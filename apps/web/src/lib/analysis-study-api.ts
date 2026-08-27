import {
  AnalysisFailureTaxonomyCreateInputSchema,
  AnalysisObservationAssignmentEventInputSchema,
  AnalysisObservationAssignmentEventResultSchema,
  AnalysisObservationAssignmentsPageSchema,
  AnalysisStudyAbandonInputSchema,
  AnalysisStudyCloseInputSchema,
  AnalysisStudyCompleteInputSchema,
  AnalysisStudyCreateInputSchema,
  AnalysisStudyCreateResultSchema,
  AnalysisStudyDetailSchema,
  AnalysisStudyEventResultSchema,
  AnalysisStudyItemEventInputSchema,
  AnalysisStudyItemEventResultSchema,
  AnalysisStudyItemEventsPageSchema,
  AnalysisStudyItemsPageSchema,
  AnalysisStudyOpenInputSchema,
  AnalysisStudySummariesPageSchema,
  AnalysisTaxonomyCoverageSchema,
  AnalysisTaxonomyDetailSchema,
  AnalysisTaxonomyRevisionCreateInputSchema,
  AnalysisTaxonomyRevisionProjectionSchema,
  AnalysisTaxonomyRevisionResultSchema,
  AnalysisTaxonomyRevisionsPageSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisFailureTaxonomyCreateInput,
  type AnalysisObservationAssignmentEventInput,
  type AnalysisObservationAssignmentEventResult,
  type AnalysisObservationAssignmentsPage,
  type AnalysisStudyAbandonInput,
  type AnalysisStudyCloseInput,
  type AnalysisStudyCompleteInput,
  type AnalysisStudyCreateInput,
  type AnalysisStudyCreateResult,
  type AnalysisStudyDetail,
  type AnalysisStudyEventResult,
  type AnalysisStudyItemEventInput,
  type AnalysisStudyItemEventResult,
  type AnalysisStudyItemEventsPage,
  type AnalysisStudyItemsPage,
  type AnalysisStudyOpenInput,
  type AnalysisStudySummariesPage,
  type AnalysisTaxonomyCoverage,
  type AnalysisTaxonomyDetail,
  type AnalysisTaxonomyRevisionCreateInput,
  type AnalysisTaxonomyRevisionProjection,
  type AnalysisTaxonomyRevisionResult,
  type AnalysisTaxonomyRevisionsPage,
  type DatasetRevisionPayloadSnapshot
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "coeval.project";

export interface AnalysisStudyItemContent {
  projectId: string;
  studyId: string;
  populationId: string;
  drawId: string;
  datasetRevisionId: string;
  studyItemId: string;
  drawItemId: string;
  memberId: string;
  revisionItemId: string;
  caseId: string;
  position: number;
  inputDigest: string;
  itemDigest: string;
  viewEventId: string;
  datasetExposureEventId: string;
  payloadSnapshot: DatasetRevisionPayloadSnapshot;
}

export class AnalysisStudyApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "AnalysisStudyApiError";
  }
}

export function createAnalysisStudy(input: AnalysisStudyCreateInput): Promise<AnalysisStudyCreateResult> {
  return postResult("/api/analysis-studies", AnalysisStudyCreateInputSchema.parse(input), AnalysisStudyCreateResultSchema);
}

export async function fetchAnalysisStudies(input: PageInput = {}): Promise<AnalysisStudySummariesPage & { projectRole: "owner" | "member" }> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor) query.set("cursor", input.cursor);
  const response = await projectFetch(`${API_BASE}/api/analysis-studies?${query}`);
  if (!response.ok) throw await responseError(response, "Governed analysis study list failed");
  const body = await response.json() as { page?: unknown; projectRole?: unknown };
  if (body.projectRole !== "owner" && body.projectRole !== "member") {
    throw new Error("Analysis study list omitted the exact project role");
  }
  return { ...AnalysisStudySummariesPageSchema.parse(body.page), projectRole: body.projectRole };
}

export async function fetchAnalysisStudy(studyId: string): Promise<AnalysisStudyDetail> {
  return getField(`/api/analysis-studies/${encodeURIComponent(studyId)}`, "detail", AnalysisStudyDetailSchema);
}

export function openAnalysisStudy(studyId: string, input: AnalysisStudyOpenInput): Promise<AnalysisStudyEventResult> {
  return postResult(`/api/analysis-studies/${encodeURIComponent(studyId)}/open`, AnalysisStudyOpenInputSchema.parse(input), AnalysisStudyEventResultSchema);
}

