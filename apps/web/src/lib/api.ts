import {
  AssistTraceTestDraftInputSchema,
  AssistTraceTestDraftResultSchema,
  ApiKeySchema,
  AgentSetupPairingSchema,
  CreatedAgentSetupPairingSchema,
  CreatedApiKeySchema,
  ConvergenceAuditPageSchema,
  CriterionDetailSchema,
  CriterionSchema,
  CreateOnboardingCheckInputSchema,
  CreateOnboardingCheckResponseSchema,
  CreateTraceTestInputSchema,
  EnableTraceTestInputSchema,
  CreateSkillVersionInputSchema,
  DashboardSummarySchema,
  DeleteProjectInputSchema,
  ExceptionDetailSchema,
  FeedbackSyncJobListItemSchema,
  GoldenSetHealthSummarySchema,
  DisagreementSummarySchema,
  JudgeHumanDisagreementSummarySchema,
  KappaSummarySchema,
  ImportJobRecordSchema,
  LangfuseConnectionTestResultSchema,
  LangfuseImportEnqueueResultSchema,
  LangfuseImportRequestSchema,
  LangfuseIntegrationInputSchema,
  LangfuseIntegrationSchema,
  LangSmithConnectionTestResultSchema,
  LangSmithImportEnqueueResultSchema,
  LangSmithImportRequestSchema,
  DatasetDetailSchema,
  DatasetRevisionDetailSchema,
  DatasetRevisionSchema,
  DatasetSchema,
  EvalRunDetailSchema,
  EvalRunSchema,
  ImportDatasetExamplesResultSchema,
  LangSmithIntegrationInputSchema,
  LangSmithIntegrationSchema,
  ManualTraceImportResultSchema,
  RunComparisonDetailSchema,
  RunComparisonSchema,
  type RunComparison,
  type RunComparisonDetail,
  type CreateDatasetInput,
  type Dataset,
  type DatasetDetail,
  type DatasetRevision,
  type DatasetRevisionDetail,
  type DatasetRevisionRole,
  type DatasetExampleInput,
  type EvalRun,
  type EvalRunDetail,
  type ImportDatasetExamplesResult,
  type ProjectMode,
  PromoteGoldenSetInputSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  type Project,
  RegressionRunResultSchema,
  RetireGoldenSetEntryInputSchema,
  RecordManualTraceTestValidationInputSchema,
  SelfConsistencyReportSchema,
  SetupResponseSchema,
  type SelfConsistencyReport,
  RetentionPruneResultSchema,
  ReviseTraceTestInputSchema,
  RunTraceTestValidationInputSchema,
  StartTraceTestRunInputSchema,
  SkillSchema,
  ReviewQueueDetailSchema,
  ReviewQueueSchema,
  SkillVersionSchema,
  TraceTestDetailSchema,
  TraceTestFunnelEventInputSchema,
  TraceTestSummarySchema,
  TraceTestValidationSchema,
  TraceTestRunResultSchema,
  UpdateLangfuseIntegrationInputSchema,
  UpdateLangSmithIntegrationInputSchema,
  UpdateProjectSettingsInputSchema,
  VerdictRecordSchema,
  type ApiKey,
  type AssistTraceTestDraftInput,
  type AssistTraceTestDraftResult,
  type AgentSetupPairing,
  type CreatedAgentSetupPairing,
  type CreatedApiKey,
  type ConvergenceAuditPage,
  type Criterion,
  type CriterionDetail,
  type CreateOnboardingCheckInput,
  type CreateOnboardingCheckResponse,
  type CreateTraceTestInput,
  type EnableTraceTestInput,
  type CreateSkillVersionInput,
  type DashboardSummary,
  type ExceptionDetail,
  type FeedbackSyncJobListItem,
  type GoldenSetEntry,
  type GoldenSetHealthSummary,
  type DisagreementSummary,
  type JudgeHumanDisagreementSummary,
  type KappaSummary,
  type ImportJobRecord,
  type LangfuseConnectionTestResult,
  type LangfuseImportEnqueueResult,
  type LangfuseIntegrationInput,
  type LangfuseIntegration,
  type LangSmithConnectionTestResult,
  type LangSmithImportEnqueueResult,
  type LangSmithIntegrationInput,
  type LangSmithIntegration,
  type ManualTraceImportResult,
  type PromoteGoldenSetInput,
  type ProjectSettings,
  type RetireGoldenSetEntryInput,
  type RecordManualTraceTestValidationInput,
  type RegressionRunResult,
  type RetentionPruneResult,
  type ReviseTraceTestInput,
  type RunTraceTestValidationInput,
  type StartTraceTestRunInput,
  type SkillVersion,
  type Skill,
  type TraceTestDetail,
  type TraceTestFunnelEventInput,
  type TraceTestSummary,
  type TraceTestValidation,
  type TraceTestRunResult,
  type ReviewQueue,
  type ReviewQueueDetail,
  type UpdateLangfuseIntegrationInput,
  type UpdateLangSmithIntegrationInput,
  type UpdateProjectSettingsInput,
  type VerdictPayload,
  type VerdictRecord,
  type VerdictSource
} from "@coeval/shared";
import {
  JudgeCardSchema,
  JudgeModelCatalogSchema,
  JudgeProviderAvailabilitySchema,
  JudgeProviderKeySchema,
  SkillFormatV1Schema,
  TrustDigestSchema,
  type JudgeCard,
  type JudgeKeyProvider,
  type JudgeModelCatalog,
  type JudgeProviderAvailability,
  type JudgeProviderId,
  type JudgeProviderKey,
  type SkillFormatV1,
  type TrustDigest
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export function publicApiBaseUrl(): string {
  if (typeof window === "undefined") return API_BASE || "https://your-coeval.example";
  const resolved = API_BASE ? new URL(API_BASE, window.location.origin).toString() : window.location.origin;
  return resolved.replace(/\/$/, "");
}

// P0-2: project switching. The selected project pins every request via the
// x-coeval-project header; the server checks membership, not trust. No
// selection = the server's default (oldest membership).
const PROJECT_KEY = "coeval.project";

export function selectedProjectId(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

export function selectProject(projectId: string | null): void {
  try {
    if (projectId) localStorage.setItem(PROJECT_KEY, projectId);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    /* storage unavailable — fall back to server default */
  }
}

// Every API call goes through here so the project pin can't drift per-callsite.
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const projectId = selectedProjectId();
  const headers = new Headers(init?.headers);
  if (projectId) headers.set("x-coeval-project", projectId);
  return fetch(input, { ...init, headers, credentials: "include" });
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
  }
  return fallback;
}

