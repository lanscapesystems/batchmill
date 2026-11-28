import {
  type SignalDef, type SignalValue, type EquipmentRuntime, type EquipmentMode,
  type BatchRuntime, type DosingStep, type Recipe, type Ingredient,
  type Bin, type Fault, type ScaleReading, type FlowConnection, type LevelSwitchState,
  type StateSnapshot, type QueueSnapshot, type Command, type CommandResult,
  type ScaleConfig, type SharedVfd, type OmronConfig, type IoRackCard,
  NX_CARD_CATALOG, NX_BUS_POWER_BUDGET_W, NX_MAX_UNITS, ECC_MODEL_MIN_CYCLE_US,
  EQUIPMENT_DEFS,
} from './types.js';
import { verifyEthercatRack, discoverRack, syncIoConf, clearCouplerErrors, runRs1201Calibration, SCALE_ID_RE, type ScaleCalStep } from './ethercat.js';
import { MovingAverage, OnDelay, LoadPid, RelayTuner, scaleLinear } from './loadControl.js';
import { Debounce } from './monitors.js';
import { scaleLines, freefallAdjust, toleranceFor, feedsOnlyHammermill, flowPath, round1 } from './batchLogic.js';
import { SCALE_DECODERS, plcConfigError } from './scaleFormats.js';
import { readIoState, writeIoCommand, rawToPct, fullScaleFor, NX_ANALOG_DISCONNECT_RAW } from './ioDaemon.js';
import { loadConfig, saveConfig, type MillConfig } from './config.js';
import {
  openDb, closeDb, persistBatch, clearActiveBatch, loadActiveBatch, loadBatchesJson,
  archiveBatch, postInventoryEvent, persistFault, loadFaults,
  peekBatchNumber, claimBatchNumber, batchInHistory, lastFaultNumber,
} from './db.js';

// Logic scan period (how often the loop is woken). Timers do NOT count scans: each scan measures the real time since the
// previous one (this.dtMs) and every timer and the PI loops integrate that, so a late scan costs resolution, not accuracy.
// FIXED_DT_MS (env SCAN_MS) replaces the measurement with a constant - for the behaviour checks, which call scan() in a tight loop.
const SCAN_MS = 20;
const FIXED_DT_MS = Number(process.env.SCAN_MS) || 0;
// A scan that comes after a stall (a slow disk write, a long GC) integrates at most this much: the inputs were
// not being read during the stall, so timers must not leap on stale data and the PI loops must not take one huge step.
const MAX_DT_MS = 500;
// Bus health filter: one bad sample must not trip a fault. Bad time builds up and drains at a quarter of the rate, so lone
// glitches die away but a chattering bus still trips; once tripped, only this long fully healthy clears it.
const BUS_TRIP_MS = 200;
const BUS_RECOVER_MS = 2000;
// The whole fault list goes to every screen 5 times a second, so only this many are held; the database keeps all of them.
const MAX_FAULTS = 200;
const SETTLE_MS = 2000;
const DISCHARGE_TIMEOUT_MS = 60000;
// All delay settings are stored in seconds (0.1 s steps, like a 100 ms PLC timer); the scan runs in ms.
const delayMs = (sec: unknown, fallbackSec = 0) => Math.max(0, Number(sec ?? fallbackSec) || 0) * 1000;
const EDITABLE_STATES = new Set(['IDLE']); // a queued batch; anything released is no longer editable
const MICRO_NOT_EMPTY = 'Micros conveyor not empty - unload timed out (waiting; Pause then Abort to give up)';
const MIXER_NOT_EMPTY ='Mixer not empty - discharge timed out (Extend or Abort)';
const MIXER_BELOW_ZERO = 'Waiting: mixer scale reads';
const MICRO_BELOW_ZERO = 'Waiting: micros scale reads';
const NO_PROGRESS_WINDOW_MS = 10_000; // once past the bin's no-flow delay, weight must rise by the minimum every window
// Per-device input bypasses ("Overrides" in the sidebar): the input is ignored as if it were not assigned.
const BYPASSABLE = ['runConfirmAux', 'vfdAuxInput', 'motorAuxInput', 'analogLoadInput', 'rotationPulseInput', 'openLimitInput', 'closedLimitInput',
  'highLevelInput', 'lowLevelInput'];
