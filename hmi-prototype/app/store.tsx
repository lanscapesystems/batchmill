'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type EquipmentStatus = 'not_running' | 'running' | 'fault' | 'warning' | 'disabled';
// Motors: Hand / Off / Auto. Gates: P1 (open) / P2 (closed) / Off / Auto. Bins have no HOA.
export type EquipmentMode = 'Auto' | 'Hand' | 'Off' | 'P1' | 'P2';

export interface EquipmentItem {
  id: string;
  name: string;
  equipmentType: string;
  prefix: string;
  number: number;
  suffix: string;
  parentId: string | null;
  class: string;
  status: EquipmentStatus;
  mode: EquipmentMode;
  config: Record<string, string | number | boolean>;
}

export interface PortDef {
  id: string;
  label: string;
  side: 'top' | 'bottom' | 'left' | 'right';
  type: 'inlet' | 'outlet';
}

export interface FlowConnection {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface Position { x: number; y: number }

// Placeholder I/O points — will be configured in a dedicated IO tab later
export const IO_POOL = {
  do: Array.from({ length: 48 }, (_, i) => `DO-${i + 1}`),
  di: Array.from({ length: 48 }, (_, i) => `DI-${i + 1}`),
  ao: Array.from({ length: 16 }, (_, i) => `AO-${i + 1}`),
  ai: Array.from({ length: 16 }, (_, i) => `AI-${i + 1}`),
  com: ['COM1', 'COM2', 'COM3', 'COM4'],
};

export const EQUIPMENT_DEFS: Record<string, {
  prefix: string;
  label: string;
  class: string;
  maxCount?: number;
}> = {
  bin:          { prefix: 'B',  label: 'Ingredient Bin', class: 'StorageBin',  maxCount: 32 },
  hammermill:   { prefix: 'HM', label: 'Hammer Mill',    class: 'HammerMill',  maxCount: 4 },
  mixer:        { prefix: 'MX', label: 'Mixer',          class: 'Mixer',       maxCount: 1 },
  finished_bin: { prefix: 'FB', label: 'Finished Bin',   class: 'StorageBin',  maxCount: 8 },
  micro_drag:   { prefix: 'MD', label: 'Micro Drag',     class: 'Conveyor',    maxCount: 2 },
  gate:         { prefix: 'GT', label: 'Gate',            class: 'Gate' },
  auger:        { prefix: 'A',  label: 'Auger',          class: 'Auger' },
};

export const SUB_DEFS: Record<string, { prefix: string; label: string; class: string }> = {};

export const TYPE_DISPLAY_ORDER = [
  'hammermill', 'bin', 'micro_drag', 'mixer', 'gate', 'finished_bin', 'auger',
];

export const GRID_SNAP = 20;

export const PORT_DEFS: Record<string, PortDef[]> = {
  bin:          [{ id: 'inlet', label: 'Inlet', side: 'top', type: 'inlet' }, { id: 'discharge', label: 'Discharge', side: 'bottom', type: 'outlet' }],
  hammermill:   [{ id: 'feed', label: 'Feed', side: 'top', type: 'inlet' }, { id: 'discharge', label: 'Discharge', side: 'bottom', type: 'outlet' }],
  mixer:        [{ id: 'inlet', label: 'Inlet', side: 'top', type: 'inlet' }, { id: 'discharge', label: 'Discharge', side: 'bottom', type: 'outlet' }],
  finished_bin: [{ id: 'inlet', label: 'Inlet', side: 'top', type: 'inlet' }, { id: 'discharge', label: 'Discharge', side: 'bottom', type: 'outlet' }],
  micro_drag:   [{ id: 'feed', label: 'Feed', side: 'top', type: 'inlet' }, { id: 'discharge', label: 'Discharge', side: 'bottom', type: 'outlet' }],
  gate:         [{ id: 'inlet', label: 'Inlet', side: 'top', type: 'inlet' }, { id: 'out1', label: 'Out 1', side: 'bottom', type: 'outlet' }, { id: 'out2', label: 'Out 2', side: 'bottom', type: 'outlet' }],
  auger:        [{ id: 'inlet', label: 'Inlet', side: 'top', type: 'inlet' }, { id: 'outlet', label: 'Outlet', side: 'bottom', type: 'outlet' }],
};

export const FLOW_HIDDEN_TYPES = new Set<string>();

export function getPortsForEquipment(eq: EquipmentItem): PortDef[] {
  return PORT_DEFS[eq.equipmentType] ?? [];
}

// Global mill settings
export const GLOBAL_DEFAULTS: Record<string, number | string> = {
  motorStarterFaultDelay: 0.5,
  siteName: 'FEED MILL CONTROLLER',
};

const INITIAL_EQUIPMENT: EquipmentItem[] = [];

const INITIAL_CONNECTIONS: FlowConnection[] = [];

interface MillStoreValue {
  equipment: EquipmentItem[];
  connections: FlowConnection[];
  positions: Record<string, Position>;
  globalConfig: Record<string, number | string>;
  setPosition: (id: string, pos: Position) => void;
  addConnection: (from: string, fromPort: string, to: string, toPort: string) => void;
  removeConnection: (from: string, fromPort: string, to: string, toPort: string) => void;
  setGlobalConfig: (key: string, value: number | string) => void;
  syncGlobalConfig: (cfg: Record<string, number | string>) => void;
  syncEquipment: (eqList: BackendEquipmentLike[]) => void;
  syncConnections: (connList: FlowConnection[]) => void;
}

interface BackendEquipmentLike {
  id: string;
  name: string;
  equipmentType: string;
  class: string;
  config: Record<string, string | number | boolean>;
  position?: Position;
}

const Ctx = createContext<MillStoreValue | null>(null);

export function useMillStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useMillStore outside provider');
  return ctx;
}

