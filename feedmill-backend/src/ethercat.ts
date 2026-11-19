import { execFileSync } from 'child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import type { OmronConfig, IoRackCard, EquipmentRuntime, SignalDef, ScaleConfig } from './types.js';
import {
  NX_CARD_CATALOG, NX_DI_PDO, NX_DO_PDO, NX_AI_PDO, NX_AO_PDO, NX_RS1201_PDO,
  NX_CARD_PRODUCT_ID, OMRON_VENDOR_ID,
} from './types.js';

const IO_CONF_PATH = process.env.FEEDMILL_IO_CONF_PATH ?? '/etc/feedmill/io.conf';
const PDO_BY_DIRECTION = { DI: NX_DI_PDO, DO: NX_DO_PDO, AI: NX_AI_PDO, AO: NX_AO_PDO };

export interface EthercatMasterStatus {
  toolAvailable: boolean;
  phase?: string;
  linkUp?: boolean;
  slaveCount?: number;
}

export interface EthercatSlave {
  position: number;
  state: string;
  name: string;
}

function runEthercat(args: string[]): string | null {
  try {
    return execFileSync('ethercat', args, { encoding: 'utf8', timeout: 3000 });
  } catch {
    return null;
  }
}

// shortcut: parses the default IgH `ethercat` CLI text format (tested against documented
// `ethercat master`/`ethercat slaves` samples, not live hardware). If the installed IgH
// version's column layout differs, update these regexes against `ethercat --version`.
export function getMasterStatus(): EthercatMasterStatus {
  const out = runEthercat(['master']);
  if (out === null) return { toolAvailable: false };
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
  const out = runEthercat(['slaves']);
  if (out === null) return [];
  const slaves: EthercatSlave[] = [];
  for (const line of out.split('\n')) {
    // one-line-per-slave default format: "<pos>  <alias>:<pos>  <state>  <flag>  <name>"
    const m = /^\s*(\d+)\s+\S+\s+(\S+)\s+\S\s+(.+?)\s*$/.exec(line);
    if (m) slaves.push({ position: Number(m[1]), state: m[2], name: m[3] });
  }
  return slaves;
}

/** Real rack verification via the IgH `ethercat` CLI, with a simulated echo fallback
 * when the tool isn't installed (dev machine, or master not set up yet on the target). */
export function verifyEthercatRack(om: OmronConfig): { cards: IoRackCard[]; warnings: string[] } {
  const master = getMasterStatus();
  if (!master.toolAvailable) {
    return {
      cards: om.cards.map(c => ({ ...c, actual: c.model, status: 'ok' as const })),
      warnings: ['ethercat master tool not found on this host — showing simulated rack, not a live read'],
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
  const coupler = slaves[0];
  if (!coupler) {
    warnings.push('No EtherCAT slaves detected on the bus');
    return { cards: om.cards.map(c => ({ ...c, status: 'missing' as const })), warnings };
  }
  const expectedCoupler = om.eccModel.replace('NX-', '');
  if (!coupler.name.toUpperCase().includes(expectedCoupler)) {
    warnings.push(`Coupler at position 0 reports "${coupler.name}", expected ${om.eccModel}`);
  }

  const cards: IoRackCard[] = om.cards.map((card, i) => {
    const slave = slaves[i + 1]; // position 0 is the coupler itself
    if (!slave) return { ...card, actual: undefined, status: 'missing' as const };
    const matches = slave.name.toUpperCase().includes(card.model.toUpperCase());
    return { ...card, actual: slave.name, status: matches ? 'ok' as const : 'mismatch' as const };
  });

  return { cards, warnings };
}

/** Builds the io_daemon's full channel config from every signal currently
 * mapped to a rack address (see buildSignals() in mill.ts) — the daemon has
 * no hand-maintained channel list of its own; the HMI's I/O Config and the
 * verified rack are the single source of truth for what's wired where. A
 * signal is marked for edge-counting ("count") when some equipment has it
 * assigned as rotationPulseInput. */
export function generateIoConf(
  om: OmronConfig, signals: Iterable<SignalDef>, equipment: Iterable<EquipmentRuntime>, scaleConfigs: Iterable<ScaleConfig>,
): { conf: string; warnings: string[] } {
  const warnings: string[] = [];
  const slaveLines = new Map<number, string>();
  const channelLines: string[] = [];

  const addSlave = (slot: number, productId: number) => {
    if (slaveLines.has(slot)) return;
    const vid = OMRON_VENDOR_ID.toString(16).padStart(8, '0');
    const pid = productId.toString(16).padStart(8, '0');
    slaveLines.set(slot, `slave ${slot} 0x${vid} 0x${pid}`);
  };

  for (const sc of scaleConfigs) {
    if (sc.connectionType !== 'rs1201') continue;
    const card = om.cards.find(c => c.slot === sc.rackSlot);
    if (!card) { warnings.push(`${sc.name}: no card in slot ${sc.rackSlot}`); continue; }
    const def = NX_CARD_CATALOG.find(d => d.model === card.model);
    if (!def || def.category !== 'scale') { warnings.push(`${sc.name}: ${card.model} is not a load cell card`); continue; }
    const productId = NX_CARD_PRODUCT_ID[card.model];
    if (productId === undefined) { warnings.push(`${sc.name}: ${card.model} has no known EtherCAT product ID`); continue; }
    addSlave(sc.rackSlot, productId);
    const idx = NX_RS1201_PDO.weightIndex.toString(16).padStart(4, '0');
    const sub = NX_RS1201_PDO.weightSubindex.toString(16).padStart(2, '0');
    channelLines.push(`channel SC:${sc.id} ${sc.rackSlot} SCALE 0x${idx} 0x${sub}`);
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
    const productId = NX_CARD_PRODUCT_ID[card.model];
    if (productId === undefined) { warnings.push(`${sig.id}: ${card.model} has no known EtherCAT product ID (add it to NX_CARD_PRODUCT_ID)`); continue; }

    addSlave(slot, productId);
    const pdo = PDO_BY_DIRECTION[sig.direction];
    const subindex = (pdo.subindexBase + point).toString(16).padStart(2, '0');
    const index = pdo.pdoIndex.toString(16).padStart(4, '0');
    const countFlag = sig.direction === 'DI' && rotationSignals.has(sig.id) ? ' count' : '';
    channelLines.push(`channel ${sig.id} ${slot} ${sig.direction} 0x${index} 0x${subindex}${countFlag}`);
  }

  const lines = [
    '# auto-generated by feedmill-backend from the rack + I/O config — do not hand-edit',
    `cycle_us ${om.cycleTimeUs}`,
    ...slaveLines.values(),
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
        execFileSync('systemctl', ['restart', 'feedmill-io-daemon.service'], { timeout: 3000 });
      } catch {
        // dev machine, daemon not installed, or this process lacks permission to manage the service
      }
    }
  } catch {
    // e.g. /etc/feedmill isn't writable here (dev machine) — nothing generated
  }
  return warnings;
}
