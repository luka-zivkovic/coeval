import { z } from "zod";

import { VerdictLabelSchema } from "./judge.js";
import { MAX_TRACE_STEPS, TraceStepSchema } from "./traces.js";

// Datasets: named case collections — the generalization of the golden set's
// "cases worth re-judging" role. A dataset is NOT a label registry (the golden
// set keeps promote/retire + health); `expectedLabel` is optional per item so
// eval runs CAN report agreement without requiring ground truth.
export const DatasetKindSchema = z.enum(["custom", "adhoc"]);
export type DatasetKind = z.infer<typeof DatasetKindSchema>;

export const DatasetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: DatasetKindSchema,
  itemCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  archivedAt: z.string().nullable()
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const DatasetItemSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  caseId: z.string(),
  traceId: z.string(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  // which step you expect the failure on (0-based; only ever stored
  // alongside expectedLabel "fail" — a re-label to pass clears it).
  expectedFailStep: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
  addedAt: z.string()
});
export type DatasetItem = z.infer<typeof DatasetItemSchema>;

export const DatasetDetailSchema = DatasetSchema.extend({
  items: z.array(DatasetItemSchema)
});
export type DatasetDetail = z.infer<typeof DatasetDetailSchema>;

// Immutable evidence revisions sit alongside mutable datasets. Exact input
// identity is deliberately separate from assessment-receipt v1's
// input+output content digest.
export const DatasetRevisionRoleSchema = z.enum([
  "analysis_authoring",
  "iterative_development",
  "sealed_validation",
  "regression_golden"
]);
export type DatasetRevisionRole = z.infer<typeof DatasetRevisionRoleSchema>;

export const DatasetRevisionSourceKindSchema = z.enum([
  "collection_snapshot",
  "golden_snapshot",
  "sealed_intake",
  "analysis_population"
]);
export type DatasetRevisionSourceKind = z.infer<typeof DatasetRevisionSourceKindSchema>;

export const DatasetRevisionProvenanceLevelSchema = z.enum([
  "legacy",
  "unverified",
  "imported_self_attested",
  "imported_verified_attested",
  "reviewed_unblinded",
  "governed_blind"
]);
export type DatasetRevisionProvenanceLevel = z.infer<typeof DatasetRevisionProvenanceLevelSchema>;

export const DatasetExposureStateSchema = z.enum(["visible_by_design", "protected", "exposed"]);
export type DatasetExposureState = z.infer<typeof DatasetExposureStateSchema>;

export const DatasetEvidenceDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const DatasetReferenceProvenanceSchema = z.object({
  kind: z.enum(["unlabeled", "dataset_claim", "human_verdict", "adjudication", "golden_promotion"]),
  sourceId: z.string().nullable(),
  verdictIds: z.array(z.string()),
  actorUserIds: z.array(z.string()),
  basis: z.string()
}).strict();
export type DatasetReferenceProvenance = z.infer<typeof DatasetReferenceProvenanceSchema>;

export const DatasetRevisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  seriesId: z.string(),
  revisionNumber: z.number().int().positive(),
  sourceDatasetId: z.string().nullable(),
  parentRevisionId: z.string().nullable(),
  role: DatasetRevisionRoleSchema,
  sourceKind: DatasetRevisionSourceKindSchema,
  identityBasis: z.literal("input-identity/v1"),
  contentDigest: DatasetEvidenceDigestSchema,
  revisionDigest: DatasetEvidenceDigestSchema,
  itemCount: z.number().int().nonnegative(),
  provenanceLevel: DatasetRevisionProvenanceLevelSchema,
  exposureState: DatasetExposureStateSchema,
  // Exact digests cannot detect paraphrases or semantic near-duplicates.
  semanticLeakageDetection: z.literal("unsupported"),
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
});
export type DatasetRevision = z.infer<typeof DatasetRevisionSchema>;

export const DatasetRevisionPayloadSnapshotSchema = z.object({
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  steps: z.array(TraceStepSchema).optional()
}).strict();
export type DatasetRevisionPayloadSnapshot = z.infer<typeof DatasetRevisionPayloadSnapshotSchema>;

export const DatasetRevisionItemSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  position: z.number().int().nonnegative(),
  sourceCaseId: z.string().nullable(),
  sourceTraceId: z.string().nullable(),
  sourceDatasetItemId: z.string().nullable(),
  sourceGoldenEntryId: z.string().nullable(),
  inputDigest: DatasetEvidenceDigestSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  payloadSnapshot: DatasetRevisionPayloadSnapshotSchema,
  referenceLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  referenceFailStep: z.number().int().nonnegative().nullable(),
  referenceProvenance: DatasetReferenceProvenanceSchema,
  note: z.string().nullable(),
  createdAt: z.string()
});
export type DatasetRevisionItem = z.infer<typeof DatasetRevisionItemSchema>;

