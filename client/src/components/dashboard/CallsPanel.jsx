import { memo } from 'react';

function formatDuration(seconds) {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const CALL_META = {
  incoming: { icon: '📲', color: '#34d399', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.25)' },
  outgoing: { icon: '📱', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.25)' },
  missed: { icon: '📵', color: '#f87171', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.25)' },
  rejected: { icon: '🚫', color: '#fb923c', bg: 'rgba(251,146,60,0.12)', border: 'rgba(251,146,60,0.25)' },
};

export const CallsPanel = memo(function CallsPanel({ calls }) {
  return (
    <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8,
        background: 'rgba(245,158,11,0.06)', borderBottom: '1px solid rgba(245,158,11,0.12)',
      }}>
        <span style={{ fontSize: 14 }}>📞</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#e4e4e7', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Calls
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#52525b', fontWeight: 500 }}>
          {calls.length} calls
        </span>
      </div>

      {calls.length === 0 ? (
        <div style={{ padding: '32px 16px', textAlign: 'center', color: '#52525b', fontSize: 12 }}>
          <div style={{ fontSize: 24, marginBottom: 6, opacity: 0.3 }}>📞</div>
          No call history yet. Tap "Sync Data" to fetch.
        </div>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {calls.map(call => {
            const meta = CALL_META[call.type] || { icon: '📞', color: '#71717a', bg: 'rgba(82,82,91,0.12)', border: 'rgba(82,82,91,0.25)' };
            return (
              <div key={call.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px', borderBottom: '1px solid rgba(63,63,70,0.2)',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(63,63,70,0.1)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ fontSize: 16, flexShrink: 0 }}>{meta.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#e4e4e7', overflowWrap: 'anywhere' }}>
                      {call.number}
                    </span>
                    {call.name && <span style={{ fontSize: 10, color: '#71717a', overflowWrap: 'anywhere' }}>({call.name})</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span style={{
                      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                      background: meta.bg, border: `1px solid ${meta.border}`,
                      color: meta.color, textTransform: 'uppercase',
                    }}>{call.type}</span>
                    <span style={{ fontSize: 9, color: '#52525b' }}>
                      {new Date(call.timestamp).toLocaleString()}
                    </span>
                  </div>
                </div>
                {call.duration > 0 && (
                  <span style={{ fontSize: 11, color: '#71717a', fontFamily: "'IBM Plex Mono', monospace", fontWeight: 500, flexShrink: 0 }}>
                    {formatDuration(call.duration)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
