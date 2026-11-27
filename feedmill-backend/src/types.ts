export type SignalDirection = 'DI' | 'DO' | 'AI' | 'AO';
export type SignalValue = boolean | number;

export interface SignalDef {
  id: string;
  direction: SignalDirection;
  label: string;
  equipmentId?: string;
  assignment?: string; // what the point is configured as, e.g. "A-1 Run" or "E-Stop" (snapshot only)
  port?: string;
}

export type EquipmentStatus = 'not_running' | 'running' | 'fault' | 'warning' | 'disabled';
// Motors: Hand / Off / Auto. Gates: P1 (open) / P2 (closed) / Off / Auto. Bins have no HOA (no motor).
export type EquipmentMode = 'Auto' | 'Hand' | 'Off' | 'P1' | 'P2';

export interface EquipmentRuntime {
  id: string;
  name: string;
  equipmentType: string;
  class: string;
  mode: EquipmentMode;
  status: EquipmentStatus;
  request: boolean;   // run request bit, set by Hand mode, the batch engine or a refill
  runCmd: boolean;    // run command after start/stop delays; this is what the run output follows
  feedback: boolean;
  faultReason?: string;
  warningReason?: string;
  owner?: string;
  config: Record<string, string | number | boolean>;
  position?: { x: number; y: number };
  speed?: number;    // VFD speed setpoint, % (only used when config.analogSpeedOutput is assigned)
  faultTimerMs: number;
  loadAmps?: number;          // averaged motor current from config.analogLoadInput, scaled min/maxAmps (runtime only)
  loadDisconnected?: boolean;
  gatePort?: 1 | 2;           // gate: which outlet (P1 / P2) its owner needs, chosen from the flow path
  gateLast?: 'open' | 'close'; // gate: last position driven (a double-coil / motor gate stays there when released)
  vfdStartMs?: number;        // master VFD: how long the starter has been confirmed (runtime)
  vfdCmd?: boolean;           // master VFD run output wanted (starter confirmed for vfdStartDelay)
  loadAtRunning?: boolean;    // relay autotune in progress (runtime)
  loadAtMsg?: string;         // last autotune result
  loadControlAuto?: boolean;  // load PID trims the feeder's speed (runtime, off at startup)
  enabled?: boolean;         // hammermill only: the operator's Enable/Disable switch, separate from the HOA mode
  runSecondsTotal?: number;  // lifetime run time, never reset
  runSeconds?: number;       // run time since runSecondsResetAt (operator-resettable, like the PLC's RT1)
  runSecondsResetAt?: string;
  positionTimerMs: number;
  startTimerMs: number;
  stopTimerMs: number;
  gatePosition?: 'open' | 'closed' | 'moving' | 'unknown';
}

export type BatchState = 'IDLE' | 'VALIDATING' | 'READY' | 'DOSING' | 'MIXING' |
  'ROUTE_PRECHECK' | 'DISCHARGING' | 'CLEAROUT' | 'COMPLETED' | 'PAUSING' | 'PAUSED' | 'FAULTED' |
  'ABORTED_HOLD' | 'ABORTED'; // aborted/failed with material in the mixer: waits for Unload (or Discard once empty)

export interface DosingStep {
  ingredientId: string;
  ingredientName: string;
  sourceBinId: string;
  augerId: string;
  target: number;
  actual: number;
  unit: string;
  state: 'pending' | 'baseline' | 'feeding' | 'cutoff' | 'settling' | 'hold' | 'complete' | 'faulted';
  baselineWeight: number;
  settleStartTime: number;
  cutoffStartTime: number;
  augerRunMs?: number;   // time the auger has run this feed (no-progress delay counts from here)
  progressMs?: number;   // time in the current no-progress window
  progressRef?: number;  // step actual at the start of the window
  clean?: boolean;       // false once paused / scale lost / re-baselined: the stop point is not a clean run, so no freefall calibration
  deviation?: number;    // actual - target once settled
  ffOld?: number;        // freefall before / after the calibration of this step (set when one was applied)
  ffNew?: number;
  micro?: boolean;       // dosed from the recipe's micro list: weighed on the micros conveyor's scale, unloaded into the mixer after all dosing
  conveyorId?: string;   // micro steps: the micro_drag its auger feeds
}

