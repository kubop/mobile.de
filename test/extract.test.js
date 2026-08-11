import test from "node:test";
import assert from "node:assert/strict";
import { loadFixture, skipIfMissing } from "./fixtures.js";
import {
  extractSearchResults,
  normalizeListing,
  dedupeById,
  parsePrice,
  parsePower,
  parseMonthYear,
  parseInteger,
  parseOnlineSince,
  normalizeVat,
  normalizeImageUrl,
  normalizeSellerEnum,
} from "../src/extract.js";

// mobile.de alternates between SRP implementations; all of them must keep working.
const A = "srp-2026-08-05.html"; // variant A: RSC flight payload, full data
const B = "srp-legacy-2026-08-05.html"; // variant B: window.__INITIAL_STATE__
const C = "srp-migrated-2026-08-11.html"; // variant C: reworked RSC, display fields only rendered
const skip = skipIfMissing(A, B);
const skipC = skipIfMissing(C);
const skipAll = skipIfMissing(A, B, C);
const fixture = loadFixture(A);
const legacy = loadFixture(B);
const migrated = loadFixture(C);

/** Every variant reports itself as one of these; C is indistinguishable from A by name alone. */
const rowsOf = (html) => dedupeById(extractSearchResults(html).listings).map(normalizeListing);

test("parsePrice handles both separator styles", () => {
  assert.equal(parsePrice("€419,640"), 419640);
  assert.equal(parsePrice("419.640 €"), 419640);
  assert.equal(parsePrice("$undefined"), null);
  assert.equal(parsePrice(null), null);
});

test("parsePower splits kW and hp", () => {
  assert.deepEqual(parsePower("552 kW (751 hp)"), { kw: 552, hp: 751 });
  assert.deepEqual(parsePower("405 kW (551 PS)"), { kw: 405, hp: 551 });
  assert.deepEqual(parsePower(null), { kw: null, hp: null });
});

test("parseMonthYear normalises to sortable YYYY-MM", () => {
  assert.equal(parseMonthYear("03/2026"), "2026-03");
  assert.equal(parseMonthYear("12/2023"), "2023-12");
  assert.equal(parseMonthYear("New"), null);
});

test("parseInteger strips units and keeps zero", () => {
  assert.equal(parseInteger("1,500 km"), 1500);
  assert.equal(parseInteger("0 km"), 0);
  assert.equal(parseInteger("1,413 kg"), 1413);
  assert.equal(parseInteger("$undefined"), null);
});

test("parseOnlineSince converts the legacy date string", () => {
  assert.equal(parseOnlineSince("5/13/2026, 12:35"), Math.floor(Date.UTC(2026, 4, 13, 12, 35) / 1000));
  assert.equal(parseOnlineSince("$undefined"), null);
  assert.equal(parseOnlineSince("nonsense"), null);
});

test("normalizeImageUrl produces a usable absolute URL", () => {
  // The RSC variant ships this shape. Stored verbatim it resolves against the dashboard's own
  // origin and 404s; and the CDN returns 400 when the rule parameter is missing, so the scheme
  // alone is not enough.
  assert.equal(
    normalizeImageUrl("img.classistatic.de/api/v1/mo-prod/images/50/abc"),
    "https://img.classistatic.de/api/v1/mo-prod/images/50/abc?rule=mo-160w",
  );
  assert.equal(
    normalizeImageUrl("//img.classistatic.de/x"),
    "https://img.classistatic.de/x?rule=mo-160w",
    "protocol-relative",
  );
  const already = "https://img.classistatic.de/x?rule=mo-160w";
  assert.equal(normalizeImageUrl(already), already, "the legacy variant's URL is left alone");
  assert.equal(
    normalizeImageUrl("https://img.classistatic.de/x?foo=1"),
    "https://img.classistatic.de/x?foo=1&rule=mo-160w",
    "appends to an existing query string",
  );
  assert.equal(normalizeImageUrl("$undefined"), null);
  assert.equal(normalizeImageUrl(null), null);
});

