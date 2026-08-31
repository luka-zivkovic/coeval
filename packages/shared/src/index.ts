import { z } from "zod";
import {
  JsonSchemaSchema,
  HttpUrlSchema,
  JudgeProviderIdSchema,
  MinimumVerdictOutputSchema,
  ModelBindingInputSchema,
  ModelBindingSchema,
  RubricProvenanceSchema,
  RUBRIC_TEMPLATE_VARIABLE,
  SkillStatusSchema,
  STARTER_RUBRIC_MARKER,
  StoredModelBindingSchema,
  VerdictKindSchema,
  VerdictLabelSchema,
  compileJudgePrompt,
  containsLoneUtf16Surrogate,
  defaultJudgePromptTemplate,
  normalizeJudgeProviderId,
  promptReferencesRubric,
  renderJudgePromptContent,
  verdictOutputSchema
} from "./judge.js";
import type {
  CompiledJudgePrompt,
  JsonSchema,
  JudgePromptDiagnostic,
  JudgeProviderId,
  ModelBinding,
  ModelBindingInput,
  RubricProvenance,
  SkillStatus,
  StoredModelBinding,
  VerdictKind,
  VerdictLabel
} from "./judge.js";
import {
  DeleteProjectInputSchema,
  GOLDEN_GATE_ARMS_AT,
  GOLDEN_GATE_RECOMMENDED,
  KAPPA_MIN_SHARED_CASES,
  PROJECT_NAME_MAX_LENGTH,
  ProjectModeSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  RetentionPruneResultSchema,
  UpdateProjectSettingsInputSchema
} from "./projects.js";
import type {
  DeleteProjectInput,
  Project,
  ProjectMode,
  ProjectSettings,
  RetentionPruneResult,
  UpdateProjectSettingsInput
} from "./projects.js";
import { SkillSchema, SkillVersionSchema } from "./skills.js";
import type { Skill, SkillVersion } from "./skills.js";
import {
  BinaryAbstainedVerdictPayloadSchema,
  BinaryClassifiedVerdictPayloadSchema,
  BinaryVerdictPayloadSchema,
  CategoricalVerdictPayloadSchema,
  ScalarVerdictPayloadSchema,
  VerdictDistributionSchema,
  VerdictPayloadSchema,
  VerdictRecordSchema,
  VerdictSourceSchema
} from "./verdicts.js";
import type {
  VerdictDistribution,
  VerdictPayload,
  VerdictRecord,
  VerdictSource
} from "./verdicts.js";
import {
  CapabilityGapSchema,
  ExceptionCaseSchema,
  JudgeHumanDisagreementSummarySchema,
  KappaInterpretationSchema,
  SelfConsistencyReportSchema
} from "./legacy-review.js";
import {
  DatasetEvidenceDigestSchema,
  DatasetRevisionPayloadSnapshotSchema,
} from "./datasets.js";
import {
  TracePayloadSchema,
  TraceSourceSchema,
  TraceStepsSchema
} from "./traces.js";
import { ProviderResponseMetadataSchema } from "./evaluation-runs.js";
import type { EvalRunStatus } from "./evaluation-runs.js";
import {
  CreateCriterionVersionInputSchema,
  CriterionVersionSchema
} from "./criterion-governance.js";
import { BinaryCalibrationWilsonRateSchema } from "./binary-calibration.js";
import {
  AnalysisStudyStateSchema,
  AnalysisTaxonomyCoverageSchema
} from "./analysis-study.js";

export {
  BinaryAbstainedVerdictPayloadSchema,
  BinaryClassifiedVerdictPayloadSchema,
  BinaryVerdictPayloadSchema,
  CategoricalVerdictPayloadSchema,
  DeleteProjectInputSchema,
  GOLDEN_GATE_ARMS_AT,
  GOLDEN_GATE_RECOMMENDED,
  JsonSchemaSchema,
  JudgeProviderIdSchema,
  KAPPA_MIN_SHARED_CASES,
  MinimumVerdictOutputSchema,
  ModelBindingInputSchema,
  ModelBindingSchema,
  PROJECT_NAME_MAX_LENGTH,
  ProjectModeSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  RUBRIC_TEMPLATE_VARIABLE,
  RetentionPruneResultSchema,
  RubricProvenanceSchema,
  STARTER_RUBRIC_MARKER,
  ScalarVerdictPayloadSchema,
  SkillSchema,
  SkillStatusSchema,
  SkillVersionSchema,
  StoredModelBindingSchema,
  UpdateProjectSettingsInputSchema,
  VerdictDistributionSchema,
  VerdictKindSchema,
  VerdictLabelSchema,
  VerdictPayloadSchema,
  VerdictRecordSchema,
  VerdictSourceSchema,
  compileJudgePrompt,
  containsLoneUtf16Surrogate,
  defaultJudgePromptTemplate,
  normalizeJudgeProviderId,
  promptReferencesRubric,
  renderJudgePromptContent,
  verdictOutputSchema
};
export type {
  CompiledJudgePrompt,
  DeleteProjectInput,
  JsonSchema,
  JudgePromptDiagnostic,
  JudgeProviderId,
  ModelBinding,
  ModelBindingInput,
  Project,
  ProjectMode,
  ProjectSettings,
  RetentionPruneResult,
  RubricProvenance,
  Skill,
  SkillStatus,
  SkillVersion,
  StoredModelBinding,
  UpdateProjectSettingsInput,
  VerdictDistribution,
  VerdictKind,
  VerdictLabel,
  VerdictPayload,
  VerdictRecord,
  VerdictSource
};

export * from "./legacy-review.js";

export {
  CaseSourceSchema,
  IngestionPurposeSchema,
  MAX_TRACE_STEPS,
  ManualTraceImportInputSchema,
  ManualTraceImportResultSchema,
  RuntimeIngestionPurposeSchema,
  TracePayloadSchema,
  TraceSourceSchema,
  TraceStepSchema
} from "./traces.js";
export type {
  CaseSource,
  IngestionPurpose,
  ManualTraceImportInput,
  ManualTraceImportResult,
  RuntimeIngestionPurpose,
  TracePayload,
  TraceSource,
  TraceStep
} from "./traces.js";


export * from "./agent-access.js";


export * from "./trace-tests.js";


export * from "./datasets.js";


export {
  ANALYSIS_POPULATION_MAX_MEMBERS,
  ANALYSIS_POPULATION_MAX_FIXED_BUDGET,
  ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS,
  ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
  ANALYSIS_POPULATION_ORDERING_VERSION,
  ANALYSIS_POPULATION_RNG_VERSION,
  ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
  ANALYSIS_POPULATION_MAX_SNAPSHOT_XID8_BYTES,
  ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
  AnalysisPopulationEligibleSourcesSchema,
  ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
  AnalysisPopulationEligibleIngestionPurposesSchema,
  AnalysisPopulationExactCountSchema,
  ANALYSIS_POPULATION_API_PAGE_MAX,
  ANALYSIS_POPULATION_CURSOR_MAX_LENGTH,
  AnalysisPopulationCreateInputSchema,
  AnalysisPopulationRequestRecordSchema,
  AnalysisPopulationSchema,
  AnalysisPopulationMemberSchema,
  AnalysisPopulationMemberRecordSchema,
  AnalysisPopulationExclusionReasonSchema,
  AnalysisPopulationExclusionSchema,
  AnalysisPopulationInclusionProbabilitySchema,
  AnalysisPopulationDrawSelectionSchema,
  AnalysisPopulationDrawSchema,
  AnalysisPopulationDrawSummarySchema,
  AnalysisPopulationClaimSchema,
  AnalysisPopulationOverlapSummarySchema,
  AnalysisPopulationSummarySchema,
  AnalysisPopulationDetailSchema,
  AnalysisPopulationMembersPageSchema,
  AnalysisPopulationExclusionsPageSchema,
  AnalysisPopulationOverlapsPageSchema,
  AnalysisPopulationSelectedItemsPageSchema,
  AnalysisPopulationSummariesPageSchema,
  AnalysisPopulationCreateResultSchema
} from "./analysis-population.js";
export type {
  AnalysisPopulationCreateInput,
  AnalysisPopulationRequestRecord,
  AnalysisPopulation,
  AnalysisPopulationMember,
  AnalysisPopulationMemberRecord,
  AnalysisPopulationExclusionReason,
  AnalysisPopulationExclusion,
  AnalysisPopulationInclusionProbability,
  AnalysisPopulationDrawSelection,
  AnalysisPopulationDraw,
  AnalysisPopulationDrawSummary,
  AnalysisPopulationClaim,
  AnalysisPopulationOverlapSummary,
  AnalysisPopulationSummary,
  AnalysisPopulationDetail,
  AnalysisPopulationMembersPage,
  AnalysisPopulationExclusionsPage,
  AnalysisPopulationOverlapsPage,
  AnalysisPopulationSelectedItemsPage,
  AnalysisPopulationSummariesPage,
  AnalysisPopulationCreateResult
} from "./analysis-population.js";


