import {
  type AssistTraceTestDraftInput,
  AssistTraceTestDraftInputSchema,
  type AssistTraceTestDraftResult,
  AssistTraceTestDraftResultSchema,
  type CreateTraceTestInput,
  CreateTraceTestInputSchema,
  type EnableTraceTestInput,
  EnableTraceTestInputSchema,
  type ExceptionDetail,
  ExceptionDetailSchema,
  type GoldenSetEntry,
  type PromoteGoldenSetInput,
  PromoteGoldenSetInputSchema,
  type RecordManualTraceTestValidationInput,
  RecordManualTraceTestValidationInputSchema,
  type RetireGoldenSetEntryInput,
  RetireGoldenSetEntryInputSchema,
  type ReviewQueue,
  type ReviewQueueDetail,
  ReviewQueueDetailSchema,
  ReviewQueueSchema,
  type ReviseTraceTestInput,
  ReviseTraceTestInputSchema,
  type RunTraceTestValidationInput,
  RunTraceTestValidationInputSchema,
  type StartTraceTestRunInput,
  StartTraceTestRunInputSchema,
  type TraceTestDetail,
  TraceTestDetailSchema,
  type TraceTestFunnelEventInput,
  TraceTestFunnelEventInputSchema,
  type TraceTestRunResult,
  TraceTestRunResultSchema,
  type TraceTestSummary,
  TraceTestSummarySchema,
  type TraceTestValidation,
  TraceTestValidationSchema,
  type VerdictPayload,
  type VerdictRecord,
  VerdictRecordSchema,
  type VerdictSource
} from "@coeval/shared";
import {
  API_BASE,
  apiError,
  apiErrorFromResponse,
  apiFetch,
  queryPath
} from "./transport.js";

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
