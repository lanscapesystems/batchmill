// Behaviour check for micro dosing: micros dose onto their own conveyor scale while the majors dose into the mixer; the belt
// runs into the mixer only after both are finished. Run: MILL_DATA_DIR=<tmp dir> npm run check
import './testScan.js';
import assert from 'node:assert/strict';
import { Mill } from './mill.js';
import { loadBatchesJson, clearActiveBatch } from './db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fixture: B1 -> A1 -> MX (majors, mixer scale SC); B2 -> A2 -> MC (micros conveyor, belt scale SM) -> MX; MX -> FB.
const m: any = new Mill();
const mk = (id: string, type: string, config: Record<string, unknown>, mode = 'Auto') => ({
  id, name: id, equipmentType: type, class: type, mode, status: 'not_running', request: false, runCmd: false,
  feedback: false, config, faultTimerMs: 0, positionTimerMs: 0, startTimerMs: 0, stopTimerMs: 0,
});
const cmd = (action: string, targetId?: string, parameters?: Record<string, unknown>) =>
  m.processCommand({ requestId: 'x', action, targetId, parameters });
let w1 = 0, w2 = 0, microCoast = 0, beltValid = true, wasA2 = false, mcRanEarly = false, mcRan = false;
const scan = (n = 1) => {
  for (let i = 0; i < n; i++) {
    m.scales.SC = { weight: w1, stable: true, valid: true, timestamp: Date.now() };
    m.scales.SM = { weight: w2, stable: true, valid: beltValid, timestamp: Date.now() };
    m.scan();
    const a1 = m.equipment.get('A1'), a2 = m.equipment.get('A2'), mc = m.equipment.get('MC');
    if (a1.runCmd) w1 += 5;
    if (a2.runCmd) w2 += 1;
    if (wasA2 && !a2.runCmd) w2 += microCoast;
    wasA2 = a2.runCmd;
    if (mc.runCmd) {
      mcRan = true;
      const b = m.activeBatch;
      if (b && b.state === 'DOSING' && !b.unloading && b.dosingSteps.some((s: any) => s.state !== 'complete')) mcRanEarly = true;
      const mv = Math.min(w2, 4); w2 -= mv; w1 += mv; // the belt empties into the mixer
    }
    if (m.activeBatch?.state === 'DISCHARGING') w1 = Math.max(0, w1 - 20);
  }
};
const until = (pred: () => boolean, max = 2000) => { for (let i = 0; i < max && !pred(); i++) scan(); return pred(); };
const reset = (recipe: 'both' | 'micro' | 'major' = 'both') => {
  for (const b of loadBatchesJson()) clearActiveBatch(b.id);
  m.equipment.clear(); m.bins = []; m.connections = []; m.queue = []; m.activeBatch = null; m.scales = {}; m.faults = [];
  m.ioOverrides = {}; m.commissioningMode = false; m.queueHeld = true; delete m.globalConfig.estopInput;
  w1 = 0; w2 = 0; microCoast = 0; beltValid = true; wasA2 = false; mcRanEarly = false; mcRan = false;
  const bin = { freefall: 5, settleSec: 0.2, noProgressDelaySec: 0.5, toleranceLbs: 1.5 };
  m.equipment.set('MX', mk('MX', 'mixer', { scaleId: 'SC', capacity: 1000, cleanoutSec: 1 }));
  m.equipment.set('A1', mk('A1', 'auger', { startDelay: 0, stopDelay: 0 }));
  m.equipment.set('A2', mk('A2', 'auger', { startDelay: 0, stopDelay: 0 }));
  m.equipment.set('MC', mk('MC', 'micro_drag', { scaleId: 'SM', startDelay: 0, stopDelay: 0, zeroToleranceLbs: 2, unloadMinSec: 1, failedToEmptySec: 30, capacityLbs: 100 }));
  m.equipment.set('B1', mk('B1', 'bin', bin));
  m.equipment.set('B2', mk('B2', 'bin', { ...bin, freefall: 1 }));
  m.equipment.set('FB', mk('FB', 'finished_bin', {}));
  m.bins = [{ id: 'B1', name: 'B1', ingredientId: 'I1', balance: 1000, capacity: 5000, unit: 'lbs', type: 'ingredient' },
            { id: 'B2', name: 'B2', ingredientId: 'I2', balance: 500, capacity: 5000, unit: 'lbs', type: 'ingredient' },
            { id: 'FB', name: 'FB', ingredientId: null, balance: 0, capacity: 66000, unit: 'lbs', type: 'finished' }];
  m.ingredients = [{ id: 'I1', name: 'Corn', category: 'MAIN', unit: 'lbs' }, { id: 'I2', name: 'Vitamin', category: 'MICRO', unit: 'lbs' }];
  m.recipes = [{ id: 'R', name: 'Recipe', revision: 1, mixTime: 0.3,
    lines: recipe === 'micro' ? [] : [{ ingredientId: 'I1', target: 50, unit: 'lbs' }],
    microLines: recipe === 'major' ? [] : [{ ingredientId: 'I2', target: 10, unit: 'lbs' }] }];
  m.connections = [{ from: 'B1', fromPort: 'discharge', to: 'A1', toPort: 'inlet' }, { from: 'A1', fromPort: 'outlet', to: 'MX', toPort: 'inlet' },
                   { from: 'B2', fromPort: 'discharge', to: 'A2', toPort: 'inlet' }, { from: 'A2', fromPort: 'outlet', to: 'MC', toPort: 'feed' },
                   { from: 'MC', fromPort: 'discharge', to: 'MX', toPort: 'inlet' }, { from: 'MX', fromPort: 'discharge', to: 'FB', toPort: 'inlet' }];
};
const queue = () => cmd('QueueBatch', undefined, { recipeId: 'R', destination: 'FB', acknowledged: true });
const run = () => cmd('SetQueueHold', undefined, { held: false });
const done = () => until(() => m.activeBatch === null && ['COMPLETED', 'ABORTED', 'FAULTED'].includes(m.queue[0].state));
const step = (i: number) => m.activeBatch?.dosingSteps[i] ?? { state: 'none', actual: 0 };

