/**
 * Photo upload and storage service
 */

const fs = require("fs");
const path = require("path");
const { PHOTOS_DIR } = require("../config");

function saveUploadedPhoto(deviceId, payload) {
  try {
    const base64 = String(payload?.data || "").trim();
    if (!base64) return null;
    const raw = Buffer.from(base64, "base64");
    if (!raw.length) return null;
    const safeDevice =
      String(deviceId || "unknown")
        .replace(/[^a-z0-9_-]/gi, "")
        .slice(0, 16) || "unknown";
    const reqName = String(payload?.filename || "").replace(
      /[^a-z0-9._-]/gi,
      "",
    );
    const ext = /\.(png)$/i.test(reqName) ? ".png" : ".jpg";
    const payloadType = String(payload?.type || "").toLowerCase();
    const requestedCamera = String(payload?.camera || "").toLowerCase();
    const camera =
      payloadType === "screenshot_upload" || /^screenshot_/i.test(reqName)
        ? "screenshot"
        : requestedCamera === "front"
          ? "front"
          : "rear";
    const ts = Number(payload?.ts) || Date.now();
    const filename = reqName || `photo_${safeDevice}_${camera}_${ts}${ext}`;
    const filepath = path.join(PHOTOS_DIR, filename);
    fs.writeFileSync(filepath, raw);
    return {
      filename,
      size: raw.length,
      camera,
      quality: ["fast", "normal", "hd"].includes(
        String(payload?.quality || "normal").toLowerCase(),
      )
        ? String(payload?.quality || "normal").toLowerCase()
        : "normal",
      nightMode: String(payload?.nightMode || "off").toLowerCase(),
      aiEnhanced: payload?.aiEnhanced === true,
      ts,
    };
  } catch (err) {
    console.error(`❌ Failed to save photo from ${deviceId}:`, err.message);
    return null;
  }
}

module.exports = {
  saveUploadedPhoto,
};
