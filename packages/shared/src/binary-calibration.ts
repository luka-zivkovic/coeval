import { z } from "zod";

import { containsLoneUtf16Surrogate } from "./judge.js";

// Binary calibration v1 is a closed aggregate evidence contract. Counts are
// bounded by governed review's public 5,000-item selection cap, and every
// digest-covered number is an integer which is exactly representable by
// ECMAScript. Derived rates remain exact numerator/denominator pairs; Wilson
// bounds travel as their big-endian IEEE-754 binary64 bit patterns.
const BinaryCalibrationCountSchema = z.number().int().min(0).max(5_000);
const BinaryCalibrationPositiveCountSchema = z.number().int().min(1).max(5_000);
const BinaryCalibrationMetricComponentSchema = z.number().int().min(0).max(10_000);
const BinaryCalibrationSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const BinaryCalibrationNonEmptyStringSchema = z.string().min(1)
  .refine((value) => Array.from(value).length <= 4_096, {
    message: "Text must contain no more than 4,096 Unicode code points"
  })
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Text must not contain an unpaired UTF-16 surrogate"
  });
const BinaryCalibrationCanonicalDecimalSchema = z.string().max(32).regex(
  /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/
);

export const BinaryCalibrationSha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const BinaryCalibrationBinary64BitsSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const BinaryCalibrationUtcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
);

export const BinaryCalibrationDefinedWilsonRateSchema = z.object({
  state: z.literal("defined"),
  numerator: BinaryCalibrationCountSchema,
  denominator: BinaryCalibrationPositiveCountSchema,
  interval: z.object({
    method: z.literal("wilson-score/v1"),
    confidenceBasisPoints: z.literal(9_500),
    lowerBinary64: BinaryCalibrationBinary64BitsSchema,
    upperBinary64: BinaryCalibrationBinary64BitsSchema
  }).strict()
}).strict();

export const BinaryCalibrationUndefinedWilsonRateSchema = z.object({
  state: z.literal("undefined"),
  numerator: z.literal(0),
  denominator: z.literal(0),
  undefinedReason: z.literal("zero_denominator"),
  interval: z.null()
}).strict();

export const BinaryCalibrationWilsonRateSchema = z.discriminatedUnion("state", [
  BinaryCalibrationDefinedWilsonRateSchema,
  BinaryCalibrationUndefinedWilsonRateSchema
]);
export type BinaryCalibrationWilsonRate = z.infer<typeof BinaryCalibrationWilsonRateSchema>;

export const BinaryCalibrationDefinedExactRateSchema = z.object({
  state: z.literal("defined"),
  numerator: BinaryCalibrationMetricComponentSchema,
  denominator: BinaryCalibrationMetricComponentSchema.refine((value) => value > 0)
}).strict();

export const BinaryCalibrationUndefinedExactRateSchema = z.object({
  state: z.literal("undefined"),
  numerator: BinaryCalibrationMetricComponentSchema,
  denominator: BinaryCalibrationMetricComponentSchema,
  undefinedReason: z.enum(["zero_denominator", "no_positive_truth_support"])
}).strict();

export const BinaryCalibrationExactRateSchema = z.discriminatedUnion("state", [
  BinaryCalibrationDefinedExactRateSchema,
  BinaryCalibrationUndefinedExactRateSchema
]);
export type BinaryCalibrationExactRate = z.infer<typeof BinaryCalibrationExactRateSchema>;

export const BinaryCalibrationOutcomeCountsSchema = z.object({
  classified: BinaryCalibrationCountSchema,
  abstained: BinaryCalibrationCountSchema,
  errored: BinaryCalibrationCountSchema,
  unevaluated: BinaryCalibrationCountSchema
}).strict();
export type BinaryCalibrationOutcomeCounts = z.infer<typeof BinaryCalibrationOutcomeCountsSchema>;

export const BinaryCalibrationMatrixSchema = z.object({
  truthPassEvaluatorPass: BinaryCalibrationCountSchema,
  truthPassEvaluatorFail: BinaryCalibrationCountSchema,
  truthFailEvaluatorPass: BinaryCalibrationCountSchema,
  truthFailEvaluatorFail: BinaryCalibrationCountSchema
}).strict();
export type BinaryCalibrationMatrix = z.infer<typeof BinaryCalibrationMatrixSchema>;