function apiError(response: Response, payload: unknown, fallback: string): ApiError {
  return new ApiError(errorMessage(payload, `${fallback}: ${response.status}`), response.status, payload);
}

async function apiErrorFromResponse(response: Response, fallback: string): Promise<ApiError> {
  const payload = await response.json().catch(() => null) as unknown;
  return apiError(response, payload, fallback);
}

// P0-2: the project switcher's data. Works with zero memberships (returns []).
export async function fetchProjects(): Promise<Project[]> {
  const response = await apiFetch(`${API_BASE}/api/projects`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Projects request failed");
  const body = (await response.json()) as { projects: unknown[] };
  return body.projects.map((p) => ProjectSchema.parse(p));
}

// P0-2: create a project (the caller becomes its owner). The only mutation
// that must work after the last project was deleted. `mode: "bench"` creates
// a Skill Bench project — evidence from example datasets, no tracing infra.
export async function createProject(name: string, mode?: ProjectMode): Promise<{ projectId: string; apiKey: CreatedApiKey | null }> {
  const response = await apiFetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, ...(mode ? { mode } : {}) })
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Project creation failed");
  const body = await response.json().catch(() => null);
  if (typeof body?.projectId !== "string") throw new Error("Project creation response did not include a project id");
  // The project is already committed here. A malformed one-time key must not
  // encourage a duplicate project retry; Settings can mint a replacement.
  const apiKey = CreatedApiKeySchema.safeParse(body.apiKey);
  return { projectId: body.projectId, apiKey: apiKey.success ? apiKey.data : null };
}

function queryPath(path: string, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const serialized = query.toString();
  return `${path}${serialized ? `?${serialized}` : ""}`;
}

