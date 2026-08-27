import { z } from "zod";

const OpaqueIdSchema = z.string().trim().min(1).max(240);
const IdempotencyKeySchema = z.string().trim().min(1).max(200);
const ExpectedVersionSchema = z.number().int().nonnegative();
const DateTimeSchema = z.string().datetime({ offset: true });
const JsonValueSchema = z.json();

export const GOVERNED_REVIEW_GENERAL_BODY_BYTES = 1024 * 1024;
export const GOVERNED_REVIEW_INTAKE_BODY_BYTES = 10 * 1024 * 1024;

export const CreateGovernedReviewInstructionInputSchema = z.object({
  criterionVersionId: OpaqueIdSchema,
  predecessorInstructionVersionId: OpaqueIdSchema.nullable().optional(),
  title: z.string().trim().min(1).max(240),
  instructions: z.string().trim().min(1).max(100_000),
  failureCodeGuidance: z.string().max(50_000),
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type CreateGovernedReviewInstructionInput = z.infer<
  typeof CreateGovernedReviewInstructionInputSchema
>;

const GovernedReviewStepInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  input: JsonValueSchema,
  output: JsonValueSchema
}).strict();

const SealedIntakeItemInputSchema = z.object({
  clientItemId: OpaqueIdSchema,
  input: JsonValueSchema,
  output: JsonValueSchema,
  steps: z.array(GovernedReviewStepInputSchema).max(1_000).optional()
}).strict();

export const CreateSealedReviewIntakeInputSchema = z.object({
  populationDefinition: z.string().trim().min(1).max(20_000),
  timeWindow: z.object({
    startInclusive: DateTimeSchema,
    endExclusive: DateTimeSchema
  }).strict().refine(
    (window) => Date.parse(window.startInclusive) < Date.parse(window.endExclusive),
    { message: "Sealed intake time window must be ascending" }
  ).nullable().optional(),
  predecessorRevisionId: OpaqueIdSchema.optional(),
  items: z.array(SealedIntakeItemInputSchema).min(1).max(5_000),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((input, ctx) => {
  const ids = input.items.map((item) => item.clientItemId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Sealed intake client item ids must be unique" });
  }
});
export type CreateSealedReviewIntakeInput = z.infer<typeof CreateSealedReviewIntakeInputSchema>;

const GovernedReviewSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dataset_revision"), revisionId: OpaqueIdSchema }).strict(),
  z.object({ kind: z.literal("analysis_promotion_handoff"), promotionId: OpaqueIdSchema }).strict(),
  z.object({ kind: z.literal("sealed_intake"), intakeId: OpaqueIdSchema }).strict()
]);

const RandomSelectionSchema = z.object({
  method: z.enum(["simple_random", "systematic"]),
  fixedBudget: z.number().int().positive().max(5_000)
}).strict();

const StratifiedSelectionSchema = z.object({
  method: z.literal("stratified_random"),
  strata: z.array(z.object({
    key: z.string().trim().min(1).max(240),
    definition: z.string().trim().min(1).max(10_000),
    sourceItemIds: z.array(OpaqueIdSchema).min(1).max(5_000),
    fixedBudget: z.number().int().positive().max(5_000)
  }).strict()).min(1).max(500)
}).strict().superRefine((input, ctx) => {
  const keys = input.strata.map((stratum) => stratum.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", path: ["strata"], message: "Selection stratum keys must be unique" });
  }
  const ids = input.strata.flatMap((stratum) => stratum.sourceItemIds);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["strata"], message: "A source item may belong to only one declared stratum" });
  }
  for (const [index, stratum] of input.strata.entries()) {
    if (stratum.fixedBudget > stratum.sourceItemIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["strata", index, "fixedBudget"],
        message: "A stratum budget cannot exceed its declared population"
      });
    }
  }
  if (ids.length > 5_000) {
    ctx.addIssue({ code: "custom", path: ["strata"], message: "Stratified source population cannot exceed 5,000 items" });
  }
  if (input.strata.reduce((sum, stratum) => sum + stratum.fixedBudget, 0) > 5_000) {
    ctx.addIssue({ code: "custom", path: ["strata"], message: "Stratified fixed budget cannot exceed 5,000 items" });
  }
});

const DirectedSelectionSchema = z.object({
  method: z.enum(["convenience", "uncertainty", "failure_hunting", "manual"]),
  selectedSourceItemIds: z.array(OpaqueIdSchema).min(1).max(5_000)
}).strict().superRefine((input, ctx) => {
  if (new Set(input.selectedSourceItemIds).size !== input.selectedSourceItemIds.length) {
    ctx.addIssue({ code: "custom", path: ["selectedSourceItemIds"], message: "Selected source items must be unique" });
  }
});

