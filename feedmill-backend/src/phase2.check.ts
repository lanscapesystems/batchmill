// Behaviour check for Phase 2 load monitoring and the load PID. Run: MILL_DATA_DIR=<tmp dir> npm run check
import assert from 'node:assert/strict';
import { Mill } from './mill.js';
import { loadFaults } from './db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const m: any = new Mill();
const mk = (id: string, type: string, config: Record<string, unknown>) => ({
  id, name: id, equipmentType: type, class: type, mode: 'Hand', status: 'not_running', request: false, runCmd: false,
  feedback: false, config, faultTimerMs: 0, positionTimerMs: 0, startTimerMs: 0, stopTimerMs: 0,
});
const cmd = (action: string, targetId?: string, parameters?: Record<string, unknown>) =>
  m.processCommand({ requestId: 'x', action, targetId, parameters });
const scan = (n: number) => { for (let i = 0; i < n; i++) m.scan(); };

const hm: any = mk('HM-1', 'hammermill', {
  runOutput: 'HM_OUT', runConfirmAux: 'HM_AUX', analogLoadInput: 'HM_AI', minAmps: 0, maxAmps: 100, loadAvgSamples: 1,
  loadLimitDelay: 0.3, hiPauseAmps: 80, loadControlFeeder: 'A-1', loadSetpointAmps: 40, loadKp: 0.5, loadTiSec: 5,
});
const a: any = mk('A-1', 'auger', { runOutput: 'A_OUT', runConfirmAux: 'A_AUX', analogSpeedOutput: 'A_AO' });
a.speed = 50;
m.equipment.set('HM-1', hm); m.equipment.set('A-1', a);
m.ioInputs.HM_AUX = true; m.ioInputs.A_AUX = true;
m.enableHammermill(hm);

// scaling: 0% = minAmps, 100% = maxAmps; no limit trips at a normal load
m.ioInputs.HM_AI = 50; scan(10);
assert.equal(hm.status, 'running'); assert.equal(hm.loadAmps, 50);

// PID: plant amps = 0.6 * feeder speed; setpoint 40 A -> speed settles near 66.7 %. Bumpless: starts from 50 %.
cmd('SetEquipmentMode', 'A-1', { mode: 'Hand' });
cmd('SetLoadControl', 'HM-1', { auto: true });
for (let i = 0; i < 1200; i++) { m.ioInputs.HM_AI = 0.6 * (a.speed ?? 0); m.scan(); }
assert.ok(Math.abs(hm.loadAmps - 40) < 1, `amps ${hm.loadAmps}`);
assert.ok(Math.abs(a.speed - 66.7) < 2, `speed ${a.speed}`);
cmd('SetLoadControl', 'HM-1', { auto: false }); const held = a.speed; scan(20);
assert.equal(a.speed, held);

// high-load pause trips the motor after the delay and drops Hand
m.ioInputs.HM_AI = 90; scan(2); assert.equal(hm.status, 'running'); scan(4);
assert.equal(hm.status, 'fault'); assert.equal(hm.mode, 'Off');
assert.ok(m.faults.some((f: any) => f.code === 'E-LD-01' && f.active));

// disconnected sensor trips a running motor
cmd('ResetEquipmentFault', 'HM-1'); m.ioInputs.HM_AI = 50; cmd('SetEquipmentMode', 'HM-1', { mode: 'Hand' }); scan(5);
assert.equal(hm.status, 'running');
m.aiDisconnected.add('HM_AI'); scan(2);
assert.equal(hm.status, 'fault'); assert.equal(hm.loadAmps, undefined);
// an override is not a disconnected sensor
m.aiDisconnected.add('HM_AI'); m.ioOverrides.HM_AI = 50; m.ioInputs.HM_AI = 50; scan(1);
assert.equal(hm.loadDisconnected, false);
delete m.ioOverrides.HM_AI;

