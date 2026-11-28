// Frontend view types for backend state

export type BatchState = 'IDLE' | 'VALIDATING' | 'READY' | 'DOSING' | 'MIXING' | 'ROUTE_PRECHECK' | 'DISCHARGING' | 'CLEAROUT' | 'COMPLETED' | 'PAUSING' | 'PAUSED' | 'FAULTED' | 'ABORTED_HOLD' | 'ABORTED';

export interface Ingredient {
  id: string;
  name: string;
  category: 'MAIN' | 'MICRO';
  unit: string;
  hidden?: boolean;
}

export interface InventoryEvent {
  id: string;
  ingredientId: string;
  type: 'batch' | 'adjustment';
  batchId?: string;
  adjustmentId?: string;
  change: number;
  date: string;
  notes: string;
  binId?: string;
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
  hidden?: boolean; // hammermill-feed bin marked Not tracked: not shown in inventory or recipes
  levelSwitchState?: 'empty' | 'full' | 'normal' | 'fault';
}

export interface RecipeLine {
  ingredientId: string;
  target: number;
  unit: string;
}

export interface Recipe {
  id: string;
  name: string;
  revision: number;
  mixTime: number;
  lines: RecipeLine[];
  microLines: RecipeLine[];
}

export interface QueueEntry {
  id: string;
  recipeId: string;
  recipeName: string;
  targetMass: number;
  destination: string;
  state: BatchState;
  progress?: string; // live batches: stage and how far through it
  startedAt?: string;
  completedAt?: string;
  actuals?: { ingredientId: string; target: number; actual: number; unit: string; sourceBinId: string; alternateBinIds?: string[] }[];
  scheduledAt?: string;
  late?: boolean;
  warnings?: string[];
  faultReason?: string;
  tolHold?: ToleranceHold;
  dosingError?: DosingError;
  microUnloading?: boolean;
}

// An out-of-tolerance step waiting for the operator (Ignore / Update freefall / Abort).
export interface ToleranceHold {
  stepIndex: number; ingredientName: string; desired: number; actual: number; difference: number; currentFreefall: number; newFreefall: number;
}

// A dosing step that failed (no flow ...): the batch is paused; Resume retries, Accept carries on, Abort gives up.
export interface DosingError { stepIndex: number; ingredientName: string; message: string; actual: number; target: number }

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
