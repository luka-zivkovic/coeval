import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_CALIBRATION_CONTRACT,
  PRODUCTION_CALIBRATION_THRESHOLD_GRID,
  PRODUCTION_DECISION_RECORD_CONTRACT,
  ProductionCalibrationArtifactSchema,
  ProductionDecisionLedgerRecordSchema,
  adviseProductionThreshold,
  buildProductionCalibrationArtifact,
  joinProductionDecisionRecords,
  productionBooleanCalibration,
  productionCalibrationRate,
  productionCalibrationWilsonInterval,
  productionChoiceCalibration,
  productionDriftByWindow,
  productionScoreCalibration,
  type ProductionDecisionLedgerRecord
} from "@rubrist/shared";

const digest = `sha256:${"b".repeat(64)}`;
const day = 24 * 3600 * 1000;
const t0 = Date.parse("2026-07-01T00:00:00.000Z");
const now = new Date("2026-09-20T12:00:00.000Z");

interface Case {
  p: number;
  y?: boolean | null;
  model?: string | null;
  at?: string;
  /** Extra outcomes for the same question, in input order. */
  more?: Array<{ value: boolean; at: string }>;
}

/** Build a ledger of boolean `q` decisions; `y` undefined means no outcome. */
function ledger(cases: readonly Case[], question = "q"): ProductionDecisionLedgerRecord[] {
  const records: ProductionDecisionLedgerRecord[] = [];
  cases.forEach((entry, index) => {
    const id = `d${index + 1}`;
    const at = entry.at ?? new Date(t0 + index * 60_000).toISOString();
    records.push({
      kind: "decision",
      id,
      at,
      questionSet: { name: "t", version: 1, digest },
      model: entry.model === undefined ? "m1" : entry.model,
      provider: "test",
      stateDigest: digest,
      stateLength: 1,
      answers: { [question]: { type: "boolean", probability: entry.p } },
      latencyMs: null,
      usage: null
    });
    if (entry.y !== undefined && entry.y !== null) {
      records.push({ kind: "outcome", decisionId: id, at, question, value: entry.y, source: "automatic" });
    }
    for (const extra of entry.more ?? []) {
      records.push({ kind: "outcome", decisionId: id, at: extra.at, question, value: extra.value, source: "human" });
    }
  });
  return records;
}

/** k positives out of n at probability p, so the truth is exactly calibrated at the bin level. */
function calibrated(p: number, n: number, k = Math.round(p * n)): Case[] {
  return Array.from({ length: n }, (_, index) => ({ p, y: index < k }));
}

