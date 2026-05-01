export function NetworkProfile({
  lowNetwork = false,
  streamCodec,
  streamCodecMode,
  onForceToggle,
  isStreaming = false,
  connQuality,
  netType,
  isConnected = true,
  deviceId,
  pendingCommands = {}
}) {
  const status = deviceId ? pendingCommands[`${deviceId}:set_low_network`]?.status : null;
  const isPending = status === 'sending' || status === 'queued';
  const disableToggle = !isConnected || !deviceId || isPending;
  const modeLabel = lowNetwork ? '⚡ Low-Bandwidth Mode' : `📡 High-Quality Mode`;
  const modeDesc = lowNetwork ? 'Server 2.5× gain boost active • Optimized for weak signal' : streamCodecMode === 'auto' ? 'HQ Opus auto-codec • Max fidelity for clear voice' : streamCodec === 'pcm' ? 'Uncompressed PCM 16-bit • Zero loss' : `${streamCodec || 'PCM'} ${streamCodecMode || ''}`;
  const qualColor = connQuality === 'excellent' ? '#10b981' : connQuality === 'good' ? '#6366f1' : connQuality === 'poor' ? '#ef4444' : '#f59e0b';
  return <div className="rounded-2xl px-5 py-3 flex items-center justify-between gap-4 flex-wrap" style={{
    background: lowNetwork ? 'linear-gradient(90deg, rgba(245,158,11,0.1) 0%, rgba(239,68,68,0.08) 100%)' : 'linear-gradient(90deg, rgba(14,165,233,0.1) 0%, rgba(16,185,129,0.08) 100%)',
    border: `1px solid ${lowNetwork ? 'rgba(245,158,11,0.35)' : 'rgba(34,211,238,0.28)'}`,
    backdropFilter: 'blur(12px)',
    boxShadow: lowNetwork ? '0 0 30px rgba(245,158,11,0.14)' : '0 0 30px rgba(14,165,233,0.14)'
  }}>
      {/* Left — mode label */}
      <div className="flex items-center gap-4">
        {/* Animated signal bars icon */}
        <div className="flex items-end gap-0.5 h-6" aria-hidden="true">
          {[3, 5, 7, 9].map((h, i) => <div key={i} className="w-1 rounded-sm transition-all duration-500" style={{
          height: `${lowNetwork && i > 1 ? Math.max(3, h * 0.4) : h}px`,
          background: lowNetwork ? i < 2 ? '#f59e0b' : 'rgba(245,158,11,0.2)' : `hsl(${145 + i * 15}, 70%, 55%)`,
          opacity: isStreaming ? 1 : 0.5
        }} />)}
        </div>

        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold" style={{
            color: lowNetwork ? '#fbbf24' : '#a5b4fc'
          }}>
              {modeLabel}
            </span>
            {lowNetwork && isStreaming && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{
            background: 'rgba(245,158,11,0.15)',
            border: '1px solid rgba(245,158,11,0.3)',
            color: '#fbbf24'
          }}>
                BOOSTED
              </span>}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">{modeDesc}</div>
        </div>
      </div>

      {/* Center — quality pills */}
      <div className="flex items-center gap-3 flex-wrap">
        {connQuality && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{
        background: `${qualColor}18`,
        border: `1px solid ${qualColor}40`,
        color: qualColor
      }}>
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {connQuality.charAt(0).toUpperCase() + connQuality.slice(1)} Quality
          </div>}
        {netType && <div className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{
        background: 'rgba(148,163,184,0.07)',
        border: '1px solid rgba(148,163,184,0.12)',
        color: '#64748b'
      }}>
            {netType.toUpperCase()}
          </div>}
        {streamCodec && <div className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{
        background: 'rgba(99,102,241,0.1)',
        border: '1px solid rgba(99,102,241,0.2)',
        color: '#a5b4fc'
      }}>
            {streamCodec.toUpperCase()}
          </div>}
      </div>

      {/* Right — toggle button */}
      <button onClick={onForceToggle} disabled={disableToggle} className="ml-auto shrink-0 text-xs font-bold px-4 py-2 rounded-xl transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2" style={{
      background: lowNetwork ? 'rgba(245,158,11,0.15)' : 'rgba(14,165,233,0.14)',
      border: `1px solid ${lowNetwork ? 'rgba(245,158,11,0.35)' : 'rgba(34,211,238,0.42)'}`,
      color: lowNetwork ? '#fbbf24' : '#67e8f9'
    }} onMouseEnter={e => {
      if (disableToggle) return;
      e.currentTarget.style.transform = 'scale(1.03)';
    }} onMouseLeave={e => {
      if (disableToggle) return;
      e.currentTarget.style.transform = 'scale(1)';
    }}>
        <span>{isPending ? 'Working...' : lowNetwork ? '▲ Switch to HQ' : '▼ Force Low-BW'}</span>
        <CommandStatusPill status={status} />
      </button>
    </div>;
}
const COMMAND_STATUS_META = {
  pending: {
    label: 'Pending',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.16)',
    border: 'rgba(245,158,11,0.35)'
  },
  sent: {
    label: 'Sent',
    color: '#34d399',
    bg: 'rgba(16,185,129,0.16)',
    border: 'rgba(16,185,129,0.35)'
  },
  ack: {
    label: 'Ack',
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.16)',
    border: 'rgba(167,139,250,0.35)'
  },
  error: {
    label: 'Error',
    color: '#f87171',
    bg: 'rgba(239,68,68,0.16)',
    border: 'rgba(239,68,68,0.35)'
  }
};
const normalizeCommandStatus = status => {
  if (status === 'sending' || status === 'queued') return 'pending';
  if (status === 'success') return 'ack';
  return status;
};
function CommandStatusPill({
  status
}) {
  const meta = COMMAND_STATUS_META[normalizeCommandStatus(status)];
  if (!meta) return null;
  return <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{
    background: meta.bg,
    border: `1px solid ${meta.border}`,
    color: meta.color
  }}>
      <span className="w-1 h-1 rounded-full bg-current" />
      {meta.label}
    </span>;
}