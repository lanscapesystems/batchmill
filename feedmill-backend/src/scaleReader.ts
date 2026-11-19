import { SerialPort } from 'serialport';
import type { Mill } from './mill.js';
import type { ScaleConfig } from './types.js';
import { readIoState } from './ioDaemon.js';

const DEFAULT_WEIGHT_REGEX = '[+-]?\\d+\\.?\\d*';
const RS1201_POLL_MS = 100;

interface Reader {
  key: string; // config fields that define the connection — reader restarts when this changes
  close: () => void;
}

const readers = new Map<string, Reader>();

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

  const markStaleLoop = setInterval(() => {
    if (Date.now() - lastValidAt > cfg.freshnessTimeout) mill.setScale(cfg.id, 0, false, false);
  }, Math.max(250, cfg.freshnessTimeout / 2));

  try {
    const re = new RegExp(cfg.weightRegex || DEFAULT_WEIGHT_REGEX);
    port = new SerialPort({
      path: cfg.comPort, baudRate: cfg.baudRate,
      dataBits: cfg.dataBits as 5 | 6 | 7 | 8, parity: cfg.parity, stopBits: cfg.stopBits as 1 | 1.5 | 2,
    });
    port.on('data', (chunk: Buffer) => {
      buf += chunk.toString('ascii');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = re.exec(line);
        if (!m) continue;
        const weight = Number(m[0]);
        if (!Number.isFinite(weight)) continue;
        lastValidAt = Date.now();
        mill.setScale(cfg.id, weight, stable(weight, lastValidAt), true);
      }
    });
    port.on('error', () => { /* reconcile will retry on the next config check; no crash */ });
  } catch {
    // port failed to open (not present, wrong name) — scale just stays stale/invalid, no fault from here
  }

  return () => { clearInterval(markStaleLoop); try { port?.close(); } catch {} };
}

// ── RS1201: weight PDO read via the io_daemon's cyclic state file ──
//
// UNVALIDATED: the raw-counts-to-weight formula below (zeroOffset/ratedMvV)
// has not been checked against a real NX-RS1201. The W565 manual's
// program-driven calibration handshake (Ch1 Calibration Command/Data,
// polling the Response SID) is NOT implemented — do this via the HMI's
// commissioning workflow once the module is on the bench, then replace
// this formula with the module's own calibrated zero/span.
function startRs1201Reader(mill: Mill, cfg: ScaleConfig): () => void {
  const stable = makeStabilityTracker(cfg);
  const signalId = `SC:${cfg.id}`;
  const timer = setInterval(() => {
    const state = readIoState();
    const raw = state?.inputs[signalId];
    if (typeof raw !== 'number') {
      mill.setScale(cfg.id, 0, false, false); // io_daemon not running, or this scale not in its config yet
      return;
    }
    const weight = (raw - cfg.zeroOffset) * cfg.ratedMvV;
    const now = Date.now();
    mill.setScale(cfg.id, weight, stable(weight, now), true);
  }, RS1201_POLL_MS);
  return () => clearInterval(timer);
}