export {
  ANALYSIS_STUDY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_CONTRACT_VERSION,
  ANALYSIS_TAXONOMY_COVERAGE_VERSION,
  ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
  ANALYSIS_MAX_TAXONOMY_CODES,
  ANALYSIS_MAX_TAXONOMY_REVISIONS,
  ANALYSIS_MAX_FAILURE_LABEL_LENGTH,
  ANALYSIS_MAX_RATIONALE_LENGTH,
  ANALYSIS_MAX_REASON_LENGTH,
  ANALYSIS_MAX_EVENT_VERSION,
  ANALYSIS_MAX_EXPECTED_EVENT_VERSION,
  AnalysisStudyStateSchema,
  AnalysisStudyItemStateSchema,
  AnalysisStudyStoppingRuleSchema,
  AnalysisEvidenceAnchorSchema,
  AnalysisStudyCreateInputSchema,
  AnalysisStudyOpenInputSchema,
  AnalysisStudyCloseInputSchema,
  AnalysisStudyCompleteInputSchema,
  AnalysisStudyAbandonInputSchema,
  AnalysisStudyArtifactSchema,
  AnalysisStudyItemArtifactSchema,
  AnalysisStudyEventTypeSchema,
  AnalysisStudyEventArtifactSchema,
  AnalysisStudyProjectionSchema,
  AnalysisStudyItemEventTypeSchema,
  AnalysisStudyItemEventInputSchema,
  AnalysisStudyItemEventArtifactSchema,
  AnalysisStudyItemProjectionSchema,
  AnalysisRepresentativeReasonSchema,
  AnalysisStudyClosureItemArtifactSchema,
  AnalysisStudyClosureArtifactSchema,
  AnalysisStudyItemViewArtifactSchema,
  AnalysisFailureTaxonomyArtifactSchema,
  AnalysisFailureCodeArtifactSchema,
  AnalysisTaxonomyCodeStatusSchema,
  AnalysisTaxonomyRevisionCodeArtifactSchema,
  AnalysisTaxonomyRevisionArtifactSchema,
  AnalysisTaxonomyRevisionProjectionSchema,
  AnalysisObservationAssignmentEventArtifactSchema,
  AnalysisTaxonomyCoverageSchema,
  AnalysisTaxonomyNewCodeInputSchema,
  AnalysisTaxonomyExistingCodeInputSchema,
  AnalysisTaxonomyRevisionCodeInputSchema,
  AnalysisFailureTaxonomyCreateInputSchema,
  AnalysisTaxonomyRevisionCreateInputSchema,
  AnalysisObservationAssignmentEventInputSchema,
  AnalysisStudySummarySchema,
  AnalysisStudyDetailSchema,
  AnalysisStudySummariesPageSchema,
  AnalysisStudyItemsPageSchema,
  AnalysisStudyItemEventsPageSchema,
  AnalysisStudyCreateResultSchema,
  AnalysisStudyEventResultSchema,
  AnalysisStudyItemEventResultSchema,
  AnalysisTaxonomySummarySchema,
  AnalysisTaxonomyDetailSchema,
  AnalysisTaxonomyRevisionsPageSchema,
  AnalysisTaxonomyRevisionResultSchema,
  AnalysisObservationAssignmentsPageSchema,
  AnalysisObservationAssignmentEventResultSchema
} from "./analysis-study.js";
export type {
  AnalysisStudyState,
  AnalysisStudyItemState,
  AnalysisStudyStoppingRule,
  AnalysisEvidenceAnchor,
  AnalysisStudyCreateInput,
  AnalysisStudyOpenInput,
  AnalysisStudyCloseInput,
  AnalysisStudyCompleteInput,
  AnalysisStudyAbandonInput,
  AnalysisStudyArtifact,
  AnalysisStudyItemArtifact,
  AnalysisStudyEventType,
  AnalysisStudyEventArtifact,
  AnalysisStudyProjection,
  AnalysisStudyItemEventType,
  AnalysisStudyItemEventInput,
  AnalysisStudyItemEventArtifact,
  AnalysisStudyItemProjection,
  AnalysisRepresentativeReason,
  AnalysisStudyClosureItemArtifact,
  AnalysisStudyClosureArtifact,
  AnalysisStudyItemViewArtifact,
  AnalysisFailureTaxonomyArtifact,
  AnalysisFailureCodeArtifact,
  AnalysisTaxonomyCodeStatus,
  AnalysisTaxonomyRevisionCodeArtifact,
  AnalysisTaxonomyRevisionArtifact,
  AnalysisTaxonomyRevisionProjection,
  AnalysisObservationAssignmentEventArtifact,
  AnalysisTaxonomyCoverage,
  AnalysisTaxonomyNewCodeInput,
  AnalysisTaxonomyExistingCodeInput,
  AnalysisTaxonomyRevisionCodeInput,
  AnalysisFailureTaxonomyCreateInput,
  AnalysisTaxonomyRevisionCreateInput,
  AnalysisObservationAssignmentEventInput,
  AnalysisStudySummary,
  AnalysisStudyDetail,
  AnalysisStudySummariesPage,
  AnalysisStudyItemsPage,
  AnalysisStudyItemEventsPage,
  AnalysisStudyCreateResult,
  AnalysisStudyEventResult,
  AnalysisStudyItemEventResult,
  AnalysisTaxonomySummary,
  AnalysisTaxonomyDetail,
  AnalysisTaxonomyRevisionsPage,
  AnalysisTaxonomyRevisionResult,
  AnalysisObservationAssignmentsPage,
  AnalysisObservationAssignmentEventResult
} from "./analysis-study.js";




export * from "./evaluation-runs.js";


export * from "./criterion-governance.js";


export * from "./binary-calibration.js";


// Product deploy gate (gate checks): the regression-gate idea pointed at the
// CUSTOMER'S product instead of the judge skill. Before deploying a new
// prompt/model/agent, the customer re-runs their product against the golden
// cases' inputs and submits the candidate outputs; Coeval judges each with the
// APPROVED skill version and compares the judged label against the golden
// set's historical human-approved label. A gate check persists identity + config and
// points at a regular eval run — its status is DERIVED from that run's
// counters (deriveGateCheckDecision below), never dual-written, so the eval
// run stays the single source of truth and no completion hook can drift.
// Deprecated: new integrations consume policy-free assessment receipts and
// make release decisions in their release layer.
export const GateCheckStatusSchema = z.enum(["pending", "running", "passed", "blocked", "error"]);
export type GateCheckStatus = z.infer<typeof GateCheckStatusSchema>;

// One candidate output, addressed at a golden case either by the case id
// (`goldenCaseId`) or by the golden entry's source trace id (`caseKey`) —
// the stable key CI pipelines usually carry.
export const GateCheckCandidateSchema = z.object({
  goldenCaseId: z.string().min(1).optional(),
  caseKey: z.string().min(1).optional(),
  output: z.unknown()
}).superRefine((candidate, ctx) => {
  if (!candidate.goldenCaseId && !candidate.caseKey) {
    ctx.addIssue({ code: "custom", message: "Each candidate needs goldenCaseId or caseKey" });
  }
  if (candidate.goldenCaseId && candidate.caseKey) {
    ctx.addIssue({ code: "custom", message: "Give goldenCaseId or caseKey, not both" });
  }
});
export type GateCheckCandidate = z.infer<typeof GateCheckCandidateSchema>;

export const CreateGateCheckRequestSchema = z.object({
  // One skill per project (locked decision) — when provided this must be the
  // project's skill; the gate always judges with its approved version.
  skillId: z.string().min(1).optional(),
  candidates: z.array(GateCheckCandidateSchema).min(1),
  // Free-form deploy label (e.g. a git sha) + metadata for CI traceability.
  label: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // The gate passes iff disagreements <= maxDisagreements (default 0).
  maxDisagreements: z.number().int().nonnegative().optional()
});
export type CreateGateCheckRequest = z.infer<typeof CreateGateCheckRequestSchema>;

export const GateCheckItemSchema = z.object({
  id: z.string(),
  gateCheckId: z.string(),
  goldenEntryId: z.string(),
  goldenCaseId: z.string(),
  // Snapshot of the golden entry's trace id at submission — the CI-facing key.
  caseKey: z.string(),
  // The derived case: golden input + candidate output, judged like any trace.
  candidateCaseId: z.string(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  status: z.enum(["pending", "completed", "failed"]),
  judgedLabel: z.string().nullable(),
  agreement: z.boolean().nullable(),
  // True when the candidate output was already judged by this skill version
  // (re-running an unchanged product spends nothing).
  cached: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string()
});
export type GateCheckItem = z.infer<typeof GateCheckItemSchema>;

export const GateCheckSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  skillVersionId: z.string(),
  evalRunId: z.string(),
  label: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  maxDisagreements: z.number().int().nonnegative(),
  status: GateCheckStatusSchema,
  totalCandidates: z.number().int().nonnegative(),
  judgedCandidates: z.number().int().nonnegative(),
  erroredCandidates: z.number().int().nonnegative(),
  disagreements: z.number().int().nonnegative(),
  createdAt: z.string(),
  finishedAt: z.string().nullable()
});
export type GateCheck = z.infer<typeof GateCheckSchema>;

export const GateCheckDetailSchema = GateCheckSchema.extend({
  items: z.array(GateCheckItemSchema)
});
export type GateCheckDetail = z.infer<typeof GateCheckDetailSchema>;

// The gate decision as a pure projection of the linked eval run's counters.
// Every gate item carries an expected label, so agreement is defined for every
// completed item: disagreements = completed - agreed.
//
// Locked invariant — infrastructure failures must NEVER masquerade as passing
// gates: a failed run, a canceled run, or ANY failed item is 'error', never
// 'passed' (and never 'blocked' either — an un-judged deploy is unknown, not
// regressed).
export function deriveGateCheckDecision(input: {
  runStatus: EvalRunStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  agreedItems: number;
  maxDisagreements: number;
}): { status: GateCheckStatus; disagreements: number } {
  const disagreements = Math.max(0, input.completedItems - input.agreedItems);
  if (input.runStatus === "failed" || input.runStatus === "canceled") return { status: "error", disagreements };
  if (input.runStatus === "pending") return { status: "pending", disagreements };
  if (input.runStatus === "running") return { status: "running", disagreements };
  // Belt-and-braces: an unrecognized run status (schema drift, a bad cast)
  // must read as 'error' — it must never fall through to pass/blocked.
  if (input.runStatus !== "completed") return { status: "error", disagreements };
  // Run completed. Belt-and-braces: even if a run somehow completes with
  // fewer completed items than total, the shortfall reads as 'error'.
  if (input.failedItems > 0 || input.completedItems < input.totalItems) return { status: "error", disagreements };
  return { status: disagreements <= input.maxDisagreements ? "passed" : "blocked", disagreements };
}

export const TraceRedactionConfigSchema = z.object({
  excludedPaths: z.array(z.string().min(1).refine((path) => !/\[(?!\d+\]|\*\])/.test(path), {
    message: "Only numeric indexes like [0] and wildcards like [*] are supported in redaction paths"
  })).optional(),
  sensitiveKeyPatterns: z.array(z.string().min(1)).optional(),
  maxStringChars: z.number().int().positive().max(100_000).optional()
});
export type TraceRedactionConfig = z.infer<typeof TraceRedactionConfigSchema>;

export const LangSmithIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  apiKey: z.string().min(1),
  projectName: z.string().min(1).optional(),
  endpointUrl: z.url().optional(),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type LangSmithIntegrationInput = z.infer<typeof LangSmithIntegrationInputSchema>;

export const UpdateLangSmithIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
}).refine((input) => Object.keys(input).length > 0, {
  message: "At least one LangSmith integration setting is required"
});
export type UpdateLangSmithIntegrationInput = z.infer<typeof UpdateLangSmithIntegrationInputSchema>;

export const LangSmithConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  sampleRunCount: z.number().int().nonnegative().optional(),
  status: z.number().int().positive().optional(),
  error: z.string().optional()
});
export type LangSmithConnectionTestResult = z.infer<typeof LangSmithConnectionTestResultSchema>;

export const LangSmithIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("langsmith"),
  skillVersionId: z.string().nullable(),
  projectName: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: LangSmithConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type LangSmithIntegration = z.infer<typeof LangSmithIntegrationSchema>;

export const LangfuseIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
  endpointUrl: z.url().optional(),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type LangfuseIntegrationInput = z.infer<typeof LangfuseIntegrationInputSchema>;

export const UpdateLangfuseIntegrationInputSchema = UpdateLangSmithIntegrationInputSchema;
export type UpdateLangfuseIntegrationInput = z.infer<typeof UpdateLangfuseIntegrationInputSchema>;

export const LangfuseConnectionTestResultSchema = LangSmithConnectionTestResultSchema;
export type LangfuseConnectionTestResult = z.infer<typeof LangfuseConnectionTestResultSchema>;

export const LangfuseIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("langfuse"),
  skillVersionId: z.string().nullable(),
  projectName: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: LangfuseConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type LangfuseIntegration = z.infer<typeof LangfuseIntegrationSchema>;

export const IRONSIDE_EVALUATOR_PROTOCOL_VERSION = "ironside/evaluator/v1" as const;

export const IronsideEvaluatorContextSchema = z.object({
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  // Capability names are additive. Require the two native evaluator grants
  // in the client, but tolerate future unrelated capabilities on the key.
  capabilities: z.array(z.string().min(1)),
  settlement: z.object({
    kind: z.literal("quiet_period"),
    quietPeriodSeconds: z.number().int().nonnegative()
  })
});
export type IronsideEvaluatorContext = z.infer<typeof IronsideEvaluatorContextSchema>;

export const IronsideEvaluatorTraceSummarySchema = z.object({
  traceId: z.string().min(1),
  traceVersion: z.iso.datetime({ offset: true }),
  timestamp: z.iso.datetime({ offset: true }),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string())
});
export type IronsideEvaluatorTraceSummary = z.infer<typeof IronsideEvaluatorTraceSummarySchema>;

