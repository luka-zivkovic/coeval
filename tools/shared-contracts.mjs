#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  buildEagerImportGraph,
  exportSurfaceDiff,
  findImportCycles
} from "./shared-contracts-lib.mjs";

const root = process.cwd();
const sharedDir = path.join(root, "packages/shared");
const sourceDir = path.join(sharedDir, "src");
const cliArgs = process.argv.slice(2).filter((argument) => argument !== "--");
assert.ok(cliArgs.every((argument) => argument === "--write"), `Unknown argument(s): ${cliArgs.join(", ")}`);
const writeFixtures = cliArgs.includes("--write");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const packageJson = JSON.parse(await readFile(path.join(sharedDir, "package.json"), "utf8"));
assert.deepEqual(Object.keys(packageJson.exports), ["."], "@coeval/shared must retain one public root entry and no deep exports");
const rootExport = packageJson.exports["."];
assert.deepEqual(Object.keys(rootExport), ["types", "import"], "@coeval/shared must resolve types before its runtime import condition");
assert.equal(packageJson.main, rootExport.import);
assert.equal(packageJson.types, rootExport.types);
for (const target of [rootExport.types, rootExport.import]) {
  const absolute = path.join(sharedDir, target.replace(/^\.\//u, ""));
  try {
    await stat(absolute);
  } catch {
    throw new Error(`Missing built @coeval/shared target ${target}; run pnpm shared-contracts to force a fresh build.`);
  }
}

const configPath = path.join(sharedDir, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, sharedDir, undefined, configPath);
assert.notEqual(parsedConfig.options.verbatimModuleSyntax, true,
  "The eager-import guard assumes TypeScript elides type-only and empty imports; extend it before enabling verbatimModuleSyntax.");

const absoluteFiles = await listFiles(sourceDir);
const absoluteSources = absoluteFiles.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
const sourceFiles = new Set(absoluteSources.map((file) => path.relative(root, file).split(path.sep).join("/")));
const knownFiles = new Set(absoluteFiles.map((file) => path.relative(root, file).split(path.sep).join("/")));
const sources = new Map();
for (const absolute of absoluteSources) {
  const importer = path.relative(root, absolute).split(path.sep).join("/");
  sources.set(importer, await readFile(absolute, "utf8"));
}
const graph = buildEagerImportGraph(sources, knownFiles);
const cycles = findImportCycles(graph);
if (cycles.length > 0) {
  throw new Error(`@coeval/shared runtime import cycle(s):\n${cycles.map((cycle) => `- ${cycle.join(" -> ")}`).join("\n")}`);
}

const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const entrySource = program.getSourceFile(path.join(sourceDir, "index.ts"));
const entrySymbol = entrySource && program.getTypeChecker().getSymbolAtLocation(entrySource);
if (!entrySymbol) throw new Error("Cannot resolve the @coeval/shared TypeScript entry module");
const actualPublicExports = program.getTypeChecker().getExportsOfModule(entrySymbol).map((symbol) => symbol.getName()).sort();
const distUrl = pathToFileURL(path.join(sharedDir, rootExport.import.replace(/^\.\//u, "")));
distUrl.searchParams.set("guard", `${Date.now()}`);
const builtModule = await import(distUrl.href);
const actualExports = Object.keys(builtModule).sort();
const publicNames = new Set(actualPublicExports);
assert.deepEqual(actualExports.filter((name) => !publicNames.has(name)), [],
  "Every @coeval/shared runtime export must also be present in its TypeScript public surface");

const publicFixturePath = path.join(root, "tools/shared-contract-public-exports.json");
const runtimeFixturePath = path.join(root, "tools/shared-contract-exports.json");
if (writeFixtures) {
  await writeFile(publicFixturePath, `${JSON.stringify({ version: 1, publicExports: actualPublicExports }, null, 2)}\n`);
  await writeFile(runtimeFixturePath, `${JSON.stringify({ version: 1, runtimeExports: actualExports }, null, 2)}\n`);
  console.log("Updated sorted @coeval/shared public and runtime export fixtures; review the complete diff.");
} else {
  const publicFixture = JSON.parse(await readFile(publicFixturePath, "utf8"));
  assert.equal(publicFixture.version, 1, "Unsupported shared contract public export fixture version");
  assert.ok(Array.isArray(publicFixture.publicExports), "Shared contract public export fixture must contain publicExports");
  const expectedPublicExports = [...publicFixture.publicExports].sort();
  const publicDrift = exportSurfaceDiff(expectedPublicExports, actualPublicExports);
  if (publicDrift.added.length > 0 || publicDrift.removed.length > 0) {
    throw new Error([
      "@coeval/shared public TypeScript exports changed.",
      `Added: ${publicDrift.added.join(", ") || "none"}`,
      `Removed: ${publicDrift.removed.join(", ") || "none"}`,
      "After authorization, run pnpm shared-contracts -- --write and review the full fixture diff."
    ].join("\n"));
  }

  const runtimeFixture = JSON.parse(await readFile(runtimeFixturePath, "utf8"));
  assert.equal(runtimeFixture.version, 1, "Unsupported shared contract runtime export fixture version");
  assert.ok(Array.isArray(runtimeFixture.runtimeExports), "Shared contract runtime export fixture must contain runtimeExports");
  const expectedExports = [...runtimeFixture.runtimeExports].sort();
  const drift = exportSurfaceDiff(expectedExports, actualExports);
  if (drift.added.length > 0 || drift.removed.length > 0) {
    throw new Error([
      "@coeval/shared public runtime exports changed.",
      `Added: ${drift.added.join(", ") || "none"}`,
      `Removed: ${drift.removed.join(", ") || "none"}`,
      "After authorization, run pnpm shared-contracts -- --write and review the full fixture diff."
    ].join("\n"));
  }
}

console.log(`Shared contract guards passed: ${sourceFiles.size} source module(s), ${actualPublicExports.length} public export(s), ${actualExports.length} runtime export(s), built root initialized, no cycles.`);