// no low-load protection (stop delays end a run): a running motor near 0 A is left alone; only the high limit trips
const mx: any = mk('MX-1', 'mixer', { runOutput: 'MX_OUT', runConfirmAux: 'MX_AUX', analogLoadInput: 'MX_AI', minAmps: 0, maxAmps: 100, loadAvgSamples: 10, loadLimitDelay: 0.3, hiPauseAmps: 80 });
mx.mode = 'Off'; m.equipment.set('MX-1', mx); m.ioInputs.MX_AUX = true; m.ioInputs.MX_AI = 0; scan(30);
m.ioInputs.MX_AI = 50; cmd('SetEquipmentMode', 'MX-1', { mode: 'Hand' }); scan(15);
assert.equal(mx.status, 'running');
m.ioInputs.MX_AI = 2; scan(40);
assert.equal(mx.status, 'running', 'low load must not trip'); assert.ok(!m.faults.some((f: any) => f.code === 'E-LD-02' || f.code === 'W-LD-02'));
// bypass: high load and a broken sensor are ignored while the load input is bypassed; clearing it re-arms the disconnect trip
assert.equal(cmd('SetBypass', 'MX-1', { key: 'analogLoadInput', value: true }).accepted, true);
m.ioInputs.MX_AI = 95; scan(40); assert.equal(mx.status, 'running');
m.aiDisconnected.add('MX_AI'); scan(5); assert.equal(mx.status, 'running'); assert.equal(mx.loadDisconnected, true);
cmd('SetBypass', 'MX-1', { key: 'analogLoadInput', value: false }); scan(2);
assert.equal(mx.status, 'fault'); assert.ok(m.faults.some((f: any) => f.code === 'E-LD-03' && f.equipment === 'MX-1'));
m.aiDisconnected.delete('MX_AI');
// other bypasses: starter aux, gate limit switches; only assigned inputs of a known kind can be bypassed
assert.equal(cmd('SetBypass', 'MX-1', { key: 'rotationPulseInput', value: true }).accepted, false, 'not assigned');
assert.equal(cmd('SetBypass', 'MX-1', { key: 'runOutput', value: true }).accepted, false, 'not a bypassable input');
const aug: any = mk('A-9', 'auger', { runOutput: 'A9_OUT', runConfirmAux: 'A9_AUX' }); aug.mode = 'Hand'; m.equipment.set('A-9', aug);
m.ioInputs.A9_AUX = false; scan(10); assert.equal(aug.status, 'fault', 'no aux feedback faults');
cmd('ResetEquipmentFault', 'A-9'); cmd('SetEquipmentMode', 'A-9', { mode: 'Hand' });
cmd('SetBypass', 'A-9', { key: 'runConfirmAux', value: true }); scan(10); assert.equal(aug.status, 'running', 'aux bypassed: runs without feedback');
const gt: any = mk('G-1', 'gate', { openOutput: 'G_O', closeOutput: 'G_C', openLimitInput: 'G_OL', closedLimitInput: 'G_CL', positionTimeout: 0.3 }); gt.request = true; m.equipment.set('G-1', gt);
m.ioInputs.G_OL = false; m.ioInputs.G_CL = false; scan(8); assert.equal(gt.status, 'fault', 'open limit never made');
cmd('ResetEquipmentFault', 'G-1'); cmd('SetBypass', 'G-1', { key: 'openLimitInput', value: true }); scan(3);
assert.equal(gt.gatePosition, 'open'); assert.notEqual(gt.status, 'fault', 'limit bypassed');
// runtime settings are validated
assert.equal(cmd('SetLoadConfig', 'MX-1', { values: { hiWarnAmps: 90 } }).accepted, false, 'warn above pause');
assert.equal(cmd('SetLoadConfig', 'MX-1', { values: { runOutput: 'X' } }).accepted, false, 'not a runtime key');
assert.equal(cmd('SetLoadConfig', 'MX-1', { values: { hiWarnAmps: 60 } }).accepted, true);

