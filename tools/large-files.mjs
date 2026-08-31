#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("./large-files.json", import.meta.url));
const config = JSON.parse(await readFile(configPath, "utf8"));
validateConfig(config);

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8"
}).trim();
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
}).split("\0").filter(Boolean);

const rows = [];
for (const path of tracked) {
  const contents = await readFile(resolve(root, path));
  const lines = countLines(contents);
  if (lines <= config.threshold) continue;
  const record = config.files[path];
  rows.push({
    path,
    lines,
    classification: record?.classification ?? "review_required",
    reason: record?.reason ?? "No classification has been recorded."
  });
}

rows.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));

const trackedSet = new Set(tracked);
const stale = Object.keys(config.files).filter((path) => {
  if (!trackedSet.has(path)) return true;
  return !rows.some((row) => row.path === path);
});

console.log(`Tracked files over ${config.threshold.toLocaleString("en-US")} lines: ${rows.length}`);
console.log("");
console.log(`${"LINES".padStart(7)}  ${"CLASSIFICATION".padEnd(22)}  FILE`);
for (const row of rows) {
  console.log(`${String(row.lines).padStart(7)}  ${row.classification.padEnd(22)}  ${row.path}`);
  console.log(`${"".padStart(7)}  ${"".padEnd(22)}  ${row.reason}`);
}

const counts = Object.groupBy(rows, (row) => row.classification);
console.log("");
for (const classification of [
  "generated",
  "structural_exception",
  "refactor_candidate",
  "cohesion_review",
  "review_required"
]) {
  console.log(`${classification}: ${counts[classification]?.length ?? 0}`);
}

if (stale.length > 0) {
  console.log("");
  console.log("Recorded entries no longer over the threshold (review the inventory):");
  for (const path of stale.sort()) console.log(`- ${path}`);
}

const unclassified = rows.filter((row) => row.classification === "review_required");
if (unclassified.length > 0) {
  console.log("");
  console.log("Review required: classify these files in tools/large-files.json.");
}

function countLines(contents) {
  if (contents.length === 0) return 0;
  let lines = 0;
  for (const byte of contents) {
    if (byte === 0x0a) lines += 1;
  }
  return contents.at(-1) === 0x0a ? lines : lines + 1;
}

function validateConfig(value) {
  if (!value || !Number.isInteger(value.threshold) || value.threshold < 1 || !value.files || typeof value.files !== "object") {
    throw new Error(`Invalid large-file inventory at ${relative(process.cwd(), configPath)}`);
  }
  const classifications = new Set([
    "generated",
    "structural_exception",
    "refactor_candidate",
    "cohesion_review"
  ]);
  for (const [path, record] of Object.entries(value.files)) {
    if (!record || !classifications.has(record.classification) ||
        typeof record.reason !== "string" || record.reason.trim().length === 0 ||
        typeof record.revisit !== "string" || record.revisit.trim().length === 0) {
      throw new Error(`Invalid classification for ${path} in ${relative(process.cwd(), configPath)}`);
    }
  }
}
