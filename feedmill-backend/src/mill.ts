import {
  type SignalDef, type SignalValue, type EquipmentRuntime, type EquipmentMode,
  type BatchRuntime, type DosingStep, type Recipe, type Ingredient,
  type Bin, type Fault, type ScaleReading, type FlowConnection, type LevelSwitchState,
  type StateSnapshot, type QueueSnapshot, type Command, type CommandResult,
  type ScaleConfig, type OmronConfig, type IoRackCard,
  NX_CARD_CATALOG, NX_BUS_POWER_BUDGET_W, NX_MAX_UNITS, ECC_MODEL_MIN_CYCLE_US,
  EQUIPMENT_DEFS,
} from './types.js';
import { listCandidateNics } from './network.js';
import { verifyEthercatRack, syncIoConf, checkRackPresence } from './ethercat.js';
import { readIoState, writeIoCommand } from './ioDaemon.js';
import { loadConfig, saveConfig, type MillConfig } from './config.js';
import {
  openDb, closeDb, persistBatch, clearActiveBatch, loadActiveBatch,
  archiveBatch, postInventoryEvent, persistFault,
} from './db.js';

const SCAN_MS = 100;
// How often the rack watchdog polls `ethercat slaves` for a card going missing/
// mismatched after commissioning. Deliberately NOT inside scan() — it shells out
// to the ethercat CLI (blocking, up to its 3s timeout), which the 100ms control
// loop can't afford.
const RACK_WATCHDOG_MS = 3000;
const SETTLE_MS = 2000;
const DISCHARGE_TIMEOUT_MS = 60000;
// All delay settings are stored in seconds (0.1 s steps, like a 100 ms PLC timer); the scan runs in ms.
const delayMs = (sec: unknown, fallbackSec = 0) => Math.max(0, Number(sec ?? fallbackSec) || 0) * 1000;
const EDITABLE_STATES = new Set(['IDLE', 'READY']);

// One hammermill refill cycle: all path equipment is requested at once and runs until the destination high switch.
// Each motor's start/stop delay does the sequencing (downstream short start delay / long stop delay).
interface Refill {
  state: 'STARTING' | 'FILLING' | 'STOPPING';
  path: string[];
  dest: string;
  startedAt: number;
  fault?: { code: string; message: string };
}

const PORT_LABELS: Record<string, string> = {
  runOutput: 'Run', runConfirmAux: 'Run FB', openOutput: 'Open', closeOutput: 'Close',
  openLimitInput: 'Open FB', closedLimitInput: 'Closed FB',
  highLevelInput: 'High Level', lowLevelInput: 'Low Level', fullSensor: 'Full', lowSensor: 'Low',
  analogSpeedOutput: 'Speed', analogLoadInput: 'Load', rotationPulseInput: 'Rotation',
  vfdRunOutput: 'VFD Run', vfdAuxInput: 'VFD Aux',
};

export class Mill {
  equipment = new Map<string, EquipmentRuntime>();
  signals: SignalDef[] = [];
  ioInputs: Record<string, SignalValue> = {};
  ioOutputs: Record<string, SignalValue> = {};

  queue: BatchRuntime[] = [];
  activeBatch: BatchRuntime | null = null;
  faults: Fault[] = [];
  bins: Bin[] = [];
  recipes: Recipe[] = [];
  ingredients: Ingredient[] = [];
  connections: FlowConnection[] = [];
  scales: Record<string, ScaleReading> = {};

  revision = 0;
  private refills = new Map<string, Refill>();
  // Outputs are staged during the scan and written to the I/O image once, at the end (computeOutputs), like a PLC.
  private outImage: Record<string, boolean | number> = {};
  private out(sig: string | undefined, value: boolean | number) { if (sig) this.outImage[sig] = value; }
  private rotationState = new Map<string, { prevCount: number; prevAtMs: number; runningMs: number; rpm?: number }>();
  ioOverrides: Record<string, SignalValue> = {};
  scaleConfigs: ScaleConfig[] = [];
  scaleConfigVersion = 0; // bumped on ConfigureScale/RemoveScale — server.ts watches this to restart scale readers
  omronConfig: OmronConfig = { couplerType: 'none', ipAddress: '', nodeAddress: 1, ethercatInterface: '', eccModel: 'NX-ECC203', cycleTimeUs: 5000, ringTopology: false, cards: [], rackVerified: false, warnings: [] };
  globalConfig: Record<string, string | number> = { motorStarterFaultDelay: 0.5, siteName: 'FEED MILL CONTROLLER' };
  networkInterfaces: string[] = listCandidateNics(); // computed once at startup; restart the service to pick up newly added NICs
  private faultSeq = 300;
  private batchSeq = 2000;
  private batchPersistCounter = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private rackWatchdogHandle: ReturnType<typeof setInterval> | null = null;
  private onChange?: () => void;

