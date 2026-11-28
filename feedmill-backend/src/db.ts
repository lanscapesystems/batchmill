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
  pruneFaults();
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
  cleared_at TEXT
);

CREATE TABLE IF NOT EXISTS batch_json (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS batch_history_completed ON batch_history (completed_at);
CREATE INDEX IF NOT EXISTS fault_log_raised ON fault_log (raised_at);
CREATE INDEX IF NOT EXISTS inventory_events_batch ON inventory_events (batch_id);
CREATE INDEX IF NOT EXISTS inventory_events_time ON inventory_events (timestamp);
`;

// ── batch numbers: count up from 1 and are never issued twice ──

const lastBatchSql = "SELECT value FROM counters WHERE name = 'batch'";
const raiseBatchSql = "INSERT INTO counters (name, value) VALUES ('batch', ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)";

export function lastBatchNumber(): number {
  return (db.prepare(lastBatchSql).get() as { value: number } | undefined)?.value ?? 0;
}

// The next number after the last one issued, passing over any that a record already carries (older versions started at 2000).
export function peekBatchNumber(): number {
  const onRecord = db.prepare(`SELECT 1 FROM batch_history WHERE id = @id UNION ALL SELECT 1 FROM batch_json WHERE id = @id
    UNION ALL SELECT 1 FROM active_batch WHERE id = @id UNION ALL SELECT 1 FROM inventory_events WHERE batch_id = @id`);
  let n = lastBatchNumber() + 1;
  while (onRecord.get({ id: String(n) })) n++;
  return n;
}

export function claimBatchNumber(n: number): void {
  db.prepare(raiseBatchSql).run(n);
}

// A restored (older) database must not hand out numbers that were issued after its backup was made.
export function keepBatchNumber(file: string, issued: number): void {
  const restored = new Database(file);
  try {
    restored.exec('CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    restored.prepare(raiseBatchSql).run(issued);
  } finally { restored.close(); }
}

export function batchInHistory(id: string): boolean {
  return !!db.prepare('SELECT 1 FROM batch_history WHERE id = ?').get(id);
}

// ── batch persistence: the whole batch as JSON, queued and active alike (queued batches survive a restart) ──

export function persistBatchJson(b: BatchRuntime): void {
  db.prepare('INSERT OR REPLACE INTO batch_json (id, json, updated_at) VALUES (?,?,?)').run(b.id, JSON.stringify(b), new Date().toISOString());
}

export function removeBatchJson(id: string): void {
  db.prepare('DELETE FROM batch_json WHERE id = ?').run(id);
}

export function loadBatchesJson(): BatchRuntime[] {
  return (db.prepare('SELECT json FROM batch_json ORDER BY rowid').all() as { json: string }[]).map(r => JSON.parse(r.json) as BatchRuntime);
}

// ── active batch persistence (legacy table, still read once for a batch saved by an older version) ──

const deleteBatch = () => db.prepare('DELETE FROM active_batch WHERE id = ?');
const selectBatch = () => db.prepare('SELECT * FROM active_batch LIMIT 1');

export function persistBatch(b: BatchRuntime): void {
  persistBatchJson(b);
}

export function clearActiveBatch(id: string): void {
  deleteBatch().run(id);
  removeBatchJson(id);
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
  const { changes } = insertHistory().run(
    b.id, b.recipeId, b.recipeName, b.targetMass, b.destination, b.state,
    b.startedAt, b.completedAt ?? null, JSON.stringify(b.dosingSteps), b.mixTimeTotalMs,
  );
  if (!changes) console.error(`Batch ${b.id} is already in the history: this record was NOT saved`);
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

// An ID with history must not be given to a new ingredient.
export function ingredientIdsOnRecord(): string[] {
  return (db.prepare('SELECT DISTINCT ingredient_id AS id FROM inventory_events WHERE ingredient_id IS NOT NULL').all() as { id: string }[]).map(r => r.id);
}

// shortcut: the whole period in one response (the screen totals usage from it); total here and page it if 'all' gets slow
export function inventoryHistory(q: HistoryQuery) {
  const rows = db.prepare(`SELECT * FROM inventory_events WHERE ingredient_id IS NOT NULL AND timestamp >= ?
    ORDER BY timestamp DESC, seq DESC`).all(q.from ?? '') as Record<string, string | number | null>[];
  return {
    more: false,
    rows: rows.map(r => ({
      id: String(r.seq), ingredientId: r.ingredient_id as string, binId: r.bin_id as string,
      type: r.event_type === 'adjustment' ? 'adjustment' as const : 'batch' as const,
      batchId: (r.batch_id as string | null) ?? undefined,
      adjustmentId: r.event_type === 'adjustment' ? String(r.seq) : undefined,
      change: r.quantity as number, date: r.timestamp as string, notes: '',
    })),
  };
}

// ── fault log ──

const upsertFault = () => db.prepare(`
  INSERT OR REPLACE INTO fault_log
    (id, severity, equipment, message, code, raised_at, cleared_at)
  VALUES (?,?,?,?,?,?,?)
`);

// Faults survive a power cycle: everything still active, plus recent history, newest first (the order Mill keeps them in).
export function loadFaults(limit = 500): Fault[] {
  const rows = db.prepare('SELECT * FROM fault_log ORDER BY (cleared_at IS NULL) DESC, raised_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(r => ({
    id: r.id as string, severity: r.severity as Fault['severity'], equipment: r.equipment as string,
    message: r.message as string, code: r.code as string, raisedAt: r.raised_at as string,
    clearedAt: (r.cleared_at as string | null) ?? null,
    active: r.cleared_at == null,
  })).sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : a.raisedAt > b.raisedAt ? -1 : 0));
}

export function persistFault(f: Fault): void {
  upsertFault().run(
    f.id, f.severity, f.equipment, f.message, f.code,
    f.raisedAt, f.clearedAt,
  );
}

export function lastFaultNumber(): number {
  return (db.prepare('SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS n FROM fault_log').get() as { n: number | null }).n ?? 0;
}

const FAULT_KEEP_DAYS = 365;
const FAULT_KEEP_NEWEST = 1000; // kept whatever their age, so a wrong system clock cannot empty the history

export function pruneFaults(now = Date.now()): void {
  db.prepare(`DELETE FROM fault_log WHERE cleared_at IS NOT NULL AND cleared_at < ?
    AND id NOT IN (SELECT id FROM fault_log ORDER BY raised_at DESC LIMIT ${FAULT_KEEP_NEWEST})`)
    .run(new Date(now - FAULT_KEEP_DAYS * 86_400_000).toISOString());
}

// ── history, read a page at a time when a screen asks ──

export const HISTORY_PAGE = 50;
export interface HistoryQuery { from?: string; to?: string; offset: number; code?: string; equipment?: string }

export function historyQuery(q: Record<string, unknown>): HistoryQuery {
  const when = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return { from: when(q.from), to: when(q.to), offset: Math.max(0, Math.floor(Number(q.offset)) || 0), code: text(q.code), equipment: text(q.equipment) };
}

function page<T>(select: string, timeColumn: string, q: HistoryQuery, rest: string, where: [string, string][] = []): { rows: T[]; more: boolean } {
  if (q.from) where.push([`${timeColumn} >= ?`, q.from]);
  if (q.to) where.push([`${timeColumn} < ?`, q.to]);
  const filter = where.length ? `WHERE ${where.map(w => w[0]).join(' AND ')}` : '';
  const rows = db.prepare(`${select} ${filter} ${rest} LIMIT ${HISTORY_PAGE + 1} OFFSET ?`).all(...where.map(w => w[1]), q.offset) as T[];
  return { rows: rows.slice(0, HISTORY_PAGE), more: rows.length > HISTORY_PAGE };
}

export function batchHistory(q: HistoryQuery) {
  const { rows, more } = page<Record<string, string | number | null>>(
    'SELECT * FROM batch_history', 'completed_at', q, 'ORDER BY completed_at DESC, rowid DESC');
  return {
    more,
    rows: rows.map(r => ({
      id: r.id as string, recipeId: r.recipe_id as string, recipeName: r.recipe_name as string,
      targetMass: r.target_mass as number, destination: r.destination as string, state: r.final_state as string,
      startedAt: r.started_at as string, completedAt: (r.completed_at as string | null) ?? undefined,
      dosingSteps: (JSON.parse(r.dosing_steps as string) as DosingStep[]).map(s => ({
        ingredientId: s.ingredientId, ingredientName: s.ingredientName, sourceBinId: s.sourceBinId,
        target: s.target, actual: Math.round(s.actual * 10) / 10, unit: s.unit,
      })),
    })),
  };
}

// Without a code: one row per fault (code + equipment) with how often it happened. With one: each occurrence.
export function faultHistory(q: HistoryQuery) {
  if (q.code && q.equipment) {
    return page<{ id: string; raisedAt: string; clearedAt: string | null; message: string }>(
      'SELECT id, raised_at AS raisedAt, cleared_at AS clearedAt, message FROM fault_log', 'raised_at', q,
      'ORDER BY raised_at DESC, rowid DESC', [['code = ?', q.code], ['equipment = ?', q.equipment]]);
  }
  // SQLite takes the bare columns (severity, message) from the row that holds MAX(raised_at): the latest occurrence
  return page<{ code: string; equipment: string; severity: string; message: string; count: number; lastAt: string }>(
    'SELECT code, equipment, severity, message, COUNT(*) AS count, MAX(raised_at) AS lastAt FROM fault_log', 'raised_at', q,
    'GROUP BY code, equipment ORDER BY lastAt DESC');
}

export const dbFilePath = DB_PATH;
// consistent online snapshot (safe while the db is in use, WAL included)
export function backupDb(dest: string): Promise<unknown> {
  return db.backup(dest);
}
