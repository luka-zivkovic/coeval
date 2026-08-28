import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@coeval/shared";

const Element = ({ children, ...props }: { children?: unknown }) =>
  createElement("div", props, children as never);

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: Element }));
vi.mock("@/components/first-project-key", () => ({ FirstProjectKeyCard: () => null }));
vi.mock("@/components/first-verdict", () => ({ FirstVerdictCard: () => null }));
vi.mock("@/components/coeval", () => ({
  SectionHead: Element,
  KPI: Element,
  KPIRow: Element,
  ProvBanner: ({ text, cta, cta2 }: { text?: unknown; cta?: unknown; cta2?: unknown }) =>
    createElement("div", null, text as never, cta as never, cta2 as never),
  SetupLedger: ({ steps, description }: {
    steps: Array<{ state: string; title: string; cta?: string; foot?: string }>;
    description?: string;
  }) => createElement(
    "div",
    null,
    description,
    ...steps.map((step) => createElement("div", { key: step.title }, step.title, step.cta, step.foot))
  )
}));
vi.mock("@/components/first-run-setup-ledger", async () =>
  import("../src/components/first-run-setup-ledger.js")
);
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  signOffSkillVersion: vi.fn()
}));

function provisionalBench(judged = 0): DashboardSummary {
  return {
    project: {
      id: "project_bench",
      mode: "bench",
      importedTraceCount: 4,
      autoJudgedTraceCount: judged,
      traceProvider: "manual"
    },
    skill: {
      id: "skill_1",
      isStarter: true,
      currentVersion: {
        id: "version_starter",
        version: "0.1.0",
        status: "draft",
        approvedAt: null
      }
    },
    currentVersionResultCount: judged,
    goldenSetSize: 0,
    exceptions: [],
    viewerRole: "owner"
  } as DashboardSummary;
}

describe("provisional Skill Bench journey", () => {
  it("makes the Check the next action after examples arrive", async () => {
    const { DashboardProvisional } = await import("../src/screens/dashboard-provisional.js");
    const html = renderToStaticMarkup(createElement(DashboardProvisional, {
      dashboard: provisionalBench(),
      onSignedOff: vi.fn()
    }));

    expect(html).toContain("Review the Check");
    expect(html).not.toContain("Run the example");
    expect(html).toContain("1 of 3 complete");
    expect(html).toContain("until an owner reviews and signs off the guide");
  });

  it("keeps a missing tracing Result explicit instead of implying a pass", async () => {
    const { DashboardProvisional } = await import("../src/screens/dashboard-provisional.js");
    const dashboard = provisionalBench();
    dashboard.project.mode = "tracing";
    dashboard.project.traceProvider = "langsmith";
    const html = renderToStaticMarkup(createElement(DashboardProvisional, {
      dashboard,
      onSignedOff: vi.fn()
    }));

    expect(html).toContain("No complete Check Result yet");
    expect(html).toContain("has not returned a complete Result");
    expect(html).not.toContain("did not flag these imported runs");
  });

  it("describes partial tracing coverage without extending the Result to pending runs", async () => {
    const { DashboardProvisional } = await import("../src/screens/dashboard-provisional.js");
    const dashboard = provisionalBench(2);
    dashboard.project.mode = "tracing";
    dashboard.project.traceProvider = "langsmith";
    const html = renderToStaticMarkup(createElement(DashboardProvisional, {
      dashboard,
      onSignedOff: vi.fn()
    }));

    expect(html).toContain("2 completed Runs");
    expect(html).toContain("2 still have no complete Result");
    expect(html).not.toContain("did not flag these imported runs");
  });

  it("does not call a completed bench Result unevaluated", async () => {
    const { DashboardProvisional } = await import("../src/screens/dashboard-provisional.js");
    const html = renderToStaticMarkup(createElement(DashboardProvisional, {
      dashboard: provisionalBench(1),
      onSignedOff: vi.fn()
    }));

    expect(html).toContain("1 of 4 examples have a provisional Result");
    expect(html).not.toContain("Nothing has been evaluated yet");
  });

  it("gives members a read-only Check action instead of owner setup controls", async () => {
    const { DashboardProvisional } = await import("../src/screens/dashboard-provisional.js");
    const dashboard = provisionalBench();
    dashboard.viewerRole = "member";
    const html = renderToStaticMarkup(createElement(DashboardProvisional, {
      dashboard,
      onSignedOff: vi.fn()
    }));

    expect(html).toContain("View the Check");
    expect(html).not.toContain("Review the Check");
    expect(html).not.toContain("Use this starter Check");
  });
});