export const DatasetExposureEventSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  revisionId: z.string(),
  revisionItemId: z.string().nullable(),
  kind: z.enum([
    "created", "legacy_pretracking", "human_access", "evaluator_execution",
    "development_use", "declassification", "superseded", "overlap_detected", "exported"
  ]),
  exposureClass: z.enum(["lineage", "provenance", "development"]),
  activity: z.enum([
    "revision_create", "legacy_import", "content_view", "export", "analysis_authoring",
    "criterion_authoring", "rubric_authoring", "prompt_tuning", "example_selection", "model_selection",
    "development_run", "final_validation_run", "regression_run", "declassify",
    "supersede", "exact_overlap"
  ]),
  subjectKind: z.enum(["person", "api_key", "evaluator_version", "activity", "system"]),
  subjectId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  evidenceRefKind: z.string().nullable(),
  evidenceRefId: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  occurredAt: z.string()
});
export type DatasetExposureEvent = z.infer<typeof DatasetExposureEventSchema>;

export const DatasetRevisionDetailSchema = DatasetRevisionSchema.extend({
  items: z.array(DatasetRevisionItemSchema),
  exposures: z.array(DatasetExposureEventSchema)
});
export type DatasetRevisionDetail = z.infer<typeof DatasetRevisionDetailSchema>;

export const CreateDatasetRevisionInputSchema = z.object({
  role: DatasetRevisionRoleSchema,
  expectedParentRevisionId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200).optional()
}).strict();
export type CreateDatasetRevisionInput = z.infer<typeof CreateDatasetRevisionInputSchema>;

export const CreateDatasetInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional()
});
export type CreateDatasetInput = z.infer<typeof CreateDatasetInputSchema>;

export const AddDatasetItemsInputSchema = z.object({
  items: z.array(z.object({
    caseId: z.string().min(1),
    expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).optional(),
    note: z.string().max(2000).optional()
  })).min(1).max(500)
});
export type AddDatasetItemsInput = z.infer<typeof AddDatasetItemsInputSchema>;

// Skill Bench ingestion: paste examples as content, not case refs. Each item
// mints (or content-dedups into) a manual case and lands in the dataset with
// its expected label. Unlike trace imports, this path never auto-judges —
// bench judging happens only through explicit eval runs.
// a step-targeted expectation is valid only alongside expectedLabel
// "fail" and must index a step supplied IN THE SAME item — labeling an
// existing case without resupplying its steps is rejected by the same rule.
export function validateStepExpectation(
  item: { expectedLabel?: "pass" | "fail" | undefined; expectedFailStep?: number | undefined; steps?: unknown[] | undefined },
  ctx: z.RefinementCtx
): void {
  if (item.expectedFailStep === undefined) return;
  if (item.expectedLabel !== "fail") {
    ctx.addIssue({
      code: "custom",
      path: ["expectedFailStep"],
      message: 'expectedFailStep is only valid alongside expectedLabel "fail"'
    });
  }
  if (!item.steps || item.expectedFailStep >= item.steps.length) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedFailStep"],
      message: "expectedFailStep must index (0-based) a step supplied in the same item's steps"
    });
  }
}

export const DatasetExampleInputSchema = z.object({
  input: z.unknown(),
  output: z.unknown(),
  // Optional human title; becomes the case title via normalized metadata.name.
  name: z.string().trim().min(1).max(200).optional(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).optional(),
  expectedFailStep: z.number().int().nonnegative().optional(),
  note: z.string().max(2000).optional(),
  steps: z.array(TraceStepSchema).max(MAX_TRACE_STEPS, `a case supports at most ${MAX_TRACE_STEPS} steps`).optional()
}).superRefine(validateStepExpectation);
export type DatasetExampleInput = z.infer<typeof DatasetExampleInputSchema>;

export const ImportDatasetExamplesInputSchema = z.object({
  items: z.array(DatasetExampleInputSchema).min(1).max(500)
});
export type ImportDatasetExamplesInput = z.infer<typeof ImportDatasetExamplesInputSchema>;

export const ImportDatasetExamplesResultSchema = z.object({
  items: z.array(z.object({
    caseId: z.string(),
    datasetItemId: z.string().nullable(),
    created: z.boolean()
  })),
  // Items whose content matched an existing case (re-paste of an unchanged
  // example) — deduped, stored content untouched.
  reusedCount: z.number().int().nonnegative(),
  // Items refused by the anti-recursion guard.
  skippedCount: z.number().int().nonnegative()
});
export type ImportDatasetExamplesResult = z.infer<typeof ImportDatasetExamplesResultSchema>;
