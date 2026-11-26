// Behaviour check for the Phase 1 motor-protection logic. Run: MILL_DATA_DIR=<tmp dir> npm run check
import './testScan.js';
import assert from 'node:assert/strict';
import { Mill } from './mill.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const m: any = new Mill();
const mk = (id: string, type: string, config: Record<string, unknown>) => ({
  id, name: id, equipmentType: type, class: type, mode: 'Off', status: 'not_running', request: false, runCmd: false,
  feedback: false, config, faultTimerMs: 0, positionTimerMs: 0, startTimerMs: 0, stopTimerMs: 0,
});
const cmd = (action: string, targetId?: string, parameters?: Record<string, unknown>) =>
  m.processCommand({ requestId: 'x', action, targetId, parameters });
const scan = (n: number) => { for (let i = 0; i < n; i++) m.scan(); };

const a: any = mk('A-1', 'auger', { runOutput: 'X_OUT', runConfirmAux: 'X_AUX', starterFaultDelay: 0.3, startDelay: 0, stopDelay: 0 });
const hm: any = mk('HM-1', 'hammermill', { autoEnable: true });
m.equipment.set('A-1', a); m.equipment.set('HM-1', hm);
m.ioInputs.X_AUX = false;

// per-motor fault delay (0.3 s) beats the global one (0.5 s); a trip cancels Hand and survives a mode change
cmd('SetEquipmentMode', 'A-1', { mode: 'Hand' }); scan(4);
assert.equal(a.status, 'fault'); assert.equal(a.mode, 'Off');
cmd('SetEquipmentMode', 'A-1', { mode: 'Hand' }); scan(2);
assert.equal(a.status, 'fault'); assert.equal(a.runCmd, false);
cmd('ResetEquipmentFault', 'A-1'); scan(2);
assert.equal(a.status, 'not_running'); assert.equal(a.runCmd, false);

// run hours accrue only while running, and reset on command
m.ioInputs.X_AUX = true; cmd('SetEquipmentMode', 'A-1', { mode: 'Hand' }); scan(10);
assert.equal(a.status, 'running'); assert.ok(a.runSeconds > 0.5);
cmd('ResetRunHours', 'A-1'); assert.equal(a.runSeconds, 0); assert.ok(a.runSecondsTotal > 0.5);

// enable is separate from HOA; e-stop disables the mill but leaves its HOA mode, and release does not re-enable
cmd('SetHammermillEnabled', 'HM-1', { enabled: true }); cmd('SetEquipmentMode', 'HM-1', { mode: 'Auto' });
assert.equal(hm.enabled, true); assert.equal(hm.mode, 'Auto');
m.globalConfig.estopInput = 'ES'; m.ioInputs.ES = false; scan(1);
assert.equal(a.runCmd, false); assert.equal(a.mode, 'Off');
assert.equal(hm.enabled, false); assert.equal(hm.status, 'disabled'); assert.equal(hm.mode, 'Auto');
assert.equal(cmd('SetHammermillEnabled', 'HM-1', { enabled: true }).accepted, false);
m.ioInputs.ES = true; scan(1);
assert.equal(hm.enabled, false);
assert.equal(cmd('SetHammermillEnabled', 'HM-1', { enabled: true }).accepted, true);
console.log('phase1 checks passed');
process.exit(0);
