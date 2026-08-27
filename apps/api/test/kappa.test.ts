import { describe, expect, it } from "vitest";
import { interpretKappa, type VerdictPayload, type VerdictRecord } from "@coeval/shared";
import { computeConvergenceAudit, computeDisagreementSummary, computeJudgeHumanCalibration, computeJudgeHumanDisagreement, computeKappaSummary, computeSelfConsistency, isJudgeActorId } from "../src/lib/kappa.js";

describe("interpretKappa (Landis & Koch bands)", () => {
  it("maps κ values to the canonical six-band interpretation", () => {
    expect(interpretKappa(-0.1)).toBe("poor");
    expect(interpretKappa(0)).toBe("slight");
    expect(interpretKappa(0.2)).toBe("slight");
    expect(interpretKappa(0.21)).toBe("fair");
    expect(interpretKappa(0.4)).toBe("fair");
    expect(interpretKappa(0.41)).toBe("moderate");
    expect(interpretKappa(0.6)).toBe("moderate");
    expect(interpretKappa(0.61)).toBe("substantial");
    expect(interpretKappa(0.8)).toBe("substantial");
    expect(interpretKappa(0.81)).toBe("almost_perfect");
    expect(interpretKappa(1)).toBe("almost_perfect");
  });
});

describe("computeKappaSummary", () => {
  it("returns an empty summary when there are fewer than 2 raters", () => {
    expect(computeKappaSummary([])).toEqual({
      raterCount: 0,
      overlappingCases: 0,
      pairs: [],
      meanKappa: null,
      meanInterpretation: null,
      undefinedPairs: [],
      unsupportedPairs: 0
    });
    const single = computeKappaSummary([humanBinary("case_1", "reviewer_a", true)]);
    expect(single.raterCount).toBe(1);
    expect(single.pairs).toEqual([]);
    expect(single.meanKappa).toBeNull();
  });

  it("returns an explicit undefined result when expected agreement is one", () => {
    const verdicts = [
      humanBinary("case_1", "reviewer_a", true),
      humanBinary("case_1", "reviewer_b", true),
      humanBinary("case_2", "reviewer_a", true),
      humanBinary("case_2", "reviewer_b", true),
      humanBinary("case_3", "reviewer_a", true),
      humanBinary("case_3", "reviewer_b", true)
    ];
    const summary = computeKappaSummary(verdicts);
    expect(summary.raterCount).toBe(2);
    expect(summary.overlappingCases).toBe(3);
    expect(summary.pairs).toEqual([]);
    expect(summary.undefinedPairs).toEqual([{
      reviewerA: "reviewer_a",
      reviewerB: "reviewer_b",
      cases: 3,
      observedAgreement: 1,
      expectedAgreement: 1,
      kappa: null,
      interpretation: null,
      reason: "expected_agreement_one"
    }]);
    expect(summary.meanKappa).toBeNull();
    expect(summary.meanInterpretation).toBeNull();
  });

  it("computes the textbook κ = 0.4 example", () => {
    // Classic 2-rater, 2-category contingency table:
    //                  Rater B
    //                  pos    neg
    // Rater A  pos     20      5
    //          neg     10     15
    // Total n=50. Observed agreement = 35/50 = 0.7
    // Margins: A_pos = 0.5, A_neg = 0.5, B_pos = 0.6, B_neg = 0.4
    // Expected = 0.5*0.6 + 0.5*0.4 = 0.5
    // κ = (0.7 - 0.5) / (1 - 0.5) = 0.4
    const verdicts: VerdictRecord[] = [];
    const push = (caseId: string, reviewerId: string, label: "pos" | "neg") =>
      verdicts.push(humanBinary(caseId, reviewerId, label === "pos"));
    let id = 0;
    // 20 cases: both pos
    for (let i = 0; i < 20; i += 1) { id += 1; push(`c_${id}`, "reviewer_a", "pos"); push(`c_${id}`, "reviewer_b", "pos"); }
    // 5 cases: A=pos, B=neg
    for (let i = 0; i < 5; i += 1) { id += 1; push(`c_${id}`, "reviewer_a", "pos"); push(`c_${id}`, "reviewer_b", "neg"); }
    // 10 cases: A=neg, B=pos
    for (let i = 0; i < 10; i += 1) { id += 1; push(`c_${id}`, "reviewer_a", "neg"); push(`c_${id}`, "reviewer_b", "pos"); }
    // 15 cases: both neg
    for (let i = 0; i < 15; i += 1) { id += 1; push(`c_${id}`, "reviewer_a", "neg"); push(`c_${id}`, "reviewer_b", "neg"); }

    const summary = computeKappaSummary(verdicts);
    expect(summary.pairs).toHaveLength(1);
    expect(summary.pairs[0]?.cases).toBe(50);
    expect(summary.pairs[0]?.observedAgreement).toBeCloseTo(0.7);
    expect(summary.pairs[0]?.expectedAgreement).toBeCloseTo(0.5);
    expect(summary.pairs[0]?.kappa).toBeCloseTo(0.4);
    expect(summary.pairs[0]?.interpretation).toBe("fair");
  });

  it("returns negative κ when raters systematically disagree", () => {
    // 4 cases, both raters cover the same 4 cases, raters always disagree on
    // a balanced 50/50 marginal → κ should be negative (< 0).
    const verdicts: VerdictRecord[] = [
      humanBinary("case_1", "reviewer_a", true),
      humanBinary("case_1", "reviewer_b", false),
      humanBinary("case_2", "reviewer_a", false),
      humanBinary("case_2", "reviewer_b", true),
      humanBinary("case_3", "reviewer_a", true),
      humanBinary("case_3", "reviewer_b", false),
      humanBinary("case_4", "reviewer_a", false),
      humanBinary("case_4", "reviewer_b", true)
    ];
    const summary = computeKappaSummary(verdicts);
    expect(summary.pairs[0]?.observedAgreement).toBe(0);
    expect(summary.pairs[0]?.kappa).toBeLessThan(0);
    expect(summary.pairs[0]?.interpretation).toBe("poor");
  });

  it("computes pairwise κ + mean for 3 reviewers", () => {
    // A and B agree on everything, C disagrees with both half the time.
    // Pair (A, B): κ = 1
    // Pair (A, C): observed = 0.5, expected = 0.5, κ = 0
    // Pair (B, C): same as A-C
    // Mean κ ≈ 0.333.
    const verdicts: VerdictRecord[] = [];
    const total = 8;
    for (let i = 1; i <= total; i += 1) {
      const caseId = `c_${i}`;
      const truth = i % 2 === 0;
      verdicts.push(humanBinary(caseId, "reviewer_a", truth));
      verdicts.push(humanBinary(caseId, "reviewer_b", truth));
      verdicts.push(humanBinary(caseId, "reviewer_c", i <= total / 2 ? truth : !truth));
    }
    const summary = computeKappaSummary(verdicts);
    expect(summary.raterCount).toBe(3);
    expect(summary.pairs).toHaveLength(3);
    const abPair = summary.pairs.find((p) => p.reviewerA === "reviewer_a" && p.reviewerB === "reviewer_b");
    const acPair = summary.pairs.find((p) => p.reviewerA === "reviewer_a" && p.reviewerB === "reviewer_c");
    expect(abPair?.kappa).toBe(1);
    expect(acPair?.kappa).toBeCloseTo(0);
    expect(summary.meanKappa ?? 0).toBeCloseTo((1 + 0 + 0) / 3, 5);
  });

  it("handles categorical verdicts the same way", () => {
    const categorical = (caseId: string, actor: string, choice: string): VerdictRecord => ({
      id: `verdict_${caseId}_${actor}`,
      projectId: "proj_t",
      caseId,
      skillVersionId: null,
      source: "human",
      actorUserId: actor,
      payload: { kind: "categorical", choice, choiceScores: { good: 1, okay: 0.5, bad: 0 }, rationale: "" },
      externalRunId: null,
      createdAt: new Date().toISOString()
    });

    // 4 cases, all reviewers agree on 3, disagree on 1.
    const verdicts = [
      categorical("c1", "a", "good"), categorical("c1", "b", "good"),
      categorical("c2", "a", "okay"), categorical("c2", "b", "okay"),
      categorical("c3", "a", "bad"), categorical("c3", "b", "bad"),
      categorical("c4", "a", "good"), categorical("c4", "b", "okay")
    ];
    const summary = computeKappaSummary(verdicts);
    expect(summary.pairs).toHaveLength(1);
    expect(summary.pairs[0]?.cases).toBe(4);
    expect(summary.pairs[0]?.observedAgreement).toBe(0.75);
    expect(summary.pairs[0]?.kappa).toBeGreaterThan(0);
    expect(summary.pairs[0]?.kappa).toBeLessThan(1);
  });

  it("treats explicit binary abstention as an ambiguous discrete category", () => {
    const ambiguous = (caseId: string, actorUserId: string): VerdictRecord => ({
      id: `verdict_${caseId}_${actorUserId}`,
      projectId: "proj_t",
      caseId,
      skillVersionId: null,
      source: "human",
      actorUserId,
      payload: { kind: "binary", label: "ambiguous", rationale: "insufficient evidence" },
      externalRunId: null,
      createdAt: new Date().toISOString()
    });
    const verdicts = [
      ambiguous("case_1", "reviewer_a"),
      ambiguous("case_1", "reviewer_b"),
      humanBinary("case_2", "reviewer_a", true),
      humanBinary("case_2", "reviewer_b", false),
      humanBinary("case_3", "reviewer_a", false),
      humanBinary("case_3", "reviewer_b", true)
    ];

    const summary = computeKappaSummary(verdicts);
    expect(summary.pairs).toHaveLength(1);
    expect(summary.pairs[0]?.cases).toBe(3);
    expect(summary.pairs[0]?.observedAgreement).toBeCloseTo(1 / 3);
    expect(summary.pairs[0]?.kappa).toBeCloseTo(0);
  });

  it("marks scalar verdicts as unsupported and reports the count separately", () => {
    const scalarVerdict = (caseId: string, actor: string, score: number): VerdictRecord => ({
      id: `verdict_${caseId}_${actor}`,
      projectId: "proj_t",
      caseId,
      skillVersionId: null,
      source: "human",
      actorUserId: actor,
      payload: { kind: "scalar", score, range: [0, 1], rationale: "" },
      externalRunId: null,
      createdAt: new Date().toISOString()
    });

    const verdicts = [
      scalarVerdict("case_1", "reviewer_a", 0.7),
      scalarVerdict("case_1", "reviewer_b", 0.8),
      scalarVerdict("case_2", "reviewer_a", 0.6),
      scalarVerdict("case_2", "reviewer_b", 0.5)
    ];
    const summary = computeKappaSummary(verdicts);
    expect(summary.pairs).toEqual([]);
    expect(summary.unsupportedPairs).toBe(1);
    expect(summary.meanKappa).toBeNull();
  });

  it("ignores LLM-judge verdicts when computing inter-rater agreement", () => {
    const llmJudge: VerdictRecord = {
      id: "verdict_llm",
      projectId: "proj_t",
      caseId: "case_1",
      skillVersionId: "skillv_1",
      source: "llm_judge",
      actorUserId: null,
      payload: { kind: "binary", pass: true, rationale: "" },
      externalRunId: null,
      createdAt: new Date().toISOString()
    };
    const verdicts = [
      llmJudge,
      humanBinary("case_1", "reviewer_a", true),
      humanBinary("case_1", "reviewer_b", false)
    ];
    const summary = computeKappaSummary(verdicts);
    expect(summary.raterCount).toBe(2);
    expect(summary.pairs).toHaveLength(1);
    expect(summary.pairs[0]?.cases).toBe(1);
  });

  it("first-verdict-wins per (case, reviewer) preserves the append-only invariant", () => {
    // If a reviewer somehow has two verdicts on the same case (shouldn't happen
    // via app logic, but the table is append-only at the DB level), only the
    // first counts toward κ.
    const earlier = humanBinary("case_1", "reviewer_a", true);
    earlier.createdAt = "2026-01-01T00:00:00.000Z";
    const later: VerdictRecord = { ...earlier, id: "verdict_later", payload: { kind: "binary", pass: false, rationale: "" }, createdAt: "2026-06-01T00:00:00.000Z" };
    const verdicts = [
      earlier,
      later,
      humanBinary("case_1", "reviewer_b", true),
      humanBinary("case_2", "reviewer_a", false),
      humanBinary("case_2", "reviewer_b", false)
    ];
    const summary = computeKappaSummary(verdicts);
    expect(summary.pairs[0]?.observedAgreement).toBe(1);
    expect(summary.pairs[0]?.kappa).toBe(1);
  });
});

