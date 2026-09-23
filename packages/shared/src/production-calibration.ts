import { z } from "zod";

import { containsLoneUtf16Surrogate } from "./judge.js";

// Production calibration v1 measures whether a classifier's stated
// probabilities held up against the outcomes that arrived later on the
// customer's own traffic. It shares sealed binary calibration's rate
// conventions (exact numerator/denominator pairs, 95% Wilson score intervals,
// explicit undefined rates with a reason, provider identity grouping) but it is
// continuous, unsealed, and outcome-sourced evidence: nothing here is
// governed-blind truth and the artifact says so in its `evidence` block.
// Counts are unbounded safe integers because a ledger grows with traffic, and
// Wilson bounds travel as ordinary finite numbers because this artifact is a
// report over records, not a digest-pinned commitment.
//
// The input record shapes are ported field-for-field from jevkit's decision
// ledger so that one of its JSON Lines entries validates unchanged. The state a
// decision was made on is never stored: only its digest and length travel.

export const PRODUCTION_DECISION_RECORD_CONTRACT = "rubrist/production-decision-record/v1" as const;
export const PRODUCTION_CALIBRATION_CONTRACT = "rubrist/production-calibration/v1" as const;
export const PRODUCTION_CALIBRATION_METRIC_DEFINITION_VERSION = "production-calibration-metrics/v1" as const;
export const PRODUCTION_CALIBRATION_INTERVAL_DEFINITION_VERSION = "wilson-score/v1" as const;
export const PRODUCTION_CALIBRATION_CONFIDENCE_BASIS_POINTS = 9_500 as const;
// Exact binary64 value 3fff5c0331eeff84, pinned by wilson-score/v1.
export const PRODUCTION_CALIBRATION_WILSON_Z = 1.959963984540054;
export const PRODUCTION_CALIBRATION_DEFAULT_BINS = 10;
export const PRODUCTION_CALIBRATION_DEFAULT_THRESHOLD = 0.5;
export const PRODUCTION_CALIBRATION_DEFAULT_WINDOW_DAYS = 7;
export const PRODUCTION_CALIBRATION_DEFAULT_MIN_OUTCOMES_TO_FLAG = 20;
export const PRODUCTION_CALIBRATION_MIN_ADVISABLE_OUTCOMES = 30;
export const PRODUCTION_CALIBRATION_MAX_BINS = 100;
/** Thresholds swept by the advisor: 0.05 to 0.95 in steps of 0.05. */
export const PRODUCTION_CALIBRATION_THRESHOLD_GRID: readonly number[] = Object.freeze(
  Array.from({ length: 19 }, (_, index) => Math.round((index + 1) * 5) / 100)
);

const ProductionCalibrationTextSchema = z.string().min(1)
  .refine((value) => Array.from(value).length <= 4_096, {
    message: "Text must contain no more than 4,096 Unicode code points"
  })
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Text must not contain an unpaired UTF-16 surrogate"
  });
const ProductionCalibrationNoteSchema = z.string()
  .refine((value) => Array.from(value).length <= 4_096, {
    message: "Text must contain no more than 4,096 Unicode code points"
  })
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Text must not contain an unpaired UTF-16 surrogate"
  });
const ProductionCalibrationCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ProductionCalibrationPositiveCountSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ProductionCalibrationFiniteSchema = z.number().finite();
const ProductionCalibrationNonNegativeSchema = z.number().finite().min(0);

export const ProductionCalibrationProbabilitySchema = z.number().finite().min(0).max(1);
export const ProductionCalibrationTimestampSchema = z.string().datetime({ offset: true });
export const ProductionCalibrationSha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

// ---------------------------------------------------------------------------
// Input records: rubrist/production-decision-record/v1
// ---------------------------------------------------------------------------

export const ProductionDecisionBooleanAnswerSchema = z.object({
  type: z.literal("boolean"),
  /** P(the statement is true). */
  probability: ProductionCalibrationProbabilitySchema
}).strict();
export type ProductionDecisionBooleanAnswer = z.infer<typeof ProductionDecisionBooleanAnswerSchema>;

