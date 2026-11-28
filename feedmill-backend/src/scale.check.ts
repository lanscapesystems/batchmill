// A serial scale that cannot be read raises a fault and leaves the backend running (an unopenable port once looped until
// it ran out of memory). Run: MILL_DATA_DIR=<tmp dir> npm run check
import './testScan.js';
import assert from 'node:assert/strict';
import { Mill } from './mill.js';
import { reconcileScaleReaders, parseWeight } from './scaleReader.js';
import type { ScaleConfig } from './types.js';

// weights below zero keep their sign however the head pads or places it
for (const [line, weight] of [
  ['ST,GS,+001234.5 lb', 1234.5], ['ST,GS,-000012.5 lb', -12.5], ['ST,GS,-   12.5lb', -12.5], ['  12.5- lb', -12.5],
  ['  500', 500], ['-.5', -0.5], ['12.5-lb', 12.5], ['#### ERR ####', null],
  ['\x02-   12.5LG ', -12.5], ['\x02    1234LG ', 1234], // Rice Lake 480 STR1 frames: padded digits, no thousands commas
] as const) assert.equal(parseWeight(line), weight, line);
assert.equal(parseWeight('W=- 7', /-?\s*\d+/), -7, 'a custom pattern may span the padding too');
assert.equal(parseWeight('abc', /\d*/), null, 'an empty match is not zero');

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
