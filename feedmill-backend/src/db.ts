import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { BatchRuntime, DosingStep, Fault } from './types.js';

const DATA_DIR = process.env.MILL_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'mill.db');

let db: Database.Database;

export function openDb(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(SCHEMA);
}

export function closeDb(): void {
  db?.close();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS active_batch (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  target_mass REAL NOT NULL,
  destination TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  dosing_index INTEGER NOT NULL,
  dosing_steps TEXT NOT NULL,
  mix_time_remaining_ms INTEGER NOT NULL,
  mix_time_total_ms INTEGER NOT NULL,
  discharge_start_time INTEGER NOT NULL,
  fault_reason TEXT,
  previous_state TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_history (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  target_mass REAL NOT NULL,
  destination TEXT NOT NULL,
  final_state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  dosing_steps TEXT NOT NULL,
  mix_time_total_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  bin_id TEXT NOT NULL,
  ingredient_id TEXT,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  batch_id TEXT,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fault_log (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  equipment TEXT NOT NULL,
  message TEXT NOT NULL,
  code TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  cleared_at TEXT,
  acknowledged_at TEXT
);
`;

// ── active batch persistence ──

const upsertBatch = () => db.prepare(`
  INSERT OR REPLACE INTO active_batch
    (id, recipe_id, recipe_name, target_mass, destination, state,
     started_at, dosing_index, dosing_steps,
     mix_time_remaining_ms, mix_time_total_ms, discharge_start_time,
     fault_reason, previous_state, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const deleteBatch = () => db.prepare('DELETE FROM active_batch WHERE id = ?');
const selectBatch = () => db.prepare('SELECT * FROM active_batch LIMIT 1');

export function persistBatch(b: BatchRuntime): void {
  upsertBatch().run(
    b.id, b.recipeId, b.recipeName, b.targetMass, b.destination, b.state,
    b.startedAt, b.dosingIndex, JSON.stringify(b.dosingSteps),
    b.mixTimeRemainingMs, b.mixTimeTotalMs, b.dischargeStartTime,
    b.faultReason ?? null, b.previousState ?? null,
    new Date().toISOString(),
  );
}

export function clearActiveBatch(id: string): void {
  deleteBatch().run(id);
}

export function loadActiveBatch(): BatchRuntime | null {
  const row = selectBatch().get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    recipeId: row.recipe_id as string,
    recipeName: row.recipe_name as string,
    targetMass: row.target_mass as number,
    destination: row.destination as string,
    state: row.state as BatchRuntime['state'],
    startedAt: row.started_at as string,
    dosingIndex: row.dosing_index as number,
    dosingSteps: JSON.parse(row.dosing_steps as string) as DosingStep[],
    mixTimeRemainingMs: row.mix_time_remaining_ms as number,
    mixTimeTotalMs: row.mix_time_total_ms as number,
    dischargeStartTime: row.discharge_start_time as number,
    faultReason: row.fault_reason as string | undefined,
    previousState: row.previous_state as BatchRuntime['state'] | undefined,
  };
}

// ── batch history ──

const insertHistory = () => db.prepare(`
  INSERT OR IGNORE INTO batch_history
    (id, recipe_id, recipe_name, target_mass, destination, final_state,
     started_at, completed_at, dosing_steps, mix_time_total_ms)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`);

export function archiveBatch(b: BatchRuntime): void {
  insertHistory().run(
    b.id, b.recipeId, b.recipeName, b.targetMass, b.destination, b.state,
    b.startedAt, b.completedAt ?? null, JSON.stringify(b.dosingSteps), b.mixTimeTotalMs,
  );
}

// ── inventory events ──

const insertInventory = () => db.prepare(`
  INSERT OR IGNORE INTO inventory_events
    (idempotency_key, event_type, bin_id, ingredient_id, quantity, unit, batch_id, timestamp)
  VALUES (?,?,?,?,?,?,?,?)
`);

export function postInventoryEvent(
  idempotencyKey: string, eventType: string,
  binId: string, ingredientId: string | null,
  quantity: number, unit: string, batchId: string | null,
): void {
  insertInventory().run(
    idempotencyKey, eventType, binId, ingredientId, quantity, unit,
    batchId, new Date().toISOString(),
  );
}

// ── fault log ──

const upsertFault = () => db.prepare(`
  INSERT OR REPLACE INTO fault_log
    (id, severity, equipment, message, code, raised_at, cleared_at, acknowledged_at)
  VALUES (?,?,?,?,?,?,?,?)
`);

// Faults survive a power cycle: everything still active, plus recent history, newest first (the order Mill keeps them in).
export function loadFaults(limit = 500): Fault[] {
  const rows = db.prepare('SELECT * FROM fault_log ORDER BY (cleared_at IS NULL) DESC, raised_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(r => ({
    id: r.id as string, severity: r.severity as Fault['severity'], equipment: r.equipment as string,
    message: r.message as string, code: r.code as string, raisedAt: r.raised_at as string,
    clearedAt: (r.cleared_at as string | null) ?? null, acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
    active: r.cleared_at == null,
  })).sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : a.raisedAt > b.raisedAt ? -1 : 0));
}

export function persistFault(f: Fault): void {
  upsertFault().run(
    f.id, f.severity, f.equipment, f.message, f.code,
    f.raisedAt, f.clearedAt, f.acknowledgedAt,
  );
}
