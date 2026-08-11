import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { paths, nowIso } from "./config.js";

/**
 * Storage model:
 *   run      — one row per scrape attempt (including failures, so gaps are explainable)
 *   listing  — one row per ad, holding identity + first_seen/last_seen/removed_at
 *   snapshot — append-only, one row per listing per successful run (this is the price history)
 *   change   — a field-level diff feed (price drops etc.)
 *   event    — new / removed / relisted markers
 *
 * A snapshot is written every run even when nothing changed, so charts have real sample
 * points and "price held steady for 3 weeks" is distinguishable from "we stopped looking".
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,
  pages_fetched     INTEGER,
  num_results_total INTEGER,
  listings_seen     INTEGER,
  new_count         INTEGER,
  removed_count     INTEGER,
  changed_count     INTEGER,
  duration_ms       INTEGER,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS listing (
  id                   TEXT PRIMARY KEY,
  url                  TEXT,
  make                 TEXT,
  model                TEXT,
  title                TEXT,
  short_title          TEXT,
  sub_title            TEXT,
  first_registration   TEXT,
  first_reg_ym         TEXT,
  year_of_construction INTEGER,
  category             TEXT,
  sub_category         TEXT,
  seller_type          TEXT,
  seller_name          TEXT,
  seller_id            TEXT,
  country              TEXT,
  zip                  TEXT,
  location             TEXT,
  lat                  REAL,
  lon                  REAL,
  image                TEXT,
  created_at           INTEGER,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  first_seen_run       INTEGER NOT NULL,
  last_seen_run        INTEGER NOT NULL,
  removed_at           TEXT
);

CREATE TABLE IF NOT EXISTS snapshot (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id         TEXT NOT NULL,
  run_id             INTEGER NOT NULL,
  seen_at            TEXT NOT NULL,
  price_eur          INTEGER,
  price_raw          TEXT,
  mileage_km         INTEGER,
  previous_owners    INTEGER,
  power_kw           INTEGER,
  power_hp           INTEGER,
  condition          TEXT,
  condition_new      INTEGER,
  has_damage         INTEGER,
  ready_to_drive     INTEGER,
  vat                TEXT,
  color              TEXT,
  cubic_capacity     INTEGER,
  inspection         TEXT,
  modified_at        INTEGER,
  raw                TEXT,
  FOREIGN KEY (listing_id) REFERENCES listing(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_listing ON snapshot(listing_id, seen_at);
CREATE INDEX IF NOT EXISTS idx_snapshot_run     ON snapshot(run_id);

CREATE TABLE IF NOT EXISTS change (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  run_id     INTEGER NOT NULL,
  at         TEXT NOT NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_at ON change(at DESC);

CREATE TABLE IF NOT EXISTS event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  run_id     INTEGER,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_at ON event(at DESC);
`;

/** Volatile fields worth a change-feed entry, diffed against the previous snapshot row. */
const WATCHED_SNAPSHOT = [
  ["priceEur", "price_eur"],
  ["mileageKm", "mileage_km"],
  ["previousOwners", "previous_owners"],
  ["vat", "vat"],
  ["condition", "condition"],
  ["inspection", "inspection"],
];

/** Same idea, but these columns live on `listing`, so they diff against the pre-update row. */
const WATCHED_LISTING = [
  ["title", "title"],
  ["subTitle", "sub_title"],
];

