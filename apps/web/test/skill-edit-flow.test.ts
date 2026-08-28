import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  SkillChangeReview,
  SkillEditFlow
} from "../src/components/skill-edit-flow.js";
import {
  knownFailureGateSummary,
  regressionReceiptLabel,
  skillEditOperationIsCurrent,
  skillVersionChangeLabels,
  verdictOutputContractChanged
} from "../src/lib/skill-edit-flow.js";
import type { RegressionRunResult, SkillVersion } from "@coeval/shared";

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardContent: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardDescription: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardHeader: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardTitle: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never)
}));
vi.mock("@/components/coeval", () => ({
  Chip: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  Eyebrow: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never)
}));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));

const base: SkillVersion = {
  id: "skillv_base",
  skillId: "skill_1",
  criterionVersionId: "criterionv_1",
  version: "1.1.0",
  status: "approved",
  rubricMarkdown: "# Guide\n\nPass when grounded.",
  prompt: "Judge against {{rubric_markdown}}.",
  modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
  outputSchema: { type: "object" },
  goldenSetAgreement: 1,
  tooStrictCount: 0,
  tooLenientCount: 0,
  ambiguousCount: 0,
  knownLimitations: [],
  verdictKind: "binary",
  scalarRange: null,
  categoricalChoiceScores: null,
  rubricProvenance: "human-authored",
  regressionDatasetRevisionId: "revision_base",
  createdAt: "2026-08-26T00:00:00.000Z",
  approvedAt: "2026-08-26T00:01:00.000Z"
};

describe("guided evaluator editing", () => {
  it("shows the durable version and exact pinned-case count in the running stage", () => {
    const html = renderToStaticMarkup(createElement(SkillEditFlow, {
      phase: "running",
      baseVersion: "1.1.0",
      createdVersion: "1.2.0",
      referenceCount: 3
    }));

    expect(html).toContain("Review changes");
    expect(html).toContain("v1.2.0 recorded");
    expect(html).toContain("3 cases");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("Passed</span>");
  });

  it("distinguishes the first armed case from the recommended starting set", () => {
    expect(knownFailureGateSummary(0)).toContain("enables at 1");
    expect(knownFailureGateSummary(1)).toContain("check enabled with 1 active reference case");
    expect(knownFailureGateSummary(1)).toContain("1/5 toward the recommended");
    expect(knownFailureGateSummary(5)).toContain("recommended starting set of 5 has been reached");
  });

  it("reviews field-level changes and preserves exact old/new source before save", () => {
    const html = renderToStaticMarkup(createElement(SkillChangeReview, {
      base,
      rubricMarkdown: "# Guide\n\nPass only with a cited source.",
      prompt: base.prompt,
      modelBinding: { ...base.modelBinding, modelId: "mock-v2", modelVersion: "mock-v2" },
      verdictKind: "binary",
      timeScope: "both"
    }));

    expect(html).toContain("Review changes from v1.1.0");
    expect(html).toContain("Saving never overwrites v1.1.0");
    expect(html).toContain("2 evaluator fields changed");
    expect(html).toContain("View exact source comparison");
    expect(html).toContain("Pass when grounded.");
    expect(html).toContain("Pass only with a cited source.");
    expect(html).toContain("Future and existing traces");
  });

  it("summarizes what changed for the version-history ledger", () => {
    expect(skillVersionChangeLabels({
      ...base,
      id: "skillv_next",
      version: "1.2.0",
      rubricMarkdown: "A stricter guide.",
      modelBinding: { ...base.modelBinding, modelId: "mock-v2", modelVersion: "mock-v2" }
    }, base)).toEqual(["review guide", "requested model"]);
    expect(skillVersionChangeLabels(base)).toEqual(["initial version"]);
  });

  it("keeps a template's changed result contract after its guide is edited", () => {
    expect(verdictOutputContractChanged(base, {
      verdictKind: "categorical",
      scalarRange: null,
      categoricalChoiceScores: { faithful: 1, partial: 0.5, unsupported: 0 }
    })).toBe(true);
    expect(verdictOutputContractChanged(base, {
      verdictKind: base.verdictKind,
      scalarRange: base.scalarRange,
      categoricalChoiceScores: base.categoricalChoiceScores
    })).toBe(false);
  });

  it("renders terminal blocked and error outcomes without calling them active", () => {
    const blocked = renderToStaticMarkup(createElement(SkillEditFlow, {
      phase: "result",
      baseVersion: "1.1.0",
      createdVersion: "1.2.0",
      referenceCount: 5,
      outcome: "blocked"
    }));
    const failed = renderToStaticMarkup(createElement(SkillEditFlow, {
      phase: "result",
      baseVersion: "1.1.0",
      createdVersion: "1.2.0",
      referenceCount: 5,
      outcome: "error"
    }));

    expect(blocked).toContain("Review required");
    expect(failed).toContain("Check failed");
    expect(`${blocked}${failed}`).not.toMatch(/version (?:is )?active|activated evaluator/i);
  });

  it("labels exact terminal receipts without inferring pass from approval", () => {
    const run = (status: RegressionRunResult["status"], goldenSetMissing = false): RegressionRunResult => ({
      id: `run_${status}`,
      skillVersionId: "skillv_next",
      datasetRevisionId: "revision_1",
      status,
      compared: goldenSetMissing ? 0 : 2,
      regressed: status === "blocked" || status === "overridden" ? 1 : 0,
      improved: 0,
      flipped: 0,
      goldenSetMissing,
      cases: [],
      createdAt: "2026-08-26T01:00:00.000Z"
    });

    expect(regressionReceiptLabel(run("passed"))).toBe("check passed");
    expect(regressionReceiptLabel(run("passed", true))).toBe("recorded without comparison");
    expect(regressionReceiptLabel(run("overridden"))).toBe("override recorded");
    expect(regressionReceiptLabel(run("blocked"))).toBe("regression found");
    expect(regressionReceiptLabel(run("error"))).toBe("check failed");
    expect(regressionReceiptLabel(undefined)).toBe("no regression receipt");
  });

  it("fails closed across criterion changes and governed evaluator lineages", async () => {
    const source = await readFile(new URL("../src/screens/skill-edit.tsx", import.meta.url), "utf8");

    expect(source).toContain("loadedCriterionId !== selectedCriterionId");
    expect(source).toContain('next.delete("version")');
    expect(source).toContain('selectedChoice?.criterion.sourceKind === "analysis_promotion"');
    expect(source).toContain("Legacy editing and overrides are unavailable");
    expect(source).toContain('htmlFor="skill-regression-override-reason"');
  });

  it("ignores a deferred create response after its criterion scope changes", async () => {
    let resolve!: () => void;
    const response = new Promise<void>((done) => { resolve = done; });
    const submitted = { generation: 4, criterionId: "criterion_a", skillId: "skill_a" };
    let adopted = false;
    const completion = response.then(() => {
      adopted = skillEditOperationIsCurrent(submitted, {
        generation: 5,
        criterionId: "criterion_b",
        skillId: "skill_b"
      });
    });

    resolve();
    await completion;
    expect(adopted).toBe(false);
  });
});
