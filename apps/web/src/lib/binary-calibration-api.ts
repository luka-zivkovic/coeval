import {
  BinaryCalibrationArtifactSchema,
  type BinaryCalibrationArtifact
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "coeval.project";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export type BinaryCalibrationRunState =
  | "queued"
  | "running"
  | "recovery_required"
  | "complete"
  | "incomplete"
  | "rejected";

export interface BinaryCalibrationRun {
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

export interface CreateBinaryCalibrationRunInput {
  datasetRevisionId: string;
  skillVersionId: string;
  positiveClass: "pass" | "fail";
  trialPlan: { kind: "single"; trialsPerItem: 1 };
  suiteBinding?: { manifestId: string; memberPosition: number } | null;
  idempotencyKey: string;
}

export interface BinaryCalibrationArtifactStatus {
  contract: "coeval/binary-calibration-artifact-status/v1";
  schemaVersion: 1;
  artifactId: string;
  calibrationRunId: string;
  artifactStatus: "complete" | "incomplete";
  currentAdmissibility: "admissible" | "revoked" | "unknown";
  reasons: BinaryCalibrationArtifactStatusReason[];
  evaluatedAt: string;
}

export type BinaryCalibrationArtifactStatusReason =
  | "development_exposure"
  | "provider_policy_invalidated"
  | "provenance_invalidated"
  | "artifact_superseded"
  | "current_status_unavailable";

const ARTIFACT_STATUS_REASONS = [
  "development_exposure",
  "provider_policy_invalidated",
  "provenance_invalidated",
  "artifact_superseded",
  "current_status_unavailable"
] as const;

export interface BinaryCalibrationArtifactDownload {
  artifact: BinaryCalibrationArtifact;
  canonicalBytes: Uint8Array;
  artifactDigest: string;
  evidenceDigest: string;
}

export class BinaryCalibrationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
    this.name = "BinaryCalibrationApiError";
  }
}

export function calibrationIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-binary-calibration-${suffix}`;
}

export async function fetchBinaryCalibrationRuns(): Promise<BinaryCalibrationRun[]> {
  const response = await calibrationFetch(`${API_BASE}/api/binary-calibration-runs`);
  const body = await responseJson(response, "Binary calibration runs request failed");
  if (!response.ok) throw apiError(response, body, "Binary calibration runs request failed");
  const record = object(body, "binary calibration runs response");
  if (!Array.isArray(record.runs)) throw new Error("Binary calibration response omitted runs");
  return record.runs.map(normalizeRun);
}

export async function fetchBinaryCalibrationRun(runId: string): Promise<BinaryCalibrationRun> {
  const response = await calibrationFetch(
    `${API_BASE}/api/binary-calibration-runs/${pathId(runId)}`
  );
  const body = await responseJson(response, "Binary calibration run request failed");
  if (!response.ok) throw apiError(response, body, "Binary calibration run request failed");
  return normalizeRun(object(body, "binary calibration run response").run);
}

export async function createBinaryCalibrationRun(
  input: CreateBinaryCalibrationRunInput
): Promise<BinaryCalibrationRun> {
  const response = await calibrationFetch(`${API_BASE}/api/binary-calibration-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, suiteBinding: input.suiteBinding ?? null })
  });
  const body = await responseJson(response, "Binary calibration launch failed");
  if (!response.ok) throw apiError(response, body, "Binary calibration launch failed");
  return normalizeRun(object(body, "binary calibration launch response").run);
}

/** Fetches exact artifact bytes through the project-owner session boundary. */
export async function fetchBinaryCalibrationArtifact(
  artifactId: string
): Promise<BinaryCalibrationArtifactDownload> {
  const response = await calibrationFetch(
    `${API_BASE}/api/v1/binary-calibration-artifacts/${pathId(artifactId)}`
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as unknown;
    throw apiError(response, payload, "Binary calibration artifact request failed");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
    throw new Error("Binary calibration artifact exceeds 16 MiB");
  }
  const canonicalBytes = new Uint8Array(await response.arrayBuffer());
  if (canonicalBytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("Binary calibration artifact exceeds 16 MiB");
  }
  const artifactDigest = requiredDigestHeader(response, "x-coeval-artifact-digest");
  const evidenceDigest = requiredDigestHeader(response, "x-coeval-evidence-digest");
  if (response.headers.get("x-coeval-canonicalization") !== "coeval-canonical-json/v1") {
    throw new Error("Binary calibration artifact omitted its canonicalization contract");
  }
  const actualDigest = await sha256Digest(canonicalBytes);
  if (actualDigest !== artifactDigest) {
    throw new Error("Binary calibration artifact bytes do not match their digest header");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes));
  } catch {
    throw new Error("Binary calibration artifact is not valid UTF-8 JSON");
  }
  const artifact = BinaryCalibrationArtifactSchema.parse(raw);
  if (artifact.artifactId !== artifactId) {
    throw new Error("Binary calibration artifact identity does not match the requested artifact");
  }
  if (artifact.evidenceDigest !== evidenceDigest) {
    throw new Error("Binary calibration evidence digest does not match its response header");
  }
  return { artifact, canonicalBytes, artifactDigest, evidenceDigest };
}

