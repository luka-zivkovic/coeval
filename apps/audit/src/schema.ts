import { z } from "zod";

export const LabelSchema = z.enum(["pass", "fail", "ambiguous"]);
export type Label = z.infer<typeof LabelSchema>;

export const JsonRecordSchema = z.record(z.string(), z.unknown());

export const TraceSchema = z.object({
  id: z.string().min(1),
  input: z.unknown(),
  output: z.unknown(),
  metadata: JsonRecordSchema.optional(),
  // supplied agent-trajectory steps. Providers serialize the whole
  // trace object into the judge prompt, so steps present here are what the
  // judge sees — this schema is the delivery gate.
  steps: z.array(z.object({
    name: z.string().optional(),
    input: z.unknown(),
    output: z.unknown(),
    metadata: JsonRecordSchema.optional()
  })).optional(),
  createdAt: z.string().optional(),
  normalizedText: z.string().optional()
});
export type Trace = z.infer<typeof TraceSchema>;

export const JudgePromptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
  kind: z.enum(["submitted", "unified", "regression-demo"]).default("submitted")
});
export type JudgePrompt = z.infer<typeof JudgePromptSchema>;

export const HumanLabelSchema = z.object({
  traceId: z.string().min(1),
  label: LabelSchema,
  reason: z.string().optional(),
  failureCategory: z.string().optional(),
  expectedBehavior: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  reviewerId: z.string().default("human")
});
export type HumanLabel = z.infer<typeof HumanLabelSchema>;

export const JudgeVerdictSchema = z.object({
  label: LabelSchema,
  score: z.number().min(0).max(1),
  reason: z.string().min(1),
  failureCategory: z.string().optional(),
  expectedBehavior: z.string().optional(),
  confidence: z.number().min(0).max(1),
  criteria: JsonRecordSchema.optional(),
  raw: z.unknown().optional()
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JudgeRunSchema = z.object({
  promptId: z.string(),
  promptName: z.string(),
  promptKind: z.enum(["submitted", "unified", "regression-demo"]),
  traceId: z.string(),
  attempt: z.number().int().min(1),
  verdict: JudgeVerdictSchema.optional(),
  startedAt: z.string(),
  completedAt: z.string(),
  error: z.string().optional()
});
export type JudgeRun = z.infer<typeof JudgeRunSchema>;

export const AgreementStatsSchema = z.object({
  compared: z.number().int().nonnegative(),
  agreed: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable()
});
export type AgreementStats = z.infer<typeof AgreementStatsSchema>;

export const PromptMetricSchema = z.object({
  promptId: z.string(),
  promptName: z.string(),
  promptKind: z.enum(["submitted", "unified", "regression-demo"]),
  agreementWithHumans: AgreementStatsSchema,
  kappaWithHumans: z.number().nullable(),
  tooStrict: z.number().int().nonnegative(),
  tooLenient: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  invalidRuns: z.number().int().nonnegative()
});
export type PromptMetric = z.infer<typeof PromptMetricSchema>;

export const PairwiseDivergenceSchema = z.object({
  promptAId: z.string(),
  promptAName: z.string(),
  promptBId: z.string(),
  promptBName: z.string(),
  compared: z.number().int().nonnegative(),
  disagreements: z.number().int().nonnegative(),
  divergenceRate: z.number().min(0).max(1).nullable()
});
export type PairwiseDivergence = z.infer<typeof PairwiseDivergenceSchema>;

export const DisagreementSchema = z.object({
  traceId: z.string(),
  promptId: z.string(),
  promptName: z.string(),
  judgeLabel: LabelSchema,
  humanLabel: LabelSchema,
  bucket: z.enum([
    "skill_too_strict",
    "skill_too_lenient",
    "ambiguous",
    "human_label_question",
    "rubric_unclear",
    "other"
  ]),
  reason: z.string().optional()
});
export type Disagreement = z.infer<typeof DisagreementSchema>;


export const HumanDisagreementSchema = z.object({
  traceId: z.string(),
  reviewerCount: z.number().int().min(2),
  labels: z.array(
    z.object({
      reviewerId: z.string(),
      label: LabelSchema,
      confidence: z.number().min(0).max(1),
      reason: z.string().optional()
    })
  ),
  uniqueLabels: z.array(LabelSchema),
  reason: z.string()
});
export type HumanDisagreement = z.infer<typeof HumanDisagreementSchema>;

export const GoldenSetCandidateSchema = z.object({
  traceId: z.string(),
  agreedLabel: LabelSchema.exclude(["ambiguous"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
  source: z.enum(["single-human", "multi-human-agreement"])
});
export type GoldenSetCandidate = z.infer<typeof GoldenSetCandidateSchema>;

export const FlakyCaseSchema = z.object({
  promptId: z.string(),
  promptName: z.string(),
  traceId: z.string(),
  attempts: z.number().int().positive(),
  labels: z.array(LabelSchema),
  reason: z.string()
});
export type FlakyCase = z.infer<typeof FlakyCaseSchema>;

export const StaleCaseSchema = z.object({
  traceId: z.string(),
  signals: z.array(z.string()),
  reason: z.string()
});
export type StaleCase = z.infer<typeof StaleCaseSchema>;

export const AuditSummarySchema = z.object({
  generatedAt: z.string(),
  traceCount: z.number().int().nonnegative(),
  submittedPromptCount: z.number().int().nonnegative(),
  humanLabelCount: z.number().int().nonnegative(),
  promptMetrics: z.array(PromptMetricSchema),
  pairwiseDivergence: z.array(PairwiseDivergenceSchema),
  disagreements: z.array(DisagreementSchema),
  humanDisagreements: z.array(HumanDisagreementSchema),
  flakyCases: z.array(FlakyCaseSchema),
  staleCases: z.array(StaleCaseSchema),
  goldenSetCandidates: z.array(GoldenSetCandidateSchema),
  regressionDemo: z
    .object({
      compared: z.number().int().nonnegative(),
      flipped: z.number().int().nonnegative(),
      flipRate: z.number().min(0).max(1).nullable()
    })
    .optional()
});
export type AuditSummary = z.infer<typeof AuditSummarySchema>;
