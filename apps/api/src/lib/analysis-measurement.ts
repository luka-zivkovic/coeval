import { createHash } from "node:crypto";
import {
  ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION,
  ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION,
  AnalysisGovernedDisagreementMeasurementSchema,
  AnalysisTaxonomyChurnSchema,
  AnalysisWorkflowMeasurementReportSchema,
  type AnalysisCalibrationTrialMeasurement,
  type AnalysisGovernedDisagreementMeasurement,
  type AnalysisTaxonomyChurn,
  type AnalysisWorkflowMeasurementReport,
  type BinaryCalibrationArtifact
} from "@coeval/shared";
import { canonicalGovernedJsonV1 } from "./governed-content-digest.js";

export const ANALYSIS_WORKFLOW_MEASUREMENT_REPORT_DIGEST_BASIS =
  "analysis-workflow-measurement-report/v1" as const;

export interface GovernedDisagreementItemInput {
  requiredLabelCount: number;
  assignedTaskCount: number;
  activeLabels: readonly ("pass" | "fail" | "cannot_determine")[];
  adjudicationDecision: "pass" | "fail" | "unresolvable" | null;
}

export interface TaxonomyChurnCodeInput {
  codeId: string;
  label: string;
  definition: string;
  status: "active" | "retired";
}

export function deriveAnalysisGovernedDisagreement(
  governedBatchId: string,
  governedBatchDigest: string,
  items: readonly GovernedDisagreementItemInput[]
): AnalysisGovernedDisagreementMeasurement {
  const counts = {
    unanimous: 0,
    mixedPassFail: 0,
    cannotDetermine: 0,
    coverageGap: 0,
    unresolvable: 0,
    singleRater: 0,
    adjudicated: 0
  };
  for (const item of items) {
    if (item.adjudicationDecision === "pass" || item.adjudicationDecision === "fail") {
      counts.adjudicated += 1;
    }
    if (!Number.isSafeInteger(item.requiredLabelCount) || item.requiredLabelCount < 1 ||
        item.assignedTaskCount !== item.requiredLabelCount ||
        item.activeLabels.length !== item.requiredLabelCount) {
      counts.coverageGap += 1;
      continue;
    }
    if (item.adjudicationDecision === "unresolvable") {
      counts.unresolvable += 1;
      continue;
    }
    if (item.activeLabels.includes("cannot_determine")) {
      counts.cannotDetermine += 1;
      continue;
    }
    const pass = item.activeLabels.filter((label) => label === "pass").length;
    const fail = item.activeLabels.filter((label) => label === "fail").length;
    if (item.requiredLabelCount === 1 && pass + fail === 1) counts.singleRater += 1;
    else if (pass === item.requiredLabelCount || fail === item.requiredLabelCount) counts.unanimous += 1;
    else counts.mixedPassFail += 1;
  }
  return AnalysisGovernedDisagreementMeasurementSchema.parse({
    governedBatchId,
    governedBatchDigest,
    selectedItemCount: items.length,
    ...counts
  });
}

export function deriveAnalysisTaxonomyChurn(input: {
  taxonomyRevisionId: string;
  taxonomyRevisionDigest: string;
  taxonomyRevisionSequence: number;
  predecessorRevisionId: string | null;
  predecessorRevisionDigest: string | null;
  currentCodes: readonly TaxonomyChurnCodeInput[];
  predecessorCodes: readonly TaxonomyChurnCodeInput[];
  observationReassignments: number;
}): AnalysisTaxonomyChurn {
  const predecessor = new Map(input.predecessorCodes.map((code) => [code.codeId, code]));
  let additions = 0;
  let labelChanges = 0;
  let definitionChanges = 0;
  let retirements = 0;
  for (const current of input.currentCodes) {
    const prior = predecessor.get(current.codeId);
    if (!prior) {
      additions += 1;
      continue;
    }
    if (prior.label !== current.label) labelChanges += 1;
    if (prior.definition !== current.definition) definitionChanges += 1;
    if (prior.status === "active" && current.status === "retired") retirements += 1;
  }
  return AnalysisTaxonomyChurnSchema.parse({
    taxonomyRevisionId: input.taxonomyRevisionId,
    taxonomyRevisionDigest: input.taxonomyRevisionDigest,
    taxonomyRevisionSequence: input.taxonomyRevisionSequence,
    predecessorRevisionId: input.predecessorRevisionId,
    predecessorRevisionDigest: input.predecessorRevisionDigest,
    additions,
    labelChanges,
    definitionChanges,
    retirements,
    observationReassignments: input.observationReassignments
  });
}

export function exactDurationMilliseconds(start: string, end: string): string {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs) {
    throw new Error("Measurement duration timestamps are invalid or reverse ordered");
  }
  return String(endMs - startMs);
}

export function analysisCalibrationTrialMeasurements(
  artifact: BinaryCalibrationArtifact
): AnalysisCalibrationTrialMeasurement[] {
  return artifact.trials.map((trial) => ({
    trialIndex: trial.trialIndex,
    status: trial.status,
    planned: trial.outcomes.planned,
    classified: trial.outcomes.classified,
    abstained: trial.outcomes.abstained,
    errored: trial.outcomes.errored,
    unevaluated: trial.outcomes.unevaluated,
    falsePass: trial.errorDirections.falsePass,
    falseFail: trial.errorDirections.falseFail,
    classifiedCoverage: trial.metrics.classifiedCoverage
  }));
}

export function analysisWorkflowMeasurementReportDigest(
  report: Omit<AnalysisWorkflowMeasurementReport, "reportDigest" | "calculatedAt">
): string {
  const exact = {
    basis: ANALYSIS_WORKFLOW_MEASUREMENT_REPORT_DIGEST_BASIS,
    ...report,
    contractVersion: ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION,
    calculationVersion: ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION
  };
  return `sha256:${createHash("sha256").update(canonicalGovernedJsonV1(exact)).digest("hex")}`;
}

export function verifyAnalysisWorkflowMeasurementReport(
  value: AnalysisWorkflowMeasurementReport
): AnalysisWorkflowMeasurementReport {
  const parsed = AnalysisWorkflowMeasurementReportSchema.parse(value);
  const { reportDigest, calculatedAt: _calculatedAt, ...content } = parsed;
  if (analysisWorkflowMeasurementReportDigest(content) !== reportDigest) {
    throw new Error("Analysis workflow measurement report digest mismatch");
  }
  return parsed;
}
