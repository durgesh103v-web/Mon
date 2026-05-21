/**
 * Dashboard WebSocket client store
 *
 * Scalability note:
 * - Audio frames are heavy; we do NOT broadcast every device's audio to every dashboard.
 * - Each dashboard client can subscribe to one or more device streams.
 *   The backend routes audio frames only to clients subscribed to that device.
 */

const WebSocket = require("ws");

/** @type {Set<any>} */
const dashboardClients = new Set();

// ws -> Set<deviceId> (audio subscriptions)
const audioSubscriptionByClient = new Map();

function addClient(ws) {
  dashboardClients.add(ws);
}

function removeClient(ws) {
  dashboardClients.delete(ws);
  audioSubscriptionByClient.delete(ws);
}

function size() {
  return dashboardClients.size;
}

function forEachClient(callback) {
  dashboardClients.forEach(callback);
}

function setAudioSubscription(ws, deviceId) {
  if (!ws) return;
  if (!deviceId) {
    audioSubscriptionByClient.delete(ws);
    return;
  }
  audioSubscriptionByClient.set(ws, new Set([String(deviceId)]));
}

function addAudioSubscription(ws, deviceId) {
  if (!ws || !deviceId) return;
  const set = audioSubscriptionByClient.get(ws) || new Set();
  set.add(String(deviceId));
  audioSubscriptionByClient.set(ws, set);
}

function removeAudioSubscription(ws, deviceId) {
  if (!ws) return;
  if (!deviceId) {
    audioSubscriptionByClient.delete(ws);
    return;
  }
  const set = audioSubscriptionByClient.get(ws);
  if (!set) return;
  set.delete(String(deviceId));
  if (set.size === 0) audioSubscriptionByClient.delete(ws);
}

function clearAudioSubscription(ws) {
  if (!ws) return;
  audioSubscriptionByClient.delete(ws);
}

function getAudioSubscription(ws) {
  const set = audioSubscriptionByClient.get(ws);
  if (!set || set.size === 0) return null;
  return Array.from(set)[0] || null;
}

function getAudioSubscriptions(ws) {
  const set = audioSubscriptionByClient.get(ws);
  return set ? Array.from(set) : [];
}

function isClientSubscribedToDevice(ws, deviceId) {
  if (!ws || !deviceId) return false;
  return audioSubscriptionByClient.get(ws)?.has(String(deviceId)) === true;
}

function forEachClientSubscribedToDevice(deviceId, callback) {
  if (!deviceId) return;
  const want = String(deviceId);
  dashboardClients.forEach((client) => {
    if (!client || client.readyState !== WebSocket.OPEN) return;
    const sub = audioSubscriptionByClient.get(client);
    if (sub?.has(want)) callback(client);
  });
}

function getSubscribersForDevice(deviceId) {
  const subscribers = [];
  if (!deviceId) return subscribers;
  const want = String(deviceId);
  dashboardClients.forEach((client) => {
    if (!client || client.readyState !== WebSocket.OPEN) return;
    if (audioSubscriptionByClient.get(client)?.has(want)) subscribers.push(client);
  });
  return subscribers;
}

module.exports = {
  addClient,
  removeClient,
  size,
  forEachClient,
  dashboardClients,
  setAudioSubscription,
  addAudioSubscription,
  removeAudioSubscription,
  clearAudioSubscription,
  getAudioSubscription,
  getAudioSubscriptions,
  isClientSubscribedToDevice,
  forEachClientSubscribedToDevice,
  getSubscribersForDevice,
};