export const CreateGovernedReviewBatchInputSchema = z.object({
  instructionVersionId: OpaqueIdSchema,
  roleIntent: z.enum(["analysis_authoring", "iterative_development", "sealed_validation"]),
  source: GovernedReviewSourceSchema,
  selection: z.union([RandomSelectionSchema, StratifiedSelectionSchema, DirectedSelectionSchema]),
  reviewerUserIds: z.array(OpaqueIdSchema).min(1).max(20),
  fixedStopAt: DateTimeSchema,
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((input, ctx) => {
  if (new Set(input.reviewerUserIds).size !== input.reviewerUserIds.length) {
    ctx.addIssue({ code: "custom", path: ["reviewerUserIds"], message: "Reviewers must be unique" });
  }
  if (input.roleIntent === "sealed_validation" && input.source.kind !== "sealed_intake") {
    ctx.addIssue({ code: "custom", path: ["source"], message: "Sealed review requires protected sealed intake" });
  }
  if (input.roleIntent === "iterative_development" && input.source.kind !== "dataset_revision") {
    ctx.addIssue({ code: "custom", path: ["source"], message: "Iterative review requires an immutable dataset revision" });
  }
  if (input.roleIntent === "analysis_authoring" && input.source.kind === "sealed_intake") {
    ctx.addIssue({ code: "custom", path: ["source"], message: "Analysis authoring requires a development revision or exact promotion handoff" });
  }
  if (input.source.kind === "analysis_promotion_handoff" && input.roleIntent !== "analysis_authoring") {
    ctx.addIssue({ code: "custom", path: ["source"], message: "Promotion handoff is restricted to analysis authoring" });
  }
  if (input.roleIntent === "sealed_validation" && input.reviewerUserIds.length < 2) {
    ctx.addIssue({ code: "custom", path: ["reviewerUserIds"], message: "Sealed review requires two independent reviewers" });
  }
});
export type CreateGovernedReviewBatchInput = z.infer<typeof CreateGovernedReviewBatchInputSchema>;

export const GovernedReviewStreamCommandSchema = z.object({
  expectedStateVersion: ExpectedVersionSchema,
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type GovernedReviewStreamCommand = z.infer<typeof GovernedReviewStreamCommandSchema>;

export const DeferGovernedReviewTaskInputSchema = z.object({
  expectedStreamVersion: ExpectedVersionSchema,
  reason: z.string().trim().min(1).max(10_000),
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type DeferGovernedReviewTaskInput = z.infer<typeof DeferGovernedReviewTaskInputSchema>;

export const ResumeGovernedReviewTaskInputSchema = z.object({
  expectedStreamVersion: ExpectedVersionSchema,
  reason: z.string().trim().min(1).max(10_000).nullable().optional(),
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type ResumeGovernedReviewTaskInput = z.infer<typeof ResumeGovernedReviewTaskInputSchema>;

export const SubmitGovernedReviewLabelInputSchema = z.object({
  expectedStreamVersion: ExpectedVersionSchema,
  viewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  label: z.enum(["pass", "fail", "cannot_determine"]),
  rationale: z.string().trim().min(1).max(50_000),
  failureCodes: z.array(z.string().trim().min(1).max(240)).max(100),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((input, ctx) => {
  if (new Set(input.failureCodes).size !== input.failureCodes.length) {
    ctx.addIssue({ code: "custom", path: ["failureCodes"], message: "Failure codes must be unique" });
  }
});
export type SubmitGovernedReviewLabelInput = z.infer<typeof SubmitGovernedReviewLabelInputSchema>;

export const WithdrawGovernedReviewLabelInputSchema = z.object({
  expectedStreamVersion: ExpectedVersionSchema,
  labelId: OpaqueIdSchema,
  reason: z.string().trim().min(1).max(10_000),
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type WithdrawGovernedReviewLabelInput = z.infer<typeof WithdrawGovernedReviewLabelInputSchema>;

export const AppendGovernedReviewAlignmentEventInputSchema = z.object({
  expectedAlignmentVersion: ExpectedVersionSchema,
  kind: z.enum(["comment_recorded", "instruction_change_proposed", "closed"]),
  content: z.string().trim().min(1).max(50_000),
  proposedInstructionVersionId: OpaqueIdSchema.nullable().optional(),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((input, ctx) => {
  if (input.kind === "instruction_change_proposed" && !input.proposedInstructionVersionId) {
    ctx.addIssue({
      code: "custom",
      path: ["proposedInstructionVersionId"],
      message: "Instruction-change proposals must name an immutable successor instruction"
    });
  }
  if (input.kind !== "instruction_change_proposed" && input.proposedInstructionVersionId != null) {
    ctx.addIssue({
      code: "custom",
      path: ["proposedInstructionVersionId"],
      message: "Only instruction-change proposals may name a successor instruction"
    });
  }
});
export type AppendGovernedReviewAlignmentEventInput = z.infer<
  typeof AppendGovernedReviewAlignmentEventInputSchema
>;

export const AppendGovernedReviewAdjudicationInputSchema = z.object({
  expectedHeadAdjudicationId: OpaqueIdSchema.nullable(),
  decision: z.enum(["pass", "fail", "unresolvable"]),
  rationale: z.string().trim().min(1).max(50_000),
  basis: z.string().trim().min(1).max(50_000),
  correctionReason: z.string().trim().min(1).max(50_000).nullable().optional(),
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type AppendGovernedReviewAdjudicationInput = z.infer<
  typeof AppendGovernedReviewAdjudicationInputSchema
>;

export const GovernedReviewListQuerySchema = z.object({
  criterionVersionId: OpaqueIdSchema.optional(),
  state: z.enum([
    "draft", "open", "labeling_closed", "alignment_open", "adjudicating",
    "resolved", "abandoned", "incomplete", "frozen"
  ]).optional()
}).strict();
export type GovernedReviewListQuery = z.infer<typeof GovernedReviewListQuerySchema>;

export const CreateImportedTruthInputSchema = z.object({
  criterionVersionId: OpaqueIdSchema,
  issuer: z.string().trim().min(1).max(4_000),
  subject: z.string().trim().min(1).max(4_000),
  sourceArtifact: JsonValueSchema,
  transportProvenance: JsonValueSchema.nullable().optional(),
  verificationMethod: z.enum([
    "none", "self_attested", "verified_signature", "independently_verified_transport"
  ]),
  verificationEvidence: JsonValueSchema.nullable().optional(),
  instructionsProvenance: JsonValueSchema.nullable().optional(),
  raterProvenance: JsonValueSchema.nullable().optional(),
  adjudicationProvenance: JsonValueSchema.nullable().optional(),
  blindAttestation: JsonValueSchema.nullable().optional(),
  payloadSnapshot: z.object({
    input: JsonValueSchema,
    output: JsonValueSchema,
    steps: z.array(GovernedReviewStepInputSchema).max(1_000).optional()
  }).strict(),
  label: z.enum(["pass", "fail", "cannot_determine"]),
  rationale: z.string().trim().min(1).max(20_000),
  failureCodes: z.array(z.string().trim().min(1).max(240)).max(100),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((input, ctx) => {
  if (new Set(input.failureCodes).size !== input.failureCodes.length) {
    ctx.addIssue({ code: "custom", path: ["failureCodes"], message: "Failure codes must be unique" });
  }
});
export type CreateImportedTruthInput = z.infer<typeof CreateImportedTruthInputSchema>;

export const ImportedTruthListQuerySchema = z.object({
  criterionVersionId: OpaqueIdSchema.optional(),
  evidenceClass: z.enum([
    "unverified", "imported_self_attested", "imported_verified_attested"
  ]).optional()
}).strict();
export type ImportedTruthListQuery = z.infer<typeof ImportedTruthListQuerySchema>;

export type GovernedReviewEvidenceClass =
  | "governed_blind"
  | "imported_verified_attested"
  | "imported_self_attested"
  | "unverified";

export interface GovernedReviewInstructionProjection {
  instructionVersionId: string;
  criterionVersionId: string;
  revision: number;
  predecessorInstructionVersionId: string | null;
  title: string;
  instructions: string;
  failureCodeGuidance: string;
  allowedLabels: ["pass", "fail", "cannot_determine"];
  instructionDigest: string;
  createdAt: string;
}

export interface GovernedReviewSubjectProjection {
  subjectId: string;
  userId: string;
  name: string | null;
  email: string | null;
  projectRole: "owner" | "member";
}

export interface GovernedSealedIntakeReceipt {
  intakeId: string;
  protection: "sealed";
  populationDefinition: string;
  itemCount: number;
  frameDigest: string;
  predecessorRevisionId: string | null;
  createdAt: string;
}

export interface GovernedReviewCompletenessProjection {
  totalTasks: number;
  submittedTasks: number;
  deferredTasks: number;
  expiredTasks: number;
  pendingTasks: number;
}

export interface GovernedReviewRepresentativenessProjection {
  status: "not_evaluated" | "eligible" | "ineligible";
  populationId: string | null;
  reasons: string[];
}

export interface GovernedReviewBatchProjection {
  batchId: string;
  criterionVersionId: string;
  instructionVersionId: string;
  roleIntent: "analysis_authoring" | "iterative_development" | "sealed_validation";
  sourcePopulationKind: "dataset_revision" | "sealed_intake" | "analysis_promotion_handoff";
  sourcePopulationId: string;
  evaluatorBlind: boolean;
  peerBlindUntilLabelingClosed: boolean;
  selectionMethod: z.infer<typeof CreateGovernedReviewBatchInputSchema>["selection"]["method"];
  batchDigest: string;
  populationDigest: string;
  drawDigest: string;
  fixedBudget: number;
  requiredIndependentLabels: number;
  state: "draft" | "open" | "labeling_closed" | "alignment_open" | "adjudicating" |
    "resolved" | "abandoned" | "incomplete" | "frozen";
  stateVersion: number;
  fixedStopAt: string;
  itemCount: number;
  items: Array<{
    batchItemId: string;
    servePosition: number;
    resolutionKind: "single_rater" | "unanimous" | "adjudicated" | "coverage_gap" | "conflict" | "unresolvable" | null;
    resolvedLabel: "pass" | "fail" | null;
  }>;
  /** Null before the irreversible barrier so a reviewer cannot infer peer progress. */
  completeness: GovernedReviewCompletenessProjection | null;
  representativeness: GovernedReviewRepresentativenessProjection;
  datasetRevisionId: string | null;
  evidenceClass: "governed_blind" | null;
  createdAt: string;
}

export interface GovernedReviewerTaskProjection {
  taskId: string;
  batchId: string;
  criterionVersionId: string;
  instructionVersionId: string;
  criterionName: string;
  instructionTitle: string;
  state: "assigned" | "viewed" | "deferred" | "submitted" | "withdrawn" | "expired";
  stateVersion: number;
  servePosition: number;
  fixedStopAt: string;
  activeLabelId: string | null;
}

export interface GovernedTaskMutationProjection {
  taskId: string;
  state: GovernedReviewerTaskProjection["state"];
  stateVersion: number;
  activeLabelId: string | null;
}

export interface GovernedPostBarrierItemProjection {
  batchId: string;
  batchItemId: string;
  alignmentVersion: number;
  criterion: { criterionVersionId: string; name: string; definition: string };
  instruction: { instructionVersionId: string; title: string; instructions: string; failureCodeGuidance: string };
  payloadSnapshot: { input: z.infer<typeof JsonValueSchema>; output: z.infer<typeof JsonValueSchema>; steps?: Array<{ name: string; input: z.infer<typeof JsonValueSchema>; output: z.infer<typeof JsonValueSchema> }> };
  activeLabels: Array<{
    labelId: string;
    reviewerSubjectId: string;
    label: "pass" | "fail" | "cannot_determine";
    rationale: string;
    failureCodes: string[];
  }>;
  resolution: {
    kind: "single_rater" | "unanimous" | "adjudicated" | "coverage_gap" | "conflict" | "unresolvable";
    resolvedLabel: "pass" | "fail" | null;
    adjudicationId: string | null;
  };
}

export interface GovernedAlignmentEventProjection {
  alignmentEventId: string;
  batchId: string;
  sequence: number;
  kind: "comment_recorded" | "instruction_change_proposed" | "closed";
  content: string;
  proposedInstructionVersionId: string | null;
  visibleLabelCount: number;
  occurredAt: string;
}

export interface GovernedAdjudicationProjection {
  adjudicationId: string;
  batchId: string;
  batchItemId: string;
  chainVersion: number;
  predecessorAdjudicationId: string | null;
  decision: "pass" | "fail" | "unresolvable";
  rationale: string;
  basis: string;
  correctionReason: string | null;
  consideredLabelIds: string[];
  createdAt: string;
}

export interface ImportedTruthProjection {
  importedTruthId: string;
  criterionVersionId: string;
  issuer: string;
  subject: string;
  sourceArtifactDigest: string;
  sourceArtifactBytes: number;
  verificationMethod: CreateImportedTruthInput["verificationMethod"];
  evidenceClass: "unverified" | "imported_self_attested" | "imported_verified_attested";
  inputDigest: string;
  label: "pass" | "fail" | "cannot_determine";
  rationale: string;
  failureCodes: string[];
  provenanceDigest: string;
  contentDigest: string;
  importedAt: string;
}
