import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Mill } from './mill.js';
import type { Command, CommandResult } from './types.js';
import { screenFeed } from './hmiFeed.js';
import { batchHistory, faultHistory, historyQuery, pruneFaults } from './db.js';
import { reconcileScaleReaders, listSerialPorts } from './scaleReader.js';
import { registerUpdateRoutes } from './updateApi.js';
import { registerBackupRoutes } from './backupApi.js';

let PKG_VERSION = '0.0.0';
try { PKG_VERSION = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version; } catch {}

const PORT = parseInt(process.env.PORT ?? '3001', 10);
// Loopback-only by default — this port carries no auth of its own, so it
// must never be reachable from the network directly. nginx (see install.sh)
// is the one thing that's supposed to reach it, proxying /ws/hmi and /api/
// from the HMI's port 80 to here. Override only for local dev.
const HOST = process.env.HOST ?? '127.0.0.1';
const BROADCAST_INTERVAL_MS = 200;

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const mill = new Mill();

// ── WebSocket servers on separate paths ──

const wssHmi = new WebSocketServer({ noServer: true, perMessageDeflate: true }); // snapshots compress to a fraction

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/ws/hmi') {
    wssHmi.handleUpgrade(req, socket, head, ws => wssHmi.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── HMI WebSocket: broadcast state snapshots ──

const hmiClients = new Map<WebSocket, ReturnType<typeof screenFeed>>();
const snapshotMessage = () => JSON.stringify({ type: 'snapshot', data: mill.getSnapshot() });

wssHmi.on('connection', (ws, req) => {
  const feed = screenFeed(ws, new URL(req.url ?? '/', 'http://localhost').searchParams.has('paced'), snapshotMessage);
  hmiClients.set(ws, feed);
  console.log(`HMI client connected (${hmiClients.size} total)`);

  // send initial snapshot immediately
  try { feed.send(snapshotMessage()); } catch {}

  ws.on('close', () => { hmiClients.delete(ws); });
  ws.on('error', () => { hmiClients.delete(ws); });

  ws.on('message', (raw) => {
    let requestId: string | undefined;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ack') feed.confirm();
      else if (msg.type === 'command') {
        requestId = msg.data?.requestId;
        const result = mill.processCommand(msg.data as Command);
        const reply = (data: CommandResult) => { ws.send(JSON.stringify({ type: 'command_result', data })); pushSoon(); };
        if (result.later) { pushSoon(); result.later.then(reply).catch(err => console.error('HMI reply failed:', err)); }
        else reply(result);
      }
    } catch (err) {
      console.error('HMI command failed:', err);
      if (requestId) {
        try { ws.send(JSON.stringify({ type: 'command_result', data: { requestId, accepted: false, reason: 'Internal error', revision: mill.revision } })); } catch {}
      }
    }
  });
});

function broadcastToHmi() {
  if (hmiClients.size === 0) return;
  const snapshot = snapshotMessage();
  for (const [ws, feed] of hmiClients) {
    try { feed.send(snapshot); } catch { hmiClients.delete(ws); }
  }
}

// Show a command's effect at once instead of at the next 200 ms broadcast. The short wait lets a scan (20 ms) apply it to
// outputs and motor states first; commands arriving together share one push.
let pushTimer: ReturnType<typeof setTimeout> | undefined;
function pushSoon() {
  pushTimer ??= setTimeout(() => { pushTimer = undefined; broadcastToHmi(); }, 30);
}

// ── Scale readers: start at boot, restart whenever ConfigureScale/RemoveScale changes the list ──

reconcileScaleReaders(mill, mill.scaleConfigs);
let lastScaleConfigVersion = mill.scaleConfigVersion;

function maybeReconcileScaleReaders() {
  if (mill.scaleConfigVersion === lastScaleConfigVersion) return;
  lastScaleConfigVersion = mill.scaleConfigVersion;
  reconcileScaleReaders(mill, mill.scaleConfigs);
}

// ── REST API ──

app.get('/api/v1/state', (_req, res) => {
  res.json(mill.getSnapshot());
});

app.post('/api/v1/commands', async (req, res) => {
  const cmd = req.body as Command;
  if (!cmd.requestId || !cmd.action) {
    res.status(400).json({ error: 'Missing requestId or action' });
    return;
  }
  const result = mill.processCommand(cmd);
  res.json(await (result.later ?? result));
});

app.get('/api/v1/trend/:id', (req, res) => {
  res.json(mill.getTrend(req.params.id));
});

app.get('/api/v1/history/batches', (req, res) => {
  res.json(batchHistory(historyQuery(req.query)));
});

app.get('/api/v1/history/faults', (req, res) => {
  res.json(faultHistory(historyQuery(req.query)));
});

app.get('/api/v1/serial/ports', async (_req, res) => {
  try { res.json(await listSerialPorts()); }
  catch (err) {
    console.error('Serial port list failed:', err);
    res.status(500).json({ error: 'Could not list serial ports' });
  }
});

app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: PKG_VERSION,
    hmiClients: hmiClients.size,
    revision: mill.revision,
  });
});

registerUpdateRoutes(app, mill);
registerBackupRoutes(app, mill);

app.post('/api/v1/shutdown', (_req, res) => {
  if (mill.activeBatch) {
    res.status(409).json({ error: 'Active batch running — abort or complete it first' });
    return;
  }
  for (const eq of mill.equipment.values()) {
    if (eq.status === 'running') {
      res.status(409).json({ error: 'Equipment still running — stop all equipment first' });
      return;
    }
  }
  res.json({ status: 'shutting_down' });
  setTimeout(() => {
    mill.stop();
    for (const ws of hmiClients.keys()) ws.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  }, 200);
});

// ── Start ──

mill.start(() => {
  // state changed — broadcasts happen on interval, not every scan
});

setInterval(() => {
  maybeReconcileScaleReaders();
  broadcastToHmi();
}, BROADCAST_INTERVAL_MS);

setInterval(() => pruneFaults(), 86_400_000).unref();

// Event-loop stall log: a timer that fires >250 ms late means something blocked the backend (HMI commands time out meanwhile).
let lastLoopTick = Date.now();
setInterval(() => {
  const late = Date.now() - lastLoopTick - 100;
  lastLoopTick = Date.now();
  if (late > 250) console.warn(`[loop] backend stalled ${late} ms`);
}, 100).unref();

server.listen(PORT, HOST, () => {
  console.log(`Feed Mill Backend running on http://${HOST}:${PORT} (not reachable from the network — see nginx)`);
  console.log(`  HMI WebSocket:       ws://${HOST}:${PORT}/ws/hmi`);
  console.log(`  REST API:            http://${HOST}:${PORT}/api/v1/state`);
  console.log(`  Health:              http://${HOST}:${PORT}/api/v1/health`);
});
