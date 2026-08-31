import { z } from "zod";

import { DatasetEvidenceDigestSchema } from "./datasets.js";
import {
  ANALYSIS_POPULATION_API_PAGE_MAX,
  ANALYSIS_POPULATION_MAX_FIXED_BUDGET,
  AnalysisPopulationCursorSchema,
  AnalysisPopulationExactCountSchema,
  AnalysisPopulationIdSchema,
  AnalysisPopulationRequestTimestampSchema,
  AnalysisPopulationTimestampSchema
} from "./analysis-population.js";
import { MAX_TRACE_STEPS } from "./traces.js";

// Governed analysis study, open coding, flat taxonomy, and exact as-of
// coverage (ADR-0010, Batch 6B-2). Immutable artifacts are named separately
// from their derived head/state projections.
export const ANALYSIS_STUDY_CONTRACT_VERSION = "analysis-study/v1" as const;
export const ANALYSIS_TAXONOMY_CONTRACT_VERSION = "analysis-taxonomy/v1" as const;
export const ANALYSIS_TAXONOMY_COVERAGE_VERSION = "analysis-taxonomy-coverage/v1" as const;
export const ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION = "representative-assessment-time/v1" as const;
export const ANALYSIS_MAX_TAXONOMY_CODES = 1_000 as const;
export const ANALYSIS_MAX_TAXONOMY_REVISIONS = 10_000 as const;
export const ANALYSIS_MAX_FAILURE_LABEL_LENGTH = 500 as const;
export const ANALYSIS_MAX_RATIONALE_LENGTH = 5_000 as const;
export const ANALYSIS_MAX_REASON_LENGTH = 2_000 as const;
export const ANALYSIS_MAX_EVENT_VERSION = "9223372036854775807" as const;
export const ANALYSIS_MAX_EXPECTED_EVENT_VERSION = "9223372036854775806" as const;

function isAnalysisEventVersion(value: string): boolean {
  return value.length < ANALYSIS_MAX_EVENT_VERSION.length ||
    (value.length === ANALYSIS_MAX_EVENT_VERSION.length && value <= ANALYSIS_MAX_EVENT_VERSION);
}

const AnalysisEventVersionSchema = AnalysisPopulationExactCountSchema.refine(isAnalysisEventVersion, {
  message: "must fit the PostgreSQL bigint event-version domain"
});
const AnalysisPositiveEventVersionSchema = z.string().regex(/^[1-9][0-9]*$/)
  .refine(isAnalysisEventVersion, { message: "must fit the PostgreSQL bigint event-version domain" });
const AnalysisExpectedEventVersionSchema = AnalysisPopulationExactCountSchema.refine(
  (value) => value.length < ANALYSIS_MAX_EXPECTED_EVENT_VERSION.length ||
    (value.length === ANALYSIS_MAX_EXPECTED_EVENT_VERSION.length && value <= ANALYSIS_MAX_EXPECTED_EVENT_VERSION),
  { message: "must leave room for a successor in the PostgreSQL bigint event-version domain" }
);
const AnalysisCanonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" })
  .refine((value) => value === value.trim(), { message: "must not have leading or trailing whitespace" });
export const AnalysisIdempotencyKeySchema = AnalysisCanonicalText(240);
export const AnalysisCommandIdempotencyKeySchema = AnalysisIdempotencyKeySchema.refine(
  (value) => !value.startsWith("analysis-deadline-close_"),
  { message: "is reserved for database-owned deadline closure" }
);

export const AnalysisStudyStateSchema = z.enum([
  "draft", "coding_open", "coding_closed", "completed", "abandoned"
]);
export type AnalysisStudyState = z.infer<typeof AnalysisStudyStateSchema>;

export const AnalysisStudyItemStateSchema = z.enum(["uncoded", "in_progress", "completed"]);
export type AnalysisStudyItemState = z.infer<typeof AnalysisStudyItemStateSchema>;

export const AnalysisStudyStoppingRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("server_deadline"),
    closeAt: AnalysisPopulationRequestTimestampSchema
  }).strict(),
  z.object({
    kind: z.literal("explicit_owner_close"),
    closeAt: z.null()
  }).strict()
]);
export type AnalysisStudyStoppingRule = z.infer<typeof AnalysisStudyStoppingRuleSchema>;

export const AnalysisEvidenceAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("case_output") }).strict(),
  z.object({
    kind: z.literal("step"),
    stepIndex: z.number().int().min(0).max(MAX_TRACE_STEPS - 1)
  }).strict()
]);
export type AnalysisEvidenceAnchor = z.infer<typeof AnalysisEvidenceAnchorSchema>;

