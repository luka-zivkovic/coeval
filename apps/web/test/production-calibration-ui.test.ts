import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ProductionDecisionLedgerRecordSchema,
  buildProductionCalibrationArtifact,
  type ProductionCalibrationArtifact,
  type ProductionCalibrationWilsonRate
} from "@coeval/shared";
import {
  PRODUCTION_CALIBRATION_PROVENANCE_LINE,
  adviceState,
  cheapestBandRows,
  costsFromInputs,
  driftFlags,
  formatModelIdentity,
  formatOutcomeSources,
  formatRate,
  formatRateCompact,
  questionOptionLabel,
  questionOptions,
  recommendationText,
  reliabilityDiagramLayout,
  topConfusionPairs
} from "../src/lib/production-calibration-ui.js";

const records = readFileSync(
  new URL("../../api/test/fixtures/production-decision-ledger.flaky-triage.jsonl", import.meta.url),
  "utf8"
).split("\n").filter((line) => line.trim() !== "").map((line) => ProductionDecisionLedgerRecordSchema.parse(JSON.parse(line)));
const now = new Date("2026-09-21T09:00:00.000Z");

function booleanEntry(artifact: ProductionCalibrationArtifact, question: string) {
  const entry = artifact.questions.find((candidate) => candidate.question === question);
  if (!entry || entry.answerType !== "boolean") throw new Error(`missing boolean ${question}`);
  return entry;
}

describe("production calibration presentation helpers", () => {
  it("renders every rate with its numerator, denominator, and interval, or the explicit undefined form", () => {
    const defined: ProductionCalibrationWilsonRate = {
      state: "defined",
      numerator: 10,
      denominator: 16,
      rate: 0.625,
      interval: { method: "wilson-score/v1", confidenceBasisPoints: 9_500, lower: 0.386, upper: 0.815 }
    };
    const undefinedRate: ProductionCalibrationWilsonRate = {
      state: "undefined", numerator: 0, denominator: 0, undefinedReason: "zero_denominator", interval: null
    };
    expect(formatRate(defined)).toBe("10/16 = 62.5% · 95% [38.6%, 81.5%]");
    expect(formatRateCompact(defined)).toBe("62.5% [38.6%, 81.5%] · 10/16");
    expect(formatRate(undefinedRate)).toBe("undefined · zero denominator · 0/0");
    expect(formatRateCompact(undefinedRate)).toBe("undefined · 0/0");
    expect(PRODUCTION_CALIBRATION_PROVENANCE_LINE).toBe(
      "Outcomes from production sources are development feedback. Independent validation is a separate step."
    );
  });

  it("labels questions with type and counts from the artifact and summary", () => {
    const artifact = buildProductionCalibrationArtifact(records, { now });
    const options = questionOptions(artifact, [
      { question: "is_flaky", answerTypes: ["boolean"], decisions: 16, outcomes: 16 }
    ]);
    expect(options.map((option) => option.question)).toEqual([
      "failure_kind", "is_flaky", "needs_human", "owner_team", "resolution", "safe_to_retry", "severity"
    ]);
    expect(questionOptionLabel(options[1]!)).toBe("is_flaky · boolean · 16 decisions · 16 outcomes");
    expect(questionOptionLabel(options[6]!)).toBe("severity · score · 16 decisions · 0 outcomes");
    expect(formatOutcomeSources(artifact.evidence)).toBe("32 outcomes · 32 human · 0 automatic · 0 delayed");
    expect(formatModelIdentity(artifact.records.models[0]!.model)).toBe("typesafe · jev-1.13.0");
    expect(formatModelIdentity({ provider: "p", observedModel: null, identityStrength: "unreported" })).toBe("p · version unreported");
  });

  it("lays out populated bins at (mean predicted, observed) with interval ranges and count-sized marks", () => {
    const artifact = buildProductionCalibrationArtifact(records, { now });
    const bins = booleanEntry(artifact, "is_flaky").calibration.reliability;
    const layout = reliabilityDiagramLayout(bins);
    expect(layout.points.length + layout.emptyBins).toBe(bins.length);
    expect(layout.points.length).toBeGreaterThan(0);
    for (const point of layout.points) {
      expect(point.x).toBeGreaterThanOrEqual(layout.plot.left);
      expect(point.x).toBeLessThanOrEqual(layout.plot.right);
      expect(point.yUpper).toBeLessThanOrEqual(point.y);
      expect(point.y).toBeLessThanOrEqual(point.yLower);
      expect(point.radius).toBeGreaterThanOrEqual(4);
      expect(point.radius).toBeLessThanOrEqual(12);
      expect(point.label).toBe(`n=${point.count}`);
    }
    const largest = Math.max(...layout.points.map((point) => point.count));
    expect(layout.points.find((point) => point.count === largest)?.radius).toBe(12);
    expect(layout.ticks.map((tick) => tick.label)).toEqual(["0", "0.25", "0.50", "0.75", "1"]);
    expect(reliabilityDiagramLayout([]).points).toEqual([]);
  });

  it("describes advisor states honestly", () => {
    expect(adviceState(null).kind).toBe("not_requested");
    const artifact = buildProductionCalibrationArtifact(records, { now, costs: { falsePositive: 1, falseNegative: 4 } });
    const thin = adviceState(booleanEntry(artifact, "is_flaky").thresholdAdvice);
    expect(thin.kind).toBe("thin");
    expect(thin.text).toContain("fewer than 30");
    expect(thin.kind === "thin" && thin.recommendation).toMatch(/^Threshold 0\.\d\d · expected cost/);
    const none = adviceState(booleanEntry(artifact, "needs_human").thresholdAdvice);
    expect(none.kind).toBe("no_outcomes");
    const band = buildProductionCalibrationArtifact(records, { now, costs: { falsePositive: 1, falseNegative: 4, humanReview: 0.5 } });
    const bandAdvice = booleanEntry(band, "is_flaky").thresholdAdvice!;
    expect(recommendationText(bandAdvice)).toMatch(/automation \d+\/\d+ = /);
    const cheapest = cheapestBandRows(bandAdvice, 5);
    expect(cheapest).toHaveLength(5);
    expect(cheapest[0]).toEqual(bandAdvice.recommendation);
    expect(cheapestBandRows(booleanEntry(artifact, "is_flaky").thresholdAdvice!)).toEqual([]);
  });

  it("orders confusion pairs off the diagonal and parses cost inputs", () => {
    expect(topConfusionPairs([
      { truth: "a", chosen: "a", count: 9 },
      { truth: "a", chosen: "b", count: 2 },
      { truth: "b", chosen: "a", count: 3 }
    ])).toEqual([
      { truth: "b", chosen: "a", count: 3 },
      { truth: "a", chosen: "b", count: 2 }
    ]);
    expect(costsFromInputs({ falsePositive: "1", falseNegative: "4", humanReview: "" })).toEqual({ falsePositive: 1, falseNegative: 4, humanReview: null });
    expect(costsFromInputs({ falsePositive: "1", falseNegative: "4", humanReview: "0.5" })).toEqual({ falsePositive: 1, falseNegative: 4, humanReview: 0.5 });
    expect(costsFromInputs({ falsePositive: "1", falseNegative: "", humanReview: "" })).toBeNull();
    expect(costsFromInputs({ falsePositive: "-1", falseNegative: "4", humanReview: "" })).toBeNull();
    const artifact = buildProductionCalibrationArtifact(records, { now });
    expect(booleanEntry(artifact, "is_flaky").drift.windows.map(driftFlags)).toEqual([[]]);
  });
});
