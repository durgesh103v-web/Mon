import { useEffect, useRef, memo } from 'react';

const getEventStyle = event => {
  if (event.includes('success') || event.includes('ok') || event.includes('streaming') || event.includes('connected'))
    return { color: '#34d399', glow: 'rgba(52,211,153,0.1)', icon: '●' };
  if (event.includes('error') || event.includes('failed') || event.includes('Error'))
    return { color: '#f87171', glow: 'rgba(248,113,113,0.1)', icon: '✕' };
  if (event.includes('ACK') || event.includes('ack'))
    return { color: '#a78bfa', glow: 'rgba(167,139,250,0.08)', icon: '✓' };
  if (event.includes('CMD') || event.includes('cmd'))
    return { color: '#60a5fa', glow: 'rgba(96,165,250,0.08)', icon: '→' };
  if (event.includes('Photo') || event.includes('📷'))
    return { color: '#fb923c', glow: 'rgba(251,146,60,0.08)', icon: '◆' };
  if (event.includes('Audio') || event.includes('🎙'))
    return { color: '#4ade80', glow: 'rgba(74,222,128,0.08)', icon: '◉' };
  return { color: '#71717a', glow: 'transparent', icon: '·' };
};

export const EventLog = memo(function EventLog({ events }) {
  const listRef = useRef(null);
  const displayEvents = events.length > 0 ? events : [];

  // Auto-scroll to latest
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events.length]);

  const getTimestamp = () => {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  };

  return (
    <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 16px',
        background: 'rgba(14,165,233,0.05)', borderBottom: '1px solid rgba(34,211,238,0.1)',
      }}>
        <span style={{ fontSize: 14 }}>📋</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#d4d4d8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Event Log
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: '#3f3f46' }}>
            {displayEvents.length} events
          </span>
          {events.length > 0 && (
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', animation: 'beatBar 0.8s ease-in-out infinite alternate' }} />
          )}
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={listRef}
        style={{
          padding: 12, maxHeight: 200, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}
      >
        {displayEvents.length === 0 ? (
          <div style={{ padding: '20px 0', textAlign: 'center', color: '#3f3f46', fontSize: 11 }}>
            No events yet
          </div>
        ) : (
          displayEvents.map((event, idx) => {
            const style = getEventStyle(event);
            const isLast = idx === displayEvents.length - 1;
            return (
              <div key={idx} style={{
                display: 'flex', alignItems: 'flex-start', gap: 6,
                padding: '4px 8px', borderRadius: 6,
                fontSize: 10, fontFamily: "'IBM Plex Mono', monospace",
                background: isLast ? style.glow : 'transparent',
                borderLeft: isLast ? `2px solid ${style.color}` : '2px solid transparent',
                transition: 'background 0.2s',
              }}>
                <span style={{ color: '#3f3f46', flexShrink: 0, fontSize: 9, marginTop: 1, width: 48, display: 'inline-block' }}>
                  {getTimestamp()}
                </span>
                <span style={{ color: style.color, fontWeight: 700, fontSize: 9, flexShrink: 0 }}>
                  {style.icon}
                </span>
                <span style={{
                  color: style.color === '#71717a' ? '#52525b' : `${style.color}cc`,
                  lineHeight: 1.4, wordBreak: 'break-all',
                }}>{event}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});