export const AnalysisStudyCreateInputSchema = z.object({
  populationId: AnalysisPopulationIdSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyCreateInput = z.infer<typeof AnalysisStudyCreateInputSchema>;

export const AnalysisStudyOpenInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  stoppingRule: AnalysisStudyStoppingRuleSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyOpenInput = z.infer<typeof AnalysisStudyOpenInputSchema>;

export const AnalysisStudyCloseInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyCloseInput = z.infer<typeof AnalysisStudyCloseInputSchema>;

export const AnalysisStudyCompleteInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  expectedClosureDigest: DatasetEvidenceDigestSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyCompleteInput = z.infer<typeof AnalysisStudyCompleteInputSchema>;

export const AnalysisStudyAbandonInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyAbandonInput = z.infer<typeof AnalysisStudyAbandonInputSchema>;

export const AnalysisStudyArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema,
  datasetRevisionId: AnalysisPopulationIdSchema,
  contractVersion: z.literal(ANALYSIS_STUDY_CONTRACT_VERSION),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema,
  createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisStudyArtifact = z.infer<typeof AnalysisStudyArtifactSchema>;

export const AnalysisStudyItemArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  drawItemId: AnalysisPopulationIdSchema,
  memberId: AnalysisPopulationIdSchema,
  revisionItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisStudyItemArtifact = z.infer<typeof AnalysisStudyItemArtifactSchema>;

export const AnalysisStudyEventTypeSchema = z.enum([
  "coding_opened", "coding_closed", "study_completed", "study_abandoned"
]);
export type AnalysisStudyEventType = z.infer<typeof AnalysisStudyEventTypeSchema>;

const AnalysisStudyEventCommonShape = {
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  version: AnalysisPositiveEventVersionSchema,
  predecessorEventId: AnalysisPopulationIdSchema.nullable(),
  predecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  actorUserId: AnalysisPopulationIdSchema.nullable(),
  actorSubjectId: AnalysisPopulationIdSchema.nullable(),
  actorRole: z.enum(["owner", "system"]),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: AnalysisPopulationTimestampSchema
} as const;

export const AnalysisStudyEventArtifactSchema = z.discriminatedUnion("eventType", [
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("coding_opened"),
    fromState: z.literal("draft"),
    toState: z.literal("coding_open"),
    stoppingRule: AnalysisStudyStoppingRuleSchema,
    closeCause: z.null(),
    closureId: z.null(), closureDigest: z.null(), expectedClosureDigest: z.null(), reason: z.null()
  }).strict(),
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("coding_closed"),
    fromState: z.literal("coding_open"),
    toState: z.literal("coding_closed"),
    stoppingRule: z.null(),
    closeCause: z.enum(["server_deadline", "explicit_owner_close"]),
    closureId: AnalysisPopulationIdSchema,
    closureDigest: DatasetEvidenceDigestSchema,
    expectedClosureDigest: z.null(),
    reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH).nullable()
  }).strict(),
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("study_completed"),
    fromState: z.literal("coding_closed"),
    toState: z.literal("completed"),
    stoppingRule: z.null(), closeCause: z.null(), closureId: z.null(), closureDigest: z.null(),
    expectedClosureDigest: DatasetEvidenceDigestSchema,
    reason: z.null()
  }).strict(),
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("study_abandoned"),
    fromState: z.enum(["draft", "coding_open"]),
    toState: z.literal("abandoned"),
    stoppingRule: z.null(), closeCause: z.null(), closureId: z.null(), closureDigest: z.null(), expectedClosureDigest: z.null(),
    reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH)
  }).strict()
]).superRefine((value, ctx) => {
  refineAnalysisEventPredecessor(value.version, value.predecessorEventId, value.predecessorEventDigest, ctx);
  if (value.eventType === "coding_closed" && value.closeCause === "server_deadline") {
    if (value.actorUserId !== null || value.actorSubjectId !== null || value.actorRole !== "system" || value.reason !== null) {
      ctx.addIssue({ code: "custom", path: ["actorRole"], message: "deadline close requires reasonless system actor" });
    }
  } else if (value.actorUserId === null || value.actorSubjectId === null || value.actorRole !== "owner") {
    ctx.addIssue({ code: "custom", path: ["actorRole"], message: "study administration requires durable owner actor" });
  }
  if (value.eventType === "coding_closed" && value.closeCause === "explicit_owner_close" && value.reason === null) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "owner close requires reason" });
  }
});
export type AnalysisStudyEventArtifact = z.infer<typeof AnalysisStudyEventArtifactSchema>;

export const AnalysisStudyProjectionSchema = z.object({
  study: AnalysisStudyArtifactSchema,
  state: AnalysisStudyStateSchema,
  currentVersion: AnalysisEventVersionSchema,
  currentEventId: AnalysisPopulationIdSchema.nullable(),
  currentEventDigest: DatasetEvidenceDigestSchema.nullable(),
  stoppingRule: AnalysisStudyStoppingRuleSchema.nullable(),
  closureId: AnalysisPopulationIdSchema.nullable(),
  closureDigest: DatasetEvidenceDigestSchema.nullable()
}).strict().superRefine((value, ctx) => {
  const zero = value.currentVersion === "0";
  if (zero !== (value.currentEventId === null && value.currentEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["currentVersion"], message: "version zero must have no event head" });
  }
  if ((value.currentEventId === null) !== (value.currentEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["currentEventId"], message: "event head ID and digest must be present together" });
  }
  const hasClosure = value.closureId !== null && value.closureDigest !== null;
  if ((value.closureId === null) !== (value.closureDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["closureId"], message: "closure ID and digest must be present together" });
  }
  if (value.state === "draft" && (!zero || value.stoppingRule !== null || hasClosure)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "draft has no events, stopping rule, or closure" });
  }
  if (value.state === "coding_open" && (value.stoppingRule === null || hasClosure)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "open coding requires its frozen stopping rule and no closure" });
  }
  if (["coding_closed", "completed"].includes(value.state) && (value.stoppingRule === null || !hasClosure)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "closed/completed study requires stopping and closure evidence" });
  }
  if (value.state === "abandoned" && hasClosure) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "abandoned study cannot have closure evidence" });
  }
});
export type AnalysisStudyProjection = z.infer<typeof AnalysisStudyProjectionSchema>;

