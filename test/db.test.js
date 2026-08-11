import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, startRun, finishRun, recordListings, markRemoved, lastSuccessfulRun } from "../src/db.js";
import { extractSearchResults, dedupeById, normalizeListing } from "../src/extract.js";
import { loadFixture, skipIfMissing } from "./fixtures.js";

const FIXTURE = "srp-2026-08-05.html";
const LEGACY_FIXTURE = "srp-legacy-2026-08-05.html";
const MIGRATED_FIXTURE = "srp-migrated-2026-08-11.html";
const skip = skipIfMissing(FIXTURE);

function baseRows() {
  const { listings } = extractSearchResults(loadFixture(FIXTURE));
  return dedupeById(listings).map(normalizeListing);
}

function tmpDb() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mobde-")), "t.sqlite");
  return openDb(p);
}

/** Run one synthetic scrape cycle against the db. */
function doRun(db, rows, { markGone = true } = {}) {
  const { id, startedAt } = startRun(db);
  const res = recordListings(db, id, startedAt, rows);
  const removed = markGone ? markRemoved(db, id, startedAt) : [];
  finishRun(db, id, {
    pagesFetched: 2,
    numResultsTotal: rows.length,
    listingsSeen: rows.length,
    newCount: res.newIds.length,
    removedCount: removed.length,
    changedCount: res.changes.length,
    durationMs: 1,
  });
  return { runId: id, ...res, removed };
}

test("first run inserts every listing as new with a snapshot each", { skip }, () => {
  const db = tmpDb();
  const rows = baseRows();
  const r = doRun(db, rows);

  assert.equal(r.newIds.length, rows.length);
  assert.equal(r.changes.length, 0, "nothing to diff on a first sighting");
  assert.equal(r.removed.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM listing").get().c, rows.length);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshot").get().c, rows.length);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM event WHERE type='new'").get().c, rows.length);
});

test("unchanged second run adds snapshots but no changes and no new listings", { skip }, () => {
  const db = tmpDb();
  const rows = baseRows();
  doRun(db, rows);
  const r2 = doRun(db, baseRows());

  assert.equal(r2.newIds.length, 0);
  assert.equal(r2.changes.length, 0);
  assert.equal(r2.removed.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM listing").get().c, rows.length);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM snapshot").get().c,
    rows.length * 2,
    "history keeps accumulating so charts have sample points",
  );
});

test("a price drop is recorded as a change and preserved in history", { skip }, () => {
  const db = tmpDb();
  doRun(db, baseRows());

  const rows = baseRows();
  const target = rows.find((r) => r.id === "443379399");
  const original = target.priceEur;
  target.priceEur = original - 15000;
  target.priceRaw = "€292,950";

  const r2 = doRun(db, rows);
  const priceChanges = r2.changes.filter((c) => c.field === "price_eur");
  assert.equal(priceChanges.length, 1);
  assert.equal(priceChanges[0].id, "443379399");
  assert.equal(priceChanges[0].from, String(original));
  assert.equal(priceChanges[0].to, String(original - 15000));

  const hist = db
    .prepare("SELECT price_eur FROM snapshot WHERE listing_id=? ORDER BY id")
    .all("443379399")
    .map((x) => x.price_eur);
  assert.deepEqual(hist, [original, original - 15000]);
});

test("mileage and owner changes are tracked too", { skip }, () => {
  const db = tmpDb();
  doRun(db, baseRows());
  const rows = baseRows();
  const t = rows.find((r) => r.id === "443379399");
  t.mileageKm = t.mileageKm + 800;
  t.previousOwners = 5;
  const r2 = doRun(db, rows);
  const fields = r2.changes.filter((c) => c.id === "443379399").map((c) => c.field).sort();
  assert.deepEqual(fields, ["mileage_km", "previous_owners"]);
});

test("a listing missing from a later run is marked removed", { skip }, () => {
  const db = tmpDb();
  const rows = baseRows();
  doRun(db, rows);

  const fewer = baseRows().filter((r) => r.id !== "443379399");
  const r2 = doRun(db, fewer);

  assert.deepEqual(r2.removed, ["443379399"]);
  const l = db.prepare("SELECT removed_at FROM listing WHERE id=?").get("443379399");
  assert.ok(l.removed_at, "removed_at stamped");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM event WHERE type='removed'").get().c, 1);
  // The car's history survives deletion — that's the point of the append-only table.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshot WHERE listing_id=?").get("443379399").c, 1);
});

test("a returning listing is relisted, not duplicated", { skip }, () => {
  const db = tmpDb();
  doRun(db, baseRows());
  doRun(db, baseRows().filter((r) => r.id !== "443379399"));
  const r3 = doRun(db, baseRows());

  assert.deepEqual(r3.relistedIds, ["443379399"]);
  assert.equal(r3.newIds.length, 0, "not counted as new again");
  const l = db.prepare("SELECT removed_at FROM listing WHERE id=?").get("443379399");
  assert.equal(l.removed_at, null, "removed flag cleared");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM event WHERE type='relisted'").get().c, 1);
});

