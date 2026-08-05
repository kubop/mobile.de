# mobile.de tracker

Periodically snapshots a mobile.de search, stores every listing in SQLite, and serves a
dashboard showing price trends, new and removed listings, and side-by-side comparison of
mileage, registration date, previous owners and specs. Runs either locally or entirely on
GitHub Actions, publishing the dashboard to GitHub Pages for free.

**One npm dependency** (`playwright-core`, ~14 MB, no browser download). Everything else —
database, HTTP server, charts — uses what's already in Node 22 and your browser.

```
npm install
npm run scrape     # collect a snapshot
npm run serve      # dashboard at http://localhost:8477
npm run stats      # terminal summary
```

---

## Why it works this way

mobile.de actively blocks automated access. Measured on this machine against the configured
search URL:

| Approach | Result |
|---|---|
| `fetch()` with browser-like headers | **403** Access denied |
| `curl` with a full Chrome header set | **403** |
| Playwright → **headless** Chrome | **403** |
| Playwright **launches** Chrome, headed | **200, but still the denial page** (soft block) |
| Chrome launched as a normal process, attached over CDP | ✅ **works** |

So `src/browser.js` spawns `chrome.exe` itself with `--remote-debugging-port` and *then*
attaches Playwright via `connectOverCDP`. **Do not refactor that into `chromium.launch()`** —
that is precisely the case mobile.de rejects. The window is real and visible, just positioned
offscreen (`browser.offscreen` in `config.json`).

Once the page loads, no HTML parsing is involved: mobile.de embeds the complete, structured
result set in the page as JSON, and `src/extract.js` pulls it straight out.

### Two page variants

mobile.de alternates between two search-results implementations; both were observed live and
both are supported:

- **`rsc`** — Next.js App Router. Data arrives in the RSC flight stream
  (`self.__next_f.push([1, "…"])`); the array is `searchResults.listings`.
- **`initial-state`** — legacy. Data sits in `window.__INITIAL_STATE__`; the array is
  `searchResults.items`, interleaved with advertising slots (filtered out by id), and it
  helpfully also reports `numPages` / `hasNextPage`.

The scrape log prints which variant it got. `test/fixtures/` holds a captured page of each, and
`npm test` asserts both still normalise to the same shape — that is the early-warning system if
mobile.de changes something.

**The two variants format identical data differently, and storing a value verbatim has bitten
twice.** Both were live bugs, so treat this as the default suspicion for anything odd:

| Field | `rsc` emits | `initial-state` emits | Symptom before normalising |
|---|---|---|---|
| VAT | `19.00% VAT` | `19% VAT` | Every variant flip logged a change on nearly every listing — one run recorded 25 phantom changes out of 26 |
| image URL | `img.classistatic.de/…` (no scheme, no `rule`) | `https://…?rule=mo-160w` | Photos 404: a scheme-less URL resolves against the dashboard's own origin. The CDN also returns **400** if `rule` is missing, so adding the scheme alone is not enough |

`normalizeVat()` and `normalizeImageUrl()` in `extract.js` canonicalise both, with regression
tests that were each confirmed to fail when the fix is reverted. If a run ever reports an
implausible `changed` count, group the change records by field first — that is how both were
found. Asserting a field is merely *present* is not enough: the broken image URL satisfied
`assert.ok(r.image)` perfectly.

---

## Not spamming the site

Several independent brakes, all in `config.json` under `politeness`:

| Setting | Default | Effect |
|---|---|---|
| `minMinutesBetweenRuns` | 60 | A run that starts too soon after the last **successful** one exits without touching the network. Override with `--force`. Must stay well under the cron interval or scheduled runs silently skip. |
| `pageDelayMs` | 7–14 s | Randomised pause between pages, so requests aren't metronomic. |
| `settleMs` | 4–6.5 s | Wait for the payload after each navigation. |
| `maxAttemptsPerPage` | 2 | One retry, then give up — never hammer. |
| `blockedBackoffMs` | 45 s | Wait before that single retry. |

Plus: one browser session per run (not per page), a persistent Chrome profile so the cookie
banner is answered once, and a lock file preventing overlapping runs. A full run is **2 page
requests** — at the current 2-hourly cadence that's 24 requests a day.

> mobile.de's terms prohibit automated access. This is built for low-volume personal use of a
> search you'd otherwise refresh by hand. Keep it that way.

