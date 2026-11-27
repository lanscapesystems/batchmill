// Behaviour check for fault set / clear / horn, modelled on the Omron FaultReset + horn logic.
// Run: MILL_DATA_DIR=<tmp dir> npm run check
import './testScan.js';
import assert from 'node:assert/strict';
import { Mill } from './mill.js';
import { loadBatchesJson, clearActiveBatch } from './db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const m: any = new Mill();
const mk = (id: string, type: string, config: Record<string, unknown>, mode = 'Auto') => ({
  id, name: id, equipmentType: type, class: type, mode, status: 'not_running', request: false, runCmd: false,
  feedback: false, config, faultTimerMs: 0, positionTimerMs: 0, startTimerMs: 0, stopTimerMs: 0,
});
const cmd = (action: string, targetId?: string, parameters?: Record<string, unknown>) =>
  m.processCommand({ requestId: 'x', action, targetId, parameters });
let weight = 0, scaleValid = true, scaleStable = true;
const feed = () => { m.scales.SC = { weight, stable: scaleStable, valid: scaleValid, timestamp: Date.now() }; };
const scan = (n = 1) => { for (let i = 0; i < n; i++) { feed(); m.scan(); } };
const active = (code: string) => m.faults.some((f: any) => f.code === code && f.active);
const reset = () => {
  for (const b of loadBatchesJson()) clearActiveBatch(b.id);
  m.equipment.clear(); m.bins = []; m.connections = []; m.queue = []; m.activeBatch = null; m.scales = {}; m.faults = [];
  delete m.globalConfig.estopInput; delete m.globalConfig.faultResetInput; m.ioOverrides = {}; m.commissioningMode = false; m.queueHeld = true;
  weight = 0; scaleValid = true; scaleStable = true;
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
const queue = () => cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB', acknowledged: true });
const run = () => cmd('SetQueueHold', undefined, { held: false });

// ── ResetFaults clears latched faults and trip latches; acknowledges; leaves level faults alone ──
reset();
const aug: any = mk('A9', 'auger', { runOutput: 'A9_OUT', runConfirmAux: 'A9_AUX' }, 'Hand'); m.equipment.set('A9', aug);
m.ioInputs.A9_AUX = false; scan(10);
assert.equal(aug.status, 'fault'); assert.ok(active('E-MT-01') || active('E-GT-03'), 'starter feedback fault raised');
m.signals.push({ id: 'ESB', direction: 'DI', label: 'estop' }); m.globalConfig.estopInput = 'ESB'; m.ioInputs.ESB = false; scan(2);
assert.ok(active('E-ES-01'));
const r: any = cmd('ResetFaults');
assert.equal(r.accepted, true); assert.match(r.reason, /1 cleared, 1 still present/);
assert.equal(aug.status, 'not_running', 'trip latch released'); assert.ok(active('E-ES-01'), 'E-stop fault follows the circuit, not the reset');
assert.ok(m.faults.filter((f: any) => !f.active).every((f: any) => f.acknowledgedAt && f.clearedAt), 'cleared faults are acknowledged');
m.ioInputs.ESB = true; scan(2); assert.ok(!active('E-ES-01'), 'E-stop fault clears itself when the circuit is back');
cmd('SetEquipmentMode', 'A9', { mode: 'Off' });

// a cause that is still there raises a fresh fault after reset
cmd('SetEquipmentMode', 'A9', { mode: 'Hand' }); scan(10); assert.equal(aug.status, 'fault');
cmd('ResetFaults'); cmd('SetEquipmentMode', 'A9', { mode: 'Hand' }); scan(10);
assert.equal(aug.status, 'fault', 'no feedback: faults again'); assert.ok(m.faults.filter((f: any) => f.active).length >= 1);
cmd('SetEquipmentMode', 'A9', { mode: 'Off' }); cmd('ResetFaults');

// physical reset input: rising edge only
reset(); m.signals.push({ id: 'FRB', direction: 'DI', label: 'reset' }); m.globalConfig.faultResetInput = 'FRB'; m.ioInputs.FRB = false;
m.equipment.get('A1').mode = 'Hand'; m.ioInputs.A1_AUX = false;
(m as any).raiseFault('A1', 'WARNING', 'test fault', 'W-TEST-01'); assert.ok(active('W-TEST-01'));
m.ioInputs.FRB = true; scan(1); assert.ok(!active('W-TEST-01'), 'reset input clears it');
(m as any).raiseFault('A1', 'WARNING', 'again', 'W-TEST-01'); scan(3); assert.ok(active('W-TEST-01'), 'held input does not clear again'); m.ioInputs.FRB = false;

// ── horn: a new fault re-arms a silenced horn; reset ends it ──
reset(); Object.assign(m.globalConfig, { hornAutoSilenceSec: 60, hornOnSec: 5, hornOffSec: 0 }); // steady horn, whatever an earlier check left in the shared config
m.globalConfig.hornOutput = 'HORN'; m.signals.push({ id: 'HORN', direction: 'DO', label: 'horn' });
(m as any).raiseFault('A1', 'WARNING', 'one', 'W-TEST-01'); scan(2); assert.equal(m.getSnapshot().horn.on, true);
cmd('SilenceHorn'); scan(2); assert.equal(m.getSnapshot().horn.silenced, true); assert.equal(m.getSnapshot().horn.on, false);
(m as any).raiseFault('A1', 'WARNING', 'two', 'W-TEST-02'); scan(1); assert.equal(m.getSnapshot().horn.silenced, false, 'new fault re-arms');
cmd('ResetFaults'); scan(2); assert.equal(m.getSnapshot().horn.on, false, 'no active faults: no horn');

// ── scale fault: invalid past the delay latches; reset while still invalid re-raises; valid + reset clears ──
reset(); scaleValid = false; scan(15); assert.ok(!active('E-SC-01'), 'inside the delay: no fault');
scan(10); assert.ok(active('E-SC-01'), 'invalid past the delay');
cmd('ResetFaults'); scan(1); assert.ok(active('E-SC-01'), 'still invalid: raised again');
scaleValid = true; scan(2); assert.ok(active('E-SC-01'), 'latched until reset'); cmd('ResetFaults'); scan(2); assert.ok(!active('E-SC-01'));
delete m.scales.SC; m.equipment.get('MX').config.scaleId = 'NOPE'; scan(40); assert.ok(!active('E-SC-01'), 'no reading at all is not a fault');

// ── zero tolerance at batch start: either side, fault + wait ──
reset(); queue(); run(); weight = 50; scan(3);
assert.ok(active('E-BA-05'), 'mixer off zero (above)'); assert.match(m.getSnapshot().queueControl.waiting, /mixer not empty/); assert.equal(m.activeBatch, null);
cmd('ResetFaults'); weight = -20; scan(3);
assert.ok(active('E-BA-05'), 'mixer off zero (below)'); assert.match(m.getSnapshot().queueControl.waiting, /zero it/); assert.equal(m.activeBatch, null);
weight = 0; scan(3); assert.equal(m.activeBatch?.id, m.queue[0].id, 'starts by itself once the scale is back at zero');
cmd('ResetFaults');

// ── mixer over capacity while dosing: stop the feeder, pause, fault; Reset never resumes ──
reset(); m.equipment.get('MX').config.capacity = 100; queue(); run();
for (let i = 0; i < 200 && m.activeBatch?.dosingSteps?.[0]?.state !== 'feeding'; i++) scan();
assert.equal(m.activeBatch.dosingSteps[0].state, 'feeding'); weight = 150; scan(2);
assert.ok(active('E-BA-04')); assert.ok(['PAUSING', 'PAUSED'].includes(m.activeBatch.state)); assert.match(m.activeBatch.faultReason, /over capacity/);
scan(5); assert.equal(m.activeBatch.state, 'PAUSED');
cmd('ResetFaults'); scan(5); assert.equal(m.activeBatch.state, 'PAUSED', 'reset does not resume the batch');
assert.ok(!active('E-BA-04'));

console.log('fault checks passed');