// load control: Auto needs a setup, and the feeder can't be hand-set while it is under control
hm.config.loadSetpointAmps = 0;
assert.equal(cmd('SetLoadControl', 'HM-1', { auto: true }).accepted, false);
assert.equal(cmd('SetLoadControl', 'HM-1', { auto: true, setpoint: 40 }).accepted, true);
assert.equal(cmd('SetEquipmentSpeed', 'A-1', { speed: 60 }).accepted, false);
cmd('SetLoadControl', 'HM-1', { auto: false });
assert.equal(cmd('SetEquipmentSpeed', 'A-1', { speed: 60 }).accepted, true);
// autotune: first-order plant (amps follow 0.6 * speed, 3 s lag); relay test finds Kp/Ti, then the PID holds the setpoint
cmd('ResetEquipmentFault', 'HM-1'); m.aiDisconnected.delete('HM_AI'); delete m.ioOverrides.HM_AI; m.ioInputs.HM_AI = 40;
cmd('SetEquipmentMode', 'HM-1', { mode: 'Hand' }); a.speed = 66.7; scan(10);
assert.equal(hm.status, 'running'); assert.equal(a.status, 'running');
hm.config.loadKp = 0; hm.config.loadTiSec = 0;
let amps = 40; const plant = () => { amps += (0.6 * (a.speed ?? 0) - amps) * 0.1 / 3; m.ioInputs.HM_AI = amps; m.scan(); };
assert.equal(cmd('SetLoadControl', 'HM-1', { auto: true }).accepted, true);
assert.equal(cmd('StartLoadAutotune', 'HM-1').accepted, true);
assert.equal(cmd('SetLoadControl', 'HM-1', { auto: true }).accepted, false, 'no mode change while tuning');
assert.equal(cmd('SetEquipmentSpeed', 'A-1', { speed: 60 }).accepted, false, 'feeder locked while tuning');
for (let i = 0; i < 6000 && hm.loadAtRunning; i++) plant();
assert.ok(!hm.loadAtRunning && /done/.test(hm.loadAtMsg), hm.loadAtMsg);
assert.ok(hm.config.loadKp > 0 && hm.config.loadTiSec > 0, `kp ${hm.config.loadKp} ti ${hm.config.loadTiSec}`);
assert.equal(a.speed, 66.7, 'feeder handed back at its old speed');
assert.equal(hm.loadControlAuto, true, 'control resumes in Auto with the new constants, like PIDAT');
for (let i = 0; i < 3000; i++) plant();
assert.ok(Math.abs(hm.loadAmps - 40) < 1.5, `tuned loop amps ${hm.loadAmps}`);
cmd('SetLoadControl', 'HM-1', { auto: false });
// an autotune aborts when the mill stops
assert.equal(cmd('StartLoadAutotune', 'HM-1').accepted, true); hm.status = 'fault'; scan(2);
assert.ok(!hm.loadAtRunning && /aborted/.test(hm.loadAtMsg));
// trend buffer: 1 Hz samples of amps
assert.ok(m.getTrend('HM-1').length > 10 && typeof m.getTrend('HM-1')[0].a === 'number');

// horn: sounds while any fault is active, silence toggles it, a new fault re-arms it, auto-silences, off when faults clear
m.globalConfig.hornOutput = 'HORN'; m.globalConfig.hornSilenceInput = 'HSIL'; m.globalConfig.hornAutoSilenceSec = 2; m.globalConfig.hornOnSec = 0.2; m.globalConfig.hornOffSec = 0.2;
m.hornSilenced = false; m.hornAutoMs = 0;
let heard = false; for (let i = 0; i < 6; i++) { m.scan(); heard ||= m.ioOutputs.HORN === true; } assert.ok(heard, 'horn beeps with faults active');
cmd('SilenceHorn'); scan(3); assert.equal(m.ioOutputs.HORN, false); assert.equal(m.getSnapshot().horn.silenced, true);
m.raiseFault('X', 'WARNING', 't', 'T-NEW'); heard = false; for (let i = 0; i < 6; i++) { m.scan(); heard ||= m.ioOutputs.HORN === true; } assert.ok(heard, 'new fault re-arms the horn');
scan(30); assert.equal(m.ioOutputs.HORN, false, 'auto-silenced'); assert.equal(m.getSnapshot().horn.silenced, true);
m.ioInputs.HSIL = true; scan(1); assert.equal(m.getSnapshot().horn.silenced, false, 'silence input toggles (re-arms)'); m.ioInputs.HSIL = false;
for (const f of m.faults) f.active = false; scan(10); assert.equal(m.ioOutputs.HORN, false, 'no faults, no horn');
// commissioning force (an OUTPUT): never during a batch or with a hammermill enabled; input overrides stay available
m.signals.push({ id: 'OUT_X', direction: 'DO', label: 'x' }); m.commissioningMode = true;
m.activeBatch = { state: 'DOSING' };
assert.equal(cmd('SetOverride', 'OUT_X', { value: true }).accepted, false, 'batch in progress');
assert.equal(cmd('SetOverride', 'SOME_IN', { value: true }).accepted, true, 'input override is not guarded'); cmd('ClearOverride', 'SOME_IN');
m.activeBatch = null;
hm.enabled = true; assert.equal(cmd('SetOverride', 'OUT_X', { value: true }).accepted, false, 'hammermill enabled'); hm.enabled = false;
assert.equal(cmd('SetOverride', 'OUT_X', { value: true }).accepted, true);
assert.equal(cmd('SetHammermillEnabled', 'HM-1', { enabled: true }).accepted, false, 'forced output active');
cmd('SetOverride', 'SOME_IN', { value: true }); assert.equal(m.outputForcesActive(), true);
cmd('ClearOverride', 'OUT_X'); assert.equal(m.outputForcesActive(), false, 'an input override does not count'); cmd('ClearOverride', 'SOME_IN');
m.commissioningMode = false;

