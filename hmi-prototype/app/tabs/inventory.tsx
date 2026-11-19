'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { useBackend } from '../backend';
import { type Bin, type Ingredient, type InventoryEvent } from '../sim-data';
import * as XLSX from 'xlsx';

type TopTab = 'BINS' | 'INGREDIENTS';
type Timeframe = '24h' | '7d' | '30d' | '90d' | 'all';
type Change = { binId: string; field: string; from: string; to: string };

function ingName(id: string | null, ingredients: Ingredient[]) {
  if (!id) return '— None —';
  return ingredients.find(i => i.id === id)?.name ?? id;
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
  borderRadius: '3px', padding: '2px 4px', fontSize: '12px', cursor: 'pointer',
};

const btnStyle: React.CSSProperties = {
  padding: '4px 10px', fontSize: '11px', fontWeight: 500, borderRadius: '3px',
  border: '1px solid var(--border)', cursor: 'pointer',
};

const TF_MS: Record<Timeframe, number> = { '24h': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000, 'all': Infinity };

export function InventoryTab() {
  const backend = useBackend();
  const [topTab, setTopTab] = useState<TopTab>('BINS');
  const bins: Bin[] = backend?.connected
    ? backend.bins.map(b => ({ ...b, tracked: b.tracked ?? true }))
    : [];
  const ingredients: Ingredient[] = backend?.connected ? backend.ingredients : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1">
        {(['BINS', 'INGREDIENTS'] as const).map(t => (
          <button key={t} onClick={() => setTopTab(t)} className="px-3 py-2 text-xs font-medium"
            style={{ background: topTab === t ? 'var(--bg-row)' : 'transparent', color: topTab === t ? 'var(--fg-bright)' : 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px' }}>
            {t === 'BINS' ? 'Bins' : 'Ingredients'}
          </button>
        ))}
      </div>
      {topTab === 'BINS'
        ? <BinsTab bins={bins} ingredients={ingredients} />
        : <IngredientsTab ingredients={ingredients} />
      }
    </div>
  );
}

// ─── Note input that holds local state while focused ───

function NoteInput({ binId, serverNote, onSave }: { binId: string; serverNote: string; onSave: (binId: string, note: string) => void }) {
  const [local, setLocal] = useState(serverNote);
  const [focused, setFocused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!focused) setLocal(serverNote);
  }, [serverNote, focused]);

  function handleChange(val: string) {
    setLocal(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSave(binId, val), 500);
  }

  function handleBlur() {
    setFocused(false);
    clearTimeout(timerRef.current);
    if (local !== serverNote) onSave(binId, local);
  }

  return (
    <input value={local} onChange={e => handleChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={handleBlur}
      placeholder="—" style={{ background: 'transparent', border: 'none', color: 'var(--fg)', fontSize: '12px', width: '100%', outline: 'none', padding: 0 }} />
  );
}

// ─── BINS TAB ───

