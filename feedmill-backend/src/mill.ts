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
import { verifyEthercatRack, discoverRack, syncIoConf, checkRackPresence, clearCouplerErrors, runRs1201Calibration, type ScaleCalStep } from './ethercat.js';
import { MovingAverage, OnDelay, LoadPid, RelayTuner, scaleLinear } from './loadControl.js';
import { Debounce } from './monitors.js';
import { readIoState, writeIoCommand, rawToPct, fullScaleFor, NX_ANALOG_DISCONNECT_RAW } from './ioDaemon.js';
import { loadConfig, saveConfig, type MillConfig } from './config.js';
import {
  openDb, closeDb, persistBatch, clearActiveBatch, loadActiveBatch,
  archiveBatch, postInventoryEvent, persistFault, loadFaults,
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
// Per-device input bypasses ("Overrides" in the sidebar): the input is ignored as if it were not assigned.
const BYPASSABLE = ['runConfirmAux', 'vfdAuxInput', 'motorAuxInput', 'analogLoadInput', 'rotationPulseInput', 'openLimitInput', 'closedLimitInput',
  'highLevelInput', 'lowLevelInput'];
// Faults that latch their equipment in 'fault' until reset (restored on boot if the equipment state was lost).
const TRIP_CODES = ['E-MT-01', 'E-MT-02', 'E-MT-03', 'E-LD-01', 'E-LD-03', 'E-GT-01', 'E-GT-03', 'W-GT-02'];
type LoadMon = { avgSize: number; avg: MovingAverage; hiWarn: OnDelay; hiPause: OnDelay; pid: LoadPid; tuner?: RelayTuner; tuneBase?: number; tuneWasAuto?: boolean };

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
  runOutput: 'MS Coil', runConfirmAux: 'MS Aux', openOutput: 'P1', closeOutput: 'P2',
  openLimitInput: 'P1 FB', closedLimitInput: 'P2 FB',
  highLevelInput: 'High Switch', lowLevelInput: 'Low Switch',
  analogSpeedOutput: 'Speed', analogLoadInput: 'Load', rotationPulseInput: 'Rotation',
  vfdRunOutput: 'VFD Fwd', vfdAuxInput: 'VFD Aux', motorAuxInput: 'MS Aux',
};

