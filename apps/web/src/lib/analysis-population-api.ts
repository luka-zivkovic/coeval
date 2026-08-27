import {
  AnalysisPopulationCreateInputSchema,
  AnalysisPopulationCreateResultSchema,
  AnalysisPopulationDetailSchema,
  AnalysisPopulationExclusionsPageSchema,
  AnalysisPopulationMembersPageSchema,
  AnalysisPopulationOverlapsPageSchema,
  AnalysisPopulationSelectedItemsPageSchema,
  AnalysisPopulationSummariesPageSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisPopulationCreateInput,
  type AnalysisPopulationCreateResult,
  type AnalysisPopulationDetail,
  type AnalysisPopulationExclusionsPage,
  type AnalysisPopulationMembersPage,
  type AnalysisPopulationOverlapsPage,
  type AnalysisPopulationSelectedItemsPage,
  type AnalysisPopulationSummariesPage,
  type DatasetRevisionPayloadSnapshot
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "coeval.project";

export interface AnalysisPopulationSelectedContent {
  populationId: string;
  datasetRevisionId: string;
  memberId: string;
  revisionItemId: string;
  caseId: string;
  drawPosition: number;
  inputDigest: string;
  itemDigest: string;
  payloadSnapshot: DatasetRevisionPayloadSnapshot;
}

export class AnalysisPopulationApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "AnalysisPopulationApiError";
  }
}

export async function createAnalysisPopulation(
  rawInput: AnalysisPopulationCreateInput
): Promise<AnalysisPopulationCreateResult> {
  const input = AnalysisPopulationCreateInputSchema.parse(rawInput);
  const response = await projectFetch(`${API_BASE}/api/analysis-populations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await responseError(response, "Analysis population creation failed");
  const body = await response.json() as { result?: unknown };
  return AnalysisPopulationCreateResultSchema.parse(body.result);
}

export async function fetchAnalysisPopulations(input: {
  limit?: number;
  cursor?: string | null;
} = {}): Promise<AnalysisPopulationSummariesPage> {
  return fetchPage("", input, AnalysisPopulationSummariesPageSchema, "Analysis population list failed");
}

export async function fetchAnalysisPopulation(populationId: string): Promise<AnalysisPopulationDetail> {
  const response = await projectFetch(`${base(populationId)}`);
  if (!response.ok) throw await responseError(response, "Analysis population detail failed");
  const body = await response.json() as { detail?: unknown };
  return AnalysisPopulationDetailSchema.parse(body.detail);
}

export function fetchAnalysisPopulationMembers(
  populationId: string,
  input: { limit?: number; cursor?: string | null } = {}
): Promise<AnalysisPopulationMembersPage> {
  return fetchPage(`/${encodeURIComponent(populationId)}/members`, input, AnalysisPopulationMembersPageSchema, "Analysis member list failed");
}

export function fetchAnalysisPopulationSelections(
  populationId: string,
  input: { limit?: number; cursor?: string | null } = {}
): Promise<AnalysisPopulationSelectedItemsPage> {
  return fetchPage(`/${encodeURIComponent(populationId)}/selections`, input, AnalysisPopulationSelectedItemsPageSchema, "Analysis draw selection list failed");
}

export function fetchAnalysisPopulationExclusions(
  populationId: string,
  input: { limit?: number; cursor?: string | null } = {}
): Promise<AnalysisPopulationExclusionsPage> {
  return fetchPage(`/${encodeURIComponent(populationId)}/exclusions`, input, AnalysisPopulationExclusionsPageSchema, "Analysis exclusion list failed");
}

export function fetchAnalysisPopulationOverlaps(
  populationId: string,
  input: { limit?: number; cursor?: string | null } = {}
): Promise<AnalysisPopulationOverlapsPage> {
  return fetchPage(`/${encodeURIComponent(populationId)}/overlaps`, input, AnalysisPopulationOverlapsPageSchema, "Analysis overlap list failed");
}

export async function fetchAnalysisPopulationSelectedContent(
  populationId: string,
  drawPosition: number
): Promise<AnalysisPopulationSelectedContent> {
  const response = await projectFetch(
    `${base(populationId)}/selections/${drawPosition}/content`
  );
  if (!response.ok) throw await responseError(response, "Analysis selected content failed");
  const body = await response.json() as { content?: unknown };
  return parseSelectedContent(body.content);
}

async function fetchPage<T>(
  suffix: string,
  input: { limit?: number; cursor?: string | null },
  schema: { parse(value: unknown): T },
  fallback: string
): Promise<T> {
  const query = new URLSearchParams();
  query.set("limit", String(input.limit ?? 50));
  if (input.cursor) query.set("cursor", input.cursor);
  const response = await projectFetch(`${API_BASE}/api/analysis-populations${suffix}?${query}`);
  if (!response.ok) throw await responseError(response, fallback);
  const body = await response.json() as { page?: unknown };
  return schema.parse(body.page);
}

function base(populationId: string): string {
  return `${API_BASE}/api/analysis-populations/${encodeURIComponent(populationId)}`;
}

function projectFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  try {
    const projectId = localStorage.getItem(PROJECT_KEY);
    if (projectId) headers.set("x-coeval-project", projectId);
  } catch {
    // The authenticated server default remains authoritative when storage is unavailable.
  }
  return fetch(url, { ...init, headers, credentials: "include" });
}

async function responseError(response: Response, fallback: string): Promise<AnalysisPopulationApiError> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  return new AnalysisPopulationApiError(
    typeof body?.error === "string" ? body.error : `${fallback}: ${response.status}`,
    response.status,
    typeof body?.code === "string" ? body.code : null
  );
}

function parseSelectedContent(value: unknown): AnalysisPopulationSelectedContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Analysis selected content response is invalid");
  }
  const row = value as Record<string, unknown>;
  const stringFields = [
    "populationId", "datasetRevisionId", "memberId", "revisionItemId", "caseId",
    "inputDigest", "itemDigest"
  ] as const;
  for (const field of stringFields) {
    if (typeof row[field] !== "string" || row[field].length === 0) {
      throw new Error(`Analysis selected content omitted ${field}`);
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(row.inputDigest)) || !/^sha256:[0-9a-f]{64}$/.test(String(row.itemDigest))) {
    throw new Error("Analysis selected content digest is invalid");
  }
  if (!Number.isSafeInteger(row.drawPosition) || Number(row.drawPosition) < 0) {
    throw new Error("Analysis selected content position is invalid");
  }
  return {
    populationId: String(row.populationId),
    datasetRevisionId: String(row.datasetRevisionId),
    memberId: String(row.memberId),
    revisionItemId: String(row.revisionItemId),
    caseId: String(row.caseId),
    drawPosition: Number(row.drawPosition),
    inputDigest: String(row.inputDigest),
    itemDigest: String(row.itemDigest),
    payloadSnapshot: DatasetRevisionPayloadSnapshotSchema.parse(row.payloadSnapshot)
  };
}
