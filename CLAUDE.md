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

### Two page variants, and the bug class they cause

mobile.de alternates between an `rsc` implementation (Next.js flight stream) and an
`initial-state` one (`window.__INITIAL_STATE__`). `extract.js` supports both and never parses
HTML — the complete result set is embedded as JSON.

**The variants format identical data differently, so any field stored verbatim can produce
phantom diffs or broken values whenever the served variant flips.** This has happened twice in
production:

- VAT — `19.00% VAT` vs `19% VAT`. One run recorded 25 phantom changes out of 26.
- image URL — `img.classistatic.de/…` with no scheme and no `rule` param, vs a full
  `https://…?rule=mo-160w`. Scheme-less URLs resolve against the dashboard's own origin and
  404; the CDN also rejects a missing `rule` with HTTP 400.

`normalizeVat()` and `normalizeImageUrl()` fix these. When adding or changing an extracted
field, check it against **both** fixtures, and assert its shape rather than its presence — the
broken image URL satisfied `assert.ok(r.image)`. If a run reports an implausible `changed`
count, group `history/change.ndjson` by field; that is how both bugs were found.

### history/ is the durable record, not data/mobile.sqlite

The SQLite file and the built `data.json` are rewritten wholesale every run, so committing
either would add a fresh ~200 KB binary blob 12 times a day. `history/*.ndjson` is append-mostly
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

- **scrape and publish** — cron `17 */2 * * *`, plus `workflow_dispatch` and a push filter on
  its own file. Imports history, scrapes under xvfb, exports, commits, publishes.
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

Both page variants must keep working, so most extractor and storage tests run against both
fixtures. When fixing a data bug, verify the new test fails with the fix reverted — that is how
the VAT and image-URL regressions were confirmed to test anything at all.