export const ProductionDecisionChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: ProductionCalibrationTextSchema,
  probabilities: z.record(z.string(), ProductionCalibrationProbabilitySchema),
  confidence: ProductionCalibrationProbabilitySchema
}).strict();
export type ProductionDecisionChoiceAnswer = z.infer<typeof ProductionDecisionChoiceAnswerSchema>;

export const ProductionDecisionScoreAnswerSchema = z.object({
  type: z.literal("score"),
  /** Fractional mean over the ordered levels, 0 to levels.length - 1. */
  mean: ProductionCalibrationNonNegativeSchema,
  probabilities: z.array(ProductionCalibrationProbabilitySchema)
}).strict();
export type ProductionDecisionScoreAnswer = z.infer<typeof ProductionDecisionScoreAnswerSchema>;

export const ProductionDecisionAnswerSchema = z.discriminatedUnion("type", [
  ProductionDecisionBooleanAnswerSchema,
  ProductionDecisionChoiceAnswerSchema,
  ProductionDecisionScoreAnswerSchema
]);
export type ProductionDecisionAnswer = z.infer<typeof ProductionDecisionAnswerSchema>;
export type ProductionDecisionAnswerType = ProductionDecisionAnswer["type"];

export const ProductionDecisionUsageSchema = z.object({
  input_tokens: ProductionCalibrationCountSchema,
  output_tokens: ProductionCalibrationCountSchema
}).strict();
export type ProductionDecisionUsage = z.infer<typeof ProductionDecisionUsageSchema>;

export const ProductionDecisionQuestionSetRefSchema = z.object({
  name: ProductionCalibrationTextSchema,
  version: z.union([ProductionCalibrationTextSchema, ProductionCalibrationCountSchema]),
  digest: ProductionCalibrationSha256DigestSchema
}).strict();
export type ProductionDecisionQuestionSetRef = z.infer<typeof ProductionDecisionQuestionSetRefSchema>;

export const ProductionDecisionRecordSchema = z.object({
  kind: z.literal("decision"),
  id: ProductionCalibrationTextSchema,
  at: ProductionCalibrationTimestampSchema,
  questionSet: ProductionDecisionQuestionSetRefSchema,
  /** The model version the provider reported, or null when it did not say. */
  model: ProductionCalibrationTextSchema.nullable(),
  provider: ProductionCalibrationTextSchema,
  /** sha256 of the exact state text. The state itself is never stored. */
  stateDigest: ProductionCalibrationSha256DigestSchema,
  stateLength: ProductionCalibrationCountSchema,
  answers: z.record(z.string(), ProductionDecisionAnswerSchema),
  latencyMs: ProductionCalibrationNonNegativeSchema.nullable(),
  usage: ProductionDecisionUsageSchema.nullable(),
  tags: z.record(z.string(), z.string()).optional()
}).strict();
export type ProductionDecisionRecord = z.infer<typeof ProductionDecisionRecordSchema>;

export const ProductionActionThresholdSchema = z.union([
  ProductionCalibrationProbabilitySchema,
  z.object({
    low: ProductionCalibrationProbabilitySchema,
    high: ProductionCalibrationProbabilitySchema
  }).strict()
]).nullable();
export type ProductionActionThreshold = z.infer<typeof ProductionActionThresholdSchema>;

export const ProductionActionRecordSchema = z.object({
  kind: z.literal("action"),
  decisionId: ProductionCalibrationTextSchema,
  at: ProductionCalibrationTimestampSchema,
  question: ProductionCalibrationTextSchema,
  threshold: ProductionActionThresholdSchema,
  /** The policy outcome the caller applied, e.g. auto_retry or ask_human. */
  action: ProductionCalibrationTextSchema,
  by: ProductionCalibrationTextSchema.optional()
}).strict();
export type ProductionActionRecord = z.infer<typeof ProductionActionRecordSchema>;

