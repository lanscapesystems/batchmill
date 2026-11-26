'use client';

import { useState, useEffect, useRef } from 'react';
import { BACKEND_HTTP } from '../backend';

type Target = 'browser' | 'usb' | 'folder';
type Kind = 'db' | 'config';
interface BackupFile { name: string; kind: Kind; size: number; at: string }

const KIND_LABEL: Record<Kind, string> = { db: 'Database', config: 'Config' };
const TARGET_LABEL: Record<Target, string> = { browser: 'This browser', usb: 'USB drive', folder: 'Backups folder' };

const btn = (kind: 'primary' | 'destructive' | 'ghost', enabled = true) => ({
  background: kind === 'primary' ? 'var(--accent)' : kind === 'destructive' ? 'var(--red)' : 'transparent',
  color: kind === 'primary' ? '#000' : kind === 'destructive' ? '#fff' : 'var(--fg-dim)',
  border: kind === 'ghost' ? '1px solid var(--border)' : 'none',
  borderRadius: '3px', padding: '4px 10px', fontFamily: 'inherit', fontSize: '12px', fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.4,
});

export function BackupSection() {
  const [target, setTarget] = useState<Target>('folder');
  const [kind, setKind] = useState<Kind>('config');
  const [usb, setUsb] = useState<string[]>([]);
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [dir, setDir] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const upload = useRef<HTMLInputElement>(null);

  async function api(url: string, init?: RequestInit) {
    const r = await fetch(`${BACKEND_HTTP}${url}`, init);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    return r;
  }
  const post = (url: string, body: unknown) =>
    api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function refresh() {
    if (target === 'browser') { setFiles([]); return; }
    try {
      if (target === 'usb') setUsb((await (await api('/api/v1/backup/targets')).json()).usb);
      const d = await (await api(`/api/v1/backup/list?target=${target}`)).json();
      setFiles(d.files); setDir(d.dir);
    } catch (e) { setFiles([]); setDir(''); setMsg({ ok: false, text: (e as Error).message }); }
  }
  useEffect(() => { setMsg(null); refresh(); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  // after a restore the backend restarts itself; poll until it is back
  function waitForRestart() {
    setOffline(true);
    const t = setInterval(async () => {
      try { await fetch(`${BACKEND_HTTP}/api/v1/health`); clearInterval(t); setOffline(false); setBusy(false); setMsg({ ok: true, text: 'Restored — controller restarted.' }); refresh(); } catch { /* still down */ }
    }, 2000);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); setBusy(false); return; }
    setBusy(false);
  }

  const backup = () => run(async () => {
    if (target === 'browser') {
      const r = await api(`/api/v1/backup/download?kind=${kind}`);
      const name = /filename="?([^"]+)"?/.exec(r.headers.get('Content-Disposition') ?? '')?.[1] ?? `feedmill-${kind}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click();
      URL.revokeObjectURL(a.href);
      setMsg({ ok: true, text: `Downloaded ${name}` });
    } else {
      const d = await (await post('/api/v1/backup/save', { kind, target, usb: usb[0] })).json();
      setMsg({ ok: true, text: `Saved ${d.name}` });
      refresh();
    }
  });

  const restoreFile = (f: BackupFile) => {
    if (!confirm(`Restore ${KIND_LABEL[f.kind]} from ${f.name}? This replaces the current ${f.kind === 'db' ? 'database' : 'config'} and restarts the controller.`)) return;
    run(async () => { await post('/api/v1/backup/restore', { kind: f.kind, target, usb: usb[0], name: f.name }); setBusy(true); waitForRestart(); });
  };
  const restoreUpload = (file: File) => {
    if (!confirm(`Restore ${KIND_LABEL[kind]} from ${file.name}? This replaces the current ${kind === 'db' ? 'database' : 'config'} and restarts the controller.`)) return;
    run(async () => { await api(`/api/v1/backup/restore-upload?kind=${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }); setBusy(true); waitForRestart(); });
  };

  const noUsb = target === 'usb' && usb.length === 0;

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
      <div className="px-4 py-3 flex flex-col gap-3" style={{ fontSize: '13px' }}>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-dim)', width: '120px' }}>Location</span>
          {(Object.keys(TARGET_LABEL) as Target[]).map(t => (
            <button key={t} style={{ ...btn(target === t ? 'primary' : 'ghost'), }} disabled={busy} onClick={() => setTarget(t)}>{TARGET_LABEL[t]}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-dim)', width: '120px' }}>Data</span>
          {(Object.keys(KIND_LABEL) as Kind[]).map(k => (
            <button key={k} style={btn(kind === k ? 'primary' : 'ghost')} disabled={busy} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span style={{ width: '120px' }} />
          <button style={btn('primary', !busy && !noUsb)} disabled={busy || noUsb} onClick={backup}>
            {target === 'browser' ? `Download ${KIND_LABEL[kind]} backup` : `Back up ${KIND_LABEL[kind]} now`}
          </button>
        </div>

        {target === 'browser' && (
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--fg-dim)', width: '120px' }}>Restore {KIND_LABEL[kind]}</span>
            <input ref={upload} type="file" accept={kind === 'db' ? '.db' : '.json'} disabled={busy}
              onChange={e => { const f = e.target.files?.[0]; if (f) restoreUpload(f); if (upload.current) upload.current.value = ''; }} />
          </div>
        )}

        {target !== 'browser' && (
          <div>
            <div style={{ color: 'var(--fg-dim)', fontSize: '11px', marginBottom: '6px' }}>
              {noUsb ? 'No USB drive detected on the controller.' : dir ? `Folder: ${dir}` : ''}
            </div>
            {files.length === 0 && !noUsb && <div style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>No backups yet.</div>}
            {files.length > 0 && (
              <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                <thead><tr style={{ color: 'var(--fg-dim)', textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th className="py-2 px-3">Type</th><th className="py-2 px-3">File</th><th className="py-2 px-3">Date</th>
                  <th className="py-2 px-3" style={{ textAlign: 'right' }}>Size</th><th />
                </tr></thead>
                <tbody>{files.map(f => (
                  <tr key={f.name} style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg)' }}>
                    <td className="py-2 px-3" style={{ color: 'var(--fg-bright)' }}>{KIND_LABEL[f.kind]}</td>
                    <td className="py-2 px-3">{f.name}</td>
                    <td className="py-2 px-3">{new Date(f.at).toLocaleString()}</td>
                    <td className="py-2 px-3" style={{ textAlign: 'right', color: 'var(--fg-bright)' }}>{(f.size / 1024).toFixed(0)} KB</td>
                    <td className="py-2 px-3" style={{ textAlign: 'right' }}>
                      <button style={btn('destructive', !busy)} disabled={busy} onClick={() => restoreFile(f)}>Restore</button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}

        <div style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>
          Restore is refused while a batch is running or equipment is running, then replaces the data and restarts the controller.
          Restoring a database does not change the config, and vice versa.
        </div>
        {msg && <div style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
        {offline && <div style={{ color: 'var(--fg-dim)' }}>Controller restarting… waiting for it to come back.</div>}
      </div>
    </div>
  );
}