export const AnalysisStudyItemEventTypeSchema = z.enum([
  "failure_observed", "failure_withdrawn", "no_failure_observed",
  "no_failure_withdrawn", "coding_completed", "coding_reopened"
]);
export type AnalysisStudyItemEventType = z.infer<typeof AnalysisStudyItemEventTypeSchema>;

const AnalysisStudyItemEventRequestBase = {
  expectedVersion: AnalysisExpectedEventVersionSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
} as const;
export const AnalysisStudyItemEventInputSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("failure_observed"),
    failureLabel: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
    evidenceAnchor: AnalysisEvidenceAnchorSchema }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("no_failure_observed"),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("no_failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("coding_completed") }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("coding_reopened"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict()
]);
export type AnalysisStudyItemEventInput = z.infer<typeof AnalysisStudyItemEventInputSchema>;

const AnalysisStudyItemEventArtifactCommonShape = {
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  studyItemId: AnalysisPopulationIdSchema,
  version: AnalysisPositiveEventVersionSchema,
  predecessorEventId: AnalysisPopulationIdSchema.nullable(),
  predecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  actorUserId: AnalysisPopulationIdSchema,
  actorSubjectId: AnalysisPopulationIdSchema,
  actorRole: z.enum(["owner", "member"]),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: AnalysisPopulationTimestampSchema
} as const;
export const AnalysisStudyItemEventArtifactSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("failure_observed"),
    failureLabel: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH), evidenceAnchor: AnalysisEvidenceAnchorSchema }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("no_failure_observed"),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("no_failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("coding_completed") }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("coding_reopened"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict()
]).superRefine((value, ctx) => {
  refineAnalysisEventPredecessor(value.version, value.predecessorEventId, value.predecessorEventDigest, ctx);
});
export type AnalysisStudyItemEventArtifact = z.infer<typeof AnalysisStudyItemEventArtifactSchema>;

export const AnalysisStudyItemProjectionSchema = z.object({
  item: AnalysisStudyItemArtifactSchema,
  state: AnalysisStudyItemStateSchema,
  currentVersion: AnalysisEventVersionSchema,
  currentEventId: AnalysisPopulationIdSchema.nullable(),
  currentEventDigest: DatasetEvidenceDigestSchema.nullable(),
  viewEventIds: z.array(AnalysisPopulationIdSchema),
  viewEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureObservationEventIds: z.array(AnalysisPopulationIdSchema),
  activeFailureObservationEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureAssignmentEventIds: z.array(AnalysisPopulationIdSchema.nullable()),
  activeFailureAssignmentEventDigests: z.array(DatasetEvidenceDigestSchema.nullable()),
  activeNoFailureEventId: AnalysisPopulationIdSchema.nullable(),
  activeNoFailureEventDigest: DatasetEvidenceDigestSchema.nullable(),
  completionEventId: AnalysisPopulationIdSchema.nullable(),
  completionEventDigest: DatasetEvidenceDigestSchema.nullable()
}).strict().superRefine(refineAnalysisStudyItemProjection);
export type AnalysisStudyItemProjection = z.infer<typeof AnalysisStudyItemProjectionSchema>;

export const AnalysisRepresentativeReasonSchema = z.enum([
  "method_not_eligible", "frame_not_reproducible", "draw_not_complete", "coding_not_complete"
]);
export type AnalysisRepresentativeReason = z.infer<typeof AnalysisRepresentativeReasonSchema>;

export const AnalysisStudyClosureItemArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  closureId: AnalysisPopulationIdSchema, studyId: AnalysisPopulationIdSchema,
  studyItemId: AnalysisPopulationIdSchema, drawItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  itemState: AnalysisStudyItemStateSchema,
  itemEventVersion: AnalysisEventVersionSchema,
  currentEventId: AnalysisPopulationIdSchema.nullable(),
  currentEventDigest: DatasetEvidenceDigestSchema.nullable(),
  viewEventIds: z.array(AnalysisPopulationIdSchema),
  viewEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureObservationEventIds: z.array(AnalysisPopulationIdSchema),
  activeFailureObservationEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureAssignmentEventIds: z.array(AnalysisPopulationIdSchema.nullable()),
  activeFailureAssignmentEventDigests: z.array(DatasetEvidenceDigestSchema.nullable()),
  activeNoFailureEventId: AnalysisPopulationIdSchema.nullable(),
  activeNoFailureEventDigest: DatasetEvidenceDigestSchema.nullable(),
  completionEventId: AnalysisPopulationIdSchema.nullable(),
  completionEventDigest: DatasetEvidenceDigestSchema.nullable(),
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  refineAnalysisItemEvidence(value, ctx, ["itemState"]);
});
export type AnalysisStudyClosureItemArtifact = z.infer<typeof AnalysisStudyClosureItemArtifactSchema>;

