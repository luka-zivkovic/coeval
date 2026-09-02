import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,
  SkillVersionSchema,
  type BinaryCalibrationCompletionEligibilityReason,
  type BinaryCalibrationErrorCode,
  type BinaryCalibrationPrivateLedger,
  type ModelBinding,
  type SkillVersion
} from "@coeval/shared";
import { evaluatorExecutionAuthorizationDigest } from "../lib/evaluator-lifecycle.js";
import { canonicalJson, sha256Digest } from "../lib/assessment-receipt.js";

import type {
  BinaryCalibrationActor,
  BinaryCalibrationArtifactCopy,
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationProviderDataHandlingPolicy,
  BinaryCalibrationRequestedModelBinding,
  BinaryCalibrationRunProjection,
  CompleteBinaryCalibrationAttemptInput,
  CreateBinaryCalibrationRunInput
} from "./repository.js";
import { binaryCalibrationBaseUrlDigest, BinaryCalibrationRepositoryError } from "./repository.js";

export type Db = Pool | PoolClient;

export const COVERED_CAPABILITIES = [
  "criterion_authoring",
  "instruction_authoring",
  "evaluator_authoring",
  "rubric_authoring",
  "prompt_authoring",
  "example_selection",
  "development_exposure"
] as const;

export interface RunRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  dataset_revision_id: string;
  revision_digest: string;
  truth_content_digest: string;
  item_count: number;
  criterion_id: string;
  criterion_version_id: string;
  criterion_digest: string;
  skill_id: string;
  skill_version_id: string;
  requested_provider: string;
  requested_model_id: string;
  requested_model_version: string;
  temperature_decimal: string;
  top_p_decimal: string | null;
  endpoint_kind: "managed" | "custom";
  base_url_digest: string | null;
  requested_binding_digest: string;
  suite_manifest_id: string | null;
  suite_manifest_digest: string | null;
  suite_member_position: number | null;
  positive_class: "pass" | "fail";
  state: BinaryCalibrationRunProjection["state"];
  planned_observations: number;
  accounted_observations: number;
  artifact_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface FrozenOriginRow extends Record<string, unknown> {
  batch_id: string;
  batch_content_digest: string;
  instruction_version_id: string;
  instruction_digest: string;
  population_id: string;
  population_digest: string;
  source_population_id: string;
  population_definition: unknown;
  population_collection_provenance: unknown;
  population_size: number;
  selection_method: string;
  selection_seed: string | null;
  rng_version: string | null;
  draw_executed_by: string;
  fixed_budget: number;
  draw_digest: string;
  strata: unknown;
  custodian_subject_id: string;
}