export async function fetchCriteria(): Promise<Criterion[]> {
  const response = await apiFetch(`${API_BASE}/api/v1/criteria`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Criteria request failed");
  const body = await response.json() as { criteria?: unknown };
  return CriterionSchema.array().parse(body.criteria ?? []);
}

export async function fetchCriterionDetail(criterionId: string): Promise<CriterionDetail> {
  const response = await apiFetch(`${API_BASE}/api/v1/criteria/${encodeURIComponent(criterionId)}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Criterion request failed");
  return CriterionDetailSchema.parse(await response.json());
}

export async function fetchDashboard(criterionId?: string): Promise<DashboardSummary> {
  const path = queryPath(`${API_BASE}/api/dashboard`, { criterionId });
  const response = await apiFetch(path, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Dashboard request failed");
  return DashboardSummarySchema.parse(await response.json());
}

export async function fetchCurrentSkill(criterionId?: string): Promise<Skill> {
  const path = criterionId
    ? `${API_BASE}/api/v1/criteria/${encodeURIComponent(criterionId)}/current-skill`
    : `${API_BASE}/api/skills/current`;
  const response = await apiFetch(path, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Skill request failed");
  const body = await response.json() as unknown;
  if (criterionId && body && typeof body === "object" && "skill" in body) {
    return SkillSchema.parse((body as { skill: unknown }).skill);
  }
  return SkillSchema.parse(body);
}

// The newest version regardless of status — the skill editor's seed. Keeps a
// gate-blocked draft editable after a reload instead of silently falling back
// to the older approved version.
export async function fetchLatestSkill(criterionId?: string): Promise<Skill> {
  const path = criterionId
    ? queryPath(`${API_BASE}/api/v1/criteria/${encodeURIComponent(criterionId)}/current-skill`, { scope: "latest" })
    : `${API_BASE}/api/skills/current?scope=latest`;
  const response = await apiFetch(path, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Skill request failed");
  const body = await response.json() as unknown;
  if (criterionId && body && typeof body === "object" && "skill" in body) {
    return SkillSchema.parse((body as { skill: unknown }).skill);
  }
  return SkillSchema.parse(body);
}

// P0-1 onboarding: approve the starter draft as-is, without re-judging.
// Exits the provisional journey stage. 409 when the version was already
// approved or edited (those go through the regression gate instead).
export async function signOffSkillVersion(skillId: string, versionId: string): Promise<SkillVersion> {
  const response = await apiFetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/signoff`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Rubric sign-off failed");
  const body = (await response.json()) as { version: unknown };
  return SkillVersionSchema.parse(body.version);
}

export async function fetchGoldenSet(criterionVersionId?: string): Promise<GoldenSetEntry[]> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/golden-set`, { criterionVersionId }), { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Golden set request failed");
  const body = (await response.json()) as { entries: GoldenSetEntry[] };
  return body.entries;
}

// the trust digest — four signals + drift nudges, current version.
export async function fetchTrustDigest(skillVersionId?: string): Promise<TrustDigest> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/trust-digest`, { skillVersionId }), { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Trust digest request failed");
  return TrustDigestSchema.parse(await response.json());
}

export async function fetchGoldenSetHealth(criterionVersionId?: string): Promise<GoldenSetHealthSummary> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/golden-set/health`, { criterionVersionId }), { credentials: "include" });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Golden set health request failed");
  try {
    return GoldenSetHealthSummarySchema.parse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Golden set health response was invalid";
    throw new ApiError(message, response.status, payload);
  }
}

export async function fetchKappaSummary(criterionVersionId?: string): Promise<KappaSummary> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/projects/kappa`, { criterionVersionId }), { credentials: "include" });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Kappa summary request failed");
  try {
    return KappaSummarySchema.parse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kappa summary response was invalid";
    throw new ApiError(message, response.status, payload);
  }
}

export async function fetchDisagreements(criterionVersionId?: string): Promise<DisagreementSummary> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/projects/disagreements`, { criterionVersionId }), { credentials: "include" });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Disagreements request failed");
  try {
    return DisagreementSummarySchema.parse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Disagreements response was invalid";
    throw new ApiError(message, response.status, payload);
  }
}

export async function fetchJudgeHumanDisagreements(criterionVersionId?: string): Promise<JudgeHumanDisagreementSummary> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/projects/judge-human-disagreements`, { criterionVersionId }), { credentials: "include" });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Judge-human disagreements request failed");
  try {
    return JudgeHumanDisagreementSummarySchema.parse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Judge-human disagreements response was invalid";
    throw new ApiError(message, response.status, payload);
  }
}

export async function fetchSkillVersions(skillId: string, limit = 50): Promise<SkillVersion[]> {
  return (await fetchSkillVersionHistory(skillId, limit)).versions;
}