// master VFD, sequenced like the PLC's micros VFD: starter first, VFD 0.7 s after the starter is confirmed, drops with the
// run command, and a VFD output shared by two motors stays on while either one runs
const vmk = (id: string) => mk(id, 'auger', { runOutput: `${id}_OUT`, runConfirmAux: `${id}_AUX`, masterVfd: true, vfdRunOutput: 'VFD_RUN', vfdAuxInput: 'VFD_AUX' });
const v1: any = vmk('V1'), v2: any = vmk('V2'); v1.mode = 'Off'; v2.mode = 'Off'; m.equipment.set('V1', v1); m.equipment.set('V2', v2);
const follow = () => { for (const id of ['V1', 'V2']) m.ioInputs[`${id}_AUX`] = m.ioOutputs[`${id}_OUT`] === true; m.ioInputs.VFD_AUX = m.ioOutputs.VFD_RUN === true; m.scan(); };
cmd('SetEquipmentMode', 'V1', { mode: 'Hand' });
for (let i = 0; i < 4; i++) follow();
assert.equal(m.ioOutputs.V1_OUT, true); assert.equal(m.ioOutputs.VFD_RUN, false, 'VFD waits for the starter'); assert.notEqual(v1.status, 'running');
for (let i = 0; i < 30; i++) follow();
assert.equal(m.ioOutputs.VFD_RUN, true); assert.equal(v1.status, 'running', 'no false VFD feedback fault during the start delay');
cmd('SetEquipmentMode', 'V2', { mode: 'Hand' }); for (let i = 0; i < 15; i++) follow(); assert.equal(v2.status, 'running');
cmd('SetEquipmentMode', 'V1', { mode: 'Off' }); for (let i = 0; i < 5; i++) follow(); assert.equal(m.ioOutputs.VFD_RUN, true, 'shared VFD stays on for V2');
cmd('SetEquipmentMode', 'V2', { mode: 'Off' }); for (let i = 0; i < 3; i++) follow(); assert.equal(m.ioOutputs.VFD_RUN, false, 'VFD drops with the last run command');
// PLC-style display state
const ds = (e: any) => m.displayState(e);
const sm: any = mk('S-1', 'auger', { runOutput: 'S_OUT', runConfirmAux: 'S_AUX' }); sm.mode = 'Off'; m.equipment.set('S-1', sm);
assert.equal(ds(sm), 'off');
sm.mode = 'Auto'; assert.equal(ds(sm), 'auto_stopped'); sm.status = 'running'; assert.equal(ds(sm), 'auto_running');
sm.config.bypass_runConfirmAux = true; assert.equal(ds(sm), 'bypass'); delete sm.config.bypass_runConfirmAux;
sm.mode = 'Hand'; assert.equal(ds(sm), 'hand_running'); sm.warningReason = 'High load'; assert.equal(ds(sm), 'alarm');
sm.status = 'fault'; assert.equal(ds(sm), 'fault', 'a trip outranks a warning'); sm.status = 'disabled'; assert.equal(ds(sm), 'disabled');
assert.equal(m.getSnapshot().equipment.find((e: any) => e.id === 'S-1').state, 'disabled');
// the fault list survives a power cycle: every state change is written to the DB (which the next boot loads)
m.raiseFault('PX', 'CRITICAL', 'keep me', 'T-KEEP');
const kept = () => loadFaults().find((f: any) => f.code === 'T-KEEP');
assert.ok(kept() && kept()!.active, 'raised fault is stored');
cmd('AcknowledgeFault', m.faults.find((f: any) => f.code === 'T-KEEP').id); assert.ok(kept()!.acknowledgedAt, 'acknowledge stored');
cmd('ClearFault', m.faults.find((f: any) => f.code === 'T-KEEP').id); assert.ok(!kept()!.active, 'cleared fault stored');
const rq: any = mk('RQ', 'auger', { runOutput: 'RQ_OUT' }); rq.status = 'fault'; m.equipment.set('RQ', rq);
m.raiseFault('RQ', 'CRITICAL', 'trip', 'T-RESET'); cmd('ResetEquipmentFault', 'RQ');
assert.ok(!loadFaults().find((f: any) => f.code === 'T-RESET')!.active, 'equipment reset is stored too');