export interface EligibilityResult {
  exposureState: "protected" | "exposed";
  eligible: boolean;
  reasons: BinaryCalibrationCompletionEligibilityReason[];
  snapshot: Record<string, unknown>;
}
export function aggregateTrial(records: BinaryCalibrationPrivateLedger["records"]) {
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
  const truthSupport = { total: records.length, pass: 0, fail: 0 };
  const confusionMatrix = {
    truthPassEvaluatorPass: 0,
    truthPassEvaluatorFail: 0,
    truthFailEvaluatorPass: 0,
    truthFailEvaluatorFail: 0
  };
  const errors = new Map<BinaryCalibrationErrorCode, number>();
  const groups = new Map<string, {
    provider: string;
    observedModel: string | null;
    observedVersion: string | null;
    systemFingerprint: string | null;
    identityStrength: "observed_version" | "observed_fingerprint" | "observed_model" | "requested_only";
    observationCount: number;
  }>();
  for (const record of records) {
    truthSupport[record.truthLabel] += 1;
    outcomes.providerCalls += record.physicalProviderCalls;
    const bucket = record.terminalEvaluatorOutcome === "evaluator_pass" ||
      record.terminalEvaluatorOutcome === "evaluator_fail"
      ? "classified"
      : record.terminalEvaluatorOutcome;
    const outcomeBucket = bucket === "classified" || bucket === "abstained" ||
      bucket === "errored" || bucket === "unevaluated" ? bucket : "errored";
    outcomes[outcomeBucket] += 1;
    outcomes.byTruth[record.truthLabel][outcomeBucket] += 1;
    if (record.terminalEvaluatorOutcome === "evaluator_pass") {
      confusionMatrix[record.truthLabel === "pass" ?
        "truthPassEvaluatorPass" : "truthFailEvaluatorPass"] += 1;
    } else if (record.terminalEvaluatorOutcome === "evaluator_fail") {
      confusionMatrix[record.truthLabel === "pass" ?
        "truthPassEvaluatorFail" : "truthFailEvaluatorFail"] += 1;
    }
    if (record.errorCode) errors.set(record.errorCode, (errors.get(record.errorCode) ?? 0) + 1);
    const identityStrength = record.providerObservation.observedVersion !== null
      ? "observed_version" as const
      : record.providerObservation.systemFingerprint !== null
        ? "observed_fingerprint" as const
        : record.providerObservation.observedModel !== null
          ? "observed_model" as const
          : "requested_only" as const;
    const group = { ...record.providerObservation, identityStrength, observationCount: 1 };
    const key = canonicalJson({
      provider: group.provider,
      observedModel: group.observedModel,
      observedVersion: group.observedVersion,
      systemFingerprint: group.systemFingerprint,
      identityStrength: group.identityStrength
    });
    const prior = groups.get(key);
    groups.set(key, prior ? { ...prior, observationCount: prior.observationCount + 1 } : group);
  }
  outcomes.errors = [...errors.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, count]) => ({ code, count }));
  const providerIdentityGroups = [...groups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, group]) => group);
  return { outcomes, truthSupport, confusionMatrix, providerIdentityGroups };
}

export function requestedBindingFor(binding: ModelBinding): BinaryCalibrationRequestedModelBinding {
  if (!["anthropic", "openai", "openrouter", "custom", "mock"].includes(binding.provider)) {
    throw repoError("unsupported", "sealed calibration requires a canonical supported provider id");
  }
  if (!binding.modelId || !binding.modelVersion ||
      Array.from(binding.modelId).length > 4_096 || Array.from(binding.modelVersion).length > 4_096 ||
      containsLoneSurrogate(binding.modelId) || containsLoneSurrogate(binding.modelVersion)) {
    throw repoError("unsupported", "sealed calibration requires a nonempty model id and requested version");
  }
  const endpointKind = binding.provider === "custom" ? "custom" as const : "managed" as const;
  if ((endpointKind === "custom") !== Boolean(binding.baseUrl)) {
    throw repoError("unsupported", "custom sealed calibration bindings require an exact base URL");
  }
  const unsigned = {
    provider: binding.provider,
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    temperatureDecimal: canonicalDecimal(binding.temperature),
    topPDecimal: binding.topP === undefined ? null : canonicalDecimal(binding.topP),
    endpointKind,
    baseUrlDigest: binding.baseUrl ? binaryCalibrationBaseUrlDigest(binding.baseUrl) : null
  };
  return { ...unsigned, requestedBindingDigest: sha256Digest(unsigned) };
}

export function requestedBindingFromRun(run: Record<string, unknown>): BinaryCalibrationRequestedModelBinding {
  return {
    provider: String(run.requested_provider),
    modelId: String(run.requested_model_id),
    modelVersion: String(run.requested_model_version),
    temperatureDecimal: String(run.temperature_decimal),
    topPDecimal: nullableString(run.top_p_decimal),
    endpointKind: run.endpoint_kind === "custom" ? "custom" : "managed",
    baseUrlDigest: nullableString(run.base_url_digest),
    requestedBindingDigest: String(run.requested_binding_digest)
  };
}

