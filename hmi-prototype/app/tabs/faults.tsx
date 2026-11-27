'use client';

import { useState } from 'react';
import type { Fault } from '../sim-data';
import { useBackend } from '../backend';
import { ALL_DATES, DateRangeInputs, Pager, dateTime, useHistory, type DateRange } from './history';

const sevColor: Record<string, string> = {
  CRITICAL: 'var(--red)',
  WARNING: 'var(--orange)',
  INFO: 'var(--fg-dim)',
};

// one fault (code + equipment) and how often it happened in the chosen dates
interface FaultGroup { code: string; equipment: string; severity: string; message: string; count: number; lastAt: string }
interface Occurrence { id: string; raisedAt: string; clearedAt: string | null; message: string }

export function FaultsTab() {
  const [view, setView] = useState<'active' | 'history'>('active');
  const [range, setRange] = useState(ALL_DATES);
  const backend = useBackend();

  const faults: Fault[] = backend?.connected ? backend.faults : []; // the live feed carries active faults only
  const activeCount = faults.length;

  function clearFault(id: string) {
    if (backend?.connected) {
      backend.sendCommand('ClearFault', id);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {(['active', 'history'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className="px-3 py-2 text-xs font-medium uppercase"
              style={{
                background: view === v ? 'var(--bg-row)' : 'transparent',
                color: view === v ? 'var(--fg-bright)' : 'var(--fg-dim)',
                border: '1px solid var(--border)',
                borderRadius: '3px',
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>
          {activeCount} active
        </span>
        {view === 'history' && <DateRangeInputs range={range} onChange={setRange} />}
        {backend?.connected && activeCount > 0 && (
          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => backend.sendCommand('SilenceHorn')}
              className="px-3 py-1.5 text-xs font-semibold"
              style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}
            >
              {backend.horn.silenced ? 'Re-arm Horn' : 'Silence Horn'}
            </button>
            <button
              onClick={() => backend.sendCommand('ResetFaults')}
              className="px-3 py-1.5 text-xs font-semibold"
              style={{ background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
            >
              Reset All Faults
            </button>
          </div>
        )}
      </div>

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        {view === 'history' ? (
          <FaultHistory range={range} refreshKey={`${backend?.connected} ${faults.map(f => f.id).join()}`} />
        ) : (
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
                <th className="text-left py-2 px-3 w-8"></th>
                <th className="text-left py-2 px-3">Equipment</th>
                <th className="text-left py-2 px-3">Message</th>
                <th className="text-left py-2 px-3">Raised</th>
                <th className="text-left py-2 px-3 w-28"></th>
              </tr>
            </thead>
            <tbody>
              {faults.map(f => (
                <tr key={f.id} style={{ borderBottom: '1px solid var(--border)', background: 'rgba(229,57,53,0.04)' }}>
                  <td className="py-2 px-3">
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: sevColor[f.severity] }} />
                  </td>
                  <td className="py-2 px-3 font-medium" style={{ color: 'var(--fg-bright)' }}>{f.equipment}</td>
                  <td className="py-2 px-3">{f.message}</td>
                  <td className="py-2 px-3" style={{ color: 'var(--fg-dim)' }}>{dateTime(f.raisedAt)}</td>
                  <td className="py-2 px-3 flex gap-1">
                    <button
                      onClick={() => clearFault(f.id)}
                      className="px-3 py-1 text-xs font-medium"
                      style={{ background: 'var(--green)', color: '#000', borderRadius: '3px', border: 'none', cursor: 'pointer' }}
                    >
                      CLEAR
                    </button>
                  </td>
                </tr>
              ))}
              {faults.length === 0 && (
                <tr><td colSpan={5} className="py-3 text-center" style={{ color: 'var(--fg-dim)' }}>No faults</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function FaultHistory({ range, refreshKey }: { range: DateRange; refreshKey: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const history = useHistory<FaultGroup>('faults', range, refreshKey);

  return (
    <>
      <table className="w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
            <th className="text-left py-2 px-3 w-8"></th>
            <th className="text-left py-2 px-3">Equipment</th>
            <th className="text-left py-2 px-3">Latest message</th>
            <th className="text-right py-2 px-3">Times</th>
            <th className="text-left py-2 px-3">Last raised</th>
          </tr>
        </thead>
        <tbody>
          {history.rows.map(g => {
            const key = `${g.code} ${g.equipment}`;
            return [
              <tr key={key} onClick={() => setOpen(open === key ? null : key)} className="cursor-pointer"
                style={{ borderBottom: '1px solid var(--border)', background: open === key ? 'var(--bg-row)' : 'transparent' }}>
                <td className="py-2 px-3">
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: sevColor[g.severity] }} />
                </td>
                <td className="py-2 px-3 font-medium" style={{ color: 'var(--fg-bright)' }}>
                  <button aria-expanded={open === key} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' }}>{g.equipment}</button>
                </td>
                <td className="py-2 px-3">{g.code} — {g.message}</td>
                <td className="py-2 px-3 text-right" style={{ color: 'var(--fg-bright)' }}>{g.count}</td>
                <td className="py-2 px-3" style={{ color: 'var(--fg-dim)' }}>{dateTime(g.lastAt)}</td>
              </tr>,
              open === key && (
                <tr key={`${key} detail`} style={{ background: 'var(--bg-row)' }}>
                  <td colSpan={5} className="px-6 py-2">
                    <Occurrences code={g.code} equipment={g.equipment} range={range} refreshKey={refreshKey} />
                  </td>
                </tr>
              ),
            ];
          })}
          {history.message && (
            <tr><td colSpan={5} className="py-3 text-center" style={{ color: 'var(--fg-dim)' }}>{history.message}</td></tr>
          )}
        </tbody>
      </table>
      <Pager history={history} />
    </>
  );
}

function Occurrences({ code, equipment, range, refreshKey }: { code: string; equipment: string; range: DateRange; refreshKey: string }) {
  const history = useHistory<Occurrence>('faults', range, refreshKey, { code, equipment });
  return (
    <>
      <table className="w-full" style={{ fontSize: '12px' }}>
        <thead>
          <tr style={{ color: 'var(--fg-dim)' }}>
            <th className="text-left py-0.5">Raised</th>
            <th className="text-left py-0.5">Cleared</th>
            <th className="text-left py-0.5">Message</th>
          </tr>
        </thead>
        <tbody>
          {history.rows.map(o => (
            <tr key={o.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td className="py-0.5">{dateTime(o.raisedAt)}</td>
              <td className="py-0.5" style={{ color: o.clearedAt ? 'var(--fg-dim)' : 'var(--red)' }}>{o.clearedAt ? dateTime(o.clearedAt) : 'Active'}</td>
              <td className="py-0.5">{o.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {history.message && <div style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>{history.message}</div>}
      <Pager history={history} />
    </>
  );
}
