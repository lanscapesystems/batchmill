// Rack allocation check (no hardware needed): RS1201 must be recognised wherever it sits in the rack.
import assert from 'node:assert/strict';
import { allocateRackEntries, cardsFromRack, discoverRack, generateIoConf, verifyEthercatRack } from './ethercat.js';
import type { IoRackCard } from './types.js';
import { NX_CARD_CATALOG } from './types.js';

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
// reading a fresh rack (nothing configured): units are identified from idents where confirmed, otherwise from process-data layout
const inE = (idx: number, bits: number, sub = 1) => ({ index: idx, subindex: sub, bits, dir: 'input' as const });
const outE = (idx: number, bits: number, sub = 1) => ({ index: idx, subindex: sub, bits, dir: 'output' as const });
const u = (n: number) => 0x6000 + (n - 1) * 0x20, uo = (n: number) => 0x7000 + (n - 1) * 0x20;
const rack = [
  inE(u(2), 16),                                                 // unit 2: ident of NX-ID5442
  outE(uo(3), 16),                                               // unit 3: ident of NX-OD5256
  inE(u(4), 16, 1), inE(u(4), 16, 2), inE(u(4), 16, 3), inE(u(4), 16, 4), // unit 4: 4 x 16-bit in -> AI, 4 ch
  inE(u(5), 16), inE(u(5) + 1, 16), inE(u(5) + 2, 32), outE(uo(5), 16),   // unit 5: load cell
  inE(u(6), 8),                                                  // unit 6: 8-bit packed input
];
const found = cardsFromRack(rack, [null, 0x1, 0x00115442, 0x00135256, null, null, null], 6);
const byslot = (n: number) => found.cards.find(c => c.slot === n)!;
assert.equal(found.cards.length, 6);
assert.deepEqual([byslot(1).model, byslot(1).confidence], ['NX-PF0730', 'assumed'], 'unit with no process data = power unit');
assert.deepEqual([byslot(2).model, byslot(2).confidence], ['NX-ID5442', 'ident']);
assert.deepEqual([byslot(3).model, byslot(3).confidence], ['NX-OD5256', 'ident']);
assert.deepEqual([byslot(4).model, byslot(4).confidence], ['NX-AD3203', 'inferred'], '4 analog channels');
assert.deepEqual([byslot(5).model, byslot(5).confidence], ['NX-RS1201', 'inferred']);
assert.equal(byslot(6).model, 'NX-ID4342'); assert.equal(byslot(6).confidence, 'ambiguous', '8-pt digital input: NPN or PNP');
// a 16-bit digital card with an unknown ident: two candidates (PNP / NPN)
const di16 = cardsFromRack([inE(u(1), 16)], [null, null], 1).cards[0]; assert.equal(di16.confidence, 'ambiguous');
// a layout nothing matches is flagged, not guessed silently
const odd = cardsFromRack([inE(u(1), 16), outE(uo(1), 16)], [null, null], 1); assert.equal(odd.warnings.length, 1);
// the unit's slot is its NX unit number even when earlier units have no data
assert.equal(cardsFromRack([inE(u(3), 16)], [null], 3).cards.map(c => c.slot).join(), '1,2,3');
// NX-DA3205: 4-ch current output with 1/30000 resolution, so its full scale is 30000 (not the 1/8000 models' 8000)
assert.equal(NX_CARD_CATALOG.find(d => d.model === 'NX-DA3205')?.fullScale, 30000);
assert.equal(allocateRackEntries([card(1, 'NX-DA3205')], [], [1, 2, 3, 4].map(i => outE(uo(1), 16, i))).get(1)!.status, 'ok');
// an unconfirmed ident only pre-selects the likely model
assert.equal(cardsFromRack([1, 2, 3, 4].map(i => outE(uo(1), 16, i)), [null, 0x00233205], 1).cards[0].model, 'NX-DA3205');

// a scale ID with a space would make the daemon reject io.conf and exit: the scale is left out instead
const om: any = { couplerType: 'NX-ECC', eccModel: 'NX-ECC203', cycleTimeUs: 5000, cards: [card(1, 'NX-RS1201')], discoveredRack: { productId: 1, inputEntries: rs(1), outputEntries: [] } };
const badId = generateIoConf(om, [], [], [{ id: 'SC 2', name: 'S', connectionType: 'rs1201', rackSlot: 1 } as any]);
assert.ok(!badId.conf.includes('channel') && badId.warnings.length === 1);

// rack read against a fake `ethercat` CLI: a read that is partial at first is retried; an empty one keeps the last good map
let pdoReads = 0, partialReads = 2, empty = false, rescans = 0, parkedAtRescan = false;
const cp = require('child_process'), fs = require('fs');
const confPath = require('path').join(require('os').tmpdir(), `io-check-${process.pid}.conf`);
process.env.FEEDMILL_IO_CONF_PATH = confPath; // never touch a real io.conf
fs.writeFileSync(confPath, 'old conf\n');
cp.execFileSync = (cmd: string, args: string[]) => {
  if (cmd === 'sudo') return '';
  if (args[0] === 'rescan') { rescans++; parkedAtRescan = fs.readFileSync(confPath, 'utf8').startsWith('# parked'); return ''; }
  if (args[0] === 'master') return 'Phase: Operation\nSlaves: 1\nLink: UP\n';
  if (args[0] === 'slaves') return args.includes('-v') ? 'Product code: 0x000000a7\n' : '0  0:0  OP  +  NX-ECC203\n';
  if (args[0] !== 'pdos') return args.includes('0xf050') ? (args[args.length - 1] === '1' ? `0x00135256 ${0x00135256}\n` : `0x00115442 ${0x00115442}\n`) : '0x00 0\n';
  pdoReads++;
  if (empty) return '';
  return 'RxPDO 0x1600\n PDO entry 0x7002:01, 16 bit\n' + (pdoReads > partialReads ? 'TxPDO 0x1a00\n PDO entry 0x6022:01, 16 bit\n' : '');
};
const rackOm: any = { couplerType: 'NX-ECC', eccModel: 'NX-ECC203', cards: [card(1, 'NX-OD5256'), card(2, 'NX-ID5442')] };
const read = verifyEthercatRack(rackOm);
assert.equal(pdoReads, 3); assert.ok(read.cards.every(c => c.status === 'ok'), 'partial read retried');
assert.ok(rescans === 1 && parkedAtRescan, 'one rescan per read, with the daemon parked');
verifyEthercatRack(rackOm);
assert.equal(Number(rescans), 2, 'every save read rescans, even a complete one');
// Read from Coupler rescans too, waits for the inputs, and puts the previous io.conf back
fs.writeFileSync(confPath, 'old conf\n'); pdoReads = 0; partialReads = 1;
const probe = discoverRack();
assert.equal(Number(rescans), 3); assert.ok(probe.cards.some(c => c.model === 'NX-ID5442'));
assert.equal(fs.readFileSync(confPath, 'utf8'), 'old conf\n');
empty = true;
const gone = verifyEthercatRack(rackOm);
assert.equal(rackOm.discoveredRack.inputEntries.length, 1, 'empty read keeps the last good map');
assert.ok(gone.warnings.some(w => w.includes('keeping the last good one')) && gone.warnings.some(w => w.includes('inputs: none')));
fs.rmSync(confPath, { force: true });
console.log('ethercat checks passed');
