'use client';

import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { Fault, Ingredient, Bin, Recipe } from './sim-data';
import type { EquipmentStatus, EquipmentMode } from './store';

export interface BackendEquipment {
  id: string;
  name: string;
  equipmentType: string;
  class: string;
  status: EquipmentStatus;
  mode: EquipmentMode;
  commanded: boolean;
  feedback: boolean;
  faultReason?: string;
  warningReason?: string;
  owner?: string;
  config: Record<string, string | number | boolean>;
  position?: { x: number; y: number };
  speed?: number;
  refillState?: 'STARTING' | 'FILLING' | 'STOPPING';
  gatePosition?: string;
  state?: string; // PLC-style motor display state (off, auto_stopped, auto_running, hand_running, bypass, alarm, fault, disabled)
  loadAmps?: number;
  loadDisconnected?: boolean;
  loadControlAuto?: boolean;
  loadAtRunning?: boolean;
  loadAtMsg?: string;
  enabled?: boolean;
  runSecondsTotal?: number;
  runSeconds?: number;
  runSecondsResetAt?: string;
}

export interface BackendBatch {
  id: string;
  recipeId: string;
  recipeName: string;
  targetMass: number;
  destination: string;
  state: string;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  dosingSteps?: {
    ingredientId: string;
    ingredientName: string;
    sourceBinId: string;
    target: number;
    actual: number;
    unit: string;
    state: string;
  }[];
  mixTimeRemainingMs?: number;
  mixTimeTotalMs?: number;
  faultReason?: string;
}

export interface BackendSignal {
  id: string;
  direction: string;
  label: string;
  equipmentId?: string;
  port?: string;
  assignment?: string; // what the point is configured as, e.g. "A-1 Run", "E-Stop"
}

export interface BackendScaleReading {
  weight: number;
  stable: boolean;
  valid: boolean;
  timestamp: number;
}

export interface BackendScaleConfig {
  id: string;
  name: string;
  connectionType: 'serial' | 'rs1201';
  protocol: string;
  comPort: string;
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: number;
  rackSlot: number;
  zeroOffset: number;
  ratedMvV: number;
  calibration?: { mode: 'theoretical' | 'zero' | 'span'; at: string; standardWeight?: number };
  capacity: number;
  resolution: number;
  freshnessTimeout: number;
  stabilityWindow: number;
}

export type BackendCouplerType = 'none' | 'NX-EIC' | 'NX-ECC';

export type BackendEccModel = 'NX-ECC202' | 'NX-ECC203';

export interface BackendIoRackCard {
  slot: number;
  model: string;
  actual?: string;
  status: 'unchecked' | 'ok' | 'mismatch' | 'missing';
}

export interface BackendOmronConfig {
  couplerType: BackendCouplerType;
  ipAddress: string;
  nodeAddress: number;
  ethercatInterface: string;
  eccModel: BackendEccModel;
  cycleTimeUs: number;
  ringTopology: boolean;
  cards: BackendIoRackCard[];
  rackVerified: boolean;
  lastReadAt?: string;
  warnings: string[];
}

type CommandResult = { accepted: boolean; reason?: string };

interface BackendState {
  connected: boolean;
  ready: boolean;
  commandError: string | null;
  clearCommandError: () => void;
  equipment: BackendEquipment[];
  queue: BackendBatch[];
  activeBatch: BackendBatch | null;
  faults: Fault[];
  bins: Bin[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  connections: { from: string; fromPort: string; to: string; toPort: string }[];
  ioSignals: BackendSignal[];
  ioInputs: Record<string, boolean | number>;
  ioOutputs: Record<string, boolean | number>;
  ioOverrides: Record<string, boolean | number>;
  scales: Record<string, BackendScaleReading>;
  scaleConfigs: BackendScaleConfig[];
  omronConfig: BackendOmronConfig;
  globalConfig: Record<string, string | number>;
  networkInterfaces: string[];
  commissioningMode: boolean;
  horn: { on: boolean; silenced: boolean };
  sendCommand: (action: string, targetId?: string, parameters?: Record<string, unknown>) => Promise<CommandResult>;
}

type SnapshotData = Omit<BackendState, 'connected' | 'ready' | 'commandError' | 'clearCommandError' | 'sendCommand'>;

const EMPTY_OMRON: BackendOmronConfig = { couplerType: 'none', ipAddress: '', nodeAddress: 1, ethercatInterface: '', eccModel: 'NX-ECC203', cycleTimeUs: 5000, ringTopology: false, cards: [], rackVerified: false, warnings: [] };

const EMPTY_DATA: SnapshotData = {
  equipment: [], queue: [], activeBatch: null,
  faults: [], bins: [], recipes: [], ingredients: [], connections: [],
  ioSignals: [], ioInputs: {}, ioOutputs: {}, ioOverrides: {},
  scales: {}, scaleConfigs: [],
  omronConfig: EMPTY_OMRON,
  globalConfig: {},
  networkInterfaces: [],
  commissioningMode: false,
  horn: { on: false, silenced: false },
};

function parseSnapshot(d: Record<string, any>): SnapshotData { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    equipment: d.equipment ?? [],
    queue: d.queue ?? [],
    activeBatch: d.activeBatch ?? null,
    faults: d.faults ?? [],
    bins: d.bins ?? [],
    recipes: d.recipes ?? [],
    ingredients: d.ingredients ?? [],
    connections: d.connections ?? [],
    ioSignals: d.io?.signals ?? [],
    ioInputs: d.io?.inputs ?? {},
    ioOutputs: d.io?.outputs ?? {},
    ioOverrides: d.io?.overrides ?? {},
    scales: d.scales ?? {},
    scaleConfigs: d.scaleConfigs ?? [],
    omronConfig: d.omronConfig ?? EMPTY_OMRON,
    globalConfig: d.globalConfig ?? {},
    networkInterfaces: d.networkInterfaces ?? [],
    commissioningMode: d.commissioningMode ?? false,
    horn: d.horn ?? { on: false, silenced: false },
  };
}

