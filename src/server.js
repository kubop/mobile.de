import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, paths } from "./config.js";
import { openDb } from "./db.js";
import {
  getOverview,
  getListings,
  getRuns,
  getChanges,
  getEvents,
  getPriceHistory,
  getMarketTimeline,
  getMedianTimeline,
  getListingDetail,
} from "./queries.js";

const cfg = loadConfig();
const port = Number(process.env.PORT) || cfg.server?.port || 8477;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Open the DB per request. SQLite handles this fine at this scale and it means the server
 * always reflects a scrape that finished after the server started — no restart needed.
 */
function withDb(fn) {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function sendJson(res, body, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(paths.public, rel);
  // Keep path traversal out.
  if (!file.startsWith(paths.public)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === "/api/data") {
      // One round trip for the whole dashboard — the dataset is small by design.
      return sendJson(
        res,
        withDb((db) => ({
          label: cfg.label ?? "mobile.de search",
          searchUrl: cfg.searchUrl,
          generatedAt: new Date().toISOString(),
          minMinutesBetweenRuns: cfg.politeness?.minMinutesBetweenRuns ?? null,
          overview: getOverview(db),
          listings: getListings(db),
          runs: getRuns(db),
          changes: getChanges(db),
          events: getEvents(db),
          priceHistory: getPriceHistory(db),
          marketTimeline: getMarketTimeline(db),
          medianTimeline: getMedianTimeline(db),
        })),
      );
    }

    const m = p.match(/^\/api\/listing\/(\d+)$/);
    if (m) {
      const detail = withDb((db) => getListingDetail(db, m[1]));
      return detail ? sendJson(res, detail) : sendJson(res, { error: "not found" }, 404);
    }

    if (p.startsWith("/api/")) return sendJson(res, { error: "unknown endpoint" }, 404);

    return serveStatic(res, p);
  } catch (e) {
    console.error(e);
    return sendJson(res, { error: e.message }, 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mobile.de tracker dashboard -> http://localhost:${port}`);
  console.log(`tracking: ${cfg.label ?? cfg.searchUrl}`);
  if (!fs.existsSync(paths.db)) {
    console.log(`\nNo database yet at ${paths.db}`);
    console.log(`Run  npm run scrape  first.`);
  }
});
