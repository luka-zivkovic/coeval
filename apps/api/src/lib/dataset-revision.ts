import { sha256Digest } from "./assessment-receipt.js";
import type { DatasetRevisionRole as SharedDatasetRevisionRole } from "@coeval/shared";

export type DatasetRevisionRole = SharedDatasetRevisionRole;

export const DATASET_REVISION_ROLES = [
  "analysis_authoring",
  "iterative_development",
  "sealed_validation",
  "regression_golden"
] as const satisfies readonly DatasetRevisionRole[];

export const INPUT_IDENTITY_BASIS = "input-identity/v1" as const;
export const DATASET_REVISION_ITEM_DIGEST_BASIS = "dataset-revision-item/v1" as const;
export const DATASET_REVISION_CONTENT_DIGEST_BASIS = "dataset-revision-content/v1" as const;
export const DATASET_REVISION_DIGEST_BASIS = "dataset-revision/v1" as const;
export const SEMANTIC_NEAR_DUPLICATE_DETECTION = "unsupported" as const;
export const PUBLIC_SEALED_REVISION_CREATION_AVAILABLE = false as const;
export const PUBLIC_DATASET_REVISION_ROLES = [
  "analysis_authoring",
  "iterative_development"
] as const satisfies readonly DatasetRevisionRole[];

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface DatasetInputIdentity {
  basis: typeof INPUT_IDENTITY_BASIS;
  digest: string;
}

/**
 * Build the exact leakage identity from the pre-redaction top-level input.
 * Output, steps, metadata, labels, notes, and every other case field are
 * intentionally outside this identity.
 *
 * Canonical JSON sorts object keys but does not Unicode-normalize strings.
 * Consequently this catches exact canonical duplicates, not semantic or
 * Unicode-normalization-equivalent near duplicates.
 */
export function datasetInputIdentity(caseEvidence: Readonly<{ input: unknown }>): DatasetInputIdentity {
  return Object.freeze({
    basis: INPUT_IDENTITY_BASIS,
    digest: sha256Digest(caseEvidence.input)
  });
}

export interface DatasetRevisionItemDigestInput {
  inputIdentity: DatasetInputIdentity;
  redactedPayload: unknown;
  referenceLabel: unknown;
  expectedFailStep: number | null;
  reviewProvenance: unknown;
  note: unknown;
}

/** Digest all frozen item evidence, including its pre-redaction leakage key. */
export function datasetRevisionItemDigest(item: Readonly<DatasetRevisionItemDigestInput>): string {
  assertInputIdentity(item.inputIdentity);
  assertDefined(item.redactedPayload, "Dataset revision redactedPayload");
  assertDefined(item.referenceLabel, "Dataset revision referenceLabel");
  assertDefined(item.reviewProvenance, "Dataset revision reviewProvenance");
  assertDefined(item.note, "Dataset revision note");
  if (item.note !== null && typeof item.note !== "string") {
    throw new Error("Dataset revision note must be a string or null");
  }
  if (item.expectedFailStep !== null && (!Number.isSafeInteger(item.expectedFailStep) || item.expectedFailStep < 0)) {
    throw new Error("Dataset revision expectedFailStep must be a non-negative safe integer or null");
  }
  return sha256Digest({
    basis: DATASET_REVISION_ITEM_DIGEST_BASIS,
    inputIdentity: {
      basis: item.inputIdentity.basis,
      digest: item.inputIdentity.digest
    },
    redactedPayload: item.redactedPayload,
    referenceLabel: item.referenceLabel,
    expectedFailStep: item.expectedFailStep,
    reviewProvenance: item.reviewProvenance,
    note: item.note
  });
}

export interface DatasetRevisionDigestInput {
  role: DatasetRevisionRole;
  itemDigests: readonly string[];
  // Operational identity and lineage are accepted only to make their explicit
  // exclusion from content identity visible at call sites.
  revisionId?: unknown;
  createdAt?: unknown;
  parentRevisionId?: unknown;
}

/** Role-independent identity for the frozen item multiset. */
export function datasetRevisionContentDigest(itemDigests: readonly string[]): string {
  for (const digest of itemDigests) assertSha256Digest(digest, "dataset revision item digest");
  return sha256Digest({
    basis: DATASET_REVISION_CONTENT_DIGEST_BASIS,
    inputIdentityBasis: INPUT_IDENTITY_BASIS,
    itemDigests: [...itemDigests].sort(compareStrings)
  });
}

/**
 * Content-identify a revision as a multiset of frozen items. Lexicographic
 * ordering makes the result independent of database retrieval order while
 * retaining duplicate entries.
 */
export function datasetRevisionDigest(revision: Readonly<DatasetRevisionDigestInput>): string {
  if (!isDatasetRevisionRole(revision.role)) {
    throw new Error("Unknown dataset revision role");
  }
  for (const digest of revision.itemDigests) assertSha256Digest(digest, "dataset revision item digest");
  const orderedItemDigests = [...revision.itemDigests].sort(compareStrings);
  return sha256Digest({
    basis: DATASET_REVISION_DIGEST_BASIS,
    role: revision.role,
    inputIdentityBasis: INPUT_IDENTITY_BASIS,
    itemDigests: orderedItemDigests
  });
}

export type SealedRevisionExposureState = "protected_unexposed" | "exposed";

