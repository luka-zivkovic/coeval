import { z } from "zod";
import { BinaryCalibrationWilsonRateSchema } from "./binary-calibration.js";
import {
  AnalysisStudyStateSchema,
  AnalysisTaxonomyCoverageSchema
} from "./analysis-study.js";

// Batch 6B-5: component-only Analyze measurements. This report is a
// versioned read projection over immutable evidence plus explicitly named
// read-time calibration admissibility. It deliberately has no composite,
// threshold, trust, promotion, block, or release field.
export const ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION =
  "coeval/analysis-workflow-measurement/v1" as const;
export const ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION =
  "analysis-workflow-components/v1" as const;

const AnalysisMeasurementIdSchema = z.string().trim().min(1).max(240);
const AnalysisMeasurementDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const AnalysisMeasurementTimestampSchema = z.string().datetime({ offset: true });
const AnalysisMeasurementCountSchema = z.number().int().min(0).max(10_000);

export const AnalysisCodingMeasurementSchema = z.object({
  selectedItemCount: z.number().int().min(1).max(10_000),
  viewedItemCount: AnalysisMeasurementCountSchema,
  inProgressItemCount: AnalysisMeasurementCountSchema,
  completedItemCount: AnalysisMeasurementCountSchema,
  noFailureObservedItemCount: AnalysisMeasurementCountSchema,
  missingItemCount: AnalysisMeasurementCountSchema
}).strict().superRefine((value, context) => {
  if (value.viewedItemCount > value.selectedItemCount ||
      value.noFailureObservedItemCount > value.selectedItemCount ||
      value.completedItemCount + value.inProgressItemCount + value.missingItemCount !== value.selectedItemCount) {
    context.addIssue({ code: "custom", message: "coding measurement counts must conserve the selected frame" });
  }
});
export type AnalysisCodingMeasurement = z.infer<typeof AnalysisCodingMeasurementSchema>;

export const AnalysisTaxonomyChurnSchema = z.object({
  taxonomyRevisionId: AnalysisMeasurementIdSchema,
  taxonomyRevisionDigest: AnalysisMeasurementDigestSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(10_000),
  predecessorRevisionId: AnalysisMeasurementIdSchema.nullable(),
  predecessorRevisionDigest: AnalysisMeasurementDigestSchema.nullable(),
  additions: AnalysisMeasurementCountSchema,
  labelChanges: AnalysisMeasurementCountSchema,
  definitionChanges: AnalysisMeasurementCountSchema,
  retirements: AnalysisMeasurementCountSchema,
  observationReassignments: AnalysisMeasurementCountSchema
}).strict().superRefine((value, context) => {
  if ((value.predecessorRevisionId === null) !== (value.predecessorRevisionDigest === null) ||
      (value.taxonomyRevisionSequence === 1) !== (value.predecessorRevisionId === null)) {
    context.addIssue({ code: "custom", message: "taxonomy churn must bind the exact predecessor" });
  }
});
export type AnalysisTaxonomyChurn = z.infer<typeof AnalysisTaxonomyChurnSchema>;

export const AnalysisTaxonomyMeasurementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_requested") }).strict(),
  z.object({
    state: z.literal("available"),
    coverage: AnalysisTaxonomyCoverageSchema,
    churn: AnalysisTaxonomyChurnSchema
  }).strict().superRefine((value, context) => {
    if (value.coverage.taxonomyRevisionId !== value.churn.taxonomyRevisionId ||
        value.coverage.taxonomyRevisionSequence !== value.churn.taxonomyRevisionSequence) {
      context.addIssue({ code: "custom", message: "taxonomy coverage and churn must name one revision" });
    }
  })
]);
export type AnalysisTaxonomyMeasurement = z.infer<typeof AnalysisTaxonomyMeasurementSchema>;

