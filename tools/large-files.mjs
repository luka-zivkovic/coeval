#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyInventoryDrift,
  countLines,
  isBinary,
  validateConfig
} from "./large-files-lib.mjs";

const configPath = fileURLToPath(new URL("./large-files.json", import.meta.url));
const config = JSON.parse(await readFile(configPath, "utf8"));
validateConfig(config, configPath);

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8"
}).trim();
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
}).split("\0").filter(Boolean);

const rows = [];
const unavailable = [];
const binary = [];
for (const path of tracked) {
  let contents;
  try {
    contents = await readFile(resolve(root, path));
  } catch (error) {
    unavailable.push({
      path,
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unavailable"
    });
    continue;
  }
  if (isBinary(contents)) {
    binary.push(path);
    continue;
  }
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

const drift = classifyInventoryDrift({
  configured: Object.keys(config.files),
  tracked,
  overThreshold: rows.map((row) => row.path),
  unavailable: unavailable.map((row) => row.path),
  binary
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

if (unavailable.length > 0) {
  console.log("");
  console.log("Tracked paths unavailable in the working tree (not counted):");
  for (const item of unavailable.sort((left, right) => left.path.localeCompare(right.path))) {
    console.log(`- ${item.path} (${item.code})`);
  }
}

if (binary.length > 0) {
  console.log("");
  console.log("Binary tracked paths skipped:");
  for (const path of binary.sort()) console.log(`- ${path}`);
}

if (drift.untracked.length > 0) {
  console.log("");
  console.log("Recorded inventory paths that are no longer tracked:");
  for (const path of drift.untracked) console.log(`- ${path}`);
}

if (drift.belowThreshold.length > 0) {
  console.log("");
  console.log("Recorded entries no longer over the threshold (review the classification):");
  for (const path of drift.belowThreshold) console.log(`- ${path}`);
}

const unclassified = rows.filter((row) => row.classification === "review_required");
if (unclassified.length > 0) {
  console.log("");
  console.log("Review required: classify these files in tools/large-files.json.");
}