// ── micro steps are tagged and ordered: majors first, micros after, the micro knows its conveyor ──
reset(); queue();
assert.deepEqual(m.queue[0].dosingSteps.map((s: any) => [s.ingredientId, !!s.micro, s.conveyorId]), [['I1', false, undefined], ['I2', true, 'MC']]);

// a bin whose auger feeds the micros conveyor shows up as a micro bin (no separate type to configure)
reset(); const snapBins = m.getSnapshot().bins; assert.equal(snapBins.find((b: any) => b.id === 'B2').type, 'micro_hopper'); assert.equal(snapBins.find((b: any) => b.id === 'B1').type, 'ingredient');
assert.equal(m.bins.find((b: any) => b.id === 'B2').type, 'ingredient', 'the stored type is untouched');

// ── both tracks dose at once; the belt waits for both, then runs into the mixer ──
reset(); queue(); run();
let both = false;
assert.ok(until(() => { const a1 = m.equipment.get('A1'), a2 = m.equipment.get('A2'); if (a1.runCmd && a2.runCmd) both = true; return m.activeBatch?.state === 'MIXING' || m.activeBatch?.state === 'DISCHARGING'; }));
assert.ok(both, 'micro auger ran while the major auger was still feeding');
assert.equal(mcRanEarly, false, 'the belt never ran before every major and micro was finished');
assert.ok(mcRan, 'the belt ran into the mixer');
assert.ok(w2 < 2, 'the belt is empty before mixing starts');
assert.ok(done(), 'batch completes');
assert.equal(m.queue[0].state, 'COMPLETED');
assert.ok(Math.abs(m.bins.find((b: any) => b.id === 'B2').balance - (500 - 10)) < 1.6, 'micro bin deducted');
assert.ok(m.bins.find((b: any) => b.id === 'B1').balance < 960, 'major bin deducted');
assert.ok(m.bins.find((b: any) => b.id === 'FB').balance > 55, 'destination got majors and micros');

// ── no micros: the belt never runs; micros only: unload as soon as they are done ──
reset('major'); queue(); run(); assert.ok(done()); assert.equal(mcRan, false, 'a recipe with no micros never runs the belt');
reset('micro'); queue(); run(); assert.ok(done()); assert.equal(mcRan, true); assert.equal(m.queue[0].state, 'COMPLETED');