// A VFD shared by several augers: its I/O is configured once here, and the augers on it only keep their starter.
export interface SharedVfd {
  id: string;
  name: string;
  runOutput?: string;
  auxInput?: string;
  analogSpeedOutput?: string;
  startDelay: number;    // s: the VFD run output closes this long after the auger's starter is confirmed (PLC M11: 0.7)
  speedMinPct: number;   // analog output span: 0..100 % of the speed setpoint maps to these % of the output
  speedMaxPct: number;
  speedMinLimit: number; // operator limits for the speed setpoint, %
  speedMaxLimit: number;
}

// Out-of-tolerance step waiting for the operator (Ignore / Update freefall / Abort).
export interface DosingError { stepIndex: number; ingredientName: string; message: string; actual: number; target: number }

export interface ToleranceHold {
  stepIndex: number;
  ingredientName: string;
  desired: number;
  actual: number;
  difference: number;
  currentFreefall: number;
  newFreefall: number;
}

export interface BatchRuntime {
  id: string;
  recipeId: string;
  recipeName: string;
  targetMass: number;
  destination: string;
  state: BatchState;
  startedAt: string;
  completedAt?: string;
  dosingIndex: number;
  dosingSteps: DosingStep[];
  mixTimeRemainingMs: number;
  mixTimeTotalMs: number;
  dischargeStartTime: number;
  faultReason?: string;
  previousState?: BatchState;
  order?: number;                // queue position (kept across restarts; Move changes it)
  scheduledAt?: string;          // ISO time: not released before this
  late?: boolean;                // released more than a minute after its scheduled time
  warnings?: string[];           // queue-time warnings (inventory / mixer capacity) the operator accepted
  tolHold?: ToleranceHold;
  dosingError?: DosingError;
  // Micros: dosingIndex walks the majors (steps before the first micro), microIndex walks the micros; both tracks run at once.
  microIndex?: number;
  microUnloading?: boolean;      // belt running into the mixer (after every major and micro is done, or at the start of an abort unload)
  microUnloadRunMs?: number;     // time the belt has run in this unload
  microDelivered?: boolean;      // the belt has been emptied into the mixer
  abortMode?: 'mixUnload' | 'unload'; // an aborted batch with micros on the belt: what to do once the belt is empty
  dischargeStartWeight?: number; // mixer weight when discharge began (credited weight = this minus what is left)
  emptySinceMs?: number;         // when the scale first declared the mixer empty (cleanout time counts from here)
  consumptionPosted?: boolean;   // dosed material already deducted from the bins
  unloading?: boolean;           // an aborted batch is discharging its mixer contents
}

export interface Recipe {
  id: string;
  name: string;
  revision: number;
  mixTime: number;
  lines: { ingredientId: string; target: number; unit: string }[];
  microLines: { ingredientId: string; target: number; unit: string }[];
}

export interface Ingredient {
  id: string;
  name: string;
  category: 'MAIN' | 'MICRO';
  unit: string;
  hidden?: boolean;
}

export interface Bin {
  id: string;
  name: string;
  note?: string;
  ingredientId: string | null;
  balance: number;
  capacity: number;
  unit: string;
  type: 'ingredient' | 'finished' | 'micro_hopper';
  tracked?: boolean;
  hidden?: boolean; // snapshot only: a hammermill-feed bin marked Not tracked (hidden from inventory and recipes)
}

export interface Fault {
  id: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  equipment: string;
  message: string;
  code: string;
  raisedAt: string;
  clearedAt: string | null;
  active: boolean;
}

export interface ScaleReading {
  weight: number;
  stable: boolean;
  valid: boolean;
  timestamp: number;
}