export const AnalysisGovernedDisagreementMeasurementSchema = z.object({
  governedBatchId: AnalysisMeasurementIdSchema,
  governedBatchDigest: AnalysisMeasurementDigestSchema,
  selectedItemCount: z.number().int().min(1).max(10_000),
  unanimous: AnalysisMeasurementCountSchema,
  mixedPassFail: AnalysisMeasurementCountSchema,
  cannotDetermine: AnalysisMeasurementCountSchema,
  coverageGap: AnalysisMeasurementCountSchema,
  unresolvable: AnalysisMeasurementCountSchema,
  singleRater: AnalysisMeasurementCountSchema,
  adjudicated: AnalysisMeasurementCountSchema
}).strict().superRefine((value, context) => {
  const primary = value.unanimous + value.mixedPassFail + value.cannotDetermine +
    value.coverageGap + value.unresolvable + value.singleRater;
  if (primary !== value.selectedItemCount || value.adjudicated > value.selectedItemCount) {
    context.addIssue({ code: "custom", message: "governed disagreement must be a disjoint primary partition" });
  }
});
export type AnalysisGovernedDisagreementMeasurement = z.infer<
  typeof AnalysisGovernedDisagreementMeasurementSchema
>;

export const AnalysisCalibrationTrialMeasurementSchema = z.object({
  trialIndex: z.number().int().min(0).max(9),
  status: z.enum(["complete", "incomplete"]),
  planned: z.number().int().min(1).max(5_000),
  classified: AnalysisMeasurementCountSchema,
  abstained: AnalysisMeasurementCountSchema,
  errored: AnalysisMeasurementCountSchema,
  unevaluated: AnalysisMeasurementCountSchema,
  falsePass: AnalysisMeasurementCountSchema,
  falseFail: AnalysisMeasurementCountSchema,
  classifiedCoverage: z.object({
    overall: BinaryCalibrationWilsonRateSchema,
    truthPass: BinaryCalibrationWilsonRateSchema,
    truthFail: BinaryCalibrationWilsonRateSchema
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.classified + value.abstained + value.errored + value.unevaluated !== value.planned ||
      value.falsePass + value.falseFail > value.classified) {
    context.addIssue({ code: "custom", message: "calibration trial outcomes must conserve planned support" });
  }
});
export type AnalysisCalibrationTrialMeasurement = z.infer<typeof AnalysisCalibrationTrialMeasurementSchema>;

const AnalysisCalibrationCommonShape = {
  calibrationRunId: AnalysisMeasurementIdSchema,
  runCreatedAt: AnalysisMeasurementTimestampSchema,
  plannedObservations: z.number().int().min(1).max(5_000),
  accountedObservations: z.number().int().min(0).max(5_000)
} as const;

export const AnalysisCalibrationMeasurementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }).strict(),
  z.object({
    state: z.enum(["queued", "running", "recovery_required", "rejected"]),
    ...AnalysisCalibrationCommonShape,
    rejectionReason: z.string().min(1).max(5_000).nullable()
  }).strict(),
  z.object({
    state: z.enum(["complete", "incomplete"]),
    ...AnalysisCalibrationCommonShape,
    artifactId: AnalysisMeasurementIdSchema,
    artifactDigest: AnalysisMeasurementDigestSchema,
    evidenceDigest: AnalysisMeasurementDigestSchema,
    artifactCreatedAt: AnalysisMeasurementTimestampSchema,
    currentAdmissibility: z.enum(["admissible", "revoked", "unknown"]),
    currentAdmissibilityReasons: z.array(z.enum([
      "development_exposure", "provider_policy_invalidated", "provenance_invalidated",
      "artifact_superseded", "current_status_unavailable"
    ])).max(5),
    positiveClass: z.enum(["pass", "fail"]),
    truthSupport: z.object({
      total: z.number().int().min(1).max(5_000),
      pass: AnalysisMeasurementCountSchema,
      fail: AnalysisMeasurementCountSchema
    }).strict(),
    trials: z.array(AnalysisCalibrationTrialMeasurementSchema).min(1).max(10)
  }).strict().superRefine((value, context) => {
    if (value.truthSupport.pass + value.truthSupport.fail !== value.truthSupport.total ||
        (value.currentAdmissibility === "admissible") !== (value.currentAdmissibilityReasons.length === 0)) {
      context.addIssue({ code: "custom", message: "calibration artifact support and current status must be exact" });
    }
  })
]);
export type AnalysisCalibrationMeasurement = z.infer<typeof AnalysisCalibrationMeasurementSchema>;

