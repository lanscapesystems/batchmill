'use client';

import { useState, useEffect } from 'react';
import { BACKEND_HTTP } from '../backend';

// History is kept on the mill and read a page at a time, newest first, only while it is on screen.
const PAGE = 50; // matches HISTORY_PAGE in the backend

export interface DateRange { from: string; to: string } // yyyy-mm-dd, '' = open
export const ALL_DATES: DateRange = { from: '', to: '' };

export const dateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export function useHistory<T>(kind: 'batches' | 'faults', range: DateRange, refreshKey: string, extra?: Record<string, string>) {
  const query = new URLSearchParams(extra);
  if (range.from) query.set('from', new Date(`${range.from}T00:00`).toISOString());
  if (range.to) { const end = new Date(`${range.to}T00:00`); end.setDate(end.getDate() + 1); query.set('to', end.toISOString()); }
  const filter = query.toString();
  const [position, setPosition] = useState({ filter, page: 0 });
  const page = position.filter === filter ? position.page : 0; // a new filter starts at the newest
  const url = `${BACKEND_HTTP}/api/v1/history/${kind}?${filter}&offset=${page * PAGE}`;
  const [result, setResult] = useState<{ url: string; rows: T[]; more: boolean; failed?: boolean }>({ url: '', rows: [], more: false });

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        const d = await r.json();
        if (!off) setResult({ url, rows: d.rows, more: d.more });
      } catch { if (!off) setResult({ url, rows: [], more: false, failed: true }); }
    })();
    return () => { off = true; };
  }, [url, refreshKey]);

  const loading = result.url !== url;
  return {
    rows: loading ? [] : result.rows,
    message: loading ? 'Loading…' : result.failed ? 'History could not be read' : result.rows.length === 0 ? 'No records' : null,
    page,
    newer: page > 0 ? () => setPosition({ filter, page: page - 1 }) : undefined,
    older: !loading && result.more ? () => setPosition({ filter, page: page + 1 }) : undefined,
  };
}

export function DateRangeInputs({ range, onChange }: { range: DateRange; onChange: (r: DateRange) => void }) {
  const input = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontSize: '12px', colorScheme: 'dark' } as const;
  return (
    <div className="flex items-center gap-2" style={{ fontSize: '11px', fontWeight: 400, color: 'var(--fg-dim)' }}>
      {(['from', 'to'] as const).map(k => (
        <label key={k} className="flex items-center gap-1">
          {k === 'from' ? 'From' : 'To'}
          <input type="date" value={range[k]} onChange={e => onChange({ ...range, [k]: e.target.value })} style={input} />
        </label>
      ))}
    </div>
  );
}

export function Pager({ history }: { history: { page: number; newer?: () => void; older?: () => void } }) {
  if (!history.newer && !history.older) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-3 py-2">
      <span style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>Page {history.page + 1}</span>
      {([['Newer', history.newer], ['Older', history.older]] as const).map(([label, go]) => (
        <button key={label} onClick={go} disabled={!go}
          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-dim)', cursor: go ? 'pointer' : 'default', opacity: go ? 1 : 0.4, padding: '4px 10px', fontSize: '12px', fontWeight: 600 }}>
          {label}
        </button>
      ))}
    </div>
  );
}
