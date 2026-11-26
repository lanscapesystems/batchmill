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
const gt: any = mk('G-1', 'gate', { openOutput: 'G_O', closeOutput: 'G_C', openLimitInput: 'G_OL', closedLimitInput: 'G_CL', positionTimeout: 0.3 }); gt.mode = 'P1'; m.equipment.set('G-1', gt);
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
assert.equal(cmd('SetOverride', 'SOME_IN', { value: true }).accepted, true, 'input override allowed in commissioning mode'); cmd('ClearOverride', 'SOME_IN');
m.activeBatch = null;
hm.enabled = true; assert.equal(cmd('SetOverride', 'OUT_X', { value: true }).accepted, false, 'hammermill enabled'); hm.enabled = false;
assert.equal(cmd('SetOverride', 'OUT_X', { value: true }).accepted, true);
assert.equal(cmd('SetHammermillEnabled', 'HM-1', { enabled: true }).accepted, false, 'forced output active');
cmd('SetOverride', 'SOME_IN', { value: true }); assert.equal(m.outputForcesActive(), true);
cmd('ClearOverride', 'OUT_X'); assert.equal(m.outputForcesActive(), false, 'an input override does not count'); cmd('ClearOverride', 'SOME_IN');
cmd('SetOverride', 'SOME_IN', { value: true }); cmd('SetCommissioningMode', undefined, { enabled: false }); assert.deepEqual(m.ioOverrides, {}, 'disabling commissioning drops every force'); assert.equal(cmd('SetOverride', 'SOME_IN', { value: true }).accepted, false, 'no input force outside commissioning'); cmd('SetCommissioningMode', undefined, { enabled: true });
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
// Hand ignores start/stop delays; Auto honours them
const dm: any = mk('D-1', 'auger', { runOutput: 'D_OUT', startDelay: 5, stopDelay: 5 }); dm.mode = 'Off'; m.equipment.set('D-1', dm);
cmd('SetEquipmentMode', 'D-1', { mode: 'Hand' }); m.scan(); assert.equal(dm.runCmd, true, 'Hand starts at once despite the start delay');
cmd('SetEquipmentMode', 'D-1', { mode: 'Off' }); m.scan(); assert.equal(dm.runCmd, false, 'Hand stops at once despite the stop delay');
// Hand ignores the downstream run permissive; Auto-style (non-Hand) still obeys it
const dn: any = mk('D-2', 'auger', { runOutput: 'D2_OUT' }); dn.mode = 'Off'; m.equipment.set('D-2', dn);
m.connections.push({ from: 'D-1', to: 'D-2' } as any);
cmd('SetEquipmentMode', 'D-1', { mode: 'Hand' }); m.scan(); assert.equal(dm.runCmd, true, 'Hand runs although the motor it feeds is stopped');
m.connections.pop(); m.equipment.delete('D-2');
m.equipment.delete('D-1');
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
m.raiseFault('RQ', 'CRITICAL', 'trip', 'E-MT-01'); cmd('ResetEquipmentFault', 'RQ');
assert.ok(!loadFaults().find((f: any) => f.equipment === 'RQ' && f.code === 'E-MT-01')!.active, 'equipment reset is stored too');

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

// an open analog channel is a fault only when it is mapped to equipment
m.signals.push({ id: 'U_AI', direction: 'AI', label: 'Analog Input' });
const openFault = () => m.faults.some((f: any) => f.code === 'W-AI-U_AI' && f.active);
m.readRealInputs({ inputs: { U_AI: 32767 } }); assert.equal(openFault(), false, 'unmapped open channel: no fault');
m.signals.find((s: any) => s.id === 'U_AI').equipmentId = 'HM-1'; m.readRealInputs({ inputs: { U_AI: 32767 } });
assert.equal(openFault(), true, 'mapped open channel: fault');
m.signals.find((s: any) => s.id === 'U_AI').equipmentId = undefined; m.readRealInputs({ inputs: { U_AI: 32767 } });
assert.equal(openFault(), false, 'unmapping clears it');

