import { describe, expect, it } from "vitest";
import { buildTrustDigest } from "../src/lib/trust-digest.js";
import type { GoldenSetHealthSummary, KappaSummary, SelfConsistencyReport, SkillVersion } from "@coeval/shared";

const VERSION = {
  id: "skillv_digest",
  version: "0.1.3"
} as SkillVersion;

function health(overrides: Partial<GoldenSetHealthSummary> = {}): GoldenSetHealthSummary {
  return {
    projectId: "proj_1",
    status: "healthy",
    totalActive: 0,
    staleAfterDays: 30,
    staleCount: 0,
    freshCount: 0,
    passCount: 0,
    failCount: 0,
    oldestPromotedAt: null,
    newestPromotedAt: null,
    staleEntries: [],
    duplicateCount: 0,
    duplicateGroups: [],
    recommendations: [],
    ...overrides
  } as GoldenSetHealthSummary;
}

function calibration(
  pairs: KappaSummary["pairs"],
  undefinedPairs: KappaSummary["undefinedPairs"] = []
): KappaSummary {
  return {
    raterCount: pairs.length + undefinedPairs.length + 1,
    overlappingCases: 5,
    pairs,
    meanKappa: null,
    meanInterpretation: null,
    undefinedPairs,
    unsupportedPairs: 0
  };
}

function consistency(overrides: Partial<SelfConsistencyReport> = {}): SelfConsistencyReport {
  return {
    skillVersionId: VERSION.id,
    comparedCases: 0,
    consistentCases: 0,
    meanAgreement: null,
    cases: [],
    ...overrides
  };
}

const SPEND = { windowRuns: 10, runsCounted: 0, freshItems: 0, cachedItems: 0, inputTokens: null, outputTokens: null, usageMissingCount: 0 };

function build(overrides: Partial<Parameters<typeof buildTrustDigest>[0]> = {}) {
  return buildTrustDigest({
    generatedAt: "2026-07-05T00:00:00.000Z",
    version: VERSION,
    goldenSetHealth: health(),
    calibration: calibration([]),
    selfConsistency: consistency(),
    spend: SPEND,
    ...overrides
  });
}

