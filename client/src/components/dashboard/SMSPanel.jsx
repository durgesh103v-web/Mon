import { memo, useMemo } from 'react';

export const SMSPanel = memo(function SMSPanel({ messages }) {
  const visibleMessages = useMemo(() => messages.slice(0, 40), [messages]);

  return (
    <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8,
        background: 'rgba(16,185,129,0.06)', borderBottom: '1px solid rgba(16,185,129,0.12)',
      }}>
        <span style={{ fontSize: 14 }}>💬</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#e4e4e7', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          SMS
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#52525b', fontWeight: 500 }}>
          {messages.length} messages
        </span>
      </div>

      {messages.length === 0 ? (
        <div style={{ padding: '32px 16px', textAlign: 'center', color: '#52525b', fontSize: 12 }}>
          <div style={{ fontSize: 24, marginBottom: 6, opacity: 0.3 }}>💬</div>
          No SMS data yet. Tap "Sync Data" to fetch.
        </div>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {visibleMessages.map(msg => (
            <div key={msg.id} style={{
              padding: '8px 14px', borderBottom: '1px solid rgba(63,63,70,0.2)',
            }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#e4e4e7', minWidth: 0, overflowWrap: 'anywhere' }}>
                  {msg.sender}
                </span>
                <TypeBadge type={msg.type} />
                {!msg.read && msg.type === 'inbox' && (
                  <span style={{
                    fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                    background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                    color: '#f87171', textTransform: 'uppercase',
                  }}>Unread</span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 9, color: '#52525b' }}>
                  {new Date(msg.timestamp).toLocaleString()}
                </span>
              </div>
              <p style={{
                fontSize: 11, color: '#a1a1aa', margin: 0, lineHeight: 1.45,
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              }}>{msg.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function TypeBadge({ type }) {
  const meta = {
    inbox: { bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.25)', color: '#60a5fa' },
    sent: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.25)', color: '#34d399' },
  }[type] || { bg: 'rgba(82,82,91,0.12)', border: 'rgba(82,82,91,0.25)', color: '#71717a' };
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
      background: meta.bg, border: `1px solid ${meta.border}`,
      color: meta.color, textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>{type}</span>
  );
}
