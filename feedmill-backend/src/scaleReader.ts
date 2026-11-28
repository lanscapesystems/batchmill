import { existsSync, readFileSync } from 'fs';
import { SerialPort } from 'serialport';
import type { Mill } from './mill.js';
import type { ScaleConfig } from './types.js';
import { readIoState } from './ioDaemon.js';

const DEFAULT_WEIGHT_REGEX = '[+-]?\\d+\\.?\\d*';
const RS1201_POLL_MS = 100;
const SERIAL_RETRY_MS = 3000;

interface Reader {
  key: string; // config fields that define the connection — reader restarts when this changes
  close: () => void;
}

const readers = new Map<string, Reader>();

export interface SerialPortOption { path: string; label: string }

const SIM_LINK = '/tmp/ttyScale'; // tools/scale-sim.py's default; a pty, so udev never lists it

// /sys type 0 = a ttyS node with no UART behind it (Linux creates ~32 of them)
const uartType = (name: string): string => { try { return readFileSync(`/sys/class/tty/${name}/type`, 'utf8').trim(); } catch { return ''; } };

export function toPortOptions(
  ports: { path: string; pnpId?: string; manufacturer?: string }[], readType = uartType,
): SerialPortOption[] {
  return ports
    .filter(p => !(p.path.startsWith('/dev/ttyS') && readType(p.path.slice('/dev/'.length)) === '0'))
    .map(p => {
      // by-id survives reboots and replugging; ttyUSB numbers don't, which could swap two scales
      // shortcut: identical adapters without a serial number share one by-id name; use /dev/serial/by-path if that occurs
      const byId = p.path.startsWith('/dev/') && p.pnpId ? `/dev/serial/by-id/${p.pnpId}` : '';
      return { path: byId || p.path, label: [p.path, p.manufacturer, p.pnpId].filter(Boolean).join(' — ') };
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export async function listSerialPorts(): Promise<SerialPortOption[]> {
  const options = toPortOptions(await SerialPort.list());
  if (existsSync(SIM_LINK)) options.push({ path: SIM_LINK, label: `${SIM_LINK} — scale simulator` });
  return options;
}

function configKey(cfg: ScaleConfig): string {
  return JSON.stringify(cfg);
}

/** Starts/stops/restarts per-scale readers to match the given configs. Call
 * once at startup with the initial scaleConfigs, and again after any
 * ConfigureScale/RemoveScale command — cheap no-op when nothing changed. */
export function reconcileScaleReaders(mill: Mill, configs: ScaleConfig[]): void {
  const liveIds = new Set(configs.map(c => c.id));
  for (const [id, r] of readers) {
    if (!liveIds.has(id)) { r.close(); readers.delete(id); }
  }
  for (const cfg of configs) {
    const key = configKey(cfg);
    const existing = readers.get(cfg.id);
    if (existing?.key === key) continue;
    existing?.close();
    readers.set(cfg.id, {
      key,
      close: cfg.connectionType === 'serial' ? startSerialReader(mill, cfg) : startRs1201Reader(mill, cfg),
    });
  }
}

// ── stability/freshness tracking, shared by both connection types ──

function makeStabilityTracker(cfg: ScaleConfig) {
  let history: { t: number; w: number }[] = [];
  return (weight: number, now: number) => {
    history.push({ t: now, w: weight });
    history = history.filter(h => now - h.t <= cfg.stabilityWindow);
    const spread = Math.max(...history.map(h => h.w)) - Math.min(...history.map(h => h.w));
    return spread <= Math.max(cfg.resolution, 0.0001);
  };
}

// ── serial: continuous-output ASCII scaleheads, format configured per ScaleConfig ──

function startSerialReader(mill: Mill, cfg: ScaleConfig): () => void {
  const stable = makeStabilityTracker(cfg);
  let lastValidAt = 0;
  let port: SerialPort | null = null;
  let buf = '';
  let closed = false;
  let retry: NodeJS.Timeout | null = null;
  const startedAt = Date.now();
  const faultAfterMs = Math.max(2000, cfg.freshnessTimeout || 0); // time to open the port and hear a first weight
  let portError = ''; // why the port last failed to open or closed
  const problem = () => !cfg.comPort ? 'no serial port selected'
    : portError ? `cannot read ${cfg.comPort}: ${portError}`
    : `no weight received on ${cfg.comPort} - check wiring, baud rate and weight format`;

  const markStaleLoop = setInterval(() => {
    const now = Date.now();
    if (now - lastValidAt > cfg.freshnessTimeout) mill.setScale(cfg.id, 0, false, false);
    if (now - Math.max(lastValidAt, startedAt) > faultAfterMs) mill.setScaleProblem(cfg.id, problem());
  }, Math.max(250, cfg.freshnessTimeout / 2));

  // Port missing / unplugged / errored: stay stale and re-open every few seconds.
  const scheduleRetry = () => {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = null; open(); }, SERIAL_RETRY_MS);
  };

  const open = () => {
    try {
      const re = new RegExp(cfg.weightRegex || DEFAULT_WEIGHT_REGEX);
      buf = '';
      const p = new SerialPort({
        path: cfg.comPort, baudRate: cfg.baudRate,
        dataBits: cfg.dataBits as 5 | 6 | 7 | 8, parity: cfg.parity, stopBits: cfg.stopBits as 1 | 1.5 | 2,
      });
      port = p;
      p.on('data', (chunk: Buffer) => {
        buf += chunk.toString('ascii');
        if (buf.length > 4096) buf = buf.slice(-256); // no line terminator ever arriving must not grow the buffer forever
        let nl: number;
        // LF or CR ends a line (some heads send CR only); blank pieces from CRLF are skipped by the regex miss
        while ((nl = buf.search(/[\r\n]/)) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const m = re.exec(line);
          if (!m) continue;
          const weight = Number(m[0]);
          if (!Number.isFinite(weight)) continue;
          lastValidAt = Date.now();
          mill.setScale(cfg.id, weight, stable(weight, lastValidAt), true);
          mill.setScaleProblem(cfg.id, '');
        }
      });
      // Always close with a callback: without one, closing a port that is not open emits 'error' again, and handling that
      // by closing looped until the backend ran out of memory.
      p.on('error', e => { portError = e.message; p.close(() => {}); scheduleRetry(); });
      p.on('close', (e?: Error) => { if (e) portError = e.message; scheduleRetry(); }); // e: unplugged
      p.on('open', () => {
        portError = '';
        if (closed) p.close(() => {}); // the scale was changed while the port was still opening
      });
    } catch (e) { // bad settings or weight pattern
      portError = (e as Error).message;
      scheduleRetry();
    }
  };
  open();

  return () => {
    closed = true; if (retry) clearTimeout(retry); clearInterval(markStaleLoop); port?.close(() => {});
    mill.setScaleProblem(cfg.id, '');
  };
}

// ── RS1201: weight PDO read via the io_daemon's cyclic state file ──
//
// W565: 0x6002:01 Gross Weight DINT is already zero/span-calibrated inside the
// unit (calibrate it with Sysmac Studio, not here) and is weight x 10^(decimal
// point position setting, default 0) — so with the unit's factory decimal
// position this is the weight in the calibrated unit. 0x6000:01 Detection
// Status bits 0-3 (sensor disconnected / under range / over range / ADC error)
// invalidate the reading. The program-driven calibration handshake (0x7xxx
// Calibration Command) is NOT implemented. Zero offset / mV/V settings in
// ScaleConfig are unused for RS1201 for the same reason.
function startRs1201Reader(mill: Mill, cfg: ScaleConfig): () => void {
  const stable = makeStabilityTracker(cfg);
  const signalId = `SC:${cfg.id}`;
  const timer = setInterval(() => {
    const state = readIoState();
    const raw = state?.inputs[signalId];
    // healthy === false: the daemon freezes inputs at last-good, so a stale weight would otherwise look live
    if (typeof raw !== 'number' || state?.healthy === false) {
      mill.setScale(cfg.id, 0, false, false); // io_daemon not running, bus down, or this scale not in its config yet
      return;
    }
    const status = state?.inputs[`SS:${cfg.id}`];
    const faulted = typeof status !== 'number' || (status & 0x0f) !== 0;
    const weight = raw;
    const now = Date.now();
    mill.setScale(cfg.id, weight, !faulted && stable(weight, now), !faulted);
  }, RS1201_POLL_MS);
  return () => clearInterval(timer);
}
