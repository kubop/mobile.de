/**
 * Read-side queries for the dashboard. Kept separate from db.js (the write side) so the
 * server never touches the scrape logic.
 */

/** Latest snapshot per listing, joined onto listing identity. */
const LATEST = `
  SELECT s.* FROM snapshot s
  JOIN (SELECT listing_id, MAX(id) AS mid FROM snapshot GROUP BY listing_id) m
    ON m.mid = s.id
`;

export function getRuns(db, limit = 200) {
  return db
    .prepare(
      `SELECT id, started_at, finished_at, status, pages_fetched, num_results_total,
              listings_seen, new_count, removed_count, changed_count, duration_ms, error
       FROM run ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

export function getListings(db) {
  return db
    .prepare(`
      WITH latest AS (${LATEST}),
      first_snap AS (
        SELECT s.listing_id, s.price_eur AS first_price
        FROM snapshot s
        JOIN (SELECT listing_id, MIN(id) AS mid FROM snapshot GROUP BY listing_id) m
          ON m.mid = s.id
      )
      SELECT
        l.id, l.url, l.make, l.model, l.title, l.short_title, l.sub_title,
        l.first_registration, l.first_reg_ym, l.category, l.seller_type, l.seller_name,
        l.country, l.zip, l.location, l.image, l.created_at,
        l.first_seen_at, l.last_seen_at, l.removed_at,
        latest.price_eur, latest.mileage_km, latest.previous_owners, latest.power_kw,
        latest.power_hp, latest.fuel, latest.transmission, latest.condition,
        latest.has_damage, latest.vat, latest.price_rating, latest.price_rating_label,
        latest.num_images, latest.color, latest.doors, latest.seats, latest.cubic_capacity,
        latest.weight_kg, latest.euro_class, latest.inspection, latest.consumption,
        latest.emissions, latest.seen_at AS latest_seen_at,
        first_snap.first_price,
        (latest.price_eur - first_snap.first_price) AS price_delta,
        (SELECT COUNT(*) FROM snapshot s2 WHERE s2.listing_id = l.id) AS snapshot_count,
        (SELECT COUNT(*) FROM change c WHERE c.listing_id = l.id AND c.field = 'price_eur')
          AS price_change_count
      FROM listing l
      JOIN latest ON latest.listing_id = l.id
      LEFT JOIN first_snap ON first_snap.listing_id = l.id
      ORDER BY l.removed_at IS NOT NULL, latest.price_eur
    `)
    .all();
}

export function getPriceHistory(db) {
  return db
    .prepare(
      `SELECT listing_id, seen_at, price_eur, mileage_km
       FROM snapshot WHERE price_eur IS NOT NULL ORDER BY listing_id, seen_at`,
    )
    .all();
}

/** Per-run market aggregates — the "is this market moving" chart. */
export function getMarketTimeline(db) {
  return db
    .prepare(`
      SELECT r.id AS run_id, r.started_at,
             COUNT(s.id) AS active,
             ROUND(AVG(s.price_eur)) AS avg_price,
             MIN(s.price_eur) AS min_price,
             MAX(s.price_eur) AS max_price,
             ROUND(AVG(s.mileage_km)) AS avg_mileage
      FROM run r
      JOIN snapshot s ON s.run_id = r.id
      WHERE r.status = 'ok'
      GROUP BY r.id
      ORDER BY r.started_at, r.id
    `)
    .all();
}

/** Median can't be done with AVG, so compute per-run medians in JS. */
export function getMedianTimeline(db) {
  const rows = db
    .prepare(
      `SELECT s.run_id, r.started_at, s.price_eur
       FROM snapshot s JOIN run r ON r.id = s.run_id
       WHERE r.status='ok' AND s.price_eur IS NOT NULL
       ORDER BY r.started_at, s.run_id, s.price_eur`,
    )
    .all();
  const byRun = new Map();
  for (const r of rows) {
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, { started_at: r.started_at, prices: [] });
    byRun.get(r.run_id).prices.push(r.price_eur);
  }
  return [...byRun.entries()]
    .map(([run_id, v]) => {
      const p = v.prices;
      const mid = Math.floor(p.length / 2);
      return {
        run_id,
        started_at: v.started_at,
        median_price: p.length % 2 ? p[mid] : Math.round((p[mid - 1] + p[mid]) / 2),
        n: p.length,
      };
    })
    .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.run_id - b.run_id));
}

export function getChanges(db, limit = 400) {
  return db
    .prepare(`
      SELECT c.id, c.listing_id, c.run_id, c.at, c.field, c.old_value, c.new_value,
             l.title, l.short_title, l.sub_title, l.url, l.seller_name
      FROM change c LEFT JOIN listing l ON l.id = c.listing_id
      ORDER BY c.at DESC, c.id DESC LIMIT ?
    `)
    .all(limit);
}

export function getEvents(db, limit = 400) {
  return db
    .prepare(`
      SELECT e.id, e.listing_id, e.run_id, e.at, e.type,
             l.title, l.short_title, l.sub_title, l.url, l.seller_name, l.image,
             (SELECT price_eur FROM snapshot s WHERE s.listing_id = e.listing_id
              ORDER BY s.id DESC LIMIT 1) AS price_eur,
             (SELECT mileage_km FROM snapshot s WHERE s.listing_id = e.listing_id
              ORDER BY s.id DESC LIMIT 1) AS mileage_km
      FROM event e LEFT JOIN listing l ON l.id = e.listing_id
      ORDER BY e.at DESC, e.id DESC LIMIT ?
    `)
    .all(limit);
}

export function getOverview(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const active = one("SELECT COUNT(*) c FROM listing WHERE removed_at IS NULL").c;
  const removed = one("SELECT COUNT(*) c FROM listing WHERE removed_at IS NOT NULL").c;
  const lastRun = one("SELECT * FROM run WHERE status='ok' ORDER BY id DESC LIMIT 1");
  const prevRun = one("SELECT * FROM run WHERE status='ok' ORDER BY id DESC LIMIT 1 OFFSET 1");
  const lastFailed = one("SELECT * FROM run WHERE status='failed' ORDER BY id DESC LIMIT 1");

  const priceAgg = one(`
    WITH latest AS (${LATEST})
    SELECT COUNT(price_eur) n, MIN(price_eur) min, MAX(price_eur) max, ROUND(AVG(price_eur)) avg
    FROM latest
    JOIN listing l ON l.id = latest.listing_id
    WHERE l.removed_at IS NULL
  `);

  const prices = db
    .prepare(`
      WITH latest AS (${LATEST})
      SELECT price_eur FROM latest
      JOIN listing l ON l.id = latest.listing_id
      WHERE l.removed_at IS NULL AND price_eur IS NOT NULL ORDER BY price_eur
    `)
    .all()
    .map((r) => r.price_eur);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length
    ? prices.length % 2
      ? prices[mid]
      : Math.round((prices[mid - 1] + prices[mid]) / 2)
    : null;

  return {
    active,
    removed,
    totalTracked: active + removed,
    lastRun: lastRun ?? null,
    prevRun: prevRun ?? null,
    lastFailedRun: lastFailed ?? null,
    runCount: one("SELECT COUNT(*) c FROM run WHERE status='ok'").c,
    snapshotCount: one("SELECT COUNT(*) c FROM snapshot").c,
    priceMin: priceAgg.min,
    priceMax: priceAgg.max,
    priceAvg: priceAgg.avg,
    priceMedian: median,
    priceDrops: one("SELECT COUNT(*) c FROM change WHERE field='price_eur' AND CAST(new_value AS INTEGER) < CAST(old_value AS INTEGER)").c,
    priceRises: one("SELECT COUNT(*) c FROM change WHERE field='price_eur' AND CAST(new_value AS INTEGER) > CAST(old_value AS INTEGER)").c,
  };
}

export function getListingDetail(db, id) {
  const listing = db.prepare("SELECT * FROM listing WHERE id = ?").get(id);
  if (!listing) return null;
  return {
    listing,
    snapshots: db
      .prepare("SELECT * FROM snapshot WHERE listing_id = ? ORDER BY seen_at, id").all(id),
    changes: db
      .prepare("SELECT * FROM change WHERE listing_id = ? ORDER BY at DESC, id DESC").all(id),
    events: db
      .prepare("SELECT * FROM event WHERE listing_id = ? ORDER BY at DESC, id DESC").all(id),
  };
}
