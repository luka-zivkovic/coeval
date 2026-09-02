import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { governedContentV1Digest } from "../lib/governed-content-digest.js";

import type {
  CreateGovernedReviewBatchInput,
  GovernedAdjudicationProjection,
  GovernedAlignmentEventProjection,
  GovernedReviewInstructionProjection,
  GovernedSealedIntakeReceipt,
  ImportedTruthProjection
} from "./contracts.js";
import {
  GovernedReviewConflictError,
  GovernedReviewForbiddenError,
  GovernedReviewIdempotencyConflictError,
  GovernedReviewLabelAlreadyRevealedError,
  GovernedReviewSealedOverlapError,
  GovernedReviewSeparationIneligibleError,
  GovernedReviewSeparationUnknownError
} from "./errors.js";

import type { GovernedReviewActor } from "./repository.js";

export type Db = Pool | PoolClient;

export const ALLOWED_LABELS = ["pass", "fail", "cannot_determine"] as const;
export const MAX_BLIND_VIEW_BYTES = 2 * 1024 * 1024;
// Public idempotency keys are bounded to 200 bytes by contracts.ts. Keeping
// internal stream keys outside that length domain makes collisions impossible
// even when a caller deliberately chooses the old `view:<taskId>` shape.
export const INTERNAL_VIEW_IDEMPOTENCY_KEY = `coeval-internal/view/v1/${"0".repeat(200)}`;
export const COVERED_CAPABILITIES = [
  "criterion_authoring", "instruction_authoring", "evaluator_authoring",
  "rubric_authoring", "prompt_authoring", "example_selection", "development_exposure"
] as const;

export interface BatchRow {
  id: string;
  project_id: string;
  criterion_version_id: string;
  instruction_version_id: string;
  role_intent: "analysis_authoring" | "iterative_development" | "sealed_validation";
  source_population_kind: "dataset_revision" | "sealed_intake" | "analysis_promotion_handoff";
  source_population_id: string;
  population_id: string;
  population_definition: unknown;
  population_collection_provenance: unknown;
  population_size: number;
  population_digest: string;
  selection_method: CreateGovernedReviewBatchInput["selection"]["method"];
  selection_seed: string | null;
  rng_version: string | null;
  selection_algorithm_version: string;
  fixed_budget: number;
  stop_at: Date | string;
  draw_digest: string;
  required_labels_per_item: number;
  custodian_subject_id: string | null;
  custodian_role_at_review: string | null;
  created_at: Date | string;
}
export function taskEventContent(input: {
  actorRoleAtReview: string;
  actorSubjectId: string;
  eventKind: string;
  taskId: string;
  sequence: number;
  previousEventDigest: string | null;
  labelId?: string | null;
  reason?: string | null;
  canonicalViewBytesBase64?: string | null;
  viewDigest?: string | null;
  viewContractVersion?: string | null;
  canonicalizationVersion?: string | null;
  exposureClass?: string | null;
  activity?: string | null;
}) {
  return {
    activity: input.activity ?? null,
    actorRoleAtReview: input.actorRoleAtReview,
    actorSubjectId: input.actorSubjectId,
    canonicalizationVersion: input.canonicalizationVersion ?? null,
    eventKind: input.eventKind,
    exposureClass: input.exposureClass ?? null,
    labelId: input.labelId ?? null,
    reason: input.reason ?? null,
    canonicalViewBytesBase64: input.canonicalViewBytesBase64 ?? null,
    previousEventDigest: input.previousEventDigest,
    sequence: input.sequence,
    stateVersion: input.sequence,
    taskId: input.taskId,
    viewContractVersion: input.viewContractVersion ?? null,
    viewDigest: input.viewDigest ?? null
  };
}

export async function loadAdjudication(
  db: Db,
  row: Record<string, unknown>
): Promise<GovernedAdjudicationProjection> {
  const labels = await db.query(
    `select label_id from governed_review_adjudication_labels
     where adjudication_id=$1 order by label_id`, [row.id]
  );
  return {
    adjudicationId: String(row.id),
    batchId: String(row.batch_id),
    batchItemId: String(row.batch_item_id),
    chainVersion: Number(row.chain_version),
    predecessorAdjudicationId: row.supersedes_adjudication_id
      ? String(row.supersedes_adjudication_id)
      : null,
    decision: row.decision as GovernedAdjudicationProjection["decision"],
    rationale: String(row.rationale),
    basis: String(row.basis),
    correctionReason: row.correction_reason ? String(row.correction_reason) : null,
    consideredLabelIds: labels.rows.map((label) => String(label.label_id)),
    createdAt: iso(row.created_at)
  };
}

export function rowToAlignment(row: Record<string, unknown>): GovernedAlignmentEventProjection {
  return {
    alignmentEventId: String(row.id),
    batchId: String(row.batch_id),
    sequence: Number(row.sequence),
    kind: row.event_kind as GovernedAlignmentEventProjection["kind"],
    content: String(row.content),
    proposedInstructionVersionId: row.proposed_instruction_version_id
      ? String(row.proposed_instruction_version_id)
      : null,
    visibleLabelCount: Number(row.visible_label_count),
    occurredAt: iso(row.occurred_at)
  };
}