describe("trust digest (M3 S4)", () => {
  it("a fresh project produces ONLY explicit no-signal facts — zero nudges, nothing fabricated", () => {
    const digest = build();
    expect(digest.nudges).toEqual([]);
    expect(digest.noSignal).toHaveLength(4);
    expect(digest.noSignal.join(" ")).toMatch(/golden set: no active entries/);
    expect(digest.noSignal.join(" ")).toMatch(/no human verdicts overlap/);
    expect(digest.noSignal.join(" ")).toMatch(/judged twice/);
    expect(digest.noSignal.join(" ")).toMatch(/no eval runs/);
  });

  it("an EMPTY golden set marked needs_action is a no-signal fact, never a nudge (locked shape)", () => {
    const digest = build({ goldenSetHealth: health({ status: "needs_action", totalActive: 0, recommendations: ["Promote reviewed exceptions"] }) });
    expect(digest.nudges).toEqual([]);
    expect(digest.noSignal.join(" ")).toMatch(/golden set: no active entries/);
  });

  it("golden health nudges only with >=1 active entry and needs_action, with counts + falsifier", () => {
    const digest = build({ goldenSetHealth: health({ status: "needs_action", totalActive: 4, staleCount: 3 }) });
    const nudge = digest.nudges.find((candidate) => candidate.signal === "golden_health");
    expect(nudge?.sentence).toContain("3 of 4");
    expect(nudge?.falsifier).toMatch(/What would prove this wrong/);
  });

  it("golden nudge names the REAL driver: small set and duplicates never masquerade as staleness", () => {
    const small = build({ goldenSetHealth: health({ status: "needs_action", totalActive: 4, staleCount: 0 }) });
    const smallNudge = small.nudges.find((candidate) => candidate.signal === "golden_health");
    expect(smallNudge?.sentence).toContain("only 4 active entries");
    expect(smallNudge?.sentence).not.toContain("stale");
    expect(smallNudge?.falsifier).toContain("promote more reviewed cases");

    const dupes = build({ goldenSetHealth: health({ status: "needs_action", totalActive: 12, staleCount: 0, duplicateCount: 2 }) });
    const dupeNudge = dupes.nudges.find((candidate) => candidate.signal === "golden_health");
    expect(dupeNudge?.sentence).toContain("2 duplicate(s)");
    expect(dupeNudge?.sentence).not.toContain("stale");
    expect(dupeNudge?.falsifier).toContain("retire the duplicate entries");
  });

  it("judge–human κ nudges below moderate over >=5 cases; moderate-or-better and small overlaps never nudge", () => {
    const judge = `judge:${VERSION.id}`;
    const weak = build({
      calibration: calibration([
        { reviewerA: judge, reviewerB: "Dana", cases: 6, observedAgreement: 0.5, expectedAgreement: 0.45, kappa: 0.09, interpretation: "slight" }
      ])
    });
    expect(weak.nudges.map((nudge) => nudge.signal)).toContain("judge_human_kappa");
    expect(weak.nudges[0]?.sentence).toContain("6 overlapping");

    const small = build({
      calibration: calibration([
        { reviewerA: judge, reviewerB: "Dana", cases: 4, observedAgreement: 0.5, expectedAgreement: 0.45, kappa: 0.09, interpretation: "slight" }
      ])
    });
    expect(small.nudges).toEqual([]);

    const fine = build({
      calibration: calibration([
        { reviewerA: judge, reviewerB: "Dana", cases: 8, observedAgreement: 0.9, expectedAgreement: 0.5, kappa: 0.8, interpretation: "substantial" }
      ])
    });
    expect(fine.nudges).toEqual([]);
    // Another version's judge rater never bleeds in (A2.2c pinning).
    const foreign = build({
      calibration: calibration([
        { reviewerA: "judge:skillv_OTHER", reviewerB: "Dana", cases: 9, observedAgreement: 0.4, expectedAgreement: 0.4, kappa: 0, interpretation: "poor" }
      ])
    });
    expect(foreign.judgeHumanKappa).toEqual([]);
    expect(foreign.nudges).toEqual([]);
  });

  it("reports one-label judge–human kappa as undefined, not as no overlap or a favorable signal", () => {
    const digest = build({
      calibration: calibration([], [{
        reviewerA: `judge:${VERSION.id}`,
        reviewerB: "Dana",
        cases: 8,
        observedAgreement: 1,
        expectedAgreement: 1,
        kappa: null,
        interpretation: null,
        reason: "expected_agreement_one"
      }])
    });

    expect(digest.judgeHumanKappa).toEqual([]);
    expect(digest.nudges).toEqual([]);
    expect(digest.noSignal.join(" ")).toMatch(/undefined.*expected agreement is 1/);
    expect(digest.noSignal.join(" ")).not.toMatch(/no human verdicts overlap/);
  });

  it("self-consistency nudges below 1.0 over >=3 repeat-judged cases, stating consistent ≠ correct", () => {
    const drifty = build({ selfConsistency: consistency({ comparedCases: 4, consistentCases: 2, meanAgreement: 0.75 }) });
    const nudge = drifty.nudges.find((candidate) => candidate.signal === "self_consistency");
    expect(nudge?.sentence).toContain("2 of 4");
    expect(nudge?.sentence).toContain("Consistent ≠ correct");

    const tooFew = build({ selfConsistency: consistency({ comparedCases: 2, consistentCases: 1, meanAgreement: 0.5 }) });
    expect(tooFew.nudges).toEqual([]);

    const perfect = build({ selfConsistency: consistency({ comparedCases: 5, consistentCases: 5, meanAgreement: 1 }) });
    expect(perfect.nudges).toEqual([]);
  });
});