export function closeAnalysisStudy(studyId: string, input: AnalysisStudyCloseInput): Promise<AnalysisStudyEventResult> {
  return postResult(`/api/analysis-studies/${encodeURIComponent(studyId)}/close`, AnalysisStudyCloseInputSchema.parse(input), AnalysisStudyEventResultSchema);
}

export function completeAnalysisStudy(studyId: string, input: AnalysisStudyCompleteInput): Promise<AnalysisStudyEventResult> {
  return postResult(`/api/analysis-studies/${encodeURIComponent(studyId)}/complete`, AnalysisStudyCompleteInputSchema.parse(input), AnalysisStudyEventResultSchema);
}

export function abandonAnalysisStudy(studyId: string, input: AnalysisStudyAbandonInput): Promise<AnalysisStudyEventResult> {
  return postResult(`/api/analysis-studies/${encodeURIComponent(studyId)}/abandon`, AnalysisStudyAbandonInputSchema.parse(input), AnalysisStudyEventResultSchema);
}

export function fetchAnalysisStudyItems(studyId: string, input: PageInput = {}): Promise<AnalysisStudyItemsPage> {
  return getPage(`/api/analysis-studies/${encodeURIComponent(studyId)}/items`, input, AnalysisStudyItemsPageSchema);
}

export function fetchAnalysisStudyItemEvents(
  studyId: string,
  studyItemId: string,
  input: PageInput = {}
): Promise<AnalysisStudyItemEventsPage> {
  return getPage(`${itemBase(studyId, studyItemId)}/events`, input, AnalysisStudyItemEventsPageSchema);
}

export function appendAnalysisStudyItemEvent(
  studyId: string,
  studyItemId: string,
  input: AnalysisStudyItemEventInput
): Promise<AnalysisStudyItemEventResult> {
  return postResult(`${itemBase(studyId, studyItemId)}/events`, AnalysisStudyItemEventInputSchema.parse(input), AnalysisStudyItemEventResultSchema);
}

export async function fetchAnalysisStudyItemContent(
  studyId: string,
  studyItemId: string
): Promise<AnalysisStudyItemContent> {
  const response = await projectFetch(`${API_BASE}${itemBase(studyId, studyItemId)}/content`);
  if (!response.ok) throw await responseError(response, "Analysis study content failed");
  const body = await response.json() as { content?: unknown };
  return parseItemContent(body.content);
}

export async function fetchAnalysisStudyCoverage(
  studyId: string,
  taxonomyRevisionId: string
): Promise<AnalysisTaxonomyCoverage> {
  const query = new URLSearchParams({ taxonomyRevisionId });
  return getField(`/api/analysis-studies/${encodeURIComponent(studyId)}/coverage?${query}`, "coverage", AnalysisTaxonomyCoverageSchema);
}

export function createAnalysisTaxonomy(
  input: AnalysisFailureTaxonomyCreateInput
): Promise<AnalysisTaxonomyRevisionResult> {
  return postResult("/api/analysis-taxonomies", AnalysisFailureTaxonomyCreateInputSchema.parse(input), AnalysisTaxonomyRevisionResultSchema);
}

export function fetchAnalysisTaxonomy(): Promise<AnalysisTaxonomyDetail> {
  return getField("/api/analysis-taxonomies", "detail", AnalysisTaxonomyDetailSchema);
}

export function fetchAnalysisTaxonomyRevisions(
  taxonomyId: string,
  input: PageInput = {}
): Promise<AnalysisTaxonomyRevisionsPage> {
  return getPage(`/api/analysis-taxonomies/${encodeURIComponent(taxonomyId)}/revisions`, input, AnalysisTaxonomyRevisionsPageSchema);
}

export function fetchAnalysisTaxonomyRevision(
  taxonomyId: string,
  revisionId: string
): Promise<AnalysisTaxonomyRevisionProjection> {
  return getField(`/api/analysis-taxonomies/${encodeURIComponent(taxonomyId)}/revisions/${encodeURIComponent(revisionId)}`, "revision", AnalysisTaxonomyRevisionProjectionSchema);
}

