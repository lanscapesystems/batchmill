// Behaviour check for the live queue hold / run. Run: MILL_DATA_DIR=<tmp dir> npm run check
import assert from 'node:assert/strict';
import { Mill } from './mill.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const m: any = new Mill();
const cmd = (action: string, targetId?: string, parameters?: Record<string, unknown>) =>
  m.processCommand({ requestId: 'x', action, targetId, parameters });
const scan = (n: number) => { for (let i = 0; i < n; i++) m.scan(); };
const queued = (id: string) => ({ id, recipeId: 'R', recipeName: 'R', targetMass: 100, destination: 'FB-1', state: 'IDLE', startedAt: '', dosingIndex: 0, dosingSteps: [], mixTimeRemainingMs: 0, mixTimeTotalMs: 0, dischargeStartTime: 0 });

// the suites share one data dir, so start from a clean slate
delete m.globalConfig.estopInput; m.ioOverrides = {}; m.commissioningMode = false;
m.activeBatch = null; m.queue = [queued('Q1'), queued('Q2')];

// comes up on hold: nothing starts by itself
assert.equal(m.getSnapshot().queueControl.held, true);
scan(5); assert.equal(m.activeBatch, null); assert.equal(m.queue[0].state, 'IDLE');

// bad parameter is rejected
assert.equal(cmd('SetQueueHold', undefined, { held: 'no' }).accepted, false);

// run: the head batch is released, the second waits behind it
assert.equal(cmd('SetQueueHold', undefined, { held: false }).accepted, true);
scan(1); assert.equal(m.activeBatch?.id, 'Q1'); assert.equal(m.queue[1].state, 'IDLE');

// hold never interrupts the active batch, and stops the next one being released
cmd('SetQueueHold', undefined, { held: true });
m.activeBatch.state = 'COMPLETED'; m.activeBatch = null; scan(3);
assert.equal(m.activeBatch, null); assert.equal(m.queue[1].state, 'IDLE');

// e-stop holds the release with a reason; the batch starts once it clears
m.signals.push({ id: 'ESQ', direction: 'DI', label: 'estop' }); m.globalConfig.estopInput = 'ESQ'; m.ioInputs.ESQ = false;
cmd('SetQueueHold', undefined, { held: false }); scan(2);
assert.equal(m.activeBatch, null); assert.equal(m.getSnapshot().queueControl.waiting, 'E-stop active');
m.ioInputs.ESQ = true; scan(2); assert.equal(m.activeBatch?.id, 'Q2');
console.log('queue checks passed');
process.exit(0);
