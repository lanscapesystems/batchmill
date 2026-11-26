import { execFileSync } from 'child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import type { OmronConfig, IoRackCard, EquipmentRuntime, SignalDef, ScaleConfig, PdoEntry } from './types.js';
import { NX_CARD_CATALOG, OMRON_VENDOR_ID } from './types.js';

const IO_CONF_PATH = process.env.FEEDMILL_IO_CONF_PATH ?? '/etc/feedmill/io.conf';

export interface EthercatMasterStatus {
  toolAvailable: boolean;
  error?: string; // why toolAvailable is false — e.g. "ENOENT" (not installed) vs an EACCES permission message
  phase?: string;
  linkUp?: boolean;
  slaveCount?: number;
}

export interface EthercatSlave {
  position: number;
  state: string;
  name: string;
}

// shortcut: every call below is synchronous (execFileSync) and blocks the
// WHOLE Node event loop for the subprocess's duration, including the
// mill's own 100ms scan timer and any WebSocket traffic — not just the
// caller. verifyEthercatRack/syncIoConf run from explicit, infrequent user
// actions (Read Rack, reconfigure), so the stall is bounded and visible;
// checkRackPresence runs on rackWatchdogCheck's unconditional 3s timer in
// mill.ts, so it stalls the scan loop on every tick. Upgrade to converge
// on when the scan's own measured jitter (see io_daemon.c's P1 timing
// finding) demands it — would need runEthercat and every caller async
// (execFile, not execFileSync), which ripples into mill.ts's command
// dispatch; not done here. See ethercat-io-audit.md's P1 timing finding.
function runEthercat(args: string[]): { out: string | null; error?: string } {
  try {
    return { out: execFileSync('ethercat', args, { encoding: 'utf8', timeout: 3000 }) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === 'ENOENT') return { out: null, error: 'ethercat CLI not found on PATH' };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    // Most common real cause on a freshly-installed box: the backend runs as an
    // unprivileged user, and /dev/EtherCAT0 is root-owned until a udev rule grants
    // group access (see install.sh) — that shows up here as an EACCES in stderr/message.
    return { out: null, error: stderr || e.message || 'ethercat command failed' };
  }
}

// shortcut: parses the default IgH `ethercat` CLI text format (tested against documented
// `ethercat master`/`ethercat slaves` samples, not live hardware). If the installed IgH
// version's column layout differs, update these regexes against `ethercat --version`.
export function getMasterStatus(): EthercatMasterStatus {
  const { out, error } = runEthercat(['master']);
  if (out === null) return { toolAvailable: false, error };
  const phase = /Phase:\s*(.+)/.exec(out)?.[1]?.trim();
  const slaveCountStr = /Slaves:\s*(\d+)/.exec(out)?.[1];
  const linkMatch = /Link:\s*(UP|DOWN)/i.exec(out);
  return {
    toolAvailable: true,
    phase,
    slaveCount: slaveCountStr ? Number(slaveCountStr) : undefined,
    linkUp: linkMatch ? linkMatch[1].toUpperCase() === 'UP' : undefined,
  };
}

export function listSlaves(): EthercatSlave[] {
  const { out } = runEthercat(['slaves']);
  if (out === null) return [];
  const slaves: EthercatSlave[] = [];
  for (const line of out.split('\n')) {
    // one-line-per-slave default format: "<pos>  <alias>:<pos>  <state>  <flag>  <name>"
    const m = /^\s*(\d+)\s+\S+\s+(\S+)\s+\S\s+(.+?)\s*$/.exec(line);
    if (m) slaves.push({ position: Number(m[1]), state: m[2], name: m[3] });
  }
  return slaves;
}

// shortcut: parses `ethercat slaves -p <pos> -v`'s documented "Identity" block
// ("Vendor Id:       0x00000083" / "Product code:    0x...."). Written from
// documented IgH samples, not verified against a live box's actual output —
// if it comes back undefined for a real slave, run `ethercat slaves -p
// <pos> -v` by hand and fix this regex to match what your IgH version prints.
function getSlaveProductId(position: number): number | null {
  const { out } = runEthercat(['slaves', '-p', String(position), '-v']);
  if (out === null) return null;
  const m = /Product code:\s*0x([0-9a-fA-F]+)/.exec(out);
  return m ? parseInt(m[1], 16) : null;
}