// ── release gate ──
reset(); queue(); run(); w2 = 5; scan(3);
assert.match(m.getSnapshot().queueControl.waiting, /micros conveyor not empty/); w2 = 0;
beltValid = false; scan(3); assert.match(m.getSnapshot().queueControl.waiting, /micros scale invalid/); beltValid = true;
m.equipment.get('MC').mode = 'Hand'; scan(2); assert.match(m.getSnapshot().queueControl.waiting, /MC is not in Auto/); m.equipment.get('MC').mode = 'Auto';
delete m.equipment.get('MC').config.scaleId; scan(2); assert.match(m.getSnapshot().queueControl.waiting, /MC has no scale assigned/); m.equipment.get('MC').config.scaleId = 'SM';
const keep = m.connections; m.connections = keep.filter((c: any) => c.to !== 'MC'); scan(2);
assert.match(m.getSnapshot().queueControl.waiting, /a micro but A2 does not feed a micros conveyor/); m.connections = keep;
m.queue[0].dosingSteps[0].micro = undefined; m.queue[0].dosingSteps[1].micro = undefined; scan(2);
assert.match(m.getSnapshot().queueControl.waiting, /in the major list but A2 feeds the micros conveyor/);

// ── pause stops both tracks; Resume restarts both ──
reset(); queue(); run();
assert.ok(until(() => m.equipment.get('A1').runCmd && m.equipment.get('A2').runCmd));
assert.equal(cmd('PauseBatch').accepted, true); assert.ok(until(() => m.activeBatch?.state === 'PAUSED'));
assert.equal(m.equipment.get('A1').runCmd, false); assert.equal(m.equipment.get('A2').runCmd, false);
assert.equal(cmd('ResumeBatch').accepted, true);
assert.ok(until(() => m.equipment.get('A1').runCmd || m.equipment.get('A2').runCmd), 'both feeders come back');
assert.ok(done()); assert.equal(m.queue[0].state, 'COMPLETED');

// ── micros scale lost mid-feed pauses the batch and stops the major feeder too ──
reset(); queue(); run();
assert.ok(until(() => step(1).state === 'feeding'));
beltValid = false; scan(3);
assert.equal(m.activeBatch.state === 'PAUSING' || m.activeBatch.state === 'PAUSED', true); assert.match(m.activeBatch.faultReason, /Micros scale invalid/);
assert.ok(until(() => m.activeBatch?.state === 'PAUSED')); assert.equal(m.equipment.get('A1').runCmd, false);
assert.equal(cmd('ResumeBatch').accepted, false, 'cannot resume without the micros scale'); beltValid = true; scan(); assert.equal(cmd('ResumeBatch').accepted, true);

// ── a tolerance hold on the micro track does not stop the majors; each is resolved on its own ──
reset(); microCoast = 6; queue(); run();
assert.ok(until(() => m.activeBatch?.tolHold !== undefined && m.activeBatch !== null), 'micro overshoots into the tolerance hold');
assert.equal(m.activeBatch.tolHold.stepIndex, 1);
assert.ok(until(() => step(0).state === 'complete'), 'the major track carried on while the micro waited');
assert.equal(step(1).state, 'hold'); assert.equal(m.activeBatch.state, 'DOSING'); assert.equal(mcRan, false, 'belt waits for the held micro');
assert.equal(cmd('ResolveTolerance', undefined, { choice: 'ignore' }).accepted, true);
assert.ok(done()); assert.equal(m.queue[0].state, 'COMPLETED');

// ── over capacity on the belt stops the feeders ──
reset(); queue(); run(); m.equipment.get('MC').config.capacityLbs = 3;
assert.ok(until(() => m.activeBatch?.state === 'PAUSING' || m.activeBatch?.state === 'PAUSED'));
assert.match(m.activeBatch.faultReason, /over capacity/); assert.ok(m.faults.some((f: any) => f.code === 'E-BA-02' && f.active));

// ── a dosing problem on a micro step: Accept completes that micro step and the batch goes on ──
reset(); queue(); run();
assert.ok(until(() => step(1).state === 'feeding'));
m.equipment.get('B2').config.failedToAchieveSec = 0.3; // total feed time for the step
assert.ok(until(() => !!m.activeBatch?.dosingError), 'failed to achieve weight');
assert.equal(m.activeBatch.dosingError.stepIndex, 1);
assert.ok(until(() => m.activeBatch?.state === 'PAUSED'));
assert.equal(cmd('AcceptDosing').accepted, true);
assert.ok(done()); assert.equal(m.queue[0].state, 'COMPLETED');

