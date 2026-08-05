# mobile.de tracker

Periodically snapshots a mobile.de search, stores every listing in SQLite, and serves a local
dashboard showing price trends, new and removed listings, and side-by-side comparison of
mileage, registration date, previous owners and specs.

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

---

## Not spamming the site

Several independent brakes, all in `config.json` under `politeness`:

| Setting | Default | Effect |
|---|---|---|
| `minMinutesBetweenRuns` | 180 | A run that starts too soon after the last **successful** one exits without touching the network. Override with `--force`. |
| `pageDelayMs` | 7–14 s | Randomised pause between pages, so requests aren't metronomic. |
| `settleMs` | 4–6.5 s | Wait for the payload after each navigation. |
| `maxAttemptsPerPage` | 2 | One retry, then give up — never hammer. |
| `blockedBackoffMs` | 45 s | Wait before that single retry. |

Plus: one browser session per run (not per page), a persistent Chrome profile so the cookie
banner is answered once, and a lock file preventing overlapping runs. A full run is **2 page
requests** — at 3×/day that's 6 requests a day.

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

## Scheduling

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
weeks" is distinguishable from "we stopped looking". At 32 cars × 3 runs/day that's ~35k rows a
year — nothing for SQLite.

A listing that disappears is marked `removed_at`, not deleted; if it comes back it's *relisted*,
not re-created, so its full price history stays attached.

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
  drawer with the full price history and spec sheet.

Filters at the top scope every chart, the feed and the table together. Light and dark themes
are both explicitly styled; the chart palette is validated for colour-vision deficiency.

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
| `npm test` | Extractor + storage tests against captured fixtures. |

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
