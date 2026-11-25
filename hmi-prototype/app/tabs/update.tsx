'use client';

import { useState, useEffect, useRef } from 'react';
import { BACKEND_HTTP } from '../backend';

interface UpdateInfo {
  enabled: boolean;
  current: string | null;
  previous: string | null;
  status: { state: string; message?: string; version?: string; at?: string };
}

const STATE_COLOR: Record<string, string> = { success: 'var(--green)', failed: 'var(--red)', rolled_back: 'var(--orange)' };

export function UpdateSection() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [offline, setOffline] = useState(false); // backend restarts mid-update; expected, not an error
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let off = false;
    async function poll() {
      try {
        const r = await fetch(`${BACKEND_HTTP}/api/v1/update`);
        const d = await r.json();
        if (!off) { setInfo(d); setOffline(false); }
      } catch { if (!off) setOffline(true); }
    }
    poll();
    const t = setInterval(poll, 3000);
    return () => { off = true; clearInterval(t); };
  }, []);

  const st = info?.status.state ?? 'idle';
  const busy = progress !== null || st === 'queued' || st === 'running';

  function upload() {
    if (!file) return;
    setError('');
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BACKEND_HTTP}/api/v1/update`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      setProgress(null);
      if (xhr.status === 202) { setFile(null); if (input.current) input.current.value = ''; return; }
      try { setError(JSON.parse(xhr.responseText).error ?? `HTTP ${xhr.status}`); } catch { setError(`HTTP ${xhr.status}`); }
    };
    xhr.onerror = () => { setProgress(null); setError('Upload failed — connection lost'); };
    xhr.send(file);
  }

  async function rollback() {
    if (!confirm(`Roll back to ${info?.previous}? The system restarts. The database is NOT restored.`)) return;
    setError('');
    try {
      const r = await fetch(`${BACKEND_HTTP}/api/v1/update/rollback`, { method: 'POST' });
      if (!r.ok) setError((await r.json()).error ?? `HTTP ${r.status}`);
    } catch { setError('Rollback request failed'); }
  }

  const btn = (kind: 'primary' | 'destructive', enabled: boolean) => ({
    background: kind === 'primary' ? 'var(--accent)' : 'var(--red)', color: kind === 'primary' ? '#000' : '#fff',
    border: 'none', borderRadius: '3px', padding: '6px 14px', fontFamily: 'inherit', fontSize: '12px', fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.4,
  });

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
      <div className="px-4 py-3 flex flex-col gap-3" style={{ fontSize: '13px' }}>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-dim)', width: '200px', flexShrink: 0 }}>Running release</span>
          <span style={{ color: 'var(--fg-bright)' }}>{info?.current ?? '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-dim)', width: '200px', flexShrink: 0 }}>Previous release</span>
          <span style={{ color: 'var(--fg-bright)' }}>{info?.previous ?? 'none'}</span>
          <button style={btn('destructive', !!info?.previous && !busy)} disabled={!info?.previous || busy} onClick={rollback}>Roll back</button>
        </div>

        {info && !info.enabled && (
          <div style={{ color: 'var(--orange)' }}>Updates are disabled: no signing key is installed on this machine.</div>
        )}

        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-dim)', width: '200px', flexShrink: 0 }}>Update bundle (.zip)</span>
          <input ref={input} type="file" accept=".zip" disabled={busy || !info?.enabled} onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <button style={btn('primary', !!file && !busy)} disabled={!file || busy} onClick={upload}>
            {progress !== null ? `Uploading ${progress}%` : 'Install update'}
          </button>
        </div>
        <div style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>
          Must be a signed bundle from install/make-update.sh. Refused while a batch is active or equipment is running.
          The controller restarts during the update; if the new version fails its health check it reverts automatically.
        </div>

        {error && <div style={{ color: 'var(--red)' }}>{error}</div>}
        {offline && <div style={{ color: 'var(--fg-dim)' }}>Controller restarting… waiting for it to come back.</div>}
        {info && st !== 'idle' && (
          <div style={{ color: STATE_COLOR[st] ?? 'var(--fg-bright)' }}>
            {st.replace('_', ' ')}{info.status.message ? ` — ${info.status.message}` : ''}
            {info.status.at ? ` (${new Date(info.status.at).toLocaleString()})` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