// Faults that latch their equipment in 'fault' until reset (restored on boot if the equipment state was lost).
const TRIP_CODES = ['E-MT-01', 'E-MT-02', 'E-MT-03', 'E-LD-01', 'E-LD-03', 'E-GT-01', 'E-GT-03', 'E-GT-04', 'W-GT-02'];
// Level faults follow their own cause and clear themselves (E-stop, bus/rack, open sensor, level switches, low speed warning);
// the operator's reset leaves them alone. Every other code is latched like the PLC's FaultReset list: it stays until reset.
const LEVEL_FAULT = /^(E-ES-01|E-OM-|W-OM-|W-AI-|W-LV-|W-MT-02)/;
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
const HM_NO_ROTATION = ['rotationPulseInput', 'pulsesPerRev', 'minRpm', 'warnRpm','rotationStartupDelay', 'bypass_rotationPulseInput'];
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
  private handRun = new Set<string>(); // motors whose current run was started in Hand (no start/stop delays)
  private rotationState = new Map<string, { runningMs: number; rpm?: number }>();
  private busState: 'idle' | 'ok' | 'fault' | 'offline' = 'idle'; // live EtherCAT state for the HMI indicator (set every scan)
  private lastDaemonStartUs: number | null = null; // detects an io_daemon restart (see updateBusHealth)
  private busBadMs = 0;
  private busGoodMs = 0;
  private busTripped = false;
  ioOverrides: Record<string, SignalValue> = {};
  // Gates forcing an output via SetOverride; never persisted, so a restart
  // never comes back up with this on. Resets any forced outputs on exit.
  commissioningMode = false;
  scaleConfigs: ScaleConfig[] = [];
  sharedVfds: SharedVfd[] = [];
  scaleConfigVersion = 0; // bumped on ConfigureScale/RemoveScale — server.ts watches this to restart scale readers
  omronConfig: OmronConfig = { couplerType: 'none', ipAddress: '', nodeAddress: 1, eccModel: 'NX-ECC203', cycleTimeUs: 5000, ringTopology: false, cards: [], rackVerified: false, warnings: [] };
  globalConfig: Record<string, string | number> = { motorStarterFaultDelay: 0.5, siteName: 'FEED MILL CONTROLLER' };
  private faultSeq = 300;
  private batchPersistCounter = 0;
  private dtMs = SCAN_MS; // real time since the previous scan
  private lastScanAt = performance.now();
  private persistMs = 0;
  private aiDisconnected = new Set<string>();
  private loadMon = new Map<string, LoadMon>();
  // 1 Hz load trend per motor, last 10 minutes (served by GET /api/v1/trend/:id, not pushed in the snapshot)
  private trends = new Map<string, { t: number; a: number; s?: number; sp?: number }[]>();
  private trendMs = 0;
  // Queue hold: stops NEW batches being released (the active one is never interrupted). Not persisted, so the queue
  // always comes up on hold after a restart or power loss and nothing starts unattended after an outage.
  // Batch timers (settle, discharge, cleanout) count scans, not wall-clock time, so they are exact and testable; they restart on Resume.
  private clockMs = 0;
  private queueHeld = true;
  private queueWait: string | undefined;
  // Alarm horn (PLC R137-R143): beeps while any fault is active, a silence (HMI or input) toggles it, a NEW fault re-arms it,
  // and it silences itself after hornAutoSilenceSec.
  private hornSilenced = false;
  private hornAutoMs = 0;
  private hornPhaseOn = true;
  private hornPhaseMs = 0;
  private hornInPrev = false;
  private hornOn = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private rackBusy = false; // a bus read or calibration is running in the background (see busJob)
  private onChange?: () => void;

  constructor() {
    openDb();
    this.faults = loadFaults(); // the fault list stays through a power cycle
    this.faultSeq = Math.max(this.faultSeq, lastFaultNumber() + 1);
    this.trimFaults();
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
    const saved = loadBatchesJson().sort((a, b) => (a.order ?? Number(a.id)) - (b.order ?? Number(b.id)));
    if (!saved.some(b => b.state !== 'IDLE')) {
      const legacy = loadActiveBatch(); // a batch saved by a version that kept it in its own table
      if (legacy) saved.unshift(legacy);
    }
    for (const b of saved) {
      if (['COMPLETED', 'FAULTED', 'ABORTED'].includes(b.state)) continue;
      // older versions reused numbers after a restart: a batch carrying a finished batch's number gets a new one
      if (batchInHistory(b.id)) {
        const old = b.id;
        b.order ??= Number(old);
        clearActiveBatch(old);
        b.id = String(peekBatchNumber());
        claimBatchNumber(Number(b.id));
        persistBatch(b);
        console.warn(`Batch ${old} had the number of a finished batch: it is now batch ${b.id}`);
      }
      if (b.state !== 'IDLE') {
        if (!['PAUSED', 'ABORTED_HOLD'].includes(b.state)) {
          b.previousState = b.state;
          b.state = 'PAUSED';
          b.faultReason = 'Recovered after power loss';
          this.raiseFault('BATCH', 'WARNING', `Batch ${b.id} recovered after power loss — review and resume or abort`, 'W-BA-REC');
        }
        this.activeBatch = b;
      }
      this.queue.push(b);
    }
  }

  // ── lifecycle ──

  start(onChange: () => void) {
    this.onChange = onChange;
    this.intervalHandle = setInterval(() => this.scan(), SCAN_MS);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    closeDb();
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
    this.sharedVfds = cfg.sharedVfds ?? [];
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
      sharedVfds: this.sharedVfds,
      omronConfig: this.omronConfig,
      globalConfig: this.globalConfig,
    };
  }

  private persistConfig(): void {
    saveConfig(this.snapshotConfig());
  }

  // ── external sensor input (scaleReader.ts calls this on every new reading) ──

  setScale(scaleId: string, weight: number, stable: boolean, valid: boolean) {
    // PLC Scale Out of Range: a reading outside the legal limits invalidates the scale until Reset Faults
    const sc = this.scaleConfigs.find(s => s.id === scaleId);
    if (valid && (weight < (sc?.minLegal ?? -Infinity) || weight > (sc?.maxLegal ?? Infinity))) this.scaleIllegal.set(scaleId, weight);
    const latched = this.scaleIllegal.has(scaleId) || this.faults.some(f => f.active && f.equipment === scaleId && f.code === 'E-SC-03');
    this.scales[scaleId] = { weight, stable, valid: valid && !latched, timestamp: Date.now() };
  }
  private scaleIllegal = new Map<string, number>(); // seen by a reader, raised by the next scan

  // scaleReader.ts: why a serial scale gives no weight ('' = reading again, or no longer a serial scale).
  // Held here and raised by the scan, which stops with the database; the reader's timers do not.
  private scaleProblems = new Map<string, string>();
  setScaleProblem(scaleId: string, problem: string) {
    if (problem) this.scaleProblems.set(scaleId, problem); else this.scaleProblems.delete(scaleId);
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
        if (!this.speedOutput(eq)) return reject('No analog speed output assigned');
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
        const p = cmd.parameters as { recipeId: string; destination: string; targetMass?: number; scheduledAt?: string; acknowledged?: boolean } | undefined;
        if (!p?.recipeId || !p.destination) return reject('Missing recipe or destination');
        const recipe = this.recipes.find(r => r.id === p.recipeId);
        if (!recipe) return reject('Unknown recipe');
        if (!this.bins.some(b => b.id === p.destination && b.type === 'finished')) return reject('Destination must be a finished bin');
        if (p.targetMass !== undefined && !(p.targetMass > 0)) return reject('Batch size must be above zero');
        if (p.scheduledAt && Number.isNaN(Date.parse(p.scheduledAt))) return reject('Bad scheduled time');
        const batch = this.buildBatch(String(peekBatchNumber()), recipe, p.destination, p.targetMass, p.scheduledAt);
        // inventory / mixer-capacity warnings are raised here (not at start) so the live queue never stalls on a question
        const warnings = this.batchWarnings(batch);
        if (warnings.length && !p.acknowledged) return { ...reject('Warnings'), data: { warnings } };
        claimBatchNumber(Number(batch.id));
        batch.warnings = warnings;
        batch.order = 1 + Math.max(0, ...this.queue.map(q => q.order ?? Number(q.id))); // joins at the back, whatever its number
        this.queue.push(batch);
        persistBatch(batch);
        return ok('Queued as batch ' + batch.id);
      }

      // The queue is live (no Start button): releaseQueue() starts the next batch whenever the queue is running.
      case 'SetQueueHold': {
        if (typeof cmd.parameters?.held !== 'boolean') return reject('held must be true or false');
        this.queueHeld = cmd.parameters.held;
        return ok(this.queueHeld ? 'Queue on hold' : 'Queue running');
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
        // the scale must still agree with the saved progress of the step in progress: ask the operator if it does not
        const active = b.unloading ? [] : this.activeStepIdx(b).map(i => b.dosingSteps[i]); // both tracks resume together
        const checks = active.map(step => ({ step, mm: this.resumeMismatch(b, step) }));
        const bad = checks.find(c => c.mm === 'invalid');
        if (bad) return reject(`${bad.step.micro ? 'Micros' : 'Mixer'} scale invalid`);
        const off = checks.filter(c => c.mm && c.mm !== 'invalid');
        if (off.length) {
          if (cmd.parameters?.rebaseline !== true) return { ...reject('Scale mismatch'), data: off[0].mm };
          for (const c of off) { // carry on from what the scale reads now
            const mm = c.mm as { current: number };
            c.step.baselineWeight = mm.current - c.step.actual;
            c.step.clean = false;
          }
        }
        for (const step of active) {
          if (step.state === 'feeding') { step.augerRunMs = 0; step.progressMs = 0; step.progressRef = step.actual; } // no-flow delay starts again
          step.stillMs = 0; // the scale was not watched while paused: settle again
        }
        b.dischargeStartTime = this.clockMs; b.emptySinceMs = undefined;
        b.faultReason = undefined; b.dosingError = undefined;
        b.state = b.previousState ?? 'DOSING';
        persistBatch(b);
        return ok();
      }

      case 'AbortBatch': {
        const b = this.activeBatch;
        if (!b) return reject('No active batch');
        if (b.state !== 'PAUSED' && b.state !== 'ABORTED_HOLD') return reject('Pause the batch before aborting'); // ABORTED_HOLD: a failed batch holding material
        const mode = cmd.parameters?.mode;
        if (mode !== 'mixUnload' && mode !== 'unload' && mode !== 'cancel') return reject('Choose Mix + Unload, Unload or Cancel');
        if (mode === 'cancel' && cmd.parameters?.acknowledged !== true) return reject('Cancel must be acknowledged');
        const dosed = b.dosingSteps.some(st => st.actual > 0);
        if (mode === 'cancel' || !dosed) { // nothing is discharged: the batch closes and what is in the mixer stays there
          this.postConsumption(b);
          this.closeBatch(b, 'ABORTED');
          return ok();
        }
        if (!this.estopOk()) return reject('E-stop active'); if (this.outputForcesActive()) return reject('Clear the forced outputs first');
        this.postConsumption(b);
        b.unloading = true;
        b.faultReason = undefined;
        b.previousState = undefined;
        b.tolHold = undefined; b.dosingError = undefined;
        // micros dosed onto the belt are still there: run the belt into the mixer first, then continue as chosen
        const onBelt = this.hasMicros(b) && !b.microDelivered && b.dosingSteps.some(s => s.micro && s.actual > 0);
        if (onBelt) { b.abortMode = mode; b.microUnloading = false; b.microUnloadRunMs = 0; b.state = 'DOSING'; }
        else b.state = mode === 'mixUnload' ? 'MIXING' : 'ROUTE_PRECHECK';
        persistBatch(b);
        return ok();
      }

      // After a dosing problem (batch paused): take what was dosed for the step and carry on with the next ingredient.
      case 'AcceptDosing': {
        const b = this.activeBatch;
        if (!b?.dosingError || b.state !== 'PAUSED') return reject('No dosing problem to accept');
        if (!this.estopOk()) return reject('E-stop active'); if (this.outputForcesActive()) return reject('Clear the forced outputs first');
        const step = b.dosingSteps[b.dosingError.stepIndex];
        const scale = this.stepScale(step);
        if (scale?.valid) step.actual = Math.max(0, scale.weight - step.baselineWeight);
        step.deviation = round1(step.actual - step.target);
        step.clean = false; // an accepted problem never calibrates freefall
        step.state = 'complete';
        if (step.micro) b.microIndex = b.dosingError.stepIndex + 1; else b.dosingIndex = b.dosingError.stepIndex + 1;
        b.dosingError = undefined; b.faultReason = undefined; b.tolHold = undefined;
        b.state = 'DOSING';
        persistBatch(b);
        return ok();
      }

      case 'ExtendDischarge': {
        const b = this.activeBatch;
        if (!b || b.state !== 'DISCHARGING') return reject('Not discharging');
        b.dischargeStartTime = this.clockMs;
        if (b.faultReason === MIXER_NOT_EMPTY) b.faultReason = undefined;
        return ok();
      }

      case 'ResolveTolerance': {
        const b = this.activeBatch;
        if (!b?.tolHold) return reject('No step is waiting for the operator');
        const choice = cmd.parameters?.choice;
        if (choice !== 'ignore' && choice !== 'update') return reject('Choose ignore or update');
        const step = b.dosingSteps[b.tolHold.stepIndex];
        const binEq = this.equipment.get(step.sourceBinId);
        if (choice === 'update' && binEq) this.applyFreefall(b, step, binEq, false); // Update ignores the max-adjust cap
        b.tolHold = undefined;
        b.faultReason = undefined;
        step.state = 'complete';
        if (step.micro) b.microIndex = this.microCursor(b) + 1; else b.dosingIndex++;
        persistBatch(b);
        return ok();
      }

      // A queued (not yet released) batch can be changed: recipe, destination, size, scheduled time.
      case 'EditBatch': {
        const idx = this.queue.findIndex(b => b.id === cmd.targetId);
        if (idx < 0) return reject('Batch not found');
        const old = this.queue[idx];
        if (!EDITABLE_STATES.has(old.state)) return reject('Batch already started');
        const p = (cmd.parameters ?? {}) as { recipeId?: string; destination?: string; targetMass?: number; scheduledAt?: string | null; acknowledged?: boolean };
        const recipe = this.recipes.find(r => r.id === (p.recipeId ?? old.recipeId));
        if (!recipe) return reject('Unknown recipe');
        const destination = p.destination ?? old.destination;
        if (!this.bins.some(b => b.id === destination && b.type === 'finished')) return reject('Destination must be a finished bin');
        if (p.targetMass !== undefined && !(p.targetMass > 0)) return reject('Batch size must be above zero');
        const scheduledAt = p.scheduledAt === undefined ? old.scheduledAt : (p.scheduledAt ?? undefined);
        if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) return reject('Bad scheduled time');
        // changing the recipe without a size keeps the recipe's own weights; changing only the destination keeps the batch as it was
        const resize = p.recipeId !== undefined || p.targetMass !== undefined;
        const batch = resize ? this.buildBatch(old.id, recipe, destination, p.targetMass, scheduledAt) : { ...old, destination, scheduledAt };
        batch.order = old.order;
        const saved = this.queue[idx];
        this.queue[idx] = batch; // in place, so the warnings count only the batches ahead of it
        const warnings = this.batchWarnings(batch);
        if (warnings.length && !p.acknowledged) { this.queue[idx] = saved; return { ...reject('Warnings'), data: { warnings } }; }
        batch.warnings = warnings;
        persistBatch(batch);
        return ok();
      }

      case 'DeleteBatch': {
        const idx = this.queue.findIndex(b => b.id === cmd.targetId);
        if (idx < 0) return reject('Batch not found');
        if (!EDITABLE_STATES.has(this.queue[idx].state)) return reject('Batch already started');
        clearActiveBatch(this.queue[idx].id);
        this.queue.splice(idx, 1);
        return ok();
      }

      // Move a queued batch past its nearest queued neighbour (batches already started or finished keep their place).
      case 'MoveBatch': {
        const dir = cmd.parameters?.direction;
        if (dir !== 'up' && dir !== 'down') return reject('direction must be up or down');
        const idx = this.queue.findIndex(b => b.id === cmd.targetId);
        if (idx < 0) return reject('Batch not found');
        if (!EDITABLE_STATES.has(this.queue[idx].state)) return reject('Batch already started');
        const step = dir === 'up' ? -1 : 1;
        let j = idx + step;
        while (j >= 0 && j < this.queue.length && !EDITABLE_STATES.has(this.queue[j].state)) j += step;
        if (j < 0 || j >= this.queue.length) return reject('Already at the ' + (dir === 'up' ? 'front' : 'back'));
        const a = this.queue[idx], c = this.queue[j];
        [a.order, c.order] = [c.order ?? Number(c.id), a.order ?? Number(a.id)];
        this.queue[idx] = c; this.queue[j] = a;
        persistBatch(a); persistBatch(c);
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
          if (!this.speedOutput(feeder)) return reject('Load control needs a feeder with an analog speed output');
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
        const otherLimit = key === 'openLimitInput' ? 'closedLimitInput' : key === 'closedLimitInput' ? 'openLimitInput' : undefined;
        if (value && otherLimit && eq.config[`bypass_${otherLimit}`]) return reject('Turn off the other limit switch override first');
        if (value) eq.config[`bypass_${key}`] = true; else delete eq.config[`bypass_${key}`];
        this.persistConfig();
        return ok();
      }

      case 'StartLoadAutotune': {
        const eq = this.equipment.get(cmd.targetId ?? '');
        const m = eq && this.loadMon.get(eq.id);
        if (!eq || !m) return reject('No load input on this equipment');
        const feeder = this.equipment.get(String(eq.config.loadControlFeeder ?? ''));
        if (!feeder || !this.speedOutput(feeder)) return reject('Load control needs a feeder with an analog speed output');
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

      // The PLC's FaultReset: clears every latched fault and the trip latches. It never resumes a batch (Resume stays the operator's
      // call) and leaves level faults to their cause, so a cause that is still there raises a fresh fault on the next scan.
      case 'ResetFaults': {
        const r = this.resetFaults();
        return ok(`${r.cleared} cleared${r.kept ? `, ${r.kept} still present` : ''}`);
      }

      case 'ClearFault': {
        const f = this.faults.find(f => f.id === cmd.targetId && f.active);
        if (!f) return reject('Fault not found');
        if (f.code === 'E-ES-01') return reject('The E-stop fault clears itself when the E-stop circuit is back');
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
        if (!this.commissioningMode) return reject('Enable commissioning mode to force I/O');
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
        if (!en) this.ioOverrides = {}; // leaving commissioning mode drops every force (inputs and outputs)
        return ok();
      }

      case 'ReadOmronRack': {
        const guardErr = this.guardConfigEdit(); // the rack read shells out to the CLI and stalls the scan: not while running
        if (guardErr) return reject(guardErr);
        // probe: read the rack off the bus while the coupler is still being set up (nothing saved, no cards needed)
        if (cmd.parameters?.probe === true) {
          return this.busJob(cmd, async () => {
            const r = await discoverRack();
            return r.ok ? { accepted: true, reason: `${r.cards.length} unit(s) detected`, data: r } : { accepted: false, reason: r.error ?? 'Rack read failed' };
          });
        }
        if (this.omronConfig.couplerType === 'none') return reject('No coupler configured');
        return this.busJob(cmd, () => this.readAndSaveRack());
      }

      case 'ClearEthercatErrors': {
        if (this.omronConfig.couplerType !== 'NX-ECC') return reject('Only supported for NX-ECC couplers');
        const guardErr = this.guardConfigEdit(); // the re-read can rewrite io.conf and restart the daemon: not while running
        if (guardErr) return reject(guardErr);
        return this.busJob(cmd, async () => {
          const r = await clearCouplerErrors();
          if (!r.ok) return { accepted: false, reason: `Could not clear coupler errors: ${r.error ?? 'unknown'}` };
          return this.readAndSaveRack(); // re-read so the rack status/warnings reflect what's still wrong
        });
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
        return this.busJob(cmd, async () => {
          const r = await runRs1201Calibration(sc.rackSlot, steps);
          if (!r.ok) return { accepted: false, reason: `Calibration failed: ${r.error}` };
          sc.calibration = { mode, at: new Date().toISOString(), ...(mode === 'span' ? { standardWeight: Number(cmd.parameters?.standardWeight) } : {}) };
          this.persistConfig();
          return { accepted: true };
        });
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
      case 'ConfigureSharedVfd':
      case 'RemoveSharedVfd':
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

  // Anything that talks to the coupler runs in the background, so the scan and the screens never wait on the bus. The real
  // answer is `later`; until it resolves no other config edit or bus command is accepted.
  private busJob(cmd: Command, job: () => Promise<Pick<CommandResult, 'accepted' | 'reason' | 'data'>>): CommandResult {
    const answer = (r: Pick<CommandResult, 'accepted' | 'reason' | 'data'>) => ({ requestId: cmd.requestId, revision: this.revision, ...r });
    this.rackBusy = true;
    const later = job()
      .catch(e => { console.error(`${cmd.action} failed:`, e); return { accepted: false, reason: 'Internal error' }; })
      .then(r => { this.rackBusy = false; return answer(r); });
    return { ...answer({ accepted: true }), later };
  }

  // Config edits, scale calibration and software updates need: batch paused (or none), hammermills disabled, motors not running.
  guardConfigEdit(): string | null {
    if (this.rackBusy) return 'The rack is being read - try again in a moment';
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
        if (p.config?.notTracked === true && !(eq.equipmentType === 'bin' && feedsOnlyHammermill(eq.id, this.connections, id => this.equipment.get(id)?.equipmentType)))
          return reject('A bin can be Not tracked only if it discharges only to a hammermill');
        const renaming = !!p.newId && p.newId !== eq.id;
        if (renaming && this.equipment.has(p.newId!)) return reject('ID already in use');
        if (renaming && eq.owner) return reject('Cannot rename owned equipment');
        if (p.name !== undefined) eq.name = p.name;
        if (p.config !== undefined) {
          if (p.config.sharedVfdId && !this.sharedVfds.some(v => v.id === p.config!.sharedVfdId)) return reject('Unknown shared VFD');
          eq.config = { ...eq.config, ...p.config }; stripHammermillRotation(eq);
          // on a shared VFD the drive's I/O lives on the VFD: the auger keeps only its starter, so no stale VFD / speed I/O is left behind
          if (eq.config.sharedVfdId) for (const k of ['analogSpeedOutput', 'vfdRunOutput', 'vfdAuxInput', 'masterVfd', 'vfdStartDelay', 'speedMinPct', 'speedMaxPct', 'speedMinLimit', 'speedMaxLimit']) delete eq.config[k];
          else delete eq.config.sharedVfdId;
        }
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
        this.revalidateHiddenBins();
        return ok();
      }

      case 'RemoveConnection': {
        const p = cmd.parameters as { from: string; fromPort: string; to: string; toPort: string } | undefined;
        if (!p?.from || !p.fromPort || !p.to || !p.toPort) return reject('Missing connection fields');
        const idx = this.connections.findIndex(c => c.from === p.from && c.fromPort === p.fromPort && c.to === p.to && c.toPort === p.toPort);
        if (idx < 0) return reject('Connection not found');
        this.connections.splice(idx, 1);
        this.revalidateHiddenBins();
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
        if (this.queue.some(b => b.recipeId === id && !['COMPLETED', 'FAULTED', 'ABORTED'].includes(b.state))) return reject('Recipe in queued batch');
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
        if (p.format && p.format !== 'plc' && !Object.hasOwn(SCALE_DECODERS, p.format)) return reject('Unknown scale format');
        const framing = p.format === 'plc' && p.connectionType !== 'rs1201' ? plcConfigError(p) : null;
        if (framing) return reject(framing);
        const minLegal = p.minLegal ?? undefined, maxLegal = p.maxLegal ?? undefined;
        if ([minLegal, maxLegal].some(v => v !== undefined && !Number.isFinite(v))) return reject('Legal limits must be numbers');
        if (minLegal !== undefined && maxLegal !== undefined && minLegal >= maxLegal) return reject('Minimum legal weight must be below the maximum');
        if (p.connectionType === 'rs1201' && !SCALE_ID_RE.test(p.id)) return reject('Scale ID may use only letters, numbers, - and _ (24 at most)');
        const sc: ScaleConfig = {
          id: p.id, name: p.name,
          connectionType: p.connectionType ?? 'serial',
          format: p.format ?? '',
          startCode: p.startCode, endCode: p.endCode, prefixChar: p.prefixChar, suffixChar: p.suffixChar, motionChar: p.motionChar,
          minLegal, maxLegal,
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

      case 'ConfigureSharedVfd': {
        const p = cmd.parameters as Partial<SharedVfd> | undefined;
        if (!p) return reject('Missing parameters');
        const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
        const id = p.id || `VFD${(this.sharedVfds.reduce((mx, v) => Math.max(mx, parseInt(v.id.replace(/\D/g, '')) || 0), 0)) + 1}`;
        const v: SharedVfd = {
          id, name: (p.name ?? '').trim() || id,
          runOutput: p.runOutput || undefined, auxInput: p.auxInput || undefined, analogSpeedOutput: p.analogSpeedOutput || undefined,
          startDelay: Math.max(0, num(p.startDelay, 0.7)),
          speedMinPct: num(p.speedMinPct, 0), speedMaxPct: num(p.speedMaxPct, 100),
          speedMinLimit: num(p.speedMinLimit, 0), speedMaxLimit: num(p.speedMaxLimit, 100),
        };
        if (!(v.speedMaxLimit > v.speedMinLimit)) return reject('Speed max limit must be above the min limit');
        // one terminal point, one job: not on another shared VFD and not on any piece of equipment
        const mine = [v.runOutput, v.auxInput, v.analogSpeedOutput].filter((s): s is string => !!s);
        if (new Set(mine).size !== mine.length) return reject('Run, aux and speed must be different points');
        for (const sig of mine) {
          const other = this.sharedVfds.find(o => o.id !== id && [o.runOutput, o.auxInput, o.analogSpeedOutput].includes(sig));
          if (other) return reject(`${sig} is already used by ${other.name}`);
          for (const eq of this.equipment.values()) {
            const key = Object.keys(PORT_LABELS).find(k => eq.config[k] === sig);
            if (key) return reject(`${sig} is already used by ${eq.id} (${PORT_LABELS[key]})`);
          }
        }
        const idx = this.sharedVfds.findIndex(o => o.id === id);
        if (idx >= 0) this.sharedVfds[idx] = v; else this.sharedVfds.push(v);
        return ok();
      }

      case 'RemoveSharedVfd': {
        const id = cmd.targetId;
        if (!id) return reject('Missing shared VFD id');
        const user = Array.from(this.equipment.values()).find(e => e.config.sharedVfdId === id);
        if (user) return reject(`${user.id} still uses this VFD`);
        this.sharedVfds = this.sharedVfds.filter(v => v.id !== id);
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
        // NX-ECC: the rack read below writes io.conf once, after reading the rack - no extra restart here
        this.buildSignals(this.omronConfig.couplerType !== 'NX-ECC');
        // every save verifies the rack against the bus (a mismatch raises the rack fault, as the old Verify Rack did)
        if (this.omronConfig.couplerType === 'none') return ok();
        return this.busJob(cmd, () => this.readAndSaveRack());
      }

      default:
        return reject('Unknown topology action: ' + cmd.action);
    }
  }

  // ── main control cycle ──

  private scan() {
    const now = performance.now();
    this.dtMs = FIXED_DT_MS || Math.min(MAX_DT_MS, Math.max(0, now - this.lastScanAt));
    this.lastScanAt = now;
    this.clockMs += this.dtMs;
    this.applyOverrides();
    const ioState = readIoState(); // read once; shared by readRealInputs and updateRotationSensors
    this.updateBusHealth(ioState);
    this.readRealInputs(ioState);
    this.checkScaleFaults();
    this.checkLevelSensors();
    this.updateRefills();
    this.updateEquipmentStates();
    this.updateLoadMonitors();
    this.updateRotationSensors(ioState);
    this.updateLoadControl();
    this.applyAugerSpeeds();
    this.releaseQueue();
    this.advanceBatch();
    this.sampleTrends();
    this.updateHorn();
    this.computeOutputs();
    // run-hour counters change every scan; write them out once a minute (a power cut loses at most that)
    if ((this.persistMs += this.dtMs) >= 60_000) { this.persistMs = 0; this.persistConfig(); }
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
      // not on the bus: read as off / zero (a normally-closed contact then trips), never hold what it read before
      if (state.missing?.includes(sig.id)) { this.ioInputs[sig.id] = sig.direction === 'DI' ? false : 0; continue; }
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
    if (om.couplerType !== 'NX-ECC') {
      this.busState = 'idle'; this.busBadMs = this.busGoodMs = 0; this.busTripped = false;
      return;
    }
    const unhealthy = !state || state.healthy === false;
    const dt = Math.min(this.dtMs, 100); // the one sample after a stall must not trip by itself
    this.busBadMs = unhealthy ? Math.min(BUS_TRIP_MS, this.busBadMs + dt) : Math.max(0, this.busBadMs - dt / 4);
    this.busGoodMs = unhealthy ? 0 : this.busGoodMs + dt;
    if (this.busBadMs >= BUS_TRIP_MS) this.busTripped = true;
    else if (this.busGoodMs >= BUS_RECOVER_MS) this.busTripped = false;
    if (this.busTripped) this.busState = state ? 'fault' : 'offline';
    else if (!unhealthy) this.busState = 'ok'; // a glitch still being filtered leaves the indicator as it was
    if (!om.rackVerified) return; // not commissioned yet — nothing to enforce

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

    if (this.busTripped) {
      this.ioFaultShutdown('E-OM-02', state
        ? 'EtherCAT process data invalid (link down or incomplete working counter)'
        : 'io_daemon not reporting (not running, or state file stale)');
    } else if (!unhealthy) {
      this.clearFault('E-OM-02');
    }
    const missing = state?.missing;
    if (missing?.length) {
      this.ioFaultShutdown('E-OM-03', `I/O not on the bus: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}`);
    } else if (state) this.clearFault('E-OM-03');
  }

  private updateEquipmentStates() {
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'gate') this.updateGate(eq);
    }
    // Motor rungs, like nested PLC rungs: run logic upstream-first (a stop delay starts only once the motors feeding it
    // have stopped), then the downstream permissive downstream-first, then feedback/fault/status/outputs.
    if (!this.estopOk()) {
      this.raiseFault('ESTOP', 'CRITICAL', 'Emergency stop pressed', 'E-ES-01');
      this.pauseActiveBatch(); // a plain pause (the fault tells the operator why): motors are already dead (motorRunLogic), so PAUSING completes on the next batch tick
      // Hammermills are disabled (paused) like at startup: the operator must re-enable them, and any refill is dropped.
      this.abortRefills();
      for (const eq of this.equipment.values()) {
        if (eq.equipmentType === 'hammermill' && eq.status !== 'fault' && eq.status !== 'disabled') this.pauseHammermill(eq);
      }
    } else this.clearFault('E-ES-01'); // level fault: gone when the circuit is back (Resume / re-enable stay manual)
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
    if (eq.equipmentType === 'mixer') return true; // it holds its product, so it batches and mixes with the discharge conveyors stopped
    for (const c of this.connections) {
      if (c.from !== eq.id) continue;
      const next = this.equipment.get(c.to);
      // the micros conveyor stays stopped while the micro augers dose onto it (it only runs to unload), so it is no permissive
      if (next && this.isMotor(next) && next.equipmentType !== 'micro_drag' && !next.runCmd) return false;
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
      st.runningMs = eq.status === 'running' ? st.runningMs + this.dtMs : 0;

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
      // PLC Rot.RpmWarn: below the warn speed is only a warning (horn + list) that clears when the speed recovers.
      const warnRpm = eq.config.warnRpm as number | undefined;
      if (typeof warnRpm === 'number' && warnRpm > 0 && eq.status === 'running' && st.runningMs >= startupDelay) {
        if ((st.rpm ?? 0) < warnRpm) this.raiseFault(eq.id, 'WARNING', `${eq.name}: low rotation speed (${(st.rpm ?? 0).toFixed(0)} RPM < ${warnRpm} warn)`, 'W-MT-02');
        else this.clearFault('W-MT-02', eq.id);
      } else this.clearFault('W-MT-02', eq.id);
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
      if (eq.mode === 'Hand') { eq.runCmd = true; this.handRun.add(eq.id); } // Hand ignores the start delay
      else {
        this.handRun.delete(eq.id);
        eq.startTimerMs += this.dtMs;
        if (eq.startTimerMs >= delayMs(eq.config.startDelay)) eq.runCmd = true;
      }
    } else {
      eq.startTimerMs = 0;
      if (eq.runCmd && this.handRun.has(eq.id)) { eq.runCmd = false; eq.stopTimerMs = 0; } // a Hand run stops at once (to Off, or to Auto with no request): no stop delay
      else if (eq.runCmd && !this.upstreamStopping(eq)) {
        eq.stopTimerMs += this.dtMs;
        if (eq.stopTimerMs >= delayMs(eq.config.stopDelay)) { eq.runCmd = false; eq.stopTimerMs = 0; }
      } else eq.stopTimerMs = 0; // not running, or waiting for upstream motors to finish stopping
    }
    if (!eq.runCmd) this.handRun.delete(eq.id);
  }

  // Nested run permissive: a motor may only run while every motor it feeds is running. If one stops or faults,
  // everything feeding it drops out at once (no stop delay) and restarts, after its start delay, when it is running again.
  private motorInterlock(eq: EquipmentRuntime) {
    if (eq.mode !== 'Hand' && !this.downstreamRunning(eq)) { // Hand ignores the permissive
      eq.runCmd = false;
      eq.startTimerMs = 0;
      eq.stopTimerMs = 0;
    }
  }

  // Optional DI from an auxiliary contact of the hardware e-stop contactor (globalConfig.estopInput); true = pulled in. Unassigned = no e-stop.
  private estopOk(): boolean {
    const sig = this.globalConfig.estopInput as string | undefined;
    return !sig || !!this.ioInputs[sig];
  }

  private upstreamStopping(eq: EquipmentRuntime): boolean {
    for (const c of this.connections) {
      if (c.to !== eq.id) continue;
      const prev = this.equipment.get(c.from);
      if (prev && this.isMotor(prev) && prev.runCmd && !prev.request && eq.equipmentType !== 'micro_drag') return true;
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
    if (eq.mode === 'Hand') st = running ? 'hand_running' : 'hand_stopped';
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
      const hiWarn = m.hiWarn.tick(watch && lim('hiWarnAmps') > 0 && amps >= lim('hiWarnAmps'), this.dtMs, delay);
      const hiPause = m.hiPause.tick(watch && lim('hiPauseAmps') > 0 && amps >= lim('hiPauseAmps'), this.dtMs, delay);

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
      const ready = !!this.speedOutput(feeder) && eq.loadAmps !== undefined && !bypass;
      const bothRun = eq.status === 'running' && feeder?.status === 'running';
      if (m.tuner) {
        if (!ready || !bothRun) { this.endTune(eq, m, 'Autotune aborted: mill, feeder or load input not available', feeder); continue; }
        const r = m.tuner.step(eq.loadAmps!, this.dtMs / 1000);
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
        Number(eq.config.loadSetpointAmps ?? 0), eq.loadAmps!, feeder!.speed ?? 100, this.dtMs / 1000,
        { kp: Number(eq.config.loadKp ?? 0), tiSec: Number(eq.config.loadTiSec ?? 0), tdSec: Number(eq.config.loadTdSec ?? 0) }, lo, hi);
    }
  }

  private sampleTrends() {
    if ((this.trendMs += this.dtMs) < 1000) return; // one trend sample per second
    this.trendMs = 0;
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

  private resetFaults(): { cleared: number; kept: number } {
    const now = new Date().toISOString();
    let cleared = 0, kept = 0;
    for (const f of this.faults) {
      if (!f.active) continue;
      if (LEVEL_FAULT.test(f.code)) { kept++; continue; }
      f.active = false; f.clearedAt = now;
      persistFault(f);
      cleared++;
    }
    for (const eq of this.equipment.values()) {
      if (eq.status === 'fault') { eq.status = 'not_running'; eq.faultReason = undefined; eq.faultTimerMs = 0; }
    }
    return { cleared, kept };
  }

  // Omron Scale Out-of-Range / Data Invalid / Comm faults: a scale a mixer or micros conveyor uses that stays invalid past the
  // delay is a latched fault (no reading yet is not a fault: nothing has been wired). Batch steps already hold on an invalid scale.
  private scaleBadMs = new Map<string, number>();
  private checkScaleFaults() {
    // a serial scale that cannot be read, whether or not any equipment uses it; latched like E-SC-01
    for (const [id, problem] of this.scaleProblems) this.raiseFault(id, 'WARNING', `Scale ${id}: ${problem}`, 'W-SC-02');
    for (const [id, weight] of this.scaleIllegal) {
      this.raiseFault(id, 'CRITICAL', `Scale ${id}: ${round1(weight)} lb is outside its legal limits`, 'E-SC-03');
      if (this.scales[id]) this.scales[id].valid = false;
      // the PLC stops the batcher when the scale it is working from goes out of range
      const b = this.activeBatch;
      if (!b) continue;
      const inUse = id === this.findEquipmentByType('mixer')?.config.scaleId
        || (id === this.microConveyor(b)?.config.scaleId && b.state === 'DOSING' && !b.microDelivered);
      if (inUse && this.pauseActiveBatch()) b.faultReason = `Scale ${id} outside its legal limits - Reset Faults, then Resume`;
    }
    this.scaleIllegal.clear();
    const delay = delayMs(this.globalConfig.scaleFaultDelay, 2);
    for (const eq of this.equipment.values()) {
      const id = eq.config.scaleId as string | undefined;
      if (!id || (eq.equipmentType !== 'mixer' && eq.equipmentType !== 'micro_drag')) continue;
      const s = this.scales[id];
      if (!s || s.valid) { this.scaleBadMs.set(id, 0); continue; }
      const t = (this.scaleBadMs.get(id) ?? 0) + this.dtMs;
      this.scaleBadMs.set(id, t);
      if (t >= delay) this.raiseFault(id, 'CRITICAL', `Scale ${id}: data invalid, out of range or no communication`, 'E-SC-01');
    }
  }

  // Omron Mixer/Micros Zero Tolerance fault: a stable scale off zero (either side) when the next batch is due. The batch keeps
  // waiting (it starts by itself once the scale is back); the fault is the horn and the log entry.
  private zeroToleranceFault(b: BatchRuntime) {
    const check = (eq: EquipmentRuntime | undefined, limit: number, code: string) => {
      const s = eq?.config.scaleId ? this.scales[eq.config.scaleId as string] : undefined;
      if (eq && s?.valid && s.stable && Math.abs(s.weight) >= limit) {
        this.raiseFault(eq.id, 'CRITICAL', `${eq.name}: scale reads ${round1(s.weight)} lb at batch start - verify it is empty and zero the scale`, code);
      }
    };
    check(this.findEquipmentByType('mixer'), this.emptyLbs(), 'E-BA-05');
    const conv = this.microConveyor(b);
    if (conv) check(conv, this.microZeroLbs(conv), 'E-BA-06');
  }

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
      this.hornAutoMs += this.dtMs;
      if (auto > 0 && this.hornAutoMs >= auto * 1000) this.hornSilenced = true;
      else {
        const onMs = delayMs(gc.hornOnSec, 1), offMs = delayMs(gc.hornOffSec, 1);
        this.hornPhaseMs += this.dtMs;
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
  // A shared VFD (several augers on one drive) replaces the auger's own: the drive's run output is the OR of the augers
  // running on it (outOr), and its aux is only waited for by an auger that is running, so only running augers fault.
  private vfdOf(eq: EquipmentRuntime) {
    const shared = this.sharedVfdOf(eq);
    if (shared) return { run: shared.runOutput, aux: shared.auxInput };
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
    eq.vfdStartMs = vfd && usable && eq.runCmd && eq.feedback ? (eq.vfdStartMs ?? 0) + this.dtMs : 0;
    eq.vfdCmd = !!vfd && eq.vfdStartMs >= delayMs(this.sharedVfdOf(eq)?.startDelay ?? eq.config.vfdStartDelay, 0.7);

    if (usable) {
      if ((eq.runCmd && !eq.feedback) || (eq.vfdCmd && !vfdOk)) {
        eq.faultTimerMs += this.dtMs;
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
      eq.runSecondsTotal = (eq.runSecondsTotal ?? 0) + this.dtMs / 1000;
      eq.runSeconds = (eq.runSeconds ?? 0) + this.dtMs / 1000;
    }
    this.out(eq.config.runOutput as string | undefined, eq.runCmd);
    this.outOr(vfd?.run, !!eq.vfdCmd && eq.runCmd);
  }

  private updateGate(eq: EquipmentRuntime) {
    const openOutput = eq.config.openOutput as string | undefined;
    const closeOutput = eq.config.closeOutput as string | undefined;
    const openLimit = eq.config.openLimitInput as string | undefined;
    const closedLimit = eq.config.closedLimitInput as string | undefined;
    const timeout = delayMs(eq.config.positionTimeout, 5);
    // Motor gate (dual outputs to a reversing starter): the output is only needed while moving, so it drops once the limit
    // switch confirms the position; the starter's aux must be on while an output is on.
    const motor = eq.config.motorGate === true && !!closeOutput;
    const auxSig = motor && !this.byp(eq, 'motorAuxInput') ? eq.config.motorAuxInput as string | undefined : undefined;

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

    // An overridden limit switch reads as made (the gate is at that port, whatever mode it is in); only one may be set at a time.
    const openFb = this.byp(eq, 'openLimitInput') ? true : openLimit ? !!this.ioInputs[openLimit] : undefined;
    const closedFb = this.byp(eq, 'closedLimitInput') ? true : closedLimit ? !!this.ioInputs[closedLimit] : undefined;

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
        eq.positionTimerMs += this.dtMs;
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
          eq.positionTimerMs += this.dtMs;
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
      if (openFb && closedFb) {
        // Both limit switches on (or one overridden while the other is on): the position cannot be determined.
        eq.gatePosition = 'unknown';
        if (eq.status !== 'fault') {
          eq.status = 'fault';
          eq.faultReason = 'Gate position undetermined';
          this.raiseFault(eq.id, 'CRITICAL', `${eq.name}: both limit switches on, position undetermined`, 'E-GT-04');
        }
      } else if (openFb) eq.gatePosition = 'open';
      else if (closedFb) eq.gatePosition = 'closed';
      else if (openFb === undefined && closedFb === undefined) { /* no sensors, keep last known */ }
      else eq.gatePosition = 'unknown';
      eq.positionTimerMs = 0;
    }

    // A gate's state is its position. It only counts as running while a motor gate is actually driving an output.
    if (eq.status !== 'fault' && eq.status !== 'disabled') eq.status = motor && driving ? 'running' : 'not_running';

    if (auxSig && driving && !this.ioInputs[auxSig]) {
      eq.faultTimerMs += this.dtMs;
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
    if (b.state === 'DOSING') {
      if (!b.unloading) for (const i of this.activeStepIdx(b)) { const st = b.dosingSteps[i]; if (st?.augerId) need.push(this.equipment.get(st.augerId)); }
      if (b.microUnloading || b.unloading) need.push(this.microConveyor(b));
      else if (this.activeStepIdx(b).length === 0 && this.hasMicros(b) && !b.microDelivered) need.push(this.microConveyor(b));
    }
    if (['ROUTE_PRECHECK', 'DISCHARGING'].includes(b.state)) {
      need.push(...this.dischargeEquipment(b.destination));
    }
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
        // the same checks that released it, re-run: nothing starts moving until they all hold
        const blocker = this.releaseBlocker(b);
        if (blocker) { this.zeroToleranceFault(b); b.faultReason = `Waiting: ${blocker}`; break; }
        b.faultReason = undefined;
        b.state = 'READY';
        break;
      }

      case 'READY': {
        b.state = 'DOSING';
        b.dosingIndex = 0;
        b.microIndex = this.majorCount(b);
        b.microUnloading = false; b.microUnloadRunMs = 0; b.microDelivered = false;
        this.requestMixer(b);
        break;
      }

      case 'DOSING': {
        this.requestMixer(b);
        this.advanceDosing(b);
        break;
      }

      case 'MIXING': {
        const mixer = this.requestMixer(b);
        // the timer only counts while the mixer is actually running
        if (mixer?.runCmd) b.mixTimeRemainingMs -= this.dtMs;
        if (b.mixTimeRemainingMs <= 0) {
          b.mixTimeRemainingMs = 0;
          b.state = 'ROUTE_PRECHECK';
        }
        break;
      }

      case 'ROUTE_PRECHECK': {
        this.requestMixer(b);
        const destLevel = this.levelState(b.destination);
        if (destLevel === 'full' || destLevel === 'fault') {
          b.faultReason = destLevel === 'full' ? `Waiting: destination ${b.destination} is full` : `Waiting: ${b.destination} level sensors disagree`;
          break;
        }
        b.faultReason = undefined;
        this.requestDischargeGates(b);
        const scale = this.getMixerScale();
        b.dischargeStartWeight = scale?.valid ? scale.weight : undefined;
        b.emptySinceMs = undefined;
        b.state = 'DISCHARGING';
        b.dischargeStartTime = this.clockMs;
        break;
      }

      case 'DISCHARGING': {
        const mixer = this.requestMixer(b);
        // 'full' is already debounced by the destination's Bin Full Stop Delay
        if (this.levelState(b.destination) === 'full') {
          b.previousState = b.state;
          b.state = 'PAUSING';
          b.faultReason = `Destination ${b.destination} full — discharge paused`;
          this.initiateEquipmentStop(b.id);
          break;
        }
        const gates = this.requestDischargeGates(b);
        if (!gates.every(g => this.pathReady(g.id))) { b.dischargeStartTime = this.clockMs; break; } // wait for the gate(s) to reach the destination's outlet
        // then the conveyors on the route; time spent starting them counts toward neither the timeout nor the cleanout
        // shortcut: a mixer outlet gate ahead of a conveyor would open before it runs; order those if such a plant appears
        const conveyors = this.requestDischargeMotors(b);
        if (!conveyors.every(c => this.pathReady(c.id))) { b.dischargeStartTime = this.clockMs; b.emptySinceMs = undefined; break; }
        const scale = this.getMixerScale();
        if (!scale || !scale.valid) { b.faultReason = 'Waiting: mixer scale invalid'; break; }
        if (b.faultReason === 'Waiting: mixer scale invalid') b.faultReason = undefined;
        // well under zero means the scale is off, not that the mixer is empty: wait for the operator to zero it
        if (b.faultReason?.startsWith(MIXER_BELOW_ZERO)) b.faultReason = undefined; // re-judged every scan
        // like the PLC, motion is ignored here (the mixer is running): the cleanout time is what rides out a passing low reading
        if (Math.abs(scale.weight) < this.emptyLbs()) {
          // declared empty: keep running for the mixer's cleanout time, then finish
          b.emptySinceMs ??= this.clockMs;
          if (this.clockMs - b.emptySinceMs >= delayMs(mixer?.config.cleanoutSec, 0)) { b.faultReason = undefined; b.state = 'CLEAROUT'; }
        } else {
          b.emptySinceMs = undefined;
          // never completes on a timeout: alarm and keep waiting (Extend Discharge re-arms the timer, Abort gives up)
          const limit = delayMs(mixer?.config.dischargeTimeoutSec, DISCHARGE_TIMEOUT_MS / 1000);
          if (this.clockMs - b.dischargeStartTime > limit && b.faultReason !== MIXER_NOT_EMPTY) {
            b.faultReason = MIXER_NOT_EMPTY;
            this.raiseFault('BATCH', 'WARNING', `Batch ${b.id}: mixer not empty - discharge timed out`, 'W-BA-02');
          }
          if (scale.weight <= -this.emptyLbs()) b.faultReason = `${MIXER_BELOW_ZERO} ${round1(scale.weight)} lb - zero it`;
        }
        break;
      }

      case 'CLEAROUT': {
        // motors run out through their stop delays first; the batch keeps the route gates in position until then
        this.initiateEquipmentStop(b.id);
        if (!this.allOwnedEquipmentStopped(b.id)) break;
        // what actually left the mixer is credited to the destination: weight at the start of discharge minus what is left
        const scale = this.getMixerScale();
        const dosed = b.dosingSteps.reduce((s, st) => s + st.actual, 0);
        const left = scale?.valid ? Math.max(0, scale.weight) : 0; // zero drift must not credit more than was in the mixer
        const discharged = Math.max(0, (b.dischargeStartWeight ?? dosed) - left);
        this.postConsumption(b);
        const destBin = this.bins.find(bn => bn.id === b.destination);
        if (destBin) {
          destBin.balance += discharged;
          postInventoryEvent(`${b.id}-dest-receive`, 'batch_receive', b.destination, null, discharged, 'lbs', b.id);
        }
        this.closeBatch(b, b.unloading ? 'ABORTED' : 'COMPLETED');
        break;
      }

      case 'PAUSING': {
        if (this.allOwnedEquipmentStopped(b.id)) {
          this.releaseEquipment(b.id);
          b.state = 'PAUSED';
        }
        break;
      }

      case 'ABORTED_HOLD': {
        // everything stopped through its own stop delay; the batch now waits for the operator (Mix + Unload, Unload or Cancel)
        if (this.allOwnedEquipmentStopped(b.id)) this.releaseEquipment(b.id);
        break;
      }

      case 'PAUSED':
      case 'FAULTED':
      case 'ABORTED':
      case 'COMPLETED':
      case 'IDLE':
        break;
    }

    if (b.state !== prevState && this.activeBatch === b) persistBatch(b); // a batch closed above must not be written back
  }

  private requestMixer(b: BatchRuntime): EquipmentRuntime | undefined {
    const mixer = this.findEquipmentByType('mixer');
    if (mixer) { mixer.owner = b.id; mixer.request = true; }
    return mixer;
  }

  // Gates and motors between the mixer and the destination, in flow order.
  private dischargeEquipment(destination: string): EquipmentRuntime[] {
    const mixer = this.findEquipmentByType('mixer');
    const path = (mixer && flowPath(mixer.id, destination, this.connections)) || [];
    return path.slice(1).map(id => this.equipment.get(id)).filter((e): e is EquipmentRuntime => !!e && (e.equipmentType === 'gate' || this.isMotor(e)));
  }

  // Each gate on the route is told which outlet leads on to the next hop.
  private requestDischargeGates(b: BatchRuntime): EquipmentRuntime[] {
    const mixer = this.findEquipmentByType('mixer');
    const path = (mixer && flowPath(mixer.id, b.destination, this.connections)) || [];
    const gates = this.dischargeEquipment(b.destination).filter(e => e.equipmentType === 'gate');
    for (const g of gates) {
      g.owner = b.id;
      g.request = true;
      g.gatePort = this.gatePortToward(g, path[path.indexOf(g.id) + 1]) ?? 1;
    }
    return gates;
  }

  private requestDischargeMotors(b: BatchRuntime): EquipmentRuntime[] {
    const motors = this.dischargeEquipment(b.destination).filter(e => this.isMotor(e));
    for (const m of motors) { m.owner = b.id; m.request = true; }
    return motors;
  }

  private emptyLbs() { return Number(this.globalConfig.mixerEmptyLbs ?? 10); }

  // Everything that must hold before the head of the queue is released. A failing check keeps the batch queued with its reason.
  private releaseBlocker(b: BatchRuntime): string | null {
    if (!this.estopOk()) return 'E-stop active';
    if (this.outputForcesActive()) return 'forced outputs are active';
    const mixer = this.findEquipmentByType('mixer');
    if (!mixer) return 'no mixer configured';
    if (mixer.mode !== 'Auto') return `${mixer.id} is not in Auto`;
    if (mixer.status === 'fault') return `${mixer.id} is faulted`;
    if (!mixer.config.scaleId) return 'the mixer has no scale assigned';
    const scale = this.getMixerScale();
    if (!scale || !scale.valid) return 'mixer scale invalid';
    if (!scale.stable) return 'mixer scale not stable';
    if (Math.abs(scale.weight) >= this.emptyLbs()) return scale.weight < 0 ? `mixer scale reads ${round1(scale.weight)} lb - zero it` : `mixer not empty (${round1(scale.weight)} lb)`;
    for (const st of b.dosingSteps) {
      if (!st.sourceBinId || !this.equipment.has(st.sourceBinId)) return `no source bin for ${st.ingredientName}`;
      const a = st.augerId ? this.equipment.get(st.augerId) : undefined;
      if (!a) return `no auger below ${st.sourceBinId}`;
      if (a.mode !== 'Auto') return `${a.id} is not in Auto`;
      if (a.status === 'fault') return `${a.id} is faulted`;
      const conv = this.findMicroConveyor(a.id);
      if (!st.micro && conv) return `${st.ingredientName} is in the major list but ${a.id} feeds the micros conveyor ${conv}`;
      if (st.micro && !conv) return `${st.ingredientName} is a micro but ${a.id} does not feed a micros conveyor`;
    }
    const mconvIds = new Set(b.dosingSteps.filter(s => s.micro).map(s => s.conveyorId));
    if (mconvIds.size > 1) return 'the micro ingredients feed different micros conveyors';
    const mconv = this.microConveyor(b);
    if (mconv) {
      if (mconv.mode !== 'Auto') return `${mconv.id} is not in Auto`;
      if (mconv.status === 'fault') return `${mconv.id} is faulted`;
      const ms = this.stepScale(b.dosingSteps.find(s => s.micro)!);
      if (!mconv.config.scaleId) return `${mconv.id} has no scale assigned`;
      if (!ms || !ms.valid) return 'micros scale invalid';
      if (!ms.stable) return 'micros scale not stable';
      if (Math.abs(ms.weight) >= this.microZeroLbs(mconv)) return ms.weight < 0 ? `micros scale reads ${round1(ms.weight)} lb - zero it` : `micros conveyor not empty (${round1(ms.weight)} lb)`;
    }
    if (!this.bins.some(x => x.id === b.destination && x.type === 'finished')) return `destination ${b.destination} not found`;
    const lvl = this.levelState(b.destination);
    if (lvl === 'full') return `destination ${b.destination} is full`;
    if (lvl === 'fault') return `${b.destination} level sensors disagree`;
    const path = flowPath(mixer.id, b.destination, this.connections);
    if (!path) return `no flow path from ${mixer.id} to ${b.destination}`;
    for (const e of this.dischargeEquipment(b.destination)) {
      if (e.mode !== 'Auto') return `${e.id} is not in Auto`;
      if (e.status === 'fault' || e.status === 'disabled') return `${e.id} is ${e.status === 'fault' ? 'faulted' : 'disabled'}`;
    }
    return null;
  }

  // Live queue: with the queue running and no active batch, the next eligible batch starts by itself. A scheduled batch that
  // is not due yet is skipped (it does not hold up the ones behind it); the head batch waits, with a reason, while a check fails.
  private releaseQueue() {
    this.queueWait = undefined;
    if (this.queueHeld || this.activeBatch) return;
    const now = Date.now();
    const batch = this.queue.find(b => b.state === 'IDLE' && (!b.scheduledAt || Date.parse(b.scheduledAt) <= now));
    if (!batch) return;
    const blocker = this.releaseBlocker(batch);
    if (blocker) { this.zeroToleranceFault(batch); this.queueWait = `batch ${batch.id} - ${blocker}`; return; }
    if (batch.scheduledAt && now - Date.parse(batch.scheduledAt) > 60_000) batch.late = true;
    batch.state = 'VALIDATING';
    batch.startedAt = new Date().toISOString();
    this.activeBatch = batch;
    persistBatch(batch);
  }

  // Two tracks run at once: the majors one after another into the mixer (mixer scale) and the micros one after another onto
  // the micros conveyor (its own scale). The belt only runs into the mixer once both are finished.
  private advanceDosing(b: BatchRuntime) {
    if (b.unloading) { this.runMicroUnload(b); return; } // aborted with micros on the belt: empty it first
    const majorsDone = b.dosingIndex >= this.majorCount(b);
    const microsDone = this.microCursor(b) >= b.dosingSteps.length;
    if (majorsDone && microsDone) {
      if (this.hasMicros(b) && !b.microDelivered) { this.runMicroUnload(b); return; }
      b.state = 'MIXING';
      persistBatch(b);
      return;
    }
    for (const idx of this.activeStepIdx(b)) {
      this.advanceStep(b, idx);
      if (b.state !== 'DOSING') return; // a pause or dosing problem in one track stops the other in the same scan
    }
  }

  // The belt runs into the mixer until its minimum time has passed and the micros scale reads empty. A timeout only alarms:
  // the batch keeps waiting (Abort from the pause gives up), like the mixer discharge.
  private runMicroUnload(b: BatchRuntime) {
    const conv = this.microConveyor(b);
    const first = b.dosingSteps.find(s => s.micro);
    if (!conv || !first) { b.microDelivered = true; this.afterMicroUnload(b); return; }
    if (!b.microUnloading) { b.microUnloading = true; b.microUnloadRunMs = 0; persistBatch(b); }
    conv.owner = b.id; conv.request = true;
    if (conv.runCmd) b.microUnloadRunMs = (b.microUnloadRunMs ?? 0) + this.dtMs;
    const scale = this.stepScale(first);
    if (!scale || !scale.valid) { b.faultReason = 'Waiting: micros scale invalid'; return; }
    if (b.faultReason === 'Waiting: micros scale invalid') b.faultReason = undefined;
    const minMs = delayMs(conv.config.unloadMinSec, 10);
    if (b.faultReason?.startsWith(MICRO_BELOW_ZERO)) b.faultReason = undefined; // re-judged every scan, like the mixer
    if ((b.microUnloadRunMs ?? 0) >= minMs && Math.abs(scale.weight) < this.microZeroLbs(conv)) { // motion ignored: the belt is running
      conv.request = false; // stops through its own stop delay
      b.microUnloading = false; b.microDelivered = true;
      if (b.faultReason === MICRO_NOT_EMPTY) b.faultReason = undefined;
      this.afterMicroUnload(b);
      return;
    }
    const limit = delayMs(conv.config.failedToEmptySec, 60);
    if ((b.microUnloadRunMs ?? 0) > limit && b.faultReason !== MICRO_NOT_EMPTY) {
      b.faultReason = MICRO_NOT_EMPTY;
      this.raiseFault('BATCH', 'WARNING', `Batch ${b.id}: micros conveyor not empty - unload timed out`, 'W-BA-03');
    }
    if (scale.weight <= -this.microZeroLbs(conv)) b.faultReason = `${MICRO_BELOW_ZERO} ${round1(scale.weight)} lb - zero it`;
  }

  private afterMicroUnload(b: BatchRuntime) {
    if (b.unloading) { b.state = b.abortMode === 'mixUnload' ? 'MIXING' : 'ROUTE_PRECHECK'; b.abortMode = undefined; }
    else b.state = 'MIXING';
    persistBatch(b);
  }

  private advanceStep(b: BatchRuntime, idx: number) {
    const step = b.dosingSteps[idx];
    const prevStepState = step.state;
    const binEq = this.equipment.get(step.sourceBinId);
    const auger = step.augerId ? this.equipment.get(step.augerId) : undefined;
    const hasAnalogSpeed = !!this.speedOutput(auger);
    const freefall = (binEq?.config.freefall as number) ?? 0;
    const slowFeedLbs = (hasAnalogSpeed && (binEq?.config.slowFeedLbs as number)) ? (binEq!.config.slowFeedLbs as number) : 0;
    // Real weight only: no scale reading means nothing is dosed (there is no simulated mode).
    const scale = this.stepScale(step);
    const scaleOk = !!scale && scale.valid;
    const label = step.micro ? 'micros' : 'mixer';
    const waitScale = (needStable: boolean): boolean => {
      if (!scaleOk) { b.faultReason = `Waiting: ${label} scale invalid`; return true; }
      if (needStable && !scale!.stable) { b.faultReason = `Waiting: ${label} scale not stable`; return true; }
      if (b.faultReason?.startsWith(`Waiting: ${label} scale`)) b.faultReason = undefined;
      return false;
    };
    const done = () => { if (step.micro) b.microIndex = idx + 1; else b.dosingIndex = idx + 1; };
    // PLC settle timer: the scale must be still for the whole time; motion or a lost reading starts it over
    const stillFor = (ms: number): boolean => {
      if (waitScale(true)) { step.stillMs = 0; return false; }
      step.stillMs = (step.stillMs ?? 0) + this.dtMs;
      return step.stillMs >= ms;
    };

    switch (step.state) {
      case 'pending': {
        // a micro waits out the initial settle (the belt scale), a major only needs a still reading
        if (!stillFor(step.micro ? delayMs(this.globalConfig.microInitialSettleSec, SETTLE_MS / 1000) : 0)) break;
        step.baselineWeight = scale!.weight;
        step.augerRunMs = 0; step.progressMs = 0; step.progressRef = 0; step.clean = true;
        step.state = 'baseline';
        break;
      }

      case 'baseline': {
        if (auger) { auger.owner = b.id; auger.request = true; }
        step.state = 'feeding';
        break;
      }

      case 'feeding': {
        if (!scaleOk) {
          // lost the weight while feeding: stop the feeder and pause; Resume once the scale is back
          step.clean = false;
          if (auger) auger.request = false;
          this.pauseActiveBatch();
          b.faultReason = `${step.micro ? 'Micros' : 'Mixer'} scale invalid - restore it, then Resume`;
          return;
        }
        if (step.micro && !this.checkMicroCapacity(b, step, scale!.weight)) return;
        if (!step.micro && !this.checkMixerCapacity(b, step, scale!.weight)) return;
        if (auger) { auger.owner = b.id; auger.request = true; }
        step.actual = Math.max(0, scale!.weight - step.baselineWeight);
        const remaining = step.target - step.actual;
        if (hasAnalogSpeed) {
          const slowSpeed = (binEq?.config.slowFeedSpeed as number) ?? 50;
          const inSlowZone = slowFeedLbs > 0 && (remaining <= slowFeedLbs || slowFeedLbs >= step.target);
          const normal = auger?.speed ?? 100;
          this.setAugerSpeed(auger, inSlowZone ? Math.min(slowSpeed, normal) : normal);
        }
        // Failed to achieve weight (PLC): the bin's total feed time for this step; 0 = off
        const failedMs = delayMs(binEq?.config.failedToAchieveSec, 0);
        if (failedMs > 0 && auger?.runCmd && (step.augerRunMs ?? 0) >= failedMs) {
          this.dosingProblem(b, step, `${step.sourceBinId} failed to achieve the weight in time`, idx);
          return;
        }
        // No-flow watchdog: once the auger has run for the bin's delay, the weight must keep rising
        if (auger?.runCmd) {
          step.augerRunMs = (step.augerRunMs ?? 0) + this.dtMs;
          const delay = delayMs(binEq?.config.noProgressDelaySec, 60);
          if (step.augerRunMs >= delay) {
            if (step.augerRunMs - this.dtMs < delay) { step.progressRef = step.actual; step.progressMs = 0; }
            else {
              step.progressMs = (step.progressMs ?? 0) + this.dtMs;
              if (step.progressMs >= NO_PROGRESS_WINDOW_MS) {
                const minLbs = Number(binEq?.config.noProgressMinLbs ?? 2);
                if (step.actual - (step.progressRef ?? 0) < minLbs) {
                  this.dosingProblem(b, step, `No flow from ${step.sourceBinId}`, idx);
                  return;
                }
                step.progressRef = step.actual; step.progressMs = 0;
              }
            }
          }
        }
        // Freefall cutoff
        if (step.actual >= step.target - freefall) {
          if (auger) auger.request = false; // the auger's own stop delay keeps it running through the freefall
          step.state = 'cutoff';
        }
        break;
      }

      case 'cutoff': {
        if (scaleOk) step.actual = Math.max(0, scale!.weight - step.baselineWeight);
        else step.clean = false;
        if (auger) auger.request = false;
        if (!auger?.runCmd) {
          if (auger) auger.owner = undefined;
          step.stillMs = 0;
          step.state = 'settling';
        }
        break;
      }

      case 'settling': {
        if (!scaleOk) step.clean = false;
        if (!stillFor(delayMs(binEq?.config.settleSec, SETTLE_MS / 1000))) break;
        step.actual = Math.max(0, scale!.weight - step.baselineWeight);
        step.deviation = Math.round((step.actual - step.target) * 100) / 100;
        const tol = toleranceFor(binEq?.config.toleranceLbs, step.target);
        if (Math.abs(step.deviation) > tol) {
          // out of tolerance: hold for the operator (Ignore / Update freefall / Abort), like the PLC popup
          if (b.tolHold) break; // the other track already has the operator's attention: this one waits its turn
          const ff = freefall;
          const { newFreefall } = freefallAdjust(step.actual, step.target, ff, Number(binEq?.config.ffStrengthPct ?? 50));
          b.tolHold = { stepIndex: idx, ingredientName: step.ingredientName, desired: step.target, actual: step.actual,
            difference: step.deviation, currentFreefall: ff, newFreefall };
          b.faultReason = `${step.ingredientName} is ${round1(Math.abs(step.deviation))} lb ${step.deviation > 0 ? 'over' : 'under'} target - choose Ignore or Update freefall`;
          step.state = 'hold';
          persistBatch(b);
          break;
        }
        if (binEq?.config.ffAuto === true && step.clean !== false) this.applyFreefall(b, step, binEq, true);
        step.state = 'complete';
        done();
        break;
      }

      case 'hold':
        break; // waiting for ResolveTolerance

      case 'complete':
        done();
        break;

      case 'faulted':
        this.dosingProblem(b, step, `Dosing step ${step.ingredientName} faulted`, idx);
        break;
    }

    if (step.state !== prevStepState) {
      persistBatch(b);
      this.batchPersistCounter = 0;
    } else if (step.state === 'feeding') {
      this.batchPersistCounter++;
      if (this.batchPersistCounter >= 10) { // once a second while feeding: a power cut loses at most that
        persistBatch(b);
        this.batchPersistCounter = 0;
      }
    }
  }

  // PLC freefall calibration: move the bin's freefall by (error x strength %). Auto mode is capped by the bin's max adjust per
  // batch; the operator's "Update" is not. Each change is logged on the bin (last 10) so a bad trend can be seen.
  private applyFreefall(b: BatchRuntime, step: DosingStep, binEq: EquipmentRuntime, capped: boolean) {
    const old = Number(binEq.config.freefall ?? 0);
    const cap = capped ? Number(binEq.config.ffMaxAdjLbs ?? 2) : undefined;
    const { adjust, newFreefall } = freefallAdjust(step.actual, step.target, old, Number(binEq.config.ffStrengthPct ?? 50), cap);
    if (adjust <= 0 || newFreefall === old) return;
    binEq.config.freefall = newFreefall;
    step.ffOld = old; step.ffNew = newFreefall;
    let log: unknown[] = [];
    try { log = JSON.parse(String(binEq.config.ffLog ?? '[]')) as unknown[]; } catch { log = []; }
    log.push({ at: new Date().toISOString(), batch: b.id, old, new: newFreefall, error: step.deviation });
    binEq.config.ffLog = JSON.stringify(log.slice(-10));
    this.persistConfig();
  }

  // Dosed material comes off the source bins once, however the batch ends.
  private postConsumption(b: BatchRuntime) {
    if (b.consumptionPosted) return;
    b.consumptionPosted = true;
    for (const [i, step] of b.dosingSteps.entries()) {
      if (step.actual <= 0) continue;
      const bin = this.bins.find(bn => bn.id === step.sourceBinId);
      if (bin) bin.balance = Math.max(0, bin.balance - step.actual);
      // the step number keeps two lines of the same ingredient apart
      postInventoryEvent(`${b.id}-${i}-${step.ingredientId}-consume`, 'consumption', step.sourceBinId, step.ingredientId, -step.actual, step.unit, b.id);
    }
    this.persistConfig();
  }

  // Ends the active batch for good: releases everything, archives it, clears it from the database and frees the queue.
  private closeBatch(b: BatchRuntime, final: 'COMPLETED' | 'FAULTED' | 'ABORTED') {
    this.releaseEquipment(b.id);
    b.state = final;
    b.tolHold = undefined;
    b.completedAt = new Date().toISOString();
    this.activeBatch = null;
    archiveBatch(b);
    clearActiveBatch(b.id);
  }

  // What the saved progress of the step in progress says the scale should read, vs. what it reads now (checked on Resume).
  private resumeMismatch(b: BatchRuntime, step: DosingStep): 'invalid' | { saved: number; current: number; ingredientName: string } | null {
    if ((b.previousState ?? 'DOSING') !== 'DOSING' || !step || !['feeding', 'cutoff', 'settling', 'hold'].includes(step.state)) return null;
    const scale = this.stepScale(step);
    if (!scale || !scale.valid) return 'invalid';
    const saved = step.baselineWeight + step.actual;
    if (Math.abs(scale.weight - saved) <= Number(this.globalConfig.resumeMismatchLbs ?? 10)) return null;
    return { saved: round1(saved), current: round1(scale.weight), ingredientName: step.ingredientName };
  }

  private setAugerSpeed(auger: EquipmentRuntime | undefined, pct: number) {
    const o = this.speedOutput(auger);
    if (o) {
      const limited = Math.min(o.hi, Math.max(o.lo, pct));
      const scaled = o.minPct + (limited / 100) * (o.maxPct - o.minPct);
      this.out(o.sig, Math.round(scaled * 100) / 100);
    }
  }

  // Drop the run request of everything the batch owns; each motor stops after its own stop delay.
  // Pause the running batch: PAUSING releases its equipment once everything has stopped, then it sits PAUSED for Resume.
  private pauseActiveBatch(): boolean {
    const b = this.activeBatch;
    if (!b || ['COMPLETED', 'FAULTED', 'ABORTED', 'ABORTED_HOLD', 'PAUSED', 'PAUSING', 'IDLE'].includes(b.state)) return false;
    if (b.state === 'DOSING') for (const i of this.activeStepIdx(b)) b.dosingSteps[i].clean = false; // a paused feed is not a clean run: no freefall calibration from it
    b.previousState = b.state;
    b.state = 'PAUSING';
    this.initiateEquipmentStop(b.id);
    persistBatch(b);
    return true;
  }

  private initiateEquipmentStop(ownerId: string) {
    for (const eq of this.equipment.values()) {
      // gates hold until releaseEquipment: moving one while a conveyor runs out would misroute what is still on it
      if (eq.owner === ownerId && eq.equipmentType !== 'gate') eq.request = false;
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
      d.db.step(raw, this.dtMs, isHi ? delay : 0, isHi ? 0 : delay); // high: slow to cover; low: slow to uncover
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
    const o = this.speedOutput(eq);
    return o ? [o.lo, o.hi] : [Number(eq.config.speedMinLimit ?? 0), Number(eq.config.speedMaxLimit ?? 100)];
  }

  // Runs before the batch engine, which overrides the active auger's speed while dosing.
  private applyAugerSpeeds() {
    // augers on one shared VFD write its single output: a running (or requested) auger decides the speed, idle ones do not overwrite it
    const seen = new Set<string>();
    const busyFirst = Array.from(this.equipment.values()).sort((a, b) => Number(b.runCmd || b.request) - Number(a.runCmd || a.request));
    for (const eq of busyFirst) {
      if (!this.speedOutput(eq)) continue;
      const shared = this.sharedVfdOf(eq)?.id;
      if (shared) { if (seen.has(shared)) continue; seen.add(shared); }
      this.setAugerSpeed(eq, eq.speed ?? 100);
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
    if (r.state === 'STARTING' && r.path.every(id => this.pathReady(id))) r.state = 'FILLING';
  }

  // A path device is ready when a motor is running, or a gate sits on the outlet the sequence needs (P1 or P2), per its limit switch.
  private pathReady(id: string): boolean {
    const e = this.equipment.get(id);
    if (e?.equipmentType === 'gate') return e.gatePosition === (e.gatePort === 2 ? 'closed' : 'open');
    return e?.status === 'running';
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
      ...(eq.equipmentType === 'bin' || eq.equipmentType === 'finished_bin'
        ? { highCovered: this.sensorCovered(eq, this.levelSwitches(eq).hi), lowCovered: this.sensorCovered(eq, this.levelSwitches(eq).lo) } : {}),
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
    for (const v of this.sharedVfds) {
      for (const [sig, label] of [[v.runOutput, 'VFD Run'], [v.auxInput, 'VFD Aux'], [v.analogSpeedOutput, 'VFD Speed']] as const) if (sig) tags.set(sig, `${v.name} ${label}`);
    }
    for (const [key, label] of [['estopInput', 'E-Stop'], ['hornOutput', 'Horn'], ['hornSilenceInput', 'Horn Silence']] as const) {
      if (this.globalConfig[key]) tags.set(String(this.globalConfig[key]), label);
    }

    const batchToQueue = (b: BatchRuntime): QueueSnapshot => {
      const mixerScale = b === this.activeBatch ? this.getMixerScale() : undefined;
      return {
        id: b.id, recipeId: b.recipeId, recipeName: b.recipeName,
        targetMass: b.targetMass, destination: b.destination, state: b.state,
        previousState: b.previousState, // a paused batch keeps showing the stage it stopped in
        mixerLbs: mixerScale?.valid ? mixerScale.weight : undefined,
        startedAt: b.startedAt, completedAt: b.completedAt,
        dosingSteps: b.dosingSteps.map(s => ({
          ingredientId: s.ingredientId, ingredientName: s.ingredientName,
          sourceBinId: s.sourceBinId, target: s.target,
          actual: Math.round(s.actual * 10) / 10, unit: s.unit, state: s.state, deviation: s.deviation, micro: s.micro,
        })),
        microUnloading: b.microUnloading,
        mixTimeRemainingMs: b.mixTimeRemainingMs, mixTimeTotalMs: b.mixTimeTotalMs,
        faultReason: b.faultReason,
        scheduledAt: b.scheduledAt, late: b.late, warnings: b.warnings, tolHold: b.tolHold, dosingError: b.dosingError,
      };
    };

    return {
      revision: this.revision,
      timestamp: new Date().toISOString(),
      equipment: eqList,
      // only what is live goes to the screens (finished batches and cleared faults are read from the history on request)
      queue: this.queue.filter(b => !['COMPLETED', 'FAULTED', 'ABORTED'].includes(b.state)).map(batchToQueue),
      activeBatch: this.activeBatch ? batchToQueue(this.activeBatch) : null,
      faults: this.faults.filter(f => f.active),
      // a bin is a micro bin when its auger discharges onto a micros conveyor (no separate bin type to configure)
      bins: this.bins.map(b => ({ ...b, type: b.type === 'ingredient' && this.isMicroBin(b.id) ? 'micro_hopper' as const : b.type, hidden: this.isHidden(b.id) || undefined, levelSwitchState: this.levelState(b.id) })),
      recipes: this.recipes,
      ingredients: this.ingredients,
      connections: this.connections,
      io: { inputs: { ...this.ioInputs }, outputs: { ...this.ioOutputs }, signals: this.signals.map(s => ({ ...s, assignment: tags.get(s.id) })), overrides: { ...this.ioOverrides } },
      scales: { ...this.scales },
      scaleConfigs: this.scaleConfigs,
      sharedVfds: this.sharedVfds,
      omronConfig: { ...this.omronConfig, bus: this.busState, cards: this.omronConfig.cards.map(c => ({ ...c })) },
      globalConfig: { ...this.globalConfig },
      commissioningMode: this.commissioningMode,
      horn: { on: this.hornOn, silenced: this.hornSilenced },
      queueControl: { held: this.queueHeld, waiting: this.queueWait },
    };
  }

  // ── helpers ──

  private raiseFault(eqId: string, severity: Fault['severity'], message: string, code: string) {
    if (this.faults.some(f => f.equipment === eqId && f.code === code && f.active)) return;
    const fault: Fault = {
      id: `F-${this.faultSeq++}`, severity, equipment: eqId,
      message, code, raisedAt: new Date().toISOString(),
      clearedAt: null, active: true,
    };
    this.faults.unshift(fault);
    persistFault(fault);
    this.trimFaults();
    this.hornRearm();
  }

  // drops the oldest cleared faults beyond the limit (newest are first); active ones always stay
  private trimFaults() {
    for (let i = this.faults.length - 1; i >= 0 && this.faults.length > MAX_FAULTS; i--) if (!this.faults[i].active) this.faults.splice(i, 1);
  }

  private async readAndSaveRack() {
    await this.readOmronRack();
    this.persistConfig(); // discoveredRack must survive a restart, or every reboot would need a fresh Read Rack
    return { accepted: true };
  }

  private async readOmronRack() {
    const om = this.omronConfig;
    let driverWarnings: string[] = [];
    if (om.couplerType === 'NX-ECC') {
      const result = await verifyEthercatRack(om);
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
      this.clearRackFault(); // the latest rack read matches again (e.g. a reseated card)
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
    // Motors a batch or refill is driving drop at once, as on e-stop: a stop delay would carry on commanding them after the bus is back.
    for (const eq of this.equipment.values()) {
      if (eq.owner && this.isMotor(eq)) { eq.runCmd = false; eq.startTimerMs = 0; eq.stopTimerMs = 0; }
    }
    this.abortRefills();
    for (const eq of this.equipment.values()) {
      if (eq.equipmentType === 'hammermill') this.pauseHammermill(eq);
    }
    const b = this.activeBatch;
    if (b && !['COMPLETED', 'FAULTED', 'IDLE', 'PAUSED'].includes(b.state)) {
      if (b.state === 'DOSING') for (const i of this.activeStepIdx(b)) b.dosingSteps[i].clean = false;
      if (b.state !== 'PAUSING') b.previousState = b.state; // PAUSING already saved where to resume
      b.state = 'PAUSED';
      b.faultReason = message;
      this.releaseEquipment(b.id); // PAUSED holds no equipment: a kept run request would start it again
      persistBatch(b);
    }
  }

  private clearRackFault() { this.clearFault('E-OM-01'); }

  private clearFault(code: string, eqId?: string) {
    const idx = this.faults.findIndex(f => f.code === code && f.active && (!eqId || f.equipment === eqId));
    if (idx >= 0) {
      this.faults[idx].active = false;
      this.faults[idx].clearedAt = new Date().toISOString();
      persistFault(this.faults[idx]); // keep fault_log in sync
    }
  }

  // A dosing problem pauses the batch (the feeders stop) and raises a popup on the HMI: Resume tries the step again,
  // Accept takes what was dosed and carries on, Abort gives the batch up.
  private dosingProblem(b: BatchRuntime, step: DosingStep, message: string, idx: number) {
    this.raiseFault('BATCH', 'CRITICAL', `Batch ${b.id}: ${message}`, 'E-BA-01');
    b.dosingError = { stepIndex: idx, ingredientName: step.ingredientName, message, actual: step.actual, target: step.target };
    this.pauseActiveBatch();
    b.faultReason = message;
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

  private buildBatch(id: string, recipe: Recipe, destination: string, targetMass?: number, scheduledAt?: string): BatchRuntime {
    // a requested size scales every line (micros included); no size = the recipe as written
    const lines = scaleLines([...recipe.lines, ...recipe.microLines], targetMass);
    const steps: DosingStep[] = lines.map((line, i) => {
      const ing = this.ingredients.find(i => i.id === line.ingredientId);
      const bin = this.findBinForIngredient(line.ingredientId);
      const augerId = this.findAugerForBin(bin?.id ?? '');
      const micro = i >= recipe.lines.length; // the recipe's micro list: majors first, then micros, each in list order
      return {
        micro: micro || undefined,
        conveyorId: micro && augerId ? this.findMicroConveyor(augerId) : undefined,
        ingredientId: line.ingredientId,
        ingredientName: ing?.name ?? line.ingredientId,
        sourceBinId: bin?.id ?? '',
        augerId: augerId ?? '',
        target: line.target,
        actual: 0,
        unit: line.unit,
        state: 'pending' as const,
        baselineWeight: 0,
        cutoffStartTime: 0,
      };
    });
    return {
      id, recipeId: recipe.id, recipeName: recipe.name,
      targetMass: Math.round(steps.reduce((s, st) => s + st.target, 0) * 100) / 100,
      destination,
      state: 'IDLE',
      startedAt: '',
      dosingIndex: 0,
      microIndex: steps.filter(s => !s.micro).length,
      dosingSteps: steps,
      mixTimeRemainingMs: recipe.mixTime * 1000,
      mixTimeTotalMs: recipe.mixTime * 1000,
      dischargeStartTime: 0,
      scheduledAt,
    };
  }

  // Advisory only (the operator confirms): what the batch would need from each bin after every batch ahead of it in the queue,
  // and whether it fits the mixer. Raised when a batch is added or edited, never at start.
  private batchWarnings(b: BatchRuntime): string[] {
    const w: string[] = [];
    const ahead = new Map<string, number>();
    for (const o of this.queue) {
      if (o.id === b.id) break; // on an edit the batch sits in the queue: count only what is in front of it
      if (['COMPLETED', 'FAULTED', 'ABORTED'].includes(o.state)) continue;
      for (const st of o.dosingSteps) ahead.set(st.sourceBinId, (ahead.get(st.sourceBinId) ?? 0) + st.target);
    }
    const need = new Map<string, number>();
    for (const st of b.dosingSteps) {
      if (!st.sourceBinId) { w.push(`No source bin for ${st.ingredientName}`); continue; }
      if (!st.augerId) w.push(`No auger below ${st.sourceBinId}`);
      need.set(st.sourceBinId, (need.get(st.sourceBinId) ?? 0) + st.target);
    }
    for (const [binId, n] of need) {
      const bin = this.bins.find(x => x.id === binId);
      if (!bin) continue;
      const available = bin.balance - (ahead.get(binId) ?? 0);
      if (n > available) w.push(`${bin.name}: needs ${round1(n)} lbs, ${round1(Math.max(0, available))} available${ahead.get(binId) ? ' after the batches ahead' : ''}`);
    }
    const mixer = this.findEquipmentByType('mixer');
    const capacity = Number(mixer?.config.capacity ?? 4000);
    if (mixer && capacity > 0 && b.targetMass > capacity) w.push(`Batch is ${round1(b.targetMass)} lbs; mixer capacity is ${capacity} lbs`);
    return w;
  }

  private isHidden(binId: string) { return this.equipment.get(binId)?.config.notTracked === true; }

  // A bin marked Not tracked must still discharge only to a hammermill; if a connection change breaks that, the flag is cleared.
  private revalidateHiddenBins() {
    for (const eq of this.equipment.values()) {
      if (eq.config.notTracked !== true) continue;
      if (feedsOnlyHammermill(eq.id, this.connections, id => this.equipment.get(id)?.equipmentType)) continue;
      delete eq.config.notTracked;
      this.raiseFault(eq.id, 'WARNING', `${eq.name} no longer feeds only a hammermill - it is tracked again`, 'W-BN-01');
    }
  }

  private findBinForIngredient(ingredientId: string): Bin | undefined {
    return this.bins
      .filter(b => b.ingredientId === ingredientId && b.type !== 'finished' && !this.isHidden(b.id))
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

  private isMicroBin(binId: string): boolean {
    return this.connections.some(c => c.from === binId && this.equipment.get(c.to)?.equipmentType === 'auger' && !!this.findMicroConveyor(c.to));
  }

  // The micros conveyor an auger discharges onto (auger -> micro_drag), if any.
  private findMicroConveyor(augerId: string): string | undefined {
    for (const c of this.connections) {
      if (c.from === augerId && this.equipment.get(c.to)?.equipmentType === 'micro_drag') return c.to;
    }
    return undefined;
  }

  // Majors are the steps before the first micro (buildBatch puts them first); each track has its own cursor.
  private majorCount(b: BatchRuntime): number {
    const i = b.dosingSteps.findIndex(s => s.micro);
    return i < 0 ? b.dosingSteps.length : i;
  }
  private microCursor(b: BatchRuntime): number { return b.microIndex ?? this.majorCount(b); }
  /** Indexes of the steps being dosed right now: the current major and the current micro. */
  private activeStepIdx(b: BatchRuntime): number[] {
    const idx: number[] = [];
    if (b.dosingIndex < this.majorCount(b)) idx.push(b.dosingIndex);
    if (this.microCursor(b) < b.dosingSteps.length) idx.push(this.microCursor(b));
    return idx;
  }
  private hasMicros(b: BatchRuntime) { return b.dosingSteps.some(s => s.micro); }
  private microConveyor(b: BatchRuntime): EquipmentRuntime | undefined {
    const id = b.dosingSteps.find(s => s.micro)?.conveyorId;
    return id ? this.equipment.get(id) : undefined;
  }
  /** The scale a step is weighed on: a micro on its conveyor's scale, anything else on the mixer's. */
  private stepScale(step: DosingStep): ScaleReading | undefined {
    if (!step.micro) return this.getMixerScale();
    const id = step.conveyorId ? this.equipment.get(step.conveyorId)?.config.scaleId as string | undefined : undefined;
    return id ? this.scales[id] : undefined;
  }
  private microZeroLbs(conv: EquipmentRuntime) { return Number(conv.config.zeroToleranceLbs ?? 2); }

  // PLC Micros Over Capacity: more on the belt than the conveyor can hold stops the feeders and pauses the batch.
  private checkMicroCapacity(b: BatchRuntime, step: DosingStep, weight: number): boolean {
    const conv = step.conveyorId ? this.equipment.get(step.conveyorId) : undefined;
    const cap = Number(conv?.config.capacityLbs ?? 0);
    if (!conv || !(cap > 0) || weight <= cap) return true;
    step.clean = false;
    const auger = step.augerId ? this.equipment.get(step.augerId) : undefined;
    if (auger) auger.request = false;
    this.raiseFault(conv.id, 'CRITICAL', `${conv.name}: micros scale over capacity (${round1(weight)} lb)`, 'E-BA-02');
    this.pauseActiveBatch();
    b.faultReason = `Micros scale over capacity (${round1(weight)} of ${cap} lb) - clear the belt, then Resume`;
    return false;
  }

  // PLC Mixer Capacity: more gross weight in the mixer than it holds stops the feeder and pauses the batch (same default as the queue warning).
  private checkMixerCapacity(b: BatchRuntime, step: DosingStep, weight: number): boolean {
    const mixer = this.findEquipmentByType('mixer');
    const cap = Number(mixer?.config.capacity ?? 4000);
    if (!mixer || !(cap > 0) || weight <= cap) return true;
    step.clean = false;
    const auger = step.augerId ? this.equipment.get(step.augerId) : undefined;
    if (auger) auger.request = false;
    this.raiseFault(mixer.id, 'CRITICAL', `${mixer.name}: mixer scale over capacity (${round1(weight)} lb)`, 'E-BA-04');
    this.pauseActiveBatch();
    b.faultReason = `Mixer scale over capacity (${round1(weight)} of ${cap} lb) - empty the mixer, then Resume`;
    return false;
  }

  // ── shared VFDs: one drive for several augers; its I/O lives on the VFD, the auger keeps only its starter ──
  private sharedVfdOf(eq: EquipmentRuntime | undefined): SharedVfd | undefined {
    const id = eq?.config.sharedVfdId;
    return id ? this.sharedVfds.find(v => v.id === id) : undefined;
  }
  /** The analog speed output that drives this feeder (its own, or its shared VFD's) with the span and limits that go with it. */
  private speedOutput(eq: EquipmentRuntime | undefined): { sig: string; minPct: number; maxPct: number; lo: number; hi: number } | undefined {
    if (!eq) return undefined;
    const v = this.sharedVfdOf(eq);
    if (v) return v.analogSpeedOutput ? { sig: v.analogSpeedOutput, minPct: v.speedMinPct, maxPct: v.speedMaxPct, lo: v.speedMinLimit, hi: v.speedMaxLimit } : undefined;
    const sig = eq.config.analogSpeedOutput as string | undefined;
    return sig ? { sig, minPct: Number(eq.config.speedMinPct ?? 0), maxPct: Number(eq.config.speedMaxPct ?? 100),
      lo: Number(eq.config.speedMinLimit ?? 0), hi: Number(eq.config.speedMaxLimit ?? 100) } : undefined;
  }

  // Only the scale assigned to the mixer counts: with none assigned (or none reading) the batch has no weight to work with.
  private getMixerScale(): ScaleReading | undefined {
    const id = this.findEquipmentByType('mixer')?.config.scaleId as string | undefined;
    return id ? this.scales[id] : undefined;
  }

  // ── default config matching hmi-prototype ──

  private loadDefaults() {
    this.ingredients = [];
    this.recipes = [];
    this.bins = [];
    this.connections = [];
    this.buildSignals();
  }

  private buildSignals(syncDaemon = true) {
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
    if (syncDaemon) syncIoConf(om, this.signals, this.equipment.values(), this.scaleConfigs);
  }
}