export const BinaryCalibrationProviderIdentityStrengthSchema = z.enum([
  "observed_version",
  "observed_fingerprint",
  "observed_model",
  "requested_only"
]);
export type BinaryCalibrationProviderIdentityStrength = z.infer<
  typeof BinaryCalibrationProviderIdentityStrengthSchema
>;

export const BinaryCalibrationProviderIdentityGroupSchema = z.object({
  provider: BinaryCalibrationNonEmptyStringSchema,
  observedModel: BinaryCalibrationNonEmptyStringSchema.nullable(),
  observedVersion: BinaryCalibrationNonEmptyStringSchema.nullable(),
  systemFingerprint: BinaryCalibrationNonEmptyStringSchema.nullable(),
  identityStrength: BinaryCalibrationProviderIdentityStrengthSchema,
  observationCount: BinaryCalibrationPositiveCountSchema
}).strict();
export type BinaryCalibrationProviderIdentityGroup = z.infer<
  typeof BinaryCalibrationProviderIdentityGroupSchema
>;

export const BinaryCalibrationErrorCodeSchema = z.enum([
  "provider_unavailable",
  "provider_authentication",
  "provider_rate_limit",
  "provider_timeout",
  "provider_transport",
  "provider_protocol",
  "invalid_evaluator_output",
  "outcome_unknown",
  "internal"
]);
export type BinaryCalibrationErrorCode = z.infer<typeof BinaryCalibrationErrorCodeSchema>;

export const BinaryCalibrationPrivateProviderObservationSchema = z.object({
  provider: BinaryCalibrationNonEmptyStringSchema,
  observedModel: BinaryCalibrationNonEmptyStringSchema.nullable(),
  observedVersion: BinaryCalibrationNonEmptyStringSchema.nullable(),
  systemFingerprint: BinaryCalibrationNonEmptyStringSchema.nullable()
}).strict();
export type BinaryCalibrationPrivateProviderObservation = z.infer<
  typeof BinaryCalibrationPrivateProviderObservationSchema
>;

