import { z } from "zod";
import {
  JsonSchemaSchema,
  MinimumVerdictOutputSchema,
  ModelBindingInputSchema
} from "./judge.js";
import { SkillSchema } from "./skills.js";

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
