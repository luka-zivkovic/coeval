// Shared plumbing for the sim harness scripts: .env loading, a pg pool
// borrowed from packages/db's dependency tree, and cookie-aware fetch
// helpers for the session-authenticated API routes.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
export const SIM_DIR = join(REPO_ROOT, "out", "sim");

// pg is not a root dependency; borrow packages/db's copy so the harness has
// no install step of its own.
const require = createRequire(join(REPO_ROOT, "packages", "db", "package.json"));
const { Pool } = require("pg");

export function loadEnv() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(join(REPO_ROOT, ".env"), "utf8");
  } catch {
    throw new Error(".env not found at repo root — the harness reads DATABASE_URL from it");
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

let pool = null;
export function getPool() {
  if (!pool) {
    const { DATABASE_URL } = loadEnv();
    if (!DATABASE_URL) throw new Error("DATABASE_URL missing from .env");
    pool = new Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

export async function query(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export const API_BASE = process.env.COEVAL_API ?? "http://localhost:8787";
// better-auth rejects requests without a trusted Origin; impersonate the web
// app's origin (must be in the API's TRUSTED_ORIGINS).
export const WEB_ORIGIN = process.env.COEVAL_WEB ?? "http://localhost:5175";

// Minimal cookie jar: better-auth emits session cookies on setup/sign-in;
// session-authenticated routes (key minting) need them replayed.
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(response) {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export async function apiFetch(path, { jar, ...init } = {}) {
  const headers = { "Content-Type": "application/json", Origin: WEB_ORIGIN, ...(init.headers ?? {}) };
  if (jar && jar.cookies.size > 0) headers.Cookie = jar.header();
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (jar) jar.absorb(response);
  return response;
}

export function writeArtifact(filename, data) {
  mkdirSync(SIM_DIR, { recursive: true });
  const path = join(SIM_DIR, filename);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 1) + "\n");
  return path;
}