export const AnalysisStudyClosureArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema, populationId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema, datasetRevisionId: AnalysisPopulationIdSchema,
  stoppingRule: AnalysisStudyStoppingRuleSchema,
  closeCause: z.enum(["server_deadline", "explicit_owner_close"]),
  closeActorUserId: AnalysisPopulationIdSchema.nullable(),
  closeActorSubjectId: AnalysisPopulationIdSchema.nullable(),
  closeActorRole: z.enum(["owner", "system"]),
  closeReason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH).nullable(),
  effectiveClosedAt: AnalysisPopulationTimestampSchema,
  recordedAt: AnalysisPopulationTimestampSchema,
  selectedItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  viewedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  completedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  viewSetDigest: DatasetEvidenceDigestSchema,
  assessmentVersion: z.literal(ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION),
  method: z.string().min(1).max(100),
  frozenFrameDigest: DatasetEvidenceDigestSchema,
  recomputedFrameDigest: DatasetEvidenceDigestSchema.nullable(),
  frozenDrawDigest: DatasetEvidenceDigestSchema,
  recomputedDrawDigest: DatasetEvidenceDigestSchema.nullable(),
  methodEligible: z.boolean(), frameReproducible: z.boolean(), drawComplete: z.boolean(), codingComplete: z.boolean(),
  closureItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  drawnFromPopulationId: AnalysisPopulationIdSchema,
  representativeOfPopulationId: AnalysisPopulationIdSchema.nullable(),
  representativeReason: AnalysisRepresentativeReasonSchema.nullable(),
  assessmentDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  closureDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  if (value.viewedItemCount > value.selectedItemCount || value.completedItemCount > value.selectedItemCount ||
      value.closureItemCount !== value.selectedItemCount) {
    ctx.addIssue({ code: "custom", path: ["selectedItemCount"], message: "viewed/completed/closure counts cannot exceed selected" });
  }
  const frameReproducible = value.recomputedFrameDigest !== null && value.frozenFrameDigest === value.recomputedFrameDigest;
  const drawComplete = value.recomputedDrawDigest !== null && value.frozenDrawDigest === value.recomputedDrawDigest;
  const codingComplete = drawComplete && value.completedItemCount === value.selectedItemCount;
  if (value.frameReproducible !== frameReproducible || value.drawComplete !== drawComplete || value.codingComplete !== codingComplete) {
    ctx.addIssue({ code: "custom", path: ["assessmentDigest"], message: "assessment booleans must match immutable derivation inputs" });
  }
  if (value.methodEligible !== (value.method === "simple_random")) {
    ctx.addIssue({ code: "custom", path: ["methodEligible"], message: "v1 only admits simple_random" });
  }
  const expectedReason: AnalysisRepresentativeReason | null = !value.methodEligible ? "method_not_eligible"
    : !value.frameReproducible ? "frame_not_reproducible"
      : !value.drawComplete ? "draw_not_complete"
        : !value.codingComplete ? "coding_not_complete" : null;
  if (value.drawnFromPopulationId !== value.populationId || value.representativeReason !== expectedReason ||
      value.representativeOfPopulationId !== (expectedReason === null ? value.populationId : null)) {
    ctx.addIssue({ code: "custom", path: ["representativeReason"], message: "representative claim must follow the closed precedence" });
  }
  const effective = Date.parse(value.effectiveClosedAt);
  const recorded = Date.parse(value.recordedAt);
  if (recorded < effective) ctx.addIssue({ code: "custom", path: ["recordedAt"], message: "recordedAt cannot precede effective close" });
  if (value.closeCause !== value.stoppingRule.kind) {
    ctx.addIssue({ code: "custom", path: ["closeCause"], message: "close cause must match stopping rule" });
  } else if (value.closeCause === "server_deadline") {
    if (value.closeActorUserId !== null || value.closeActorSubjectId !== null || value.closeActorRole !== "system" ||
        value.closeReason !== null || value.stoppingRule.closeAt !== normalizeAnalysisSharedTimestamp(value.effectiveClosedAt)) {
      ctx.addIssue({ code: "custom", path: ["closeActorRole"], message: "deadline close must freeze effective closeAt with a reasonless system actor" });
    }
  } else if (value.closeActorUserId === null || value.closeActorSubjectId === null || value.closeActorRole !== "owner" || value.closeReason === null || effective !== recorded) {
    ctx.addIssue({ code: "custom", path: ["closeActorRole"], message: "explicit close requires owner evidence and effective recorded time" });
  }
});
export type AnalysisStudyClosureArtifact = z.infer<typeof AnalysisStudyClosureArtifactSchema>;

export const AnalysisStudyItemViewArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema, studyItemId: AnalysisPopulationIdSchema,
  viewerUserId: AnalysisPopulationIdSchema, viewerSubjectId: AnalysisPopulationIdSchema,
  datasetExposureEventId: AnalysisPopulationIdSchema,
  countsTowardClosure: z.boolean(),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema, contentDigest: DatasetEvidenceDigestSchema,
  viewedAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisStudyItemViewArtifact = z.infer<typeof AnalysisStudyItemViewArtifactSchema>;

export const AnalysisFailureTaxonomyArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  contractVersion: z.literal(ANALYSIS_TAXONOMY_CONTRACT_VERSION),
  name: AnalysisCanonicalText(240),
  description: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema, createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisFailureTaxonomyArtifact = z.infer<typeof AnalysisFailureTaxonomyArtifactSchema>;

export const AnalysisFailureCodeArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  createdInRevisionId: AnalysisPopulationIdSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema, createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisFailureCodeArtifact = z.infer<typeof AnalysisFailureCodeArtifactSchema>;

