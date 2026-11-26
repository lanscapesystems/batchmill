'use client';

import { useState, useRef, useCallback, useEffect, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react';
import { useMillStore, EQUIPMENT_DEFS, getPortsForEquipment, FLOW_HIDDEN_TYPES, type EquipmentItem, type EquipmentMode, type PortDef, type Position } from '../store';
import { useBackend, BACKEND_HTTP, type BackendEquipment, type BackendSignal } from '../backend';

const BLOCK_W = 100;
const BLOCK_H = 50;

const SEL_PAD = 6;
const SEL_COLOR = '#e91e8a';

const TYPE_COLORS: Record<string, string> = {
  bin: '#5c6bc0', hammermill: '#ef5350', mixer: '#ab47bc', finished_bin: '#26a69a',
  micro_drag: '#ffa726', gate: '#8d6e63', auger: '#29b6f6',
};

// Motor display states = the PLC's motor status word. The colours here are the defaults; Settings > General can override
// each one (globalConfig stateColor_<state>, #rrggbb).
export const STATE_STYLE: Record<string, { label: string; color: string }> = {
  off:          { label: 'OFF',          color: '#4a148c' },
  auto_stopped: { label: 'AUTO STOPPED', color: '#424242' },
  auto_running: { label: 'AUTO RUNNING', color: '#2e7d32' },
  hand_running: { label: 'HAND RUNNING', color: '#1565c0' },
  hand_stopped: { label: 'HAND STOPPED', color: '#37474f' },
  bypass:       { label: 'BYPASS',       color: '#f9a825' },
  alarm:        { label: 'ALARM',        color: '#e65100' },
  fault:        { label: 'FAULT',        color: '#b71c1c' },
  disabled:     { label: 'DISABLED',     color: '#4a148c' },
};

export function stateColor(state: string, globalConfig?: Record<string, string | number>): string {
  const custom = globalConfig?.[`stateColor_${state}`];
  return typeof custom === 'string' && /^#[0-9a-f]{6}$/i.test(custom) ? custom : STATE_STYLE[state].color;
}

function blockFill(eq: EquipmentItem, backendEq?: BackendEquipment, globalConfig?: Record<string, string | number>): string {
  if (backendEq?.state && STATE_STYLE[backendEq.state]) return stateColor(backendEq.state, globalConfig);
  const status = backendEq?.status ?? eq.status;
  const mode = backendEq?.mode ?? eq.mode;
  if (status === 'fault') return '#b71c1c';
  if (status === 'warning') return '#e65100';
  if (mode === 'Off' || status === 'disabled') return '#4a148c';
  if (status === 'running') return '#2e7d32';
  // A gate sitting at P2 reports not_running (P1 reports running): either port is a good, confirmed position.
  if (eq.equipmentType === 'gate' && (backendEq?.gatePosition === 'open' || backendEq?.gatePosition === 'closed')) return '#2e7d32';
  return '#424242';
}

// Sidebar state text. Motors use the backend's status word; a gate is never "running", it is at P1, at P2 or moving.
function statusLabel(equipmentType: string, beq: BackendEquipment | undefined, status: string): string {
  if (beq?.state && STATE_STYLE[beq.state]) return STATE_STYLE[beq.state].label;
  if (equipmentType === 'gate' && status !== 'fault' && status !== 'disabled') {
    const pos = beq?.gatePosition;
    return pos === 'open' ? 'P1' : pos === 'closed' ? 'P2' : pos ? pos.toUpperCase() : 'UNKNOWN';
  }
  return status === 'not_running' ? 'STOPPED' : status.toUpperCase();
}

// Motor load for display: % of the motor's FLA (amps come from the analog scaling), or amps when no FLA is set.
function loadText(be: BackendEquipment): string {
  if (be.loadDisconnected) return 'NO SENSOR';
  if (be.loadAmps === undefined) return '—';
  const fla = Number(be.config.motorFla ?? 0);
  return fla > 0 ? `${Math.round((be.loadAmps / fla) * 100)}%` : `${be.loadAmps} A`;
}

// Live number under a box's id: motor load (A) and/or the weight of its scale (lb).
function boxReadout(be: BackendEquipment | undefined, scales: Record<string, { weight: number; valid: boolean }> | undefined): string | undefined {
  if (!be) return undefined;
  const parts: string[] = [];
  const scale = be.config.scaleId ? scales?.[String(be.config.scaleId)] : undefined;
  if (be.config.scaleId) parts.push(scale?.valid ? `${Math.round(scale.weight)} lb` : '— lb');
  if (be.config.analogLoadInput) parts.push(loadText(be));
  return parts.length ? parts.join(' · ') : undefined;
}

function portPosition(pos: Position, port: PortDef, allPorts: PortDef[]): { x: number; y: number } {
  const sameSide = allPorts.filter(p => p.side === port.side);
  const idx = sameSide.findIndex(p => p.id === port.id);
  const frac = (idx + 1) / (sameSide.length + 1);
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

function scalePos(p: Position): Position {
  return { x: p.x * (BLOCK_W / 120), y: p.y * (BLOCK_H / 50) };
}

export function SystemTab() {
  const { equipment, connections, positions } = useMillStore();
  const backend = useBackend();
  const backendEqMap = new Map((backend?.connected ? backend.equipment : []).map(e => [e.id, e]));
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedEq, setSelectedEq] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({ x: -30, y: -30, w: 1200, h: 900 });
  const [panning, setPanning] = useState<{ startX: number; startY: number; vbX: number; vbY: number } | null>(null);

  const flowEquipment = equipment.filter(e => !FLOW_HIDDEN_TYPES.has(e.equipmentType));
  const selectedItem = selectedEq ? equipment.find(e => e.id === selectedEq) : null;

  const scaledPositions: Record<string, Position> = {};
  for (const [id, pos] of Object.entries(positions)) {
    scaledPositions[id] = scalePos(pos);
  }

  const handleBgMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button === 0) {
      setPanning({ startX: e.clientX, startY: e.clientY, vbX: viewBox.x, vbY: viewBox.y });
      setSelectedEq(null);
    }
  }, [viewBox.x, viewBox.y]);

  const handleMouseMove = useCallback((e: ReactMouseEvent) => {
    if (!panning) return;
    const svg = svgRef.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const dx = (e.clientX - panning.startX) / ctm.a;
    const dy = (e.clientY - panning.startY) / ctm.d;
    setViewBox(prev => ({ ...prev, x: panning.vbX - dx, y: panning.vbY - dy }));
  }, [panning]);

  const handleMouseUp = useCallback(() => { setPanning(null); }, []);

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

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <div className="flex flex-col" style={{ height: '100%' }}>
        <div style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', overflow: 'hidden', minHeight: '500px' }}>
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            onMouseDown={handleBgMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            style={{ cursor: panning ? 'grabbing' : 'default', userSelect: 'none' }}
            tabIndex={0}
          >
            <defs>
              <pattern id="sys-grid" width={20} height={20} patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect x={viewBox.x - 2000} y={viewBox.y - 2000} width={viewBox.w + 4000} height={viewBox.h + 4000} fill="url(#sys-grid)" />

            {/* Connection lines */}
            {connections.map((c, i) => {
              const fromEq = flowEquipment.find(e => e.id === c.from);
              const toEq = flowEquipment.find(e => e.id === c.to);
              if (!fromEq || !toEq) return null;
              const from = portPositionForEq(fromEq, c.fromPort, scaledPositions);
              const to = portPositionForEq(toEq, c.toPort, scaledPositions);
              if (!from || !to) return null;
              const midY = (from.y + to.y) / 2;
              return (
                <path key={i} d={`M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`}
                  fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" />
              );
            })}

            {/* Equipment blocks */}
            {flowEquipment.map(eq => {
              const pos = scaledPositions[eq.id];
              if (!pos) return null;
              const ports = getPortsForEquipment(eq);
              const fill = blockFill(eq, backendEqMap.get(eq.id), backend?.globalConfig);
              const isSel = selectedEq === eq.id;

              return (
                <g key={eq.id}>
                  {isSel && <rect x={pos.x - SEL_PAD} y={pos.y - SEL_PAD}
                    width={BLOCK_W + SEL_PAD * 2} height={BLOCK_H + SEL_PAD * 2} rx={6}
                    fill="none" stroke={SEL_COLOR} strokeWidth="2.5" />}
                  <rect
                    x={pos.x} y={pos.y} width={BLOCK_W} height={BLOCK_H} rx={4}
                    fill={fill} stroke="rgba(255,255,255,0.25)" strokeWidth="1"
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => { e.stopPropagation(); setSelectedEq(eq.id); }}
                  />
                  {(() => {
                    const readout = boxReadout(backendEqMap.get(eq.id), backend?.connected ? backend.scales : undefined);
                    return (<>
                      <text x={pos.x + BLOCK_W / 2} y={pos.y + (readout ? 24 : BLOCK_H / 2 + 6)} textAnchor="middle"
                        fill="#fff" fontSize="16" fontWeight="700"
                        fontFamily="Roboto, sans-serif" pointerEvents="none">{eq.id}</text>
                      {readout && <text x={pos.x + BLOCK_W / 2} y={pos.y + 42} textAnchor="middle"
                        fill="#fff" fontSize="13" fontWeight="500"
                        fontFamily="Roboto, sans-serif" pointerEvents="none">{readout}</text>}
                    </>);
                  })()}

                  {ports.map(port => {
                    const pp = portPosition(pos, port, ports);
                    return (
                      <circle key={port.id} cx={pp.x} cy={pp.y} r={3}
                        fill="rgba(255,255,255,0.3)" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Right sidebar for equipment detail/control */}
      {selectedItem && (() => {
        const beq = backendEqMap.get(selectedItem.id);
        const liveStatus = beq?.status ?? selectedItem.status;
        const liveMode = beq?.mode ?? selectedItem.mode;

        function setMode(m: EquipmentMode) {
          backend?.sendCommand('SetEquipmentMode', selectedItem!.id, { mode: m });
        }

        return (
        <div style={{ width: '300px', position: 'absolute', top: 0, right: 0, bottom: 0, background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'auto', zIndex: 10 }}>
          <div className="px-3 py-2.5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 700, flexShrink: 0 }}>{selectedItem.id}</span>
              <span style={{ width: '1px', alignSelf: 'stretch', background: 'var(--border)', flexShrink: 0 }} />
              <span style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{beq?.name ?? selectedItem.name}</span>
            </span>
            <button onClick={() => setSelectedEq(null)} style={{ color: 'var(--fg-bright)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '16px', lineHeight: '1' }}>✕</button>
          </div>

          <div className="px-3 py-3 flex flex-col gap-3" style={{ fontSize: '12px' }}>
            {/* Name & Type */}
            <div>
              {selectedItem.equipmentType === 'gate'
                // what P1 / P2 do is set by the flow path: each outlet and the equipment it feeds
                ? [1, 2].map(p => {
                    const to = connections.find(c => c.from === selectedItem.id && c.fromPort === `out${p}`)?.to;
                    const target = to ? equipment.find(e => e.id === to) : undefined;
                    return (
                      <div key={p} style={{ color: TYPE_COLORS.gate, fontSize: '11px' }}>
                        P{p} → {target ? `${target.id} ${target.name}` : <span style={{ color: 'var(--fg-bright)' }}>not connected</span>}
                      </div>
                    );
                  })
                : <div style={{ color: TYPE_COLORS[selectedItem.equipmentType] ?? 'var(--fg-dim)', fontSize: '11px' }}>
                    {EQUIPMENT_DEFS[selectedItem.equipmentType]?.label ?? selectedItem.equipmentType}
                  </div>}
            </div>

            {/* Status */}
            {selectedItem.equipmentType === 'bin' || selectedItem.equipmentType === 'finished_bin'
              // bins have no run state: show each configured level switch (full = red, empty = orange)
              ? <div className="flex items-center gap-4">
                  {([['FULL', beq?.highCovered, 'var(--red)'], ['EMPTY', beq?.lowCovered === undefined ? undefined : !beq.lowCovered, 'var(--orange)']] as const).map(([label, on, color]) => on === undefined ? null : (
                    <span key={label} className="flex items-center gap-2" style={{ color: on ? color : 'var(--fg-dim)', fontSize: '12px', fontWeight: 500 }}>
                      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: on ? color : 'var(--fg-dim)', opacity: on ? 1 : 0.3 }} />{label}
                    </span>
                  ))}
                </div>
              : <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: blockFill(selectedItem, beq, backend?.globalConfig) }} />
                  <span style={{ color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 500 }}>
                    {statusLabel(selectedItem.equipmentType, beq, liveStatus)}
                  </span>
                </div>}

            {beq?.faultReason && (
              <div style={{ color: 'var(--red)', fontSize: '11px' }}>{beq.faultReason}</div>
            )}

            {beq?.warningReason && (
              <div style={{ color: 'var(--orange)', fontSize: '11px' }}>{beq.warningReason}</div>
            )}

            {beq && backend?.connected && !!beq.config.analogLoadInput && (
              <LoadPanel key={beq.id} beq={beq} backend={backend} />
            )}

            {beq && backend?.connected && beq.runSecondsTotal !== undefined && (
              <div className="flex items-center gap-2" style={{ color: 'var(--fg-bright)', fontSize: '11px' }}>
                <span>Run {(beq.runSeconds ?? 0) / 3600 | 0}.{Math.floor(((beq.runSeconds ?? 0) % 3600) / 360)} h since {beq.runSecondsResetAt ? new Date(beq.runSecondsResetAt).toLocaleDateString() : 'install'} · total {((beq.runSecondsTotal ?? 0) / 3600).toFixed(1)} h</span>
                <button onClick={() => backend.sendCommand('ResetRunHours', selectedItem.id)}
                  style={{ background: 'transparent', color: 'var(--fg-bright)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer', fontSize: '11px' }}>Reset</button>
              </div>
            )}

            {beq?.owner && (
              <div style={{ color: 'var(--accent)', fontSize: '11px' }}>Owner: {beq.owner}</div>
            )}

            {/* Mode control: motors Hand/Auto/Off, gates P1/P2/Auto/Off, bins none (no motor) */}
            {selectedItem.equipmentType !== 'bin' && selectedItem.equipmentType !== 'finished_bin' && <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
              <div className="mb-2" style={{ color: 'var(--fg-bright)', fontSize: '11px', fontWeight: 500 }}>MODE</div>
              <div className="flex gap-1">
                {((selectedItem.equipmentType === 'gate' ? ['P1', 'P2', 'Auto', 'Off'] : ['Hand', 'Auto', 'Off']) as EquipmentMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className="px-4 py-1.5 text-xs font-medium flex-1"
                    style={{
                      background: liveMode === m
                        ? (m === 'Hand' || m === 'P1' || m === 'P2' ? 'var(--orange)' : m === 'Off' ? 'var(--red)' : 'var(--green)')
                        : 'var(--bg)',
                      color: liveMode === m ? '#000' : 'var(--fg-bright)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      cursor: 'pointer',
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>}

            {beq && backend?.connected && !!beq.config.analogSpeedOutput && (
              <SpeedField key={beq.id} beq={beq} backend={backend}
                locked={backend.equipment.some(e => (e.loadControlAuto || e.loadAtRunning) && e.config.loadControlFeeder === beq.id) ? `Speed is set by ${backend.equipment.find(e => e.config.loadControlFeeder === beq.id && (e.loadControlAuto || e.loadAtRunning))?.id} load control. Switch it to Manual to set it by hand.` : undefined} />
            )}

            {liveStatus === 'fault' && backend?.connected && (
              <button
                onClick={() => backend.sendCommand('ResetEquipmentFault', selectedItem.id)}
                className="px-4 py-1.5 text-xs font-medium"
                style={{ background: 'var(--orange)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
              >
                Reset Fault
              </button>
            )}

            {beq && backend?.connected && <IOMonitor beq={beq} backend={backend} />}
            {beq && backend?.connected && <OverridesPanel beq={beq} backend={backend} />}
          </div>
        </div>
        );
      })()}
    </div>
  );

}

export type Backend = NonNullable<ReturnType<typeof useBackend>>;

function SpeedField({ beq, backend, locked }: { beq: BackendEquipment; backend: Backend; locked?: string }) {
  const min = Number(beq.config.speedMinLimit ?? 0);
  const max = Number(beq.config.speedMaxLimit ?? 100);
  const [draft, setDraft] = useState<string | null>(null); // null = show the backend's value
  const value = draft ?? String(Math.min(max, Math.max(min, beq.speed ?? 100))); // the backend clamps the output the same way
  const n = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max;

  async function apply() {
    if (!valid) return;
    const r = await backend.sendCommand('SetEquipmentSpeed', beq.id, { speed: n });
    if (r.accepted) setDraft(null);
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      <div className="mb-2" style={{ color: 'var(--fg-bright)', fontSize: '11px', fontWeight: 500 }}>SPEED SETPOINT</div>
      <div className="flex items-center gap-2">
        <input
          type="number" value={value} min={min} max={max} disabled={!!locked}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') apply(); }}
          aria-label="Speed setpoint percent"
          style={{ background: 'var(--bg)', border: `1px solid ${valid ? 'var(--border)' : 'var(--red)'}`, borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontSize: '12px', width: '80px' }}
        />
        <span style={{ color: 'var(--fg-bright)', fontSize: '11px' }}>%</span>
        <button
          onClick={apply} disabled={!valid || draft === null || !!locked}
          className="px-3 py-1.5 text-xs font-medium"
          style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer', fontWeight: 600, opacity: !valid || draft === null || locked ? 0.4 : 1 }}
        >
          Set
        </button>
      </div>
      <div className="mt-1" style={{ color: 'var(--fg-bright)', fontSize: '11px' }}>
        {locked ?? `Allowed ${min}–${max}%. Used in Hand and as the normal feed speed in Auto.`}
      </div>
    </div>
  );
}

// equipmentId filters to one piece of equipment's mapped ports; pass showAll
// instead to list every rack signal regardless of equipment mapping (used by
// the Commissioning panel, where nothing may be mapped to equipment yet).
export function IOSignalList({ equipmentId, backend, showAll, embedded }: { equipmentId?: string; backend: Backend; showAll?: boolean; embedded?: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Forcing I/O is refused by the backend too: never during a batch, never with a hammermill enabled.
  const blocked = backend.activeBatch && !['COMPLETED', 'FAULTED', 'IDLE'].includes(backend.activeBatch.state) ? 'A batch is in progress'
    : backend.equipment.some(e => e.equipmentType === 'hammermill' && e.enabled) ? 'A hammermill is enabled' : null;
  const signals = showAll ? backend.ioSignals : backend.ioSignals.filter(s => s.equipmentId === equipmentId);

  const force = (id: string, value: boolean | number) => backend.sendCommand('SetOverride', id, { value });
  const release = (id: string) => backend.sendCommand('ClearOverride', id);
  const numInput = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '2px 6px', fontFamily: 'inherit', fontSize: '11px', width: '64px' } as const;

  const sigRow = (sig: BackendSignal) => {
    const analog = sig.direction === 'AI' || sig.direction === 'AO';
    const isOutput = sig.direction === 'DO' || sig.direction === 'AO';
    const val = isOutput ? backend.ioOutputs[sig.id] : backend.ioInputs[sig.id];
    const on = !!val;
    const isOverridden = sig.id in backend.ioOverrides;
    // Forcing an output needs commissioning mode — the backend rejects it
    // otherwise. Hide the control rather than show one that always fails.
    const canOverride = !isOutput || backend.commissioningMode || isOverridden;
    const disabled = !!blocked && !isOverridden && (!!showAll || isOutput);
    const draft = drafts[sig.id] ?? (typeof backend.ioOverrides[sig.id] === 'number' ? String(backend.ioOverrides[sig.id]) : '0');
    const n = Number(draft);
    const validNum = draft.trim() !== '' && Number.isFinite(n);
    const commit = () => { if (isOverridden && validNum) force(sig.id, n); };

    return (
      <div key={sig.id} className="flex items-center gap-2 py-0.5" style={{ fontSize: '11px' }}>
        {!analog && <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: on ? 'var(--green)' : 'var(--fg-dim)', opacity: on ? 1 : 0.3 }} />}
        <span style={{ color: 'var(--fg-dim)', width: '42px', flexShrink: 0 }}>{sig.id}</span>
        <span style={{ color: on || analog ? 'var(--fg-bright)' : 'var(--fg-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {showAll ? (sig.assignment
            ? <span title="Configured as" style={{ color: 'var(--accent)', border: '1px solid var(--border)', borderRadius: '3px', padding: '0 6px' }}>{sig.assignment}</span>
            : <span style={{ color: 'var(--fg-dim)' }}>unassigned</span>) : (sig.assignment ?? sig.port ?? sig.label)}
        </span>
        {analog && <span style={{ color: 'var(--fg-bright)', minWidth: '48px', textAlign: 'right', flexShrink: 0 }}>{typeof val === 'number' ? val : '—'}</span>}
        {canOverride && (
          <label style={{ flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center' }}
            title={isOverridden ? 'Forced — click to release' : disabled ? `Forcing is disabled: ${blocked}` : analog ? 'Force to the entered value' : 'Force on'}>
            <input type="checkbox" checked={isOverridden} disabled={disabled || (analog && !isOverridden && !validNum)}
              onChange={() => isOverridden ? release(sig.id) : force(sig.id, analog ? n : true)}
              style={{ accentColor: 'var(--orange)', width: '12px', height: '12px', cursor: 'pointer' }} />
          </label>
        )}
        {analog && canOverride && (
          <input type="number" aria-label={`Force value for ${sig.id}`} value={draft} style={numInput}
            onChange={e => setDrafts({ ...drafts, [sig.id]: e.target.value })}
            onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }} />
        )}
      </div>
    );
  };

  if (signals.length === 0) return null;

  const sections: [string, string][] = [['DI', 'I'], ['DO', 'O'], ['AI', 'AI'], ['AO', 'AO']];
  return (
    <div style={embedded ? undefined : { borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      {blocked && (showAll || backend.commissioningMode) && <div className="mb-2" style={{ color: 'var(--orange)', fontSize: '11px' }}>Forcing is disabled: {blocked.toLowerCase()}. Existing forces can still be released.</div>}
      {sections.map(([dir, title]) => {
        const rows = signals.filter(s => s.direction === dir);
        return rows.length === 0 ? null : (
          <div key={dir} className="mb-2">
            <div className="mb-1" style={{ color: 'var(--fg-dim)', fontSize: '11px', fontWeight: 500 }}>{title}</div>
            {rows.map(sigRow)}
          </div>
        );
      })}
    </div>
  );
}

const loadInput = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontFamily: 'inherit', fontSize: '12px', width: '72px' } as const;
const ghostBtn = { background: 'transparent', color: 'var(--fg-bright)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' } as const;
const stepBtn = { ...ghostBtn, width: '26px', height: '26px', fontSize: '14px', fontWeight: 600, lineHeight: '1', color: 'var(--fg-bright)' } as const;

// The input kinds a device can bypass (backend BYPASSABLE) and how the sidebar names them.
const BYPASS_LABELS: Record<string, string> = {
  runConfirmAux: 'MS Aux', vfdAuxInput: 'VFD Aux', motorAuxInput: 'MS Aux', analogLoadInput: 'Load sensor',
  rotationPulseInput: 'Rotation sensor', openLimitInput: 'P1 limit switch', closedLimitInput: 'P2 limit switch',
  highLevelInput: 'High Switch', lowLevelInput: 'Low Switch',
};
const bypassKeys = (beq: BackendEquipment) =>
  Object.keys(BYPASS_LABELS).filter(k => !!beq.config[k] && (k !== 'vfdAuxInput' || !!beq.config.masterVfd) && (k !== 'motorAuxInput' || !!beq.config.motorGate));

// Every configured digital point of this device with its live state. Orange = forced (commissioning) or the input is bypassed.
function IOMonitor({ beq, backend }: { beq: BackendEquipment; backend: Backend }) {
  const sigs = backend.ioSignals.filter(s => s.equipmentId === beq.id && (s.direction === 'DI' || s.direction === 'DO'));
  if (sigs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      <div className="mb-1" style={{ color: 'var(--fg-bright)', fontSize: '11px', fontWeight: 500 }}>IO MONITOR</div>
      {sigs.map(sig => {
        const on = !!(sig.direction === 'DO' ? backend.ioOutputs[sig.id] : backend.ioInputs[sig.id]);
        const forced = sig.id in backend.ioOverrides || (!!sig.port && beq.config[`bypass_${sig.port}`] === true);
        const dot = forced ? 'var(--orange)' : on ? 'var(--green)' : 'var(--fg-dim)';
        return (
          <div key={sig.id} className="flex items-center gap-2" style={{ fontSize: '11px', color: forced ? 'var(--orange)' : 'var(--fg-bright)' }}>
            <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: dot, opacity: forced || on ? 1 : 0.3 }} />
            <span style={{ width: '42px', flexShrink: 0 }}>{sig.id}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sig.label.replace(`${beq.id} `, '')}</span>
            <span>{on ? 'ON' : 'OFF'}</span>
          </div>
        );
      })}
    </div>
  );
}

function OverridesPanel({ beq, backend }: { beq: BackendEquipment; backend: Backend }) {
  const keys = bypassKeys(beq);
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      <div style={{ color: 'var(--fg-bright)', fontSize: '11px', fontWeight: 500 }}>OVERRIDES</div>
      {keys.map(k => {
        const on = beq.config[`bypass_${k}`] === true;
        // A gate's two limit switch overrides are exclusive: turn one off before the other can be turned on.
        const other = k === 'openLimitInput' ? 'closedLimitInput' : k === 'closedLimitInput' ? 'openLimitInput' : undefined;
        const blocked = !on && !!other && beq.config[`bypass_${other}`] === true;
        return (
          <label key={k} className="flex items-center gap-2" style={{ color: on ? 'var(--orange)' : 'var(--fg)', fontSize: '12px', opacity: blocked ? 0.5 : 1 }}>
            <input type="checkbox" checked={on} disabled={blocked} style={{ accentColor: 'var(--accent)' }}
              onChange={e => backend.sendCommand('SetBypass', beq.id, { key: k, value: e.target.checked })} />
            <span>{BYPASS_LABELS[k]} <span style={{ color: 'var(--fg-bright)', fontSize: '11px' }}>({String(beq.config[k])})</span></span>
          </label>
        );
      })}
    </div>
  );
}

function Modal({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 20px', maxWidth: '680px', width: '92%' }}>
        <div style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>{title}</div>
        <div style={{ color: 'var(--fg)', fontSize: '12px' }}>{children}</div>
        <div className="flex justify-end gap-2" style={{ marginTop: '12px' }}>{actions}</div>
      </div>
    </div>
  );
}

// One per-machine load number: shows the backend value, commits on Enter/blur through SetLoadConfig (allowed while running).
function LoadNum({ beq, backend, k, label, unit, def = 0, step = 1, stepper }: { beq: BackendEquipment; backend: Backend; k: string; label: string; unit?: string; def?: number; step?: number; stepper?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cur = Number(beq.config[k] ?? def);
  const value = draft ?? String(cur);
  const send = (n: number) => backend.sendCommand('SetLoadConfig', beq.id, { values: { [k]: n } });
  async function commit() {
    if (draft === null) return;
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n) && n >= 0 && n !== cur) await send(n);
    setDraft(null);
  }
  return (
    <label className="flex items-center justify-between gap-2">
      <span style={{ color: 'var(--fg-bright)', fontSize: '11px' }}>{label}</span>
      <span className="flex items-center gap-1">
        {stepper && <button type="button" aria-label={`${label} down`} style={stepBtn} onClick={() => send(Math.max(0, Math.round((cur - stepper) * 100) / 100))}>−</button>}
        <input type="number" min={0} step={step} value={value} style={loadInput}
          onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        {stepper && <button type="button" aria-label={`${label} up`} style={stepBtn} onClick={() => send(Math.round((cur + stepper) * 100) / 100)}>+</button>}
        <span style={{ color: 'var(--fg-bright)', fontSize: '11px', width: '14px' }}>{unit}</span>
      </span>
    </label>
  );
}

type TrendPoint = { t: number; a: number; s?: number; sp?: number };

// Larger trend of the last 10 minutes (backend keeps 1 Hz samples), polled while the dialog is open.
function TrendModal({ beq, onClose }: { beq: BackendEquipment; onClose: () => void }) {
  const id = beq.id;
  const minAmps = Number(beq.config.minAmps ?? 0), maxAmps = Number(beq.config.maxAmps ?? 100);
  const [pts, setPts] = useState<TrendPoint[]>([]);
  useEffect(() => {
    let off = false;
    const load = async () => {
      try { const r = await fetch(`${BACKEND_HTTP}/api/v1/trend/${encodeURIComponent(id)}`); const d = await r.json(); if (!off && Array.isArray(d)) setPts(d); } catch {}
    };
    load();
    const h = setInterval(load, 2000);
    return () => { off = true; clearInterval(h); };
  }, [id]);
  const L = 44, W = 640, H = 240;
  const t0 = pts[0]?.t ?? 0, span = Math.max(1, (pts[pts.length - 1]?.t ?? 0) - t0);
  const X = (t: number) => L + ((t - t0) / span) * (W - L);
  const Y = (a: number) => H - ((a - minAmps) / Math.max(0.001, maxAmps - minAmps)) * H;
  const line = (f: (p: TrendPoint) => number | undefined, scale: (v: number) => number) =>
    pts.flatMap(p => { const v = f(p); return v === undefined ? [] : [`${X(p.t).toFixed(1)},${Math.max(0, Math.min(H, scale(v))).toFixed(1)}`]; }).join(' ');
  const sp = pts[pts.length - 1]?.sp;
  return (
    <Modal title={`${id} load trend`} actions={<button onClick={onClose} className="px-3 py-1.5 text-xs font-medium" style={ghostBtn}>Close</button>}>
      {pts.length < 2 ? <div style={{ color: 'var(--fg-dim)' }}>Collecting samples…</div> : (
        <>
          <svg viewBox={`0 0 ${W} ${H + 16}`} width="100%" role="img" aria-label="Load trend, last 10 minutes" style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px' }}>
            {[0, 0.5, 1].map(f => (
              <g key={f}>
                <line x1={L} x2={W} y1={H - f * H} y2={H - f * H} stroke="var(--border)" strokeWidth={1} />
                <text x={L - 4} y={Math.min(H, Math.max(11, H - f * H + 4))} textAnchor="end" fill="var(--fg-dim)" fontSize="11">{Math.round((minAmps + f * (maxAmps - minAmps)) * 10) / 10} A</text>
              </g>
            ))}
            {sp !== undefined && <line x1={L} x2={W} y1={Y(sp)} y2={Y(sp)} stroke="var(--orange)" strokeDasharray="4 3" strokeWidth={1} />}
            <polyline points={line(p => p.s, v => H - (v / 100) * H)} fill="none" stroke="var(--fg-dim)" strokeWidth={1} />
            <polyline points={line(p => p.a, Y)} fill="none" stroke="var(--green)" strokeWidth={1.5} />
            <text x={L} y={H + 13} fill="var(--fg-dim)" fontSize="11">−{Math.round(span / 6000) / 10} min</text>
            <text x={W} y={H + 13} textAnchor="end" fill="var(--fg-dim)" fontSize="11">now</text>
          </svg>
          <div style={{ color: 'var(--fg-dim)', fontSize: '11px', marginTop: '4px' }}>
            Amps (green) · feeder speed 0–100% (grey){sp !== undefined ? ' · setpoint (dashed)' : ''}
          </div>
        </>
      )}
    </Modal>
  );
}

// Per-machine load settings live here (Settings only assigns the input, its scaling and the feeder at commissioning).
// Auto/Manual follows the PLC's PID: Manual tracks the feeder's speed (bumpless), Auto drives it, and the speed is only
// hand-adjustable (1% steps, like the PLC's MV inc/dec) in Manual.
function LoadPanel({ beq, backend }: { beq: BackendEquipment; backend: Backend }) {
  const c = beq.config;
  const feeder = backend.equipment.find(e => e.id === c.loadControlFeeder);
  const bypass = c.bypass_analogLoadInput === true;
  const locked = !!beq.loadControlAuto || !!beq.loadAtRunning;
  const [confirmTune, setConfirmTune] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const nf = (k: string, label: string, unit?: string, def = 0, step = 1, stepper?: number) => <LoadNum beq={beq} backend={backend} k={k} label={label} unit={unit} def={def} step={step} stepper={stepper} />;
  const fMin = Number(feeder?.config.speedMinLimit ?? 0), fMax = Number(feeder?.config.speedMaxLimit ?? 100);
  const nudge = (d: number) => feeder && backend.sendCommand('SetEquipmentSpeed', feeder.id, { speed: Math.min(fMax, Math.max(fMin, Math.round((feeder.speed ?? 0) + d))) });
  const modeBtn = (auto: boolean) => {
    const on = !!beq.loadControlAuto === auto;
    return (
      <button key={String(auto)} disabled={bypass || !!beq.loadAtRunning} onClick={() => backend.sendCommand('SetLoadControl', beq.id, { auto })}
        className="px-2 py-1 text-xs font-medium flex-1"
        style={{ background: on ? (auto ? 'var(--green)' : 'var(--orange)') : 'var(--bg)', color: on ? '#000' : 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer', opacity: bypass || beq.loadAtRunning ? 0.5 : 1 }}>
        {auto ? 'Auto' : 'Manual'}
      </button>
    );
  };
  return (
    <div className="flex flex-col gap-2" style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      <div className="flex items-center justify-between">
        <span style={{ color: 'var(--fg-bright)', fontSize: '11px', fontWeight: 500 }}>LOAD</span>
        <span style={{ color: beq.loadDisconnected ? 'var(--red)' : 'var(--fg-bright)', fontWeight: 600 }}>
          {beq.loadDisconnected ? 'Sensor disconnected' : beq.loadAmps === undefined ? '—' : Number(c.motorFla ?? 0) > 0 ? `${loadText(beq)} · ${beq.loadAmps} A` : `${beq.loadAmps} A (set Motor FLA in Settings for %)`}
        </span>
      </div>
      {bypass && <div style={{ color: 'var(--orange)', fontSize: '11px' }}>Load sensor bypassed (see Overrides): no limits, no sensor-fault trip, no load control.</div>}
      {nf('hiWarnAmps', 'High Warn (0 = off)', 'A')}
      {nf('hiPauseAmps', 'High Limit trip (0 = off)', 'A')}
      {nf('loadLimitDelay', 'Limit Delay', 's', 2, 0.1)}
      {feeder && <>
        <div style={{ color: 'var(--fg-bright)', fontSize: '11px', fontWeight: 500, marginTop: '4px' }}>LOAD CONTROL · feeder {feeder.id}</div>
        {nf('loadSetpointAmps', 'Load Setpoint', 'A', 0, 1, 1)}
        {nf('loadKp', 'Gain Kp (% per A)', '', 0, 0.05)}
        {nf('loadTiSec', 'Integral Ti (0 = off)', 's', 0, 0.5)}
        {nf('loadTdSec', 'Derivative Td (0 = off)', 's', 0, 0.1)}
        <div className="flex gap-1">{modeBtn(false)}{modeBtn(true)}</div>
        <div className="flex items-center justify-between gap-2">
          <span style={{ color: 'var(--fg-bright)', fontSize: '11px' }}>Feeder speed {locked ? '(set by load control)' : ''}</span>
          <span className="flex items-center gap-1">
            <button type="button" aria-label="Feeder speed down" style={{ ...stepBtn, opacity: locked ? 0.4 : 1 }} disabled={locked} onClick={() => nudge(-1)}>−</button>
            <span style={{ color: 'var(--fg-bright)', fontWeight: 600, width: '44px', textAlign: 'center' }}>{Math.round(feeder.speed ?? 0)} %</span>
            <button type="button" aria-label="Feeder speed up" style={{ ...stepBtn, opacity: locked ? 0.4 : 1 }} disabled={locked} onClick={() => nudge(1)}>+</button>
          </span>
        </div>
        <button onClick={() => (beq.loadAtRunning ? backend.sendCommand('CancelLoadAutotune', beq.id) : setConfirmTune(true))}
          className="px-2 py-1 text-xs font-medium" style={ghostBtn}>
          {beq.loadAtRunning ? 'Cancel Autotune' : 'Autotune…'}
        </button>
        {nf('loadAtStepPct', 'Autotune speed step', '%', 10)}
        {nf('loadAtHyst', 'Autotune hysteresis', 'A', 1, 0.1)}
        {nf('loadAtGain', 'Autotune gain (1 fast – 10 slow)', '', 7)}
        <div style={{ color: 'var(--fg-bright)', fontSize: '11px' }}>
          {beq.loadAtMsg ?? 'Autotune needs the mill and feeder running, with the feeder near the speed that gives the setpoint load.'}
        </div>
      </>}
      <button onClick={() => setShowTrend(true)} className="px-2 py-1 text-xs font-medium" style={ghostBtn}>Show Trend</button>
      {showTrend && <TrendModal beq={beq} onClose={() => setShowTrend(false)} />}
      {confirmTune && feeder && (
        <Modal title="Start autotune?" actions={<>
          <button onClick={() => setConfirmTune(false)} className="px-3 py-1.5 text-xs font-medium" style={ghostBtn}>Cancel</button>
          <button onClick={() => { setConfirmTune(false); backend.sendCommand('StartLoadAutotune', beq.id); }} className="px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer', fontWeight: 600 }}>Start Autotune</button>
        </>}>
          <p style={{ marginBottom: '6px' }}>
            {feeder.id} will be driven ±{Number(c.loadAtStepPct ?? 10)}% around its current speed ({Math.round(feeder.speed ?? 0)}%) so {beq.id}&apos;s load swings around {Number(c.loadSetpointAmps ?? 0)} A, for a few minutes (it gives up after 15).
          </p>
          <p style={{ marginBottom: '6px' }}>The high limit still trips the mill. Kp and Ti are replaced with the measured values, then control returns to {beq.loadControlAuto ? 'Auto' : 'Manual'}.</p>
          <p style={{ color: 'var(--orange)' }}>Make sure it is safe to vary the load on {beq.id}.</p>
        </Modal>
      )}
    </div>
  );
}
