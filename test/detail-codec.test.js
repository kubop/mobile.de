import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { getPriceHistory, getOkRunIds } from "../src/queries.js";
import { encodeSnapshots, encodeDetails, DETAILS_ENCODING } from "../src/detail-codec.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The dashboard is served standalone and cannot import src/, so its copy of the decoder is a
 * mirror of detail-codec.js. Pull the real function text out of index.html and test *that* —
 * a second copy that is never exercised is exactly how the live and static dashboards drift,
 * and the decode path only ever runs in static mode, which local development never hits.
 */
function fromDashboard(name) {
  const src = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `public/index.html no longer defines ${name}()`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const decodeSnapshots = new Function(`${fromDashboard("decodeSnapshots")}; return decodeSnapshots;`)();

/** The dashboard's deriver, run against an injected DATA/detailCache scope. */
function derivePriceHistory(DATA, detailCache) {
  return new Function(
    "DATA",
    "detailCache",
    `${fromDashboard("derivePriceHistory")}; return derivePriceHistory();`,
  )(DATA, detailCache);
}

/** Every snapshot in the committed history, grouped by listing, in getListingDetail() order. */
function historyByListing() {
  const f = path.join(root, "history", "snapshot.ndjson");
  if (!fs.existsSync(f)) return null;
  const by = new Map();
  for (const line of fs.readFileSync(f, "utf8").trim().split("\n")) {
    const { raw, ...row } = JSON.parse(line);
    if (!by.has(row.listing_id)) by.set(row.listing_id, []);
    by.get(row.listing_id).push(row);
  }
  for (const rows of by.values()) {
    rows.sort((a, b) => (a.seen_at < b.seen_at ? -1 : a.seen_at > b.seen_at ? 1 : a.id - b.id));
  }
  return by;
}

const hist = historyByListing();
const skipHist = hist ? false : "needs history/snapshot.ndjson";

test("round-trips the whole committed history through the dashboard's own decoder", { skip: skipHist }, () => {
  let rows = 0;
  for (const [id, snapshots] of hist) {
    assert.deepEqual(decodeSnapshots(id, encodeSnapshots(snapshots)), snapshots, `listing ${id}`);
    rows += snapshots.length;
  }
  assert.ok(rows > 100, `expected a real history, got ${rows} snapshots`);
});

test("a field dropping to null is written explicitly, not omitted", () => {
  const snaps = [
    { id: 1, listing_id: "a", run_id: 1, seen_at: "t1", price_eur: 100, vat: "19% VAT" },
    { id: 2, listing_id: "a", run_id: 2, seen_at: "t2", price_eur: 100, vat: null },
    { id: 3, listing_id: "a", run_id: 3, seen_at: "t3", price_eur: 100, vat: "19% VAT" },
  ];
  const enc = encodeSnapshots(snaps);

  assert.ok("vat" in enc[1][3], "the null must be in the patch — omission would mean 'unchanged'");
  assert.equal(enc[1][3].vat, null);
  assert.ok(!("price_eur" in enc[1][3]), "unchanged fields stay out of the patch");
  assert.deepEqual(decodeSnapshots("a", enc), snaps);
});

test("the first row of a listing carries every column, nulls included", () => {
  const snaps = [{ id: 1, listing_id: "a", run_id: 1, seen_at: "t1", price_eur: null, vat: null }];
  const [[, , , patch]] = encodeSnapshots(snaps);
  assert.deepEqual(patch, { price_eur: null, vat: null });
});

test("a column that disappears from later rows is diffed as null, not carried forward", () => {
  const snaps = [
    { id: 1, listing_id: "a", run_id: 1, seen_at: "t1", vat: "19% VAT" },
    { id: 2, listing_id: "a", run_id: 2, seen_at: "t2" },
  ];
  assert.deepEqual(decodeSnapshots("a", encodeSnapshots(snaps)), [
    snaps[0],
    { id: 2, listing_id: "a", run_id: 2, seen_at: "t2", vat: null },
  ]);
});

test("encodeDetails leaves everything but snapshots alone", () => {
  const detail = {
    a: {
      listing: { id: "a", title: "x" },
      snapshots: [{ id: 1, listing_id: "a", run_id: 1, seen_at: "t1", price_eur: 5 }],
      changes: [{ field: "price_eur" }],
      events: [{ type: "new" }],
    },
  };
  const enc = encodeDetails(detail);
  assert.deepEqual(enc.a.listing, detail.a.listing);
  assert.deepEqual(enc.a.changes, detail.a.changes);
  assert.deepEqual(enc.a.events, detail.a.events);
  assert.deepEqual(decodeSnapshots("a", enc.a.snapshots), detail.a.snapshots);
});

/**
 * The reason data.json can stop shipping priceHistory at all: the dashboard must rebuild it
 * exactly, including the run-status filter that only okRunIds can supply. The db below gives
 * it something to get wrong — a failed run that still wrote snapshots, which is what happens
 * when a scrape crashes between recordListings() and finishRun().
 */
test("the dashboard rebuilds priceHistory exactly as getPriceHistory would", () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mobde-codec-")), "t.sqlite"));
  db.prepare(
    `INSERT INTO listing (id, first_seen_at, last_seen_at, first_seen_run, last_seen_run)
     VALUES (?, 't', 't', 1, 1)`,
  ).run("a");
  db.prepare("INSERT INTO listing (id, first_seen_at, last_seen_at, first_seen_run, last_seen_run) VALUES ('b','t','t',1,1)").run();
  for (const [id, status] of [[1, "ok"], [2, "ok"], [3, "failed"], [4, "ok"]]) {
    db.prepare("INSERT INTO run (id, started_at, status) VALUES (?, ?, ?)").run(id, `t${id}`, status);
  }
  const ins = db.prepare(
    "INSERT INTO snapshot (listing_id, run_id, seen_at, price_eur, mileage_km) VALUES (?, ?, ?, ?, ?)",
  );
  for (const id of ["a", "b"]) {
    ins.run(id, 1, "t1", 100, 10);
    ins.run(id, 2, "t2", null, 20); // no price: excluded by getPriceHistory
    ins.run(id, 3, "t3", 300, 30); // failed run: excluded too
    ins.run(id, 4, "t4", 400, 40);
  }

  const details = encodeDetails(
    Object.fromEntries(
      ["a", "b"].map((id) => [
        id,
        { snapshots: db.prepare("SELECT * FROM snapshot WHERE listing_id = ? ORDER BY seen_at, id").all(id).map(({ raw, ...r }) => r) },
      ]),
    ),
  );
  const cache = new Map(
    Object.entries(details).map(([id, d]) => [id, { ...d, snapshots: decodeSnapshots(id, d.snapshots) }]),
  );

  const derived = derivePriceHistory({ okRunIds: getOkRunIds(db), detailsEncoding: DETAILS_ENCODING }, cache);
  // node:sqlite hands back null-prototype rows; compare what the browser actually receives.
  assert.deepEqual(derived, JSON.parse(JSON.stringify(getPriceHistory(db))));
  assert.equal(derived.length, 4, "two listings x two ok runs carrying a price");
  db.close();
});
