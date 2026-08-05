/**
 * mobile.de embeds the complete, already-structured result set in the page, so we never touch
 * the DOM. It ships TWO different SRP implementations (they alternate between them, so both
 * must keep working):
 *
 *   A) Next.js App Router — the RSC "flight" stream, a series of
 *      self.__next_f.push([1, "<escaped chunk>"]) calls; result array is searchResults.listings
 *   B) Legacy — window.__INITIAL_STATE__ = {...}; result array is searchResults.items,
 *      and it helpfully also carries page/numPages/hasNextPage
 *
 * In both cases the payload is inline JSON, so the same "find the searchResults object and
 * take a balanced slice" trick works; we just search two haystacks.
 */

/** Concatenate the RSC flight stream chunks back into one string. */
export function reassembleFlight(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
  for (const m of html.matchAll(re)) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      /* skip malformed chunk */
    }
  }
  return chunks.join("");
}

/** Slice a balanced {...} or [...] starting at `from`, respecting strings and escapes. */
function balancedSlice(s, from) {
  const open = s[from];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * The legacy variant interleaves advertising slots into `items` (type "inlineAdvertising",
 * "page1Ads", …). Those have no numeric id and are not vehicles.
 */
function isVehicleListing(l) {
  return !!l && l.id != null && /^\d+$/.test(String(l.id));
}

/** Scan one string for a "searchResults" object that actually carries a result array. */
function findSearchResults(haystack) {
  const key = '"searchResults":';
  let at = -1;
  let lastErr = null;
  while ((at = haystack.indexOf(key, at + 1)) !== -1) {
    const braceAt = haystack.indexOf("{", at + key.length);
    if (braceAt === -1) continue;
    const raw = balancedSlice(haystack, braceAt);
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      // Variant A calls it `listings`, variant B calls it `items`.
      if (Array.isArray(obj.listings) || Array.isArray(obj.items)) return { obj, err: null };
    } catch (e) {
      lastErr = e;
    }
  }
  return { obj: null, err: lastErr };
}

/**
 * Extract { numResultsTotal, listings, numPages, hasNextPage, variant } from a rendered SRP.
 * Throws on failure — a silent empty result would look identical to "every car was delisted".
 */
export function extractSearchResults(html) {
  const flight = reassembleFlight(html);

  const candidates = [
    ["rsc", flight],
    // The legacy payload is inline JSON in the raw HTML, so search it directly.
    ["initial-state", html],
  ];

  let lastErr = null;
  for (const [variant, haystack] of candidates) {
    if (!haystack) continue;
    const { obj, err } = findSearchResults(haystack);
    if (err) lastErr = err;
    if (!obj) continue;

    const all = obj.listings ?? obj.items;
    const listings = all.filter(isVehicleListing);

    return {
      variant,
      numResultsTotal: Number.isFinite(obj.numResultsTotal) ? obj.numResultsTotal : null,
      numPages: Number.isFinite(obj.numPages) ? obj.numPages : null,
      hasNextPage: typeof obj.hasNextPage === "boolean" ? obj.hasNextPage : null,
      page: Number.isFinite(obj.page) ? obj.page : null,
      listings,
      adSlotsSkipped: all.length - listings.length,
    };
  }

  throw new Error(
    "could not extract searchResults from the page — neither the RSC flight payload " +
      `(${flight.length} chars) nor window.__INITIAL_STATE__ yielded a result array; ` +
      "mobile.de may have changed its page structure" +
      (lastErr ? ` (last JSON error: ${lastErr.message})` : ""),
  );
}

// ---------------------------------------------------------------------------
// Normalisation: mobile.de ships display strings ("€419,640", "1,500 km",
// "552 kW (751 hp)"). Parse them into numbers so we can chart and compare.
// ---------------------------------------------------------------------------

/** "$undefined" is the RSC marker for an absent value. */
const clean = (v) => (v === undefined || v === null || v === "$undefined" || v === "" ? null : v);