export function MillStoreProvider({ children }: { children: ReactNode }) {
  const [equipment, setEquipment] = useState<EquipmentItem[]>(INITIAL_EQUIPMENT);
  const [connections, setConnections] = useState<FlowConnection[]>(INITIAL_CONNECTIONS);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [globalConfig, setGlobalConfigState] = useState<Record<string, number | string>>({
    motorStarterFaultDelay: GLOBAL_DEFAULTS.motorStarterFaultDelay,
    siteName: GLOBAL_DEFAULTS.siteName,
  });

  const setPosition = useCallback((id: string, pos: Position) => {
    setPositions(prev => ({ ...prev, [id]: pos }));
  }, []);

  const addConnection = useCallback((from: string, fromPort: string, to: string, toPort: string) => {
    if (from === to) return;
    setConnections(prev => {
      if (prev.some(c => c.from === from && c.fromPort === fromPort && c.to === to && c.toPort === toPort)) return prev;
      return [...prev, { from, fromPort, to, toPort }];
    });
  }, []);

  const removeConnection = useCallback((from: string, fromPort: string, to: string, toPort: string) => {
    setConnections(prev => prev.filter(c => !(c.from === from && c.fromPort === fromPort && c.to === to && c.toPort === toPort)));
  }, []);

  const setGlobalConfig = useCallback((key: string, value: number | string) => {
    setGlobalConfigState(prev => ({ ...prev, [key]: value }));
  }, []);

  const syncGlobalConfig = useCallback((cfg: Record<string, number | string>) => {
    setGlobalConfigState(prev => {
      const merged = { ...prev, ...cfg };
      return JSON.stringify(merged) === JSON.stringify(prev) ? prev : merged;
    });
  }, []);

  const syncEquipment = useCallback((eqList: BackendEquipmentLike[]) => {
    setEquipment(prev => {
      const same = eqList.length === prev.length && eqList.every((e, i) => {
        const p = prev[i];
        return p && e.id === p.id && e.name === p.name && JSON.stringify(e.config) === JSON.stringify(p.config);
      });
      if (same) return prev;
      return eqList.map(e => {
        const existing = prev.find(p => p.id === e.id);
        const def = EQUIPMENT_DEFS[e.equipmentType];
        return {
          id: e.id,
          name: e.name,
          equipmentType: e.equipmentType,
          prefix: def?.prefix ?? '',
          number: parseInt(e.id.replace(/\D/g, '')) || 0,
          suffix: '',
          parentId: null,
          class: e.class,
          status: existing?.status ?? 'not_running',
          mode: existing?.mode ?? 'Auto',
          config: e.config,
        };
      });
    });
    setPositions(prev => {
      const ids = new Set(eqList.map(e => e.id));
      const next: Record<string, Position> = {};
      let changed = Object.keys(prev).some(id => !ids.has(id));
      const placed = Object.values(prev);
      const startY = placed.length ? Math.max(...placed.map(p => p.y)) + 100 : 40;
      let newIdx = 0;
      for (const e of eqList) {
        if (prev[e.id]) { next[e.id] = prev[e.id]; continue; }
        changed = true;
        next[e.id] = e.position ?? { x: 40 + (newIdx % 4) * 160, y: startY + Math.floor(newIdx / 4) * 100 };
        if (!e.position) newIdx++;
      }
      return changed ? next : prev;
    });
  }, []);

  const syncConnections = useCallback((connList: FlowConnection[]) => {
    setConnections(prev => JSON.stringify(connList) === JSON.stringify(prev) ? prev : connList);
  }, []);

  return (
    <Ctx.Provider value={{ equipment, connections, positions, globalConfig, setPosition, addConnection, removeConnection, setGlobalConfig, syncGlobalConfig, syncEquipment, syncConnections }}>
      {children}
    </Ctx.Provider>
  );
}
