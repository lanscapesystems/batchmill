'use client';

import { useState } from 'react';
import type { Fault } from '../sim-data';
import { useBackend } from '../backend';

const sevColor: Record<string, string> = {
  CRITICAL: 'var(--red)',
  WARNING: 'var(--orange)',
  INFO: 'var(--fg-dim)',
};

function timeStr(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function FaultsTab() {
  const [filter, setFilter] = useState<'all' | 'active'>('active');
  const backend = useBackend();

  const faults: Fault[] = backend?.connected ? backend.faults : [];
  const filtered = filter === 'active' ? faults.filter(f => f.active) : faults;
  const activeCount = faults.filter(f => f.active).length;

  function clearFault(id: string) {
    if (backend?.connected) {
      backend.sendCommand('ClearFault', id);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {(['active', 'all'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-3 py-2 text-xs font-medium uppercase"
              style={{
                background: filter === f ? 'var(--bg-row)' : 'transparent',
                color: filter === f ? 'var(--fg-bright)' : 'var(--fg-dim)',
                border: '1px solid var(--border)',
                borderRadius: '3px',
              }}
            >
              {f}
            </button>
          ))}
        </div>
        <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>
          {faults.filter(f => f.active).length} active
        </span>
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
            {filtered.map(f => (
              <tr key={f.id} style={{ borderBottom: '1px solid var(--border)', background: f.active ? 'rgba(229,57,53,0.04)' : 'transparent' }}>
                <td className="py-2 px-3">
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: f.active ? sevColor[f.severity] : 'var(--gray)' }} />
                </td>
                <td className="py-2 px-3 font-medium" style={{ color: 'var(--fg-bright)' }}>{f.equipment}</td>
                <td className="py-2 px-3">{f.message}</td>
                <td className="py-2 px-3" style={{ color: 'var(--fg-dim)' }}>{timeStr(f.raisedAt)}</td>
                <td className="py-2 px-3 flex gap-1">
                  {f.active && backend?.connected && (
                    <button
                      onClick={() => clearFault(f.id)}
                      className="px-3 py-1 text-xs font-medium"
                      style={{ background: 'var(--green)', color: '#000', borderRadius: '3px', border: 'none', cursor: 'pointer' }}
                    >
                      CLEAR
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="py-3 text-center" style={{ color: 'var(--fg-dim)' }}>No faults</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