export function providerPolicyFor(
  binding: BinaryCalibrationRequestedModelBinding
): BinaryCalibrationProviderDataHandlingPolicy {
  const executionEnvironment = binding.provider === "mock" ? "local_provider" : "external_provider";
  const policyContent = {
    contract: "coeval/provider-data-handling-policy/v1",
    schemaVersion: 1,
    provider: binding.provider,
    endpointKind: binding.endpointKind,
    baseUrlDigest: binding.baseUrlDigest,
    executionEnvironment,
    payloadTransmission: "sealed_payload_to_pinned_provider" as const,
    rawProviderResponsePersistence: "none"
  };
  const policyDigest = sha256Digest(policyContent);
  return {
    executionEnvironment,
    policyId: stableId("bcp", policyDigest),
    policyDigest,
    payloadTransmission: "sealed_payload_to_pinned_provider"
  };
}

export function skillVersionFromRow(row: Record<string, unknown>): SkillVersion {
  const scalarRange = row.scalar_range === null || row.scalar_range === undefined
    ? null : parseJson(row.scalar_range);
  const choices = row.categorical_choice_scores === null || row.categorical_choice_scores === undefined
    ? null : parseJson(row.categorical_choice_scores);
  return SkillVersionSchema.parse({
    id: String(row.id),
    skillId: String(row.skill_id),
    criterionVersionId: String(row.criterion_version_id),
    version: String(row.version),
    status: String(row.status),
    rubricMarkdown: String(row.rubric_markdown),
    prompt: String(row.prompt),
    modelBinding: parseJson(row.model_binding),
    outputSchema: parseJson(row.output_schema),
    goldenSetAgreement: row.golden_set_agreement == null ? null : Number(row.golden_set_agreement),
    tooStrictCount: Number(row.too_strict_count),
    tooLenientCount: Number(row.too_lenient_count),
    ambiguousCount: Number(row.ambiguous_count),
    knownLimitations: asStringArray(row.known_limitations),
    verdictKind: String(row.verdict_kind),
    scalarRange,
    categoricalChoiceScores: choices,
    rubricProvenance: String(row.rubric_provenance),
    regressionDatasetRevisionId: nullableString(row.regression_dataset_revision_id),
    createdAt: toIso(row.created_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null
  });
}

export function rowToRun(row: RunRow): BinaryCalibrationRunProjection {
  return {
    runId: String(row.id),
    projectId: String(row.project_id),
    datasetRevisionId: String(row.dataset_revision_id),
    revisionDigest: String(row.revision_digest),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    skillId: String(row.skill_id),
    skillVersionId: String(row.skill_version_id),
    positiveClass: row.positive_class === "pass" ? "pass" : "fail",
    trialPlan: { kind: "single", trialsPerItem: 1 },
    suiteBinding: row.suite_manifest_id === null ? null : {
      manifestId: String(row.suite_manifest_id),
      manifestDigest: String(row.suite_manifest_digest),
      memberPosition: Number(row.suite_member_position)
    },
    state: row.state,
    plannedObservations: Number(row.planned_observations),
    accountedObservations: Number(row.accounted_observations),
    artifactId: nullableString(row.artifact_id),
    artifactDigest: nullableString(row.artifact_digest),
    evidenceDigest: nullableString(row.evidence_digest),
    createdAt: toIso(row.created_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null
  };
}

export function artifactCopyFromRow(row: Record<string, unknown>): BinaryCalibrationArtifactCopy {
  return {
    artifactId: String(row.id),
    calibrationRunId: String(row.run_id),
    canonicalBytes: Uint8Array.from(Buffer.from(row.canonical_bytes as Uint8Array)),
    artifactDigest: String(row.artifact_digest),
    evidenceDigest: String(row.evidence_digest),
    createdAt: toIso(row.created_at)
  };
}

export function claimFromRow(row: Record<string, unknown>): BinaryCalibrationExecutionClaim {
  return {
    runId: String(row.id),
    workerId: String(row.claim_worker_id),
    claimToken: String(row.claim_token),
    claimExpiresAt: toIso(row.claim_expires_at)
  };
}

export function validateCreateInput(input: CreateBinaryCalibrationRunInput): void {
  if (!input.datasetRevisionId || !input.skillVersionId) {
    throw repoError("unsupported", "binary calibration requires revision and evaluator identities");
  }
  if (input.positiveClass !== "pass" && input.positiveClass !== "fail") {
    throw repoError("unsupported", "binary calibration positive class must be pass or fail");
  }
  if (input.trialPlan.kind !== "single" || input.trialPlan.trialsPerItem !== 1) {
    throw repoError("unsupported", "Batch 5B executes only one trial per item");
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200 ||
      input.idempotencyKey.trim() !== input.idempotencyKey) {
    throw repoError("unsupported", "binary calibration idempotency key must be 1-200 unpadded characters");
  }
  if (input.suiteBinding && (!Number.isSafeInteger(input.suiteBinding.memberPosition) ||
      input.suiteBinding.memberPosition < 0 || input.suiteBinding.memberPosition > 99)) {
    throw repoError("unsupported", "binary calibration suite member position must be 0-99");
  }
}

export function validateClaimInput(workerId: string, claimTtlMs: number): void {
  if (!workerId || workerId.length > 256 || !Number.isSafeInteger(claimTtlMs) ||
      claimTtlMs < 1_000 || claimTtlMs > 15 * 60_000) {
    throw repoError("unsupported", "binary calibration claim requires a worker id and a 1s-15m TTL");
  }
}

export function validateAttemptCompletion(input: CompleteBinaryCalibrationAttemptInput): void {
  const allowedOutcomes = ["evaluator_pass", "evaluator_fail", "abstained", "errored", "unevaluated"];
  const allowedErrors: BinaryCalibrationErrorCode[] = [
    "provider_unavailable", "provider_authentication", "provider_rate_limit", "provider_timeout",
    "provider_transport", "provider_protocol", "invalid_evaluator_output", "outcome_unknown", "internal"
  ];
  if (!allowedOutcomes.includes(input.terminalEvaluatorOutcome)) {
    throw repoError("unsupported", "unknown terminal evaluator outcome");
  }
  if (input.errorCode !== null && !allowedErrors.includes(input.errorCode)) {
    throw repoError("unsupported", "unknown binary calibration error code");
  }
  if ((input.terminalEvaluatorOutcome === "errored") !== (input.errorCode !== null)) {
    throw repoError("conflict", "only errored calibration outcomes carry an error code");
  }
  if (input.errorCode === "outcome_unknown") {
    throw repoError("conflict", "outcome_unknown is reserved for repository crash recovery");
  }
  const expectedState = input.terminalEvaluatorOutcome === "unevaluated" ? "not_started" : "terminal";
  if (input.attemptState !== expectedState) {
    throw repoError("conflict", `${input.terminalEvaluatorOutcome} requires ${expectedState} attempt state`);
  }
  if ((input.providerObservation.observedVersion !== null ||
      input.providerObservation.systemFingerprint !== null) &&
      input.providerObservation.observedModel === null) {
    throw repoError("conflict", "observed provider version/fingerprint requires an observed model");
  }
  for (const value of [
    input.providerObservation.provider,
    input.providerObservation.observedModel,
    input.providerObservation.observedVersion,
    input.providerObservation.systemFingerprint
  ]) {
    if (value !== null && (Array.from(value).length > 4_096 || containsLoneSurrogate(value))) {
      throw repoError("unsupported", "provider observation strings exceed the contract boundary");
    }
  }
}

export async function requireProjectOwner(client: PoolClient, actor: BinaryCalibrationActor): Promise<void> {
  const result = await client.query(
    `select 1 from project_members where project_id=$1 and user_id=$2 and role='owner'`,
    [actor.projectId, actor.userId]
  );
  if (!result.rows[0]) throw repoError("forbidden", "only a project owner may start sealed calibration");
}

export function requireOwner(actor: BinaryCalibrationActor): void {
  if (actor.projectRole !== "owner") {
    throw repoError("forbidden", "only a project owner may start sealed calibration");
  }
}

export function repoError(
  code: ConstructorParameters<typeof BinaryCalibrationRepositoryError>[0],
  message: string
): BinaryCalibrationRepositoryError {
  return new BinaryCalibrationRepositoryError(code, message);
}

export function mapPgError(error: unknown): Error {
  if (error instanceof BinaryCalibrationRepositoryError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code) : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint) : "";
  if (code === "23505" && constraint.includes("idempotency")) {
    return repoError("idempotency_conflict", "binary calibration idempotency conflict");
  }
  if (code === "23505" || code === "40001" || code === "40P01" || code === "55000") {
    return repoError("state_conflict", "binary calibration state conflict");
  }
  if (code === "23503" || code === "23514") {
    return repoError("ineligible", "binary calibration identity or invariant is ineligible");
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function insertEvaluatorExecutionAuthorization(
  client: PoolClient,
  run: Record<string, unknown>,
  input: {
    context: "binary_calibration_evidence";
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }
): Promise<void> {
  const current = (await client.query(
    `select lifecycle.id as lifecycle_id,head.id as event_id,head.calibration_artifact_id
     from skill_versions version
     left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
     left join lateral evaluator_lifecycle_head_v1(lifecycle.id) head on true
     where version.project_id=$1 and version.id=$2`,
    [run.project_id, run.skill_version_id]
  )).rows[0];
  if (!current) throw repoError("ineligible", "binary calibration evaluator version is unavailable");
  const contentDigest = evaluatorExecutionAuthorizationDigest({
    projectId: String(run.project_id),
    skillVersionId: String(run.skill_version_id),
    context: input.context,
    lifecycleEventId: current.event_id ? String(current.event_id) : null,
    calibrationArtifactId: current.calibration_artifact_id ? String(current.calibration_artifact_id) : null,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId
  });
  const authorization = await client.query(
    `insert into evaluator_execution_authorizations
       (id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,
        calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (project_id,idempotency_key)
     do nothing
     returning content_digest`,
    [stableId("eauth",String(run.id),input.context),EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,
      run.project_id,run.skill_version_id,input.context,current.event_id ?? null,
      current.calibration_artifact_id ?? null,input.resourceKind,input.resourceId,input.idempotencyKey,
      contentDigest]
  );
  const persistedDigest = authorization.rows[0]?.content_digest ?? (await client.query(
    `select content_digest from evaluator_execution_authorizations
     where project_id=$1 and idempotency_key=$2`,
    [run.project_id,input.idempotencyKey]
  )).rows[0]?.content_digest;
  if (String(persistedDigest ?? "") !== contentDigest) {
    throw repoError("ineligible", "binary calibration execution authorization replay does not match");
  }
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 48)}`;
}

function canonicalDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    throw repoError("unsupported", "model binding decimal is not a canonical nonnegative finite number");
  }
  const raw = JSON.stringify(value);
  if (!/[eE]/.test(raw)) return raw;
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (!match) throw repoError("unsupported", "model binding decimal cannot be canonicalized");
  const integer = match[1]!;
  const fraction = match[2] ?? "";
  const digits = `${integer}${fraction}`;
  const point = integer.length + Number(match[3]);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${"0".repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export async function databaseClock(db: Db): Promise<string> {
  const row = (await db.query(
    `select date_trunc('milliseconds',clock_timestamp()) as recorded_at`
  )).rows[0];
  return toIso(row.recorded_at);
}

export function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid persisted timestamp");
  return date.toISOString();
}

export function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function isString(value: string | null): value is string {
  return value !== null;
}

export function isEmptyObject(value: unknown): boolean {
  return !(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0);
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) return true;
  }
  return false;
}