/** Fetches current status through the project-owner session boundary. */
export async function fetchBinaryCalibrationArtifactStatus(
  artifactId: string
): Promise<BinaryCalibrationArtifactStatus> {
  const response = await calibrationFetch(
    `${API_BASE}/api/v1/binary-calibration-artifacts/${pathId(artifactId)}/status`
  );
  const body = await responseJson(response, "Binary calibration status request failed");
  if (!response.ok) throw apiError(response, body, "Binary calibration status request failed");
  const value = object(body, "binary calibration status response");
  if (value.contract !== "coeval/binary-calibration-artifact-status/v1" || value.schemaVersion !== 1) {
    throw new Error("Unsupported binary calibration artifact status contract");
  }
  const currentAdmissibility = enumValue(
    value.currentAdmissibility,
    ["admissible", "revoked", "unknown"] as const,
    "current admissibility"
  );
  const reasons = enumArray(value.reasons, ARTIFACT_STATUS_REASONS, "status reasons");
  assertStatusMeaning(currentAdmissibility, reasons);
  const responseArtifactId = stringValue(value.artifactId, "artifactId");
  if (responseArtifactId !== artifactId) {
    throw new Error("Binary calibration status identity does not match the requested artifact");
  }
  return {
    contract: value.contract,
    schemaVersion: 1,
    artifactId: responseArtifactId,
    calibrationRunId: stringValue(value.calibrationRunId, "calibrationRunId"),
    artifactStatus: enumValue(value.artifactStatus, ["complete", "incomplete"] as const, "artifact status"),
    currentAdmissibility,
    reasons,
    evaluatedAt: stringValue(value.evaluatedAt, "evaluatedAt")
  };
}

export function downloadBinaryCalibrationArtifact(
  download: BinaryCalibrationArtifactDownload
): void {
  const exactBuffer = Uint8Array.from(download.canonicalBytes).buffer;
  const blob = new Blob([exactBuffer], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${download.artifact.artifactId}.binary-calibration.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function calibrationFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  try {
    const projectId = localStorage.getItem(PROJECT_KEY);
    if (projectId) headers.set("x-coeval-project", projectId);
  } catch {
    // The authenticated server default remains available when storage is not.
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}

function normalizeRun(raw: unknown): BinaryCalibrationRun {
  const value = object(raw, "binary calibration run");
  const trialPlan = object(value.trialPlan, "trial plan");
  if (trialPlan.kind !== "single" || trialPlan.trialsPerItem !== 1) {
    throw new Error("Binary calibration run does not use the supported single-trial plan");
  }
  const suite = value.suiteBinding === null ? null : object(value.suiteBinding, "suite binding");
  return {
    runId: stringValue(value.runId, "runId"),
    projectId: stringValue(value.projectId, "projectId"),
    datasetRevisionId: stringValue(value.datasetRevisionId, "datasetRevisionId"),
    revisionDigest: digestValue(value.revisionDigest, "revisionDigest"),
    criterionId: stringValue(value.criterionId, "criterionId"),
    criterionVersionId: stringValue(value.criterionVersionId, "criterionVersionId"),
    skillId: stringValue(value.skillId, "skillId"),
    skillVersionId: stringValue(value.skillVersionId, "skillVersionId"),
    positiveClass: enumValue(value.positiveClass, ["pass", "fail"] as const, "positive class"),
    trialPlan: { kind: "single", trialsPerItem: 1 },
    suiteBinding: suite ? {
      manifestId: stringValue(suite.manifestId, "manifestId"),
      manifestDigest: digestValue(suite.manifestDigest, "manifestDigest"),
      memberPosition: integerValue(suite.memberPosition, "memberPosition")
    } : null,
    state: enumValue(value.state, [
      "queued", "running", "recovery_required", "complete", "incomplete", "rejected"
    ] as const, "run state"),
    plannedObservations: integerValue(value.plannedObservations, "plannedObservations"),
    accountedObservations: integerValue(value.accountedObservations, "accountedObservations"),
    artifactId: nullableString(value.artifactId, "artifactId"),
    artifactDigest: nullableDigest(value.artifactDigest, "artifactDigest"),
    evidenceDigest: nullableDigest(value.evidenceDigest, "evidenceDigest"),
    createdAt: stringValue(value.createdAt, "createdAt"),
    startedAt: nullableString(value.startedAt, "startedAt"),
    completedAt: nullableString(value.completedAt, "completedAt")
  };
}

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return `sha256:${[...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function requiredDigestHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value || !DIGEST_PATTERN.test(value)) throw new Error(`Binary calibration response omitted ${name}`);
  return value;
}

async function responseJson(response: Response, fallback: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (!response.ok) throw new BinaryCalibrationApiError(`${fallback}: ${response.status}`, response.status, null);
    throw new Error(`${fallback}: invalid JSON response`);
  }
}

function apiError(response: Response, payload: unknown, fallback: string): BinaryCalibrationApiError {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return new BinaryCalibrationApiError(
    typeof value.error === "string" && value.error ? value.error : `${fallback}: ${response.status}`,
    response.status,
    typeof value.code === "string" ? value.code : null
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function digestValue(value: unknown, label: string): string {
  const digest = stringValue(value, label);
  if (!DIGEST_PATTERN.test(digest)) throw new Error(`Invalid ${label}`);
  return digest;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digestValue(value, label);
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`Invalid ${label}`);
  return value as T[number];
}

function enumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number][] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const parsed = value.map((entry) => enumValue(entry, values, label));
  if (new Set(parsed).size !== parsed.length ||
    parsed.some((entry, index) => entry !== [...parsed].sort()[index])) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function assertStatusMeaning(
  admissibility: BinaryCalibrationArtifactStatus["currentAdmissibility"],
  reasons: BinaryCalibrationArtifactStatusReason[]
): void {
  const unavailable = reasons.includes("current_status_unavailable");
  if (admissibility === "admissible" && reasons.length === 0) return;
  if (admissibility === "unknown" && reasons.length === 1 && unavailable) return;
  if (admissibility === "revoked" && reasons.length > 0 && !unavailable) return;
  throw new Error("Binary calibration status reasons do not match current admissibility");
}

function pathId(value: string): string {
  if (!value.trim()) throw new Error("Binary calibration identifier is required");
  return encodeURIComponent(value);
}