export const BinaryCalibrationPrivateLedgerRecordSchema = z.object({
  datasetRevisionItemDigest: BinaryCalibrationSha256DigestSchema,
  trialIndex: z.number().int().min(0).max(9),
  truthLabel: z.enum(["pass", "fail"]),
  terminalEvaluatorOutcome: z.enum([
    "evaluator_pass",
    "evaluator_fail",
    "abstained",
    "errored",
    "unevaluated"
  ]),
  attemptState: z.enum(["not_started", "started", "terminal"]),
  errorCode: BinaryCalibrationErrorCodeSchema.nullable(),
  physicalProviderCalls: BinaryCalibrationSafeIntegerSchema,
  providerObservation: BinaryCalibrationPrivateProviderObservationSchema,
  commitmentSalt: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type BinaryCalibrationPrivateLedgerRecord = z.infer<
  typeof BinaryCalibrationPrivateLedgerRecordSchema
>;

export const BinaryCalibrationPrivateLedgerSchema = z.object({
  contract: z.literal("coeval/binary-calibration-private-ledger/v1"),
  schemaVersion: z.literal(1),
  canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
  artifactId: BinaryCalibrationNonEmptyStringSchema,
  calibrationRunId: BinaryCalibrationNonEmptyStringSchema,
  projectId: BinaryCalibrationNonEmptyStringSchema,
  revisionDigest: BinaryCalibrationSha256DigestSchema,
  requestedProvider: BinaryCalibrationNonEmptyStringSchema,
  itemCount: BinaryCalibrationPositiveCountSchema,
  trialsPerItem: z.number().int().min(1).max(10),
  records: z.array(BinaryCalibrationPrivateLedgerRecordSchema).min(1).max(50_000)
}).strict();
export type BinaryCalibrationPrivateLedger = z.infer<typeof BinaryCalibrationPrivateLedgerSchema>;

export const BinaryCalibrationTrialSchema = z.object({
  trialIndex: z.number().int().min(0).max(9),
  status: z.enum(["complete", "incomplete"]),
  outcomes: z.object({
    planned: BinaryCalibrationPositiveCountSchema,
    classified: BinaryCalibrationCountSchema,
    abstained: BinaryCalibrationCountSchema,
    errored: BinaryCalibrationCountSchema,
    unevaluated: BinaryCalibrationCountSchema,
    providerCalls: BinaryCalibrationSafeIntegerSchema,
    byTruth: z.object({
      pass: BinaryCalibrationOutcomeCountsSchema,
      fail: BinaryCalibrationOutcomeCountsSchema
    }).strict(),
    errors: z.array(z.object({
      code: BinaryCalibrationErrorCodeSchema,
      count: BinaryCalibrationPositiveCountSchema
    }).strict()).max(9)
  }).strict(),
  confusionMatrix: BinaryCalibrationMatrixSchema,
  errorDirections: z.object({
    falsePass: BinaryCalibrationCountSchema,
    falseFail: BinaryCalibrationCountSchema
  }).strict(),
  metrics: z.object({
    accuracy: BinaryCalibrationWilsonRateSchema,
    truthPassRecall: BinaryCalibrationWilsonRateSchema,
    truthFailRecall: BinaryCalibrationWilsonRateSchema,
    positiveClassPrecision: BinaryCalibrationWilsonRateSchema,
    positiveClassRecall: BinaryCalibrationWilsonRateSchema,
    positiveClassF1: BinaryCalibrationExactRateSchema,
    classifiedCoverage: z.object({
      overall: BinaryCalibrationWilsonRateSchema,
      truthPass: BinaryCalibrationWilsonRateSchema,
      truthFail: BinaryCalibrationWilsonRateSchema
    }).strict()
  }).strict(),
  providerIdentityGroups: z.array(BinaryCalibrationProviderIdentityGroupSchema).min(1).max(5_000)
}).strict();
export type BinaryCalibrationTrial = z.infer<typeof BinaryCalibrationTrialSchema>;

export const BinaryCalibrationCompletionEligibilityReasonSchema = z.enum([
  "authorization_snapshot_changed",
  "development_exposure_detected",
  "evaluator_reuse_ineligible",
  "exposure_state_unknown"
]);
export type BinaryCalibrationCompletionEligibilityReason = z.infer<
  typeof BinaryCalibrationCompletionEligibilityReasonSchema
>;

export const BinaryCalibrationIncompleteReasonSchema = z.enum([
  "trial_incomplete",
  "completion_exposure_exposed",
  "completion_exposure_ineligible"
]);
export type BinaryCalibrationIncompleteReason = z.infer<typeof BinaryCalibrationIncompleteReasonSchema>;

export const BinaryCalibrationRepresentativeIneligibleReasonSchema = z.enum([
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
export type BinaryCalibrationRepresentativeIneligibleReason = z.infer<
  typeof BinaryCalibrationRepresentativeIneligibleReasonSchema
>;

export const BinaryCalibrationArtifactSchema = z.object({
  contract: z.literal("coeval/binary-calibration/v1"),
  schemaVersion: z.literal(1),
  canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
  artifactId: BinaryCalibrationNonEmptyStringSchema,
  calibrationRunId: BinaryCalibrationNonEmptyStringSchema,
  projectId: BinaryCalibrationNonEmptyStringSchema,
  lineage: z.object({
    artifactRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    predecessorArtifactId: BinaryCalibrationNonEmptyStringSchema.nullable(),
    correctionReason: BinaryCalibrationNonEmptyStringSchema.nullable()
  }).strict(),
  status: z.enum(["complete", "incomplete"]),
  incompleteReasons: z.array(BinaryCalibrationIncompleteReasonSchema).max(3),
  createdAt: BinaryCalibrationUtcTimestampSchema,
  startedAt: BinaryCalibrationUtcTimestampSchema,
  completedAt: BinaryCalibrationUtcTimestampSchema,
  criterion: z.object({
    criterionId: BinaryCalibrationNonEmptyStringSchema,
    criterionVersionId: BinaryCalibrationNonEmptyStringSchema,
    criterionDigest: BinaryCalibrationSha256DigestSchema
  }).strict(),
  evaluator: z.object({
    skillId: BinaryCalibrationNonEmptyStringSchema,
    skillVersionId: BinaryCalibrationNonEmptyStringSchema,
    skillDigest: BinaryCalibrationSha256DigestSchema,
    outputContractDigest: BinaryCalibrationSha256DigestSchema,
    requestedModelBinding: z.object({
      provider: BinaryCalibrationNonEmptyStringSchema,
      modelId: BinaryCalibrationNonEmptyStringSchema,
      modelVersion: BinaryCalibrationNonEmptyStringSchema,
      temperatureDecimal: BinaryCalibrationCanonicalDecimalSchema,
      topPDecimal: BinaryCalibrationCanonicalDecimalSchema.nullable(),
      endpointKind: z.enum(["managed", "custom"]),
      baseUrlDigest: BinaryCalibrationSha256DigestSchema.nullable(),
      requestedBindingDigest: BinaryCalibrationSha256DigestSchema
    }).strict()
  }).strict(),
  suiteBinding: z.object({
    manifestId: BinaryCalibrationNonEmptyStringSchema,
    manifestDigest: BinaryCalibrationSha256DigestSchema,
    memberPosition: z.number().int().min(0).max(99)
  }).strict().nullable(),
  truth: z.object({
    datasetRevisionId: BinaryCalibrationNonEmptyStringSchema,
    revisionDigest: BinaryCalibrationSha256DigestSchema,
    contentDigest: BinaryCalibrationSha256DigestSchema,
    itemCount: BinaryCalibrationPositiveCountSchema,
    role: z.literal("sealed_validation"),
    sourceKind: z.literal("sealed_intake"),
    provenanceLevel: z.literal("governed_blind"),
    semanticLeakageDetection: z.literal("unsupported"),
    representativeOfPopulationId: BinaryCalibrationNonEmptyStringSchema.nullable(),
    representativeIneligibleReasons: z.array(BinaryCalibrationRepresentativeIneligibleReasonSchema).max(11),
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
      governedReviewBatchId: BinaryCalibrationNonEmptyStringSchema,
      governedReviewBatchDigest: BinaryCalibrationSha256DigestSchema,
      reviewInstructionVersionId: BinaryCalibrationNonEmptyStringSchema,
      reviewInstructionDigest: BinaryCalibrationSha256DigestSchema,
      populationId: BinaryCalibrationNonEmptyStringSchema,
      populationDigest: BinaryCalibrationSha256DigestSchema,
      drawDigest: BinaryCalibrationSha256DigestSchema
    }).strict()
  }).strict(),
  exposure: z.object({
    authorization: z.object({
      state: z.literal("protected"),
      snapshotDigest: BinaryCalibrationSha256DigestSchema,
      eventId: BinaryCalibrationNonEmptyStringSchema,
      recordedAt: BinaryCalibrationUtcTimestampSchema
    }).strict(),
    completion: z.object({
      state: z.enum(["protected", "exposed"]),
      snapshotDigest: BinaryCalibrationSha256DigestSchema,
      eventId: BinaryCalibrationNonEmptyStringSchema,
      recordedAt: BinaryCalibrationUtcTimestampSchema,
      eligibility: z.object({
        result: z.enum(["eligible", "ineligible"]),
        reasons: z.array(BinaryCalibrationCompletionEligibilityReasonSchema).max(4)
      }).strict()
    }).strict()
  }).strict(),
  execution: z.object({
    definitionVersion: z.literal("sealed-binary-calibration-execution/v1"),
    providerDataHandling: z.object({
      executionEnvironment: z.enum(["external_provider", "self_hosted_provider", "local_provider"]),
      policyId: BinaryCalibrationNonEmptyStringSchema,
      policyDigest: BinaryCalibrationSha256DigestSchema,
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
    total: BinaryCalibrationPositiveCountSchema,
    pass: BinaryCalibrationCountSchema,
    fail: BinaryCalibrationCountSchema
  }).strict(),
  privateLedger: z.object({
    contract: z.literal("coeval/binary-calibration-private-ledger/v1"),
    commitmentDigest: BinaryCalibrationSha256DigestSchema
  }).strict(),
  trials: z.array(BinaryCalibrationTrialSchema).min(1).max(10),
  evidenceDigest: BinaryCalibrationSha256DigestSchema
}).strict();
export type BinaryCalibrationArtifact = z.infer<typeof BinaryCalibrationArtifactSchema>;
