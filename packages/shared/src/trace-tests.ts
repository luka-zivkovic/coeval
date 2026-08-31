import { z } from "zod";

import { MAX_TRACE_STEPS } from "./traces.js";

// Trace-to-test: a beginner-facing test derived from one retained source
// conversation. The stable identity owns provenance; every content change and
// validation is append-only so an enabled revision is never rewritten in
// place. Product copy calls these Tests, not eval cases.
export const TraceTestLifecycleSchema = z.enum(["draft", "enabled"]);
export type TraceTestLifecycle = z.infer<typeof TraceTestLifecycleSchema>;

const TraceTestPathSegmentSchema = z.union([
  z.string().min(1).max(200),
  z.number().int().nonnegative()
]);

export const TraceTestSourceScopeSchema = z.object({
  responsePath: z.array(TraceTestPathSegmentSchema).max(32),
  turnIndexes: z.array(z.number().int().nonnegative()).max(200).default([]),
  stepIndexes: z.array(z.number().int().nonnegative()).max(MAX_TRACE_STEPS).default([])
});
export type TraceTestSourceScope = z.infer<typeof TraceTestSourceScopeSchema>;

export const TraceTestDraftFieldSchema = z.enum([
  "scenario",
  "expectedBehavior",
  "mustDo",
  "mustAvoid",
  "goodExample",
  "badExample",
  "checker"
]);
export type TraceTestDraftField = z.infer<typeof TraceTestDraftFieldSchema>;

export const TraceTestDraftProvenanceSchema = z.object({
  origin: z.enum(["human", "generated", "mixed"]),
  generatedFields: z.array(TraceTestDraftFieldSchema).max(7).default([]),
  generator: z.object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    version: z.string().min(1).max(200).optional()
  }).nullable().default(null)
}).superRefine((value, ctx) => {
  if (value.origin === "human" && value.generatedFields.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["generatedFields"],
      message: "human drafts cannot declare generated fields"
    });
  }
  if (value.origin === "human" && value.generator !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["generator"],
      message: "human drafts cannot declare a generator"
    });
  }
  if (value.origin !== "human" && value.generatedFields.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["generatedFields"],
      message: "assisted drafts must identify generated fields"
    });
  }
  if (value.origin !== "human" && value.generator === null) {
    ctx.addIssue({
      code: "custom",
      path: ["generator"],
      message: "assisted drafts must identify their generator"
    });
  }
});
export type TraceTestDraftProvenance = z.infer<typeof TraceTestDraftProvenanceSchema>;

export const TraceTestCheckerSchema = z.object({
  kind: z.enum(["judge", "deterministic", "manual"]),
  label: z.string().min(1).max(120),
  metadata: z.record(z.string(), z.json()).default({})
});
export type TraceTestChecker = z.infer<typeof TraceTestCheckerSchema>;

const TraceTestExampleSchema = z.json();

export const TraceTestDraftContentSchema = z.object({
  scenario: z.string().trim().min(1).max(20_000),
  expectedBehavior: z.string().trim().min(1).max(20_000),
  mustDo: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  mustAvoid: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  goodExample: TraceTestExampleSchema,
  badExample: TraceTestExampleSchema,
  checker: TraceTestCheckerSchema,
  draftProvenance: TraceTestDraftProvenanceSchema
});
export type TraceTestDraftContent = z.infer<typeof TraceTestDraftContentSchema>;

export const TraceTestValidationOutcomeSchema = z.enum([
  "pass",
  "fail",
  "ambiguous",
  "evaluator_error",
  "unavailable",
  // Backward-compatible values for validations recorded before Batch 5.
  "needs_review",
  "could_not_run"
]);
export type TraceTestValidationOutcome = z.infer<typeof TraceTestValidationOutcomeSchema>;

export const TraceTestValidationStatusSchema = z.enum([
  "passed",
  "failed",
  "non_discriminating",
  "ambiguous",
  "evaluator_error",
  "unavailable",
  // Backward-compatible values for validations recorded before Batch 5.
  "needs_review",
  "could_not_run"
]);
export type TraceTestValidationStatus = z.infer<typeof TraceTestValidationStatusSchema>;

export const TraceTestValidationEvidenceInputSchema = z.object({
  output: TraceTestExampleSchema,
  result: TraceTestValidationOutcomeSchema,
  note: z.string().max(2_000).nullable().default(null)
});
export type TraceTestValidationEvidenceInput = z.infer<typeof TraceTestValidationEvidenceInputSchema>;

export const TraceTestValidationEvidenceSchema = TraceTestValidationEvidenceInputSchema.extend({
  expectedResult: z.enum(["pass", "fail"]),
  attempts: z.number().int().nonnegative().default(0),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative()
  }).nullable().default(null)
});
export type TraceTestValidationEvidence = z.infer<typeof TraceTestValidationEvidenceSchema>;

export const TraceTestValidationMethodSchema = z.enum(["automated", "manual_override"]);
export type TraceTestValidationMethod = z.infer<typeof TraceTestValidationMethodSchema>;

export const TraceTestValidationDiagnosticSchema = z.enum([
  "always_pass",
  "always_fail",
  "reversed",
  "ambiguous",
  "evaluator_error",
  "unavailable"
]);
export type TraceTestValidationDiagnostic = z.infer<typeof TraceTestValidationDiagnosticSchema>;

export const TraceTestValidationEvaluatorSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  version: z.string().min(1).max(200).optional()
});
export type TraceTestValidationEvaluator = z.infer<typeof TraceTestValidationEvaluatorSchema>;