const fixtureLines = readFileSync(new URL("./fixtures/production-decision-ledger.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "");

describe("production decision record contract", () => {
  it("validates a live jevkit ledger line unchanged and round-trips it", () => {
    expect(PRODUCTION_DECISION_RECORD_CONTRACT).toBe("rubrist/production-decision-record/v1");
    expect(fixtureLines).toHaveLength(6);
    const records = fixtureLines.map((line) => ProductionDecisionLedgerRecordSchema.parse(JSON.parse(line)));
    expect(records.map((record) => record.kind)).toEqual(["decision", "decision", "outcome", "outcome", "outcome", "outcome"]);
    for (const [index, record] of records.entries()) {
      expect(JSON.parse(JSON.stringify(record))).toEqual(JSON.parse(fixtureLines[index] ?? ""));
    }
    const decision = records[0];
    if (decision?.kind !== "decision") throw new Error("expected a decision record");
    expect(decision.model).toBe("jev-1.13.0");
    expect(decision.stateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(decision.answers["is_flaky"]).toEqual({ type: "boolean", probability: 0.84 });
    expect(decision.answers["severity"]?.type).toBe("score");
    expect(Object.keys(decision)).not.toContain("state");
  });

  it("rejects unknown fields, bad digests, and probabilities outside [0, 1]", () => {
    const decision = JSON.parse(fixtureLines[0] ?? "") as Record<string, unknown>;
    expect(ProductionDecisionLedgerRecordSchema.safeParse({ ...decision, state: "raw text" }).success).toBe(false);
    expect(ProductionDecisionLedgerRecordSchema.safeParse({ ...decision, stateDigest: "sha256:short" }).success).toBe(false);
    expect(ProductionDecisionLedgerRecordSchema.safeParse({
      ...decision,
      answers: { q: { type: "boolean", probability: 1.5 } }
    }).success).toBe(false);
    expect(ProductionDecisionLedgerRecordSchema.safeParse({
      kind: "outcome", decisionId: "x", at: "2026-09-20T20:41:33.678Z", question: "q", value: true, source: "guess"
    }).success).toBe(false);
  });

  it("joins actions and outcomes; the latest outcome per question wins and conflicts are counted", () => {
    const records = ledger([
      { p: 0.9, y: false, more: [{ value: true, at: "2026-07-02T00:00:00.000Z" }, { value: true, at: "2026-07-03T00:00:00.000Z" }] },
      { p: 0.2 }
    ]);
    records.push({ kind: "action", decisionId: "d1", at: "2026-07-01T00:00:01.000Z", question: "q", threshold: 0.5, action: "auto" });
    records.push({ kind: "outcome", decisionId: "ghost", at: "2026-07-01T00:00:01.000Z", question: "q", value: true, source: "human" });
    const joined = joinProductionDecisionRecords(records);
    expect(joined).toHaveLength(2);
    expect(joined[0]?.actions).toHaveLength(1);
    expect(joined[0]?.outcomes["q"]?.value).toBe(true);
    expect(joined[0]?.outcomeCount).toBe(3);
    expect(joined[0]?.conflictingOutcomes).toBe(1);
    expect(joined[1]?.outcomes).toEqual({});
  });

  it("deduplicates identical decisions regardless of object key order without losing outcomes", () => {
    const records = ledger([{ p: 0.9, y: true }]);
    const decision = records[0];
    if (decision?.kind !== "decision") throw new Error("expected a decision record");
    const duplicate = {
      ...decision,
      questionSet: { digest, version: 1, name: "t" },
      answers: { q: { probability: 0.9, type: "boolean" as const } }
    };
    const artifact = buildProductionCalibrationArtifact([...records, duplicate], { now });
    expect(artifact).toEqual(buildProductionCalibrationArtifact(records, { now }));
    expect(artifact.records.decisions.total).toBe(1);
    expect(artifact.records.outcomes.total).toBe(1);
  });

  it.each([
    { answers: { q: { type: "boolean", probability: 0.1 } } },
    { model: "different-model" },
    { stateDigest: `sha256:${"c".repeat(64)}` },
    { tags: { synthetic: "true" } }
  ])("rejects conflicting decision identity in either input order: %j", (change) => {
    const records = ledger([{ p: 0.9, y: true }]);
    const decision = records[0];
    const conflicting = ProductionDecisionLedgerRecordSchema.parse({ ...decision, ...change });
    for (const input of [[...records, conflicting], [conflicting, ...records]]) {
      expect(() => joinProductionDecisionRecords(input)).toThrow(/conflicting decision.*d1/i);
      expect(() => buildProductionCalibrationArtifact(input, { now })).toThrow(/conflicting decision.*d1/i);
    }
  });
});

describe("Wilson rates", () => {
  it("matches every frozen wilson-score/v1 reference vector bit for bit", () => {
    const script = new URL("../../../contracts/reference/binary-calibration-wilson-v1.py", import.meta.url);
    const vectors = JSON.parse(execFileSync("python3", [script.pathname], { encoding: "utf8" })) as Array<{
      x: number; n: number; lowerBinary64: string; upperBinary64: string;
    }>;
    const bits = (value: number): string => {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(value);
      return bytes.toString("hex");
    };
    for (const { x, n, lowerBinary64, upperBinary64 } of vectors) {
      const interval = productionCalibrationWilsonInterval(x, n);
      expect(interval).not.toBeNull();
      expect(bits(interval!.lower), `lower ${x}/${n}`).toBe(lowerBinary64);
      expect(bits(interval!.upper), `upper ${x}/${n}`).toBe(upperBinary64);
    }
  });

  it("matches known values and stays inside [0, 1] at the edges", () => {
    const interval = productionCalibrationWilsonInterval(42, 45);
    expect(interval?.rate).toBeCloseTo(0.9333, 4);
    expect(interval?.lower).toBeGreaterThan(0.81);
    expect(interval?.lower).toBeLessThan(0.83);
    expect(interval?.upper).toBeGreaterThan(0.97);
    expect(interval?.upper).toBeLessThan(0.985);
    expect(productionCalibrationWilsonInterval(0, 10)).toMatchObject({ rate: 0, lower: 0 });
    expect(productionCalibrationWilsonInterval(0, 10)?.upper).toBeCloseTo(0.278, 2);
    expect(productionCalibrationWilsonInterval(10, 10)?.lower).toBeCloseTo(0.722, 2);
    expect(productionCalibrationWilsonInterval(10, 10)?.upper).toBe(1);
  });

  it("is explicitly undefined on a zero denominator and keeps the denominator next to the rate", () => {
    expect(productionCalibrationWilsonInterval(0, 0)).toBeNull();
    expect(productionCalibrationRate(0, 0)).toEqual({
      state: "undefined", numerator: 0, denominator: 0, undefinedReason: "zero_denominator", interval: null
    });
    expect(productionCalibrationRate(3, 4)).toMatchObject({
      state: "defined",
      numerator: 3,
      denominator: 4,
      rate: 0.75,
      interval: { method: "wilson-score/v1", confidenceBasisPoints: 9_500 }
    });
  });
});

describe("boolean calibration", () => {
  it("gives ECE of 0 and the expected Brier on a perfectly calibrated set", () => {
    const cases = [...calibrated(0.1, 10), ...calibrated(0.3, 10), ...calibrated(0.5, 10), ...calibrated(0.7, 10), ...calibrated(0.9, 10)];
    const calibration = productionBooleanCalibration(joinProductionDecisionRecords(ledger(cases)), "q");
    expect(calibration.n).toBe(50);
    expect(calibration.nWithOutcome).toBe(50);
    expect(calibration.ece).toBeCloseTo(0, 10);
    // Brier of a calibrated forecaster is the mean of p(1-p): (0.09+0.21+0.25+0.21+0.09)/5 = 0.17
    expect(calibration.brier).toBeCloseTo(0.17, 10);
    expect(calibration.reliability).toHaveLength(10);
    expect(calibration.reliability[1]).toMatchObject({ index: 1, lower: 0.1, upper: 0.2, count: 10 });
    expect(calibration.reliability[1]?.meanPredicted).toBeCloseTo(0.1, 10);
    expect(calibration.reliability[1]?.observedRate).toMatchObject({ state: "defined", numerator: 1, denominator: 10 });
    expect(calibration.reliability[0]?.count).toBe(0);
    expect(calibration.reliability[0]?.observedRate.state).toBe("undefined");
  });

  it("gives a high Brier and ECE on an inverted set", () => {
    const cases = [...calibrated(0.9, 10, 1), ...calibrated(0.1, 10, 9)];
    const calibration = productionBooleanCalibration(joinProductionDecisionRecords(ledger(cases)), "q");
    expect(calibration.brier).toBeCloseTo(0.9 * 0.81 + 0.1 * 0.01, 10);
    expect(calibration.ece).toBeCloseTo(0.8, 10);
  });

  it("counts the confusion matrix at the threshold with Wilson rates and spelled-out error directions", () => {
    const cases: Case[] = [
      { p: 0.9, y: true }, { p: 0.8, y: true }, { p: 0.7, y: false },
      { p: 0.4, y: true }, { p: 0.2, y: false }, { p: 0.1, y: false },
      { p: 0.5, y: null }, { p: 0.6 }
    ];
    const calibration = productionBooleanCalibration(joinProductionDecisionRecords(ledger(cases)), "q", { threshold: 0.6 });
    expect(calibration.n).toBe(8);
    expect(calibration.nWithOutcome).toBe(6);
    expect(calibration.confusion).toMatchObject({ threshold: 0.6, truePositive: 2, falsePositive: 1, trueNegative: 2, falseNegative: 1 });
    expect(calibration.confusion.accuracy).toMatchObject({ numerator: 4, denominator: 6 });
    expect(calibration.confusion.precision).toMatchObject({ numerator: 2, denominator: 3 });
    expect(calibration.confusion.recall).toMatchObject({ numerator: 2, denominator: 3 });
    expect(calibration.confusion.specificity).toMatchObject({ numerator: 2, denominator: 3 });
    expect(calibration.errorDirections.falsePositive).toEqual({
      definition: "predicted true at p >= 0.6 when the outcome was false", count: 1
    });
    expect(calibration.errorDirections.falseNegative).toEqual({
      definition: "predicted false at p < 0.6 when the outcome was true", count: 1
    });
  });

  it("never emits NaN: precision is undefined when nothing is predicted positive", () => {
    const calibration = productionBooleanCalibration(
      joinProductionDecisionRecords(ledger([{ p: 0.1, y: false }, { p: 0.2, y: false }])), "q", { threshold: 0.9 }
    );
    expect(calibration.confusion.precision.state).toBe("undefined");
    expect(calibration.confusion.recall.state).toBe("undefined");
    expect(JSON.stringify(calibration)).not.toContain("NaN");
    const empty = productionBooleanCalibration([], "q");
    expect(empty.brier).toBeNull();
    expect(empty.ece).toBeNull();
    expect(JSON.stringify(empty)).not.toContain("NaN");
  });

  it("flips the orientation for positiveClass false and groups by observed model and digest", () => {
    const cases: Case[] = [{ p: 0.9, y: true, model: "b" }, { p: 0.1, y: false, model: "a" }, { p: 0.3, y: false, model: null }];
    const calibration = productionBooleanCalibration(joinProductionDecisionRecords(ledger(cases)), "q", { positiveClass: false });
    // p(false) = 0.9 for the second decision and its truth is false, so it is a true positive.
    expect(calibration.confusion.truePositive).toBe(2);
    expect(calibration.confusion.trueNegative).toBe(1);
    expect(calibration.byModel.map((group) => group.model)).toEqual([
      { provider: "test", observedModel: null, identityStrength: "unreported" },
      { provider: "test", observedModel: "a", identityStrength: "observed_version" },
      { provider: "test", observedModel: "b", identityStrength: "observed_version" }
    ]);
    expect(calibration.byModel[1]).toMatchObject({ n: 1, nWithOutcome: 1 });
    expect(calibration.byDigest).toHaveLength(1);
    expect(calibration.byDigest[0]).toMatchObject({ questionSetDigest: digest, n: 3, nWithOutcome: 3 });
  });
});

describe("choice and score calibration", () => {
  it("measures top-1 accuracy, confidence reliability and per-option confusion", () => {
    const records: ProductionDecisionLedgerRecord[] = [];
    const rows: Array<[string, string, number]> = [
      ["timing", "timing", 0.9], ["timing", "test_bug", 0.55], ["test_bug", "test_bug", 0.95], ["test_bug", "test_bug", 0.6]
    ];
    rows.forEach(([truth, choice, confidence], index) => {
      const id = `c${index}`;
      const at = new Date(t0 + index * 1000).toISOString();
      records.push({
        kind: "decision", id, at, questionSet: { name: "t", version: 1, digest }, model: "m", provider: "test",
        stateDigest: digest, stateLength: 1, latencyMs: null, usage: null,
        answers: { kind: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } }
      });
      records.push({ kind: "outcome", decisionId: id, at, question: "kind", value: truth, source: "human" });
    });
    const calibration = productionChoiceCalibration(joinProductionDecisionRecords(records), "kind");
    expect(calibration.n).toBe(4);
    expect(calibration.accuracy).toMatchObject({ numerator: 3, denominator: 4 });
    expect(calibration.confusion).toEqual([
      { truth: "test_bug", chosen: "test_bug", count: 2 },
      { truth: "timing", chosen: "test_bug", count: 1 },
      { truth: "timing", chosen: "timing", count: 1 }
    ]);
    expect(calibration.reliability[9]).toMatchObject({ count: 2 });
    expect(calibration.reliability[9]?.observedRate).toMatchObject({ numerator: 2, denominator: 2 });
    expect(calibration.reliability[5]).toMatchObject({ count: 1 });
    expect(calibration.reliability[5]?.observedRate).toMatchObject({ numerator: 0, denominator: 1 });
    expect(calibration.byModel[0]?.accuracy).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it("says plainly that score calibration is not implemented", () => {
    const records: ProductionDecisionLedgerRecord[] = [{
      kind: "decision", id: "s1", at: "2026-07-01T00:00:00.000Z", questionSet: { name: "t", version: 1, digest }, model: "m",
      provider: "test", stateDigest: digest, stateLength: 1, latencyMs: null, usage: null,
      answers: { sev: { type: "score", mean: 1, probabilities: [0.5, 0.5] } }
    }, { kind: "outcome", decisionId: "s1", at: "2026-07-01T00:00:00.000Z", question: "sev", value: 1, source: "human" }];
    expect(productionScoreCalibration(joinProductionDecisionRecords(records), "sev")).toEqual({
      question: "sev", implemented: false, reason: "ordinal_calibration_not_implemented", n: 1, nWithOutcome: 1
    });
  });
});

describe("threshold advisor", () => {
  // Calibrated-ish traffic: positives cluster high, negatives low, with overlap in the middle.
  const traffic: Case[] = [
    ...calibrated(0.95, 20), ...calibrated(0.8, 20), ...calibrated(0.65, 20), ...calibrated(0.5, 20),
    ...calibrated(0.35, 20), ...calibrated(0.2, 20), ...calibrated(0.05, 20)
  ];
  const joined = joinProductionDecisionRecords(ledger(traffic));

  it("picks a high threshold when false positives are expensive and a low one when misses are", () => {
    const fpHeavy = adviseProductionThreshold(joined, "q", { falsePositive: 50, falseNegative: 2 });
    const fnHeavy = adviseProductionThreshold(joined, "q", { falsePositive: 2, falseNegative: 50 });
    if (fpHeavy.mode !== "single" || fnHeavy.mode !== "single") throw new Error("expected single-threshold advice");
    expect(fpHeavy.recommendation?.threshold).toBeGreaterThanOrEqual(0.8);
    expect(fnHeavy.recommendation?.threshold).toBeLessThanOrEqual(0.2);
    expect(fpHeavy.sweep).toHaveLength(19);
    expect(fpHeavy.sweep.map((row) => row.threshold)).toEqual([...PRODUCTION_CALIBRATION_THRESHOLD_GRID]);
    expect(fpHeavy.n).toBe(140);
    expect(fpHeavy.caveat).toBeNull();
    expect(fpHeavy.costs).toEqual({ falsePositive: 50, falseNegative: 2, humanReview: null });
    const min = Math.min(...fpHeavy.sweep.map((row) => row.expectedCostPerDecision));
    expect(fpHeavy.recommendation?.expectedCostPerDecision).toBe(min);
    expect(fpHeavy.recommendation?.errorRateAmongAutomated).toMatchObject({ state: "defined", denominator: 140 });
  });

  it("recommends a review band when a review cost is given, keeping the confident ends automated", () => {
    const band = adviseProductionThreshold(joined, "q", { falsePositive: 50, falseNegative: 50, humanReview: 1 });
    if (band.mode !== "band" || !band.recommendation) throw new Error("expected a band recommendation");
    expect(band.sweep).toHaveLength(190);
    const { low, high, automationRate, humanReviews, automated } = band.recommendation;
    expect(low).toBeLessThan(high);
    expect(low).toBeLessThanOrEqual(0.35);
    expect(high).toBeGreaterThanOrEqual(0.65);
    expect(humanReviews).toBeGreaterThan(0);
    expect(automated + humanReviews).toBe(140);
    expect(automationRate).toBeGreaterThan(0);
    expect(automationRate).toBeLessThan(1);
    expect(band.recommendation.errorRateAmongAutomated).toMatchObject({ state: "defined", denominator: automated });
    // Humans are cheap here, so reviewing the middle beats any single threshold.
    const single = adviseProductionThreshold(joined, "q", { falsePositive: 50, falseNegative: 50 });
    expect(band.recommendation.expectedCostPerDecision).toBeLessThan(single.recommendation?.expectedCostPerDecision ?? Infinity);
  });

  it("collapses to no review band when human review is prohibitively expensive", () => {
    const band = adviseProductionThreshold(joined, "q", { falsePositive: 5, falseNegative: 5, humanReview: 1000 });
    if (band.mode !== "band" || !band.recommendation) throw new Error("expected a band recommendation");
    expect(band.recommendation.humanReviews).toBe(0);
    expect(band.recommendation.automationRate).toBe(1);
  });

  it("caveats small samples and returns no recommendation without outcomes", () => {
    const few = adviseProductionThreshold(
      joinProductionDecisionRecords(ledger(calibrated(0.7, 10))), "q", { falsePositive: 1, falseNegative: 1 }
    );
    expect(few.caveat).toBe("fewer_than_30_outcomes");
    const none = adviseProductionThreshold(
      joinProductionDecisionRecords(ledger([{ p: 0.5 }])), "q", { falsePositive: 1, falseNegative: 1, humanReview: 1 }
    );
    expect(none.recommendation).toBeNull();
    expect(none.caveat).toBe("no_outcomes");
    expect(JSON.stringify(none)).not.toContain("NaN");
  });

  it("rejects negative or non-finite costs", () => {
    expect(() => adviseProductionThreshold(joined, "q", { falsePositive: -1, falseNegative: 1 })).toThrow(RangeError);
    expect(() => adviseProductionThreshold(joined, "q", { falsePositive: 1, falseNegative: Number.NaN })).toThrow(RangeError);
  });
});

describe("drift by window", () => {
  it.each([{ p: 0, y: false, n: 22 }, { p: 1, y: true, n: 21 }])(
    "does not flag perfectly correct endpoint predictions: %j", ({ p, y, n }) => {
      const cases = Array.from({ length: n }, () => ({ p, y }));
      const drift = productionDriftByWindow(joinProductionDecisionRecords(ledger(cases)), "q");
      expect(drift.windows[0]?.driftFlag).toBe(false);
      expect(drift.windows[0]?.observedRate).toMatchObject({
        interval: p === 0 ? { lower: 0 } : { upper: 1 }
      });
    }
  );

  it("flags a window whose outcomes diverge from the predictions and marks a model change", () => {
    const cases: Case[] = [];
    // Week 1: calibrated, model m1. Week 2: calibrated, m1. Week 3: predicted 0.7 but observed 0.2, model m2.
    for (let i = 0; i < 30; i++) cases.push({ p: 0.7, y: i < 21, model: "m1", at: new Date(t0 + i * 3600_000).toISOString() });
    for (let i = 0; i < 30; i++) cases.push({ p: 0.7, y: i < 21, model: "m1", at: new Date(t0 + 7 * day + i * 3600_000).toISOString() });
    for (let i = 0; i < 30; i++) cases.push({ p: 0.7, y: i < 6, model: "m2", at: new Date(t0 + 14 * day + i * 3600_000).toISOString() });
    const drift = productionDriftByWindow(joinProductionDecisionRecords(ledger(cases)), "q", { windowDays: 7 });
    expect(drift.windows.map((window) => window.index)).toEqual([0, 1, 2]);
    expect(drift.windows[0]).toMatchObject({ n: 30, nWithOutcome: 30, driftFlag: false, modelChanged: false });
    expect(drift.windows[0]?.models).toEqual([{ provider: "test", observedModel: "m1", identityStrength: "observed_version" }]);
    expect(drift.windows[0]?.meanPredicted).toBeCloseTo(0.7);
    expect(drift.windows[0]?.observedRate).toMatchObject({ numerator: 21, denominator: 30 });
    expect(drift.windows[1]).toMatchObject({ driftFlag: false, modelChanged: false });
    expect(drift.windows[2]).toMatchObject({ driftFlag: true, modelChanged: true });
    expect(drift.windows[2]?.models[0]?.observedModel).toBe("m2");
    expect(drift.windows[2]?.start).toBe("2026-07-15T00:00:00.000Z");
    expect(drift.windows[2]?.end).toBe("2026-07-22T00:00:00.000Z");
  });

  it("does not flag divergence on fewer than the minimum outcomes", () => {
    const cases: Case[] = Array.from({ length: 10 }, (_, i) => ({ p: 0.9, y: false, at: new Date(t0 + i * 1000).toISOString() }));
    const drift = productionDriftByWindow(joinProductionDecisionRecords(ledger(cases)), "q");
    expect(drift.windows[0]?.driftFlag).toBe(false);
    expect(drift.windows[0]?.nWithOutcome).toBe(10);
    expect(productionDriftByWindow([], "q").windows).toEqual([]);
  });
});

describe("production calibration artifact", () => {
  it("builds a schema-valid report for 150,000 decisions without an argument-limit crash", () => {
    const records = ledger(Array.from({ length: 150_000 }, () => ({ p: 0.5 })));
    // Put the earliest decision last to verify that the minimum is not input-order dependent.
    records.reverse();
    const artifact = buildProductionCalibrationArtifact(records, { now });
    expect(ProductionCalibrationArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(artifact.records.decisions.total).toBe(150_000);
    const question = artifact.questions[0];
    if (question?.answerType !== "boolean") throw new Error("expected boolean calibration");
    expect(question.drift.windows[0]?.start).toBe("2026-07-01T00:00:00.000Z");
    expect(question.drift.windows.reduce((sum, window) => sum + window.n, 0)).toBe(150_000);
  });

  it.each([-0.1, 1.5, Number.NaN, Infinity, -Infinity])(
    "rejects invalid per-question and standalone thresholds: %s", (threshold) => {
      const records = ledger([{ p: 0.9, y: true }]);
      expect(() => buildProductionCalibrationArtifact(records, {
        now, questions: { q: { threshold } }
      })).toThrow();
      expect(() => productionBooleanCalibration(joinProductionDecisionRecords(records), "q", { threshold })).toThrow();
    }
  );

  it.each([0, 0.8, 1])("accepts a valid per-question threshold override: %s", (threshold) => {
    const artifact = buildProductionCalibrationArtifact(ledger([{ p: 0.9, y: true }]), {
      now, questions: { q: { threshold } }
    });
    expect(ProductionCalibrationArtifactSchema.safeParse(artifact).success).toBe(true);
    const question = artifact.questions[0];
    if (question?.answerType !== "boolean") throw new Error("expected boolean calibration");
    expect(question.calibration.confusion.threshold).toBe(threshold);
  });

  it("builds a schema-valid artifact from live ledger lines without reading the clock", () => {
    const records = fixtureLines.map((line) => ProductionDecisionLedgerRecordSchema.parse(JSON.parse(line)));
    const artifact = buildProductionCalibrationArtifact(records, {
      now,
      threshold: 0.85,
      costs: { falsePositive: 50, falseNegative: 2 },
      questions: { is_flaky: { costs: { falsePositive: 50, falseNegative: 2, humanReview: 0.5 } } }
    });
    expect(ProductionCalibrationArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.contract).toBe(PRODUCTION_CALIBRATION_CONTRACT);
    expect(artifact.generatedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(artifact.evidence).toEqual({
      kind: "production_outcomes",
      sealed: false,
      independentHumanValidation: false,
      outcomeSources: { human: 4, automatic: 0, delayed: 0 }
    });
    expect(artifact.records).toMatchObject({
      contract: PRODUCTION_DECISION_RECORD_CONTRACT,
      decisions: { total: 2, synthetic: 0, firstAt: "2026-09-20T20:41:31.392Z", lastAt: "2026-09-20T20:41:31.544Z" },
      actions: { total: 0, orphan: 0 },
      outcomes: { total: 4, orphan: 0, superseded: 0, conflicting: 0 },
      questionSets: [{ name: "flaky-triage", version: 3, decisions: 2 }],
      models: [{ model: { provider: "typesafe", observedModel: "jev-1.13.0", identityStrength: "observed_version" }, decisions: 2 }]
    });
    expect(artifact.parameters).toEqual({ bins: 10, threshold: 0.85, positiveClass: true, windowDays: 7, minOutcomesToFlag: 20 });
    expect(artifact.questions.map((question) => `${question.question}:${question.answerType}`)).toEqual([
      "failure_kind:choice", "is_flaky:boolean", "needs_human:boolean", "owner_team:choice",
      "resolution:choice", "safe_to_retry:boolean", "severity:score"
    ]);

    const isFlaky = artifact.questions.find((question) => question.question === "is_flaky");
    if (isFlaky?.answerType !== "boolean") throw new Error("expected boolean calibration for is_flaky");
    expect(isFlaky.calibration.confusion).toMatchObject({ threshold: 0.85, truePositive: 1, falseNegative: 1 });
    expect(isFlaky.calibration.errorDirections.falseNegative.definition).toBe(
      "predicted false at p < 0.85 when the outcome was true"
    );
    expect(isFlaky.thresholdAdvice?.mode).toBe("band");
    expect(isFlaky.thresholdAdvice?.caveat).toBe("fewer_than_30_outcomes");
    expect(isFlaky.drift.windows).toHaveLength(1);

    const needsHuman = artifact.questions.find((question) => question.question === "needs_human");
    if (needsHuman?.answerType !== "boolean") throw new Error("expected boolean calibration for needs_human");
    expect(needsHuman.calibration.nWithOutcome).toBe(0);
    expect(needsHuman.thresholdAdvice).toMatchObject({ mode: "single", recommendation: null, caveat: "no_outcomes" });

    const failureKind = artifact.questions.find((question) => question.question === "failure_kind");
    if (failureKind?.answerType !== "choice") throw new Error("expected choice calibration for failure_kind");
    expect(failureKind.calibration.accuracy).toMatchObject({ numerator: 2, denominator: 2 });
    expect(failureKind.calibration.confusion).toEqual([
      { truth: "external_dependency", chosen: "external_dependency", count: 1 },
      { truth: "timing", chosen: "timing", count: 1 }
    ]);

    const severity = artifact.questions.find((question) => question.question === "severity");
    expect(severity).toEqual({
      question: "severity",
      answerType: "score",
      calibration: { question: "severity", implemented: false, reason: "ordinal_calibration_not_implemented", n: 2, nWithOutcome: 0 }
    });
    expect(JSON.stringify(artifact)).not.toContain("NaN");
  });

  it("counts orphan, superseded, conflicting and synthetic records and leaves advice null without costs", () => {
    const records = ledger([
      { p: 0.9, y: false, more: [{ value: true, at: "2026-07-02T00:00:00.000Z" }] },
      { p: 0.2, y: false, more: [{ value: false, at: "2026-07-02T00:00:00.000Z" }] }
    ]);
    const first = records[0];
    if (first?.kind !== "decision") throw new Error("expected a decision record");
    first.tags = { synthetic: "true" };
    records.push({ kind: "action", decisionId: "ghost", at: "2026-07-01T00:00:01.000Z", question: "q", threshold: null, action: "auto" });
    records.push({ kind: "outcome", decisionId: "ghost", at: "2026-07-01T00:00:01.000Z", question: "q", value: true, source: "delayed" });
    const artifact = buildProductionCalibrationArtifact(records, { now });
    expect(ProductionCalibrationArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(artifact.records.decisions).toMatchObject({ total: 2, synthetic: 1 });
    expect(artifact.records.actions).toEqual({ total: 1, orphan: 1 });
    expect(artifact.records.outcomes).toEqual({ total: 5, orphan: 1, superseded: 2, conflicting: 1 });
    expect(artifact.evidence.outcomeSources).toEqual({ human: 2, automatic: 2, delayed: 1 });
    const question = artifact.questions[0];
    if (question?.answerType !== "boolean") throw new Error("expected boolean calibration");
    expect(question.thresholdAdvice).toBeNull();
  });

  it("rejects out-of-range parameters instead of producing a malformed artifact", () => {
    expect(() => buildProductionCalibrationArtifact([], { now, bins: 0 })).toThrow();
    expect(() => buildProductionCalibrationArtifact([], { now, threshold: 1.5 })).toThrow();
    expect(() => productionBooleanCalibration([], "q", { bins: 101 })).toThrow(RangeError);
    const empty = buildProductionCalibrationArtifact([], { now });
    expect(ProductionCalibrationArtifactSchema.safeParse(empty).success).toBe(true);
    expect(empty.questions).toEqual([]);
    expect(empty.records.decisions).toEqual({ total: 0, synthetic: 0, firstAt: null, lastAt: null });
  });
});