export const ProductionOutcomeSourceSchema = z.enum(["human", "automatic", "delayed"]);
export type ProductionOutcomeSource = z.infer<typeof ProductionOutcomeSourceSchema>;

export const ProductionOutcomeValueSchema = z.union([
  z.boolean(),
  ProductionCalibrationTextSchema,
  ProductionCalibrationFiniteSchema
]);
export type ProductionOutcomeValue = z.infer<typeof ProductionOutcomeValueSchema>;

export const ProductionOutcomeRecordSchema = z.object({
  kind: z.literal("outcome"),
  decisionId: ProductionCalibrationTextSchema,
  at: ProductionCalibrationTimestampSchema,
  question: ProductionCalibrationTextSchema,
  /** boolean for boolean questions, the correct option for choice, the correct level index for score. */
  value: ProductionOutcomeValueSchema,
  source: ProductionOutcomeSourceSchema,
  by: ProductionCalibrationTextSchema.optional(),
  note: ProductionCalibrationNoteSchema.optional()
}).strict();
export type ProductionOutcomeRecord = z.infer<typeof ProductionOutcomeRecordSchema>;

export const ProductionDecisionLedgerRecordSchema = z.discriminatedUnion("kind", [
  ProductionDecisionRecordSchema,
  ProductionActionRecordSchema,
  ProductionOutcomeRecordSchema
]);
export type ProductionDecisionLedgerRecord = z.infer<typeof ProductionDecisionLedgerRecordSchema>;

// ---------------------------------------------------------------------------
// Output artifact: rubrist/production-calibration/v1
// ---------------------------------------------------------------------------

export const ProductionCalibrationDefinedWilsonRateSchema = z.object({
  state: z.literal("defined"),
  numerator: ProductionCalibrationCountSchema,
  denominator: ProductionCalibrationPositiveCountSchema,
  rate: ProductionCalibrationProbabilitySchema,
  interval: z.object({
    method: z.literal(PRODUCTION_CALIBRATION_INTERVAL_DEFINITION_VERSION),
    confidenceBasisPoints: z.literal(PRODUCTION_CALIBRATION_CONFIDENCE_BASIS_POINTS),
    lower: ProductionCalibrationProbabilitySchema,
    upper: ProductionCalibrationProbabilitySchema
  }).strict()
}).strict();
export type ProductionCalibrationDefinedWilsonRate = z.infer<typeof ProductionCalibrationDefinedWilsonRateSchema>;

export const ProductionCalibrationUndefinedWilsonRateSchema = z.object({
  state: z.literal("undefined"),
  numerator: z.literal(0),
  denominator: z.literal(0),
  undefinedReason: z.literal("zero_denominator"),
  interval: z.null()
}).strict();
export type ProductionCalibrationUndefinedWilsonRate = z.infer<typeof ProductionCalibrationUndefinedWilsonRateSchema>;

export const ProductionCalibrationWilsonRateSchema = z.discriminatedUnion("state", [
  ProductionCalibrationDefinedWilsonRateSchema,
  ProductionCalibrationUndefinedWilsonRateSchema
]);
export type ProductionCalibrationWilsonRate = z.infer<typeof ProductionCalibrationWilsonRateSchema>;

// The ledger records the model version the provider reported, or null when it
// did not say. That is the only provider identity available in production, so
// the group key is provider plus observed version and an unreported version is
// its own explicit group rather than a made-up name.
export const ProductionCalibrationModelIdentitySchema = z.object({
  provider: ProductionCalibrationTextSchema,
  observedModel: ProductionCalibrationTextSchema.nullable(),
  identityStrength: z.enum(["observed_version", "unreported"])
}).strict();
export type ProductionCalibrationModelIdentity = z.infer<typeof ProductionCalibrationModelIdentitySchema>;

