import { z } from "zod";

import {
  ANALYSIS_POPULATION_API_PAGE_MAX,
  ANALYSIS_POPULATION_MAX_FIXED_BUDGET,
  AnalysisPopulationCursorSchema,
  AnalysisPopulationExactCountSchema,
  AnalysisPopulationIdSchema,
  AnalysisPopulationTimestampSchema
} from "./analysis-population.js";
import {
  ANALYSIS_MAX_FAILURE_LABEL_LENGTH,
  ANALYSIS_MAX_RATIONALE_LENGTH,
  ANALYSIS_MAX_TAXONOMY_REVISIONS,
  AnalysisCommandIdempotencyKeySchema,
  AnalysisEvidenceAnchorSchema,
  AnalysisIdempotencyKeySchema
} from "./analysis-study.js";
import { DatasetEvidenceDigestSchema } from "./datasets.js";
import {
  JsonSchemaSchema,
  MinimumVerdictOutputSchema,
  ModelBindingInputSchema,
  UnicodeScalarValueSchema,
  VerdictKindSchema,
  containsLoneUtf16Surrogate
} from "./judge.js";
import { SkillSchema } from "./skills.js";

// Evaluator suite manifest v1 is a separate, policy-free artifact. It binds
// immutable criterion definitions to exact evaluator versions while leaving
// every criterion's assessment in its existing receipt-v1 artifact. Keep all
// nested objects strict: release roles, thresholds, weights, compensation,
// and composite decisions are intentionally not representable here.
const EvaluatorSuiteSha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const CriterionSourceKindSchema = z.enum(["native", "analysis_promotion"]);
export type CriterionSourceKind = z.infer<typeof CriterionSourceKindSchema>;

export const CriterionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  stableKey: z.string().min(1),
  sourceKind: CriterionSourceKindSchema,
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
}).strict();
export type Criterion = z.infer<typeof CriterionSchema>;

export const CriterionVersionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  revision: z.number().int().positive(),
  name: z.string().min(1),
  definition: z.string().min(1),
  criterionDigest: EvaluatorSuiteSha256DigestSchema,
  sourceKind: CriterionSourceKindSchema,
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
}).strict();
export type CriterionVersion = z.infer<typeof CriterionVersionSchema>;

// Failure-code promotion is the narrow ADR-0010 bridge from governed Analyze
// evidence into one criterion definition. It creates no evaluator or truth.
export const ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION = "analysis-criterion-promotion/v1" as const;
export const ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION = "analysis-criterion-promotion-handoff/v1" as const;
export const ANALYSIS_MAX_PROMOTION_SUPPORTS = 1_000 as const;

const AnalysisPromotionCanonicalText = (maximum: number) => UnicodeScalarValueSchema
  .min(1)
  .max(maximum)
  .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" })
  .refine((value) => value === value.trim(), { message: "must not have leading or trailing whitespace" });

export const AnalysisCriterionPromotionSupportInputSchema = z.object({
  studyItemId: AnalysisPopulationIdSchema,
  closureItemId: AnalysisPopulationIdSchema,
  closureItemDigest: DatasetEvidenceDigestSchema,
  observationEventId: AnalysisPopulationIdSchema,
  observationEventDigest: DatasetEvidenceDigestSchema,
  assignmentEventId: AnalysisPopulationIdSchema,
  assignmentEventDigest: DatasetEvidenceDigestSchema
}).strict();
export type AnalysisCriterionPromotionSupportInput = z.infer<typeof AnalysisCriterionPromotionSupportInputSchema>;

