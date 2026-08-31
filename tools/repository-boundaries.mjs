#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  analyzeRepositorySources,
  boundaryDiff,
  validateRepositoryBoundaries
} from "./repository-boundaries-lib.mjs";

const root = process.cwd();
const cliArgs = process.argv.slice(2).filter((argument) => argument !== "--");
assert.ok(cliArgs.every((argument) => argument === "--write"), `Unknown argument(s): ${cliArgs.join(", ")}`);
const writeFixture = cliArgs.includes("--write");
const fixturePath = path.join(root, "tools/repository-boundaries.json");
const expected = JSON.parse(await readFile(fixturePath, "utf8"));

async function listTypeScriptFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(absolute);
  }
  return files;
}

const rootSourcePath = path.join(root, "apps/api/src/repository.pg.ts");
const extractedSourcePaths = await listTypeScriptFiles(path.join(root, "apps/api/src/repository.pg"));
const sourcePaths = [rootSourcePath, ...extractedSourcePaths];
const sources = new Map();
for (const sourcePath of sourcePaths) {
  sources.set(path.relative(root, sourcePath).split(path.sep).join("/"), await readFile(sourcePath, "utf8"));
}
const actual = validateRepositoryBoundaries(analyzeRepositorySources(sources, {
  allowedExternalPoolDelegates: ["PgEvaluatorLifecycleRepository"],
  minimumConnectionOwners: expected.minimums?.connectionOwners ?? 36,
  minimumClientScopedCommands: expected.minimums?.clientScopedCommands ?? 16
}));

if (writeFixture) {
  await writeFile(fixturePath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log("Updated the PostgreSQL connection-owner and client-command map; review every changed boundary.");
} else {
  const drift = boundaryDiff(expected, actual);
  if (drift !== null) {
    throw new Error([
      "PostgreSQL repository transaction boundaries changed.",
      "After mapping the consistency and lock implications, run pnpm repository-boundaries -- --write and review the complete fixture diff.",
      "Actual boundaries:",
      drift
    ].join("\n"));
  }
}

const transactions = actual.connectionOwners.filter((owner) => owner.kind === "transaction").length;
const sessionLocks = actual.connectionOwners.filter((owner) => owner.kind === "session_advisory_lock").length;
console.log(`Repository boundary guard passed: ${transactions} transaction owner(s), ${sessionLocks} session-lock owner(s), ${actual.clientScopedCommands.length} client-scoped command(s).`);