export const ProductionCalibrationReliabilityBinSchema = z.object({
  index: ProductionCalibrationCountSchema,
  /** Inclusive lower bound. */
  lower: ProductionCalibrationProbabilitySchema,
  /** Exclusive upper bound, except the last bin which includes 1. */
  upper: ProductionCalibrationProbabilitySchema,
  count: ProductionCalibrationCountSchema,
  meanPredicted: ProductionCalibrationProbabilitySchema.nullable(),
  observedRate: ProductionCalibrationWilsonRateSchema
}).strict();
export type ProductionCalibrationReliabilityBin = z.infer<typeof ProductionCalibrationReliabilityBinSchema>;

export const ProductionCalibrationConfusionSchema = z.object({
  /** `p >= threshold` counts as predicted positive. */
  threshold: ProductionCalibrationProbabilitySchema,
  truePositive: ProductionCalibrationCountSchema,
  falsePositive: ProductionCalibrationCountSchema,
  trueNegative: ProductionCalibrationCountSchema,
  falseNegative: ProductionCalibrationCountSchema,
  accuracy: ProductionCalibrationWilsonRateSchema,
  precision: ProductionCalibrationWilsonRateSchema,
  recall: ProductionCalibrationWilsonRateSchema,
  specificity: ProductionCalibrationWilsonRateSchema
}).strict();
export type ProductionCalibrationConfusion = z.infer<typeof ProductionCalibrationConfusionSchema>;

export const ProductionCalibrationErrorDirectionSchema = z.object({
  definition: ProductionCalibrationTextSchema,
  count: ProductionCalibrationCountSchema
}).strict();
export type ProductionCalibrationErrorDirection = z.infer<typeof ProductionCalibrationErrorDirectionSchema>;

const ProductionCalibrationBinaryStatsShape = {
  n: ProductionCalibrationCountSchema,
  nWithOutcome: ProductionCalibrationCountSchema,
  /** Mean squared error between probability and outcome; 0 is perfect, 0.25 is "always say 0.5". */
  brier: ProductionCalibrationProbabilitySchema.nullable(),
  /** Expected calibration error: sum over bins of (count / n) times |observed - meanPredicted|. */
  ece: ProductionCalibrationProbabilitySchema.nullable()
};

export const ProductionCalibrationModelGroupSchema = z.object({
  model: ProductionCalibrationModelIdentitySchema,
  ...ProductionCalibrationBinaryStatsShape
}).strict();
export type ProductionCalibrationModelGroup = z.infer<typeof ProductionCalibrationModelGroupSchema>;

export const ProductionCalibrationDigestGroupSchema = z.object({
  questionSetDigest: ProductionCalibrationSha256DigestSchema,
  ...ProductionCalibrationBinaryStatsShape
}).strict();
export type ProductionCalibrationDigestGroup = z.infer<typeof ProductionCalibrationDigestGroupSchema>;

export const ProductionCalibrationBooleanSchema = z.object({
  question: ProductionCalibrationTextSchema,
  /** The answer treated as the event of interest; false flips both probability and outcome. */
  positiveClass: z.boolean(),
  bins: z.number().int().min(1).max(PRODUCTION_CALIBRATION_MAX_BINS),
  ...ProductionCalibrationBinaryStatsShape,
  reliability: z.array(ProductionCalibrationReliabilityBinSchema).min(1).max(PRODUCTION_CALIBRATION_MAX_BINS),
  confusion: ProductionCalibrationConfusionSchema,
  errorDirections: z.object({
    falsePositive: ProductionCalibrationErrorDirectionSchema,
    falseNegative: ProductionCalibrationErrorDirectionSchema
  }).strict(),
  byModel: z.array(ProductionCalibrationModelGroupSchema),
  byDigest: z.array(ProductionCalibrationDigestGroupSchema)
}).strict();
export type ProductionCalibrationBoolean = z.infer<typeof ProductionCalibrationBooleanSchema>;

