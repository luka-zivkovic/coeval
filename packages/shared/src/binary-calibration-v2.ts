import { z } from "zod";

import {
  EvaluatorFailureKindSchema,
  EvaluatorItemStateSchema,
  SkillDigestInputSchema,
  type EvaluatorFailureKind
} from "./evaluator-execution.js";
import { containsLoneUtf16Surrogate } from "./judge.js";

// Binary calibration v2 (Rubrist ADR-0014 section 7) keeps v1's closed
// aggregate evidence contract and changes only what ADR-0014 names: the
// evaluator is the v2 execution binding and definition digest, failures use
// the shared taxonomy, items that never reached the provider are
// `notAttempted`, ledger records use the shared item result, and provider
// groups record the OpenRouter upstream. Counts are
// bounded by governed review's public 5,000-item selection cap, and every
// digest-covered number is an integer which is exactly representable by
// ECMAScript. Derived rates remain exact numerator/denominator pairs; Wilson
// bounds travel as their big-endian IEEE-754 binary64 bit patterns.
const BinaryCalibrationV2CountSchema = z.number().int().min(0).max(5_000);
const BinaryCalibrationV2PositiveCountSchema = z.number().int().min(1).max(5_000);
const BinaryCalibrationV2MetricComponentSchema = z.number().int().min(0).max(10_000);
const BinaryCalibrationV2SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const BinaryCalibrationV2NonEmptyStringSchema = z.string().min(1)
  .refine((value) => Array.from(value).length <= 4_096, {
    message: "Text must contain no more than 4,096 Unicode code points"
  })
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Text must not contain an unpaired UTF-16 surrogate"
  });

export const BinaryCalibrationV2Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const BinaryCalibrationV2Binary64BitsSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const BinaryCalibrationV2UtcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
);

export const BinaryCalibrationV2DefinedWilsonRateSchema = z.object({
  state: z.literal("defined"),
  numerator: BinaryCalibrationV2CountSchema,
  denominator: BinaryCalibrationV2PositiveCountSchema,
  interval: z.object({
    method: z.literal("wilson-score/v1"),
    confidenceBasisPoints: z.literal(9_500),
    lowerBinary64: BinaryCalibrationV2Binary64BitsSchema,
    upperBinary64: BinaryCalibrationV2Binary64BitsSchema
  }).strict()
}).strict();

export const BinaryCalibrationV2UndefinedWilsonRateSchema = z.object({
  state: z.literal("undefined"),
  numerator: z.literal(0),
  denominator: z.literal(0),
  undefinedReason: z.literal("zero_denominator"),
  interval: z.null()
}).strict();

export const BinaryCalibrationV2WilsonRateSchema = z.discriminatedUnion("state", [
  BinaryCalibrationV2DefinedWilsonRateSchema,
  BinaryCalibrationV2UndefinedWilsonRateSchema
]);
export type BinaryCalibrationV2WilsonRate = z.infer<typeof BinaryCalibrationV2WilsonRateSchema>;

export const BinaryCalibrationV2DefinedExactRateSchema = z.object({
  state: z.literal("defined"),
  numerator: BinaryCalibrationV2MetricComponentSchema,
  denominator: BinaryCalibrationV2MetricComponentSchema.refine((value) => value > 0)
}).strict();

export const BinaryCalibrationV2UndefinedExactRateSchema = z.object({
  state: z.literal("undefined"),
  numerator: BinaryCalibrationV2MetricComponentSchema,
  denominator: BinaryCalibrationV2MetricComponentSchema,
  undefinedReason: z.enum(["zero_denominator", "no_positive_truth_support"])
}).strict();

export const BinaryCalibrationV2ExactRateSchema = z.discriminatedUnion("state", [
  BinaryCalibrationV2DefinedExactRateSchema,
  BinaryCalibrationV2UndefinedExactRateSchema
]);
export type BinaryCalibrationV2ExactRate = z.infer<typeof BinaryCalibrationV2ExactRateSchema>;

export const BinaryCalibrationV2OutcomeCountsSchema = z.object({
  classified: BinaryCalibrationV2CountSchema,
  abstained: BinaryCalibrationV2CountSchema,
  errored: BinaryCalibrationV2CountSchema,
  notAttempted: BinaryCalibrationV2CountSchema
}).strict();
export type BinaryCalibrationV2OutcomeCounts = z.infer<typeof BinaryCalibrationV2OutcomeCountsSchema>;

