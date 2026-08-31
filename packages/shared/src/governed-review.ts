import { z } from "zod";
import { DatasetEvidenceDigestSchema } from "./datasets.js";

// Governed human truth (ADR-0008). These contracts are deliberately separate
// from legacy verdict and annotation-queue contracts elsewhere in this
// package: historical rows cannot be inferred to have been independently
// assigned or evaluator-blind.
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
