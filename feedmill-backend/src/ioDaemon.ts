import { readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import type { SignalDef, SignalValue } from './types.js';

const STATE_PATH = process.env.FEEDMILL_IO_STATE_PATH ?? '/run/feedmill/io-state.json';
const COMMAND_PATH = process.env.FEEDMILL_IO_COMMAND_PATH ?? '/run/feedmill/io-command.txt';
const STALE_MS = 500; // the daemon's writer thread refreshes every 20ms; anything older means it isn't running

// Omron NX analog I/O's commonly documented unipolar raw-count convention
// (0 = 0%, 27648 = 100%) — PLACEHOLDER. The real scale depends on each
// module's configured range (4-20mA vs 0-20mA, unipolar vs ±10V bipolar);
// confirm against the actual module config before trusting this for
// anything beyond bench testing.
const NX_ANALOG_FULL_SCALE = 27648;
export const pctToRaw = (pct: number): number => Math.round((pct / 100) * NX_ANALOG_FULL_SCALE);
export const rawToPct = (raw: number): number => (raw / NX_ANALOG_FULL_SCALE) * 100;

export interface RotationChannelState {
  count: number;
  lastEdgeUs: number;
}

interface IoStateFile {
  atUs: number;
  inputs: Record<string, SignalValue>;
  rotation: Record<string, RotationChannelState>;
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

let lastWritten: string | null = null;

/**
 * Writes every DO/AO signal's desired value for the io_daemon to apply on
 * its next cycle. Analog values are converted from the engineering-unit
 * percentages mill.ts works in to the daemon's raw PDO counts (see
 * NX_ANALOG_FULL_SCALE above). Skips the write entirely when nothing
 * changed, and otherwise writes tmp+rename — a hard power-off must never
 * leave the daemon reading a half-written command file.
 */
export function writeIoCommand(outputs: Record<string, SignalValue>, signals: SignalDef[]): void {
  const lines: string[] = [];
  for (const sig of signals) {
    if (sig.direction !== 'DO' && sig.direction !== 'AO') continue;
    const v = outputs[sig.id];
    if (v === undefined) continue;
    const raw = sig.direction === 'DO' ? (v ? 1 : 0) : pctToRaw(v as number);
    lines.push(`output ${sig.id} ${raw}`);
  }
  const text = lines.join('\n') + '\n';
  if (text === lastWritten) return;
  try {
    const tmp = `${COMMAND_PATH}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, COMMAND_PATH);
    lastWritten = text;
  } catch {
    // e.g. /run/feedmill isn't writable here (dev machine, daemon not installed) — nothing to apply anyway
  }
}
