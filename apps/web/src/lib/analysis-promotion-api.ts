import {
  AnalysisCriterionPromotionCandidatesPageSchema,
  AnalysisCriterionPromotionCreateInputSchema,
  AnalysisCriterionPromotionCreateResultSchema,
  AnalysisCriterionPromotionSummariesPageSchema,
  AnalysisCriterionPromotionSupportsPageSchema,
  type AnalysisCriterionPromotionCandidatesPage,
  type AnalysisCriterionPromotionCreateInput,
  type AnalysisCriterionPromotionCreateResult,
  type AnalysisCriterionPromotionSummariesPage,
  type AnalysisCriterionPromotionSupportsPage
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "coeval.project";

export class AnalysisPromotionApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "AnalysisPromotionApiError";
  }
}

export function createAnalysisPromotion(
  input: AnalysisCriterionPromotionCreateInput
): Promise<AnalysisCriterionPromotionCreateResult> {
  return postResult(AnalysisCriterionPromotionCreateInputSchema.parse(input));
}

export async function fetchAnalysisPromotionCandidates(input: {
  studyId: string;
  taxonomyRevisionId: string;
  codeId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<AnalysisCriterionPromotionCandidatesPage> {
  const query = new URLSearchParams({
    studyId: input.studyId,
    taxonomyRevisionId: input.taxonomyRevisionId,
    codeId: input.codeId,
    limit: String(input.limit ?? 100)
  });
  if (input.cursor) query.set("cursor", input.cursor);
  return getPage(`/api/analysis-promotions/candidates?${query}`, AnalysisCriterionPromotionCandidatesPageSchema);
}

export async function fetchAnalysisPromotions(input: {
  studyId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<AnalysisCriterionPromotionSummariesPage> {
  const query = new URLSearchParams({ studyId: input.studyId, limit: String(input.limit ?? 50) });
  if (input.cursor) query.set("cursor", input.cursor);
  return getPage(`/api/analysis-promotions?${query}`, AnalysisCriterionPromotionSummariesPageSchema);
}

export async function fetchAnalysisPromotionSupports(
  promotionId: string,
  input: { limit?: number; cursor?: string | null } = {}
): Promise<AnalysisCriterionPromotionSupportsPage> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 100) });
  if (input.cursor) query.set("cursor", input.cursor);
  return getPage(
    `/api/analysis-promotions/${encodeURIComponent(promotionId)}/supports?${query}`,
    AnalysisCriterionPromotionSupportsPageSchema
  );
}

async function postResult(
  input: AnalysisCriterionPromotionCreateInput
): Promise<AnalysisCriterionPromotionCreateResult> {
  const response = await projectFetch(`${API_BASE}/api/analysis-promotions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await responseError(response, "Analysis criterion promotion failed");
  const body = await response.json() as { result?: unknown };
  return AnalysisCriterionPromotionCreateResultSchema.parse(body.result);
}

async function getPage<T>(
  path: string,
  schema: { parse(value: unknown): T }
): Promise<T> {
  const response = await projectFetch(`${API_BASE}${path}`);
  if (!response.ok) throw await responseError(response, "Analysis promotion request failed");
  const body = await response.json() as { page?: unknown };
  return schema.parse(body.page);
}

function projectFetch(path: string, init?: RequestInit): Promise<Response> {
  const projectId = window.localStorage.getItem(PROJECT_KEY);
  return fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.headers ?? {}),
      ...(projectId ? { "x-coeval-project": projectId } : {})
    }
  });
}

async function responseError(response: Response, fallback: string): Promise<AnalysisPromotionApiError> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  return new AnalysisPromotionApiError(
    typeof body?.error === "string" ? body.error : fallback,
    response.status,
    typeof body?.code === "string" ? body.code : null
  );
}