// level switches on the shared debounce: the high switch is slow to cover, the low switch slow to uncover, the other way immediate
const bn: any = mk('B-1', 'bin', { highLevelInput: 'LV_HI', lowLevelInput: 'LV_LO', binFullStopDelay: 0.3, binLowRestartDelay: 0.3 }); m.equipment.set('B-1', bn);
const lvl = () => m.levelState('B-1');
m.ioInputs.LV_HI = false; m.ioInputs.LV_LO = true; scan(2); assert.equal(lvl(), 'normal');
m.ioInputs.LV_HI = true; scan(2); assert.equal(lvl(), 'normal', 'full only after the stop delay'); scan(3); assert.equal(lvl(), 'full');
m.ioInputs.LV_HI = false; scan(1); assert.equal(lvl(), 'normal', 'uncovering the high switch is immediate');
m.ioInputs.LV_LO = false; scan(2); assert.equal(lvl(), 'normal', 'empty only after the restart delay'); scan(3); assert.equal(lvl(), 'empty');
m.ioInputs.LV_LO = true; scan(1); assert.equal(lvl(), 'normal', 'covering the low switch is immediate');
m.ioInputs.LV_HI = true; scan(6); assert.equal(lvl(), 'full');
assert.equal(cmd('SetBypass', 'B-1', { key: 'highLevelInput', value: true }).accepted, true); scan(1);
assert.equal(lvl(), 'normal', 'a bypassed switch is ignored (bin no longer reports full)');
cmd('SetBypass', 'B-1', { key: 'highLevelInput', value: false }); scan(1); assert.equal(lvl(), 'full');
m.ioInputs.LV_HI = false; scan(2);

// after a restart an active trip fault puts its equipment back in 'fault' (the latch survives the power cycle)
const lt: any = mk('LT', 'auger', { runOutput: 'LT_OUT' }); lt.mode = 'Hand'; m.equipment.set('LT', lt);
m.raiseFault('LT', 'CRITICAL', `${lt.name}: starter feedback timeout`, 'E-MT-01'); m.restoreTripLatches();
assert.equal(lt.status, 'fault'); assert.equal(lt.mode, 'Off'); assert.equal(lt.faultReason, 'starter feedback timeout');

// each I/O point reports what it is configured as
m.signals.push({ id: 'HM_OUT', direction: 'DO', label: 'Digital Output' }, { id: 'TAGX', direction: 'DI', label: 'Digital Input' }); m.globalConfig.estopInput = 'TAGX';
const tag = (id: string) => m.getSnapshot().io.signals.find((s: any) => s.id === id).assignment;
assert.equal(tag('HM_OUT'), 'HM-1 Run'); assert.equal(tag('TAGX'), 'E-Stop');
assert.equal(cmd('SetGlobalConfig', undefined, { key: 'stateColor_fault', value: 'red' }).accepted, false, 'colour must be #rrggbb');
assert.equal(cmd('SetGlobalConfig', undefined, { key: 'stateColor_fault', value: '#B71C1C' }).accepted, true);
console.log('phase2 checks passed');
process.exit(0);
