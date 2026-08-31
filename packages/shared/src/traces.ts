import { z } from "zod";

// one step of a supplied agent trajectory. A case with `steps` is a
// trajectory; a case without is exactly what it was before M2. Steps ride
// inside the normalized case payload — no separate table, no per-step verdict
// rows (locked M2 shape).
export const TraceStepSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const MAX_TRACE_STEPS = 50;
export const TraceStepsSchema = z
  .array(TraceStepSchema)
  .max(MAX_TRACE_STEPS, `a case supports at most ${MAX_TRACE_STEPS} steps`);

export const TracePayloadSchema = z.object({
  id: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  steps: TraceStepsSchema.optional()
});
export type TracePayload = z.infer<typeof TracePayloadSchema>;

export const ManualTraceImportInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  sourceTraceId: z.string().min(1).optional(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  steps: TraceStepsSchema.optional()
});
export type ManualTraceImportInput = z.infer<typeof ManualTraceImportInputSchema>;

export const ManualTraceImportResultSchema = z.object({
  rawTraceId: z.string(),
  caseId: z.string(),
  sourceTraceId: z.string(),
  queued: z.boolean(),
  queueJobId: z.string().nullable()
});
export type ManualTraceImportResult = z.infer<typeof ManualTraceImportResultSchema>;

export const TraceSourceSchema = z.enum(["manual", "langsmith", "langfuse", "ironside"]);
export type TraceSource = z.infer<typeof TraceSourceSchema>;

// Where a CASE came from: the trace-import sources plus 'gate_candidate' —
// the derived cases the product deploy gate mints (golden input + candidate
// output; stored in cases.case_type). Gate candidates are judging
// scaffolding, not customer traffic: they are excluded from the exceptions
// dashboard, the approval-time judge backfill (listCaseIdsForProject), and
// the imported-trace/dashboard counts. TraceSource stays the
// import-integration enum (import_jobs has a matching DB check constraint).
export const CaseSourceSchema = z.enum([...TraceSourceSchema.options, "gate_candidate", "release_evidence"]);
export type CaseSource = z.infer<typeof CaseSourceSchema>;

// Closed provenance vocabulary for Analyze population eligibility. Every new
// Every case writer must choose one current purpose explicitly. Keep this
// schema synchronized with the database CHECK constraint.
export const IngestionPurposeSchema = z.enum([
  "analysis_eligible_manual",
  "analysis_eligible_langsmith",
  "analysis_eligible_langfuse",
  "analysis_eligible_ironside",
  "judge_api",
  "judge_batch_general",
  "dataset_example",
  "trace_test_synthetic",
  "release_evidence"
]);
export type IngestionPurpose = z.infer<typeof IngestionPurposeSchema>;

export const RuntimeIngestionPurposeSchema = IngestionPurposeSchema;
export type RuntimeIngestionPurpose = z.infer<typeof RuntimeIngestionPurposeSchema>;