export function openDb(dbPath = paths.db) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function lastSuccessfulRun(db) {
  return db.prepare("SELECT * FROM run WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() ?? null;
}

export function startRun(db) {
  const at = nowIso();
  db.prepare("INSERT INTO run (started_at, status) VALUES (?, 'running')").run(at);
  return { id: Number(db.prepare("SELECT last_insert_rowid() AS id").get().id), startedAt: at };
}

export function failRun(db, runId, error, pagesFetched = 0, durationMs = null) {
  db.prepare(
    `UPDATE run SET status='failed', finished_at=?, error=?, pages_fetched=?, duration_ms=? WHERE id=?`,
  ).run(nowIso(), String(error).slice(0, 2000), pagesFetched, durationMs, runId);
}

export function finishRun(db, runId, stats) {
  db.prepare(
    `UPDATE run SET status='ok', finished_at=?, pages_fetched=?, num_results_total=?,
       listings_seen=?, new_count=?, removed_count=?, changed_count=?, duration_ms=?
     WHERE id=?`,
  ).run(
    nowIso(),
    stats.pagesFetched,
    stats.numResultsTotal,
    stats.listingsSeen,
    stats.newCount,
    stats.removedCount,
    stats.changedCount,
    stats.durationMs,
    runId,
  );
}

/**
 * Record one run's worth of listings. Returns { newIds, relistedIds, changes }.
 * Wrapped in a transaction so a mid-write crash can't leave a half-recorded run.
 */
export function recordListings(db, runId, seenAt, rows) {
  const newIds = [];
  const relistedIds = [];
  const changes = [];

  // Includes the watched listing-level columns so we can diff them before overwriting.
  const getListing = db.prepare("SELECT id, removed_at, title, sub_title FROM listing WHERE id = ?");
  const getPrevSnap = db.prepare(
    "SELECT * FROM snapshot WHERE listing_id = ? ORDER BY seen_at DESC, id DESC LIMIT 1",
  );

  const insertListing = db.prepare(`
    INSERT INTO listing (
      id, url, make, model, title, short_title, sub_title, first_registration, first_reg_ym,
      year_of_construction, category, sub_category, seller_type, seller_name, seller_id,
      country, zip, location, lat, lon, image, created_at,
      first_seen_at, last_seen_at, first_seen_run, last_seen_run, removed_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
    )`);

  /**
   * Identity fields can legitimately be edited by the seller, so refresh them each run — but
   * COALESCE, never blindly.
   *
   * This is the only copy of these values: `listing` is updated in place, unlike `snapshot`,
   * which appends a row per run. When the reworked SRP stopped shipping the display fields, an
   * unconditional overwrite wiped every car's photo, title and seller name with no change-feed
   * entry and nothing in the run summary — the dashboard simply lost its images until a run
   * happened to be served the older page. A field mobile.de did not send is an absence of
   * information, so the last known value is kept.
   */
  const updateListing = db.prepare(`
    UPDATE listing SET
      url=?,
      make=COALESCE(?, make), model=COALESCE(?, model), title=COALESCE(?, title),
      short_title=COALESCE(?, short_title), sub_title=COALESCE(?, sub_title),
      first_registration=COALESCE(?, first_registration),
      first_reg_ym=COALESCE(?, first_reg_ym),
      year_of_construction=COALESCE(?, year_of_construction),
      category=COALESCE(?, category), sub_category=COALESCE(?, sub_category),
      seller_type=COALESCE(?, seller_type), seller_name=COALESCE(?, seller_name),
      seller_id=COALESCE(?, seller_id), country=COALESCE(?, country), zip=COALESCE(?, zip),
      location=COALESCE(?, location), lat=COALESCE(?, lat), lon=COALESCE(?, lon),
      image=COALESCE(?, image), created_at=COALESCE(?, created_at),
      last_seen_at=?, last_seen_run=?, removed_at=NULL
    WHERE id=?`);

  const insertSnapshot = db.prepare(`
    INSERT INTO snapshot (
      listing_id, run_id, seen_at, price_eur, price_raw, mileage_km, previous_owners,
      power_kw, power_hp, condition, condition_new, has_damage, ready_to_drive, vat,
      color, cubic_capacity, inspection, modified_at, raw
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`);

  const insertChange = db.prepare(
    "INSERT INTO change (listing_id, run_id, at, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO event (listing_id, run_id, at, type) VALUES (?, ?, ?, ?)",
  );

  const record = (id, col, before, after) => {
    const a = before == null ? null : String(before);
    const b = after == null ? null : String(after);
    if (a === b) return;
    insertChange.run(id, runId, seenAt, col, a, b);
    changes.push({ id, field: col, from: a, to: b });
  };

  /**
   * Snapshot fields are stored exactly as seen, so a value arriving or disappearing is a fact
   * about that run and worth recording. Run 13 is why this must not be suppressed: a dealer
   * turned a new car into a used demo, and `condition` going "New car" -> null was part of the
   * same real event as its price, mileage and owner count all moving.
   */
  const diffSnapshot = record;

  /**
   * Listing fields are COALESCEd on update, so when mobile.de sends nothing the stored value is
   * kept — there is no change to report, and claiming one would contradict what the table now
   * holds. This is what stops a variant flip from logging a title and subtitle change for every
   * car; the reworked SRP produced 62 such entries per flip.
   */
  const diffListing = (id, col, before, after) => {
    if (before == null || after == null) return;
    record(id, col, before, after);
  };

  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const existing = getListing.get(r.id);

      if (!existing) {
        insertListing.run(
          r.id, r.url, r.make, r.model, r.title, r.shortTitle, r.subTitle, r.firstRegistration,
          r.firstRegYm, r.yearOfConstruction, r.category, r.subCategory, r.sellerType,
          r.sellerName, r.sellerId == null ? null : String(r.sellerId), r.country, r.zip,
          r.location, r.lat, r.lon, r.image, r.createdAt, seenAt, seenAt, runId, runId,
        );
        newIds.push(r.id);
        insertEvent.run(r.id, runId, seenAt, "new");
      } else {
        const wasRemoved = existing.removed_at !== null;
        // Diff listing-level fields against the row as it stands *before* we overwrite it.
        for (const [jsKey, col] of WATCHED_LISTING) diffListing(r.id, col, existing[col], r[jsKey]);
        updateListing.run(
          r.url, r.make, r.model, r.title, r.shortTitle, r.subTitle, r.firstRegistration,
          r.firstRegYm, r.yearOfConstruction, r.category, r.subCategory, r.sellerType,
          r.sellerName, r.sellerId == null ? null : String(r.sellerId), r.country, r.zip,
          r.location, r.lat, r.lon, r.image, r.createdAt, seenAt, runId, r.id,
        );
        if (wasRemoved) {
          relistedIds.push(r.id);
          insertEvent.run(r.id, runId, seenAt, "relisted");
        }
      }

      // Diff against the previous snapshot before inserting the new one.
      const prev = getPrevSnap.get(r.id);
      if (prev) {
        for (const [jsKey, col] of WATCHED_SNAPSHOT) diffSnapshot(r.id, col, prev[col], r[jsKey]);
      }

      insertSnapshot.run(
        r.id, runId, seenAt, r.priceEur, r.priceRaw, r.mileageKm, r.previousOwners,
        r.powerKw, r.powerHp, r.condition, r.conditionNew, r.hasDamage, r.readyToDrive,
        r.vat, r.color, r.cubicCapacity, r.inspection, r.modifiedAt, r.raw,
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { newIds, relistedIds, changes };
}

/**
 * Anything not seen in this run is gone. Only ever call after a *fully successful* run —
 * a partial run would mass-flag live cars as removed.
 */
export function markRemoved(db, runId, seenAt) {
  const gone = db
    .prepare("SELECT id FROM listing WHERE removed_at IS NULL AND last_seen_run < ?")
    .all(runId)
    .map((r) => r.id);

  if (!gone.length) return [];

  db.exec("BEGIN");
  try {
    const upd = db.prepare("UPDATE listing SET removed_at = ? WHERE id = ?");
    const ev = db.prepare("INSERT INTO event (listing_id, run_id, at, type) VALUES (?, ?, ?, 'removed')");
    for (const id of gone) {
      upd.run(seenAt, id);
      ev.run(id, runId, seenAt);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return gone;
}
