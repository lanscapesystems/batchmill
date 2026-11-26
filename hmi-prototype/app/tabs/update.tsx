'use client';

import { useState, useEffect, useRef } from 'react';
import { BACKEND_HTTP } from '../backend';

interface UpdateInfo {
  enabled: boolean;
  current: string | null;
  previous: string | null;
  status: { state: string; message?: string; version?: string; at?: string };
  version: string;
  repo: string;
  branch: string;
}
interface CheckResult { version: string; running: string; relation: 'newer' | 'same' | 'older' }

const STATE_COLOR: Record<string, string> = { success: 'var(--green)', failed: 'var(--red)', rolled_back: 'var(--orange)' };

const inputStyle = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px',
  color: 'var(--fg-bright)', padding: '4px 8px', fontSize: '12px', fontFamily: 'inherit', width: '260px',
};

export function UpdateSection() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [offline, setOffline] = useState(false); // backend restarts mid-update; expected, not an error
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [branch, setBranch] = useState('');
  const srcLoaded = useRef(false); // fill the inputs once, so polling doesn't overwrite typing
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let off = false;
    async function poll() {
      try {
        const r = await fetch(`${BACKEND_HTTP}/api/v1/update`);
        const d: UpdateInfo = await r.json();
        if (off) return;
        setInfo(d); setOffline(false);
        if (!srcLoaded.current) { srcLoaded.current = true; setBranch(d.branch); }
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

  async function call(url: string, init?: RequestInit): Promise<Response | null> {
    setError('');
    try {
      const r = await fetch(`${BACKEND_HTTP}${url}`, init);
      if (r.ok) return r;
      setError((await r.json()).error ?? `HTTP ${r.status}`);
    } catch { setError('Request failed'); }
    return null;
  }
  const saveSource = () => call('/api/v1/update/branch', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch }),
  });

  async function checkGithub() {
    setChecking(true); setCheck(null);
    if (await saveSource()) {
      const r = await call('/api/v1/update/check');
      if (r) setCheck(await r.json());
    }
    setChecking(false);
  }
  async function installGithub() {
    if (!confirm(`Install ${info?.repo}@${branch}? The code is NOT signature-checked. The system restarts.`)) return;
    if (await saveSource()) await call('/api/v1/update/github', { method: 'POST' });
  }
  async function rollback() {
    if (!confirm(`Roll back to ${info?.previous}? The system restarts. The database is NOT restored.`)) return;
    await call('/api/v1/update/rollback', { method: 'POST' });
  }

  const btn = (kind: 'primary' | 'destructive' | 'ghost', enabled: boolean) => ({
    background: kind === 'primary' ? 'var(--accent)' : kind === 'destructive' ? 'var(--red)' : 'transparent',
    color: kind === 'primary' ? '#000' : kind === 'destructive' ? '#fff' : 'var(--fg-dim)',
    border: kind === 'ghost' ? '1px solid var(--border)' : 'none',
    borderRadius: '3px', padding: '6px 14px', fontFamily: 'inherit', fontSize: '12px', fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.4,
  });

  const label = { color: 'var(--fg-dim)', width: '200px', flexShrink: 0 };

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
      <div className="px-4 py-3 flex flex-col gap-3" style={{ fontSize: '13px' }}>
        <div className="flex items-center gap-2">
          <span style={label}>Version</span>
          <span style={{ color: 'var(--fg-bright)' }}>{info?.version ?? '—'}</span>
          <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>release {info?.current ?? '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={label}>Previous release</span>
          <span style={{ color: 'var(--fg-bright)' }}>{info?.previous ?? 'none'}</span>
          <button style={btn('destructive', !!info?.previous && !busy)} disabled={!info?.previous || busy} onClick={rollback}>Roll back</button>
        </div>

        <div className="flex items-center gap-2">
          <span style={label}>GitHub</span>
          <span style={{ color: 'var(--fg-bright)' }}>{info?.repo ?? '—'}</span>
          <span style={{ color: 'var(--fg-dim)' }}>Branch</span>
          <input value={branch} onChange={e => setBranch(e.target.value)} disabled={busy} style={inputStyle} />
        </div>
        <div className="flex items-center gap-2">
          <span style={{ ...label, width: '200px' }} />
          <button style={btn('ghost', !!branch && !busy && !checking)} disabled={!branch || busy || checking} onClick={checkGithub}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          <button style={btn('primary', !!branch && !busy)} disabled={!branch || busy} onClick={installGithub}>Install from GitHub</button>
        </div>
        {check && (
          <div style={{ color: check.relation === 'newer' ? 'var(--orange)' : check.relation === 'same' ? 'var(--green)' : 'var(--fg)' }}>
            {check.relation === 'newer' ? `Update available — ${check.version} (running ${check.running})`
              : check.relation === 'same' ? `Up to date (${check.running})`
              : `Branch has an older version (${check.version}) than the one running (${check.running})`}
          </div>
        )}

        {info && !info.enabled && (
          <div style={{ color: 'var(--orange)' }}>Zip upload is disabled: no signing key is installed on this machine.</div>
        )}
        <div className="flex items-center gap-2">
          <span style={label}>Update bundle (.zip)</span>
          <input ref={input} type="file" accept=".zip" disabled={busy || !info?.enabled} onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <button style={btn('primary', !!file && !busy)} disabled={!file || busy} onClick={upload}>
            {progress !== null ? `Uploading ${progress}%` : 'Install update'}
          </button>
        </div>
        <div style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>
          Updates are refused while a batch is active or equipment is running. The controller restarts during the update;
          if the new version fails its health check it reverts automatically.
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
