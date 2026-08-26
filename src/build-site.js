/**
 * Builds the static dashboard into dist/ for GitHub Pages.
 *
 * Reuses the exact same query layer the local server uses, so the published page and the local
 * one can never drift apart. The only difference is that data.json also bundles per-listing
 * detail (which the live server serves from /api/listing/:id).
 *
 *   node src/build-site.js            # from data/mobile.sqlite
 *   node src/build-site.js --from-history   # rebuild the db from history/ first
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, paths } from "./config.js";
import { openDb } from "./db.js";
import { importHistory } from "./history.js";
import {
  getOverview,
  getListings,
  getRuns,
  getChanges,
  getEvents,
  getPriceHistory,
  getListingDetail,
} from "./queries.js";

const cfg = loadConfig();
const outDir = path.join(paths.root, "dist");

if (process.argv.includes("--from-history")) {
  const c = importHistory();
  console.log(`rebuilt database from history/: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

if (!fs.existsSync(paths.db)) {
  console.error(`No database at ${paths.db}. Run a scrape, or pass --from-history.`);
  process.exit(1);
}

const db = openDb();
const listings = getListings(db);

const payload = {
  label: cfg.label ?? "mobile.de search",
  searchUrl: cfg.searchUrl,
  generatedAt: new Date().toISOString(),
  minMinutesBetweenRuns: cfg.politeness?.minMinutesBetweenRuns ?? null,
  overview: getOverview(db),
  listings,
  runs: getRuns(db),
  changes: getChanges(db),
  events: getEvents(db),
  priceHistory: getPriceHistory(db),
  // Static builds have no API to call, so per-listing detail rides along.
  details: Object.fromEntries(listings.map((l) => [l.id, getListingDetail(db, l.id)])),
};
db.close();

// Clear the contents rather than the directory itself: removing dist/ fails if anything
// (a preview server, an editor) is holding it open.
fs.mkdirSync(outDir, { recursive: true });
for (const entry of fs.readdirSync(outDir)) {
  fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}
fs.copyFileSync(path.join(paths.public, "index.html"), path.join(outDir, "index.html"));
fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(payload));
// Pages would otherwise run the output through Jekyll.
fs.writeFileSync(path.join(outDir, ".nojekyll"), "");

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`built dist/`);
console.log(`  index.html  ${kb(fs.statSync(path.join(outDir, "index.html")).size)}`);
console.log(`  data.json   ${kb(fs.statSync(path.join(outDir, "data.json")).size)}`);
console.log(
  `  ${payload.listings.length} listings · ${payload.overview.runCount} run(s) · ` +
    `${payload.priceHistory.length} price points`,
);
