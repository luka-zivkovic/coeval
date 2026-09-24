import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const screenState = { demoMode: false };

const Element = ({ children, ...props }: { children?: unknown }) =>
  createElement("div", props, children as never);

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/components/ui/card", () => ({ Card: Element, CardContent: Element, CardHeader: Element, CardTitle: Element }));
vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: object) => createElement("textarea", props)
}));
vi.mock("@/components/rubrist", () => ({
  SectionHead: ({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) =>
    createElement("header", null, eyebrow, title, sub)
}));
vi.mock("@/components/database-mode-required", () => ({
  DatabaseModeRequired: ({ title, demoAlternative }: { title: string; demoAlternative: string }) =>
    createElement("section", { "data-demo": true }, title, demoAlternative)
}));
vi.mock("@/lib/app-mode", () => ({
  useAppMode: () => ({ authEnabled: !screenState.demoMode, demoMode: screenState.demoMode })
}));

const { ProductionCalibrationScreen } = await import("../src/screens/production-calibration.js");

describe("production calibration screen", () => {
  it("opens with the provenance line, the ledger input, and the sample affordance in a signed-in project", () => {
    screenState.demoMode = false;
    const html = renderToStaticMarkup(createElement(ProductionCalibrationScreen));
    expect(html).toContain("Production calibration · ungoverned");
    expect(html).toContain("Stored records");
    expect(html).toContain("Build report");
    expect(html).toContain("Save snapshot");
    expect(html).toContain("Import .jsonl (owners)");
    expect(html).toContain("Loading snapshots…");
    expect(html).toContain('aria-label="Window from date"');
    expect(html).toContain("Preview a ledger");
    expect(html).toContain("Outcomes from production sources are development feedback. Independent validation is a separate step.");
    expect(html).toContain("routed through governed review, is a separate future step");
    expect(html).toContain('aria-label="Decision ledger (JSON Lines)"');
    expect(html).toContain("Load sample ledger");
    expect(html).toContain("Upload .jsonl");
    expect(html).toContain("Compute preview");
    expect(html).toContain("rubrist/production-decision-record/v1");
    expect(html).not.toContain("data-demo");
  });

  it("explains the missing project session in demo mode instead of computing", () => {
    screenState.demoMode = true;
    const html = renderToStaticMarkup(createElement(ProductionCalibrationScreen));
    expect(html).toContain("data-demo");
    expect(html).toContain("Production calibration previews need a signed-in project.");
    expect(html).not.toContain("Compute preview");
  });

  it("is reachable from the router, both navigations, and the breadcrumb without a criterion selection", async () => {
    const src = new URL("../src/", import.meta.url);
    const [app, sidebar, rootLayout, criterionSelection] = await Promise.all([
      readFile(new URL("App.tsx", src), "utf8"),
      readFile(new URL("components/layout/sidebar.tsx", src), "utf8"),
      readFile(new URL("components/layout/root-layout.tsx", src), "utf8"),
      readFile(new URL("lib/criterion-selection.ts", src), "utf8")
    ]);
    expect(app).toContain('{ path: "production-calibration", element: <ProductionCalibrationScreen /> }');
    expect(sidebar.match(/{ to: "\/production-calibration", label: "Production calibration", icon: Activity }/g)).toHaveLength(2);
    expect(rootLayout).toContain('"/production-calibration": ["Production calibration"]');
    expect(criterionSelection).toContain('"/production-calibration",');
  });
});
