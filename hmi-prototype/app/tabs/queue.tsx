'use client';

import { useState, useEffect } from 'react';
import { type QueueEntry, type Recipe, type Bin } from '../sim-data';
import { useBackend, type BackendBatch } from '../backend';
import { useMillStore, type FlowConnection } from '../store';

const stateColor: Record<string, string> = {
  IDLE: 'var(--gray)',
  VALIDATING: 'var(--orange)',
  READY: 'var(--accent)',
  DOSING: 'var(--green)',
  MIXING: 'var(--green)',
  ROUTE_PRECHECK: 'var(--orange)',
  DISCHARGING: 'var(--green)',
  CLEAROUT: 'var(--orange)',
  COMPLETED: 'var(--fg-dim)',
  PAUSING: 'var(--orange)',
  PAUSED: 'var(--orange)',
  FAULTED: 'var(--red)',
};

const RUNNING_STATES = new Set(['VALIDATING', 'DOSING', 'MIXING', 'ROUTE_PRECHECK', 'DISCHARGING', 'CLEAROUT', 'PAUSING', 'PAUSED', 'FAULTED']);
const EDITABLE_STATES = new Set(['IDLE', 'READY']);

const btnBase = { padding: '6px 14px', borderRadius: '3px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600 } as const;

function backendToQueueEntry(b: BackendBatch): QueueEntry {
  return {
    id: b.id, recipeId: b.recipeId, recipeName: b.recipeName,
    targetMass: b.targetMass, destination: b.destination,
    state: b.state as QueueEntry['state'],
    progress: b.progress,
    startedAt: b.startedAt, completedAt: b.completedAt,
    actuals: b.dosingSteps?.map(s => ({
      ingredientId: s.ingredientId, target: s.target, actual: s.actual,
      unit: s.unit, sourceBinId: s.sourceBinId,
    })),
  };
}

function findHmPathGroups(hmIds: string[], connections: FlowConnection[]): string[][] {
  if (hmIds.length <= 1) return hmIds.map(id => [id]);
  const adj = new Map<string, Set<string>>();
  for (const c of connections) {
    if (!adj.has(c.from)) adj.set(c.from, new Set());
    adj.get(c.from)!.add(c.to);
  }
  function reachable(start: string): Set<string> {
    const visited = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      for (const next of adj.get(n) ?? []) stack.push(next);
    }
    visited.delete(start);
    return visited;
  }
  const down = hmIds.map(id => ({ id, nodes: reachable(id) }));
  const used = new Set<number>();
  const groups: string[][] = [];
  for (let i = 0; i < down.length; i++) {
    if (used.has(i)) continue;
    const group = [down[i].id];
    used.add(i);
    for (let j = i + 1; j < down.length; j++) {
      if (used.has(j)) continue;
      for (const node of down[i].nodes) {
        if (down[j].nodes.has(node)) { group.push(down[j].id); used.add(j); break; }
      }
    }
    groups.push(group);
  }
  return groups;
}

