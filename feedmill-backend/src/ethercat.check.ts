// Rack allocation check (no hardware needed): RS1201 must be recognised wherever it sits in the rack.
import assert from 'node:assert/strict';
import { allocateRackEntries } from './ethercat.js';
import type { IoRackCard } from './types.js';

const card = (slot: number, model: string): IoRackCard => ({ slot, model, status: 'unchecked' });
const unitBase = (n: number) => 0x6000 + (n - 1) * 0x20;
const e = (index: number, bits: number, subindex = 1) => ({ index, subindex, bits, dir: 'input' as const });
const rs = (n: number) => [e(unitBase(n), 16), e(unitBase(n) + 1, 16), e(unitBase(n) + 2, 32)];

// PF (#1, no I/O), 16-pt DI (#2), 4-ch AI (#3), RS1201 (#4)
const cards = [card(1, 'NX-PF0730'), card(2, 'NX-ID5442'), card(3, 'NX-AD3203'), card(4, 'NX-RS1201')];
const ins = [e(unitBase(2), 16), ...[1, 2, 3, 4].map(i => e(unitBase(3), 16, i)), ...rs(4)];
const a = allocateRackEntries(cards, ins, []);
assert.equal(a.get(4)!.status, 'ok', 'RS1201 at unit #4 is found');
assert.equal(a.get(4)!.pdoEntries![2].index, unitBase(4) + 2, 'weight entry is the third');
assert.equal(a.get(3)!.status, 'ok');

// first unit, and extra calibration entries in its block are consumed by the RS1201 (not handed to the next card)
const first = allocateRackEntries([card(1, 'NX-RS1201'), card(2, 'NX-AD3203')],
  [...rs(1), e(unitBase(1) + 3, 16), e(unitBase(1) + 4, 16), ...[1, 2, 3, 4].map(i => e(unitBase(2), 16, i))], []);
assert.equal(first.get(1)!.status, 'ok'); assert.equal(first.get(1)!.pdoEntries!.length, 5);
assert.equal(first.get(2)!.status, 'ok'); assert.equal(first.get(2)!.pdoEntries![0].index, unitBase(2));

// a unit that is not mapped as a load cell is still reported missing
const bad = allocateRackEntries([card(1, 'NX-RS1201')], [e(unitBase(1), 16), e(unitBase(1) + 1, 16), e(unitBase(1) + 2, 16)], []);
assert.equal(bad.get(1)!.status, 'missing');
assert.equal(allocateRackEntries([card(1, 'NX-RS1201')], [], []).get(1)!.status, 'missing');
console.log('ethercat checks passed');
