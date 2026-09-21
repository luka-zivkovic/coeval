import type {
  ProductionCalibrationArtifact,
  ProductionCalibrationDriftWindow,
  ProductionCalibrationModelIdentity,
  ProductionCalibrationReliabilityBin,
  ProductionCalibrationThresholdAdvice,
  ProductionCalibrationWilsonRate
} from "@coeval/shared";

// Pure presentation helpers for the production calibration view. Nothing here
// touches React or the network, so the text every rate is rendered with can be
// tested exactly. Rates keep the shared module's shape: numerator over
// denominator, the point estimate, and its 95% Wilson interval; a zero
// denominator is spelled out instead of shown as a number.

export const PRODUCTION_CALIBRATION_PROVENANCE_LINE =
  "Outcomes from production sources are development feedback. Independent validation is a separate step.";

export const PRODUCTION_CALIBRATION_GOVERNED_REVIEW_NOTE =
  "An independently reviewed sample, routed through governed review, is a separate future step; this reading does not stand in for it.";

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatProbability(value: number | null, digits = 3): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/** `k/n = 62.5% · 95% [38.6%, 81.5%]`, or the explicit undefined form. */
export function formatRate(rate: ProductionCalibrationWilsonRate): string {
  if (rate.state === "undefined") return `undefined · ${rate.undefinedReason.replaceAll("_", " ")} · 0/0`;
  return `${rate.numerator}/${rate.denominator} = ${formatPercent(rate.rate)} · 95% [${formatPercent(rate.interval.lower)}, ${formatPercent(rate.interval.upper)}]`;
}

/** The short form for table cells: `62.5% [38.6%, 81.5%] · 10/16`. */
export function formatRateCompact(rate: ProductionCalibrationWilsonRate): string {
  if (rate.state === "undefined") return "undefined · 0/0";
  return `${formatPercent(rate.rate)} [${formatPercent(rate.interval.lower)}, ${formatPercent(rate.interval.upper)}] · ${rate.numerator}/${rate.denominator}`;
}

export function formatModelIdentity(model: ProductionCalibrationModelIdentity): string {
  return model.identityStrength === "unreported"
    ? `${model.provider} · version unreported`
    : `${model.provider} · ${model.observedModel}`;
}

export function formatOutcomeSources(evidence: ProductionCalibrationArtifact["evidence"]): string {
  const { human, automatic, delayed } = evidence.outcomeSources;
  return `${human + automatic + delayed} outcomes · ${human} human · ${automatic} automatic · ${delayed} delayed`;
}

export function formatWindow(window: ProductionCalibrationDriftWindow): string {
  return `${window.start.slice(0, 10)} to ${window.end.slice(0, 10)}`;
}

export function driftFlags(window: ProductionCalibrationDriftWindow): string[] {
  const flags: string[] = [];
  if (window.modelChanged) flags.push("model changed");
  if (window.driftFlag) flags.push("drift");
  return flags;
}

export interface QuestionOption {
  question: string;
  answerType: "boolean" | "choice" | "score";
  decisions: number;
  outcomes: number;
}

export function questionOptionKey(option: Pick<QuestionOption, "question" | "answerType">): string {
  return `${option.answerType}:${option.question}`;
}

export function questionOptionLabel(option: QuestionOption): string {
  return `${option.question} · ${option.answerType} · ${option.decisions} decision${option.decisions === 1 ? "" : "s"} · ${option.outcomes} outcome${option.outcomes === 1 ? "" : "s"}`;
}

export function questionOptions(
  artifact: ProductionCalibrationArtifact,
  summary: ReadonlyArray<{ question: string; answerTypes: readonly string[]; decisions: number; outcomes: number }>
): QuestionOption[] {
  return artifact.questions.map((entry) => {
    const counts = summary.find((row) => row.question === entry.question);
    return {
      question: entry.question,
      answerType: entry.answerType,
      decisions: counts?.decisions ?? entry.calibration.n,
      outcomes: counts?.outcomes ?? entry.calibration.nWithOutcome
    };
  });
}

// ---------------------------------------------------------------------------
// Reliability diagram geometry
// ---------------------------------------------------------------------------

export interface ReliabilityDiagramPoint {
  index: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
  lower: number;
  upper: number;
  /** SVG user units. */
  x: number;
  y: number;
  yLower: number;
  yUpper: number;
  radius: number;
  label: string;
}

export interface ReliabilityDiagramLayout {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  ticks: Array<{ value: number; x: number; y: number; label: string }>;
  points: ReliabilityDiagramPoint[];
  emptyBins: number;
}

export const RELIABILITY_DIAGRAM_SIZE = { width: 360, height: 320 } as const;
const PLOT_MARGIN = { left: 44, top: 14, right: 16, bottom: 40 } as const;
const MIN_RADIUS = 4;
const MAX_RADIUS = 12;