/**
 * Canonicalise a VAT rate.
 *
 * The two page implementations format the same rate differently — the RSC variant emits
 * "19.00% VAT", the legacy one "19% VAT". Since mobile.de alternates between them, storing the
 * string verbatim made nearly every listing look like it changed each time the variant flipped:
 * one run recorded 25 such phantom changes out of 26. Percentages are reduced to their shortest
 * exact form, so the two agree. Anything that is not a percentage passes through untouched.
 */
export function normalizeVat(v) {
  const s = clean(v);
  if (s === null || typeof s !== "string") return s;
  return s.replace(/(\d+)(?:[.,](\d+))?\s*%/, (_m, whole, frac) => {
    const trimmed = (frac ?? "").replace(/0+$/, "");
    return trimmed ? `${whole}.${trimmed}%` : `${whole}%`;
  });
}

/**
 * Canonicalise a preview-image URL.
 *
 * The second place the two page implementations disagree (see normalizeVat for the first). The
 * legacy variant emits a full "https://…?rule=mo-160w"; the RSC variant emits a bare
 * "img.classistatic.de/…" with no scheme and no rule. Stored verbatim, the bare form resolves
 * relative to the dashboard's own origin, so every photo 404s — and the CDN rejects the URL with
 * HTTP 400 if the rule parameter is missing, so adding the scheme alone is not enough.
 */
export function normalizeImageUrl(v) {
  const s = clean(v);
  if (s === null || typeof s !== "string") return s;
  let url = s.trim();
  if (!url) return null;
  if (url.startsWith("//")) url = `https:${url}`;
  else if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  // mo-160w matches what the legacy variant ships, keeping one canonical stored form. Larger
  // sizes are derived from it at display time.
  if (!/[?&]rule=/.test(url)) url += `${url.includes("?") ? "&" : "?"}rule=mo-160w`;
  return url;
}

export function parseInteger(s) {
  const v = clean(s);
  if (v === null) return null;
  if (typeof v === "number") return Math.round(v);
  const digits = String(v).replace(/[^\d]/g, "");
  return digits ? Number.parseInt(digits, 10) : null;
}

/** "€419,640" / "419.640 €" -> 419640. Handles both thousand separators. */
export function parsePrice(s) {
  const v = clean(s);
  if (v === null) return null;
  const m = String(v).match(/[\d.,\s]+/);
  if (!m) return null;
  const digits = m[0].replace(/[^\d]/g, "");
  return digits ? Number.parseInt(digits, 10) : null;
}

/** "552 kW (751 hp)" -> { kw: 552, hp: 751 } */
export function parsePower(s) {
  const v = clean(s);
  if (v === null) return { kw: null, hp: null };
  const kw = v.match(/([\d.,]+)\s*kW/i);
  const hp = v.match(/([\d.,]+)\s*(?:hp|PS)/i);
  return { kw: kw ? parseInteger(kw[1]) : null, hp: hp ? parseInteger(hp[1]) : null };
}

/** "03/2026" -> "2026-03" (sortable); anything else passed through as null. */
export function parseMonthYear(s) {
  const v = clean(s);
  if (v === null) return null;
  const m = String(v).match(/^(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[2]}-${m[1].padStart(2, "0")}`;
}

export function listingUrl(id) {
  return `https://suchen.mobile.de/fahrzeuge/details.html?id=${id}&lang=en`;
}

/** "5/13/2026, 12:35" (variant B's onlineSince) -> unix seconds, or null. */
export function parseOnlineSince(s) {
  const v = clean(s);
  if (v === null) return null;
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, mo, d, y, hh = "0", mm = "0"] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * SQLite only binds null/number/string. If mobile.de turns a scalar field into an object
 * (as it did with priceRating), coerce rather than lose the whole run to a bind error.
 */
function toBindable(row) {
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) row[k] = null;
    else if (typeof v === "boolean") row[k] = v ? 1 : 0;
    else if (v !== null && typeof v === "object") row[k] = JSON.stringify(v);
  }
  return row;
}

