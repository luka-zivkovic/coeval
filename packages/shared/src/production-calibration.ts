import { z } from "zod";

import { containsLoneUtf16Surrogate } from "./judge.js";

// Production calibration measures whether a classifier's stated probabilities
// held up against the outcomes that arrived later on the customer's own
// traffic. It shares sealed binary calibration's rate conventions (exact
// numerator/denominator pairs, 95% Wilson score intervals, explicit undefined
// rates with a reason, provider identity grouping) but it is continuous,
// unsealed, and outcome-sourced evidence: nothing here is governed-blind truth
// and the artifact says so in its `evidence` block. Counts are unbounded safe
// integers because a ledger grows with traffic, and Wilson bounds travel as
// ordinary finite numbers because this artifact is a report over records, not
// a digest-pinned commitment.
//
// Report v2 adds score (ordinal) calibration and the time window a report
// covers. No v1 report was ever stored, so v1 has no parser here.
//
// The input record shapes are ported field-for-field from jevkit's decision
// ledger so that one of its JSON Lines entries validates unchanged. The state a
// decision was made on is never stored: only its digest and length travel.

export const PRODUCTION_DECISION_RECORD_CONTRACT = "rubrist/production-decision-record/v1" as const;
export const PRODUCTION_CALIBRATION_CONTRACT = "rubrist/production-calibration/v2" as const;
export const PRODUCTION_CALIBRATION_METRIC_DEFINITION_VERSION = "production-calibration-metrics/v2" as const;
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
/** A score answer describes an ordered rubric of 2 to 10 levels. */
export const PRODUCTION_CALIBRATION_MIN_SCORE_LEVELS = 2;
export const PRODUCTION_CALIBRATION_MAX_SCORE_LEVELS = 10;
/** Score probabilities must sum to 1 within this tolerance; the analysis then divides them by their sum. */
export const PRODUCTION_CALIBRATION_SCORE_SUM_TOLERANCE = 0.01;
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
// Output artifact: rubrist/production-calibration/v2
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

const ProductionCalibrationScoreLevelsSchema = z.number().int()
  .min(PRODUCTION_CALIBRATION_MIN_SCORE_LEVELS)
  .max(PRODUCTION_CALIBRATION_MAX_SCORE_LEVELS);
const ProductionCalibrationScoreLevelSchema = z.number().int().min(0).max(PRODUCTION_CALIBRATION_MAX_SCORE_LEVELS - 1);

export const ProductionCalibrationScoreLevelCountSchema = z.object({
  levels: ProductionCalibrationScoreLevelsSchema,
  decisions: ProductionCalibrationPositiveCountSchema
}).strict();
export type ProductionCalibrationScoreLevelCount = z.infer<typeof ProductionCalibrationScoreLevelCountSchema>;

export const ProductionCalibrationScoreExclusionsSchema = z.object({
  /**
   * Answers left out of every score metric: a level count outside 2 to 10,
   * probabilities that do not sum to 1 within 0.01, or a mean outside
   * [0, levels - 1].
   */
  invalidAnswer: ProductionCalibrationCountSchema,
  /** Valid answers whose numeric outcome is not an integer level of their own scale. */
  outcomeOutOfRange: ProductionCalibrationCountSchema
}).strict();
export type ProductionCalibrationScoreExclusions = z.infer<typeof ProductionCalibrationScoreExclusionsSchema>;

/** The event "outcome level >= atLeast", predicted by the summed probability of that level and every level above it. */
export const ProductionCalibrationScoreCutSchema = z.object({
  atLeast: z.number().int().min(1).max(PRODUCTION_CALIBRATION_MAX_SCORE_LEVELS - 1),
  /** Mean predicted probability over the decisions that have an outcome. */
  meanPredicted: ProductionCalibrationProbabilitySchema.nullable(),
  observedRate: ProductionCalibrationWilsonRateSchema,
  brier: ProductionCalibrationProbabilitySchema.nullable(),
  ece: ProductionCalibrationProbabilitySchema.nullable(),
  reliability: z.array(ProductionCalibrationReliabilityBinSchema).min(1).max(PRODUCTION_CALIBRATION_MAX_BINS)
}).strict();
export type ProductionCalibrationScoreCut = z.infer<typeof ProductionCalibrationScoreCutSchema>;

export const ProductionCalibrationScoreConfusionCellSchema = z.object({
  truth: ProductionCalibrationScoreLevelSchema,
  /** The most likely level; ties resolve to the lowest level. */
  predicted: ProductionCalibrationScoreLevelSchema,
  count: ProductionCalibrationPositiveCountSchema
}).strict();
export type ProductionCalibrationScoreConfusionCell = z.infer<typeof ProductionCalibrationScoreConfusionCellSchema>;

export const ProductionCalibrationScoreModelGroupSchema = z.object({
  model: ProductionCalibrationModelIdentitySchema,
  n: ProductionCalibrationCountSchema,
  nWithOutcome: ProductionCalibrationCountSchema,
  exactAccuracy: ProductionCalibrationWilsonRateSchema,
  meanAbsoluteError: ProductionCalibrationNonNegativeSchema.nullable(),
  rankedProbabilityScore: ProductionCalibrationProbabilitySchema.nullable()
}).strict();
export type ProductionCalibrationScoreModelGroup = z.infer<typeof ProductionCalibrationScoreModelGroupSchema>;

