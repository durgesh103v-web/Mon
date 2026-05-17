const express = require("express");
const path = require("path");
const multer = require("multer");
const apiController = require("../controllers/apiController");
const { optionalAuth } = require("../middleware/auth");
const { PHOTOS_DIR, RECORDINGS_DIR } = require("../config");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, PHOTOS_DIR);
  },
  filename: function (req, file, cb) {
    // Prevent path traversal by extracting just the basename
    const safeName = path.basename(file.originalname);
    cb(null, safeName);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only images allowed"), false);
    }
    cb(null, true);
  }
});

const recordingStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, RECORDINGS_DIR);
  },
  filename: function (req, file, cb) {
    const safeName = path.basename(file.originalname || file.filename || "recording.m4a");
    cb(null, safeName);
  }
});

const uploadRecording = multer({
  storage: recordingStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

const router = express.Router();

router.get("/devices", optionalAuth, apiController.listDevices);

router.get("/photos", apiController.listPhotos);
router.get("/version", apiController.versionInfo);
router.get("/version-diagnostics", optionalAuth, apiController.versionDiagnostics);
router.post("/cache-apk-checksum", apiController.cacheApkChecksum);
router.get("/provisioning-qr", apiController.provisioningQr);
router.get("/sync", optionalAuth, apiController.sync);
router.post("/heartbeat", optionalAuth, apiController.heartbeat);
router.get("/heartbeat", optionalAuth, apiController.heartbeat);

// Commands & Photos
router.post("/devices/:deviceId/command", optionalAuth, apiController.sendCommand);
router.post("/upload-photo", optionalAuth, upload.single("photo"), apiController.uploadPhoto);
router.post("/upload-recording", optionalAuth, uploadRecording.single("recording"), apiController.uploadRecording);
router.get("/recordings", optionalAuth, apiController.listRecordings);
router.delete("/recordings/:filename", optionalAuth, apiController.deleteRecording);

module.exports = router;