describe("computeJudgeHumanCalibration", () => {
  it("treats the LLM judge as a synthetic reviewer keyed by skill version", () => {
    const verdicts: VerdictRecord[] = [
      llmJudge("case_1", "skillv_1", true),
      humanBinary("case_1", "reviewer_a", true),
      llmJudge("case_2", "skillv_1", false),
      humanBinary("case_2", "reviewer_a", false),
      llmJudge("case_3", "skillv_1", true),
      humanBinary("case_3", "reviewer_a", false) // disagreement
    ];
    const summary = computeJudgeHumanCalibration(verdicts);
    expect(summary.raterCount).toBe(2);
    expect(summary.pairs).toHaveLength(1);
    const pair = summary.pairs[0]!;
    expect(pair.cases).toBe(3);
    // 2/3 agreement → observedAgreement ≈ 0.667
    expect(pair.observedAgreement).toBeCloseTo(2 / 3, 5);
    // One of the reviewer ids carries the judge: prefix.
    const judgeSide = isJudgeActorId(pair.reviewerA) ? pair.reviewerA : pair.reviewerB;
    expect(judgeSide).toBe("judge:skillv_1");
  });

  it("isolates calibration by skill version (two judge versions = two synthetic reviewers)", () => {
    // skillv_1 perfectly agrees with reviewer_a; skillv_2 perfectly disagrees.
    // The judge-human calibration should surface two pairs (judge:1 vs A, judge:2 vs A).
    const verdicts: VerdictRecord[] = [
      llmJudge("case_1", "skillv_1", true),
      llmJudge("case_1", "skillv_2", false),
      humanBinary("case_1", "reviewer_a", true),
      llmJudge("case_2", "skillv_1", false),
      llmJudge("case_2", "skillv_2", true),
      humanBinary("case_2", "reviewer_a", false)
    ];
    const summary = computeJudgeHumanCalibration(verdicts);
    expect(summary.raterCount).toBe(3); // judge:1, judge:2, reviewer_a
    // Exactly the two judge×human pairs. The (judge:1, judge:2) pair is
    // dropped: two versions of the judge agreeing with each other says
    // nothing about agreement with the team, and it would dominate the mean.
    expect(summary.pairs).toHaveLength(2);
    expect(summary.pairs.every((p) => isJudgeActorId(p.reviewerA) !== isJudgeActorId(p.reviewerB))).toBe(true);
    const judge1VsHuman = summary.pairs.find((p) =>
      (p.reviewerA === "judge:skillv_1" && p.reviewerB === "reviewer_a") ||
      (p.reviewerB === "judge:skillv_1" && p.reviewerA === "reviewer_a")
    );
    const judge2VsHuman = summary.pairs.find((p) =>
      (p.reviewerA === "judge:skillv_2" && p.reviewerB === "reviewer_a") ||
      (p.reviewerB === "judge:skillv_2" && p.reviewerA === "reviewer_a")
    );
    expect(judge1VsHuman?.kappa).toBe(1);
    expect(judge2VsHuman?.kappa).toBeLessThan(0);
    // The mean is over judge×human pairs only: (1 + κ₂)/2, NOT pulled up by a
    // judge×judge κ.
    expect(summary.meanKappa).toBeCloseTo((judge1VsHuman!.kappa + judge2VsHuman!.kappa) / 2, 10);
  });

  it("excludes human×human pairs from calibration (they belong to the κ surface)", () => {
    const verdicts: VerdictRecord[] = [
      llmJudge("case_1", "skillv_1", true),
      humanBinary("case_1", "reviewer_a", true),
      humanBinary("case_1", "reviewer_b", false),
      llmJudge("case_2", "skillv_1", false),
      humanBinary("case_2", "reviewer_a", false),
      humanBinary("case_2", "reviewer_b", true)
    ];
    const summary = computeJudgeHumanCalibration(verdicts);
    // judge×a and judge×b — not a×b.
    expect(summary.pairs).toHaveLength(2);
    expect(summary.pairs.every((p) => isJudgeActorId(p.reviewerA) || isJudgeActorId(p.reviewerB))).toBe(true);
  });

  it("keeps overlappingCases consistent with the filtered pairs (no phantom overlap)", () => {
    // Two humans double-code cases the judge never touched: no judge×human
    // pair exists, so the calibration summary must not report overlap or
    // unsupported pairs sourced from the excluded human×human comparison.
    const verdicts: VerdictRecord[] = [
      humanBinary("case_1", "reviewer_a", true),
      humanBinary("case_1", "reviewer_b", false),
      humanBinary("case_2", "reviewer_a", true),
      humanBinary("case_2", "reviewer_b", true),
      llmJudge("case_3", "skillv_1", true)
    ];
    const summary = computeJudgeHumanCalibration(verdicts);
    expect(summary.pairs).toEqual([]);
    expect(summary.meanKappa).toBeNull();
    expect(summary.overlappingCases).toBe(0);
    expect(summary.unsupportedPairs).toBe(0);
  });

  it("returns the empty summary when there are no human verdicts to compare against", () => {
    const verdicts: VerdictRecord[] = [
      llmJudge("case_1", "skillv_1", true),
      llmJudge("case_2", "skillv_1", false)
    ];
    const summary = computeJudgeHumanCalibration(verdicts);
    expect(summary.raterCount).toBe(1); // only the judge
    expect(summary.pairs).toEqual([]);
    expect(summary.meanKappa).toBeNull();
  });

  it("ignores imported_external verdicts (they don't participate in judge calibration)", () => {
    const verdicts: VerdictRecord[] = [
      llmJudge("case_1", "skillv_1", true),
      humanBinary("case_1", "reviewer_a", true),
      {
        id: "verdict_ext",
        projectId: "proj_t",
        caseId: "case_1",
        skillVersionId: null,
        source: "imported_external",
        actorUserId: null,
        payload: { kind: "binary", pass: false, rationale: "" },
        externalRunId: "ext_1",
        createdAt: new Date().toISOString()
      }
    ];
    const summary = computeJudgeHumanCalibration(verdicts);
    expect(summary.raterCount).toBe(2); // judge + reviewer_a; external ignored
  });
});