export const AnalysisTaxonomyCodeStatusSchema = z.enum(["active", "retired"]);
export type AnalysisTaxonomyCodeStatus = z.infer<typeof AnalysisTaxonomyCodeStatusSchema>;

export const AnalysisTaxonomyRevisionCodeArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema, taxonomyRevisionId: AnalysisPopulationIdSchema,
  codeId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_MAX_TAXONOMY_CODES - 1),
  label: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  definition: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  status: AnalysisTaxonomyCodeStatusSchema,
  entryDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisTaxonomyRevisionCodeArtifact = z.infer<typeof AnalysisTaxonomyRevisionCodeArtifactSchema>;

export const AnalysisTaxonomyRevisionArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  sequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  predecessorRevisionId: AnalysisPopulationIdSchema.nullable(),
  predecessorRevisionDigest: DatasetEvidenceDigestSchema.nullable(),
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  codeCount: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_CODES),
  contentDigest: DatasetEvidenceDigestSchema, revisionDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema, createdBySubjectId: AnalysisPopulationIdSchema,
  idempotencyKey: AnalysisIdempotencyKeySchema, requestDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisTaxonomyRevisionArtifact = z.infer<typeof AnalysisTaxonomyRevisionArtifactSchema>;

export const AnalysisTaxonomyRevisionProjectionSchema = z.object({
  revision: AnalysisTaxonomyRevisionArtifactSchema,
  codes: z.array(AnalysisTaxonomyRevisionCodeArtifactSchema).min(1).max(ANALYSIS_MAX_TAXONOMY_CODES)
}).strict().superRefine((value, ctx) => {
  if (value.codes.length !== value.revision.codeCount) {
    ctx.addIssue({ code: "custom", path: ["codes"], message: "codes must match revision codeCount" });
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  value.codes.forEach((code, index) => {
    if (code.projectId !== value.revision.projectId || code.taxonomyId !== value.revision.taxonomyId ||
        code.taxonomyRevisionId !== value.revision.id || code.position !== index || ids.has(code.codeId)) {
      ctx.addIssue({ code: "custom", path: ["codes", index], message: "revision code owner, identity, and position must be exact" });
    }
    ids.add(code.codeId);
    if (code.status === "active" && labels.has(code.label)) {
      ctx.addIssue({ code: "custom", path: ["codes", index, "label"], message: "active labels must be exact-string unique" });
    }
    if (code.status === "active") labels.add(code.label);
  });
});
export type AnalysisTaxonomyRevisionProjection = z.infer<typeof AnalysisTaxonomyRevisionProjectionSchema>;

const AnalysisAssignmentEventCommonShape = {
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema, taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  studyId: AnalysisPopulationIdSchema, studyItemId: AnalysisPopulationIdSchema,
  observationEventId: AnalysisPopulationIdSchema,
  version: AnalysisPositiveEventVersionSchema,
  predecessorEventId: AnalysisPopulationIdSchema.nullable(),
  predecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  actorUserId: AnalysisPopulationIdSchema, actorSubjectId: AnalysisPopulationIdSchema,
  actorRole: z.enum(["owner", "member"]),
  idempotencyKey: AnalysisIdempotencyKeySchema, requestDigest: DatasetEvidenceDigestSchema,
  eventDigest: DatasetEvidenceDigestSchema, occurredAt: AnalysisPopulationTimestampSchema
} as const;
export const AnalysisObservationAssignmentEventArtifactSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisAssignmentEventCommonShape, eventType: z.literal("assigned"), codeId: AnalysisPopulationIdSchema }).strict(),
  z.object({ ...AnalysisAssignmentEventCommonShape, eventType: z.literal("withdrawn"), codeId: z.null() }).strict()
]).superRefine((value, ctx) => {
  refineAnalysisEventPredecessor(value.version, value.predecessorEventId, value.predecessorEventDigest, ctx);
});
export type AnalysisObservationAssignmentEventArtifact = z.infer<typeof AnalysisObservationAssignmentEventArtifactSchema>;

export const AnalysisTaxonomyCoverageSchema = z.object({
  projectId: AnalysisPopulationIdSchema, studyId: AnalysisPopulationIdSchema, taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  calculationVersion: z.literal(ANALYSIS_TAXONOMY_COVERAGE_VERSION),
  selectedItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  completedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  noFailureObservedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  activeFailureObservationCount: AnalysisPopulationExactCountSchema,
  categorized: AnalysisPopulationExactCountSchema,
  assignedToRetiredCode: AnalysisPopulationExactCountSchema,
  uncategorized: AnalysisPopulationExactCountSchema,
  categorizedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  assignedToRetiredCodeItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  uncategorizedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET)
}).strict().superRefine((value, ctx) => {
  if (value.completedItemCount > value.selectedItemCount || value.noFailureObservedItemCount > value.selectedItemCount ||
      value.categorizedItemCount > value.selectedItemCount || value.assignedToRetiredCodeItemCount > value.selectedItemCount ||
      value.uncategorizedItemCount > value.selectedItemCount) {
    ctx.addIssue({ code: "custom", path: ["selectedItemCount"], message: "item counts cannot exceed selected" });
  }
  if (BigInt(value.categorized) + BigInt(value.assignedToRetiredCode) + BigInt(value.uncategorized) !== BigInt(value.activeFailureObservationCount)) {
    ctx.addIssue({ code: "custom", path: ["activeFailureObservationCount"], message: "taxonomy buckets must conserve active failure observations" });
  }
});
export type AnalysisTaxonomyCoverage = z.infer<typeof AnalysisTaxonomyCoverageSchema>;

