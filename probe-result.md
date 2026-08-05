# mobile.de reachability probe from a GitHub-hosted runner

**VIABLE — mobile.de served this runner and listings parsed. Scraping from GitHub Actions can work.**

- Probed at: 2026-08-05T08:54:56.793Z
- Runner IP: `128.24.163.39` — AS8075 Microsoft Corporation (Cheyenne, US)
- Chrome: `Google Chrome 150.0.7871.128`
- DISPLAY: `:99`

| Test | Result | HTTP | Bytes | Parsed |
|---|---|---|---|---|
| A: plain fetch | blocked/failed | 403 | 7684 | no — could not extract searchResults from the page — neither the RSC flight |
| B: headless (playwright launch) | blocked/failed | 403 | 7651 | no — could not extract searchResults from the page — neither the RSC flight |
| C: headed + CDP (sandboxed) | served | 200 | 1535342 | 21/32 (rsc) |

Local baseline for comparison: A 403, B 403, C **200 + 32/32 parsed**.

<details><summary>Raw</summary>

```json
{
  "ipInfo": {
    "ip": "128.24.163.39",
    "city": "Cheyenne",
    "region": "Wyoming",
    "country": "US",
    "loc": "41.1400,-104.8203",
    "org": "AS8075 Microsoft Corporation",
    "postal": "82001",
    "timezone": "America/Denver",
    "readme": "https://ipinfo.io/missingauth"
  },
  "chromePath": "/usr/bin/google-chrome-stable",
  "chromeVersion": "Google Chrome 150.0.7871.128",
  "results": [
    {
      "name": "A: plain fetch",
      "status": 403,
      "htmlLength": 7684,
      "denial": true,
      "ok": false,
      "parse": {
        "parsed": false,
        "error": "could not extract searchResults from the page — neither the RSC flight payload (0 chars) nor window.__INITIAL_STATE__ yielded a result array; mobile.de may have changed its page structure"
      }
    },
    {
      "name": "B: headless (playwright launch)",
      "status": 403,
      "title": "Zugriff verweigert / Access denied",
      "htmlLength": 7651,
      "denial": true,
      "ok": false,
      "parse": {
        "parsed": false,
        "error": "could not extract searchResults from the page — neither the RSC flight payload (0 chars) nor window.__INITIAL_STATE__ yielded a result array; mobile.de may have changed its page structure"
      }
    },
    {
      "name": "C: headed + CDP (sandboxed)",
      "status": 200,
      "title": "Car search on mobile.de – find your vehicle quick and easy",
      "webdriver": false,
      "browserVersion": "Chrome/150.0.7871.128",
      "htmlLength": 1535342,
      "denial": false,
      "ok": true,
      "parse": {
        "parsed": true,
        "variant": "rsc",
        "numResultsTotal": 32,
        "unique": 21
      }
    }
  ]
}
```

</details>
