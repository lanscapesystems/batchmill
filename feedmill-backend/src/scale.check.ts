// A serial scale that cannot be read raises a fault and leaves the backend running (an unopenable port once looped until
// it ran out of memory). Run: MILL_DATA_DIR=<tmp dir> npm run check
import './testScan.js';
import assert from 'node:assert/strict';
import { Mill } from './mill.js';
import { reconcileScaleReaders } from './scaleReader.js';
import { parseWeight, SCALE_DECODERS, plcDecoder, plcConfigError, splitFrames } from './scaleFormats.js';
import type { ScaleConfig } from './types.js';

// indicator formats: weight and motion as the indicator states them, its bad verdicts, and lines that are not a weight
const { ricelake, toledo, and, weightronix } = SCALE_DECODERS;
const ok = (weight: number, motion = false) => ({ weight, motion });
const bad = (r: unknown) => assert.ok(r && typeof r === 'object' && 'bad' in r, JSON.stringify(r));
assert.deepEqual(ricelake('\x02    1234LG '), ok(1234));
assert.deepEqual(ricelake('\x02-   12.5LGM'), ok(-12.5, true));
assert.deepEqual(ricelake('\x02       0LGZ'), ok(0), 'centre of zero is a good reading');
bad(ricelake('\x02 &&&&&&&LGO')); bad(ricelake('\x02    1234LGI'));
assert.equal(ricelake('ST,GS,+001234.5 lb'), null);
const tol = (a: number, b: number, c: number, w: string, tare = '     0') => toledo('\x02' + String.fromCharCode(a, b, c) + w + tare);
assert.deepEqual(tol(0x22, 0x20, 0x20, '  1234'), ok(1234));
assert.deepEqual(tol(0x23, 0x22, 0x20, '  1234'), ok(-123.4), 'sign and decimal point come from the status bytes');
assert.deepEqual(tol(0x20, 0x28, 0x20, '    12'), ok(1200, true), 'fixed zeroes');
assert.deepEqual(tol(0x22, 0x20, 0x20, '  1234', ''), ok(1234), 'short format, no tare');
assert.deepEqual(toledo('7\x02\x22\x20\x20  1234     0'), ok(1234), 'previous frame checksum in front');
bad(tol(0x22, 0x24, 0x20, '  1234')); bad(tol(0x22, 0x20, 0x30, '  1234'));
assert.equal(tol(0x22, 0x20, 0x20, '  12'), null, 'truncated frame'); assert.equal(toledo('  1234     0 and junk'), null);
assert.deepEqual(and('ST,GS,+000123.4kg'), ok(123.4));
assert.deepEqual(and('US,NT,-00012,5 lb'), ok(-12.5, true), 'comma as the decimal mark');
assert.deepEqual(and('ST,+00123.45  g'), ok(123.45));
bad(and('OL,GS,+     . kg'));
assert.equal(and('ST,TR,+000010.0kg'), null, 'tare is not the weight');
assert.deepEqual(weightronix('+001234 lb g  \x03'), ok(1234));
assert.deepEqual(weightronix('-0012.5 kg n m  \x03'), ok(-12.5, true));
bad(weightronix('+999999 lb g o  \x03'));
assert.equal(weightronix('#### ERR ####'), null);

// weights below zero keep their sign however the head pads or places it
for (const [line, weight] of [
  ['ST,GS,+001234.5 lb', 1234.5], ['ST,GS,-000012.5 lb', -12.5], ['ST,GS,-   12.5lb', -12.5], ['  12.5- lb', -12.5],
  ['  500', 500], ['-.5', -0.5], ['12.5-lb', 12.5], ['#### ERR ####', null],
  ['\x02-   12.5LG ', -12.5], ['\x02    1234LG ', 1234], // Rice Lake 480 STR1 frames: padded digits, no thousands commas
] as const) assert.equal(parseWeight(line), weight, line);
assert.equal(parseWeight('W=- 7', /-?\s*\d+/), -7, 'a custom pattern may span the padding too');
assert.equal(parseWeight('abc', /\d*/), null, 'an empty match is not zero');

// PLC framing: start / end codes, weight between prefix and suffix, moving character anywhere
const plcCfg = { startCode: '02', endCode: '0d', prefixChar: 'G', suffixChar: 'L', motionChar: 'M' };
const got = splitFrames('junk\x02G  -12.5L M\rno start\r\x02old\x02G 500L \r\x02G 7', plcCfg);
assert.deepEqual(got, { lines: ['\x02G  -12.5L M\r', '\x02G 500L \r'], rest: '\x02G 7' });
assert.deepEqual(got.lines.map(plcDecoder(plcCfg)), [{ weight: -12.5, motion: true }, { weight: 500, motion: false }]);
assert.equal(plcDecoder(plcCfg)('\x02Gx1L\r'), null, 'text between prefix and suffix must be a number');
assert.equal(plcDecoder(plcCfg)('L 5 G'), null);
assert.deepEqual(splitFrames('a\r\nb'), { lines: ['a', ''], rest: 'b' });
assert.equal(plcConfigError(plcCfg), null); assert.equal(plcConfigError({ ...plcCfg, motionChar: '' }), null);
for (const wrong of [{ startCode: '2' }, { endCode: '02' }, { endCode: '8d' }, { prefixChar: '' }, { suffixChar: 'G' }, { motionChar: 'MM' }]) {
  assert.ok(plcConfigError({ ...plcCfg, ...wrong }), JSON.stringify(wrong));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const m: any = new Mill();
const cfg: ScaleConfig = {
  id: 'SC-X', name: 'x', connectionType: 'serial', comPort: '/dev/no-such-scale', baudRate: 9600, dataBits: 8,
  parity: 'none', stopBits: 1, weightRegex: '', rackSlot: 0, zeroOffset: 0, ratedMvV: 2, capacity: 1000, resolution: 1,
  freshnessTimeout: 2000, stabilityWindow: 500,
};
const active = () => m.faults.find((f: any) => f.code === 'W-SC-02' && f.equipment === 'SC-X' && f.active);
const reset = () => { m.processCommand({ requestId: 'x', action: 'ResetFaults' }); m.scan(); };

// the loop ran on nextTick, which starves timers: count ticks and give up rather than wait for the memory to run out
const tick = process.nextTick;
let ticks = 0;
process.nextTick = ((...args: Parameters<typeof tick>) => {
  if (++ticks === 10_000) { console.error('FAIL: serial port error loop'); process.exit(1); } // ===: console.error ticks too
  return tick(...args);
}) as typeof tick;

const later = (ms: number) => new Promise(r => setTimeout(r, ms));

void (async () => {
  reconcileScaleReaders(m, [cfg]);
  m.scan();
  assert.ok(!active(), 'a port gets a moment to open before it is a fault');
  await later(4000); // past the failed open, a retry and the fault delay
  m.scan();
  assert.match(active()?.message ?? '', /SC-X: cannot read \/dev\/no-such-scale: .+/, 'the fault names the port and the reason');
  assert.equal(active().severity, 'WARNING');
  reset();
  assert.ok(active(), 'still unreadable: raised again after a reset');

  reconcileScaleReaders(m, []); // closing a port that never opened must not loop either
  m.scan();
  assert.ok(active(), 'latched until reset');
  reset();
  assert.ok(!active(), 'scale removed: the reset clears it for good');

  reconcileScaleReaders(m, [{ ...cfg, comPort: '' }]);
  await later(4000);
  m.scan();
  assert.match(active()?.message ?? '', /no serial port selected/);
  reconcileScaleReaders(m, []);
  assert.ok(ticks < 500, `${ticks} ticks`);
  console.log('scale checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
