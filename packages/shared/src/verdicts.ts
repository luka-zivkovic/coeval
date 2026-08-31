import { z } from "zod";

export const VerdictDistributionSchema = z.object({
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative()
});
export type VerdictDistribution = z.infer<typeof VerdictDistributionSchema>;

// v2 verdict primitives (greenfield rebuild). The legacy `VerdictLabelSchema`
// remains during co-existence; new code paths use the tagged-union shape below.
// Inspired by Braintrust's `choice_scores` (autoevals/py/autoevals/llm.py) + Opik
// `ScoreResult` (sdks/python/src/opik/evaluation/metrics/score_result.py).

// `adjudicated` (A2.2b-2): the recorded legacy ruling a human/panel sets on an
// ungoverned disagreement — the decision that closes this diagnostic loop. It is NOT a
// rater: every κ / disagreement computation filters on `human` / `llm_judge`
// explicitly, so an adjudicated verdict never distorts the agreement math; it
// only annotates which disagreements have been resolved and to what label.
export const VerdictSourceSchema = z.enum(["llm_judge", "human", "imported_external", "adjudicated"]);
export type VerdictSource = z.infer<typeof VerdictSourceSchema>;

// optional failingStep (0-based index into the case's steps) — schema
// only here; T3 teaches the judge to populate it. Lives inside the payload,
// consistent with append-only verdicts.
const FailingStepSchema = z.number().int().nonnegative();

export const BinaryClassifiedVerdictPayloadSchema = z.object({
  kind: z.literal("binary"),
  pass: z.boolean(),
  rationale: z.string(),
  failingStep: FailingStepSchema.optional()
}).strict();

// A binary evaluator may explicitly abstain when its rubric does not support
// either pass or fail. Keep `pass` absent so incorrect readers fail loudly
// instead of treating null or another falsy value as a failure.
export const BinaryAbstainedVerdictPayloadSchema = z.object({
  kind: z.literal("binary"),
  label: z.literal("ambiguous"),
  rationale: z.string()
}).strict();

export const BinaryVerdictPayloadSchema = z.union([
  BinaryClassifiedVerdictPayloadSchema,
  BinaryAbstainedVerdictPayloadSchema
]);

export const ScalarVerdictPayloadSchema = z
  .object({
    kind: z.literal("scalar"),
    score: z.number(),
    range: z.tuple([z.number(), z.number()]),
    rationale: z.string(),
    failingStep: FailingStepSchema.optional()
  })
  .refine((v) => v.range[0] < v.range[1], { message: "scalar range must be ascending" })
  .refine((v) => v.score >= v.range[0] && v.score <= v.range[1], { message: "scalar score must lie within range" });

export const CategoricalVerdictPayloadSchema = z
  .object({
    kind: z.literal("categorical"),
    choice: z.string().min(1),
    choiceScores: z.record(z.string(), z.number().min(0).max(1)),
    rationale: z.string(),
    failingStep: FailingStepSchema.optional()
  })
  .refine((v) => v.choice in v.choiceScores, { message: "chosen category must appear in choiceScores" });

export const VerdictPayloadSchema = z.union([
  BinaryVerdictPayloadSchema,
  ScalarVerdictPayloadSchema,
  CategoricalVerdictPayloadSchema
]);
export type VerdictPayload = z.infer<typeof VerdictPayloadSchema>;

export const VerdictRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string().nullable(),
  source: VerdictSourceSchema,
  actorUserId: z.string().nullable(),
  // Read projections resolve a display name from the authenticated user.
  // Mutation responses and imported/external verdicts may omit it; clients
  // fall back to actorUserId without weakening the append-only record.
  actorName: z.string().nullable().optional(),
  payload: VerdictPayloadSchema,
  externalRunId: z.string().nullable(),
  createdAt: z.string()
});
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>;
