/**
 * Git-friendly history format.
 *
 * The SQLite file and the built data.json are both rewritten in full on every run, so
 * committing either would add a fresh ~200 KB+ binary blob 3x/day and bloat the repo into
 * gigabytes within a year. These NDJSON files are append-mostly instead: a run adds ~32 lines
 * at the end, which git deltas almost perfectly (~10 KB/run, a few MB/year).
 *
 * `snapshot.raw` (the full original listing JSON, ~2.3 KB each) is deliberately NOT exported —
 * it is a local debugging convenience and would be ~80 MB/year of committed text.
 *
 *   node src/history.js export   # SQLite -> history/*.ndjson
 *   node src/history.js import   # history/*.ndjson -> SQLite (rebuilds data/mobile.sqlite)
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { openDb } from "./db.js";

export const historyDir = process.env.MOBILEDE_HISTORY || path.join(paths.root, "history");

/** Column lists are explicit so a schema change can't silently drop a field from history. */
const TABLES = {
  run: {
    order: "id",
    columns: [
      "id", "started_at", "finished_at", "status", "pages_fetched", "num_results_total",
      "listings_seen", "new_count", "removed_count", "changed_count", "duration_ms", "error",
    ],
  },
  listing: {
    order: "id",
    columns: [
      "id", "url", "make", "model", "title", "short_title", "sub_title", "first_registration",
      "first_reg_ym", "year_of_construction", "category", "sub_category", "seller_type",
      "seller_name", "seller_id", "country", "zip", "location", "lat", "lon", "image",
      "created_at", "first_seen_at", "last_seen_at", "first_seen_run", "last_seen_run",
      "removed_at",
    ],
  },
  snapshot: {
    order: "id",
    // `raw` intentionally excluded — see the note above.
    columns: [
      "id", "listing_id", "run_id", "seen_at", "price_eur", "price_raw", "mileage_km",
      "previous_owners", "power_kw", "power_hp", "condition", "condition_new", "has_damage",
      "ready_to_drive", "vat", "color", "cubic_capacity", "inspection", "modified_at",
    ],
  },
  change: {
    order: "id",
    columns: ["id", "listing_id", "run_id", "at", "field", "old_value", "new_value"],
  },
  event: {
    order: "id",
    columns: ["id", "listing_id", "run_id", "at", "type"],
  },
};

const fileFor = (table, dir = historyDir) => path.join(dir, `${table}.ndjson`);

export function exportHistory(db = null, dir = historyDir) {
  const own = !db;
  db = db ?? openDb();
  fs.mkdirSync(dir, { recursive: true });
  const counts = {};
  try {
    for (const [table, spec] of Object.entries(TABLES)) {
      const rows = db
        .prepare(`SELECT ${spec.columns.join(", ")} FROM ${table} ORDER BY ${spec.order}`)
        .all();
      // One JSON object per line, keys in a fixed order, so diffs stay minimal and readable.
      const text = rows.map((r) => JSON.stringify(Object.fromEntries(spec.columns.map((c) => [c, r[c] ?? null])))).join("\n");
      fs.writeFileSync(fileFor(table, dir), rows.length ? text + "\n" : "");
      counts[table] = rows.length;
    }
  } finally {
    if (own) db.close();
  }
  return counts;
}

function readNdjson(table, dir = historyDir) {
  const f = fileFor(table, dir);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`${table}.ndjson line ${i + 1} is not valid JSON: ${e.message}`);
      }
    });
}

/**
 * Rebuild the SQLite database from the committed history. Destructive by design: the NDJSON
 * is the source of truth in the GitHub flow, so this always starts from a clean database.
 */
export function importHistory(dbPath = paths.db, dir = historyDir) {
  fs.rmSync(dbPath, { force: true });
  for (const s of ["-wal", "-shm"]) fs.rmSync(dbPath + s, { force: true });

  const db = openDb(dbPath);
  const counts = {};
  db.exec("BEGIN");
  try {
    for (const [table, spec] of Object.entries(TABLES)) {
      const rows = readNdjson(table, dir);
      if (rows.length) {
        const cols = spec.columns;
        const stmt = db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        );
        for (const r of rows) stmt.run(...cols.map((c) => r[c] ?? null));
      }
      counts[table] = rows.length;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.close();
    throw e;
  }

  // AUTOINCREMENT sequences must be advanced past the imported ids, or the next scrape
  // collides on the primary key.
  for (const table of Object.keys(TABLES)) {
    const max = db.prepare(`SELECT MAX(id) m FROM ${table}`).get().m;
    if (max != null) {
      db.prepare(
        "INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS " +
          "(SELECT 1 FROM sqlite_sequence WHERE name = ?)",
      ).run(table, max, table);
      db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq < ?").run(max, table, max);
    }
  }
  db.close();
  return counts;
}

// ------------------------------------------------------------------------------ CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("history.js")) {
  const mode = process.argv[2];
  if (mode === "export") {
    const c = exportHistory();
    console.log(`exported to history/: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  } else if (mode === "import") {
    if (!fs.existsSync(fileFor("listing"))) {
      console.log("no history/ to import — starting from an empty database");
      process.exit(0);
    }
    const c = importHistory();
    console.log(`imported from history/: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  } else {
    console.log("usage: node src/history.js <export|import>");
    process.exit(1);
  }
}
