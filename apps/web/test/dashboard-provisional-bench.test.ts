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
  ProvBanner: ({ text }: { text?: unknown }) => createElement("div", null, text as never),
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
vi.mock("@/components/bench-setup-ledger", async () =>
  import("../src/components/bench-setup-ledger.js")
);
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  signOffSkillVersion: vi.fn()
}));

function provisionalBench(): DashboardSummary {
  return {
    project: {
      id: "project_bench",
      mode: "bench",
      importedTraceCount: 4,
      autoJudgedTraceCount: 0,
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
    goldenSetSize: 0,
    exceptions: []
  } as DashboardSummary;
}

describe("provisional Skill Bench journey", () => {
  it("keeps imported examples runnable while starter rubric review is open", async () => {
    const { DashboardProvisional } = await import("../src/screens/dashboard-provisional.js");
    const html = renderToStaticMarkup(createElement(DashboardProvisional, {
      dashboard: provisionalBench(),
      onSignedOff: vi.fn()
    }));

    expect(html).toContain("Open the editor");
    expect(html).toContain("Run examples");
    expect(html).toContain("1 of 4 complete");
    expect(html).toContain("until an owner reviews and approves the guide");
  });
});