export const IronsideEvaluatorTraceFeedSchema = z.object({
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  traces: z.array(IronsideEvaluatorTraceSummarySchema),
  nextCursor: z.string().min(1),
  hasMore: z.boolean()
});
export type IronsideEvaluatorTraceFeed = z.infer<typeof IronsideEvaluatorTraceFeedSchema>;

export interface IronsideEvaluatorObservationNode {
  id: string;
  parentObservationId?: string | null | undefined;
  type: string;
  name?: string | null | undefined;
  startTime: string;
  endTime?: string | null | undefined;
  level?: string | null | undefined;
  statusMessage?: string | null | undefined;
  model?: string | null | undefined;
  modelParameters?: Record<string, string> | undefined;
  input?: unknown;
  output?: unknown;
  usageDetails?: Record<string, number> | undefined;
  costDetails?: Record<string, number> | undefined;
  completionStartTime?: string | null | undefined;
  metadata?: Record<string, string> | undefined;
  children: IronsideEvaluatorObservationNode[];
}

export const IronsideEvaluatorObservationNodeSchema: z.ZodType<IronsideEvaluatorObservationNode> = z.lazy(() => z.object({
  id: z.string(),
  parentObservationId: z.string().nullish(),
  type: z.string(),
  name: z.string().nullish(),
  startTime: z.string(),
  endTime: z.string().nullish(),
  level: z.string().nullish(),
  statusMessage: z.string().nullish(),
  model: z.string().nullish(),
  modelParameters: z.record(z.string(), z.string()).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  usageDetails: z.record(z.string(), z.number()).optional(),
  costDetails: z.record(z.string(), z.number()).optional(),
  completionStartTime: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).optional(),
  children: z.array(IronsideEvaluatorObservationNodeSchema)
}));

export const IronsideEvaluatorTraceSchema = z.object({
  id: z.string().min(1),
  traceVersion: z.iso.datetime({ offset: true }),
  timestamp: z.iso.datetime({ offset: true }),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  release: z.string().nullable(),
  version: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string()),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  observations: z.array(IronsideEvaluatorObservationNodeSchema)
});
export type IronsideEvaluatorTrace = z.infer<typeof IronsideEvaluatorTraceSchema>;

// A native connection is one Ironside project plus a scoped machine key. The
// remote service owns settlement and exposes immutable trace versions; Coeval
// persists only the opaque continuation cursor it receives from that feed.
export const IronsideIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  url: z.url(),
  apiKey: z.string().min(1),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type IronsideIntegrationInput = z.infer<typeof IronsideIntegrationInputSchema>;

export const UpdateIronsideIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  url: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
}).refine((input) => Object.keys(input).length > 0, {
  message: "At least one Ironside integration setting is required"
});
export type UpdateIronsideIntegrationInput = z.infer<typeof UpdateIronsideIntegrationInputSchema>;

export const IronsideConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  status: z.number().int().positive().optional(),
  error: z.string().optional(),
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION).optional(),
  remoteProjectId: z.string().min(1).optional(),
  remoteProjectName: z.string().min(1).optional()
});
export type IronsideConnectionTestResult = z.infer<typeof IronsideConnectionTestResultSchema>;

export const IronsideIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("ironside"),
  skillVersionId: z.string().nullable(),
  url: z.string(),
  remoteProjectId: z.string().min(1),
  remoteProjectName: z.string().min(1),
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  settlementQuietPeriodSeconds: z.number().int().nonnegative(),
  revalidationRequired: z.boolean(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: IronsideConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type IronsideIntegration = z.infer<typeof IronsideIntegrationSchema>;

// The cursor is intentionally opaque: ordering, settlement, bootstrap and
// recovery remain Ironside concerns rather than duplicated Coeval policy.
export const IronsideSyncStateSchema = z.object({
  cursor: z.string().nullable()
});
export type IronsideSyncState = z.infer<typeof IronsideSyncStateSchema>;

export const LangSmithImportJobSchema = z.object({
  projectId: z.string(),
  integrationId: z.string(),
  skillVersionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(25),
  importJobId: z.string().optional()
});
export type LangSmithImportJob = z.infer<typeof LangSmithImportJobSchema>;

export const LangSmithImportTargetSchema = z.object({
  projectId: z.string(),
  integrationId: z.string(),
  skillVersionId: z.string().min(1),
  limit: z.number().int().positive().max(100)
});
export type LangSmithImportTarget = z.infer<typeof LangSmithImportTargetSchema>;

export const LangSmithImportRequestSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(25)
});
export type LangSmithImportRequest = z.infer<typeof LangSmithImportRequestSchema>;

export const LangfuseImportJobSchema = LangSmithImportJobSchema;
export type LangfuseImportJob = z.infer<typeof LangfuseImportJobSchema>;

export const LangfuseImportTargetSchema = LangSmithImportTargetSchema;
export type LangfuseImportTarget = z.infer<typeof LangfuseImportTargetSchema>;

export const LangfuseImportRequestSchema = LangSmithImportRequestSchema;
export type LangfuseImportRequest = z.infer<typeof LangfuseImportRequestSchema>;

export const IronsideImportJobSchema = LangSmithImportJobSchema;
export type IronsideImportJob = z.infer<typeof IronsideImportJobSchema>;

export const IronsideImportTargetSchema = LangSmithImportTargetSchema;
export type IronsideImportTarget = z.infer<typeof IronsideImportTargetSchema>;

export const IronsideImportRequestSchema = LangSmithImportRequestSchema;
export type IronsideImportRequest = z.infer<typeof IronsideImportRequestSchema>;

export const ImportJobStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;

export const ImportJobRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: TraceSourceSchema,
  sourceIntegrationId: z.string().nullable(),
  // Null only for a terminal failed scheduling attempt that could not select
  // one evaluator safely (for example an unconfigured multi-criterion poller).
  skillVersionId: z.string().min(1).nullable(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorName: z.string().nullable(),
  queueJobId: z.string().nullable(),
  status: ImportJobStatusSchema,
  requestedLimit: z.number().int().positive().nullable(),
  importedCount: z.number().int().nonnegative(),
  queuedJudgeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable()
});
export type ImportJobRecord = z.infer<typeof ImportJobRecordSchema>;

export const LangSmithImportEnqueueResultSchema = z.object({
  queued: z.boolean(),
  queueJobId: z.string().nullable(),
  importJob: ImportJobRecordSchema
});
export type LangSmithImportEnqueueResult = z.infer<typeof LangSmithImportEnqueueResultSchema>;

export const LangfuseImportEnqueueResultSchema = LangSmithImportEnqueueResultSchema;
export type LangfuseImportEnqueueResult = z.infer<typeof LangfuseImportEnqueueResultSchema>;

export const IronsideImportEnqueueResultSchema = LangSmithImportEnqueueResultSchema;
export type IronsideImportEnqueueResult = z.infer<typeof IronsideImportEnqueueResultSchema>;

export const JudgeRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string(),
  verdict: VerdictLabelSchema,
  score: z.number().min(0).max(1),
  reasoning: z.string(),
  // Wall-clock duration of the provider call when the provider execution path
  // captures it; other current run sources may not report a duration.
  latencyMs: z.number().int().nonnegative().optional(),
  // Provider-observed response identity. Null fields mean the provider did
  // not report that datum; this is distinct from the requested model binding.
  providerMetadata: ProviderResponseMetadataSchema.optional(),
  createdAt: z.string()
});
export type JudgeRun = z.infer<typeof JudgeRunSchema>;

// the case's dataset expectations — YOUR labels (never reviews),
// listed per dataset because a case can sit in several with different labels;
// showing all of them beats silently picking one.
export const CaseDatasetExpectationSchema = z.object({
  datasetName: z.string(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  expectedFailStep: z.number().int().nonnegative().nullable()
});
export type CaseDatasetExpectation = z.infer<typeof CaseDatasetExpectationSchema>;

export const GoldenSetEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  reason: z.string(),
  promotedBy: z.string(),
  promotedAt: z.string(),
  sourceSkillVersionId: z.string(),
  criterionVersionId: z.string()
});
export type GoldenSetEntry = z.infer<typeof GoldenSetEntrySchema>;

export const ExceptionDetailSchema = z.object({
  exception: ExceptionCaseSchema,
  trace: TracePayloadSchema,
  judgeRun: JudgeRunSchema,
  datasetExpectations: z.array(CaseDatasetExpectationSchema),
  // Label of the latest human or adjudicated verdict on the case, when one
  // exists. Review surfaces must prefer this over the judge's label anywhere
  // a human decision is being frozen (golden-set promotion) — a recorded
  // override outranks the verdict it overrode.
  latestHumanLabel: VerdictLabelSchema.nullish(),
  // Append-only legacy decision evidence shown on the case: evaluator outputs
  // plus human and owner rulings. The effective human ruling is projected with
  // effectiveHumanVerdict; callers must not silently treat an evaluator output
  // or a later plain-human row as outranking an owner adjudication.
  verdictHistory: z.array(VerdictRecordSchema),
  // Active regression reference for this exact case and criterion, when one
  // exists. This is intentionally separate from the human-ruling evidence.
  goldenSetEntry: GoldenSetEntrySchema.nullable(),
  rawRequest: z.unknown().optional(),
  rawResponse: z.unknown().optional()
});
export type ExceptionDetail = z.infer<typeof ExceptionDetailSchema>;

// Single-sourced cap for project-scope verdict listing: the web's audit-trail
// page requests exactly this, and the API validates against it — sharing the
// constant keeps a client bump from turning into a 400 on the whole screen.
export const VERDICT_LIST_MAX_LIMIT = 500;

export const GOLDEN_SET_REASON_MAX_LENGTH = 1000;

export const PromoteGoldenSetInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  reason: z.string().min(1).max(GOLDEN_SET_REASON_MAX_LENGTH)
});
export type PromoteGoldenSetInput = z.infer<typeof PromoteGoldenSetInputSchema>;

export const RetireGoldenSetEntryInputSchema = z.object({
  reason: z.string().min(1).max(GOLDEN_SET_REASON_MAX_LENGTH).optional()
});
export type RetireGoldenSetEntryInput = z.infer<typeof RetireGoldenSetEntryInputSchema>;

export const GoldenSetRetirementContextSchema = z.object({
  retiredAt: z.string().nullable(),
  retiredByUserId: z.string().nullable(),
  retiredBy: z.string().nullable(),
  reason: z.string().nullable()
});
export type GoldenSetRetirementContext = z.infer<typeof GoldenSetRetirementContextSchema>;

export const JudgeRunJobSchema = z.object({
  projectId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string().optional(),
  evalRunId: z.string().optional(),
  evalRunItemId: z.string().optional()
}).superRefine((value, context) => {
  if ((value.evalRunId === undefined) !== (value.evalRunItemId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "evalRunId and evalRunItemId must be supplied together"
    });
  }
});
export type JudgeRunJob = z.infer<typeof JudgeRunJobSchema>;

export const FeedbackSyncJobSchema = z.object({
  projectId: z.string(),
  feedbackSyncJobId: z.string()
});
export type FeedbackSyncJob = z.infer<typeof FeedbackSyncJobSchema>;

// eval.run fans out one eval.item per pending run item; each item job judges
// one case via judgeAndRecord and atomically updates the run's counters.
// gate.run payload (M0 C5): executes the golden-set regression gate for a
// pending (calibrating) skill version asynchronously. timeScope rides along so
// the worker can create the existing/both backfill EvalRun AFTER the gate
// outcome is known (a blocked version must never judge traffic).
export const GateRunJobSchema = z.object({
  projectId: z.string(),
  skillVersionId: z.string(),
  datasetRevisionId: z.string(),
  overrideReason: z.string().optional(),
  actorUserId: z.string().optional(),
  timeScope: z.enum(["new", "existing", "both"])
});
export type GateRunJob = z.infer<typeof GateRunJobSchema>;