export function normalizeListing(raw) {
  const a = raw.attr ?? {};
  const power = parsePower(a.pw);
  const contact = raw.contact ?? raw.contactInfo ?? {};

  // Keep a raw copy for future-proofing, minus the bulky image/thumbnail lists.
  const rawSlim = { ...raw };
  for (const k of ["images", "previewThumbnails", "financePlans", "attributes"]) delete rawSlim[k];
  if (rawSlim.contact) rawSlim.contact = { ...rawSlim.contact, logo: undefined };
  if (rawSlim.contactInfo) rawSlim.contactInfo = { ...rawSlim.contactInfo, logo: undefined };

  // Variant B (legacy) uses different containers than variant A (RSC) for these; read both.
  const price = raw.price ?? {};
  const priceEur =
    (Number.isFinite(price.grossAmount) ? Math.round(price.grossAmount) : null) ??
    (Number.isFinite(price.grs?.amount) ? Math.round(price.grs.amount) : null) ??
    parsePrice(raw.p) ??
    parsePrice(price.gross) ??
    parsePrice(price.grs?.localized);
  const priceRaw = clean(raw.p) ?? clean(price.gross) ?? clean(price.grs?.localized);
  const makeName = typeof raw.make === "string" ? clean(raw.make) : clean(raw.make?.localized);
  const modelName = typeof raw.model === "string" ? clean(raw.model) : clean(raw.model?.localized);
  const image = normalizeImageUrl(raw.images?.[0]?.uri) ?? normalizeImageUrl(raw.previewImage?.src);

  return toBindable({
    id: String(raw.id),
    url: listingUrl(raw.id),

    // Identity / slow-changing
    make: makeName,
    model: modelName,
    title: clean(raw.title) ?? clean(raw.shortTitle) ?? null,
    shortTitle: clean(raw.shortTitle),
    subTitle: clean(raw.subTitle),
    firstRegistration: clean(a.fr),
    firstRegYm: parseMonthYear(a.fr),
    yearOfConstruction: parseInteger(a.yc),
    category: clean(a.c) ?? clean(raw.category),
    subCategory: clean(a.subc),
    sellerType: clean(raw.st) ?? clean(contact.type) ?? clean(contact.typeLocalized),
    sellerName: clean(contact.name),
    sellerId: clean(raw.sellerId) ?? null,
    country: clean(a.cn) ?? clean(contact.country),
    zip: clean(a.z),
    location: clean(a.loc) ?? clean(contact.location),
    lat: contact.latLong?.lat ?? null,
    lon: contact.latLong?.lon ?? null,
    image,
    createdAt: clean(raw.created) ?? parseOnlineSince(raw.onlineSince),

    // Per-snapshot / volatile
    priceEur,
    priceRaw,
    mileageKm: parseInteger(a.ml),
    previousOwners: parseInteger(a.pvo),
    powerKw: power.kw,
    powerHp: power.hp,
    fuel: clean(a.ft),
    transmission: clean(a.tr),
    condition: clean(a.con),
    conditionNew: raw.isConditionNew ? 1 : 0,
    hasDamage: raw.hasDamage ? 1 : 0,
    readyToDrive: raw.readyToDrive ? 1 : 0,
    vat: normalizeVat(raw.vat) ?? normalizeVat(price.vat),
    // priceRating is an object: { rating, ratingLabel, noRatingReason }.
    priceRating: clean(raw.priceRating?.rating),
    priceRatingLabel: clean(raw.priceRating?.ratingLabel),
    numImages: parseInteger(raw.numImages),
    color: clean(a.ecol),
    doors: clean(a.door),
    seats: clean(a.sc),
    cubicCapacity: parseInteger(a.cc),
    weightKg: parseInteger(a.nw),
    euroClass: clean(a.emc),
    inspection: clean(a.gi),
    consumption: clean(a.csmpt),
    emissions: clean(a.emiss),
    modifiedAt: clean(raw.modified),
    raw: JSON.stringify(rawSlim),
  });
}

/**
 * Dedupe by id, preserving first-seen order. Sponsored / eye-catcher slots repeat the same
 * ad within and across pages, so the raw arrays contain duplicates.
 */
export function dedupeById(listings) {
  const seen = new Set();
  const out = [];
  for (const l of listings) {
    const id = String(l.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(l);
  }
  return out;
}
