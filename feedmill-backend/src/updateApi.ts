import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { Express } from 'express';
import type { Mill } from './mill.js';

// The backend only STAGES an upload and asks systemd (via one fixed sudoers
// line) to start the root-owned feedmill-update.service. It never verifies,
// unpacks or runs the bundle itself — see install/apply-update.sh.
const STATE_DIR = process.env.FEEDMILL_STATE_DIR ?? '/var/lib/feedmill';
const STAGED = path.join(STATE_DIR, 'staging', 'update.zip');
const STATUS = path.join(STATE_DIR, 'update-status.json');
const ROOT = process.env.FEEDMILL_ROOT ?? '/opt/feedmill';
const PUBKEY = '/etc/feedmill-update/pubkey.pem';
const MAX_BYTES = 512 * 1024 * 1024;

let uploading = false;

function readStatus(): { state: string; message?: string; version?: string; at?: string } {
  try { return JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { return { state: 'idle' }; }
}
function releaseName(link: string): string | null {
  try { return path.basename(fs.realpathSync(path.join(ROOT, link))); } catch { return null; }
}
function writeStatus(state: string, message: string) {
  const tmp = `${STATUS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ state, message, at: new Date().toISOString() }));
  fs.renameSync(tmp, STATUS);
}
function startUnit(unit: 'feedmill-update.service' | 'feedmill-rollback.service'): Promise<void> {
  return new Promise((resolve, reject) =>
    // --no-block: the unit restarts this very process, so don't wait on it
    execFile('sudo', ['-n', '/bin/systemctl', 'start', '--no-block', unit], err => (err ? reject(err) : resolve())));
}

export function registerUpdateRoutes(app: Express, mill: Mill) {
  // same preconditions as /api/v1/shutdown: never swap code under a live batch
  const busyReason = (): string | null => {
    if (mill.activeBatch) return 'Active batch running — abort or complete it first';
    for (const eq of mill.equipment.values()) if (eq.status === 'running') return 'Equipment still running — stop all equipment first';
    const s = readStatus().state;
    if (uploading || s === 'running' || s === 'queued') return 'An update is already in progress';
    return null;
  };

  app.get('/api/v1/update', (_req, res) => {
    res.json({
      enabled: fs.existsSync(PUBKEY),
      current: releaseName('current'),
      previous: releaseName('previous'),
      status: readStatus(),
    });
  });

  app.post('/api/v1/update', async (req, res) => {
    if (!fs.existsSync(PUBKEY)) { res.status(503).json({ error: 'Updates are disabled: no signing key installed on this machine' }); return; }
    const busy = busyReason();
    if (busy) { res.status(409).json({ error: busy }); return; }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES) { res.status(413).json({ error: 'Update bundle too large' }); return; }

    uploading = true;
    const part = `${STAGED}.part`;
    let bytes = 0;
    try {
      fs.mkdirSync(path.dirname(STAGED), { recursive: true });
      const limit = new Transform({
        transform(chunk, _enc, cb) { bytes += chunk.length; bytes > MAX_BYTES ? cb(new Error('too large')) : cb(null, chunk); },
      });
      await pipeline(req, limit, fs.createWriteStream(part, { mode: 0o640 }));
      if (bytes === 0) throw new Error('empty upload');
      fs.renameSync(part, STAGED);
      writeStatus('queued', 'upload received');
      await startUnit('feedmill-update.service');
      res.status(202).json({ accepted: true });
    } catch (err) {
      fs.rmSync(part, { force: true });
      fs.rmSync(STAGED, { force: true });
      try { if (readStatus().state === 'queued') writeStatus('failed', `upload not started: ${(err as Error).message}`); } catch {} // else 'queued' would block every later update
      const tooBig = (err as Error).message === 'too large';
      if (!res.headersSent) res.status(tooBig ? 413 : 500).json({ error: tooBig ? 'Update bundle too large' : `Upload failed: ${(err as Error).message}` });
    } finally {
      uploading = false;
    }
  });

  app.post('/api/v1/update/rollback', async (_req, res) => {
    const busy = busyReason();
    if (busy) { res.status(409).json({ error: busy }); return; }
    if (!releaseName('previous')) { res.status(409).json({ error: 'No previous release to roll back to' }); return; }
    try {
      await startUnit('feedmill-rollback.service');
      res.status(202).json({ accepted: true });
    } catch (err) {
      res.status(500).json({ error: `Could not start rollback: ${(err as Error).message}` });
    }
  });
}