describe("computeDisagreementSummary", () => {
  it("returns nothing when there are no multi-reviewer cases", () => {
    const summary = computeDisagreementSummary([
      humanBinary("c1", "a", true),
      humanBinary("c2", "a", false)
    ]);
    expect(summary).toEqual({ comparedCases: 0, disagreedCases: 0, resolvedCases: 0, cases: [] });
  });

  it("ignores unanimous multi-reviewer cases", () => {
    const summary = computeDisagreementSummary([
      humanBinary("c1", "a", true),
      humanBinary("c1", "b", true)
    ]);
    expect(summary.comparedCases).toBe(1);
    expect(summary.disagreedCases).toBe(0);
  });

  it("surfaces a split case with severity and per-reviewer labels", () => {
    const summary = computeDisagreementSummary([
      humanBinary("c1", "a", true),
      humanBinary("c1", "b", false)
    ]);
    expect(summary.comparedCases).toBe(1);
    expect(summary.disagreedCases).toBe(1);
    const c = summary.cases[0]!;
    expect(c.caseId).toBe("c1");
    expect(c.reviewerCount).toBe(2);
    expect(c.distinctLabels).toBe(2);
    expect(c.severity).toBe(0.5); // 1 - 1/2
    expect(c.labels).toEqual([
      { actorUserId: "a", label: "pass" },
      { actorUserId: "b", label: "fail" }
    ]);
  });

  it("ranks an even split above a lopsided one", () => {
    // c_even: 1 pass / 1 fail → severity 0.5
    // c_lop: 2 pass / 1 fail → severity 1 - 2/3 ≈ 0.333
    const summary = computeDisagreementSummary([
      humanBinary("c_lop", "a", true),
      humanBinary("c_lop", "b", true),
      humanBinary("c_lop", "c", false),
      humanBinary("c_even", "a", true),
      humanBinary("c_even", "b", false)
    ]);
    expect(summary.disagreedCases).toBe(2);
    expect(summary.cases[0]?.caseId).toBe("c_even");
    expect(summary.cases[0]?.severity).toBe(0.5);
    expect(summary.cases[1]?.caseId).toBe("c_lop");
    expect(summary.cases[1]?.severity).toBeCloseTo(1 / 3, 5);
  });

  it("first-verdict-wins per (case, reviewer)", () => {
    // reviewer a's second verdict on c1 is ignored; a=pass, b=pass → unanimous.
    const summary = computeDisagreementSummary([
      humanBinary("c1", "a", true),
      humanBinary("c1", "a", false),
      humanBinary("c1", "b", true)
    ]);
    expect(summary.disagreedCases).toBe(0);
  });
});

