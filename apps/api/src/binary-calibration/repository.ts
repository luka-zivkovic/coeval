import { createHash } from "node:crypto";
import type {
  BinaryCalibrationArtifact,
  BinaryCalibrationCompletionEligibilityReason,
  BinaryCalibrationErrorCode,
  BinaryCalibrationPrivateProviderObservation,
  ModelBinding
} from "@coeval/shared";

export type BinaryCalibrationProjectRole = "owner" | "member";

export interface BinaryCalibrationProjectAccess {
  projectId: string;
}

export interface BinaryCalibrationActor extends BinaryCalibrationProjectAccess {
  userId: string;
  projectRole: BinaryCalibrationProjectRole;
}

export interface BinaryCalibrationProviderDataHandlingPolicy {
  executionEnvironment: "external_provider" | "self_hosted_provider" | "local_provider";
  policyId: string;
  policyDigest: string;
  payloadTransmission: "sealed_payload_to_pinned_provider";
}

export interface CreateBinaryCalibrationRunInput {
  datasetRevisionId: string;
  skillVersionId: string;
  positiveClass: "pass" | "fail";
  trialPlan: { kind: "single"; trialsPerItem: 1 };
  suiteBinding: { manifestId: string; memberPosition: number } | null;
  idempotencyKey: string;
}

export type BinaryCalibrationRunState =
  | "queued"
  | "running"
  | "recovery_required"
  | "complete"
  | "incomplete"
  | "rejected";

export type BinaryCalibrationCurrentAdmissibility = "admissible" | "revoked" | "unknown";

export type BinaryCalibrationArtifactStatusReason =
  | "development_exposure"
  | "provider_policy_invalidated"
  | "provenance_invalidated"
  | "artifact_superseded"
  | "current_status_unavailable";

