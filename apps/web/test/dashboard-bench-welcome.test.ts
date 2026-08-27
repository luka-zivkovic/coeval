import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@coeval/shared";
import { BenchSetupLedger } from "../src/components/bench-setup-ledger.js";

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/coeval", () => ({
  SetupLedger: ({ steps, description }: {
    steps: Array<{ state: string; title: string; detail?: string; cta?: string; foot?: string }>;
    description: string;
  }) =>
    createElement(
      "div",
      null,
      description,
      ...steps.map((step) => createElement("div", { key: step.title }, step.title, step.detail, step.cta, step.foot))
    )
}));
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));

function dashboard(input: {
  imported: number;
  judged: number;
  golden: number;
  starter?: boolean;
  exceptions?: number;
}): DashboardSummary {
  return {
    project: {
      id: "project_bench",
      mode: "bench",
      importedTraceCount: input.imported,
      autoJudgedTraceCount: input.judged
    },
    skill: {
      isStarter: input.starter ?? false,
      currentVersion: { version: "1.0.0", status: "approved" }
    },
    goldenSetSize: input.golden,
    exceptions: Array.from({ length: input.exceptions ?? 0 }, (_, index) => ({ id: `case_${index}` }))
  } as DashboardSummary;
}

describe("Skill Bench setup ledger", () => {
  it("shows an agent-bootstrapped evaluator as complete and makes examples next", () => {
    const html = renderToStaticMarkup(createElement(
      BenchSetupLedger,
      {
        dashboard: dashboard({ imported: 0, judged: 0, golden: 0 })
      }
    ));

    expect(html).toContain("1 of 4 complete");
    expect(html).toContain("v1.0.0 ready");
    expect(html).toContain("Add examples");
    expect(html).not.toContain("Open the editor");
  });

  it("explains the evaluator output contract during starter setup", () => {
    const html = renderToStaticMarkup(createElement(BenchSetupLedger, {
      dashboard: dashboard({ imported: 0, judged: 0, golden: 0, starter: true })
    }));

    expect(html).toContain("structured verdict");
    expect(html).toContain("Open the editor");
  });

  it("marks regression checks enabled after the first golden case", () => {
    const html = renderToStaticMarkup(createElement(
      BenchSetupLedger,
      {
        dashboard: dashboard({ imported: 6, judged: 6, golden: 1 })
      }
    ));

    expect(html).toContain("4 of 4 complete");
    expect(html).toContain("1 active · 1/5 recommended");
  });

  it("shows reachable run and regression actions as saved state advances", () => {
    const runHtml = renderToStaticMarkup(createElement(BenchSetupLedger, {
      dashboard: dashboard({ imported: 6, judged: 0, golden: 0 })
    }));
    expect(runHtml).toContain("Run examples");

    const goldenHtml = renderToStaticMarkup(createElement(BenchSetupLedger, {
      dashboard: dashboard({ imported: 6, judged: 6, golden: 0 })
    }));
    expect(goldenHtml).toContain("Open golden set");

    const disagreementHtml = renderToStaticMarkup(createElement(BenchSetupLedger, {
      dashboard: dashboard({ imported: 6, judged: 6, golden: 0, exceptions: 1 })
    }));
    expect(disagreementHtml).toContain("Review disagreements");
  });
});