function BinsTab({ bins, ingredients }: { bins: Bin[]; ingredients: Ingredient[] }) {
  const backend = useBackend();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Bin[]>([]);
  const [pendingChanges, setPendingChanges] = useState<Change[] | null>(null);
  const [adjustBinId, setAdjustBinId] = useState<string | null>(null);
  const [adjustAmt, setAdjustAmt] = useState('');

  const src = editing ? draft : bins;
  const majorBins = src.filter(b => b.type === 'ingredient');
  const microBins = src.filter(b => b.type === 'micro_hopper');
  const finishedBins = bins.filter(b => b.type === 'finished');
  const allEditableBins = bins.filter(b => b.type !== 'finished');

  function startEdit() { setDraft(bins.map(b => ({ ...b }))); setEditing(true); setAdjustBinId(null); }
  function cancelEdit() { setEditing(false); setDraft([]); setPendingChanges(null); }

  function trySave() {
    const changes: Change[] = [];
    for (const d of draft) {
      const orig = bins.find(b => b.id === d.id);
      if (!orig) continue;
      if (d.ingredientId !== orig.ingredientId)
        changes.push({ binId: d.id, field: 'Ingredient', from: ingName(orig.ingredientId, ingredients), to: ingName(d.ingredientId, ingredients) });
      if ((d.tracked ?? true) !== (orig.tracked ?? true))
        changes.push({ binId: d.id, field: 'Tracking', from: orig.tracked === false ? 'Off' : 'On', to: d.tracked === false ? 'Off' : 'On' });
    }
    if (changes.length === 0) { cancelEdit(); return; }
    setPendingChanges(changes);
  }

  function confirmSave() {
    for (const d of draft) {
      const orig = bins.find(b => b.id === d.id);
      if (!orig) continue;
      const upd: Record<string, unknown> = {};
      if (d.ingredientId !== orig.ingredientId) upd.ingredientId = d.ingredientId;
      if ((d.tracked ?? true) !== (orig.tracked ?? true)) upd.tracked = d.tracked;
      if (Object.keys(upd).length > 0) backend?.sendCommand('UpdateBin', d.id, upd);
    }
    setEditing(false); setDraft([]); setPendingChanges(null);
  }
  function updateDraft(binId: string, upd: Partial<Bin>) { setDraft(prev => prev.map(b => b.id === binId ? { ...b, ...upd } : b)); }

  function applyAdjust() {
    const amt = parseFloat(adjustAmt);
    if (!adjustBinId || isNaN(amt)) return;
    const bin = bins.find(b => b.id === adjustBinId);
    const newBalance = Math.max(0, (bin?.balance ?? 0) + amt);
    backend?.sendCommand('UpdateBin', adjustBinId, { balance: newBalance });
    setAdjustAmt(''); setAdjustBinId(null);
  }

  function sendNote(binId: string, note: string) {
    backend?.sendCommand('UpdateBin', binId, { note });
  }

  function availableIngredientsFor(b: Bin) {
    return b.type === 'micro_hopper'
      ? ingredients.filter(i => i.category === 'MICRO' && !i.hidden)
      : ingredients.filter(i => i.category === 'MAIN' && !i.hidden);
  }

  function renderBinTable(binList: Bin[], label: string) {
    return (
      <Panel>
        <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.03em' }}>
          {label}
        </div>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
              {editing && <th className="text-center py-2 px-2" style={{ width: '40px' }}>Track</th>}
              <th className="text-left py-2 pl-3 pr-4" style={{ width: '96px' }}>Bin</th>
              <th className="text-left py-2 pl-5 pr-6" style={{ width: '200px' }}>Ingredient</th>
              <th className="text-left py-2 pl-5 pr-3">Note</th>
              <th className="text-right py-2 px-3">Balance</th>
              <th className="text-left py-2 px-3 w-48">Level</th>
            </tr>
          </thead>
          <tbody>
            {binList.map(b => {
              const tracked = b.tracked !== false;
              const hasSwitch = b.levelSwitchState != null;
              const pct = b.capacity > 0 ? (b.balance / b.capacity) * 100 : 0;
              const barColor = pct < 15 ? 'var(--red)' : pct < 30 ? 'var(--orange)' : 'var(--green)';
              const canAssign = b.balance < 100;
              const avail = availableIngredientsFor(b);
              return (
                <tr key={b.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  {editing && (
                    <td className="text-center py-2 px-2">
                      <input type="checkbox" checked={tracked}
                        onChange={e => updateDraft(b.id, { tracked: e.target.checked })}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                    </td>
                  )}
                  <td className="py-2 pl-3 pr-4 font-medium" style={{ color: 'var(--fg-bright)' }}>{b.id}</td>
                  <td className="py-2 pl-5 pr-6">
                    {editing && canAssign ? (
                      <select value={b.ingredientId ?? ''} onChange={e => updateDraft(b.id, { ingredientId: e.target.value || null })} style={selectStyle}>
                        <option value="">— None —</option>
                        {avail.map(ing => <option key={ing.id} value={ing.id}>{ing.name}</option>)}
                      </select>
                    ) : (
                      <span title={!editing && !canAssign ? 'Balance must be < 100 lbs to change' : undefined} style={{ color: !tracked ? 'var(--fg-dim)' : undefined }}>
                        {ingName(b.ingredientId, ingredients)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pl-5 pr-3">
                    <NoteInput binId={b.id} serverNote={b.note ?? ''} onSave={sendNote} />
                  </td>
                  <td className="text-right py-2 px-3" style={{ color: 'var(--fg-bright)' }}>{b.balance.toLocaleString()} {b.unit}</td>
                  <td className="py-2 px-3">
                    <LevelCell tracked={tracked} hasSwitch={hasSwitch} switchState={b.levelSwitchState} pct={pct} barColor={barColor} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div style={{ flex: 1 }} />
        {!editing ? (
          <>
            <button onClick={startEdit} style={{ ...btnStyle, background: 'var(--bg-row)', color: 'var(--fg-bright)' }}>Edit Bins</button>
            <button onClick={() => { setAdjustBinId(allEditableBins[0]?.id ?? null); setAdjustAmt(''); }} style={{ ...btnStyle, background: 'var(--bg-row)', color: 'var(--fg-bright)' }}>Adjust Inventory</button>
          </>
        ) : (
          <>
            <button onClick={cancelEdit} style={{ ...btnStyle, background: 'transparent', color: 'var(--fg-dim)' }}>Cancel</button>
            <button onClick={trySave} style={{ ...btnStyle, background: 'var(--green)', color: '#000' }}>Save</button>
          </>
        )}
      </div>

      {!editing && adjustBinId !== null && (
        <Panel>
          <div className="px-3 py-2.5 flex items-center gap-3" style={{ fontSize: '12px' }}>
            <span style={{ color: 'var(--fg-dim)', fontWeight: 500 }}>Adjust:</span>
            <select value={adjustBinId} onChange={e => setAdjustBinId(e.target.value)} style={selectStyle}>
              {allEditableBins.map(b => <option key={b.id} value={b.id}>{b.id} — {ingName(b.ingredientId, ingredients)}</option>)}
            </select>
            <input type="number" value={adjustAmt} onChange={e => setAdjustAmt(e.target.value)} placeholder="+/- lbs"
              style={{ ...selectStyle, width: '100px', cursor: 'text' }} />
            <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>lbs</span>
            <button onClick={applyAdjust} disabled={!adjustAmt || isNaN(parseFloat(adjustAmt))}
              style={{ ...btnStyle, background: 'var(--accent)', color: '#000', opacity: (!adjustAmt || isNaN(parseFloat(adjustAmt))) ? 0.4 : 1 }}>Apply</button>
            <button onClick={() => setAdjustBinId(null)} style={{ ...btnStyle, background: 'transparent', color: 'var(--fg-dim)' }}>Close</button>
          </div>
        </Panel>
      )}

      {renderBinTable(majorBins, 'MAJOR BINS')}
      {renderBinTable(microBins, 'MICRO BINS')}

      <Panel>
        <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.03em' }}>
          FINISHED BINS
        </div>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
              <th className="text-left py-2 pl-3 pr-4" style={{ width: '96px' }}>Bin</th>
              <th style={{ width: '200px' }}></th>
              <th className="text-left py-2 pl-5 pr-3">Note</th>
              <th className="text-right py-2 px-3">Balance</th>
              <th className="text-left py-2 px-3 w-48">Level</th>
            </tr>
          </thead>
          <tbody>
            {finishedBins.map(b => {
              const pct = b.capacity > 0 ? (b.balance / b.capacity) * 100 : 0;
              return (
                <tr key={b.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td className="py-2 pl-3 pr-4 font-medium" style={{ color: 'var(--fg-bright)' }}>{b.id}</td>
                  <td></td>
                  <td className="py-2 pl-5 pr-3">
                    <NoteInput binId={b.id} serverNote={b.note ?? ''} onSave={sendNote} />
                  </td>
                  <td className="text-right py-2 px-3" style={{ color: b.balance > 0 ? 'var(--fg-bright)' : 'var(--fg-dim)' }}>
                    {b.balance > 0 ? `${b.balance.toLocaleString()} ${b.unit}` : 'Empty'}
                  </td>
                  <td className="py-2 px-3 w-48">
                    <LevelCell tracked hasSwitch={b.levelSwitchState != null} switchState={b.levelSwitchState} pct={pct} barColor={pct > 90 ? 'var(--orange)' : 'var(--green)'} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {pendingChanges && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '4px', padding: '16px', minWidth: '320px', maxWidth: '480px' }}>
            <div style={{ color: 'var(--fg-bright)', fontWeight: 600, fontSize: '13px', marginBottom: '12px' }}>Confirm Changes</div>
            <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)' }}>
                  <th className="text-left py-1 px-2">Bin</th>
                  <th className="text-left py-1 px-2">Field</th>
                  <th className="text-left py-1 px-2">From</th>
                  <th className="text-left py-1 px-2">To</th>
                </tr>
              </thead>
              <tbody>
                {pendingChanges.map((c, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="py-1 px-2 font-medium" style={{ color: 'var(--fg-bright)' }}>{c.binId}</td>
                    <td className="py-1 px-2" style={{ color: 'var(--fg-dim)' }}>{c.field}</td>
                    <td className="py-1 px-2">{c.from}</td>
                    <td className="py-1 px-2" style={{ color: 'var(--fg-bright)' }}>{c.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end gap-2" style={{ marginTop: '12px' }}>
              <button onClick={() => setPendingChanges(null)} style={{ ...btnStyle, background: 'transparent', color: 'var(--fg-dim)' }}>Cancel</button>
              <button onClick={confirmSave} style={{ ...btnStyle, background: 'var(--green)', color: '#000' }}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── INGREDIENTS TAB ───

function IngredientsTab({ ingredients }: { ingredients: Ingredient[] }) {
  const backend = useBackend();
  const [timeframe, setTimeframe] = useState<Timeframe>('7d');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [newIngName, setNewIngName] = useState('');
  const [newIngCategory, setNewIngCategory] = useState<'MAIN' | 'MICRO'>('MAIN');
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; step: number } | null>(null);
  const [hideConfirm, setHideConfirm] = useState<string | null>(null);

  // Inventory events are not yet streamed from the backend
  const events: InventoryEvent[] = [];

  const cutoff = TF_MS[timeframe] === Infinity ? 0 : Date.now() - TF_MS[timeframe];
  const filteredEvents = useMemo(() =>
    events.filter(e => new Date(e.date).getTime() >= cutoff).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [events, cutoff]
  );

  const visibleIngredients = ingredients.filter(i => !i.hidden);
  const hiddenIngredients = ingredients.filter(i => i.hidden);

  const usageByIngredient = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of filteredEvents) {
      if (e.change < 0) m[e.ingredientId] = (m[e.ingredientId] ?? 0) + Math.abs(e.change);
    }
    return m;
  }, [filteredEvents]);

  const selectedEvents = useMemo(() =>
    selectedId ? filteredEvents.filter(e => e.ingredientId === selectedId) : [],
    [selectedId, filteredEvents]
  );

  function hasRecords(id: string) { return events.some(e => e.ingredientId === id); }

  function doDelete(id: string) {
    backend?.sendCommand('RemoveIngredient', id);
    setDeleteConfirm(null);
    if (selectedId === id) setSelectedId(null);
  }

  function doHide(id: string) {
    backend?.sendCommand('UpdateIngredient', id, { hidden: true });
    setHideConfirm(null);
    if (selectedId === id) setSelectedId(null);
  }

  function doUnhide(id: string) {
    backend?.sendCommand('UpdateIngredient', id, { hidden: false });
  }

  function doRename(id: string) {
    if (!renameName.trim()) return;
    backend?.sendCommand('UpdateIngredient', id, { name: renameName.trim() });
    setRenameId(null); setRenameName('');
  }

  function doCreate() {
    if (!newIngName.trim()) return;
    backend?.sendCommand('AddIngredient', undefined, { name: newIngName.trim(), category: newIngCategory, unit: 'lbs' });
    setNewIngName('');
  }

  return (
    <>
      {/* Top bar: timeframe + report + edit */}
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {(['24h', '7d', '30d', '90d', 'all'] as const).map(tf => (
            <button key={tf} onClick={() => setTimeframe(tf)} className="px-2 py-1.5 text-xs"
              style={{ background: timeframe === tf ? 'var(--bg-row)' : 'transparent', color: timeframe === tf ? 'var(--fg-bright)' : 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px' }}>
              {tf}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowReport(true)} style={{ ...btnStyle, background: 'var(--bg-row)', color: 'var(--fg-bright)' }}>Generate Report</button>
        <button onClick={() => setEditMode(!editMode)} style={{ ...btnStyle, background: editMode ? 'var(--accent)' : 'var(--bg-row)', color: editMode ? '#000' : 'var(--fg-bright)' }}>
          {editMode ? 'Done' : 'Edit'}
        </button>
      </div>

      <div className="flex gap-3" style={{ minHeight: '400px' }}>
        {/* Left column: ingredient list */}
        <div style={{ width: '280px', flexShrink: 0 }}>
          <Panel>
            <div style={{ maxHeight: '500px', overflow: 'auto' }}>
              {visibleIngredients.map(ing => (
                <div key={ing.id} onClick={() => { if (!editMode) setSelectedId(ing.id); }}
                  className="px-3 py-2 flex items-center justify-between"
                  style={{ borderBottom: '1px solid var(--border)', cursor: editMode ? 'default' : 'pointer',
                    background: selectedId === ing.id ? 'var(--bg-row)' : 'transparent' }}>
                  {renameId === ing.id ? (
                    <div className="flex items-center gap-1 flex-1">
                      <input value={renameName} onChange={e => setRenameName(e.target.value)} autoFocus
                        onKeyDown={e => { if (e.key === 'Enter') doRename(ing.id); if (e.key === 'Escape') setRenameId(null); }}
                        style={{ ...selectStyle, flex: 1 }} />
                      <button onClick={() => doRename(ing.id)} style={{ ...btnStyle, padding: '2px 6px', background: 'var(--green)', color: '#000' }}>OK</button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <div style={{ fontSize: '12px', color: 'var(--fg-bright)' }}>{ing.name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>{(usageByIngredient[ing.id] ?? 0).toFixed(1)} lbs used</div>
                      </div>
                      {editMode && (
                        <div className="flex gap-1">
                          <button onClick={() => { setRenameId(ing.id); setRenameName(ing.name); }} style={{ ...btnStyle, padding: '1px 5px', fontSize: '11px' }}>Ren</button>
                          <button onClick={() => setHideConfirm(ing.id)} style={{ ...btnStyle, padding: '1px 5px', fontSize: '11px' }}>Hide</button>
                          <button onClick={() => setDeleteConfirm({ id: ing.id, step: hasRecords(ing.id) ? 1 : 0 })}
                            style={{ ...btnStyle, padding: '1px 5px', fontSize: '11px', color: 'var(--red)' }}>Del</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {editMode && (
                <div className="px-3 py-2 flex items-center gap-1" style={{ borderBottom: '1px solid var(--border)' }}>
                  <input value={newIngName} onChange={e => setNewIngName(e.target.value)} placeholder="New ingredient"
                    onKeyDown={e => { if (e.key === 'Enter') doCreate(); }}
                    style={{ ...selectStyle, flex: 1 }} />
                  <select value={newIngCategory} onChange={e => setNewIngCategory(e.target.value as 'MAIN' | 'MICRO')} style={{ ...selectStyle, width: '60px' }}>
                    <option value="MAIN">Main</option>
                    <option value="MICRO">Micro</option>
                  </select>
                  <button onClick={doCreate} disabled={!newIngName.trim()}
                    style={{ ...btnStyle, padding: '2px 6px', background: 'var(--green)', color: '#000', opacity: newIngName.trim() ? 1 : 0.4 }}>+</button>
                </div>
              )}
              {/* Hidden ingredients section */}
              {hiddenIngredients.length > 0 && (
                <>
                  <div onClick={() => setShowHidden(!showHidden)} className="px-3 py-1.5 cursor-pointer"
                    style={{ fontSize: '11px', color: 'var(--fg-dim)', background: 'var(--bg)' }}>
                    {showHidden ? '▾' : '▸'} Hidden ({hiddenIngredients.length})
                  </div>
                  {showHidden && hiddenIngredients.map(ing => (
                    <div key={ing.id} className="px-3 py-2 flex items-center justify-between"
                      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)', opacity: 0.6 }}>
                      <span style={{ fontSize: '12px', color: 'var(--fg-dim)' }}>{ing.name}</span>
                      {editMode && (
                        <button onClick={() => doUnhide(ing.id)} style={{ ...btnStyle, padding: '1px 5px', fontSize: '11px' }}>Unhide</button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          </Panel>
        </div>

        {/* Right panel: event log */}
        <div style={{ flex: 1 }}>
          {selectedId ? (
            <Panel>
              <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 600 }}>
                {ingName(selectedId, ingredients)} — Inventory Log
              </div>
              <div style={{ maxHeight: '450px', overflow: 'auto' }}>
                {selectedEvents.length === 0 && (
                  <div className="px-3 py-4 text-center" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>No events in this period</div>
                )}
                {selectedEvents.map(ev => (
                  <div key={ev.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <div onClick={() => setExpandedEvent(expandedEvent === ev.id ? null : ev.id)}
                      className="px-3 py-2 flex items-center gap-3 cursor-pointer"
                      style={{ background: expandedEvent === ev.id ? 'var(--bg-row)' : 'transparent' }}>
                      <span style={{ fontSize: '11px', color: 'var(--fg-dim)', width: '130px', flexShrink: 0 }}>
                        {new Date(ev.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span style={{ fontSize: '12px', color: 'var(--fg-bright)', width: '80px' }}>
                        {ev.type === 'batch' ? `Batch ${ev.batchId}` : `Adj ${ev.adjustmentId}`}
                      </span>
                      <span style={{ fontSize: '12px', fontWeight: 500, color: ev.change > 0 ? 'var(--green)' : 'var(--fg-bright)', flex: 1, textAlign: 'right' }}>
                        {ev.change > 0 ? '+' : ''}{ev.change.toFixed(1)} lbs
                      </span>
                      <span style={{ fontSize: '11px', color: ev.notes === 'Failed' ? 'var(--red)' : 'var(--fg-dim)', width: '80px', textAlign: 'right' }}>
                        {ev.notes}
                      </span>
                    </div>
                    {expandedEvent === ev.id && (
                      <div className="px-6 py-2" style={{ background: 'var(--bg-row)', fontSize: '11px' }}>
                        <div className="flex gap-6">
                          <div><span style={{ color: 'var(--fg-dim)' }}>Type:</span> <span style={{ color: 'var(--fg-bright)' }}>{ev.type === 'batch' ? 'Batch Consumption' : 'Manual Adjustment'}</span></div>
                          {ev.binId && <div><span style={{ color: 'var(--fg-dim)' }}>Bin:</span> <span style={{ color: 'var(--fg-bright)' }}>{ev.binId}</span></div>}
                          <div><span style={{ color: 'var(--fg-dim)' }}>Date:</span> <span style={{ color: 'var(--fg-bright)' }}>{new Date(ev.date).toLocaleString()}</span></div>
                        </div>
                        {ev.notes && <div style={{ marginTop: '4px' }}><span style={{ color: 'var(--fg-dim)' }}>Notes:</span> <span style={{ color: 'var(--fg-bright)' }}>{ev.notes}</span></div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <Panel>
              <div className="px-3 py-8 text-center" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>Select an ingredient to view inventory log</div>
            </Panel>
          )}
        </div>
      </div>

      {/* Report popup */}
      {showReport && <ReportPopup ingredients={visibleIngredients} events={filteredEvents} timeframe={timeframe} onClose={() => setShowReport(false)} />}

      {/* Delete confirmation overlay */}
      {deleteConfirm && (
        <Overlay>
          <div style={{ color: 'var(--fg-bright)', fontWeight: 600, fontSize: '13px', marginBottom: '8px' }}>
            Delete {ingName(deleteConfirm.id, ingredients)}?
          </div>
          {deleteConfirm.step === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--fg-dim)', marginBottom: '12px' }}>No inventory records exist. Delete this ingredient?</div>
          ) : deleteConfirm.step === 1 ? (
            <div style={{ fontSize: '12px', color: 'var(--orange)', marginBottom: '12px' }}>
              This ingredient has inventory records. Deleting will remove all history. Are you sure?
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--red)', marginBottom: '12px' }}>
              FINAL CONFIRMATION: This action cannot be undone. All records for this ingredient will be permanently deleted.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setDeleteConfirm(null)} style={{ ...btnStyle, background: 'transparent', color: 'var(--fg-dim)' }}>Cancel</button>
            {deleteConfirm.step < 2 && hasRecords(deleteConfirm.id) ? (
              <button onClick={() => setDeleteConfirm({ ...deleteConfirm, step: deleteConfirm.step + 1 })}
                style={{ ...btnStyle, background: 'var(--red)', color: '#fff' }}>Continue</button>
            ) : (
              <button onClick={() => doDelete(deleteConfirm.id)} style={{ ...btnStyle, background: 'var(--red)', color: '#fff' }}>Delete</button>
            )}
          </div>
        </Overlay>
      )}

      {/* Hide confirmation overlay */}
      {hideConfirm && (
        <Overlay>
          <div style={{ color: 'var(--fg-bright)', fontWeight: 600, fontSize: '13px', marginBottom: '8px' }}>
            Hide {ingName(hideConfirm, ingredients)}?
          </div>
          <div style={{ fontSize: '12px', color: 'var(--fg-dim)', marginBottom: '12px' }}>
            Hidden ingredients are excluded from reports and recipes. Inventory data is preserved. You can unhide later.
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setHideConfirm(null)} style={{ ...btnStyle, background: 'transparent', color: 'var(--fg-dim)' }}>Cancel</button>
            <button onClick={() => doHide(hideConfirm)} style={{ ...btnStyle, background: 'var(--orange)', color: '#000' }}>Hide</button>
          </div>
        </Overlay>
      )}
    </>
  );
}

// ─── REPORT POPUP ───

function ReportPopup({ ingredients, events, timeframe, onClose }: {
  ingredients: Ingredient[]; events: InventoryEvent[]; timeframe: Timeframe; onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ingredients.map(i => i.id)));
  const allSelected = selected.size === ingredients.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(ingredients.map(i => i.id)));
  }

  function generate() {
    const selIngs = ingredients.filter(i => selected.has(i.id));
    const ingEvents: Record<string, InventoryEvent[]> = {};
    for (const ing of selIngs) ingEvents[ing.id] = [];
    for (const e of events) {
      if (ingEvents[e.ingredientId]) ingEvents[e.ingredientId].push(e);
    }

    const allDates = new Set<string>();
    const rowMap: Record<string, Record<string, { ref: string; change: number; notes: string }>> = {};
    for (const [ingId, evts] of Object.entries(ingEvents)) {
      for (const e of evts) {
        const key = e.type === 'batch' ? e.batchId! : e.adjustmentId!;
        if (!rowMap[key]) rowMap[key] = {};
        rowMap[key][ingId] = { ref: key, change: e.change, notes: e.notes };
        allDates.add(`${e.date}|${key}`);
      }
    }

    const sorted = Array.from(allDates).sort((a, b) => new Date(b.split('|')[0]).getTime() - new Date(a.split('|')[0]).getTime());

    const usageRow: Record<string, string | number> = { Date: 'TOTAL USAGE', 'Batch/Adj #': '', Notes: '' };
    for (const ing of selIngs) {
      const total = events.filter(e => e.ingredientId === ing.id && e.change < 0).reduce((s, e) => s + Math.abs(e.change), 0);
      usageRow[ing.name] = total > 0 ? parseFloat(total.toFixed(1)) : '';
    }

    const rows: Record<string, string | number>[] = [usageRow];
    for (const entry of sorted) {
      const [date, key] = entry.split('|');
      const row: Record<string, string | number> = {
        Date: new Date(date).toLocaleString(),
        'Batch/Adj #': key,
        Notes: '',
      };
      let hasData = false;
      for (const ing of selIngs) {
        const cell = rowMap[key]?.[ing.id];
        if (cell) {
          row[ing.name] = parseFloat(cell.change.toFixed(1));
          if (!row.Notes) row.Notes = cell.notes;
          hasData = true;
        } else {
          row[ing.name] = '';
        }
      }
      if (hasData) rows.push(row);
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Inventory ${timeframe}`);
    XLSX.writeFile(wb, `inventory_report_${timeframe}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    onClose();
  }

  return (
    <Overlay>
      <div style={{ color: 'var(--fg-bright)', fontWeight: 600, fontSize: '13px', marginBottom: '12px' }}>
        Generate Inventory Report ({timeframe})
      </div>
      <div className="flex items-center gap-2 mb-2">
        <button onClick={toggleAll} style={{ ...btnStyle, fontSize: '11px', padding: '2px 6px' }}>
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
      </div>
      <div style={{ maxHeight: '300px', overflow: 'auto', marginBottom: '12px' }}>
        {ingredients.map(ing => (
          <label key={ing.id} className="flex items-center gap-2 px-2 py-1 cursor-pointer" style={{ fontSize: '12px' }}>
            <input type="checkbox" checked={selected.has(ing.id)}
              onChange={() => {
                const next = new Set(selected);
                next.has(ing.id) ? next.delete(ing.id) : next.add(ing.id);
                setSelected(next);
              }}
              style={{ accentColor: 'var(--accent)' }} />
            {ing.name}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} style={{ ...btnStyle, background: 'transparent', color: 'var(--fg-dim)' }}>Cancel</button>
        <button onClick={generate} disabled={selected.size === 0}
          style={{ ...btnStyle, background: 'var(--accent)', color: '#000', opacity: selected.size === 0 ? 0.4 : 1 }}>Download XLSX</button>
      </div>
    </Overlay>
  );
}

// ─── SHARED COMPONENTS ───

function LevelCell({ tracked, hasSwitch, switchState, pct, barColor }: {
  tracked: boolean; hasSwitch: boolean; switchState?: 'empty' | 'full' | 'normal' | 'fault'; pct: number; barColor: string;
}) {
  const color = switchState === 'full' ? 'var(--red)' : switchState === 'empty' || switchState === 'fault' ? 'var(--orange)' : 'var(--fg-dim)';
  const label = switchState === 'full' ? 'FULL' : switchState === 'empty' ? 'EMPTY' : switchState === 'fault' ? 'SENSOR' : '';
  if (tracked) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2.5 rounded-sm" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <div className="h-full rounded-sm" style={{ width: `${pct}%`, background: barColor }} />
        </div>
        <span style={{ fontSize: '11px', color: 'var(--fg-dim)', width: '28px', textAlign: 'right' }}>{pct.toFixed(0)}%</span>
        {hasSwitch && label && <span style={{ fontSize: '11px', color, fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>}
      </div>
    );
  }
  if (hasSwitch) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2.5 rounded-sm" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <div className="h-full rounded-sm" style={{ width: '100%', background: color, opacity: switchState === 'normal' ? 0.15 : 1 }} />
        </div>
        {label && <span style={{ fontSize: '11px', color, fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>}
      </div>
    );
  }
  return <span style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>Usage only</span>;
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
      {children}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '4px', padding: '16px', minWidth: '320px', maxWidth: '480px' }}>
        {children}
      </div>
    </div>
  );
}