export interface FlowConnection {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface EquipmentDef {
  prefix: string;
  label: string;
  class: string;
  maxCount?: number;
}

export const EQUIPMENT_DEFS: Record<string, EquipmentDef> = {
  bin:          { prefix: 'B',  label: 'Ingredient Bin', class: 'StorageBin',  maxCount: 32 },
  hammermill:   { prefix: 'HM', label: 'Hammer Mill',    class: 'HammerMill',  maxCount: 4 },
  mixer:        { prefix: 'MX', label: 'Mixer',          class: 'Mixer',       maxCount: 1 },
  finished_bin: { prefix: 'FB', label: 'Finished Bin',   class: 'StorageBin',  maxCount: 8 },
  micro_drag:   { prefix: 'MD', label: 'Micro Drag',     class: 'Conveyor',    maxCount: 2 },
  gate:         { prefix: 'GT', label: 'Gate',            class: 'Gate' },
  auger:        { prefix: 'A',  label: 'Auger',          class: 'Auger' },
};

// empty = low switch uncovered, full = high switch covered, fault = high covered while low uncovered (impossible)
export type LevelSwitchState = 'empty' | 'normal' | 'full' | 'fault';

export interface StateSnapshot {
  revision: number;
  timestamp: string;
  equipment: {
    id: string;
    name: string;
    equipmentType: string;
    class: string;
    status: EquipmentStatus;
    mode: EquipmentMode;
    commanded: boolean;
    feedback: boolean;
    faultReason?: string;
    warningReason?: string;
    owner?: string;
    config: Record<string, string | number | boolean>;
    position?: { x: number; y: number };
    speed?: number;
    refillState?: string;
    gatePosition?: string;
    highCovered?: boolean; // bins: high switch covered (full); undefined = not configured or bypassed
    lowCovered?: boolean;  // bins: low switch covered (above low point); uncovered = empty
  }[];
  queue: QueueSnapshot[];
  activeBatch: BatchSnapshot | null;
  faults: Fault[];
  bins: (Bin & { levelSwitchState?: LevelSwitchState })[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  connections: FlowConnection[];
  io: {
    inputs: Record<string, SignalValue>;
    outputs: Record<string, SignalValue>;
    signals: SignalDef[];
    overrides: Record<string, SignalValue>;
  };
  scales: Record<string, ScaleReading>;
  scaleConfigs: ScaleConfig[];
  sharedVfds: SharedVfd[];
  omronConfig: OmronConfig;
  globalConfig: Record<string, string | number>;
  // Gates forcing an output via SetOverride — bench-testing real DO/AO points
  // needs to bypass control logic, which normal operation must never allow.
  commissioningMode: boolean;
  horn: { on: boolean; silenced: boolean };
  queueControl: { held: boolean; waiting?: string }; // held = no new batches are released
}

export interface QueueSnapshot {
  id: string;
  recipeId: string;
  recipeName: string;
  targetMass: number;
  destination: string;
  state: BatchState;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  dosingSteps?: {
    ingredientId: string;
    ingredientName: string;
    sourceBinId: string;
    target: number;
    actual: number;
    unit: string;
    state: string;
    deviation?: number;
    micro?: boolean;
  }[];
  microUnloading?: boolean;
  mixTimeRemainingMs?: number;
  mixTimeTotalMs?: number;
  faultReason?: string;
  scheduledAt?: string;
  late?: boolean;
  warnings?: string[];
  tolHold?: ToleranceHold;
  dosingError?: DosingError;
}

export interface BatchSnapshot extends QueueSnapshot {}

export interface Command {
  requestId: string;
  action: string;
  targetId?: string;
  parameters?: Record<string, unknown>;
}

export interface CommandResult {
  requestId: string;
  accepted: boolean;
  reason?: string;
  revision: number;
  data?: unknown; // optional payload (e.g. a rack read)
}

export type ScaleConnectionType = 'serial' | 'rs1201';

export interface ScaleConfig {
  id: string;
  name: string;
  connectionType: ScaleConnectionType;
  // Serial settings (used when connectionType === 'serial')
  protocol: string;
  comPort: string;
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: number;
  // Weight extraction for 'serial': first match of this regex against each
  // line is parsed as the weight (sign + digits + optional decimal point).
  // Works unconfigured for most continuous-output scaleheads, which just
  // emit a number per line; override only if a head's framing needs it
  // (e.g. to skip a non-weight number elsewhere in the line).
  weightRegex: string;
  // RS1201 settings (used when connectionType === 'rs1201')
  rackSlot: number;
  // Calibration (RS1201 load cell)
  zeroOffset: number;
  ratedMvV: number;
  calibration?: { mode: 'theoretical' | 'zero' | 'span'; at: string; standardWeight?: number }; // last RS1201 calibration done from the HMI
  // Common
  capacity: number;
  resolution: number;
  freshnessTimeout: number;
  stabilityWindow: number;
}

export type CouplerType = 'none' | 'NX-EIC' | 'NX-ECC';

// NX-ECC202 vs NX-ECC203: min cyclic period and ring-topology support differ (Omron W519).
export type EccModel = 'NX-ECC202' | 'NX-ECC203';

export const ECC_MODEL_MIN_CYCLE_US: Record<EccModel, number> = {
  'NX-ECC202': 250,
  'NX-ECC203': 125,
};

export type NxCardCategory = 'power' | 'DI' | 'DO' | 'AI' | 'AO' | 'scale';

export interface NxCardDef {
  model: string;
  category: NxCardCategory;
  points: number;
  label: string;
  busWatts: number; // NX Bus power consumption (W) — coupler supplies 10W max
  fullScale?: number; // AI/AO only: raw count at 100% of the span (W522 §6-2/7-2: 1/8000 models, 4-20mA = 0..8000; ±10V models = ±4000, 0-10V half used here)
}

export const NX_CARD_CATALOG: NxCardDef[] = [
  // Power — I/O field power supply; busWatts = coupler-connected values
  { model: 'NX-PF0730', category: 'power', points: 0, label: 'I/O Power Supply (10A)', busWatts: 0.45 },
  { model: 'NX-PF0630', category: 'power', points: 0, label: 'Additional I/O Power Supply (4A)', busWatts: 0.45 },
  { model: 'NX-PC0030', category: 'power', points: 0, label: 'I/O Power Connection Unit', busWatts: 0.45 },
  // Digital Input — DC
  { model: 'NX-ID5442', category: 'DI', points: 16, label: '16pt 24VDC Input (PNP)', busWatts: 0.55 },
  { model: 'NX-ID5342', category: 'DI', points: 16, label: '16pt 24VDC Input (NPN)', busWatts: 0.55 },
  { model: 'NX-ID4342', category: 'DI', points: 8, label: '8pt 24VDC Input (NPN)', busWatts: 0.55 },
  { model: 'NX-ID4442', category: 'DI', points: 8, label: '8pt 24VDC Input (PNP)', busWatts: 0.55 },
  // Digital Input — AC
  { model: 'NX-IA3117', category: 'DI', points: 4, label: '4pt 200-240VAC Input', busWatts: 0.50 },
  // Digital Output — Transistor
  { model: 'NX-OD5256', category: 'DO', points: 16, label: '16pt 24VDC Output (PNP)', busWatts: 0.70 },
  { model: 'NX-OD4256', category: 'DO', points: 8, label: '8pt 24VDC Output (PNP)', busWatts: 0.65 },
  // Digital Output — Relay (independent contacts per point, 2A/point)
  { model: 'NX-OC4633', category: 'DO', points: 8, label: '8pt Relay Output (indep. contacts)', busWatts: 1.65 },
  { model: 'NX-OC2633', category: 'DO', points: 2, label: '2pt Relay Output (indep. contacts)', busWatts: 0.80 },
  // Analog Input
  { model: 'NX-AD4203', category: 'AI', points: 8, label: '8ch Current Input (4-20mA)', fullScale: 8000, busWatts: 1.05 },
  { model: 'NX-AD4603', category: 'AI', points: 8, label: '8ch Voltage Input (±10V)', fullScale: 4000, busWatts: 1.15 },
  { model: 'NX-AD2203', category: 'AI', points: 2, label: '2ch Current Input (4-20mA)', fullScale: 8000, busWatts: 0.90 },
  { model: 'NX-AD3203', category: 'AI', points: 4, label: '4ch Current Input (4-20mA)', fullScale: 8000, busWatts: 0.90 },
  // Analog Output
  { model: 'NX-DA2203', category: 'AO', points: 2, label: '2ch Current Output (4-20mA)', fullScale: 8000, busWatts: 1.40 },
  { model: 'NX-DA3203', category: 'AO', points: 4, label: '4ch Current Output (4-20mA)', fullScale: 8000, busWatts: 1.80 },
  { model: 'NX-DA3205', category: 'AO', points: 4, label: '4ch Current Output (4-20mA, 1/30000)', fullScale: 30000, busWatts: 1.80 }, // W522: 0..30000 = 4..20 mA
  { model: 'NX-DA3603', category: 'AO', points: 4, label: '4ch Voltage Output (±10V)', fullScale: 4000, busWatts: 1.80 },
  // Load Cell
  { model: 'NX-RS1201', category: 'scale', points: 1, label: '1ch Load Cell Input (24-bit)', busWatts: 1.70 },
  // Additional NX Bus Power (provides 10W to downstream units)
  { model: 'NX-PD1000', category: 'power', points: 0, label: 'Addl NX Bus Power Supply (10W)', busWatts: 0.45 },
];

export const NX_BUS_POWER_BUDGET_W = 10; // Coupler provides 10W NX Bus power
export const NX_MAX_UNITS = 63; // Max I/O units per coupler

export const OMRON_VENDOR_ID = 0x00000083;

// Confirmed on real NX-ECC203 hardware: the coupler + every NX I/O module
// racked behind it is ONE EtherCAT slave, not one slave per card — Omron's
// NX bus is an internal backplane the coupler bridges to EtherCAT, invisible
// to the network. So there's one shared product ID and PDO entry list for
// the whole rack (DiscoveredRack below), and a card's own entry/entries are
// a SLICE of that list — which slice depends on the card's position among
// same-category cards, not just its model, so re-slicing happens fresh
// every time generateIoConf() runs (see allocateRackEntries in
// src/ethercat.ts), not once and cached per model.
export interface PdoEntry {
  index: number;
  subindex: number;
  bits: number;
  dir: 'input' | 'output';
}

export interface DiscoveredRack {
  productId: number;
  inputEntries: PdoEntry[];  // in physical rack order among DI/AI/scale cards
  outputEntries: PdoEntry[]; // in physical rack order among DO/AO cards
}

export interface IoRackCard {
  slot: number; // position in the physical rack (1st, 2nd module...), NOT an EtherCAT bus position
  model: string;
  actual?: string;
  status: 'unchecked' | 'ok' | 'mismatch' | 'missing';
  pdoEntries?: PdoEntry[]; // this card's slice of DiscoveredRack, from the last Read Rack
}

export interface OmronConfig {
  couplerType: CouplerType;
  ipAddress: string;
  nodeAddress: number;
  eccModel: EccModel; // NX-ECC only: NX-ECC202 or NX-ECC203
  cycleTimeUs: number; // EtherCAT master cyclic period, in microseconds (NX-ECC only)
  ringTopology: boolean; // NX-ECC203 v1.5+ only
  cards: IoRackCard[];
  rackVerified: boolean;
  bus?: 'idle' | 'ok' | 'fault' | 'offline'; // live, snapshot-only (never persisted): daemon healthy / bus invalid / daemon silent
  lastReadAt?: string;
  warnings: string[];
  discoveredRack?: DiscoveredRack; // from the last Read Rack; persists across restarts and reconfiguration
}

