/**
 * Answers one question: will mobile.de serve a GitHub-hosted runner?
 *
 * It repeats the exact three-way matrix that was measured locally, so the results are directly
 * comparable:
 *
 *   A) plain fetch with browser-like headers   — locally: 403
 *   B) Playwright-launched headless Chrome     — locally: 403
 *   C) Chrome spawned as a normal process,
 *      attached over CDP, with a real display  — locally: 200 ✅
 *
 * If C fails here but works locally, the difference is the runner's datacenter IP, and
 * scraping from GitHub Actions is not viable.
 *
 * Always exits 0 and always writes probe-result.{md,json} — the verdict is in the file, so the
 * workflow can commit results even when every attempt is blocked.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { chromium } from "playwright-core";
import { extractSearchResults, dedupeById } from "../src/extract.js";

const SEARCH_URL =
  process.env.SEARCH_URL ??
  JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8")).searchUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(...m);

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,de;q=0.8",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

function isDenial(html, title = "") {
  return /Zugriff verweigert|Access denied/i.test(title) || /Zugriff verweigert|Access denied/i.test(html);
}

/** Try to parse listings; report the count or why not. */
function tryParse(html) {
  try {
    const r = extractSearchResults(html);
    return {
      parsed: true,
      variant: r.variant,
      numResultsTotal: r.numResultsTotal,
      unique: dedupeById(r.listings).length,
    };
  } catch (e) {
    return { parsed: false, error: e.message.slice(0, 200) };
  }
}

const results = [];
const record = (r) => {
  results.push(r);
  log(
    `  -> ${r.name}: ${r.ok ? "OK" : "BLOCKED/FAILED"} ` +
      `status=${r.status ?? "-"} len=${r.htmlLength ?? "-"} ` +
      `${r.parse?.parsed ? `parsed ${r.parse.unique}/${r.parse.numResultsTotal} (${r.parse.variant})` : (r.parse?.error ?? r.error ?? "")}`,
  );
};

// ------------------------------------------------------------------ environment
let ipInfo = {};
try {
  ipInfo = await fetch("https://ipinfo.io/json").then((r) => r.json());
} catch (e) {
  ipInfo = { error: e.message };
}
log(`runner IP: ${ipInfo.ip} (${ipInfo.org ?? "?"}) ${ipInfo.city ?? ""} ${ipInfo.country ?? ""}`);