export const AnalysisCriterionPromotionCreateInputSchema = z.object({
  studyId: AnalysisPopulationIdSchema,
  expectedClosureId: AnalysisPopulationIdSchema,
  expectedClosureDigest: DatasetEvidenceDigestSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  expectedTaxonomyRevisionDigest: DatasetEvidenceDigestSchema,
  codeId: AnalysisPopulationIdSchema,
  expectedCodeEntryDigest: DatasetEvidenceDigestSchema,
  criterionName: AnalysisPromotionCanonicalText(200),
  criterionDefinition: AnalysisPromotionCanonicalText(20_000),
  rationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  supportingObservations: z.array(AnalysisCriterionPromotionSupportInputSchema)
    .min(1)
    .max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict().superRefine((value, ctx) => {
  const observationIds = new Set<string>();
  value.supportingObservations.forEach((support, index) => {
    if (observationIds.has(support.observationEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["supportingObservations", index, "observationEventId"],
        message: "supporting observations must have unique observation identities"
      });
    }
    observationIds.add(support.observationEventId);
  });
});
export type AnalysisCriterionPromotionCreateInput = z.infer<typeof AnalysisCriterionPromotionCreateInputSchema>;

export const AnalysisCriterionPromotionArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  contractVersion: z.literal(ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION),
  studyId: AnalysisPopulationIdSchema,
  studyClosureId: AnalysisPopulationIdSchema,
  studyClosureDigest: DatasetEvidenceDigestSchema,
  populationId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionContentDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionDigest: DatasetEvidenceDigestSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  taxonomyRevisionDigest: DatasetEvidenceDigestSchema,
  codeId: AnalysisPopulationIdSchema,
  codeEntryId: AnalysisPopulationIdSchema,
  codeEntryDigest: DatasetEvidenceDigestSchema,
  codeLabel: AnalysisPromotionCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  codeDefinition: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  criterionId: AnalysisPopulationIdSchema,
  criterionVersionId: AnalysisPopulationIdSchema,
  criterionStableKey: AnalysisPromotionCanonicalText(200),
  criterionName: AnalysisPromotionCanonicalText(200),
  criterionDefinition: AnalysisPromotionCanonicalText(20_000),
  criterionDigest: DatasetEvidenceDigestSchema,
  rationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  supportCount: z.number().int().min(1).max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  supportSetDigest: DatasetEvidenceDigestSchema,
  criterionAuthoringExposureEventId: AnalysisPopulationIdSchema,
  promotedByUserId: AnalysisPopulationIdSchema,
  promotedBySubjectId: AnalysisPopulationIdSchema,
  promoterRole: z.literal("owner"),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  handoffVersion: z.literal(ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION),
  handoffDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  if (value.criterionStableKey !== `analysis-failure-code:${value.codeId}`) {
    ctx.addIssue({
      code: "custom",
      path: ["criterionStableKey"],
      message: "promoted criterion stable key must bind the exact failure code"
    });
  }
});
export type AnalysisCriterionPromotionArtifact = z.infer<typeof AnalysisCriterionPromotionArtifactSchema>;

export const AnalysisCriterionPromotionSupportArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  promotionId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_MAX_PROMOTION_SUPPORTS - 1),
  studyId: AnalysisPopulationIdSchema,
  studyItemId: AnalysisPopulationIdSchema,
  closureId: AnalysisPopulationIdSchema,
  closureItemId: AnalysisPopulationIdSchema,
  closureItemDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionItemId: AnalysisPopulationIdSchema,
  sourceItemDigest: DatasetEvidenceDigestSchema,
  observationEventId: AnalysisPopulationIdSchema,
  observationEventDigest: DatasetEvidenceDigestSchema,
  assignmentEventId: AnalysisPopulationIdSchema,
  assignmentEventDigest: DatasetEvidenceDigestSchema,
  observationAuthorSubjectId: AnalysisPopulationIdSchema,
  exampleSelectionExposureEventId: AnalysisPopulationIdSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisCriterionPromotionSupportArtifact = z.infer<typeof AnalysisCriterionPromotionSupportArtifactSchema>;

export const AnalysisCriterionPromotionHandoffSchema = z.object({
  handoffVersion: z.literal(ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION),
  promotionId: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  criterionId: AnalysisPopulationIdSchema,
  criterionVersionId: AnalysisPopulationIdSchema,
  criterionDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionContentDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionDigest: DatasetEvidenceDigestSchema,
  roleIntent: z.literal("analysis_authoring"),
  sourceKind: z.literal("analysis_promotion_handoff"),
  evidenceClass: z.literal("development_authoring_not_truth"),
  createsTruth: z.literal(false),
  createsEvaluator: z.literal(false),
  handoffDigest: DatasetEvidenceDigestSchema
}).strict();
export type AnalysisCriterionPromotionHandoff = z.infer<typeof AnalysisCriterionPromotionHandoffSchema>;