export const AnalysisTaxonomyNewCodeInputSchema = z.object({
  kind: z.literal("new"),
  clientToken: AnalysisCanonicalText(120),
  label: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  definition: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH)
}).strict();
export type AnalysisTaxonomyNewCodeInput = z.infer<typeof AnalysisTaxonomyNewCodeInputSchema>;

export const AnalysisTaxonomyExistingCodeInputSchema = z.object({
  kind: z.literal("existing"),
  codeId: AnalysisPopulationIdSchema,
  label: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  definition: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  status: AnalysisTaxonomyCodeStatusSchema
}).strict();
export type AnalysisTaxonomyExistingCodeInput = z.infer<typeof AnalysisTaxonomyExistingCodeInputSchema>;

export const AnalysisTaxonomyRevisionCodeInputSchema = z.discriminatedUnion("kind", [
  AnalysisTaxonomyNewCodeInputSchema,
  AnalysisTaxonomyExistingCodeInputSchema
]);
export type AnalysisTaxonomyRevisionCodeInput = z.infer<typeof AnalysisTaxonomyRevisionCodeInputSchema>;

export const AnalysisFailureTaxonomyCreateInputSchema = z.object({
  name: AnalysisCanonicalText(240),
  description: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  codes: z.array(AnalysisTaxonomyNewCodeInputSchema).min(1).max(ANALYSIS_MAX_TAXONOMY_CODES),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict().superRefine((value, ctx) => refineAnalysisTaxonomyCommandCodes(value.codes, ctx));
export type AnalysisFailureTaxonomyCreateInput = z.infer<typeof AnalysisFailureTaxonomyCreateInputSchema>;

export const AnalysisTaxonomyRevisionCreateInputSchema = z.object({
  expectedPredecessorRevisionId: AnalysisPopulationIdSchema,
  expectedPredecessorRevisionDigest: DatasetEvidenceDigestSchema,
  expectedPredecessorSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS - 1),
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  codes: z.array(AnalysisTaxonomyRevisionCodeInputSchema).min(1).max(ANALYSIS_MAX_TAXONOMY_CODES),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict().superRefine((value, ctx) => refineAnalysisTaxonomyCommandCodes(value.codes, ctx));
export type AnalysisTaxonomyRevisionCreateInput = z.infer<typeof AnalysisTaxonomyRevisionCreateInputSchema>;

const AnalysisAssignmentInputCommonShape = {
  observationEventId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  expectedVersion: AnalysisExpectedEventVersionSchema,
  expectedPredecessorEventId: AnalysisPopulationIdSchema.nullable(),
  expectedPredecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
} as const;
export const AnalysisObservationAssignmentEventInputSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisAssignmentInputCommonShape, eventType: z.literal("assigned"), codeId: AnalysisPopulationIdSchema }).strict(),
  z.object({ ...AnalysisAssignmentInputCommonShape, eventType: z.literal("withdrawn"), codeId: z.null() }).strict()
]).superRefine((value, ctx) => {
  const zero = value.expectedVersion === "0";
  const noPredecessor = value.expectedPredecessorEventId === null && value.expectedPredecessorEventDigest === null;
  if (zero !== noPredecessor || (value.expectedPredecessorEventId === null) !== (value.expectedPredecessorEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["expectedVersion"], message: "version zero iff predecessor ID/digest are null" });
  }
});
export type AnalysisObservationAssignmentEventInput = z.infer<typeof AnalysisObservationAssignmentEventInputSchema>;

export const AnalysisStudySummarySchema = z.object({
  study: AnalysisStudyProjectionSchema,
  selectedItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  viewedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  completedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  closure: AnalysisStudyClosureArtifactSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (value.viewedItemCount > value.selectedItemCount || value.completedItemCount > value.selectedItemCount) {
    ctx.addIssue({ code: "custom", path: ["selectedItemCount"], message: "viewed/completed counts cannot exceed selected" });
  }
  if (value.closure !== null && (value.closure.studyId !== value.study.study.id ||
      value.closure.projectId !== value.study.study.projectId || value.closure.populationId !== value.study.study.populationId ||
      value.closure.drawId !== value.study.study.drawId || value.closure.datasetRevisionId !== value.study.study.datasetRevisionId ||
      value.closure.selectedItemCount !== value.selectedItemCount || value.closure.viewedItemCount !== value.viewedItemCount ||
      value.closure.completedItemCount !== value.completedItemCount)) {
    ctx.addIssue({ code: "custom", path: ["closure"], message: "closure must bind the exact study and summary counts" });
  }
  if ((value.study.state === "coding_closed" || value.study.state === "completed") !== (value.closure !== null)) {
    ctx.addIssue({ code: "custom", path: ["closure"], message: "only closed/completed studies have closure" });
  }
});
export type AnalysisStudySummary = z.infer<typeof AnalysisStudySummarySchema>;

