import { z } from "zod";

import { DatasetEvidenceDigestSchema } from "./datasets.js";

// Representative Analyze population and one server draw (ADR-0010, Batch
// 6B-1b). The route accepts only the four request fields below; all evidence
// identity, ordering, seed, rows, and digests are server-owned.
export const ANALYSIS_POPULATION_MAX_MEMBERS = 100_000 as const;
export const ANALYSIS_POPULATION_MAX_FIXED_BUDGET = 10_000 as const;
export const ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS = 60 as const;
export const ANALYSIS_POPULATION_CANONICALIZATION_VERSION = "governed-content-json/v1" as const;
export const ANALYSIS_POPULATION_ORDERING_VERSION = "cases-created-at-id/v1" as const;
export const ANALYSIS_POPULATION_RNG_VERSION = "sha256-rank/v1" as const;
export const ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION = "coeval-analysis-draw/v1" as const;
export const ANALYSIS_POPULATION_MAX_SNAPSHOT_XID8_BYTES = 1_048_576 as const;

export const ANALYSIS_POPULATION_ELIGIBLE_SOURCES = [
  "manual",
  "langsmith",
  "langfuse",
  "ironside"
] as const;
export const AnalysisPopulationEligibleSourcesSchema = z.tuple([
  z.literal("manual"),
  z.literal("langsmith"),
  z.literal("langfuse"),
  z.literal("ironside")
]);

export const ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES = [
  "analysis_eligible_manual",
  "analysis_eligible_langsmith",
  "analysis_eligible_langfuse",
  "analysis_eligible_ironside"
] as const;
export const AnalysisPopulationEligibleIngestionPurposesSchema = z.tuple([
  z.literal("analysis_eligible_manual"),
  z.literal("analysis_eligible_langsmith"),
  z.literal("analysis_eligible_langfuse"),
  z.literal("analysis_eligible_ironside")
]);

export const AnalysisPopulationTimestampSchema = z.string().datetime({ offset: true });
export const AnalysisPopulationRequestTimestampSchema = AnalysisPopulationTimestampSchema
  .transform((value) => new Date(value).toISOString());
const AnalysisPopulationSnapshotXid8Schema = z.string().min(1)
  .regex(/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/)
  .max(ANALYSIS_POPULATION_MAX_SNAPSHOT_XID8_BYTES);
export const AnalysisPopulationIdSchema = z.string().min(1).max(240);
const AnalysisPopulationCountSchema = z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_MEMBERS);
export const AnalysisPopulationExactCountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const ANALYSIS_POPULATION_API_PAGE_MAX = 200 as const;
export const ANALYSIS_POPULATION_CURSOR_MAX_LENGTH = 2_048 as const;
export const AnalysisPopulationCursorSchema = z.string().min(1).max(ANALYSIS_POPULATION_CURSOR_MAX_LENGTH).nullable();

export const AnalysisPopulationCreateInputSchema = z.object({
  windowStart: AnalysisPopulationRequestTimestampSchema,
  windowEnd: AnalysisPopulationRequestTimestampSchema,
  fixedBudget: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  idempotencyKey: z.string().min(1).max(240)
    .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" })
    .refine((value) => value === value.trim(), { message: "must not have leading or trailing whitespace" })
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.windowStart) >= Date.parse(value.windowEnd)) {
    ctx.addIssue({
      code: "custom",
      path: ["windowEnd"],
      message: "windowEnd must be later than windowStart"
    });
  }
});
export type AnalysisPopulationCreateInput = z.infer<typeof AnalysisPopulationCreateInputSchema>;

export const AnalysisPopulationRequestRecordSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  idempotencyKey: z.string().min(1).max(240),
  requestDigest: DatasetEvidenceDigestSchema,
  populationId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisPopulationRequestRecord = z.infer<typeof AnalysisPopulationRequestRecordSchema>;

