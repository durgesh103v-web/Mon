import { memo } from 'react';

export const NetworkProfile = memo(function NetworkProfile({
  lowNetwork = false,
  streamCodec,
  streamCodecMode,
  onForceToggle,
  isStreaming = false,
  connQuality,
  netType,
  isConnected = true,
  deviceId,
  pendingCommands = {},
}) {
  const status = deviceId ? pendingCommands[`${deviceId}:set_low_network`]?.status : null;
  const isPending = status === 'sending' || status === 'queued';
  const disableToggle = !isConnected || !deviceId || isPending;

  const modeLabel = lowNetwork ? '⚡ Low-Bandwidth Mode' : '📡 High-Quality Mode';
  const modeDesc = lowNetwork
    ? 'Longer PCM frames + gain boost for weak signal'
    : streamCodec === 'pcm'
      ? 'Realtime PCM 16-bit for clear voice'
      : `${streamCodec || 'PCM'} ${streamCodecMode || ''}`;

  const qualColor = connQuality === 'excellent' ? '#10b981'
    : connQuality === 'good' ? '#818cf8'
    : connQuality === 'poor' ? '#ef4444' : '#f59e0b';

  return (
    <div style={{
      borderRadius: 14, padding: '10px 18px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 14, flexWrap: 'wrap',
      background: lowNetwork
        ? 'linear-gradient(90deg, rgba(245,158,11,0.06), rgba(239,68,68,0.04))'
        : 'linear-gradient(90deg, rgba(14,165,233,0.06), rgba(16,185,129,0.04))',
      border: `1px solid ${lowNetwork ? 'rgba(245,158,11,0.25)' : 'rgba(34,211,238,0.2)'}`,
      backdropFilter: 'blur(12px)',
      boxShadow: lowNetwork ? '0 0 20px rgba(245,158,11,0.08)' : '0 0 20px rgba(14,165,233,0.08)',
    }}>
      {/* Left — mode info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Signal bars */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 20 }} aria-hidden="true">
          {[3, 5, 7, 9].map((h, i) => (
            <div key={i} style={{
              width: 3, borderRadius: 1.5, transition: 'all 0.4s',
              height: `${lowNetwork && i > 1 ? Math.max(3, h * 0.4) : h}px`,
              background: lowNetwork
                ? (i < 2 ? '#f59e0b' : 'rgba(245,158,11,0.15)')
                : `hsl(${145 + i * 15}, 65%, 52%)`,
              opacity: isStreaming ? 1 : 0.45,
            }} />
          ))}
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: lowNetwork ? '#fbbf24' : '#a5b4fc' }}>
              {modeLabel}
            </span>
            {lowNetwork && isStreaming && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)',
                color: '#fbbf24',
              }}>BOOSTED</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: '#52525b', marginTop: 2 }}>{modeDesc}</div>
        </div>
      </div>

      {/* Center — quality pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {connQuality && (
          <QualityPill color={qualColor}>
            {connQuality.charAt(0).toUpperCase() + connQuality.slice(1)} Quality
          </QualityPill>
        )}
        {netType && (
          <QualityPill color="#52525b">{netType.toUpperCase()}</QualityPill>
        )}
        {streamCodec && (
          <QualityPill color="#818cf8">{streamCodec.toUpperCase()}</QualityPill>
        )}
      </div>

      {/* Right — toggle */}
      <button
        onClick={onForceToggle}
        disabled={disableToggle}
        style={{
          marginLeft: 'auto', flexShrink: 0,
          fontSize: 11, fontWeight: 700, padding: '7px 16px', borderRadius: 10,
          background: lowNetwork ? 'rgba(245,158,11,0.1)' : 'rgba(14,165,233,0.08)',
          border: `1px solid ${lowNetwork ? 'rgba(245,158,11,0.3)' : 'rgba(34,211,238,0.3)'}`,
          color: lowNetwork ? '#fbbf24' : '#67e8f9',
          cursor: disableToggle ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s',
          opacity: disableToggle ? 0.5 : 1,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        {isPending ? 'Working...' : lowNetwork ? '▲ Switch to HQ' : '▼ Force Low-BW'}
        {status && <StatusPill status={status} />}
      </button>
    </div>
  );
});

function QualityPill({ color, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '4px 10px', borderRadius: 8,
      fontSize: 10, fontWeight: 600,
      background: `${color}12`, border: `1px solid ${color}30`, color,
    }}>
      <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'currentColor' }} />
      {children}
    </div>
  );
}

function StatusPill({ status }) {
  const meta = {
    sending: { label: 'Pending', color: '#f59e0b' },
    queued: { label: 'Pending', color: '#f59e0b' },
    sent: { label: 'Sent', color: '#34d399' },
    success: { label: 'Done', color: '#34d399' },
    error: { label: 'Error', color: '#f87171' },
  }[status];
  if (!meta) return null;
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 8,
      background: `${meta.color}18`, border: `1px solid ${meta.color}30`,
      color: meta.color, textTransform: 'uppercase',
      display: 'inline-flex', alignItems: 'center', gap: 3,
    }}>
      <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'currentColor' }} />
      {meta.label}
    </span>
  );
}
