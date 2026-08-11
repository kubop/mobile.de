import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { paths, sleep } from "./config.js";

/**
 * mobile.de blocks Playwright-launched Chrome (403 / soft-block denial page) even when headed.
 * A Chrome we start ourselves as an ordinary process and then attach to over CDP is served
 * normally. So: spawn chrome.exe by hand, wait for the debugging endpoint, connectOverCDP.
 * Do not "simplify" this into chromium.launch() — that is exactly what gets blocked.
 */

const IS_WINDOWS = process.platform === "win32";

/** How long to let Chrome quit on its own before killing it. See `close()` for why it matters. */
const GRACEFUL_EXIT_MS = 8000;

const CHROME_CANDIDATES = IS_WINDOWS
  ? [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ]
  : [
      // Linux (incl. GitHub Actions runners, which ship google-chrome-stable) and macOS.
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/opt/google/chrome/chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];

export function findBrowserExecutable(override) {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`browser.executablePath not found: ${override}`);
    return override;
  }
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c;
  throw new Error(
    `No Chrome found for platform ${process.platform}. Set browser.executablePath in config.json.`,
  );
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  throw new Error(`No free CDP port in ${start}..${start + 19}`);
}

async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`Chrome CDP endpoint never came up on port ${port}: ${lastErr?.message ?? "timeout"}`);
}

function killTree(pid) {
  try {
    if (IS_WINDOWS) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Starts Chrome, attaches Playwright over CDP and returns { page, close }.
 * `close()` is safe to call multiple times and always kills the browser process tree.
 */
export async function openSession(cfg, log = console.log) {
  const exe = findBrowserExecutable(cfg.browser?.executablePath);
  const port = await findFreePort(cfg.browser?.cdpPort ?? 9333);

  if (!cfg.browser?.keepProfile) fs.rmSync(paths.profile, { recursive: true, force: true });
  fs.mkdirSync(paths.profile, { recursive: true });

  // Chrome must be started as an ordinary process (see the note above), so the flag list stays
  // minimal and deliberately avoids anything that advertises automation.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.resolve(paths.profile)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    // An offscreen window would otherwise be treated as occluded and throttled.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    // Linux only, and only meaningful because the cookie store is cached between CI runs:
    // pin cookie encryption to Chrome's built-in key rather than whatever keyring the machine
    // happens to expose. Otherwise the store is encrypted per-machine and carrying it from one
    // runner to the next silently yields nothing.
    ...(IS_WINDOWS ? [] : ["--password-store=basic"]),
    ...(cfg.browser?.extraArgs ?? []),
    "about:blank",
  ];
  // Only meaningful on a real desktop; under xvfb the display is already virtual.
  const offscreen = IS_WINDOWS && cfg.browser?.offscreen !== false;
  if (offscreen) args.splice(4, 0, "--window-position=-32000,-32000");

  if (!IS_WINDOWS && !process.env.DISPLAY) {
    throw new Error(
      "No DISPLAY set. A headless browser is blocked by mobile.de, so this needs a real or " +
        "virtual display — run under xvfb, e.g. `xvfb-run -a npm run scrape`.",
    );
  }

  log(`launching ${path.basename(exe)} (CDP :${port}${offscreen ? ", offscreen" : ""})`);
  const proc = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  proc.on("error", (e) => log(`browser process error: ${e.message}`));

  let exited = false;
  const exitedPromise = new Promise((resolve) =>
    proc.once("exit", () => {
      exited = true;
      resolve();
    }),
  );

  let browser;
  let closed = false;
  /**
   * Shut Chrome down cleanly, because a profile is only written to disk on a graceful exit.
   *
   * mobile.de sits behind Akamai Bot Manager, which hands a browser a year-long `_abck` trust
   * token plus a family of `bm_*` cookies. SIGKILLing Chrome threw those away seconds after
   * they were earned, so `keepProfile` was persisting an empty cookie store and every run
   * started cold and cookie-less — the state most likely to be challenged.
   *
   * `browser.close()` only detaches the CDP connection; on a browser we attached to rather
   * than launched, it leaves the process running. So ask Chrome itself to quit, and keep the
   * kill purely as a backstop for a browser that will not go.
   */
  const close = async () => {
    if (closed) return;
    closed = true;
    if (browser) {
      try {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send("Browser.close");
      } catch {
        /* no usable connection — fall through to the kill */
      }
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      await Promise.race([exitedPromise, sleep(GRACEFUL_EXIT_MS)]);
      if (!exited) {
        log(
          `Chrome did not exit within ${GRACEFUL_EXIT_MS / 1000}s — killing it; ` +
            `cookies earned this run will be lost`,
        );
      }
    }
    if (!exited && proc.pid) killTree(proc.pid);
  };

  // Make sure a crash mid-scrape never leaves an orphaned Chrome behind.
  const onExit = () => {
    if (proc.pid) killTree(proc.pid);
  };
  process.once("exit", onExit);

  try {
    const version = await waitForCdp(port);
    log(`attached to ${version.Browser}`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(cfg.politeness?.navTimeoutMs ?? 60000);
    return { browser, page, close, port };
  } catch (e) {
    await close();
    throw e;
  }
}

const CONSENT_SELECTORS = [
  '[data-testid="gdpr-consent-accept-all"]',
  'button:has-text("Accept all")',
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Einverstanden")',
  "#gdpr-consent-accept-button",
];

/** Best-effort dismissal of the GDPR modal. Never fatal — the data is in the payload regardless. */
export async function dismissConsent(page, log = console.log) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 4000 });
        log(`dismissed consent modal (${sel})`);
        await sleep(1200);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

/** mobile.de serves its denial page as both 403 and a soft 200, so match on content too. */
export function detectBlock(status, html, title = "") {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  if (/Zugriff verweigert|Access denied/i.test(title)) return "denial page (title)";
  if (html.length < 30000 && /Zugriff verweigert|Access denied/i.test(html)) return "denial page (body)";
  return null;
}
