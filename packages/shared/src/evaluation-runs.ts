import { z } from "zod";

import { DatasetSchema, validateStepExpectation } from "./datasets.js";
import { ModelBindingSchema, VerdictLabelSchema } from "./judge.js";
import { ManualTraceImportInputSchema } from "./traces.js";

export const ProviderResponseMetadataSchema = z.object({
  model: z.string().nullable(),
  requestId: z.string().nullable(),
  responseId: z.string().nullable(),
  systemFingerprint: z.string().nullable()
});
export type ProviderResponseMetadata = z.infer<typeof ProviderResponseMetadataSchema>;

// Eval runs: judge a set of cases with one skill version via queue fan-out.
// Aggregates are incremental counters (completion detection is an atomic
// per-item update, not a scan).
export const EvalRunStatusSchema = z.enum(["pending", "running", "completed", "failed", "canceled"]);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

// 'backfill' = a durable re-evaluation of existing cases after a version gate.
// It is deliberately distinct from 'regression_gate', which is evaluator-
// version governance over the pinned known-failure revision.
// 'product_gate' = the retained run kind behind deprecated product-gate reads.
export const EvalRunTriggerSchema = z.enum(["manual", "api_batch", "backfill", "regression_gate", "product_gate", "release_evidence"]);
export type EvalRunTrigger = z.infer<typeof EvalRunTriggerSchema>;

export const EvalRunItemStatusSchema = z.enum(["pending", "completed", "failed", "skipped"]);
export type EvalRunItemStatus = z.infer<typeof EvalRunItemStatusSchema>;

export const TraceTestRunSourceSchema = z.object({
  traceTestId: z.string().min(1),
  revision: z.number().int().positive(),
  validationRevision: z.number().int().positive(),
  validationId: z.string().min(1),
  sourceCaseRef: z.string().min(1),
  caseId: z.string().min(1),
  datasetItemId: z.string().min(1)
});
export type TraceTestRunSource = z.infer<typeof TraceTestRunSourceSchema>;

export const EvalRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  datasetId: z.string().nullable(),
  datasetRevisionId: z.string().nullable().optional(),
  skillVersionId: z.string(),
  trigger: EvalRunTriggerSchema,
  status: EvalRunStatusSchema,
  blocking: z.boolean(),
  totalItems: z.number().int().nonnegative(),
  completedItems: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  // Items with an expectedLabel whose result matched; items without ground
  // truth never count here.
  agreedItems: z.number().int().nonnegative(),
  error: z.string().nullable(),
  sourceTraceTest: TraceTestRunSourceSchema.nullable().default(null),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable()
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