export const AnalysisArtifactDurationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }).strict(),
  z.object({
    state: z.literal("defined"),
    artifactId: AnalysisMeasurementIdSchema,
    artifactCreatedAt: AnalysisMeasurementTimestampSchema,
    durationMilliseconds: z.string().regex(/^(0|[1-9][0-9]*)$/)
  }).strict()
]);
export type AnalysisArtifactDuration = z.infer<typeof AnalysisArtifactDurationSchema>;

export const AnalysisEvaluatorMeasurementSchema = z.object({
  lifecycleId: AnalysisMeasurementIdSchema,
  promotionId: AnalysisMeasurementIdSchema,
  criterionId: AnalysisMeasurementIdSchema,
  criterionVersionId: AnalysisMeasurementIdSchema,
  skillId: AnalysisMeasurementIdSchema,
  skillVersionId: AnalysisMeasurementIdSchema,
  governedDisagreement: AnalysisGovernedDisagreementMeasurementSchema,
  calibration: AnalysisCalibrationMeasurementSchema,
  timeToFirstCompletedCalibrationArtifact: AnalysisArtifactDurationSchema,
  timeToFirstCurrentlyAdmissibleCalibrationArtifact: AnalysisArtifactDurationSchema
}).strict();
export type AnalysisEvaluatorMeasurement = z.infer<typeof AnalysisEvaluatorMeasurementSchema>;

export const AnalysisEvaluatorMeasurementOptionSchema = z.object({
  lifecycleId: AnalysisMeasurementIdSchema,
  promotionId: AnalysisMeasurementIdSchema,
  criterionId: AnalysisMeasurementIdSchema,
  criterionVersionId: AnalysisMeasurementIdSchema,
  skillId: AnalysisMeasurementIdSchema,
  skillVersionId: AnalysisMeasurementIdSchema
}).strict();
export type AnalysisEvaluatorMeasurementOption = z.infer<typeof AnalysisEvaluatorMeasurementOptionSchema>;

export const AnalysisWorkflowMeasurementReportSchema = z.object({
  contractVersion: z.literal(ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION),
  calculationVersion: z.literal(ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION),
  projectId: AnalysisMeasurementIdSchema,
  studyId: AnalysisMeasurementIdSchema,
  populationId: AnalysisMeasurementIdSchema,
  drawId: AnalysisMeasurementIdSchema,
  datasetRevisionId: AnalysisMeasurementIdSchema,
  studyCreatedAt: AnalysisMeasurementTimestampSchema,
  studyState: AnalysisStudyStateSchema,
  coding: AnalysisCodingMeasurementSchema,
  taxonomy: AnalysisTaxonomyMeasurementSchema,
  evaluatorOptions: z.array(AnalysisEvaluatorMeasurementOptionSchema).max(1_000),
  evaluator: AnalysisEvaluatorMeasurementSchema.nullable(),
  reportDigest: AnalysisMeasurementDigestSchema,
  calculatedAt: AnalysisMeasurementTimestampSchema
}).strict().superRefine((value, context) => {
  if (value.taxonomy.state === "available" &&
      (value.taxonomy.coverage.projectId !== value.projectId ||
       value.taxonomy.coverage.studyId !== value.studyId)) {
    context.addIssue({ code: "custom", message: "taxonomy measurement must bind the report study" });
  }
  const identities = new Set(value.evaluatorOptions.map((option) => option.skillVersionId));
  if (identities.size !== value.evaluatorOptions.length ||
      (value.evaluator !== null && !identities.has(value.evaluator.skillVersionId))) {
    context.addIssue({ code: "custom", message: "evaluator measurement must bind one listed study evaluator" });
  }
});
export type AnalysisWorkflowMeasurementReport = z.infer<typeof AnalysisWorkflowMeasurementReportSchema>;