function findChrome() {
  const names = ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"];
  for (const n of names) {
    try {
      const p = execFileSync("which", [n], { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {
      /* next */
    }
  }
  return null;
}
const chromePath = findChrome();
let chromeVersion = null;
try {
  chromeVersion = chromePath ? execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim() : null;
} catch {
  /* ignore */
}
log(`chrome: ${chromePath ?? "NOT FOUND"} ${chromeVersion ?? ""}`);
log(`display: ${process.env.DISPLAY ?? "(none — headed Chrome will fail)"}`);

// ------------------------------------------------------------------- test A
log("\n[A] plain fetch with browser-like headers");
try {
  const r = await fetch(SEARCH_URL, { headers: HEADERS, redirect: "follow" });
  const html = await r.text();
  record({
    name: "A: plain fetch",
    status: r.status,
    htmlLength: html.length,
    denial: isDenial(html),
    ok: r.ok && !isDenial(html),
    parse: tryParse(html),
  });
} catch (e) {
  record({ name: "A: plain fetch", ok: false, error: e.message });
}

await sleep(8000); // stay polite between attempts

// ------------------------------------------------------------------- test B
log("\n[B] Playwright-launched headless Chrome");
if (!chromePath) {
  record({ name: "B: headless (playwright launch)", ok: false, error: "no chrome binary" });
} else {
  let b;
  try {
    b = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox"] });
    const p = await b.newContext({ locale: "en-US" }).then((c) => c.newPage());
    const resp = await p.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(5000);
    const html = await p.content();
    const title = await p.title().catch(() => "");
    record({
      name: "B: headless (playwright launch)",
      status: resp?.status(),
      title,
      htmlLength: html.length,
      denial: isDenial(html, title),
      ok: !isDenial(html, title),
      parse: tryParse(html),
    });
  } catch (e) {
    record({ name: "B: headless (playwright launch)", ok: false, error: e.message.slice(0, 200) });
  } finally {
    await b?.close().catch(() => {});
  }
}

await sleep(8000);

// ------------------------------------------------------------------- test C
log("\n[C] Chrome spawned as a normal process + CDP attach (the approach that works locally)");

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function testC(extraArgs, label) {
  const port = (await portFree(9333)) ? 9333 : 9444;
  const profile = fs.mkdtempSync("/tmp/chrome-profile-");
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(chromePath, args, { stdio: "ignore" });
  let browser;
  try {
    // wait for the CDP endpoint
    const deadline = Date.now() + 30000;
    let version = null;
    while (Date.now() < deadline && !version) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) version = await r.json();
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error("CDP endpoint never came up");

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const p = ctx.pages()[0] ?? (await ctx.newPage());
    const webdriver = await p.evaluate(() => navigator.webdriver).catch(() => null);
    const resp = await p.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(6000);
    const html = await p.content();
    const title = await p.title().catch(() => "");
    fs.mkdirSync("probe-debug", { recursive: true });
    fs.writeFileSync(`probe-debug/${label}.html`, html);
    return {
      name: `C: headed + CDP (${label})`,
      status: resp?.status(),
      title,
      webdriver,
      browserVersion: version.Browser,
      htmlLength: html.length,
      denial: isDenial(html, title),
      ok: !isDenial(html, title),
      parse: tryParse(html),
    };
  } catch (e) {
    return { name: `C: headed + CDP (${label})`, ok: false, error: e.message.slice(0, 200) };
  } finally {
    await browser?.close().catch(() => {});
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}

if (!chromePath) {
  record({ name: "C: headed + CDP", ok: false, error: "no chrome binary" });
} else if (!process.env.DISPLAY) {
  record({ name: "C: headed + CDP", ok: false, error: "no DISPLAY — run under xvfb" });
} else {
  // The runner's Chrome usually needs --no-sandbox; try the clean way first.
  let c = await testC([], "sandboxed");
  if (!c.ok && /CDP endpoint never came up|Target|crash/i.test(c.error ?? "")) {
    log("  retrying with --no-sandbox");
    await sleep(4000);
    c = await testC(["--no-sandbox", "--disable-dev-shm-usage"], "no-sandbox");
  }
  record(c);
}

// ------------------------------------------------------------------- verdict
const cResult = results.find((r) => r.name.startsWith("C:"));
const viable = !!cResult?.ok && !!cResult?.parse?.parsed;

const verdict = viable
  ? "VIABLE — mobile.de served this runner and listings parsed. Scraping from GitHub Actions can work."
  : "NOT VIABLE — the approach that works locally is blocked here. Keep scraping from your own machine.";

const md = [
  `# mobile.de reachability probe from a GitHub-hosted runner`,
  ``,
  `**${verdict}**`,
  ``,
  `- Probed at: ${new Date().toISOString()}`,
  `- Runner IP: \`${ipInfo.ip ?? "?"}\` — ${ipInfo.org ?? "?"} (${ipInfo.city ?? "?"}, ${ipInfo.country ?? "?"})`,
  `- Chrome: \`${chromeVersion ?? "not found"}\``,
  `- DISPLAY: \`${process.env.DISPLAY ?? "(none)"}\``,
  ``,
  `| Test | Result | HTTP | Bytes | Parsed |`,
  `|---|---|---|---|---|`,
  ...results.map((r) => {
    const parsed = r.parse?.parsed
      ? `${r.parse.unique}/${r.parse.numResultsTotal} (${r.parse.variant})`
      : `no — ${(r.parse?.error ?? r.error ?? "").replace(/\|/g, "/").slice(0, 70)}`;
    return `| ${r.name} | ${r.ok ? "served" : "blocked/failed"} | ${r.status ?? "—"} | ${r.htmlLength ?? "—"} | ${parsed} |`;
  }),
  ``,
  `Local baseline for comparison: A 403, B 403, C **200 + 32/32 parsed**.`,
  ``,
  `<details><summary>Raw</summary>`,
  ``,
  "```json",
  JSON.stringify({ ipInfo, chromePath, chromeVersion, results }, null, 2),
  "```",
  ``,
  `</details>`,
  ``,
].join("\n");

fs.writeFileSync("probe-result.md", md);
fs.writeFileSync(
  "probe-result.json",
  JSON.stringify({ probedAt: new Date().toISOString(), viable, ipInfo, chromePath, chromeVersion, results }, null, 2),
);

log(`\n${"=".repeat(70)}\n${verdict}\n${"=".repeat(70)}`);
log("wrote probe-result.md and probe-result.json");
