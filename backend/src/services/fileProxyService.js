const { sendJsonToDevice } = require("./deviceService");

const pendingStreams = new Map();

function buildRequestId() {
  return `file_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function cleanupRequest(requestId) {
  const entry = pendingStreams.get(requestId);
  if (!entry) return;
  if (entry.timeout) {
    clearTimeout(entry.timeout);
  }
  pendingStreams.delete(requestId);
}

function failRequest(requestId, status, message) {
  const entry = pendingStreams.get(requestId);
  if (!entry) return;
  if (!entry.res.headersSent) {
    entry.res.status(status).send(message);
  } else {
    entry.res.end();
  }
  cleanupRequest(requestId);
}

function requestFileStream({ deviceId, path, rangeStart, rangeEnd, download, res }) {
  const requestId = buildRequestId();
  const entry = {
    requestId,
    deviceId,
    path,
    rangeStart: Number.isFinite(rangeStart) ? rangeStart : null,
    rangeEnd: Number.isFinite(rangeEnd) ? rangeEnd : null,
    download: download === true,
    res,
    headersSent: false,
    fileSize: null,
    mime: null,
    bytesSent: 0,
    timeout: null,
  };

  entry.timeout = setTimeout(() => {
    failRequest(requestId, 504, "File stream timed out");
  }, 30_000);

  pendingStreams.set(requestId, entry);

  res.on("close", () => {
    cleanupRequest(requestId);
  });

  console.log("Sending file_stream_start:", { deviceId, requestId, path });

  const sent = sendJsonToDevice(deviceId, {
    type: "file_stream_start",
    requestId,
    path,
    rangeStart: entry.rangeStart,
    rangeEnd: entry.rangeEnd,
  });

  if (!sent) {
    failRequest(requestId, 404, "Device not connected");
    return null;
  }

  return requestId;
}

function contentDispositionFilename(value) {
  return String(value || "download")
    .replace(/[\r\n"]/g, "_")
    .slice(0, 180) || "download";
}

function handleFileInfo(payload) {
  const requestId = String(payload.requestId || "");
  const entry = pendingStreams.get(requestId);
  if (!entry) return;

  if (payload.status && payload.status !== "ok") {
    const message = payload.error || "File error";
    failRequest(requestId, 404, message);
    return;
  }

  entry.fileSize = Number(payload.size || 0);
  entry.mime = String(payload.mime || "application/octet-stream");

  let start = entry.rangeStart ?? 0;
  let end = entry.rangeEnd ?? (entry.fileSize > 0 ? entry.fileSize - 1 : null);

  if (start < 0 || (end !== null && end < start)) {
    failRequest(requestId, 416, "Invalid range");
    return;
  }

  if (!entry.res.headersSent) {
    if (entry.rangeStart !== null || entry.rangeEnd !== null) {
      if (end === null) {
        end = entry.fileSize > 0 ? entry.fileSize - 1 : start;
      }
      const chunkSize = entry.fileSize > 0 ? (end - start + 1) : undefined;
      const headers = {
        "Content-Type": entry.mime,
        "Accept-Ranges": "bytes",
      };
      if (entry.download) {
        headers["Content-Disposition"] = `attachment; filename="${contentDispositionFilename(entry.path.split(/[\\/]/).pop())}"`;
      }
      if (entry.fileSize > 0) {
        headers["Content-Range"] = `bytes ${start}-${end}/${entry.fileSize}`;
      }
      if (chunkSize && chunkSize > 0) {
        headers["Content-Length"] = chunkSize;
      }
      entry.res.writeHead(206, headers);
    } else {
      const headers = {
        "Content-Type": entry.mime,
        "Accept-Ranges": "bytes",
      };
      if (entry.download) {
        headers["Content-Disposition"] = `attachment; filename="${contentDispositionFilename(entry.path.split(/[\\/]/).pop())}"`;
      }
      if (entry.fileSize > 0) {
        headers["Content-Length"] = entry.fileSize;
      }
      entry.res.writeHead(200, headers);
    }
    entry.headersSent = true;
  }
}

function handleFileChunk(header, data) {
  const requestId = String(header.requestId || "");
  const entry = pendingStreams.get(requestId);
  if (!entry) return;

  if (!entry.headersSent) {
    entry.res.writeHead(200, {
      "Content-Type": entry.mime || "application/octet-stream",
      "Accept-Ranges": "bytes",
      ...(entry.download
        ? { "Content-Disposition": `attachment; filename="${contentDispositionFilename(entry.path.split(/[\\/]/).pop())}"` }
        : {}),
    });
    entry.headersSent = true;
  }

  if (data && data.length) {
    entry.res.write(data);
    entry.bytesSent += data.length;
  }

  if (header.eof === true) {
    entry.res.end();
    cleanupRequest(requestId);
  }
}

function handleFileError(payload) {
  const requestId = String(payload.requestId || "");
  const entry = pendingStreams.get(requestId);
  if (!entry) return;
  const message = payload.error || "File error";
  failRequest(requestId, 404, message);
}

module.exports = {
  requestFileStream,
  handleFileInfo,
  handleFileChunk,
  handleFileError,
};