export function createAnalysisTaxonomyRevision(
  taxonomyId: string,
  input: AnalysisTaxonomyRevisionCreateInput
): Promise<AnalysisTaxonomyRevisionResult> {
  return postResult(`/api/analysis-taxonomies/${encodeURIComponent(taxonomyId)}/revisions`, AnalysisTaxonomyRevisionCreateInputSchema.parse(input), AnalysisTaxonomyRevisionResultSchema);
}

export function fetchAnalysisObservationAssignments(
  taxonomyId: string,
  observationEventId: string,
  input: PageInput = {}
): Promise<AnalysisObservationAssignmentsPage> {
  return getPage(`/api/analysis-taxonomies/${encodeURIComponent(taxonomyId)}/assignments/${encodeURIComponent(observationEventId)}`, input, AnalysisObservationAssignmentsPageSchema);
}

export function appendAnalysisObservationAssignment(
  taxonomyId: string,
  input: AnalysisObservationAssignmentEventInput
): Promise<AnalysisObservationAssignmentEventResult> {
  return postResult(`/api/analysis-taxonomies/${encodeURIComponent(taxonomyId)}/assignments`, AnalysisObservationAssignmentEventInputSchema.parse(input), AnalysisObservationAssignmentEventResultSchema);
}

interface PageInput {
  limit?: number;
  cursor?: string | null;
}

async function getPage<T>(path: string, input: PageInput, schema: { parse(value: unknown): T }): Promise<T> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor) query.set("cursor", input.cursor);
  return getField(`${path}?${query}`, "page", schema);
}

async function getField<T>(
  path: string,
  field: string,
  schema: { parse(value: unknown): T }
): Promise<T> {
  const response = await projectFetch(`${API_BASE}${path}`);
  if (!response.ok) throw await responseError(response, "Governed analysis request failed");
  const body = await response.json() as Record<string, unknown>;
  return schema.parse(body[field]);
}

async function postResult<TInput, TResult>(
  path: string,
  input: TInput,
  schema: { parse(value: unknown): TResult }
): Promise<TResult> {
  const response = await projectFetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await responseError(response, "Governed analysis mutation failed");
  const body = await response.json() as { result?: unknown };
  return schema.parse(body.result);
}

function itemBase(studyId: string, studyItemId: string): string {
  return `/api/analysis-studies/${encodeURIComponent(studyId)}/items/${encodeURIComponent(studyItemId)}`;
}

function projectFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  try {
    const projectId = localStorage.getItem(PROJECT_KEY);
    if (projectId) headers.set("x-coeval-project", projectId);
  } catch {
    // The authenticated server default remains authoritative.
  }
  return fetch(url, { ...init, headers, credentials: "include" });
}

async function responseError(response: Response, fallback: string): Promise<AnalysisStudyApiError> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  return new AnalysisStudyApiError(
    typeof body?.error === "string" ? body.error : `${fallback}: ${response.status}`,
    response.status,
    typeof body?.code === "string" ? body.code : null
  );
}

function parseItemContent(value: unknown): AnalysisStudyItemContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Analysis study content response is invalid");
  }
  const row = value as Record<string, unknown>;
  const strings = [
    "projectId", "studyId", "populationId", "drawId", "datasetRevisionId", "studyItemId", "drawItemId",
    "memberId", "revisionItemId", "caseId", "inputDigest", "itemDigest", "viewEventId",
    "datasetExposureEventId"
  ] as const;
  for (const field of strings) {
    if (typeof row[field] !== "string" || row[field].length === 0) {
      throw new Error(`Analysis study content omitted ${field}`);
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(row.inputDigest)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(row.itemDigest)) ||
      !Number.isSafeInteger(row.position) || Number(row.position) < 0 || Number(row.position) > 9_999) {
    throw new Error("Analysis study content identity is invalid");
  }
  return {
    projectId: String(row.projectId), studyId: String(row.studyId), populationId: String(row.populationId),
    drawId: String(row.drawId), datasetRevisionId: String(row.datasetRevisionId), studyItemId: String(row.studyItemId),
    drawItemId: String(row.drawItemId), memberId: String(row.memberId), revisionItemId: String(row.revisionItemId),
    caseId: String(row.caseId), position: Number(row.position), inputDigest: String(row.inputDigest),
    itemDigest: String(row.itemDigest), viewEventId: String(row.viewEventId),
    datasetExposureEventId: String(row.datasetExposureEventId),
    payloadSnapshot: DatasetRevisionPayloadSnapshotSchema.parse(row.payloadSnapshot)
  };
}