export async function fetchSkillVersionHistory(skillId: string, limit = 50): Promise<{
  versions: SkillVersion[];
  regressionRuns: RegressionRunResult[];
}> {
  const response = await apiFetch(`${API_BASE}/api/skills/${skillId}/versions?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Skill versions request failed");
  const body = (await response.json()) as { versions?: unknown; regressionRuns?: unknown };
  return {
    versions: SkillVersionSchema.array().parse(body.versions ?? []),
    regressionRuns: RegressionRunResultSchema.array().parse(body.regressionRuns ?? [])
  };
}

// the regression run recorded for a specific version (incl. per-case
// diff). Returns null on 404 (no run recorded — e.g. the seeded baseline
// version or a version created before regression runs were persisted).
export async function fetchSkillVersionRegression(skillId: string, versionId: string): Promise<RegressionRunResult | null> {
  const response = await apiFetch(`${API_BASE}/api/skills/${skillId}/versions/${versionId}/regression`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response, "Regression run request failed");
  const body = (await response.json()) as { regressionRun?: unknown };
  return RegressionRunResultSchema.parse(body.regressionRun);
}

// Exact version-pinned summary plus one keyset page of the recorded legacy
// adjudication ledger. The summary never inherits the case-page bound.
export async function fetchSkillVersionConvergence(
  skillId: string,
  versionId: string,
  input: { limit?: number; cursor?: string } = {}
): Promise<ConvergenceAuditPage> {
  const response = await apiFetch(queryPath(
    `${API_BASE}/api/skills/${skillId}/versions/${versionId}/convergence`,
    { limit: input.limit?.toString(), cursor: input.cursor }
  ), { credentials: "include" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw apiError(response, payload, "Convergence audit request failed");
  return ConvergenceAuditPageSchema.parse(payload);
}

export async function runNextUncoveredConvergenceCase(
  skillId: string,
  versionId: string
): Promise<{ run: EvalRun; caseId: string }> {
  const response = await apiFetch(
    `${API_BASE}/api/skills/${skillId}/versions/${versionId}/convergence/runs`,
    { method: "POST", credentials: "include" }
  );
  const payload = await response.json().catch(() => null) as { run?: unknown; caseId?: unknown } | null;
  if (!response.ok) throw apiError(response, payload, "Current-version run failed");
  if (typeof payload?.caseId !== "string") throw new Error("Current-version run response omitted its case");
  return { run: EvalRunSchema.parse(payload.run), caseId: payload.caseId };
}

export async function fetchProjectVerdicts(opts?: {
  source?: VerdictSource;
  caseId?: string;
  criterionId?: string;
  skillVersionId?: string;
  evidenceScope?: "all" | "customer";
  limit?: number;
}): Promise<VerdictRecord[]> {
  const params = new URLSearchParams();
  if (opts?.source) params.set("source", opts.source);
  if (opts?.caseId) params.set("caseId", opts.caseId);
  if (opts?.criterionId) params.set("criterionId", opts.criterionId);
  if (opts?.skillVersionId) params.set("skillVersionId", opts.skillVersionId);
  if (opts?.evidenceScope) params.set("evidenceScope", opts.evidenceScope);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString();
  const response = await apiFetch(`${API_BASE}/api/projects/verdicts${suffix ? `?${suffix}` : ""}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Project verdicts request failed");
  const body = (await response.json()) as { verdicts?: unknown };
  return VerdictRecordSchema.array().parse(body.verdicts ?? []);
}

// Browser-side download trigger. The endpoint sets content-disposition:
// attachment so opening the URL in a new tab streams the file straight to
// disk — no client-side blob construction needed.
// the authoritative Judge Card. The panel renders from this JSON; the
// Markdown export/copy pull `/card?format=md` so what's shown == what's
// attested == what's exported.
export async function fetchJudgeCard(skillId: string, versionId: string): Promise<JudgeCard> {
  const response = await apiFetch(`${API_BASE}/api/skills/${skillId}/versions/${versionId}/card`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge Card request failed");
  return JudgeCardSchema.parse(await response.json());
}

export async function fetchJudgeCardMarkdown(skillId: string, versionId: string): Promise<string> {
  const response = await apiFetch(`${API_BASE}/api/skills/${skillId}/versions/${versionId}/card?format=md`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge Card markdown request failed");
  return response.text();
}


// portable SkillFormat v1 export (JSON). Project-scoped via apiFetch,
// same as the Judge Card export.
export async function fetchSkillFormat(skillId: string, versionId: string): Promise<SkillFormatV1> {
  const response = await apiFetch(`${API_BASE}/api/skills/${skillId}/versions/${versionId}/skill-format`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "SkillFormat export failed");
  return SkillFormatV1Schema.parse(await response.json());
}

export function buildVerdictExportUrl(opts?: {
  format?: "jsonl" | "csv";
  source?: VerdictSource;
  criterionId?: string;
  skillVersionId?: string;
}): string {
  const params = new URLSearchParams();
  params.set("format", opts?.format ?? "jsonl");
  if (opts?.source) params.set("source", opts.source);
  if (opts?.criterionId) params.set("criterionId", opts.criterionId);
  if (opts?.skillVersionId) params.set("skillVersionId", opts.skillVersionId);
  return `${API_BASE}/api/projects/verdicts/export?${params.toString()}`;
}

export async function fetchJudgeHumanCalibration(criterionVersionId?: string): Promise<KappaSummary> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/projects/judge-human-calibration`, { criterionVersionId }), { credentials: "include" });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "Judge-human calibration request failed");
  try {
    return KappaSummarySchema.parse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Judge-human calibration response was invalid";
    throw new ApiError(message, response.status, payload);
  }
}

export async function fetchSetupState(): Promise<{ setupRequired: boolean; authEnabled: boolean }> {
  const response = await apiFetch(`${API_BASE}/api/auth/setup-required`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Setup state request failed");
  return response.json();
}

export async function fetchProjectSettings(): Promise<ProjectSettings> {
  const response = await apiFetch(`${API_BASE}/api/project/settings`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Project settings request failed");
  return ProjectSettingsSchema.parse(await response.json());
}

export async function fetchLangSmithIntegrations(): Promise<LangSmithIntegration[]> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "LangSmith integrations request failed");
  const body = (await response.json()) as { integrations?: unknown };
  return LangSmithIntegrationSchema.array().parse(body.integrations ?? []);
}

export async function fetchLangfuseIntegrations(): Promise<LangfuseIntegration[]> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Langfuse integrations request failed");
  const body = (await response.json()) as { integrations?: unknown };
  return LangfuseIntegrationSchema.array().parse(body.integrations ?? []);
}

export async function fetchImportJobs(limit = 10): Promise<ImportJobRecord[]> {
  const response = await apiFetch(`${API_BASE}/api/import-jobs?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Import jobs request failed");
  const body = (await response.json()) as { importJobs?: unknown };
  return ImportJobRecordSchema.array().parse(body.importJobs ?? []);
}

export async function fetchFeedbackSyncs(limit = 10): Promise<FeedbackSyncJobListItem[]> {
  const response = await apiFetch(`${API_BASE}/api/feedback-syncs?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Feedback sync request failed");
  const body = (await response.json()) as { feedbackSyncs?: unknown };
  return FeedbackSyncJobListItemSchema.array().parse(body.feedbackSyncs ?? []);
}

export async function createLangSmithIntegration(input: LangSmithIntegrationInput): Promise<LangSmithIntegration> {
  const body = LangSmithIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangSmithIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangSmithIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "LangSmith integration create failed");
}

export async function updateLangSmithIntegration(integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration> {
  const body = UpdateLangSmithIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangSmithIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangSmithIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "LangSmith integration update failed");
}

export async function createLangfuseIntegration(input: LangfuseIntegrationInput): Promise<LangfuseIntegration> {
  const body = LangfuseIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangfuseIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangfuseIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "Langfuse integration create failed");
}

export async function updateLangfuseIntegration(integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration> {
  const body = UpdateLangfuseIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangfuseIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangfuseIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "Langfuse integration update failed");
}

// BYO judge provider keys. The raw key goes up once and never comes
// back — responses carry only the masked keyDisplay.
export async function fetchJudgeKeys(): Promise<JudgeProviderKey[]> {
  const response = await apiFetch(`${API_BASE}/api/judge-keys`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge keys request failed");
  const body = (await response.json()) as { keys: unknown };
  return JudgeProviderKeySchema.array().parse(body.keys ?? []);
}

export async function fetchJudgeProviders(): Promise<JudgeProviderAvailability> {
  const response = await apiFetch(`${API_BASE}/api/judge/providers`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge providers request failed");
  return JudgeProviderAvailabilitySchema.parse(await response.json());
}

export async function fetchJudgeModels(provider: JudgeProviderId): Promise<JudgeModelCatalog> {
  const response = await apiFetch(`${API_BASE}/api/judge/providers/${provider}/models`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge models request failed");
  return JudgeModelCatalogSchema.parse(await response.json());
}

export async function setJudgeKey(provider: JudgeKeyProvider, apiKey: string): Promise<JudgeProviderKey> {
  const response = await apiFetch(`${API_BASE}/api/judge-keys/${provider}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey })
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Saving the judge key failed");
  const body = (await response.json()) as { key: unknown };
  return JudgeProviderKeySchema.parse(body.key);
}

export async function deleteJudgeKey(provider: JudgeKeyProvider): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/judge-keys/${provider}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Removing the judge key failed");
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const response = await apiFetch(`${API_BASE}/api/api-keys`, { credentials: "include" });
  const payload = await response.json().catch(() => null) as { apiKeys?: unknown; error?: string } | null;
  if (response.ok && Array.isArray(payload?.apiKeys)) return payload.apiKeys.map((key) => ApiKeySchema.parse(key));
  throw apiError(response, payload, "Failed to load API keys");
}

