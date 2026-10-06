# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                      # one dependency: playwright-core (no browser download)
npm test                         # extractor, storage and history round-trip tests
npm run scrape                   # scrape and record; skips if the last success was too recent
npm run scrape -- --force        # ignore the minimum-interval guard
npm run scrape -- --dry-run      # fetch and parse, print, write nothing
npm run scrape -- --debug        # also dump fetched HTML to debug/
npm run serve                    # dashboard on http://localhost:8477 (127.0.0.1 only)
npm run stats                    # terminal summary
npm run build                    # build the static dashboard into dist/
npm run history:export           # SQLite -> history/*.ndjson
npm run history:import           # history/*.ndjson -> SQLite (DESTRUCTIVE: rebuilds the db)
```

Run one test file, or one test by name:

```bash
node --experimental-sqlite --no-warnings --test test/extract.test.js
node --experimental-sqlite --no-warnings --test --test-name-pattern="normalizeVat" test/*.test.js
```

Pass the glob, not the directory — a bare `test/` is resolved as a module path and fails with
`MODULE_NOT_FOUND`.

Every script needs `--experimental-sqlite` because storage is `node:sqlite` (Node >= 22.5), not
`better-sqlite3`. There is no build step, bundler, linter or framework anywhere in the project.

Env overrides, useful for working without touching real data:

- `MOBILEDE_DB=/path/to/copy.sqlite` — point any command at a different database
- `MOBILEDE_HISTORY=/path/to/dir` — point history export/import at a different directory
- `PORT=9000 npm run serve`

## Architecture

Pipeline, in dependency order:

```
browser.js  spawn Chrome, attach over CDP
   └─ scrape.js   orchestrate: guard, paginate, validate, record
        ├─ extract.js   page JSON -> normalised rows
        └─ db.js        run / listing / snapshot / change / event
             ├─ queries.js    read models for both the server and the static build
             │    ├─ server.js       live API + static files
             │    └─ build-site.js   dist/ for GitHub Pages
             └─ history.js    SQLite <-> history/*.ndjson (the durable record)
```

### Chrome must be spawned, not launched

mobile.de serves a real Chrome started as an ordinary process and attached over CDP. It returns
403 or a denial page for plain `fetch`, headless Chrome, **and** `chromium.launch()` — that last
one is the trap, since it looks like the obvious refactor. `browser.js` therefore spawns the
binary with `--remote-debugging-port` and connects via `connectOverCDP`. Never replace that with
`chromium.launch()`.

A real display is required. On Linux/CI that means `xvfb-run`; `browser.js` refuses to start
without `DISPLAY` rather than falling back to headless, which would just be blocked.

### The blocker is Akamai Bot Manager, and it is cookie-shaped

Confirmed from response headers (`akamai-grn`, `akamai-request-bc`, `x-akamai-transformed`) and
the cookies it sets: `_abck` (a **one-year** trust token), `bm_s`, `bm_so`, `bm_lso`, `bm_sz`,
`ak_bmsc`, `bm_sc`. Three consequences shape the code:

- **Chrome must exit gracefully or the token is lost.** A profile is only written on clean
  shutdown, and `browser.close()` merely detaches a CDP connection — on a browser we attached to
  rather than launched, the process keeps running. `close()` therefore sends CDP `Browser.close`
  and waits, killing only as a backstop. Before that, `keepProfile: true` was persisting a cookie
  store with **zero** rows. It works: a denied CI run still ends with 7 rows on disk.
- **A block must not be retried.** Akamai answers a suspect request with a soft denial — a 200
  whose title is "Zugriff verweigert" — and re-requesting from the same IP 45 s later escalates
  it to a hard 403. `maxAttemptsPerPage` is 1 for that reason. `detectBlock()` checks status
  before content, so a `denial page (title)` in the log means the status was *not* 403.
- **Volume is the lever that matters.** Two thirds of runs were being denied at 12 runs a day
  against a path `robots.txt` disallows; the cron is 6-hourly now.
- **"Wait for the block to clear" is vaguer than it sounds.** Every job draws a different address
  from the ~28 million GitHub publishes for Actions, so consecutive denials are not one IP being
  punished. What is actually constant across runs is the *network reputation of the range* — which
  other people's traffic moves as much as yours — and the *client*: same Chrome build, same flags,
  same 1440x900 xvfb screen, same CDP attachment, same two-page pattern. Re-running by hand
  neither helps nor obviously hurts; it mostly re-samples a score you do not control. The one
  documented escalation is retrying the same IP *within a run*, which is why `maxAttemptsPerPage`
  is 1.

CI caches only the cookie store — a whole profile is ~130 MB of model and metrics data Chrome
recreates anyway — and saves it only after a successful scrape, so a token carrying Akamai's
rejection is never handed to the next run. `--password-store=basic` on Linux pins cookie
encryption to Chrome's built-in key; without it the store is encrypted per-machine and moving it
between runners silently achieves nothing.

**On a Linux runner Chrome keeps its cookies at `.chrome-profile/Default/Cookies`, not
`Default/Network/Cookies`.** The latter is the Windows layout (Chrome 96 moved the store into
`Network/`; a fresh Linux profile here still uses the old location). Hardcoding it meant no cache
was written once between 2026-08-11 and 2026-09-01 — every run in that window arrived
cookie-less. `actions/cache` and `hashFiles()` were both
reporting the truth: a `path` that resolves to nothing is a warning, not a failure, so the job
stayed green and silent for three weeks. Confirmed from a run that printed
`cookie store at .chrome-profile/Default/Cookies — 28672 bytes, 7 rows`.

So the workflow caches a `chrome-state/` that **mirrors the profile's own layout**, which makes
the Windows/Linux split irrelevant: restoring is `cp -a chrome-state/. .chrome-profile/`. It
carries `Default/Cookies`, `Default/Network`, `Default/Local Storage`, `Default/History` and
`Default/Preferences` — about 350 KB.

Cookies alone were not enough, and were arguably worse than nothing: a profile that presents
`bm_lso` (Akamai's local-storage marker) while its localStorage is empty, with a History showing
it has never been to the site, is in a state no real returning visitor is ever in. Carry the
consistent set or none of it.

**`Service Worker` is deliberately excluded.** It is the largest part by far, and a stale worker
can serve a cached page instead of the live one — which would poison the scrape with yesterday's
listings and look like a data bug, not a caching one.

A cache is only worth having if you can see it working, so both steps print what they found, the
save refuses a store with zero rows, and the staging step runs even on a denied scrape — where
Chrome put its profile is worth knowing either way.

**Cold-start is not what gets a run denied, and the three weeks of broken cache are the proof.**
All 140 runs to 2026-09-01 went out cookie-less and 130 of them succeeded — a 7% block rate with
no token at all. Any claim that arriving cold is "the state Akamai challenges" is therefore
untested folklore; treat the cookie cache as an experiment, not a fix.

It may even cut the other way. Every job draws a fresh address from the ~28 million GitHub
publishes for Actions, so a reused `_abck` is always presented from an IP that did not earn it,
and a token bound to network context reads as replay. The cookie lifetimes sharpen this: at a
6-hourly cadence `ak_bmsc` (2 h), `bm_sv` (2 h) and `bm_sz` (4 h) are all dead before the next
run, so what actually crosses is essentially `_abck` alone — the long-lived one, and the one most
likely to be bound.

So the workflow does not bet either way: **state that was restored and then blocked is deleted**,
and the next run starts cold. That needs `actions: write`. Only an actual denial counts — a runner
whose Chrome failed to start says nothing about the cookies — so the step greps `scrape.out` for
`blocked by mobile.de` before touching anything. If reuse is harmful the system finds out on its
own; if it helps, the cache simply persists.

### Two page variants, and the bug class they cause

mobile.de alternates between **three** SRP implementations. `extract.js` supports all of them
and never parses HTML — the result set is embedded as JSON.

| Variant | Detected as | Result array | Notes |
|---|---|---|---|
| RSC | `rsc` | `searchResults.listings` | Next.js flight stream, 42 keys per listing |
| legacy | `initial-state` | `searchResults.items` | `window.__INITIAL_STATE__`, also carries `numPages`/`hasNextPage` |
| reworked | `rsc` | `searchResults.listings` | 15 keys; display fields only in the render tree |

The reworked one is the trap: it is an RSC page too, so `variant` **cannot** tell it from the
first. Its listing markup carries `isCosSrpMigrationVariant: true`, and its `searchResults`
dropped title, subtitle, VAT, preview image, seller name and `onlineSince`. `renderTreeFields()`
reads them all back out of the rendered component props, joining them to listing ids via
the numbered slot testIds (`base-result-listing-3` and its `-title` / `-image` / `-price-section`
children). Only lat/lon are genuinely gone from the page — those keep their last known value.

**Seller name and `onlineSince` are one hop further out, and the hop is the whole difficulty.**
The flight stream is a sequence of `<id>:<json>` lines, and a node tree refers to another chunk
by putting the string `"$L<id>"` where that chunk's value belongs; React resolves those on the
client. The seller card and the details section are chunks of their own, so a parser that walks
only the slot's own subtree stops at the placeholder and sees nothing — which is why both were
documented here as unrecoverable for two months. `flightChunks()` indexes the chunks by id and
`findNode()` steps through `$L` references while searching, after which the fields read out
like any other. The cost of the omission: **every ad first seen from run 125 on had both stored
as null**, because COALESCE can only carry forward a value some earlier run observed, and a new
listing has none to carry. 10 of the 50 listings in `history/` were affected.

Neither field has an exact testId, so each is read with a fallback, as VAT is. The seller name
is tagged by a CSS-module class (`SellerInfo-module__<build hash>__dealerName`) whose hash moves
every deploy, so only the `__dealerName` suffix is matched, and if that is renamed the first
span rendering plain text inside `seller-info` is taken instead. `onlineSince` is matched as a
date (`5/13/2026, 12:35`) inside the `online-since` node rather than by stripping the
"Ad online since" label, so localising the page cannot empty the column.

**The variants format identical data differently, so any field stored verbatim can produce
phantom diffs or broken values whenever the served variant flips.** This has happened
repeatedly in production:

- VAT — `19.00% VAT` vs `19% VAT`. One run recorded 25 phantom changes out of 26.
- image URL — `img.classistatic.de/…` with no scheme and no `rule` param, vs a full
  `https://…?rule=mo-160w`. Scheme-less URLs resolve against the dashboard's own origin and
  404; the CDN also rejects a missing `rule` with HTTP 400.
- the reworked SRP's missing fields — 87 phantom changes in one run, and a silent wipe of every
  photo and seller name, because `listing` is updated in place. Fixed on both sides: the parser
  recovers what it can, and `updateListing` COALESCEs so an absent field can never overwrite a
  known value. `diff()` also ignores transitions to or from null — a field appearing or
  vanishing describes the page we were served, not the car.
- listing date — `created` (variant A only) and `onlineSince` (all three) are *different
  dates*: when the ad was first written versus when the current listing went live, 14 months
  apart for 426267925. Reading `created` first meant the column jumped whenever the served
  variant flipped. `onlineSince` wins now — it is the one all three carry, the one the site
  itself prints, and the one 23 of 24 stored values already came from.
- seller type — the reworked payload kept only `contact.enumType` (`DEALER`) where the others
  send `Dealer`. `normalizeSellerEnum()` restores the display form.
- VAT again, from the other direction — run 263 (2026-10-02) was served an rsc page whose
  render tree gave up every other field but whose `price-vat` testId matched nothing, so all 41
  listings recorded their rate as removed. The tell is in the log: **4.00 recovered fields per
  listing, where a page carrying VAT gave 4.83** (6.83 since seller name and `onlineSince`
  were added to the recovery — compare runs against each other, not against a fixed number).
  `vatFromPriceNode()` now falls back to
  scanning the price node's rendered text, which survives the tag being renamed. That fallback
  has to run over `textOf()` output and not the node's JSON — the rate is split across sibling
  children (`["19","% VAT"]`), so in serialised form the number and the unit are never adjacent.

When adding or changing an extracted field, check it against **all three** fixtures and assert
its shape rather than its presence — the broken image URL satisfied `assert.ok(r.image)`, and 31
hollow listings satisfied every count-based guard. The strongest test available is
cross-variant: for ads present in two fixtures, the display fields must be byte-identical, which
is what catches a mis-joined render tree that per-row null checks cannot see. If a run reports
an implausible `changed` count, group `history/change.ndjson` by field; that is how all three
bugs were found.

### history/ is the durable record, not data/mobile.sqlite

The SQLite file and the built `data.json` are rewritten wholesale every run, so committing
either would add a fresh ~200 KB binary blob on every scheduled run. `history/*.ndjson` is append-mostly
instead, so git deltas it well. Consequences worth knowing:

- `snapshot.raw` is deliberately excluded from the export. `getListingDetail()` strips the
  column too, so a locally built `data.json` matches a CI-built one byte for byte.
- CI rebuilds the database from `history/` on every run, so the committed NDJSON is the source
  of truth. A fresh clone reproduces the whole dashboard via `npm run history:import`.
- `importHistory()` advances `sqlite_sequence` past the imported ids; without that the next
  insert collides on the primary key.
- Adding a column means adding it to the explicit column lists in `history.js`, or it silently
  stops being persisted.

### Fail loudly, never silently empty

The same reasoning applies one level down, to columns rather than rows. `null` in a snapshot
column is overloaded: it means both "this car has no VAT rate" (true of ~15% of listings on any
day) and "the page didn't tell us". Per listing the two are indistinguishable; per run they are
not, because 41 of 41 dropping at once is a parse failure, not 41 dealers switching to margin
taxation on the same afternoon. `collapsedFields()` in `db.js` compares each watched field's
coverage against the previous run and, when it falls from ≥50% to exactly zero, **carries the
last value forward instead of storing null, skips the diff, and records the field in
`run.unobserved_fields`**.

Carrying forward is the part that is easy to leave out and that does half the work. Suppressing
only the diff still writes the null, and the next run to see the field diffs against it and logs
the change in reverse — runs 52/57/63 lost VAT and run 64 logged 25 changes putting it back;
run 263 lost it again for 35 more. Both waves come from the same stored null.

The threshold is empirical, not a guess: across 239 runs and six watched fields, per-run VAT
coverage has only ever been 80–87% or exactly 0%, never anything between, and replaying the rule
over the whole history fires it on runs 52, 57, 63 and 263 and on nothing else. A single listing
losing a field is still recorded as a change — that asymmetry is deliberate and `run 13` is why:
a dealer turned a new car into a used demo, and `condition` going "New car" -> null belonged to
the same event as its price, mileage and owner count moving.

A collapse is **not** fatal. Run 263's price, mileage and spec data were all correct, and
discarding the run to avoid one bad column would lose more than it saves — so the scrape logs a
WARNING and carries on. `run.variant` is persisted for the same reason the guard exists: the
variant was previously only ever written to stdout, and diagnosing run 263 after the fact meant
reading a CI log that needs admin rights and expires.

A scrape that returns nothing looks identical to "every car was delisted", which would mark
every ad removed. So `extract.js` throws rather than returning `[]`, and `scrape.js` aborts if
zero listings were collected or fewer than half of `numResultsTotal`. `markRemoved()` only runs
after a fully successful scrape. Failed runs are still recorded in `run` so gaps stay
explainable. Preserve this invariant when touching the scrape path.

### One dashboard file, two serving modes

`public/index.html` is a single ~1400-line file with no framework. It tries the live API first
and falls back to a bundled `data.json`, so the local and published dashboards cannot drift.
Static mode has no API, so `build-site.js` bundles per-listing detail into `data.json`.

All chart colours are CSS `var()`, never resolved in JS, so a theme change repaints SVG without
a re-render. Filters, sort, hidden columns and favourites persist in `localStorage`; stored
values are validated on load so a stale one cannot leave the page in a state with no visible
cause. Favourites are the deliberate exception and are never pruned against current data — a
favourited car can vanish and return, and discarding the id would destroy user data.

## Workflows

- **scrape and publish** — cron `17 */6 * * *`, plus `workflow_dispatch` and a push filter on
  its own file. Restores the cached Chrome cookie store, imports history, scrapes under xvfb,
  saves the cookie store again if the scrape succeeded, exports, commits, publishes.
- **publish dashboard** — rebuilds and deploys from committed history with no network access to
  mobile.de and no write permission. Use this to republish without scraping.
- **probe mobile.de reachability** — one-off diagnostic; commits findings to `probe-result.md`.

Two coupled settings: `config.json`'s `minMinutesBetweenRuns` must stay well under the cron
interval, or scheduled runs exit as "skipped" while looking successful. A **shrink guard** in the
scrape workflow refuses to commit a history that lost lines, so a failure upstream cannot wipe
accumulated data.

Editing `.github/workflows/scrape.yml` triggers a scrape, because of its own push filter. Keep
that in mind when the intent is only to change the schedule.

GitHub's scheduler is best-effort: slots arrive late (16 minutes observed) or are dropped
entirely with nothing queued or logged. Check `/actions/runs` via the API — unauthenticated
works for a public repo — before concluding a workflow is broken.

## Testing

Fixtures in `test/fixtures/*.html` are **gitignored**: they are captured mobile.de pages
containing dealer names, addresses and phone numbers, and this is a public repo. Tests that need
them skip with a message rather than failing, so a fresh clone shows passes and skips, never red.
Capture your own with `npm run scrape -- --dry-run --debug` and copy from `debug/`.

All three page variants must keep working, so most extractor and storage tests run against every
fixture:

| Fixture | Variant |
|---|---|
| `srp-2026-08-05.html` | RSC, full payload |
| `srp-legacy-2026-08-05.html` | `window.__INITIAL_STATE__` |
| `srp-migrated-2026-08-11.html` | reworked RSC, display fields only rendered |

Each is gated separately, so a clone holding only some of them still runs what it can.

When fixing a data bug, verify the new test fails with the fix reverted — that is how the VAT,
image-URL and reworked-SRP regressions were each confirmed to test anything at all.
