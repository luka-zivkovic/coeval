import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  readFeatureSource,
  readWebSource,
  webExtractionContracts
} from "./support/web-extraction-contracts.js";

const durableFeatures = [
  "analysis-study-workspace",
  "datasets",
  "skill-edit",
  "trace-test-builder"
] as const;

async function testFiles(directory: URL, prefix = ""): Promise<Array<{ name: string; url: URL }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ name: string; url: URL }> = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relative = `${prefix}${entry.name}`;
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) files.push(...await testFiles(url, `${relative}/`));
    else if (entry.isFile() && /\.test\.tsx?$/u.test(entry.name)) files.push({ name: relative, url });
  }
  return files;
}

describe("web extraction source contracts", () => {
  it("covers every large screen already classified for extraction", async () => {
    const inventory = JSON.parse(await readFile(
      new URL("../../../tools/large-files.json", import.meta.url),
      "utf8"
    )) as { files: Record<string, { classification: string }> };
    const candidateScreens = Object.entries(inventory.files)
      .filter(([path, record]) => path.startsWith("apps/web/src/screens/") && record.classification === "refactor_candidate")
      .map(([path]) => path.replace("apps/web/src/", ""))
      .sort();
    const contractRoots = Object.values(webExtractionContracts).map(({ root }) => root).sort();

    expect(Object.keys(webExtractionContracts).sort()).toEqual([...durableFeatures].sort());
    for (const path of candidateScreens) expect(contractRoots).toContain(path);
  });

  it("keeps each feature inventory explicit, existent, and behaviorally scoped", async () => {
    const owned = new Set<string>();
    for (const [feature, contract] of Object.entries(webExtractionContracts)) {
      expect(contract.sources[0], feature).toBe(contract.root);
      expect(new Set(contract.sources).size, feature).toBe(contract.sources.length);
      const contents = new Map<string, string>();
      for (const path of contract.sources) {
        expect(path, feature).toMatch(/^(?:components|hooks|lib|screens)\//u);
        expect(owned.has(path), `${path} must have one extraction owner`).toBe(false);
        owned.add(path);
        const source = await readWebSource(path);
        expect(source, path).not.toHaveLength(0);
        contents.set(path, source);
      }
      for (const path of [...contract.dialogSources, ...contract.rowActionSources]) {
        expect(contract.sources, `${path} must be owned before it carries a behavior contract`).toContain(path);
      }
      const discoveredDialogs = contract.sources.filter((path) => contents.get(path)!.includes('role="dialog"')).sort();
      const discoveredRows = contract.sources.filter((path) => {
        const source = contents.get(path)!;
        return source.includes("row-link") || /<Row(?:Link|Button)/u.test(source);
      }).sort();
      expect([...contract.dialogSources].sort(), `${feature} dialog inventory must match owned source`).toEqual(discoveredDialogs);
      expect([...contract.rowActionSources].sort(), `${feature} row-action inventory must match owned source`).toEqual(discoveredRows);
      const combined = await readFeatureSource(feature as keyof typeof webExtractionContracts);
      expect(combined).toContain(`/* ${contract.root} */`);
    }
  });

  it("keeps candidate-screen source paths centralized in the extraction inventory", async () => {
    const guardedPaths = Object.values(webExtractionContracts).flatMap(({ sources }) => [...sources]);
    for (const file of await testFiles(new URL(".", import.meta.url))) {
      const contents = await readFile(file.url, "utf8");
      for (const path of guardedPaths) {
        expect(contents, `${file.name} must read ${path} through the extraction contract`).not.toContain(path);
      }
    }
  });
});