describe("computeJudgeHumanDisagreement", () => {
  it("surfaces a case where the judge and the single reviewer disagree", () => {
    const summary = computeJudgeHumanDisagreement([
      llmJudge("c1", "skillv_1", true),
      humanBinary("c1", "reviewer_a", false)
    ]);
    expect(summary.comparedCases).toBe(1);
    expect(summary.disagreedCases).toBe(1);
    const c = summary.cases[0]!;
    expect(c.caseId).toBe("c1");
    expect(c.judgeLabel).toBe("pass");
    expect(c.disagreeingHumans).toBe(1);
    expect(c.agreeingHumans).toBe(0);
    expect(c.severity).toBe(1);
    expect(c.humanLabels).toEqual([{ actorUserId: "reviewer_a", label: "fail" }]);
  });

  it("ignores a case where the judge and reviewer agree", () => {
    const summary = computeJudgeHumanDisagreement([
      llmJudge("c1", "skillv_1", true),
      humanBinary("c1", "reviewer_a", true)
    ]);
    expect(summary.comparedCases).toBe(1);
    expect(summary.disagreedCases).toBe(0);
  });

  it("does not compare a case with no human verdict", () => {
    const summary = computeJudgeHumanDisagreement([llmJudge("c1", "skillv_1", true)]);
    expect(summary).toEqual({ comparedCases: 0, disagreedCases: 0, resolvedCases: 0, cases: [] });
  });

  it("uses the latest judge verdict per case", () => {
    // Two judge verdicts on c1; the later one (pass) is the judge's label.
    const early = llmJudge("c1", "skillv_1", false);
    early.createdAt = "2026-01-01T00:00:00.000Z";
    const late = llmJudge("c1", "skillv_2", true);
    late.createdAt = "2026-02-01T00:00:00.000Z";
    const summary = computeJudgeHumanDisagreement([early, late, humanBinary("c1", "reviewer_a", true)]);
    // latest judge = pass, human = pass → agree → not surfaced.
    expect(summary.disagreedCases).toBe(0);
  });

  it("ranks a unanimous human-vs-judge contradiction above a split one", () => {
    const summary = computeJudgeHumanDisagreement([
      // c_unanimous: judge pass, both humans fail → severity 1
      llmJudge("c_unanimous", "skillv_1", true),
      humanBinary("c_unanimous", "a", false),
      humanBinary("c_unanimous", "b", false),
      // c_split: judge pass, one human fail one human pass → severity 0.5
      llmJudge("c_split", "skillv_1", true),
      humanBinary("c_split", "a", false),
      humanBinary("c_split", "b", true)
    ]);
    expect(summary.disagreedCases).toBe(2);
    expect(summary.cases[0]?.caseId).toBe("c_unanimous");
    expect(summary.cases[0]?.severity).toBe(1);
    expect(summary.cases[1]?.caseId).toBe("c_split");
    expect(summary.cases[1]?.severity).toBe(0.5);
  });
});