export async function createApiKey(name: string): Promise<CreatedApiKey> {
  const response = await apiFetch(`${API_BASE}/api/api-keys`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (response.ok) return CreatedApiKeySchema.parse(payload);
  throw apiError(response, payload, "Failed to create API key");
}

export async function revokeApiKey(apiKeyId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/api-keys/${apiKeyId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Failed to revoke API key");
  }
}

export async function deleteLangSmithIntegration(integrationId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "LangSmith integration disconnect failed");
  }
}

export async function deleteLangfuseIntegration(integrationId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Langfuse integration disconnect failed");
  }
}

export async function testLangSmithIntegration(integrationId: string): Promise<LangSmithConnectionTestResult> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}/test`, {
    method: "POST",
    credentials: "include"
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (payload && typeof payload === "object" && "ok" in payload) {
    return LangSmithConnectionTestResultSchema.parse(payload);
  }
  if (!response.ok) {
    const errorPayload = payload as { error?: string } | null;
    throw apiError(response, errorPayload, "LangSmith connection test failed");
  }
  return LangSmithConnectionTestResultSchema.parse(payload);
}

export async function triggerLangSmithImport(
  integrationId: string,
  limit: number,
  skillVersionId?: string,
): Promise<LangSmithImportEnqueueResult> {
  const body = LangSmithImportRequestSchema.parse({ limit, skillVersionId });
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}/import`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | unknown;
  if (response.ok) return LangSmithImportEnqueueResultSchema.parse(payload);
  throw apiError(response, payload, "LangSmith import request failed");
}