const BackendCtx = createContext<BackendState | null>(null);

export function useBackend(): BackendState | null {
  return useContext(BackendCtx);
}

// Same-origin by default: the page is loaded through nginx on :80 (see
// install.sh), which proxies /ws/hmi to the backend on 127.0.0.1:3001 —
// so "this page's own host" is always the right address, from any device
// on the network. The ?backend= override remains for local dev against
// `next dev` + a bare backend (no nginx in front).
const BACKEND_WS = typeof window !== 'undefined'
  ? (new URLSearchParams(window.location.search).get('backend') ??
     `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/hmi`)
  : 'ws://localhost:3001/ws/hmi';

// REST base (trend data) follows the same host as the WebSocket, including the ?backend= dev override.
export const BACKEND_HTTP = BACKEND_WS.replace(/^ws/, 'http').replace(/\/ws\/hmi$/, '');

export function BackendProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<SnapshotData>(EMPTY_DATA);
  const [commandError, setCommandError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cmdCallbacks = useRef<Map<string, (r: CommandResult) => void>>(new Map());
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastJson = useRef<Partial<Record<keyof SnapshotData, string>>>({});
  const latest = useRef<SnapshotData>(EMPTY_DATA);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let disposed = false;

    function connect() {
      ws = new WebSocket(BACKEND_WS);
      wsRef.current = ws;

      // A disposed effect's socket must not touch shared state: in dev, StrictMode's second mount shares wsRef.
      ws.onopen = () => { if (!disposed) setConnected(true); };
      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        setReady(false);
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => {};

      ws.onmessage = (e) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'snapshot' && msg.data) {
            const next = parseSnapshot(msg.data);
            setReady(true);
            // Keep the previous reference for unchanged slices so consumers and effects only re-run on real changes.
            const prev = latest.current;
            const merged = { ...next } as Record<keyof SnapshotData, unknown>;
            let changed = false;
            for (const k of Object.keys(next) as (keyof SnapshotData)[]) {
              const json = JSON.stringify(next[k]);
              if (lastJson.current[k] === json) merged[k] = prev[k];
              else { lastJson.current[k] = json; changed = true; }
            }
            if (changed) {
              latest.current = merged as unknown as SnapshotData;
              setData(latest.current);
            }
          } else if (msg.type === 'command_result' && msg.data) {
            const cb = cmdCallbacks.current.get(msg.data.requestId);
            if (cb) { cb(msg.data); cmdCallbacks.current.delete(msg.data.requestId); }
          }
        } catch {}
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(errorTimer.current);
      if (ws) ws.close();
    };
  }, []);

  const clearCommandError = useCallback(() => {
    clearTimeout(errorTimer.current);
    setCommandError(null);
  }, []);

  const sendCommand = useCallback(async (action: string, targetId?: string, parameters?: Record<string, unknown>) => {
    const requestId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = await new Promise<CommandResult>((resolve) => {
      const timeout = setTimeout(() => {
        cmdCallbacks.current.delete(requestId);
        resolve({ accepted: false, reason: 'Timeout' });
      }, 5000);

      cmdCallbacks.current.set(requestId, (r) => {
        clearTimeout(timeout);
        resolve(r);
      });

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'command', data: { requestId, action, targetId, parameters } }));
      } else {
        clearTimeout(timeout);
        cmdCallbacks.current.delete(requestId);
        resolve({ accepted: false, reason: 'Not connected' });
      }
    });
    if (!result.accepted) {
      setCommandError(result.reason || `${action} was rejected`);
      clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setCommandError(null), 6000);
    }
    return result;
  }, []);

  return (
    <BackendCtx.Provider value={{ ...data, connected, ready, commandError, clearCommandError, sendCommand }}>
      {children}
    </BackendCtx.Provider>
  );
}