// Hammermills have no rotation switch: drop its keys wherever a hammermill's config enters (load, add, update).
const HM_NO_ROTATION = ['rotationPulseInput', 'pulsesPerRev', 'minRpm', 'rotationStartupDelay', 'bypass_rotationPulseInput'];
function stripHammermillRotation(eq: EquipmentRuntime) {
  if (eq.equipmentType === 'hammermill') for (const k of HM_NO_ROTATION) delete eq.config[k];
}

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
  // A signal shared by several motors (a common VFD run output) is on while any of them wants it.
  private outOr(sig: string | undefined, value: boolean) { if (sig) this.outImage[sig] = this.outImage[sig] === true || value; }
  // Forcing an OUTPUT is the commissioning tool: never while a batch is in progress or a hammermill is enabled.
  // (Input overrides are not guarded; they energize nothing.)
  private outputForcesActive() {
    return Object.keys(this.ioOverrides).some(id => { const d = this.signals.find(s => s.id === id)?.direction; return d === 'DO' || d === 'AO'; });
  }
  private forceBlockedReason(): string | null {
    if (this.activeBatch && !['COMPLETED', 'FAULTED', 'IDLE'].includes(this.activeBatch.state)) return 'A batch is in progress';
    if (Array.from(this.equipment.values()).some(e => e.equipmentType === 'hammermill' && e.enabled)) return 'A hammermill is enabled - disable it first';
    return null;
  }
  private rotationState = new Map<string, { runningMs: number; rpm?: number }>();
  private lastDaemonStartUs: number | null = null; // detects an io_daemon restart (see updateBusHealth)
  ioOverrides: Record<string, SignalValue> = {};
  // Gates forcing an output via SetOverride; never persisted, so a restart
  // never comes back up with this on. Resets any forced outputs on exit.
  commissioningMode = false;
  scaleConfigs: ScaleConfig[] = [];
  scaleConfigVersion = 0; // bumped on ConfigureScale/RemoveScale — server.ts watches this to restart scale readers
  omronConfig: OmronConfig = { couplerType: 'none', ipAddress: '', nodeAddress: 1, ethercatInterface: '', eccModel: 'NX-ECC203', cycleTimeUs: 5000, ringTopology: false, cards: [], rackVerified: false, warnings: [] };
  globalConfig: Record<string, string | number> = { motorStarterFaultDelay: 0.5, siteName: 'FEED MILL CONTROLLER' };
  networkInterfaces: string[] = listCandidateNics(); // computed once at startup; restart the service to pick up newly added NICs
  private faultSeq = 300;
  private batchSeq = 2000;
  private batchPersistCounter = 0;
  private persistTicks = 0;
  private aiDisconnected = new Set<string>();
  private loadMon = new Map<string, LoadMon>();
  // 1 Hz load trend per motor, last 10 minutes (served by GET /api/v1/trend/:id, not pushed in the snapshot)
  private trends = new Map<string, { t: number; a: number; s?: number; sp?: number }[]>();
  private trendTicks = 0;
  // Alarm horn (PLC R137-R143): beeps while any fault is active, a silence (HMI or input) toggles it, a NEW fault re-arms it,
  // and it silences itself after hornAutoSilenceSec.
  private hornSilenced = false;
  private hornAutoMs = 0;
  private hornPhaseOn = true;
  private hornPhaseMs = 0;
  private hornInPrev = false;
  private hornOn = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private rackWatchdogHandle: ReturnType<typeof setInterval> | null = null;
  private onChange?: () => void;

  constructor() {
    openDb();
    this.faults = loadFaults(); // the fault list stays through a power cycle
    this.faultSeq = Math.max(this.faultSeq, ...this.faults.map(f => (parseInt(f.id.replace(/\D/g, ''), 10) || 0) + 1));
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
        this.pauseHammermill(eq);
      }
    }
    // gates no longer have Hand (they have P1 / P2): a saved Hand selection becomes Off
    for (const eq of this.equipment.values()) if (eq.equipmentType === 'gate' && eq.mode === 'Hand') eq.mode = 'Off';
    this.restoreTripLatches();
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
      // finished bins used to name their level switches fullSensor/lowSensor; same device as a bin's, same keys now
      for (const [o, n] of [['fullSensor', 'highLevelInput'], ['fullSensorCovered', 'highLevelCovered'], ['bypass_fullSensor', 'bypass_highLevelInput'],
                            ['lowSensor', 'lowLevelInput'], ['lowSensorCovered', 'lowLevelCovered'], ['bypass_lowSensor', 'bypass_lowLevelInput']]) {
        if (o in eq.config) { if (!(n in eq.config)) eq.config[n] = eq.config[o]; delete eq.config[o]; }
      }
      stripHammermillRotation(eq);
      Object.assign(eq, { request: false, runCmd: false, startTimerMs: 0, stopTimerMs: 0, loadControlAuto: false });
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
        if (eq.equipmentType === 'bin' || eq.equipmentType === 'finished_bin') return reject('Bins have no HOA (no motor)');
        const allowed = eq.equipmentType === 'gate' ? ['P1', 'P2', 'Auto', 'Off'] : ['Hand', 'Auto', 'Off'];
        if (!mode || !allowed.includes(mode)) return reject('Invalid mode');
        // A hammermill mid-refill may be switched Off (HOA): the refill then does its controlled stop.
        const pausingMill = eq.equipmentType === 'hammermill' && mode === 'Off' && !!eq.owner?.startsWith('REFILL-');
        if (eq.owner && mode !== 'Auto' && !pausingMill) return reject('Equipment owned by batch ' + eq.owner);
        // A tripped motor stays tripped until ResetEquipmentFault; changing mode no longer clears it.
        eq.mode = mode;
        return ok();
      }

      case 'SetEquipmentSpeed': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        if (!eq.config.analogSpeedOutput) return reject('No analog speed output assigned');
        if (Array.from(this.equipment.values()).some(e => (e.loadControlAuto || e.loadAtRunning) && e.config.loadControlFeeder === eq.id)) return reject('Speed is under load control or autotune (switch it to Manual first)');
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
        if (!this.estopOk()) return reject('E-stop active'); if (this.outputForcesActive()) return reject('Clear the forced outputs first');
        batch.state = 'VALIDATING';
        batch.startedAt = new Date().toISOString();
        this.activeBatch = batch;
        persistBatch(batch);
        return ok();
      }

      case 'PauseBatch': {
        if (!this.activeBatch) return reject('No active batch');
        if (!this.pauseActiveBatch()) return reject('Cannot pause in state ' + this.activeBatch.state);
        return ok();
      }

      case 'ResumeBatch': {
        if (!this.activeBatch) return reject('No active batch');
        const b = this.activeBatch;
        if (b.state !== 'PAUSED') return reject('Batch not paused');
        if (!this.estopOk()) return reject('E-stop active'); if (this.outputForcesActive()) return reject('Clear the forced outputs first');
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

      case 'SetHammermillEnabled': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq || eq.equipmentType !== 'hammermill') return reject('Hammermill not found');
        if (cmd.parameters?.enabled) {
          if (!this.estopOk()) return reject('E-stop active'); if (this.outputForcesActive()) return reject('Clear the forced outputs first');
          this.enableHammermill(eq);
        } else if (eq.owner?.startsWith('REFILL-')) eq.enabled = false; // mid-refill: the refill does its controlled stop
        else this.pauseHammermill(eq);
        return ok();
      }

      case 'SetLoadControl': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        const p = cmd.parameters ?? {};
        if (typeof p.setpoint === 'number' && Number.isFinite(p.setpoint) && p.setpoint >= 0) eq.config.loadSetpointAmps = p.setpoint;
        if (typeof p.auto === 'boolean' && eq.loadAtRunning) return reject('Autotune is running (cancel it first)');
        if (p.auto === true) {
          const feeder = this.equipment.get(String(eq.config.loadControlFeeder ?? ''));
          if (!feeder?.config.analogSpeedOutput) return reject('Load control needs a feeder with an analog speed output');
          if (!(Number(eq.config.maxAmps ?? 0) > Number(eq.config.minAmps ?? 0))) return reject('Load input needs Min/Max Amps');
          if (!(Number(eq.config.loadSetpointAmps ?? 0) > 0)) return reject('Set a load setpoint first');
          if (this.byp(eq, 'analogLoadInput')) return reject('Load monitoring is bypassed');
          eq.loadControlAuto = true;
        } else if (p.auto === false) eq.loadControlAuto = false;
        this.persistConfig();
        return ok();
      }

      // Per-machine load settings that are safe to change while the mill runs (the general config edit is blocked mid-batch).
      case 'SetLoadConfig': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        const v = cmd.parameters?.values as Record<string, unknown> | undefined;
        if (!eq || !v || typeof v !== 'object') return reject('Unknown equipment');
        const NUM = ['hiWarnAmps', 'hiPauseAmps', 'loadLimitDelay', 'loadSetpointAmps', 'loadKp', 'loadTiSec', 'loadTdSec', 'loadAtStepPct', 'loadAtHyst', 'loadAtGain'];
        for (const [k, val] of Object.entries(v)) {
          if (NUM.includes(k)) { if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return reject(`${k} must be a number >= 0`); }
          else return reject(`Not a runtime setting: ${k}`);
        }
        const merged = { ...eq.config, ...v };
        if (Number(merged.hiWarnAmps ?? 0) > 0 && Number(merged.hiPauseAmps ?? 0) > 0 && Number(merged.hiWarnAmps) >= Number(merged.hiPauseAmps)) return reject('High warning must be below the high limit');
        Object.assign(eq.config, v);
        this.persistConfig();
        return ok();
      }

      case 'SetBypass': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        const key = String(cmd.parameters?.key ?? '');
        const value = cmd.parameters?.value;
        if (!eq) return reject('Unknown equipment');
        if (!BYPASSABLE.includes(key) || typeof value !== 'boolean') return reject('Not a bypassable input');
        if (value && !eq.config[key]) return reject('That input is not assigned on this equipment');
        if (value) eq.config[`bypass_${key}`] = true; else delete eq.config[`bypass_${key}`];
        this.persistConfig();
        return ok();
      }

      case 'StartLoadAutotune': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        const m = eq && this.loadMon.get(eq.id);
        if (!eq || !m) return reject('No load input on this equipment');
        const feeder = this.equipment.get(String(eq.config.loadControlFeeder ?? ''));
        if (!feeder?.config.analogSpeedOutput) return reject('Load control needs a feeder with an analog speed output');
        if (this.byp(eq, 'analogLoadInput')) return reject('Load monitoring is bypassed');
        if (eq.loadAmps === undefined) return reject('No load reading');
        if (eq.status !== 'running' || feeder.status !== 'running') return reject('Run the mill and feeder first');
        const sp = Number(eq.config.loadSetpointAmps ?? 0);
        if (!(sp > 0)) return reject('Set a load setpoint first');
        const [lo, hi] = this.speedLimits(feeder);
        const base = feeder.speed ?? 100;
        m.tuneBase = base;
        m.tuneWasAuto = !!eq.loadControlAuto;
        m.tuner = new RelayTuner(sp, base, Number(eq.config.loadAtStepPct ?? 10), Number(eq.config.loadAtHyst ?? 1), lo, hi, eq.loadAmps);
        eq.loadControlAuto = false;
        eq.loadAtRunning = true;
        eq.loadAtMsg = 'Autotune running';
        return ok();
      }

      case 'CancelLoadAutotune': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        const m = eq && this.loadMon.get(eq.id);
        if (!eq || !m?.tuner) return reject('No autotune running');
        this.endTune(eq, m, 'Autotune cancelled', this.equipment.get(String(eq.config.loadControlFeeder ?? '')));
        return ok();
      }

      case 'SilenceHorn': {
        this.toggleHornSilence();
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
        // Only clearing a trip fault releases the equipment's latch, and only when no other trip fault is still active on it.
        const eq = this.equipment.get(f.equipment);
        if (eq && eq.status === 'fault' && TRIP_CODES.includes(f.code) && !this.faults.some(x => x.active && x.equipment === eq.id && TRIP_CODES.includes(x.code))) {
          eq.status = 'not_running'; eq.faultReason = undefined; eq.faultTimerMs = 0;
        }
        return ok();
      }

      case 'ResetEquipmentFault': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        if (eq.status !== 'fault') return reject('No fault');
        eq.status = 'not_running';
        eq.faultReason = undefined;
        eq.faultTimerMs = 0;
        // clear every active trip fault of this equipment (not warnings): a left-over one would re-latch it after a restart
        for (const f of this.faults) {
          if (f.equipment === eq.id && f.active && TRIP_CODES.includes(f.code)) { f.active = false; f.clearedAt = new Date().toISOString(); persistFault(f); }
        }
        return ok();
      }

      case 'ResetRunHours': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        if (!eq) return reject('Unknown equipment');
        eq.runSeconds = 0;
        eq.runSecondsResetAt = new Date().toISOString();
        this.persistConfig();
        return ok();
      }

      case 'SetOverride': {
        const sig = cmd.targetId;
        const val = cmd.parameters?.value;
        if (!sig || val === undefined) return reject('Missing signal or value');
        const sigDef = this.signals.find(s => s.id === sig);
        const isOutput = sigDef?.direction === 'DO' || sigDef?.direction === 'AO';
        const blocked = isOutput ? this.forceBlockedReason() : null;
        if (blocked) return reject(`Cannot force an output: ${blocked}`);
        if (isOutput && !this.commissioningMode) {
          return reject('Enable commissioning mode to force an output');
        }
        this.ioOverrides[sig] = val as SignalValue;
        return ok();
      }

      case 'ClearOverride': {
        const sig = cmd.targetId;
        if (!sig) return reject('Missing signal');
        delete this.ioOverrides[sig];
        // Released inputs get the real reading back on the next scan's readRealInputs();
        // released outputs get the next scan's control-logic value via computeOutputs().
        return ok();
      }

      case 'SetCommissioningMode': {
        const en = cmd.parameters?.enabled;
        if (typeof en !== 'boolean') return reject('Missing enabled');
        this.commissioningMode = en;
        if (!en) {
          // Leaving commissioning mode drops any forced outputs rather than
          // leaving an actuator stuck at whatever it was forced to.
          for (const id of Object.keys(this.ioOverrides)) {
            const sigDef = this.signals.find(s => s.id === id);
            if (sigDef?.direction === 'DO' || sigDef?.direction === 'AO') delete this.ioOverrides[id];
          }
        }
        return ok();
      }

      case 'ReadOmronRack': {
        // probe: read the rack off the bus while the coupler is still being set up (nothing saved, no cards needed)
        if (cmd.parameters?.probe === true) {
          const r = discoverRack();
          return r.ok ? { ...ok(`${r.cards.length} unit(s) detected`), data: r } : reject(r.error ?? 'Rack read failed');
        }
        if (this.omronConfig.couplerType === 'none') return reject('No coupler configured');
        this.readOmronRack();
        this.persistConfig(); // discoveredRack must survive a restart, or every reboot would need a fresh Read Rack
        return ok();
      }

      case 'ClearEthercatErrors': {
        if (this.omronConfig.couplerType !== 'NX-ECC') return reject('Only supported for NX-ECC couplers');
        const r = clearCouplerErrors();
        if (!r.ok) return reject(`Could not clear coupler errors: ${r.error ?? 'unknown'}`);
        this.readOmronRack(); // re-read so the rack status/warnings reflect what's still wrong
        this.persistConfig();
        return ok();
      }

      case 'CalibrateScale': {
        // mode 'theoretical': load-cell rated capacity + mV/V from the scale's config (W565 equivalent-input calibration).
        // mode 'zero' / 'span': actual-load calibration — empty scale then 'zero'; standard weight on then 'span'.
        const guardErr = this.guardConfigEdit();
        if (guardErr) return reject(guardErr);
        const sc = this.scaleConfigs.find(s => s.id === cmd.targetId);
        if (!sc || sc.connectionType !== 'rs1201') return reject('Not an RS1201 scale');
        if (this.omronConfig.couplerType !== 'NX-ECC') return reject('Requires an NX-ECC coupler');
        const mode = cmd.parameters?.mode;
        const steps: ScaleCalStep[] = [];
        if (mode === 'theoretical') {
          const capacity = Number(cmd.parameters?.capacity ?? sc.capacity);
          const mvv = Number(cmd.parameters?.ratedMvV ?? sc.ratedMvV);
          if (!(capacity > 0) || !(mvv > 0)) return reject('Set the scale capacity and rated mV/V first');
          const zb = Number(cmd.parameters?.zeroBalance ?? 0);
          if (!Number.isFinite(zb)) return reject('Invalid zero balance');
          steps.push({ cmd: 0x90, data: capacity }, { cmd: 0x91, data: mvv }, { cmd: 0x92, data: zb });
          sc.capacity = capacity; sc.ratedMvV = mvv; // keep the saved config in step with what the unit was calibrated to
          if (cmd.parameters?.switchFromActual === true) steps.push({ cmd: 0x40 }); // only needed after a previous actual-load calibration
        } else if (mode === 'zero') {
          steps.push({ cmd: 0x20 });
        } else if (mode === 'span') {
          const w = Number(cmd.parameters?.standardWeight);
          if (!(w > 0)) return reject('Enter the standard weight');
          steps.push({ cmd: 0x93, data: w }, { cmd: 0x30 });
        } else return reject('Unknown calibration mode');
        const r = runRs1201Calibration(sc.rackSlot, steps);
        if (!r.ok) return reject(`Calibration failed: ${r.error}`);
        sc.calibration = { mode, at: new Date().toISOString(), ...(mode === 'span' ? { standardWeight: Number(cmd.parameters?.standardWeight) } : {}) };
        this.persistConfig();
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

  // Config edits, scale calibration and software updates need: batch paused (or none), hammermills disabled, motors not running.
  guardConfigEdit(): string | null {
    if (this.activeBatch && !['PAUSED', 'COMPLETED', 'FAULTED', 'IDLE'].includes(this.activeBatch.state)) {
      return 'Pause the batch first';
    }
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'hammermill' && eq.enabled) return `Disable ${eq.name} first`;
      if (this.isMotor(eq) && eq.status === 'running') return `Stop ${eq.name} first`;
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
        stripHammermillRotation(eq);
        if (p.equipmentType === 'hammermill') this.pauseHammermill(eq);
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
        if (p.config !== undefined) { eq.config = { ...eq.config, ...p.config }; stripHammermillRotation(eq); }
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
        if (p.key.startsWith('stateColor_') && !/^#[0-9a-f]{6}$/i.test(String(p.value))) return reject('Colour must be #rrggbb');
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
    this.updateBusHealth(ioState);
    this.readRealInputs(ioState);
    this.checkLevelSensors();
    this.updateRefills();
    this.updateEquipmentStates();
    this.updateLoadMonitors();
    this.updateRotationSensors(ioState);
    this.updateLoadControl();
    this.applyAugerSpeeds();
    this.advanceBatch();
    this.sampleTrends();
    this.updateHorn();
    this.computeOutputs();
    // run-hour counters change every scan; write them out once a minute (a power cut loses at most that)
    if (++this.persistTicks >= 600) { this.persistTicks = 0; this.persistConfig(); }
    this.revision++;
    this.onChange?.();
  }

  private applyOverrides() {
    for (const [id, val] of Object.entries(this.ioOverrides)) {
      const sigDef = this.signals.find(s => s.id === id);
      if (sigDef?.direction === 'DO' || sigDef?.direction === 'AO') continue; // applied in computeOutputs(), after control logic runs
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
      let v = state.inputs[sig.id];
      if (v !== undefined && sig.direction === 'AI' && typeof v === 'number') {
        // 32767 = wire break (W522 §6-2): hold nothing, fault it, never present it as a reading
        const code = `W-AI-${sig.id}`;
        if (v === NX_ANALOG_DISCONNECT_RAW) {
          this.aiDisconnected.add(sig.id);
          // an open channel nobody is using is normal: only a point mapped to equipment is a fault
          if (sig.equipmentId) this.raiseFault('OMRON', 'WARNING', `${sig.id}: analog input open circuit (sensor disconnected)`, code);
          else this.clearFault(code);
          continue;
        }
        this.aiDisconnected.delete(sig.id);
        this.clearFault(code);
        v = rawToPct(v, fullScaleFor(sig.id, this.omronConfig.cards));
      }
      if (v !== undefined) this.ioInputs[sig.id] = v;
    }
  }

  // The daemon now gates its own reads/writes on a complete working counter
  // and publishes the result as `healthy` (io_daemon.c's run_cycle) instead
  // of this backend trusting "the state file is recent" as proof the I/O
  // underneath it is valid. Once a rack is actually commissioned, no state
  // at all (daemon down) or healthy:false (daemon up, bus degraded) both
  // get the same fail-safe response as a rack mismatch: abort refills,
  // pause hammermills, pause the active batch. Also detects an io_daemon
  // process restart (daemonStartUs changing) and clears any forced output
  // overrides on it — a restarted daemon starts every DO/AO at 0 with no
  // memory of what was forced before, so a stale UI override should not
  // silently resume commanding a value the daemon no longer agrees with.
  private updateBusHealth(state: ReturnType<typeof readIoState>) {
    const om = this.omronConfig;
    if (om.couplerType !== 'NX-ECC' || !om.rackVerified) return; // not commissioned yet — nothing to enforce

    if (state && this.lastDaemonStartUs !== null && state.daemonStartUs !== this.lastDaemonStartUs) {
      const hadOverrides = Object.keys(this.ioOverrides).length > 0;
      this.ioOverrides = {};
      if (hadOverrides) {
        this.raiseFault('OMRON', 'WARNING',
          'io_daemon restarted — forced outputs were cleared; re-force from Commissioning if still needed', 'W-OM-02');
        this.clearFault('W-OM-02'); // one-shot notice, not an ongoing condition
      }
    }
    if (state) this.lastDaemonStartUs = state.daemonStartUs;

    const unhealthy = !state || state.healthy === false;
    if (unhealthy) {
      this.ioFaultShutdown('E-OM-02', state
        ? 'EtherCAT process data invalid (link down or incomplete working counter)'
        : 'io_daemon not reporting (not running, or state file stale)');
    } else {
      this.clearFault('E-OM-02');
    }
  }

  private updateEquipmentStates() {
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'gate') this.updateGate(eq);
    }
    // Motor rungs, like nested PLC rungs: run logic upstream-first (a stop delay starts only once the motors feeding it
    // have stopped), then the downstream permissive downstream-first, then feedback/fault/status/outputs.
    if (!this.estopOk()) {
      this.raiseFault('ESTOP', 'CRITICAL', 'Emergency stop pressed', 'E-ES-01');
      this.pauseActiveBatch(); // motors are already dead (motorRunLogic), so PAUSING completes on the next batch tick
      // Hammermills are disabled (paused) like at startup: the operator must re-enable them, and any refill is dropped.
      this.abortRefills();
      for (const eq of this.equipment.values()) {
        if (eq.equipmentType === 'hammermill' && eq.status !== 'fault' && eq.status !== 'disabled') this.pauseHammermill(eq);
      }
    }
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
  // shaft-sensor pulses AND their edge-to-edge interval in its own EtherCAT
  // cyclic loop — this 100ms scan can't sample fast enough to count them
  // itself. RPM comes from that interval, not from a count delta over this
  // scan's own 100ms window: at 500 RPM/1 pulse-per-rev, edges arrive every
  // 120ms, so a 100ms window aliases between catching 0 or 1 edge (reading
  // ~0 or ~600 RPM) depending only on where the window happens to land.
  private updateRotationSensors(state: ReturnType<typeof readIoState>) {
    const counters = state?.rotation;
    const nowUs = state?.atUs;
    for (const eq of this.equipment.values()) {
      const sig = eq.config.rotationPulseInput as string | undefined;
      if (!sig) continue;
      if (this.byp(eq, 'rotationPulseInput')) { const old = this.rotationState.get(eq.id); if (old) old.rpm = undefined; continue; }

      let st = this.rotationState.get(eq.id);
      if (!st) {
        st = { runningMs: 0 };
        this.rotationState.set(eq.id, st);
      }
      st.runningMs = eq.status === 'running' ? st.runningMs + SCAN_MS : 0;

      if (!counters || !(sig in counters) || nowUs === undefined) {
        // Daemon not running (dev box, or not installed yet) — no live data,
        // so don't guess an RPM and don't fault on missing infrastructure.
        st.rpm = undefined;
        continue;
      }

      const chan = counters[sig];
      const pulsesPerRev = (eq.config.pulsesPerRev as number) || 1;
      const minRpm = eq.config.minRpm as number | undefined;

      // ageUs and chan.lastEdgeUs are both the daemon's own CLOCK_MONOTONIC
      // (state.atUs), so their difference is a valid elapsed time even
      // though neither is comparable to Node's Date.now(). A shaft that's
      // genuinely stopped must read 0, not keep implying its last live
      // speed forever — derive the stopped cutoff from minRpm (2x the edge
      // period that speed implies) when it's configured, so a channel
      // that's merely slow doesn't nuisance-trip to "stopped" before the
      // stall fault below would've fired anyway; fall back to a flat 2s
      // for a channel with no minRpm configured.
      const ageUs = nowUs - chan.lastEdgeUs;
      const stoppedUs = typeof minRpm === 'number' && minRpm > 0
        ? (60_000_000 * pulsesPerRev / minRpm) * 2
        : 2_000_000;
      st.rpm = chan.intervalUs > 0 && chan.lastEdgeUs > 0 && ageUs < stoppedUs
        ? 60_000_000 / (chan.intervalUs * pulsesPerRev)
        : 0;

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

    // Like the PLC's FaultIntlTmp: a trip cancels Hand, so the operator's reset can't restart the motor on its own.
    if (eq.status === 'fault' && eq.mode === 'Hand') eq.mode = 'Off';

    // E-stop: nothing runs, Hand is cancelled (Auto selection survives), and the start timers re-arm on release.
    if (!this.estopOk()) {
      if (eq.mode === 'Hand') eq.mode = 'Off';
      eq.runCmd = false;
      eq.startTimerMs = 0;
      eq.stopTimerMs = 0;
      return;
    }

    if (!usable || eq.mode === 'Off') eq.request = false;
    else if (eq.mode === 'Hand') eq.request = true;
    else if (!eq.owner) eq.request = false; // Auto only runs on a request from a batch / refill; a Hand request must not carry over

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

  // Optional DI wired through the NC e-stop chain (globalConfig.estopInput); true = healthy. Unassigned = no e-stop.
  private estopOk(): boolean {
    const sig = this.globalConfig.estopInput as string | undefined;
    return !sig || !!this.ioInputs[sig];
  }

  private upstreamStopping(eq: EquipmentRuntime): boolean {
    for (const c of this.connections) {
      if (c.to !== eq.id) continue;
      const prev = this.equipment.get(c.from);
      if (prev && this.isMotor(prev) && prev.runCmd && !prev.request) return true;
    }
    return false;
  }

  // The PLC's motor status word (DisWd): off / auto stopped / auto running / hand running / bypass / fault / alarm, applied
  // in the PLC's rung order so the later rule wins. Alarm is kept below Fault (the PLC lets it win; a warning should not hide a trip).
  private displayState(eq: EquipmentRuntime): string {
    if (eq.status === 'disabled') return 'disabled';
    const running = eq.status === 'running';
    const bypassed = BYPASSABLE.some(k => !!eq.config[k] && this.byp(eq, k));
    let st = 'off';
    if (eq.mode === 'Auto') st = running ? 'auto_running' : 'auto_stopped';
    if (bypassed) st = 'bypass';
    if (eq.mode === 'Off') st = 'off';
    if (eq.mode === 'Hand' && running) st = 'hand_running';
    if (eq.warningReason || this.faults.some(f => f.active && f.equipment === eq.id && f.severity === 'WARNING')) st = 'alarm';
    if (eq.status === 'fault') st = 'fault';
    return st;
  }

  // A trip is a latch. If its fault is still active after a restart but the equipment lost its fault state (power cut
  // before config.json was written), put the equipment back in 'fault' so it cannot start until the operator resets it.
  private restoreTripLatches() {
    for (const f of this.faults) {
      const eq = f.active && TRIP_CODES.includes(f.code) ? this.equipment.get(f.equipment) : undefined;
      if (!eq || eq.status === 'fault') continue;
      eq.status = 'fault';
      eq.faultReason = f.message.replace(`${eq.name}: `, '');
      eq.runCmd = false; eq.request = false;
      if (eq.mode === 'Hand') eq.mode = 'Off';
    }
  }

  private byp(eq: EquipmentRuntime, key: string) { return eq.config[`bypass_${key}`] === true; }

  // A protective trip: same latched fault the feedback timeout uses (cleared by ResetEquipmentFault, drops Hand).
  private tripMotor(eq: EquipmentRuntime, reason: string, code: string) {
    eq.status = 'fault';
    eq.faultReason = reason;
    eq.runCmd = false;
    this.raiseFault(eq.id, 'CRITICAL', `${eq.name}: ${reason}`, code);
  }

  // Motor load (amps): moving average of the card's %-of-span, scaled to amps (0% = minAmps, 100% = maxAmps; the % already
  // uses the configured card's full scale, e.g. NX-AD3203 0..8000). As in the PLC (M40) only HIGH current is watched:
  // Hi Warn = warning (+horn), Hi Pause = latched fault that trips the motor and drops Hand. A limit of 0 is off. Limits
  // only count while running, after loadLimitDelay s. A disconnected sensor trips a running motor, unless the operator
  // set the load-input bypass (monitoring disabled: no limits, no disconnect trip, no load control).
  private updateLoadMonitors() {
    for (const eq of this.equipment.values()) {
      const sig = eq.config.analogLoadInput as string | undefined;
      const lo = Number(eq.config.minAmps ?? 0), hi = Number(eq.config.maxAmps ?? 0);
      if (!sig || !this.isMotor(eq) || !(hi > lo)) { eq.loadAmps = undefined; eq.loadDisconnected = undefined; continue; }
      const avgSize = Math.max(1, Number(eq.config.loadAvgSamples ?? 10));
      let m = this.loadMon.get(eq.id);
      if (!m || m.avgSize !== avgSize) {
        m = { avgSize, avg: new MovingAverage(avgSize), hiWarn: new OnDelay(), hiPause: new OnDelay(), pid: new LoadPid(), tuner: m?.tuner, tuneBase: m?.tuneBase };
        this.loadMon.set(eq.id, m);
      }
      const bypass = this.byp(eq, 'analogLoadInput');
      const running = eq.status === 'running';
      eq.loadDisconnected = this.aiDisconnected.has(sig) && !(sig in this.ioOverrides); // an overridden input is a forced value
      if (eq.loadDisconnected) {
        eq.loadAmps = undefined;
        m.avg.reset();
        if (!bypass && eq.runCmd && eq.status !== 'fault') this.tripMotor(eq, 'load sensor disconnected', 'E-LD-03');
        continue;
      }
      const pct = this.ioInputs[sig];
      if (typeof pct !== 'number') { eq.loadAmps = undefined; continue; }
      if (!running) m.avg.reset(); // idle samples must not drag the average down when the motor starts
      const amps = m.avg.push(scaleLinear(pct, lo, hi));
      eq.loadAmps = Math.round(amps * 10) / 10;

      const delay = delayMs(eq.config.loadLimitDelay, 2);
      const lim = (k: string) => Number(eq.config[k] ?? 0);
      const watch = running && !bypass;
      const hiWarn = m.hiWarn.tick(watch && lim('hiWarnAmps') > 0 && amps >= lim('hiWarnAmps'), SCAN_MS, delay);
      const hiPause = m.hiPause.tick(watch && lim('hiPauseAmps') > 0 && amps >= lim('hiPauseAmps'), SCAN_MS, delay);

      eq.warningReason = hiWarn ? 'High load' : undefined;
      if (hiWarn) this.raiseFault(eq.id, 'WARNING', `${eq.name}: high load warning (${eq.loadAmps} A)`, 'W-LD-01');
      if (hiPause) this.tripMotor(eq, `high load (${eq.loadAmps} A)`, 'E-LD-01');
    }
  }

  private endTune(eq: EquipmentRuntime, m: LoadMon, msg: string, feeder?: EquipmentRuntime) {
    if (feeder && m.tuneBase !== undefined) feeder.speed = m.tuneBase; // hand the feeder back at the speed it had
    eq.loadControlAuto = !!m.tuneWasAuto; // like the PLC's PIDAT: control carries on in the mode it was in, with the new constants
    m.tuner = undefined; m.tuneBase = undefined; m.tuneWasAuto = undefined; m.pid.reset();
    eq.loadAtRunning = false; eq.loadAtMsg = msg;
  }

  // Hammermill load control: a velocity-form PID trims the feeder auger's speed to hold the mill's amps at
  // loadSetpointAmps. Runs only in Auto (loadControlAuto) with the mill and feeder both running; otherwise it tracks
  // the feeder's current speed so switching to Auto is bumpless. An autotune (relay test) takes the feeder over instead.
  private updateLoadControl() {
    for (const eq of this.equipment.values()) {
      const m = this.loadMon.get(eq.id);
      if (!m) continue;
      const feeder = this.equipment.get(String(eq.config.loadControlFeeder ?? ''));
      const bypass = this.byp(eq, 'analogLoadInput');
      if (bypass) eq.loadControlAuto = false;
      const ready = !!feeder?.config.analogSpeedOutput && eq.loadAmps !== undefined && !bypass;
      const bothRun = eq.status === 'running' && feeder?.status === 'running';
      if (m.tuner) {
        if (!ready || !bothRun) { this.endTune(eq, m, 'Autotune aborted: mill, feeder or load input not available', feeder); continue; }
        const r = m.tuner.step(eq.loadAmps!, SCAN_MS / 1000);
        feeder!.speed = r.out;
        if (r.done) {
          // PLC's ATCalcGain: 1 = fast ... 10 = slow, default 7. Gain 7 keeps the measured values; slower = gentler Kp and longer Ti.
          const g = Math.min(10, Math.max(1, Number(eq.config.loadAtGain ?? 7)));
          const kp = Math.round(r.done.kp * (7 / g) * 1000) / 1000, ti = Math.round(r.done.tiSec * (g / 7) * 10) / 10;
          eq.config.loadKp = kp; eq.config.loadTiSec = ti; eq.config.loadTdSec = 0;
          this.endTune(eq, m, `Autotune done: Kp ${kp}, Ti ${ti} s (cycle ${r.done.tuSec.toFixed(1)} s). Control is ${m.tuneWasAuto ? 'Auto with the new values' : 'still Manual'}.`, feeder);
          this.persistConfig();
        } else if (r.failed) this.endTune(eq, m, `Autotune failed: ${r.failed}`, feeder);
        continue;
      }
      if (!ready || !(eq.loadControlAuto && bothRun)) { m.pid.reset(); continue; }
      const [lo, hi] = this.speedLimits(feeder!);
      feeder!.speed = m.pid.step(
        Number(eq.config.loadSetpointAmps ?? 0), eq.loadAmps!, feeder!.speed ?? 100, SCAN_MS / 1000,
        { kp: Number(eq.config.loadKp ?? 0), tiSec: Number(eq.config.loadTiSec ?? 0), tdSec: Number(eq.config.loadTdSec ?? 0) }, lo, hi);
    }
  }

  private sampleTrends() {
    if (++this.trendTicks < 10) return;
    this.trendTicks = 0;
    const now = Date.now();
    for (const eq of this.equipment.values()) {
      if (eq.loadAmps === undefined) continue;
      const feeder = this.equipment.get(String(eq.config.loadControlFeeder ?? ''));
      const sp = Number(eq.config.loadSetpointAmps ?? 0);
      let buf = this.trends.get(eq.id);
      if (!buf) { buf = []; this.trends.set(eq.id, buf); }
      buf.push({ t: now, a: eq.loadAmps, s: feeder ? feeder.speed : undefined, sp: sp > 0 ? sp : undefined });
      if (buf.length > 600) buf.shift();
    }
  }

  getTrend(id: string) { return this.trends.get(id) ?? []; }

  private hornRearm() { this.hornSilenced = false; this.hornAutoMs = 0; this.hornPhaseOn = true; this.hornPhaseMs = 0; }
  private toggleHornSilence() { if (this.hornSilenced) this.hornRearm(); else this.hornSilenced = true; }

  private updateHorn() {
    const gc = this.globalConfig;
    const inSig = gc.hornSilenceInput as string | undefined;
    const inNow = !!(inSig && this.ioInputs[inSig]);
    if (inNow && !this.hornInPrev) this.toggleHornSilence();
    this.hornInPrev = inNow;
    let on = false;
    if (this.faults.some(f => f.active) && !this.hornSilenced) {
      const auto = Number(gc.hornAutoSilenceSec ?? 60);
      this.hornAutoMs += SCAN_MS;
      if (auto > 0 && this.hornAutoMs >= auto * 1000) this.hornSilenced = true;
      else {
        const onMs = delayMs(gc.hornOnSec, 1), offMs = delayMs(gc.hornOffSec, 1);
        this.hornPhaseMs += SCAN_MS;
        if (offMs === 0) this.hornPhaseOn = true;
        else if (this.hornPhaseOn && this.hornPhaseMs >= onMs) { this.hornPhaseOn = false; this.hornPhaseMs = 0; }
        else if (!this.hornPhaseOn && this.hornPhaseMs >= offMs) { this.hornPhaseOn = true; this.hornPhaseMs = 0; }
        on = this.hornPhaseOn;
      }
    }
    this.hornOn = on;
    this.out(gc.hornOutput as string | undefined, on);
  }

  // Master VFD: a second starter that follows the run command and must confirm on its aux input.
  private vfdOf(eq: EquipmentRuntime) {
    return eq.config.masterVfd
      ? { run: eq.config.vfdRunOutput as string | undefined, aux: this.byp(eq, 'vfdAuxInput') ? undefined : eq.config.vfdAuxInput as string | undefined }
      : undefined;
  }

  // Read the run confirmation(s) and time them against the global Motor Starter Fault Delay (same delay for the VFD).
  private motorFeedback(eq: EquipmentRuntime) {
    const runOutput = eq.config.runOutput as string | undefined;
    const runConfirmAux = this.byp(eq, 'runConfirmAux') ? undefined : eq.config.runConfirmAux as string | undefined;
    const usable = eq.status !== 'fault' && eq.status !== 'disabled';

    if (runConfirmAux && runConfirmAux in this.ioInputs) {
      eq.feedback = !!this.ioInputs[runConfirmAux];
    } else if (!runConfirmAux || !runOutput) {
      eq.feedback = eq.runCmd;
    }

    const vfd = this.vfdOf(eq);
    const vfdOk = !vfd?.aux || !!this.ioInputs[vfd.aux];
    // Same sequence as the PLC's micros VFD (M11): the starter closes first and the VFD is started only once the starter
    // has been confirmed for vfdStartDelay (0.7 s); it drops with the run command. Its aux is only expected once it was started.
    eq.vfdStartMs = vfd && usable && eq.runCmd && eq.feedback ? (eq.vfdStartMs ?? 0) + SCAN_MS : 0;
    eq.vfdCmd = !!vfd && eq.vfdStartMs >= delayMs(eq.config.vfdStartDelay, 0.7);

    if (usable) {
      if ((eq.runCmd && !eq.feedback) || (eq.vfdCmd && !vfdOk)) {
        eq.faultTimerMs += SCAN_MS;
        // per-motor starterFaultDelay overrides the global one (PLC: OLFaultTdSV is an input of each MSFault call)
        if (eq.faultTimerMs >= delayMs(eq.config.starterFaultDelay ?? this.globalConfig.motorStarterFaultDelay, 0.5)) {
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
      eq.status = eq.runCmd && eq.feedback && (!vfd || eq.vfdCmd) && vfdOk ? 'running' : 'not_running';
    }
    if (eq.status === 'running') {
      eq.runSecondsTotal = (eq.runSecondsTotal ?? 0) + SCAN_MS / 1000;
      eq.runSeconds = (eq.runSeconds ?? 0) + SCAN_MS / 1000;
    }
    this.out(eq.config.runOutput as string | undefined, eq.runCmd);
    this.outOr(vfd?.run, !!eq.vfdCmd && eq.runCmd);
  }

  private updateGate(eq: EquipmentRuntime) {
    const openOutput = eq.config.openOutput as string | undefined;
    const closeOutput = eq.config.closeOutput as string | undefined;
    const openLimit = this.byp(eq, 'openLimitInput') ? undefined : eq.config.openLimitInput as string | undefined;
    const closedLimit = this.byp(eq, 'closedLimitInput') ? undefined : eq.config.closedLimitInput as string | undefined;
    const timeout = delayMs(eq.config.positionTimeout, 5);
    // Motor gate (dual outputs to a reversing starter): the output is only needed while moving, so it drops once the limit
    // switch confirms the position; the starter's aux must be on while an output is on.
    const motor = eq.config.motorGate === true && !!closeOutput;
    const auxSig = motor && !this.byp(eq, 'motorAuxInput') ? eq.config.motorAuxInput as string | undefined : undefined;

    const openFb = openLimit ? !!this.ioInputs[openLimit] : undefined;
    const closedFb = closedLimit ? !!this.ioInputs[closedLimit] : undefined;

    // P1 / P2 are the gate's two outlets (what each one feeds comes from the flow path). Coil 1 / limit 1 is P1 (openOutput /
    // openLimitInput), coil 2 / limit 2 is P2. Auto goes to the outlet its owner (batch / refill) needs. Released, a
    // single-coil valve falls back to P2 (spring return); a double-coil or motorized gate stays where it was. Off drives nothing.
    const single = !closeOutput;
    let want: 'open' | 'close' | undefined = eq.mode === 'P1' ? 'open' : eq.mode === 'P2' ? 'close'
      : eq.mode === 'Auto' ? (eq.owner && eq.request ? (eq.gatePort === 2 ? 'close' : 'open') : single ? 'close' : eq.gateLast) : undefined;
    if (want && eq.mode !== 'Off') eq.gateLast = want;
    // E-stop: only a motorized gate is shut off (its output drops, and it carries on once the e-stop is released); valves keep their state.
    if (motor && !this.estopOk()) want = undefined;
    if (eq.status === 'fault' && eq.faultReason === 'Motor starter feedback timeout') want = undefined; // nothing is driven until reset

    let driving = false;
    if (want === 'open') {
      driving = !(motor && openFb);
      this.out(openOutput, driving);
      this.out(closeOutput, false);
      if (openFb) {
        eq.gatePosition = 'open';
        eq.feedback = true;
        if (eq.status !== 'fault') eq.status = 'running';
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
        if (eq.status !== 'fault') eq.status = 'running';
      }
    } else if (want === 'close') {
      driving = !(motor && closedFb === true);
      this.out(openOutput, false);
      this.out(closeOutput, driving);
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
      // Off (or a starter trip): both outputs de-energized, just read feedback for position display
      this.out(openOutput, false);
      this.out(closeOutput, false);
      if (openFb) eq.gatePosition = 'open';
      else if (closedFb) eq.gatePosition = 'closed';
      else if (openFb === undefined && closedFb === undefined) { /* no sensors, keep last known */ }
      else eq.gatePosition = 'unknown';
      eq.positionTimerMs = 0;
    }

    if (auxSig && driving && !this.ioInputs[auxSig]) {
      eq.faultTimerMs += SCAN_MS;
      if (eq.faultTimerMs >= delayMs(eq.config.starterFaultDelay ?? this.globalConfig.motorStarterFaultDelay, 0.5) && eq.status !== 'fault') {
        eq.status = 'fault';
        eq.faultReason = 'Motor starter feedback timeout';
        this.raiseFault(eq.id, 'CRITICAL', `${eq.name}: motor starter feedback timeout`, 'E-GT-03');
      }
    } else eq.faultTimerMs = 0;
  }

  // ── batch engine ──

  // Which outlet of a gate (1 = P1, 2 = P2) leads to the target, following the flow path; undefined if neither does.
  private gatePortToward(gate: EquipmentRuntime, target: string): 1 | 2 | undefined {
    for (const port of [1, 2] as const) {
      const seen = new Set<string>();
      const queue = this.connections.filter(c => c.from === gate.id && c.fromPort === `out${port}`).map(c => c.to);
      while (queue.length) {
        const n = queue.shift()!;
        if (n === target) return port;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const c of this.connections) if (c.from === n) queue.push(c.to);
      }
    }
    return undefined;
  }

  // PLC HOA: a sequence only drives equipment that is in Auto; anything else holds the batch with a reason (nothing is claimed).
  private batchHold(b: BatchRuntime): string | null {
    const need: (EquipmentRuntime | undefined)[] = [];
    if (['READY', 'DOSING', 'MIXING'].includes(b.state)) need.push(this.findEquipmentByType('mixer'));
    if (b.state === 'DOSING') { const st = b.dosingSteps[b.dosingIndex]; if (st?.augerId) need.push(this.equipment.get(st.augerId)); }
    if (['ROUTE_PRECHECK', 'DISCHARGING'].includes(b.state)) need.push(this.findGateForDischarge());
    const bad = need.find(e => e && e.owner !== b.id && e.mode !== 'Auto'); // equipment the batch already owns cannot leave Auto
    return bad ? `Waiting: ${bad.id} is not in Auto` : null;
  }

  private advanceBatch() {
    const b = this.activeBatch;
    if (!b) return;
    const prevState = b.state;

    if (['READY', 'DOSING', 'MIXING', 'ROUTE_PRECHECK', 'DISCHARGING'].includes(b.state)) {
      // equipment this batch owns tripped: stop and wait (Resume after the operator resets it) instead of feeding blind
      const tripped = Array.from(this.equipment.values()).find(e => e.owner === b.id && e.status === 'fault');
      if (tripped) { this.pauseActiveBatch(); b.faultReason = `${tripped.id} faulted - reset it, then Resume`; return; }
      const hold = this.batchHold(b);
      if (hold) { b.faultReason = hold; return; }
      if (b.faultReason?.endsWith('is not in Auto')) b.faultReason = undefined;
    }

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
          gate.gatePort = this.gatePortToward(gate, b.destination) ?? 1;
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
        if (gate) { gate.owner = b.id; gate.request = true; gate.gatePort = this.gatePortToward(gate, b.destination) ?? 1; }
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
  // Pause the running batch: PAUSING releases its equipment once everything has stopped, then it sits PAUSED for Resume.
  private pauseActiveBatch(): boolean {
    const b = this.activeBatch;
    if (!b || ['COMPLETED', 'FAULTED', 'PAUSED', 'PAUSING', 'IDLE'].includes(b.state)) return false;
    b.previousState = b.state;
    b.state = 'PAUSING';
    this.initiateEquipmentStop(b.id);
    persistBatch(b);
    return true;
  }

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
    const c = eq.config;
    const pick = (k: string) => (this.byp(eq, k) ? undefined : c[k] as string | undefined);
    return {
      hi: { input: pick('highLevelInput'), covered: 'highLevelCovered', delay: 'binFullStopDelay' },
      lo: { input: pick('lowLevelInput'), covered: 'lowLevelCovered', delay: 'binLowRestartDelay' },
    };
  }

  // Raw covered state of a switch from its input and its "high/low = covered" setting (default high).
  private rawCovered(eq: EquipmentRuntime, sw: { input?: string; covered: string }): boolean {
    return !!this.ioInputs[sw.input!] === (eq.config[sw.covered] !== 'low');
  }

  // Debounce: the high switch must stay covered for Bin Full Stop Delay before the bin counts as full; the low switch must
  // stay uncovered for Bin Low Restart Delay before it counts as empty. The other direction is immediate.
  // Updated once per scan; before the first scan the raw state is used.
  private debouncedCovered = new Map<string, { input: string; db: Debounce }>();

  private updateLevelDebounce(eq: EquipmentRuntime) {
    const sws = this.levelSwitches(eq);
    for (const [isHi, sw] of [[true, sws.hi], [false, sws.lo]] as const) {
      if (!sw.input) continue;
      const key = `${eq.id}:${sw.covered}`;
      const raw = this.rawCovered(eq, sw);
      let d = this.debouncedCovered.get(key);
      if (!d || d.input !== sw.input) { d = { input: sw.input, db: new Debounce(raw) }; this.debouncedCovered.set(key, d); }
      const delay = delayMs(eq.config[sw.delay]);
      d.db.step(raw, SCAN_MS, isHi ? delay : 0, isHi ? 0 : delay); // high: slow to cover; low: slow to uncover
    }
  }

  private sensorCovered(eq: EquipmentRuntime, sw: { input?: string; covered: string }): boolean | undefined {
    if (!sw.input) return undefined;
    const d = this.debouncedCovered.get(`${eq.id}:${sw.covered}`);
    return d && d.input === sw.input ? d.db.state : this.rawCovered(eq, sw);
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

  // Enabled/disabled is the operator's main-screen switch and is separate from the HOA mode: an enabled mill in Auto
  // keeps its destination bin full from the level switches. Disabling leaves the HOA selection alone.
  private pauseHammermill(hm: EquipmentRuntime) {
    hm.enabled = false;
    hm.status = 'disabled';
    hm.request = false;
  }

  private enableHammermill(hm: EquipmentRuntime) {
    hm.enabled = true;
    if (hm.status === 'disabled') { hm.status = 'not_running'; hm.faultTimerMs = 0; }
  }

  private abortRefills() {
    for (const hmId of this.refills.keys()) this.releaseEquipment(`REFILL-${hmId}`);
    this.refills.clear();
  }

  private hammermillReady(hm: EquipmentRuntime): boolean {
    return !!hm.enabled && hm.mode === 'Auto' && !!hm.config.autoEnable
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
    const hops = [...path.downstream, path.dest]; // each gate on the way takes the outlet that leads to the next hop
    path.downstream.forEach((id, i) => { const g = this.equipment.get(id); if (g?.equipmentType === 'gate') g.gatePort = this.gatePortToward(g, hops[i + 1]) ?? 1; });
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
    // Forced outputs win over whatever control logic just computed — this is
    // the one place that's true, so a forced value always reaches the bus.
    for (const [id, val] of Object.entries(this.ioOverrides)) {
      const sigDef = this.signals.find(s => s.id === id);
      if (sigDef?.direction === 'DO' || sigDef?.direction === 'AO') this.ioOutputs[id] = val;
    }
    writeIoCommand(this.ioOutputs, this.signals, this.omronConfig.cards);
  }

  // ── snapshot ──

  getSnapshot(): StateSnapshot {
    const eqList = Array.from(this.equipment.values()).map(eq => ({
      id: eq.id, name: eq.name, equipmentType: eq.equipmentType, class: eq.class,
      status: eq.status, mode: eq.mode, commanded: eq.runCmd, feedback: eq.feedback,
      faultReason: eq.faultReason, warningReason: eq.warningReason, owner: eq.owner,
      config: eq.config, position: eq.position, gatePosition: eq.gatePosition,
      speed: eq.speed, refillState: this.refills.get(eq.id)?.state,
      state: this.isMotor(eq) ? this.displayState(eq) : undefined,
      enabled: eq.enabled, loadAmps: eq.loadAmps, loadDisconnected: eq.loadDisconnected, loadControlAuto: eq.loadControlAuto,
      loadAtRunning: eq.loadAtRunning, loadAtMsg: eq.loadAtMsg,
      // only motors have run hours; default 0 so the HMI shows the counter (and Reset) before the first run
      ...(this.isMotor(eq) ? { runSecondsTotal: eq.runSecondsTotal ?? 0, runSeconds: eq.runSeconds ?? 0, runSecondsResetAt: eq.runSecondsResetAt } : {}),
    }));

    // What each I/O point is set to in the configuration (equipment role, or a global like the e-stop / horn).
    const tags = new Map<string, string>();
    for (const eq of this.equipment.values()) {
      for (const [key, label] of Object.entries(PORT_LABELS)) { const id = eq.config[key]; if (id) tags.set(String(id), `${eq.id} ${label}`); }
    }
    for (const [key, label] of [['estopInput', 'E-Stop'], ['hornOutput', 'Horn'], ['hornSilenceInput', 'Horn Silence']] as const) {
      if (this.globalConfig[key]) tags.set(String(this.globalConfig[key]), label);
    }

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
      io: { inputs: { ...this.ioInputs }, outputs: { ...this.ioOutputs }, signals: this.signals.map(s => ({ ...s, assignment: tags.get(s.id) })), overrides: { ...this.ioOverrides } },
      scales: { ...this.scales },
      scaleConfigs: this.scaleConfigs,
      omronConfig: { ...this.omronConfig, cards: this.omronConfig.cards.map(c => ({ ...c })) },
      globalConfig: { ...this.globalConfig },
      networkInterfaces: this.networkInterfaces,
      commissioningMode: this.commissioningMode,
      horn: { on: this.hornOn, silenced: this.hornSilenced },
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
    this.hornRearm();
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
    this.ioFaultShutdown('E-OM-01', `Rack mismatch: ${mismatched.join('; ')}`);
  }

  // Shared fail-safe response for any I/O-layer fault (rack mismatch, or
  // the EtherCAT bus itself going unhealthy — see updateBusHealth): raise
  // the fault, then stop the same things a rack mismatch always stopped.
  private ioFaultShutdown(code: string, message: string) {
    this.raiseFault('OMRON', 'CRITICAL', message, code);
    this.abortRefills();
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'hammermill') this.pauseHammermill(eq);
    }
    if (this.activeBatch && !['COMPLETED', 'FAULTED', 'IDLE', 'PAUSED'].includes(this.activeBatch.state)) {
      this.activeBatch.previousState = this.activeBatch.state;
      this.activeBatch.state = 'PAUSED';
      this.activeBatch.faultReason = message;
    }
  }

  private clearRackFault() { this.clearFault('E-OM-01'); }

  private clearFault(code: string) {
    const idx = this.faults.findIndex(f => f.code === code && f.active);
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
