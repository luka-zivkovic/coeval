import { createHash } from "node:crypto";
import {
  BinaryCalibrationArtifactSchema,
  BinaryCalibrationPrivateLedgerSchema,
  containsLoneUtf16Surrogate,
  type BinaryCalibrationArtifact,
  type BinaryCalibrationIncompleteReason,
  type BinaryCalibrationErrorCode,
  type BinaryCalibrationExactRate,
  type BinaryCalibrationMatrix,
  type BinaryCalibrationPrivateLedger,
  type BinaryCalibrationOutcomeCounts,
  type BinaryCalibrationProviderIdentityGroup,
  type BinaryCalibrationProviderIdentityStrength,
  type BinaryCalibrationTrial,
  type BinaryCalibrationWilsonRate
} from "@coeval/shared";
import { canonicalJson } from "./assessment-receipt.js";

export const BINARY_CALIBRATION_CONTRACT = "coeval/binary-calibration/v1" as const;
export const BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT =
  "coeval/binary-calibration-private-ledger/v1" as const;
export const BINARY_CALIBRATION_CANONICALIZATION_VERSION = "coeval-canonical-json/v1" as const;
export const BINARY_CALIBRATION_METRIC_DEFINITION_VERSION = "binary-classification/v1" as const;
export const BINARY_CALIBRATION_INTERVAL_DEFINITION_VERSION = "wilson-score/v1" as const;
export const BINARY_CALIBRATION_MAX_ITEMS = 5_000;
export const BINARY_CALIBRATION_MAX_CANONICAL_BYTES = 16 * 1024 * 1024;
export const BINARY_CALIBRATION_MAX_STRING_CODE_POINTS = 4_096;
export const BINARY_CALIBRATION_MAX_JSON_DEPTH = 32;
export const WILSON_95_Z_BINARY64 = "3fff5c0331eeff84" as const;
export const WILSON_95_CONFIDENCE_BASIS_POINTS = 9_500 as const;

const BINARY64_BITS_PATTERN = /^[a-f0-9]{16}$/;
const EXACT_UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const PROVIDER_STRENGTH_ORDER: Record<BinaryCalibrationProviderIdentityStrength, number> = {
  observed_version: 0,
  observed_fingerprint: 1,
  observed_model: 2,
  requested_only: 3
};

export interface BinaryCalibrationTrialBuildInput {
  trialIndex: number;
  outcomes: BinaryCalibrationTrial["outcomes"];
  confusionMatrix: BinaryCalibrationMatrix;
  providerIdentityGroups: BinaryCalibrationProviderIdentityGroup[];
}

export interface BuildBinaryCalibrationArtifactInput {
  artifactId: string;
  calibrationRunId: string;
  projectId: string;
  lineage: BinaryCalibrationArtifact["lineage"];
  createdAt: string;
  startedAt: string;
  completedAt: string;
  criterion: BinaryCalibrationArtifact["criterion"];
  evaluator: BinaryCalibrationArtifact["evaluator"];
  suiteBinding: BinaryCalibrationArtifact["suiteBinding"];
  truth: BinaryCalibrationArtifact["truth"];
  exposure: BinaryCalibrationArtifact["exposure"];
  execution: BinaryCalibrationArtifact["execution"];
  positiveClass: BinaryCalibrationArtifact["positiveClass"];
  trialPlan: BinaryCalibrationArtifact["trialPlan"];
  truthSupport: BinaryCalibrationArtifact["truthSupport"];
  privateLedgerCommitmentDigest: string;
  trials: BinaryCalibrationTrialBuildInput[];
}

export interface ExpectedBinaryCalibrationArtifact {
  artifactId: string;
  calibrationRunId: string;
  projectId: string;
  criterionId: string;
  criterionVersionId: string;
  criterionDigest: string;
  skillId: string;
  skillVersionId: string;
  skillDigest: string;
  outputContractDigest: string;
  requestedBindingDigest: string;
  datasetRevisionId: string;
  revisionDigest: string;
  contentDigest: string;
  itemCount: number;
  governedReviewBatchId: string;
  governedReviewBatchDigest: string;
  reviewInstructionVersionId: string;
  reviewInstructionDigest: string;
  populationId: string;
  populationDigest: string;
  drawDigest: string;
  representativeOfPopulationId: string | null;
  selectionMethod: BinaryCalibrationArtifact["truth"]["selectionMethod"];
  exposureAuthorizationSnapshotDigest: string;
  exposureAuthorizationEventId: string;
  exposureCompletionSnapshotDigest: string;
  exposureCompletionEventId: string;
  exposureCompletionState: BinaryCalibrationArtifact["exposure"]["completion"]["state"];
  exposureCompletionEligibility: BinaryCalibrationArtifact["exposure"]["completion"]["eligibility"]["result"];
  executionEnvironment: BinaryCalibrationArtifact["execution"]["providerDataHandling"]["executionEnvironment"];
  providerDataHandlingPolicyId: string;
  providerDataHandlingPolicyDigest: string;
  positiveClass: BinaryCalibrationArtifact["positiveClass"];
  trialPlanKind: BinaryCalibrationArtifact["trialPlan"]["kind"];
  trialsPerItem: number;
  suiteManifestId: string | null;
  suiteManifestDigest: string | null;
  suiteMemberPosition: number | null;
}

export function binary64FromBits(bits: string): number {
  if (!BINARY64_BITS_PATTERN.test(bits)) throw new Error("binary64 bits must be exactly 16 lowercase hexadecimal digits");
  return Buffer.from(bits, "hex").readDoubleBE(0);
}

export function binary64Bits(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new Error("binary64 evidence must be finite and must not be negative zero");
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value, 0);
  return bytes.toString("hex");
}

const WILSON_95_Z = binary64FromBits(WILSON_95_Z_BINARY64);

/**
 * Wilson score v1. The operation order is part of the wire contract. Do not
 * algebraically simplify this implementation: equivalent formulae can differ
 * by multiple binary64 ULPs and therefore produce different evidence bytes.
 */
