'use client';

import { useState, useRef, useCallback, useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { useMillStore, EQUIPMENT_DEFS, IO_POOL, getPortsForEquipment, GRID_SNAP, FLOW_HIDDEN_TYPES, GLOBAL_DEFAULTS, type EquipmentItem, type PortDef, type Position, type FlowConnection } from '../store';
import { useBackend, type BackendScaleConfig, type BackendOmronConfig, type BackendIoRackCard, type BackendCouplerType, type BackendEccModel } from '../backend';
import { IOSignalList } from './system';

function useIOPools(backend: ReturnType<typeof useBackend>) {
  if (!backend?.connected || backend.ioSignals.length === 0) return IO_POOL;
  const sigs = backend.ioSignals;
  return {
    do: sigs.filter(s => s.direction === 'DO').map(s => s.id),
    di: sigs.filter(s => s.direction === 'DI').map(s => s.id),
    ao: sigs.filter(s => s.direction === 'AO').map(s => s.id),
    ai: sigs.filter(s => s.direction === 'AI').map(s => s.id),
    com: IO_POOL.com,
  };
}

type SettingsSection = 'equipment' | 'io' | 'global';

export function SettingsTab() {
  const [section, setSection] = useState<SettingsSection>('equipment');

  return (
    <div className="flex gap-4 h-full">
      <div className="flex flex-col w-40 flex-shrink-0" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        {([['equipment', 'Equipment'], ['io', 'I/O Config'], ['global', 'Global']] as [SettingsSection, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className="px-4 py-3 text-sm font-medium text-left"
            style={{
              background: section === key ? 'var(--bg-row)' : 'transparent',
              color: section === key ? 'var(--fg-bright)' : 'var(--fg-dim)',
              borderBottom: '1px solid var(--border)',
              borderLeft: section === key ? '3px solid var(--accent)' : '3px solid transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {section === 'equipment' && <FlowPathSection />}
        {section === 'io' && <IOSection />}
        {section === 'global' && <GlobalSection />}
      </div>
    </div>
  );
}

// ─── Flow Path Visual Configurator ───

const BLOCK_W = 120;
const BLOCK_H = 50;

function snapVal(v: number) { return Math.round(v / GRID_SNAP) * GRID_SNAP; }

function portPosition(pos: Position, port: PortDef, allPorts: PortDef[]): { x: number; y: number } {
  const sameSide = allPorts.filter(p => p.side === port.side);
  const idx = sameSide.findIndex(p => p.id === port.id);
  const count = sameSide.length;
  const frac = (idx + 1) / (count + 1);

  switch (port.side) {
    case 'top':    return { x: pos.x + BLOCK_W * frac, y: pos.y };
    case 'bottom': return { x: pos.x + BLOCK_W * frac, y: pos.y + BLOCK_H };
    case 'left':   return { x: pos.x, y: pos.y + BLOCK_H * frac };
    case 'right':  return { x: pos.x + BLOCK_W, y: pos.y + BLOCK_H * frac };
  }
}

function portPositionForEq(eq: EquipmentItem, portId: string, positions: Record<string, Position>): { x: number; y: number } | null {
  const pos = positions[eq.id];
  if (!pos) return null;
  const ports = getPortsForEquipment(eq);
  const port = ports.find(p => p.id === portId);
  if (!port) return null;
  return portPosition(pos, port, ports);
}

const TYPE_COLORS: Record<string, string> = {
  bin: '#5c6bc0', hammermill: '#ef5350', mixer: '#ab47bc', finished_bin: '#26a69a',
  micro_drag: '#ffa726', gate: '#8d6e63', auger: '#29b6f6',
};

const ADD_TYPES = ['bin', 'hammermill', 'micro_drag', 'mixer', 'gate', 'finished_bin', 'auger'] as const;

function FlowPathSection() {
  const { equipment, connections, positions, setPosition, addConnection, removeConnection } = useMillStore();
  const backend = useBackend();
  const ioPools = useIOPools(backend);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Flow path edit mode — locks positions/connections only
  const [editMode, setEditMode] = useState(false);
  const [savedPositions, setSavedPositions] = useState<Record<string, Position> | null>(null);
  const [savedConnections, setSavedConnections] = useState<FlowConnection[] | null>(null);
  const [confirmAction, setConfirmAction] = useState<'save' | 'cancel' | null>(null);

  // Diagram interaction state
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [linking, setLinking] = useState<{ fromId: string; fromPort: string; mouseX: number; mouseY: number } | null>(null);
  const [selectedConn, setSelectedConn] = useState<number | null>(null);
  const [selectedEq, setSelectedEq] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({ x: -20, y: -20, w: 1200, h: 900 });
  const [panning, setPanning] = useState<{ startX: number; startY: number; vbX: number; vbY: number } | null>(null);

  // Sidebar equipment editing
  const [sidebarEditing, setSidebarEditing] = useState(false);
  const [sidebarDraft, setSidebarDraft] = useState<{ id: string; name: string; mode: string; config: Record<string, string | number | boolean> }>({ id: '', name: '', mode: '', config: {} });
  const [sidebarDirty, setSidebarDirty] = useState(false);
  const [sidebarGuard, setSidebarGuard] = useState(false);
  const [confirmDeleteEq, setConfirmDeleteEq] = useState(false);

  // Add equipment dropdown
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const flowEquipment = equipment.filter(e => !FLOW_HIDDEN_TYPES.has(e.equipmentType));

  // --- Edit mode ---
  function enterEdit() {
    setSavedPositions({ ...positions });
    setSavedConnections([...connections]);
    setEditMode(true);
    setConfirmAction(null);
  }

  function confirmSave() { setConfirmAction('save'); }
  function confirmCancel() { setConfirmAction('cancel'); }

  const sameConn = (a: FlowConnection, b: FlowConnection) =>
    a.from === b.from && a.fromPort === b.fromPort && a.to === b.to && a.toPort === b.toPort;

  async function doSave() {
    if (backend?.connected) {
      const stored = backend.connections;
      const added = connections.filter(c => !stored.some(s => sameConn(s, c)));
      const removed = stored.filter(s => !connections.some(c => sameConn(s, c)));
      await backend.sendCommand('SetEquipmentPositions', undefined, { positions });
      for (const c of removed) await backend.sendCommand('RemoveConnection', undefined, { ...c });
      for (const c of added) await backend.sendCommand('AddConnection', undefined, { ...c });
    }
    setSavedPositions(null);
    setSavedConnections(null);
    setEditMode(false);
    setConfirmAction(null);
  }

  function doCancel() {
    if (savedPositions) {
      Object.entries(savedPositions).forEach(([id, pos]) => setPosition(id, pos));
    }
    if (savedConnections) {
      connections.forEach(c => removeConnection(c.from, c.fromPort, c.to, c.toPort));
      savedConnections.forEach(c => addConnection(c.from, c.fromPort, c.to, c.toPort));
    }
    setSavedPositions(null);
    setSavedConnections(null);
    setEditMode(false);
    setConfirmAction(null);
  }

  // --- Sidebar ---
  function openSidebar(eqId: string) {
    if (sidebarDirty && sidebarEditing) {
      setSidebarGuard(true);
      return;
    }
    const eq = equipment.find(e => e.id === eqId);
    if (!eq) return;
    setSelectedEq(eqId);
    setSidebarEditing(false);
    setSidebarDirty(false);
    setSidebarGuard(false);
    setConfirmDeleteEq(false);
    setSidebarDraft({ id: eq.id, name: eq.name, mode: eq.mode, config: { ...eq.config } });
  }

  function closeSidebar() {
    if (sidebarDirty && sidebarEditing) {
      setSidebarGuard(true);
      return;
    }
    setSelectedEq(null);
    setSidebarEditing(false);
    setSidebarDirty(false);
    setSidebarGuard(false);
  }

  function startSidebarEdit() {
    const eq = equipment.find(e => e.id === selectedEq);
    if (!eq) return;
    setSidebarEditing(true);
    setSidebarDraft({ id: eq.id, name: eq.name, mode: eq.mode, config: { ...eq.config } });
    setSidebarDirty(false);
  }

  async function saveSidebarEdit() {
    if (!selectedEq || !backend?.connected) return;
    const allIds = new Set(equipment.map(e => e.id));
    const newId = sidebarDraft.id.trim();
    if (!newId || (newId !== selectedEq && allIds.has(newId))) return;
    const result = await backend.sendCommand('UpdateEquipment', selectedEq, { name: sidebarDraft.name, config: sidebarDraft.config, ...(newId !== selectedEq ? { newId } : {}) });
    if (!result.accepted) return;
    if (newId !== selectedEq) {
      const pos = positions[selectedEq];
      if (pos) setPosition(newId, pos);
      setSelectedEq(newId);
    }
    setSidebarEditing(false);
    setSidebarDirty(false);
    setSidebarGuard(false);
  }

  async function deleteSelectedEquipment() {
    if (!selectedEq || !backend?.connected) return;
    const result = await backend.sendCommand('RemoveEquipment', selectedEq);
    setConfirmDeleteEq(false);
    if (result.accepted) {
      setSelectedEq(null);
      setSidebarEditing(false);
      setSidebarDirty(false);
    }
  }

  function cancelSidebarEdit() {
    setSidebarEditing(false);
    setSidebarDirty(false);
    setSidebarGuard(false);
  }

  function updateSidebarDraft(d: typeof sidebarDraft) {
    setSidebarDraft(d);
    setSidebarDirty(true);
  }

  // --- SVG coordinate transform (uses getScreenCTM so preserveAspectRatio is handled) ---
  const svgPt = useCallback((e: ReactMouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM()?.inverse();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm);
    return { x: pt.x, y: pt.y };
  }, []);

  // --- Mouse handlers ---
  const handleBlockMouseDown = useCallback((e: ReactMouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (editMode) {
      const pt = svgPt(e);
      const pos = positions[id] ?? { x: 0, y: 0 };
      setDragging({ id, offsetX: pt.x - pos.x, offsetY: pt.y - pos.y });
    }
    setSelectedConn(null);
    openSidebar(id);
  }, [editMode, positions, svgPt, sidebarDirty, sidebarEditing]);

  const handlePortMouseDown = useCallback((e: ReactMouseEvent, eqId: string, portId: string) => {
    if (!editMode) return;
    e.stopPropagation();
    const pt = svgPt(e);
    setLinking({ fromId: eqId, fromPort: portId, mouseX: pt.x, mouseY: pt.y });
  }, [editMode, svgPt]);

  const handleMouseMove = useCallback((e: ReactMouseEvent) => {
    const pt = svgPt(e);
    if (dragging && editMode) {
      setPosition(dragging.id, { x: snapVal(pt.x - dragging.offsetX), y: snapVal(pt.y - dragging.offsetY) });
    }
    if (linking) {
      setLinking(prev => prev ? { ...prev, mouseX: pt.x, mouseY: pt.y } : null);
    }
    if (panning) {
      const svg = svgRef.current;
      if (!svg) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const dx = (e.clientX - panning.startX) / ctm.a;
      const dy = (e.clientY - panning.startY) / ctm.d;
      setViewBox(prev => ({ ...prev, x: panning.vbX - dx, y: panning.vbY - dy }));
    }
  }, [dragging, editMode, linking, panning, setPosition, svgPt]);

  const handleMouseUp = useCallback((e: ReactMouseEvent) => {
    if (linking && editMode) {
      const pt = svgPt(e);
      for (const eq of flowEquipment) {
        const ports = getPortsForEquipment(eq);
        for (const port of ports) {
          const pp = portPositionForEq(eq, port.id, positions);
          if (!pp) continue;
          const dist = Math.sqrt((pt.x - pp.x) ** 2 + (pt.y - pp.y) ** 2);
          if (dist < 12 && eq.id !== linking.fromId) {
            const fromEq = flowEquipment.find(e2 => e2.id === linking.fromId);
            const fromPorts = fromEq ? getPortsForEquipment(fromEq) : [];
            const fromPort = fromPorts.find(p => p.id === linking.fromPort);
            if (fromPort?.type === 'outlet' && port.type === 'inlet') {
              addConnection(linking.fromId, linking.fromPort, eq.id, port.id);
            } else if (fromPort?.type === 'inlet' && port.type === 'outlet') {
              addConnection(eq.id, port.id, linking.fromId, linking.fromPort);
            }
            break;
          }
        }
      }
      setLinking(null);
    }
    setDragging(null);
    setPanning(null);
  }, [linking, editMode, flowEquipment, positions, addConnection, svgPt]);

  const handleBgMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button === 0) {
      setPanning({ startX: e.clientX, startY: e.clientY, vbX: viewBox.x, vbY: viewBox.y });
      setSelectedConn(null);
      if (selectedEq && !sidebarGuard) {
        if (sidebarDirty && sidebarEditing) {
          setSidebarGuard(true);
        } else {
          setSelectedEq(null);
          setSidebarEditing(false);
        }
      }
    }
  }, [viewBox.x, viewBox.y, selectedEq, sidebarDirty, sidebarEditing, sidebarGuard]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    setViewBox(prev => {
      const nw = prev.w * factor;
      const nh = prev.h * factor;
      return { x: prev.x + (prev.w - nw) * mx, y: prev.y + (prev.h - nh) * my, w: nw, h: nh };
    });
  }, []);

  // --- Delete key for connections ---
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Delete' && selectedConn !== null && editMode) {
        const c = connections[selectedConn];
        if (c) removeConnection(c.from, c.fromPort, c.to, c.toPort);
        setSelectedConn(null);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedConn, editMode, connections, removeConnection]);

  // --- Add equipment from toolbar ---
  function handleAddEquipment(type: string) {
    backend?.sendCommand('AddEquipment', undefined, { equipmentType: type });
    setAddMenuOpen(false);
  }

  const selectedItem = selectedEq ? equipment.find(e => e.id === selectedEq) : null;
  const allIds = new Set(equipment.map(e => e.id));
  const idDup = sidebarEditing && sidebarDraft.id.trim() !== selectedEq && allIds.has(sidebarDraft.id.trim());
  const inputStyle = { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontFamily: 'inherit', fontSize: '12px', width: '100%' };

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      {/* Main diagram area */}
      <div className="flex flex-col gap-2" style={{ height: '100%' }} ref={containerRef}>
        {/* Toolbar */}
        <div className="flex items-center gap-2" style={{ fontSize: '11px' }}>
          {!editMode ? (
            <button onClick={enterEdit} className="px-3 py-1.5 text-xs font-medium"
              style={{ background: 'transparent', color: 'var(--fg-bright)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
              Edit Layout
            </button>
          ) : (
            <>
              {confirmAction === 'save' ? (
                <div className="flex items-center gap-2">
                  <span style={{ color: 'var(--fg-dim)' }}>Apply layout changes?</span>
                  <button onClick={doSave} className="px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Confirm</button>
                  <button onClick={() => setConfirmAction(null)} className="px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Back</button>
                </div>
              ) : confirmAction === 'cancel' ? (
                <div className="flex items-center gap-2">
                  <span style={{ color: 'var(--red)' }}>Discard layout changes?</span>
                  <button onClick={doCancel} className="px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'var(--red)', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Discard</button>
                  <button onClick={() => setConfirmAction(null)} className="px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Back</button>
                </div>
              ) : (
                <>
                  <button onClick={confirmSave} className="px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Save</button>
                  <button onClick={confirmCancel} className="px-3 py-1.5 text-xs font-medium"
                    style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Cancel</button>
                  <div style={{ position: 'relative' }}>
                    <button onClick={() => setAddMenuOpen(!addMenuOpen)} className="px-2 py-1.5 text-xs font-medium"
                      style={{ color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>+ Add Equipment</button>
                    {addMenuOpen && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 20, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px', minWidth: '160px', marginTop: '2px' }}>
                        {ADD_TYPES.map(t => (
                          <div key={t} onClick={() => handleAddEquipment(t)} className="px-3 py-2 cursor-pointer text-xs"
                            style={{ color: 'var(--fg-bright)', borderBottom: '1px solid var(--border)' }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-row)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            {EQUIPMENT_DEFS[t].label}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {selectedConn !== null && (
                    <button onClick={() => {
                      const c = connections[selectedConn];
                      if (c) removeConnection(c.from, c.fromPort, c.to, c.toPort);
                      setSelectedConn(null);
                    }} className="px-2 py-1.5 text-xs"
                      style={{ color: 'var(--red)', border: '1px solid var(--red)', borderRadius: '3px', background: 'transparent', cursor: 'pointer' }}>
                      Remove Connection
                    </button>
                  )}
                </>
              )}
            </>
          )}
          <span style={{ color: 'var(--fg-dim)', fontSize: '11px', marginLeft: 'auto' }}>
            {editMode ? 'Editing — drag blocks, connect ports' : 'Click equipment to configure'}
          </span>
        </div>

        {/* SVG Canvas */}
        <div style={{ flex: 1, background: 'var(--bg)', border: `2px solid ${editMode ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '3px', overflow: 'hidden', minHeight: '500px' }}>
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            onMouseDown={handleBgMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            style={{ cursor: dragging ? 'grabbing' : panning ? 'grabbing' : 'default', userSelect: 'none' }}
            tabIndex={0}
          >
            {/* Grid */}
            <defs>
              <pattern id="grid" width={GRID_SNAP} height={GRID_SNAP} patternUnits="userSpaceOnUse">
                <path d={`M ${GRID_SNAP} 0 L 0 0 0 ${GRID_SNAP}`} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect x={viewBox.x - 2000} y={viewBox.y - 2000} width={viewBox.w + 4000} height={viewBox.h + 4000} fill="url(#grid)" />

            {/* Connection lines */}
            {connections.map((c, i) => {
              const fromEq = flowEquipment.find(e => e.id === c.from);
              const toEq = flowEquipment.find(e => e.id === c.to);
              if (!fromEq || !toEq) return null;
              const from = portPositionForEq(fromEq, c.fromPort, positions);
              const to = portPositionForEq(toEq, c.toPort, positions);
              if (!from || !to) return null;
              const midY = (from.y + to.y) / 2;
              const sel = selectedConn === i;
              return (
                <g key={i}>
                  <path d={`M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`}
                    fill="none" stroke={sel ? 'var(--accent)' : 'rgba(255,255,255,0.2)'} strokeWidth={sel ? 2.5 : 1.5} />
                  <path d={`M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`}
                    fill="none" stroke="transparent" strokeWidth="10" style={{ cursor: editMode ? 'pointer' : 'default' }}
                    onClick={(e) => { if (editMode) { e.stopPropagation(); setSelectedConn(i); } }} />
                </g>
              );
            })}

            {/* Linking preview */}
            {linking && (() => {
              const fromEq = flowEquipment.find(e => e.id === linking.fromId);
              if (!fromEq) return null;
              const from = portPositionForEq(fromEq, linking.fromPort, positions);
              if (!from) return null;
              return <line x1={from.x} y1={from.y} x2={linking.mouseX} y2={linking.mouseY}
                stroke="var(--accent)" strokeWidth="2" strokeDasharray="6,3" pointerEvents="none" />;
            })()}

            {/* Equipment blocks */}
            {flowEquipment.map(eq => {
              const pos = positions[eq.id];
              if (!pos) return null;
              const ports = getPortsForEquipment(eq);
              const color = TYPE_COLORS[eq.equipmentType] ?? '#555';
              const isSel = selectedEq === eq.id;

              return (
                <g key={eq.id}>
                  {isSel && <rect x={pos.x - 3} y={pos.y - 3} width={BLOCK_W + 6} height={BLOCK_H + 6} rx={6}
                    fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4,2" />}
                  <rect
                    x={pos.x} y={pos.y} width={BLOCK_W} height={BLOCK_H} rx={4}
                    fill="var(--bg-panel)" stroke={color} strokeWidth="1.5"
                    style={{ cursor: editMode ? 'grab' : 'pointer' }}
                    onMouseDown={(e) => handleBlockMouseDown(e, eq.id)}
                  />
                  <text x={pos.x + BLOCK_W / 2} y={pos.y + 18} textAnchor="middle"
                    fill={color} fontSize="11" fontWeight="700" fontFamily="Roboto, sans-serif"
                    pointerEvents="none">{eq.id}</text>
                  <text x={pos.x + BLOCK_W / 2} y={pos.y + 34} textAnchor="middle"
                    fill="rgba(255,255,255,0.5)" fontSize="9" fontFamily="Roboto, sans-serif"
                    pointerEvents="none">
                    {eq.name.length > 16 ? eq.name.slice(0, 15) + '…' : eq.name}
                  </text>

                  {ports.map(port => {
                    const pp = portPosition(pos, port, ports);
                    const isInlet = port.type === 'inlet';
                    return (
                      <g key={port.id}>
                        <circle cx={pp.x} cy={pp.y} r={5}
                          fill={isInlet ? '#333' : color} stroke={color} strokeWidth="1.5"
                          style={{ cursor: editMode ? 'crosshair' : 'default' }}
                          onMouseDown={(e) => handlePortMouseDown(e, eq.id, port.id)} />
                        <text
                          x={pp.x}
                          y={pp.y + (port.side === 'top' ? -6 : 12)}
                          textAnchor="middle"
                          fill="rgba(255,255,255,0.35)" fontSize="7" fontFamily="Roboto, sans-serif"
                          pointerEvents="none"
                        >{port.label}</text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Right sidebar for equipment settings */}
      {selectedItem && (
        <div style={{ width: '280px', position: 'absolute', top: 0, right: 0, bottom: 0, background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'auto', zIndex: 10 }}>
          <div className="px-3 py-2.5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 700 }}>{selectedItem.id}</span>
            <button onClick={closeSidebar} style={{ color: 'var(--fg-dim)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '16px', lineHeight: '1' }}>✕</button>
          </div>

          {sidebarGuard && (
            <div className="px-3 py-2" style={{ background: 'rgba(229,57,53,0.1)', borderBottom: '1px solid var(--border)', fontSize: '11px' }}>
              <span style={{ color: 'var(--red)' }}>Unsaved changes. </span>
              <button onClick={saveSidebarEdit} className="text-xs" style={{ color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Save</button>
              <span style={{ color: 'var(--fg-dim)' }}> or </span>
              <button onClick={cancelSidebarEdit} className="text-xs" style={{ color: 'var(--fg-dim)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Discard</button>
            </div>
          )}

          <div className="px-3 py-3 flex flex-col gap-2" style={{ fontSize: '12px' }}>
            {/* ID */}
            <div className="flex flex-col gap-1">
              <span style={{ color: 'var(--fg-dim)' }}>ID</span>
              {sidebarEditing ? (
                <div className="flex items-center gap-1">
                  <span style={{ color: 'var(--fg-dim)' }}>{selectedItem.prefix}-</span>
                  <input value={sidebarDraft.id.slice(selectedItem.prefix.length + 1)}
                    onChange={e => updateSidebarDraft({ ...sidebarDraft, id: selectedItem.prefix + '-' + e.target.value })}
                    style={{ ...inputStyle, width: '80px', borderColor: idDup ? 'var(--red)' : undefined }} />
                  {idDup && <span style={{ color: 'var(--red)', fontSize: '11px' }}>Taken</span>}
                </div>
              ) : <span style={{ color: 'var(--fg-bright)' }}>{selectedItem.id}</span>}
            </div>

            {/* Name */}
            <div className="flex flex-col gap-1">
              <span style={{ color: 'var(--fg-dim)' }}>Name</span>
              {sidebarEditing
                ? <input value={sidebarDraft.name} onChange={e => updateSidebarDraft({ ...sidebarDraft, name: e.target.value })} style={inputStyle} />
                : <span style={{ color: 'var(--fg-bright)' }}>{selectedItem.name}</span>}
            </div>

            {/* Type */}
            <div className="flex flex-col gap-1">
              <span style={{ color: 'var(--fg-dim)' }}>Type</span>
              <span style={{ color: TYPE_COLORS[selectedItem.equipmentType] ?? 'var(--fg-bright)' }}>
                {EQUIPMENT_DEFS[selectedItem.equipmentType]?.label ?? selectedItem.equipmentType}
              </span>
            </div>

            {/* Type-specific config */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '4px' }}>
              <SidebarTypeConfig
                type={selectedItem.equipmentType}
                cfg={sidebarEditing ? sidebarDraft.config : selectedItem.config}
                editing={sidebarEditing}
                setCfg={(key, val) => updateSidebarDraft({ ...sidebarDraft, config: { ...sidebarDraft.config, [key]: val } })}
                inputStyle={inputStyle}
                scaleConfigs={backend?.scaleConfigs ?? []}
                ioPools={ioPools}
                equipmentId={selectedItem.id}
                connections={connections}
                allEquipment={equipment}
              />
            </div>
          </div>

          {/* Sidebar action buttons */}
          <div className="px-3 py-2 flex items-center gap-2" style={{ borderTop: '1px solid var(--border)', marginTop: 'auto' }}>
            {!sidebarEditing ? (
              <button onClick={startSidebarEdit} className="px-3 py-1.5 text-xs font-medium"
                style={{ background: 'transparent', color: 'var(--fg-bright)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Edit</button>
            ) : (
              <>
                <button onClick={saveSidebarEdit} className="px-3 py-1.5 text-xs font-medium"
                  style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Save</button>
                <button onClick={cancelSidebarEdit} className="px-3 py-1.5 text-xs font-medium"
                  style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Cancel</button>
              </>
            )}
            {editMode && !sidebarEditing && (confirmDeleteEq ? (
              <span className="flex items-center gap-1" style={{ marginLeft: 'auto' }}>
                <button onClick={deleteSelectedEquipment} className="px-2 py-1.5 text-xs font-medium"
                  style={{ background: 'var(--red)', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Delete {selectedItem.id}</button>
                <button onClick={() => setConfirmDeleteEq(false)} className="px-2 py-1.5 text-xs font-medium"
                  style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDeleteEq(true)} className="px-3 py-1.5 text-xs font-medium"
                style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: '3px', cursor: 'pointer' }}>Delete</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sidebar Type-Specific Config ───

interface IOPools { do: string[]; di: string[]; ao: string[]; ai: string[]; com: string[] }

interface ConfigPanelProps {
  type: string;
  cfg: Record<string, string | number | boolean>;
  editing: boolean;
  setCfg: (key: string, val: string | number | boolean) => void;
  inputStyle: React.CSSProperties;
  scaleConfigs: BackendScaleConfig[];
  ioPools: IOPools;
  equipmentId?: string;
  connections?: FlowConnection[];
  allEquipment?: EquipmentItem[];
}

function SidebarTypeConfig({ type, cfg, editing, setCfg, inputStyle, scaleConfigs, ioPools, equipmentId, connections, allEquipment }: ConfigPanelProps) {
  const v = (key: string, fb: string | number | boolean = '') => cfg[key] ?? fb;

  const row = (label: string, content: React.ReactNode) => (
    <div className="flex flex-col gap-1" style={{ marginBottom: '4px' }}>
      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>{label}</span>
      {content}
    </div>
  );

  const ioSel = (pool: string[], key: string) => {
    const val = (v(key) as string) || '';
    if (!editing) return <span style={{ color: val ? 'var(--fg-bright)' : 'var(--fg-dim)', fontSize: '12px' }}>{val || 'Not Assigned'}</span>;
    return (
      <select value={val} onChange={e => setCfg(key, e.target.value)} style={inputStyle}>
        <option value="">Not Assigned</option>
        {pool.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
    );
  };

  // Level switch wiring: which input state means the sensor is covered by material
  const coveredSel = (key: string) => {
    const val = v(key, 'high') as string;
    if (!editing) return <span style={{ color: 'var(--fg-bright)', fontSize: '12px' }}>{val === 'low' ? 'Low = covered' : 'High = covered'}</span>;
    return (
      <select value={val} onChange={e => setCfg(key, e.target.value)} style={inputStyle}>
        <option value="high">High = covered</option>
        <option value="low">Low = covered</option>
      </select>
    );
  };

  const numIn = (key: string, fb = 0, suffix = '', step?: number) => {
    const val = v(key, fb) as number;
    if (!editing) return <span style={{ color: 'var(--fg-bright)', fontSize: '12px' }}>{val}{suffix ? ` ${suffix}` : ''}</span>;
    return <input type="number" value={val} step={step} min={step ? 0 : undefined} onChange={e => setCfg(key, Number(e.target.value))} style={inputStyle} />;
  };

  const check = (key: string, label: string) => {
    const val = !!v(key, false);
    if (!editing) return <span style={{ color: val ? 'var(--accent)' : 'var(--fg-dim)', fontSize: '12px' }}>{val ? label : '—'}</span>;
    return (
      <label className="flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--fg-bright)', fontSize: '12px' }}>
        <input type="checkbox" checked={val} onChange={e => setCfg(key, e.target.checked)} /> {label}
      </label>
    );
  };

  const scaleSel = (key: string, scaleConfigs: BackendScaleConfig[]) => {
    const val = (v(key) as string) || '';
    if (!editing) {
      const sc = scaleConfigs.find(s => s.id === val);
      return <span style={{ color: val ? 'var(--fg-bright)' : 'var(--fg-dim)', fontSize: '12px' }}>{sc ? sc.name : (val || 'Not Assigned')}</span>;
    }
    return (
      <select value={val} onChange={e => setCfg(key, e.target.value)} style={inputStyle}>
        <option value="">Not Assigned</option>
        {scaleConfigs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    );
  };

  const motorFields = (opts: { rotation?: boolean; load?: boolean; delays?: boolean }) => (
    <>
      {row('Run Output', ioSel(ioPools.do, 'runOutput'))}
      {row('Run Confirmation Aux', ioSel(ioPools.di, 'runConfirmAux'))}
      {opts.rotation !== false && <>
        {row('Rotation Pulse Input', ioSel(ioPools.di, 'rotationPulseInput'))}
        {v('rotationPulseInput') && <>
          {row('Pulses per Rev', numIn('pulsesPerRev', 1))}
          {row('Min RPM', numIn('minRpm', 0))}
          {row('Rotation Startup Delay', numIn('rotationStartupDelay', 0, 's', 0.1))}
        </>}
      </>}
      {opts.delays !== false && <>
        {row('Start Delay', numIn('startDelay', 0, 's', 0.1))}
        {row('Stop Delay', numIn('stopDelay', 0, 's', 0.1))}
      </>}
      {row('Analog Speed Output', ioSel(ioPools.ao, 'analogSpeedOutput'))}
      {v('analogSpeedOutput') && <>
        {row('Speed Min %', numIn('speedMinPct', 0, '%'))}
        {row('Speed Max %', numIn('speedMaxPct', 100, '%'))}
        {row('Speed Min Limit %', numIn('speedMinLimit', 0, '%'))}
        {row('Speed Max Limit %', numIn('speedMaxLimit', 100, '%'))}
      </>}
      {opts.load !== false && <>
        {row('Analog Load Input', ioSel(ioPools.ai, 'analogLoadInput'))}
        {v('analogLoadInput') && <>
          {row('Min Amps', numIn('minAmps', 0, 'A'))}
          {row('Max Amps', numIn('maxAmps', 0, 'A'))}
          {row('Motor FLA', numIn('motorFla', 0, 'A'))}
        </>}
      </>}
    </>
  );

  switch (type) {
    case 'bin': {
      const connectedAugerId = connections?.find(c => c.from === equipmentId)?.to;
      const connectedAuger = connectedAugerId ? allEquipment?.find(e => e.id === connectedAugerId) : undefined;
      const augerHasAnalog = !!(connectedAuger?.config.analogSpeedOutput);
      return <>
        {row('Capacity', numIn('capacity', 0, 'lbs'))}
        {row('High Level Input', ioSel(ioPools.di, 'highLevelInput'))}
        {v('highLevelInput') && row('High Level Polarity', coveredSel('highLevelCovered'))}
        {v('highLevelInput') && row('Bin Full Stop Delay', numIn('binFullStopDelay', 0, 's', 0.1))}
        {row('Low Level Input', ioSel(ioPools.di, 'lowLevelInput'))}
        {v('lowLevelInput') && row('Low Level Polarity', coveredSel('lowLevelCovered'))}
        {v('lowLevelInput') && row('Bin Low Restart Delay', numIn('binLowRestartDelay', 0, 's', 0.1))}
        {row('Freefall', numIn('freefall', 0, 'lbs'))}
        {augerHasAnalog && <>
          {row('Slow Feed Speed', numIn('slowFeedSpeed', 50, '%'))}
          {row('Slow Feed', numIn('slowFeedLbs', 0, 'lbs'))}
        </>}
      </>;
    }

    case 'auger':
      return <>
        {motorFields({ rotation: true, load: true, delays: true })}
        {row('Master VFD', check('masterVfd', 'Master VFD'))}
        {v('masterVfd') && <>
          {row('VFD Run Output', ioSel(ioPools.do, 'vfdRunOutput'))}
          {row('VFD Aux Input', ioSel(ioPools.di, 'vfdAuxInput'))}
        </>}
      </>;

    case 'hammermill': {
      const hmDests: { id: string; name: string }[] = [];
      if (connections && allEquipment && equipmentId) {
        const visited = new Set<string>();
        const stack = [equipmentId];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (visited.has(cur)) continue;
          visited.add(cur);
          for (const c of connections) {
            if (c.from === cur && !visited.has(c.to)) {
              const target = allEquipment.find(e => e.id === c.to);
              if (target && (target.equipmentType === 'bin' || target.equipmentType === 'finished_bin')) {
                hmDests.push({ id: target.id, name: target.name });
              }
              stack.push(c.to);
            }
          }
        }
      }
      const destVal = (v('destination') as string) || '';
      return <>
        {row('Destination', editing
          ? <select value={destVal} onChange={e => setCfg('destination', e.target.value)} style={inputStyle}>
              <option value="">Not Assigned</option>
              {hmDests.map(d => <option key={d.id} value={d.id}>{d.id} — {d.name}</option>)}
            </select>
          : <span style={{ color: destVal ? 'var(--fg-bright)' : 'var(--fg-dim)', fontSize: '12px' }}>{destVal || 'Not Assigned'}</span>
        )}
        {motorFields({ rotation: true, load: true, delays: true })}
        {v('analogLoadInput') && row('High Current Pause Setpoint', numIn('highCurrentPauseSetpoint', 0, '%'))}
        {row('Auto Enable', check('autoEnable', 'Auto Enable'))}
        {row('Max Fill Time', numIn('maxFillMinutes', 60, 'min'))}
      </>;
    }

    case 'mixer':
      return <>
        {row('Capacity', numIn('capacity', 4000, 'lbs'))}
        {row('Run Output', ioSel(ioPools.do, 'runOutput'))}
        {row('Run Confirmation Aux', ioSel(ioPools.di, 'runConfirmAux'))}
        {row('Analog Load Input', ioSel(ioPools.ai, 'analogLoadInput'))}
        {v('analogLoadInput') && <>
          {row('Min Amps', numIn('minAmps', 0, 'A'))}
          {row('Max Amps', numIn('maxAmps', 0, 'A'))}
          {row('Motor FLA', numIn('motorFla', 0, 'A'))}
        </>}
        {row('Scale', scaleSel('scaleId', scaleConfigs))}
      </>;

    case 'micro_drag':
      return <>
        {row('Run Output', ioSel(ioPools.do, 'runOutput'))}
        {row('Run Confirmation Aux', ioSel(ioPools.di, 'runConfirmAux'))}
        {row('Start Delay', numIn('startDelay', 0, 's', 0.1))}
        {row('Stop Delay', numIn('stopDelay', 0, 's', 0.1))}
        {row('Timer Based Dosing', check('timerBasedDosing', 'Timer Based Dosing'))}
        {!v('timerBasedDosing') && row('Scale', scaleSel('scaleId', scaleConfigs))}
        {row('Weight Stop Setpoint', numIn('weightStopSetpoint', 0, 'lbs'))}
      </>;

    case 'gate':
      return <>
        {row('Actuator Type', editing
          ? <select value={(v('actuatorType', 'single') as string)} onChange={e => setCfg('actuatorType', e.target.value)} style={inputStyle}>
              <option value="single">Single</option>
              <option value="dual">Dual</option>
            </select>
          : <span style={{ color: 'var(--fg-bright)', fontSize: '12px' }}>{v('actuatorType', 'single') === 'dual' ? 'Dual' : 'Single'}</span>
        )}
        {row('Open Output', ioSel(ioPools.do, 'openOutput'))}
        {v('actuatorType') === 'dual' && row('Close Output', ioSel(ioPools.do, 'closeOutput'))}
        {row('Open Limit Input', ioSel(ioPools.di, 'openLimitInput'))}
        {row('Closed Limit Input', ioSel(ioPools.di, 'closedLimitInput'))}
        {row('Position Timeout', numIn('positionTimeout', 5, 's', 0.1))}
      </>;

    case 'finished_bin':
      return <>
        {row('Assigned Product', editing
          ? <input value={(v('assignedProduct') as string) || ''} onChange={e => setCfg('assignedProduct', e.target.value)} style={inputStyle} placeholder="Not Assigned" />
          : <span style={{ color: v('assignedProduct') ? 'var(--fg-bright)' : 'var(--fg-dim)', fontSize: '12px' }}>{(v('assignedProduct') as string) || 'Not Assigned'}</span>
        )}
        {row('Capacity', numIn('capacity', 10000, 'lbs'))}
        {row('Scale Input', check('scaleInput', 'Scale Input'))}
        {v('scaleInput') && row('Scale', scaleSel('scaleId', scaleConfigs))}
        {row('Full Sensor', ioSel(ioPools.di, 'fullSensor'))}
        {v('fullSensor') && row('Full Sensor Polarity', coveredSel('fullSensorCovered'))}
        {v('fullSensor') && row('Bin Full Stop Delay', numIn('binFullStopDelay', 0, 's', 0.1))}
        {row('Low Sensor', ioSel(ioPools.di, 'lowSensor'))}
        {v('lowSensor') && row('Low Sensor Polarity', coveredSel('lowSensorCovered'))}
        {v('lowSensor') && row('Bin Low Restart Delay', numIn('binLowRestartDelay', 0, 's', 0.1))}
      </>;

    default:
      return null;
  }
}

// ─── I/O Configuration Section ───

function IOSection() {
  const backend = useBackend();
  const [editingScale, setEditingScale] = useState<BackendScaleConfig | null>(null);
  const [scaleDraft, setScaleDraft] = useState<BackendScaleConfig>({ id: '', name: '', connectionType: 'serial', protocol: '', comPort: '', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, rackSlot: 0, zeroOffset: 0, ratedMvV: 2.0, capacity: 5000, resolution: 1, freshnessTimeout: 5000, stabilityWindow: 500 });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [commissioningOpen, setCommissioningOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [calStep, setCalStep] = useState<'zero' | 'span'>('zero');
  const [calZeroReading, setCalZeroReading] = useState(0);
  const [calTestWeight, setCalTestWeight] = useState('');

  const scaleConfigs = backend?.scaleConfigs ?? [];
  const om: BackendOmronConfig = backend?.omronConfig ?? { couplerType: 'none', ipAddress: '', nodeAddress: 1, ethercatInterface: '', eccModel: 'NX-ECC203', cycleTimeUs: 5000, ringTopology: false, cards: [], rackVerified: false, warnings: [] };
  const commissioningMode = backend?.commissioningMode ?? false;
  const [omDraft, setOmDraft] = useState<BackendOmronConfig>(om);
  const [omEditing, setOmEditing] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [confirmReadRack, setConfirmReadRack] = useState(false);

  const inputStyle = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontFamily: 'inherit', fontSize: '12px', width: '100%' } as const;

  const NX_CARDS = [
    { model: 'NX-PF0730', label: 'NX-PF0730 — I/O Power Supply (10A)', cat: 'Power' },
    { model: 'NX-PF0630', label: 'NX-PF0630 — Addl I/O Power (4A)', cat: 'Power' },
    { model: 'NX-PC0030', label: 'NX-PC0030 — I/O Power Connection', cat: 'Power' },
    { model: 'NX-ID5442', label: 'NX-ID5442 — 16pt DI (PNP)', cat: 'Digital Input' },
    { model: 'NX-ID5342', label: 'NX-ID5342 — 16pt DI (NPN)', cat: 'Digital Input' },
    { model: 'NX-ID4342', label: 'NX-ID4342 — 8pt DI (NPN)', cat: 'Digital Input' },
    { model: 'NX-ID4442', label: 'NX-ID4442 — 8pt DI (PNP)', cat: 'Digital Input' },
    { model: 'NX-IA3117', label: 'NX-IA3117 — 4pt AC Input (200-240V)', cat: 'Digital Input' },
    { model: 'NX-OD5256', label: 'NX-OD5256 — 16pt DO (PNP)', cat: 'Digital Output' },
    { model: 'NX-OD4256', label: 'NX-OD4256 — 8pt DO (PNP)', cat: 'Digital Output' },
    { model: 'NX-OC4633', label: 'NX-OC4633 — 8pt Relay (indep. contacts)', cat: 'Digital Output' },
    { model: 'NX-OC2633', label: 'NX-OC2633 — 2pt Relay (indep. contacts)', cat: 'Digital Output' },
    { model: 'NX-AD4203', label: 'NX-AD4203 — 8ch AI (4-20mA)', cat: 'Analog Input' },
    { model: 'NX-AD4603', label: 'NX-AD4603 — 8ch AI (±10V)', cat: 'Analog Input' },
    { model: 'NX-AD2203', label: 'NX-AD2203 — 2ch AI (4-20mA)', cat: 'Analog Input' },
    { model: 'NX-AD3203', label: 'NX-AD3203 — 4ch AI (4-20mA)', cat: 'Analog Input' },
    { model: 'NX-DA2203', label: 'NX-DA2203 — 2ch AO (4-20mA)', cat: 'Analog Output' },
    { model: 'NX-DA3203', label: 'NX-DA3203 — 4ch AO (4-20mA)', cat: 'Analog Output' },
    { model: 'NX-DA3603', label: 'NX-DA3603 — 4ch AO (±10V)', cat: 'Analog Output' },
    { model: 'NX-RS1201', label: 'NX-RS1201 — 1ch Load Cell (24-bit)', cat: 'Scale' },
    { model: 'NX-PD1000', label: 'NX-PD1000 — Addl NX Bus Power (10W)', cat: 'Power' },
  ];

  function renumberCards(cards: BackendIoRackCard[]) { return cards.map((c, i) => ({ ...c, slot: i + 1 })); }
  function startEditOmron() { setOmDraft({ ...om, cards: om.cards.map(c => ({ ...c })) }); setOmEditing(true); }
  function saveOmron() {
    const sorted = { ...omDraft, cards: renumberCards(omDraft.cards) };
    backend?.sendCommand('ConfigureOmron', undefined, sorted as unknown as Record<string, unknown>);
    setOmEditing(false);
  }
  function cancelOmron() { setOmEditing(false); }
  function addCard() {
    const nextSlot = omDraft.cards.length + 1;
    setOmDraft({ ...omDraft, cards: [...omDraft.cards, { slot: nextSlot, model: nextSlot === 1 ? 'NX-PF0730' : 'NX-ID5342', status: 'unchecked' as const }] });
  }
  function removeCard(idx: number) {
    setOmDraft({ ...omDraft, cards: renumberCards(omDraft.cards.filter((_, i) => i !== idx)) });
  }
  function updateCardModel(idx: number, model: string) {
    const cards = omDraft.cards.map((c, i) => i === idx ? { ...c, model } : c);
    setOmDraft({ ...omDraft, cards });
  }
  function handleDragStart(i: number) { setDragIdx(i); }
  function handleDragOver(e: React.DragEvent, i: number) { e.preventDefault(); setDragOverIdx(i); }
  function handleDragEnd() { setDragIdx(null); setDragOverIdx(null); }
  function handleDrop(i: number) {
    if (dragIdx === null || dragIdx === i) { setDragIdx(null); setDragOverIdx(null); return; }
    const cards = [...omDraft.cards];
    const [moved] = cards.splice(dragIdx, 1);
    cards.splice(i, 0, moved);
    setOmDraft({ ...omDraft, cards: renumberCards(cards) });
    setDragIdx(null);
    setDragOverIdx(null);
  }
  function doReadRack() { backend?.sendCommand('ReadOmronRack'); setConfirmReadRack(false); }

  // Commissioning
  function toggleCommissioningMode(en: boolean) {
    backend?.sendCommand('SetCommissioningMode', undefined, { enabled: en });
  }

  // Scales
  const rs1201Slots = om.cards.filter(c => c.model === 'NX-RS1201').map(c => c.slot);

  function startAddScale() {
    const nextNum = scaleConfigs.length + 1;
    setScaleDraft({ id: `SC-${nextNum}`, name: `Scale ${nextNum}`, connectionType: 'serial', protocol: '', comPort: '', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, rackSlot: 0, zeroOffset: 0, ratedMvV: 2.0, capacity: 5000, resolution: 1, freshnessTimeout: 5000, stabilityWindow: 500 });
    setEditingScale({ id: '', name: '', connectionType: 'serial', protocol: '', comPort: '', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, rackSlot: 0, zeroOffset: 0, ratedMvV: 2.0, capacity: 0, resolution: 0, freshnessTimeout: 0, stabilityWindow: 0 });
  }
  function startEditScale(sc: BackendScaleConfig) { setScaleDraft({ ...sc }); setEditingScale(sc); }
  function saveScale() {
    backend?.sendCommand('ConfigureScale', undefined, scaleDraft as unknown as Record<string, unknown>);
    setEditingScale(null);
  }
  function deleteScale(id: string) { backend?.sendCommand('RemoveScale', id); setConfirmDelete(null); }


  return (
    <div className="flex flex-col gap-3">

      {/* ── EtherNet/IP / EtherCAT I/O Rack ── */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600 }}>ETHERNET/IP &middot; ETHERCAT I/O RACK</div>
        <div className="px-4 py-3 flex flex-col gap-2" style={{ fontSize: '12px' }}>
          {!omEditing ? (
            <>
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: om.couplerType === 'none' ? 'var(--fg-dim)' : om.rackVerified ? 'var(--green)' : 'var(--orange)', opacity: om.couplerType === 'none' ? 0.3 : 1 }} />
                <span style={{ color: om.couplerType !== 'none' ? 'var(--fg-bright)' : 'var(--fg-dim)' }}>
                  {om.couplerType === 'none' ? 'Not Used' : om.couplerType === 'NX-EIC' ? 'NX-EIC (EtherNet/IP)' : 'NX-ECC (EtherCAT)'}
                </span>
                {om.couplerType !== 'none' && om.rackVerified && om.cards.every(c => c.status === 'ok') && (
                  <span style={{ color: 'var(--green)', fontSize: '11px' }}>RACK VERIFIED</span>
                )}
                {om.couplerType !== 'none' && om.rackVerified && om.cards.some(c => c.status === 'mismatch' || c.status === 'missing') && (
                  <span style={{ color: 'var(--red)', fontSize: '11px', fontWeight: 600 }}>RACK MISMATCH</span>
                )}
              </div>
              {om.couplerType !== 'none' && (
                <>
                  {om.couplerType === 'NX-EIC' && <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>IP: {om.ipAddress || '—'}</div>}
                  {om.couplerType === 'NX-ECC' && <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>{om.eccModel} &middot; Node Address: {om.nodeAddress} &middot; Debian Interface: {om.ethercatInterface || '—'} &middot; Cycle: {om.cycleTimeUs}&micro;s{om.ringTopology ? ' · Ring' : ''}</div>}
                  {om.cards.length > 0 && (
                    <table style={{ fontSize: '11px', borderCollapse: 'collapse', width: '100%' }}>
                      <thead>
                        <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                          <th style={{ padding: '2px 8px 2px 0', fontWeight: 600 }}>Slot</th>
                          <th style={{ padding: '2px 8px', fontWeight: 600 }}>Configured</th>
                          <th style={{ padding: '2px 8px', fontWeight: 600 }}>Actual</th>
                          <th style={{ padding: '2px 8px', fontWeight: 600 }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {om.cards.map(c => (
                          <tr key={c.slot} style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={{ padding: '3px 8px 3px 0', color: 'var(--accent)' }}>{c.slot}</td>
                            <td style={{ padding: '3px 8px', color: 'var(--fg-bright)' }}>{c.model}</td>
                            <td style={{ padding: '3px 8px', color: c.actual ? 'var(--fg-bright)' : 'var(--fg-dim)' }}>{c.actual ?? '—'}</td>
                            <td style={{ padding: '3px 8px' }}>
                              <span style={{ color: c.status === 'ok' ? 'var(--green)' : c.status === 'mismatch' || c.status === 'missing' ? 'var(--red)' : 'var(--fg-dim)' }}>
                                {c.status === 'ok' ? 'OK' : c.status === 'mismatch' ? 'MISMATCH' : c.status === 'missing' ? 'MISSING' : '—'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {om.warnings.length > 0 && (
                    <div className="flex flex-col gap-1" style={{ fontSize: '11px', color: 'var(--orange)', marginTop: '2px' }}>
                      {om.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                    </div>
                  )}
                  {om.lastReadAt && (
                    <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>Last read: {new Date(om.lastReadAt).toLocaleString()}</div>
                  )}
                </>
              )}
              <div className="flex gap-2 mt-1">
                <button onClick={startEditOmron} className="px-3 py-1.5 text-xs font-medium"
                  style={{ background: 'transparent', color: 'var(--fg-bright)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
                  Configure
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Coupler</span>
                <select value={omDraft.couplerType} onChange={e => setOmDraft({ ...omDraft, couplerType: e.target.value as BackendCouplerType })} style={inputStyle}>
                  <option value="none">Not Used</option>
                  <option value="NX-EIC">NX-EIC — EtherNet/IP Remote I/O Coupler</option>
                  <option value="NX-ECC">NX-ECC — EtherCAT Remote I/O Coupler</option>
                </select>
              </div>
              {omDraft.couplerType !== 'none' && (
                <>
                  {omDraft.couplerType === 'NX-EIC' && (
                    <div className="flex flex-col gap-1">
                      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Coupler IP Address</span>
                      <input value={omDraft.ipAddress} onChange={e => setOmDraft({ ...omDraft, ipAddress: e.target.value })}
                        placeholder="192.168.250.1" style={inputStyle} />
                    </div>
                  )}
                  {omDraft.couplerType === 'NX-ECC' && (
                    <>
                      <div className="flex flex-col gap-1">
                        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>EtherCAT Coupler Model</span>
                        <select value={omDraft.eccModel} onChange={e => {
                          const eccModel = e.target.value as BackendEccModel;
                          setOmDraft({ ...omDraft, eccModel, ringTopology: eccModel === 'NX-ECC203' ? omDraft.ringTopology : false });
                        }} style={inputStyle}>
                          <option value="NX-ECC202">NX-ECC202 (250µs min cycle)</option>
                          <option value="NX-ECC203">NX-ECC203 (125µs min cycle, ring topology)</option>
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Node Address (1–199 rotary switch)</span>
                        <input type="number" min={1} max={199} value={omDraft.nodeAddress}
                          onChange={e => setOmDraft({ ...omDraft, nodeAddress: Number(e.target.value) })}
                          style={{ ...inputStyle, width: '80px' }} />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Debian EtherCAT Interface (dedicated NIC)</span>
                        {(() => {
                          const nics = backend?.networkInterfaces ?? [];
                          const current = omDraft.ethercatInterface;
                          if (nics.length === 0) {
                            return <input value={current} onChange={e => setOmDraft({ ...omDraft, ethercatInterface: e.target.value })}
                              placeholder="enp2s0" style={inputStyle} />;
                          }
                          const options = current && !nics.includes(current) ? [...nics, current] : nics;
                          return (
                            <select value={current} onChange={e => setOmDraft({ ...omDraft, ethercatInterface: e.target.value })} style={inputStyle}>
                              <option value="">Select interface</option>
                              {options.map(n => <option key={n} value={n}>{n}{n === current && !nics.includes(n) ? ' (not detected)' : ''}</option>)}
                            </select>
                          );
                        })()}
                        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Must be a NIC reserved for the EtherCAT master — not the general LAN port. Only physical interfaces detected on the Debian host are listed.</span>
                      </div>
                      <div className="flex items-end gap-3">
                        <div className="flex flex-col gap-1">
                          <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Master Cycle Time (µs)</span>
                          <input type="number" min={1} value={omDraft.cycleTimeUs}
                            onChange={e => setOmDraft({ ...omDraft, cycleTimeUs: Number(e.target.value) })}
                            style={{ ...inputStyle, width: '100px' }} />
                        </div>
                        <label className="flex items-center gap-1" style={{ fontSize: '11px', color: 'var(--fg-dim)', opacity: omDraft.eccModel === 'NX-ECC203' ? 1 : 0.4, paddingBottom: '6px' }}>
                          <input type="checkbox" checked={omDraft.ringTopology} disabled={omDraft.eccModel !== 'NX-ECC203'}
                            onChange={e => setOmDraft({ ...omDraft, ringTopology: e.target.checked })}
                            style={{ accentColor: 'var(--accent)' }} />
                          Ring topology
                        </label>
                      </div>
                    </>
                  )}
                  <div className="flex items-center justify-between" style={{ marginTop: '4px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--fg-dim)', fontWeight: 600 }}>RACK LAYOUT</span>
                    <button onClick={() => setConfirmReadRack(true)} className="px-2 py-0.5 text-xs"
                      style={{ color: 'var(--accent)', background: 'transparent', border: '1px solid var(--accent)', borderRadius: '3px', cursor: 'pointer', fontSize: '11px' }}>
                      Read from Coupler
                    </button>
                  </div>
                  <table style={{ fontSize: '11px', borderCollapse: 'collapse', width: '100%' }}>
                    <thead>
                      <tr style={{ color: 'var(--fg-dim)', textAlign: 'left' }}>
                        <th style={{ padding: '2px 0', fontWeight: 600, width: '20px' }}></th>
                        <th style={{ padding: '2px 8px 2px 0', fontWeight: 600, width: '40px' }}>Slot</th>
                        <th style={{ padding: '2px 8px', fontWeight: 600 }}>Card</th>
                        <th style={{ padding: '2px 4px', fontWeight: 600, width: '30px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {omDraft.cards.map((c, i) => (
                        <tr key={i}
                          draggable
                          onDragStart={() => handleDragStart(i)}
                          onDragOver={(e) => handleDragOver(e, i)}
                          onDrop={() => handleDrop(i)}
                          onDragEnd={handleDragEnd}
                          style={{
                            borderTop: '1px solid var(--border)',
                            opacity: dragIdx === i ? 0.4 : 1,
                            background: dragOverIdx === i && dragIdx !== i ? 'rgba(255,255,255,0.05)' : undefined,
                          }}>
                          <td style={{ padding: '3px 0', cursor: 'grab', color: 'var(--fg-dim)', fontSize: '12px', userSelect: 'none' }}>☰</td>
                          <td style={{ padding: '3px 8px 3px 0', color: 'var(--accent)', fontWeight: 600 }}>{i + 1}</td>
                          <td style={{ padding: '3px 8px' }}>
                            <select value={c.model} onChange={e => updateCardModel(i, e.target.value)} style={inputStyle}>
                              {(['Power', 'Digital Output', 'Digital Input', 'Analog Output', 'Analog Input', 'Scale'] as const).map(cat => (
                                <optgroup key={cat} label={cat}>
                                  {NX_CARDS.filter(nc => nc.cat === cat).map(nc => (
                                    <option key={nc.model} value={nc.model}>{nc.label}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                            <button onClick={() => removeCard(i)} style={{ color: 'var(--red)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '13px' }}>×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button onClick={addCard} className="px-2 py-1 text-xs self-start"
                    style={{ color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
                    + Add Card
                  </button>
                </>
              )}
              <div className="flex gap-2 mt-1">
                <button onClick={saveOmron} className="px-3 py-1.5 text-xs font-medium"
                  style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Save</button>
                <button onClick={cancelOmron} className="px-3 py-1.5 text-xs font-medium"
                  style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Scales ── */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        <div className="px-4 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600 }}>SCALES</span>
          <button onClick={startAddScale} className="px-2 py-1 text-xs"
            style={{ color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
            + Add Scale
          </button>
        </div>
        <div className="px-4 py-2">
          {scaleConfigs.length === 0 && !editingScale && (
            <div style={{ color: 'var(--fg-dim)', fontSize: '12px', padding: '8px 0' }}>No scales configured</div>
          )}
          {scaleConfigs.map(sc => (
            <div key={sc.id} className="flex items-center gap-2 py-2" style={{ borderBottom: '1px solid var(--border)', fontSize: '12px' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600, width: '48px', flexShrink: 0 }}>{sc.id}</span>
              <span style={{ color: 'var(--fg-bright)', flex: 1 }}>{sc.name}</span>
              <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>{sc.connectionType === 'rs1201' ? `RS1201 Slot ${sc.rackSlot}` : (sc.protocol || '—')}</span>
              <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>{sc.capacity} lbs</span>
              <button onClick={() => startEditScale(sc)} className="px-2 py-0.5 text-xs"
                style={{ color: 'var(--fg-bright)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Edit</button>
              <button onClick={() => setConfirmDelete(sc.id)} className="px-2 py-0.5 text-xs"
                style={{ color: 'var(--red)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Del</button>
            </div>
          ))}
          {editingScale && (
            <div className="py-3 flex flex-col gap-2" style={{ borderTop: scaleConfigs.length > 0 ? '1px solid var(--border)' : undefined }}>
              <div className="flex gap-2">
                <div className="flex flex-col gap-1" style={{ width: '80px' }}>
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>ID</span>
                  <input value={scaleDraft.id} onChange={e => setScaleDraft({ ...scaleDraft, id: e.target.value })} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Name</span>
                  <input value={scaleDraft.name} onChange={e => setScaleDraft({ ...scaleDraft, name: e.target.value })} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-1" style={{ width: '120px' }}>
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Connection</span>
                  <select value={scaleDraft.connectionType} onChange={e => setScaleDraft({ ...scaleDraft, connectionType: e.target.value as 'serial' | 'rs1201' })} style={inputStyle}>
                    <option value="serial">Serial</option>
                    {rs1201Slots.length > 0 && <option value="rs1201">NX-RS1201</option>}
                  </select>
                </div>
              </div>
              {scaleDraft.connectionType === 'serial' ? (
                <>
                  <div className="flex gap-2">
                    <div className="flex flex-col gap-1 flex-1">
                      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Protocol</span>
                      <select value={scaleDraft.protocol} onChange={e => setScaleDraft({ ...scaleDraft, protocol: e.target.value })} style={inputStyle}>
                        <option value="">Select</option>
                        <option value="A&D">A&amp;D</option>
                        <option value="Toledo">Toledo</option>
                        <option value="Rice Lake">Rice Lake</option>
                        <option value="GSE">GSE</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1 flex-1">
                      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>COM Port</span>
                      <input value={scaleDraft.comPort} onChange={e => setScaleDraft({ ...scaleDraft, comPort: e.target.value })} placeholder="COM1" style={inputStyle} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex flex-col gap-1 flex-1">
                      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Baud Rate</span>
                      <select value={scaleDraft.baudRate} onChange={e => setScaleDraft({ ...scaleDraft, baudRate: Number(e.target.value) })} style={inputStyle}>
                        {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1 flex-1">
                      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Data Bits</span>
                      <select value={scaleDraft.dataBits} onChange={e => setScaleDraft({ ...scaleDraft, dataBits: Number(e.target.value) })} style={inputStyle}>
                        <option value={7}>7</option>
                        <option value={8}>8</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1 flex-1">
                      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Parity</span>
                      <select value={scaleDraft.parity} onChange={e => setScaleDraft({ ...scaleDraft, parity: e.target.value as 'none' | 'even' | 'odd' })} style={inputStyle}>
                        <option value="none">None</option>
                        <option value="even">Even</option>
                        <option value="odd">Odd</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1 flex-1">
                      <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Stop Bits</span>
                      <select value={scaleDraft.stopBits} onChange={e => setScaleDraft({ ...scaleDraft, stopBits: Number(e.target.value) })} style={inputStyle}>
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                      </select>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex gap-2">
                  <div className="flex flex-col gap-1 flex-1">
                    <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>RS1201 Rack Slot</span>
                    <select value={scaleDraft.rackSlot} onChange={e => setScaleDraft({ ...scaleDraft, rackSlot: Number(e.target.value) })} style={inputStyle}>
                      <option value={0}>Select slot</option>
                      {rs1201Slots.map(s => <option key={s} value={s}>Slot {s}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {scaleDraft.connectionType === 'rs1201' && (
              <>
              <div className="flex gap-2">
                <div className="flex flex-col gap-1 flex-1">
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Zero Offset (mV/V)</span>
                  <div className="flex gap-1">
                    <input type="number" step="0.0001" value={scaleDraft.zeroOffset} onChange={e => setScaleDraft({ ...scaleDraft, zeroOffset: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }} />
                    <button onClick={() => {
                      const reading = backend?.scales[scaleDraft.id];
                      setScaleDraft({ ...scaleDraft, zeroOffset: reading?.weight ?? 0 });
                    }} className="px-2 py-1 text-xs font-medium" style={{ background: 'var(--bg-panel)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Zero</button>
                  </div>
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Rated Output (mV/V)</span>
                  <div className="flex gap-1">
                    <input type="number" step="0.0001" value={scaleDraft.ratedMvV} onChange={e => setScaleDraft({ ...scaleDraft, ratedMvV: Number(e.target.value) })} style={{ ...inputStyle, flex: 1 }} />
                    <button onClick={() => {
                      setCalStep('zero');
                      setCalZeroReading(0);
                      setCalTestWeight('');
                      setCalOpen(true);
                    }} className="px-2 py-1 text-xs font-medium" style={{ background: 'var(--bg-panel)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Span Cal</button>
                  </div>
                </div>
              </div>
              {calOpen && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={e => { if (e.target === e.currentTarget) setCalOpen(false); }}>
                  <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '20px', width: 340, maxWidth: '90vw' }}
                    onClick={e => e.stopPropagation()}>
                    <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: 12, color: 'var(--fg)' }}>Span Calibration</div>
                    <div style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: 8 }}>
                      Live reading: <strong style={{ color: 'var(--fg)' }}>{(backend?.scales[scaleDraft.id]?.weight ?? 0).toFixed(4)} mV/V</strong>
                      {backend?.scales[scaleDraft.id]?.stable && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>STABLE</span>}
                    </div>
                    {calStep === 'zero' ? (
                      <div className="flex flex-col gap-2">
                        <div style={{ fontSize: '12px', color: 'var(--fg)' }}>Step 1: Remove all weight from scale</div>
                        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>Clear scale platform completely, then press Zero to capture the no-load reading.</div>
                        <button onClick={() => {
                          const r = backend?.scales[scaleDraft.id]?.weight ?? 0;
                          setCalZeroReading(r);
                          setScaleDraft({ ...scaleDraft, zeroOffset: r });
                          setCalStep('span');
                        }} className="px-3 py-1.5 text-xs font-medium"
                          style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer', alignSelf: 'flex-start' }}>Zero</button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>Zero captured: {calZeroReading.toFixed(4)} mV/V</div>
                        <div style={{ fontSize: '12px', color: 'var(--fg)' }}>Step 2: Place test weight on scale</div>
                        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>Place a known test weight on the scale and enter the weight below.</div>
                        <div className="flex flex-col gap-1">
                          <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Test Weight (lbs)</span>
                          <input type="number" value={calTestWeight} onChange={e => setCalTestWeight(e.target.value)}
                            style={inputStyle} placeholder="e.g. 1000" autoFocus />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => {
                            const tw = parseFloat(calTestWeight);
                            const raw = backend?.scales[scaleDraft.id]?.weight ?? 0;
                            const delta = raw - calZeroReading;
                            if (!tw || tw <= 0 || !scaleDraft.capacity) return;
                            if (Math.abs(delta) < 0.0001) return;
                            const mvv = delta * scaleDraft.capacity / tw;
                            setScaleDraft({ ...scaleDraft, zeroOffset: calZeroReading, ratedMvV: Math.round(mvv * 10000) / 10000 });
                            setCalOpen(false);
                          }} className="px-3 py-1.5 text-xs font-medium"
                            style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                            disabled={!calTestWeight || parseFloat(calTestWeight) <= 0}>Calibrate</button>
                          <button onClick={() => setCalStep('zero')} className="px-3 py-1.5 text-xs font-medium"
                            style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Back</button>
                        </div>
                      </div>
                    )}
                    <button onClick={() => setCalOpen(false)} className="px-3 py-1.5 text-xs font-medium mt-3"
                      style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer', width: '100%' }}>Cancel</button>
                  </div>
                </div>
              )}
              </>
              )}
              <div className="flex gap-2">
                <div className="flex flex-col gap-1 flex-1">
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Capacity (lbs)</span>
                  <input type="number" value={scaleDraft.capacity} onChange={e => setScaleDraft({ ...scaleDraft, capacity: Number(e.target.value) })} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Resolution (lbs)</span>
                  <input type="number" value={scaleDraft.resolution} onChange={e => setScaleDraft({ ...scaleDraft, resolution: Number(e.target.value) })} style={inputStyle} />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex flex-col gap-1 flex-1">
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Freshness (ms)</span>
                  <input type="number" value={scaleDraft.freshnessTimeout} onChange={e => setScaleDraft({ ...scaleDraft, freshnessTimeout: Number(e.target.value) })} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Stability (ms)</span>
                  <input type="number" value={scaleDraft.stabilityWindow} onChange={e => setScaleDraft({ ...scaleDraft, stabilityWindow: Number(e.target.value) })} style={inputStyle} />
                </div>
              </div>
              <div className="flex gap-2 mt-1">
                <button onClick={saveScale} className="px-3 py-1.5 text-xs font-medium"
                  style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Save</button>
                <button onClick={() => setEditingScale(null)} className="px-3 py-1.5 text-xs font-medium"
                  style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Commissioning / Raw I/O ── */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        <div className="px-4 py-2 flex items-center justify-between cursor-pointer" style={{ borderBottom: commissioningOpen ? '1px solid var(--border)' : undefined, color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600 }}
          onClick={() => setCommissioningOpen(!commissioningOpen)}>
          <span>COMMISSIONING / RAW I/O</span>
          <span style={{ fontSize: '11px' }}>{commissioningOpen ? '▾' : '▸'}</span>
        </div>
        {commissioningOpen && (
          <div className="px-4 py-3 flex flex-col gap-2" style={{ fontSize: '12px' }}>
            <label className="flex items-center gap-2 cursor-pointer" style={{ color: 'var(--fg-bright)' }}>
              <input type="checkbox" checked={commissioningMode} onChange={e => toggleCommissioningMode(e.target.checked)}
                style={{ accentColor: 'var(--orange)' }} />
              Enable Commissioning Mode
            </label>
            <div style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>
              {commissioningMode
                ? 'Commissioning mode is ON — every output below can be forced directly, bypassing control logic. Real outputs will energize. Turn this off when done; any forced outputs release automatically.'
                : 'Lets you watch every discovered rack signal live, independent of equipment mapping. Enable to also force outputs directly — e.g. to bench-test a DO point before it is wired to any equipment.'}
            </div>
            {backend?.connected && <IOSignalList backend={backend} showAll />}
          </div>
        )}
      </div>

      {/* Read Rack confirmation */}
      {confirmReadRack && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setConfirmReadRack(false)}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 20px', minWidth: '280px' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Read Rack from Coupler</div>
            <div style={{ color: 'var(--fg)', fontSize: '12px', marginBottom: '14px' }}>
              This will query the coupler for its current card layout. Any mismatch between configured and detected cards will raise a fatal fault.
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmReadRack(false)}
                style={{ padding: '5px 14px', borderRadius: '3px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={doReadRack}
                style={{ padding: '5px 14px', borderRadius: '3px', border: 'none', background: 'var(--accent)', color: '#000', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Read Rack</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete scale confirmation */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setConfirmDelete(null)}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 20px', minWidth: '260px' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Delete Scale</div>
            <div style={{ color: 'var(--fg)', fontSize: '12px', marginBottom: '14px' }}>
              Remove scale {confirmDelete}? Equipment referencing it will need to be reassigned.
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)}
                style={{ padding: '5px 14px', borderRadius: '3px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => deleteScale(confirmDelete)}
                style={{ padding: '5px 14px', borderRadius: '3px', border: 'none', background: 'var(--red)', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Global Section ───

function GlobalSection() {
  const { globalConfig, setGlobalConfig } = useMillStore();
  const backend = useBackend();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(globalConfig);

  function startEdit() {
    setDraft({ ...globalConfig });
    setEditing(true);
  }

  function save() {
    Object.entries(draft).forEach(([k, v]) => {
      setGlobalConfig(k, v);
      backend?.sendCommand('SetGlobalConfig', undefined, { key: k, value: v });
    });
    setEditing(false);
  }

  function cancel() { setEditing(false); }

  const inputStyle = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontFamily: 'inherit', fontSize: '12px', width: '120px' };

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
      <div className="px-4 py-3 flex flex-col gap-3" style={{ fontSize: '13px' }}>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-dim)', width: '200px', flexShrink: 0 }}>Site Name</span>
          {editing
            ? <input value={(draft.siteName as string) ?? ''} onChange={e => setDraft({ ...draft, siteName: e.target.value })}
                style={{ ...inputStyle, width: '200px' }} />
            : <span style={{ color: 'var(--fg-bright)' }}>{(globalConfig.siteName as string) || 'FEED MILL CONTROLLER'}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-dim)', width: '200px', flexShrink: 0 }}>Motor Starter Fault Delay</span>
          {editing
            ? <div className="flex items-center gap-1">
                <input type="number" step={0.1} min={0} value={draft.motorStarterFaultDelay ?? GLOBAL_DEFAULTS.motorStarterFaultDelay}
                  onChange={e => setDraft({ ...draft, motorStarterFaultDelay: Number(e.target.value) })} style={inputStyle} />
                <span style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>s</span>
              </div>
            : <span style={{ color: 'var(--fg-bright)' }}>{globalConfig.motorStarterFaultDelay ?? GLOBAL_DEFAULTS.motorStarterFaultDelay} s</span>}
        </div>

        <div className="flex items-center gap-2" style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
          {!editing ? (
            <button onClick={startEdit} className="px-3 py-1.5 text-xs font-medium"
              style={{ background: 'transparent', color: 'var(--fg-bright)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Edit</button>
          ) : (
            <>
              <button onClick={save} className="px-3 py-1.5 text-xs font-medium"
                style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Save</button>
              <button onClick={cancel} className="px-3 py-1.5 text-xs font-medium"
                style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