export const EvalRunJobSchema = z.object({
  projectId: z.string(),
  evalRunId: z.string()
});
export type EvalRunJob = z.infer<typeof EvalRunJobSchema>;

export const EvalItemJobSchema = z.object({
  projectId: z.string(),
  evalRunId: z.string(),
  evalRunItemId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string()
});
export type EvalItemJob = z.infer<typeof EvalItemJobSchema>;

export const FeedbackSyncStatusSchema = z.enum(["pending", "sending", "synced", "failed", "blocked"]);
export type FeedbackSyncStatus = z.infer<typeof FeedbackSyncStatusSchema>;

export const FeedbackSyncJobListItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  judgeRunId: z.string(),
  provider: z.enum(["langsmith", "langfuse", "ironside"]),
  status: FeedbackSyncStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.string()
});
export type FeedbackSyncJobListItem = z.infer<typeof FeedbackSyncJobListItemSchema>;

export const GOLDEN_SET_STALE_AFTER_DAYS = 90;

export const GoldenSetHealthStatusSchema = z.enum(["healthy", "needs_action"]);
export type GoldenSetHealthStatus = z.infer<typeof GoldenSetHealthStatusSchema>;

export const GoldenSetHealthEntrySchema = z.object({
  id: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  promotedAt: z.string(),
  ageDays: z.number().int().nonnegative(),
  reason: z.string()
});
export type GoldenSetHealthEntry = z.infer<typeof GoldenSetHealthEntrySchema>;

export const GoldenSetDuplicateGroupSchema = z.object({
  traceId: z.string(),
  entryCount: z.number().int().min(2),
  entries: z.array(GoldenSetHealthEntrySchema)
});
export type GoldenSetDuplicateGroup = z.infer<typeof GoldenSetDuplicateGroupSchema>;

export const GoldenSetHealthSummarySchema = z.object({
  projectId: z.string(),
  status: GoldenSetHealthStatusSchema,
  totalActive: z.number().int().nonnegative(),
  // Server-authoritative threshold; can become project-specific without changing clients.
  staleAfterDays: z.number().int().positive(),
  staleCount: z.number().int().nonnegative(),
  freshCount: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  oldestPromotedAt: z.string().nullable(),
  newestPromotedAt: z.string().nullable(),
  staleEntries: z.array(GoldenSetHealthEntrySchema),
  duplicateCount: z.number().int().nonnegative(),
  duplicateGroups: z.array(GoldenSetDuplicateGroupSchema),
  recommendations: z.array(z.string())
});
export type GoldenSetHealthSummary = z.infer<typeof GoldenSetHealthSummarySchema>;

// the trust digest — four recorded-evidence signals + drift nudges.
// Every signal is one signal among several (never composited); empty states
// are explicit "no signal yet" facts, never fabricated numbers.
export const TrustNudgeSchema = z.object({
  signal: z.enum(["golden_health", "judge_human_kappa", "self_consistency"]),
  // A recorded-evidence sentence with counts.
  sentence: z.string(),
  // What would prove this wrong — the falsifier travels with the nudge.
  falsifier: z.string()
});
export type TrustNudge = z.infer<typeof TrustNudgeSchema>;

export const TrustDigestSpendSchema = z.object({
  // The aggregation window constant, echoed so the UI never hardcodes it.
  windowRuns: z.number().int().positive(),
  runsCounted: z.number().int().nonnegative(),
  freshItems: z.number().int().nonnegative(),
  cachedItems: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  usageMissingCount: z.number().int().nonnegative()
});
export type TrustDigestSpend = z.infer<typeof TrustDigestSpendSchema>;

export const TrustDigestSchema = z.object({
  generatedAt: z.string(),
  skillVersionId: z.string(),
  version: z.string(),
  goldenSetHealth: GoldenSetHealthSummarySchema,
  // κ pairs for the CURRENT version's judge rater vs each human (A2.2c:
  // pinned to the version, never latest-wins).
  judgeHumanKappa: z.array(z.object({
    humanRater: z.string(),
    kappa: z.number(),
    interpretation: KappaInterpretationSchema,
    cases: z.number().int().nonnegative()
  })),
  selfConsistency: SelfConsistencyReportSchema,
  spend: TrustDigestSpendSchema,
  nudges: z.array(TrustNudgeSchema),
  // "No signal yet" facts for absent signals — explicit, never implied.
  noSignal: z.array(z.string())
});
export type TrustDigest = z.infer<typeof TrustDigestSchema>;


export const DashboardSummarySchema = z.object({
  project: ProjectSchema,
  skill: SkillSchema,
  // Exact successful coverage for the evaluator version shown in `skill`.
  // `project.autoJudgedTraceCount` is intentionally historical/project-wide
  // and cannot prove that this version has produced a Result.
  currentVersionResultCount: z.number().int().nonnegative(),
  verdictDistribution: VerdictDistributionSchema,
  exceptions: z.array(ExceptionCaseSchema),
  topCapabilityGaps: z.array(CapabilityGapSchema),
  goldenSetSize: z.number().int().nonnegative(),
  // Lets owner-only affordances (agent pairing) hide from members instead of
  // rendering a guaranteed-403 card.
  viewerRole: z.enum(["owner", "member"])
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

// time-scope on skill edits. Per Langfuse's evaluator time-scope
// (docs/08, high-priority borrow #5). "new" is the product default.
// "existing" + "both" create one durable backfill EvalRun over project cases
// against the new skill version.
export const SkillVersionTimeScopeSchema = z.enum(["new", "existing", "both"]);
export type SkillVersionTimeScope = z.infer<typeof SkillVersionTimeScopeSchema>;

export const CreateSkillVersionInputSchema = z
  .object({
    criterionVersionId: z.string().min(1).optional(),
    rubricMarkdown: z.string().min(1),
    prompt: z.string().min(1),
    modelBinding: ModelBindingInputSchema,
    outputSchema: JsonSchemaSchema.default(MinimumVerdictOutputSchema),
    verdictKind: VerdictKindSchema.default("binary"),
    scalarRange: z.tuple([z.number(), z.number()]).optional(),
    categoricalChoiceScores: z.record(z.string(), z.number().min(0).max(1)).optional(),
    timeScope: SkillVersionTimeScopeSchema.default("new"),
    overrideReason: z.string().optional()
  })
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Evaluator input must not contain an unpaired UTF-16 surrogate"
  })
  .refine(
    (v) => v.verdictKind !== "scalar" || (v.scalarRange !== undefined && v.scalarRange[0] < v.scalarRange[1]),
    { message: "scalar skill versions require an ascending scalarRange" }
  )
  .refine(
    (v) => v.verdictKind !== "categorical" || (v.categoricalChoiceScores !== undefined && Object.keys(v.categoricalChoiceScores).length > 0),
    { message: "categorical skill versions require a non-empty categoricalChoiceScores map" }
  )
  .refine((v) => v.verdictKind === "scalar" || v.scalarRange === undefined, { message: "scalarRange is only valid for scalar kinds" })
  .refine((v) => v.verdictKind === "categorical" || v.categoricalChoiceScores === undefined, { message: "categoricalChoiceScores is only valid for categorical kinds" });
export type CreateSkillVersionInput = z.infer<typeof CreateSkillVersionInputSchema>;

// Beginner onboarding creates the first real Check over the project's seeded
// native criterion. The visible quality question and evaluator draft travel in
// one request so the repository can append the criterion definition and bind
// the evaluator version atomically. Ordinary evaluator edits keep using
// CreateSkillVersionInputSchema and cannot change criterion identity.
export const CreateOnboardingCheckInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(240),
  criterion: CreateCriterionVersionInputSchema,
  evaluator: CreateSkillVersionInputSchema
}).strict().superRefine((value, context) => {
  if (value.evaluator.criterionVersionId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["evaluator", "criterionVersionId"],
      message: "Onboarding creates and binds its own criterion version"
    });
  }
  if (value.evaluator.overrideReason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["evaluator", "overrideReason"],
      message: "Onboarding cannot override a regression result"
    });
  }
});
export type CreateOnboardingCheckInput = z.infer<typeof CreateOnboardingCheckInputSchema>;

