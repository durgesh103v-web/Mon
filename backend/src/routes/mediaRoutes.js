const express = require("express");
const { PHOTOS_DIR, RECORDINGS_DIR } = require("../config");
const { optionalAuth } = require("../middleware/auth");
const { requestFileStream } = require("../services/fileProxyService");

function registerMediaRoutes(app) {
  app.use("/photos", express.static(PHOTOS_DIR));
  app.use("/recordings", express.static(RECORDINGS_DIR));

  app.get("/file", optionalAuth, (req, res) => {
    const deviceId = String(req.query.deviceId || "");
    const rawPath = String(req.query.path || "");
    if (!deviceId) {
      return res.status(400).send("Missing deviceId");
    }
    if (!rawPath) {
      return res.status(400).send("Missing path");
    }

    const decodedPath = decodeURIComponent(rawPath.replace(/\+/g, " "));
    const range = req.headers.range || "";
    let rangeStart = null;
    let rangeEnd = null;
    if (range.startsWith("bytes=")) {
      const parts = range.replace(/bytes=/, "").split("-");
      rangeStart = parts[0] ? Number.parseInt(parts[0], 10) : null;
      rangeEnd = parts[1] ? Number.parseInt(parts[1], 10) : null;
    }

    const requestId = requestFileStream({
      deviceId,
      path: decodedPath,
      rangeStart,
      rangeEnd,
      download: String(req.query.download || "") === "1",
      res,
    });

    if (!requestId) {
      return;
    }
  });
}

module.exports = {
  registerMediaRoutes,
};