export async function testLangfuseIntegration(integrationId: string): Promise<LangfuseConnectionTestResult> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}/test`, {
    method: "POST",
    credentials: "include"
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (payload && typeof payload === "object" && "ok" in payload) {
    return LangfuseConnectionTestResultSchema.parse(payload);
  }
  if (!response.ok) {
    const errorPayload = payload as { error?: string } | null;
    throw apiError(response, errorPayload, "Langfuse connection test failed");
  }
  return LangfuseConnectionTestResultSchema.parse(payload);
}

export async function triggerLangfuseImport(
  integrationId: string,
  limit: number,
  skillVersionId?: string,
): Promise<LangfuseImportEnqueueResult> {
  const body = LangfuseImportRequestSchema.parse({ limit, skillVersionId });
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}/import`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | unknown;
  if (response.ok) return LangfuseImportEnqueueResultSchema.parse(payload);
  throw apiError(response, payload, "Langfuse import request failed");
}

export async function updateProjectSettings(input: UpdateProjectSettingsInput): Promise<ProjectSettings> {
  const body = UpdateProjectSettingsInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/project/settings`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | ProjectSettings | null;
  if (response.ok) return ProjectSettingsSchema.parse(payload);
  throw apiError(response, payload, "Project settings update failed");
}

export async function pruneExpiredTraces(): Promise<RetentionPruneResult> {
  const response = await apiFetch(`${API_BASE}/api/project/retention/prune`, {
    method: "POST",
    credentials: "include"
  });
  const payload = await response.json().catch(() => null) as { error?: string } | RetentionPruneResult | null;
  if (response.ok) return RetentionPruneResultSchema.parse(payload);
  throw apiError(response, payload, "Retention prune failed");
}

export async function deleteProject(confirmProjectName: string): Promise<void> {
  const body = DeleteProjectInputSchema.parse({ confirmProjectName });
  const response = await apiFetch(`${API_BASE}/api/project`, {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Project deletion failed");
  }
}

export async function setupOwner(input: {
  email: string;
  password: string;
  name?: string;
  mode?: ProjectMode;
  projectName?: string;
}): Promise<{ projectId: string | null; apiKey: CreatedApiKey | null }> {
  const response = await apiFetch(`${API_BASE}/api/auth/setup`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Setup failed");
  const body = await response.json().catch(() => null);
  // A browser reused against a fresh local database can retain an old project
  // pin. Clear it before the next onboarding request (agent pairing) so the
  // server resolves the newly-created first project. This must run — and the
  // function must NOT throw if the successful response body is malformed: by
  // this point the owner account, workspace, and session cookie are committed
  // server-side, and every resubmit would correctly return 409.
  selectProject(null);
  const parsed = SetupResponseSchema.safeParse(body);
  if (!parsed.success) return { projectId: null, apiKey: null };
  return {
    projectId: parsed.data.projectId,
    apiKey: parsed.data.apiKey ?? null
  };
}

export async function createAgentSetupPairing(): Promise<CreatedAgentSetupPairing> {
  const response = await apiFetch(`${API_BASE}/api/agent-setup/pairings`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Agent connection creation failed");
  return CreatedAgentSetupPairingSchema.parse(await response.json());
}

export async function fetchAgentSetupPairing(pairingId: string): Promise<AgentSetupPairing> {
  const response = await apiFetch(`${API_BASE}/api/agent-setup/pairings/${encodeURIComponent(pairingId)}`, {
    credentials: "include"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Agent connection status failed");
  return AgentSetupPairingSchema.parse(await response.json());
}

export async function revokeAgentSetupPairing(pairingId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/agent-setup/pairings/${encodeURIComponent(pairingId)}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok && response.status !== 404) {
    throw await apiErrorFromResponse(response, "Agent connection revoke failed");
  }
}

export async function importTrace(input: {
  input: unknown;
  output: unknown;
  metadata?: Record<string, unknown>;
  sourceTraceId?: string;
  skillVersionId?: string;
}): Promise<ManualTraceImportResult> {
  const response = await apiFetch(`${API_BASE}/api/traces/manual`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Trace import failed");
  return ManualTraceImportResultSchema.parse(await response.json());
}

export interface SkillVersionBackfillSummary {
  timeScope: "new" | "existing" | "both";
  cases: number;
  enqueued: number;
  skipped: number;
}

export interface CompletedSkillVersionResult {
  version: SkillVersion;
  regressionRun: RegressionRunResult;
  blocked: boolean;
  backfill?: SkillVersionBackfillSummary;
}

export type CreateSkillVersionResult =
  | ({ state: "complete" } & CompletedSkillVersionResult)
  | { state: "queued"; version: SkillVersion };

export async function createSkillVersion(skillId: string, input: CreateSkillVersionInput): Promise<CreateSkillVersionResult> {
  const body = CreateSkillVersionInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/skills/${skillId}/versions`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as {
    version?: SkillVersion;
    regressionRun?: RegressionRunResult;
    backfill?: SkillVersionBackfillSummary;
    error?: string;
  } | null;
  if ((response.status === 201 || response.status === 409) && payload?.version && payload.regressionRun) {
    // Parse the complete current run contract before rendering its evidence.
    const regressionRun = RegressionRunResultSchema.parse(payload.regressionRun);
    return {
      state: "complete",
      version: payload.version,
      regressionRun,
      blocked: response.status === 409 || regressionRun.status === "blocked",
      ...(payload.backfill ? { backfill: payload.backfill } : {})
    };
  }
  // The immutable version already exists at 202. Return that durable receipt
  // immediately so the screen can name it, preserve it in the URL, and poll
  // visibly. Hiding this response behind a three-minute helper loop made the
  // save look frozen and made reloads lose the in-flight version identity.
  if (response.status === 202 && payload?.version) {
    return { state: "queued", version: SkillVersionSchema.parse(payload.version) };
  }
  throw apiError(response, payload, "Skill version request failed");
}