test("both variants yield absolute image URLs with a size rule", { skip }, () => {
  // The original test only asserted an image was present, which the broken bare form satisfied.
  for (const [name, html] of [["rsc", fixture], ["legacy", legacy]]) {
    const imgs = dedupeById(extractSearchResults(html).listings).map(normalizeListing).map((r) => r.image);
    assert.ok(imgs.length > 0, `${name} has listings`);
    for (const u of imgs.filter(Boolean)) {
      assert.match(u, /^https:\/\//, `${name}: ${u} is absolute`);
      assert.match(u, /[?&]rule=mo-\d+w/, `${name}: ${u} carries a size rule`);
    }
  }
});

test("normalizeVat collapses the two variants' formatting to one value", () => {
  // The bug this exists for: one run logged 25 phantom VAT changes out of 26 because the served
  // page implementation flipped.
  assert.equal(normalizeVat("19.00% VAT"), "19% VAT");
  assert.equal(normalizeVat("19% VAT"), "19% VAT");
  assert.equal(normalizeVat("21.00% VAT"), "21% VAT");
  assert.equal(normalizeVat("19.50% VAT"), "19.5% VAT", "a real fraction is kept");
  assert.equal(normalizeVat("19,00% VAT"), "19% VAT", "comma decimal separator");
  assert.equal(normalizeVat("VAT not deductible"), "VAT not deductible", "non-numeric passes through");
  assert.equal(normalizeVat("$undefined"), null);
  assert.equal(normalizeVat(null), null);
});

test("both page variants agree on VAT after normalisation", { skip }, () => {
  const vats = (html) =>
    [...new Set(dedupeById(extractSearchResults(html).listings).map(normalizeListing).map((r) => r.vat))]
      .filter(Boolean)
      .sort();
  // Before the fix these differed only by "19%" vs "19.00%", and every flip looked like a change.
  assert.deepEqual(vats(fixture), vats(legacy));
  for (const v of vats(fixture)) assert.doesNotMatch(v, /\.\d*0%/, `${v} carries no trailing zeros`);
});

test("extracts the full result set from variant A (RSC)", { skip }, () => {
  const { variant, numResultsTotal, listings } = extractSearchResults(fixture);
  assert.equal(variant, "rsc");
  assert.equal(numResultsTotal, 32);
  assert.equal(listings.length, 24);
  assert.equal(dedupeById(listings).length, 21, "sponsored slots repeat ads");
});

test("extracts the full result set from variant B (legacy __INITIAL_STATE__)", { skip }, () => {
  const r = extractSearchResults(legacy);
  assert.equal(r.variant, "initial-state");
  assert.equal(r.numResultsTotal, 32);
  assert.equal(r.numPages, 2, "legacy variant reports page count directly");
  assert.equal(r.hasNextPage, true);
  assert.equal(r.page, 1);
  assert.equal(r.listings.length, 21);
  assert.equal(r.adSlotsSkipped, 5, "interleaved advertising slots are dropped");
  for (const l of r.listings) assert.match(String(l.id), /^\d+$/);
});

test("variant B normalises to the same shape with prices and specs intact", { skip }, () => {
  const { listings } = extractSearchResults(legacy);
  const rows = dedupeById(listings).map(normalizeListing);

  for (const r of rows) {
    assert.ok(r.id, "id present");
    assert.ok(Number.isInteger(r.priceEur), `price parsed for ${r.id} (legacy variant)`);
    assert.equal(r.make, "McLaren", `make resolved for ${r.id}`);
    assert.equal(r.model, "750S", `model resolved for ${r.id}`);
    assert.ok(r.sellerName, `seller resolved for ${r.id}`);
    assert.ok(r.image, `image resolved for ${r.id}`);
  }

  const one = rows.find((r) => r.id === "455696026");
  assert.equal(one.priceEur, 324640);
  assert.equal(one.mileageKm, 6900);
  assert.equal(one.previousOwners, 1);
  assert.equal(one.firstRegYm, "2024-04");
  assert.equal(one.powerKw, 551);
  assert.equal(one.sellerName, "Auto Individuell Automotive GmbH");
  assert.equal(one.vat, "19% VAT");
  assert.equal(one.country, "DE");
  assert.ok(one.createdAt, "createdAt derived from onlineSince");
});

test("both variants produce identical field sets", { skip }, () => {
  const a = normalizeListing(extractSearchResults(fixture).listings[0]);
  const b = normalizeListing(extractSearchResults(legacy).listings[0]);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
});

test("normalises a used car with all comparison fields", { skip }, () => {
  const { listings } = extractSearchResults(fixture);
  const raw = listings.find((l) => String(l.id) === "443379399");
  const n = normalizeListing(raw);

  assert.equal(n.id, "443379399");
  assert.equal(n.priceEur, 307950);
  assert.equal(n.mileageKm, 24500);
  assert.equal(n.previousOwners, 4);
  assert.equal(n.firstRegYm, "2024-01");
  assert.equal(n.powerKw, 552);
  assert.equal(n.powerHp, 751);
  assert.equal(n.conditionNew, 0);
  assert.equal(n.make, "McLaren");
  assert.equal(n.model, "750S");
  assert.match(n.url, /id=443379399/);
});

test("every listing yields an id and a price", { skip }, () => {
  const { listings } = extractSearchResults(fixture);
  const rows = dedupeById(listings).map(normalizeListing);
  for (const r of rows) {
    assert.ok(r.id, "id present");
    assert.ok(Number.isInteger(r.priceEur), `price parsed for ${r.id}`);
  }
});

test("normalized rows only contain SQLite-bindable values", { skip }, () => {
  for (const html of [fixture, legacy]) {
    const { listings } = extractSearchResults(html);
    for (const r of dedupeById(listings).map(normalizeListing)) {
      for (const [k, v] of Object.entries(r)) {
        const ok = v === null || typeof v === "string" || typeof v === "number";
        assert.ok(ok, `${k} is bindable (got ${typeof v})`);
      }
    }
  }
});

test("throws loudly rather than returning empty on an unusable page", () => {
  assert.throws(
    () => extractSearchResults("<html><body>Access denied</body></html>"),
    /could not extract searchResults/,
  );
});

test("normalizeSellerEnum recovers the display form of the seller type", () => {
  // The reworked SRP kept only contact.enumType ("DEALER"). Stored verbatim it would make the
  // column alternate Dealer/DEALER as the served variant flips.
  assert.equal(normalizeSellerEnum("DEALER"), "Dealer");
  assert.equal(normalizeSellerEnum("PRIVATE"), "Private");
  assert.equal(normalizeSellerEnum("Dealer"), "Dealer", "idempotent on the display form");
  assert.equal(normalizeSellerEnum("$undefined"), null);
  assert.equal(normalizeSellerEnum(null), null);
});

test("the reworked SRP ships a slimmed payload that still parses", { skip: skipC }, () => {
  const res = extractSearchResults(migrated);
  // It is an RSC page like variant A, so `variant` alone cannot tell them apart — the tell is
  // that searchResults no longer carries the display fields.
  assert.equal(res.variant, "rsc");
  assert.equal(res.numResultsTotal, 31);
  assert.ok(res.listings.length > 0, "listings were found");
  assert.ok(res.repairedFields > 0, "fields were recovered from the render tree");
});

test("every variant populates the display fields for every listing", { skip: skipAll }, () => {
  // Asserts shape, not presence. This is the test the bug would have failed: variant C parsed
  // fine and returned the right number of listings, all of them hollow. Revert the render-tree
  // parser in extract.js and this fails on C with title/subTitle/shortTitle/image all null.
  const REQUIRED = ["id", "url", "make", "model", "title", "shortTitle", "subTitle", "image", "sellerType", "priceEur"];
  for (const [name, html] of [["A", fixture], ["B", legacy], ["C", migrated]]) {
    const rows = rowsOf(html);
    assert.ok(rows.length > 0, `${name} has listings`);
    for (const r of rows) {
      for (const f of REQUIRED) assert.ok(r[f] != null, `${name}: listing ${r.id} has ${f}`);
    }
  }
});

test("variants agree field-for-field on the ads they share", { skip: skipAll }, () => {
  // The strongest guard against a mis-joined render tree: an off-by-one in the slot mapping
  // would attach a neighbour's title or photo, which no per-row null check would notice.
  // priceEur is excluded — it genuinely moved between the Aug 5 and Aug 11 captures.
  const AGREE = ["title", "shortTitle", "subTitle", "image", "vat", "sellerType"];
  const byId = (html) => new Map(rowsOf(html).map((r) => [String(r.id), r]));
  const variants = { A: byId(fixture), B: byId(legacy), C: byId(migrated) };

  for (const [x, y] of [["A", "C"], ["B", "C"], ["A", "B"]]) {
    const shared = [...variants[x].keys()].filter((id) => variants[y].has(id));
    assert.ok(shared.length >= 10, `${x} and ${y} share enough ads to compare (${shared.length})`);
    for (const id of shared) {
      for (const f of AGREE) {
        assert.equal(
          variants[x].get(id)[f] ?? null,
          variants[y].get(id)[f] ?? null,
          `${f} agrees between ${x} and ${y} for listing ${id}`,
        );
      }
    }
  }
});