export const AnalysisPopulationSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  datasetRevisionId: AnalysisPopulationIdSchema,
  windowStart: AnalysisPopulationTimestampSchema,
  windowEnd: AnalysisPopulationTimestampSchema,
  eligibleSources: AnalysisPopulationEligibleSourcesSchema,
  eligibleIngestionPurposes: AnalysisPopulationEligibleIngestionPurposesSchema,
  canonicalizationVersion: z.literal(ANALYSIS_POPULATION_CANONICALIZATION_VERSION),
  orderingVersion: z.literal(ANALYSIS_POPULATION_ORDERING_VERSION),
  populationSize: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  exclusionCount: AnalysisPopulationExactCountSchema,
  frameDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  // pg_current_snapshot() text is ASCII, so this character bound is the exact
  // byte bound enforced by the current baseline.
  snapshotXid8: AnalysisPopulationSnapshotXid8Schema,
  snapshotTakenAt: AnalysisPopulationTimestampSchema,
  createdByUserId: AnalysisPopulationIdSchema,
  createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisPopulation = z.infer<typeof AnalysisPopulationSchema>;

const AnalysisPopulationMemberBaseSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  revisionItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  caseType: z.enum(ANALYSIS_POPULATION_ELIGIBLE_SOURCES),
  ingestionPurpose: z.enum(ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES),
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_MEMBERS - 1),
  ingestionTime: AnalysisPopulationTimestampSchema,
  inputDigest: DatasetEvidenceDigestSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  frameMemberDigest: DatasetEvidenceDigestSchema,
  lineageDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();

function refineAnalysisPopulationMemberOrigin(
  value: { caseType: typeof ANALYSIS_POPULATION_ELIGIBLE_SOURCES[number]; ingestionPurpose: typeof ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES[number] },
  ctx: z.RefinementCtx
): void {
  const valid =
    (value.caseType === "manual" && value.ingestionPurpose === "analysis_eligible_manual") ||
    (value.caseType === "langsmith" && value.ingestionPurpose === "analysis_eligible_langsmith") ||
    (value.caseType === "langfuse" && value.ingestionPurpose === "analysis_eligible_langfuse") ||
    (value.caseType === "ironside" && value.ingestionPurpose === "analysis_eligible_ironside");
  if (!valid) {
    ctx.addIssue({
      code: "custom",
      path: ["ingestionPurpose"],
      message: "ingestionPurpose must match the eligible caseType origin"
    });
  }
}

export const AnalysisPopulationMemberSchema = AnalysisPopulationMemberBaseSchema
  .superRefine(refineAnalysisPopulationMemberOrigin);
export type AnalysisPopulationMember = z.infer<typeof AnalysisPopulationMemberSchema>;

export const AnalysisPopulationMemberRecordSchema = AnalysisPopulationMemberBaseSchema.extend({
  rawTraceId: AnalysisPopulationIdSchema,
  sourceTraceId: z.string().min(1)
}).strict().superRefine(refineAnalysisPopulationMemberOrigin);
export type AnalysisPopulationMemberRecord = z.infer<typeof AnalysisPopulationMemberRecordSchema>;

export const AnalysisPopulationExclusionReasonSchema = z.literal("ineligible_ingestion_purpose");
export type AnalysisPopulationExclusionReason = z.infer<typeof AnalysisPopulationExclusionReasonSchema>;

const AnalysisPopulationExclusionBaseShape = {
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: AnalysisPopulationExactCountSchema,
  ingestionTime: AnalysisPopulationTimestampSchema,
  reason: AnalysisPopulationExclusionReasonSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
} as const;

const AnalysisPopulationManualExclusionSchema = z.object({
  ...AnalysisPopulationExclusionBaseShape,
  rawTraceId: AnalysisPopulationIdSchema,
  sourceTraceId: z.string().min(1),
  caseType: z.literal("manual"),
  ingestionPurpose: z.enum([
    "judge_api",
    "judge_batch_general",
    "dataset_example",
    "trace_test_synthetic"
  ])
}).strict();

const AnalysisPopulationReleaseExclusionSchema = z.object({
  ...AnalysisPopulationExclusionBaseShape,
  rawTraceId: AnalysisPopulationIdSchema.nullable(),
  sourceTraceId: z.string().min(1).nullable(),
  caseType: z.literal("release_evidence"),
  ingestionPurpose: z.literal("release_evidence")
}).strict().superRefine((value, ctx) => {
  if ((value.rawTraceId === null) !== (value.sourceTraceId === null)) {
    ctx.addIssue({ code: "custom", path: ["sourceTraceId"], message: "raw and source trace identity must be present together" });
  }
});

export const AnalysisPopulationExclusionSchema = z.union([
  AnalysisPopulationManualExclusionSchema,
  AnalysisPopulationReleaseExclusionSchema
]);
export type AnalysisPopulationExclusion = z.infer<typeof AnalysisPopulationExclusionSchema>;