export type DatasetRoleCompatibilityCode =
  | "allowed_nonsealed_overlap"
  | "allowed_explicit_declassification"
  | "allowed_direct_sealed_successor"
  | "rejected_unknown_role"
  | "rejected_unknown_sealed_exposure_state"
  | "rejected_invalid_transition_context"
  | "rejected_nonsealed_to_sealed"
  | "rejected_explicit_declassification_required"
  | "rejected_sealed_successor_source_exposed"
  | "rejected_sealed_successor_not_direct"
  | "rejected_sealed_successor_branch";

export interface DatasetRoleCompatibilityDecision {
  allowed: boolean;
  code: DatasetRoleCompatibilityCode;
}

export interface DatasetRoleCompatibilityInput {
  fromRole: unknown;
  toRole: unknown;
  sourceSealedExposureState?: unknown;
  explicitDeclassification?: unknown;
  sourceIsDirectParent?: unknown;
  sourceAlreadyHasSealedSuccessor?: unknown;
}

/**
 * Decide whether an exact input identity may move/overlap directionally from
 * one revision role into another. Unknown roles and unknown sealed-state facts
 * fail closed. Public sealed creation is a separate decision below.
 */
export function decideDatasetRoleCompatibility(
  input: Readonly<DatasetRoleCompatibilityInput>
): DatasetRoleCompatibilityDecision {
  if (!isDatasetRevisionRole(input.fromRole) || !isDatasetRevisionRole(input.toRole)) {
    return denied("rejected_unknown_role");
  }

  const fromSealed = input.fromRole === "sealed_validation";
  const toSealed = input.toRole === "sealed_validation";

  if (!fromSealed && !toSealed) return allowed("allowed_nonsealed_overlap");
  if (!fromSealed && toSealed) return denied("rejected_nonsealed_to_sealed");

  if (!isSealedRevisionExposureState(input.sourceSealedExposureState)) {
    return denied("rejected_unknown_sealed_exposure_state");
  }

  if (!toSealed) {
    if (typeof input.explicitDeclassification !== "boolean") {
      return denied("rejected_invalid_transition_context");
    }
    return input.explicitDeclassification
      ? allowed("allowed_explicit_declassification")
      : denied("rejected_explicit_declassification_required");
  }

  if (input.sourceSealedExposureState !== "protected_unexposed") {
    return denied("rejected_sealed_successor_source_exposed");
  }
  if (typeof input.sourceIsDirectParent !== "boolean" || typeof input.sourceAlreadyHasSealedSuccessor !== "boolean") {
    return denied("rejected_invalid_transition_context");
  }
  if (!input.sourceIsDirectParent) return denied("rejected_sealed_successor_not_direct");
  if (input.sourceAlreadyHasSealedSuccessor) return denied("rejected_sealed_successor_branch");
  return allowed("allowed_direct_sealed_successor");
}

export type PublicDatasetRevisionCreationCode =
  | "allowed_public_nonsealed_creation"
  | "rejected_public_sealed_creation_unavailable"
  | "rejected_public_regression_creation_unavailable"
  | "rejected_unknown_role";

export interface PublicDatasetRevisionCreationDecision {
  allowed: boolean;
  code: PublicDatasetRevisionCreationCode;
}

/**
 * Batch 2 public collection freezes are authoring/development evidence only.
 * Sealed validation needs governed blind intake, and regression/golden
 * revisions are materialized solely from promotion/retirement governance.
 */
export function decidePublicDatasetRevisionCreation(role: unknown): PublicDatasetRevisionCreationDecision {
  if (!isDatasetRevisionRole(role)) {
    return { allowed: false, code: "rejected_unknown_role" };
  }
  if (role === "sealed_validation" && !PUBLIC_SEALED_REVISION_CREATION_AVAILABLE) {
    return { allowed: false, code: "rejected_public_sealed_creation_unavailable" };
  }
  if (role === "regression_golden") {
    return { allowed: false, code: "rejected_public_regression_creation_unavailable" };
  }
  return { allowed: true, code: "allowed_public_nonsealed_creation" };
}

export function isDatasetRevisionRole(value: unknown): value is DatasetRevisionRole {
  return typeof value === "string" && (DATASET_REVISION_ROLES as readonly string[]).includes(value);
}

function isSealedRevisionExposureState(value: unknown): value is SealedRevisionExposureState {
  return value === "protected_unexposed" || value === "exposed";
}

function assertInputIdentity(identity: DatasetInputIdentity): void {
  if (identity.basis !== INPUT_IDENTITY_BASIS) {
    throw new Error("Unknown dataset input identity basis");
  }
  assertSha256Digest(identity.digest, "dataset input identity digest");
}

function assertSha256Digest(digest: unknown, name: string): asserts digest is string {
  if (typeof digest !== "string" || !SHA256_DIGEST_PATTERN.test(digest)) {
    throw new Error(`Invalid ${name}`);
  }
}

function assertDefined(value: unknown, name: string): void {
  if (value === undefined) throw new Error(`${name} must be explicit (use null when absent)`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function allowed(code: DatasetRoleCompatibilityCode): DatasetRoleCompatibilityDecision {
  return { allowed: true, code };
}

function denied(code: DatasetRoleCompatibilityCode): DatasetRoleCompatibilityDecision {
  return { allowed: false, code };
}