// Parses `ethercat pdos -p <pos>`'s Sync Manager / PDO entry listing — an
// "RxPDO" section is what the master writes (outputs), "TxPDO" is what it
// reads (inputs). CONFIRMED against a real NX-ECC203 dump: only entries at
// index 0x6000-0x6fff (inputs) / 0x7000-0x7fff (outputs) are real channel
// data (the CoE digital-I/O profile convention) — everything else seen
// (0x3xxx 64-bit blocks, 0x2xxx status byte, 0x0000 "Gap") is coupler
// diagnostics/padding, not a card's data. Called ONCE for the whole rack
// (position 0, the coupler) — see allocateRackEntries for how individual
// cards' entries get sliced out of the result.
function getRackPdoEntries(position: number): PdoEntry[] {
  const { out } = runEthercat(['pdos', '-p', String(position)]);
  if (out === null) return [];
  const entries: PdoEntry[] = [];
  let dir: PdoEntry['dir'] | null = null;
  for (const line of out.split('\n')) {
    if (/\bRxPDO\b/.test(line)) dir = 'output';
    else if (/\bTxPDO\b/.test(line)) dir = 'input';
    const m = /PDO entry\s+0x([0-9a-fA-F]+):([0-9a-fA-F]+),\s*(\d+)\s*bit/.exec(line);
    if (!m || !dir) continue;
    const index = parseInt(m[1], 16);
    const inRange = dir === 'input' ? (index >= 0x6000 && index <= 0x6fff) : (index >= 0x7000 && index <= 0x7fff);
    if (inRange) entries.push({ index, subindex: parseInt(m[2], 16), bits: Number(m[3]), dir });
  }
  return entries;
}

// Confirmed module idents from CoE 0xF050 ("Detected module ident list"),
// keyed by physical slot number as the SDO subindex (1-63) — confirmed
// against a real NX-ECC203 via a standalone bench tool, not this program.
// Only models listed here get a real per-slot identity check in
// verifyEthercatRack(); everything else falls back to the PDO-count-based
// allocation check (allocateRackEntries) alone, which can't tell a wrong
// card from a right one of the same category/width — add a model here
// only once its ident is confirmed against real hardware.
const NX_CARD_IDENTS: Record<string, number> = {
  'NX-OD5256': 0x00135256,
  'NX-ID5442': 0x00115442,
  'NX-RS1201': 0x00251201,
  'NX-AD3203': 0x00213203,
};

