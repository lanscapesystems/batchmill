'use client';

import { useState, useEffect } from 'react';
import { MillStoreProvider, useMillStore } from './store';
import { BackendProvider, useBackend } from './backend';
import { QueueTab } from './tabs/queue';
import { RecipesTab } from './tabs/recipes';
import { InventoryTab } from './tabs/inventory';
import { FaultsTab } from './tabs/faults';
import { SystemTab } from './tabs/system';
import { SettingsTab } from './tabs/settings';
import type { Fault } from './sim-data';

const TABS = ['Queue', 'Recipes', 'Inventory', 'Faults', 'System', 'Settings'] as const;
type Tab = (typeof TABS)[number];

export default function Page() {
  return (
    <BackendProvider>
      <MillStoreProvider>
        <PageInner />
      </MillStoreProvider>
    </BackendProvider>
  );
}

function PageInner() {
  const [tab, setTab] = useState<Tab>('Queue');
  const backend = useBackend();
  const { globalConfig, syncGlobalConfig, syncEquipment, syncConnections } = useMillStore();

  const ready = !!backend?.ready;

  useEffect(() => {
    if (ready && backend) syncGlobalConfig(backend.globalConfig as Record<string, number | string>);
  }, [ready, backend?.globalConfig, syncGlobalConfig]);

  useEffect(() => {
    if (ready && backend) syncEquipment(backend.equipment);
  }, [ready, backend?.equipment, syncEquipment]);

  useEffect(() => {
    if (ready && backend) syncConnections(backend.connections);
  }, [ready, backend?.connections, syncConnections]);

  const siteName = (globalConfig.siteName as string) || 'FEED MILL CONTROLLER';
  const faults: Fault[] = backend?.connected ? backend.faults : [];
  const activeFaults = faults.filter(f => f.active).length;
  const activeBatch = backend?.connected ? backend.activeBatch : null;
  const isPaused = activeBatch?.state === 'PAUSED' || activeBatch?.state === 'PAUSING';

  useEffect(() => {
    document.title = siteName;
  }, [siteName]);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-5 py-3" style={{ background: 'var(--bg-panel)', borderBottom: '2px solid var(--border)' }}>
        <span style={{ color: 'var(--fg-bright)', fontWeight: 700, fontSize: '16px', letterSpacing: '0.04em' }}>{siteName}</span>
        {backend?.connected && activeFaults > 0 && (
          <button onClick={() => backend.sendCommand('SilenceHorn')} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wide"
            style={{ background: backend.horn.silenced ? 'transparent' : 'var(--red)', color: backend.horn.silenced ? 'var(--fg-dim)' : '#fff', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer', fontWeight: 600, marginLeft: 'auto', marginRight: '12px' }}>
            {backend.horn.silenced ? 'Horn Silenced (re-arm)' : 'Silence Horn'}
          </button>
        )}
        {activeBatch && backend?.connected && (
          <button
            onClick={() => backend.sendCommand(isPaused ? 'ResumeBatch' : 'PauseBatch')}
            className="px-4 py-1.5 text-xs font-medium uppercase tracking-wide"
            style={{
              background: isPaused ? 'var(--green)' : 'var(--orange)',
              color: '#000',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {isPaused ? 'Resume' : 'Pause'}
          </button>
        )}
      </header>

      <nav className="flex" style={{ background: '#151515', borderBottom: '2px solid var(--border)' }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-medium tracking-wide uppercase${t === 'Faults' && activeFaults > 0 ? ' fault-flash' : ''}`}
            style={{
              ...(t === 'Faults' && activeFaults > 0 ? {} : { background: tab === t ? 'var(--bg)' : 'transparent', color: tab === t ? 'var(--fg-bright)' : 'var(--fg)' }),
              borderBottom: tab === t ? '3px solid var(--accent)' : '3px solid transparent',
              marginBottom: '-2px',
            }}
          >
            {t}
            {t === 'Faults' && activeFaults > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[11px] rounded" style={{ background: 'var(--red)', color: '#fff' }}>{activeFaults}</span>
            )}
          </button>
        ))}
      </nav>

      {backend && !backend.connected && (
        <div role="status" className="px-5 py-2" style={{ background: 'var(--bg-row)', borderBottom: '1px solid var(--border)', color: 'var(--orange)', fontSize: '12px', fontWeight: 600 }}>
          Backend disconnected — reconnecting…
        </div>
      )}
      {backend?.commandError && (
        <div role="alert" className="flex items-center justify-between px-5 py-2" style={{ background: 'var(--bg-row)', borderBottom: '1px solid var(--border)', color: 'var(--red)', fontSize: '12px', fontWeight: 600 }}>
          <span>Command rejected: {backend.commandError}</span>
          <button onClick={backend.clearCommandError} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-dim)', cursor: 'pointer', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>Dismiss</button>
        </div>
      )}

      <main className="flex-1 overflow-auto p-4">
        {tab === 'Queue' && <QueueTab />}
        {tab === 'Recipes' && <RecipesTab />}
        {tab === 'Inventory' && <InventoryTab />}
        {tab === 'Faults' && <FaultsTab />}
        {tab === 'System' && <SystemTab />}
        {tab === 'Settings' && <SettingsTab />}
      </main>
    </div>
  );
}