export async function createOnboardingCheck(
  skillId: string,
  input: CreateOnboardingCheckInput
): Promise<CreateOnboardingCheckResponse> {
  const body = CreateOnboardingCheckInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/skills/${encodeURIComponent(skillId)}/onboarding-check`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw apiError(response, payload, "First Check creation failed");
  return CreateOnboardingCheckResponseSchema.parse(payload);
}

// The canonical case-detail fetcher — resolves any judged case, exception or
// not, so links from the regression diff to a still-passing golden case don't
// 404 and the exceptions queue drills into the same endpoint.
export async function fetchCaseDetail(caseId: string, skillVersionId?: string): Promise<ExceptionDetail> {
  const response = await apiFetch(queryPath(`${API_BASE}/api/cases/${caseId}`, { skillVersionId }), { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Case detail request failed");
  return ExceptionDetailSchema.parse(await response.json());
}

export async function fetchTraceTests(sourceCaseId?: string): Promise<TraceTestSummary[]> {
  const suffix = sourceCaseId ? `?sourceCaseId=${encodeURIComponent(sourceCaseId)}` : "";
  const response = await apiFetch(`${API_BASE}/api/trace-tests${suffix}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Tests request failed");
  const body = await response.json() as { tests?: unknown };
  return TraceTestSummarySchema.array().parse(body.tests ?? []);
}

export async function fetchTraceTest(traceTestId: string): Promise<TraceTestDetail> {
  const response = await apiFetch(`${API_BASE}/api/trace-tests/${encodeURIComponent(traceTestId)}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Test request failed");
  const body = await response.json() as { test?: unknown };
  return TraceTestDetailSchema.parse(body.test);
}

export async function assistTraceTestDraft(input: AssistTraceTestDraftInput, signal?: AbortSignal): Promise<AssistTraceTestDraftResult> {
  const body = AssistTraceTestDraftInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests/assist`, {
    method: "POST",
    credentials: "include",
    ...(signal ? { signal } : {}),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Automatic drafting request failed");
  return AssistTraceTestDraftResultSchema.parse(await response.json());
}

export async function createTraceTest(input: CreateTraceTestInput): Promise<TraceTestDetail> {
  const body = CreateTraceTestInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { test?: unknown; error?: string } | null;
  if (response.ok && payload?.test) return TraceTestDetailSchema.parse(payload.test);
  throw apiError(response, payload, "Test draft creation failed");
}

export async function reviseTraceTest(traceTestId: string, input: ReviseTraceTestInput): Promise<TraceTestDetail> {
  const body = ReviseTraceTestInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests/${encodeURIComponent(traceTestId)}/revisions`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { test?: unknown; error?: string } | null;
  if (response.ok && payload?.test) return TraceTestDetailSchema.parse(payload.test);
  throw apiError(response, payload, "Test draft update failed");
}

export async function runTraceTestValidation(traceTestId: string, input: RunTraceTestValidationInput): Promise<TraceTestValidation> {
  const body = RunTraceTestValidationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests/${encodeURIComponent(traceTestId)}/checks`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { validation?: unknown; error?: string } | null;
  if (response.ok && payload?.validation) return TraceTestValidationSchema.parse(payload.validation);
  throw apiError(response, payload, "Test check failed");
}

export async function recordManualTraceTestValidation(
  traceTestId: string,
  input: RecordManualTraceTestValidationInput
): Promise<TraceTestValidation> {
  const body = RecordManualTraceTestValidationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests/${encodeURIComponent(traceTestId)}/validations`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { validation?: unknown; error?: string } | null;
  if (response.ok && payload?.validation) return TraceTestValidationSchema.parse(payload.validation);
  throw apiError(response, payload, "Manual test check failed");
}

export async function enableTraceTest(traceTestId: string, input: EnableTraceTestInput): Promise<TraceTestDetail> {
  const body = EnableTraceTestInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests/${encodeURIComponent(traceTestId)}/enable`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { test?: unknown; error?: string } | null;
  if (response.ok && payload?.test) return TraceTestDetailSchema.parse(payload.test);
  throw apiError(response, payload, "Test enable failed");
}

export async function startTraceTestRun(
  traceTestId: string,
  input: StartTraceTestRunInput = {}
): Promise<TraceTestRunResult> {
  const body = StartTraceTestRunInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests/${encodeURIComponent(traceTestId)}/runs`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (response.ok) return TraceTestRunResultSchema.parse(payload);
  throw apiError(response, payload, "Test run failed to start");
}

export async function recordTraceTestFunnelEvent(input: TraceTestFunnelEventInput): Promise<void> {
  const body = TraceTestFunnelEventInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/trace-tests/funnel-events`, {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Trace-to-test metrics request failed");
}

export async function promoteExceptionToGoldenSet(caseId: string, input: PromoteGoldenSetInput): Promise<GoldenSetEntry> {
  const body = PromoteGoldenSetInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/cases/${caseId}/promote`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { entry?: GoldenSetEntry; error?: string } | null;
  if (response.ok && payload?.entry) return payload.entry;
  throw apiError(response, payload, "Golden-set promotion failed");
}

export async function retireGoldenSetEntry(entryId: string, input: RetireGoldenSetEntryInput = {}): Promise<void> {
  const body = RetireGoldenSetEntryInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/golden-set/${entryId}/retire`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Golden-set retirement failed");
  }
}


export async function recordHumanVerdict(
  caseId: string,
  payload: VerdictPayload,
  skillVersionId?: string,
): Promise<VerdictRecord> {
  const response = await apiFetch(`${API_BASE}/api/cases/${caseId}/verdicts`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, ...(skillVersionId ? { skillVersionId } : {}) })
  });
  const body = await response.json().catch(() => null) as { verdict?: unknown; error?: string } | null;
  if (response.ok && body?.verdict) return VerdictRecordSchema.parse(body.verdict);
  throw apiError(response, body, "Verdict recording failed");
}

