import { z } from "zod";

import { VerdictLabelSchema } from "./judge.js";
import { TraceStepSchema } from "./traces.js";

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