// shortcut: `ethercat upload`'s exact output format for a uint32 SDO
// wasn't re-verified against a live box in this pass (only the 0xF050
// index:subindex scheme itself was, via the user's own bench tool) —
// Number() parses either a bare decimal or a "0x"-prefixed hex string, so
// this should survive either convention, but if getSlotModuleIdent always
// returns null on real hardware, check the raw CLI output here first.
// IgH prints an upload as "0x<hex> <decimal>" (e.g. "0x00135256 1266262"), so
// Number() on the whole line is NaN — take the first token only.
function sdoUpload(type: 'uint8' | 'uint16' | 'uint32', index: string, sub: string): number | null {
  const { out } = runEthercat(['upload', '-p', '0', '-t', type, index, sub]);
  if (out === null) return null;
  const n = Number(out.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

function getSlotModuleIdent(slot: number): number | null {
  return sdoUpload('uint32', '0xf050', String(slot));
}

/** Number of current errors held by the coupler + NX units (W519 A-5-2:
 * CoE 0x3809:00 is the error count plus 1). null = could not read. */
export function readCouplerErrorCount(): number | null {
  const n = sdoUpload('uint8', '0x3809', '0');
  return n === null ? null : Math.max(0, n - 1);
}

/** Clears the coupler's + NX units' current errors by writing 01 to CoE
 * 0x2002:02 "Sysmac Error Status Clear" (W519 A-5-3). Does not fix the cause —
 * the same error returns if it's still present. */
export function clearCouplerErrors(): { ok: boolean; error?: string } {
  const { out, error } = runEthercat(['download', '-p', '0', '-t', 'uint8', '0x2002', '2', '1']);
  return out === null ? { ok: false, error } : { ok: true };
}

interface SlotAllocation {
  status: IoRackCard['status'];
  pdoEntries?: PdoEntry[];
}

// Which PDO entry (or entries) belong to a card depends on where it sits
// among same-category cards, not just its model -- two NX-ID5442s in the
// rack need two DIFFERENT input entries. So this re-slices the rack's
// (cached or freshly-read) entry lists against the CURRENT card list every
// time it's called, in physical rack order (card.slot ascending), rather
// than caching a slice per model. Digital cards (DI/DO) consume exactly
// ONE entry — every point is a bit within it. Analog/scale cards consume
// one entry PER CHANNEL (unverified — no real analog dump seen yet, but
// unlike digital bits, analog values can't share a word).
export function allocateRackEntries(cards: IoRackCard[], inputEntries: PdoEntry[], outputEntries: PdoEntry[]): Map<number, SlotAllocation> {
  const sorted = [...cards].sort((a, b) => a.slot - b.slot);
  let inIdx = 0, outIdx = 0;
  const bySlot = new Map<number, SlotAllocation>();
  for (const card of sorted) {
    const def = NX_CARD_CATALOG.find(d => d.model === card.model);
    if (!def) { bySlot.set(card.slot, { status: 'mismatch' }); continue; }
    if (def.category === 'power') { bySlot.set(card.slot, { status: 'ok' }); continue; }
    const isInput = def.category === 'DI' || def.category === 'AI' || def.category === 'scale';
    const pool = isInput ? inputEntries : outputEntries;
    const start = isInput ? inIdx : outIdx;
    // W521: 8/16/32-point digital cards expose ONE packed BYTE/WORD/DWORD entry,
    // but 2/4-point cards (NX-IA3117, NX-OC2633...) expose one 1-bit BOOL entry
    // per point — so consume entries until their bits cover the card's points.
    let take = def.points;
    // W565 §6-2-1 default input map: +0 Detection Status, +1 Executing Status, +2 Gross Weight DINT. On a Slave Terminal each NX
    // unit's data objects sit in their own 0x20-wide block, 0x6000 + (unit number - 1) * 0x20 (W519 A-7-3), so only the offset
    // inside the block is fixed, never the absolute index. A unit consumes every entry of its block (calibration entries can be added).
    if (def.category === 'scale') {
      const block = (i: number) => i >> 5;
      take = 0;
      while (start + take < pool.length && block(pool[start + take].index) === block(pool[start].index)) take++;
    }
    if (def.category === 'DI' || def.category === 'DO') {
      take = 0;
      for (let bits = 0; bits < def.points && start + take < pool.length; take++) bits += pool[start + take].bits;
    }
    const slice = pool.slice(start, start + take);
    if (isInput) inIdx += take; else outIdx += take;
    const covered = def.category === 'DI' || def.category === 'DO'
      ? slice.reduce((n, e) => n + e.bits, 0) >= def.points
      : def.category === 'scale'
        ? slice.length >= 3 && slice[0].index % 0x20 === 0 && slice[1].index % 0x20 === 1 && slice[2].index % 0x20 === 2 && slice[2].bits === 32
        : slice.length === take;
    bySlot.set(card.slot, covered ? { status: 'ok', pdoEntries: slice } : { status: 'missing' });
  }
  return bySlot;
}

export interface DiscoveredCard {
  slot: number;
  model: string;
  ident?: number;
  // ident = matched a confirmed module ident; inferred = the only catalog model with that process-data layout;
  // ambiguous = several catalog models share it (the first is picked); assumed = nothing to go on (e.g. a power unit)
  confidence: 'ident' | 'inferred' | 'ambiguous' | 'assumed';
}
export interface RackDiscovery { ok: boolean; error?: string; couplerName?: string; eccModel?: string; cards: DiscoveredCard[]; warnings: string[] }

type Shape = { category: 'DI' | 'DO' | 'AI' | 'AO' | 'scale'; points: number };

// Process-data layout of one NX unit -> what kind of card it is. Digital cards expose packed entries (or one BOOL per point on
// 2/4-point cards); analog cards one 16-bit entry per channel (never a lone 16-bit entry: that is a 16-point digital card);
// the RS1201 exposes Detection Status (16), Executing Status (16) and Gross Weight (32).
function unitShape(ins: PdoEntry[], outs: PdoEntry[]): Shape | undefined {
  if (ins.length >= 3 && ins[0].bits === 16 && ins[1].bits === 16 && ins[2].bits === 32) return { category: 'scale', points: 1 };
  const bitsOf = (es: PdoEntry[]) => es.reduce((n, e) => n + e.bits, 0);
  if (ins.length && !outs.length) return ins.length >= 2 && ins.every(e => e.bits === 16) ? { category: 'AI', points: ins.length } : { category: 'DI', points: bitsOf(ins) };
  if (outs.length && !ins.length) return outs.length >= 2 && outs.every(e => e.bits === 16) ? { category: 'AO', points: outs.length } : { category: 'DO', points: bitsOf(outs) };
  return undefined;
}

/** Build a card list from what the coupler exposes alone (no saved config needed). Each NX unit's data objects sit in their own
 * 0x20-wide block (W519 A-7-3), so unit n's entries are found by index; `idents` is the CoE 0xF050 detected-module list
 * (1-based by unit) and lets units with no process data (power units) be counted. */
export function cardsFromRack(entries: PdoEntry[], idents: (number | null)[], unitCount: number): { cards: DiscoveredCard[]; warnings: string[] } {
  const warnings: string[] = [];
  const unitOf = (e: PdoEntry) => ((e.index - (e.dir === 'input' ? 0x6000 : 0x7000)) >> 5) + 1;
  const cards: DiscoveredCard[] = [];
  for (let u = 1; u <= unitCount; u++) {
    const ins = entries.filter(e => e.dir === 'input' && unitOf(e) === u);
    const outs = entries.filter(e => e.dir === 'output' && unitOf(e) === u);
    const ident = idents[u] ?? undefined;
    const known = ident === undefined ? undefined : Object.entries(NX_CARD_IDENTS).find(([, v]) => v === ident)?.[0];
    if (known) { cards.push({ slot: u, model: known, ident, confidence: 'ident' }); continue; }
    if (!ins.length && !outs.length) { cards.push({ slot: u, model: u === 1 ? 'NX-PF0730' : 'NX-PD1000', ident, confidence: 'assumed' }); continue; }
    const shape = unitShape(ins, outs);
    const candidates = shape ? NX_CARD_CATALOG.filter(d => d.category === shape.category && d.points === shape.points) : [];
    if (!candidates.length) {
      warnings.push(`Unit ${u}: process data layout not recognised — pick its model by hand`);
      cards.push({ slot: u, model: 'NX-ID5342', ident, confidence: 'assumed' });
    } else cards.push({ slot: u, model: candidates[0].model, ident, confidence: candidates.length === 1 ? 'inferred' : 'ambiguous' });
  }
  return { cards, warnings };
}

/** Read the rack straight off the bus using nothing from the saved config — works on a fresh install, before any card is
 * entered or the coupler settings are saved (the IgH master is set up by install.sh, not by this backend). */
export function discoverRack(): RackDiscovery {
  const master = getMasterStatus();
  if (!master.toolAvailable) return { ok: false, error: `cannot reach the EtherCAT master (${master.error ?? 'unknown reason'})`, cards: [], warnings: [] };
  if (master.linkUp === false) return { ok: false, error: 'EtherCAT link is down - check the cable and the master NIC', cards: [], warnings: [] };
  const coupler = listSlaves().find(s => s.position === 0);
  if (!coupler) return { ok: false, error: 'No EtherCAT slaves detected on the bus', cards: [], warnings: [] };
  const eccMatch = /ECC20([23])/i.exec(coupler.name);
  const entries = getRackPdoEntries(0);
  const identCount = sdoUpload('uint8', '0xf050', '0');
  const idents: (number | null)[] = [null];
  for (let i = 1; i <= (identCount ?? 0); i++) idents[i] = getSlotModuleIdent(i);
  const unitOf = (e: PdoEntry) => ((e.index - (e.dir === 'input' ? 0x6000 : 0x7000)) >> 5) + 1;
  const unitCount = Math.max(identCount ?? 0, ...entries.map(unitOf), 0);
  const { cards, warnings } = cardsFromRack(entries, idents, unitCount);
  if (identCount === null) warnings.push('Could not read the module list (CoE 0xF050): units without process data, such as power units, may be missing');
  if (!entries.length) warnings.push('The coupler exposes no process data entries yet');
  return { ok: true, couplerName: coupler.name, eccModel: eccMatch ? `NX-ECC20${eccMatch[1]}` : undefined, cards, warnings };
}

/** Real rack verification via the IgH `ethercat` CLI, with a simulated echo
 * fallback when the tool isn't installed (dev machine, or master not set up
 * yet). Reads the coupler's product ID and PDO entry lists ONCE (position 0
 * — the whole rack is one slave) and caches them on om.discoveredRack; each
 * card's own entry/entries are then sliced out fresh via allocateRackEntries. */
export function verifyEthercatRack(om: OmronConfig): { cards: IoRackCard[]; warnings: string[] } {
  const master = getMasterStatus();
  if (!master.toolAvailable) {
    return {
      cards: om.cards.map(c => ({ ...c, actual: c.model, status: 'ok' as const })),
      warnings: [`cannot reach the EtherCAT master (${master.error ?? 'unknown reason'}) — showing an unverified rack, not a live read`],
    };
  }

  const warnings: string[] = [];
  if (master.linkUp === false) {
    warnings.push(`EtherCAT link down on ${om.ethercatInterface || 'the configured NIC'}`);
  }
  if (master.phase && !/^op/i.test(master.phase)) {
    warnings.push(`EtherCAT master phase is "${master.phase}", not Operation`);
  }

  const slaves = listSlaves();
  const coupler = slaves.find(s => s.position === 0);
  if (!coupler) {
    warnings.push('No EtherCAT slaves detected on the bus');
    return { cards: om.cards.map(c => ({ ...c, status: 'missing' as const })), warnings };
  }
  const expectedCoupler = om.eccModel.replace('NX-', '');
  if (!coupler.name.toUpperCase().includes(expectedCoupler)) {
    warnings.push(`Coupler at position 0 reports "${coupler.name}", expected ${om.eccModel}`);
  }

  const errCount = readCouplerErrorCount();
  if (errCount) warnings.push(`Coupler/NX units report ${errCount} current error(s) — remove the cause, then Clear EtherCAT Errors`);

  const productId = getSlaveProductId(0);
  const rackEntries = getRackPdoEntries(0);
  const inputEntries = rackEntries.filter(e => e.dir === 'input');
  const outputEntries = rackEntries.filter(e => e.dir === 'output');
  if (productId !== null) om.discoveredRack = { productId, inputEntries, outputEntries };

  const allocations = allocateRackEntries(om.cards, inputEntries, outputEntries);
  const cards = om.cards.map(card => {
    const alloc = allocations.get(card.slot)!;
    if (alloc.status === 'missing') {
      warnings.push(`${card.model} in slot ${card.slot}: coupler doesn't expose enough PDO entries for it — missing module, or an earlier-slot card is claiming entries that belong to it`);
    }
    return { ...card, actual: coupler.name, status: alloc.status, pdoEntries: alloc.pdoEntries };
  });

  // PDO-count allocation (above) can accept the wrong card if it's the same
  // category/width as the one expected — it has no notion of slot identity.
  // Cross-check against 0xF050 for every model we have a confirmed ident
  // for; a mismatch overrides an otherwise-"ok" allocation.
  const identifiedCards = cards.map(card => {
    if (card.status !== 'ok') return card;
    const expectedIdent = NX_CARD_IDENTS[card.model];
    const actualIdent = getSlotModuleIdent(card.slot);
    if (expectedIdent === undefined) {
      // no confirmed ident for this model — can't verify beyond PDO-count allocation, but surface what the bus reports so it can be added
      if (actualIdent !== null) warnings.push(`${card.model} in slot ${card.slot}: identity not in the verified table (bus reports 0x${actualIdent.toString(16).padStart(8, '0')}) — add to NX_CARD_IDENTS once confirmed`);
      return card;
    }
    if (actualIdent === null) {
      warnings.push(`${card.model} in slot ${card.slot}: could not read module identity (0xF050) to verify — relying on PDO-count allocation only`);
      return card;
    }
    if (actualIdent !== expectedIdent) {
      warnings.push(`${card.model} in slot ${card.slot}: module identity 0x${actualIdent.toString(16)} does not match expected 0x${expectedIdent.toString(16)} — wrong card in this slot`);
      return { ...card, status: 'mismatch' as const };
    }
    return card;
  });

  return { cards: identifiedCards, warnings };
}

/** Cheap, poll-safe rack presence check for the watchdog — same coupler-
 * presence + PDO-entry-count check as verifyEthercatRack() above, but never
 * touches om.discoveredRack or card.pdoEntries — only a full Read Rack
 * refreshes those.
 *
 * If the master itself can't be reached, that's treated as every card going
 * missing (can't verify == can't trust), not silently skipped — losing the
 * ability to check the rack at all is worse than a single wrong card, and the
 * watchdog must fail safe, not fail silent. */
export function checkRackPresence(om: OmronConfig): { cards: IoRackCard[]; unreachable?: string } {
  const master = getMasterStatus();
  if (!master.toolAvailable) {
    return {
      cards: om.cards.map(c => ({ ...c, actual: undefined, status: 'missing' as const })),
      unreachable: master.error ?? 'unknown reason',
    };
  }

  const slaves = listSlaves();
  const coupler = slaves.find(s => s.position === 0);
  if (!coupler) return { cards: om.cards.map(c => ({ ...c, actual: undefined, status: 'missing' as const })) };
  const expectedCoupler = om.eccModel.replace('NX-', '');
  if (!coupler.name.toUpperCase().includes(expectedCoupler)) {
    return { cards: om.cards.map(c => ({ ...c, actual: coupler.name, status: 'mismatch' as const })) };
  }

  const rackEntries = getRackPdoEntries(0);
  const inputEntries = rackEntries.filter(e => e.dir === 'input');
  const outputEntries = rackEntries.filter(e => e.dir === 'output');
  const allocations = allocateRackEntries(om.cards, inputEntries, outputEntries);
  return {
    cards: om.cards.map(card => ({ ...card, actual: coupler.name, status: allocations.get(card.slot)!.status })),
  };
}

// Analog (AI/AO) and load-cell (SCALE) channels need a per-model confirmed
// PDO map, engineering range/encoding and failure behavior — unlike a
// digital point, a wrong assumption here can silently report or command
// the wrong physical quantity rather than just failing to toggle. Nothing
// is listed yet: no analog or RS1201 card has been bench-verified. Add a
// model here only once its actual PDO map and scaling are confirmed
// against the installed module (see ethercat-io-audit.md's P1 analog
// finding). Now populated from W522 (NX-AD/DA) and W565 (NX-RS1201): PDO maps and
// raw scaling are taken from the manuals; NOT yet bench-tested — until then, generateIoConf excludes it from io.conf entirely
// rather than generating a channel against an unverified guess.
const VERIFIED_ANALOG_MODELS = new Set<string>([
  'NX-AD2203', 'NX-AD3203', 'NX-AD4203', 'NX-AD4603', 'NX-DA2203', 'NX-DA3203', 'NX-DA3603', 'NX-RS1201',
]);

/** Builds the io_daemon's full channel config from every signal currently
 * mapped to a rack address (see buildSignals() in mill.ts) — the daemon has
 * no hand-maintained channel list of its own; the HMI's I/O Config and the
 * verified rack are the single source of truth for what's wired where. A
 * signal is marked for edge-counting ("count") when some equipment has it
 * assigned as rotationPulseInput. The whole rack is ONE EtherCAT slave
 * (position 0, the coupler) — om.discoveredRack's product ID and PDO entry
 * lists, from the last Read Rack, get re-sliced against the CURRENT card
 * list here every time (allocateRackEntries), not cached per card. Nothing
 * discovered yet at all just produces one warning telling the operator to
 * run Read Rack. */
export function generateIoConf(
  om: OmronConfig, signals: Iterable<SignalDef>, equipment: Iterable<EquipmentRuntime>, scaleConfigs: Iterable<ScaleConfig>,
): { conf: string; warnings: string[] } {
  const warnings: string[] = [];
  const channelLines: string[] = [];

  if (!om.discoveredRack) {
    const anyRackCards = om.cards.some(c => NX_CARD_CATALOG.find(d => d.model === c.model)?.category !== 'power');
    const anyScale = Array.from(scaleConfigs).some(sc => sc.connectionType === 'rs1201');
    if (anyRackCards || anyScale) warnings.push('Run Read Rack once — no PDO map discovered for this coupler yet');
    const lines = ['# auto-generated by feedmill-backend from the rack + I/O config — do not hand-edit', `cycle_us ${om.cycleTimeUs}`];
    return { conf: lines.join('\n') + '\n', warnings };
  }

  const { productId, inputEntries, outputEntries } = om.discoveredRack;
  const allocations = allocateRackEntries(om.cards, inputEntries, outputEntries);
  const vid = OMRON_VENDOR_ID.toString(16).padStart(8, '0');
  const pid = productId.toString(16).padStart(8, '0');
  const slaveLine = `slave 0 0x${vid} 0x${pid}`; // the whole rack is one EtherCAT slave: the coupler

  for (const sc of scaleConfigs) {
    if (sc.connectionType !== 'rs1201') continue;
    const card = om.cards.find(c => c.slot === sc.rackSlot);
    if (!card) { warnings.push(`${sc.name}: no card in slot ${sc.rackSlot}`); continue; }
    const def = NX_CARD_CATALOG.find(d => d.model === card.model);
    if (!def || def.category !== 'scale') { warnings.push(`${sc.name}: ${card.model} is not a load cell card`); continue; }
    if (!VERIFIED_ANALOG_MODELS.has(card.model)) { warnings.push(`${sc.name}: ${card.model} is not yet bench-verified for production use — excluded from io.conf (see ethercat-io-audit.md)`); continue; }
    const alloc = allocations.get(card.slot);
    if (!alloc || alloc.status !== 'ok' || !alloc.pdoEntries) { warnings.push(`${sc.name}: ${card.model} in slot ${sc.rackSlot} — not enough PDO entries discovered; re-run Read Rack`); continue; }
    // W565: entries[2] is 0x6002:01 Gross Weight DINT (already calibrated inside the unit); entries[0] is 0x6000:01 Detection Status (WORD)
    const [st, , wt] = alloc.pdoEntries;
    const hex = (e: PdoEntry) => `0x${e.index.toString(16).padStart(4, '0')} 0x${e.subindex.toString(16).padStart(2, '0')}`;
    channelLines.push(`channel SC:${sc.id} 0 SCALE ${hex(wt)} 0`);
    channelLines.push(`channel SS:${sc.id} 0 AI ${hex(st)} 0`); // detection status word: bits 0-3 = sensor disconnected / under / over / ADC error
  }

  const rotationSignals = new Set(
    Array.from(equipment, eq => eq.config.rotationPulseInput as string | undefined).filter((s): s is string => !!s),
  );

  for (const sig of signals) {
    const m = /^(I|O|AI|AO):(\d+)\.(\d+)$/.exec(sig.id);
    if (!m) continue; // not a rack address (e.g. the generic DO-n/DI-n pool before a rack is configured)
    const slot = Number(m[2]);
    const point = Number(m[3]);
    const card = om.cards.find(c => c.slot === slot);
    if (!card) { warnings.push(`${sig.id}: no card in slot ${slot}`); continue; }
    const def = NX_CARD_CATALOG.find(d => d.model === card.model);
    if (!def || def.category !== sig.direction) { warnings.push(`${sig.id}: ${card.model} is not a ${sig.direction} card`); continue; }
    if ((sig.direction === 'AI' || sig.direction === 'AO') && !VERIFIED_ANALOG_MODELS.has(card.model)) {
      warnings.push(`${sig.id}: ${card.model} is not yet bench-verified for production use — excluded from io.conf (see ethercat-io-audit.md)`);
      continue;
    }
    const alloc = allocations.get(slot);
    if (!alloc || alloc.status !== 'ok' || !alloc.pdoEntries) { warnings.push(`${sig.id}: ${card.model} in slot ${slot} — not enough PDO entries discovered; re-run Read Rack`); continue; }

    // Digital cards pack every point into the ONE entry they were allocated,
    // addressed as a bit within it; analog cards get one entry PER point.
    const isDigital = sig.direction === 'DI' || sig.direction === 'DO';
    // Walk the card's entries: a packed word holds many points, 1-bit BOOL entries one each.
    let entry: PdoEntry | undefined, bit = 0;
    if (isDigital) {
      bit = point;
      for (const e of alloc.pdoEntries) {
        if (bit < e.bits) { entry = e; break; }
        bit -= e.bits;
      }
    } else entry = alloc.pdoEntries[point];
    if (!entry) { warnings.push(`${sig.id}: ${card.model}'s allocated PDO entries have nothing for point ${point}`); continue; }

    const index = entry.index.toString(16).padStart(4, '0');
    const subindex = entry.subindex.toString(16).padStart(2, '0');
    const countFlag = sig.direction === 'DI' && rotationSignals.has(sig.id) ? ' count' : '';
    channelLines.push(`channel ${sig.id} 0 ${sig.direction} 0x${index} 0x${subindex} ${bit}${countFlag}`);
  }

  const lines = [
    '# auto-generated by feedmill-backend from the rack + I/O config — do not hand-edit',
    `cycle_us ${om.cycleTimeUs}`,
    slaveLine,
    ...channelLines,
  ];
  return { conf: lines.join('\n') + '\n', warnings };
}

/** Writes the generated conf (if it changed) and restarts the daemon so it
 * picks up the new channel list — ecrt can't add PDO registrations to an
 * already-activated master, so a restart is required, not just a reload.
 * No-ops quietly when /etc isn't writable or systemctl/the unit aren't
 * present (dev machine, or not installed yet) — this is best-effort. Write
 * is tmp+rename so a hard power-off never leaves a half-written conf file
 * for the daemon to choke on. */
export function syncIoConf(
  om: OmronConfig, signals: Iterable<SignalDef>, equipment: Iterable<EquipmentRuntime>, scaleConfigs: Iterable<ScaleConfig>,
): string[] {
  const { conf, warnings } = generateIoConf(om, signals, equipment, scaleConfigs);
  try {
    const current = existsSync(IO_CONF_PATH) ? readFileSync(IO_CONF_PATH, 'utf8') : null;
    if (current !== conf) {
      const tmp = `${IO_CONF_PATH}.tmp`;
      writeFileSync(tmp, conf, 'utf8');
      renameSync(tmp, IO_CONF_PATH);
      try {
        // Calling systemctl directly here goes through polkit (not sudo), which
        // refuses an unattended non-root caller with "Interactive authentication
        // required" -- install.sh's NOPASSWD sudoers grant is for exactly this
        // command, so it must actually be invoked via sudo to take effect.
        execFileSync('sudo', ['-n', '/bin/systemctl', 'restart', 'feedmill-io-daemon.service'], { timeout: 3000 });
      } catch {
        // dev machine, daemon not installed, or this process lacks permission to manage the service
      }
    }
  } catch {
    // e.g. /etc/feedmill isn't writable here (dev machine) — nothing generated
  }
  return warnings;
}

// ── NX-RS1201 calibration over CoE SDO (W565 §6-2 / §7-4; W519 A-7-3) ──
// The calibration objects (0x7001 SID, 0x7002 command, 0x7003 REAL data, 0x600A
// response SID, 0x600B response) aren't in the default PDO map, so they're
// reached by SDO at the coupler's per-unit shifted index: base + (unit-1)*0x20.
// UNVERIFIED on hardware (SDO access to these NX objects through the coupler,
// and `ethercat download -t float`). Blocks the event loop while it runs
// (same shortcut as runEthercat above) — an explicit operator action, ~<1s.
export type ScaleCalStep = { cmd: number; data?: number };

const RS1201_CAL_ERRORS: Record<number, string> = {
  1: 'unit rejected the calibration command',
  2: 'calibration data out of range',
  3: 'unit cannot accept calibration now (sensor disconnection test running, calibration busy, or AD conversion error)',
  4: 'calibration failed (AD error, over/under range during calibration, or non-volatile write failed)',
};

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function runRs1201Calibration(unit: number, steps: ScaleCalStep[]): { ok: boolean; error?: string } {
  const at = (base: number) => '0x' + (base + (unit - 1) * 0x20).toString(16);
  const write = (type: 'uint16' | 'float', base: number, v: number) =>
    runEthercat(['download', '-p', '0', '-t', type, at(base), '1', String(v)]);
  const waitSid = (sid: number): boolean => {
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
      const r = sdoUpload('uint16', at(0x600a), '1');
      if (r === sid) return true;
      sleepMs(20);
    }
    return false;
  };

  let w = write('uint16', 0x7001, 0); // reset SID to 0 first (W565: response SID must follow)
  if (w.out === null) return { ok: false, error: w.error };
  if (!waitSid(0)) return { ok: false, error: 'calibration SID did not reset (is the unit in message-enabled/operational state?)' };

  let sid = 0;
  for (const step of steps) {
    sid = sid % 255 + 1; // 1..255, wraps back to 1
    if (step.data !== undefined) { w = write('float', 0x7003, step.data); if (w.out === null) return { ok: false, error: w.error }; }
    w = write('uint16', 0x7002, step.cmd); if (w.out === null) return { ok: false, error: w.error };
    w = write('uint16', 0x7001, sid); if (w.out === null) return { ok: false, error: w.error };
    if (!waitSid(sid)) return { ok: false, error: `no response to calibration command 0x${step.cmd.toString(16)} within 1 s` };
    const resp = sdoUpload('uint16', at(0x600b), '1');
    if (resp !== 0) return { ok: false, error: `command 0x${step.cmd.toString(16)}: ${RS1201_CAL_ERRORS[resp ?? -1] ?? `response ${resp}`}` };
  }
  return { ok: true };
}