export interface BinaryCalibrationRunProjection {
  runId: string;
  projectId: string;
  datasetRevisionId: string;
  revisionDigest: string;
  criterionId: string;
  criterionVersionId: string;
  skillId: string;
  skillVersionId: string;
  positiveClass: "pass" | "fail";
  trialPlan: { kind: "single"; trialsPerItem: 1 };
  suiteBinding: {
    manifestId: string;
    manifestDigest: string;
    memberPosition: number;
  } | null;
  state: BinaryCalibrationRunState;
  plannedObservations: number;
  accountedObservations: number;
  artifactId: string | null;
  artifactDigest: string | null;
  evidenceDigest: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BinaryCalibrationArtifactCopy {
  artifactId: string;
  calibrationRunId: string;
  canonicalBytes: Uint8Array;
  artifactDigest: string;
  evidenceDigest: string;
  createdAt: string;
}

export interface BinaryCalibrationArtifactStatusProjection {
  contract: "coeval/binary-calibration-artifact-status/v1";
  schemaVersion: 1;
  artifactId: string;
  calibrationRunId: string;
  artifactStatus: "complete" | "incomplete";
  currentAdmissibility: BinaryCalibrationCurrentAdmissibility;
  reasons: BinaryCalibrationArtifactStatusReason[];
  evaluatedAt: string;
}

/**
 * Digest basis for a custom endpoint: SHA-256 over the UTF-8 bytes of the
 * domain-separated exact stored URL. Callers must not normalize or resolve it.
 */
export function binaryCalibrationBaseUrlDigest(baseUrl: string): string {
  return `sha256:${createHash("sha256")
    .update("coeval/binary-calibration-base-url/v1\0", "utf8")
    .update(baseUrl, "utf8")
    .digest("hex")}`;
}

/**
 * HTTP/session-facing persistence. This surface intentionally cannot load a
 * sealed item or the private ledger. Authentication is resolved before calls;
 * every read remains project-scoped to prevent cross-project identifier leaks.
 */
export interface BinaryCalibrationControlRepository {
  createRun(
    actor: BinaryCalibrationActor,
    input: CreateBinaryCalibrationRunInput
  ): Promise<BinaryCalibrationRunProjection>;
  listRuns(access: BinaryCalibrationProjectAccess): Promise<BinaryCalibrationRunProjection[]>;
  getRun(
    access: BinaryCalibrationProjectAccess,
    runId: string
  ): Promise<BinaryCalibrationRunProjection>;
  getArtifact(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactCopy>;
  getArtifactStatus(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactStatusProjection>;
}

export interface BinaryCalibrationExecutionClaim {
  runId: string;
  workerId: string;
  claimToken: string;
  claimExpiresAt: string;
}

export interface BinaryCalibrationRequestedModelBinding {
  provider: string;
  modelId: string;
  modelVersion: string;
  temperatureDecimal: string;
  topPDecimal: string | null;
  endpointKind: "managed" | "custom";
  baseUrlDigest: string | null;
  requestedBindingDigest: string;
}

export interface BinaryCalibrationAuthorizedRun {
  claim: BinaryCalibrationExecutionClaim;
  projectId: string;
  datasetRevisionId: string;
  revisionDigest: string;
  itemCount: number;
  skillVersionId: string;
  requestedModelBinding: BinaryCalibrationRequestedModelBinding;
  /** Exact stored binding used for provider construction; never persisted in public bytes. */
  executionModelBinding: ModelBinding;
  providerDataHandling: BinaryCalibrationProviderDataHandlingPolicy;
  evaluator: {
    rubricMarkdown: string;
    prompt: string;
    outputSchema: unknown;
  };
  authorization: {
    snapshotDigest: string;
    eventId: string;
    recordedAt: string;
  };
}

export interface BinaryCalibrationAttemptWorkItem {
  attemptId: string;
  runId: string;
  datasetRevisionItemDigest: string;
  trialIndex: 0;
  payloadSnapshot: unknown;
  physicalProviderCalls: number;
}

export interface CompleteBinaryCalibrationAttemptInput {
  terminalEvaluatorOutcome:
    | "evaluator_pass"
    | "evaluator_fail"
    | "abstained"
    | "errored"
    | "unevaluated";
  attemptState: "not_started" | "started" | "terminal";
  errorCode: BinaryCalibrationErrorCode | null;
  providerObservation: BinaryCalibrationPrivateProviderObservation;
}

export interface BinaryCalibrationMintResult {
  run: BinaryCalibrationRunProjection;
  artifact: BinaryCalibrationArtifact;
  artifactCopy: BinaryCalibrationArtifactCopy;
  completion: {
    state: "protected" | "exposed";
    eligibility: "eligible" | "ineligible";
    reasons: BinaryCalibrationCompletionEligibilityReason[];
    snapshotDigest: string;
    eventId: string;
    recordedAt: string;
  };
}

/**
 * Worker-only persistence. Do not inject this interface into the HTTP app.
 * Protected payloads leave the repository one observation at a time, and no
 * method can return private-ledger bytes after atomic minting.
 */
export interface BinaryCalibrationExecutionRepository {
  listRunnableRunIds(limit: number): Promise<string[]>;
  claimRun(
    runId: string,
    workerId: string,
    claimTtlMs: number
  ): Promise<BinaryCalibrationExecutionClaim | null>;
  heartbeatClaim(
    claim: BinaryCalibrationExecutionClaim,
    claimTtlMs: number
  ): Promise<BinaryCalibrationExecutionClaim>;
  authorizeRun(claim: BinaryCalibrationExecutionClaim): Promise<BinaryCalibrationAuthorizedRun>;
  /** Permanently accounts stale `started` rows as errored/outcome_unknown. */
  recoverStartedAttempts(claim: BinaryCalibrationExecutionClaim): Promise<number>;
  getNextAttempt(
    claim: BinaryCalibrationExecutionClaim
  ): Promise<BinaryCalibrationAttemptWorkItem | null>;
  /** Commits started state and increments physical calls before dispatch. */
  recordProviderCallStarted(
    claim: BinaryCalibrationExecutionClaim,
    attemptId: string
  ): Promise<number>;
  completeAttempt(
    claim: BinaryCalibrationExecutionClaim,
    attemptId: string,
    input: CompleteBinaryCalibrationAttemptInput
  ): Promise<void>;
  finalizeRun(claim: BinaryCalibrationExecutionClaim): Promise<BinaryCalibrationMintResult>;
  markRecoveryRequired(claim: BinaryCalibrationExecutionClaim): Promise<void>;
}

export type BinaryCalibrationRepositoryErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "idempotency_conflict"
  | "ineligible"
  | "unsupported"
  | "state_conflict";

export class BinaryCalibrationRepositoryError extends Error {
  constructor(
    public readonly code: BinaryCalibrationRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BinaryCalibrationRepositoryError";
  }
}
