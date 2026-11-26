// Behaviour check for the batch engine: live queue, release gate, dosing, tolerance / freefall, discharge, abort / unload.
// Run: MILL_DATA_DIR=<tmp dir> npm run check
import assert from 'node:assert/strict';
import { Mill } from './mill.js';
import { loadBatchesJson, clearActiveBatch } from './db.js';
import { scaleLines, freefallAdjust, toleranceFor, feedsOnlyHammermill, flowPath } from './batchLogic.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// ── pure helpers ──
assert.deepEqual(scaleLines([{ target: 30 }, { target: 20 }], 100).map(l => l.target), [60, 40]);
assert.deepEqual(scaleLines([{ target: 30 }], undefined).map(l => l.target), [30]);
assert.equal(toleranceFor(undefined, 50), 1); assert.equal(toleranceFor(3, 50), 3);
assert.deepEqual(freefallAdjust(53, 50, 5, 100), { adjust: 3, newFreefall: 8 }, 'over target: more freefall');
assert.deepEqual(freefallAdjust(47, 50, 5, 50), { adjust: 1.5, newFreefall: 3.5 }, 'under target: less freefall');
assert.deepEqual(freefallAdjust(53, 50, 5, 100, 2), { adjust: 2, newFreefall: 7 }, 'capped');
assert.equal(freefallAdjust(49, 50, 0.5, 100).newFreefall, 0, 'never below zero');
const conns = [{ from: 'B', fromPort: 'd', to: 'A', toPort: 'i' }, { from: 'A', fromPort: 'o', to: 'HM', toPort: 'i' }];
const types: Record<string, string> = { B: 'bin', A: 'auger', HM: 'hammermill', MX: 'mixer' };
assert.equal(feedsOnlyHammermill('B', conns, id => types[id]), true);
assert.equal(feedsOnlyHammermill('B', [...conns, { from: 'A', fromPort: 'o', to: 'MX', toPort: 'i' }], id => types[id]), false);
assert.equal(feedsOnlyHammermill('B', [], id => types[id]), false);
assert.deepEqual(flowPath('B', 'HM', conns), ['B', 'A', 'HM']); assert.equal(flowPath('HM', 'B', conns), null);

// ── fixture: bin B1 -> auger A1 -> mixer MX -> finished bin FB, with a simulated scale ──
const m: any = new Mill();
const mk = (id: string, type: string, config: Record<string, unknown>, mode = 'Auto') => ({
  id, name: id, equipmentType: type, class: type, mode, status: 'not_running', request: false, runCmd: false,
  feedback: false, config, faultTimerMs: 0, positionTimerMs: 0, startTimerMs: 0, stopTimerMs: 0,
});
const cmd = (action: string, targetId?: string, parameters?: Record<string, unknown>) =>
  m.processCommand({ requestId: 'x', action, targetId, parameters });
