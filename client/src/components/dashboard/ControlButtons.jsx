import { useEffect, useMemo, useState, memo, useCallback } from 'react';

const GAIN_LEVELS = [
  { label: '1× Normal', value: 1.0, color: '#a1a1aa', bg: '#27272a' },
  { label: '1.5× Boost', value: 1.5, color: '#bae6fd', bg: '#0c4a6e' },
  { label: '2× Loud', value: 2.0, color: '#6ee7b7', bg: '#064e3b' },
  { label: '3× Max', value: 3.0, color: '#fde68a', bg: '#78350f' },
  { label: '4× Ultra', value: 4.0, color: '#fecaca', bg: '#7f1d1d' },
];

const VOICE_PROFILES = ['near', 'room', 'far'];
const VOICE_META = {
  near: { icon: '🎙', label: 'Near', color: '#60a5fa', bg: '#1e3a5f' },
  room: { icon: '🔊', label: 'Room', color: '#a5b4fc', bg: '#312e81' },
  far: { icon: '📢', label: 'Far', color: '#fbbf24', bg: '#78350f' },
};

export const ControlButtons = memo(function ControlButtons({
  onCommand,
  health,
  isStreaming = false,
  isConnected = false,
  deviceId,
  pendingCommands = {},
}) {
  const [voiceProfile, setVoiceProfile] = useState(health?.voiceProfile || 'near');
  const [gainIndex, setGainIndex] = useState(0);

  const statusFor = useCallback((cmd) => {
    if (!deviceId) return null;
    return pendingCommands[`${deviceId}:${cmd}`]?.status || null;
  }, [deviceId, pendingCommands]);

  const isPending = useCallback((cmd) => {
    const s = statusFor(cmd);
    return s === 'sending' || s === 'queued';
  }, [statusFor]);

  const disabledAll = !isConnected || !deviceId;

  // Sync voice profile from device health
  useEffect(() => {
    if (health?.voiceProfile && VOICE_PROFILES.includes(health.voiceProfile)) {
      setVoiceProfile(health.voiceProfile);
    }
  }, [health?.voiceProfile]);

  // Sync gain from device health
  useEffect(() => {
    const level = Number(health?.gainLevel);
    if (!Number.isFinite(level)) return;
    let closest = 0, bestDiff = Infinity;
    for (let i = 0; i < GAIN_LEVELS.length; i++) {
      const diff = Math.abs(GAIN_LEVELS[i].value - level);
      if (diff < bestDiff) { bestDiff = diff; closest = i; }
    }
    setGainIndex(prev => prev === closest ? prev : closest);
  }, [health?.gainLevel]);

  const cycleVoice = useCallback(() => {
    if (disabledAll || isPending('voice_profile')) return;
    const next = VOICE_PROFILES[(VOICE_PROFILES.indexOf(voiceProfile) + 1) % VOICE_PROFILES.length];
    setVoiceProfile(next);
    onCommand('voice_profile', { profile: next });
  }, [disabledAll, isPending, voiceProfile, onCommand]);

  const cycleGain = useCallback(() => {
    if (disabledAll || isPending('set_gain')) return;
    const nextIdx = (gainIndex + 1) % GAIN_LEVELS.length;
    setGainIndex(nextIdx);
    onCommand('set_gain', { level: GAIN_LEVELS[nextIdx].value });
  }, [disabledAll, isPending, gainIndex, onCommand]);

  const gain = GAIN_LEVELS[gainIndex];
  const voice = VOICE_META[voiceProfile];
  const codecLabel = health?.streamCodec
    ? `${health.streamCodec.toUpperCase()}${health.streamCodecMode ? ` ${health.streamCodecMode}` : ''}`
    : 'PCM';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Audio Section ─────────────────────────────── */}
      <SectionHead icon="🎙" label="Audio Controls" />

      {/* Listen Toggle */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <ActionBtn
          icon={isStreaming ? '⏹' : '🎧'}
          label={isPending(isStreaming ? 'stop_stream' : 'start_stream') ? 'Working...' : isStreaming ? 'Stop Listen' : 'Start Listen'}
          onClick={() => onCommand(isStreaming ? 'stop_stream' : 'start_stream')}
          active={isStreaming}
          activeColor="#10b981"
          inactiveColor="#27272a"
          disabled={disabledAll || isPending(isStreaming ? 'stop_stream' : 'start_stream')}
        />
        <ActionBtn
          icon={voice.icon}
          label={`Voice: ${voice.label}`}
          onClick={cycleVoice}
          active={voiceProfile !== 'near'}
          activeColor={voice.bg}
          activeBorder={voice.color}
          inactiveColor="#27272a"
          disabled={disabledAll || isPending('voice_profile')}
          subtitle="Tap to cycle"
        />
      </div>

      {/* Gain Row */}
      <button
        onClick={cycleGain}
        disabled={disabledAll || isPending('set_gain')}
        style={{
          width: '100%', padding: '10px 14px', borderRadius: 12,
          background: gain.bg, border: `1px solid ${gain.color}45`,
          color: gain.color, cursor: disabledAll ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 11, fontWeight: 700, transition: 'all 0.2s',
          opacity: (disabledAll || isPending('set_gain')) ? 0.5 : 1,
        }}
      >
        <span style={{ fontSize: 16 }}>🔊</span>
        <span style={{ flex: 1, textAlign: 'left' }}>Gain: {gain.label}</span>
        <div style={{ display: 'flex', alignItems: 'end', gap: 2, height: 16 }}>
          {GAIN_LEVELS.map((_, i) => (
            <div key={i} style={{
              width: 4, borderRadius: 2, transition: 'all 0.3s',
              height: `${20 + i * 20}%`, minHeight: 4,
              background: i <= gainIndex ? gain.color : `${gain.color}25`,
            }} />
          ))}
        </div>
        <span style={{ fontSize: 9, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Tap to cycle
        </span>
      </button>

      {/* Codec indicator */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 12px', borderRadius: 8,
        background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.12)',
      }}>
        <span style={{ fontSize: 10, color: '#71717a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Codec
        </span>
        <span style={{ fontSize: 11, color: '#a5b4fc', fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>
          {codecLabel}
        </span>
        {health?.lowNetwork && (
          <span style={{
            fontSize: 9, padding: '2px 6px', borderRadius: 6,
            background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.25)',
            color: '#fbbf24', fontWeight: 700, textTransform: 'uppercase',
          }}>Low-BW</span>
        )}
      </div>

      {/* ── System Section ────────────────────────────── */}
      <SectionHead icon="⚙️" label="System" />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <SmallBtn icon="⚡" label={isPending('wake_device') ? 'Waking...' : 'Force Wake'}
          onClick={() => onCommand('wake_device')} color="#f59e0b"
          disabled={!isConnected || health?.wsConnected === true || isPending('wake_device')}
          active={health?.wsConnected === false}
        />
        <SmallBtn icon="📥" label={isPending('get_data') ? 'Syncing...' : 'Sync Data'}
          onClick={() => onCommand('get_data')} color="#38bdf8"
          disabled={disabledAll || isPending('get_data')}
        />
        <SmallBtn icon="⬆️" label={isPending('force_update') ? 'Updating...' : 'Force Update'}
          onClick={() => onCommand('force_update')} color="#818cf8"
          disabled={disabledAll || isPending('force_update')}
        />
        <SmallBtn icon="🔐" label={isPending('grant_permissions') ? 'Granting...' : 'Grant Perms'}
          onClick={() => onCommand('grant_permissions')} color="#818cf8"
          disabled={disabledAll || isPending('grant_permissions')}
        />
        <SmallBtn icon="🚀" label={isPending('enable_autostart') ? 'Enabling...' : 'Autostart'}
          onClick={() => onCommand('enable_autostart')} color="#fb923c"
          disabled={disabledAll || isPending('enable_autostart')}
        />
      </div>

      {/* ── Device Control ─────────────────────────────── */}
      <SectionHead icon="🎮" label="Device" />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <SmallBtn icon="🔊" label="Vol Up" onClick={() => onCommand('system_action', { action: 'volume_up' })} color="#34d399" disabled={disabledAll} />
        <SmallBtn icon="🔉" label="Vol Down" onClick={() => onCommand('system_action', { action: 'volume_down' })} color="#fbbf24" disabled={disabledAll} />
        <SmallBtn icon="🔇" label="Mute" onClick={() => onCommand('system_action', { action: 'volume_mute' })} color="#f87171" disabled={disabledAll} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <SmallBtn icon="🏠" label="Home" onClick={() => onCommand('system_action', { action: 'home' })} color="#60a5fa" disabled={disabledAll} />
        <SmallBtn icon="◀️" label="Back" onClick={() => onCommand('system_action', { action: 'back' })} color="#a78bfa" disabled={disabledAll} />
        <SmallBtn icon="🗂" label="Recents" onClick={() => onCommand('system_action', { action: 'recents' })} color="#c084fc" disabled={disabledAll} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <SmallBtn icon="⏻" label="Power" onClick={() => onCommand('system_action', { action: 'power_dialog' })} color="#fb923c" disabled={disabledAll} />
        <SmallBtn icon="🔒" label="Lock" onClick={() => onCommand('system_action', { action: 'lock_screen' })} color="#f43f5e" disabled={disabledAll} />
      </div>
    </div>
  );
});

// ── Sub-components ─────────────────────────────────────

function SectionHead({ icon, label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      marginBottom: 2, marginTop: 4,
    }}>
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: '#22d3ee',
      }}>{label}</span>
      <span style={{
        flex: 1, height: 1,
        background: 'linear-gradient(90deg, rgba(34,211,238,0.35), transparent)',
      }} />
    </div>
  );
}