// Exact, project-scoped inventory shown before the beginner creates a Check.
// Counts describe the customer Runs currently stored after ingestion
// redaction; they do not imply that missing fields can be reconstructed.
export const OnboardingEvidenceInventorySchema = z.object({
  runCount: z.number().int().nonnegative(),
  inputCount: z.number().int().nonnegative(),
  outputCount: z.number().int().nonnegative(),
  stepsCount: z.number().int().nonnegative(),
  metadataCount: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  for (const field of ["inputCount", "outputCount", "stepsCount", "metadataCount"] as const) {
    if (value[field] > value.runCount) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} cannot exceed runCount`
      });
    }
  }
});
export type OnboardingEvidenceInventory = z.infer<typeof OnboardingEvidenceInventorySchema>;

// Backfill summary returned alongside the regression run when timeScope is
// 'existing' or 'both'. This aggregate is retained for the synchronous demo
// response; the EvalRun is the authoritative lifecycle record.
export const SkillVersionBackfillSummarySchema = z.object({
  timeScope: SkillVersionTimeScopeSchema,
  cases: z.number().int().nonnegative(),
  enqueued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative()
});
export type SkillVersionBackfillSummary = z.infer<typeof SkillVersionBackfillSummarySchema>;

// Per-case detail from a golden-set regression run. The gate's "teeth": a CI
// tool that says "3 cases regressed" without showing WHICH and HOW the verdict
// changed isn't usable CI. `change` classifies each compared case:
//   regress  — the new version disagrees with the golden-set agreed label
//   agree    — the new version still matches the agreed label
//   improve  — RESERVED: matched the agreed label where the PRIOR version did
//              not. Not emitted yet — computing it requires loading the previous
//              version's per-case verdict, which lands with the convergence loop
//              (roadmap A2). Until then every match is `agree`, not `improve`.
export const RegressionCaseChangeSchema = z.enum(["regress", "agree", "improve"]);
export type RegressionCaseChange = z.infer<typeof RegressionCaseChangeSchema>;

// Persisted + returned rationale is capped: the full judge reasoning already
// lives on the JudgeRun. The diff only needs a readable snippet, and an
// uncapped field × a 500-case golden set would bloat the JSONB row.
export const REGRESSION_RATIONALE_MAX_LENGTH = 280;

export const RegressionCaseDiffSchema = z.object({
  caseId: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  newLabel: VerdictLabelSchema,
  change: RegressionCaseChangeSchema,
  rationale: z.string().max(REGRESSION_RATIONALE_MAX_LENGTH)
});
export type RegressionCaseDiff = z.infer<typeof RegressionCaseDiffSchema>;

// Direction split of a run's regressions. Golden labels are pass|fail only,
// so every regression is exactly one of: judge stricter than the team
// (agreed pass, judged fail), judge more lenient (agreed fail, judged pass),
// or judge hedging (judged ambiguous against either label). The three buckets
// sum to `regressed` — lumping them all into "strict" misreads lenient flips,
// which are the dangerous direction for a gate.
export function regressionDirectionCounts(cases: RegressionCaseDiff[]): {
  tooStrict: number;
  tooLenient: number;
  ambiguous: number;
} {
  let tooStrict = 0;
  let tooLenient = 0;
  let ambiguous = 0;
  for (const diff of cases) {
    if (diff.change !== "regress") continue;
    if (diff.newLabel === "ambiguous") ambiguous += 1;
    else if (diff.agreedLabel === "pass") tooStrict += 1;
    else tooLenient += 1;
  }
  return { tooStrict, tooLenient, ambiguous };
}

export const RegressionRunResultSchema = z.object({
  id: z.string(),
  skillVersionId: z.string(),
  datasetRevisionId: z.string(),
  status: z.enum(["passed", "blocked", "overridden", "error"]),
  compared: z.number().int().nonnegative(),
  regressed: z.number().int().nonnegative(),
  improved: z.number().int().nonnegative(),
  flipped: z.number().int().nonnegative(),
  overrideReason: z.string().optional(),
  error: z.string().nullable().optional(),
  goldenSetMissing: z.boolean(),
  // Per-case breakdown emitted for every current regression run.
  cases: z.array(RegressionCaseDiffSchema),
  createdAt: z.string()
});
export type RegressionRunResult = z.infer<typeof RegressionRunResultSchema>;

export const CreateOnboardingCheckResponseSchema = z.discriminatedUnion("queued", [
  z.object({
    criterionVersion: CriterionVersionSchema,
    version: SkillVersionSchema,
    regressionRun: z.null(),
    queued: z.literal(true)
  }).strict(),
  z.object({
    criterionVersion: CriterionVersionSchema,
    version: SkillVersionSchema,
    regressionRun: RegressionRunResultSchema,
    queued: z.literal(false)
  }).strict()
]);
export type CreateOnboardingCheckResponse = z.infer<typeof CreateOnboardingCheckResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional()
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// Governed human truth (ADR-0008). These contracts are deliberately separate
// from the legacy verdict and annotation-queue shapes above: historical rows
// cannot be inferred to have been independently assigned or evaluator-blind.
const governedNonBlankString = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" });

export const GovernedReviewLabelValueSchema = z.enum(["pass", "fail", "cannot_determine"]);
export type GovernedReviewLabelValue = z.infer<typeof GovernedReviewLabelValueSchema>;

export const GovernedReviewActorSnapshotSchema = z.object({
  subjectId: z.string().min(1),
  roleAtReview: governedNonBlankString(100)
}).strict();
export type GovernedReviewActorSnapshot = z.infer<typeof GovernedReviewActorSnapshotSchema>;

export const GovernedReviewRoleIntentSchema = z.enum([
  "analysis_authoring",
  "iterative_development",
  "sealed_validation"
]);
export type GovernedReviewRoleIntent = z.infer<typeof GovernedReviewRoleIntentSchema>;

export const GovernedReviewSelectionMethodSchema = z.enum([
  "simple_random",
  "stratified_random",
  "systematic",
  "convenience",
  "uncertainty",
  "failure_hunting",
  "manual"
]);
export type GovernedReviewSelectionMethod = z.infer<typeof GovernedReviewSelectionMethodSchema>;

export const GovernedReviewInstructionVersionSchema = z.object({
  contract: z.literal("coeval/governed-review-instruction/v1"),
  schemaVersion: z.literal(1),
  instructionVersionId: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  revision: z.number().int().positive(),
  predecessorInstructionVersionId: z.string().min(1).nullable(),
  title: governedNonBlankString(240),
  instructions: governedNonBlankString(100_000),
  failureCodeGuidance: z.string().max(50_000),
  allowedLabels: z.tuple([
    z.literal("pass"),
    z.literal("fail"),
    z.literal("cannot_determine")
  ]),
  instructionDigest: DatasetEvidenceDigestSchema,
  createdBySubjectId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true })
}).strict();
export type GovernedReviewInstructionVersion = z.infer<typeof GovernedReviewInstructionVersionSchema>;

export const GovernedReviewItemSourceKindSchema = z.enum(["dataset_revision_item", "sealed_intake"]);
export type GovernedReviewItemSourceKind = z.infer<typeof GovernedReviewItemSourceKindSchema>;

// This is the complete reviewer-visible data surface. It is intentionally
// narrower than DatasetRevisionPayloadSnapshotSchema: source metadata and
// step metadata are never copied into governed review evidence.
export const GovernedReviewPayloadStepSchema = z.object({
  name: governedNonBlankString(200),
  input: z.json(),
  output: z.json()
}).strict();
export type GovernedReviewPayloadStep = z.infer<typeof GovernedReviewPayloadStepSchema>;

export const GovernedReviewPayloadSnapshotSchema = z.object({
  // The pure verifier additionally enforces a 2 MiB canonical JSON limit.
  input: z.json(),
  output: z.json(),
  steps: z.array(GovernedReviewPayloadStepSchema).max(1_000).optional()
}).strict();
export type GovernedReviewPayloadSnapshot = z.infer<typeof GovernedReviewPayloadSnapshotSchema>;

export const GovernedReviewItemSchema = z.object({
  contract: z.literal("coeval/governed-review-item/v1"),
  schemaVersion: z.literal(1),
  reviewItemId: z.string().min(1),
  projectId: z.string().min(1),
  sourceKind: GovernedReviewItemSourceKindSchema,
  sourceRevisionId: z.string().min(1).nullable(),
  sourceRevisionItemId: z.string().min(1).nullable(),
  sourceItemDigest: DatasetEvidenceDigestSchema.nullable(),
  sealedIntakePopulationId: z.string().min(1).nullable(),
  inputIdentityBasis: z.literal("input-identity/v1"),
  inputDigest: DatasetEvidenceDigestSchema,
  payloadSnapshot: GovernedReviewPayloadSnapshotSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (value.sourceKind === "dataset_revision_item") {
    if (
      value.sourceRevisionId === null ||
      value.sourceRevisionItemId === null ||
      value.sourceItemDigest === null
    ) {
      ctx.addIssue({ code: "custom", path: ["sourceRevisionItemId"], message: "nonsealed review items require an exact immutable dataset revision item" });
    }
    if (value.sealedIntakePopulationId !== null) {
      ctx.addIssue({ code: "custom", path: ["sealedIntakePopulationId"], message: "nonsealed review items cannot name sealed intake" });
    }
  } else {
    if (value.sealedIntakePopulationId === null) {
      ctx.addIssue({ code: "custom", path: ["sealedIntakePopulationId"], message: "sealed review items require sealed intake identity" });
    }
    if (
      value.sourceRevisionId !== null ||
      value.sourceRevisionItemId !== null ||
      value.sourceItemDigest !== null
    ) {
      ctx.addIssue({ code: "custom", path: ["sourceRevisionItemId"], message: "sealed intake cannot bind an ordinary dataset revision item" });
    }
  }
});
export type GovernedReviewItem = z.infer<typeof GovernedReviewItemSchema>;

export const GovernedReviewSelectionStratumSchema = z.object({
  key: governedNonBlankString(240),
  definition: governedNonBlankString(20_000),
  populationSize: z.number().int().nonnegative(),
  membershipDigest: DatasetEvidenceDigestSchema,
  inclusionProbability: z.number().positive().max(1),
  weight: z.number().positive(),
  fixedBudget: z.number().int().nonnegative(),
  drawItemDigests: z.array(DatasetEvidenceDigestSchema).max(10_000),
  drawDigest: DatasetEvidenceDigestSchema
}).strict();
export type GovernedReviewSelectionStratum = z.infer<typeof GovernedReviewSelectionStratumSchema>;

export const GovernedReviewSelectionPlanSchema = z.object({
  contract: z.literal("coeval/governed-review-selection/v1"),
  schemaVersion: z.literal(1),
  method: GovernedReviewSelectionMethodSchema,
  sourcePopulationId: z.string().min(1),
  sourcePopulationDefinition: governedNonBlankString(20_000),
  timeWindow: z.object({
    startInclusive: z.string().datetime({ offset: true }),
    endExclusive: z.string().datetime({ offset: true })
  }).strict(),
  populationSize: z.number().int().positive(),
  populationDigest: DatasetEvidenceDigestSchema,
  collectionProvenance: z.json(),
  collectionProvenanceDigest: DatasetEvidenceDigestSchema,
  frozenFrameDigest: DatasetEvidenceDigestSchema,
  seed: z.string().min(1).nullable(),
  rngVersion: z.string().min(1).nullable(),
  selectionAlgorithmVersion: z.string().min(1).max(200),
  inclusionProbability: z.number().positive().max(1).nullable(),
  weight: z.number().positive().nullable(),
  fixedBudget: z.number().int().positive(),
  stoppingRule: z.literal("fixed"),
  drawExecutor: z.literal("coeval_server"),
  drawItemDigests: z.array(DatasetEvidenceDigestSchema).min(1).max(10_000),
  drawDigest: DatasetEvidenceDigestSchema,
  strata: z.array(GovernedReviewSelectionStratumSchema).max(1_000),
  selectionPlanDigest: DatasetEvidenceDigestSchema
}).strict();
export type GovernedReviewSelectionPlan = z.infer<typeof GovernedReviewSelectionPlanSchema>;

export const GovernedReviewBatchMemberSchema = z.object({
  reviewItemId: z.string().min(1),
  reviewItemDigest: DatasetEvidenceDigestSchema,
  servePosition: z.number().int().nonnegative(),
  taskIds: z.array(z.string().min(1)).min(1).max(20)
}).strict();
export type GovernedReviewBatchMember = z.infer<typeof GovernedReviewBatchMemberSchema>;

export const GovernedReviewBatchSchema = z.object({
  contract: z.literal("coeval/governed-review-batch/v1"),
  schemaVersion: z.literal(1),
  batchId: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  instructionDigest: DatasetEvidenceDigestSchema,
  roleIntent: GovernedReviewRoleIntentSchema,
  sourcePopulationKind: z.enum(["dataset_revision", "analysis_promotion_handoff", "sealed_intake"]),
  selectionPlan: GovernedReviewSelectionPlanSchema,
  requiredIndependentLabels: z.number().int().positive().max(20),
  evaluatorBlind: z.boolean(),
  peerBlindUntilLabelingClosed: z.boolean(),
  separationOfDutiesRequired: z.boolean(),
  custodianSubjectId: z.string().min(1),
  custodianRoleAtReview: governedNonBlankString(100).nullable(),
  developmentIdentityStatus: z.enum(["resolved", "unknown"]),
  developmentCapabilitySubjectIds: z.array(z.string().min(1).max(240)).max(10_000),
  developmentExposureSubjectIds: z.array(z.string().min(1).max(240)).max(10_000),
  stateMachineVersion: z.literal("governed-review-state/v1"),
  idempotencyKey: z.string().min(1).max(200),
  requestDigest: DatasetEvidenceDigestSchema,
  members: z.array(GovernedReviewBatchMemberSchema).min(1).max(10_000),
  batchDigest: DatasetEvidenceDigestSchema,
  fixedStopAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true })
}).strict().superRefine((batch, ctx) => {
  const validSource = batch.roleIntent === "sealed_validation"
    ? batch.sourcePopulationKind === "sealed_intake"
    : batch.roleIntent === "iterative_development"
      ? batch.sourcePopulationKind === "dataset_revision"
      : batch.sourcePopulationKind !== "sealed_intake";
  if (!validSource) {
    ctx.addIssue({
      code: "custom",
      path: ["sourcePopulationKind"],
      message: "Governed review source kind must match its exact role intent"
    });
  }
});
export type GovernedReviewBatch = z.infer<typeof GovernedReviewBatchSchema>;

export const GovernedReviewTaskSchema = z.object({
  contract: z.literal("coeval/governed-review-task/v1"),
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  reviewerSubjectId: z.string().min(1),
  reviewerRoleAtReview: governedNonBlankString(100),
  assignmentOrdinal: z.number().int().nonnegative(),
  servePosition: z.number().int().nonnegative(),
  taskDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict();
export type GovernedReviewTask = z.infer<typeof GovernedReviewTaskSchema>;

export const GovernedReviewLabelSchema = z.object({
  contract: z.literal("coeval/governed-review-label/v1"),
  schemaVersion: z.literal(1),
  labelId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  taskId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  reviewerSubjectId: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  replacesLabelId: z.string().min(1).nullable(),
  value: GovernedReviewLabelValueSchema,
  rationale: governedNonBlankString(20_000),
  failureCodes: z.array(governedNonBlankString(240)).max(100),
  blindViewDigest: DatasetEvidenceDigestSchema,
  labelDigest: DatasetEvidenceDigestSchema,
  submittedAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (new Set(value.failureCodes).size !== value.failureCodes.length) {
    ctx.addIssue({ code: "custom", path: ["failureCodes"], message: "failure codes must be unique" });
  }
  if (value.attemptNumber === 1 && value.replacesLabelId !== null) {
    ctx.addIssue({ code: "custom", path: ["replacesLabelId"], message: "first label attempt cannot replace another label" });
  }
  if (value.attemptNumber > 1 && value.replacesLabelId === null) {
    ctx.addIssue({ code: "custom", path: ["replacesLabelId"], message: "replacement label attempts must name the withdrawn label" });
  }
});
export type GovernedReviewLabel = z.infer<typeof GovernedReviewLabelSchema>;

const GovernedReviewTaskEventBaseSchema = z.object({
  contract: z.literal("coeval/governed-review-task-event/v1"),
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  taskId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  sequence: z.number().int().positive(),
  stateVersion: z.number().int().positive(),
  expectedPreviousStateVersion: z.number().int().nonnegative(),
  actorSubjectId: z.string().min(1),
  actorRoleAtReview: governedNonBlankString(100),
  previousEventDigest: DatasetEvidenceDigestSchema.nullable(),
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export const GovernedReviewTaskEventSchema = z.discriminatedUnion("type", [
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("viewed"),
    viewContractVersion: z.literal("coeval/governed-blind-task-view/v1"),
    canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
    canonicalViewBytesBase64: z.string().min(1).max(2_796_204),
    viewDigest: DatasetEvidenceDigestSchema,
    exposureClass: z.literal("provenance"),
    activity: z.literal("governed_review")
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("deferred"),
    reason: governedNonBlankString(2_000)
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("resumed"),
    reason: governedNonBlankString(2_000).nullable()
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("label_submitted"),
    labelId: z.string().min(1)
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("label_withdrawn"),
    labelId: z.string().min(1),
    reason: governedNonBlankString(2_000)
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("expired"),
    reason: z.literal("fixed_stop_reached")
  }).strict()
]);
export type GovernedReviewTaskEvent = z.infer<typeof GovernedReviewTaskEventSchema>;

export const GovernedReviewBatchStateSchema = z.enum([
  "draft",
  "open",
  "labeling_closed",
  "alignment_open",
  "adjudicating",
  "resolved",
  "abandoned",
  "incomplete",
  "frozen"
]);
export type GovernedReviewBatchState = z.infer<typeof GovernedReviewBatchStateSchema>;

const GovernedReviewBatchEventBaseSchema = z.object({
  contract: z.literal("coeval/governed-review-batch-event/v1"),
  schemaVersion: z.literal(1),
  batchEventId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  sequence: z.number().int().positive(),
  stateVersion: z.number().int().positive(),
  expectedPreviousStateVersion: z.number().int().nonnegative(),
  actorSubjectId: z.string().min(1),
  actorRoleAtReview: governedNonBlankString(100),
  previousEventDigest: DatasetEvidenceDigestSchema.nullable(),
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export const GovernedReviewBatchEventSchema = z.discriminatedUnion("type", [
  GovernedReviewBatchEventBaseSchema.extend({ type: z.literal("opened") }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("labeling_closed"),
    activeLabelIds: z.array(z.string().min(1)).max(200_000),
    deferredTaskIds: z.array(z.string().min(1)).max(200_000),
    expiredTaskIds: z.array(z.string().min(1)).max(200_000),
    closedAtFixedStop: z.boolean()
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({ type: z.literal("alignment_opened") }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({ type: z.literal("adjudication_started") }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("resolved"),
    resolvedReviewItemIds: z.array(z.string().min(1)).min(1).max(10_000)
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("incomplete"),
    gapReviewItemIds: z.array(z.string().min(1)).min(1).max(10_000)
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("frozen"),
    datasetRevisionId: z.string().min(1),
    representativeOfPopulationId: z.string().min(1).nullable()
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("abandoned"),
    reason: governedNonBlankString(2_000)
  }).strict()
]);
export type GovernedReviewBatchEvent = z.infer<typeof GovernedReviewBatchEventSchema>;

export const GovernedReviewAlignmentEventSchema = z.object({
  contract: z.literal("coeval/governed-review-alignment-event/v1"),
  schemaVersion: z.literal(1),
  alignmentEventId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  sequence: z.number().int().positive(),
  expectedPreviousSequence: z.number().int().nonnegative(),
  actorSubjectId: z.string().min(1),
  actorRoleAtReview: governedNonBlankString(100),
  visibleActiveLabelIds: z.array(z.string().min(1)).max(200_000),
  kind: z.enum(["comment_recorded", "instruction_change_proposed", "closed"]),
  content: governedNonBlankString(20_000),
  previousEventDigest: DatasetEvidenceDigestSchema.nullable(),
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: z.string().datetime({ offset: true })
}).strict();
export type GovernedReviewAlignmentEvent = z.infer<typeof GovernedReviewAlignmentEventSchema>;

export const GovernedReviewAdjudicationSchema = z.object({
  contract: z.literal("coeval/governed-review-adjudication/v1"),
  schemaVersion: z.literal(1),
  adjudicationId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  adjudicatorSubjectId: z.string().min(1),
  adjudicatorRoleAtReview: governedNonBlankString(100),
  sequence: z.number().int().positive(),
  expectedPreviousChainVersion: z.number().int().nonnegative(),
  consideredLabelIds: z.array(z.string().min(1)).min(1).max(20),
  decision: z.enum(["pass", "fail", "unresolvable"]),
  rationale: governedNonBlankString(20_000),
  basis: governedNonBlankString(20_000),
  predecessorAdjudicationId: z.string().min(1).nullable(),
  correctionReason: governedNonBlankString(2_000).nullable(),
  adjudicationDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (new Set(value.consideredLabelIds).size !== value.consideredLabelIds.length) {
    ctx.addIssue({ code: "custom", path: ["consideredLabelIds"], message: "considered labels must be unique" });
  }
});
export type GovernedReviewAdjudication = z.infer<typeof GovernedReviewAdjudicationSchema>;

export const ImportedTruthClassificationSchema = z.enum([
  "imported_verified_attested",
  "imported_self_attested",
  "unverified"
]);
export type ImportedTruthClassification = z.infer<typeof ImportedTruthClassificationSchema>;

export const ImportedHumanTruthSchema = z.object({
  contract: z.literal("coeval/imported-human-truth/v1"),
  schemaVersion: z.literal(1),
  importedTruthId: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  issuer: governedNonBlankString(500).nullable(),
  subject: governedNonBlankString(500).nullable(),
  sourceSystem: governedNonBlankString(500).nullable(),
  sourceRecordId: governedNonBlankString(2_000).nullable(),
  sourceDigest: DatasetEvidenceDigestSchema.nullable(),
  sourceArtifact: z.json().nullable(),
  transportMethod: governedNonBlankString(500).nullable(),
  verificationMethod: z.enum([
    "verified_signature",
    "independently_verified_transport",
    "self_attested",
    "unverified"
  ]).nullable(),
  verificationEvidence: z.json().nullable(),
  verificationEvidenceDigest: DatasetEvidenceDigestSchema.nullable(),
  instructionText: governedNonBlankString(100_000).nullable(),
  instructionDigest: DatasetEvidenceDigestSchema.nullable(),
  raters: z.array(GovernedReviewActorSnapshotSchema).max(100),
  label: GovernedReviewLabelValueSchema.nullable(),
  rationale: governedNonBlankString(20_000).nullable(),
  failureCodes: z.array(governedNonBlankString(240)).max(100),
  adjudicatorSubjectId: z.string().min(1).nullable(),
  adjudicationDecision: z.enum(["pass", "fail", "unresolvable"]).nullable(),
  adjudicationRationale: governedNonBlankString(20_000).nullable(),
  blindAttestation: z.object({
    attestedBySubjectId: z.string().min(1),
    statement: governedNonBlankString(20_000),
    attestationDigest: DatasetEvidenceDigestSchema,
    attestedAt: z.string().datetime({ offset: true })
  }).strict().nullable(),
  classification: ImportedTruthClassificationSchema,
  importDigest: DatasetEvidenceDigestSchema,
  importedAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (new Set(value.raters.map((rater) => rater.subjectId)).size !== value.raters.length) {
    ctx.addIssue({ code: "custom", path: ["raters"], message: "imported rater subjects must be unique" });
  }
  if (new Set(value.failureCodes).size !== value.failureCodes.length) {
    ctx.addIssue({ code: "custom", path: ["failureCodes"], message: "failure codes must be unique" });
  }
});
export type ImportedHumanTruth = z.infer<typeof ImportedHumanTruthSchema>;

export const GovernedBlindTaskViewSchema = z.object({
  contract: z.literal("coeval/governed-blind-task-view/v1"),
  schemaVersion: z.literal(1),
  canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
  taskId: z.string().min(1),
  batchId: z.string().min(1),
  servePosition: z.number().int().nonnegative(),
  criterion: z.object({
    criterionId: z.string().min(1),
    criterionVersionId: z.string().min(1),
    name: governedNonBlankString(500),
    definition: governedNonBlankString(100_000),
    criterionDigest: DatasetEvidenceDigestSchema
  }).strict(),
  instruction: z.object({
    instructionVersionId: z.string().min(1),
    title: governedNonBlankString(240),
    instructions: governedNonBlankString(100_000),
    failureCodeGuidance: z.string(),
    allowedLabels: z.tuple([
      z.literal("pass"),
      z.literal("fail"),
      z.literal("cannot_determine")
    ]),
    instructionDigest: DatasetEvidenceDigestSchema
  }).strict(),
  payloadSnapshot: GovernedReviewPayloadSnapshotSchema
}).strict();
export type GovernedBlindTaskView = z.infer<typeof GovernedBlindTaskViewSchema>;

// Relational materialization uses this separate linkage rather than coercing
// pseudonymous governed IDs into DatasetReferenceProvenance's legacy
// verdictIds/actorUserIds fields.
const GovernedDatasetReferenceProvenanceBaseSchema = z.object({
  contract: z.literal("coeval/governed-dataset-reference-provenance/v1"),
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  datasetRevisionId: z.string().min(1),
  datasetRevisionItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  referenceLabel: z.enum(["pass", "fail"]),
  provenanceDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict();

export const GovernedDatasetReferenceProvenanceSchema = z.discriminatedUnion("kind", [
  GovernedDatasetReferenceProvenanceBaseSchema.extend({
    kind: z.literal("governed_labels"),
    batchItemId: z.string().min(1),
    labelIds: z.array(z.string().min(1)).min(1).max(20),
    resolutionBasis: z.enum(["unanimous", "single_rater"])
  }).strict(),
  GovernedDatasetReferenceProvenanceBaseSchema.extend({
    kind: z.literal("adjudication"),
    batchItemId: z.string().min(1),
    adjudicationId: z.string().min(1)
  }).strict(),
  GovernedDatasetReferenceProvenanceBaseSchema.extend({
    kind: z.literal("imported_truth"),
    importedTruthId: z.string().min(1),
    classification: ImportedTruthClassificationSchema
  }).strict()
]);
export type GovernedDatasetReferenceProvenance = z.infer<typeof GovernedDatasetReferenceProvenanceSchema>;

export const GovernedTruthResolutionSchema = z.object({
  status: z.enum(["resolved", "unresolved"]),
  referenceLabel: z.enum(["pass", "fail"]).nullable(),
  basis: z.enum([
    "unanimous",
    "single_rater",
    "adjudicated",
    "coverage_gap",
    "requires_adjudication",
    "unresolvable"
  ]),
  singleRater: z.boolean(),
  consideredLabelIds: z.array(z.string().min(1)),
  requiredIndependentLabels: z.number().int().positive(),
  activeIndependentLabels: z.number().int().nonnegative()
}).strict();
export type GovernedTruthResolution = z.infer<typeof GovernedTruthResolutionSchema>;

export const RepresentativeClaimReasonSchema = z.enum([
  "eligible",
  "selection_method_not_eligible",
  "population_frame_incomplete",
  "collection_provenance_unverified",
  "draw_not_server_executed",
  "draw_not_reproducible",
  "fixed_budget_mismatch",
  "strata_incomplete",
  "review_coverage_incomplete",
  "deferred_assignments",
  "cannot_determine_present",
  "unresolved_items"
]);
export type RepresentativeClaimReason = z.infer<typeof RepresentativeClaimReasonSchema>;

export const RepresentativeClaimEligibilitySchema = z.object({
  representativeClaimEligible: z.boolean(),
  representativeOfPopulationId: z.string().min(1).nullable(),
  reasons: z.array(RepresentativeClaimReasonSchema),
  selectedItems: z.number().int().nonnegative(),
  resolvedItems: z.number().int().nonnegative()
}).strict();
export type RepresentativeClaimEligibility = z.infer<typeof RepresentativeClaimEligibilitySchema>;

// Batch 6B-4: explicit evaluator lifecycle for analysis-promotion criteria.
// Legacy skill_versions.status remains a compatibility projection only; once
// a lineage has this contract, the append-only lifecycle is authoritative.
export const EVALUATOR_LIFECYCLE_CONTRACT_VERSION = "coeval/evaluator-lifecycle/v1" as const;
export const EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION = "coeval/evaluator-lifecycle-event/v1" as const;
export const EVALUATOR_EXECUTION_AUTHORIZATION_VERSION = "coeval/evaluator-execution-authorization/v1" as const;

const EvaluatorLifecycleIdSchema = z.string().trim().min(1).max(240);
const EvaluatorLifecycleDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const EvaluatorLifecycleTimestampSchema = z.string().datetime({ offset: true });
const EvaluatorLifecycleIdempotencyKeySchema = z.string().trim().min(1).max(240);
const EvaluatorLifecycleExpectedSequenceSchema = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const EvaluatorLifecycleStateSchema = z.enum([
  "candidate",
  "active",
  "needs_review",
  "retired"
]);
export type EvaluatorLifecycleState = z.infer<typeof EvaluatorLifecycleStateSchema>;

export const EvaluatorLifecycleTransitionSchema = z.enum([
  "candidate_created",
  "activated",
  "calibration_revoked",
  "retired"
]);
export type EvaluatorLifecycleTransition = z.infer<typeof EvaluatorLifecycleTransitionSchema>;

export const EvaluatorExecutionContextSchema = z.enum([
  "implicit_production",
  "manual_import",
  "scheduled_import",
  "suite_publication",
  "trace_test",
  "release_gate",
  "explicit_nonproduction_dataset",
  "governed_nonsealed_evaluation",
  "binary_calibration_evidence",
  "candidate_regression_evidence"
]);
export type EvaluatorExecutionContext = z.infer<typeof EvaluatorExecutionContextSchema>;

export const EvaluatorCandidateCreateInputSchema = z.object({
  criterionId: EvaluatorLifecycleIdSchema,
  criterionVersionId: EvaluatorLifecycleIdSchema,
  governedBatchId: EvaluatorLifecycleIdSchema,
  expectedBatchDigest: EvaluatorLifecycleDigestSchema,
  truthDatasetRevisionId: EvaluatorLifecycleIdSchema,
  expectedTruthRevisionDigest: EvaluatorLifecycleDigestSchema,
  expectedTruthContentDigest: EvaluatorLifecycleDigestSchema,
  skillName: z.string().trim().min(1).max(200),
  skillDescription: z.string().trim().min(1).max(2_000),
  rubricMarkdown: z.string().trim().min(1).max(100_000),
  prompt: z.string().trim().min(1).max(100_000),
  modelBinding: ModelBindingInputSchema,
  outputSchema: JsonSchemaSchema.default(MinimumVerdictOutputSchema),
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema
}).strict();
export type EvaluatorCandidateCreateInput = z.infer<typeof EvaluatorCandidateCreateInputSchema>;

export const EvaluatorLifecycleArtifactSchema = z.object({
  id: EvaluatorLifecycleIdSchema,
  contractVersion: z.literal(EVALUATOR_LIFECYCLE_CONTRACT_VERSION),
  projectId: EvaluatorLifecycleIdSchema,
  criterionId: EvaluatorLifecycleIdSchema,
  criterionVersionId: EvaluatorLifecycleIdSchema,
  skillId: EvaluatorLifecycleIdSchema,
  skillVersionId: EvaluatorLifecycleIdSchema,
  promotionId: EvaluatorLifecycleIdSchema,
  governedBatchId: EvaluatorLifecycleIdSchema,
  governedBatchDigest: EvaluatorLifecycleDigestSchema,
  truthDatasetRevisionId: EvaluatorLifecycleIdSchema,
  truthRevisionDigest: EvaluatorLifecycleDigestSchema,
  truthContentDigest: EvaluatorLifecycleDigestSchema,
  truthItemCount: z.number().int().positive().max(10_000),
  regressionDatasetRevisionId: EvaluatorLifecycleIdSchema,
  regressionRevisionDigest: EvaluatorLifecycleDigestSchema,
  regressionContentDigest: EvaluatorLifecycleDigestSchema,
  regressionItemCount: z.number().int().positive().max(10_000),
  developerExposureEventId: EvaluatorLifecycleIdSchema,
  createdByUserId: EvaluatorLifecycleIdSchema,
  createdBySubjectId: EvaluatorLifecycleIdSchema,
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema,
  requestDigest: EvaluatorLifecycleDigestSchema,
  contentDigest: EvaluatorLifecycleDigestSchema,
  createdAt: EvaluatorLifecycleTimestampSchema
}).strict().superRefine((value, context) => {
  if (value.truthItemCount !== value.regressionItemCount) {
    context.addIssue({ code: "custom", message: "candidate regression item count must equal frozen truth item count" });
  }
});
export type EvaluatorLifecycleArtifact = z.infer<typeof EvaluatorLifecycleArtifactSchema>;

const EvaluatorLifecycleActivationEvidenceSchema = z.object({
  calibrationArtifactId: EvaluatorLifecycleIdSchema,
  calibrationArtifactDigest: EvaluatorLifecycleDigestSchema,
  calibrationEvidenceDigest: EvaluatorLifecycleDigestSchema,
  regressionRunId: EvaluatorLifecycleIdSchema,
  regressionDatasetRevisionId: EvaluatorLifecycleIdSchema
}).strict();

export const EvaluatorLifecycleEventSchema = z.object({
  id: EvaluatorLifecycleIdSchema,
  contractVersion: z.literal(EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION),
  lifecycleId: EvaluatorLifecycleIdSchema,
  projectId: EvaluatorLifecycleIdSchema,
  criterionId: EvaluatorLifecycleIdSchema,
  skillVersionId: EvaluatorLifecycleIdSchema,
  sequence: EvaluatorLifecycleExpectedSequenceSchema.refine((value) => value !== "0"),
  transition: EvaluatorLifecycleTransitionSchema,
  state: EvaluatorLifecycleStateSchema,
  predecessorEventId: EvaluatorLifecycleIdSchema.nullable(),
  predecessorEventDigest: EvaluatorLifecycleDigestSchema.nullable(),
  activationBundleId: EvaluatorLifecycleIdSchema.nullable(),
  activationEvidence: EvaluatorLifecycleActivationEvidenceSchema.nullable(),
  replacedSkillVersionId: EvaluatorLifecycleIdSchema.nullable(),
  actorUserId: EvaluatorLifecycleIdSchema.nullable(),
  actorSubjectId: EvaluatorLifecycleIdSchema.nullable(),
  actorRole: z.enum(["owner", "system"]),
  reason: z.string().trim().min(1).max(5_000),
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema,
  requestDigest: EvaluatorLifecycleDigestSchema,
  contentDigest: EvaluatorLifecycleDigestSchema,
  occurredAt: EvaluatorLifecycleTimestampSchema
}).strict().superRefine((value, context) => {
  const initial = value.transition === "candidate_created";
  if ((value.sequence === "1") !== initial || (value.predecessorEventId === null) !== initial ||
      (value.predecessorEventDigest === null) !== initial) {
    context.addIssue({ code: "custom", message: "candidate seed must be the sole predecessor-free sequence-one event" });
  }
  if ((value.transition === "activated") !== (value.activationEvidence !== null)) {
    context.addIssue({ code: "custom", message: "activation evidence is required only for activated events" });
  }
  if (value.transition === "candidate_created" && value.state !== "candidate") {
    context.addIssue({ code: "custom", message: "candidate_created must project candidate" });
  }
  if (value.transition === "activated" && value.state !== "active") {
    context.addIssue({ code: "custom", message: "activated must project active" });
  }
  if (value.transition === "calibration_revoked" && (value.state !== "needs_review" || value.actorRole !== "system")) {
    context.addIssue({ code: "custom", message: "calibration revocation must be a system needs_review event" });
  }
  if (value.transition === "retired" && value.state !== "retired") {
    context.addIssue({ code: "custom", message: "retired transition must project retired" });
  }
  if ((value.transition === "calibration_revoked") !== (value.actorRole === "system")) {
    context.addIssue({
      code: "custom",
      message: "only calibration revocation is system-authored; all owner commands require an owner actor"
    });
  }
  if (value.transition === "activated" && value.activationBundleId === null) {
    context.addIssue({ code: "custom", message: "activation requires one exact activation bundle" });
  }
  if (value.transition !== "activated" && value.replacedSkillVersionId !== null) {
    context.addIssue({ code: "custom", message: "only activation may name a replaced evaluator version" });
  }
  if ((value.transition === "candidate_created" || value.transition === "calibration_revoked") &&
      value.activationBundleId !== null) {
    context.addIssue({ code: "custom", message: "candidate and revocation events cannot claim an activation bundle" });
  }
  if (value.actorRole === "owner" && (value.actorUserId === null || value.actorSubjectId === null)) {
    context.addIssue({ code: "custom", message: "owner lifecycle events require durable actor identities" });
  }
  if (value.actorRole === "system" && (value.actorUserId !== null || value.actorSubjectId !== null)) {
    context.addIssue({ code: "custom", message: "system lifecycle events cannot claim a human actor" });
  }
});
export type EvaluatorLifecycleEvent = z.infer<typeof EvaluatorLifecycleEventSchema>;

export const EvaluatorLifecycleProjectionSchema = z.object({
  lifecycle: EvaluatorLifecycleArtifactSchema,
  currentEvent: EvaluatorLifecycleEventSchema,
  currentCalibrationAdmissibility: z.enum(["admissible", "revoked", "unknown", "not_applicable"]),
  implicitExecutionAllowed: z.boolean(),
  implicitDenialReasons: z.array(z.enum([
    "not_active",
    "calibration_incomplete",
    "calibration_revoked",
    "calibration_status_unknown",
    "activation_evidence_mismatch"
  ])).max(5)
}).strict().superRefine((value, context) => {
  if (value.currentEvent.lifecycleId !== value.lifecycle.id ||
      value.currentEvent.projectId !== value.lifecycle.projectId ||
      value.currentEvent.criterionId !== value.lifecycle.criterionId ||
      value.currentEvent.skillVersionId !== value.lifecycle.skillVersionId) {
    context.addIssue({ code: "custom", message: "lifecycle projection identities must be reciprocal" });
  }
  if (value.implicitExecutionAllowed !== (
    value.currentEvent.state === "active" &&
    value.currentCalibrationAdmissibility === "admissible" &&
    value.implicitDenialReasons.length === 0
  )) {
    context.addIssue({ code: "custom", message: "implicit execution must derive from active and admissible evidence" });
  }
});
export type EvaluatorLifecycleProjection = z.infer<typeof EvaluatorLifecycleProjectionSchema>;

export const EvaluatorCandidateCreateResultSchema = z.object({
  skill: SkillSchema,
  projection: EvaluatorLifecycleProjectionSchema,
  replayed: z.boolean()
}).strict().superRefine((value, context) => {
  if (value.skill.id !== value.projection.lifecycle.skillId ||
      value.skill.criterionId !== value.projection.lifecycle.criterionId ||
      value.skill.currentVersion.id !== value.projection.lifecycle.skillVersionId ||
      value.skill.currentVersion.criterionVersionId !== value.projection.lifecycle.criterionVersionId) {
    context.addIssue({ code: "custom", message: "candidate create result must bind one exact skill lifecycle" });
  }
});
export type EvaluatorCandidateCreateResult = z.infer<typeof EvaluatorCandidateCreateResultSchema>;

const EvaluatorLifecycleExpectedHeadSchema = z.object({
  expectedState: z.enum(["candidate", "active", "needs_review"]),
  expectedSequence: EvaluatorLifecycleExpectedSequenceSchema.refine((value) => value !== "0"),
  expectedEventId: EvaluatorLifecycleIdSchema,
  expectedEventDigest: EvaluatorLifecycleDigestSchema,
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema
}).strict();

export const EvaluatorLifecycleActivateInputSchema = EvaluatorLifecycleExpectedHeadSchema.extend({
  calibrationArtifactId: EvaluatorLifecycleIdSchema,
  expectedCalibrationArtifactDigest: EvaluatorLifecycleDigestSchema,
  expectedCalibrationEvidenceDigest: EvaluatorLifecycleDigestSchema,
  regressionRunId: EvaluatorLifecycleIdSchema,
  expectedPriorActiveSkillVersionId: EvaluatorLifecycleIdSchema.nullable(),
  expectedPriorActiveEventId: EvaluatorLifecycleIdSchema.nullable(),
  expectedPriorActiveEventDigest: EvaluatorLifecycleDigestSchema.nullable(),
  rationale: z.string().trim().min(1).max(5_000)
}).strict().superRefine((value, context) => {
  if (value.expectedState === "active") {
    context.addIssue({ code: "custom", message: "activation requires candidate or needs_review state" });
  }
  const allPriorNull = value.expectedPriorActiveSkillVersionId === null &&
    value.expectedPriorActiveEventId === null && value.expectedPriorActiveEventDigest === null;
  const allPriorSet = value.expectedPriorActiveSkillVersionId !== null &&
    value.expectedPriorActiveEventId !== null && value.expectedPriorActiveEventDigest !== null;
  if (!allPriorNull && !allPriorSet) {
    context.addIssue({ code: "custom", message: "expected prior active identity must be wholly null or wholly specified" });
  }
});
export type EvaluatorLifecycleActivateInput = z.infer<typeof EvaluatorLifecycleActivateInputSchema>;

export const EvaluatorLifecycleRetireInputSchema = EvaluatorLifecycleExpectedHeadSchema.extend({
  rationale: z.string().trim().min(1).max(5_000)
}).strict();
export type EvaluatorLifecycleRetireInput = z.infer<typeof EvaluatorLifecycleRetireInputSchema>;

export const EvaluatorLifecycleTransitionResultSchema = z.object({
  projection: EvaluatorLifecycleProjectionSchema,
  event: EvaluatorLifecycleEventSchema,
  replacedEvent: EvaluatorLifecycleEventSchema.nullable(),
  replayed: z.boolean()
}).strict().superRefine((value, context) => {
  if (value.event.lifecycleId !== value.projection.lifecycle.id ||
      value.event.skillVersionId !== value.projection.lifecycle.skillVersionId ||
      (!value.replayed && value.event.id !== value.projection.currentEvent.id)) {
    context.addIssue({ code: "custom", message: "transition result must bind the exact lifecycle event" });
  }
});
export type EvaluatorLifecycleTransitionResult = z.infer<typeof EvaluatorLifecycleTransitionResultSchema>;

export const EvaluatorLifecycleListPageSchema = z.object({
  items: z.array(EvaluatorLifecycleProjectionSchema).max(100),
  nextCursor: z.string().max(2_048).nullable(),
  totalCount: z.string().regex(/^(0|[1-9][0-9]*)$/)
}).strict();
export type EvaluatorLifecycleListPage = z.infer<typeof EvaluatorLifecycleListPageSchema>;

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

// ---------------------------------------------------------------------------
// Findings export + machine case/golden reads (GET /api/v1/findings,
// /api/v1/cases, /api/v1/golden-set — issue #10). The aggregation is bounded
// and deterministic: no LLM calls; "clustering" is exact grouping on the
// normalized first sentence of each rationale. All three endpoints are
// read-only and project-key authed — the machine surface never adjudicates
// or promotes (those dashboard actions remain ungoverned legacy evidence).

// Scan bounds. The findings surface reads at most this many newest rows per
// feed, so one request stays cheap and its output deterministic for a given
// data state; consumers needing history beyond the window page /api/v1/cases.
export const FINDINGS_VERDICT_SCAN_LIMIT = 500;
export const FINDINGS_CASE_SCAN_LIMIT = 500;
export const FINDINGS_OVERRIDE_LIMIT = 100;
export const FINDINGS_CLUSTER_LIMIT = 20;
export const FINDINGS_CLUSTER_CASE_SAMPLE = 10;
export const V1_CASES_MAX_LIMIT = 200;
export const V1_CASES_DEFAULT_LIMIT = 50;

// A human decision that contradicts the judge on the same case — the highest
// value rows in the system for skill maintenance. `source` distinguishes a
// reviewer verdict from an owner-recorded legacy adjudication. Both remain
// ungoverned evidence.
export const FindingsHumanOverrideSchema = z.object({
  caseId: z.string(),
  source: z.enum(["human", "adjudicated"]),
  label: z.string(),
  judgeLabel: z.string(),
  rationale: z.string(),
  skillVersionId: z.string().nullable(),
  createdAt: z.string()
});
export type FindingsHumanOverride = z.infer<typeof FindingsHumanOverrideSchema>;

export const FindingsFailureClusterSchema = z.object({
  // Normalized first sentence shared by every rationale in the cluster.
  key: z.string(),
  source: z.enum(["human_override", "judge"]),
  count: z.number().int().positive(),
  // Distinct cases in the cluster, capped at FINDINGS_CLUSTER_CASE_SAMPLE.
  caseIds: z.array(z.string()),
  // One full rationale from the cluster (the earliest, for determinism).
  sampleRationale: z.string()
});
export type FindingsFailureCluster = z.infer<typeof FindingsFailureClusterSchema>;

export const FindingsStratumDistributionSchema = z.object({
  // cases carry an optional metadata.stratum string; null = unstratified.
  stratum: z.string().nullable(),
  cases: z.number().int().nonnegative(),
  // Label -> count of cases whose LATEST verdict from that source has the
  // label (latest-wins per case, counts not percentages).
  judge: z.record(z.string(), z.number().int().nonnegative()),
  human: z.record(z.string(), z.number().int().nonnegative())
});
export type FindingsStratumDistribution = z.infer<typeof FindingsStratumDistributionSchema>;

export const FindingsGoldenSetSummarySchema = z.object({
  size: z.number().int().nonnegative(),
  // Entries promoted strictly after the `since` cursor; null when no cursor
  // was given (absent ≠ zero).
  entriesSince: z.number().int().nonnegative().nullable(),
  latestPromotedAt: z.string().nullable()
});
export type FindingsGoldenSetSummary = z.infer<typeof FindingsGoldenSetSummarySchema>;

export const V1FindingsResponseSchema = z.object({
  generatedAt: z.string(),
  since: z.string().nullable(),
  humanOverrides: z.array(FindingsHumanOverrideSchema),
  judgeHumanDisagreements: JudgeHumanDisagreementSummarySchema,
  verdictDistribution: z.array(FindingsStratumDistributionSchema),
  failureClusters: z.array(FindingsFailureClusterSchema),
  goldenSet: FindingsGoldenSetSummarySchema
});
export type V1FindingsResponse = z.infer<typeof V1FindingsResponseSchema>;

// GET /api/v1/cases — full stored (ingest-redacted) inputs and outputs, so a
// skill patch can be re-run on the exact cases the judge saw.
export const V1CaseVerdictSchema = z.object({
  label: z.string(),
  rationale: z.string(),
  source: VerdictSourceSchema,
  skillVersionId: z.string().nullable(),
  createdAt: z.string()
});
export type V1CaseVerdict = z.infer<typeof V1CaseVerdictSchema>;

export const V1CaseEntrySchema = z.object({
  caseId: z.string(),
  sourceTraceId: z.string(),
  createdAt: z.string(),
  stratum: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  steps: TraceStepsSchema.optional(),
  // Latest discrete verdicts. `human` prefers adjudicated over reviewer rows
  // (a recorded override outranks the verdict it overrode).
  judge: V1CaseVerdictSchema.nullable(),
  human: V1CaseVerdictSchema.nullable(),
  // human label when present, else the judge's — what `verdict=` filters on.
  effectiveLabel: z.string().nullable()
});
export type V1CaseEntry = z.infer<typeof V1CaseEntrySchema>;

export const V1CasesResponseSchema = z.object({
  cases: z.array(V1CaseEntrySchema)
});
export type V1CasesResponse = z.infer<typeof V1CasesResponseSchema>;

// GET /api/v1/golden-set — locked truth plus each entry's stored trace, so a
// gate check can be assembled from golden inputs without dashboard access.
export const V1GoldenEntrySchema = GoldenSetEntrySchema.extend({
  trace: z.object({
    input: z.unknown(),
    output: z.unknown(),
    metadata: z.record(z.string(), z.unknown())
  }).nullable()
});
export type V1GoldenEntry = z.infer<typeof V1GoldenEntrySchema>;

export const V1GoldenResponseSchema = z.object({
  entries: z.array(V1GoldenEntrySchema),
  // Registry size before any `since` filter (absent cursor ≠ empty registry).
  totalEntries: z.number().int().nonnegative()
});
export type V1GoldenResponse = z.infer<typeof V1GoldenResponseSchema>;