let weight = 0, rate = 5, coast = 0, drain = 20, scaleValid = true, scaleStable = true, wasRunning = false;
const feed = () => { m.scales.SC = { weight, stable: scaleStable, valid: scaleValid, timestamp: Date.now() }; };
// one scan, then the "physics": the auger adds weight while running (the auger runs one more scan after the cutoff, = freefall; `coast` adds extra after it stops), the mixer drains in DISCHARGING
const scan = (n = 1) => {
  for (let i = 0; i < n; i++) {
    feed(); m.scan();
    const a = m.equipment.get('A1');
    if (a.runCmd) weight += rate;
    if (wasRunning && !a.runCmd) weight += coast;
    wasRunning = a.runCmd;
    if (m.activeBatch?.state === 'DISCHARGING') weight = Math.max(0, weight - drain);
  }
};
const until = (pred: () => boolean, max = 1500) => { for (let i = 0; i < max && !pred(); i++) scan(); return pred(); };
const reset = () => {
  for (const b of loadBatchesJson()) clearActiveBatch(b.id); // the database outlives each scenario
  m.equipment.clear(); m.bins = []; m.connections = []; m.queue = []; m.activeBatch = null; m.scales = {}; m.faults = [];
  delete m.globalConfig.estopInput; m.ioOverrides = {}; m.commissioningMode = false; m.queueHeld = true;
  weight = 0; rate = 5; coast = 0; drain = 20; scaleValid = true; scaleStable = true; wasRunning = false;
  m.equipment.set('MX', mk('MX', 'mixer', { scaleId: 'SC', capacity: 1000, cleanoutSec: 1 }));
  m.equipment.set('A1', mk('A1', 'auger', { startDelay: 0, stopDelay: 0 }));
  m.equipment.set('B1', mk('B1', 'bin', { freefall: 5, settleSec: 0.2, noProgressDelaySec: 0.5 }));
  m.equipment.set('FB', mk('FB', 'finished_bin', {}));
  m.bins = [{ id: 'B1', name: 'B1', ingredientId: 'I1', balance: 1000, capacity: 5000, unit: 'lbs', type: 'ingredient' },
            { id: 'FB', name: 'FB', ingredientId: null, balance: 0, capacity: 66000, unit: 'lbs', type: 'finished' }];
  m.ingredients = [{ id: 'I1', name: 'Corn', category: 'MAIN', unit: 'lbs' }];
  m.recipes = [{ id: 'R', name: 'Recipe', revision: 1, mixTime: 0.3, lines: [{ ingredientId: 'I1', target: 50, unit: 'lbs' }], microLines: [] }];
  m.connections = [{ from: 'B1', fromPort: 'discharge', to: 'A1', toPort: 'inlet' }, { from: 'A1', fromPort: 'outlet', to: 'MX', toPort: 'inlet' },
                   { from: 'MX', fromPort: 'discharge', to: 'FB', toPort: 'inlet' }];
  feed();
};
const queue = (extra: Record<string, unknown> = {}) => cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB', acknowledged: true, ...extra });
const run = () => cmd('SetQueueHold', undefined, { held: false });
const finished = () => until(() => m.activeBatch === null && m.queue.every((b: any) => !['IDLE', 'VALIDATING', 'READY', 'DOSING', 'MIXING', 'ROUTE_PRECHECK', 'DISCHARGING', 'CLEAROUT', 'PAUSING', 'PAUSED', 'ABORTED_HOLD'].includes(b.state)));

// ── hold + release gate ──
reset(); assert.equal(queue().accepted, true);
scan(5); assert.equal(m.activeBatch, null, 'queue comes up on hold'); assert.equal(m.queue[0].state, 'IDLE');
run(); scaleValid = false; scan(3);
assert.equal(m.activeBatch, null); assert.match(m.getSnapshot().queueControl.waiting, /mixer scale invalid/, 'no scale reading: never starts, never simulated');
scaleValid = true; scaleStable = false; scan(2); assert.match(m.getSnapshot().queueControl.waiting, /not stable/);
scaleStable = true; weight = 50; scan(2); assert.match(m.getSnapshot().queueControl.waiting, /mixer not empty/); weight = 0;
m.equipment.get('A1').mode = 'Hand'; scan(2); assert.match(m.getSnapshot().queueControl.waiting, /A1 is not in Auto/); m.equipment.get('A1').mode = 'Auto'; scan(3); weight = 0; wasRunning = false; // Hand ran the auger and added weight; start clean
m.connections = m.connections.filter((c: any) => c.from !== 'MX'); scan(2); assert.match(m.getSnapshot().queueControl.waiting, /no flow path/);
m.connections.push({ from: 'MX', fromPort: 'discharge', to: 'FB', toPort: 'inlet' });
delete m.equipment.get('MX').config.scaleId; scan(2); assert.match(m.getSnapshot().queueControl.waiting, /no scale assigned/); m.equipment.get('MX').config.scaleId = 'SC';
m.signals.push({ id: 'ESB', direction: 'DI', label: 'estop' }); m.globalConfig.estopInput = 'ESB'; m.ioInputs.ESB = false; scan(2);
assert.match(m.getSnapshot().queueControl.waiting, /E-stop/); m.ioInputs.ESB = true; delete m.globalConfig.estopInput;
scan(2); assert.equal(m.activeBatch?.id, m.queue[0].id, 'released once every check holds');