export const AnalysisPopulationInclusionProbabilitySchema = z.object({
  numerator: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  denominator: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS)
}).strict().superRefine((value, ctx) => {
  if (value.numerator > value.denominator) {
    ctx.addIssue({ code: "custom", path: ["numerator"], message: "numerator cannot exceed denominator" });
  }
});
export type AnalysisPopulationInclusionProbability = z.infer<typeof AnalysisPopulationInclusionProbabilitySchema>;

export const AnalysisPopulationDrawSelectionSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  memberId: AnalysisPopulationIdSchema,
  revisionItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  frameMemberDigest: DatasetEvidenceDigestSchema,
  rankDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisPopulationDrawSelection = z.infer<typeof AnalysisPopulationDrawSelectionSchema>;

const AnalysisPopulationDrawBaseSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  datasetRevisionId: AnalysisPopulationIdSchema,
  method: z.literal("simple_random"),
  stoppingRule: z.literal("fixed"),
  drawExecutor: z.literal("coeval_server"),
  seed: z.string().regex(/^[0-9a-f]{64}$/),
  rngVersion: z.literal(ANALYSIS_POPULATION_RNG_VERSION),
  algorithmVersion: z.literal(ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION),
  fixedBudget: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  populationSize: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  inclusionProbability: AnalysisPopulationInclusionProbabilitySchema,
  drawDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  executedBySubjectId: AnalysisPopulationIdSchema,
  executedAt: AnalysisPopulationTimestampSchema
}).strict();

export const AnalysisPopulationDrawSchema = AnalysisPopulationDrawBaseSchema.extend({
  selections: z.array(AnalysisPopulationDrawSelectionSchema).min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET)
}).strict().superRefine((value, ctx) => {
  if (value.fixedBudget > value.populationSize) {
    ctx.addIssue({ code: "custom", path: ["fixedBudget"], message: "fixedBudget cannot exceed populationSize" });
  }
  if (
    value.inclusionProbability.numerator !== value.fixedBudget ||
    value.inclusionProbability.denominator !== value.populationSize
  ) {
    ctx.addIssue({ code: "custom", path: ["inclusionProbability"], message: "inclusionProbability must be exact K/N" });
  }
  if (value.selections.length !== value.fixedBudget) {
    ctx.addIssue({ code: "custom", path: ["selections"], message: "selection count must equal fixedBudget" });
  }
  const memberIds = new Set<string>();
  const revisionItemIds = new Set<string>();
  const caseIds = new Set<string>();
  value.selections.forEach((selection, index) => {
    if (selection.position !== index) {
      ctx.addIssue({ code: "custom", path: ["selections", index, "position"], message: "selection positions must be contiguous" });
    }
    if (selection.projectId !== value.projectId || selection.populationId !== value.populationId || selection.drawId !== value.id) {
      ctx.addIssue({ code: "custom", path: ["selections", index], message: "selection owner identity mismatch" });
    }
    for (const [set, value, label] of [
      [memberIds, selection.memberId, "memberId"],
      [revisionItemIds, selection.revisionItemId, "revisionItemId"],
      [caseIds, selection.caseId, "caseId"]
    ] as const) {
      if (set.has(value)) {
        ctx.addIssue({ code: "custom", path: ["selections", index, label], message: `${label} must be unique within the draw` });
      }
      set.add(value);
    }
  });
});
export type AnalysisPopulationDraw = z.infer<typeof AnalysisPopulationDrawSchema>;

export const AnalysisPopulationDrawSummarySchema = AnalysisPopulationDrawBaseSchema.superRefine((value, ctx) => {
  if (value.fixedBudget > value.populationSize) {
    ctx.addIssue({ code: "custom", path: ["fixedBudget"], message: "fixedBudget cannot exceed populationSize" });
  }
  if (
    value.inclusionProbability.numerator !== value.fixedBudget ||
    value.inclusionProbability.denominator !== value.populationSize
  ) {
    ctx.addIssue({ code: "custom", path: ["inclusionProbability"], message: "inclusionProbability must be exact K/N" });
  }
});
export type AnalysisPopulationDrawSummary = z.infer<typeof AnalysisPopulationDrawSummarySchema>;