export function QueueTab() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newBatchOpen, setNewBatchOpen] = useState(false);
  const [editBatchId, setEditBatchId] = useState<string | null>(null);
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false);
  const [awaitingUnload, setAwaitingUnload] = useState(false);

  const backend = useBackend();
  const { equipment, connections } = useMillStore();

  const queueData: QueueEntry[] = backend?.connected
    ? backend.queue.map(backendToQueueEntry)
    : [];
  const recipes: Recipe[] = backend?.connected ? backend.recipes : [];
  const allBins: Bin[] = backend?.connected ? backend.bins : [];
  const ingredients = backend?.connected ? backend.ingredients : [];
  const finishedBins = allBins.filter(b => b.type === 'finished');

  const activeBatchEntry: QueueEntry | null = backend?.connected
    ? (backend.activeBatch ? backendToQueueEntry(backend.activeBatch) : null)
    : queueData.find(q => RUNNING_STATES.has(q.state)) ?? null;

  // Bin full: the backend's level state for the destination (its fullSensor input is active)
  const batchDestBinFull = !!activeBatchEntry && allBins.find(b => b.id === activeBatchEntry.destination)?.levelSwitchState === 'full';

  const hasActiveBatch = !!activeBatchEntry;
  const TERMINAL = new Set(['COMPLETED', 'FAULTED']);
  const active = queueData.filter(q => !TERMINAL.has(q.state));
  const history = queueData.filter(q => TERMINAL.has(q.state));

  // Hammermills
  const hammermills = equipment.filter(e => e.equipmentType === 'hammermill');
  const hmIds = hammermills.map(h => h.id);
  const hmGroups = findHmPathGroups(hmIds, connections);
  const hmGroupMap = new Map<string, string[]>();
  for (const group of hmGroups) for (const id of group) hmGroupMap.set(id, group);

  const backendEqMap = new Map((backend?.connected ? backend.equipment : []).map(e => [e.id, e]));

  useEffect(() => {
    if (!hasActiveBatch) setAwaitingUnload(false);
  }, [hasActiveBatch]);

  function handleHmDestChange(hmId: string, dest: string) {
    const group = hmGroupMap.get(hmId) ?? [hmId];
    if (backend?.connected) {
      for (const id of group) backend.sendCommand('SetHammermillDestination', id, { destination: dest });
    }
  }

  function handleHmToggle(hmId: string) {
    const beq = backendEqMap.get(hmId);
    const hm = hammermills.find(h => h.id === hmId);
    const currentMode = beq?.mode ?? hm?.mode ?? 'Auto';
    const newMode = currentMode === 'Off' ? 'Auto' : 'Off';
    if (backend?.connected) backend.sendCommand('SetEquipmentMode', hmId, { mode: newMode });
  }

  const isPaused = activeBatchEntry?.state === 'PAUSED' || activeBatchEntry?.state === 'PAUSING';

  async function handleAbortConfirm() {
    if (backend?.connected) await backend.sendCommand('AbortBatch');
    setAbortConfirmOpen(false);
    setAwaitingUnload(true);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Top split: Batch Status + Hammermill Control */}
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Panel title="BATCH STATUS">
          {activeBatchEntry ? (
            <div className="px-3 py-3 flex flex-col gap-3" style={{ fontSize: '12px' }}>
              <div className="flex items-center justify-between">
                <div>
                  <div style={{ color: 'var(--fg-bright)', fontWeight: 600, fontSize: '14px' }}>
                    #{activeBatchEntry.id} &mdash; {activeBatchEntry.recipeName}
                  </div>
                  <div style={{ color: batchDestBinFull ? 'var(--orange)' : 'var(--fg-dim)', marginTop: '2px' }}>
                    Dest: {activeBatchEntry.destination}{batchDestBinFull && ' — BIN FULL'}
                  </div>
                </div>
                <span style={{ color: stateColor[activeBatchEntry.state] ?? 'var(--fg)', fontWeight: 600 }}>
                  {activeBatchEntry.state}
                </span>
              </div>
              <div>
                <div className="flex justify-between" style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: '4px' }}>
                  <span>Progress</span>
                  <span style={{ color: 'var(--fg-bright)' }}>{(activeBatchEntry.progress ?? 0).toFixed(1)}%</span>
                </div>
                <div style={{ background: 'var(--bg)', borderRadius: '2px', height: '6px', overflow: 'hidden' }}>
                  <div style={{ background: stateColor[activeBatchEntry.state] ?? 'var(--accent)', width: `${activeBatchEntry.progress ?? 0}%`, height: '100%', borderRadius: '2px', transition: 'width 0.3s' }} />
                </div>
              </div>
              {backend?.connected && (
                <div className="flex gap-2">
                  {awaitingUnload ? (
                    <button onClick={() => { backend.sendCommand('UnloadBatch'); setAwaitingUnload(false); }}
                      style={{ ...btnBase, background: 'var(--green)', color: '#000' }}>Unload</button>
                  ) : isPaused ? (
                    <button onClick={() => backend.sendCommand('ResumeBatch')}
                      style={{ ...btnBase, background: 'var(--green)', color: '#000' }}>Resume</button>
                  ) : (
                    <button onClick={() => backend.sendCommand('PauseBatch')}
                      style={{ ...btnBase, background: 'var(--orange)', color: '#000' }}>Pause</button>
                  )}
                  {!awaitingUnload && (
                    <button onClick={() => setAbortConfirmOpen(true)}
                      style={{ ...btnBase, background: 'var(--red)', color: '#fff' }}>Abort</button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="px-3 py-6 text-center" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>No active batch</div>
          )}
        </Panel>

        <Panel title="HAMMERMILL CONTROL">
          <div className="px-3 py-3">
            {hammermills.length === 0 ? (
              <div className="text-center py-4" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>No hammermills configured</div>
            ) : (
              <div className="flex gap-4">
                {hammermills.map(hm => {
                  const beq = backendEqMap.get(hm.id);
                  const mode = beq?.mode ?? hm.mode;
                  const status = beq?.status ?? hm.status;
                  const destId = (beq?.config.destination as string | undefined) ?? (hm.config.destination as string | undefined) ?? '';
                  const isBinFull = !!destId && allBins.find(b => b.id === destId)?.levelSwitchState === 'full';
                  const isOff = mode === 'Off';
                  const refilling = beq?.refillState;
                  const label = isOff ? (refilling ? 'Stopping' : 'Disabled') : isBinFull ? 'Bin Full' : refilling ? `Refilling (${refilling.toLowerCase()})` : status === 'running' ? 'Running' : status === 'fault' ? 'Faulted' : 'Stopped';
                  const dotColor = isOff ? 'var(--fg-dim)' : isBinFull ? 'var(--orange)' : status === 'running' ? 'var(--green)' : status === 'fault' ? 'var(--red)' : 'var(--fg-dim)';
                  return (
                    <div key={hm.id} className="flex flex-col gap-2 flex-1" style={{ minWidth: 0, fontSize: '12px' }}>
                      <div style={{ color: 'var(--fg-bright)', fontWeight: 600, fontSize: '13px' }}>{beq?.name ?? hm.name}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ background: dotColor }} />
                        <span style={{ color: dotColor }}>{label}</span>
                      </div>
                      <button onClick={() => handleHmToggle(hm.id)}
                        className="px-3 py-1.5 text-xs font-medium"
                        style={{
                          background: isOff ? 'var(--bg)' : 'var(--green)',
                          color: isOff ? 'var(--fg-dim)' : '#000',
                          border: '1px solid var(--border)',
                          borderRadius: '3px', cursor: 'pointer',
                        }}>
                        {isOff ? 'Enable' : 'Disable'}
                      </button>
                      <div className="flex flex-col gap-1">
                        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Destination</span>
                        <select value={destId} onChange={e => handleHmDestChange(hm.id, e.target.value)}
                          style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontSize: '12px' }}>
                          <option value="">---</option>
                          {finishedBins.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* Queue */}
      <Panel title="QUEUE" action={
        <button onClick={() => setNewBatchOpen(true)}
          style={{ ...btnBase, padding: '4px 10px', background: 'var(--accent)', color: '#000' }}>+ New Batch</button>
      }>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
              <th className="text-left py-2 px-3">Batch</th>
              <th className="text-left py-2 px-3">Recipe</th>
              <th className="text-right py-2 px-3">Target</th>
              <th className="text-left py-2 px-3">Dest</th>
              <th className="text-left py-2 px-3">State</th>
              <th className="text-right py-2 px-3">Progress</th>
            </tr>
          </thead>
          <tbody>
            {active.map((q, i) => (
              <BatchRow key={`${q.id}-${i}`} entry={q} expanded={expanded === q.id}
                onToggle={() => setExpanded(expanded === q.id ? null : q.id)}
                onEdit={EDITABLE_STATES.has(q.state) ? () => setEditBatchId(q.id) : undefined}
                onStart={q.state === 'IDLE' && !hasActiveBatch && backend?.connected
                  ? () => backend.sendCommand('StartBatch', q.id) : undefined}
                ingredients={ingredients} />
            ))}
            {active.length === 0 && (
              <tr><td colSpan={6} className="py-3 text-center" style={{ color: 'var(--fg-dim)' }}>No batches queued</td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      {/* History */}
      <Panel title="HISTORY">
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
              <th className="text-left py-2 px-3">Batch</th>
              <th className="text-left py-2 px-3">Recipe</th>
              <th className="text-right py-2 px-3">Target</th>
              <th className="text-left py-2 px-3">Dest</th>
              <th className="text-left py-2 px-3">State</th>
            </tr>
          </thead>
          <tbody>
            {history.map((q, i) => (
              <BatchRow key={`${q.id}-${i}`} entry={q} expanded={expanded === q.id}
                onToggle={() => setExpanded(expanded === q.id ? null : q.id)}
                ingredients={ingredients} />
            ))}
          </tbody>
        </table>
      </Panel>

      {/* Abort Confirm */}
      {abortConfirmOpen && (
        <ModalOverlay onClose={() => setAbortConfirmOpen(false)}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--fg-bright)' }}>Abort Batch?</div>
          <div style={{ fontSize: '12px', color: 'var(--fg)', marginBottom: '14px' }}>
            This will stop the current batch. Press Unload to run the unload sequence.
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setAbortConfirmOpen(false)}
              style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Cancel</button>
            <button onClick={handleAbortConfirm}
              style={{ ...btnBase, background: 'var(--red)', color: '#fff' }}>Abort</button>
          </div>
        </ModalOverlay>
      )}

      {/* New / Edit Batch */}
      {(newBatchOpen || editBatchId) && (
        <BatchFormModal
          recipes={recipes}
          finishedBins={finishedBins}
          initial={editBatchId ? queueData.find(q => q.id === editBatchId) : undefined}
          onSubmit={(data) => {
            if (editBatchId && backend?.connected) {
              backend.sendCommand('EditBatch', editBatchId, data);
            } else if (backend?.connected) {
              backend.sendCommand('QueueBatch', undefined, data);
            }
            setNewBatchOpen(false);
            setEditBatchId(null);
          }}
          onClose={() => { setNewBatchOpen(false); setEditBatchId(null); }}
        />
      )}
    </div>
  );
}

function BatchRow({ entry: q, expanded, onToggle, onEdit, onStart, ingredients }: {
  entry: QueueEntry; expanded: boolean; onToggle: () => void; onEdit?: () => void; onStart?: () => void; ingredients: { id: string; name: string }[];
}) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer"
        style={{ borderBottom: '1px solid var(--border)', background: expanded ? 'var(--bg-row)' : 'transparent' }}>
        <td className="py-2 px-3 font-medium" style={{ color: 'var(--fg-bright)' }}>{q.id}</td>
        <td className="py-2 px-3">{q.recipeName}</td>
        <td className="py-2 px-3 text-right">{Number(q.targetMass.toFixed(2)).toLocaleString()} lbs</td>
        <td className="py-2 px-3">{q.destination}</td>
        <td className="py-2 px-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: stateColor[q.state] ?? 'var(--gray)' }} />
            <span style={{ color: stateColor[q.state] ?? 'var(--fg)' }}>{q.state}</span>
          </span>
        </td>
        {q.state !== 'COMPLETED' && (
          <td className="py-2 px-3 text-right">{q.progress != null ? `${q.progress.toFixed(1)}%` : '—'}</td>
        )}
      </tr>
      {expanded && (
        <tr style={{ background: 'var(--bg-row)' }}>
          <td colSpan={7} className="px-6 py-2">
            {(onEdit || onStart) && (
              <div className="flex justify-end gap-2 mb-2">
                {onStart && (
                  <button onClick={(e) => { e.stopPropagation(); onStart(); }}
                    style={{ ...btnBase, padding: '2px 10px', fontSize: '11px', background: 'var(--accent)', color: '#000' }}>
                    Start
                  </button>
                )}
                {onEdit && (
                  <button onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-dim)', cursor: 'pointer', padding: '2px 8px', fontSize: '11px' }}>
                    Edit
                  </button>
                )}
              </div>
            )}
            {q.actuals ? (
              <table className="w-full" style={{ fontSize: '12px' }}>
                <thead>
                  <tr style={{ color: 'var(--fg-dim)' }}>
                    <th className="text-left py-0.5">Ingredient</th>
                    <th className="text-left py-0.5">Bin</th>
                    <th className="text-right py-0.5">Target</th>
                    <th className="text-right py-0.5">Actual</th>
                    <th className="text-right py-0.5">Var</th>
                  </tr>
                </thead>
                <tbody>
                  {q.actuals.map((a, i) => {
                    const prev = q.actuals!.slice(0, i);
                    const isFirst = !prev.some(p => p.ingredientId === a.ingredientId);
                    const peers = q.actuals!.filter(p => p.ingredientId === a.ingredientId);
                    const totalActual = peers.reduce((s, p) => s + p.actual, 0);
                    const target = peers.find(p => p.target > 0)?.target ?? 0;
                    const v = totalActual > 0 ? totalActual - target : 0;
                    return (
                      <tr key={`${a.ingredientId}-${a.sourceBinId}`} style={{ borderTop: isFirst ? '1px solid var(--border)' : undefined }}>
                        <td className="py-0.5" style={!isFirst ? { color: 'var(--fg-dim)' } : undefined}>{isFirst ? (ingredients.find(ing => ing.id === a.ingredientId)?.name ?? a.ingredientId) : '″'}</td>
                        <td className="py-0.5" style={{ color: 'var(--fg-dim)' }}>{a.sourceBinId}</td>
                        <td className="text-right py-0.5" style={!isFirst ? { color: 'var(--fg-dim)' } : undefined}>{isFirst ? `${target} ${a.unit}` : '″'}</td>
                        <td className="text-right py-0.5" style={!isFirst ? { color: 'var(--fg-dim)' } : { color: totalActual > 0 ? 'var(--fg-bright)' : 'var(--fg-dim)' }}>
                          {isFirst ? (totalActual > 0 ? `${totalActual.toFixed(1)} ${a.unit}` : '—') : '″'}
                        </td>
                        <td className="text-right py-0.5" style={!isFirst ? { color: 'var(--fg-dim)' } : { color: Math.abs(v) > 1 ? 'var(--orange)' : 'var(--fg-dim)' }}>
                          {isFirst ? (totalActual > 0 ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—') : '″'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>No dosing data</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function BatchFormModal({ recipes, finishedBins, initial, onSubmit, onClose }: {
  recipes: Recipe[]; finishedBins: Bin[]; initial?: QueueEntry;
  onSubmit: (data: { recipeId: string; destination: string }) => void;
  onClose: () => void;
}) {
  const [recipeId, setRecipeId] = useState(initial?.recipeId || recipes[0]?.id || '');
  const [dest, setDest] = useState(initial?.destination || finishedBins[0]?.id || '');

  const inputStyle = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '6px 10px', fontSize: '12px', width: '100%' } as const;

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '12px', color: 'var(--fg-bright)' }}>
        {initial ? `Edit Batch #${initial.id}` : 'New Batch'}
      </div>
      <div className="flex flex-col gap-3" style={{ fontSize: '12px' }}>
        <div className="flex flex-col gap-1">
          <span style={{ color: 'var(--fg-dim)' }}>Recipe</span>
          <select value={recipeId} onChange={e => setRecipeId(e.target.value)} style={inputStyle}>
            {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span style={{ color: 'var(--fg-dim)' }}>Destination</span>
          <select value={dest} onChange={e => setDest(e.target.value)} style={inputStyle}>
            {finishedBins.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>
      <div className="flex gap-2 justify-end mt-4">
        <button onClick={onClose}
          style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Cancel</button>
        <button onClick={() => onSubmit({ recipeId, destination: dest })}
          style={{ ...btnBase, background: 'var(--accent)', color: '#000' }}>
          {initial ? 'Save' : 'Queue Batch'}
        </button>
      </div>
    </ModalOverlay>
  );
}

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}>
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 20px', minWidth: '320px', maxWidth: '90vw' }}
        onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
      <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.03em' }}>
        <span>{title}</span>
        {action}
      </div>
      <div>{children}</div>
    </div>
  );
}
