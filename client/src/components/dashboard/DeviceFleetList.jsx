import { memo, useMemo } from 'react';

export const DeviceFleetList = memo(function DeviceFleetList({
  devices,
  selectedDeviceId,
  setSelectedDeviceId,
  onCommand,
  pendingCommands = {},
}) {
  const visibleDevices = useMemo(() => devices.slice(0, 12), [devices]);

  if (devices.length === 0) return null;

  return (
    <div style={{ marginBottom: 4 }}>
      <div className="section-label">Device Fleet</div>

      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      }}>
        {visibleDevices.map(device => {
          const isSelected = selectedDeviceId === device.deviceId;
          const health = device.health || {};
          const isOffline = health.wsConnected === false;
          const isWaking = pendingCommands[`${device.deviceId}:wake_device`]?.status === 'sending';

          return (
            <div
              key={device.deviceId}
              onClick={() => setSelectedDeviceId(device.deviceId)}
              style={{
                position: 'relative', padding: 16, borderRadius: 14,
                cursor: 'pointer', overflow: 'hidden',
                display: 'flex', flexDirection: 'column', gap: 12,
                background: isSelected
                  ? 'linear-gradient(140deg, rgba(14,165,233,0.12), rgba(34,197,94,0.08))'
                  : 'rgba(15,15,20,0.6)',
                border: `1px solid ${isSelected ? 'rgba(34,211,238,0.35)' : 'rgba(63,63,70,0.3)'}`,
                boxShadow: isSelected ? '0 0 0 1px rgba(34,211,238,0.16)' : 'none',
                opacity: isOffline ? 0.7 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, flexShrink: 0,
                  background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(63,63,70,0.4)',
                }}>
                  {isOffline ? '💤' : '📱'}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#e4e4e7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {device.model || 'Unknown Device'}
                  </div>
                  <div style={{ fontSize: 9, color: '#52525b', fontFamily: "'IBM Plex Mono', monospace", marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {device.deviceId}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                    <StatusDot active={!isOffline} label={isOffline ? 'Offline' : 'Online'} />
                    {health.batteryPct != null && (
                      <span style={{ fontSize: 10, color: '#71717a', fontWeight: 500 }}>
                        🔋 {health.batteryPct}%
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Wake button for offline devices */}
              {isOffline && onCommand && (
                <div style={{ paddingTop: 10, borderTop: '1px solid rgba(63,63,70,0.3)' }}>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedDeviceId(device.deviceId);
                      onCommand('wake_device');
                    }}
                    disabled={isWaking}
                    style={{
                      width: '100%', padding: '7px 0', borderRadius: 8,
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                      background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
                      color: '#f59e0b', cursor: isWaking ? 'not-allowed' : 'pointer',
                      opacity: isWaking ? 0.6 : 1,
                    }}
                  >
                    {isWaking ? '⚡ Waking...' : '⚡ Force Wake'}
                  </button>
                </div>
              )}

              {/* Selected indicator */}
              {isSelected && (
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
                  background: 'linear-gradient(to bottom, #22d3ee, #10b981)',
                  borderRadius: '0 2px 2px 0',
                }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function StatusDot({ active, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: active ? '#10b981' : '#ef4444',
        animation: active ? 'beatBar 0.8s ease-in-out infinite alternate' : 'none',
      }} />
      <span style={{ fontSize: 9, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
        {label}
      </span>
    </div>
  );
}
