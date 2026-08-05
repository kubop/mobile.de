import fs from "node:fs";
import path from "node:path";
import { loadConfig, paths, jitter, sleep, nowIso, searchUrlForPage } from "./config.js";
import { openSession, dismissConsent, detectBlock } from "./browser.js";
import { extractSearchResults, normalizeListing, dedupeById } from "./extract.js";
import {
  openDb,
  startRun,
  finishRun,
  failRun,
  recordListings,
  markRemoved,
  lastSuccessfulRun,
} from "./db.js";

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const DRY = args.has("--dry-run");
const DEBUG = args.has("--debug");

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

/** Stale locks (crashed run) shouldn't block forever. */
const LOCK_STALE_MS = 30 * 60 * 1000;

function acquireLock() {
  if (fs.existsSync(paths.lock)) {
    const age = Date.now() - fs.statSync(paths.lock).mtimeMs;
    if (age < LOCK_STALE_MS) {
      const owner = fs.readFileSync(paths.lock, "utf8").trim();
      throw new Error(
        `another scrape appears to be running (lock ${Math.round(age / 1000)}s old, ${owner}). ` +
          `Delete data/scrape.lock if that's wrong.`,
      );
    }
    log(`clearing stale lock (${Math.round(age / 60000)} min old)`);
    fs.rmSync(paths.lock, { force: true });
  }
  fs.writeFileSync(paths.lock, `pid ${process.pid} at ${nowIso()}`);
}

function releaseLock() {
  fs.rmSync(paths.lock, { force: true });
}