export const TraceTestRevisionSchema = TraceTestDraftContentSchema.extend({
  id: z.string(),
  traceTestId: z.string(),
  revision: z.number().int().positive(),
  lifecycle: TraceTestLifecycleSchema,
  desiredBehavior: z.string().trim().min(1).max(20_000),
  validationId: z.string().nullable(),
  validatedRevision: z.number().int().positive().nullable(),
  createdByUserId: z.string().nullable(),
  reviewedByUserId: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable()
});
export type TraceTestRevision = z.infer<typeof TraceTestRevisionSchema>;

export const TraceTestValidationSchema = z.object({
  id: z.string(),
  traceTestId: z.string(),
  revision: z.number().int().positive(),
  status: TraceTestValidationStatusSchema,
  badEvidence: TraceTestValidationEvidenceSchema,
  goodEvidence: TraceTestValidationEvidenceSchema,
  method: TraceTestValidationMethodSchema,
  diagnostic: TraceTestValidationDiagnosticSchema.nullable().default(null),
  evaluator: TraceTestValidationEvaluatorSchema.nullable().default(null),
  overrideReason: z.string().max(2_000).nullable().default(null),
  recordedByUserId: z.string().nullable(),
  createdAt: z.string()
});
export type TraceTestValidation = z.infer<typeof TraceTestValidationSchema>;

export const TraceTestSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceCaseId: z.string().nullable(),
  sourceCaseRef: z.string(),
  sourceTraceRef: z.string(),
  lifecycle: TraceTestLifecycleSchema,
  currentRevision: z.number().int().positive(),
  enabledRevision: z.number().int().positive().nullable(),
  hasUnpublishedChanges: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TraceTestSummary = z.infer<typeof TraceTestSummarySchema>;

export const TraceTestDetailSchema = TraceTestSummarySchema.extend({
  sourceSnapshot: z.unknown(),
  sourceScope: TraceTestSourceScopeSchema,
  createdByUserId: z.string().nullable(),
  revisions: z.array(TraceTestRevisionSchema),
  validations: z.array(TraceTestValidationSchema)
});
export type TraceTestDetail = z.infer<typeof TraceTestDetailSchema>;

export const CreateTraceTestInputSchema = TraceTestDraftContentSchema.extend({
  sourceCaseId: z.string().min(1),
  sourceScope: TraceTestSourceScopeSchema,
  desiredBehavior: z.string().trim().min(1).max(20_000)
});
export type CreateTraceTestInput = z.infer<typeof CreateTraceTestInputSchema>;

// Optional model assistance for the beginner drafting step. The server owns
// source retrieval/redaction; clients identify the retained case and scope
// rather than posting trace content back across the trust boundary.
export const TraceTestDraftJobSchema = z.enum(["response", "preserve"]);
export type TraceTestDraftJob = z.infer<typeof TraceTestDraftJobSchema>;

export const AssistTraceTestDraftInputSchema = z.object({
  sourceCaseId: z.string().min(1),
  skillVersionId: z.string().min(1).optional(),
  sourceScope: TraceTestSourceScopeSchema,
  desiredBehavior: z.string().trim().min(1).max(20_000),
  job: TraceTestDraftJobSchema
});
export type AssistTraceTestDraftInput = z.infer<typeof AssistTraceTestDraftInputSchema>;

export const AssistedTraceTestContentSchema = z.object({
  scenario: z.string().trim().min(1).max(20_000),
  expectedBehavior: z.string().trim().min(1).max(20_000),
  mustDo: z.array(z.string().trim().min(1).max(2_000)).max(50),
  mustAvoid: z.array(z.string().trim().min(1).max(2_000)).max(50),
  goodExample: z.string().max(20_000),
  badExample: z.string().max(20_000),
  checker: TraceTestCheckerSchema.extend({ kind: z.enum(["judge", "manual"]) }),
  inferredContext: z.array(z.string().trim().min(1).max(1_000)).max(10)
});
export type AssistedTraceTestContent = z.infer<typeof AssistedTraceTestContentSchema>;

export const AssistedTraceTestDraftSchema = z.object({
  status: z.literal("generated"),
  content: AssistedTraceTestContentSchema,
  sourceScope: TraceTestSourceScopeSchema,
  draftProvenance: TraceTestDraftProvenanceSchema
});

export const AssistedTraceTestUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.enum(["missing_credentials", "unsupported_provider", "provider_error"]),
  message: z.string().min(1).max(500)
});

export const AssistTraceTestDraftResultSchema = z.discriminatedUnion("status", [
  AssistedTraceTestDraftSchema,
  AssistedTraceTestUnavailableSchema
]);
export type AssistTraceTestDraftResult = z.infer<typeof AssistTraceTestDraftResultSchema>;

export const ReviseTraceTestInputSchema = TraceTestDraftContentSchema.extend({
  expectedRevision: z.number().int().positive(),
  desiredBehavior: z.string().trim().min(1).max(20_000)
});
export type ReviseTraceTestInput = z.infer<typeof ReviseTraceTestInputSchema>;

export const RecordManualTraceTestValidationInputSchema = z.object({
  revision: z.number().int().positive(),
  badResult: z.enum(["pass", "fail", "ambiguous"]),
  goodResult: z.enum(["pass", "fail", "ambiguous"]),
  overrideReason: z.string().trim().min(10).max(2_000)
});
export type RecordManualTraceTestValidationInput = z.infer<typeof RecordManualTraceTestValidationInputSchema>;

export const RunTraceTestValidationInputSchema = z.object({
  revision: z.number().int().positive(),
  skillVersionId: z.string().min(1).optional()
});
export type RunTraceTestValidationInput = z.infer<typeof RunTraceTestValidationInputSchema>;

export const EnableTraceTestInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  validationId: z.string().min(1)
});
export type EnableTraceTestInput = z.infer<typeof EnableTraceTestInputSchema>;