export const EvalRunItemSchema = z.object({
  id: z.string(),
  evalRunId: z.string(),
  caseId: z.string(),
  datasetItemId: z.string().nullable(),
  datasetRevisionItemId: z.string().nullable().optional(),
  clientItemId: z.string().nullable(),
  contentDigest: z.string().nullable(),
  status: EvalRunItemStatusSchema,
  verdictId: z.string().nullable(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  // snapshot of the dataset item's step expectation at run time.
  expectedFailStep: z.number().int().nonnegative().nullable(),
  // The step the judge named (from the verdict payload). Schema-only until T3
  // populates it.
  failingStep: z.number().int().nonnegative().nullable(),
  resultLabel: z.string().nullable(),
  agreement: z.boolean().nullable(),
  // True/false only when BOTH expectedFailStep and failingStep exist; never
  // blended into overall agreement (counts reported separately).
  stepAgreement: z.boolean().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  // this item's judge-call token usage (null = cached item, failed
  // item, or provider didn't report — see the run-level spend summary).
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  // Metadata from THIS item's provider call. Null means cached/pending/failed
  // before a provider response; nullable fields inside mean unreported.
  providerMetadata: ProviderResponseMetadataSchema.nullable().optional(),
  // True when the item reused an already-recorded verdict (batch idempotency)
  // instead of spending provider tokens.
  cached: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable()
});
export type EvalRunItem = z.infer<typeof EvalRunItemSchema>;

// run-level spend — tokens and counts, never dollars. Token sums are
// null when NOTHING reported usage (no fresh calls, or all unreported);
// usageMissingCount names the fresh completed items whose call didn't report.
export const EvalRunSpendSchema = z.object({
  freshItems: z.number().int().nonnegative(),
  cachedItems: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  usageMissingCount: z.number().int().nonnegative(),
  totalLatencyMs: z.number().int().nonnegative().nullable()
});
export type EvalRunSpend = z.infer<typeof EvalRunSpendSchema>;

export const EvalRunDetailSchema = EvalRunSchema.extend({
  items: z.array(EvalRunItemSchema),
  spend: EvalRunSpendSchema
});
export type EvalRunDetail = z.infer<typeof EvalRunDetailSchema>;

export const TraceTestRunOutcomeSchema = z.enum(["running", "passed", "regressed", "needs_review", "could_not_run"]);
export type TraceTestRunOutcome = z.infer<typeof TraceTestRunOutcomeSchema>;

export function traceTestRunOutcome(run: EvalRunDetail): TraceTestRunOutcome {
  if (run.status === "pending" || run.status === "running") return "running";
  if (run.status === "failed" || run.status === "canceled") return "could_not_run";
  const source = run.sourceTraceTest;
  const item = source
    ? run.items.find((candidate) => candidate.datasetItemId === source.datasetItemId || candidate.caseId === source.caseId)
    : run.items.length === 1 ? run.items[0] : undefined;
  if (!item || item.status === "failed" || item.status === "skipped") return "could_not_run";
  if (item.status !== "completed" || item.resultLabel === "ambiguous" || item.agreement === null) return "needs_review";
  return item.agreement ? "passed" : "regressed";
}

export const StartTraceTestRunInputSchema = z.object({
  datasetId: z.string().min(1).optional()
});
export type StartTraceTestRunInput = z.infer<typeof StartTraceTestRunInputSchema>;

export const TraceTestRunResultSchema = z.object({
  dataset: DatasetSchema,
  run: EvalRunDetailSchema,
  outcome: TraceTestRunOutcomeSchema
});
export type TraceTestRunResult = z.infer<typeof TraceTestRunResultSchema>;

// Privacy-bounded activation telemetry for the beginner trace-to-test journey.
// This schema is intentionally closed: source ids, prompts, outputs, draft
// fields, and arbitrary metadata cannot cross the analytics boundary.
export const TraceTestFunnelEventNameSchema = z.enum([
  "started",
  "draft_saved",
  "validation_completed",
  "enabled",
  "correction_recorded",
  "run_started",
  "abandoned"
]);
export type TraceTestFunnelEventName = z.infer<typeof TraceTestFunnelEventNameSchema>;

export const TraceTestFunnelEventInputSchema = z.object({
  journeyId: z.string().uuid(),
  event: TraceTestFunnelEventNameSchema,
  elapsedMs: z.number().int().min(0).max(86_400_000),
  intent: z.enum(["prevent", "protect", "make"])
}).strict();
export type TraceTestFunnelEventInput = z.infer<typeof TraceTestFunnelEventInputSchema>;

export const CreateEvalRunInputSchema = z.object({
  datasetId: z.string().min(1).optional(),
  datasetRevisionId: z.string().min(1).optional(),
  // Defaults to the project's current skill version.
  skillVersionId: z.string().min(1).optional()
}).superRefine((input, ctx) => {
  if ((input.datasetId ? 1 : 0) + (input.datasetRevisionId ? 1 : 0) !== 1) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of datasetId or datasetRevisionId" });
  }
});
export type CreateEvalRunInput = z.infer<typeof CreateEvalRunInputSchema>;

// Run comparisons ("Incident Bisect", compare-on-dataset slice): one dataset,
// two skill versions, two ordinary eval runs created through the standard
// eval-run path. The persisted row only pins the participants; the per-case
// diff is computed at read time by joining both runs' items on caseId.
export const RunComparisonSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  datasetId: z.string(),
  datasetRevisionId: z.string().nullable().optional(),
  versionAId: z.string(),
  versionBId: z.string(),
  runAId: z.string(),
  runBId: z.string(),
  createdAt: z.string()
});
export type RunComparison = z.infer<typeof RunComparisonSchema>;

export const CreateRunComparisonInputSchema = z.object({
  datasetId: z.string().min(1),
  versionAId: z.string().min(1),
  versionBId: z.string().min(1)
});
export type CreateRunComparisonInput = z.infer<typeof CreateRunComparisonInputSchema>;

// Per-case diff buckets. Labels are projected pass / non-pass for bucketing
// (an ambiguous verdict is a non-pass for bisect purposes — the incident
// question is "where did passes stop passing"), so fail↔ambiguous is
// same-fail, not a flip. `pending` = either run hasn't judged the case yet;
// `missing` = the case has no judgment in one run (absent from the snapshot,
// failed, or skipped) — named, never silently dropped from a denominator.
export const RunComparisonBucketSchema = z.enum([
  "same-pass",
  "same-fail",
  "flipped-now-failing",
  "flipped-now-passing",
  "pending",
  "missing"
]);
export type RunComparisonBucket = z.infer<typeof RunComparisonBucketSchema>;

export const RunComparisonCaseSchema = z.object({
  caseId: z.string(),
  // Snapshot expectation (from either run's item — identical when both
  // snapshotted the same dataset row).
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  // The judge's recorded label per run, null when the case never completed
  // in that run (status tells why: pending / failed / skipped / absent).
  // string, not VerdictLabelSchema: snapshots EvalRunItem.resultLabel, which
  // is string-typed end-to-end — tighten both together or neither.
  labelA: z.string().nullable(),
  labelB: z.string().nullable(),
  // null status = the case is absent from that run's snapshot.
  statusA: EvalRunItemStatusSchema.nullable(),
  statusB: EvalRunItemStatusSchema.nullable(),
  bucket: RunComparisonBucketSchema
});
export type RunComparisonCase = z.infer<typeof RunComparisonCaseSchema>;

