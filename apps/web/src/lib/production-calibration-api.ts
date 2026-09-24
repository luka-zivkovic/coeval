import {
  ProductionCalibrationArtifactSchema,
  type ProductionCalibrationArtifact,
  type ProductionCalibrationModelIdentity
} from "@rubrist/shared";

// Client for the production calibration session routes. The preview is
// compute-only: the ledger travels with each request and nothing is stored,
// so every recomputation is a fresh preview. Stored reports and snapshots are
// built by the server from the project's stored decision records, and an
// owner can import a ledger file into those records.

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "rubrist.project";
export const PRODUCTION_CALIBRATION_SAMPLE_PATH = "/samples/production-decision-ledger.flaky-triage.jsonl";

export interface ProductionCalibrationPreviewInput {
  /** JSON Lines text. */
  records: string;
  /** Scope `threshold` and `costs` to one question; other questions keep the defaults. */
  question?: string;
  threshold?: number;
  bins?: number;
  windowDays?: number;
  costs?: { falsePositive: number; falseNegative: number; humanReview: number | null } | null;
}

export interface ProductionCalibrationPreviewQuestion {
  question: string;
  answerTypes: Array<"boolean" | "choice" | "score">;
  decisions: number;
  outcomes: number;
}

export interface ProductionCalibrationPreviewSummary {
  records: { total: number; decisions: number; actions: number; outcomes: number };
  questions: ProductionCalibrationPreviewQuestion[];
  models: Array<{ model: ProductionCalibrationModelIdentity; decisions: number }>;
  questionSetDigests: string[];
  question: string | null;
}

export interface ProductionCalibrationPreview {
  artifact: ProductionCalibrationArtifact;
  summary: ProductionCalibrationPreviewSummary;
  projectRole: "owner" | "member";
}

export class ProductionCalibrationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly line: number | null = null
  ) {
    super(message);
    this.name = "ProductionCalibrationApiError";
  }
}

