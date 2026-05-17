/**
 * Dashboard WebSocket client store
 *
 * Scalability note:
 * - Audio frames are heavy; we do NOT broadcast every device's audio to every dashboard.
 * - Each dashboard client maintains an "active audio subscription" (one deviceId) and
 *   the backend routes audio frames only to subscribed clients.
 */

const WebSocket = require("ws");

/** @type {Set<any>} */
const dashboardClients = new Set();

// ws -> deviceId (active audio subscription)
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
  audioSubscriptionByClient.set(ws, String(deviceId));
}

function clearAudioSubscription(ws) {
  if (!ws) return;
  audioSubscriptionByClient.delete(ws);
}

function getAudioSubscription(ws) {
  return audioSubscriptionByClient.get(ws) || null;
}

function forEachClientSubscribedToDevice(deviceId, callback) {
  if (!deviceId) return;
  const want = String(deviceId);
  dashboardClients.forEach((client) => {
    if (!client || client.readyState !== WebSocket.OPEN) return;
    const sub = audioSubscriptionByClient.get(client);
    if (sub === want) callback(client);
  });
}

function getSubscribersForDevice(deviceId) {
  const subscribers = [];
  if (!deviceId) return subscribers;
  const want = String(deviceId);
  dashboardClients.forEach((client) => {
    if (!client || client.readyState !== WebSocket.OPEN) return;
    if (audioSubscriptionByClient.get(client) === want) subscribers.push(client);
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
  clearAudioSubscription,
  getAudioSubscription,
  forEachClientSubscribedToDevice,
  getSubscribersForDevice,
};