export const BinaryCalibrationV2MatrixSchema = z.object({
  truthPassEvaluatorPass: BinaryCalibrationV2CountSchema,
  truthPassEvaluatorFail: BinaryCalibrationV2CountSchema,
  truthFailEvaluatorPass: BinaryCalibrationV2CountSchema,
  truthFailEvaluatorFail: BinaryCalibrationV2CountSchema
}).strict();
export type BinaryCalibrationV2Matrix = z.infer<typeof BinaryCalibrationV2MatrixSchema>;

export const BinaryCalibrationV2ProviderIdentityStrengthSchema = z.enum([
  "observed_version",
  "observed_fingerprint",
  "observed_model",
  "requested_only"
]);
export type BinaryCalibrationV2ProviderIdentityStrength = z.infer<
  typeof BinaryCalibrationV2ProviderIdentityStrengthSchema
>;

export const BinaryCalibrationV2ProviderIdentityGroupSchema = z.object({
  provider: BinaryCalibrationV2NonEmptyStringSchema,
  observedModel: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
  observedVersion: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
  systemFingerprint: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
  // The OpenRouter upstream that served the calls; null for every other provider.
  upstreamProvider: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
  identityStrength: BinaryCalibrationV2ProviderIdentityStrengthSchema,
  observationCount: BinaryCalibrationV2PositiveCountSchema
}).strict();
export type BinaryCalibrationV2ProviderIdentityGroup = z.infer<
  typeof BinaryCalibrationV2ProviderIdentityGroupSchema
>;

/** Error codes are the shared failure taxonomy (ADR-0014 section 6). */
export type BinaryCalibrationV2ErrorCode = EvaluatorFailureKind;

export const BinaryCalibrationV2PrivateProviderObservationSchema = z.object({
  provider: BinaryCalibrationV2NonEmptyStringSchema,
  observedModel: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
  observedVersion: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
  systemFingerprint: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
  upstreamProvider: BinaryCalibrationV2NonEmptyStringSchema.nullable()
}).strict();
export type BinaryCalibrationV2PrivateProviderObservation = z.infer<
  typeof BinaryCalibrationV2PrivateProviderObservationSchema
>;

