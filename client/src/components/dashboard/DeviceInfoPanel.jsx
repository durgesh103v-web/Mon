import { useEffect, useRef, memo } from 'react';

// ── Mini metric card ───────────────────────────────────────────────────────
function MetricCard({ label, value, color = 'default', glow = false }) {
  const colors = {
    green: { text: '#10b981', bg: 'rgba(16,185,129,0.06)', border: 'rgba(16,185,129,0.18)', glow: 'rgba(16,185,129,0.12)' },
    yellow: { text: '#f59e0b', bg: 'rgba(245,158,11,0.06)', border: 'rgba(245,158,11,0.18)', glow: 'rgba(245,158,11,0.12)' },
    red: { text: '#ef4444', bg: 'rgba(239,68,68,0.06)', border: 'rgba(239,68,68,0.18)', glow: 'rgba(239,68,68,0.12)' },
    blue: { text: '#60a5fa', bg: 'rgba(96,165,250,0.06)', border: 'rgba(96,165,250,0.18)', glow: 'rgba(96,165,250,0.12)' },
    violet: { text: '#a78bfa', bg: 'rgba(167,139,250,0.06)', border: 'rgba(167,139,250,0.18)', glow: 'rgba(167,139,250,0.12)' },
    default: { text: '#71717a', bg: 'rgba(113,113,122,0.04)', border: 'rgba(113,113,122,0.1)', glow: 'transparent' },
  };
  const c = colors[color];
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 12,
      background: c.bg, border: `1px solid ${c.border}`,
      boxShadow: 'none',
    }}>
      <span style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, color: '#52525b' }}>
        {label}
      </span>
      <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1, color: c.text }}>
        {value ?? '—'}
      </span>
    </div>
  );
}

