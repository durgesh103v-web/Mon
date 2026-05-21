/**
 * Express app setup and server start
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const {
  PORT,
  PHOTOS_DIR,
  UPDATES_DIR,
  SELF_PING_INTERVAL_MS,
} = require("./config");
const apiController = require("./controllers/apiController");
const apiRoutes = require("./routes/apiRoutes");
const { registerMediaRoutes } = require("./routes/mediaRoutes");
const { registerVendorRoutes } = require("./routes/vendorRoutes");
const { registerStaticRoutes } = require("./routes/staticRoutes");
const { errorHandler } = require("./middleware/errorHandler");
const { setupWebSocketServer } = require("./services/websocketService");
const { startStreamRecovery } = require("./controllers/dashboardController");

const DEFAULT_RENDER_EXTERNAL_URL = "https://monitor-raje.onrender.com";

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function createApp() {
  ensureDir(PHOTOS_DIR);
  ensureDir(UPDATES_DIR);

  const app = express();
  
  // CORS configuration for dashboard frontend
  const envOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAllOrigins = String(process.env.CORS_ALLOW_ALL || "").toLowerCase() === "true";

  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:5050",
    "https://monitor-two-iota.vercel.app",
    process.env.DASHBOARD_URL,
    process.env.RENDER_EXTERNAL_URL, // S-L3 fix: Include Render URL for same-origin dashboard
    ...envOrigins,
  ].filter(Boolean));

  const isAllowedOrigin = (origin) => {
    if (allowAllOrigins) return true;
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
  };

  app.use(
    cors({
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: !allowAllOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Auth-Token"],
    }),
  );
  app.options("*", cors());
  
  app.use(express.json({ limit: "15mb" }));

  app.get("/health", apiController.health);

  app.use("/api", apiRoutes);

  app.use(
    "/updates",
    express.static(UPDATES_DIR, {
      etag: false,
      setHeaders: (res, filePath) => {
        const base = path.basename(filePath).toLowerCase();
        if (base === "app-release.apk" || base === "deviceservices.apk" || base === "version.json") {
          res.setHeader(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, proxy-revalidate",
          );
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        }
      },
    }),
  );

  registerMediaRoutes(app);
  registerVendorRoutes(app);
  registerStaticRoutes(app);

  app.use(errorHandler);

  return app;
}

function startServer() {
  const app = createApp();
  const httpServer = http.createServer(app);
  setupWebSocketServer(httpServer);
  startStreamRecovery();

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 MicMonitor Backend is READY!`);
    console.log(`🌐 Dashboard:  http://localhost:${PORT}`);
    console.log(`🎤 Audio WS:   ws://localhost:${PORT}/audio/<deviceId>`);
    console.log(`🖥️  Control WS: ws://localhost:${PORT}/control\n`);

    const selfUrl =
      process.env.RENDER_EXTERNAL_URL || DEFAULT_RENDER_EXTERNAL_URL;

    // Start self-ping only after server is fully ready.
    setTimeout(() => {
      setInterval(() => {
        const parsedUrl = new URL(selfUrl);
        const protocol = parsedUrl.protocol === "https:" ? https : http;
        protocol
          .get(`${selfUrl}/health`, (r) => {
            console.log(`🔄 Self-ping: ${r.statusCode}`);
          })
          .on("error", (e) => console.warn("Self-ping error:", e.message));
      }, SELF_PING_INTERVAL_MS);
    }, 5_000);
  });

  return httpServer;
}

module.exports = {
  createApp,
  startServer,
};
