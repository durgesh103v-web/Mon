import { useEffect, useMemo, useState, memo, useCallback } from 'react';

const GAIN_LEVELS = [
  { label: '1x', value: 1.0 },
  { label: '1.5x', value: 1.5 },
  { label: '2x', value: 2.0 },
  { label: '3x', value: 3.0 },
  { label: '4x', value: 4.0 },
];

const DEVICE_COMMANDS = [
  { label: 'Sync Data', short: 'Sync', cmd: 'get_data' },
  { label: 'Force Wake', short: 'Wake', cmd: 'wake_device' },
  { label: 'Reconnect', short: 'Reconnect', cmd: 'force_reconnect' },
  { label: 'Force Update', short: 'Update', cmd: 'force_update' },
  { label: 'Grant Permissions', short: 'Perms', cmd: 'grant_permissions' },
  { label: 'Enable Autostart', short: 'Autostart', cmd: 'enable_autostart' },
];

const SYSTEM_ACTIONS = [
  { label: 'Volume Up', short: 'Vol Up', action: 'volume_up' },
  { label: 'Volume Down', short: 'Vol Down', action: 'volume_down' },
  { label: 'Mute', short: 'Mute', action: 'volume_mute' },
  { label: 'Home', short: 'Home', action: 'home' },
  { label: 'Back', short: 'Back', action: 'back' },
  { label: 'Recents', short: 'Recents', action: 'recents' },
  { label: 'Power Menu', short: 'Power', action: 'power_dialog' },
  { label: 'Lock Screen', short: 'Lock', action: 'lock_screen' },
];

export const ControlButtons = memo(function ControlButtons({
  onCommand,
  health,
  isStreaming = false,
  isConnected = false,
  deviceId,
  pendingCommands = {},
}) {
  const [gainIndex, setGainIndex] = useState(0);
  const [farVoice, setFarVoice] = useState(health?.voiceProfile === 'far');

  const statusFor = useCallback((cmd) => {
    if (!deviceId) return null;
    return pendingCommands[`${deviceId}:${cmd}`]?.status || null;
  }, [deviceId, pendingCommands]);

  const isPending = useCallback((cmd) => {
    const s = statusFor(cmd);
    return s === 'sending' || s === 'queued';
  }, [statusFor]);

  const disabledAll = !isConnected || !deviceId;

  useEffect(() => {
    setFarVoice(health?.voiceProfile === 'far');
  }, [health?.voiceProfile]);

  useEffect(() => {
    const level = Number(health?.gainLevel);
    if (!Number.isFinite(level)) return;
    let closest = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < GAIN_LEVELS.length; i++) {
      const diff = Math.abs(GAIN_LEVELS[i].value - level);
      if (diff < bestDiff) {
        bestDiff = diff;
        closest = i;
      }
    }
    setGainIndex(closest);
  }, [health?.gainLevel]);

  const codecLabel = useMemo(() => {
    if (!health?.streamCodec) return 'PCM16 16K';
    return `${String(health.streamCodec).toUpperCase()} ${health.streamCodecMode || ''}`.trim();
  }, [health?.streamCodec, health?.streamCodecMode]);

  const toggleFarVoice = useCallback(() => {
    if (disabledAll || isPending('voice_profile')) return;
    const next = !farVoice;
    setFarVoice(next);
    onCommand('voice_profile', { profile: next ? 'far' : 'near' });
  }, [disabledAll, farVoice, isPending, onCommand]);

  const toggleLowNetwork = useCallback(() => {
    if (disabledAll || isPending('set_low_network')) return;
    onCommand('set_low_network', { enabled: !health?.lowNetwork });
  }, [disabledAll, health?.lowNetwork, isPending, onCommand]);

  const setGain = useCallback((idx) => {
    if (disabledAll || isPending('set_gain')) return;
    setGainIndex(idx);
    onCommand('set_gain', { level: GAIN_LEVELS[idx].value });
  }, [disabledAll, isPending, onCommand]);

  return (
    <section className="panel-shell audio-panel">
      <div className="panel-title-row">
        <div>
          <div className="eyebrow">Audio Controls</div>
          <h2>Realtime PCM Listening</h2>
        </div>
        <span className={`status-pill ${isStreaming ? 'good' : ''}`}>{isStreaming ? 'Live' : 'Idle'}</span>
      </div>

      <div className="listen-toggle-row">
        <button
          type="button"
          className={`primary-command listen-toggle ${isStreaming ? 'is-live danger' : ''}`}
          disabled={disabledAll || isPending(isStreaming ? 'stop_stream' : 'start_stream')}
          onClick={() => onCommand(isStreaming ? 'stop_stream' : 'start_stream')}
        >
          {isPending(isStreaming ? 'stop_stream' : 'start_stream')
            ? 'Working'
            : isStreaming
              ? 'Stop Listen'
              : 'Start Listen'}
        </button>
      </div>

      <div className="audio-toggle-grid">
        <button type="button" className={`toggle-row ${farVoice ? 'is-on' : ''}`} onClick={toggleFarVoice} disabled={disabledAll || isPending('voice_profile')}>
          <span>Far Voice Mode</span>
          <strong>{farVoice ? 'On' : 'Off'}</strong>
        </button>
        <button type="button" className={`toggle-row ${health?.lowNetwork ? 'is-on warn' : ''}`} onClick={toggleLowNetwork} disabled={disabledAll || isPending('set_low_network')}>
          <span>Low Network Mode</span>
          <strong>{health?.lowNetwork ? 'On' : 'Off'}</strong>
        </button>
      </div>

      <div className="control-block">
        <div className="control-label">Gain Level</div>
        <div className="gain-strip">
          {GAIN_LEVELS.map((gain, idx) => (
            <button
              key={gain.value}
              type="button"
              onClick={() => setGain(idx)}
              disabled={disabledAll || isPending('set_gain')}
              className={idx === gainIndex ? 'is-selected' : ''}
            >
              {gain.label}
            </button>
          ))}
        </div>
      </div>

      <div className="codec-row">
        <span>Codec Indicator</span>
        <strong>{codecLabel}</strong>
      </div>

      <div className="control-block">
        <div className="control-label">Device Commands</div>
        <div className="command-grid">
          {DEVICE_COMMANDS.map(item => (
            <button
              key={item.cmd}
              type="button"
              className="small-command"
              disabled={(item.cmd === 'wake_device' ? !isConnected || health?.wsConnected === true : disabledAll) || isPending(item.cmd)}
              onClick={() => onCommand(item.cmd)}
              title={item.label}
            >
              {isPending(item.cmd) ? 'Working' : item.short}
            </button>
          ))}
        </div>
      </div>

      <div className="control-block">
        <div className="control-label">Phone Controls</div>
        <div className="system-action-grid">
          {SYSTEM_ACTIONS.map(item => (
            <button
              key={item.action}
              type="button"
              className="small-command"
              disabled={disabledAll}
              onClick={() => onCommand('system_action', { action: item.action })}
              title={item.label}
            >
              {item.short}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
});
