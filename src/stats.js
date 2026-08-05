import fs from "node:fs";
import { loadConfig, paths } from "./config.js";
import { openDb } from "./db.js";
import { getOverview, getRuns, getChanges, getEvents } from "./queries.js";

/** Terminal summary — a quick "what happened" without opening the dashboard. */

const cfg = loadConfig();
if (!fs.existsSync(paths.db)) {
  console.log(`No database yet at ${paths.db}\nRun  npm run scrape  first.`);
  process.exit(0);
}

const db = openDb();
const o = getOverview(db);
const eur = (v) => (v == null ? "—" : "€" + v.toLocaleString("en-US"));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

console.log(`\n${cfg.label ?? "mobile.de search"}`);
console.log("=".repeat(60));
console.log(`Active listings   ${o.active}`);
console.log(`Removed           ${o.removed}`);
console.log(`Ever tracked      ${o.totalTracked}`);
console.log(`Scrapes           ${o.runCount} (${o.snapshotCount} snapshots)`);
console.log(`Last scrape       ${when(o.lastRun?.started_at)}`);
if (o.lastFailedRun && (!o.lastRun || o.lastFailedRun.id > o.lastRun.id)) {
  console.log(`  ! last attempt FAILED: ${o.lastFailedRun.error}`);
}
console.log(`\nPrice  min ${eur(o.priceMin)}   median ${eur(o.priceMedian)}   avg ${eur(o.priceAvg)}   max ${eur(o.priceMax)}`);
console.log(`Price changes recorded: ${o.priceDrops} cut(s), ${o.priceRises} increase(s)`);

const events = getEvents(db, 15);
if (events.length) {
  console.log(`\nRecent listing events`);
  console.log("-".repeat(60));
  for (const e of events) {
    console.log(
      `${e.at.slice(0, 16).replace("T", " ")}  ${e.type.padEnd(9)} ${String(e.listing_id).padEnd(10)} ` +
        `${eur(e.price_eur).padStart(9)}  ${(e.sub_title ?? e.title ?? "").slice(0, 34)}`,
    );
  }
}

const changes = getChanges(db, 20).filter((c) => c.field === "price_eur");
if (changes.length) {
  console.log(`\nRecent price changes`);
  console.log("-".repeat(60));
  for (const c of changes) {
    const d = +c.new_value - +c.old_value;
    console.log(
      `${c.at.slice(0, 16).replace("T", " ")}  ${String(c.listing_id).padEnd(10)} ` +
        `${eur(+c.old_value).padStart(9)} -> ${eur(+c.new_value).padStart(9)}  ` +
        `${(d < 0 ? "" : "+") + eur(d)}  ${(c.sub_title ?? "").slice(0, 26)}`,
    );
  }
}

const failed = getRuns(db, 50).filter((r) => r.status === "failed" && r.error !== "dry-run (not recorded)");
if (failed.length) {
  console.log(`\n${failed.length} failed run(s); most recent:`);
  for (const r of failed.slice(0, 3)) {
    console.log(`  #${r.id} ${when(r.started_at)} — ${r.error}`);
  }
}

console.log(`\nDashboard:  npm run serve  ->  http://localhost:${cfg.server?.port ?? 8477}\n`);
db.close();