### Failing loudly

A scraper that silently returns nothing looks exactly like "every car was delisted", which
would wrongly mark all 32 ads as removed. So the run **aborts and records a failure** if:

- the page yields no parseable result set (`extract.js` throws rather than returning `[]`),
- zero listings were collected,
- fewer than half of `numResultsTotal` were collected (a partial run).

`markRemoved()` only ever runs after a fully successful scrape. Failed runs are kept in the
`run` table so gaps in the history are explainable, and the dashboard shows a banner when the
most recent attempt failed.

---

## Running it on GitHub instead (free)

This works, and it was verified rather than assumed. `.github/workflows/probe-cloud.yml` is a
one-off feasibility probe that repeats the local matrix on a GitHub-hosted runner:

| Test | On a GitHub runner (Azure IP, Cheyenne US) |
|---|---|
| plain `fetch` | 403 |
| headless Chrome | 403 |
| **real Chrome + CDP, under `xvfb`** | **200, listings parsed** ✅ |

The runner's datacenter IP is *not* the deciding factor — the browser fingerprint is, exactly as
on a home connection. `xvfb` supplies the virtual display that makes a "headed" browser possible
on a runner. Re-run the probe any time from the Actions tab; it commits its findings to
`probe-result.md`.

### One-time setup

1. Push the repo to GitHub.
2. **Settings → Pages → Source: GitHub Actions.** Without this the publish job fails.
3. Actions → *scrape and publish* → **Run workflow** to seed the first run.

The dashboard then lives at `https://<user>.github.io/<repo>/`.

Free-tier notes: Actions minutes are unlimited on public repos (2,000/month on private), and
**Pages on a private repo requires a paid plan** — free + hosted dashboard means a public repo,
which makes the scraped data public too.

### Republishing without scraping

**Actions → *publish dashboard* → Run workflow.** It rebuilds the database from the committed
history, builds `dist/` and deploys — no request to mobile.de, and no write access to the repo.
Use it to publish a dashboard change or bring Pages up to date with the latest commit.

It also runs automatically when you push a change to `public/index.html` or the build/query
code. It deliberately ignores `history/` changes, because the scrape workflow already publishes
after it commits and two simultaneous deployments would race.

### How the pieces fit

```
cron (every 2 h, UTC)
  └─ import history/*.ndjson ──▶ SQLite
       └─ scrape (xvfb + real Chrome)
            ├─ export history/*.ndjson ──▶ commit to the repo
            └─ build dist/ ─────────────▶ deploy to GitHub Pages
```

`history/` is the durable record, not `data/mobile.sqlite`. The SQLite file and the built
`data.json` are both rewritten wholesale every run, so committing either would add a fresh
~200 KB binary blob every run. The NDJSON files are append-mostly — a run adds ~32 lines — so
git deltas them almost perfectly — ~220 KB a day, roughly 80 MB of appended text a year at the
2-hourly cadence, which packs down well. `snapshot.raw` (the full original listing JSON, ~2.3 KB
per snapshot) is excluded from the export for the same reason: it would add another ~320 MB a
year, and nothing reads it. Its absence is also why `getListingDetail` strips the column, so a
locally built `data.json` matches a CI-built one byte for byte.

`npm run history:import` rebuilds the database from the committed history, so a fresh clone
reproduces the full dashboard, and `npm run build` produces the static site locally.

The same `public/index.html` serves both modes: it tries the live API first and falls back to a
bundled `data.json`, so the published page and the local one can never drift.

### Things to keep an eye on

- **Cron is best-effort, and this was measured, not assumed.** `17 */2 * * *` fires on even UTC
  hours at :17 (so 02:17, 04:17 … Prague during summer time, an hour earlier in winter — cron is
  UTC and does not shift with DST). Observed on the first day: one slot arrived **16 minutes
  late**, and an earlier one never ran at all. Nothing is queued or logged when a slot is
  dropped, so "no run appeared" is normal rather than evidence of a fault. Give a slot at least
  30 minutes before treating it as missed. The API is the quickest way to check what really
  happened:

  ```bash
  curl -s "https://api.github.com/repos/<user>/<repo>/actions/runs?per_page=20" \
    | grep -E '"event"|"conclusion"|"created_at"'
  ```

  No token is needed for a public repo. If nothing shows `"event": "schedule"`, the scheduler
  is the problem, not the workflow. Only an external cron calling the `workflow_dispatch` API
  gives guaranteed timing.