export const ProductionCalibrationChoiceConfusionCellSchema = z.object({
  truth: ProductionCalibrationTextSchema,
  chosen: ProductionCalibrationTextSchema,
  count: ProductionCalibrationPositiveCountSchema
}).strict();
export type ProductionCalibrationChoiceConfusionCell = z.infer<typeof ProductionCalibrationChoiceConfusionCellSchema>;

export const ProductionCalibrationChoiceModelGroupSchema = z.object({
  model: ProductionCalibrationModelIdentitySchema,
  n: ProductionCalibrationCountSchema,
  nWithOutcome: ProductionCalibrationCountSchema,
  accuracy: ProductionCalibrationWilsonRateSchema,
  ece: ProductionCalibrationProbabilitySchema.nullable()
}).strict();
export type ProductionCalibrationChoiceModelGroup = z.infer<typeof ProductionCalibrationChoiceModelGroupSchema>;

export const ProductionCalibrationChoiceSchema = z.object({
  question: ProductionCalibrationTextSchema,
  bins: z.number().int().min(1).max(PRODUCTION_CALIBRATION_MAX_BINS),
  n: ProductionCalibrationCountSchema,
  nWithOutcome: ProductionCalibrationCountSchema,
  /** Top-1 accuracy: the chosen option equalled the outcome. */
  accuracy: ProductionCalibrationWilsonRateSchema,
  /** Reliability of `confidence` against top-1 correctness, the same machinery as the boolean case. */
  reliability: z.array(ProductionCalibrationReliabilityBinSchema).min(1).max(PRODUCTION_CALIBRATION_MAX_BINS),
  ece: ProductionCalibrationProbabilitySchema.nullable(),
  brier: ProductionCalibrationProbabilitySchema.nullable(),
  /** One cell per observed (truth, chosen) pair, sorted by truth then chosen. */
  confusion: z.array(ProductionCalibrationChoiceConfusionCellSchema),
  byModel: z.array(ProductionCalibrationChoiceModelGroupSchema)
}).strict();
export type ProductionCalibrationChoice = z.infer<typeof ProductionCalibrationChoiceSchema>;

export const ProductionCalibrationScoreSchema = z.object({
  question: ProductionCalibrationTextSchema,
  implemented: z.literal(false),
  reason: z.literal("ordinal_calibration_not_implemented"),
  n: ProductionCalibrationCountSchema,
  nWithOutcome: ProductionCalibrationCountSchema
}).strict();
export type ProductionCalibrationScore = z.infer<typeof ProductionCalibrationScoreSchema>;

export const ProductionCalibrationThresholdCostsSchema = z.object({
  /** Cost of acting on a positive that was not one. */
  falsePositive: ProductionCalibrationNonNegativeSchema,
  /** Cost of missing a positive. */
  falseNegative: ProductionCalibrationNonNegativeSchema,
  /** Cost of sending one decision to a person; null selects single-threshold mode. */
  humanReview: ProductionCalibrationNonNegativeSchema.nullable()
}).strict();
export type ProductionCalibrationThresholdCosts = z.infer<typeof ProductionCalibrationThresholdCostsSchema>;

export const ProductionCalibrationSingleSweepRowSchema = z.object({
  threshold: ProductionCalibrationProbabilitySchema,
  /** Every decision with an outcome is automated in single mode. */
  automated: ProductionCalibrationCountSchema,
  falsePositives: ProductionCalibrationCountSchema,
  falseNegatives: ProductionCalibrationCountSchema,
  errorRateAmongAutomated: ProductionCalibrationWilsonRateSchema,
  expectedCostPerDecision: ProductionCalibrationNonNegativeSchema
}).strict();
export type ProductionCalibrationSingleSweepRow = z.infer<typeof ProductionCalibrationSingleSweepRowSchema>;

