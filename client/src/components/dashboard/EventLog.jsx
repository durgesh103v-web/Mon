import { useEffect, useRef } from 'react';
const EVENT_DEMO = ['🔵 Device connected: 664b1681', '📢 CMD start_stream → success', '📢 CMD set_low_network → off (HQ mode)', '⚙️ ACK stream_codec: pcm → ok', '📢 CMD voice_profile: far → 2.5× gain boost active', '🎙 Audio streaming at 16 kHz PCM', '⚙️ ACK photo_ai: on', '📷 Photo captured: rear 1920×1080'];
const getEventStyle = event => {
  if (event.includes('success') || event.includes('ok') || event.includes('streaming') || event.includes('connected')) return {
    color: '#34d399',
    glow: 'rgba(52,211,153,0.15)',
    icon: '●'
  };
  if (event.includes('error') || event.includes('failed') || event.includes('Error')) return {
    color: '#f87171',
    glow: 'rgba(248,113,113,0.15)',
    icon: '✕'
  };
  if (event.includes('ACK') || event.includes('ack')) return {
    color: '#a78bfa',
    glow: 'rgba(167,139,250,0.1)',
    icon: '✓'
  };
  if (event.includes('CMD') || event.includes('cmd')) return {
    color: '#60a5fa',
    glow: 'rgba(96,165,250,0.1)',
    icon: '→'
  };
  if (event.includes('Photo') || event.includes('📷')) return {
    color: '#fb923c',
    glow: 'rgba(251,146,60,0.1)',
    icon: '◆'
  };
  if (event.includes('Audio') || event.includes('🎙')) return {
    color: '#4ade80',
    glow: 'rgba(74,222,128,0.1)',
    icon: '◉'
  };
  return {
    color: '#94a3b8',
    glow: 'transparent',
    icon: '·'
  };
};
export function EventLog({
  events
}) {
  const listRef = useRef(null);
  const displayEvents = events.length > 0 ? events : EVENT_DEMO;

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events.length]);
  const getTimestamp = () => {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  };
  return <div className="rounded-2xl overflow-hidden flex flex-col" style={{
    background: 'linear-gradient(170deg, rgba(8,12,22,0.8), rgba(5,9,18,0.74))',
    border: '1px solid rgba(34,211,238,0.16)',
    backdropFilter: 'blur(12px)',
    boxShadow: '0 10px 36px rgba(0,0,0,0.45)'
  }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3" style={{
      background: 'rgba(14,165,233,0.08)',
      borderBottom: '1px solid rgba(34,211,238,0.12)'
    }}>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm" style={{
        background: 'rgba(14,165,233,0.2)',
        border: '1px solid rgba(34,211,238,0.45)'
      }}>📋</div>
        <span className="text-xs font-bold uppercase tracking-widest text-slate-300">Event Log</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono text-slate-600">{displayEvents.length} events</span>
          {events.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
        </div>
      </div>

      {/* Log entries */}
      <div ref={listRef} className="p-4 max-h-52 overflow-y-auto space-y-1" style={{
      scrollbarWidth: 'thin',
      scrollbarColor: 'rgba(99,102,241,0.2) transparent'
    }}>
        {displayEvents.map((event, idx) => {
        const style = getEventStyle(event);
        return <div key={idx} className="flex items-start gap-2 px-2 py-1.5 rounded-lg text-[11px] font-mono transition-all" style={{
          background: idx === displayEvents.length - 1 && events.length > 0 ? style.glow : 'transparent',
          borderLeft: `2px solid ${idx === displayEvents.length - 1 && events.length > 0 ? style.color : 'transparent'}`
        }}>
              <span className="text-slate-600 shrink-0 text-[10px] mt-0.5 w-16 inline-block">
                {getTimestamp()}
              </span>
              <span className="shrink-0 font-bold text-[10px]" style={{
            color: style.color
          }}>
                {style.icon}
              </span>
              <span style={{
            color: style.color === '#94a3b8' ? '#64748b' : `${style.color}cc`
          }} className="leading-relaxed break-all">
                {event}
              </span>
            </div>;
      })}
      </div>
    </div>;
}