export const AnalysisCriterionPromotionCandidateSchema = z.object({
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  studyState: z.enum(["coding_closed", "completed"]),
  closureId: AnalysisPopulationIdSchema,
  closureDigest: DatasetEvidenceDigestSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  taxonomyRevisionDigest: DatasetEvidenceDigestSchema,
  codeId: AnalysisPopulationIdSchema,
  codeEntryId: AnalysisPopulationIdSchema,
  codeEntryDigest: DatasetEvidenceDigestSchema,
  codeLabel: AnalysisPromotionCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  codeDefinition: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  codeStatus: z.literal("active"),
  studyItemId: AnalysisPopulationIdSchema,
  closureItemId: AnalysisPopulationIdSchema,
  closureItemDigest: DatasetEvidenceDigestSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionItemId: AnalysisPopulationIdSchema,
  sourceItemDigest: DatasetEvidenceDigestSchema,
  observationEventId: AnalysisPopulationIdSchema,
  observationEventDigest: DatasetEvidenceDigestSchema,
  failureLabel: AnalysisPromotionCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  observationRationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  evidenceAnchor: AnalysisEvidenceAnchorSchema,
  assignmentEventId: AnalysisPopulationIdSchema,
  assignmentEventDigest: DatasetEvidenceDigestSchema,
  assignmentRationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  observationAuthorSubjectId: AnalysisPopulationIdSchema
}).strict();
export type AnalysisCriterionPromotionCandidate = z.infer<typeof AnalysisCriterionPromotionCandidateSchema>;

const AnalysisCriterionPromotionSummaryBaseSchema = z.object({
  promotion: AnalysisCriterionPromotionArtifactSchema,
  criterion: CriterionSchema,
  criterionVersion: CriterionVersionSchema,
  handoff: AnalysisCriterionPromotionHandoffSchema
}).strict();

function refineAnalysisCriterionPromotionSummary(
  value: z.infer<typeof AnalysisCriterionPromotionSummaryBaseSchema>,
  ctx: z.RefinementCtx
): void {
  const { promotion, criterion, criterionVersion, handoff } = value;
  if (
    criterion.projectId !== promotion.projectId ||
    criterion.id !== promotion.criterionId ||
    criterion.stableKey !== promotion.criterionStableKey ||
    criterion.sourceKind !== "analysis_promotion" ||
    criterion.createdByUserId !== promotion.promotedByUserId ||
    criterion.createdAt !== promotion.createdAt ||
    criterionVersion.projectId !== promotion.projectId ||
    criterionVersion.id !== promotion.criterionVersionId ||
    criterionVersion.criterionId !== criterion.id ||
    criterionVersion.revision !== 1 ||
    criterionVersion.name !== promotion.criterionName ||
    criterionVersion.definition !== promotion.criterionDefinition ||
    criterionVersion.criterionDigest !== promotion.criterionDigest ||
    criterionVersion.sourceKind !== "analysis_promotion" ||
    criterionVersion.createdByUserId !== promotion.promotedByUserId ||
    criterionVersion.createdAt !== promotion.createdAt
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["criterionVersion"],
      message: "criterion and initial version must exactly match the promotion"
    });
  }
  if (
    handoff.handoffVersion !== promotion.handoffVersion ||
    handoff.promotionId !== promotion.id ||
    handoff.projectId !== promotion.projectId ||
    handoff.criterionId !== promotion.criterionId ||
    handoff.criterionVersionId !== promotion.criterionVersionId ||
    handoff.criterionDigest !== promotion.criterionDigest ||
    handoff.sourceDatasetRevisionId !== promotion.sourceDatasetRevisionId ||
    handoff.sourceDatasetRevisionContentDigest !== promotion.sourceDatasetRevisionContentDigest ||
    handoff.sourceDatasetRevisionDigest !== promotion.sourceDatasetRevisionDigest ||
    handoff.handoffDigest !== promotion.handoffDigest
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["handoff"],
      message: "handoff must bind the exact promotion, criterion, and source revision"
    });
  }
}

export const AnalysisCriterionPromotionSummarySchema = AnalysisCriterionPromotionSummaryBaseSchema
  .superRefine(refineAnalysisCriterionPromotionSummary);
export type AnalysisCriterionPromotionSummary = z.infer<typeof AnalysisCriterionPromotionSummarySchema>;

export const AnalysisCriterionPromotionDetailSchema = AnalysisCriterionPromotionSummarySchema;
export type AnalysisCriterionPromotionDetail = z.infer<typeof AnalysisCriterionPromotionDetailSchema>;