// Hand -> Auto with nothing requesting: the motor stops at once; with an owner's request it keeps running
const hb: any = mk('HB', 'auger', { runOutput: 'HB_OUT', runConfirmAux: 'HB_AUX', stopDelay: 0.3 }); hb.mode = 'Off'; m.equipment.set('HB', hb);
const hfollow = () => { m.ioInputs.HB_AUX = m.ioOutputs.HB_OUT === true; m.scan(); };
cmd('SetEquipmentMode', 'HB', { mode: 'Hand' }); for (let i = 0; i < 10; i++) hfollow();
assert.equal(hb.status, 'running'); assert.equal(hb.request, true);
cmd('SetEquipmentMode', 'HB', { mode: 'Auto' }); for (let i = 0; i < 2; i++) hfollow();
assert.equal(hb.request, false, 'Hand request does not carry into Auto'); assert.equal(hb.runCmd, false, 'a Hand run stops at once, no stop delay'); assert.equal(m.ioOutputs.HB_OUT, false);
hb.owner = 'BATCH-X'; hb.request = true; for (let i = 0; i < 6; i++) hfollow(); assert.equal(hb.runCmd, true, 'an owner request still runs it in Auto');
hb.owner = undefined; hb.request = false; cmd('SetEquipmentMode', 'HB', { mode: 'Off' });

// faults vs. latches: clearing a warning must not un-trip equipment; Reset clears the trip fault itself, not just the newest one
const ft: any = mk('FT', 'auger', { runOutput: 'FT_OUT', runConfirmAux: 'FT_AUX' }); m.equipment.set('FT', ft); m.ioInputs.FT_AUX = false; scan(8);
assert.equal(ft.status, 'fault');
m.raiseFault('FT', 'WARNING', 'warn', 'W-TEST'); cmd('ClearFault', m.faults.find((f: any) => f.code === 'W-TEST').id);
assert.equal(ft.status, 'fault', 'clearing a warning leaves the trip latched');
m.raiseFault('FT', 'WARNING', 'warn2', 'W-TEST2'); m.ioInputs.FT_AUX = true; cmd('ResetEquipmentFault', 'FT');
assert.equal(ft.status, 'not_running');
assert.ok(!m.faults.some((f: any) => f.equipment === 'FT' && f.code === 'E-MT-01' && f.active), 'the trip fault is the one cleared');
assert.ok(m.faults.some((f: any) => f.code === 'W-TEST2' && f.active), 'the unrelated warning stays');
// clearing the trip fault from the list releases the latch
ft.mode = 'Hand'; m.ioInputs.FT_AUX = false; scan(8); assert.equal(ft.status, 'fault');
cmd('ClearFault', m.faults.find((f: any) => f.equipment === 'FT' && f.code === 'E-MT-01' && f.active).id); assert.equal(ft.status, 'not_running');
// a gate's open-timeout fault stays latched when the limit arrives later
const gl: any = mk('GL', 'gate', { openOutput: 'GL_O', closeOutput: 'GL_C', openLimitInput: 'GL_OL', positionTimeout: 0.3 }); gl.mode = 'Auto'; gl.owner = 'BX'; gl.request = true; m.equipment.set('GL', gl);
m.ioInputs.GL_OL = false; scan(6); assert.equal(gl.status, 'fault'); m.ioInputs.GL_OL = true; scan(3); assert.equal(gl.status, 'fault', 'gate fault is a latch');
gl.owner = undefined; gl.request = false;

// the batch drives only equipment in Auto, and pauses when equipment it owns trips
m.equipment.delete('MX-1');
const ag: any = mk('AG', 'auger', { runOutput: 'AG_OUT', runConfirmAux: 'AG_AUX' }); ag.mode = 'Off'; m.equipment.set('AG', ag); m.ioInputs.AG_AUX = true;
m.activeBatch = { id: 'BT', recipeId: 'R', recipeName: 'R', targetMass: 100, destination: 'BIN', state: 'DOSING', startedAt: new Date().toISOString(), dosingIndex: 0,
  dosingSteps: [{ ingredientId: 'I', ingredientName: 'I', sourceBinId: 'SB', augerId: 'AG', target: 50, actual: 0, unit: 'lbs', state: 'pending', baselineWeight: 0, settleStartTime: 0, cutoffStartTime: 0 }],
  mixTimeRemainingMs: 0, mixTimeTotalMs: 0, dischargeStartTime: 0 };
scan(5); assert.equal(m.activeBatch.state, 'DOSING'); assert.equal(m.activeBatch.faultReason, 'Waiting: AG is not in Auto'); assert.equal(ag.owner, undefined, 'nothing claimed');
cmd('SetEquipmentMode', 'AG', { mode: 'Auto' }); scan(15);
assert.equal(ag.owner, 'BT'); assert.equal(m.activeBatch.faultReason, undefined, 'hold clears itself'); assert.equal(ag.runCmd, true);
m.ioInputs.AG_AUX = false; scan(10);
assert.ok(['PAUSING', 'PAUSED'].includes(m.activeBatch.state), `batch pauses when its auger trips (${m.activeBatch.state})`);
assert.match(m.activeBatch.faultReason, /AG faulted/);
m.releaseEquipment('BT'); m.activeBatch = null;

