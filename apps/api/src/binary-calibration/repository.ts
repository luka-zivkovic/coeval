import type {
  BinaryCalibrationV2Artifact,
  BinaryCalibrationV2CompletionEligibilityReason,
  BinaryCalibrationV2PrivateProviderObservation,
  CapabilityProbe,
  EvaluatorItemState,
  ExecutionBinding,
  ResolutionRecord
} from "@rubrist/shared";
import type { GovernedBinding } from "../lib/binding-resolution.js";
import type { ResolutionAttemptInput } from "../evaluator-lifecycle/resolution.pg.js";

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
  contract: "rubrist/binary-calibration-artifact-status/v1";
  schemaVersion: 1;
  artifactId: string;
  calibrationRunId: string;
  artifactStatus: "complete" | "incomplete";
  currentAdmissibility: BinaryCalibrationCurrentAdmissibility;
  reasons: BinaryCalibrationArtifactStatusReason[];
  evaluatedAt: string;
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
  /** A version's binding and latest resolution record, for the gate at run creation; `null` when absent. */
  getGovernedBinding(
    access: BinaryCalibrationProjectAccess,
    skillVersionId: string
  ): Promise<{ binding: GovernedBinding; record: ResolutionRecord | null } | null>;
  /** Appends a resolution attempt and stores it as the version's latest record. */
  recordResolution(attempt: ResolutionAttemptInput, record: ResolutionRecord): Promise<void>;
}

/** What the re-check before authorization reads (ADR-0014 section 4). */
export interface BinaryCalibrationRecheckTarget {
  binding: GovernedBinding;
  /** Whether the run already passed authorization; only the first authorization is re-checked. */
  authorized: boolean;
  /** When the run's latest re-check ended unknown, so a transient error backs off. */
  lastUnknownRecheckAt: string | null;
}

export interface BinaryCalibrationExecutionClaim {
  runId: string;
  workerId: string;
  claimToken: string;
  claimExpiresAt: string;
}

export interface BinaryCalibrationAuthorizedRun {
  claim: BinaryCalibrationExecutionClaim;
  projectId: string;
  datasetRevisionId: string;
  revisionDigest: string;
  itemCount: number;
  skillVersionId: string;
  /** The execution binding the run pins, which every call sends exactly (ADR-0014 section 2). */
  executionBinding: ExecutionBinding;
  /** A custom provider's configured base URL, checked against the binding's digest; never in public bytes. */
  customEndpointUrl: string | null;
  providerDataHandling: BinaryCalibrationProviderDataHandlingPolicy;
  evaluator: {
    rubricMarkdown: string;
    prompt: string;
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
  /** The shared item result (ADR-0014 section 6). */
  result: EvaluatorItemState;
  attemptState: "not_started" | "started" | "terminal";
  providerObservation: BinaryCalibrationV2PrivateProviderObservation;
}

export interface BinaryCalibrationMintResult {
  run: BinaryCalibrationRunProjection;
  artifact: BinaryCalibrationV2Artifact;
  artifactCopy: BinaryCalibrationArtifactCopy;
  completion: {
    state: "protected" | "exposed";
    eligibility: "eligible" | "ineligible";
    reasons: BinaryCalibrationV2CompletionEligibilityReason[];
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
  getRecheckTarget(claim: BinaryCalibrationExecutionClaim): Promise<BinaryCalibrationRecheckTarget>;
  /** Records a re-check against the run it guards; it never changes the resolution record. */
  recordRecheck(
    claim: BinaryCalibrationExecutionClaim,
    result: { outcome: "holds" | "no_longer_holds" | "unknown"; probes: readonly CapabilityProbe[] }
  ): Promise<void>;
  /** Rejects a run the re-check stopped, before any lease or exposure. */
  rejectBeforeAuthorization(claim: BinaryCalibrationExecutionClaim, reason: "resolution_no_longer_holds"): Promise<void>;
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
