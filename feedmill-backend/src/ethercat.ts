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
};

// shortcut: `ethercat upload`'s exact output format for a uint32 SDO
// wasn't re-verified against a live box in this pass (only the 0xF050
// index:subindex scheme itself was, via the user's own bench tool) —
// Number() parses either a bare decimal or a "0x"-prefixed hex string, so
// this should survive either convention, but if getSlotModuleIdent always
// returns null on real hardware, check the raw CLI output here first.
function getSlotModuleIdent(slot: number): number | null {
  const { out } = runEthercat(['upload', '-p', '0', '-t', 'uint32', '0xf050', String(slot)]);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
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
function allocateRackEntries(cards: IoRackCard[], inputEntries: PdoEntry[], outputEntries: PdoEntry[]): Map<number, SlotAllocation> {
  const sorted = [...cards].sort((a, b) => a.slot - b.slot);
  let inIdx = 0, outIdx = 0;
  const bySlot = new Map<number, SlotAllocation>();
  for (const card of sorted) {
    const def = NX_CARD_CATALOG.find(d => d.model === card.model);
    if (!def) { bySlot.set(card.slot, { status: 'mismatch' }); continue; }
    if (def.category === 'power') { bySlot.set(card.slot, { status: 'ok' }); continue; }
    const isInput = def.category === 'DI' || def.category === 'AI' || def.category === 'scale';
    const take = def.category === 'DI' || def.category === 'DO' ? 1 : def.points;
    const pool = isInput ? inputEntries : outputEntries;
    const start = isInput ? inIdx : outIdx;
    const slice = pool.slice(start, start + take);
    if (isInput) inIdx += take; else outIdx += take;
    bySlot.set(card.slot, slice.length === take ? { status: 'ok', pdoEntries: slice } : { status: 'missing' });
  }
  return bySlot;
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
  if (master.phase && !/op\b/i.test(master.phase)) {
    warnings.push(`EtherCAT master phase is "${master.phase}", not Operational`);
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
    if (expectedIdent === undefined) return card; // no confirmed ident for this model — can't verify beyond PDO-count allocation
    const actualIdent = getSlotModuleIdent(card.slot);
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
// finding) — until then, generateIoConf excludes it from io.conf entirely
// rather than generating a channel against an unverified guess.
const VERIFIED_ANALOG_MODELS = new Set<string>([]);

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
    // RS1201 convention, unverified: the weight value is the card's one allocated entry.
    const entry = alloc.pdoEntries[0];
    const idx = entry.index.toString(16).padStart(4, '0');
    const sub = entry.subindex.toString(16).padStart(2, '0');
    channelLines.push(`channel SC:${sc.id} 0 SCALE 0x${idx} 0x${sub} 0`);
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
    const entry = isDigital ? alloc.pdoEntries[0] : alloc.pdoEntries[point];
    if (!entry) { warnings.push(`${sig.id}: ${card.model}'s allocated PDO entries have nothing for point ${point}`); continue; }
    const bit = isDigital ? point : 0;

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