- **`minMinutesBetweenRuns` must stay well under the cron interval**, or runs are silently
  skipped. The two settings are coupled: a 2-hourly cron against the old 180-minute guard would
  have fired 12 times a day and actually scraped about 4, the rest exiting as "skipped" and
  looking like success. At a 120-minute cadence the guard is 60, so a run is only dropped when
  the previous one landed more than an hour late.
- **Scheduled workflows get disabled after ~60 days of repository inactivity.** GitHub emails
  you first. The bot's own history commits may not reset that timer, so if the scraper goes
  quiet, check whether the schedule was disabled.
- **A shrink guard protects the history.** If an export ever produces fewer lines than what's
  committed (an empty database because an earlier step died, say), the workflow refuses to
  commit and fails loudly rather than wiping your history.
- **Publishing continues even when a scrape fails**, so the dashboard shows the last good data
  with its "last attempt failed" banner instead of silently going stale.
- **If mobile.de starts blocking Azure ranges**, the run fails loudly and nothing is corrupted.
  Fall back to scraping locally (below) and pushing the history from your PC — the storage
  format and dashboard are identical either way.

---

## Scheduling it locally instead

The scraper needs an interactive desktop session, because the browser window is real.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
```

Registers a Windows Scheduled Task at 08:00 / 14:00 / 20:00, running as you, only while logged
on. Customise or remove:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Times 07:30,19:30
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Unregister
```

Output is appended to `data\scrape.log` (not rotated — delete it occasionally). Because of the
`minMinutesBetweenRuns` guard, extra triggers are harmless: they simply skip.

---

## Data model

Append-only, so history survives a listing being deleted from mobile.de.

| Table | Contents |
|---|---|
| `run` | One row per scrape attempt, successes and failures alike. |
| `listing` | One row per ad: identity, seller, `first_seen_at` / `last_seen_at` / `removed_at`. |
| `snapshot` | One row per listing **per run** — this is the price history. |
| `change` | Field-level diffs (price, mileage, owners, VAT, photos, title…). |
| `event` | `new` / `removed` / `relisted` markers. |

A snapshot is written every run even when nothing changed, so "price held steady for three
weeks" is distinguishable from "we stopped looking". At 32 cars × 12 runs/day that's ~140k rows
a year — nothing for SQLite.

A listing that disappears is marked `removed_at`, not deleted; if it comes back it's *relisted*,
not re-created, so its full price history stays attached.

**Identity is the mobile.de ad id, which has a known limit.** If a dealer deletes an ad and
posts a new one for the same car, it arrives as a new id: a new row, a `new` event and an empty
sparkline. The old ad keeps its full history and is still visible under *Show → Live + removed*,
but the two are not linked. This is deliberate — a wrong merge would invent a price change
between two different cars, which is worse than a visible gap. Auto-linking is also weaker than
it looks: `first_reg_ym` is `NULL` for the new/delivery-mileage ads, which are exactly the ones
dealers churn most, so a spec fingerprint is blind on nearly half the data. The preview photo
UUID is the strongest available signal; a VIN would settle it but is only on the detail page.

### Fields captured per snapshot

Price, mileage, first registration, previous owners, power (kW + hp), fuel, transmission,
condition, VAT, price rating, photo count, colour, doors, seats, engine size, kerb weight,
emission class, next inspection, consumption, emissions — plus seller, location and
coordinates on the listing.

`previous_owners`, `first_registration` and `euro_class` are only present on ads where the
seller filled them in (roughly 20 of 32 for owners at time of writing); missing values are
stored as `NULL` and shown as `—`.

---

## Dashboard

`npm run serve` → <http://localhost:8477>. Bound to `127.0.0.1` only.

