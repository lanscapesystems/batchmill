#!/usr/bin/env node
/**
 * Feed Mill Controller — Update Utility
 * Updates from a .zip file or GitHub release.
 * Preserves database (mill.db) and configuration (config.json).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';
import http from 'http';
import os from 'os';

const API_BASE = process.env.MILL_API_URL ?? 'http://localhost:3001';
const DATA_DIR = process.env.MILL_DATA_DIR ?? path.join(process.cwd(), 'data');
const PROTECTED = new Set(['data', 'node_modules', '.git', '.next']);

interface Args {
  zip?: string;
  repo?: string;
  tag?: string;
  force?: boolean;
  check?: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(`Feed Mill Controller — Update Utility

Usage:
  npm run update -- --zip <path>                       Update from a local .zip file
  npm run update -- --github <owner/repo>              Update from latest GitHub release
  npm run update -- --github <owner/repo> --tag <tag>  Update from specific tag
  npm run update -- --github <owner/repo> --check      Check for updates only

Options:
  --force   Skip equipment safety check
  --check   Check for updates without applying`);
    process.exit(0);
  }
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--zip': a.zip = argv[++i]; break;
      case '--github': a.repo = argv[++i]; break;
      case '--tag': a.tag = argv[++i]; break;
      case '--force': a.force = true; break;
      case '--check': a.check = true; break;
    }
  }
  if (!a.zip && !a.repo) {
    console.error('Error: specify --zip <path> or --github <owner/repo>');
    process.exit(1);
  }
  return a;
}

// ── HTTP helpers ──

function httpReq(url: string, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'User-Agent': 'feedmill-updater' } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, data: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function httpFollow(url: string, maxRedirects = 5): Promise<Buffer> {
  for (let i = 0; i < maxRedirects; i++) {
    const r = await httpReq(url);
    if (r.status >= 300 && r.status < 400 && r.headers.location) { url = r.headers.location; continue; }
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}`);
    return r.data;
  }
  throw new Error('Too many redirects');
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ── Equipment safety check ──

async function checkEquipment(force: boolean): Promise<boolean> {
  if (force) { console.log('[skip] Equipment check (--force)'); return true; }
  try {
    const body = await httpFollow(`${API_BASE}/api/v1/state`);
    const s = JSON.parse(body.toString());
    if (s.activeBatch) {
      console.error(`BLOCKED: Active batch ${s.activeBatch.id} (${s.activeBatch.state}). Complete or abort it first.`);
      return false;
    }
    const running = (s.equipment ?? []).filter((e: { status: string }) => e.status === 'running');
    if (running.length > 0) {
      console.error(`BLOCKED: Running equipment: ${running.map((e: { id: string }) => e.id).join(', ')}. Stop all equipment first.`);
      return false;
    }
    console.log('[ok] No active batches, no running equipment');
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? ((err as { cause?: NodeJS.ErrnoException }).cause?.code);
    if (code === 'ECONNREFUSED') {
      console.log('[ok] Server not running — safe to update');
      return true;
    }
    throw err;
  }
}

// ── Server shutdown ──

async function shutdownServer(): Promise<void> {
  try {
    const r = await httpReq(`${API_BASE}/api/v1/shutdown`, 'POST');
    if (r.status === 200) {
      console.log('Server shutting down...');
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        try { await httpReq(`${API_BASE}/api/v1/health`); } catch { console.log('Server stopped'); return; }
      }
      throw new Error('Server did not stop within 10s');
    }
    const msg = JSON.parse(r.data.toString());
    throw new Error(msg.error ?? `Shutdown refused (HTTP ${r.status})`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? ((err as { cause?: NodeJS.ErrnoException }).cause?.code);
    if (code === 'ECONNREFUSED') return; // already down
    throw err;
  }
}

// ── GitHub release ──

async function getRelease(repo: string, tag?: string): Promise<{ zipUrl: string; version: string; name: string }> {
  const url = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${tag}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  console.log(`Checking ${repo}${tag ? ` tag ${tag}` : ' latest'}...`);
  const body = await httpFollow(url);
  const rel = JSON.parse(body.toString());
  if (!rel.zipball_url) throw new Error('No zipball_url in GitHub release response');
  return { zipUrl: rel.zipball_url, version: rel.tag_name, name: rel.name ?? '' };
}

function currentVersion(): string {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')).version; }
  catch { return '0.0.0'; }
}

// ── File operations ──

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function extractZip(zipPath: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  if (os.platform() === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}'"`
    );
  } else {
    execSync(`unzip -qo "${zipPath}" -d "${dest}"`);
  }
}

function findRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const visible = entries.filter(e => !e.name.startsWith('.'));
  if (visible.length === 1 && visible[0].isDirectory()) {
    const inner = path.join(dir, visible[0].name);
    if (fs.existsSync(path.join(inner, 'feedmill-backend')) || fs.existsSync(path.join(inner, 'src')))
      return inner;
  }
  return dir;
}

function applyPackageUpdate(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (PROTECTED.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function applyUpdate(sourceRoot: string, projectRoot: string): void {
  const hasBackend = fs.existsSync(path.join(sourceRoot, 'feedmill-backend'));
  if (hasBackend) {
    for (const e of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (PROTECTED.has(e.name)) continue;
      const s = path.join(sourceRoot, e.name), d = path.join(projectRoot, e.name);
      if (e.name === 'feedmill-backend' || e.name === 'hmi-prototype') {
        applyPackageUpdate(s, d);
      } else if (e.isDirectory()) {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
        copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  } else {
    applyPackageUpdate(sourceRoot, process.cwd());
  }
}

function installDeps(projectRoot: string): void {
  const backend = fs.existsSync(path.join(projectRoot, 'feedmill-backend'))
    ? path.join(projectRoot, 'feedmill-backend') : projectRoot;

  console.log('Installing backend dependencies...');
  execSync('npm install', { cwd: backend, stdio: 'inherit' });

  try {
    console.log('Building backend...');
    execSync('npm run build', { cwd: backend, stdio: 'inherit' });
  } catch {
    console.log('Warning: build failed — run "npm run build" manually before production use');
  }

  const hmi = path.join(projectRoot, 'hmi-prototype');
  if (fs.existsSync(path.join(hmi, 'package.json'))) {
    console.log('Installing HMI dependencies...');
    execSync('npm install', { cwd: hmi, stdio: 'inherit' });
  }
}

// ── Main ──

async function main() {
  const args = parseArgs();
  console.log('=== Feed Mill Controller — Updater ===\n');

  // 1. Equipment safety check
  if (!await checkEquipment(!!args.force)) process.exit(1);

  // 2. Resolve update source
  let release: { zipUrl: string; version: string; name: string } | undefined;
  if (args.repo) {
    release = await getRelease(args.repo, args.tag);
    const cur = currentVersion();
    console.log(`  Current version:  ${cur}`);
    console.log(`  Available:        ${release.version}${release.name ? ' — ' + release.name : ''}`);
    if (args.check) {
      const v = release.version.replace(/^v/, '');
      console.log(v === cur ? '\nAlready up to date.' : '\nUpdate available.');
      process.exit(0);
    }
  }

  // 3. Shut down running server (if reachable)
  let serverRunning = false;
  try { await httpReq(`${API_BASE}/api/v1/health`); serverRunning = true; } catch {}

  if (serverRunning) {
    console.log('\nStopping server...');
    try {
      await shutdownServer();
      console.log('Server stopped');
    } catch {
      console.log('Warning: could not auto-stop server (shutdown endpoint may not exist yet).');
      console.log('If npm install fails, stop the server manually and re-run.\n');
    }
  }

  // 4. Obtain zip file
  let zipPath: string;
  let tempZip = false;
  if (args.zip) {
    zipPath = path.resolve(args.zip);
    if (!fs.existsSync(zipPath)) { console.error(`File not found: ${zipPath}`); process.exit(1); }
    console.log(`\nSource: ${zipPath}`);
  } else {
    console.log(`\nDownloading ${release!.version}...`);
    const data = await httpFollow(release!.zipUrl);
    zipPath = path.join(os.tmpdir(), `feedmill-update-${Date.now()}.zip`);
    const zipTmp = `${zipPath}.tmp`;
    fs.writeFileSync(zipTmp, data);
    fs.renameSync(zipTmp, zipPath);
    tempZip = true;
    console.log(`Downloaded ${(data.length / 1024 / 1024).toFixed(1)} MB`);
  }

  // 5. Backup data directory
  if (fs.existsSync(DATA_DIR)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = `${DATA_DIR}.backup-${ts}`;
    copyDir(DATA_DIR, backup);
    console.log(`Data backed up to ${path.relative(process.cwd(), backup) || backup}`);
  }

  // 6. Extract zip
  const extractDir = path.join(os.tmpdir(), `feedmill-extract-${Date.now()}`);
  console.log('Extracting update...');
  extractZip(zipPath, extractDir);
  const sourceRoot = findRoot(extractDir);

  // 7. Apply update (preserves data/ and node_modules/)
  const projectRoot = path.resolve(process.cwd(), '..');
  console.log('Applying update...');
  applyUpdate(sourceRoot, projectRoot);

  // 8. Install dependencies & build
  try { installDeps(projectRoot); }
  catch { console.log('Warning: dependency install had errors — check manually'); }

  // 9. Cleanup temp files
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  if (tempZip) try { fs.unlinkSync(zipPath); } catch {}

  // 10. Write update marker (inside data/ so it survives future updates)
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const markerPath = path.join(DATA_DIR, 'last-update.json');
  const markerTmp = `${markerPath}.tmp`;
  fs.writeFileSync(markerTmp, JSON.stringify({
    version: release?.version ?? path.basename(args.zip!),
    updatedAt: new Date().toISOString(),
    source: args.zip ? `zip:${path.basename(args.zip)}` : `github:${args.repo}`,
  }, null, 2));
  fs.renameSync(markerTmp, markerPath);

  console.log('\n=== Update complete ===');
  console.log('Restart the server:');
  console.log('  npm run dev     (development)');
  console.log('  npm run start   (production — after npm run build)');
}

main().catch(err => { console.error(`\nUpdate failed: ${err.message}`); process.exit(1); });
