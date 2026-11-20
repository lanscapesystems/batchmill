'use client';

import { useState, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { useMillStore, EQUIPMENT_DEFS, getPortsForEquipment, FLOW_HIDDEN_TYPES, type EquipmentItem, type EquipmentMode, type PortDef, type Position } from '../store';
import { useBackend, type BackendEquipment, type BackendSignal } from '../backend';

const BLOCK_W = 100;
const BLOCK_H = 50;

const SEL_PAD = 6;
const SEL_COLOR = '#e91e8a';

const TYPE_COLORS: Record<string, string> = {
  bin: '#5c6bc0', hammermill: '#ef5350', mixer: '#ab47bc', finished_bin: '#26a69a',
  micro_drag: '#ffa726', gate: '#8d6e63', auger: '#29b6f6',
};

function blockFill(eq: EquipmentItem, backendEq?: BackendEquipment): string {
  const status = backendEq?.status ?? eq.status;
  const mode = backendEq?.mode ?? eq.mode;
  if (status === 'fault') return '#b71c1c';
  if (status === 'warning') return '#e65100';
  if (mode === 'Off' || status === 'disabled') return '#4a148c';
  if (status === 'running') return '#2e7d32';
  return '#424242';
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
              const fill = blockFill(eq, backendEqMap.get(eq.id));
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
                  <text x={pos.x + BLOCK_W / 2} y={pos.y + BLOCK_H / 2 + 6} textAnchor="middle"
                    fill="#fff" fontSize="16" fontWeight="700"
                    fontFamily="Roboto, sans-serif" pointerEvents="none">{eq.id}</text>

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
            <span style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 700 }}>{selectedItem.id}</span>
            <button onClick={() => setSelectedEq(null)} style={{ color: 'var(--fg-dim)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '16px', lineHeight: '1' }}>✕</button>
          </div>

          <div className="px-3 py-3 flex flex-col gap-3" style={{ fontSize: '12px' }}>
            {/* Name & Type */}
            <div>
              <div style={{ color: 'var(--fg-bright)', fontWeight: 500 }}>{beq?.name ?? selectedItem.name}</div>
              <div style={{ color: TYPE_COLORS[selectedItem.equipmentType] ?? 'var(--fg-dim)', fontSize: '11px' }}>
                {EQUIPMENT_DEFS[selectedItem.equipmentType]?.label ?? selectedItem.equipmentType}
              </div>
            </div>

            {/* Status */}
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: blockFill(selectedItem, beq) }} />
              <span style={{ color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 500 }}>
                {liveStatus === 'not_running' ? 'STOPPED' : liveStatus.toUpperCase()}
              </span>
            </div>

            {beq?.faultReason && (
              <div style={{ color: 'var(--red)', fontSize: '11px' }}>{beq.faultReason}</div>
            )}

            {beq?.owner && (
              <div style={{ color: 'var(--accent)', fontSize: '11px' }}>Owner: {beq.owner}</div>
            )}

            {/* Mode control */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
              <div className="mb-2" style={{ color: 'var(--fg-dim)', fontSize: '11px', fontWeight: 500 }}>MODE</div>
              <div className="flex gap-1">
                {(['Hand', 'Auto', 'Off'] as EquipmentMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className="px-4 py-1.5 text-xs font-medium flex-1"
                    style={{
                      background: liveMode === m
                        ? (m === 'Hand' ? 'var(--orange)' : m === 'Off' ? 'var(--red)' : 'var(--green)')
                        : 'var(--bg)',
                      color: liveMode === m ? '#000' : 'var(--fg-dim)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      cursor: 'pointer',
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {beq && backend?.connected && !!beq.config.analogSpeedOutput && (
              <SpeedField key={beq.id} beq={beq} backend={backend} />
            )}

            {/* Full I/O signal listing with overrides */}
            {backend?.connected && (
              <IOSignalList equipmentId={selectedItem.id} backend={backend} />
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
          </div>
        </div>
        );
      })()}
    </div>
  );

}

export type Backend = NonNullable<ReturnType<typeof useBackend>>;

function SpeedField({ beq, backend }: { beq: BackendEquipment; backend: Backend }) {
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
      <div className="mb-2" style={{ color: 'var(--fg-dim)', fontSize: '11px', fontWeight: 500 }}>SPEED SETPOINT</div>
      <div className="flex items-center gap-2">
        <input
          type="number" value={value} min={min} max={max}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') apply(); }}
          aria-label="Speed setpoint percent"
          style={{ background: 'var(--bg)', border: `1px solid ${valid ? 'var(--border)' : 'var(--red)'}`, borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontSize: '12px', width: '80px' }}
        />
        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>%</span>
        <button
          onClick={apply} disabled={!valid || draft === null}
          className="px-3 py-1.5 text-xs font-medium"
          style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer', fontWeight: 600, opacity: !valid || draft === null ? 0.4 : 1 }}
        >
          Set
        </button>
      </div>
      <div className="mt-1" style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>
        Allowed {min}–{max}%. Used in Hand and as the normal feed speed in Auto.
      </div>
    </div>
  );
}