describe("adjudication annotation (A2.2b-2)", () => {
  it("annotates a judge-human disagreement with its adjudicated label", () => {
    const summary = computeJudgeHumanDisagreement([
      llmJudge("c1", "skillv_1", true), // judge says pass…
      humanBinary("c1", "a", false), // …human says fail → disagreement
      adjudicated("c1", false) // resolved: fail (the judge was wrong)
    ]);
    expect(summary.disagreedCases).toBe(1);
    expect(summary.resolvedCases).toBe(1);
    expect(summary.cases[0]?.adjudicatedLabel).toBe("fail");
  });

  it("leaves an open disagreement's adjudicatedLabel null", () => {
    const summary = computeJudgeHumanDisagreement([
      llmJudge("c1", "skillv_1", true),
      humanBinary("c1", "a", false)
    ]);
    expect(summary.resolvedCases).toBe(0);
    expect(summary.cases[0]?.adjudicatedLabel).toBeNull();
  });

  it("annotates a human-human split with its adjudicated label", () => {
    const summary = computeDisagreementSummary([
      humanBinary("c1", "a", true),
      humanBinary("c1", "b", false), // split
      adjudicated("c1", true) // resolved: pass
    ]);
    expect(summary.disagreedCases).toBe(1);
    expect(summary.resolvedCases).toBe(1);
    expect(summary.cases[0]?.adjudicatedLabel).toBe("pass");
  });

  it("takes the latest adjudication when a case is re-adjudicated", () => {
    const early = adjudicated("c1", true);
    early.createdAt = "2026-01-01T00:00:00.000Z";
    const late = adjudicated("c1", false);
    late.createdAt = "2026-02-01T00:00:00.000Z";
    const summary = computeJudgeHumanDisagreement([
      llmJudge("c1", "skillv_1", true),
      humanBinary("c1", "a", false),
      early,
      late
    ]);
    expect(summary.cases[0]?.adjudicatedLabel).toBe("fail");
  });

  it("does NOT count an adjudicated verdict as a rater in κ", () => {
    // One human + one adjudicated verdict on the same case: κ must still see a
    // single rater (adjudication is the resolution, not another opinion).
    const summary = computeKappaSummary([
      humanBinary("c1", "a", true),
      adjudicated("c1", false)
    ]);
    expect(summary.raterCount).toBe(1);
    expect(summary.pairs).toEqual([]);
  });
});