export const ProductionCalibrationBandSweepRowSchema = z.object({
  low: ProductionCalibrationProbabilitySchema,
  high: ProductionCalibrationProbabilitySchema,
  automated: ProductionCalibrationCountSchema,
  humanReviews: ProductionCalibrationCountSchema,
  /** Share of decisions not sent to a person; 1 when there were no outcomes. */
  automationRate: ProductionCalibrationProbabilitySchema,
  falsePositives: ProductionCalibrationCountSchema,
  falseNegatives: ProductionCalibrationCountSchema,
  errorRateAmongAutomated: ProductionCalibrationWilsonRateSchema,
  expectedCostPerDecision: ProductionCalibrationNonNegativeSchema
}).strict();
export type ProductionCalibrationBandSweepRow = z.infer<typeof ProductionCalibrationBandSweepRowSchema>;

export const ProductionCalibrationAdviceCaveatSchema = z.enum(["no_outcomes", "fewer_than_30_outcomes"]);
export type ProductionCalibrationAdviceCaveat = z.infer<typeof ProductionCalibrationAdviceCaveatSchema>;

const ProductionCalibrationAdviceBaseShape = {
  question: ProductionCalibrationTextSchema,
  positiveClass: z.boolean(),
  /** Decisions with an outcome; the sweep runs over these only. */
  n: ProductionCalibrationCountSchema,
  costs: ProductionCalibrationThresholdCostsSchema,
  caveat: ProductionCalibrationAdviceCaveatSchema.nullable()
};

export const ProductionCalibrationThresholdAdviceSchema = z.discriminatedUnion("mode", [
  z.object({
    ...ProductionCalibrationAdviceBaseShape,
    mode: z.literal("single"),
    recommendation: ProductionCalibrationSingleSweepRowSchema.nullable(),
    sweep: z.array(ProductionCalibrationSingleSweepRowSchema).length(19)
  }).strict(),
  z.object({
    ...ProductionCalibrationAdviceBaseShape,
    mode: z.literal("band"),
    recommendation: ProductionCalibrationBandSweepRowSchema.nullable(),
    sweep: z.array(ProductionCalibrationBandSweepRowSchema).length(190)
  }).strict()
]);
export type ProductionCalibrationThresholdAdvice = z.infer<typeof ProductionCalibrationThresholdAdviceSchema>;

export const ProductionCalibrationDriftWindowSchema = z.object({
  index: ProductionCalibrationCountSchema,
  /** Start inclusive, end exclusive. */
  start: ProductionCalibrationTimestampSchema,
  end: ProductionCalibrationTimestampSchema,
  n: ProductionCalibrationCountSchema,
  nWithOutcome: ProductionCalibrationCountSchema,
  /** Mean probability over the decisions that have an outcome. */
  meanPredicted: ProductionCalibrationProbabilitySchema.nullable(),
  observedRate: ProductionCalibrationWilsonRateSchema,
  brier: ProductionCalibrationProbabilitySchema.nullable(),
  models: z.array(ProductionCalibrationModelIdentitySchema),
  /** A model identity appears that the previous non-empty window did not have. */
  modelChanged: z.boolean(),
  /** meanPredicted lies outside the observed 95% interval with at least minOutcomesToFlag outcomes. */
  driftFlag: z.boolean()
}).strict();
export type ProductionCalibrationDriftWindow = z.infer<typeof ProductionCalibrationDriftWindowSchema>;

export const ProductionCalibrationDriftSchema = z.object({
  question: ProductionCalibrationTextSchema,
  positiveClass: z.boolean(),
  windowDays: z.number().int().min(1).max(366),
  minOutcomesToFlag: ProductionCalibrationPositiveCountSchema,
  windows: z.array(ProductionCalibrationDriftWindowSchema)
}).strict();
export type ProductionCalibrationDrift = z.infer<typeof ProductionCalibrationDriftSchema>;