function ActionBtn({
  icon, label, onClick, active, activeColor, activeBorder,
  inactiveColor, disabled, subtitle,
}) {
  const bg = active ? activeColor : inactiveColor;
  const border = active ? (activeBorder || activeColor) : '#3f3f46';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '12px 10px', borderRadius: 12, display: 'flex',
        flexDirection: 'column', alignItems: 'center', gap: 4,
        background: bg, border: `1px solid ${border}`,
        color: active ? '#fff' : '#a1a1aa', cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.2s', opacity: disabled ? 0.5 : 1,
        boxShadow: active ? `0 0 20px ${activeColor}55` : 'none',
      }}
    >
      <span style={{ fontSize: 20 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center', lineHeight: 1.2 }}>
        {label}
      </span>
      {subtitle && (
        <span style={{ fontSize: 8, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {subtitle}
        </span>
      )}
    </button>
  );
}

function SmallBtn({ icon, label, onClick, color, active = false, disabled = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 6px', borderRadius: 10, display: 'flex',
        alignItems: 'center', gap: 6, width: '100%',
        background: active ? `${color}18` : 'rgba(30,30,35,0.5)',
        border: `1px solid ${active ? `${color}40` : 'rgba(63,63,70,0.35)'}`,
        color: active ? color : '#71717a', cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.05em', transition: 'all 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