// gates: P1 (open) / P2 (closed) / Auto / Off instead of Hand; bins have no HOA
const gp: any = mk('GP', 'gate', { openOutput: 'GP_O', closeOutput: 'GP_C', openLimitInput: 'GP_OL', closedLimitInput: 'GP_CL', positionTimeout: 5 }); gp.mode = 'Off'; m.equipment.set('GP', gp);
assert.equal(cmd('SetEquipmentMode', 'GP', { mode: 'Hand' }).accepted, false, 'a gate has no Hand');
assert.equal(cmd('SetEquipmentMode', 'MX-9', { mode: 'P1' }).accepted, false);
assert.equal(cmd('SetEquipmentMode', 'GP', { mode: 'P1' }).accepted, true); scan(2); assert.equal(m.ioOutputs.GP_O, true); assert.equal(m.ioOutputs.GP_C, false);
cmd('SetEquipmentMode', 'GP', { mode: 'P2' }); scan(2); assert.equal(m.ioOutputs.GP_O, false); assert.equal(m.ioOutputs.GP_C, true);
cmd('SetEquipmentMode', 'GP', { mode: 'Off' }); scan(2); assert.equal(m.ioOutputs.GP_O, false); assert.equal(m.ioOutputs.GP_C, false, 'Off drives nothing');
const bnn: any = mk('BN', 'bin', {}); m.equipment.set('BN', bnn);
for (const md of ['Hand', 'Auto', 'Off', 'P1']) assert.equal(cmd('SetEquipmentMode', 'BN', { mode: md }).accepted, false, `bin rejects ${md}`);
// after a batch / refill: a single-coil valve returns to P2 (output off); a double-coil gate stays where it was
const gr: any = mk('GR', 'gate', { actuatorType: 'dual', openOutput: 'GR_O', closeOutput: 'GR_C' }); gr.mode = 'Auto'; gr.owner = 'BT2'; gr.request = true; m.equipment.set('GR', gr);
scan(3); assert.equal(m.ioOutputs.GR_O, true); gr.request = false; gr.owner = undefined; scan(3);
assert.equal(m.ioOutputs.GR_O, true, 'double-coil gate stays at P1'); assert.equal(m.ioOutputs.GR_C, false);
const gs: any = mk('GS', 'gate', { actuatorType: 'single', openOutput: 'GS_O' }); gs.mode = 'Auto'; gs.owner = 'BT2'; gs.request = true; m.equipment.set('GS', gs);
scan(3); assert.equal(m.ioOutputs.GS_O, true); gs.request = false; gs.owner = undefined; scan(3);
assert.equal(m.ioOutputs.GS_O, false, 'single-coil valve falls back to P2');
// P1/P2 follow the flow path: the owner gets the outlet that leads to its target
const gw: any = mk('GW', 'gate', { actuatorType: 'dual', openOutput: 'GW_O', closeOutput: 'GW_C' }); gw.mode = 'Auto'; m.equipment.set('GW', gw);
m.connections.push({ from: 'GW', fromPort: 'out1', to: 'DA', toPort: 'inlet' }, { from: 'DA', fromPort: 'out1', to: 'DX', toPort: 'inlet' }, { from: 'GW', fromPort: 'out2', to: 'DB', toPort: 'inlet' });
assert.equal(m.gatePortToward(gw, 'DA'), 1); assert.equal(m.gatePortToward(gw, 'DX'), 1, 'multi-hop'); assert.equal(m.gatePortToward(gw, 'DB'), 2); assert.equal(m.gatePortToward(gw, 'NOPE'), undefined);
gw.owner = 'BT3'; gw.request = true; gw.gatePort = m.gatePortToward(gw, 'DB'); scan(3);
assert.equal(m.ioOutputs.GW_C, true, 'P2 selected for DB'); assert.equal(m.ioOutputs.GW_O, false);
gw.owner = undefined; gw.request = false; scan(3); assert.equal(m.ioOutputs.GW_C, true, 'and it stays there');
m.connections = m.connections.filter((c: any) => c.from !== 'GW' && c.from !== 'DA');
const gold: any = mk('GO', 'gate', {}); gold.mode = 'Hand'; m.equipment.set('GO', gold);

