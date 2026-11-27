import { readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import type { IoRackCard, SignalDef, SignalValue } from './types.js';
import { NX_CARD_CATALOG } from './types.js';

const STATE_PATH = process.env.FEEDMILL_IO_STATE_PATH ?? '/run/feedmill/io-state.json';
const COMMAND_PATH = process.env.FEEDMILL_IO_COMMAND_PATH ?? '/run/feedmill/io-command.txt';
const STALE_MS = 500; // the daemon's writer thread refreshes every 20ms; anything older means it isn't running

// Raw-count scaling per W522 (NX-AD/DA, 1/8000-resolution "xx03" models): 4-20mA
// maps 0..8000 and +-10V maps -4000..+4000; the catalog's fullScale is the
// count at 100% (0-10V half for the voltage cards, since mill.ts commands 0-100%).
// Assumes each channel keeps its factory default range (4-20mA / +-10V) — a
// different Ch Range Setting (0x5003) on the card would change the scale.
const DEFAULT_FULL_SCALE = 8000;
export const NX_ANALOG_DISCONNECT_RAW = 32767; // W522 §6-2: AI reads 32767 when a 4-20mA input is below 1.2mA (wire break)
const fullScaleFor = (sigId: string, cards: IoRackCard[]): number => {
  const slot = Number(/^A[IO]:(\d+)\./.exec(sigId)?.[1]);
  const model = cards.find(c => c.slot === slot)?.model;
  return NX_CARD_CATALOG.find(d => d.model === model)?.fullScale ?? DEFAULT_FULL_SCALE;
};
export const pctToRaw = (pct: number, fullScale: number): number =>
  Math.round((Math.min(100, Math.max(0, pct)) / 100) * fullScale);
export const rawToPct = (raw: number, fullScale: number): number => (raw / fullScale) * 100;
export { fullScaleFor };

export interface RotationChannelState {
  count: number;
  lastEdgeUs: number;
  intervalUs: number; // time between the last two edges, in the daemon's own clock; 0 until a 2nd edge arrives
}

interface IoStateFile {
  atUs: number; // daemon's CLOCK_MONOTONIC at write time -- compare only against other *Us fields from this same file, never against Date.now()
  daemonStartUs: number; // changes across a daemon restart; callers use this to detect one (see mill.ts's updateBusHealth)
  healthy: boolean; // per-cycle bus validity (link up + complete working counter) -- false means inputs/rotation below are frozen at last-good, not live
  inputs: Record<string, SignalValue>;
  rotation: Record<string, RotationChannelState>;
  missing?: string[]; // configured signals whose PDO entry the daemon couldn't register (absent from a daemon older than 0.1.28)
}

/**
 * Reads the io_daemon's state file (ethercat-rt/io_daemon.c). That program
 * runs its own EtherCAT cyclic loop and reads every configured input each
 * cycle; this just reads its latest snapshot. Returns null when the daemon
 * isn't running, hasn't written recently, or isn't installed (dev machine)
 * — callers must treat null as "no data", never fabricate a reading.
 */
export function readIoState(): IoStateFile | null {
  try {
    const stat = statSync(STATE_PATH);
    if (Date.now() - stat.mtimeMs > STALE_MS) return null;
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as IoStateFile;
  } catch {
    return null;
  }
}

let seq = 0;

/**
 * Writes every DO/AO signal's desired value for the io_daemon to apply on
 * its next cycle. Analog values are converted from the engineering-unit
 * percentages mill.ts works in to the daemon's raw PDO counts (see
 * fullScaleFor above). Always writes (tmp+rename) even when the
 * commanded values are unchanged, with an incrementing `seq` as the first
 * line: io_daemon.c's reader thread treats that sequence number, not the
 * file's mtime, as its liveness heartbeat (mtime is only 1-second
 * resolution, which can hide a command that changes twice in the same
 * second) and force-zeros every output after 2s without it advancing.
 */
export function writeIoCommand(outputs: Record<string, SignalValue>, signals: SignalDef[], cards: IoRackCard[]): void {
  const lines: string[] = [`seq ${++seq}`];
  for (const sig of signals) {
    if (sig.direction !== 'DO' && sig.direction !== 'AO') continue;
    const v = outputs[sig.id];
    if (v === undefined) continue;
    const raw = sig.direction === 'DO' ? (v ? 1 : 0) : pctToRaw(v as number, fullScaleFor(sig.id, cards));
    lines.push(`output ${sig.id} ${raw}`);
  }
  const text = lines.join('\n') + '\n';
  try {
    const tmp = `${COMMAND_PATH}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, COMMAND_PATH);
  } catch {
    // e.g. /run/feedmill isn't writable here (dev machine, daemon not installed) — nothing to apply anyway
  }
}
