import {
  type ConvergenceAuditPage,
  ConvergenceAuditPageSchema,
  type CreatedApiKey,
  CreatedApiKeySchema,
  type CreateOnboardingCheckInput,
  CreateOnboardingCheckInputSchema,
  type CreateOnboardingCheckResponse,
  CreateOnboardingCheckResponseSchema,
  type CreateSkillVersionInput,
  CreateSkillVersionInputSchema,
  type Criterion,
  type CriterionDetail,
  CriterionDetailSchema,
  CriterionSchema,
  type CriterionVersion,
  CriterionVersionSchema,
  type DashboardSummary,
  DashboardSummarySchema,
  type DisagreementSummary,
  DisagreementSummarySchema,
  type EvalRun,
  EvalRunSchema,
  type GoldenSetEntry,
  type GoldenSetHealthSummary,
  GoldenSetHealthSummarySchema,
  type JudgeCard,
  JudgeCardSchema,
  type JudgeHumanDisagreementSummary,
  JudgeHumanDisagreementSummarySchema,
  type KappaSummary,
  KappaSummarySchema,
  type ManualTraceImportResult,
  ManualTraceImportResultSchema,
  type OnboardingEvidenceInventory,
  OnboardingEvidenceInventorySchema,
  type Project,
  type ProjectMode,
  ProjectSchema,
  type RegressionRunResult,
  RegressionRunResultSchema,
  type Skill,
  type SkillFormatV1,
  SkillFormatV1Schema,
  SkillSchema,
  type SkillVersion,
  SkillVersionSchema,
  type TrustDigest,
  TrustDigestSchema,
  type VerdictRecord,
  VerdictRecordSchema,
  type VerdictSource
} from "@coeval/shared";
import {
  API_BASE,
  ApiError,
  apiError,
  apiErrorFromResponse,
  apiFetch,
  queryPath
} from "./transport.js";

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

export async function fetchOnboardingEvidenceInventory(): Promise<OnboardingEvidenceInventory> {
  const response = await apiFetch(`${API_BASE}/api/onboarding/evidence-inventory`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Run field inventory request failed");
  return OnboardingEvidenceInventorySchema.parse(await response.json());
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

export async function fetchSkillVersionCriterion(
  skillId: string,
  skillVersionId: string
): Promise<CriterionVersion> {
  const response = await apiFetch(
    `${API_BASE}/api/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(skillVersionId)}/criterion`,
    { credentials: "include" }
  );
  if (!response.ok) throw await apiErrorFromResponse(response, "Check quality question request failed");
  const payload = await response.json() as { criterionVersion?: unknown };
  return CriterionVersionSchema.parse(payload.criterionVersion);
}
