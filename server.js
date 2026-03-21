// server.js — Dashboard HTTP server.
// Serves the web UI and provides API routes for managing Kins.
// Also runs weather polling loops for all enabled Kins.

const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./lib/db");
const scheduler = require("./lib/scheduler");

const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

// --- Static file serving ---

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url;
  // Strip query strings
  filePath = filePath.split("?")[0];
  const fullPath = path.join(__dirname, "public", filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const data = fs.readFileSync(fullPath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// --- Auth middleware ---

function checkAuth(req, res) {
  if (!DASHBOARD_PASSWORD) return true;

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== DASHBOARD_PASSWORD) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

// --- JSON helpers ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- API routes ---

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // Auth check (password is not required)
  if (pathname === "/api/auth/check") {
    if (method === "GET") {
      return sendJson(res, 200, {
        requiresPassword: Boolean(DASHBOARD_PASSWORD),
        authenticated: !DASHBOARD_PASSWORD,
      });
    }
    if (method === "POST") {
      const body = await readBody(req);
      const valid = !DASHBOARD_PASSWORD || body.password === DASHBOARD_PASSWORD;
      return sendJson(res, valid ? 200 : 401, { authenticated: valid });
    }
  }

  // All other API routes require auth
  if (!checkAuth(req, res)) return;

  // GET /api/settings — get settings (without exposing full key)
  if (pathname === "/api/settings" && method === "GET") {
    const hasKey = db.hasKindroidKey();
    return sendJson(res, 200, { hasKindroidKey: hasKey });
  }

  // PUT /api/settings — update settings
  if (pathname === "/api/settings" && method === "PUT") {
    try {
      const body = await readBody(req);
      if (body.kindroidKey !== undefined) {
        if (!body.kindroidKey) {
          return sendJson(res, 400, { error: "API key cannot be empty" });
        }
        db.setKindroidKey(body.kindroidKey);
        // Restart all schedulers with new key
        scheduler.stopAll();
        scheduler.startAll();
      }
      return sendJson(res, 200, { ok: true, hasKindroidKey: db.hasKindroidKey() });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // GET /api/kins — list all
  if (pathname === "/api/kins" && method === "GET") {
    const kins = db.listKinsWithState();
    return sendJson(res, 200, kins);
  }

  // POST /api/kins — create
  if (pathname === "/api/kins" && method === "POST") {
    try {
      const body = await readBody(req);
      if (!body.aiId || body.latitude == null || body.longitude == null) {
        return sendJson(res, 400, { error: "Missing required fields: aiId, latitude, longitude" });
      }
      if (!db.hasKindroidKey()) {
        return sendJson(res, 400, { error: "Set your Kindroid API key in Settings first" });
      }
      const kin = db.createKin(body);
      scheduler.start(kin.id);
      return sendJson(res, 201, kin);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Routes with :id
  const kinMatch = pathname.match(/^\/api\/kins\/([a-f0-9]+)$/);
  if (kinMatch) {
    const id = kinMatch[1];

    // GET /api/kins/:id
    if (method === "GET") {
      const kin = db.getKinWithState(id);
      if (!kin) return sendJson(res, 404, { error: "Kin not found" });
      const status = scheduler.getStatus(id);
      return sendJson(res, 200, { ...kin, running: status.running });
    }

    // PUT /api/kins/:id
    if (method === "PUT") {
      try {
        const body = await readBody(req);
        const kin = db.updateKin(id, body);
        if (!kin) return sendJson(res, 404, { error: "Kin not found" });
        scheduler.restart(id);
        return sendJson(res, 200, kin);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // DELETE /api/kins/:id
    if (method === "DELETE") {
      scheduler.stop(id);
      const deleted = db.deleteKin(id);
      if (!deleted) return sendJson(res, 404, { error: "Kin not found" });
      return sendJson(res, 200, { ok: true });
    }
  }

  // POST /api/kins/:id/trigger — manual update
  const triggerMatch = pathname.match(/^\/api\/kins\/([a-f0-9]+)\/trigger$/);
  if (triggerMatch && method === "POST") {
    const id = triggerMatch[1];
    const config = db.getKinConfig(id);
    if (!config) return sendJson(res, 404, { error: "Kin not found" });

    // Run tick in background, respond immediately
    scheduler.tick(id);
    return sendJson(res, 200, { ok: true, message: "Update triggered" });
  }

  // Health check
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, { status: "ok" });
  }

  sendJson(res, 404, { error: "Not found" });
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
    } else {
      serveStatic(req, res);
    }
  } catch (err) {
    console.error(`Request error: ${err.message}`);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
  if (DASHBOARD_PASSWORD) {
    console.log("Dashboard password protection is enabled.");
  } else {
    console.log("No DASHBOARD_PASSWORD set — dashboard is open.");
  }

  // Start all enabled Kin schedulers
  scheduler.startAll();
});