export const AnalysisStudyDetailSchema = z.object({
  summary: AnalysisStudySummarySchema,
  taxonomyCoverage: AnalysisTaxonomyCoverageSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (value.taxonomyCoverage !== null && value.taxonomyCoverage.studyId !== value.summary.study.study.id) {
    ctx.addIssue({ code: "custom", path: ["taxonomyCoverage"], message: "coverage must bind the exact study" });
  }
});
export type AnalysisStudyDetail = z.infer<typeof AnalysisStudyDetailSchema>;

export const AnalysisStudySummariesPageSchema = z.object({
  items: z.array(AnalysisStudySummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  unavailableDueClosureCount: z.number().int().min(0).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  if (value.items.length + value.unavailableDueClosureCount > ANALYSIS_POPULATION_API_PAGE_MAX) {
    ctx.addIssue({
      code: "custom",
      path: ["unavailableDueClosureCount"],
      message: "available and unavailable rows cannot exceed the bounded raw page"
    });
  }
});
export type AnalysisStudySummariesPage = z.infer<typeof AnalysisStudySummariesPageSchema>;

export const AnalysisStudyItemsPageSchema = z.object({
  items: z.array(AnalysisStudyItemProjectionSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisStudyItemsPage = z.infer<typeof AnalysisStudyItemsPageSchema>;

export const AnalysisStudyItemEventsPageSchema = z.object({
  items: z.array(AnalysisStudyItemEventArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisStudyItemEventsPage = z.infer<typeof AnalysisStudyItemEventsPageSchema>;

export const AnalysisStudyCreateResultSchema = z.object({
  study: AnalysisStudyProjectionSchema,
  reused: z.boolean()
}).strict();
export type AnalysisStudyCreateResult = z.infer<typeof AnalysisStudyCreateResultSchema>;

export const AnalysisStudyEventResultSchema = z.object({
  study: AnalysisStudyProjectionSchema,
  event: AnalysisStudyEventArtifactSchema,
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  const ownerMismatch = value.event.studyId !== value.study.study.id || value.event.projectId !== value.study.study.projectId;
  const headMismatch = value.study.currentEventId !== value.event.id || value.study.currentEventDigest !== value.event.eventDigest ||
    value.study.currentVersion !== value.event.version || value.study.state !== value.event.toState;
  const historicalInvalid = BigInt(value.event.version) > BigInt(value.study.currentVersion);
  if (ownerMismatch || (!value.replayed && headMismatch) || (value.replayed && historicalInvalid)) {
    ctx.addIssue({ code: "custom", path: ["event"], message: "event must be the returned study head" });
  }
});
export type AnalysisStudyEventResult = z.infer<typeof AnalysisStudyEventResultSchema>;

export const AnalysisStudyItemEventResultSchema = z.object({
  item: AnalysisStudyItemProjectionSchema,
  event: AnalysisStudyItemEventArtifactSchema,
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  const ownerMismatch = value.event.studyId !== value.item.item.studyId || value.event.studyItemId !== value.item.item.id ||
    value.event.projectId !== value.item.item.projectId;
  const headMismatch = value.item.currentEventId !== value.event.id || value.item.currentEventDigest !== value.event.eventDigest ||
    value.item.currentVersion !== value.event.version;
  const historicalInvalid = BigInt(value.event.version) > BigInt(value.item.currentVersion);
  if (ownerMismatch || (!value.replayed && headMismatch) || (value.replayed && historicalInvalid)) {
    ctx.addIssue({ code: "custom", path: ["event"], message: "event must be the returned item head" });
  }
});
export type AnalysisStudyItemEventResult = z.infer<typeof AnalysisStudyItemEventResultSchema>;

export const AnalysisTaxonomySummarySchema = z.object({
  taxonomy: AnalysisFailureTaxonomyArtifactSchema,
  currentRevision: AnalysisTaxonomyRevisionArtifactSchema
}).strict().superRefine((value, ctx) => {
  if (value.currentRevision.taxonomyId !== value.taxonomy.id || value.currentRevision.projectId !== value.taxonomy.projectId) {
    ctx.addIssue({ code: "custom", path: ["currentRevision"], message: "revision must belong to taxonomy" });
  }
});
export type AnalysisTaxonomySummary = z.infer<typeof AnalysisTaxonomySummarySchema>;

export const AnalysisTaxonomyDetailSchema = z.object({
  taxonomy: AnalysisFailureTaxonomyArtifactSchema,
  revision: AnalysisTaxonomyRevisionProjectionSchema
}).strict().superRefine((value, ctx) => {
  if (value.revision.revision.taxonomyId !== value.taxonomy.id || value.revision.revision.projectId !== value.taxonomy.projectId) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "revision must belong to taxonomy" });
  }
});
export type AnalysisTaxonomyDetail = z.infer<typeof AnalysisTaxonomyDetailSchema>;

export const AnalysisTaxonomyRevisionsPageSchema = z.object({
  items: z.array(AnalysisTaxonomyRevisionArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisTaxonomyRevisionsPage = z.infer<typeof AnalysisTaxonomyRevisionsPageSchema>;

export const AnalysisTaxonomyRevisionResultSchema = z.object({
  taxonomy: AnalysisFailureTaxonomyArtifactSchema,
  revision: AnalysisTaxonomyRevisionProjectionSchema,
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  if (value.revision.revision.taxonomyId !== value.taxonomy.id || value.revision.revision.projectId !== value.taxonomy.projectId) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "revision must belong to taxonomy" });
  }
});
export type AnalysisTaxonomyRevisionResult = z.infer<typeof AnalysisTaxonomyRevisionResultSchema>;

export const AnalysisObservationAssignmentsPageSchema = z.object({
  items: z.array(AnalysisObservationAssignmentEventArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisObservationAssignmentsPage = z.infer<typeof AnalysisObservationAssignmentsPageSchema>;

export const AnalysisObservationAssignmentEventResultSchema = z.object({
  event: AnalysisObservationAssignmentEventArtifactSchema,
  replayed: z.boolean()
}).strict();
export type AnalysisObservationAssignmentEventResult = z.infer<typeof AnalysisObservationAssignmentEventResultSchema>;

function refineAnalysisEventPredecessor(
  version: string,
  predecessorId: string | null,
  predecessorDigest: string | null,
  ctx: z.RefinementCtx
): void {
  const first = version === "1";
  const empty = predecessorId === null && predecessorDigest === null;
  if (first !== empty || (predecessorId === null) !== (predecessorDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["version"], message: "version one iff predecessor ID/digest are null" });
  }
}

function refineAnalysisStudyItemProjection(value: z.infer<typeof AnalysisStudyItemProjectionSchema>, ctx: z.RefinementCtx): void {
  refineAnalysisItemEvidence(value, ctx, ["state"]);
  const zero = value.currentVersion === "0";
  if (zero !== (value.currentEventId === null && value.currentEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["currentVersion"], message: "version zero must have no coding-event head" });
  }
  if (value.state === "uncoded" && (!zero || value.viewEventIds.length > 0 ||
      value.activeFailureObservationEventIds.length > 0 || value.activeNoFailureEventId !== null)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "uncoded item has no view or coding evidence" });
  }
  if (value.state === "completed" && value.completionEventId === null) {
    ctx.addIssue({ code: "custom", path: ["completionEventId"], message: "completed item requires completion head" });
  }
  if (value.state !== "completed" && value.completionEventId !== null) {
    ctx.addIssue({ code: "custom", path: ["completionEventId"], message: "reopened/incomplete item cannot retain completion head" });
  }
}

function refineAnalysisItemEvidence(
  value: {
    currentEventId: string | null; currentEventDigest: string | null;
    viewEventIds: string[]; viewEventDigests: string[];
    activeFailureObservationEventIds: string[]; activeFailureObservationEventDigests: string[];
    activeFailureAssignmentEventIds: (string | null)[]; activeFailureAssignmentEventDigests: (string | null)[];
    activeNoFailureEventId: string | null; activeNoFailureEventDigest: string | null;
    completionEventId: string | null; completionEventDigest: string | null;
  },
  ctx: z.RefinementCtx,
  path: PropertyKey[]
): void {
  const failureCount = value.activeFailureObservationEventIds.length;
  if (value.activeFailureObservationEventDigests.length !== failureCount ||
      value.activeFailureAssignmentEventIds.length !== failureCount ||
      value.activeFailureAssignmentEventDigests.length !== failureCount ||
      value.viewEventIds.length !== value.viewEventDigests.length) {
    ctx.addIssue({ code: "custom", path, message: "evidence ID/digest arrays must be aligned" });
  }
  if (new Set(value.viewEventIds).size !== value.viewEventIds.length ||
      new Set(value.activeFailureObservationEventIds).size !== value.activeFailureObservationEventIds.length) {
    ctx.addIssue({ code: "custom", path, message: "evidence IDs must be unique in their causal order" });
  }
  if ((value.currentEventId === null) !== (value.currentEventDigest === null) ||
      (value.activeNoFailureEventId === null) !== (value.activeNoFailureEventDigest === null) ||
      (value.completionEventId === null) !== (value.completionEventDigest === null)) {
    ctx.addIssue({ code: "custom", path, message: "evidence ID/digest pairs must be present together" });
  }
  value.activeFailureAssignmentEventIds.forEach((id, index) => {
    if ((id === null) !== (value.activeFailureAssignmentEventDigests[index] === null)) {
      ctx.addIssue({ code: "custom", path: [...path, "activeFailureAssignmentEventIds", index], message: "assignment ID/digest pair mismatch" });
    }
  });
  if (failureCount > 0 && value.activeNoFailureEventId !== null) {
    ctx.addIssue({ code: "custom", path, message: "failure and no-failure evidence are mutually exclusive" });
  }
}

function refineAnalysisTaxonomyCommandCodes(
  codes: readonly ({ kind: "new"; clientToken: string; label: string } | { kind: "existing"; codeId: string; label: string; status: "active" | "retired" })[],
  ctx: z.RefinementCtx
): void {
  const newTokens = new Set<string>();
  const existingIds = new Set<string>();
  const activeLabels = new Set<string>();
  codes.forEach((code, index) => {
    const key = code.kind === "new" ? code.clientToken : code.codeId;
    const set = code.kind === "new" ? newTokens : existingIds;
    if (set.has(key)) ctx.addIssue({ code: "custom", path: ["codes", index], message: "code identity must be unique in request" });
    set.add(key);
    const active = code.kind === "new" || code.status === "active";
    if (active && activeLabels.has(code.label)) {
      ctx.addIssue({ code: "custom", path: ["codes", index, "label"], message: "active exact labels must be unique" });
    }
    if (active) activeLabels.add(code.label);
  });
}

function normalizeAnalysisSharedTimestamp(value: string): string {
  return new Date(value).toISOString();
}
