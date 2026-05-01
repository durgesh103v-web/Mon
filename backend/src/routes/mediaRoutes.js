const express = require("express");
const fs = require("fs");
const path = require("path");
const { PHOTOS_DIR, RECORDINGS_DIR } = require("../config");
const { optionalAuth } = require("../middleware/auth");

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mkv":
      return "video/x-matroska";
    case ".3gp":
      return "video/3gpp";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
    case ".aac":
      return "audio/aac";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function registerMediaRoutes(app) {
  app.use("/photos", express.static(PHOTOS_DIR));
  app.use("/recordings", express.static(RECORDINGS_DIR));

  app.get("/file", optionalAuth, (req, res) => {
    try {
      const rawPath = String(req.query.path || "");
      if (!rawPath) {
        return res.status(400).send("Missing path");
      }

      const decodedPath = decodeURIComponent(rawPath.replace(/\+/g, " "));
      const baseDir = path.resolve(process.env.FILE_STREAM_BASE_DIR || "/storage/emulated/0");
      const resolvedPath = path.resolve(decodedPath);

      if (resolvedPath !== baseDir && !resolvedPath.startsWith(`${baseDir}${path.sep}`)) {
        return res.status(403).send("Forbidden");
      }

      if (!fs.existsSync(resolvedPath)) {
        return res.status(404).send("File not found");
      }

      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return res.status(400).send("Not a file");
      }

      const fileSize = stat.size;
      const range = req.headers.range;
      const contentType = contentTypeFor(resolvedPath);

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
          return res.status(416).send("Invalid range");
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": contentType,
        });
        fs.createReadStream(resolvedPath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(resolvedPath).pipe(res);
    } catch (err) {
      console.error("/file error:", err);
      return res.status(500).send("Server error");
    }
  });
}

module.exports = {
  registerMediaRoutes,
};