// motor gate: output only while moving (drops when the limit confirms), starter aux expected while an output is on
const gm: any = mk('GM', 'gate', { actuatorType: 'dual', motorGate: true, openOutput: 'GM_O', closeOutput: 'GM_C', openLimitInput: 'GM_OL', closedLimitInput: 'GM_CL', motorAuxInput: 'GM_AUX', positionTimeout: 5 });
gm.mode = 'Off'; m.equipment.set('GM', gm); m.ioInputs.GM_OL = false; m.ioInputs.GM_CL = true; m.ioInputs.GM_AUX = true;
cmd('SetEquipmentMode', 'GM', { mode: 'P1' }); scan(3);
assert.equal(m.ioOutputs.GM_O, true, 'driving open'); assert.notEqual(gm.status, 'fault');
m.ioInputs.GM_CL = false; m.ioInputs.GM_OL = true; scan(2);
assert.equal(m.ioOutputs.GM_O, false, 'output drops once the open limit confirms'); assert.equal(gm.gatePosition, 'open'); assert.equal(gm.status, 'not_running');
m.ioInputs.GM_AUX = false; scan(10); assert.notEqual(gm.status, 'fault', 'no aux expected once the output is off');
cmd('SetEquipmentMode', 'GM', { mode: 'P2' }); m.ioInputs.GM_OL = false; scan(3);
assert.equal(m.ioOutputs.GM_C, true, 'driving closed'); assert.notEqual(gm.status, 'fault', 'still inside the fault delay'); scan(6);
assert.equal(gm.status, 'fault', 'starter aux never came on while driving'); assert.equal(gm.faultReason, 'Motor starter feedback timeout');
assert.ok(m.faults.some((f: any) => f.code === 'E-GT-03' && f.equipment === 'GM' && f.active));
assert.equal(m.ioOutputs.GM_C, false, 'a starter fault stops driving'); cmd('ResetEquipmentFault', 'GM'); assert.equal(gm.status, 'not_running');
cmd('SetBypass', 'GM', { key: 'motorAuxInput', value: true }); scan(10); assert.notEqual(gm.status, 'fault', 'aux bypassed: no starter fault');
m.ioInputs.GM_CL = true; scan(2); assert.equal(m.ioOutputs.GM_C, false, 'closed limit confirms, output drops'); assert.equal(gm.gatePosition, 'closed');
cmd('SetEquipmentMode', 'GM', { mode: 'Off' });
// a non-motor gate keeps its output on after the limit
cmd('SetEquipmentMode', 'GP', { mode: 'P1' }); m.ioInputs.GP_OL = true; scan(3); assert.equal(m.ioOutputs.GP_O, true, 'plain gate keeps the output on'); cmd('SetEquipmentMode', 'GP', { mode: 'Off' });

// each I/O point reports what it is configured as
m.signals.push({ id: 'HM_OUT', direction: 'DO', label: 'Digital Output' }, { id: 'TAGX', direction: 'DI', label: 'Digital Input' }); m.globalConfig.estopInput = 'TAGX';
const tag = (id: string) => m.getSnapshot().io.signals.find((s: any) => s.id === id).assignment;
assert.equal(tag('HM_OUT'), 'HM-1 MS Coil'); assert.equal(tag('TAGX'), 'E-Stop');
assert.equal(cmd('SetGlobalConfig', undefined, { key: 'stateColor_fault', value: 'red' }).accepted, false, 'colour must be #rrggbb');
assert.equal(cmd('SetGlobalConfig', undefined, { key: 'stateColor_fault', value: '#B71C1C' }).accepted, true);
// e-stop: a motor gate's output drops (and resumes on release); coil valves keep their state
m.signals.push({ id: 'ES2', direction: 'DI', label: 'estop' }); m.globalConfig.estopInput = 'ES2'; m.ioInputs.ES2 = true;
cmd('SetBypass', 'GM', { key: 'motorAuxInput', value: false }); gm.status = 'not_running'; gm.faultReason = undefined;
m.ioInputs.GM_AUX = true; m.ioInputs.GM_OL = false; m.ioInputs.GM_CL = false; cmd('SetEquipmentMode', 'GM', { mode: 'P1' });
gr.owner = 'BT4'; gr.request = true; gr.gatePort = 1;
scan(3); assert.equal(m.ioOutputs.GM_O, true, 'motor gate driving'); assert.equal(m.ioOutputs.GR_O, true);
m.ioInputs.ES2 = false; scan(3);
assert.equal(m.ioOutputs.GM_O, false, 'e-stop drops the motor gate output'); assert.equal(m.ioOutputs.GR_O, true, 'a double-coil valve is not affected');
m.ioInputs.ES2 = true; scan(3); assert.equal(m.ioOutputs.GM_O, true, 'motor gate carries on after release');
cmd('SetEquipmentMode', 'GM', { mode: 'Off' }); gr.owner = undefined; gr.request = false; delete m.globalConfig.estopInput;
console.log('phase2 checks passed');
process.exit(0);
