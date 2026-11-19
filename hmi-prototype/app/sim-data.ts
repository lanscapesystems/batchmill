// Frontend view types for backend state

export type BatchState = 'IDLE' | 'VALIDATING' | 'READY' | 'DOSING' | 'MIXING' | 'ROUTE_PRECHECK' | 'DISCHARGING' | 'CLEAROUT' | 'COMPLETED' | 'PAUSING' | 'PAUSED' | 'FAULTED';

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
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  actuals?: { ingredientId: string; target: number; actual: number; unit: string; sourceBinId: string; alternateBinIds?: string[] }[];
}

export interface Fault {
  id: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  equipment: string;
  message: string;
  code: string;
  raisedAt: string;
  clearedAt: string | null;
  acknowledgedAt: string | null;
  active: boolean;
}