// Record the legacy adjudication that closes an ungoverned disagreement.
// Owner-gated in real mode (403 for non-owners). Discrete payload only — the
// API rejects scalar with a 400.
export async function adjudicateCase(
  caseId: string,
  payload: VerdictPayload,
  skillVersionId?: string,
): Promise<VerdictRecord> {
  const response = await apiFetch(`${API_BASE}/api/cases/${caseId}/adjudicate`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, ...(skillVersionId ? { skillVersionId } : {}) })
  });
  const body = await response.json().catch(() => null) as { verdict?: unknown; error?: string } | null;
  if (response.ok && body?.verdict) return VerdictRecordSchema.parse(body.verdict);
  throw apiError(response, body, "Adjudication failed");
}

export async function fetchCaseVerdicts(
  caseId: string,
  opts?: { source?: VerdictSource; skillVersionId?: string; limit?: number },
): Promise<VerdictRecord[]> {
  const params = new URLSearchParams();
  if (opts?.source) params.set("source", opts.source);
  if (opts?.skillVersionId) params.set("skillVersionId", opts.skillVersionId);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const suffix = params.toString();
  const response = await apiFetch(`${API_BASE}/api/cases/${caseId}/verdicts${suffix ? `?${suffix}` : ""}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Case verdicts request failed");
  const body = (await response.json()) as { verdicts?: unknown };
  return VerdictRecordSchema.array().parse(body.verdicts ?? []);
}

export async function fetchReviewQueues(): Promise<ReviewQueue[]> {
  const response = await apiFetch(`${API_BASE}/api/review-queues`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Review queues request failed");
  const body = (await response.json()) as { queues?: unknown };
  return ReviewQueueSchema.array().parse(body.queues ?? []);
}

export async function fetchReviewQueueDetail(queueId: string): Promise<ReviewQueueDetail | null> {
  const response = await apiFetch(`${API_BASE}/api/review-queues/${queueId}`, { credentials: "include" });
  if (response.status === 404) return null;
  if (!response.ok) throw await apiErrorFromResponse(response, "Review queue detail request failed");
  return ReviewQueueDetailSchema.parse(await response.json());
}

export async function createReviewQueue(input: {
  name: string;
  description?: string;
  caseIds: string[];
  criterionVersionId?: string;
}): Promise<ReviewQueue> {
  const response = await apiFetch(`${API_BASE}/api/review-queues`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = await response.json().catch(() => null) as { queue?: unknown; error?: string } | null;
  if (response.ok && body?.queue) return ReviewQueueSchema.parse(body.queue);
  throw apiError(response, body, "Review queue create failed");
}

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