- **Stat tiles** — live count, median price, average mileage, churn last run, price cuts.
- **Median asking price** and **listings on the market** over time (deliberately two separate
  charts — a dual-axis chart would imply a correlation that isn't in the data).
- **Price vs mileage** scatter, split into used and delivery-mileage cars.
- **Activity feed** — new/removed/relisted plus every field change.
- **Full table** — sortable, with an inline price sparkline per row; click any row for a
  drawer with the photo, a favourite toggle, the full price history and the spec sheet.
  **Columns** hides any column you don't want; the choice persists in `localStorage` per browser.

Filters at the top scope every chart, the feed and the table together. The **Auto / Light / Dark**
control picks the theme — Auto follows your OS. Both themes are explicitly styled and the chart
palette is validated for colour-vision deficiency.

**Photos** are hotlinked from mobile.de's CDN rather than copied into the repo — the same request
a browser makes when rendering their page, sent without a referrer. Only the four widths their
own `srcSet` advertises are used (160/240/360/1024); a plausible-looking `mo-720w` returns 404,
so the list is fixed rather than guessed. If an image ever fails to load the element is removed
instead of leaving a broken-image icon.

**Favourites.** The ★ column marks cars you care about, and the drawer has a labelled toggle
that states the current state. Sort by it to bring them to the top,
and they appear in the price-vs-mileage chart as stars rather than dots. That uses shape rather
than a third colour deliberately: hue already encodes condition, so a coloured outline would
compete with it and disappear in greyscale or for a red-blind viewer, whereas the shape reads
independently of colour. Favourites are drawn last so a starred car can't hide under the 0 km
cluster.

Your view is remembered per browser in `localStorage` — the favourites (`mobilede.favorites`),
the filters, the sort column and direction (`mobilede.view`) and the hidden columns
(`mobilede.hiddenCols`). **Reset view**
appears in the filter row whenever anything is non-default and clears filters and sorting;
hidden columns are a separate preference, restored with **Show all** in the Columns popover.

Stored values are validated on load, so a stale one can never leave the dashboard in a state
with no visible cause. A filter naming a seller or country that is no longer in the data is
dropped with a banner explaining why, rather than silently showing an empty table. Favourites
are the exception and are never pruned: a favourited car can legitimately vanish from the search
and come back later, so discarding the id would destroy your own data.

Trend charts need two scrapes before they show a line, and say so until then.

---

## Configuration

Everything lives in `config.json`.

```jsonc
{
  "searchUrl": "https://suchen.mobile.de/fahrzeuge/search.html?...",  // any mobile.de search
  "label": "McLaren 750S Spider",       // shown in the dashboard header
  "maxPages": 8,                        // safety cap; pagination normally stops itself
  "browser": {
    "executablePath": null,             // null = autodetect Chrome, then Edge
    "offscreen": true                   // false to watch the browser work
  },
  "server": { "port": 8477 }
}
```

**To track a different search**, run it on mobile.de, copy the URL, and replace `searchUrl`.
Add `&lang=en` for English field values. The scraper reads the result count from the page and
pages until it has everything, so no page-size assumptions need changing.

Tracking a *second* search at the same time means a second checkout with its own `data/`
directory — the schema holds one search per database.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run scrape` | Scrape and record. Skips if the last success was too recent. |
| `npm run scrape -- --force` | Ignore the minimum-interval guard. |
| `npm run scrape -- --dry-run` | Fetch and parse, print the listings, write nothing. |
| `npm run scrape -- --debug` | Also dump fetched HTML to `debug/` for diagnosis. |
| `npm run serve` | Dashboard. `PORT=9000 npm run serve` to change port. |
| `npm run stats` | Terminal summary. |
| `npm run history:export` | SQLite → `history/*.ndjson` (the git-friendly record). |
| `npm run history:import` | `history/*.ndjson` → SQLite. Destructive: rebuilds the database. |
| `npm run build` | Build the static dashboard into `dist/`. |
| `npm test` | Extractor, storage and history round-trip tests. |

`MOBILEDE_DB=/path/to/copy.sqlite npm run serve` points the dashboard at a different database.

---

## When it breaks

It will eventually — this depends on someone else's page structure.

1. `npm run scrape -- --debug` and look in `debug/`.
2. `npm test` — if the fixture tests still pass, the extractor is fine and the problem is
   access (a block), not parsing.
3. If the saved HTML is a denial page, the browser is being detected. Try
   `"offscreen": false` to watch what happens, and check whether a plain Chrome window can
   still load the search URL at all.
4. If the HTML is a real results page but extraction failed, mobile.de changed the payload
   shape: save that page into `test/fixtures/` and extend `extractSearchResults`.

Failures never corrupt existing data — a failed run writes nothing but a `run` row.