// ── a normal batch: measured weight, freefall cutoff, cleanout time, inventory ──
reset(); queue(); run();
assert.ok(until(() => m.activeBatch?.state === 'DISCHARGING'), 'reaches discharge');
const step = m.activeBatch.dosingSteps[0];
assert.ok(step.actual >= 49 && step.actual <= 52, `dosed from the scale (${step.actual})`);
let sawCleanout = false; while (m.activeBatch?.state === 'DISCHARGING') { if (weight < 10 && m.activeBatch.emptySinceMs) sawCleanout = true; scan(); }
scan(2);
assert.ok(sawCleanout, 'kept running for the cleanout time after the mixer was declared empty');
assert.equal(m.queue[0].state, 'COMPLETED'); assert.equal(m.activeBatch, null);
assert.ok(Math.abs(m.bins.find((b: any) => b.id === 'B1').balance - (1000 - step.actual)) < 0.01, 'source bin deducted once');
assert.ok(m.bins.find((b: any) => b.id === 'FB').balance > 40, 'destination credited with what was discharged');
assert.equal(loadBatchesJson().length, 0, 'finished batch leaves the database');

// ── queue size scaling, order, schedule, edit / delete / move, persistence, warnings ──
reset();
assert.equal(queue({ targetMass: 100 }).accepted, true); assert.equal(m.queue[0].dosingSteps[0].target, 100); assert.equal(m.queue[0].targetMass, 100);
assert.equal(cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'B1' }).accepted, false, 'destination must be a finished bin');
assert.equal(cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB', targetMass: -5 }).accepted, false);
assert.equal(cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB', scheduledAt: 'nonsense' }).accepted, false);
m.bins.find((b: any) => b.id === 'B1').balance = 130; // 100 queued already; a second batch of 50 is short
const r1: any = cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB' });
assert.equal(r1.accepted, false); assert.equal(r1.reason, 'Warnings'); assert.match(r1.data.warnings[0], /B1: needs 50 lbs, 30 available after the batches ahead/);
assert.equal(m.queue.length, 1, 'not queued until acknowledged');
assert.equal(queue().accepted, true); assert.deepEqual(m.queue[1].warnings.length, 1);
m.equipment.get('MX').config.capacity = 40;
const r2: any = cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB', acknowledged: false });
assert.ok(r2.data.warnings.some((w: string) => /mixer capacity is 40/.test(w)), 'capacity warning'); m.equipment.get('MX').config.capacity = 1000;
assert.deepEqual(loadBatchesJson().map(b => b.id), m.queue.map((b: any) => b.id), 'queued batches are saved');
const [q1, q2] = m.queue.map((b: any) => b.id);
assert.equal(cmd('MoveBatch', q2, { direction: 'up' }).accepted, true); assert.deepEqual(m.queue.map((b: any) => b.id), [q2, q1]);
assert.deepEqual(loadBatchesJson().sort((a: any, b: any) => a.order - b.order).map(b => b.id), [q2, q1], 'order is saved');
assert.equal(cmd('MoveBatch', q2, { direction: 'up' }).accepted, false);
m.bins.find((b: any) => b.id === 'B1').balance = 1000;
assert.equal(cmd('EditBatch', q1, { targetMass: 20 }).accepted, true); assert.equal(m.queue.find((b: any) => b.id === q1).dosingSteps[0].target, 20);
assert.equal(cmd('DeleteBatch', q2).accepted, true); assert.equal(m.queue.length, 1); assert.equal(loadBatchesJson().length, 1);
// scheduled: a future batch does not hold up the one behind it; a due one is released in order
reset(); queue({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() }); queue(); run(); scan(3);
assert.equal(m.activeBatch?.id, m.queue[1].id, 'the not-yet-due batch is skipped'); assert.equal(cmd('EditBatch', m.queue[1].id, { targetMass: 5 }).accepted, false, 'a released batch cannot be edited');
assert.equal(cmd('DeleteBatch', m.queue[1].id).accepted, false);
reset(); queue({ scheduledAt: new Date(Date.now() - 120_000).toISOString() }); run(); scan(3);
assert.equal(m.queue[0].late, true, 'released more than a minute after its time: flagged late');

// ── tolerance + freefall ──
const ff = () => m.equipment.get('B1').config.freefall;
reset(); Object.assign(m.equipment.get('B1').config, { ffAuto: true, ffStrengthPct: 100, ffMaxAdjLbs: 2 }); queue(); run(); coast = 0.5; // lands 0.5 over: in tolerance
assert.ok(until(() => m.activeBatch?.state === 'MIXING')); assert.equal(ff(), 5.5, 'auto freefall corrected an in-tolerance step'); assert.ok(m.equipment.get('B1').config.ffLog);
finished();
reset(); queue(); run(); coast = 0.5; assert.ok(until(() => m.activeBatch?.state === 'MIXING')); assert.equal(ff(), 5, 'auto off: freefall untouched'); finished();
reset(); Object.assign(m.equipment.get('B1').config, { ffAuto: true, ffStrengthPct: 100, ffMaxAdjLbs: 2 }); queue(); run(); coast = 3; // 3 over: out of tolerance
assert.ok(until(() => !!m.activeBatch?.tolHold)); const hold = m.activeBatch.tolHold;
assert.equal(hold.difference, 3); assert.equal(hold.currentFreefall, 5); assert.equal(hold.newFreefall, 8);
scan(30); assert.equal(m.activeBatch.state, 'DOSING', 'holds for the operator'); assert.equal(ff(), 5);
assert.equal(cmd('ResolveTolerance', undefined, { choice: 'update' }).accepted, true); assert.equal(ff(), 8, 'Update ignores the max-adjust cap');
assert.ok(until(() => m.activeBatch?.state === 'MIXING')); finished();
reset(); queue(); run(); coast = 3; assert.ok(until(() => !!m.activeBatch?.tolHold));
cmd('ResolveTolerance', undefined, { choice: 'ignore' }); assert.equal(ff(), 5, 'Ignore leaves freefall alone'); assert.ok(until(() => m.activeBatch?.state === 'MIXING')); finished();
assert.equal(cmd('ResolveTolerance', undefined, { choice: 'ignore' }).accepted, false);
// a paused feed is not a clean run: no calibration from it
reset(); Object.assign(m.equipment.get('B1').config, { ffAuto: true, ffStrengthPct: 100, ffMaxAdjLbs: 2 }); queue(); run(); coast = 0.5;
assert.ok(until(() => m.activeBatch?.dosingSteps[0].state === 'feeding')); cmd('PauseBatch'); assert.ok(until(() => m.activeBatch.state === 'PAUSED'));
cmd('ResumeBatch'); assert.ok(until(() => m.activeBatch?.state === 'MIXING')); assert.equal(ff(), 5, 'no freefall calibration after a pause');
finished();

// ── watchdogs ──
// no flow: the auger runs but the weight never rises
reset(); queue(); run(); rate = 0; coast = 0; scan(3); // released and feeding
assert.ok(until(() => m.activeBatch === null, 400)); assert.equal(m.queue[0].state, 'FAULTED', 'nothing dosed: closes as faulted');
assert.ok(m.faults.some((f: any) => f.active && f.code === 'E-BA-01' && /No flow from B1/.test(f.message)));
// scale lost mid-feed: feeder stops, batch pauses, resume needs the scale back
reset(); queue(); run(); assert.ok(until(() => m.activeBatch?.dosingSteps[0].state === 'feeding'));
scaleValid = false; assert.ok(until(() => ['PAUSING', 'PAUSED'].includes(m.activeBatch.state), 5)); assert.match(m.activeBatch.faultReason, /scale invalid/);
assert.ok(until(() => m.activeBatch.state === 'PAUSED')); assert.equal(cmd('ResumeBatch').accepted, false); assert.equal(cmd('ResumeBatch').reason, 'Mixer scale invalid');
scaleValid = true; feed(); let rs: any = cmd('ResumeBatch'); // the feeder coasted while the weight was lost, so the scale may now disagree: that is the ask
if (!rs.accepted) { assert.equal(rs.reason, 'Scale mismatch'); rs = cmd('ResumeBatch', undefined, { rebaseline: true }); }
assert.equal(rs.accepted, true);
// the scale disagrees with the saved progress: ask; re-baseline carries on from the current weight
cmd('PauseBatch'); assert.ok(until(() => m.activeBatch.state === 'PAUSED')); weight += 40; feed();
const rr: any = cmd('ResumeBatch'); assert.equal(rr.accepted, false); assert.equal(rr.reason, 'Scale mismatch'); assert.ok(rr.data.current - rr.data.saved >= 40);
const actualBefore = m.activeBatch.dosingSteps[0].actual;
assert.equal(cmd('ResumeBatch', undefined, { rebaseline: true }).accepted, true);
assert.equal(m.activeBatch.dosingSteps[0].clean, false); assert.ok(Math.abs(m.activeBatch.dosingSteps[0].baselineWeight - (weight - actualBefore)) < 0.01);
// e-stop pauses a running batch
reset(); queue(); run(); assert.ok(until(() => m.activeBatch?.dosingSteps[0].state === 'feeding'));
m.signals.push({ id: 'ESC', direction: 'DI', label: 'estop' }); m.globalConfig.estopInput = 'ESC'; m.ioInputs.ESC = false; scan(3);
assert.ok(['PAUSING', 'PAUSED'].includes(m.activeBatch.state)); assert.match(m.activeBatch.faultReason, /E-stop/); m.ioInputs.ESC = true; delete m.globalConfig.estopInput;

// ── discharge never completes on a timeout ──
reset(); Object.assign(m.equipment.get('MX').config, { dischargeTimeoutSec: 1, cleanoutSec: 0 }); queue(); run();
assert.ok(until(() => m.activeBatch?.state === 'DISCHARGING')); drain = 0; scan(25);
assert.equal(m.activeBatch.state, 'DISCHARGING'); assert.match(m.activeBatch.faultReason, /not empty/); assert.ok(m.faults.some((f: any) => f.code === 'W-BA-02'));
scan(30); assert.equal(m.activeBatch.state, 'DISCHARGING', 'still waiting, never completes on the timeout');
assert.equal(cmd('ExtendDischarge').accepted, true); assert.equal(m.activeBatch.faultReason, undefined);
drain = 20; finished(); assert.equal(m.queue[0].state, 'COMPLETED');

// ── abort / unload / discard and inventory ──
reset(); queue(); run(); assert.ok(until(() => m.activeBatch?.dosingSteps[0].state === 'cutoff' || m.activeBatch?.dosingSteps[0].state === 'settling'));
const dosed0 = () => m.activeBatch.dosingSteps[0].actual;
assert.equal(cmd('AbortBatch', undefined, { mode: 'unload' }).accepted, false, 'abort only while paused');
cmd('PauseBatch'); assert.ok(until(() => m.activeBatch.state === 'PAUSED')); const d = dosed0();
assert.equal(cmd('AbortBatch').accepted, false, 'a mode is required');
assert.equal(cmd('AbortBatch', undefined, { mode: 'cancel' }).accepted, false, 'cancel needs the acknowledgement');
queue(); run(); const fbBefore = m.bins.find((b: any) => b.id === 'FB').balance;
assert.equal(cmd('AbortBatch', undefined, { mode: 'unload' }).accepted, true);
assert.ok(Math.abs(m.bins.find((b: any) => b.id === 'B1').balance - (1000 - d)) < 0.01, 'dosed material deducted on abort');
scan(10); assert.equal(m.queue[1].state, 'IDLE', 'queue does not move while the mixer unloads');
assert.ok(until(() => m.queue[0].state === 'ABORTED')); assert.ok(m.bins.find((b: any) => b.id === 'FB').balance > fbBefore + 10, 'unloaded weight credited to the destination');
assert.ok(Math.abs(m.bins.find((b: any) => b.id === 'B1').balance - (1000 - d)) < 0.01, 'not deducted twice');
// mix + unload mixes first
reset(); queue(); run(); assert.ok(until(() => m.activeBatch?.dosingSteps[0].state === 'cutoff' || m.activeBatch?.dosingSteps[0].state === 'settling'));
cmd('PauseBatch'); assert.ok(until(() => m.activeBatch.state === 'PAUSED'));
assert.equal(cmd('AbortBatch', undefined, { mode: 'mixUnload' }).accepted, true); assert.equal(m.activeBatch.state, 'MIXING');
assert.ok(until(() => m.activeBatch === null && m.queue[0].state === 'ABORTED'));
// cancel (acknowledged) closes at once, material stays in the mixer
reset(); queue(); run(); assert.ok(until(() => m.activeBatch?.dosingSteps[0].state === 'feeding')); scan(3); cmd('PauseBatch'); assert.ok(until(() => m.activeBatch.state === 'PAUSED'));
const d2 = dosed0(); assert.equal(cmd('AbortBatch', undefined, { mode: 'cancel', acknowledged: true }).accepted, true); assert.equal(m.activeBatch, null); assert.equal(m.queue[0].state, 'ABORTED');
assert.ok(Math.abs(m.bins.find((b: any) => b.id === 'B1').balance - (1000 - d2)) < 0.01);
// a failure with material in the mixer still holds it for Unload / Discard
reset(); queue(); run(); assert.ok(until(() => m.activeBatch?.dosingSteps[0].state === 'feeding')); scan(3); (m as any).batchFault(m.activeBatch, 'test'); assert.equal(m.activeBatch.state, 'ABORTED_HOLD');
assert.equal(cmd('DiscardBatch').accepted, false, 'cannot discard while the scale reads material'); assert.equal(cmd('UnloadBatch', undefined, { destination: 'B1' }).accepted, false, 'destination must be a finished bin');
weight = 0; scan(2); assert.equal(cmd('DiscardBatch').accepted, true); assert.equal(m.activeBatch, null);
// aborting before anything was dosed closes at once
reset(); queue(); run(); scan(2); cmd('PauseBatch'); assert.ok(until(() => m.activeBatch.state === 'PAUSED')); assert.equal(cmd('AbortBatch', undefined, { mode: 'unload' }).accepted, true); assert.equal(m.activeBatch, null); assert.equal(m.queue[0].state, 'ABORTED');

// ── Not tracked bins: only a bin that discharges only to a hammermill ──
reset(); m.equipment.set('HM', mk('HM', 'hammermill', {})); m.equipment.set('A2', mk('A2', 'auger', {})); m.equipment.set('B2', mk('B2', 'bin', {}));
m.bins.push({ id: 'B2', name: 'B2', ingredientId: 'I1', balance: 10, capacity: 500, unit: 'lbs', type: 'ingredient' });
assert.equal(cmd('UpdateEquipment', 'B1', { config: { notTracked: true } }).accepted, false, 'B1 feeds a mixer');
assert.equal(cmd('UpdateEquipment', 'B2', { config: { notTracked: true } }).accepted, false, 'B2 has no discharge');
m.connections.push({ from: 'B2', fromPort: 'discharge', to: 'A2', toPort: 'inlet' }, { from: 'A2', fromPort: 'outlet', to: 'HM', toPort: 'feed' });
assert.equal(cmd('UpdateEquipment', 'B2', { config: { notTracked: true } }).accepted, true);
assert.equal(m.getSnapshot().bins.find((b: any) => b.id === 'B2').hidden, true); assert.equal(m.getSnapshot().bins.find((b: any) => b.id === 'B1').hidden, undefined);
assert.equal(m.findBinForIngredient('I1').id, 'B1', 'a hidden bin is never a batching source'); // B1 is the only tracked bin with I1
assert.equal(cmd('AddConnection', undefined, { from: 'B2', fromPort: 'discharge', to: 'MX', toPort: 'inlet' }).accepted, true);
assert.equal(m.equipment.get('B2').config.notTracked, undefined, 'a connection that breaks the rule clears the flag');
assert.ok(m.faults.some((f: any) => f.code === 'W-BN-01'));

console.log('batch checks passed');
process.exit(0);