const ProductionCalibrationScoreBaseShape = {
  question: ProductionCalibrationTextSchema,
  /** Valid score answers to this question; excluded answers are counted in `excluded`. */
  n: ProductionCalibrationCountSchema,
  /** Valid answers whose outcome is an integer level of their own scale. */
  nWithOutcome: ProductionCalibrationCountSchema,
  excluded: ProductionCalibrationScoreExclusionsSchema,
  /** Every level count among the valid answers, ascending. */
  levelCounts: z.array(ProductionCalibrationScoreLevelCountSchema)
};

// Score metrics are defined only when every valid answer uses the same number
// of levels: level 3 of five and level 3 of ten are different claims. A
// question whose answers disagree, or has no valid answer, is explicitly
// undefined rather than averaged across scales.
export const ProductionCalibrationScoreSchema = z.discriminatedUnion("state", [
  z.object({
    ...ProductionCalibrationScoreBaseShape,
    state: z.literal("defined"),
    levels: ProductionCalibrationScoreLevelsSchema,
    bins: z.number().int().min(1).max(PRODUCTION_CALIBRATION_MAX_BINS),
    /** The most likely level equalled the outcome. */
    exactAccuracy: ProductionCalibrationWilsonRateSchema,
    /** The most likely level was at most one level from the outcome. */
    withinOneAccuracy: ProductionCalibrationWilsonRateSchema,
    /** Mean of |mean - outcome|, in levels; it treats the levels as evenly spaced. */
    meanAbsoluteError: ProductionCalibrationNonNegativeSchema.nullable(),
    /** Mean of (mean - outcome), in levels; positive means the answers scored above the outcome. */
    meanSignedError: ProductionCalibrationFiniteSchema.nullable(),
    /** Ranked probability score: the Brier score of every "level >= k" cut, averaged; 0 is perfect. */
    rankedProbabilityScore: ProductionCalibrationProbabilitySchema.nullable(),
    /** Reliability of the most likely level's probability against exact correctness, as for choice questions. */
    reliability: z.array(ProductionCalibrationReliabilityBinSchema).min(1).max(PRODUCTION_CALIBRATION_MAX_BINS),
    ece: ProductionCalibrationProbabilitySchema.nullable(),
    brier: ProductionCalibrationProbabilitySchema.nullable(),
    /** One cut per k from 1 to levels - 1. */
    cumulative: z.array(ProductionCalibrationScoreCutSchema),
    /** One cell per observed (truth, predicted) pair, sorted by truth then predicted. */
    confusion: z.array(ProductionCalibrationScoreConfusionCellSchema),
    byModel: z.array(ProductionCalibrationScoreModelGroupSchema)
  }).strict(),
  z.object({
    ...ProductionCalibrationScoreBaseShape,
    state: z.literal("undefined"),
    undefinedReason: z.enum(["mixed_levels", "no_valid_answers"])
  }).strict()
]);
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

/** The decisions a report covers, by decision time. */
export const ProductionCalibrationWindowSchema = z.object({
  /** Inclusive; null means no lower bound. */
  from: ProductionCalibrationTimestampSchema.nullable(),
  /** Exclusive; null means no upper bound. */
  to: ProductionCalibrationTimestampSchema.nullable()
}).strict();
export type ProductionCalibrationWindow = z.infer<typeof ProductionCalibrationWindowSchema>;

export const ProductionCalibrationArtifactSchema = z.object({
  contract: z.literal(PRODUCTION_CALIBRATION_CONTRACT),
  schemaVersion: z.literal(2),
  metricDefinitionVersion: z.literal(PRODUCTION_CALIBRATION_METRIC_DEFINITION_VERSION),
  intervalDefinitionVersion: z.literal(PRODUCTION_CALIBRATION_INTERVAL_DEFINITION_VERSION),
  generatedAt: ProductionCalibrationTimestampSchema,
  window: ProductionCalibrationWindowSchema,
  // What this evidence is and is not. Production outcomes are posted by the
  // customer's own people and signals after the decision was acted on; they
  // are not a sealed, governed-blind validation set.
  evidence: z.object({
    kind: z.literal("production_outcomes"),
    sealed: z.literal(false),
    independentHumanValidation: z.literal(false),
    /** Every supplied outcome except those attached to decisions outside the window. */
    outcomeSources: z.object({
      human: ProductionCalibrationCountSchema,
      automatic: ProductionCalibrationCountSchema,
      delayed: ProductionCalibrationCountSchema
    }).strict()
  }).strict(),
  // Totals count every record supplied. `outsideWindow` counts the decisions
  // before or after the window and the actions and outcomes attached to them;
  // everything else below, and every question, covers the window only.
  records: z.object({
    contract: z.literal(PRODUCTION_DECISION_RECORD_CONTRACT),
    decisions: z.object({
      total: ProductionCalibrationCountSchema,
      outsideWindow: ProductionCalibrationCountSchema,
      /** Decisions tagged `synthetic: "true"`; a report over only these describes no real traffic. */
      synthetic: ProductionCalibrationCountSchema,
      firstAt: ProductionCalibrationTimestampSchema.nullable(),
      lastAt: ProductionCalibrationTimestampSchema.nullable()
    }).strict(),
    actions: z.object({
      total: ProductionCalibrationCountSchema,
      /** Actions whose decision id is not in the input. */
      orphan: ProductionCalibrationCountSchema,
      outsideWindow: ProductionCalibrationCountSchema
    }).strict(),
    outcomes: z.object({
      total: ProductionCalibrationCountSchema,
      orphan: ProductionCalibrationCountSchema,
      outsideWindow: ProductionCalibrationCountSchema,
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