describe("computeConvergenceAudit (A2.2c)", () => {
  it("counts an improvement: the prior judge was wrong, the audited version agrees with the truth", () => {
    const audit = computeConvergenceAudit(
      [
        adjudicated("c1", false), // truth = fail
        llmJudge("c1", "v1", true), // before: pass (wrong)
        llmJudge("c1", "v2", false) // after: fail (right)
      ],
      { beforeVersionId: "v1", afterVersionId: "v2" }
    );
    expect(audit.comparedCases).toBe(1);
    expect(audit.afterAgreed).toBe(1);
    expect(audit.beforeKnown).toBe(1);
    expect(audit.beforeAgreed).toBe(0);
    expect(audit.improved).toBe(1);
    expect(audit.regressed).toBe(0);
    expect(audit.cases[0]).toMatchObject({ change: "improved", beforeLabel: "pass", afterLabel: "fail" });
  });

  it("counts a regression: the prior judge agreed, the audited version no longer does", () => {
    const audit = computeConvergenceAudit(
      [adjudicated("c1", false), llmJudge("c1", "v1", false), llmJudge("c1", "v2", true)],
      { beforeVersionId: "v1", afterVersionId: "v2" }
    );
    expect(audit.regressed).toBe(1);
    expect(audit.afterAgreed).toBe(0);
    expect(audit.beforeAgreed).toBe(1);
    expect(audit.cases[0]?.change).toBe("regressed");
  });

  it("excludes adjudicated cases the audited version never judged", () => {
    const audit = computeConvergenceAudit(
      [adjudicated("c1", false), llmJudge("c1", "v1", false)], // only the prior version judged it
      { beforeVersionId: "v1", afterVersionId: "v2" }
    );
    expect(audit.comparedCases).toBe(0);
  });

  it("ignores cases that were judged but never adjudicated", () => {
    const audit = computeConvergenceAudit([llmJudge("c1", "v2", true)], {
      beforeVersionId: "v1",
      afterVersionId: "v2"
    });
    expect(audit.comparedCases).toBe(0);
  });

  it("with no predecessor, reports only the current agreement (no before/after delta)", () => {
    const audit = computeConvergenceAudit(
      [adjudicated("c1", false), llmJudge("c1", "v2", false)],
      { beforeVersionId: null, afterVersionId: "v2" }
    );
    expect(audit.beforeVersionId).toBeNull();
    expect(audit.comparedCases).toBe(1);
    expect(audit.afterAgreed).toBe(1);
    expect(audit.beforeKnown).toBe(0);
    expect(audit.improved).toBe(0);
    expect(audit.cases[0]).toMatchObject({ change: "still_agree", beforeLabel: null });
  });

  it("pins the after-label to the explicit version, ignoring a later version's verdict", () => {
    const audit = computeConvergenceAudit(
      [
        adjudicated("c1", false),
        llmJudge("c1", "v2", false), // audited version (v2): right
        llmJudge("c1", "v3", true) // a LATER version judged it wrong — must NOT be used
      ],
      { beforeVersionId: "v1", afterVersionId: "v2" }
    );
    expect(audit.afterAgreed).toBe(1);
    expect(audit.cases[0]?.afterLabel).toBe("fail");
  });

  it("preserves categorical choices, binary abstention, and ignores scalar rows", () => {
    const at = "2026-03-01T00:00:00.000Z";
    const verdict = (
      id: string,
      caseId: string,
      source: "adjudicated" | "llm_judge",
      payload: VerdictPayload
    ): VerdictRecord => ({
      id,
      projectId: "proj_t",
      caseId,
      skillVersionId: source === "llm_judge" ? "v2" : null,
      source,
      actorUserId: source === "adjudicated" ? "user_owner" : null,
      payload,
      externalRunId: null,
      createdAt: at
    });
    const audit = computeConvergenceAudit([
      verdict("adj_category", "category", "adjudicated", {
        kind: "categorical",
        choice: "safe",
        choiceScores: { safe: 0.2, unsafe: 0.8 },
        rationale: "Recorded category."
      }),
      verdict("judge_category", "category", "llm_judge", {
        kind: "categorical",
        choice: "safe",
        choiceScores: { safe: 0.2, unsafe: 0.8 },
        rationale: "Same raw category."
      }),
      verdict("adj_ambiguous", "abstention", "adjudicated", {
        kind: "binary",
        label: "ambiguous",
        rationale: "Insufficient evidence."
      }),
      verdict("judge_ambiguous", "abstention", "llm_judge", {
        kind: "binary",
        label: "ambiguous",
        rationale: "Insufficient evidence."
      }),
      verdict("adj_scalar", "scalar-only", "adjudicated", {
        kind: "scalar",
        score: 1,
        range: [0, 1],
        rationale: "Unsupported for a discrete comparison."
      }),
      verdict("judge_scalar", "scalar-only", "llm_judge", {
        kind: "scalar",
        score: 1,
        range: [0, 1],
        rationale: "Unsupported for a discrete comparison."
      })
    ], { beforeVersionId: null, afterVersionId: "v2" });

    expect(audit.comparedCases).toBe(2);
    expect(audit.afterAgreed).toBe(2);
    expect(audit.cases).toEqual([
      expect.objectContaining({ caseId: "abstention", adjudicatedLabel: "ambiguous", afterLabel: "ambiguous" }),
      expect.objectContaining({ caseId: "category", adjudicatedLabel: "safe", afterLabel: "safe" })
    ]);
  });

  it("breaks equal-timestamp latest-row ties by verdict id", () => {
    const at = "2026-03-01T00:00:00.000Z";
    const oldRuling = adjudicated("c1", false);
    const newRuling = adjudicated("c1", true);
    const oldJudge = llmJudge("c1", "v2", false);
    const newJudge = llmJudge("c1", "v2", true);
    Object.assign(oldRuling, { id: "verdict_adj_a", createdAt: at });
    Object.assign(newRuling, { id: "verdict_adj_z", createdAt: at });
    Object.assign(oldJudge, { id: "verdict_judge_a", createdAt: at });
    Object.assign(newJudge, { id: "verdict_judge_z", createdAt: at });

    const audit = computeConvergenceAudit(
      [newJudge, oldRuling, oldJudge, newRuling],
      { beforeVersionId: null, afterVersionId: "v2" }
    );
    expect(audit.cases[0]).toMatchObject({
      adjudicatedLabel: "pass",
      afterLabel: "pass",
      change: "still_agree"
    });
  });

  it("orders regressions before improvements before unchanged", () => {
    const audit = computeConvergenceAudit(
      [
        adjudicated("imp", false), llmJudge("imp", "v1", true), llmJudge("imp", "v2", false),
        adjudicated("reg", false), llmJudge("reg", "v1", false), llmJudge("reg", "v2", true),
        adjudicated("agr", false), llmJudge("agr", "v1", false), llmJudge("agr", "v2", false)
      ],
      { beforeVersionId: "v1", afterVersionId: "v2" }
    );
    expect(audit.cases.map((c) => c.change)).toEqual(["regressed", "improved", "still_agree"]);
  });
});

