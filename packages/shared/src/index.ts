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
  TracePayloadSchema,
  TraceStepsSchema
} from "./traces.js";
import { ProviderResponseMetadataSchema } from "./evaluation-runs.js";
import type { EvalRunStatus } from "./evaluation-runs.js";
import {
  CreateCriterionVersionInputSchema,
  CriterionVersionSchema
} from "./criterion-governance.js";

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


export * from "./governed-review.js";


export * from "./analysis-measurement.js";


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


export * from "./evaluator-lifecycle.js";


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


export * from "./integrations.js";


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
