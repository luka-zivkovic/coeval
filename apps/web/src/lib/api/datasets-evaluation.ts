import {
  type CreateDatasetInput,
  type Dataset,
  type DatasetDetail,
  DatasetDetailSchema,
  type DatasetExampleInput,
  type DatasetRevision,
  type DatasetRevisionDetail,
  DatasetRevisionDetailSchema,
  type DatasetRevisionRole,
  DatasetRevisionSchema,
  DatasetSchema,
  type EvalRun,
  type EvalRunDetail,
  EvalRunDetailSchema,
  EvalRunSchema,
  type ImportDatasetExamplesResult,
  ImportDatasetExamplesResultSchema,
  type RunComparison,
  type RunComparisonDetail,
  RunComparisonDetailSchema,
  RunComparisonSchema,
  type SelfConsistencyReport,
  SelfConsistencyReportSchema
} from "@coeval/shared";
import {
  API_BASE,
  apiError,
  apiErrorFromResponse,
  apiFetch
} from "./transport.js";

// Datasets + eval runs (the category-core primitive). List/detail are
// member-readable; starting a run is owner-only server-side (it spends
// provider tokens) — surface the 403 rather than hiding the button.
export async function fetchDatasets(): Promise<Dataset[]> {
  const response = await apiFetch(`${API_BASE}/api/datasets`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Datasets request failed");
  const body = (await response.json()) as { datasets?: unknown };
  return DatasetSchema.array().parse(body.datasets ?? []);
}

export async function fetchDatasetDetail(datasetId: string): Promise<DatasetDetail | null> {
  const response = await apiFetch(`${API_BASE}/api/datasets/${datasetId}`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response, "Dataset detail request failed");
  return DatasetDetailSchema.parse(await response.json());
}

export async function fetchDatasetRevisions(datasetId: string): Promise<DatasetRevision[]> {
  const response = await apiFetch(`${API_BASE}/api/datasets/${datasetId}/revisions`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Dataset revisions request failed");
  const body = await response.json() as { revisions?: unknown };
  return DatasetRevisionSchema.array().parse(body.revisions ?? []);
}

export async function fetchDatasetRevision(revisionId: string): Promise<DatasetRevisionDetail | null> {
  const response = await apiFetch(`${API_BASE}/api/dataset-revisions/${revisionId}`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response, "Dataset revision request failed");
  const body = await response.json() as { revision?: unknown };
  return DatasetRevisionDetailSchema.parse(body.revision);
}

export async function fetchDatasetRevisionMetadata(revisionId: string): Promise<DatasetRevision | null> {
  const response = await apiFetch(`${API_BASE}/api/dataset-revisions/${revisionId}/metadata`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response, "Dataset revision metadata request failed");
  const body = await response.json() as { revision?: unknown };
  return DatasetRevisionSchema.parse(body.revision);
}

export async function createDatasetRevision(
  datasetId: string,
  role: Exclude<DatasetRevisionRole, "sealed_validation">
): Promise<DatasetRevisionDetail> {
  const response = await apiFetch(`${API_BASE}/api/datasets/${datasetId}/revisions`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role })
  });
  const body = await response.json().catch(() => null) as { revision?: unknown; error?: string } | null;
  if (response.ok && body?.revision) return DatasetRevisionDetailSchema.parse(body.revision);
  throw apiError(response, body, "Dataset revision creation failed");
}

