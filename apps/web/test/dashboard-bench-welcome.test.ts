import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@coeval/shared";
import { FirstRunSetupLedger } from "../src/components/first-run-setup-ledger.js";

const ledgerHarness = vi.hoisted(() => ({
  navigate: vi.fn(),
  steps: [] as Array<{
    title: string;
    onCta?: () => void;
    onSecondaryCta?: () => void;
  }>
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => ledgerHarness.navigate }));
vi.mock("@/components/coeval", () => ({
  SetupLedger: ({ steps, description }: {
    steps: Array<{
      state: string;
      title: string;
      detail?: string;
      cta?: string;
      onCta?: () => void;
      secondaryCta?: string;
      onSecondaryCta?: () => void;
      foot?: string;
    }>;
    description: string;
  }) => {
    ledgerHarness.steps = steps;
    return createElement(
      "div",
      null,
      description,
      ...steps.map((step) => createElement("div", { key: step.title }, step.title, step.detail, step.secondaryCta, step.cta, step.foot))
    );
  }
}));
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));

function dashboard(input: {
  imported: number;
  judged: number;
  golden: number;
  starter?: boolean;
  exceptions?: number;
  mode?: "bench" | "tracing";
}): DashboardSummary {
  return {
    project: {
      id: "project_bench",
      mode: input.mode ?? "bench",
      importedTraceCount: input.imported,
      autoJudgedTraceCount: input.judged
    },
    skill: {
      isStarter: input.starter ?? false,
      currentVersion: {
        id: "skillv_current",
        version: "1.0.0",
        status: input.starter ? "draft" : "approved"
      }
    },
    currentVersionResultCount: input.judged,
    goldenSetSize: input.golden,
    viewerRole: "owner",
    exceptions: Array.from({ length: input.exceptions ?? 0 }, (_, index) => ({ id: `case_${index}` }))
  } as DashboardSummary;
}

describe("first-run setup ledger", () => {
  it("shows an agent-bootstrapped Check as complete and makes a Run next", () => {
    const html = renderToStaticMarkup(createElement(
      FirstRunSetupLedger,
      {
        dashboard: dashboard({ imported: 0, judged: 0, golden: 0 })
      }
    ));

    expect(html).toContain("1 of 3 complete");
    expect(html).toContain("Check v1.0.0 ready");
    expect(html).toContain("Add an example");
    expect(html).not.toContain("Review the Check");
  });

  it("offers a low-friction no-Run escape hatch without technical setup terms", () => {
    ledgerHarness.navigate.mockClear();
    const html = renderToStaticMarkup(createElement(FirstRunSetupLedger, {
      dashboard: dashboard({ imported: 0, judged: 0, golden: 0, starter: true })
    }));

    expect(html).toContain("Set up without a run");
    expect(html).not.toContain("structured verdict");
    expect(html).not.toContain("Golden");

    ledgerHarness.steps[0]?.onCta?.();
    ledgerHarness.steps[0]?.onSecondaryCta?.();
    expect(ledgerHarness.navigate).toHaveBeenNthCalledWith(1, "/datasets?add=1");
    expect(ledgerHarness.navigate).toHaveBeenNthCalledWith(2, "/skill/edit?first=1&starter=task-outcome-quality");
  });

  it("gives tracing projects an honest recorded-Run path", () => {
    ledgerHarness.navigate.mockClear();
    const html = renderToStaticMarkup(createElement(FirstRunSetupLedger, {
      dashboard: dashboard({ imported: 0, judged: 0, golden: 0, starter: true, mode: "tracing" })
    }));

    expect(html).toContain("Bring one recorded run");
    expect(html).toContain("Coeval reads the record; it does not replay your AI.");
    expect(html).toContain("Add a recorded run");

    ledgerHarness.steps[0]?.onCta?.();
    expect(ledgerHarness.navigate).toHaveBeenCalledWith("/traces");
  });

  it("completes setup at the first Result without requiring a protected example", () => {
    const html = renderToStaticMarkup(createElement(
      FirstRunSetupLedger,
      {
        dashboard: dashboard({ imported: 6, judged: 6, golden: 0 })
      }
    ));

    expect(html).toContain("first result ready");
    expect(html).toContain("3 of 3");
    expect(html).not.toContain("Golden");
  });

  it("shows the Result action only after the Check and Run are ready", () => {
    ledgerHarness.navigate.mockClear();
    const runHtml = renderToStaticMarkup(createElement(FirstRunSetupLedger, {
      dashboard: dashboard({ imported: 6, judged: 0, golden: 0 })
    }));
    expect(runHtml).toContain("Continue to first Result");
    ledgerHarness.steps[2]?.onCta?.();
    expect(ledgerHarness.navigate).toHaveBeenCalledWith("/first-result?version=skillv_current");

    const starterHtml = renderToStaticMarkup(createElement(FirstRunSetupLedger, {
      dashboard: dashboard({ imported: 6, judged: 0, golden: 0, starter: true })
    }));
    expect(starterHtml).toContain("Review the Check");
    expect(starterHtml).not.toContain("Continue to first Result");
  });

  it("does not offer members an owner-only Result action", () => {
    const member = dashboard({ imported: 1, judged: 0, golden: 0 });
    member.viewerRole = "member";
    const html = renderToStaticMarkup(createElement(FirstRunSetupLedger, { dashboard: member }));

    expect(html).toContain("An owner needs to start this Result.");
    expect(html).not.toContain("Continue to first Result");
  });
});