/** Fetch and parse one SRP page, retrying once on a block before giving up. */
async function fetchPage(page, cfg, pageNo) {
  const url = searchUrlForPage(cfg.searchUrl, pageNo);
  const maxAttempts = cfg.politeness?.maxAttemptsPerPage ?? 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`page ${pageNo}: GET${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.politeness?.navTimeoutMs ?? 60000,
    });
    const status = resp?.status() ?? 0;

    // Let the payload finish arriving.
    await sleep(jitter(cfg.politeness?.settleMs ?? [4000, 6500]));

    // Dismiss the GDPR modal *before* snapshotting the HTML — clicking it can re-render the
    // page, and with a persistent profile the choice is remembered for later runs.
    if (await dismissConsent(page, log).catch(() => false)) {
      await sleep(jitter(cfg.politeness?.settleMs ?? [4000, 6500]));
    }

    const html = await page.content();
    const title = await page.title().catch(() => "");
    const blocked = detectBlock(status, html, title);

    if (DEBUG) {
      fs.mkdirSync(paths.debugDir, { recursive: true });
      const f = path.join(paths.debugDir, `page-${pageNo}-attempt-${attempt}.html`);
      fs.writeFileSync(f, html);
      log(`  wrote ${f} (${html.length} bytes, HTTP ${status})`);
    }

    if (blocked) {
      log(`  blocked: ${blocked}`);
      if (attempt < maxAttempts) {
        const backoff = cfg.politeness?.blockedBackoffMs ?? 45000;
        log(`  backing off ${Math.round(backoff / 1000)}s before retry`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`page ${pageNo} blocked by mobile.de (${blocked})`);
    }

    const res = extractSearchResults(html);
    log(
      `  HTTP ${status}, variant=${res.variant}, ${res.listings.length} listings` +
        (res.adSlotsSkipped ? ` (${res.adSlotsSkipped} ad slots skipped)` : "") +
        `, total reported: ${res.numResultsTotal}` +
        (res.numPages ? `, pages: ${res.numPages}` : ""),
    );
    return res;
  }
  throw new Error(`page ${pageNo}: exhausted attempts`);
}

/**
 * Walk pages until we've collected every result. Page size is never assumed — sponsored slots
 * repeat ads, so counting rows would undercount. We stop on whichever comes first:
 * hasNextPage=false, page >= numPages, the reported total covered, a page that adds nothing
 * new, an empty page, or maxPages.
 */
async function collectAll(page, cfg) {
  const maxPages = cfg.maxPages ?? 8;
  const all = [];
  const seen = new Set();
  let numResultsTotal = null;
  let numPages = null;
  let pagesFetched = 0;
  let complete = false;

  for (let p = 1; p <= maxPages; p++) {
    if (p > 1) {
      const d = jitter(cfg.politeness?.pageDelayMs ?? [7000, 14000]);
      log(`waiting ${(d / 1000).toFixed(1)}s before page ${p}`);
      await sleep(d);
    }

    const res = await fetchPage(page, cfg, p);
    pagesFetched++;
    if (p === 1) {
      numResultsTotal = res.numResultsTotal;
      numPages = res.numPages;
    }

    if (!res.listings.length) {
      log(`page ${p} empty — stopping`);
      break;
    }

    let added = 0;
    for (const l of dedupeById(res.listings)) {
      const id = String(l.id);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(l);
      added++;
    }
    log(`  +${added} new unique (running total ${all.length}${numResultsTotal ? `/${numResultsTotal}` : ""})`);

    if (numResultsTotal && all.length >= numResultsTotal) {
      log(`collected all ${numResultsTotal} reported results`);
      complete = true;
      break;
    }
    if (res.hasNextPage === false) {
      log(`page ${p} reports no next page — stopping`);
      complete = true;
      break;
    }
    if (numPages && p >= numPages) {
      log(`reached last page (${numPages}) — stopping`);
      complete = true;
      break;
    }
    if (added === 0) {
      log(`page ${p} contributed nothing new — stopping`);
      complete = true;
      break;
    }
    if (p === maxPages) {
      log(
        `WARNING: hit maxPages=${maxPages} with ${all.length}/${numResultsTotal ?? "?"} collected — ` +
          `raise maxPages in config.json if the search grew`,
      );
    }
  }

  return { listings: all, numResultsTotal, numPages, pagesFetched, complete };
}

function fmtMoney(n) {
  return n == null ? "—" : `€${n.toLocaleString("en-US")}`;
}

async function main() {
  const cfg = loadConfig();
  const db = openDb();

  // Politeness guard: refuse to re-scrape too soon unless explicitly forced.
  const last = lastSuccessfulRun(db);
  const minGap = (cfg.politeness?.minMinutesBetweenRuns ?? 180) * 60000;
  if (last && !FORCE) {
    const age = Date.now() - Date.parse(last.finished_at ?? last.started_at);
    if (age < minGap) {
      const waitMin = Math.ceil((minGap - age) / 60000);
      log(
        `last successful run was ${Math.round(age / 60000)} min ago; minimum gap is ` +
          `${cfg.politeness?.minMinutesBetweenRuns} min. Skipping (${waitMin} min to go). Use --force to override.`,
      );
      db.close();
      return 0;
    }
  }

  acquireLock();
  const t0 = Date.now();
  const { id: runId, startedAt } = startRun(db);
  log(`run #${runId} — ${cfg.label ?? "search"}`);

  let session;
  let pagesFetched = 0;
  try {
    session = await openSession(cfg, log);
    const collected = await collectAll(session.page, cfg);
    pagesFetched = collected.pagesFetched;

    // Fail loudly rather than recording "everything was delisted".
    if (collected.listings.length === 0) {
      throw new Error("no listings collected — refusing to record an empty run");
    }
    if (collected.numResultsTotal && collected.listings.length < collected.numResultsTotal * 0.5) {
      throw new Error(
        `only ${collected.listings.length} of ${collected.numResultsTotal} results collected — ` +
          `refusing to record a partial run (would mass-flag live ads as removed)`,
      );
    }

    const rows = collected.listings.map(normalizeListing);

    if (DRY) {
      log(`dry run — parsed ${rows.length} listings, nothing written`);
      for (const r of rows) {
        log(
          `  ${r.id}  ${fmtMoney(r.priceEur).padStart(9)}  ${String(r.mileageKm ?? "—").padStart(7)} km  ` +
            `${(r.firstRegYm ?? "—").padStart(7)}  ${String(r.previousOwners ?? "—")} own  ${r.sellerName ?? ""}`,
        );
      }
      failRun(db, runId, "dry-run (not recorded)", pagesFetched, Date.now() - t0);
      return 0;
    }

    const { newIds, relistedIds, changes } = recordListings(db, runId, startedAt, rows);
    const removed = markRemoved(db, runId, startedAt);

    finishRun(db, runId, {
      pagesFetched,
      numResultsTotal: collected.numResultsTotal,
      listingsSeen: rows.length,
      newCount: newIds.length,
      removedCount: removed.length,
      changedCount: changes.length,
      durationMs: Date.now() - t0,
    });

    log("");
    log(`run #${runId} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    log(`  listings:  ${rows.length} (of ${collected.numResultsTotal ?? "?"} reported)`);
    log(`  new:       ${newIds.length}${newIds.length ? ` -> ${newIds.join(", ")}` : ""}`);
    log(`  relisted:  ${relistedIds.length}${relistedIds.length ? ` -> ${relistedIds.join(", ")}` : ""}`);
    log(`  removed:   ${removed.length}${removed.length ? ` -> ${removed.join(", ")}` : ""}`);
    log(`  changes:   ${changes.length}`);
    for (const c of changes) log(`    ${c.id} ${c.field}: ${c.from} -> ${c.to}`);
    return 0;
  } catch (e) {
    failRun(db, runId, e.message, pagesFetched, Date.now() - t0);
    log("");
    log(`run #${runId} FAILED: ${e.message}`);
    if (!DEBUG) log("  re-run with --debug to dump the fetched HTML into debug/");
    return 1;
  } finally {
    await session?.close();
    releaseLock();
    db.close();
  }
}

process.exitCode = await main();
