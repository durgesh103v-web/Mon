import { memo, useMemo, useState } from 'react';

export const InstalledAppsPanel = memo(function InstalledAppsPanel({
  apps = [],
  deviceId,
  onCommand,
  pendingCommands = {},
  isConnected = false,
}) {
  const [query, setQuery] = useState('');
  const [userOnly, setUserOnly] = useState(true);

  const refreshStatus = deviceId ? pendingCommands[`${deviceId}:list_apps`]?.status : null;
  const isBusy = (status) => status === 'sending' || status === 'queued' || status === 'sent';
  const refreshPending = isBusy(refreshStatus);
  const disabledAll = !isConnected || !deviceId;

  const uninstallStatusFor = (packageName) => {
    if (!deviceId || !packageName) return null;
    return pendingCommands[`${deviceId}:uninstall_package:${packageName}`]?.status || null;
  };

  const filtered = useMemo(() => {
    const safeApps = Array.isArray(apps) ? apps : [];
    const q = query.trim().toLowerCase();
    return safeApps.filter(app => {
      if (userOnly && app.isSystem) return false;
      if (!q) return true;
      const label = String(app.label || '').toLowerCase();
      const pkg = String(app.packageName || '').toLowerCase();
      return label.includes(q) || pkg.includes(q);
    });
  }, [apps, query, userOnly]);

  const handleRefresh = () => {
    if (disabledAll || refreshPending) return;
    onCommand('list_apps');
  };

  const handleUninstall = (app) => {
    if (!app || disabledAll) return;
    if (app.canUninstall !== true) return;
    const label = String(app.label || app.packageName || 'this app');
    const pkg = String(app.packageName || '').trim();
    if (!pkg) return;
    if (isBusy(uninstallStatusFor(pkg))) return;
    const confirmed = window.confirm(`Uninstall ${label}?`);
    if (!confirmed) return;
    onCommand('uninstall_package', { packageName: pkg });
  };

  return (
    <section className="panel-shell">
      <div className="panel-title-row">
        <div>
          <div className="eyebrow">Device Manager</div>
          <h2>Installed Apps</h2>
        </div>
        <button
          type="button"
          className="primary-command"
          onClick={handleRefresh}
          disabled={disabledAll || refreshPending}
          style={{ minHeight: 30, padding: '0 12px', fontSize: 9 }}
        >
          {refreshPending ? 'Refreshing' : 'Refresh Apps'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search label or package"
          style={{
            flex: 1,
            minWidth: 180,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid rgba(63,63,70,0.55)',
            background: 'rgba(24,24,27,0.7)',
            color: '#e4e4e7',
            fontSize: 10,
          }}
        />
        <button
          type="button"
          className="primary-command"
          onClick={() => setUserOnly(prev => !prev)}
          style={{ minHeight: 30, padding: '0 12px', fontSize: 9 }}
        >
          {userOnly ? 'User Apps' : 'All Apps'}
        </button>
      </div>

      <div style={{
        borderRadius: 8,
        border: '1px solid rgba(63,63,70,0.5)',
        overflow: 'hidden',
        background: 'rgba(9,9,11,0.4)',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1.5fr 0.7fr 0.6fr',
          gap: 8,
          padding: '8px 10px',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: '#71717a',
          borderBottom: '1px solid rgba(63,63,70,0.4)',
        }}>
          <span>App</span>
          <span>Package</span>
          <span>Version</span>
          <span>Action</span>
        </div>

        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '16px 12px', fontSize: 10, color: '#52525b' }}>
              {refreshPending ? 'Loading apps...' : 'No apps loaded yet.'}
            </div>
          ) : (
            filtered.map(app => {
              const isSystem = app.isSystem === true;
              const canUninstall = app.canUninstall === true;
              const pkg = String(app.packageName || '').trim();
              const uninstallStatus = uninstallStatusFor(pkg);
              const uninstallPending = isBusy(uninstallStatus);
              const versionName = String(app.versionName || '');
              const versionCode = Number(app.versionCode || 0);
              const version = versionName
                ? `${versionName}${versionCode ? ` (${versionCode})` : ''}`
                : versionCode ? `(${versionCode})` : 'N/A';
              return (
                <div
                  key={pkg || app.packageName}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.2fr 1.5fr 0.7fr 0.6fr',
                    gap: 8,
                    padding: '8px 10px',
                    alignItems: 'center',
                    borderBottom: '1px solid rgba(39,39,42,0.6)',
                    fontSize: 10,
                    color: '#e4e4e7',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {app.label || app.packageName}
                    </div>
                    <div style={{ fontSize: 9, color: '#71717a' }}>
                      {isSystem ? 'System app' : 'User app'}
                    </div>
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {app.packageName}
                  </div>
                  <div style={{ fontSize: 9, color: '#a1a1aa' }}>{version}</div>
                  <div>
                    {canUninstall ? (
                      <button
                        type="button"
                        className="primary-command"
                        style={{ minHeight: 26, padding: '0 8px', fontSize: 9 }}
                        onClick={() => handleUninstall(app)}
                        disabled={disabledAll || uninstallPending}
                      >
                        {uninstallPending ? 'Working' : uninstallStatus === 'error' ? 'Failed' : 'Uninstall'}
                      </button>
                    ) : (
                      <span style={{ fontSize: 9, color: '#52525b' }}>Locked</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
});