describe("computeSelfConsistency (A3)", () => {
  it("scores a case the judge agrees with itself on as perfectly consistent", () => {
    const r = computeSelfConsistency(
      [llmJudge("c1", "v1", true), llmJudge("c1", "v1", true), llmJudge("c1", "v1", true)],
      "v1"
    );
    expect(r.comparedCases).toBe(1);
    expect(r.consistentCases).toBe(1);
    expect(r.meanAgreement).toBe(1);
    expect(r.cases[0]).toMatchObject({ caseId: "c1", runs: 3, distinctLabels: 1, agreement: 1, majorityLabel: "pass" });
  });

  it("flags a case the judge flips on (2 pass / 1 fail → 0.67)", () => {
    const r = computeSelfConsistency(
      [llmJudge("c1", "v1", true), llmJudge("c1", "v1", true), llmJudge("c1", "v1", false)],
      "v1"
    );
    expect(r.comparedCases).toBe(1);
    expect(r.consistentCases).toBe(0);
    expect(r.cases[0]?.agreement).toBeCloseTo(2 / 3);
    expect(r.cases[0]?.distinctLabels).toBe(2);
    expect(r.cases[0]?.majorityLabel).toBe("pass");
  });

  it("excludes cases judged only once (consistency is undefined on a single run)", () => {
    const r = computeSelfConsistency([llmJudge("c1", "v1", true)], "v1");
    expect(r.comparedCases).toBe(0);
    expect(r.meanAgreement).toBeNull();
  });

  it("is pinned to the version — another version's runs don't count", () => {
    const r = computeSelfConsistency(
      [llmJudge("c1", "v1", true), llmJudge("c1", "v2", false), llmJudge("c1", "v2", true)],
      "v1"
    );
    expect(r.comparedCases).toBe(0); // only one v1 run on c1
  });

  it("ranks the least-consistent case first", () => {
    const r = computeSelfConsistency(
      [
        llmJudge("solid", "v1", true), llmJudge("solid", "v1", true),
        llmJudge("flaky", "v1", true), llmJudge("flaky", "v1", false)
      ],
      "v1"
    );
    expect(r.cases.map((c) => c.caseId)).toEqual(["flaky", "solid"]);
  });
});

function adjudicated(caseId: string, pass: boolean): VerdictRecord {
  return {
    id: `verdict_adj_${caseId}`,
    projectId: "proj_t",
    caseId,
    skillVersionId: null,
    source: "adjudicated",
    actorUserId: "user_owner",
    payload: { kind: "binary", pass, rationale: "" },
    externalRunId: null,
    createdAt: new Date().toISOString()
  };
}

function llmJudge(caseId: string, skillVersionId: string, pass: boolean): VerdictRecord {
  return {
    id: `verdict_judge_${caseId}_${skillVersionId}`,
    projectId: "proj_t",
    caseId,
    skillVersionId,
    source: "llm_judge",
    actorUserId: null,
    payload: { kind: "binary", pass, rationale: "" },
    externalRunId: null,
    createdAt: new Date().toISOString()
  };
}

function humanBinary(caseId: string, actorUserId: string, pass: boolean): VerdictRecord {
  const payload: VerdictPayload = { kind: "binary", pass, rationale: "" };
  return {
    id: `verdict_${caseId}_${actorUserId}`,
    projectId: "proj_t",
    caseId,
    skillVersionId: null,
    source: "human",
    actorUserId,
    payload,
    externalRunId: null,
    createdAt: new Date().toISOString()
  };
}