export async function previewProductionCalibration(
  input: ProductionCalibrationPreviewInput,
  signal?: AbortSignal
): Promise<ProductionCalibrationPreview> {
  const body: Record<string, unknown> = { records: input.records };
  if (input.question !== undefined) body.question = input.question;
  if (input.threshold !== undefined) body.threshold = input.threshold;
  if (input.bins !== undefined) body.bins = input.bins;
  if (input.windowDays !== undefined) body.windowDays = input.windowDays;
  if (input.costs !== undefined) body.costs = input.costs;
  const response = await projectFetch(`${API_BASE}/api/production-calibration/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Production calibration preview failed");
  const record = object(payload, "production calibration preview response");
  const artifact = ProductionCalibrationArtifactSchema.parse(record.artifact);
  const projectRole = record.projectRole;
  if (projectRole !== "owner" && projectRole !== "member") {
    throw new Error("Production calibration preview omitted the project role");
  }
  return { artifact, summary: normalizeSummary(record.summary), projectRole };
}

/** Report parameters shared by the preview and stored reports. */
export type ProductionCalibrationReportParameters = Omit<ProductionCalibrationPreviewInput, "records">;

export interface ProductionCalibrationStoredReportInput extends ProductionCalibrationReportParameters {
  /** Inclusive lower bound on decision time, ISO with an offset; omitted means unbounded. */
  from?: string | null;
  /** Exclusive upper bound on decision time; omitted means unbounded. */
  to?: string | null;
}

export interface ProductionCalibrationStoredReport extends ProductionCalibrationPreview {
  recordCount: number;
  recordSetDigest: string;
}

export interface ProductionCalibrationSnapshotSummary {
  id: string;
  artifactDigest: string;
  window: { from: string | null; to: string | null };
  recordCount: number;
  recordSetDigest: string;
  builtAt: string;
  createdByUserId: string;
  createdAt: string;
}

export interface ProductionCalibrationSnapshot {
  snapshot: ProductionCalibrationSnapshotSummary;
  artifact: ProductionCalibrationArtifact;
}

export interface ProductionRecordImportResult {
  inserted: { decisions: number; actions: number; outcomes: number };
  duplicates: number;
  awaitingDecision: number;
}

export async function buildStoredProductionReport(
  input: ProductionCalibrationStoredReportInput,
  signal?: AbortSignal
): Promise<ProductionCalibrationStoredReport> {
  const response = await projectFetch(`${API_BASE}/api/production-calibration/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(storedReportBody(input)),
    ...(signal ? { signal } : {})
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Production calibration report failed");
  const record = object(payload, "production calibration report response");
  const projectRole = record.projectRole;
  if (projectRole !== "owner" && projectRole !== "member") {
    throw new Error("Production calibration report omitted the project role");
  }
  return {
    artifact: ProductionCalibrationArtifactSchema.parse(record.artifact),
    summary: normalizeSummary(record.summary),
    projectRole,
    recordCount: count(record.recordCount, "recordCount"),
    recordSetDigest: digestText(record.recordSetDigest, "recordSetDigest")
  };
}

/** Build a report from stored records on the server and save it; the client never sends an artifact. */
export async function saveProductionSnapshot(
  input: ProductionCalibrationStoredReportInput
): Promise<ProductionCalibrationSnapshotSummary> {
  const response = await projectFetch(`${API_BASE}/api/production-calibration/snapshots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(storedReportBody(input))
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Saving the snapshot failed");
  return snapshotSummary(object(payload, "snapshot response").snapshot);
}

export async function listProductionSnapshots(): Promise<ProductionCalibrationSnapshotSummary[]> {
  const response = await projectFetch(`${API_BASE}/api/production-calibration/snapshots`);
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Loading snapshots failed");
  const snapshots = object(payload, "snapshot list").snapshots;
  if (!Array.isArray(snapshots)) throw new Error("Invalid snapshot list");
  return snapshots.map(snapshotSummary);
}

export async function fetchProductionSnapshot(snapshotId: string): Promise<ProductionCalibrationSnapshot> {
  const response = await projectFetch(`${API_BASE}/api/production-calibration/snapshots/${encodeURIComponent(snapshotId)}`);
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Loading the snapshot failed");
  const record = object(payload, "snapshot");
  return {
    snapshot: snapshotSummary(record.snapshot),
    artifact: ProductionCalibrationArtifactSchema.parse(record.artifact)
  };
}

/** Owner-only: append a JSON Lines ledger to the project's stored records. */
export async function importProductionRecords(records: string): Promise<ProductionRecordImportResult> {
  const response = await projectFetch(`${API_BASE}/api/production-calibration/records`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ records })
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Importing the ledger failed");
  const record = object(payload, "import result");
  const inserted = object(record.inserted, "inserted counts");
  return {
    inserted: {
      decisions: count(inserted.decisions, "decisions"),
      actions: count(inserted.actions, "actions"),
      outcomes: count(inserted.outcomes, "outcomes")
    },
    duplicates: count(record.duplicates, "duplicates"),
    awaitingDecision: count(record.awaitingDecision, "awaitingDecision")
  };
}

function storedReportBody(input: ProductionCalibrationStoredReportInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.from) body.from = input.from;
  if (input.to) body.to = input.to;
  if (input.question !== undefined) body.question = input.question;
  if (input.threshold !== undefined) body.threshold = input.threshold;
  if (input.bins !== undefined) body.bins = input.bins;
  if (input.windowDays !== undefined) body.windowDays = input.windowDays;
  if (input.costs !== undefined) body.costs = input.costs;
  return body;
}

function snapshotSummary(raw: unknown): ProductionCalibrationSnapshotSummary {
  const value = object(raw, "snapshot summary");
  const window = object(value.window, "snapshot window");
  const bound = (entry: unknown, label: string) => entry === null ? null : text(entry, label);
  return {
    id: text(value.id, "snapshot id"),
    artifactDigest: digestText(value.artifactDigest, "artifactDigest"),
    window: { from: bound(window.from, "window.from"), to: bound(window.to, "window.to") },
    recordCount: count(value.recordCount, "recordCount"),
    recordSetDigest: digestText(value.recordSetDigest, "recordSetDigest"),
    builtAt: text(value.builtAt, "builtAt"),
    createdByUserId: text(value.createdByUserId, "createdByUserId"),
    createdAt: text(value.createdAt, "createdAt")
  };
}

function digestText(value: unknown, label: string): string {
  const digest = text(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`Invalid ${label}`);
  return digest;
}

/** The bundled sample ledger: a CI triage bot's decisions with human outcomes, digests only. */
export async function fetchProductionCalibrationSample(): Promise<string> {
  const response = await fetch(PRODUCTION_CALIBRATION_SAMPLE_PATH, { credentials: "same-origin" });
  if (!response.ok) {
    throw new ProductionCalibrationApiError(`Sample ledger request failed: ${response.status}`, response.status, null);
  }
  return await response.text();
}

function projectFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  try {
    const projectId = localStorage.getItem(PROJECT_KEY);
    if (projectId) headers.set("x-rubrist-project", projectId);
  } catch {
    // The authenticated server default remains available when storage is not.
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}

function apiError(response: Response, payload: unknown, fallback: string): ProductionCalibrationApiError {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const details = value.details && typeof value.details === "object" ? value.details as Record<string, unknown> : {};
  return new ProductionCalibrationApiError(
    typeof value.error === "string" && value.error ? value.error : `${fallback}: ${response.status}`,
    response.status,
    typeof value.code === "string" ? value.code : null,
    typeof details.line === "number" ? details.line : null
  );
}

function normalizeSummary(raw: unknown): ProductionCalibrationPreviewSummary {
  const value = object(raw, "production calibration summary");
  const records = object(value.records, "summary records");
  if (!Array.isArray(value.questions) || !Array.isArray(value.models) || !Array.isArray(value.questionSetDigests)) {
    throw new Error("Invalid production calibration summary");
  }
  return {
    records: {
      total: count(records.total, "total"),
      decisions: count(records.decisions, "decisions"),
      actions: count(records.actions, "actions"),
      outcomes: count(records.outcomes, "outcomes")
    },
    questions: value.questions.map((entry) => {
      const question = object(entry, "summary question");
      if (!Array.isArray(question.answerTypes)) throw new Error("Invalid summary question");
      return {
        question: text(question.question, "question"),
        answerTypes: question.answerTypes.map((type) => {
          if (type !== "boolean" && type !== "choice" && type !== "score") throw new Error("Invalid answer type");
          return type;
        }),
        decisions: count(question.decisions, "decisions"),
        outcomes: count(question.outcomes, "outcomes")
      };
    }),
    models: value.models.map((entry) => {
      const row = object(entry, "summary model");
      const model = object(row.model, "model identity");
      const identityStrength = model.identityStrength;
      if (identityStrength !== "observed_version" && identityStrength !== "unreported") throw new Error("Invalid model identity");
      return {
        model: {
          provider: text(model.provider, "provider"),
          observedModel: model.observedModel === null ? null : text(model.observedModel, "observedModel"),
          identityStrength
        },
        decisions: count(row.decisions, "decisions")
      };
    }),
    questionSetDigests: value.questionSetDigests.map((digest) => text(digest, "questionSetDigest")),
    question: value.question === null || value.question === undefined ? null : text(value.question, "question")
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}
