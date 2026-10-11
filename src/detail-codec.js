/**
 * Delta encoding for the per-listing snapshot arrays that ride along in dist/data.json.
 *
 * A snapshot is written every run even when nothing changed (see db.js), which is what makes
 * "price held steady for three weeks" distinguishable from "we stopped looking" — but it also
 * means ~85% of the rows in a static build repeat the row before them verbatim. The live
 * server never pays for that (it serves one listing's detail on demand); the static build
 * bundles all of it, so data.json was 4 MB and growing ~14 KB per run.
 *
 * So each row is stored as its identity plus only the columns that differ from the row before
 * it, and the dashboard replays them on load. Measured over 272 runs: 4076 KB -> 1457 KB raw,
 * 228 KB -> 107 KB gzipped, and the per-run growth drops from 14.4 KB to 1.7 KB.
 *
 * Two rules keep the replay honest, and both exist because of bugs this project has already
 * had:
 *
 *   - A field going to null is written as an explicit `null`, never omitted. Omission means
 *     "unchanged", so the two must not be spelled the same way — that is the exact null
 *     overloading `collapsedFields()` exists to break, and getting it backwards here would
 *     make a VAT collapse invisible in the drawer by carrying the old rate forward.
 *   - The first row of every listing carries every column, so the replay never starts from a
 *     partially known state.
 *
 * The decoder is mirrored verbatim inside public/index.html (which is served standalone and
 * cannot import this file). test/detail-codec.test.js extracts that copy and round-trips real
 * data through it, so the two cannot drift.
 */

export const DETAILS_ENCODING = "snapshot-delta-1";

/** Columns that identify a row rather than describe the car: always written out in full. */
const ROW_KEYS = new Set(["id", "listing_id", "run_id", "seen_at"]);

/**
 * One listing's snapshots -> [id, run_id, seen_at, patch] rows.
 *
 * Walks the union of the keys seen so far and the keys on this row, so a column that stops
 * being selected reads as null and is diffed as one, rather than silently inheriting the last
 * value through the gap.
 */
export function encodeSnapshots(snapshots) {
  const resolved = new Map();
  return snapshots.map((s) => {
    const patch = {};
    for (const k of new Set([...resolved.keys(), ...Object.keys(s)])) {
      if (ROW_KEYS.has(k)) continue;
      const v = k in s ? s[k] : null;
      if (!resolved.has(k) || resolved.get(k) !== v) {
        patch[k] = v;
        resolved.set(k, v);
      }
    }
    return [s.id, s.run_id, s.seen_at, patch];
  });
}

/** Inverse of encodeSnapshots. Mirrored in public/index.html — change both together. */
export function decodeSnapshots(listingId, rows) {
  const resolved = {};
  return rows.map(([id, runId, seenAt, patch]) => {
    Object.assign(resolved, patch);
    return { id, listing_id: listingId, run_id: runId, seen_at: seenAt, ...resolved };
  });
}

/** Encodes the `snapshots` of every entry in a getListingDetail() map, leaving the rest alone. */
export function encodeDetails(details) {
  return Object.fromEntries(
    Object.entries(details).map(([id, d]) => [
      id,
      d && { ...d, snapshots: encodeSnapshots(d.snapshots) },
    ]),
  );
}