export const AnalysisCriterionPromotionCreateResultSchema = AnalysisCriterionPromotionSummaryBaseSchema.extend({
  supports: z.array(AnalysisCriterionPromotionSupportArtifactSchema)
    .min(1)
    .max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  refineAnalysisCriterionPromotionSummary(value, ctx);
  if (value.supports.length !== value.promotion.supportCount) {
    ctx.addIssue({ code: "custom", path: ["supports"], message: "supports must match promotion supportCount" });
  }
  const supportIds = new Set<string>();
  const observationIds = new Set<string>();
  const exposureIds = new Set<string>();
  value.supports.forEach((support, index) => {
    if (
      support.projectId !== value.promotion.projectId ||
      support.promotionId !== value.promotion.id ||
      support.studyId !== value.promotion.studyId ||
      support.closureId !== value.promotion.studyClosureId ||
      support.sourceDatasetRevisionId !== value.promotion.sourceDatasetRevisionId ||
      support.createdAt !== value.promotion.createdAt ||
      support.position !== index
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["supports", index],
        message: "support must bind the exact promotion evidence and canonical position"
      });
    }
    if (supportIds.has(support.id) || observationIds.has(support.observationEventId) ||
        exposureIds.has(support.exampleSelectionExposureEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["supports", index],
        message: "support, observation, and exposure identities must be unique"
      });
    }
    supportIds.add(support.id);
    observationIds.add(support.observationEventId);
    exposureIds.add(support.exampleSelectionExposureEventId);
  });
});
export type AnalysisCriterionPromotionCreateResult = z.infer<typeof AnalysisCriterionPromotionCreateResultSchema>;

export const AnalysisCriterionPromotionCandidatesPageSchema = z.object({
  items: z.array(AnalysisCriterionPromotionCandidateSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  const observationIds = new Set<string>();
  value.items.forEach((candidate, index) => {
    if (observationIds.has(candidate.observationEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "observationEventId"],
        message: "candidate observation identities must be unique within a page"
      });
    }
    observationIds.add(candidate.observationEventId);
  });
  if (BigInt(value.totalCount) < BigInt(value.items.length)) {
    ctx.addIssue({ code: "custom", path: ["totalCount"], message: "totalCount cannot be smaller than the page" });
  }
});
export type AnalysisCriterionPromotionCandidatesPage = z.infer<typeof AnalysisCriterionPromotionCandidatesPageSchema>;

export const AnalysisCriterionPromotionSummariesPageSchema = z.object({
  items: z.array(AnalysisCriterionPromotionSummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.items.forEach((summary, index) => {
    if (ids.has(summary.promotion.id)) {
      ctx.addIssue({ code: "custom", path: ["items", index], message: "promotion identities must be unique within a page" });
    }
    ids.add(summary.promotion.id);
  });
  if (BigInt(value.totalCount) < BigInt(value.items.length)) {
    ctx.addIssue({ code: "custom", path: ["totalCount"], message: "totalCount cannot be smaller than the page" });
  }
});
export type AnalysisCriterionPromotionSummariesPage = z.infer<typeof AnalysisCriterionPromotionSummariesPageSchema>;

export const AnalysisCriterionPromotionSupportsPageSchema = z.object({
  items: z.array(AnalysisCriterionPromotionSupportArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  const supportIds = new Set<string>();
  const observationIds = new Set<string>();
  const exposureIds = new Set<string>();
  value.items.forEach((support, index) => {
    if (supportIds.has(support.id) || observationIds.has(support.observationEventId) ||
        exposureIds.has(support.exampleSelectionExposureEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index],
        message: "support, observation, and exposure identities must be unique within a page"
      });
    }
    supportIds.add(support.id);
    observationIds.add(support.observationEventId);
    exposureIds.add(support.exampleSelectionExposureEventId);
  });
  if (value.totalCount < value.items.length) {
    ctx.addIssue({ code: "custom", path: ["totalCount"], message: "totalCount cannot be smaller than the page" });
  }
});
export type AnalysisCriterionPromotionSupportsPage = z.infer<typeof AnalysisCriterionPromotionSupportsPageSchema>;

export const CriterionDetailSchema = z.object({
  criterion: CriterionSchema,
  versions: z.array(CriterionVersionSchema)
}).strict();
export type CriterionDetail = z.infer<typeof CriterionDetailSchema>;

export const CriterionEvaluatorDraftInputSchema = z.object({
  rubricMarkdown: z.string().trim().min(1).max(100_000),
  prompt: z.string().trim().min(1).max(100_000),
  modelBinding: ModelBindingInputSchema,
  outputSchema: JsonSchemaSchema.default(MinimumVerdictOutputSchema),
  verdictKind: VerdictKindSchema.default("binary"),
  scalarRange: z.tuple([z.number(), z.number()]).optional(),
  categoricalChoiceScores: z.record(z.string(), z.number().min(0).max(1)).optional()
}).strict()
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Evaluator input must not contain an unpaired UTF-16 surrogate"
  })
  .refine(
    (value) => value.verdictKind !== "scalar" || (
      value.scalarRange !== undefined && value.scalarRange[0] < value.scalarRange[1]
    ),
    { message: "scalar evaluator drafts require an ascending scalarRange" }
  )
  .refine(
    (value) => value.verdictKind !== "categorical" || (
      value.categoricalChoiceScores !== undefined && Object.keys(value.categoricalChoiceScores).length > 0
    ),
    { message: "categorical evaluator drafts require non-empty categoricalChoiceScores" }
  )
  .refine((value) => value.verdictKind === "scalar" || value.scalarRange === undefined, {
    message: "scalarRange is only valid for scalar evaluator drafts"
  })
  .refine((value) => value.verdictKind === "categorical" || value.categoricalChoiceScores === undefined, {
    message: "categoricalChoiceScores is only valid for categorical evaluator drafts"
  });