export function wilson95Binary64Bounds(numerator: number, denominator: number): {
  lowerBinary64: string;
  upperBinary64: string;
} {
  assertCount(numerator, "Wilson numerator");
  assertCount(denominator, "Wilson denominator");
  if (denominator === 0) throw new Error("Wilson interval is undefined for a zero denominator");
  if (numerator > denominator) throw new Error("Wilson numerator cannot exceed its denominator");

  const zSquared = WILSON_95_Z * WILSON_95_Z;
  const adjustedDenominator = denominator + zSquared;
  const centerNumerator = numerator + (zSquared / 2);
  const remaining = denominator - numerator;
  const product = numerator * remaining;
  const scaledProduct = product / denominator;
  const correction = zSquared / 4;
  const radicand = scaledProduct + correction;
  const root = Math.sqrt(radicand);
  const marginNumerator = WILSON_95_Z * root;
  const lowerRaw = (centerNumerator - marginNumerator) / adjustedDenominator;
  const upperRaw = (centerNumerator + marginNumerator) / adjustedDenominator;
  const lower = numerator === 0 ? 0 : Math.max(0, lowerRaw);
  const upper = numerator === denominator ? 1 : Math.min(1, upperRaw);
  return { lowerBinary64: binary64Bits(lower), upperBinary64: binary64Bits(upper) };
}

export function binaryCalibrationEvidenceDigest(
  artifact: Omit<BinaryCalibrationArtifact, "evidenceDigest"> | BinaryCalibrationArtifact
): string {
  const { evidenceDigest: _excluded, ...unsigned } = artifact as BinaryCalibrationArtifact;
  return sha256Canonical(unsigned);
}

export function binaryCalibrationArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function verifyBinaryCalibrationPrivateLedger(raw: unknown): BinaryCalibrationPrivateLedger {
  verifyUntrustedJsonBounds(raw, 50_000);
  if (containsLoneUtf16Surrogate(raw)) {
    throw new Error("binary calibration private-ledger strings must contain only valid Unicode scalar values");
  }
  if (containsNegativeZero(raw)) {
    throw new Error("binary calibration private-ledger numbers must not contain negative zero");
  }
  const ledger = BinaryCalibrationPrivateLedgerSchema.parse(raw);
  const expectedRecords = ledger.itemCount * ledger.trialsPerItem;
  if (!Number.isSafeInteger(expectedRecords) || ledger.records.length !== expectedRecords) {
    throw new Error("binary calibration private ledger must contain exactly itemCount * trialsPerItem records");
  }
  const salts = new Set<string>();
  const truthByItem = new Map<string, "pass" | "fail">();
  const itemsByTrial = new Map<number, Set<string>>();
  let previous: BinaryCalibrationPrivateLedger["records"][number] | undefined;
  for (const record of ledger.records) {
    if (previous && (
      record.trialIndex < previous.trialIndex ||
      (record.trialIndex === previous.trialIndex &&
        record.datasetRevisionItemDigest <= previous.datasetRevisionItemDigest)
    )) {
      throw new Error("binary calibration private ledger records are not ordered uniquely by trialIndex and item digest");
    }
    previous = record;
    if (record.trialIndex >= ledger.trialsPerItem) {
      throw new Error("binary calibration private ledger trialIndex exceeds trialsPerItem");
    }
    if (salts.has(record.commitmentSalt)) {
      throw new Error("binary calibration private ledger commitment salts must be unique");
    }
    salts.add(record.commitmentSalt);
    const priorTruth = truthByItem.get(record.datasetRevisionItemDigest);
    if (priorTruth !== undefined && priorTruth !== record.truthLabel) {
      throw new Error("binary calibration private ledger truth label changed across trials");
    }
    truthByItem.set(record.datasetRevisionItemDigest, record.truthLabel);
    const trialItems = itemsByTrial.get(record.trialIndex) ?? new Set<string>();
    if (trialItems.has(record.datasetRevisionItemDigest)) {
      throw new Error("binary calibration private ledger repeats an item within a trial");
    }
    trialItems.add(record.datasetRevisionItemDigest);
    itemsByTrial.set(record.trialIndex, trialItems);
    verifyPrivateLedgerRecord(ledger, record);
  }
  if (truthByItem.size !== ledger.itemCount || itemsByTrial.size !== ledger.trialsPerItem) {
    throw new Error("binary calibration private ledger does not cover the declared items and trials");
  }
  const expectedItems = [...truthByItem.keys()].sort();
  for (let trialIndex = 0; trialIndex < ledger.trialsPerItem; trialIndex += 1) {
    const actualItems = [...(itemsByTrial.get(trialIndex) ?? [])].sort();
    if (canonicalJson(actualItems) !== canonicalJson(expectedItems)) {
      throw new Error("binary calibration private ledger item coverage differs across trials");
    }
  }
  return ledger;
}

export function canonicalBinaryCalibrationPrivateLedgerBytes(
  ledger: BinaryCalibrationPrivateLedger
): Buffer {
  return Buffer.from(canonicalJson(verifyBinaryCalibrationPrivateLedger(ledger)), "utf8");
}