// ── Waveform visualizer ────────────────────────────────────────────────────
function Waveform({ data, isPlaying }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const centerY = height / 2;
    ctx.clearRect(0, 0, width, height);

    const numBars = 32;
    const barWidth = width / numBars;

    if (!data || data.length === 0) {
      for (let i = 0; i < numBars; i++) {
        const idle = isPlaying ? 4 : 2;
        ctx.fillStyle = 'rgba(99,102,241,0.12)';
        ctx.beginPath();
        ctx.roundRect(i * barWidth + 1, centerY - idle / 2, barWidth - 2, idle, 2);
        ctx.fill();
      }
      return;
    }

    let maxAmp = 0.05;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > maxAmp) maxAmp = v;
    }

    const chunkSize = Math.floor(data.length / numBars);
    for (let i = 0; i < numBars; i++) {
      let sumSq = 0;
      const start = i * chunkSize;
      for (let j = 0; j < chunkSize; j++) {
        const val = data[start + j] || 0;
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / chunkSize);
      const normalized = rms / maxAmp;
      const center = numBars / 2;
      const eqMultiplier = 1 - Math.pow((i - center) / center, 2) * 0.4;
      let barHeight = normalized * height * 0.85 * eqMultiplier;
      barHeight = Math.max(3, Math.min(barHeight, height * 0.92));

      const intensity = normalized;
      const hue = 145 + intensity * 100;
      const sat = 65 + intensity * 20;
      const lit = 45 + intensity * 15;
      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lit}%, ${0.65 + intensity * 0.35})`;
      ctx.beginPath();
      ctx.roundRect(
        i * barWidth + Math.max(1, barWidth * 0.12),
        centerY - barHeight / 2,
        Math.max(1, barWidth * 0.76),
        barHeight, 3
      );
      ctx.fill();
    }
  }, [data, isPlaying]);

  return (
    <div style={{
      position: 'relative', height: 64, borderRadius: 12, overflow: 'hidden',
      background: 'rgba(6,8,18,0.5)',
      border: '1px solid rgba(99,102,241,0.1)',
      boxShadow: 'none',
    }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {isPlaying && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'linear-gradient(90deg, rgba(6,8,18,0.5) 0%, transparent 10%, transparent 90%, rgba(6,8,18,0.5) 100%)',
        }} />
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
export const DeviceInfoPanel = memo(function DeviceInfoPanel({ device, audioState }) {
  if (!device) {
    return (
      <div className="glass-card" style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.2 }}>📱</div>
        <div style={{ fontSize: 13, color: '#52525b' }}>No device selected</div>
      </div>
    );
  }

  const health = device.health || {};
  const isStreaming = audioState?.isPlaying || false;
  const isLowNetwork = health.lowNetwork === true;
  const qualityColor = health.connQuality === 'excellent' ? 'green'
    : health.connQuality === 'good' ? 'blue'
    : health.connQuality === 'poor' ? 'red' : 'yellow';

  return (
    <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>

      {/* Device header */}
      <div style={{
        padding: '14px 18px',
        background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.05))',
        borderBottom: '1px solid rgba(99,102,241,0.1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                background: health.wsConnected ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.08)',
                border: `1px solid ${health.wsConnected ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.2)'}`,
              }}>📱</div>
              <span style={{
                position: 'absolute', bottom: -2, right: -2,
                width: 10, height: 10, borderRadius: '50%',
                border: '2px solid #0c1020',
                background: health.wsConnected ? '#10b981' : '#f59e0b',
                animation: health.wsConnected ? 'none' : 'beatBar 0.8s ease-in-out infinite alternate',
              }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: '#e4e4e7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {device.deviceId}
              </div>
              <div style={{ fontSize: 10, color: '#71717a', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {device.model || 'Unknown'} · SDK {device.sdk || '?'} · v{device.appVersionName || '?'}
                <span style={{ color: '#3f3f46' }}> ({device.appVersionCode || '?'})</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
            {isStreaming && <Badge color="green" dot pulse>LIVE</Badge>}
            {isLowNetwork && <Badge color="yellow" dot>LOW-BW</Badge>}
            {health.callActive && <Badge color="red" dot pulse>ON CALL</Badge>}
            {!isStreaming && !health.callActive && <Badge color="gray">IDLE</Badge>}
          </div>
        </div>
      </div>

      {/* Metrics grid */}
      <div style={{ padding: 14 }}>
        <div style={{
          display: 'grid', gap: 6,
          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
          marginBottom: 14,
        }}>
          <MetricCard label="WebSocket" value={health.wsConnected ? 'Connected' : 'Disconnected'} color={health.wsConnected ? 'green' : 'red'} glow={health.wsConnected} />
          <MetricCard label="Dashboard" value={health.dashboardConnected ? 'Online' : 'Offline'} color={health.dashboardConnected ? 'green' : 'red'} />
          <MetricCard label="Mic Capture" value={health.micCapturing ? 'Running' : 'Stopped'} color={health.micCapturing ? 'green' : 'red'} />
          <MetricCard label="Camera Capture" value={health.cameraCapturing ? 'Running' : 'Stopped'} color={health.cameraCapturing ? 'green' : 'default'} />
          <MetricCard label="Accessibility" value={health.accessibilityConnected ? 'Online' : 'Offline'} color={health.accessibilityConnected ? 'green' : 'red'} />
          <MetricCard label="Conn Quality" value={health.connQuality || '—'} color={qualityColor} />
          <MetricCard label="Network" value={health.internetOnline ? `Online${health.netType ? ` · ${health.netType.toUpperCase()}` : ''}` : 'Offline'} color={health.internetOnline ? 'green' : 'red'} />
          <MetricCard label="Voice Profile" value={health.voiceProfile ? health.voiceProfile.charAt(0).toUpperCase() + health.voiceProfile.slice(1) : '—'} color={health.voiceProfile === 'far' ? 'yellow' : health.voiceProfile === 'near' ? 'blue' : 'default'} />
          <MetricCard label="Clean Far Voice" value={health.cleanFarVoice || health.voiceProfile === 'far' ? 'On' : 'Off'} color={health.cleanFarVoice || health.voiceProfile === 'far' ? 'green' : 'default'} />
          <MetricCard label="Low Network" value={health.lowNetwork ? 'On' : 'Off'} color={health.lowNetwork ? 'yellow' : 'default'} />
          <MetricCard label="Noise Gate" value={health.noiseGateActive ? 'Active' : 'Open'} color={health.noiseGateActive ? 'yellow' : 'green'} />
          <MetricCard label="Dropping Old Audio" value={health.droppingPackets || audioState?.droppingPackets ? 'Yes' : 'No'} color={health.droppingPackets || audioState?.droppingPackets ? 'red' : 'default'} />
          <MetricCard label="Hardware AGC" value={(health.agcMode || 'auto').toUpperCase()} color={health.agcMode === 'off' ? 'yellow' : 'default'} />
          <MetricCard label="Call Capture" value={`${health.callCaptureMode || 'mic'}${health.earpieceBoost && health.earpieceBoost !== 'off' ? ` ${health.earpieceBoost}` : ''}`} color={health.callCaptureMode === 'earpiece' ? 'yellow' : health.callCaptureMode === 'speaker' ? 'green' : 'default'} />
          <MetricCard label="Codec" value={health.codec || (health.streamCodec ? `${health.streamCodec.toUpperCase()} ${health.streamCodecMode || ''}` : '—')} color="violet" />
          <MetricCard label="Battery" value={health.batteryPct != null ? `${health.batteryPct}%${health.charging ? ' ⚡' : ''}` : '—'} color={health.batteryPct != null && health.batteryPct < 20 ? 'red' : health.batteryPct != null && health.batteryPct > 60 ? 'green' : 'yellow'} />
          <MetricCard label="Audio Latency" value={audioState?.latencyMs ? `${audioState.latencyMs}ms` : '—'} color={audioState?.latencyMs && audioState.latencyMs > 500 ? 'yellow' : 'default'} />
          <MetricCard label="Buffer Health" value={audioState?.bufferHealth !== undefined ? `${Math.round(audioState.bufferHealth * 100)}%` : '—'} color={audioState?.bufferHealth !== undefined && audioState.bufferHealth < 0.2 ? 'red' : 'default'} />
          <MetricCard label="MIC Level" value={health.micInLevel !== undefined ? `${health.micInLevel}%` : 'Active'} color="green" glow={isStreaming} />
        </div>

        {/* Waveform */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, color: '#818cf8' }}>
              Waveform
            </span>
            {isStreaming && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10b981', animation: 'beatBar 0.8s ease-in-out infinite alternate' }} />
                <span style={{ fontSize: 9, color: '#10b981', fontWeight: 600 }}>LIVE AUDIO</span>
              </div>
            )}
          </div>
          <Waveform data={audioState?.waveform || null} isPlaying={isStreaming} />
        </div>
      </div>
    </div>
  );
});

// ── Badge component ────────────────────────────────────────────────────────
function Badge({ children, color, dot = false, pulse = false }) {
  const colors = {
    green: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)', text: '#34d399' },
    blue: { bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.3)', text: '#60a5fa' },
    yellow: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)', text: '#fbbf24' },
    red: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', text: '#f87171' },
    gray: { bg: 'rgba(82,82,91,0.12)', border: 'rgba(82,82,91,0.3)', text: '#71717a' },
  };
  const c = colors[color];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 8,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
      background: c.bg, border: `1px solid ${c.border}`, color: c.text,
    }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', animation: pulse ? 'beatBar 0.8s ease-in-out infinite alternate' : 'none' }} />}
      {children}
    </span>
  );
}