// ── abort with micros on the belt: the belt is emptied into the mixer before the unload ──
reset(); queue(); run();
assert.ok(until(() => step(1).actual > 4 && step(0).actual > 4));
cmd('PauseBatch'); assert.ok(until(() => m.activeBatch?.state === 'PAUSED')); const mixerBefore = w1;
assert.equal(cmd('AbortBatch', undefined, { mode: 'unload' }).accepted, true);
assert.equal(m.activeBatch.state, 'DOSING'); assert.equal(m.activeBatch.unloading, true);
mcRan = false;
assert.ok(until(() => m.activeBatch?.state === 'ROUTE_PRECHECK' || m.activeBatch?.state === 'DISCHARGING'), 'belt unloaded, then the mixer unload');
assert.ok(mcRan, 'the belt ran'); assert.ok(w1 > mixerBefore || m.activeBatch.state === 'DISCHARGING');
assert.ok(done()); assert.equal(m.queue[0].state, 'ABORTED');

// ── shared VFD: one drive for several augers; the drive's output is the OR of the running augers; speed comes from the drive ──
reset();
m.sharedVfds = [{ id: 'VFD1', name: 'Micros VFD', runOutput: 'V_RUN', auxInput: 'V_AUX', analogSpeedOutput: 'V_AO', startDelay: 0.2, speedMinPct: 0, speedMaxPct: 100, speedMinLimit: 0, speedMaxLimit: 100 }];
m.equipment.get('A2').config.sharedVfdId = 'VFD1'; m.equipment.get('A2').config.runOutput = 'A2_RUN';
m.equipment.set('A3', mk('A3', 'auger', { startDelay: 0, stopDelay: 0, sharedVfdId: 'VFD1', runOutput: 'A3_RUN' }));
m.ioInputs.V_AUX = true;
m.equipment.get('A2').mode = 'Hand'; cmd('SetEquipmentSpeed', 'A2', { speed: 40 }); scan(6);
assert.equal(m.ioOutputs.V_RUN, true, 'VFD run output follows the auger on it'); assert.equal(m.ioOutputs.V_AO, 40, 'speed output is the drive\'s');
m.equipment.get('A2').mode = 'Off'; scan(3); assert.equal(m.ioOutputs.V_RUN, false, 'drops when no auger on it is running');
m.equipment.get('A2').mode = 'Hand'; m.ioInputs.V_AUX = false; scan(15);
assert.equal(m.equipment.get('A2').status, 'fault', 'the running auger faults on the VFD feedback timeout');
assert.notEqual(m.equipment.get('A3').status, 'fault', 'an idle auger on the same VFD does not');

// ── shared VFD commands: create / edit, I/O not shared with anything else, auger's own VFD I/O cleared, delete refused while in use ──
reset(); m.sharedVfds = [];
m.equipment.get('A1').config.analogSpeedOutput = 'OLD_AO'; m.equipment.get('A1').config.vfdRunOutput = 'OLD_RUN'; m.equipment.get('A1').config.masterVfd = true;
const cfgV = (p: Record<string, unknown>) => cmd('ConfigureSharedVfd', undefined, p);
assert.equal(cfgV({ name: 'Micros VFD', runOutput: 'V_RUN', auxInput: 'V_AUX', analogSpeedOutput: 'V_AO' }).accepted, true);
assert.equal(m.sharedVfds.length, 1); assert.equal(m.sharedVfds[0].startDelay, 0.7, 'PLC default start delay');
const vid = m.sharedVfds[0].id;
assert.match((cfgV({ name: 'Other', runOutput: 'V_RUN' }) as any).reason, /already used by Micros VFD/);
assert.match((cfgV({ name: 'Other', runOutput: 'OLD_RUN' }) as any).reason, /already used by A1/);
assert.equal(cfgV({ id: vid, name: 'Micros VFD', runOutput: 'V_RUN', auxInput: 'V_AUX', analogSpeedOutput: 'V_AO', startDelay: 1 }).accepted, true, 'editing keeps its own points');
assert.equal(m.sharedVfds[0].startDelay, 1);
assert.equal(cmd('UpdateEquipment', 'A1', { config: { sharedVfdId: 'NOPE' } }).accepted, false);
assert.equal(cmd('UpdateEquipment', 'A1', { config: { sharedVfdId: vid } }).accepted, true);
assert.equal(m.equipment.get('A1').config.analogSpeedOutput, undefined, 'the auger no longer has its own speed output');
assert.equal(m.equipment.get('A1').config.vfdRunOutput, undefined);
assert.equal(cmd('RemoveSharedVfd', vid).accepted, false, 'still used by A1');
cmd('UpdateEquipment', 'A1', { config: { sharedVfdId: '' } }); assert.equal(m.equipment.get('A1').config.sharedVfdId, undefined);
assert.equal(cmd('RemoveSharedVfd', vid).accepted, true); assert.equal(m.sharedVfds.length, 0);

console.log('micro checks passed');
process.exit(0);
