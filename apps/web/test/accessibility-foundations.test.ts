import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWebSource, webExtractionContracts } from "./support/web-extraction-contracts.js";

const srcRoot = new URL("../src/", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, srcRoot), "utf8");
}

async function tsxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  }));
  return nested.flat();
}

describe("accessibility foundations", () => {
  it("provides one keyboard skip target in both application shells", async () => {
    const [skipLink, rootLayout, blindLayout, sidebar] = await Promise.all([
      source("components/skip-link.tsx"),
      source("components/layout/root-layout.tsx"),
      source("layouts/blind-review-layout.tsx"),
      source("components/layout/sidebar.tsx")
    ]);

    expect(skipLink).toContain('href="#main-content"');
    for (const layout of [rootLayout, blindLayout]) {
      expect(layout).toContain("<SkipLink />");
      expect(layout).toContain('id="main-content"');
      expect(layout).toContain("tabIndex={-1}");
    }
    expect(sidebar).toContain('<nav aria-label="Project navigation">');
  });

  it("uses native controls for linked KPIs, references, personas, and disclosures", async () => {
    const [kpi, ref, sidebar, exceptions] = await Promise.all([
      source("components/coeval/kpi.tsx"),
      source("components/coeval/ref.tsx"),
      source("components/layout/sidebar.tsx"),
      source("screens/exceptions.tsx")
    ]);

    expect(kpi).toContain("<Link");
    expect(kpi).toContain("to?: string");
    expect(ref).toMatch(/<button\s+type="button"/);
    expect(sidebar).toContain('role="group"');
    expect(sidebar).toContain('aria-label="Workspace display"');
    expect(sidebar).toContain('aria-pressed={mode === option.value}');
    expect(sidebar).toContain('aria-describedby="workspace-display-help"');
    expect(sidebar).toContain("aria-expanded={open}");
    expect(sidebar).toContain('aria-current={active ? "true" : undefined}');
    expect(sidebar).not.toContain("aria-haspopup");
    expect(exceptions).toContain("aria-expanded={resolvedOpen}");
    expect(exceptions).toContain('aria-controls="resolved-decisions-panel"');
  });

  it("applies the shared focus contract to every modal overlay", async () => {
    const dialogFiles = [
      "components/import-trace-launcher.tsx",
      "components/save-queue-modal.tsx",
      "components/project-create.tsx",
      "screens/integrations.tsx",
      "screens/reliability.tsx",
      "screens/settings.tsx",
      "screens/review-queues.tsx",
      ...webExtractionContracts.datasets.dialogSources,
      ...webExtractionContracts["trace-test-builder"].dialogSources
    ];

    for (const path of dialogFiles) {
      const contents = await readWebSource(path);
      expect(contents, path).toContain("useDialogFocus");
      expect(contents, path).toContain('role="dialog"');
      expect(contents, path).toContain('aria-modal="true"');
      expect(contents, path).toMatch(/aria-labelledby=/);
    }
  });

  it("gives every pointer-clickable data row a native primary action", async () => {
    const rowFiles = [
      "components/coeval/regression-diff-table.tsx",
      "screens/dashboard.tsx",
      "screens/traces.tsx",
      "screens/exceptions.tsx",
      "screens/reliability.tsx",
      "screens/skill-versions.tsx",
      "screens/compare-versions.tsx",
      "screens/compare-runs.tsx",
      "screens/review-queues.tsx",
      ...webExtractionContracts.datasets.rowActionSources
    ];

    for (const path of rowFiles) {
      const contents = await readWebSource(path);
      expect(contents, path).toContain("row-link");
      expect(contents, path).toMatch(/<Row(?:Link|Button)/);
    }
  });

  it("does not leave href-less anchors or button roles in application JSX", async () => {
    const files = await tsxFiles(new URL(".", srcRoot).pathname);
    const contents = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");

    const anchorTags = contents.match(/<a\b[^>]*>/g) ?? [];
    expect(anchorTags.every((tag) => /\bhref(?:\s*=|\b)/.test(tag))).toBe(true);
    expect(contents).not.toContain('role="button"');
  });
});
