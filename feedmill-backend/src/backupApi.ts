import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import express from 'express';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import type { Mill } from './mill.js';
import { backupDb, dbFilePath } from './db.js';

const DATA_DIR = process.env.MILL_DATA_DIR ?? path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_DIR = process.env.FEEDMILL_STATE_DIR ?? '/var/lib/feedmill';
const FOLDER = path.join(STATE_DIR, 'backups');
const MAX_BYTES = 256 * 1024 * 1024;

type Kind = 'db' | 'config';
const EXT: Record<Kind, string> = { db: 'db', config: 'json' };
// the only names we ever read or write (no path traversal)
const NAME_RE = /^feedmill-(db|config)-[0-9T-]+\.(db|json)$/;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const kindOf = (v: unknown): Kind | null => (v === 'db' || v === 'config' ? v : null);

// USB sticks are mounted (feedmill-owned) by install/ udev rule + feedmill-usb@.service.
// A stick can only be inspected once mounted, so prefer the one that already has a backups folder.
const USB_BASE = '/mnt/feedmill-usb';
function usbMounts(): string[] {
  try {
    const m = fs.readdirSync(USB_BASE).map(n => path.join(USB_BASE, n))
      .filter(p => fs.readFileSync('/proc/mounts', 'utf8').split('\n').some(l => l.split(' ')[1] === p));
    return m.sort((a, b) => Number(fs.existsSync(path.join(b, 'feedmill-backups'))) - Number(fs.existsSync(path.join(a, 'feedmill-backups'))));
  } catch { return []; }
}
function dirFor(target: unknown, usb: unknown): string | null {
  if (target === 'folder') return FOLDER;
  if (target === 'usb') {
    const m = usbMounts();
    const pick = typeof usb === 'string' && m.includes(usb) ? usb : m[0];
    return pick ? path.join(pick, 'feedmill-backups') : null;
  }
  return null;
}
function list(dir: string): { name: string; kind: Kind; size: number; at: string }[] {
  try {
    return fs.readdirSync(dir).filter(n => NAME_RE.test(n)).map(name => {
      const st = fs.statSync(path.join(dir, name));
      return { name, kind: (name.startsWith('feedmill-db') ? 'db' : 'config') as Kind, size: st.size, at: st.mtime.toISOString() };
    }).sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

async function makeBackup(kind: Kind, dest: string): Promise<void> {
  if (kind === 'db') await backupDb(dest);
  else fs.copyFileSync(CONFIG_PATH, dest);
}

function validate(kind: Kind, file: string): string | null {
  try {
    if (kind === 'config') {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(c?.equipment) && Array.isArray(c?.recipes) ? null : 'Not a feedmill config file';
    }
    const d = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (d.pragma('integrity_check', { simple: true }) !== 'ok') return 'Database is corrupt';
      return d.prepare("SELECT 1 FROM sqlite_master WHERE name='active_batch'").get() ? null : 'Not a feedmill database';
    } finally { d.close(); }
  } catch (e) { return `Invalid backup file: ${(e as Error).message}`; }
}

export function registerBackupRoutes(app: Express, mill: Mill) {
  app.get('/api/v1/backup/targets', (_req, res) => {
    res.json({ folder: FOLDER, usb: usbMounts() });
  });

  app.get('/api/v1/backup/list', (req, res) => {
    const dir = dirFor(req.query.target, req.query.usb);
    if (!dir) { res.status(404).json({ error: 'No USB drive found' }); return; }
    res.json({ dir, files: list(dir) });
  });

  // browser target: stream a fresh backup to the client
  app.get('/api/v1/backup/download', async (req, res) => {
    const kind = kindOf(req.query.kind);
    if (!kind) { res.status(400).json({ error: 'kind must be db or config' }); return; }
    const tmp = path.join(DATA_DIR, `dl-${Date.now()}.tmp`);
    try {
      await makeBackup(kind, tmp);
      res.download(tmp, `feedmill-${kind}-${stamp()}.${EXT[kind]}`, () => fs.rmSync(tmp, { force: true }));
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      res.status(500).json({ error: `Backup failed: ${(e as Error).message}` });
    }
  });

  // usb / folder target
  app.post('/api/v1/backup/save', async (req, res) => {
    const kind = kindOf(req.body?.kind);
    const dir = dirFor(req.body?.target, req.body?.usb);
    if (!kind) { res.status(400).json({ error: 'kind must be db or config' }); return; }
    if (!dir) { res.status(404).json({ error: 'No USB drive found' }); return; }
    const name = `feedmill-${kind}-${stamp()}.${EXT[kind]}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      await makeBackup(kind, path.join(dir, name));
      res.json({ name, dir });
    } catch (e) {
      res.status(500).json({ error: `Backup failed: ${(e as Error).message}` });
    }
  });

  // Replace the live file, then have systemd restart the backend on it.
  function applyRestore(kind: Kind, src: string, res: express.Response) {
    const guard = mill.guardConfigEdit();
    if (guard) { res.status(409).json({ error: guard }); return; }
    const bad = validate(kind, src);
    if (bad) { res.status(400).json({ error: bad }); return; }
    res.status(202).json({ accepted: true });
    setTimeout(() => {
      try {
        mill.stop(); // stops scans and closes the db so nothing rewrites what we restore
        if (kind === 'config') {
          fs.copyFileSync(src, `${CONFIG_PATH}.tmp`);
          fs.renameSync(`${CONFIG_PATH}.tmp`, CONFIG_PATH);
        } else {
          for (const s of ['-wal', '-shm']) fs.rmSync(dbFilePath + s, { force: true });
          fs.copyFileSync(src, `${dbFilePath}.tmp`);
          fs.renameSync(`${dbFilePath}.tmp`, dbFilePath);
        }
      } catch (e) { console.error('restore failed:', e); }
      // sudoers allows exactly this line (install.sh); if it fails (dev run), just exit non-zero
      execFile('sudo', ['-n', '/bin/systemctl', 'restart', '--no-block', 'feedmill-backend.service'], () => process.exit(1));
    }, 300);
  }

  app.post('/api/v1/backup/restore', (req, res) => {
    const kind = kindOf(req.body?.kind);
    const dir = dirFor(req.body?.target, req.body?.usb);
    const name = String(req.body?.name ?? '');
    if (!kind || !dir || !NAME_RE.test(name) || !name.startsWith(`feedmill-${kind}-`)) { res.status(400).json({ error: 'Bad restore request' }); return; }
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) { res.status(404).json({ error: 'Backup not found' }); return; }
    applyRestore(kind, src, res);
  });

  // browser target: the client uploads the file body
  app.post('/api/v1/backup/restore-upload', express.raw({ type: '*/*', limit: MAX_BYTES }), (req, res) => {
    const kind = kindOf(req.query.kind);
    if (!kind || !Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(400).json({ error: 'Bad restore request' }); return; }
    const tmp = path.join(DATA_DIR, `restore-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, req.body);
    // on success the process exits before this matters; on failure the temp file is removed
    res.on('finish', () => setTimeout(() => fs.rmSync(tmp, { force: true }), 1000));
    applyRestore(kind, tmp, res);
  });
}
