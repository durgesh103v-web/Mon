/**
 * Server configuration and paths.
 */

const fs = require("fs");
const path = require("path");

function newestApkTimestampMs(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return -1;
    const apkFiles = fs
      .readdirSync(dirPath)
      .filter((fileName) => fileName.toLowerCase().endsWith(".apk"));
    if (apkFiles.length === 0) return -1;

    let newestTs = -1;
    for (const apk of apkFiles) {
      const fullPath = path.join(dirPath, apk);
      const st = fs.statSync(fullPath);
      if (st.mtimeMs > newestTs) newestTs = st.mtimeMs;
    }
    return newestTs;
  } catch (_e) {
    return -1;
  }
}

function resolveUpdatesDir() {
  if (process.env.UPDATES_DIR && process.env.UPDATES_DIR.trim()) {
    return path.resolve(process.env.UPDATES_DIR.trim());
  }

  const backendUpdatesDir = path.resolve(__dirname, "..", "..", "updates");
  const workspaceUpdatesDir = path.resolve(__dirname, "..", "..", "..", "updates");
  const candidates = [backendUpdatesDir, workspaceUpdatesDir];

  let bestDir = backendUpdatesDir;
  let bestTs = -1;
  for (const dirPath of candidates) {
    const ts = newestApkTimestampMs(dirPath);
    if (ts > bestTs) {
      bestTs = ts;
      bestDir = dirPath;
    }
  }

  if (bestTs >= 0) return bestDir;
  return fs.existsSync(backendUpdatesDir) ? backendUpdatesDir : workspaceUpdatesDir;
}

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 5050,
  NODE_ENV: process.env.NODE_ENV || "development",
  DASHBOARD_MAX_BUFFERED_BYTES: 32 * 1024,
  HEARTBEAT_INTERVAL_MS: 15_000,
  SELF_PING_INTERVAL_MS: 14 * 60 * 1000,
  WS_AUTH_TOKEN: process.env.WS_AUTH_TOKEN || null,
  PHOTOS_DIR: path.join(__dirname, "..", "..", "photos"),
  UPDATES_DIR: resolveUpdatesDir(),
  CLIENT_DIST_DIR: path.resolve(__dirname, "..", "..", "..", "client", "dist"),
  LEGACY_DASHBOARD: path.join(__dirname, "..", "..", "index.html"),
};
