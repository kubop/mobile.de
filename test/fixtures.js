import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fixture HTML is captured mobile.de output — dealer names, addresses and phone numbers
 * included — so it is deliberately NOT committed (see .gitignore). Capture your own with:
 *
 *   npm run scrape -- --dry-run --debug
 *   cp debug/page-1-attempt-1.html test/fixtures/srp-2026-08-05.html
 *
 * Tests that need a fixture skip with a message rather than failing when it is absent, and each
 * fixture is gated separately so a clone holding only some of them still runs what it can.
 *
 * Three variants are covered — see the page-variants section of CLAUDE.md. Which one you capture
 * depends on what mobile.de serves that minute; check `variant` in the scrape log, and whether
 * the listings carry a `title`, to know which one you got.
 */

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixture(name) {
  const f = path.join(dir, name);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}

export function skipIfMissing(...fixtures) {
  const missing = fixtures.filter((f) => !fs.existsSync(path.join(dir, f)));
  return missing.length
    ? `needs uncommitted fixture(s): ${missing.join(", ")} — see test/fixtures.js`
    : false;
}
