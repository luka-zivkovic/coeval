import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ConvergenceAudit } from "@coeval/shared";
import {
  convergenceCaseComparisonLabel,
  reliabilityHeroAction,
  reliabilityHeroProjection
} from "../src/lib/reliability-ui.js";

function audit(overrides: Partial<ConvergenceAudit> = {}): ConvergenceAudit {
  const cases = Array.from({ length: 12 }, (_, index) => ({
    caseId: `case_${index + 1}`,
    adjudicatedLabel: index < 9 ? "pass" : "fail",
    beforeLabel: null,
    afterLabel: index < 9 ? "pass" : "pass",
    change: index < 9 ? "still_agree" as const : "still_disagree" as const
  }));
  return {
    afterVersionId: "skillv_2",
    beforeVersionId: "skillv_1",
    adjudicatedTotal: 15,
    comparedCases: 12,
    afterAgreed: 9,
    beforeKnown: 0,
    beforeAgreed: 0,
    improved: 0,
    regressed: 0,
    cases,
    ...overrides
  };
}

describe("reliability hierarchy", () => {
  it("leads with exact current-version agreement and visible coverage", () => {
    const hero = reliabilityHeroProjection(audit());
    expect(hero.agreementPercent).toBe("75%");
    expect(hero.agreementSentence).toBe(
      "This evaluator matched the recorded legacy adjudication on 9 of 12 adjudicated cases it judged."
    );
    expect(hero.coverageSentence).toBe("12 of 15 adjudicated cases were covered by this version.");
    expect(hero.sampleCaveat).toContain("ungoverned, self-selected slice");
    expect(hero.nextDisagreementCaseId).toBe("case_10");
  });

  it("turns empty and uncovered states into concrete next actions", () => {
    const empty = audit({
      adjudicatedTotal: 0,
      comparedCases: 0,
      afterAgreed: 0,
      cases: []
    });
    expect(reliabilityHeroProjection(empty)).toMatchObject({
      agreementPercent: null,
      agreementSentence: "No recorded legacy adjudications are available for this evaluator version yet."
    });
    expect(reliabilityHeroAction(empty, null)).toEqual({
      kind: "open_exceptions",
      label: "Rule more exceptions",
      caseId: null
    });

    const uncovered = reliabilityHeroProjection(audit({ comparedCases: 0, afterAgreed: 0, cases: [] }));
    expect(uncovered.agreementSentence).toContain("has not judged any of the 15");
    expect(uncovered.sampleCaveat).toContain("Re-run those exact cases");
    // A general latest-version disagreement is deliberately not an input to
    // the pinned hero. Zero coverage always runs the exact pinned version on
    // the server-selected uncovered adjudicated case.
    expect(reliabilityHeroAction(audit({ comparedCases: 0, afterAgreed: 0, cases: [] }), "case_uncovered")).toEqual({
      kind: "run_uncovered",
      label: "Run current version on next uncovered case",
      caseId: "case_uncovered"
    });
  });

  it("keeps a low-N current-version comparison descriptive and version-pinned", () => {
    const lowN = audit({
      adjudicatedTotal: 4,
      comparedCases: 1,
      afterAgreed: 0,
      cases: [{
        caseId: "case_current_mismatch",
        adjudicatedLabel: "fail",
        beforeLabel: "fail",
        afterLabel: "pass",
        change: "regressed"
      }]
    });
    const hero = reliabilityHeroProjection(lowN);
    expect(hero.agreementSentence).toContain("0 of 1");
    expect(hero.coverageSentence).toBe("1 of 4 adjudicated cases were covered by this version.");
    expect(hero.sampleCaveat).toContain("One additional case");
    expect(reliabilityHeroAction(lowN, "case_uncovered")).toEqual({
      kind: "open_case",
      label: "Review current-version disagreement",
      caseId: "case_current_mismatch"
    });
  });

  it("does not invent a prior judgment for a baseline or partially covered predecessor", () => {
    expect(convergenceCaseComparisonLabel({
      caseId: "baseline",
      adjudicatedLabel: "pass",
      beforeLabel: null,
      afterLabel: "pass",
      change: "still_agree"
    })).toBe("No prior judgment; this version matches the recorded ruling");
    expect(convergenceCaseComparisonLabel({
      caseId: "newer-case",
      adjudicatedLabel: "fail",
      beforeLabel: null,
      afterLabel: "pass",
      change: "still_disagree"
    })).toBe("No prior judgment; this version differs from the recorded ruling");
  });

  it("keeps secondary diagnostics collapsed and legacy evidence labels explicit", async () => {
    const source = await readFile(new URL("../src/screens/reliability.tsx", import.meta.url), "utf8");
    expect(source).toContain("Current evaluator vs recorded rulings");
    expect(source).toContain("Exact current-version comparison");
    expect(source).toContain("Reviewer agreement (κ)");
    expect(source).toContain("Other diagnostics");
    expect(source).toContain("ungoverned · self-selected");
    expect(source).toContain("Record a legacy adjudication");
    expect(source).toContain("No prior judgment");
    expect(source).toContain("Load more exact cases");
    expect(source).not.toContain("<KPIRow");
    expect(source).not.toMatch(/ground[- ]truth/i);
  });

  it("uses baseline-safe change copy in both reliability surfaces", async () => {
    const source = await readFile(
      new URL("../src/components/coeval/convergence-audit.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toContain("c.beforeLabel === null");
    expect(source).toContain('label: "matches ruling"');
    expect(source).toContain('label: "differs from ruling"');
  });

  it("does not label legacy adjudication artifacts as ground truth", async () => {
    const sources = await Promise.all([
      readFile(new URL("../src/lib/resolved.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
      readFile(new URL("../../api/src/lib/kappa.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../packages/shared/src/index.ts", import.meta.url), "utf8")
    ]);
    const legacyGroundTruthPatterns = [
      /adjudicated ground[- ]truth/i,
      /ground truth set by adjudication/i,
      /owner adjudication \(governed ground truth\)/i,
      /turns a split into a recorded truth/i,
      /truth the next skill version is judged on/i
    ];
    for (const source of sources) {
      for (const pattern of legacyGroundTruthPatterns) expect(source).not.toMatch(pattern);
    }
  });
});
