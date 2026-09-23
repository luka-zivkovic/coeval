import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProductionDecisionLedgerRecordSchema,
  buildProductionCalibrationArtifact,
  type ProductionCalibrationArtifact
} from "@rubrist/shared";
import { BooleanReading } from "../src/components/production-calibration/boolean-reading.js";
import { ChoiceReading, ScoreNotice } from "../src/components/production-calibration/choice-reading.js";
import { ReliabilityDiagram } from "../src/components/production-calibration/reliability-diagram.js";
import { formatRate, formatRateCompact } from "../src/lib/production-calibration-ui.js";

function ledger(name: string) {
  return readFileSync(
    new URL(`../../api/test/fixtures/production-decision-ledger.${name}.jsonl`, import.meta.url),
    "utf8"
  ).split("\n").filter((line) => line.trim() !== "").map((line) => ProductionDecisionLedgerRecordSchema.parse(JSON.parse(line)));
}

const now = new Date("2026-09-21T09:00:00.000Z");
const flakyTriage = ledger("flaky-triage");
const trialRunner = ledger("trial-runner");
const costs = { falsePositive: "", falseNegative: "", humanReview: "" };

function question<T extends ProductionCalibrationArtifact["questions"][number]["answerType"]>(
  artifact: ProductionCalibrationArtifact,
  name: string,
  answerType: T
): Extract<ProductionCalibrationArtifact["questions"][number], { answerType: T }> {
  const entry = artifact.questions.find((candidate) => candidate.question === name && candidate.answerType === answerType);
  if (!entry) throw new Error(`missing ${answerType} question ${name}`);
  return entry as Extract<ProductionCalibrationArtifact["questions"][number], { answerType: T }>;
}

describe("production calibration reading components", () => {
  it("draws the reliability diagram as inline SVG with live labels, intervals, and count-sized marks", () => {
    const artifact = buildProductionCalibrationArtifact(flakyTriage, { now });
    const entry = question(artifact, "is_flaky", "boolean");
    const html = renderToStaticMarkup(createElement(ReliabilityDiagram, { bins: entry.calibration.reliability }));
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain("Mean predicted probability");
    expect(html).toContain("Observed rate");
    expect(html).toContain(">calibrated<");
    expect(html).toContain('stroke-dasharray="4 4"');
    const populated = entry.calibration.reliability.filter((bin) => bin.count > 0);
    expect(populated.length).toBeGreaterThan(0);
    for (const bin of populated) expect(html).toContain(`>n=${bin.count}<`);
    expect(html.match(/<circle /g)).toHaveLength(populated.length);
    expect(html).toContain('fill="var(--ink)"');
    expect(html).toContain('stroke="var(--ink-3)"');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
    expect(html).toContain("95% Wilson interval");
  });

  it("renders the boolean reading with denominators, intervals, threshold state, advisor state, and drift flags", () => {
    const artifact = buildProductionCalibrationArtifact(flakyTriage, { now, threshold: 0.85, costs: { falsePositive: 1, falseNegative: 4 } });
    const entry = question(artifact, "is_flaky", "boolean");
    const html = renderToStaticMarkup(createElement(BooleanReading, {
      entry,
      threshold: 0.85,
      onThresholdChange: () => undefined,
      costs: { falsePositive: "1", falseNegative: "4", humanReview: "" },
      onCostsChange: () => undefined,
      pending: false
    }));
    const confusion = entry.calibration.confusion;
    expect(html).toContain("showing confusion at 0.85");
    expect(html).toContain('type="range"');
    expect(html).toContain(formatRate(confusion.accuracy));
    expect(html).toContain(formatRate(confusion.precision));
    expect(html).toContain(formatRate(confusion.recall));
    expect(html).toContain(formatRate(confusion.specificity));
    expect(html).toContain(`${confusion.truePositive} <span class="text-ink-4">TP</span>`);
    expect(html).toContain(entry.calibration.errorDirections.falsePositive.definition.replaceAll(">", "&gt;"));
    expect(html).toContain(entry.calibration.errorDirections.falseNegative.definition.replaceAll("<", "&lt;"));
    for (const bin of entry.calibration.reliability) expect(html).toContain(formatRateCompact(bin.observedRate));
    expect(html).toContain('data-advice-state="thin"');
    expect(html).toContain("fewer than 30 outcomes · indicative only");
    expect(html).toContain("Threshold 0.");
    expect(html).toContain("· recommended");
    expect(html).toContain("Drift by 7-day window");
    expect(html).toContain("2026-09-20 to 2026-09-27");
    expect(html).toContain(">none<");
    expect(html).toContain("typesafe · jev-1.13.0");
    expect(html).toContain(artifact.records.questionSets[0]!.digest);
    expect(html).toContain("It recommends; it does not decide");
  });

  it("shows the pending state and the no-cost and no-outcome advisor states", () => {
    const artifact = buildProductionCalibrationArtifact(flakyTriage, { now, costs: { falsePositive: 1, falseNegative: 1 } });
    const noCosts = renderToStaticMarkup(createElement(BooleanReading, {
      entry: { ...question(artifact, "is_flaky", "boolean"), thresholdAdvice: null },
      threshold: 0.6,
      onThresholdChange: () => undefined,
      costs,
      onCostsChange: () => undefined,
      pending: true
    }));
    expect(noCosts).toContain("recomputing at 0.60…");
    expect(noCosts).toContain('data-advice-state="not_requested"');
    const noOutcomes = renderToStaticMarkup(createElement(BooleanReading, {
      entry: question(artifact, "needs_human", "boolean"),
      threshold: 0.5,
      onThresholdChange: () => undefined,
      costs,
      onCostsChange: () => undefined,
      pending: false
    }));
    expect(noOutcomes).toContain('data-advice-state="no_outcomes"');
    expect(noOutcomes).toContain("No recommendation");
    expect(noOutcomes).toContain("undefined · zero denominator · 0/0");
  });

  it("renders the choice reading with top-1 accuracy, confidence reliability, and confusion pairs", () => {
    const artifact = buildProductionCalibrationArtifact(trialRunner, { now });
    const entry = question(artifact, "verdict", "choice");
    const html = renderToStaticMarkup(createElement(ChoiceReading, { entry }));
    expect(html).toContain("Top-1 accuracy");
    expect(html).toContain(formatRate(entry.calibration.accuracy));
    expect(html).toContain("Confidence reliability diagram");
    expect(html).toContain("Top confusion pairs");
    const offDiagonal = entry.calibration.confusion.filter((cell) => cell.truth !== cell.chosen);
    if (offDiagonal.length === 0) {
      expect(html).toContain("Every chosen option matched its outcome.");
    } else {
      expect(html).toContain(`<td class="font-mono text-[11px]">${offDiagonal[0]!.truth}</td>`);
    }
    for (const group of entry.calibration.byModel) expect(html).toContain(formatRateCompact(group.accuracy));
  });

  it("renders the score notice from the artifact's not-implemented reason", () => {
    const artifact = buildProductionCalibrationArtifact(flakyTriage, { now });
    const html = renderToStaticMarkup(createElement(ScoreNotice, { entry: question(artifact, "severity", "score") }));
    expect(html).toContain("not implemented · ordinal calibration not implemented");
    expect(html).toContain("16 decisions and 0 outcomes");
  });
});