export const RunComparisonBucketCountsSchema = z.object({
  "same-pass": z.number().int().nonnegative(),
  "same-fail": z.number().int().nonnegative(),
  "flipped-now-failing": z.number().int().nonnegative(),
  "flipped-now-passing": z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative()
});
export type RunComparisonBucketCounts = z.infer<typeof RunComparisonBucketCountsSchema>;

// Per-version agreement over the comparison's run: agreed of labeled, where
// labeled counts only items that carried an expectedLabel AND completed —
// the honest denominator (an infrastructure failure is not a disagreement).
export const RunComparisonAgreementSchema = z.object({
  agreed: z.number().int().nonnegative(),
  labeled: z.number().int().nonnegative()
});
export type RunComparisonAgreement = z.infer<typeof RunComparisonAgreementSchema>;

export const RunComparisonDetailSchema = RunComparisonSchema.extend({
  // 'pending' until BOTH runs reached a terminal status — the poll signal.
  status: z.enum(["pending", "completed"]),
  runA: EvalRunSchema,
  runB: EvalRunSchema,
  agreementA: RunComparisonAgreementSchema,
  agreementB: RunComparisonAgreementSchema,
  buckets: RunComparisonBucketCountsSchema,
  cases: z.array(RunComparisonCaseSchema)
});
export type RunComparisonDetail = z.infer<typeof RunComparisonDetailSchema>;

// Body for POST /api/v1/judge/batch — fire-and-poll variant of /api/v1/judge.
// Each item reuses the manual-import trace shape; the response is 202 with an
// eval run id to poll. `datasetId` optionally appends the imported cases to an
// existing dataset so the batch is re-runnable later.
// batch items may carry the caller's expected label so CI runs report
// agreement. Labels are claims, not reviews (locked decision) — they land on
// dataset items / eval-run snapshots, never as verdict rows.
export const JudgeBatchItemSchema = ManualTraceImportInputSchema.extend({
  // Caller-owned join identity: preserve every code unit exactly. Trimming
  // would make the receipt impossible to join back to a valid submitted id.
  clientItemId: z.string().min(1).max(240).optional(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).optional(),
  // same cross-field rule as dataset examples (fail-only, in range of
  // THIS item's steps).
  expectedFailStep: z.number().int().nonnegative().optional()
}).superRefine(validateStepExpectation);
export type JudgeBatchItem = z.infer<typeof JudgeBatchItemSchema>;

export const JudgeBatchRequestSchema = z.object({
  purpose: z.enum(["general", "release_evidence"]).default("general"),
  items: z.array(JudgeBatchItemSchema).min(1),
  skillVersionId: z.string().min(1).optional(),
  datasetId: z.string().min(1).optional()
}).superRefine((request, ctx) => {
  if (request.purpose !== "release_evidence") return;
  const seen = new Set<string>();
  request.items.forEach((item, index) => {
    if (!item.clientItemId) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "clientItemId"],
        message: "clientItemId is required when purpose is release_evidence"
      });
      return;
    }
    if (seen.has(item.clientItemId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "clientItemId"],
        message: "clientItemId must be unique within release_evidence batches"
      });
    }
    seen.add(item.clientItemId);
  });
});
export type JudgeBatchRequest = z.infer<typeof JudgeBatchRequestSchema>;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const AssessmentReceiptItemSchema = z.object({
  clientItemId: z.string().min(1),
  caseId: z.string().min(1),
  status: EvalRunItemStatusSchema,
  judgedLabel: VerdictLabelSchema.nullable(),
  verdictId: z.string().nullable(),
  error: z.string().nullable(),
  contentDigest: Sha256DigestSchema,
  providerMetadata: ProviderResponseMetadataSchema.strict()
}).strict();
export type AssessmentReceiptItem = z.infer<typeof AssessmentReceiptItemSchema>;

export const AssessmentReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: z.string().min(1),
  evalRunId: z.string().min(1),
  projectId: z.string().min(1),
  skillId: z.string().min(1),
  skillVersionId: z.string().min(1),
  status: z.enum(["complete", "incomplete"]),
  run: z.object({
    status: EvalRunStatusSchema,
    totalItems: z.number().int().nonnegative(),
    completedItems: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
    agreedItems: z.number().int().nonnegative()
  }).strict(),
  requestedModelBinding: ModelBindingSchema.strict(),
  skillDigest: Sha256DigestSchema,
  datasetDigest: Sha256DigestSchema,
  items: z.array(AssessmentReceiptItemSchema),
  evidenceDigest: Sha256DigestSchema
}).strict();
export type AssessmentReceipt = z.infer<typeof AssessmentReceiptSchema>;
