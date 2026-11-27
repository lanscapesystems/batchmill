// Batch numbering, history pages, live-only snapshots and update pacing. Uses its own throwaway data folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-history-'));
Object.assign(process.env, {
  MILL_DATA_DIR: dir, FEEDMILL_IO_CONF_PATH: path.join(dir, 'io.conf'),
  FEEDMILL_IO_STATE_PATH: path.join(dir, 'io-state.json'), FEEDMILL_IO_COMMAND_PATH: path.join(dir, 'io-command.txt'),
});
(async () => {
const { Mill } = await import('./mill.js');
const db = await import('./db.js');
const { screenFeed } = await import('./hmiFeed.js');

let m: any;
const boot = () => {
  m = new Mill();
  m.recipes = [{ id: 'R', name: 'Ration', mixTime: 1, lines: [{ ingredientId: 'I', target: 10, unit: 'lbs' }], microLines: [] }];
  m.bins = [{ id: 'FB', name: 'Finished', type: 'finished', balance: 0, capacity: 1000, unit: 'lbs' }];
};
const restart = () => { m.stop(); boot(); };
const cmd = (action: string, targetId?: string, parameters?: any) => m.processCommand({ requestId: 'x', action, targetId, parameters });
const queue = () => { assert.equal(cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB', acknowledged: true }).accepted, true); return m.queue.at(-1); };
const finish = (b: any) => { m.activeBatch = b; m.closeBatch(b, 'COMPLETED'); };

// numbers start at 1 and are never issued twice: not after a restart, nor after a delete
boot();
assert.equal(cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'NOPE' }).accepted, false);
const b1 = queue(); assert.equal(b1.id, '1', 'first batch is #1, and a refused one uses no number');
finish(b1);
restart();
const b2 = queue(); assert.equal(b2.id, '2');
assert.equal(cmd('DeleteBatch', '2').accepted, true);
restart();
assert.equal(queue().id, '3', 'a deleted batch keeps its number');

// numbers already on record (older versions started at 2000, and reused them) are passed over
finish(m.queue[0]);
db.archiveBatch({ ...b1, id: '4', state: 'COMPLETED', completedAt: new Date().toISOString() });
db.postInventoryEvent('old-5', 'consumption', 'B', 'I', -1, 'lbs', '5');
assert.equal(queue().id, '6');
// a waiting batch left over with a finished batch's number is given a new one, keeping its place
const dup = m.queue.at(-1);
db.persistBatch({ ...dup, id: '1' }); db.clearActiveBatch(dup.id);
restart();
assert.deepEqual(m.queue.map((b: any) => [b.id, b.order]), [['7', dup.order]]);
assert.equal(queue().id, '8');
assert.ok(m.queue[1].order > m.queue[0].order, 'new batches join at the back');
// an older database restored over a newer one keeps the count
const copy = path.join(dir, 'restored.db');
await db.backupDb(copy);
db.keepBatchNumber(copy, 500);
const Database = (await import('better-sqlite3')).default;
const restored = new Database(copy);
assert.equal((restored.prepare("SELECT value FROM counters WHERE name='batch'").get() as any).value, 500);
restored.close();

// two lines of one ingredient are both recorded
const two = queue(); two.dosingSteps = [0, 1].map(() => ({ ...two.dosingSteps[0], actual: 5 }));
m.postConsumption(two); finish(two);
const reader = new Database(db.dbFilePath, { readonly: true });
assert.equal((reader.prepare('SELECT COUNT(*) AS n FROM inventory_events WHERE batch_id = ?').get(two.id) as any).n, 2);

// screens get live items only; history comes in pages, newest first, filtered by date
assert.ok(!m.getSnapshot().queue.some((b: any) => b.state === 'COMPLETED'));
for (let i = 0; i < 60; i++) db.archiveBatch({ ...b1, id: `h${i}`, state: 'COMPLETED', completedAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString() });
const old = db.historyQuery({ to: '2021-01-01' });
const first = db.batchHistory(old), second = db.batchHistory({ ...old, offset: 50 });
assert.deepEqual([first.rows.length, first.more, second.rows.length, second.more], [50, true, 10, false]);
assert.equal(first.rows[0].id, 'h59');
assert.deepEqual(db.batchHistory(db.historyQuery({ from: '2021-01-01', offset: '-3' })).rows.map(r => r.id).sort(), ['1', '3', '4', two.id].sort());

// faults: only active ones go to screens; history groups repeats; numbers are never reused
m.faults = [];
for (let i = 0; i < 3; i++) { m.raiseFault('FT', 'WARNING', `try ${i}`, 'W-T'); m.clearFault('W-T'); }
m.raiseFault('FT', 'WARNING', 'still on', 'W-T');
assert.deepEqual(m.getSnapshot().faults.map((f: any) => f.message), ['still on']);
const group = (db.faultHistory(db.historyQuery({})).rows as any[]).find(r => r.code === 'W-T');
assert.deepEqual([group.count, group.message], [4, 'still on']);
assert.equal(db.faultHistory(db.historyQuery({ code: 'W-T', equipment: 'FT' })).rows.length, 4);
const lastId = m.faults[0].id;
restart();
m.raiseFault('FT2', 'WARNING', 'after', 'W-T2');
assert.ok(Number(m.faults[0].id.slice(2)) > Number(lastId.slice(2)));

// pruning: year-old cleared faults go, but never active ones or the newest 1000
const old2019 = (i: number, cleared: boolean) => ({ id: `F-${9000 + i}`, severity: 'INFO' as const, equipment: 'OLD', message: 'm', code: 'C', raisedAt: new Date(Date.UTC(2019, 0, 1, 0, 0, i)).toISOString(), clearedAt: cleared ? '2019-01-02T00:00:00.000Z' : null, active: !cleared });
const count = () => (reader.prepare("SELECT COUNT(*) AS n FROM fault_log WHERE equipment = 'OLD'").get() as any).n;
db.persistFault(old2019(0, false));
for (let i = 1; i <= 1100; i++) db.persistFault(old2019(i, true));
db.pruneFaults();
const recent = (reader.prepare("SELECT COUNT(*) AS n FROM fault_log WHERE equipment != 'OLD'").get() as any).n;
assert.equal(count(), 1000 - recent + 1, 'the newest 1000 in total, plus the old active one');
reader.close();

// a paced screen has one update on the way; what was held back goes, current, on its confirmation
const sent: string[] = [];
const socket = { readyState: 1 as const, bufferedAmount: 0, send: (s: any) => { sent.push(s); } };
const feed = screenFeed(socket, true, () => 'latest');
feed.send('a'); feed.send('b'); feed.send('c'); assert.deepEqual(sent, ['a']);
feed.confirm(); assert.deepEqual(sent, ['a', 'latest']);
feed.confirm(); feed.confirm(); assert.deepEqual(sent, ['a', 'latest']);
const legacy = screenFeed(socket, false, () => 'latest'); sent.length = 0;
legacy.send('a'); legacy.send('b'); socket.bufferedAmount = 1; legacy.send('c'); assert.deepEqual(sent, ['a', 'b']);

m.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log('history checks passed');
})().catch(e => { console.error(e); process.exit(1); });