export function rowToImportedTruth(row: Record<string, unknown>): ImportedTruthProjection {
  const bytes = row.source_artifact_bytes as Buffer | Uint8Array;
  return {
    importedTruthId: String(row.id),
    criterionVersionId: String(row.criterion_version_id),
    issuer: String(row.issuer),
    subject: String(row.subject),
    sourceArtifactDigest: String(row.source_artifact_digest),
    sourceArtifactBytes: bytes.byteLength,
    verificationMethod: row.verification_method as ImportedTruthProjection["verificationMethod"],
    evidenceClass: row.evidence_class as ImportedTruthProjection["evidenceClass"],
    inputDigest: String(row.input_digest),
    label: row.label as ImportedTruthProjection["label"],
    rationale: String(row.rationale),
    failureCodes: asStringArray(row.failure_codes),
    provenanceDigest: String(row.provenance_digest),
    contentDigest: String(row.content_digest),
    importedAt: iso(row.imported_at)
  };
}

export function rowToInstruction(row: Record<string, unknown>): GovernedReviewInstructionProjection {
  return {
    instructionVersionId: String(row.id),
    criterionVersionId: String(row.criterion_version_id),
    revision: Number(row.revision),
    predecessorInstructionVersionId: row.predecessor_instruction_version_id
      ? String(row.predecessor_instruction_version_id)
      : null,
    title: String(row.title),
    instructions: String(row.instructions),
    failureCodeGuidance: String(row.failure_code_guidance),
    allowedLabels: [...ALLOWED_LABELS],
    instructionDigest: String(row.content_digest),
    createdAt: iso(row.created_at)
  };
}

export function rowToIntake(row: Record<string, unknown>): GovernedSealedIntakeReceipt {
  const definition = parseJson(row.population_definition) as { definition?: unknown };
  return {
    intakeId: String(row.id),
    protection: "sealed",
    populationDefinition: typeof definition.definition === "string"
      ? definition.definition
      : "Protected sealed intake",
    itemCount: Number(row.frame_count),
    frameDigest: String(row.frame_digest),
    predecessorRevisionId: row.predecessor_revision_id ? String(row.predecessor_revision_id) : null,
    createdAt: iso(row.created_at)
  };
}

export async function ensureSubject(
  client: PoolClient,
  projectId: string,
  userId: string
): Promise<{ id: string }> {
  const member = await client.query(
    `select 1 from project_members where project_id=$1 and user_id=$2`, [projectId, userId]
  );
  if (!member.rowCount) throw new GovernedReviewForbiddenError("The actor is not a project member");
  const id = governedSubjectId(projectId, userId);
  await client.query(
    `insert into governed_reviewer_subjects (id,project_id,account_user_id,subject_digest)
     values ($1,$2,$3,governed_content_v1_digest(
       'governed-reviewer-subject/v1',jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
     )) on conflict (project_id,account_user_id) where account_user_id is not null do nothing`,
    [id, projectId, userId]
  );
  const row = (await client.query(
    `select id from governed_reviewer_subjects
     where project_id=$1 and account_user_id=$2`, [projectId, userId]
  )).rows[0];
  if (!row) throw new GovernedReviewForbiddenError();
  return { id: String(row.id) };
}

function governedSubjectId(projectId: string, userId: string): string {
  return stableId("grs", projectId, userId);
}

export async function resolveSubjectId(db: Db, projectId: string, userId: string): Promise<string | null> {
  const row = (await db.query(
    `select subject.id
     from governed_reviewer_subjects subject
     where subject.project_id=$1 and subject.account_user_id=$2`,
    [projectId, userId]
  )).rows[0];
  return row?.id ? String(row.id) : null;
}

export function requireOwnerActor(actor: GovernedReviewActor, action: string): void {
  if (actor.projectRole !== "owner") {
    throw new GovernedReviewForbiddenError(`Only project owners may ${action}`);
  }
}

export function sealedItemId(intakeId: string, clientItemId: string): string {
  return stableId("gri", intakeId, "sealed-client-item", clientItemId);
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 48)}`;
}

export async function dbDigest(db: Db, kind: string, content: unknown): Promise<string> {
  const applicationDigest = governedContentV1Digest(kind, content);
  const row = (await db.query(
    `select governed_content_v1_digest($1,$2::jsonb) as digest`,
    [kind, JSON.stringify(content)]
  )).rows[0];
  const databaseDigest = String(row.digest);
  if (databaseDigest !== applicationDigest) {
    throw new Error(`governed content canonicalization mismatch for ${kind}`);
  }
  return applicationDigest;
}

export async function normalizedTimestamp(db: Db, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const row = (await db.query(`select to_jsonb($1::timestamptz) as value`, [value])).rows[0];
  return String(row.value);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function assertReplay(existing: unknown, candidate: string): void {
  if (String(existing) !== candidate) throw new GovernedReviewIdempotencyConflictError();
}

export function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

export function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function isEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

export function isPgError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

export function mapPgError(error: unknown): Error {
  if (error instanceof Error && error.name.startsWith("GovernedReview")) return error;
  const message = error instanceof Error ? error.message : "Governed review persistence failed";
  if (message.includes("overlap") || message.includes("sealed successor")) {
    return new GovernedReviewSealedOverlapError();
  }
  if (message.includes("missing or ineligible") || message.includes("cannot pass sealed")) {
    return new GovernedReviewSeparationIneligibleError();
  }
  if (message.includes("unknown historical") || message.includes("separation is missing")) {
    return new GovernedReviewSeparationUnknownError();
  }
  if (message.includes("revealed") && message.includes("withdraw")) {
    return new GovernedReviewLabelAlreadyRevealedError();
  }
  if (isPgError(error, "40001")) {
    return new GovernedReviewConflictError(
      "governed_review_stream_conflict",
      "The governed review stream changed before this transaction committed"
    );
  }
  if (isPgError(error, "23505")) return new GovernedReviewIdempotencyConflictError();
  if (isPgError(error, "55000") || isPgError(error, "23514")) {
    return new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The governed review transition failed a persistence invariant"
    );
  }
  return error instanceof Error ? error : new Error(message);
}
