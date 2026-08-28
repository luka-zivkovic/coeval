import {
  GOLDEN_GATE_ARMS_AT,
  GOLDEN_GATE_RECOMMENDED,
  type RegressionRunResult,
  type SkillVersion
} from "@coeval/shared";

export function knownFailureGateSummary(goldenSize: number): string {
  if (goldenSize < GOLDEN_GATE_ARMS_AT) {
    return `No active reference cases. The new version will be recorded without a known-failure comparison; the check enables at ${GOLDEN_GATE_ARMS_AT}.`;
  }
  if (goldenSize < GOLDEN_GATE_RECOMMENDED) {
    return `Known-failure check enabled with ${goldenSize} active reference case${goldenSize === 1 ? "" : "s"}. ${goldenSize}/${GOLDEN_GATE_RECOMMENDED} toward the recommended starting set.`;
  }
  return `Known-failure check enabled with ${goldenSize} active reference cases. The recommended starting set of ${GOLDEN_GATE_RECOMMENDED} has been reached.`;
}

export function sameModelBinding(left: SkillVersion["modelBinding"], right: SkillVersion["modelBinding"]): boolean {
  return left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.modelVersion === right.modelVersion &&
    left.temperature === right.temperature &&
    left.topP === right.topP &&
    left.baseUrl === right.baseUrl;
}

export function verdictOutputContractChanged(
  base: Pick<SkillVersion, "verdictKind" | "scalarRange" | "categoricalChoiceScores">,
  current: Pick<SkillVersion, "verdictKind" | "scalarRange" | "categoricalChoiceScores">
): boolean {
  return base.verdictKind !== current.verdictKind ||
    JSON.stringify(base.scalarRange) !== JSON.stringify(current.scalarRange) ||
    JSON.stringify(base.categoricalChoiceScores) !== JSON.stringify(current.categoricalChoiceScores);
}

export function skillVersionChangeLabels(current: SkillVersion, previous?: SkillVersion | undefined): string[] {
  if (!previous) return ["initial version"];
  const labels: string[] = [];
  if (current.rubricMarkdown !== previous.rubricMarkdown) labels.push("review guide");
  if (current.prompt !== previous.prompt) labels.push("judge instructions");
  if (!sameModelBinding(current.modelBinding, previous.modelBinding)) labels.push("requested model");
  if (
    current.verdictKind !== previous.verdictKind ||
    JSON.stringify(current.outputSchema) !== JSON.stringify(previous.outputSchema) ||
    JSON.stringify(current.scalarRange) !== JSON.stringify(previous.scalarRange) ||
    JSON.stringify(current.categoricalChoiceScores) !== JSON.stringify(previous.categoricalChoiceScores)
  ) labels.push("result format");
  return labels.length > 0 ? labels : ["no evaluator-field change"];
}

export function regressionReceiptLabel(run: RegressionRunResult | undefined): string {
  if (!run) return "no regression receipt";
  if (run.status === "overridden") return "override recorded";
  if (run.status === "blocked") return "regression found";
  if (run.status === "error") return "check failed";
  if (run.goldenSetMissing) return "recorded without comparison";
  return "check passed";
}

export interface SkillEditOperationScope {
  generation: number;
  criterionId: string | null;
  skillId: string | null;
}

export function skillEditOperationIsCurrent(
  submitted: SkillEditOperationScope,
  current: SkillEditOperationScope
): boolean {
  return submitted.generation === current.generation &&
    submitted.criterionId === current.criterionId &&
    submitted.skillId === current.skillId;
}
