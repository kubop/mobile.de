import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, startRun, finishRun, recordListings, markRemoved } from "../src/db.js";
import { exportHistory, importHistory } from "../src/history.js";
import { extractSearchResults, dedupeById, normalizeListing } from "../src/extract.js";
import { loadFixture, skipIfMissing } from "./fixtures.js";

const FIXTURE = "srp-2026-08-05.html";
const skip = skipIfMissing(FIXTURE);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mobde-hist-"));

function baseRows() {
  const { listings } = extractSearchResults(loadFixture(FIXTURE));
  return dedupeById(listings).map(normalizeListing);
}

function doRun(db, rows) {
  const { id, startedAt } = startRun(db);
  const res = recordListings(db, id, startedAt, rows);
  const removed = markRemoved(db, id, startedAt);
  finishRun(db, id, {
    pagesFetched: 2, numResultsTotal: rows.length, listingsSeen: rows.length,
    newCount: res.newIds.length, removedCount: removed.length,
    changedCount: res.changes.length, durationMs: 1,
  });
  return { runId: id, ...res, removed };
}

/** Build a db with three runs: a price cut, a mileage bump and a removal. */
function seeded(dbPath) {
  const db = openDb(dbPath);
  doRun(db, baseRows());

  const r2 = baseRows();
  const t = r2.find((r) => r.id === "443379399");
  t.priceEur -= 12000;
  t.mileageKm += 500;
  doRun(db, r2);

  doRun(db, baseRows().filter((r) => r.id !== "461192574")); // one disappears
  return db;
}

const COUNT = (db, t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

test("history round-trips every row without loss", { skip }, () => {
  const dir = tmp();
  const dbA = path.join(dir, "a.sqlite");
  const dbB = path.join(dir, "b.sqlite");
  const hist = path.join(dir, "history");

  const a = seeded(dbA);
  const before = {};
  for (const t of ["run", "listing", "snapshot", "change", "event"]) before[t] = COUNT(a, t);
  assert.ok(before.change > 0, "seeded data has changes to lose");
  assert.ok(before.event > 0, "seeded data has events to lose");

  const exported = exportHistory(a, hist);
  a.close();
  assert.deepEqual(exported, before, "export counts match the source");

  const imported = importHistory(dbB, hist);
  assert.deepEqual(imported, before, "import counts match the source");

  const b = openDb(dbB);
  for (const t of ["run", "listing", "snapshot", "change", "event"]) {
    assert.equal(COUNT(b, t), before[t], `${t} row count preserved`);
  }
  b.close();
});

test("round-trip preserves price history values exactly", { skip }, () => {
  const dir = tmp();
  const dbA = path.join(dir, "a.sqlite");
  const dbB = path.join(dir, "b.sqlite");
  const hist = path.join(dir, "history");

  const a = seeded(dbA);
  const histBefore = a
    .prepare("SELECT listing_id, seen_at, price_eur, mileage_km, previous_owners FROM snapshot ORDER BY id")
    .all();
  const changesBefore = a.prepare("SELECT listing_id, field, old_value, new_value FROM change ORDER BY id").all();
  const removedBefore = a.prepare("SELECT id, removed_at FROM listing WHERE removed_at IS NOT NULL").all();
  exportHistory(a, hist);
  a.close();

  importHistory(dbB, hist);
  const b = openDb(dbB);
  assert.deepEqual(
    b.prepare("SELECT listing_id, seen_at, price_eur, mileage_km, previous_owners FROM snapshot ORDER BY id").all(),
    histBefore,
  );
  assert.deepEqual(
    b.prepare("SELECT listing_id, field, old_value, new_value FROM change ORDER BY id").all(),
    changesBefore,
  );
  assert.deepEqual(
    b.prepare("SELECT id, removed_at FROM listing WHERE removed_at IS NOT NULL").all(),
    removedBefore,
    "removal state survives the round trip",
  );
  b.close();
});

test("a scrape after import continues the history instead of colliding on ids", { skip }, () => {
  const dir = tmp();
  const dbA = path.join(dir, "a.sqlite");
  const dbB = path.join(dir, "b.sqlite");
  const hist = path.join(dir, "history");

  const a = seeded(dbA);
  const runsBefore = COUNT(a, "run");
  const snapsBefore = COUNT(a, "snapshot");
  exportHistory(a, hist);
  a.close();

  importHistory(dbB, hist);

  // This is the failure mode the sqlite_sequence fix-up exists for: without it the next
  // INSERT reuses id 1 and throws on the primary key.
  const b = openDb(dbB);
  const rows = baseRows(); // the fixture is page 1 only, so this is 21 unique ads, not all 32
  const r = doRun(b, rows);
  assert.ok(r.runId > runsBefore, `new run id ${r.runId} continues past ${runsBefore}`);
  assert.equal(COUNT(b, "run"), runsBefore + 1);
  assert.equal(COUNT(b, "snapshot"), snapsBefore + rows.length);
  assert.equal(r.newIds.length, 0, "known listings are not re-flagged as new");
  assert.deepEqual(r.relistedIds, ["461192574"], "the removed one is seen as relisted");
  b.close();
});

test("importing an empty history yields a usable empty database", () => {
  const dir = tmp();
  const dbB = path.join(dir, "b.sqlite");
  const counts = importHistory(dbB, path.join(dir, "does-not-exist"));
  assert.deepEqual(counts, { run: 0, listing: 0, snapshot: 0, change: 0, event: 0 });
  const b = openDb(dbB);
  assert.equal(COUNT(b, "listing"), 0);
  b.close();
});