export type CriterionEvaluatorDraftInput = z.infer<typeof CriterionEvaluatorDraftInputSchema>;

export const CreateCriterionInputSchema = z.object({
  stableKey: UnicodeScalarValueSchema.trim().min(1).max(200),
  name: UnicodeScalarValueSchema.trim().min(1).max(200),
  definition: UnicodeScalarValueSchema.trim().min(1).max(20_000),
  evaluator: CriterionEvaluatorDraftInputSchema
}).strict();
export type CreateCriterionInput = z.infer<typeof CreateCriterionInputSchema>;

export const CreatedCriterionSchema = CriterionDetailSchema.extend({
  evaluator: SkillSchema
}).strict();
export type CreatedCriterion = z.infer<typeof CreatedCriterionSchema>;

export const CreateCriterionVersionInputSchema = z.object({
  name: UnicodeScalarValueSchema.trim().min(1).max(200),
  definition: UnicodeScalarValueSchema.trim().min(1).max(20_000)
}).strict();
export type CreateCriterionVersionInput = z.infer<typeof CreateCriterionVersionInputSchema>;

export const EvaluatorSuiteApplicabilitySchema = z.object({
  kind: z.literal("all_items")
}).strict();
export type EvaluatorSuiteApplicability = z.infer<typeof EvaluatorSuiteApplicabilitySchema>;

export const EvaluatorSuiteTrialPlanSchema = z.object({
  kind: z.literal("independent_repetitions"),
  trialsPerItem: z.number().int().min(2).max(10)
}).strict();
export type EvaluatorSuiteTrialPlan = z.infer<typeof EvaluatorSuiteTrialPlanSchema>;

export const EvaluatorSuiteManifestMemberSchema = z.object({
  position: z.number().int().nonnegative(),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  criterionName: z.string().min(1),
  criterionDefinition: z.string().min(1),
  criterionDigest: EvaluatorSuiteSha256DigestSchema,
  skillId: z.string().min(1),
  skillVersionId: z.string().min(1),
  skillDigest: EvaluatorSuiteSha256DigestSchema,
  outputContractDigest: EvaluatorSuiteSha256DigestSchema,
  applicability: EvaluatorSuiteApplicabilitySchema
}).strict();
export type EvaluatorSuiteManifestMember = z.infer<typeof EvaluatorSuiteManifestMemberSchema>;

export const EvaluatorSuiteManifestSchema = z.object({
  contract: z.literal("coeval/evaluator-suite-manifest/v1"),
  schemaVersion: z.literal(1),
  manifestId: z.string().min(1),
  suiteId: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  members: z.array(EvaluatorSuiteManifestMemberSchema).min(1),
  trialPlan: EvaluatorSuiteTrialPlanSchema.nullable(),
  manifestDigest: EvaluatorSuiteSha256DigestSchema
}).strict();
export type EvaluatorSuiteManifest = z.infer<typeof EvaluatorSuiteManifestSchema>;

export const EvaluatorSuiteSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
}).strict();
export type EvaluatorSuite = z.infer<typeof EvaluatorSuiteSchema>;

export const EvaluatorSuiteManifestBindingSchema = z.object({
  criterionVersionId: UnicodeScalarValueSchema.min(1),
  skillVersionId: UnicodeScalarValueSchema.min(1)
}).strict();
export type EvaluatorSuiteManifestBinding = z.infer<typeof EvaluatorSuiteManifestBindingSchema>;

export const CreateEvaluatorSuiteManifestInputSchema = z.object({
  idempotencyKey: UnicodeScalarValueSchema.trim().min(1).max(200),
  suiteId: UnicodeScalarValueSchema.min(1).optional(),
  members: z.array(EvaluatorSuiteManifestBindingSchema).min(1).max(100),
  trialPlan: EvaluatorSuiteTrialPlanSchema.nullable().default(null)
}).strict();
export type CreateEvaluatorSuiteManifestInput = z.infer<typeof CreateEvaluatorSuiteManifestInputSchema>;