export const ProductionCalibrationQuestionSchema = z.discriminatedUnion("answerType", [
  z.object({
    question: ProductionCalibrationTextSchema,
    answerType: z.literal("boolean"),
    calibration: ProductionCalibrationBooleanSchema,
    /** Null when no costs were supplied for the question. */
    thresholdAdvice: ProductionCalibrationThresholdAdviceSchema.nullable(),
    drift: ProductionCalibrationDriftSchema
  }).strict(),
  z.object({
    question: ProductionCalibrationTextSchema,
    answerType: z.literal("choice"),
    calibration: ProductionCalibrationChoiceSchema
  }).strict(),
  z.object({
    question: ProductionCalibrationTextSchema,
    answerType: z.literal("score"),
    calibration: ProductionCalibrationScoreSchema
  }).strict()
]);
export type ProductionCalibrationQuestion = z.infer<typeof ProductionCalibrationQuestionSchema>;

export const ProductionCalibrationParametersSchema = z.object({
  bins: z.number().int().min(1).max(PRODUCTION_CALIBRATION_MAX_BINS),
  threshold: ProductionCalibrationProbabilitySchema,
  positiveClass: z.boolean(),
  windowDays: z.number().int().min(1).max(366),
  minOutcomesToFlag: ProductionCalibrationPositiveCountSchema
}).strict();
export type ProductionCalibrationParameters = z.infer<typeof ProductionCalibrationParametersSchema>;

export const ProductionCalibrationArtifactSchema = z.object({
  contract: z.literal(PRODUCTION_CALIBRATION_CONTRACT),
  schemaVersion: z.literal(1),
  metricDefinitionVersion: z.literal(PRODUCTION_CALIBRATION_METRIC_DEFINITION_VERSION),
  intervalDefinitionVersion: z.literal(PRODUCTION_CALIBRATION_INTERVAL_DEFINITION_VERSION),
  generatedAt: ProductionCalibrationTimestampSchema,
  // What this evidence is and is not. Production outcomes are posted by the
  // customer's own people and signals after the decision was acted on; they
  // are not a sealed, governed-blind validation set.
  evidence: z.object({
    kind: z.literal("production_outcomes"),
    sealed: z.literal(false),
    independentHumanValidation: z.literal(false),
    outcomeSources: z.object({
      human: ProductionCalibrationCountSchema,
      automatic: ProductionCalibrationCountSchema,
      delayed: ProductionCalibrationCountSchema
    }).strict()
  }).strict(),
  records: z.object({
    contract: z.literal(PRODUCTION_DECISION_RECORD_CONTRACT),
    decisions: z.object({
      total: ProductionCalibrationCountSchema,
      /** Decisions tagged `synthetic: "true"`; a report over only these describes no real traffic. */
      synthetic: ProductionCalibrationCountSchema,
      firstAt: ProductionCalibrationTimestampSchema.nullable(),
      lastAt: ProductionCalibrationTimestampSchema.nullable()
    }).strict(),
    actions: z.object({
      total: ProductionCalibrationCountSchema,
      /** Actions whose decision id is not in the input. */
      orphan: ProductionCalibrationCountSchema
    }).strict(),
    outcomes: z.object({
      total: ProductionCalibrationCountSchema,
      orphan: ProductionCalibrationCountSchema,
      /** Outcomes replaced by a later outcome for the same decision and question. */
      superseded: ProductionCalibrationCountSchema,
      /** Superseded outcomes whose value differs from the one that won. */
      conflicting: ProductionCalibrationCountSchema
    }).strict(),
    questionSets: z.array(z.object({
      name: ProductionCalibrationTextSchema,
      version: z.union([ProductionCalibrationTextSchema, ProductionCalibrationCountSchema]),
      digest: ProductionCalibrationSha256DigestSchema,
      decisions: ProductionCalibrationPositiveCountSchema
    }).strict()),
    models: z.array(z.object({
      model: ProductionCalibrationModelIdentitySchema,
      decisions: ProductionCalibrationPositiveCountSchema
    }).strict())
  }).strict(),
  parameters: ProductionCalibrationParametersSchema,
  questions: z.array(ProductionCalibrationQuestionSchema)
}).strict();
export type ProductionCalibrationArtifact = z.infer<typeof ProductionCalibrationArtifactSchema>;