/** Place each populated bin at (mean predicted, observed rate) with its Wilson interval as a vertical range. */
export function reliabilityDiagramLayout(bins: readonly ProductionCalibrationReliabilityBin[]): ReliabilityDiagramLayout {
  const { width, height } = RELIABILITY_DIAGRAM_SIZE;
  const plot = {
    left: PLOT_MARGIN.left,
    top: PLOT_MARGIN.top,
    right: width - PLOT_MARGIN.right,
    bottom: height - PLOT_MARGIN.bottom
  };
  const scaleX = (value: number) => plot.left + value * (plot.right - plot.left);
  const scaleY = (value: number) => plot.bottom - value * (plot.bottom - plot.top);
  const populated = bins.filter(
    (bin): bin is ProductionCalibrationReliabilityBin & { meanPredicted: number } =>
      bin.count > 0 && bin.meanPredicted !== null && bin.observedRate.state === "defined"
  );
  const maxCount = Math.max(1, ...populated.map((bin) => bin.count));
  const points = populated.map((bin) => {
    const rate = bin.observedRate;
    if (rate.state !== "defined") throw new Error("unreachable: populated bins have defined rates");
    const radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(bin.count / maxCount);
    return {
      index: bin.index,
      count: bin.count,
      meanPredicted: bin.meanPredicted,
      observedRate: rate.rate,
      lower: rate.interval.lower,
      upper: rate.interval.upper,
      x: scaleX(bin.meanPredicted),
      y: scaleY(rate.rate),
      yLower: scaleY(rate.interval.lower),
      yUpper: scaleY(rate.interval.upper),
      radius,
      label: `n=${bin.count}`
    };
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((value) => ({
    value,
    x: scaleX(value),
    y: scaleY(value),
    label: value === 0 || value === 1 ? String(value) : value.toFixed(2)
  }));
  return { width, height, plot, ticks, points, emptyBins: bins.length - populated.length };
}

// ---------------------------------------------------------------------------
// Advisor state
// ---------------------------------------------------------------------------

export type AdviceState =
  | { kind: "not_requested"; text: string }
  | { kind: "no_outcomes"; text: string }
  | { kind: "thin"; text: string; recommendation: string }
  | { kind: "ready"; text: string; recommendation: string };

export function adviceState(advice: ProductionCalibrationThresholdAdvice | null): AdviceState {
  if (advice === null) {
    return { kind: "not_requested", text: "Enter the cost of a false positive and a false negative to sweep thresholds. Add a review cost to get a review band instead." };
  }
  if (advice.caveat === "no_outcomes" || advice.recommendation === null) {
    return { kind: "no_outcomes", text: "No outcomes have been posted for this question, so there is nothing to sweep. No recommendation." };
  }
  const recommendation = recommendationText(advice);
  if (advice.caveat === "fewer_than_30_outcomes") {
    return {
      kind: "thin",
      text: `Only ${advice.n} decision${advice.n === 1 ? " has" : "s have"} an outcome (fewer than 30). The sweep ran, but the optimum is not reliable yet.`,
      recommendation
    };
  }
  return {
    kind: "ready",
    text: `Sweep over ${advice.n} decisions with outcomes. Costs are ratios: only their proportions matter.`,
    recommendation
  };
}

export function recommendationText(advice: ProductionCalibrationThresholdAdvice): string {
  if (advice.recommendation === null) return "No recommendation";
  if (advice.mode === "single") {
    const row = advice.recommendation;
    return `Threshold ${row.threshold.toFixed(2)} · expected cost ${row.expectedCostPerDecision.toFixed(3)} per decision · ${row.falsePositives} false positive${row.falsePositives === 1 ? "" : "s"} · ${row.falseNegatives} false negative${row.falseNegatives === 1 ? "" : "s"} · error rate among automated ${formatRate(row.errorRateAmongAutomated)}`;
  }
  const row = advice.recommendation;
  const band = row.low === row.high
    ? `single threshold ${row.high.toFixed(2)} (review nothing)`
    : `auto-no at p <= ${row.low.toFixed(2)} · review between · auto-yes at p >= ${row.high.toFixed(2)}`;
  return `${band} · ${row.humanReviews} to review · automation ${row.automated}/${row.automated + row.humanReviews} = ${formatPercent(row.automationRate)} · expected cost ${row.expectedCostPerDecision.toFixed(3)} per decision · error rate among automated ${formatRate(row.errorRateAmongAutomated)}`;
}

/** The cheapest rows of a band sweep, so the flatness of the optimum stays visible. */
export function cheapestBandRows(advice: ProductionCalibrationThresholdAdvice, limit = 8) {
  if (advice.mode !== "band") return [];
  return [...advice.sweep]
    .sort((left, right) =>
      left.expectedCostPerDecision - right.expectedCostPerDecision ||
      right.automationRate - left.automationRate ||
      left.low - right.low ||
      left.high - right.high)
    .slice(0, limit);
}

/** Off-diagonal confusion cells first, largest first. */
export function topConfusionPairs(
  confusion: ReadonlyArray<{ truth: string; chosen: string; count: number }>,
  limit = 10
) {
  return confusion
    .filter((cell) => cell.truth !== cell.chosen)
    .sort((left, right) => right.count - left.count || left.truth.localeCompare(right.truth) || left.chosen.localeCompare(right.chosen))
    .slice(0, limit);
}

export function parseCostInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export interface CostInputs {
  falsePositive: string;
  falseNegative: string;
  humanReview: string;
}

/** Costs are sent only when both error costs are present and valid; review is optional. */
export function costsFromInputs(inputs: CostInputs): { falsePositive: number; falseNegative: number; humanReview: number | null } | null {
  const falsePositive = parseCostInput(inputs.falsePositive);
  const falseNegative = parseCostInput(inputs.falseNegative);
  if (falsePositive === null || falseNegative === null) return null;
  return { falsePositive, falseNegative, humanReview: parseCostInput(inputs.humanReview) };
}