// equipmentId filters to one piece of equipment's mapped ports; pass showAll
// instead to list every rack signal regardless of equipment mapping (used by
// the Commissioning panel, where nothing may be mapped to equipment yet).
export function IOSignalList({ equipmentId, backend, showAll }: { equipmentId?: string; backend: Backend; showAll?: boolean }) {
  const [confirmSignal, setConfirmSignal] = useState<string | null>(null);
  const [confirmValue, setConfirmValue] = useState<boolean>(false);

  const signals = showAll ? backend.ioSignals : backend.ioSignals.filter(s => s.equipmentId === equipmentId);
  const outputs = signals.filter(s => s.direction === 'DO' || s.direction === 'AO');
  const inputs = signals.filter(s => s.direction === 'DI' || s.direction === 'AI');

  function handleOverrideToggle(sigId: string, currentlyOverridden: boolean, currentVal: boolean | number) {
    if (currentlyOverridden) {
      setConfirmSignal(sigId);
      setConfirmValue(false);
    } else {
      setConfirmSignal(sigId);
      setConfirmValue(!currentVal);
    }
  }

  function confirmOverride() {
    if (!confirmSignal) return;
    const isOverridden = confirmSignal in backend.ioOverrides;
    if (isOverridden) {
      backend.sendCommand('ClearOverride', confirmSignal);
    } else {
      backend.sendCommand('SetOverride', confirmSignal, { value: confirmValue });
    }
    setConfirmSignal(null);
  }

  const sigRow = (sig: BackendSignal) => {
    const isOutput = sig.direction === 'DO' || sig.direction === 'AO';
    const val = isOutput ? backend.ioOutputs[sig.id] : backend.ioInputs[sig.id];
    const on = !!val;
    const isOverridden = sig.id in backend.ioOverrides;
    // Forcing an output needs commissioning mode — the backend rejects it
    // otherwise. Hide the control rather than show one that always fails.
    const canOverride = !isOutput || backend.commissioningMode;

    return (
      <div key={sig.id} className="flex items-center gap-2 py-0.5" style={{ fontSize: '11px' }}>
        <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: on ? 'var(--green)' : 'var(--fg-dim)', opacity: on ? 1 : 0.3 }} />
        <span style={{ color: 'var(--fg-dim)', width: '42px', flexShrink: 0 }}>{sig.id}</span>
        <span style={{ color: on ? 'var(--fg-bright)' : 'var(--fg-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sig.port ?? sig.label}
        </span>
        <span style={{ color: on ? 'var(--green)' : 'var(--fg-dim)', width: '24px', textAlign: 'right', flexShrink: 0 }}>
          {typeof val === 'number' ? val : (on ? 'ON' : 'OFF')}
        </span>
        {canOverride && (
          <label style={{ flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            title={isOverridden ? 'Override active — click to release' : isOutput ? 'Force this output (commissioning mode)' : 'Override this input'}>
            <input
              type="checkbox"
              checked={isOverridden}
              onChange={() => handleOverrideToggle(sig.id, isOverridden, on)}
              style={{ accentColor: 'var(--orange)', width: '12px', height: '12px', cursor: 'pointer' }}
            />
          </label>
        )}
      </div>
    );
  };

  if (signals.length === 0) return null;

  return (
    <>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
        <div className="mb-1" style={{ color: 'var(--fg-dim)', fontSize: '11px', fontWeight: 500 }}>OUTPUTS</div>
        {outputs.length > 0 ? outputs.map(sigRow) : <div style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>None</div>}
        <div className="mt-2 mb-1" style={{ color: 'var(--fg-dim)', fontSize: '11px', fontWeight: 500 }}>INPUTS</div>
        {inputs.length > 0 ? inputs.map(sigRow) : <div style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>None</div>}
      </div>

      {/* Confirmation dialog */}
      {confirmSignal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setConfirmSignal(null)}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 20px', minWidth: '260px' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>
              {confirmSignal in backend.ioOverrides ? 'Release Override' : 'Set Override'}
            </div>
            <div style={{ color: 'var(--fg)', fontSize: '12px', marginBottom: '14px' }}>
              {(() => {
                const sig = backend.ioSignals.find(s => s.id === confirmSignal);
                const isOutput = sig?.direction === 'DO' || sig?.direction === 'AO';
                const normal = isOutput ? 'control logic' : 'the real reading';
                return confirmSignal in backend.ioOverrides
                  ? `Release manual override on ${confirmSignal}? Signal will return to ${normal}.`
                  : `${isOutput ? 'Force' : 'Override'} ${confirmSignal} to ${confirmValue ? 'ON' : 'OFF'}? This bypasses ${normal}${isOutput ? ' — the real output will energize.' : '.'}`;
              })()}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmSignal(null)}
                style={{ padding: '5px 14px', borderRadius: '3px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: '12px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={confirmOverride}
                style={{ padding: '5px 14px', borderRadius: '3px', border: 'none', background: confirmSignal in backend.ioOverrides ? 'var(--green)' : 'var(--orange)', color: '#000', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                {confirmSignal in backend.ioOverrides ? 'Release' : 'Confirm Override'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