export const AnalysisPopulationClaimSchema = z.object({
  drawnFromPopulationId: AnalysisPopulationIdSchema,
  representativeOfPopulationId: z.null(),
  representativeReason: z.literal("coding_not_complete")
}).strict();
export type AnalysisPopulationClaim = z.infer<typeof AnalysisPopulationClaimSchema>;

export const AnalysisPopulationOverlapSummarySchema = z.object({
  populationId: AnalysisPopulationIdSchema,
  populationSize: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  overlapCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  frameDigest: DatasetEvidenceDigestSchema,
  drawId: AnalysisPopulationIdSchema,
  drawDigest: DatasetEvidenceDigestSchema,
  windowStart: AnalysisPopulationTimestampSchema,
  windowEnd: AnalysisPopulationTimestampSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  if (value.overlapCount > value.populationSize) {
    ctx.addIssue({ code: "custom", path: ["overlapCount"], message: "overlapCount cannot exceed populationSize" });
  }
});
export type AnalysisPopulationOverlapSummary = z.infer<typeof AnalysisPopulationOverlapSummarySchema>;

const AnalysisPopulationSummaryBaseSchema = z.object({
  population: AnalysisPopulationSchema,
  draw: AnalysisPopulationDrawSummarySchema,
  claim: AnalysisPopulationClaimSchema
}).strict();

function refineAnalysisPopulationSummary(
  value: z.infer<typeof AnalysisPopulationSummaryBaseSchema>,
  ctx: z.RefinementCtx
): void {
  if (
    value.draw.projectId !== value.population.projectId ||
    value.draw.populationId !== value.population.id ||
    value.draw.datasetRevisionId !== value.population.datasetRevisionId
  ) {
    ctx.addIssue({ code: "custom", path: ["draw"], message: "draw must belong to the exact population and revision" });
  }
  if (value.claim.drawnFromPopulationId !== value.population.id) {
    ctx.addIssue({ code: "custom", path: ["claim", "drawnFromPopulationId"], message: "claim must bind the exact population" });
  }
}

export const AnalysisPopulationSummarySchema = AnalysisPopulationSummaryBaseSchema
  .superRefine(refineAnalysisPopulationSummary);
export type AnalysisPopulationSummary = z.infer<typeof AnalysisPopulationSummarySchema>;

export const AnalysisPopulationDetailSchema = AnalysisPopulationSummaryBaseSchema.extend({
  overlapCount: AnalysisPopulationExactCountSchema
}).strict().superRefine(refineAnalysisPopulationSummary);
export type AnalysisPopulationDetail = z.infer<typeof AnalysisPopulationDetailSchema>;

export const AnalysisPopulationMembersPageSchema = z.object({
  items: z.array(AnalysisPopulationMemberSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationMembersPage = z.infer<typeof AnalysisPopulationMembersPageSchema>;

export const AnalysisPopulationExclusionsPageSchema = z.object({
  items: z.array(AnalysisPopulationExclusionSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationExclusionsPage = z.infer<typeof AnalysisPopulationExclusionsPageSchema>;

export const AnalysisPopulationOverlapsPageSchema = z.object({
  items: z.array(AnalysisPopulationOverlapSummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationOverlapsPage = z.infer<typeof AnalysisPopulationOverlapsPageSchema>;

export const AnalysisPopulationSelectedItemsPageSchema = z.object({
  items: z.array(AnalysisPopulationDrawSelectionSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationSelectedItemsPage = z.infer<typeof AnalysisPopulationSelectedItemsPageSchema>;

export const AnalysisPopulationSummariesPageSchema = z.object({
  items: z.array(AnalysisPopulationSummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationSummariesPage = z.infer<typeof AnalysisPopulationSummariesPageSchema>;

export const AnalysisPopulationCreateResultSchema = AnalysisPopulationSummaryBaseSchema.extend({
  reusedPopulation: z.boolean(),
  reusedDraw: z.boolean()
}).strict().superRefine((value, ctx) => {
  refineAnalysisPopulationSummary(value, ctx);
  if (value.reusedPopulation !== value.reusedDraw) {
    ctx.addIssue({
      code: "custom",
      path: ["reusedDraw"],
      message: "population and its single draw must be reused together"
    });
  }
});
export type AnalysisPopulationCreateResult = z.infer<typeof AnalysisPopulationCreateResultSchema>;
