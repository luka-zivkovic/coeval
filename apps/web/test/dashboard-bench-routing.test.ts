import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@coeval/shared";

const state = {
  dashboard: null as DashboardSummary | null
};

const Element = ({ children, ...props }: { children?: unknown }) =>
  createElement("div", props, children as never);

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children?: unknown; to: string }) =>
    createElement("a", { href: to }, children as never),
  useNavigate: () => vi.fn()
}));
vi.mock("@/components/ui/button", () => ({ Button: Element }));
vi.mock("@/components/ui/card", () => ({
  Card: Element,
  CardHeader: Element,
  CardTitle: Element,
  CardDescription: Element,
  CardContent: Element
}));
vi.mock("@/components/ui/table", () => ({ Table: Element }));
vi.mock("@/components/ui/separator", () => ({ Separator: Element }));
vi.mock("@/components/coeval", () => ({
  Eyebrow: Element,
  SectionHead: Element,
  KPI: Element,
  KPIRow: Element,
  DistBar: Element,
  Legend: Element,
  VerdictChip: Element,
  Chip: Element,
  JourneyPipeline: () => createElement("div", null, "three-act-journey"),
  Receipt: Element,
  Ref: Element
}));
vi.mock("@/components/first-run-setup-ledger", () => ({
  FirstRunSetupLedger: () => createElement("div", null, "three-step-first-run-journey")
}));
vi.mock("@/screens/dashboard-welcome", () => ({ DashboardWelcome: Element }));
vi.mock("@/screens/dashboard-bench-welcome", () => ({ DashboardBenchWelcome: Element }));
vi.mock("@/screens/dashboard-provisional", () => ({ DashboardProvisional: Element }));
vi.mock("@/components/first-project-key", () => ({ FirstProjectKeyCard: () => null }));
vi.mock("@/components/first-verdict", () => ({ FirstVerdictCard: () => null }));
vi.mock("@/components/row-action", () => ({ RowLink: Element }));
vi.mock("@/lib/legacy-human-checks", () => ({ countLegacyHumanCheckedCases: vi.fn() }));
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));
vi.mock("@/lib/dashboard-context", () => ({
  useDashboard: () => ({
    dashboard: state.dashboard,
    loading: false,
    error: null,
    reload: vi.fn()
  })
}));
vi.mock("@/hooks/use-mode", () => ({ useMode: () => ["pm", vi.fn()] }));

function productionBench(input: { judged: number; golden: number }): DashboardSummary {
  return {
    viewerRole: "owner",
    project: {
      id: "project_bench",
      mode: "bench",
      importedTraceCount: 6,
      autoJudgedTraceCount: input.judged,
      syncBackCoverage: 0,
      traceProvider: "manual",
      updatedAt: "2026-08-26T20:00:00.000Z"
    },
    skill: {
      isStarter: false,
      criterionId: null,
      name: "Support quality",
      ownerName: "Owner",
      currentVersion: {
        version: "1.0.0",
        status: "approved",
        approvedAt: "2026-08-26T19:00:00.000Z",
        goldenSetAgreement: null,
        tooStrictCount: 0,
        tooLenientCount: 0,
        modelBinding: {
          provider: "openai",
          modelId: "gpt-5",
          modelVersion: "gpt-5",
          temperature: 0
        }
      }
    },
    goldenSetSize: input.golden,
    exceptions: [],
    topCapabilityGaps: [],
    verdictDistribution: { pass: input.judged, fail: 0, ambiguous: 0 }
  } as DashboardSummary;
}

describe("Skill Bench dashboard routing", () => {
  it("keeps the first-run ledger mounted after examples are imported", async () => {
    const { DashboardScreen } = await import("../src/screens/dashboard.js");
    state.dashboard = productionBench({ judged: 0, golden: 0 });
    const html = renderToStaticMarkup(createElement(DashboardScreen));

    expect(html).toContain("three-step-first-run-journey");
    expect(html).not.toContain("three-act-journey");
  });

  it("keeps the same ledger mounted after the first Result", async () => {
    const { DashboardScreen } = await import("../src/screens/dashboard.js");
    state.dashboard = productionBench({ judged: 6, golden: 1 });
    const html = renderToStaticMarkup(createElement(DashboardScreen));

    expect(html).toContain("three-step-first-run-journey");
  });
});
