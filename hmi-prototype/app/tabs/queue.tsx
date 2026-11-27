'use client';

import { useState, useEffect } from 'react';
import { type QueueEntry, type Recipe, type Bin, type ToleranceHold, type DosingError } from '../sim-data';
import { useBackend, type BackendBatch } from '../backend';
import { useMillStore, type FlowConnection } from '../store';
import { ALL_DATES, DateRangeInputs, Pager, dateTime, useHistory } from './history';

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
  ABORTED_HOLD: 'var(--orange)',
  ABORTED: 'var(--red)',
};

const RUNNING_STATES = new Set(['VALIDATING', 'DOSING', 'MIXING', 'ROUTE_PRECHECK', 'DISCHARGING', 'CLEAROUT', 'PAUSING', 'PAUSED', 'FAULTED', 'ABORTED_HOLD']);
const EDITABLE_STATES = new Set(['IDLE']); // queued, not yet released
const stateLabel = (s: string) => (s === 'IDLE' ? 'QUEUED' : s.replace(/_/g, ' '));

const btnBase = { padding: '6px 14px', borderRadius: '3px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600 } as const;

// a finished batch as the history returns it: no progress, and only the dosing figures
type HistoryBatch = Omit<BackendBatch, 'progress' | 'dosingSteps'> & {
  progress?: number;
  dosingSteps?: Pick<NonNullable<BackendBatch['dosingSteps']>[number], 'ingredientId' | 'ingredientName' | 'sourceBinId' | 'target' | 'actual' | 'unit'>[];
};

function backendToQueueEntry(b: HistoryBatch): QueueEntry {
  return {
    id: b.id, recipeId: b.recipeId, recipeName: b.recipeName,
    targetMass: b.targetMass, destination: b.destination,
    state: b.state as QueueEntry['state'],
    progress: b.progress,
    startedAt: b.startedAt, completedAt: b.completedAt,
    scheduledAt: b.scheduledAt, late: b.late, warnings: b.warnings, faultReason: b.faultReason, tolHold: b.tolHold, dosingError: b.dosingError, microUnloading: b.microUnloading,
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
  const [abortMenu, setAbortMenu] = useState(false); // Abort pressed on a paused batch: the choices replace Resume/Abort
  const [cancelAckOpen, setCancelAckOpen] = useState(false);
  const [dosingDismissed, setDosingDismissed] = useState<string | null>(null); // dosing-error popup closed for this batch/step
  // questions the backend asks before going on: queue-time warnings, a scale that disagrees on resume
  const [warnAsk, setWarnAsk] = useState<{ warnings: string[]; action: string; targetId?: string; data: Record<string, unknown> } | null>(null);
  const [mismatchAsk, setMismatchAsk] = useState<{ saved: number; current: number; ingredientName: string } | null>(null);

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

  // Bin full: the backend's level state for the destination (its highLevelInput is active)
  const batchDestBinFull = !!activeBatchEntry && allBins.find(b => b.id === activeBatchEntry.destination)?.levelSwitchState === 'full';

  const hasActiveBatch = !!activeBatchEntry;
  const queueHeld = backend?.queueControl.held ?? true;
  const queueWaiting = backend?.queueControl.waiting;
  const [historyRange, setHistoryRange] = useState(ALL_DATES);
  // re-read when a batch leaves the live queue (it has just been added to the history)
  const history = useHistory<HistoryBatch>('batches', historyRange, `${backend?.connected} ${queueData.map(q => q.id).join()}`);

  // Hammermills
  const hammermills = equipment.filter(e => e.equipmentType === 'hammermill');
  const hmIds = hammermills.map(h => h.id);
  const hmGroups = findHmPathGroups(hmIds, connections);
  const hmGroupMap = new Map<string, string[]>();
  for (const group of hmGroups) for (const id of group) hmGroupMap.set(id, group);

  const backendEqMap = new Map((backend?.connected ? backend.equipment : []).map(e => [e.id, e]));


  function handleHmDestChange(hmId: string, dest: string) {
    const group = hmGroupMap.get(hmId) ?? [hmId];
    if (backend?.connected) {
      for (const id of group) backend.sendCommand('SetHammermillDestination', id, { destination: dest });
    }
  }

  function handleHmToggle(hmId: string) {
    const beq = backendEqMap.get(hmId);
    const hm = hammermills.find(h => h.id === hmId);
    const enabled = beq?.enabled ?? (hm?.status !== 'disabled');
    if (backend?.connected) backend.sendCommand('SetHammermillEnabled', hmId, { enabled: !enabled });
  }

  const isPaused = activeBatchEntry?.state === 'PAUSED' || activeBatchEntry?.state === 'PAUSING';

  async function handleCancelConfirm() {
    if (backend?.connected) await backend.sendCommand('AbortBatch', undefined, { mode: 'cancel', acknowledged: true });
    setCancelAckOpen(false); setAbortMenu(false);
  }

  // Add / edit a batch: the backend answers with warnings (inventory, mixer capacity) and the operator confirms to go on
  async function submitBatch(action: string, targetId: string | undefined, data: Record<string, unknown>) {
    if (!backend?.connected) return;
    const r = await backend.sendCommand(action, targetId, data);
    if (!r.accepted && r.reason === 'Warnings') { setWarnAsk({ warnings: (r.data as { warnings: string[] }).warnings, action, targetId, data }); return; }
    setNewBatchOpen(false); setEditBatchId(null);
  }

  async function handleResume(rebaseline = false) {
    if (!backend?.connected) return;
    setAbortMenu(false); setDosingDismissed(null);
    const r = await backend.sendCommand('ResumeBatch', undefined, rebaseline ? { rebaseline: true } : undefined);
    if (!r.accepted && r.reason === 'Scale mismatch') setMismatchAsk(r.data as { saved: number; current: number; ingredientName: string });
    else setMismatchAsk(null);
  }

  const aborted = activeBatchEntry?.state === 'ABORTED_HOLD';
  // the tolerance popup steps aside once the batch is paused, so the Abort choices are reachable
  const dosingError: DosingError | undefined = activeBatchEntry?.dosingError;
  const dosingKey = dosingError ? `${activeBatchEntry!.id}:${dosingError.stepIndex}` : null;
  const tolHold: ToleranceHold | undefined = isPaused ? undefined : activeBatchEntry?.tolHold;

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
                  {stateLabel(activeBatchEntry.state)}{activeBatchEntry.microUnloading ? ' · UNLOADING MICROS' : ''}
                </span>
              </div>
              {activeBatchEntry.faultReason && (
                <div style={{ color: 'var(--orange)', fontSize: '11px' }}>{activeBatchEntry.faultReason}</div>
              )}
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
                  {(aborted || (abortMenu && activeBatchEntry.state === 'PAUSED')) ? (
                    <>
                      <button onClick={() => { setAbortMenu(false); backend.sendCommand('AbortBatch', undefined, { mode: 'mixUnload' }); }}
                        style={{ ...btnBase, background: 'var(--green)', color: '#000' }}>Mix + Unload</button>
                      <button onClick={() => { setAbortMenu(false); backend.sendCommand('AbortBatch', undefined, { mode: 'unload' }); }}
                        style={{ ...btnBase, background: 'var(--orange)', color: '#000' }}>Unload</button>
                      <button onClick={() => setCancelAckOpen(true)}
                        style={{ ...btnBase, background: 'var(--red)', color: '#fff' }}>Cancel Batch</button>
                      {!aborted && (
                        <button onClick={() => setAbortMenu(false)}
                          style={{ ...btnBase, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)' }}>Back</button>
                      )}
                    </>
                  ) : isPaused ? (
                    <>
                      <button onClick={() => handleResume()}
                        style={{ ...btnBase, background: 'var(--green)', color: '#000' }}>Resume</button>
                      {activeBatchEntry.state === 'PAUSED' && dosingError && (
                        <button onClick={() => backend.sendCommand('AcceptDosing')}
                          style={{ ...btnBase, background: 'var(--accent)', color: '#000' }}>Accept and Continue</button>
                      )}
                      {activeBatchEntry.state === 'PAUSED' && (
                        <button onClick={() => setAbortMenu(true)}
                          style={{ ...btnBase, background: 'var(--red)', color: '#fff' }}>Abort</button>
                      )}
                    </>
                  ) : (
                    <button onClick={() => backend.sendCommand('PauseBatch')}
                      style={{ ...btnBase, background: 'var(--orange)', color: '#000' }}>Pause</button>
                  )}
                  {activeBatchEntry.state === 'DISCHARGING' && /not empty/.test(activeBatchEntry.faultReason ?? '') && (
                    <button onClick={() => backend.sendCommand('ExtendDischarge')}
                      style={{ ...btnBase, background: 'var(--accent)', color: '#000' }}>Extend Discharge</button>
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
                  const status = beq?.status ?? hm.status;
                  const destId = (beq?.config.destination as string | undefined) ?? (hm.config.destination as string | undefined) ?? '';
                  const isBinFull = !!destId && allBins.find(b => b.id === destId)?.levelSwitchState === 'full';
                  const isOff = !(beq?.enabled ?? status !== 'disabled'); // Enable/Disable switch, not the HOA mode
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
        <div className="flex items-center gap-2">
          {backend?.connected && (
            <span style={{ fontSize: '11px', color: queueHeld ? 'var(--orange)' : queueWaiting ? 'var(--orange)' : 'var(--fg-dim)' }}>
              {queueHeld ? 'Queue on hold' : queueWaiting ? `Waiting: ${queueWaiting}` : 'Queue running'}
            </span>
          )}
          {backend?.connected && (
            <button onClick={() => backend.sendCommand('SetQueueHold', undefined, { held: !queueHeld })}
              style={queueHeld
                ? { ...btnBase, padding: '4px 10px', background: 'var(--accent)', color: '#000' }
                : { ...btnBase, padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)' }}>
              {queueHeld ? 'Run Queue' : 'Hold Queue'}
            </button>
          )}
          <button onClick={() => setNewBatchOpen(true)}
            style={{ ...btnBase, padding: '4px 10px', background: 'var(--accent)', color: '#000' }}>+ New Batch</button>
        </div>
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
            {queueData.map(q => (
              <BatchRow key={q.id} entry={q} expanded={expanded === q.id}
                onToggle={() => setExpanded(expanded === q.id ? null : q.id)}
                onEdit={EDITABLE_STATES.has(q.state) ? () => setEditBatchId(q.id) : undefined}
                onDelete={EDITABLE_STATES.has(q.state) && backend?.connected ? () => backend.sendCommand('DeleteBatch', q.id) : undefined}
                onMove={EDITABLE_STATES.has(q.state) && backend?.connected ? (dir) => backend.sendCommand('MoveBatch', q.id, { direction: dir }) : undefined}
                ingredients={ingredients} />
            ))}
            {queueData.length === 0 && (
              <tr><td colSpan={6} className="py-3 text-center" style={{ color: 'var(--fg-dim)' }}>No batches queued</td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      {/* History */}
      <Panel title="HISTORY" action={<DateRangeInputs range={historyRange} onChange={setHistoryRange} />}>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
              <th className="text-left py-2 px-3">Batch</th>
              <th className="text-left py-2 px-3">Recipe</th>
              <th className="text-right py-2 px-3">Target</th>
              <th className="text-left py-2 px-3">Dest</th>
              <th className="text-left py-2 px-3">State</th>
              <th className="text-right py-2 px-3">Finished</th>
            </tr>
          </thead>
          <tbody>
            {history.rows.map(b => (
              <BatchRow key={b.id} entry={backendToQueueEntry(b)} finished expanded={expanded === b.id}
                onToggle={() => setExpanded(expanded === b.id ? null : b.id)}
                // names as recorded with the batch, so a deleted ingredient still reads correctly
                ingredients={(b.dosingSteps ?? []).map(s => ({ id: s.ingredientId, name: s.ingredientName }))} />
            ))}
            {history.message && (
              <tr><td colSpan={6} className="py-3 text-center" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>{history.message}</td></tr>
            )}
          </tbody>
        </table>
        <Pager history={history} />
      </Panel>

      {/* Cancel batch: acknowledged here; nothing is discharged */}
      {cancelAckOpen && (
        <ModalOverlay onClose={() => setCancelAckOpen(false)}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--fg-bright)' }}>Cancel batch?</div>
          <div style={{ fontSize: '12px', color: 'var(--orange)', marginBottom: '14px' }}>
            The batch ends now and the material already dosed stays in the mixer. It is deducted from the bins, but nothing is credited to a finished bin.
            The mixer must be emptied by hand before the next batch can start.
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setCancelAckOpen(false)}
              style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Go Back</button>
            <button onClick={handleCancelConfirm}
              style={{ ...btnBase, background: 'var(--red)', color: '#fff' }}>Cancel Batch</button>
          </div>
        </ModalOverlay>
      )}

      {/* New / Edit Batch */}
      {(newBatchOpen || editBatchId) && (
        <BatchFormModal
          recipes={recipes}
          finishedBins={finishedBins}
          initial={editBatchId ? queueData.find(q => q.id === editBatchId) : undefined}
          onSubmit={(data) => { submitBatch(editBatchId ? 'EditBatch' : 'QueueBatch', editBatchId ?? undefined, data); }}
          onClose={() => { setNewBatchOpen(false); setEditBatchId(null); }}
        />
      )}

      {/* Queue-time warnings: inventory and mixer capacity, confirmed here so the queue never stalls on them at start */}
      {warnAsk && (
        <ModalOverlay onClose={() => setWarnAsk(null)}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--fg-bright)' }}>Check before queueing</div>
          <ul style={{ fontSize: '12px', color: 'var(--orange)', margin: '0 0 14px 16px', listStyle: 'disc' }}>
            {warnAsk.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setWarnAsk(null)}
              style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Cancel</button>
            <button onClick={async () => { const a = warnAsk; setWarnAsk(null); await backend?.sendCommand(a.action, a.targetId, { ...a.data, acknowledged: true }); setNewBatchOpen(false); setEditBatchId(null); }}
              style={{ ...btnBase, background: 'var(--accent)', color: '#000' }}>{warnAsk.action === 'EditBatch' ? 'Save anyway' : 'Add anyway'}</button>
          </div>
        </ModalOverlay>
      )}

      {/* Dosing problem: the batch is paused with the error; accept it and carry on, or close this and Resume / Abort */}
      {dosingError && activeBatchEntry?.state === 'PAUSED' && dosingKey !== dosingDismissed && (
        <ModalOverlay onClose={() => setDosingDismissed(dosingKey)}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--fg-bright)' }}>Dosing problem: {dosingError.ingredientName}</div>
          <div style={{ fontSize: '12px', color: 'var(--orange)', marginBottom: '8px' }}>{dosingError.message}</div>
          <div style={{ fontSize: '12px', color: 'var(--fg)', marginBottom: '14px' }}>
            Dosed {dosingError.actual.toFixed(1)} of {dosingError.target} lbs. The batch is paused. Accept takes what was dosed and carries on with the next ingredient;
            or close this and Resume to try again, or Abort.
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setDosingDismissed(dosingKey)}
              style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Close</button>
            <button onClick={() => backend?.sendCommand('AcceptDosing')}
              style={{ ...btnBase, background: 'var(--accent)', color: '#000' }}>Accept and Continue</button>
          </div>
        </ModalOverlay>
      )}

      {/* Out of tolerance: the batch is holding for the operator */}
      {tolHold && (
        <ModalOverlay onClose={() => undefined}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--fg-bright)' }}>{tolHold.ingredientName} is out of tolerance</div>
          <table style={{ fontSize: '12px', marginBottom: '14px' }}>
            <tbody>
              {([['Desired', `${tolHold.desired} lbs`], ['Actual', `${tolHold.actual.toFixed(1)} lbs`], ['Difference', `${tolHold.difference > 0 ? '+' : ''}${tolHold.difference.toFixed(1)} lbs`],
                ['Current freefall', `${tolHold.currentFreefall} lbs`], ['Freefall if updated', `${tolHold.newFreefall} lbs`]] as const).map(([k, val]) => (
                <tr key={k}><td style={{ color: 'var(--fg-dim)', paddingRight: '16px' }}>{k}</td><td style={{ color: 'var(--fg-bright)' }}>{val}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 justify-end">
            <button onClick={() => backend?.sendCommand('PauseBatch')}
              style={{ ...btnBase, background: 'var(--orange)', color: '#000' }}>Pause</button>
            <button onClick={() => backend?.sendCommand('ResolveTolerance', undefined, { choice: 'ignore' })}
              style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Ignore</button>
            <button onClick={() => backend?.sendCommand('ResolveTolerance', undefined, { choice: 'update' })}
              style={{ ...btnBase, background: 'var(--accent)', color: '#000' }}>Update Freefall</button>
          </div>
        </ModalOverlay>
      )}

      {/* Resume: the scale no longer matches the saved progress */}
      {mismatchAsk && (
        <ModalOverlay onClose={() => setMismatchAsk(null)}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--fg-bright)' }}>The scale does not match the saved progress</div>
          <div style={{ fontSize: '12px', color: 'var(--fg)', marginBottom: '14px' }}>
            While dosing {mismatchAsk.ingredientName} the mixer should read {mismatchAsk.saved} lbs, but it reads {mismatchAsk.current} lbs.
            Re-baseline carries on from the current reading (no freefall calibration from this step), or close this and Abort the paused batch.
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setMismatchAsk(null)}
              style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Close</button>
            <button onClick={() => handleResume(true)}
              style={{ ...btnBase, background: 'var(--accent)', color: '#000' }}>Re-baseline and Resume</button>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}

function BatchRow({ entry: q, finished, expanded, onToggle, onEdit, onDelete, onMove, ingredients }: {
  entry: QueueEntry; finished?: boolean; expanded: boolean; onToggle: () => void; onEdit?: () => void; onDelete?: () => void; onMove?: (dir: 'up' | 'down') => void; ingredients: { id: string; name: string }[];
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
            <span style={{ color: stateColor[q.state] ?? 'var(--fg)' }}>{stateLabel(q.state)}{q.microUnloading ? ' · unloading micros' : ''}</span>
            {q.state === 'IDLE' && q.scheduledAt && <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>starts {new Date(q.scheduledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
            {q.late && <span style={{ color: 'var(--orange)', fontSize: '11px' }}>late</span>}
          </span>
        </td>
        <td className="py-2 px-3 text-right">{finished ? dateTime(q.completedAt) : q.progress != null ? `${q.progress.toFixed(1)}%` : '—'}</td>
      </tr>
      {expanded && (
        <tr style={{ background: 'var(--bg-row)' }}>
          <td colSpan={6} className="px-6 py-2">
            {q.warnings && q.warnings.length > 0 && (
              <ul style={{ color: 'var(--orange)', fontSize: '11px', margin: '0 0 6px 16px', listStyle: 'disc' }}>
                {q.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            {onEdit && (
              <div className="flex justify-end gap-2 mb-2">
                {([['Up', () => onMove?.('up')], ['Down', () => onMove?.('down')], ['Edit', onEdit], ['Delete', onDelete]] as const).map(([label, fn]) => fn && (
                  <button key={label} onClick={(e) => { e.stopPropagation(); fn(); }}
                    style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-dim)', cursor: 'pointer', padding: '2px 8px', fontSize: '11px' }}>
                    {label}
                  </button>
                ))}
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
  onSubmit: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [recipeId, setRecipeId] = useState(initial?.recipeId || recipes[0]?.id || '');
  const [dest, setDest] = useState(initial?.destination || finishedBins[0]?.id || '');
  const [size, setSize] = useState(initial ? String(initial.targetMass) : '');
  // datetime-local wants local "YYYY-MM-DDTHH:mm"; empty = start as soon as the queue gets to it
  const toLocal = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const [when, setWhen] = useState(toLocal(initial?.scheduledAt));

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
        <div className="flex flex-col gap-1">
          <span style={{ color: 'var(--fg-dim)' }}>Batch size (lbs, blank = recipe size)</span>
          <input type="number" min={0} value={size} onChange={e => setSize(e.target.value)} style={inputStyle} />
        </div>
        <div className="flex flex-col gap-1">
          <span style={{ color: 'var(--fg-dim)' }}>Start at (blank = as soon as the queue reaches it)</span>
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={inputStyle} />
        </div>
      </div>
      <div className="flex gap-2 justify-end mt-4">
        <button onClick={onClose}
          style={{ ...btnBase, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)' }}>Cancel</button>
        <button onClick={() => {
          const scheduledAt = when ? new Date(when).toISOString() : (initial ? null : undefined); // null clears a schedule on edit
          const mass = size.trim() === '' ? undefined : Number(size);
          if (!initial) return onSubmit({ recipeId, destination: dest, targetMass: mass, scheduledAt });
          // an edit sends only what changed: a recipe or size change re-scales the batch, nothing else does
          onSubmit({ ...(recipeId !== initial.recipeId ? { recipeId } : {}), destination: dest,
            ...(mass !== undefined && mass !== initial.targetMass ? { targetMass: mass } : {}), scheduledAt });
        }}
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