  constructor() {
    openDb();
    const cfg = loadConfig();
    if (cfg) {
      this.applyConfig(cfg);
    } else {
      this.loadDefaults();
      this.persistConfig();
    }
    this.buildSignals();
    // Hammermills default to paused on startup
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'hammermill') {
        eq.mode = 'Off';
        eq.status = 'disabled';
        eq.request = false;
      }
    }
    const recovered = loadActiveBatch();
    if (recovered && !['COMPLETED', 'FAULTED', 'IDLE'].includes(recovered.state)) {
      if (recovered.state !== 'PAUSED') {
        recovered.previousState = recovered.state;
        recovered.state = 'PAUSED';
        recovered.faultReason = 'Recovered after power loss';
        this.raiseFault('BATCH', 'WARNING', `Batch ${recovered.id} recovered after power loss — review and resume or abort`, 'W-BA-REC');
      }
      this.activeBatch = recovered;
      this.queue.unshift(recovered);
    }
    // avoid ID collisions after restart
    for (const b of this.queue) {
      const n = parseInt(b.id, 10);
      if (!isNaN(n) && n >= this.batchSeq) this.batchSeq = n + 1;
    }
  }

  // ── lifecycle ──

  start(onChange: () => void) {
    this.onChange = onChange;
    this.intervalHandle = setInterval(() => this.scan(), SCAN_MS);
    this.rackWatchdogHandle = setInterval(() => this.rackWatchdogCheck(), RACK_WATCHDOG_MS);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.rackWatchdogHandle) clearInterval(this.rackWatchdogHandle);
    closeDb();
  }

  // Confirmed-good rack, left running: re-checks presence/identity against
  // the bus every RACK_WATCHDOG_MS and faults (E-OM-01, via verifyRack) if a
  // card goes missing or changes — same check Read Rack does, minus the
  // per-card PDO discovery, so it's cheap enough to poll continuously.
  // Doesn't run until the operator has confirmed the rack once (rackVerified).
  private rackWatchdogCheck() {
    const om = this.omronConfig;
    if (om.couplerType !== 'NX-ECC' || !om.rackVerified) return;
    const result = checkRackPresence(om);
    om.cards = result.cards;
    if (result.unreachable) {
      // Can't verify at all — fail safe with the same shutdown response as a
      // genuine mismatch, not a bare fault with no protective action.
      this.rackFaultShutdown([`cannot verify rack: ${result.unreachable}`]);
      return;
    }
    this.verifyRack();
  }

  private applyConfig(cfg: MillConfig): void {
    this.equipment.clear();
    for (const eq of cfg.equipment) {
      // saved equipment is the whole runtime object: drop pre-request-bit fields and start with no run request
      for (const k of ['commanded', 'stopping', 'stopDelayTimerMs']) delete (eq as unknown as Record<string, unknown>)[k];
      Object.assign(eq, { request: false, runCmd: false, startTimerMs: 0, stopTimerMs: 0 });
      this.equipment.set(eq.id, eq);
    }
    this.connections = cfg.connections;
    this.bins = cfg.bins;
    this.ingredients = cfg.ingredients;
    this.recipes = cfg.recipes;
    this.scaleConfigs = cfg.scaleConfigs;
    // older persisted configs predate eccModel/cycleTimeUs/ringTopology
    const savedOmron = cfg.omronConfig as Partial<OmronConfig>;
    this.omronConfig = { ...this.omronConfig, ...savedOmron };
    this.globalConfig = cfg.globalConfig;
  }

  private snapshotConfig(): MillConfig {
    return {
      equipment: Array.from(this.equipment.values()),
      connections: this.connections,
      bins: this.bins,
      ingredients: this.ingredients,
      recipes: this.recipes,
      scaleConfigs: this.scaleConfigs,
      omronConfig: this.omronConfig,
      globalConfig: this.globalConfig,
    };
  }

  private persistConfig(): void {
    saveConfig(this.snapshotConfig());
  }

  // ── external sensor input (scaleReader.ts calls this on every new reading) ──

  setScale(scaleId: string, weight: number, stable: boolean, valid: boolean) {
    this.scales[scaleId] = { weight, stable, valid, timestamp: Date.now() };
  }

  // ── commands from HMI ──

  processCommand(cmd: Command): CommandResult {
    const ok = (r?: string): CommandResult => ({ requestId: cmd.requestId, accepted: true, reason: r, revision: this.revision });
    const reject = (r: string): CommandResult => ({ requestId: cmd.requestId, accepted: false, reason: r, revision: this.revision });

    switch (cmd.action) {
      case 'SetEquipmentMode': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        const mode = cmd.parameters?.mode as EquipmentMode | undefined;
        if (!mode || !['Auto', 'Hand', 'Off'].includes(mode)) return reject('Invalid mode');
        // A hammermill mid-refill may be switched Off: the refill then does its controlled stop.
        const pausingMill = eq.equipmentType === 'hammermill' && mode === 'Off' && !!eq.owner?.startsWith('REFILL-');
        if (eq.owner && mode !== 'Auto' && !pausingMill) return reject('Equipment owned by batch ' + eq.owner);
        eq.mode = mode;
        if (mode === 'Off' || mode === 'Hand') {
          if (eq.status === 'fault') { eq.status = 'not_running'; eq.faultReason = undefined; eq.faultTimerMs = 0; }
        }
        if (eq.equipmentType === 'hammermill' && !pausingMill) {
          // Off = paused ('disabled'); Auto/Hand = enabled.
          if (mode === 'Off') this.pauseHammermill(eq);
          else if (eq.status === 'disabled') { eq.status = 'not_running'; eq.faultTimerMs = 0; }
        }
        return ok();
      }

      case 'SetEquipmentSpeed': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        if (!eq.config.analogSpeedOutput) return reject('No analog speed output assigned');
        const speed = cmd.parameters?.speed;
        if (typeof speed !== 'number' || !Number.isFinite(speed)) return reject('Missing speed');
        const [lo, hi] = this.speedLimits(eq);
        if (speed < lo || speed > hi) return reject(`Speed must be between ${lo} and ${hi}%`);
        eq.speed = speed;
        this.persistConfig();
        return ok();
      }

      case 'QueueBatch': {
        const p = cmd.parameters as { recipeId: string; destination: string; targetMass?: number } | undefined;
        if (!p?.recipeId || !p.destination) return reject('Missing recipe or destination');
        const recipe = this.recipes.find(r => r.id === p.recipeId);
        if (!recipe) return reject('Unknown recipe');
        const id = String(this.batchSeq++);
        const allLines = [...recipe.lines, ...recipe.microLines];
        const steps: DosingStep[] = allLines.map(line => {
          const ing = this.ingredients.find(i => i.id === line.ingredientId);
          const bin = this.findBinForIngredient(line.ingredientId);
          const augerId = this.findAugerForBin(bin?.id ?? '');
          return {
            ingredientId: line.ingredientId,
            ingredientName: ing?.name ?? line.ingredientId,
            sourceBinId: bin?.id ?? '',
            augerId: augerId ?? '',
            target: line.target,
            actual: 0,
            unit: line.unit,
            state: 'pending' as const,
            baselineWeight: 0,
            settleStartTime: 0,
            cutoffStartTime: 0,
          };
        });
        const batch: BatchRuntime = {
          id, recipeId: recipe.id, recipeName: recipe.name,
          targetMass: p.targetMass ?? allLines.reduce((s, l) => s + l.target, 0),
          destination: p.destination,
          state: 'IDLE',
          startedAt: '',
          dosingIndex: 0,
          dosingSteps: steps,
          mixTimeRemainingMs: recipe.mixTime * 1000,
          mixTimeTotalMs: recipe.mixTime * 1000,
          dischargeStartTime: 0,
        };
        this.queue.push(batch);
        return ok('Queued as batch ' + id);
      }

      case 'StartBatch': {
        const batch = this.queue.find(b => b.id === cmd.targetId && (b.state === 'IDLE' || b.state === 'READY'));
        if (!batch) return reject('Batch not found or not startable');
        if (this.activeBatch) return reject('Another batch is active');
        batch.state = 'VALIDATING';
        batch.startedAt = new Date().toISOString();
        this.activeBatch = batch;
        persistBatch(batch);
        return ok();
      }

      case 'PauseBatch': {
        if (!this.activeBatch) return reject('No active batch');
        const b = this.activeBatch;
        if (['COMPLETED', 'FAULTED', 'PAUSED', 'PAUSING', 'IDLE'].includes(b.state)) return reject('Cannot pause in state ' + b.state);
        b.previousState = b.state;
        b.state = 'PAUSING';
        this.initiateEquipmentStop(b.id);
        persistBatch(b);
        return ok();
      }

      case 'ResumeBatch': {
        if (!this.activeBatch) return reject('No active batch');
        const b = this.activeBatch;
        if (b.state !== 'PAUSED') return reject('Batch not paused');
        b.faultReason = undefined;
        b.state = b.previousState ?? 'DOSING';
        persistBatch(b);
        return ok();
      }

      case 'AbortBatch': {
        if (!this.activeBatch) return reject('No active batch');
        const b = this.activeBatch;
        this.releaseEquipment(b.id);
        b.state = 'FAULTED';
        b.faultReason = 'Operator abort';
        b.completedAt = new Date().toISOString();
        archiveBatch(b);
        clearActiveBatch(b.id);
        this.activeBatch = null;
        return ok();
      }

      case 'EditBatch': {
        const batch = this.queue.find(b => b.id === cmd.targetId);
        if (!batch) return reject('Batch not found');
        if (!EDITABLE_STATES.has(batch.state)) return reject('Batch not editable in state ' + batch.state);
        const p = cmd.parameters as { recipeId?: string; destination?: string } | undefined;
        if (p?.recipeId) {
          const recipe = this.recipes.find(r => r.id === p.recipeId);
          if (!recipe) return reject('Unknown recipe');
          batch.recipeId = recipe.id;
          batch.recipeName = recipe.name;
          batch.mixTimeRemainingMs = recipe.mixTime * 1000;
          batch.mixTimeTotalMs = recipe.mixTime * 1000;
          const allLines = [...recipe.lines, ...recipe.microLines];
          batch.targetMass = allLines.reduce((s, l) => s + l.target, 0);
          batch.dosingSteps = allLines.map(line => {
            const ing = this.ingredients.find(i => i.id === line.ingredientId);
            const bin = this.findBinForIngredient(line.ingredientId);
            const augerId = this.findAugerForBin(bin?.id ?? '');
            return {
              ingredientId: line.ingredientId, ingredientName: ing?.name ?? line.ingredientId,
              sourceBinId: bin?.id ?? '', augerId: augerId ?? '',
              target: line.target, actual: 0, unit: line.unit, state: 'pending' as const,
              baselineWeight: 0, settleStartTime: 0, cutoffStartTime: 0,
            };
          });
        }
        if (p?.destination) batch.destination = p.destination;
        return ok();
      }

      case 'UnloadBatch': {
        if (!this.activeBatch) return reject('No active batch');
        const b = this.activeBatch;
        this.releaseEquipment(b.id);
        b.state = 'COMPLETED';
        b.completedAt = new Date().toISOString();
        archiveBatch(b);
        clearActiveBatch(b.id);
        this.activeBatch = null;
        return ok();
      }

      case 'SetHammermillDestination': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq || eq.equipmentType !== 'hammermill') return reject('Hammermill not found');
        const dest = (cmd.parameters?.destination as string) ?? '';
        eq.config.destination = dest;
        this.persistConfig();
        return ok();
      }

      case 'AcknowledgeFault': {
        const f = this.faults.find(f => f.id === cmd.targetId && f.active);
        if (!f) return reject('Fault not found');
        f.acknowledgedAt = new Date().toISOString();
        persistFault(f);
        return ok();
      }

      case 'ClearFault': {
        const f = this.faults.find(f => f.id === cmd.targetId && f.active);
        if (!f) return reject('Fault not found');
        f.active = false;
        f.clearedAt = new Date().toISOString();
        persistFault(f);
        const eq = this.equipment.get(f.equipment);
        if (eq && eq.status === 'fault') { eq.status = 'not_running'; eq.faultReason = undefined; eq.faultTimerMs = 0; }
        return ok();
      }

      case 'ResetEquipmentFault': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        if (eq.status !== 'fault') return reject('No fault');
        eq.status = 'not_running';
        eq.faultReason = undefined;
        eq.faultTimerMs = 0;
        const f = this.faults.find(f => f.equipment === eq.id && f.active);
        if (f) { f.active = false; f.clearedAt = new Date().toISOString(); }
        return ok();
      }

      case 'SetOverride': {
        const sig = cmd.targetId;
        const val = cmd.parameters?.value;
        if (!sig || val === undefined) return reject('Missing signal or value');
        this.ioOverrides[sig] = val as SignalValue;
        return ok();
      }

      case 'ClearOverride': {
        const sig = cmd.targetId;
        if (!sig) return reject('Missing signal');
        delete this.ioOverrides[sig];
        // Released inputs get the real reading back on the next scan's readRealInputs().
        return ok();
      }

      case 'ReadOmronRack': {
        if (this.omronConfig.couplerType === 'none') return reject('No coupler configured');
        this.readOmronRack();
        this.persistConfig(); // discoveredRack must survive a restart, or every reboot would need a fresh Read Rack
        return ok();
      }

      case 'SetEquipmentPositions': {
        const pos = cmd.parameters?.positions as Record<string, { x: number; y: number }> | undefined;
        if (!pos || typeof pos !== 'object') return reject('Missing positions');
        for (const [id, p] of Object.entries(pos)) {
          const eq = this.equipment.get(id);
          if (eq && Number.isFinite(p?.x) && Number.isFinite(p?.y)) eq.position = { x: p.x, y: p.y };
        }
        this.persistConfig();
        return ok();
      }

      // ── Topology: Equipment ──
      // Guard: no running motors, and any active batch must be paused
      case 'AddEquipment':
      case 'RemoveEquipment':
      case 'UpdateEquipment':
      case 'AddConnection':
      case 'RemoveConnection':
      case 'ConfigureOmron':
      case 'ConfigureScale':
      case 'RemoveScale': {
        const guardErr = this.guardConfigEdit();
        if (guardErr) return reject(guardErr);
        const result = this.processTopologyCommand(cmd, ok, reject);
        if (result.accepted) this.persistConfig();
        return result;
      }

      case 'UpdateBin':
      case 'AddIngredient':
      case 'UpdateIngredient':
      case 'RemoveIngredient':
      case 'SaveRecipe':
      case 'RemoveRecipe':
      case 'SetGlobalConfig': {
        const result = this.processTopologyCommand(cmd, ok, reject);
        if (result.accepted) this.persistConfig();
        return result;
      }

      default:
        return reject('Unknown action: ' + cmd.action);
    }
  }

  private guardConfigEdit(): string | null {
    if (this.refills.size > 0) return 'Wait for hammermill refill to finish before editing config';
    if (this.activeBatch && this.activeBatch.state !== 'PAUSED') {
      return 'Mill must be paused or idle to edit equipment/IO config';
    }
    for (const eq of this.equipment.values()) {
      if (eq.status === 'running') return 'Stop all motors before editing config';
    }
    return null;
  }

  private processTopologyCommand(
    cmd: Command,
    ok: (r?: string) => CommandResult,
    reject: (r: string) => CommandResult,
  ): CommandResult {
    switch (cmd.action) {
      case 'AddEquipment': {
        const p = cmd.parameters as { equipmentType: string; name?: string; config?: Record<string, string | number | boolean> } | undefined;
        if (!p?.equipmentType) return reject('Missing equipmentType');
        const def = EQUIPMENT_DEFS[p.equipmentType];
        if (!def) return reject('Unknown equipment type');
        const existing = Array.from(this.equipment.values()).filter(e => e.equipmentType === p.equipmentType);
        if (def.maxCount && existing.length >= def.maxCount) return reject(`Max ${def.maxCount} ${def.label} allowed`);
        const maxNum = existing.reduce((m, e) => {
          const n = parseInt(e.id.replace(/\D/g, '')) || 0;
          return Math.max(m, n);
        }, 0);
        const num = maxNum + 1;
        const id = `${def.prefix}-${num}`;
        const eq: EquipmentRuntime = {
          id, name: p.name ?? `${def.label} ${num}`, equipmentType: p.equipmentType, class: def.class,
          mode: 'Auto', status: 'not_running', request: false, runCmd: false, feedback: false,
          config: p.config ?? {}, faultTimerMs: 0, positionTimerMs: 0, startTimerMs: 0, stopTimerMs: 0,
        };
        if (p.equipmentType === 'hammermill') {
          eq.mode = 'Off';
          eq.status = 'disabled';
        }
        this.equipment.set(id, eq);
        if (p.equipmentType === 'bin' || p.equipmentType === 'finished_bin') {
          this.bins.push({
            id, name: eq.name, ingredientId: null, balance: 0,
            capacity: (p.config?.capacity as number) ?? (p.equipmentType === 'finished_bin' ? 66000 : 33000),
            unit: 'lbs', type: p.equipmentType === 'finished_bin' ? 'finished' : 'ingredient',
          });
        }
        this.buildSignals();
        return ok('Created ' + id);
      }

      case 'RemoveEquipment': {
        const id = cmd.targetId;
        if (!id) return reject('Missing targetId');
        const eq = this.equipment.get(id);
        if (!eq) return reject('Unknown equipment');
        if (eq.owner) return reject('Equipment owned by batch ' + eq.owner);
        this.equipment.delete(id);
        this.connections = this.connections.filter(c => c.from !== id && c.to !== id);
        this.bins = this.bins.filter(b => b.id !== id);
        this.buildSignals();
        return ok();
      }

      case 'UpdateEquipment': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        const p = cmd.parameters as { name?: string; config?: Record<string, string | number | boolean>; newId?: string } | undefined;
        if (!p) return reject('Missing parameters');
        const renaming = !!p.newId && p.newId !== eq.id;
        if (renaming && this.equipment.has(p.newId!)) return reject('ID already in use');
        if (renaming && eq.owner) return reject('Cannot rename owned equipment');
        if (p.name !== undefined) eq.name = p.name;
        if (p.config !== undefined) eq.config = { ...eq.config, ...p.config };
        if (renaming && p.newId) {
          const oldId = eq.id;
          eq.id = p.newId;
          this.equipment.delete(oldId);
          this.equipment.set(p.newId, eq);
          for (const c of this.connections) {
            if (c.from === oldId) c.from = p.newId;
            if (c.to === oldId) c.to = p.newId;
          }
          const bin = this.bins.find(b => b.id === oldId);
          if (bin) bin.id = p.newId;
          for (const f of this.faults) {
            if (f.equipment === oldId) f.equipment = p.newId;
          }
        }
        const bin = this.bins.find(b => b.id === eq.id);
        if (bin) {
          if (p.name !== undefined) bin.name = p.name;
          if (p.config?.capacity !== undefined) bin.capacity = p.config.capacity as number;
        }
        this.buildSignals();
        return ok();
      }

      // ── Topology: Connections ──

      case 'AddConnection': {
        const p = cmd.parameters as { from: string; fromPort: string; to: string; toPort: string } | undefined;
        if (!p?.from || !p.fromPort || !p.to || !p.toPort) return reject('Missing connection fields');
        if (p.from === p.to) return reject('Cannot connect to self');
        if (!this.equipment.has(p.from)) return reject('Unknown source: ' + p.from);
        if (!this.equipment.has(p.to)) return reject('Unknown target: ' + p.to);
        const dup = this.connections.some(c => c.from === p.from && c.fromPort === p.fromPort && c.to === p.to && c.toPort === p.toPort);
        if (dup) return reject('Connection already exists');
        this.connections.push({ from: p.from, fromPort: p.fromPort, to: p.to, toPort: p.toPort });
        return ok();
      }

      case 'RemoveConnection': {
        const p = cmd.parameters as { from: string; fromPort: string; to: string; toPort: string } | undefined;
        if (!p?.from || !p.fromPort || !p.to || !p.toPort) return reject('Missing connection fields');
        const idx = this.connections.findIndex(c => c.from === p.from && c.fromPort === p.fromPort && c.to === p.to && c.toPort === p.toPort);
        if (idx < 0) return reject('Connection not found');
        this.connections.splice(idx, 1);
        return ok();
      }

      // ── Topology: Bins ──

      case 'UpdateBin': {
        const bin = this.bins.find(b => b.id === cmd.targetId);
        if (!bin) return reject('Unknown bin');
        const p = cmd.parameters as Partial<Bin> | undefined;
        if (!p) return reject('Missing parameters');
        if (p.name !== undefined) bin.name = p.name;
        if (p.ingredientId !== undefined) bin.ingredientId = p.ingredientId;
        if (p.capacity !== undefined) bin.capacity = p.capacity;
        if (p.note !== undefined) bin.note = p.note;
        if (p.balance !== undefined) bin.balance = p.balance;
        if (p.unit !== undefined) bin.unit = p.unit;
        if (p.type !== undefined) bin.type = p.type;
        if (p.tracked !== undefined) bin.tracked = p.tracked;
        const eq = this.equipment.get(bin.id);
        if (eq && p.name !== undefined) eq.name = p.name;
        return ok();
      }

      // ── Topology: Ingredients ──

      case 'AddIngredient': {
        const p = cmd.parameters as { id?: string; name: string; category: 'MAIN' | 'MICRO'; unit: string } | undefined;
        if (!p?.name || !p.category || !p.unit) return reject('Missing name, category or unit');
        const prefix = p.category === 'MICRO' ? 'MIC' : 'ING';
        const id = p.id ?? (() => {
          const nums = this.ingredients.filter(i => i.id.startsWith(prefix + '-')).map(i => parseInt(i.id.split('-')[1]) || 0);
          return `${prefix}-${String(Math.max(0, ...nums) + 1).padStart(2, '0')}`;
        })();
        if (this.ingredients.some(i => i.id === id)) return reject('Ingredient ID already exists');
        this.ingredients.push({ id, name: p.name, category: p.category, unit: p.unit });
        return ok('Created ' + id);
      }

      case 'UpdateIngredient': {
        const ing = this.ingredients.find(i => i.id === cmd.targetId);
        if (!ing) return reject('Unknown ingredient');
        const p = cmd.parameters as Partial<Ingredient> | undefined;
        if (!p) return reject('Missing parameters');
        if (p.name !== undefined) ing.name = p.name;
        if (p.category !== undefined) ing.category = p.category;
        if (p.unit !== undefined) ing.unit = p.unit;
        if (p.hidden !== undefined) ing.hidden = p.hidden;
        return ok();
      }

      case 'RemoveIngredient': {
        const id = cmd.targetId;
        if (!id) return reject('Missing targetId');
        if (!this.ingredients.some(i => i.id === id)) return reject('Unknown ingredient');
        if (this.bins.some(b => b.ingredientId === id)) return reject('Ingredient assigned to a bin');
        this.ingredients = this.ingredients.filter(i => i.id !== id);
        return ok();
      }

      // ── Topology: Recipes ──

      case 'SaveRecipe': {
        const p = cmd.parameters as Recipe | undefined;
        if (!p?.id || !p.name) return reject('Missing recipe id or name');
        const idx = this.recipes.findIndex(r => r.id === p.id);
        const recipe: Recipe = {
          id: p.id, name: p.name,
          revision: idx >= 0 ? this.recipes[idx].revision + 1 : 1,
          mixTime: p.mixTime ?? 180,
          lines: p.lines ?? [],
          microLines: p.microLines ?? [],
        };
        if (idx >= 0) this.recipes[idx] = recipe;
        else this.recipes.push(recipe);
        return ok('Saved revision ' + recipe.revision);
      }

      case 'RemoveRecipe': {
        const id = cmd.targetId;
        if (!id) return reject('Missing targetId');
        if (!this.recipes.some(r => r.id === id)) return reject('Unknown recipe');
        if (this.activeBatch?.recipeId === id) return reject('Recipe in active batch');
        if (this.queue.some(b => b.recipeId === id && !['COMPLETED', 'FAULTED'].includes(b.state))) return reject('Recipe in queued batch');
        this.recipes = this.recipes.filter(r => r.id !== id);
        return ok();
      }

      // ── Global config ──

      case 'SetGlobalConfig': {
        const p = cmd.parameters as { key: string; value: string | number } | undefined;
        if (!p?.key || p.value === undefined) return reject('Missing key or value');
        this.globalConfig[p.key] = p.value;
        return ok();
      }

      // ── IO config (guarded) ──

      case 'ConfigureScale': {
        const p = cmd.parameters as Partial<ScaleConfig> | undefined;
        if (!p?.id || !p.name) return reject('Missing scale id or name');
        const sc: ScaleConfig = {
          id: p.id, name: p.name,
          connectionType: p.connectionType ?? 'serial',
          protocol: p.protocol ?? '',
          comPort: p.comPort ?? '',
          baudRate: p.baudRate ?? 9600,
          dataBits: p.dataBits ?? 8,
          parity: p.parity ?? 'none',
          stopBits: p.stopBits ?? 1,
          weightRegex: p.weightRegex ?? '',
          rackSlot: p.rackSlot ?? 0,
          zeroOffset: p.zeroOffset ?? 0,
          ratedMvV: p.ratedMvV ?? 2.0,
          capacity: p.capacity ?? 5000,
          resolution: p.resolution ?? 1,
          freshnessTimeout: p.freshnessTimeout ?? 5000,
          stabilityWindow: p.stabilityWindow ?? 500,
        };
        const idx = this.scaleConfigs.findIndex(s => s.id === sc.id);
        if (idx >= 0) this.scaleConfigs[idx] = sc;
        else this.scaleConfigs.push(sc);
        this.scaleConfigVersion++;
        if (this.omronConfig.couplerType === 'NX-ECC') syncIoConf(this.omronConfig, this.signals, this.equipment.values(), this.scaleConfigs);
        return ok();
      }

      case 'RemoveScale': {
        const id = cmd.targetId;
        if (!id) return reject('Missing scale id');
        this.scaleConfigs = this.scaleConfigs.filter(s => s.id !== id);
        this.scaleConfigVersion++;
        if (this.omronConfig.couplerType === 'NX-ECC') syncIoConf(this.omronConfig, this.signals, this.equipment.values(), this.scaleConfigs);
        return ok();
      }

      case 'ConfigureOmron': {
        const p = cmd.parameters as Partial<OmronConfig> | undefined;
        if (!p) return reject('Missing parameters');
        const cards: IoRackCard[] = (p.cards ?? []).map((c, i) => ({
          slot: c.slot ?? i + 1,
          model: c.model ?? 'NX-ID5342',
          actual: c.actual,
          status: c.status ?? 'unchecked',
        }));
        this.omronConfig = {
          couplerType: p.couplerType ?? 'none',
          ipAddress: p.ipAddress ?? '',
          nodeAddress: p.nodeAddress ?? 1,
          ethercatInterface: p.ethercatInterface ?? '',
          eccModel: p.eccModel ?? 'NX-ECC203',
          cycleTimeUs: p.cycleTimeUs ?? 5000,
          ringTopology: p.ringTopology ?? false,
          cards,
          rackVerified: false,
          warnings: [],
          discoveredRack: this.omronConfig.discoveredRack, // survives reconfiguration — it's rack-level, not per-card
        };
        this.validateRack();
        this.clearRackFault();
        this.buildSignals();
        return ok();
      }

      default:
        return reject('Unknown topology action: ' + cmd.action);
    }
  }

  // ── main control cycle ──

  private scan() {
    this.applyOverrides();
    const ioState = readIoState(); // read once; shared by readRealInputs and updateRotationSensors
    this.readRealInputs(ioState);
    this.checkLevelSensors();
    this.updateRefills();
    this.updateEquipmentStates();
    this.updateRotationSensors(ioState);
    this.applyAugerSpeeds();
    this.advanceBatch();
    this.computeOutputs();
    this.revision++;
    this.onChange?.();
  }

  private applyOverrides() {
    for (const [id, val] of Object.entries(this.ioOverrides)) {
      this.ioInputs[id] = val;
    }
  }

  // Reads the io_daemon's state file (ethercat-rt/io_daemon.c) into ioInputs
  // for every DI/AI signal — an override (applyOverrides, just above) always
  // wins. No daemon data (not running, dev box) leaves inputs at their last
  // value rather than guessing.
  private readRealInputs(state: ReturnType<typeof readIoState>) {
    if (!state) return;
    for (const sig of this.signals) {
      if (sig.direction !== 'DI' && sig.direction !== 'AI') continue;
      if (sig.id in this.ioOverrides) continue;
      const v = state.inputs[sig.id];
      if (v !== undefined) this.ioInputs[sig.id] = v;
    }
  }

  private updateEquipmentStates() {
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'gate') this.updateGate(eq);
    }
    // Motor rungs, like nested PLC rungs: run logic upstream-first (a stop delay starts only once the motors feeding it
    // have stopped), then the downstream permissive downstream-first, then feedback/fault/status/outputs.
    const downstreamFirst = this.motorsDownstreamFirst();
    for (let i = downstreamFirst.length - 1; i >= 0; i--) this.motorRunLogic(downstreamFirst[i]);
    for (const eq of downstreamFirst) this.motorInterlock(eq);
    for (const eq of downstreamFirst) this.motorOutputs(eq);
  }

  private isMotor(eq: EquipmentRuntime) {
    return eq.equipmentType !== 'gate' && eq.equipmentType !== 'bin' && eq.equipmentType !== 'finished_bin';
  }

  // Motors ordered so every motor comes after the motors it feeds (bins and gates end a chain). updateMotor then sees
  // the downstream run commands from this same scan, so a stop ripples all the way upstream without a scan of lag.
  private motorsDownstreamFirst(): EquipmentRuntime[] {
    const seen = new Set<string>();
    const order: EquipmentRuntime[] = [];
    const visit = (id: string) => {
      const eq = this.equipment.get(id);
      if (!eq || seen.has(id) || !this.isMotor(eq)) return;
      seen.add(id);
      for (const c of this.connections) if (c.from === id) visit(c.to);
      order.push(eq);
    };
    for (const id of this.equipment.keys()) visit(id);
    return order;
  }

  // Nested run permissive: a motor may only run while every motor it feeds is running.
  private downstreamRunning(eq: EquipmentRuntime): boolean {
    for (const c of this.connections) {
      if (c.from !== eq.id) continue;
      const next = this.equipment.get(c.to);
      if (next && this.isMotor(next) && !next.runCmd) return false;
    }
    return true;
  }

  // Reads the io_daemon's state file (ethercat-rt/io_daemon.c), which counts
  // shaft-sensor pulses in its own EtherCAT cyclic loop — this 100ms scan
  // can't sample fast enough to count them itself. Derives RPM from the
  // count delta and faults a running motor whose shaft has stalled.
  private updateRotationSensors(state: ReturnType<typeof readIoState>) {
    const counters = state?.rotation;
    const now = Date.now();
    for (const eq of this.equipment.values()) {
      const sig = eq.config.rotationPulseInput as string | undefined;
      if (!sig) continue;

      let st = this.rotationState.get(eq.id);
      if (!st) {
        st = { prevCount: 0, prevAtMs: now, runningMs: 0 };
        this.rotationState.set(eq.id, st);
      }
      st.runningMs = eq.status === 'running' ? st.runningMs + SCAN_MS : 0;

      if (!counters || !(sig in counters)) {
        // Daemon not running (dev box, or not installed yet) — no live data,
        // so don't guess an RPM and don't fault on missing infrastructure.
        st.rpm = undefined;
        continue;
      }

      const chan = counters[sig];
      const dtMs = now - st.prevAtMs;
      if (dtMs > 0) {
        const pulsesPerRev = (eq.config.pulsesPerRev as number) || 1;
        st.rpm = ((chan.count - st.prevCount) / pulsesPerRev) * (60000 / dtMs);
      }
      st.prevCount = chan.count;
      st.prevAtMs = now;

      const minRpm = eq.config.minRpm as number | undefined;
      const startupDelay = delayMs(eq.config.rotationStartupDelay);
      if (
        typeof minRpm === 'number' && minRpm > 0 &&
        eq.status === 'running' && st.runningMs >= startupDelay &&
        (st.rpm ?? 0) < minRpm
      ) {
        eq.status = 'fault';
        eq.faultReason = 'Rotation sensor stall';
        this.raiseFault(eq.id, 'CRITICAL',
          `${eq.name}: rotation stall (${(st.rpm ?? 0).toFixed(0)} RPM < ${minRpm} min)`, 'E-MT-02');
      }
    }
  }

  // eq.request is the run request bit (Hand/Auto owners set it); the run command follows it through the start
  // (on-delay) and stop (off-delay) timers. The stop timers are nested: a motor's stop delay only runs once every
  // motor feeding it that is itself stopping has finished stopping, so the delays add up down the line.
  private motorRunLogic(eq: EquipmentRuntime) {
    this.motorFeedback(eq); // a feedback fault drops the run command in this same scan
    const usable = eq.status !== 'fault' && eq.status !== 'disabled';

    if (!usable || eq.mode === 'Off') eq.request = false;
    else if (eq.mode === 'Hand') eq.request = true;
    // Auto: keep the request set by the batch engine / refill

    if (!usable) {
      eq.runCmd = false; // a fault or disable drops the run command at once
      eq.startTimerMs = 0;
      eq.stopTimerMs = 0;
    } else if (eq.request) {
      // Start delays nest too: this timer only survives the interlock pass (motorInterlock zeroes it) while every
      // motor it feeds is running, so it starts counting once the downstream start delay has elapsed.
      eq.stopTimerMs = 0;
      eq.startTimerMs += SCAN_MS;
      if (eq.startTimerMs >= delayMs(eq.config.startDelay)) eq.runCmd = true;
    } else {
      eq.startTimerMs = 0;
      if (eq.runCmd && !this.upstreamStopping(eq)) {
        eq.stopTimerMs += SCAN_MS;
        if (eq.stopTimerMs >= delayMs(eq.config.stopDelay)) { eq.runCmd = false; eq.stopTimerMs = 0; }
      } else eq.stopTimerMs = 0; // not running, or waiting for upstream motors to finish stopping
    }
  }

  // Nested run permissive: a motor may only run while every motor it feeds is running. If one stops or faults,
  // everything feeding it drops out at once (no stop delay) and restarts, after its start delay, when it is running again.
  private motorInterlock(eq: EquipmentRuntime) {
    if (!this.downstreamRunning(eq)) {
      eq.runCmd = false;
      eq.startTimerMs = 0;
      eq.stopTimerMs = 0;
    }
  }

  private upstreamStopping(eq: EquipmentRuntime): boolean {
    for (const c of this.connections) {
      if (c.to !== eq.id) continue;
      const prev = this.equipment.get(c.from);
      if (prev && this.isMotor(prev) && prev.runCmd && !prev.request) return true;
    }
    return false;
  }

  // Master VFD: a second starter that follows the run command and must confirm on its aux input.
  private vfdOf(eq: EquipmentRuntime) {
    return eq.config.masterVfd
      ? { run: eq.config.vfdRunOutput as string | undefined, aux: eq.config.vfdAuxInput as string | undefined }
      : undefined;
  }

  // Read the run confirmation(s) and time them against the global Motor Starter Fault Delay (same delay for the VFD).
  private motorFeedback(eq: EquipmentRuntime) {
    const runOutput = eq.config.runOutput as string | undefined;
    const runConfirmAux = eq.config.runConfirmAux as string | undefined;
    const usable = eq.status !== 'fault' && eq.status !== 'disabled';

    if (runConfirmAux && runConfirmAux in this.ioInputs) {
      eq.feedback = !!this.ioInputs[runConfirmAux];
    } else if (!runConfirmAux || !runOutput) {
      eq.feedback = eq.runCmd;
    }

    const vfd = this.vfdOf(eq);
    const vfdOk = !vfd?.aux || !!this.ioInputs[vfd.aux];

    if (usable) {
      if (eq.runCmd && !(eq.feedback && vfdOk)) {
        eq.faultTimerMs += SCAN_MS;
        if (eq.faultTimerMs >= delayMs(this.globalConfig.motorStarterFaultDelay, 0.5)) {
          const starter = !eq.feedback;
          eq.status = 'fault';
          eq.faultReason = starter ? 'Starter feedback timeout' : 'VFD feedback timeout';
          this.raiseFault(eq.id, 'CRITICAL', `${eq.name}: ${starter ? 'starter' : 'VFD'} feedback timeout`, starter ? 'E-MT-01' : 'E-MT-03');
        }
      } else {
        eq.faultTimerMs = 0;
      }
    }

  }

  private motorOutputs(eq: EquipmentRuntime) {
    const vfd = this.vfdOf(eq);
    if (eq.status !== 'fault' && eq.status !== 'disabled') {
      const vfdOk = !vfd?.aux || !!this.ioInputs[vfd.aux];
      eq.status = eq.runCmd && eq.feedback && vfdOk ? 'running' : 'not_running';
    }
    this.out(eq.config.runOutput as string | undefined, eq.runCmd);
    this.out(vfd?.run, eq.runCmd);
  }

  private updateGate(eq: EquipmentRuntime) {
    const openOutput = eq.config.openOutput as string | undefined;
    const closeOutput = eq.config.closeOutput as string | undefined;
    const openLimit = eq.config.openLimitInput as string | undefined;
    const closedLimit = eq.config.closedLimitInput as string | undefined;
    const timeout = delayMs(eq.config.positionTimeout, 5);

    const openFb = openLimit ? !!this.ioInputs[openLimit] : undefined;
    const closedFb = closedLimit ? !!this.ioInputs[closedLimit] : undefined;

    // Gates hold position unless a sequence commands them.
    // request=true → open, request=false with owner → close, no owner → hold outputs
    const hasOwner = !!(eq.owner || eq.mode === 'Hand');

    if (eq.request && hasOwner) {
      this.out(openOutput, true);
      this.out(closeOutput, false);
      if (openFb) {
        eq.gatePosition = 'open';
        eq.feedback = true;
        eq.status = 'running';
        eq.positionTimerMs = 0;
      } else if (openLimit) {
        eq.gatePosition = 'moving';
        eq.positionTimerMs += SCAN_MS;
        if (eq.positionTimerMs >= timeout) {
          eq.status = 'fault';
          eq.faultReason = 'Gate open timeout';
          this.raiseFault(eq.id, 'CRITICAL', `${eq.name}: open position timeout`, 'E-GT-01');
        }
      } else {
        eq.gatePosition = 'open';
        eq.feedback = true;
        eq.status = 'running';
      }
    } else if (!eq.request && hasOwner) {
      this.out(openOutput, false);
      this.out(closeOutput, true);
      if (closedFb !== undefined) {
        if (closedFb) {
          eq.gatePosition = 'closed';
          eq.feedback = false;
          eq.status = eq.status === 'fault' ? 'fault' : 'not_running';
          eq.positionTimerMs = 0;
        } else {
          eq.gatePosition = 'moving';
          eq.positionTimerMs += SCAN_MS;
          if (eq.positionTimerMs >= timeout) {
            eq.status = 'fault';
            eq.faultReason = 'Gate close timeout';
            this.raiseFault(eq.id, 'WARNING', `${eq.name}: close position timeout`, 'W-GT-02');
          }
        }
      } else {
        eq.gatePosition = 'closed';
        eq.status = eq.status === 'fault' ? 'fault' : 'not_running';
      }
    } else {
      // No owner — hold outputs, just read feedback for position display
      if (openFb) eq.gatePosition = 'open';
      else if (closedFb) eq.gatePosition = 'closed';
      else if (openFb === undefined && closedFb === undefined) { /* no sensors, keep last known */ }
      else eq.gatePosition = 'unknown';
      eq.positionTimerMs = 0;
    }
  }

  // ── batch engine ──

  private advanceBatch() {
    const b = this.activeBatch;
    if (!b) return;
    const prevState = b.state;

    switch (b.state) {
      case 'VALIDATING': {
        const mixer = this.findEquipmentByType('mixer');
        if (!mixer) { this.batchFault(b, 'No mixer configured'); return; }
        const scale = this.getMixerScale();
        if (!scale && this.hasMappedScales()) {
          return;
        }
        b.state = 'READY';
        break;
      }

      case 'READY': {
        b.state = 'DOSING';
        b.dosingIndex = 0;
        const mixer = this.findEquipmentByType('mixer');
        if (mixer) { mixer.owner = b.id; mixer.request = true; }
        break;
      }

      case 'DOSING': {
        const mixer = this.findEquipmentByType('mixer');
        if (mixer) { mixer.owner = b.id; mixer.request = true; }
        this.advanceDosing(b);
        break;
      }

      case 'MIXING': {
        const mixer = this.findEquipmentByType('mixer');
        if (mixer) { mixer.owner = b.id; mixer.request = true; }
        b.mixTimeRemainingMs -= SCAN_MS;
        if (b.mixTimeRemainingMs <= 0) {
          b.mixTimeRemainingMs = 0;
          b.state = 'ROUTE_PRECHECK';
        }
        break;
      }

      case 'ROUTE_PRECHECK': {
        const destLevel = this.levelState(b.destination);
        if (destLevel === 'full' || destLevel === 'fault') {
          b.faultReason = destLevel === 'full' ? `Waiting: destination ${b.destination} is full` : `Waiting: ${b.destination} level sensors disagree`;
          break;
        }
        b.faultReason = undefined;
        const gate = this.findGateForDischarge();
        if (gate) {
          gate.owner = b.id;
          gate.request = true;
        }
        b.state = 'DISCHARGING';
        b.dischargeStartTime = Date.now();
        break;
      }

      case 'DISCHARGING': {
        // 'full' is already debounced by the destination's Bin Full Stop Delay
        if (this.levelState(b.destination) === 'full') {
          b.previousState = b.state;
          b.state = 'PAUSING';
          b.faultReason = `Destination ${b.destination} full — discharge paused`;
          this.initiateEquipmentStop(b.id);
          break;
        }
        const gate = this.findGateForDischarge();
        if (gate) { gate.owner = b.id; gate.request = true; }
        const scale = this.getMixerScale();
        if (scale && scale.weight < 10 && scale.stable) {
          b.state = 'CLEAROUT';
        } else if (Date.now() - b.dischargeStartTime > DISCHARGE_TIMEOUT_MS) {
          b.state = 'CLEAROUT';
        }
        break;
      }

      case 'CLEAROUT': {
        const gate = this.findGateForDischarge();
        if (gate) { gate.request = false; gate.owner = undefined; }
        this.releaseEquipment(b.id);
        b.state = 'COMPLETED';
        b.completedAt = new Date().toISOString();
        this.activeBatch = null;
        for (const step of b.dosingSteps) {
          if (step.actual > 0) {
            const bin = this.bins.find(bn => bn.id === step.sourceBinId);
            if (bin) bin.balance = Math.max(0, bin.balance - step.actual);
            postInventoryEvent(
              `${b.id}-${step.ingredientId}-consume`, 'consumption',
              step.sourceBinId, step.ingredientId, -step.actual, step.unit, b.id,
            );
          }
        }
        const destBin = this.bins.find(bn => bn.id === b.destination);
        if (destBin) {
          const total = b.dosingSteps.reduce((s, st) => s + st.actual, 0);
          destBin.balance += total;
          postInventoryEvent(
            `${b.id}-dest-receive`, 'batch_receive',
            b.destination, null, total, 'lbs', b.id,
          );
        }
        this.persistConfig();
        archiveBatch(b);
        clearActiveBatch(b.id);
        break;
      }

      case 'PAUSING': {
        const allStopped = this.allOwnedEquipmentStopped(b.id);
        if (allStopped) {
          this.releaseEquipment(b.id);
          b.state = 'PAUSED';
        }
        break;
      }

      case 'PAUSED':
      case 'FAULTED':
      case 'COMPLETED':
      case 'IDLE':
        break;
    }

    if (b.state !== prevState) persistBatch(b);
  }

  private advanceDosing(b: BatchRuntime) {
    if (b.dosingIndex >= b.dosingSteps.length) {
      b.state = 'MIXING';
      persistBatch(b);
      return;
    }

    const step = b.dosingSteps[b.dosingIndex];
    const prevStepState = step.state;
    const binEq = this.equipment.get(step.sourceBinId);
    const auger = step.augerId ? this.equipment.get(step.augerId) : undefined;
    const hasAnalogSpeed = !!(auger?.config.analogSpeedOutput);
    const freefall = (binEq?.config.freefall as number) ?? 0;
    const slowFeedLbs = (hasAnalogSpeed && (binEq?.config.slowFeedLbs as number)) ? (binEq!.config.slowFeedLbs as number) : 0;

    switch (step.state) {
      case 'pending': {
        const scale = this.getMixerScale();
        if (scale && scale.stable && scale.valid) {
          step.baselineWeight = scale.weight;
          step.state = 'baseline';
        } else if (!this.hasMappedScales()) {
          step.baselineWeight = 0;
          step.state = 'baseline';
        }
        break;
      }

      case 'baseline': {
        if (auger) { auger.owner = b.id; auger.request = true; }
        step.state = 'feeding';
        break;
      }

      case 'feeding': {
        if (auger) { auger.owner = b.id; auger.request = true; }
        this.updateStepActual(step);
        const remaining = step.target - step.actual;
        if (hasAnalogSpeed) {
          const slowSpeed = (binEq?.config.slowFeedSpeed as number) ?? 50;
          const inSlowZone = slowFeedLbs > 0 && (remaining <= slowFeedLbs || slowFeedLbs >= step.target);
          const normal = auger?.speed ?? 100;
          this.setAugerSpeed(auger, inSlowZone ? Math.min(slowSpeed, normal) : normal);
        }
        // Freefall cutoff
        if (step.actual >= step.target - freefall) {
          if (auger) auger.request = false; // the auger's own stop delay keeps it running through the freefall
          step.state = 'cutoff';
        }
        break;
      }

      case 'cutoff': {
        this.updateStepActual(step);
        if (auger) auger.request = false;
        if (!auger?.runCmd) {
          if (auger) auger.owner = undefined;
          step.settleStartTime = Date.now();
          step.state = 'settling';
        }
        break;
      }

      case 'settling': {
        const scale = this.getMixerScale();
        if (scale) step.actual = Math.max(0, scale.weight - step.baselineWeight);
        if (Date.now() - step.settleStartTime >= SETTLE_MS) {
          step.state = 'complete';
          b.dosingIndex++;
        }
        break;
      }

      case 'complete':
        b.dosingIndex++;
        break;

      case 'faulted':
        this.batchFault(b, `Dosing step ${step.ingredientName} faulted`);
        break;
    }

    if (step.state !== prevStepState) {
      persistBatch(b);
      this.batchPersistCounter = 0;
    } else if (step.state === 'feeding') {
      this.batchPersistCounter++;
      if (this.batchPersistCounter >= 50) {
        persistBatch(b);
        this.batchPersistCounter = 0;
      }
    }
  }

  private updateStepActual(step: DosingStep) {
    const scale = this.getMixerScale();
    if (scale) {
      step.actual = Math.max(0, scale.weight - step.baselineWeight);
    } else if (!this.hasMappedScales()) {
      step.actual += step.target * SCAN_MS / 5000;
    }
  }

  private setAugerSpeed(auger: EquipmentRuntime | undefined, pct: number) {
    if (!auger) return;
    const aoSig = auger.config.analogSpeedOutput as string | undefined;
    if (aoSig) {
      const [lo, hi] = this.speedLimits(auger);
      const limited = Math.min(hi, Math.max(lo, pct));
      const minPct = (auger.config.speedMinPct as number) ?? 0;
      const maxPct = (auger.config.speedMaxPct as number) ?? 100;
      const scaled = minPct + (limited / 100) * (maxPct - minPct);
      this.out(aoSig, Math.round(scaled * 100) / 100);
    }
  }

  // Drop the run request of everything the batch owns; each motor stops after its own stop delay.
  private initiateEquipmentStop(ownerId: string) {
    for (const eq of this.equipment.values()) {
      if (eq.owner === ownerId) eq.request = false;
    }
  }

  private allOwnedEquipmentStopped(ownerId: string): boolean {
    for (const eq of this.equipment.values()) {
      if (eq.owner === ownerId && eq.equipmentType !== 'gate' && eq.runCmd) return false;
    }
    return true;
  }

  // ── level switches ──

  // The high and low switch of a bin: input, "high/low = covered" key, and delay key (seconds) in the equipment config.
  private levelSwitches(eq: EquipmentRuntime) {
    const fin = eq.equipmentType === 'finished_bin';
    const c = eq.config;
    return {
      hi: { input: (fin ? c.fullSensor : c.highLevelInput) as string | undefined, covered: fin ? 'fullSensorCovered' : 'highLevelCovered', delay: 'binFullStopDelay' },
      lo: { input: (fin ? c.lowSensor : c.lowLevelInput) as string | undefined, covered: fin ? 'lowSensorCovered' : 'lowLevelCovered', delay: 'binLowRestartDelay' },
    };
  }

  // Raw covered state of a switch from its input and its "high/low = covered" setting (default high).
  private rawCovered(eq: EquipmentRuntime, sw: { input?: string; covered: string }): boolean {
    return !!this.ioInputs[sw.input!] === (eq.config[sw.covered] !== 'low');
  }

  // Debounce: the high switch must stay covered for Bin Full Stop Delay before the bin counts as full; the low switch must
  // stay uncovered for Bin Low Restart Delay before it counts as empty. The other direction is immediate.
  // Updated once per scan; before the first scan the raw state is used.
  private debouncedCovered = new Map<string, { input: string; covered: boolean; pending?: boolean; since: number }>();

  private updateLevelDebounce(eq: EquipmentRuntime) {
    const now = Date.now();
    const sws = this.levelSwitches(eq);
    for (const sw of [sws.hi, sws.lo]) {
      if (!sw.input) continue;
      const key = `${eq.id}:${sw.covered}`;
      const raw = this.rawCovered(eq, sw);
      let d = this.debouncedCovered.get(key);
      if (!d || d.input !== sw.input) { d = { input: sw.input, covered: raw, since: now }; this.debouncedCovered.set(key, d); }
      if (raw === d.covered) { d.pending = undefined; continue; }
      if (d.pending !== raw) { d.pending = raw; d.since = now; }
      if (now - d.since >= (raw === (sw === sws.hi) ? delayMs(eq.config[sw.delay]) : 0)) { d.covered = raw; d.pending = undefined; }
    }
  }

  private sensorCovered(eq: EquipmentRuntime, sw: { input?: string; covered: string }): boolean | undefined {
    if (!sw.input) return undefined;
    const d = this.debouncedCovered.get(`${eq.id}:${sw.covered}`);
    return d && d.input === sw.input ? d.covered : this.rawCovered(eq, sw);
  }

  // High switch covered = full. Low switch covered = material above the low point; uncovered = empty.
  // An unwired switch is ignored. High covered with low uncovered is contradictory -> 'fault'. undefined = no switches wired.
  private levelState(binId: string): LevelSwitchState | undefined {
    const eq = this.equipment.get(binId);
    if (!eq) return undefined;
    const { hi, lo } = this.levelSwitches(eq);
    if (!hi.input && !lo.input) return undefined;
    const high = this.sensorCovered(eq, hi);
    const low = this.sensorCovered(eq, lo);
    if (high && low === false) return 'fault';
    return high ? 'full' : low === false ? 'empty' : 'normal';
  }

  private checkLevelSensors() {
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType !== 'bin' && eq.equipmentType !== 'finished_bin') continue;
      this.updateLevelDebounce(eq);
      if (this.levelState(eq.id) === 'fault') {
        this.raiseFault(eq.id, 'WARNING', `${eq.name}: high level covered but low level not covered (level switches disagree)`, 'W-LV-01');
      } else {
        const f = this.faults.find(x => x.equipment === eq.id && x.code === 'W-LV-01' && x.active);
        if (f) { f.active = false; f.clearedAt = new Date().toISOString(); persistFault(f); }
      }
    }
  }

  // ── VFD speed ──

  private speedLimits(eq: EquipmentRuntime): [number, number] {
    return [Number(eq.config.speedMinLimit ?? 0), Number(eq.config.speedMaxLimit ?? 100)];
  }

  // Runs before the batch engine, which overrides the active auger's speed while dosing.
  private applyAugerSpeeds() {
    for (const eq of this.equipment.values()) {
      if (eq.config.analogSpeedOutput) this.setAugerSpeed(eq, eq.speed ?? 100);
    }
  }

  // ── hammermill automatic refill ──

  private pauseHammermill(hm: EquipmentRuntime) {
    hm.mode = 'Off';
    hm.status = 'disabled';
    hm.request = false;
  }

  private abortRefills() {
    for (const hmId of this.refills.keys()) this.releaseEquipment(`REFILL-${hmId}`);
    this.refills.clear();
  }

  private hammermillReady(hm: EquipmentRuntime): boolean {
    return hm.mode === 'Auto' && !!hm.config.autoEnable
      && hm.status !== 'fault' && hm.status !== 'disabled';
  }

  // Equipment between the mill and its destination bin, plus augers feeding the mill.
  private refillPath(hm: EquipmentRuntime): { dest: string; sources: string[]; downstream: string[] } | null {
    const dest = hm.config.destination as string | undefined;
    if (!dest || !this.equipment.has(dest)) return null;
    const prev = new Map<string, string>([[hm.id, '']]);
    const queue = [hm.id];
    while (queue.length && !prev.has(dest)) {
      const cur = queue.shift()!;
      for (const c of this.connections) {
        if (c.from === cur && !prev.has(c.to)) { prev.set(c.to, cur); queue.push(c.to); }
      }
    }
    if (!prev.has(dest)) return null;
    const downstream: string[] = [];
    for (let n = prev.get(dest)!; n && n !== hm.id; n = prev.get(n)!) downstream.unshift(n);
    const sources = this.connections
      .filter(c => c.to === hm.id && this.equipment.get(c.from)?.equipmentType === 'auger')
      .map(c => c.from);
    return { dest, sources, downstream };
  }

  private updateRefills() {
    for (const hm of this.equipment.values()) {
      if (hm.equipmentType !== 'hammermill') continue;
      const r = this.refills.get(hm.id);
      if (r) this.advanceRefill(hm, r);
      else this.tryStartRefill(hm);
    }
  }

  // A low switch latches the request (the running cycle IS the latch); only the high switch ends it.
  private tryStartRefill(hm: EquipmentRuntime) {
    if (!this.hammermillReady(hm)) return;
    const path = this.refillPath(hm);
    if (!path || path.sources.length === 0) return;
    if (this.levelState(path.dest) !== 'empty') return;
    if (this.faults.some(f => f.active && f.equipment === hm.id && f.code.startsWith('E-HM'))) return;
    // Don't refill and dose the same bin at once (spec 20, proposed exclusion).
    if (this.activeBatch?.dosingSteps.some(s => s.sourceBinId === path.dest && s.state !== 'complete')) return;
    const ids = [...path.downstream, hm.id, ...path.sources];
    for (const id of ids) {
      const eq = this.equipment.get(id);
      if (!eq || eq.owner || eq.status === 'fault') return;
      if (id !== hm.id && (eq.mode !== 'Auto' || eq.status === 'disabled')) return;
    }
    for (const id of ids) this.equipment.get(id)!.owner = `REFILL-${hm.id}`;
    this.refills.set(hm.id, { state: 'STARTING', path: ids, dest: path.dest, startedAt: Date.now() });
  }

  private advanceRefill(hm: EquipmentRuntime, r: Refill) {
    if (r.state === 'STOPPING') {
      // requests are down; wait for every motor's stop delay to run out (gates just close)
      if (r.path.every(id => { const e = this.equipment.get(id); return !e || e.equipmentType === 'gate' || !e.runCmd; })) {
        this.releaseEquipment(`REFILL-${hm.id}`);
        this.refills.delete(hm.id);
        if (r.fault) this.raiseFault(hm.id, 'CRITICAL', r.fault.message, r.fault.code);
        if (hm.mode === 'Off') this.pauseHammermill(hm);
      }
      return;
    }

    const faulted = r.path.find(id => this.equipment.get(id)?.status === 'fault');
    if (faulted) return this.beginRefillStop(r, { code: 'E-HM-02', message: `${hm.name}: refill stopped, ${faulted} faulted` });
    const maxMs = (Number(hm.config.maxFillMinutes) || 60) * 60000;
    if (Date.now() - r.startedAt > maxMs) return this.beginRefillStop(r, { code: 'E-HM-03', message: `${hm.name}: refill exceeded max fill time without reaching high level` });
    // Stop (no fault) on pause/disable, destination high, or unusable level switches.
    const dest = this.levelState(r.dest);
    if (!this.hammermillReady(hm) || (dest !== 'empty' && dest !== 'normal')) return this.beginRefillStop(r);

    for (const id of r.path) { const e = this.equipment.get(id); if (e) e.request = true; }
    if (r.state === 'STARTING' && r.path.every(id => this.equipment.get(id)?.status === 'running')) r.state = 'FILLING';
  }

  private beginRefillStop(r: Refill, fault?: { code: string; message: string }) {
    r.state = 'STOPPING';
    r.fault = fault;
    for (const id of r.path) { const e = this.equipment.get(id); if (e) e.request = false; }
  }

  // ── output computation ──

  private computeOutputs() {
    Object.assign(this.ioOutputs, this.outImage);
    this.outImage = {};
    writeIoCommand(this.ioOutputs, this.signals);
  }

  // ── snapshot ──

  getSnapshot(): StateSnapshot {
    const eqList = Array.from(this.equipment.values()).map(eq => ({
      id: eq.id, name: eq.name, equipmentType: eq.equipmentType, class: eq.class,
      status: eq.status, mode: eq.mode, commanded: eq.runCmd, feedback: eq.feedback,
      faultReason: eq.faultReason, warningReason: eq.warningReason, owner: eq.owner,
      config: eq.config, position: eq.position, gatePosition: eq.gatePosition,
      speed: eq.speed, refillState: this.refills.get(eq.id)?.state,
    }));

    const batchToQueue = (b: BatchRuntime): QueueSnapshot => {
      const totalTarget = b.dosingSteps.reduce((s, st) => s + st.target, 0);
      const totalActual = b.dosingSteps.reduce((s, st) => s + st.actual, 0);
      let progress = 0;
      if (b.state === 'COMPLETED') progress = 100;
      else if (b.state === 'MIXING') progress = 50 + 40 * (1 - b.mixTimeRemainingMs / Math.max(1, b.mixTimeTotalMs));
      else if (b.state === 'DOSING') progress = totalTarget > 0 ? Math.round(50 * totalActual / totalTarget) : 0;
      else if (['DISCHARGING', 'CLEAROUT'].includes(b.state)) progress = 92;
      return {
        id: b.id, recipeId: b.recipeId, recipeName: b.recipeName,
        targetMass: b.targetMass, destination: b.destination, state: b.state,
        progress,
        startedAt: b.startedAt, completedAt: b.completedAt,
        dosingSteps: b.dosingSteps.map(s => ({
          ingredientId: s.ingredientId, ingredientName: s.ingredientName,
          sourceBinId: s.sourceBinId, target: s.target,
          actual: Math.round(s.actual * 10) / 10, unit: s.unit, state: s.state,
        })),
        mixTimeRemainingMs: b.mixTimeRemainingMs, mixTimeTotalMs: b.mixTimeTotalMs,
        faultReason: b.faultReason,
      };
    };

    return {
      revision: this.revision,
      timestamp: new Date().toISOString(),
      equipment: eqList,
      queue: this.queue.map(batchToQueue),
      activeBatch: this.activeBatch ? batchToQueue(this.activeBatch) : null,
      faults: this.faults,
      bins: this.bins.map(b => ({ ...b, levelSwitchState: this.levelState(b.id) })),
      recipes: this.recipes,
      ingredients: this.ingredients,
      connections: this.connections,
      io: { inputs: { ...this.ioInputs }, outputs: { ...this.ioOutputs }, signals: this.signals, overrides: { ...this.ioOverrides } },
      scales: { ...this.scales },
      scaleConfigs: this.scaleConfigs,
      omronConfig: { ...this.omronConfig, cards: this.omronConfig.cards.map(c => ({ ...c })) },
      globalConfig: { ...this.globalConfig },
      networkInterfaces: this.networkInterfaces,
    };
  }

  // ── helpers ──

  private raiseFault(eqId: string, severity: Fault['severity'], message: string, code: string) {
    if (this.faults.some(f => f.equipment === eqId && f.code === code && f.active)) return;
    const fault: Fault = {
      id: `F-${this.faultSeq++}`, severity, equipment: eqId,
      message, code, raisedAt: new Date().toISOString(),
      clearedAt: null, acknowledgedAt: null, active: true,
    };
    this.faults.unshift(fault);
    persistFault(fault);
  }

  private readOmronRack() {
    const om = this.omronConfig;
    let driverWarnings: string[] = [];
    if (om.couplerType === 'NX-ECC') {
      const result = verifyEthercatRack(om);
      om.cards = result.cards;
      driverWarnings = result.warnings;
    } else {
      // Production: CIP identity query to coupler. Sim: echo configured layout.
      for (const card of om.cards) {
        card.actual = card.model;
        card.status = 'ok';
      }
    }
    om.rackVerified = true;
    om.lastReadAt = new Date().toISOString();
    this.validateRack();
    om.warnings.push(...driverWarnings);
    if (om.couplerType === 'NX-ECC') {
      om.warnings.push(...syncIoConf(om, this.signals, this.equipment.values(), this.scaleConfigs));
    }
    this.verifyRack();
  }

  private validateRack() {
    const om = this.omronConfig;
    om.warnings = [];
    if (om.couplerType === 'NX-ECC') {
      if (!om.ethercatInterface) {
        om.warnings.push('EtherCAT master NIC not set — select the dedicated Debian interface');
      }
      const minCycle = ECC_MODEL_MIN_CYCLE_US[om.eccModel];
      if (om.cycleTimeUs < minCycle) {
        om.warnings.push(`Cycle time ${om.cycleTimeUs}µs is below ${om.eccModel}'s minimum (${minCycle}µs)`);
      }
      if (om.ringTopology && om.eccModel !== 'NX-ECC203') {
        om.warnings.push('Ring topology requires NX-ECC203 (v1.5 or later)');
      }
    }
    if (om.couplerType === 'none' || om.cards.length === 0) return;

    // NX-PF0630/PF0730 ("I/O power feed unit") is NOT required just because
    // I/O cards exist — confirmed from Omron's NX-series I/O datasheet: the
    // coupler's own terminal block has a separate I/O power supply input
    // (up to 10A on an ECC203) that feeds the NX bus directly. NX-PF units
    // are listed as being "for separation of groups" — i.e. an additional
    // feed point for current beyond the coupler's own rating or an
    // electrically isolated zone, not a mandatory first unit. No warning
    // here; only check its placement below, if one happens to be present.

    // NX Bus power zones: coupler supplies 10W, NX-PD1000 starts a new 10W zone
    let zoneIdx = 0;
    let zoneW = 0;
    for (const card of om.cards) {
      const def = NX_CARD_CATALOG.find(d => d.model === card.model);
      if (!def) continue;
      if (card.model === 'NX-PD1000') {
        zoneW += def.busWatts; // PD1000 draws 0.45W from upstream zone
        if (zoneW > NX_BUS_POWER_BUDGET_W) {
          om.warnings.push(`Zone ${zoneIdx} bus power (${zoneW.toFixed(1)}W) exceeds ${NX_BUS_POWER_BUDGET_W}W budget`);
        }
        zoneIdx++;
        zoneW = 0; // new zone starts with PD1000's 10W
      } else {
        zoneW += def.busWatts;
      }
    }
    if (zoneW > NX_BUS_POWER_BUDGET_W) {
      const label = zoneIdx === 0 ? 'NX Bus power' : `Zone ${zoneIdx} bus power`;
      om.warnings.push(`${label} (${zoneW.toFixed(1)}W) exceeds ${NX_BUS_POWER_BUDGET_W}W budget — add NX-PD1000`);
    }

    if (om.cards.length > NX_MAX_UNITS) {
      om.warnings.push(`Too many units (${om.cards.length}) — coupler supports max ${NX_MAX_UNITS}`);
    }

    // (Dropped the "NX-PF0730 must be in slot 1" check along with the
    // "required" one above — same unverified assumption. If you do add an
    // I/O power feed unit, place it wherever its "separation of groups"
    // zone needs to start, same as NX-PD1000 for NX bus power below.)
  }

  private verifyRack() {
    const om = this.omronConfig;
    if (om.couplerType === 'none' || !om.rackVerified) return;
    const mismatched: string[] = [];
    for (const card of om.cards) {
      if (card.status === 'mismatch' || card.status === 'missing') {
        mismatched.push(`Slot ${card.slot}: expected ${card.model}, got ${card.actual ?? 'empty'}`);
      }
    }
    if (mismatched.length > 0) {
      this.rackFaultShutdown(mismatched);
    } else {
      this.clearRackFault(); // rack matches again (e.g. a reseated card) — the watchdog resolves this on its own
    }
  }

  private rackFaultShutdown(mismatched: string[]) {
    this.raiseFault('OMRON', 'CRITICAL',
      `Rack mismatch: ${mismatched.join('; ')}`, 'E-OM-01');
    this.abortRefills();
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'hammermill') this.pauseHammermill(eq);
    }
    if (this.activeBatch && !['COMPLETED', 'FAULTED', 'IDLE', 'PAUSED'].includes(this.activeBatch.state)) {
      this.activeBatch.previousState = this.activeBatch.state;
      this.activeBatch.state = 'PAUSED';
      this.activeBatch.faultReason = 'I/O rack mismatch — cards missing or wrong type';
    }
  }

  private clearRackFault() {
    const idx = this.faults.findIndex(f => f.code === 'E-OM-01' && f.active);
    if (idx >= 0) {
      this.faults[idx].active = false;
      this.faults[idx].clearedAt = new Date().toISOString();
      persistFault(this.faults[idx]); // now runs from the watchdog too, not just on reconfigure — keep fault_log in sync
    }
  }

  private batchFault(b: BatchRuntime, reason: string) {
    b.state = 'FAULTED';
    b.faultReason = reason;
    this.releaseEquipment(b.id);
    this.raiseFault('BATCH', 'CRITICAL', `Batch ${b.id}: ${reason}`, 'E-BA-01');
    persistBatch(b);
  }

  private releaseEquipment(ownerId: string) {
    for (const eq of this.equipment.values()) {
      if (eq.owner === ownerId) { eq.request = false; eq.owner = undefined; }
    }
  }

  private findEquipmentByType(type: string): EquipmentRuntime | undefined {
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === type) return eq;
    }
    return undefined;
  }

  private findBinForIngredient(ingredientId: string): Bin | undefined {
    return this.bins
      .filter(b => b.ingredientId === ingredientId && b.type !== 'finished')
      .sort((a, b) => {
        const na = parseInt(a.id.replace(/\D/g, '')) || 0;
        const nb = parseInt(b.id.replace(/\D/g, '')) || 0;
        return na - nb;
      })[0];
  }

  private findAugerForBin(binId: string): string | undefined {
    for (const conn of this.connections) {
      if (conn.from === binId) return conn.to;
    }
    return undefined;
  }

  private findGateForDischarge(): EquipmentRuntime | undefined {
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'gate') return eq;
    }
    return undefined;
  }

  private getMixerScale(): ScaleReading | undefined {
    const mixer = this.findEquipmentByType('mixer');
    const id = mixer?.config.scaleId as string | undefined;
    if (id) return this.scales[id];
    return this.scales[Object.keys(this.scales)[0] ?? ''];
  }

  private hasMappedScales(): boolean {
    const mixer = this.findEquipmentByType('mixer');
    return !!(mixer?.config.scaleId);
  }

  // ── default config matching hmi-prototype ──

  private loadDefaults() {
    this.ingredients = [];
    this.recipes = [];
    this.bins = [];
    this.connections = [];
    this.buildSignals();
  }

  private buildSignals() {
    this.signals = [];
    this.ioInputs = {};
    this.ioOutputs = {};
    const addSig = (id: string, dir: SignalDef['direction'], label: string, eqId?: string, port?: string) => {
      if (!id) return;
      if (this.signals.some(s => s.id === id)) return;
      this.signals.push({ id, direction: dir, label, equipmentId: eqId, port });
    };

    const om = this.omronConfig;
    if (om.couplerType !== 'none' && om.cards.length > 0) {
      const prefixMap: Record<string, string> = { DI: 'I', DO: 'O', AI: 'AI', AO: 'AO' };
      for (const card of om.cards) {
        const def = NX_CARD_CATALOG.find(d => d.model === card.model);
        if (!def || def.category === 'power' || def.category === 'scale') continue;
        const prefix = prefixMap[def.category];
        const cc = String(card.slot).padStart(2, '0');
        for (let p = 0; p < def.points; p++) {
          const pp = String(p).padStart(2, '0');
          addSig(`${prefix}:${cc}.${pp}`, def.category as SignalDef['direction'], `${def.label} Slot ${card.slot} ${def.points > 4 ? 'Pt' : 'Ch'} ${p}`);
        }
      }
    } else {
      // Default generic I/O pool
      for (let i = 1; i <= 48; i++) {
        addSig(`DO-${i}`, 'DO', `Digital Output ${i}`);
        addSig(`DI-${i}`, 'DI', `Digital Input ${i}`);
      }
      for (let i = 1; i <= 16; i++) {
        addSig(`AO-${i}`, 'AO', `Analog Output ${i}`);
        addSig(`AI-${i}`, 'AI', `Analog Input ${i}`);
      }
    }

    // Initialize all to off/zero
    for (const s of this.signals) {
      if (s.direction === 'DI' || s.direction === 'DO') {
        this.ioInputs[s.id] = false;
        this.ioOutputs[s.id] = false;
      } else {
        this.ioInputs[s.id] = 0;
        this.ioOutputs[s.id] = 0;
      }
    }

    // Map equipment configs to signals
    for (const eq of this.equipment.values()) {
      for (const [key, label] of Object.entries(PORT_LABELS)) {
        const id = eq.config[key];
        if (!id) continue;
        const sig = this.signals.find(sg => sg.id === id);
        if (sig) { sig.equipmentId = eq.id; sig.port = key; sig.label = `${eq.id} ${label}`; }
      }
    }

    // Keep the io_daemon's channel list in sync with the signals just
    // rebuilt above — it has no config of its own to fall out of date.
    // Mapping-gap warnings surface via readOmronRack() instead of here,
    // since that's where om.warnings gets freshly rebuilt; this call's
    // warnings would otherwise pile up unbounded.
    syncIoConf(om, this.signals, this.equipment.values(), this.scaleConfigs);
  }
}
