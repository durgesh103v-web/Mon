/**
 * Dashboard broadcast helpers
 */

const WebSocket = require("ws");
const { forEachClient } = require("../models/dashboardStore");
const { forEachClientSubscribedToDevice } = require("../models/dashboardStore");
const { DASHBOARD_MAX_BUFFERED_BYTES } = require("../config");

function safeSend(client, payload, maxBuffered = DASHBOARD_MAX_BUFFERED_BYTES) {
  if (!client || client.readyState !== WebSocket.OPEN) return false;
  if ((client.bufferedAmount || 0) > maxBuffered) return false;
  try {
    client.send(payload);
    return true;
  } catch (_) {
    return false;
  }
}

function broadcastToDashboard(jsonHeader, binaryData) {
  const text = JSON.stringify(jsonHeader);
  forEachClient((client) => {
    if (!safeSend(client, text)) return;
    if (binaryData) safeSend(client, binaryData, DASHBOARD_MAX_BUFFERED_BYTES * 2);
  });
}

function broadcastToDeviceSubscribers(deviceId, jsonHeader, binaryData) {
  if (!deviceId) return;
  const text = JSON.stringify(jsonHeader);
  forEachClientSubscribedToDevice(deviceId, (client) => {
    if (!safeSend(client, text)) return;
    if (binaryData) safeSend(client, binaryData, DASHBOARD_MAX_BUFFERED_BYTES * 2);
  });
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  safeSend(ws, JSON.stringify(payload));
}

module.exports = {
  broadcastToDashboard,
  broadcastToDeviceSubscribers,
  sendJson,
  safeSend,
};