export async function fetchEvalRuns(limit = 50): Promise<EvalRun[]> {
  const response = await apiFetch(`${API_BASE}/api/eval-runs?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Eval runs request failed");
  const body = (await response.json()) as { runs?: unknown };
  return EvalRunSchema.array().parse(body.runs ?? []);
}

export async function fetchEvalRunDetail(evalRunId: string): Promise<EvalRunDetail | null> {
  const response = await apiFetch(`${API_BASE}/api/eval-runs/${evalRunId}`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response, "Eval run detail request failed");
  return EvalRunDetailSchema.parse(await response.json());
}

export interface SkillVersionBackfillEnsureResult {
  run: EvalRunDetail | null;
  dispatchPending: boolean;
  retryAfterMs: number;
}

export async function ensureSkillVersionBackfill(
  skillId: string,
  skillVersionId: string
): Promise<SkillVersionBackfillEnsureResult> {
  const response = await apiFetch(
    `${API_BASE}/api/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(skillVersionId)}/backfill`,
    { method: "POST", credentials: "include" }
  );
  const payload = await response.json().catch(() => null) as {
    run?: unknown;
    existingResult?: boolean;
    error?: string;
  } | null;
  if (response.ok && payload?.run) {
    return { run: EvalRunDetailSchema.parse(payload.run), dispatchPending: false, retryAfterMs: 30_000 };
  }
  if (response.status === 503 && payload?.run) {
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    return {
      run: EvalRunDetailSchema.parse(payload.run),
      dispatchPending: true,
      retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 30_000
    };
  }
  if (response.ok && payload?.existingResult === true) {
    return { run: null, dispatchPending: false, retryAfterMs: 30_000 };
  }
  throw apiError(response, payload, "First Result evaluation could not start");
}

export async function createDataset(input: CreateDatasetInput): Promise<Dataset> {
  const response = await apiFetch(`${API_BASE}/api/datasets`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = await response.json().catch(() => null) as { dataset?: unknown; error?: string } | null;
  if (response.ok && body?.dataset) return DatasetSchema.parse(body.dataset);
  throw apiError(response, body, "Dataset creation failed");
}

// Skill Bench ingestion: paste examples as content. Mints (or content-dedups)
// manual cases and lands them in the dataset with expected labels. Never
// auto-judges — run an eval explicitly.
export async function importDatasetExamples(
  datasetId: string,
  items: DatasetExampleInput[]
): Promise<ImportDatasetExamplesResult> {
  const response = await apiFetch(`${API_BASE}/api/datasets/${datasetId}/examples`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items })
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Example import failed");
  return ImportDatasetExamplesResultSchema.parse(await response.json());
}

// Run comparisons (Incident Bisect): one dataset judged with two versions.
// Creation is owner-only server-side (it spends provider tokens twice);
// reads are member-open. Detail is the poll target — status stays "pending"
// until both runs are terminal.
export async function fetchRunComparisons(limit = 50): Promise<RunComparison[]> {
  const response = await apiFetch(`${API_BASE}/api/run-comparisons?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Run comparisons request failed");
  const body = (await response.json()) as { comparisons?: unknown };
  return RunComparisonSchema.array().parse(body.comparisons ?? []);
}

export async function fetchRunComparisonDetail(comparisonId: string): Promise<RunComparisonDetail | null> {
  const response = await apiFetch(`${API_BASE}/api/run-comparisons/${comparisonId}`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response, "Run comparison detail request failed");
  return RunComparisonDetailSchema.parse(await response.json());
}

export async function createRunComparison(input: {
  datasetId: string;
  versionAId: string;
  versionBId: string;
}): Promise<RunComparison> {
  const response = await apiFetch(`${API_BASE}/api/run-comparisons`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = await response.json().catch(() => null) as { comparison?: unknown; error?: string } | null;
  if (response.ok && body?.comparison) return RunComparisonSchema.parse(body.comparison);
  throw apiError(response, body, "Run comparison start failed");
}

export async function createEvalRun(datasetId: string, skillVersionId?: string): Promise<EvalRun> {
  const response = await apiFetch(`${API_BASE}/api/eval-runs`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ datasetId, ...(skillVersionId ? { skillVersionId } : {}) })
  });
  const body = await response.json().catch(() => null) as { run?: unknown; error?: string } | null;
  if (response.ok && body?.run) return EvalRunSchema.parse(body.run);
  throw apiError(response, body, "Eval run start failed");
}

export async function createDatasetRevisionEvalRun(revisionId: string, skillVersionId?: string): Promise<EvalRun> {
  const response = await apiFetch(`${API_BASE}/api/eval-runs`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ datasetRevisionId: revisionId, ...(skillVersionId ? { skillVersionId } : {}) })
  });
  const body = await response.json().catch(() => null) as { run?: unknown; error?: string } | null;
  if (response.ok && body?.run) return EvalRunSchema.parse(body.run);
  throw apiError(response, body, "Dataset revision eval start failed");
}

// judge self-consistency for one version — does the requested model give the
// same verdict when re-asked? Populated by forced re-judges (force: true) and
// repeat eval runs; empty until a case has 2+ runs under this version.
export async function fetchSkillVersionSelfConsistency(skillId: string, versionId: string): Promise<SelfConsistencyReport> {
  const response = await apiFetch(`${API_BASE}/api/skills/${skillId}/versions/${versionId}/self-consistency`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Self-consistency request failed");
  const body = (await response.json()) as { selfConsistency: unknown };
  return SelfConsistencyReportSchema.parse(body.selfConsistency);
}
