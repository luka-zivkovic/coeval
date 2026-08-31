import { readFile } from "node:fs/promises";

export const webExtractionContracts = {
  "analysis-study-workspace": {
    root: "screens/analysis-study-workspace.tsx",
    sources: ["screens/analysis-study-workspace.tsx"],
    dialogSources: [],
    rowActionSources: []
  },
  datasets: {
    root: "screens/datasets.tsx",
    sources: ["screens/datasets.tsx"],
    dialogSources: ["screens/datasets.tsx"],
    rowActionSources: ["screens/datasets.tsx"]
  },
  "skill-edit": {
    root: "screens/skill-edit.tsx",
    sources: ["screens/skill-edit.tsx"],
    dialogSources: [],
    rowActionSources: []
  },
  "trace-test-builder": {
    root: "screens/trace-test-builder.tsx",
    sources: ["screens/trace-test-builder.tsx"],
    dialogSources: ["screens/trace-test-builder.tsx"],
    rowActionSources: []
  }
} as const;

// Keep these contracts after a root screen drops below 1,000 lines: extracted
// feature files must be added to `sources` and to each behavior-specific list
// they own so source-level coverage follows the move.

export type WebExtractionFeature = keyof typeof webExtractionContracts;

const srcRoot = new URL("../../src/", import.meta.url);

export async function readWebSource(path: string): Promise<string> {
  return readFile(new URL(path, srcRoot), "utf8");
}

export async function readFeatureSource(feature: WebExtractionFeature): Promise<string> {
  const sources = await Promise.all(webExtractionContracts[feature].sources.map(async (path) => ({
    path,
    source: await readWebSource(path)
  })));
  return sources.map(({ path, source }) => `/* ${path} */\n${source}`).join("\n");
}