test("a page-variant flip produces no phantom changes", { skip: skipIfMissing(FIXTURE, LEGACY_FIXTURE) }, () => {
  // The real incident: the first scrape from GitHub reported 26 changed listings, 25 of which
  // were only "19% VAT" vs "19.00% VAT" — the same rate formatted differently by the two page
  // implementations mobile.de alternates between.
  const rowsOf = (f) => dedupeById(extractSearchResults(loadFixture(f)).listings).map(normalizeListing);
  const a = rowsOf(FIXTURE);
  const bAll = rowsOf(LEGACY_FIXTURE);

  // Only the cars present in both fixtures can be compared.
  const ids = new Set(a.map((r) => r.id));
  const b = bAll.filter((r) => ids.has(r.id));
  assert.ok(b.length > 0, "the fixtures overlap, so there is something to diff");

  const db = tmpDb();
  doRun(db, a);
  const r2 = doRun(db, b, { markGone: false });

  const vatChanges = r2.changes.filter((c) => c.field === "vat");
  assert.deepEqual(vatChanges, [], `a variant flip must not look like a VAT change: ${JSON.stringify(vatChanges)}`);
});

test("a payload that stops carrying a field neither wipes it nor logs a change", { skip }, () => {
  // What the reworked SRP did before extract.js learned to read the render tree: every listing
  // came back with title, sub_title, image and seller_name null. `listing` is updated in place,
  // unlike `snapshot`, so an unconditional overwrite destroyed the only copy — and silently,
  // since image and seller_name are not diffed at all.
  const db = tmpDb();
  const full = baseRows();
  doRun(db, full);

  const hollow = baseRows().map((r) => ({
    ...r,
    title: null, subTitle: null, shortTitle: null, image: null, sellerName: null, vat: null,
  }));
  const r2 = doRun(db, hollow, { markGone: false });

  // Listing fields are kept, so reporting a change would contradict the table. Snapshot fields
  // are stored as seen, so vat going absent is still recorded — deliberately asymmetric, because
  // a real "New car" -> null once accompanied a genuine price, mileage and owner change.
  assert.deepEqual(
    r2.changes.filter((c) => ["title", "sub_title"].includes(c.field)),
    [],
    "a preserved field is not a change",
  );
  assert.equal(
    r2.changes.filter((c) => c.field === "vat" && c.to === null).length,
    full.filter((r) => r.vat != null).length,
    "a snapshot field going absent is still recorded",
  );

  const before = full[0];
  const after = db
    .prepare("SELECT title, sub_title, short_title, image, seller_name FROM listing WHERE id = ?")
    .get(before.id);
  assert.equal(after.title, before.title, "title survived");
  assert.equal(after.sub_title, before.subTitle);
  assert.equal(after.short_title, before.shortTitle);
  assert.equal(after.image, before.image, "the photo survived");
  assert.equal(after.seller_name, before.sellerName, "the seller name survived");
});

test(
  "a flip to the reworked SRP preserves the fields it cannot carry",
  { skip: skipIfMissing(FIXTURE, MIGRATED_FIXTURE) },
  () => {
    const rowsOf = (f) => dedupeById(extractSearchResults(loadFixture(f)).listings).map(normalizeListing);
    const a = rowsOf(FIXTURE);
    const ids = new Set(a.map((r) => r.id));
    const c = rowsOf(MIGRATED_FIXTURE).filter((r) => ids.has(r.id));
    assert.ok(c.length > 0, "the fixtures overlap, so there is something to diff");

    const db = tmpDb();
    doRun(db, a);
    const r2 = doRun(db, c, { markGone: false });

    // Prices genuinely moved between the two captures; the display fields must not have.
    const phantom = r2.changes.filter((ch) => ["title", "sub_title", "vat"].includes(ch.field));
    assert.deepEqual(phantom, [], `variant flip must not look like a change: ${JSON.stringify(phantom)}`);

    // seller_name is absent from the reworked payload altogether, so it can only survive by
    // being kept rather than overwritten.
    const row = db.prepare("SELECT seller_name, image FROM listing WHERE id = ?").get(c[0].id);
    assert.ok(row.seller_name, "seller name kept from the earlier variant");
    assert.ok(row.image, "photo kept");
  },
);

test("lastSuccessfulRun ignores failed runs", { skip }, () => {
  const db = tmpDb();
  const a = doRun(db, baseRows());
  const { id } = startRun(db);
  db.prepare("UPDATE run SET status='failed' WHERE id=?").run(id);
  assert.equal(lastSuccessfulRun(db).id, a.runId);
});
