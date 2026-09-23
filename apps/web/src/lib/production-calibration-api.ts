import {
  ProductionCalibrationArtifactSchema,
  type ProductionCalibrationArtifact,
  type ProductionCalibrationModelIdentity
} from "@rubrist/shared";

// Compute-only client for POST /api/production-calibration/preview. The ledger
// travels with each request and nothing is stored server-side, so every
// recomputation (a new threshold, new costs) is a fresh preview.

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