export function binaryCalibrationPrivateLedgerCommitmentDigest(
  ledger: BinaryCalibrationPrivateLedger
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalBinaryCalibrationPrivateLedgerBytes(ledger))
    .digest("hex")}`;
}

export function verifyBinaryCalibrationPrivateLedgerForArtifact(
  ledgerRaw: unknown,
  artifactRaw: unknown
): { ledger: BinaryCalibrationPrivateLedger; artifact: BinaryCalibrationArtifact } {
  const ledger = verifyBinaryCalibrationPrivateLedger(ledgerRaw);
  const artifact = verifyBinaryCalibrationArtifact(artifactRaw);
  const exactBindings = [
    ["artifactId", ledger.artifactId, artifact.artifactId],
    ["calibrationRunId", ledger.calibrationRunId, artifact.calibrationRunId],
    ["projectId", ledger.projectId, artifact.projectId],
    ["revisionDigest", ledger.revisionDigest, artifact.truth.revisionDigest],
    ["requestedProvider", ledger.requestedProvider, artifact.evaluator.requestedModelBinding.provider],
    ["itemCount", ledger.itemCount, artifact.truth.itemCount],
    ["trialsPerItem", ledger.trialsPerItem, artifact.trialPlan.trialsPerItem]
  ] as const;
  for (const [field, privateValue, publicValue] of exactBindings) {
    if (privateValue !== publicValue) {
      throw new Error(`binary calibration private-ledger ${field} does not match public artifact`);
    }
  }
  if (binaryCalibrationPrivateLedgerCommitmentDigest(ledger) !== artifact.privateLedger.commitmentDigest) {
    throw new Error("binary calibration private-ledger commitment does not match public artifact");
  }

  for (const trial of artifact.trials) {
    const records = ledger.records.filter((record) => record.trialIndex === trial.trialIndex);
    const outcomes = {
      planned: records.length,
      classified: 0,
      abstained: 0,
      errored: 0,
      unevaluated: 0,
      providerCalls: 0,
      byTruth: {
        pass: { classified: 0, abstained: 0, errored: 0, unevaluated: 0 },
        fail: { classified: 0, abstained: 0, errored: 0, unevaluated: 0 }
      },
      errors: [] as Array<{ code: BinaryCalibrationErrorCode; count: number }>
    };
    const matrix: BinaryCalibrationMatrix = {
      truthPassEvaluatorPass: 0,
      truthPassEvaluatorFail: 0,
      truthFailEvaluatorPass: 0,
      truthFailEvaluatorFail: 0
    };
    const errors = new Map<BinaryCalibrationErrorCode, number>();
    const groups = new Map<string, BinaryCalibrationProviderIdentityGroup>();
    for (const record of records) {
      const bucket = record.terminalEvaluatorOutcome === "evaluator_pass" ||
        record.terminalEvaluatorOutcome === "evaluator_fail"
        ? "classified"
        : record.terminalEvaluatorOutcome;
      const outcomeBucket = bucket === "abstained" || bucket === "errored" || bucket === "unevaluated"
        ? bucket
        : "classified";
      outcomes[outcomeBucket] += 1;
      outcomes.byTruth[record.truthLabel][outcomeBucket] += 1;
      outcomes.providerCalls = safeIntegerSum(
        outcomes.providerCalls,
        record.physicalProviderCalls,
        `trial ${trial.trialIndex} private-ledger provider calls`
      );
      if (record.terminalEvaluatorOutcome === "evaluator_pass") {
        const cell = record.truthLabel === "pass" ? "truthPassEvaluatorPass" : "truthFailEvaluatorPass";
        matrix[cell] += 1;
      } else if (record.terminalEvaluatorOutcome === "evaluator_fail") {
        const cell = record.truthLabel === "pass" ? "truthPassEvaluatorFail" : "truthFailEvaluatorFail";
        matrix[cell] += 1;
      }
      if (record.errorCode !== null) {
        errors.set(record.errorCode, (errors.get(record.errorCode) ?? 0) + 1);
      }
      const seed: BinaryCalibrationProviderIdentityGroup = {
        ...record.providerObservation,
        identityStrength: "requested_only",
        observationCount: 1
      };
      seed.identityStrength = derivedProviderStrength(seed);
      const key = providerGroupKey(seed);
      const prior = groups.get(key);
      groups.set(key, prior ? { ...prior, observationCount: prior.observationCount + 1 } : seed);
    }
    outcomes.errors = [...errors.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([code, count]) => ({ code, count }));
    const providerIdentityGroups = [...groups.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, group]) => group);
    if (canonicalJson(outcomes) !== canonicalJson(trial.outcomes)) {
      throw new Error(`trial ${trial.trialIndex} private-ledger outcomes do not match public artifact`);
    }
    if (canonicalJson(matrix) !== canonicalJson(trial.confusionMatrix)) {
      throw new Error(`trial ${trial.trialIndex} private-ledger matrix does not match public artifact`);
    }
    if (canonicalJson(providerIdentityGroups) !== canonicalJson(trial.providerIdentityGroups)) {
      throw new Error(`trial ${trial.trialIndex} private-ledger provider groups do not match public artifact`);
    }
  }
  return { ledger, artifact };
}

function verifyPrivateLedgerRecord(
  ledger: BinaryCalibrationPrivateLedger,
  record: BinaryCalibrationPrivateLedger["records"][number]
): void {
  if (record.providerObservation.provider !== ledger.requestedProvider) {
    throw new Error("binary calibration private-ledger provider does not match requestedProvider");
  }
  if (
    (record.providerObservation.observedVersion !== null ||
      record.providerObservation.systemFingerprint !== null) &&
    record.providerObservation.observedModel === null
  ) {
    throw new Error("binary calibration private-ledger version/fingerprint requires an observed model");
  }
  const hasObservedIdentity = record.providerObservation.observedModel !== null ||
    record.providerObservation.observedVersion !== null ||
    record.providerObservation.systemFingerprint !== null;
  if (hasObservedIdentity && record.physicalProviderCalls < 1) {
    throw new Error("binary calibration private-ledger observed identity requires a physical provider call");
  }
  if (record.terminalEvaluatorOutcome === "errored") {
    if (record.errorCode === null) {
      throw new Error("binary calibration private-ledger errored outcome requires errorCode");
    }
    const expectedState = record.errorCode === "outcome_unknown" ? "started" : "terminal";
    if (record.attemptState !== expectedState) {
      throw new Error(`binary calibration private-ledger errored attemptState must be ${expectedState}`);
    }
    if (record.errorCode === "outcome_unknown" && record.physicalProviderCalls < 1) {
      throw new Error("binary calibration private-ledger outcome_unknown requires a physical provider call");
    }
    return;
  }
  if (record.errorCode !== null) {
    throw new Error("binary calibration private-ledger non-errored outcome cannot have errorCode");
  }
  const expectedState = record.terminalEvaluatorOutcome === "unevaluated" ? "not_started" : "terminal";
  if (record.attemptState !== expectedState) {
    throw new Error(`binary calibration private-ledger attemptState must be ${expectedState}`);
  }
  if (record.terminalEvaluatorOutcome === "unevaluated") {
    if (record.physicalProviderCalls !== 0 || hasObservedIdentity) {
      throw new Error("binary calibration private-ledger unevaluated attempt must have zero calls and requested-only identity");
    }
  } else if (record.physicalProviderCalls < 1) {
    throw new Error("binary calibration private-ledger classified or abstained outcome requires a physical provider call");
  }
}

export function buildBinaryCalibrationArtifact(
  input: BuildBinaryCalibrationArtifactInput
): BinaryCalibrationArtifact {
  const trials = input.trials.map((trial) => buildTrial(trial, input.positiveClass, input.truthSupport));
  const unsigned: Omit<BinaryCalibrationArtifact, "evidenceDigest"> = {
    contract: BINARY_CALIBRATION_CONTRACT,
    schemaVersion: 1,
    canonicalizationVersion: BINARY_CALIBRATION_CANONICALIZATION_VERSION,
    artifactId: input.artifactId,
    calibrationRunId: input.calibrationRunId,
    projectId: input.projectId,
    lineage: input.lineage,
    status: calibrationIncompleteReasons(trials, input.exposure).length === 0 ? "complete" : "incomplete",
    incompleteReasons: calibrationIncompleteReasons(trials, input.exposure),
    createdAt: input.createdAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    criterion: input.criterion,
    evaluator: input.evaluator,
    suiteBinding: input.suiteBinding,
    truth: input.truth,
    exposure: input.exposure,
    execution: input.execution,
    positiveClass: input.positiveClass,
    errorDirectionDefinitions: {
      falsePass: "evaluator_pass_when_truth_fail",
      falseFail: "evaluator_fail_when_truth_pass"
    },
    metricDefinitionVersion: BINARY_CALIBRATION_METRIC_DEFINITION_VERSION,
    intervalDefinitionVersion: BINARY_CALIBRATION_INTERVAL_DEFINITION_VERSION,
    trialPlan: input.trialPlan,
    truthSupport: input.truthSupport,
    privateLedger: {
      contract: BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT,
      commitmentDigest: input.privateLedgerCommitmentDigest
    },
    trials
  };
  return verifyBinaryCalibrationArtifact({
    ...unsigned,
    evidenceDigest: sha256Canonical(unsigned)
  });
}

export function canonicalBinaryCalibrationArtifactBytes(artifact: BinaryCalibrationArtifact): Buffer {
  return Buffer.from(canonicalJson(verifyBinaryCalibrationArtifact(artifact)), "utf8");
}

export function parseCanonicalBinaryCalibrationArtifactBytes(
  bytes: Uint8Array,
  expected?: ExpectedBinaryCalibrationArtifact
): BinaryCalibrationArtifact {
  if (bytes.length > BINARY_CALIBRATION_MAX_CANONICAL_BYTES) {
    throw new Error(`Binary calibration artifact exceeds ${BINARY_CALIBRATION_MAX_CANONICAL_BYTES} bytes`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("Binary calibration artifact bytes must not begin with a UTF-8 BOM");
  }
  let text: string;
  try {
    // ignoreBOM:true preserves U+FEFF instead of silently stripping it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Binary calibration artifact bytes are not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Binary calibration artifact bytes are not valid JSON");
  }
  const artifact = verifyBinaryCalibrationArtifact(raw, expected);
  if (canonicalJson(artifact) !== text) {
    throw new Error("Binary calibration artifact copy is not exact canonical JSON");
  }
  return artifact;
}

export function verifyBinaryCalibrationArtifact(
  raw: unknown,
  expected?: ExpectedBinaryCalibrationArtifact
): BinaryCalibrationArtifact {
  verifyUntrustedJsonBounds(raw);
  if (containsLoneUtf16Surrogate(raw)) {
    throw new Error("binary calibration strings must contain only valid Unicode scalar values");
  }
  if (containsNegativeZero(raw)) {
    throw new Error("binary calibration numbers must not contain negative zero");
  }
  const artifact = BinaryCalibrationArtifactSchema.parse(raw);
  verifyExactTimestamp(artifact.createdAt, "createdAt");
  verifyExactTimestamp(artifact.startedAt, "startedAt");
  verifyExactTimestamp(artifact.completedAt, "completedAt");
  verifyExactTimestamp(artifact.exposure.authorization.recordedAt, "exposure.authorization.recordedAt");
  verifyExactTimestamp(artifact.exposure.completion.recordedAt, "exposure.completion.recordedAt");
  if (
    artifact.exposure.authorization.recordedAt > artifact.startedAt ||
    artifact.startedAt > artifact.completedAt ||
    artifact.completedAt > artifact.exposure.completion.recordedAt ||
    artifact.exposure.completion.recordedAt > artifact.createdAt
  ) {
    throw new Error("binary calibration timestamps are not in lifecycle order");
  }
  verifyLineage(artifact);
  verifyRequestedModelBinding(artifact);
  verifyCompletionEligibility(artifact);
  verifyTruthAndTrialPlan(artifact);
  verifyRepresentativeness(artifact);
  artifact.trials.forEach((trial, index) => verifyTrial(artifact, trial, index));

  const expectedIncompleteReasons = calibrationIncompleteReasons(artifact.trials, artifact.exposure);
  if (canonicalJson(artifact.incompleteReasons) !== canonicalJson(expectedIncompleteReasons)) {
    throw new Error("binary calibration incompleteReasons mismatch");
  }
  const expectedStatus = expectedIncompleteReasons.length === 0 ? "complete" : "incomplete";
  if (artifact.status !== expectedStatus) {
    throw new Error(`binary calibration status must be ${expectedStatus}`);
  }
  if (artifact.evidenceDigest !== binaryCalibrationEvidenceDigest(artifact)) {
    throw new Error("binary calibration evidenceDigest mismatch");
  }
  if (expected) verifyExpectedIdentity(artifact, expected);
  return artifact;
}

function buildTrial(
  input: BinaryCalibrationTrialBuildInput,
  positiveClass: BinaryCalibrationArtifact["positiveClass"],
  truthSupport: BinaryCalibrationArtifact["truthSupport"]
): BinaryCalibrationTrial {
  const matrix = input.confusionMatrix;
  const expectedMetrics = metricsFor(matrix, input.outcomes, positiveClass, truthSupport);
  const complete = measurementComplete(input.outcomes);
  return {
    trialIndex: input.trialIndex,
    status: complete ? "complete" : "incomplete",
    outcomes: input.outcomes,
    confusionMatrix: matrix,
    errorDirections: {
      falsePass: matrix.truthFailEvaluatorPass,
      falseFail: matrix.truthPassEvaluatorFail
    },
    metrics: expectedMetrics,
    providerIdentityGroups: input.providerIdentityGroups
  };
}

function metricsFor(
  matrix: BinaryCalibrationMatrix,
  outcomes: BinaryCalibrationTrial["outcomes"],
  positiveClass: BinaryCalibrationArtifact["positiveClass"],
  support: BinaryCalibrationArtifact["truthSupport"]
): BinaryCalibrationTrial["metrics"] {
  const truthPassClassified = safeSum(
    matrix.truthPassEvaluatorPass,
    matrix.truthPassEvaluatorFail,
    "truth-pass classified support"
  );
  const truthFailClassified = safeSum(
    matrix.truthFailEvaluatorPass,
    matrix.truthFailEvaluatorFail,
    "truth-fail classified support"
  );
  const classified = safeSum(truthPassClassified, truthFailClassified, "classified support");
  const correct = safeSum(
    matrix.truthPassEvaluatorPass,
    matrix.truthFailEvaluatorFail,
    "correct classifications"
  );
  const truePositive = positiveClass === "pass"
    ? matrix.truthPassEvaluatorPass
    : matrix.truthFailEvaluatorFail;
  const falsePositive = positiveClass === "pass"
    ? matrix.truthFailEvaluatorPass
    : matrix.truthPassEvaluatorFail;
  const falseNegative = positiveClass === "pass"
    ? matrix.truthPassEvaluatorFail
    : matrix.truthFailEvaluatorPass;
  const predictedPositive = safeSum(truePositive, falsePositive, "predicted-positive support");
  const positiveTruthClassified = safeSum(truePositive, falseNegative, "positive truth support");
  const positiveTruthSupport = positiveClass === "pass" ? support.pass : support.fail;
  const f1Numerator = safeDouble(truePositive, "F1 numerator");
  const f1Denominator = safeIntegerSum(
    safeIntegerSum(f1Numerator, falsePositive, "F1 partial denominator"),
    falseNegative,
    "F1 denominator"
  );
  return {
    accuracy: wilsonRate(correct, classified),
    truthPassRecall: wilsonRate(matrix.truthPassEvaluatorPass, truthPassClassified),
    truthFailRecall: wilsonRate(matrix.truthFailEvaluatorFail, truthFailClassified),
    positiveClassPrecision: wilsonRate(truePositive, predictedPositive),
    positiveClassRecall: wilsonRate(truePositive, positiveTruthClassified),
    positiveClassF1: exactF1Rate(f1Numerator, f1Denominator, positiveTruthSupport),
    classifiedCoverage: {
      overall: wilsonRate(outcomes.classified, outcomes.planned),
      truthPass: wilsonRate(outcomes.byTruth.pass.classified, support.pass),
      truthFail: wilsonRate(outcomes.byTruth.fail.classified, support.fail)
    }
  };
}

function wilsonRate(numerator: number, denominator: number): BinaryCalibrationWilsonRate {
  if (denominator === 0) {
    if (numerator !== 0) throw new Error("undefined rate with zero denominator must have zero numerator");
    return {
      state: "undefined",
      numerator: 0,
      denominator: 0,
      undefinedReason: "zero_denominator",
      interval: null
    };
  }
  return {
    state: "defined",
    numerator,
    denominator,
    interval: {
      method: BINARY_CALIBRATION_INTERVAL_DEFINITION_VERSION,
      confidenceBasisPoints: WILSON_95_CONFIDENCE_BASIS_POINTS,
      ...wilson95Binary64Bounds(numerator, denominator)
    }
  };
}

function exactF1Rate(
  numerator: number,
  denominator: number,
  positiveTruthSupport: number
): BinaryCalibrationExactRate {
  if (positiveTruthSupport === 0) {
    return { state: "undefined", numerator, denominator, undefinedReason: "no_positive_truth_support" };
  }
  if (denominator === 0) {
    return { state: "undefined", numerator, denominator, undefinedReason: "zero_denominator" };
  }
  return { state: "defined", numerator, denominator };
}

function verifyTruthAndTrialPlan(artifact: BinaryCalibrationArtifact): void {
  const supportTotal = safeSum(artifact.truthSupport.pass, artifact.truthSupport.fail, "truth support");
  if (artifact.truthSupport.total !== supportTotal || artifact.truth.itemCount !== supportTotal) {
    throw new Error("binary calibration truth support must equal the frozen revision itemCount");
  }
  if (artifact.trials.length !== artifact.trialPlan.trialsPerItem) {
    throw new Error("binary calibration trial coverage does not match trialPlan.trialsPerItem");
  }
  if (artifact.trialPlan.kind === "single" && artifact.trials.length !== 1) {
    throw new Error("single calibration trialPlan requires exactly one trial");
  }
  if (artifact.suiteBinding && artifact.suiteBinding.memberPosition < 0) {
    throw new Error("suite memberPosition must be nonnegative");
  }
}

function verifyTrial(
  artifact: BinaryCalibrationArtifact,
  trial: BinaryCalibrationTrial,
  index: number
): void {
  if (trial.trialIndex !== index) {
    throw new Error(`binary calibration trials are not ordered by contiguous trialIndex at index ${index}`);
  }
  const outcomes = trial.outcomes;
  if (outcomes.planned !== artifact.truthSupport.total) {
    throw new Error(`trial ${index} planned count does not equal truth support`);
  }
  const aggregateOutcomeCount = safeSum(
    safeSum(outcomes.classified, outcomes.abstained, `trial ${index} outcome count`),
    safeSum(outcomes.errored, outcomes.unevaluated, `trial ${index} outcome count`),
    `trial ${index} outcome count`
  );
  if (aggregateOutcomeCount !== outcomes.planned) {
    throw new Error(`trial ${index} outcomes do not conserve planned attempts`);
  }
  verifyTruthOutcomeConservation(artifact, trial, "pass");
  verifyTruthOutcomeConservation(artifact, trial, "fail");
  const byTruth = trial.outcomes.byTruth;
  for (const key of ["classified", "abstained", "errored", "unevaluated"] as const) {
    if (outcomes[key] !== safeSum(byTruth.pass[key], byTruth.fail[key], `trial ${index} ${key}`)) {
      throw new Error(`trial ${index} ${key} count does not equal its truth-class counts`);
    }
  }
  const matrix = trial.confusionMatrix;
  const matrixClassified = safeSum(
    safeSum(matrix.truthPassEvaluatorPass, matrix.truthPassEvaluatorFail, `trial ${index} matrix`),
    safeSum(matrix.truthFailEvaluatorPass, matrix.truthFailEvaluatorFail, `trial ${index} matrix`),
    `trial ${index} matrix`
  );
  if (matrixClassified !== outcomes.classified) {
    throw new Error(`trial ${index} confusion matrix does not conserve classified outcomes`);
  }
  if (
    trial.errorDirections.falsePass !== matrix.truthFailEvaluatorPass ||
    trial.errorDirections.falseFail !== matrix.truthPassEvaluatorFail
  ) {
    throw new Error(`trial ${index} error-direction counts do not match semantic matrix cells`);
  }
  verifyErrors(trial, index);
  const outcomeUnknown = trial.outcomes.errors.find((error) => error.code === "outcome_unknown")?.count ?? 0;
  const minimumProviderCalls = safeSum(
    safeSum(outcomes.classified, outcomes.abstained, `trial ${index} minimum provider calls`),
    outcomeUnknown,
    `trial ${index} minimum provider calls`
  );
  if (outcomes.providerCalls < minimumProviderCalls) {
    throw new Error(`trial ${index} providerCalls is below classified + abstained + outcome_unknown`);
  }
  verifyProviderIdentityGroups(artifact, trial, index);
  const expectedMetrics = metricsFor(matrix, outcomes, artifact.positiveClass, artifact.truthSupport);
  if (canonicalJson(trial.metrics) !== canonicalJson(expectedMetrics)) {
    throw new Error(`trial ${index} metrics or Wilson intervals do not match aggregate evidence`);
  }
  const expectedStatus = measurementComplete(outcomes)
    ? "complete"
    : "incomplete";
  if (trial.status !== expectedStatus) {
    throw new Error(`trial ${index} status must be ${expectedStatus}`);
  }
}

function verifyTruthOutcomeConservation(
  artifact: BinaryCalibrationArtifact,
  trial: BinaryCalibrationTrial,
  truth: "pass" | "fail"
): void {
  const counts: BinaryCalibrationOutcomeCounts = trial.outcomes.byTruth[truth];
  const total = safeSum(
    safeSum(counts.classified, counts.abstained, `${truth} outcome count`),
    safeSum(counts.errored, counts.unevaluated, `${truth} outcome count`),
    `${truth} outcome count`
  );
  if (total !== artifact.truthSupport[truth]) {
    throw new Error(`trial ${trial.trialIndex} ${truth} outcomes do not conserve truth support`);
  }
  const matrixClassified = truth === "pass"
    ? safeSum(
        trial.confusionMatrix.truthPassEvaluatorPass,
        trial.confusionMatrix.truthPassEvaluatorFail,
        "truth-pass matrix support"
      )
    : safeSum(
        trial.confusionMatrix.truthFailEvaluatorPass,
        trial.confusionMatrix.truthFailEvaluatorFail,
        "truth-fail matrix support"
      );
  if (counts.classified !== matrixClassified) {
    throw new Error(`trial ${trial.trialIndex} ${truth} classified count does not match matrix row`);
  }
}

function verifyErrors(trial: BinaryCalibrationTrial, index: number): void {
  const codes = trial.outcomes.errors.map((entry) => entry.code);
  const sorted = [...codes].sort();
  if (codes.some((code, position) => code !== sorted[position])) {
    throw new Error(`trial ${index} error breakdown is not ordered by code`);
  }
  if (new Set(codes).size !== codes.length) {
    throw new Error(`trial ${index} error breakdown contains duplicate codes`);
  }
  const errorCount = trial.outcomes.errors.reduce(
    (sum, error) => safeSum(sum, error.count, `trial ${index} error count`),
    0
  );
  if (errorCount !== trial.outcomes.errored) {
    throw new Error(`trial ${index} error breakdown does not conserve errored outcomes`);
  }
}

function verifyProviderIdentityGroups(
  artifact: BinaryCalibrationArtifact,
  trial: BinaryCalibrationTrial,
  index: number
): void {
  const keys = trial.providerIdentityGroups.map(providerGroupKey);
  const sorted = [...keys].sort();
  if (keys.some((key, position) => key !== sorted[position])) {
    throw new Error(`trial ${index} provider identity groups are not in canonical order`);
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error(`trial ${index} provider identity groups contain a duplicate identity`);
  }
  let observations = 0;
  for (const group of trial.providerIdentityGroups) {
    if (group.provider !== artifact.evaluator.requestedModelBinding.provider) {
      throw new Error(`trial ${index} provider identity group does not match the requested provider`);
    }
    if (group.observationCount <= 0) {
      throw new Error(`trial ${index} provider identity groups must have positive observation counts`);
    }
    const strength = derivedProviderStrength(group);
    if (strength !== group.identityStrength) {
      throw new Error(`trial ${index} provider identity strength must be ${strength}`);
    }
    observations = safeSum(observations, group.observationCount, `trial ${index} observations`);
  }
  if (observations !== trial.outcomes.planned) {
    throw new Error(`trial ${index} provider identity groups do not conserve planned observations`);
  }
}

function measurementComplete(outcomes: BinaryCalibrationTrial["outcomes"]): boolean {
  return safeSum(outcomes.classified, outcomes.abstained, "completed logical outcomes") === outcomes.planned &&
    outcomes.errored === 0 && outcomes.unevaluated === 0;
}

function calibrationIncompleteReasons(
  trials: BinaryCalibrationTrial[],
  exposure: BinaryCalibrationArtifact["exposure"]
): BinaryCalibrationIncompleteReason[] {
  const reasons: BinaryCalibrationIncompleteReason[] = [];
  if (trials.some((trial) => trial.status === "incomplete")) reasons.push("trial_incomplete");
  if (exposure.completion.state !== "protected") reasons.push("completion_exposure_exposed");
  if (exposure.completion.eligibility.result !== "eligible") {
    reasons.push("completion_exposure_ineligible");
  }
  return reasons.sort();
}

function verifyRepresentativeness(artifact: BinaryCalibrationArtifact): void {
  const reasons = artifact.truth.representativeIneligibleReasons;
  const sorted = [...reasons].sort();
  if (reasons.some((reason, index) => reason !== sorted[index]) || new Set(reasons).size !== reasons.length) {
    throw new Error("representative ineligible reasons must be sorted and unique");
  }
  if (artifact.truth.representativeOfPopulationId === null && reasons.length === 0) {
    throw new Error("non-representative calibration truth must name at least one ineligible reason");
  }
  if (artifact.truth.representativeOfPopulationId !== null && reasons.length !== 0) {
    throw new Error("representative calibration truth cannot name ineligible reasons");
  }
}

function verifyCompletionEligibility(artifact: BinaryCalibrationArtifact): void {
  const completion = artifact.exposure.completion;
  const reasons = completion.eligibility.reasons;
  const sorted = [...reasons].sort();
  if (reasons.some((reason, index) => reason !== sorted[index]) || new Set(reasons).size !== reasons.length) {
    throw new Error("completion exposure eligibility reasons must be sorted and unique");
  }
  if (completion.eligibility.result === "eligible") {
    if (completion.state !== "protected" || reasons.length !== 0) {
      throw new Error("eligible completion exposure must be protected and have no reasons");
    }
  } else if (reasons.length === 0) {
    throw new Error("ineligible completion exposure must name at least one reason");
  }
  if (completion.state === "exposed" && completion.eligibility.result !== "ineligible") {
    throw new Error("exposed completion state cannot be eligible");
  }
}

function providerGroupKey(group: BinaryCalibrationProviderIdentityGroup): string {
  return canonicalJson({
    provider: group.provider,
    observedModel: group.observedModel,
    observedVersion: group.observedVersion,
    systemFingerprint: group.systemFingerprint,
    identityStrength: group.identityStrength
  });
}

function derivedProviderStrength(
  group: BinaryCalibrationProviderIdentityGroup
): BinaryCalibrationProviderIdentityStrength {
  if (group.observedVersion !== null && group.observedModel === null) {
    throw new Error("observed provider version requires an observed model");
  }
  if (group.systemFingerprint !== null && group.observedModel === null) {
    throw new Error("observed provider fingerprint requires an observed model");
  }
  if (group.observedVersion !== null) return "observed_version";
  if (group.systemFingerprint !== null) return "observed_fingerprint";
  if (group.observedModel !== null) return "observed_model";
  return "requested_only";
}

function verifyLineage(artifact: BinaryCalibrationArtifact): void {
  const lineage = artifact.lineage;
  if (lineage.artifactRevision === 1) {
    if (lineage.predecessorArtifactId !== null || lineage.correctionReason !== null) {
      throw new Error("root binary calibration artifact cannot name correction lineage");
    }
    return;
  }
  if (lineage.predecessorArtifactId === null || lineage.correctionReason === null) {
    throw new Error("corrected binary calibration artifact must name predecessor and correctionReason");
  }
}

function verifyRequestedModelBinding(artifact: BinaryCalibrationArtifact): void {
  const binding = artifact.evaluator.requestedModelBinding;
  verifyCanonicalDecimalRange(binding.temperatureDecimal, 2, "temperatureDecimal");
  if (binding.topPDecimal !== null) verifyCanonicalDecimalRange(binding.topPDecimal, 1, "topPDecimal");
  if ((binding.endpointKind === "custom") !== (binding.baseUrlDigest !== null)) {
    throw new Error("custom requested model bindings require exactly one baseUrlDigest");
  }
  const expectedDigest = sha256Canonical({
    provider: binding.provider,
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    temperatureDecimal: binding.temperatureDecimal,
    topPDecimal: binding.topPDecimal,
    endpointKind: binding.endpointKind,
    baseUrlDigest: binding.baseUrlDigest
  });
  if (binding.requestedBindingDigest !== expectedDigest) {
    throw new Error("binary calibration requestedBindingDigest mismatch");
  }
}

function verifyCanonicalDecimalRange(value: string, maximum: number, field: string): void {
  if (!CANONICAL_DECIMAL_PATTERN.test(value)) throw new Error(`${field} is not a canonical nonnegative decimal`);
  const [integerPart] = value.split(".");
  const integer = Number(integerPart);
  if (integer > maximum || (integer === maximum && value.includes("."))) {
    throw new Error(`${field} is outside its allowed range`);
  }
}

function verifyExpectedIdentity(
  artifact: BinaryCalibrationArtifact,
  expected: ExpectedBinaryCalibrationArtifact
): void {
  const actual = {
    artifactId: artifact.artifactId,
    calibrationRunId: artifact.calibrationRunId,
    projectId: artifact.projectId,
    criterionId: artifact.criterion.criterionId,
    criterionVersionId: artifact.criterion.criterionVersionId,
    criterionDigest: artifact.criterion.criterionDigest,
    skillId: artifact.evaluator.skillId,
    skillVersionId: artifact.evaluator.skillVersionId,
    skillDigest: artifact.evaluator.skillDigest,
    outputContractDigest: artifact.evaluator.outputContractDigest,
    requestedBindingDigest: artifact.evaluator.requestedModelBinding.requestedBindingDigest,
    datasetRevisionId: artifact.truth.datasetRevisionId,
    revisionDigest: artifact.truth.revisionDigest,
    contentDigest: artifact.truth.contentDigest,
    itemCount: artifact.truth.itemCount,
    governedReviewBatchId: artifact.truth.origin.governedReviewBatchId,
    governedReviewBatchDigest: artifact.truth.origin.governedReviewBatchDigest,
    reviewInstructionVersionId: artifact.truth.origin.reviewInstructionVersionId,
    reviewInstructionDigest: artifact.truth.origin.reviewInstructionDigest,
    populationId: artifact.truth.origin.populationId,
    populationDigest: artifact.truth.origin.populationDigest,
    drawDigest: artifact.truth.origin.drawDigest,
    representativeOfPopulationId: artifact.truth.representativeOfPopulationId,
    selectionMethod: artifact.truth.selectionMethod,
    exposureAuthorizationSnapshotDigest: artifact.exposure.authorization.snapshotDigest,
    exposureAuthorizationEventId: artifact.exposure.authorization.eventId,
    exposureCompletionSnapshotDigest: artifact.exposure.completion.snapshotDigest,
    exposureCompletionEventId: artifact.exposure.completion.eventId,
    exposureCompletionState: artifact.exposure.completion.state,
    exposureCompletionEligibility: artifact.exposure.completion.eligibility.result,
    executionEnvironment: artifact.execution.providerDataHandling.executionEnvironment,
    providerDataHandlingPolicyId: artifact.execution.providerDataHandling.policyId,
    providerDataHandlingPolicyDigest: artifact.execution.providerDataHandling.policyDigest,
    positiveClass: artifact.positiveClass,
    trialPlanKind: artifact.trialPlan.kind,
    trialsPerItem: artifact.trialPlan.trialsPerItem,
    suiteManifestId: artifact.suiteBinding?.manifestId ?? null,
    suiteManifestDigest: artifact.suiteBinding?.manifestDigest ?? null,
    suiteMemberPosition: artifact.suiteBinding?.memberPosition ?? null
  };
  for (const key of Object.keys(expected) as Array<keyof ExpectedBinaryCalibrationArtifact>) {
    if (actual[key] !== expected[key]) {
      throw new Error(`binary calibration ${key} mismatch: expected ${String(expected[key])}`);
    }
  }
}

function verifyUntrustedJsonBounds(value: unknown, maxArrayItems = BINARY_CALIBRATION_MAX_ITEMS): void {
  const stack: Array<{ entry: unknown; depth: number }> = [{ entry: value, depth: 0 }];
  while (stack.length > 0) {
    const { entry, depth } = stack.pop()!;
    if (depth > BINARY_CALIBRATION_MAX_JSON_DEPTH) {
      throw new Error(`binary calibration JSON exceeds depth ${BINARY_CALIBRATION_MAX_JSON_DEPTH}`);
    }
    if (typeof entry === "string") {
      if (Array.from(entry).length > BINARY_CALIBRATION_MAX_STRING_CODE_POINTS) {
        throw new Error(`binary calibration string exceeds ${BINARY_CALIBRATION_MAX_STRING_CODE_POINTS} Unicode code points`);
      }
      continue;
    }
    if (Array.isArray(entry)) {
      if (entry.length > maxArrayItems) {
        throw new Error(`binary calibration array exceeds ${maxArrayItems} entries`);
      }
      for (const child of entry) stack.push({ entry: child, depth: depth + 1 });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > 100) throw new Error("binary calibration object exceeds 100 properties");
      for (const key of keys) {
        if (Array.from(key).length > BINARY_CALIBRATION_MAX_STRING_CODE_POINTS) {
          throw new Error(`binary calibration string exceeds ${BINARY_CALIBRATION_MAX_STRING_CODE_POINTS} Unicode code points`);
        }
        stack.push({ entry: record[key], depth: depth + 1 });
      }
    }
  }
}

function verifyExactTimestamp(value: string, field: string): void {
  if (!EXACT_UTC_MILLISECONDS_PATTERN.test(value)) {
    throw new Error(`${field} must use exact RFC3339 UTC milliseconds`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw new Error(`${field} is not an exact calendar timestamp`);
  }
}

function containsNegativeZero(value: unknown): boolean {
  if (typeof value === "number") return Object.is(value, -0);
  if (Array.isArray(value)) return value.some(containsNegativeZero);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsNegativeZero);
  }
  return false;
}

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > BINARY_CALIBRATION_MAX_ITEMS || Object.is(value, -0)) {
    throw new Error(`${field} must be a nonnegative safe integer no greater than ${BINARY_CALIBRATION_MAX_ITEMS}`);
  }
}

function safeSum(left: number, right: number, field: string): number {
  assertCount(left, field);
  assertCount(right, field);
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum > BINARY_CALIBRATION_MAX_ITEMS) {
    throw new Error(`${field} exceeds the calibration count domain`);
  }
  return sum;
}

function safeDouble(value: number, field: string): number {
  assertCount(value, field);
  const doubled = value * 2;
  if (!Number.isSafeInteger(doubled) || doubled > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${field} is not an exact safe integer`);
  }
  return doubled;
}

function safeIntegerSum(left: number, right: number, field: string): number {
  if (
    !Number.isSafeInteger(left) || left < 0 || Object.is(left, -0) ||
    !Number.isSafeInteger(right) || right < 0 || Object.is(right, -0)
  ) {
    throw new Error(`${field} must use nonnegative safe integers`);
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error(`${field} is not an exact safe integer`);
  return sum;
}

function sha256Canonical(value: unknown): string {
  if (containsLoneUtf16Surrogate(value)) {
    throw new Error("digest input must contain only valid Unicode scalar values");
  }
  if (containsNegativeZero(value)) throw new Error("digest input must not contain negative zero");
  const digest = `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
  if (!SHA256_DIGEST_PATTERN.test(digest)) throw new Error("internal SHA-256 failure");
  return digest;
}

export function compareProviderIdentityStrength(
  observed: BinaryCalibrationProviderIdentityStrength,
  required: BinaryCalibrationProviderIdentityStrength
): number {
  return PROVIDER_STRENGTH_ORDER[observed] - PROVIDER_STRENGTH_ORDER[required];
}

export function isOutcomeUnknownError(code: BinaryCalibrationErrorCode): boolean {
  return code === "outcome_unknown";
}
