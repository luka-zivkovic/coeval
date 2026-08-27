import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("trust-aligned frontend flows", () => {
  it("keeps governed workflows and ungoverned diagnostics outside the legacy act groups", async () => {
    const sidebar = await source("../src/components/layout/sidebar.tsx");
    const tracingNav = sidebar.slice(
      sidebar.indexOf("const TRACING_NAV"),
      sidebar.indexOf("const BENCH_NAV")
    );
    const operationalGroup = tracingNav.slice(
      tracingNav.indexOf('label: "2 · Operational triage"'),
      tracingNav.indexOf('label: "3 · Guard known failures"')
    );
    const knownFailureGroup = tracingNav.slice(
      tracingNav.indexOf('label: "3 · Guard known failures"'),
      tracingNav.indexOf('label: "Ungoverned diagnostics"')
    );

    expect(tracingNav).toContain('label: "Governed lifecycle"');
    expect(operationalGroup).not.toMatch(/Analyze · governed|Human truth · governed/);
    expect(knownFailureGroup).not.toContain("Reliability signals");
    expect(tracingNav).not.toMatch(/Golden evidence|Earn trust|Judge real work/);
    expect(sidebar).toContain("h-dvh flex-col overflow-y-auto");
  });

  it("describes dashboard completion as legacy operational progress", async () => {
    const [journey, dashboard] = await Promise.all([
      source("../src/components/coeval/journey-pipeline.tsx"),
      source("../src/screens/dashboard.tsx")
    ]);

    expect(journey).toContain("Operational setup only");
    expect(journey).toContain("Governed analysis and human truth are tracked separately");
    expect(journey).toContain("ungoverned triage");
    expect(journey).not.toMatch(/Earn trust|Judge real work/);
    expect(dashboard).toContain('label="Legacy human checks"');
    expect(dashboard).toContain('foot="not governed human truth"');
    expect(dashboard).not.toContain("Human-verified");
  });

  it("explains legacy reviewer disagreements without implying blind collection", async () => {
    const exceptions = await source("../src/screens/exceptions.tsx");

    expect(exceptions).toContain("These cases have different recorded verdicts from two or more reviewers");
    expect(exceptions).toContain("Compare and resolve");
    expect(exceptions).not.toMatch(/blind review/i);
  });

  it("gates persistent governed workflows in demo mode without raw API failures", async () => {
    const [notice, criteria, analyze, humanTruth] = await Promise.all([
      source("../src/components/database-mode-required.tsx"),
      source("../src/screens/criteria.tsx"),
      source("../src/screens/analyze.tsx"),
      source("../src/screens/human-truth.tsx")
    ]);

    expect(notice).toContain("Persistent signed-in workspace required");
    for (const screen of [criteria, analyze, humanTruth]) {
      expect(screen).toContain("DatabaseModeRequired");
      expect(screen).toContain("if (demoMode)");
    }
    expect(analyze).toContain("They are a preview, not a reproducible analysis sample");
    expect(humanTruth).toContain("they never become governed truth");
  });

  it("states trace units and binds the version filter to export scope", async () => {
    const [traces, traceExport] = await Promise.all([
      source("../src/screens/traces.tsx"),
      source("../src/lib/trace-export.ts")
    ]);

    expect(traces).toContain('label="Verdict rows"');
    expect(traces).toContain("distinctCases");
    expect(traces).toContain("visibleCaseCount");
    expect(traceExport).toContain("skillVersionId: versionFilter");
    expect(traceExport).toContain("Verdict-label, search, and random-sample filters are not applied");
  });

  it("uses one Golden set name and presents display density without impersonating a role", async () => {
    const [golden, sidebar, rootLayout, displayMode] = await Promise.all([
      source("../src/screens/golden.tsx"),
      source("../src/components/layout/sidebar.tsx"),
      source("../src/components/layout/root-layout.tsx"),
      source("../src/lib/display-mode.ts")
    ]);
    const combined = [golden, sidebar, rootLayout, displayMode].join("\n");

    expect(golden).toContain('title="Golden set"');
    expect(sidebar).toContain("Workspace display");
    expect(displayMode).toContain('label: "Guided"');
    expect(rootLayout).toContain("DISPLAY_MODE_BY_VALUE[mode].label");
    expect(combined).not.toMatch(/Golden evidence|Reviewer view|View as/);
  });
});
