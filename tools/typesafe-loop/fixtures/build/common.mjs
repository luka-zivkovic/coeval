// Shared helpers for the public-data fixture builders. Raw downloads land under
// out/typesafe-loop/raw/ (gitignored) and are reused on later runs. Node's
// built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set, which
// a Claude Code cloud session needs for huggingface.co.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const fixturesRoot = path.resolve(here, "..");
export const rawRoot = path.resolve(here, "..", "..", "..", "..", "out", "typesafe-loop", "raw");

/** mulberry32, the same generator metrics.mjs uses, so a seed reproduces a selection. */
export function seededShuffle(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (array) => {
    for (let i = array.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

/**
 * Every row of a Hugging Face dataset split through the datasets-server rows
 * API, 100 rows per page, cached one file per page. Pages are concatenated in
 * lexical order of their offset ("0", "100", "1000", ...), which is the order
 * the first build read them from disk; keep it so seeds reproduce.
 */
export async function huggingFaceRows({ dataset, config = "default", split, rawDir }) {
  await mkdir(rawDir, { recursive: true });
  const base = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&length=100`;
  const page = async (offset) => {
    const file = path.join(rawDir, `rows-${offset}.json`);
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      const body = await fetchJson(`${base}&offset=${offset}`);
      await writeFile(file, JSON.stringify(body));
      return body;
    }
  };
  const first = await page(0);
  const offsets = [];
  for (let offset = 0; offset < first.num_rows_total; offset += 100) offsets.push(String(offset));
  offsets.sort();
  const rows = [];
  for (const offset of offsets) rows.push(...(await page(Number(offset))).rows.map((r) => r.row));
  return rows;
}

export async function writeFixture(name, { criterion, cases, pairs }) {
  const dir = path.join(fixturesRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "criterion.json"), `${JSON.stringify(criterion, null, 2)}\n`);
  await writeFile(path.join(dir, "cases.json"), `${JSON.stringify(cases, null, 2)}\n`);
  await writeFile(path.join(dir, "pairs.json"), `${JSON.stringify(pairs, null, 2)}\n`);
  return dir;
}

export const pad = (n) => String(n).padStart(2, "0");
