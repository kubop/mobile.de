import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  root: ROOT,
  config: path.join(ROOT, "config.json"),
  dataDir: path.join(ROOT, "data"),
  // MOBILEDE_DB lets you point the server at a copy of the database (handy for trying out
  // the dashboard against synthetic history without touching real data).
  db: process.env.MOBILEDE_DB || path.join(ROOT, "data", "mobile.sqlite"),
  lock: path.join(ROOT, "data", "scrape.lock"),
  profile: path.join(ROOT, ".chrome-profile"),
  debugDir: path.join(ROOT, "debug"),
  public: path.join(ROOT, "public"),
};

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  if (!cfg.searchUrl) throw new Error("config.json: searchUrl is required");
  fs.mkdirSync(paths.dataDir, { recursive: true });
  return cfg;
}

/** Inclusive random integer in [min, max] — used to jitter delays so requests aren't metronomic. */
export function jitter([min, max]) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function nowIso() {
  return new Date().toISOString();
}

/** Build the page-N variant of the configured search URL. */
export function searchUrlForPage(searchUrl, page) {
  const u = new URL(searchUrl);
  if (page > 1) u.searchParams.set("pageNumber", String(page));
  else u.searchParams.delete("pageNumber");
  return u.toString();
}