export const BinaryCalibrationV2PrivateLedgerRecordSchema = z.object({
  datasetRevisionItemDigest: BinaryCalibrationV2Sha256DigestSchema,
  trialIndex: z.number().int().min(0).max(9),
  truthLabel: z.enum(["pass", "fail"]),
  // The shared item result (ADR-0014 section 6): an outcome, a failure, or not_attempted.
  result: EvaluatorItemStateSchema,
  attemptState: z.enum(["not_started", "started", "terminal"]),
  physicalProviderCalls: BinaryCalibrationV2SafeIntegerSchema,
  providerObservation: BinaryCalibrationV2PrivateProviderObservationSchema,
  commitmentSalt: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type BinaryCalibrationV2PrivateLedgerRecord = z.infer<
  typeof BinaryCalibrationV2PrivateLedgerRecordSchema
>;

export const BinaryCalibrationV2PrivateLedgerSchema = z.object({
  contract: z.literal("rubrist/binary-calibration-private-ledger/v2"),
  schemaVersion: z.literal(2),
  canonicalizationVersion: z.literal("rubrist-canonical-json/v1"),
  artifactId: BinaryCalibrationV2NonEmptyStringSchema,
  calibrationRunId: BinaryCalibrationV2NonEmptyStringSchema,
  projectId: BinaryCalibrationV2NonEmptyStringSchema,
  revisionDigest: BinaryCalibrationV2Sha256DigestSchema,
  requestedProvider: BinaryCalibrationV2NonEmptyStringSchema,
  itemCount: BinaryCalibrationV2PositiveCountSchema,
  trialsPerItem: z.number().int().min(1).max(10),
  records: z.array(BinaryCalibrationV2PrivateLedgerRecordSchema).min(1).max(50_000)
}).strict();
export type BinaryCalibrationV2PrivateLedger = z.infer<typeof BinaryCalibrationV2PrivateLedgerSchema>;

export const BinaryCalibrationV2TrialSchema = z.object({
  trialIndex: z.number().int().min(0).max(9),
  status: z.enum(["complete", "incomplete"]),
  outcomes: z.object({
    planned: BinaryCalibrationV2PositiveCountSchema,
    classified: BinaryCalibrationV2CountSchema,
    abstained: BinaryCalibrationV2CountSchema,
    errored: BinaryCalibrationV2CountSchema,
    notAttempted: BinaryCalibrationV2CountSchema,
    providerCalls: BinaryCalibrationV2SafeIntegerSchema,
    byTruth: z.object({
      pass: BinaryCalibrationV2OutcomeCountsSchema,
      fail: BinaryCalibrationV2OutcomeCountsSchema
    }).strict(),
    errors: z.array(z.object({
      code: EvaluatorFailureKindSchema,
      count: BinaryCalibrationV2PositiveCountSchema
    }).strict()).max(10)
  }).strict(),
  confusionMatrix: BinaryCalibrationV2MatrixSchema,
  errorDirections: z.object({
    falsePass: BinaryCalibrationV2CountSchema,
    falseFail: BinaryCalibrationV2CountSchema
  }).strict(),
  metrics: z.object({
    accuracy: BinaryCalibrationV2WilsonRateSchema,
    truthPassRecall: BinaryCalibrationV2WilsonRateSchema,
    truthFailRecall: BinaryCalibrationV2WilsonRateSchema,
    positiveClassPrecision: BinaryCalibrationV2WilsonRateSchema,
    positiveClassRecall: BinaryCalibrationV2WilsonRateSchema,
    positiveClassF1: BinaryCalibrationV2ExactRateSchema,
    classifiedCoverage: z.object({
      overall: BinaryCalibrationV2WilsonRateSchema,
      truthPass: BinaryCalibrationV2WilsonRateSchema,
      truthFail: BinaryCalibrationV2WilsonRateSchema
    }).strict()
  }).strict(),
  providerIdentityGroups: z.array(BinaryCalibrationV2ProviderIdentityGroupSchema).min(1).max(5_000)
}).strict();
export type BinaryCalibrationV2Trial = z.infer<typeof BinaryCalibrationV2TrialSchema>;

export const BinaryCalibrationV2CompletionEligibilityReasonSchema = z.enum([
  "authorization_snapshot_changed",
  "development_exposure_detected",
  "evaluator_reuse_ineligible",
  "exposure_state_unknown"
]);
export type BinaryCalibrationV2CompletionEligibilityReason = z.infer<
  typeof BinaryCalibrationV2CompletionEligibilityReasonSchema
>;

export const BinaryCalibrationV2IncompleteReasonSchema = z.enum([
  "trial_incomplete",
  "completion_exposure_exposed",
  "completion_exposure_ineligible"
]);
export type BinaryCalibrationV2IncompleteReason = z.infer<typeof BinaryCalibrationV2IncompleteReasonSchema>;

export const BinaryCalibrationV2RepresentativeIneligibleReasonSchema = z.enum([
  "selection_method_not_eligible",
  "population_frame_incomplete",
  "collection_provenance_unverified",
  "draw_not_server_executed",
  "draw_not_reproducible",
  "fixed_budget_mismatch",
  "strata_incomplete",
  "review_coverage_incomplete",
  "deferred_assignments",
  "cannot_determine_present",
  "unresolved_items"
]);
export type BinaryCalibrationV2RepresentativeIneligibleReason = z.infer<
  typeof BinaryCalibrationV2RepresentativeIneligibleReasonSchema
>;

export const BinaryCalibrationV2ArtifactSchema = z.object({
  contract: z.literal("rubrist/binary-calibration/v2"),
  schemaVersion: z.literal(2),
  canonicalizationVersion: z.literal("rubrist-canonical-json/v1"),
  artifactId: BinaryCalibrationV2NonEmptyStringSchema,
  calibrationRunId: BinaryCalibrationV2NonEmptyStringSchema,
  projectId: BinaryCalibrationV2NonEmptyStringSchema,
  lineage: z.object({
    artifactRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    predecessorArtifactId: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
    correctionReason: BinaryCalibrationV2NonEmptyStringSchema.nullable()
  }).strict(),
  status: z.enum(["complete", "incomplete"]),
  incompleteReasons: z.array(BinaryCalibrationV2IncompleteReasonSchema).max(3),
  createdAt: BinaryCalibrationV2UtcTimestampSchema,
  startedAt: BinaryCalibrationV2UtcTimestampSchema,
  completedAt: BinaryCalibrationV2UtcTimestampSchema,
  criterion: z.object({
    criterionId: BinaryCalibrationV2NonEmptyStringSchema,
    criterionVersionId: BinaryCalibrationV2NonEmptyStringSchema,
    criterionDigest: BinaryCalibrationV2Sha256DigestSchema
  }).strict(),
  evaluator: z.object({
    skillId: BinaryCalibrationV2NonEmptyStringSchema,
    skillVersionId: BinaryCalibrationV2NonEmptyStringSchema,
    // The same object receipt v2 carries as `evaluator`: the basis, the
    // definition digest, and the execution binding (ADR-0014 decision 5).
    identity: SkillDigestInputSchema,
    skillDigest: BinaryCalibrationV2Sha256DigestSchema,
    outputContractDigest: BinaryCalibrationV2Sha256DigestSchema,
    requestedBindingDigest: BinaryCalibrationV2Sha256DigestSchema
  }).strict(),
  suiteBinding: z.object({
    manifestId: BinaryCalibrationV2NonEmptyStringSchema,
    manifestDigest: BinaryCalibrationV2Sha256DigestSchema,
    memberPosition: z.number().int().min(0).max(99)
  }).strict().nullable(),
  truth: z.object({
    datasetRevisionId: BinaryCalibrationV2NonEmptyStringSchema,
    revisionDigest: BinaryCalibrationV2Sha256DigestSchema,
    contentDigest: BinaryCalibrationV2Sha256DigestSchema,
    itemCount: BinaryCalibrationV2PositiveCountSchema,
    role: z.literal("sealed_validation"),
    sourceKind: z.literal("sealed_intake"),
    provenanceLevel: z.literal("governed_blind"),
    semanticLeakageDetection: z.literal("unsupported"),
    representativeOfPopulationId: BinaryCalibrationV2NonEmptyStringSchema.nullable(),
    representativeIneligibleReasons: z.array(BinaryCalibrationV2RepresentativeIneligibleReasonSchema).max(11),
    selectionMethod: z.enum([
      "simple_random",
      "systematic",
      "stratified_random",
      "convenience",
      "uncertainty",
      "failure_hunting",
      "manual"
    ]),
    origin: z.object({
      governedReviewBatchId: BinaryCalibrationV2NonEmptyStringSchema,
      governedReviewBatchDigest: BinaryCalibrationV2Sha256DigestSchema,
      reviewInstructionVersionId: BinaryCalibrationV2NonEmptyStringSchema,
      reviewInstructionDigest: BinaryCalibrationV2Sha256DigestSchema,
      populationId: BinaryCalibrationV2NonEmptyStringSchema,
      populationDigest: BinaryCalibrationV2Sha256DigestSchema,
      drawDigest: BinaryCalibrationV2Sha256DigestSchema
    }).strict()
  }).strict(),
  exposure: z.object({
    authorization: z.object({
      state: z.literal("protected"),
      snapshotDigest: BinaryCalibrationV2Sha256DigestSchema,
      eventId: BinaryCalibrationV2NonEmptyStringSchema,
      recordedAt: BinaryCalibrationV2UtcTimestampSchema
    }).strict(),
    completion: z.object({
      state: z.enum(["protected", "exposed"]),
      snapshotDigest: BinaryCalibrationV2Sha256DigestSchema,
      eventId: BinaryCalibrationV2NonEmptyStringSchema,
      recordedAt: BinaryCalibrationV2UtcTimestampSchema,
      eligibility: z.object({
        result: z.enum(["eligible", "ineligible"]),
        reasons: z.array(BinaryCalibrationV2CompletionEligibilityReasonSchema).max(4)
      }).strict()
    }).strict()
  }).strict(),
  execution: z.object({
    definitionVersion: z.literal("sealed-binary-calibration-execution/v1"),
    providerDataHandling: z.object({
      executionEnvironment: z.enum(["external_provider", "self_hosted_provider", "local_provider"]),
      policyId: BinaryCalibrationV2NonEmptyStringSchema,
      policyDigest: BinaryCalibrationV2Sha256DigestSchema,
      payloadTransmission: z.literal("sealed_payload_to_pinned_provider")
    }).strict()
  }).strict(),
  positiveClass: z.enum(["pass", "fail"]),
  errorDirectionDefinitions: z.object({
    falsePass: z.literal("evaluator_pass_when_truth_fail"),
    falseFail: z.literal("evaluator_fail_when_truth_pass")
  }).strict(),
  metricDefinitionVersion: z.literal("binary-classification/v1"),
  intervalDefinitionVersion: z.literal("wilson-score/v1"),
  trialPlan: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("single"),
      trialsPerItem: z.literal(1)
    }).strict(),
    z.object({
      kind: z.literal("independent_repetitions"),
      trialsPerItem: z.number().int().min(2).max(10)
    }).strict()
  ]),
  truthSupport: z.object({
    total: BinaryCalibrationV2PositiveCountSchema,
    pass: BinaryCalibrationV2CountSchema,
    fail: BinaryCalibrationV2CountSchema
  }).strict(),
  privateLedger: z.object({
    contract: z.literal("rubrist/binary-calibration-private-ledger/v2"),
    commitmentDigest: BinaryCalibrationV2Sha256DigestSchema
  }).strict(),
  trials: z.array(BinaryCalibrationV2TrialSchema).min(1).max(10),
  evidenceDigest: BinaryCalibrationV2Sha256DigestSchema
}).strict();
export type BinaryCalibrationV2Artifact = z.infer<typeof BinaryCalibrationV2ArtifactSchema>;
