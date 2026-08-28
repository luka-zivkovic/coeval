import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, buildVerdictExportUrl, createProject, createReviewQueue, createSkillVersion, deleteLangSmithIntegration, ensureSkillVersionBackfill, fetchCaseVerdicts, fetchDatasetRevisionMetadata, fetchGoldenSet, fetchGoldenSetHealth, fetchJudgeHumanCalibration, fetchKappaSummary, fetchProjectVerdicts, fetchReviewQueueDetail, fetchReviewQueues, fetchSkillVersionHistory, recordHumanVerdict, setupOwner, testLangSmithIntegration } from "../src/lib/api.js";

const createdKey = {
  id: "apikey_first",
  projectId: "proj_first",
  name: "First verdict",
  keyPrefix: "coeval_sk_first…",
  createdAt: "2026-08-14T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  key: "coeval_sk_first-project-secret"
};

describe("web API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws ApiError with status and body for JSON error payloads", async () => {
    const body = { error: "Golden set unavailable", requestId: "req_123" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 503)));

    const error = await captureError(fetchGoldenSet());

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "Golden set unavailable",
      status: 503,
      body
    });
  });

  it("uses status fallback messages when an error response has no JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 502 })));

    const error = await captureError(setupOwner({ email: "owner@example.com", password: "owner-password" }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "Setup failed: 502",
      status: 502,
      body: null
    });
  });

  it("keeps a 503 backfill response visibly dispatch-pending and honors Retry-After", async () => {
    const run = {
      id: "evr_waiting",
      projectId: "proj_first",
      datasetId: null,
      datasetRevisionId: null,
      skillVersionId: "skillv_first",
      trigger: "backfill",
      status: "pending",
      blocking: false,
      totalItems: 1,
      completedItems: 0,
      failedItems: 0,
      agreedItems: 0,
      error: null,
      sourceTraceTest: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      items: [],
      spend: {
        freshItems: 0,
        cachedItems: 0,
        inputTokens: null,
        outputTokens: null,
        usageMissingCount: 0,
        totalLatencyMs: null
      }
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "The Result run is saved but not durably queued yet.",
      run
    }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "300" }
    })));

    await expect(ensureSkillVersionBackfill("skill_first", "skillv_first")).resolves.toEqual({
      run,
      dispatchPending: true,
      retryAfterMs: 300_000
    });
  });

  it("sends the first judging task with owner setup", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, projectId: "proj_first", apiKey: createdKey }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await setupOwner({
      email: "owner@example.com",
      password: "owner-password",
      projectName: "Agent skill audit",
      mode: "bench"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      projectName: "Agent skill audit",
      mode: "bench"
    });
  });

  // By the time these successful responses are parsed, the server has already
  // committed the owner/workspace (setup) or project (create). A malformed
  // body must not encourage a retry that wedges setup or duplicates a project.
  it("does not throw after setup commits but returns a malformed success body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true }, 200)));
    await expect(setupOwner({ email: "owner@example.com", password: "owner-password" })).resolves.toEqual({
      projectId: null,
      apiKey: null
    });
  });

  it("preserves the committed setup project when no new one-time key is minted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, projectId: "proj_existing" }, 200)));
    await expect(setupOwner({ email: "owner@example.com", password: "owner-password" })).resolves.toEqual({
      projectId: "proj_existing",
      apiKey: null
    });
  });

  it("does not throw after project creation commits without a parseable one-time key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ projectId: "proj_first" }, 201)));
    await expect(createProject("First evaluation", "tracing")).resolves.toEqual({
      projectId: "proj_first",
      apiKey: null
    });
  });

  it("reports a malformed project-creation body without a null dereference", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 201 })));
    await expect(createProject("First evaluation", "tracing")).rejects.toThrow(
      "Project creation response did not include a project id"
    );
  });

  it("parses the one-time project key returned with project creation", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ projectId: "proj_first", apiKey: createdKey }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createProject("First evaluation", "tracing")).resolves.toEqual({
      projectId: "proj_first",
      apiKey: createdKey
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ name: "First evaluation", mode: "tracing" });
  });

  it("preserves ApiError status for mutation helpers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "LangSmith integration not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureError(deleteLangSmithIntegration("int_missing"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/langsmith/int_missing",
      expect.objectContaining({ method: "DELETE", credentials: "include" })
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "LangSmith integration not found",
      status: 404
    });
  });

  it("returns a queued immutable evaluator version immediately instead of hiding 202 behind polling", async () => {
    const version = {
      id: "skillv_queued",
      skillId: "skill_1",
      criterionVersionId: "criterionv_1",
      version: "1.2.0",
      status: "calibrating",
      rubricMarkdown: "Pass when grounded.",
      prompt: "Judge against {{rubric_markdown}}.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
      outputSchema: { type: "object" },
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: "binary",
      scalarRange: null,
      categoricalChoiceScores: null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: "revision_pinned",
      createdAt: "2026-08-27T00:00:00.000Z",
      approvedAt: null
    };
    const fetchMock = vi.fn(async () => jsonResponse({ version, regressionRun: null, queued: true }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSkillVersion("skill_1", {
      rubricMarkdown: version.rubricMarkdown,
      prompt: version.prompt,
      modelBinding: version.modelBinding,
      outputSchema: version.outputSchema,
      verdictKind: "binary",
      timeScope: "new"
    })).resolves.toEqual({ state: "queued", version });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("loads version history receipts and reference counts from metadata-only reads", async () => {
    const version = {
      id: "skillv_history",
      skillId: "skill_1",
      criterionVersionId: "criterionv_1",
      version: "1.2.0",
      status: "approved",
      rubricMarkdown: "Pass when grounded.",
      prompt: "Judge against {{rubric_markdown}}.",
      modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
      outputSchema: { type: "object" },
      goldenSetAgreement: 1,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: "binary",
      scalarRange: null,
      categoricalChoiceScores: null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: "revision_pinned",
      createdAt: "2026-08-27T00:00:00.000Z",
      approvedAt: "2026-08-27T00:01:00.000Z"
    };
    const run = {
      id: "run_history",
      skillVersionId: version.id,
      datasetRevisionId: "revision_pinned",
      status: "passed",
      compared: 3,
      regressed: 0,
      improved: 0,
      flipped: 0,
      goldenSetMissing: false,
      cases: [],
      createdAt: "2026-08-27T00:01:00.000Z"
    };
    const metadata = {
      id: "revision_pinned",
      projectId: "proj_1",
      seriesId: "series_1",
      revisionNumber: 1,
      sourceDatasetId: null,
      parentRevisionId: null,
      role: "regression_golden",
      sourceKind: "golden_snapshot",
      identityBasis: "input-identity/v1",
      contentDigest: `sha256:${"1".repeat(64)}`,
      revisionDigest: `sha256:${"2".repeat(64)}`,
      itemCount: 3,
      provenanceLevel: "reviewed_unblinded",
      exposureState: "visible_by_design",
      semanticLeakageDetection: "unsupported",
      createdByUserId: null,
      createdAt: "2026-08-27T00:00:00.000Z"
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/metadata")
      ? jsonResponse({ revision: metadata }, 200)
      : jsonResponse({ versions: [version], regressionRuns: [run] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSkillVersionHistory("skill_1")).resolves.toMatchObject({
      versions: [{ id: version.id }],
      regressionRuns: [{ id: run.id, status: "passed" }]
    });
    await expect(fetchDatasetRevisionMetadata("revision_pinned")).resolves.toMatchObject({ itemCount: 3 });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/dataset-revisions/revision_pinned/metadata");
  });

  it("parses golden-set health payloads", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      projectId: "proj_langsmith_support",
      status: "needs_action",
      totalActive: 2,
      staleAfterDays: 90,
      staleCount: 1,
      freshCount: 1,
      duplicateCount: 1,
      passCount: 1,
      failCount: 1,
      oldestPromotedAt: "2026-01-01T00:00:00.000Z",
      newestPromotedAt: "2026-04-01T00:00:00.000Z",
      staleEntries: [
        {
          id: "gold_1",
          traceId: "trace_1",
          agreedLabel: "fail",
          promotedAt: "2026-01-01T00:00:00.000Z",
          ageDays: 126,
          reason: "Old label"
        }
      ],
      duplicateGroups: [
        {
          traceId: "trace_1",
          entryCount: 2,
          entries: [
            {
              id: "gold_1",
              traceId: "trace_1",
              agreedLabel: "fail",
              promotedAt: "2026-01-01T00:00:00.000Z",
              ageDays: 126,
              reason: "Old label"
            },
            {
              id: "gold_2",
              traceId: "trace_1",
              agreedLabel: "pass",
              promotedAt: "2026-04-01T00:00:00.000Z",
              ageDays: 36,
              reason: "Duplicate label"
            }
          ]
        }
      ],
      recommendations: [
        "Review 1 golden-set case older than 90 days for stale labels or product drift.",
        "Review 1 duplicate golden-set case before expanding the suite."
      ]
    }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoldenSetHealth()).resolves.toMatchObject({
      status: "needs_action",
      staleCount: 1,
      duplicateCount: 1,
      staleEntries: [{ traceId: "trace_1", ageDays: 126 }]
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/golden-set/health", expect.objectContaining({ credentials: "include" }));
  });

  it("parses κ summary payloads and validates against the shared schema", async () => {
    const body = {
      raterCount: 2,
      overlappingCases: 3,
      pairs: [
        {
          reviewerA: "reviewer_a",
          reviewerB: "reviewer_b",
          cases: 3,
          observedAgreement: 0.6667,
          expectedAgreement: 0.5,
          kappa: 0.33,
          interpretation: "fair"
        }
      ],
      meanKappa: 0.33,
      meanInterpretation: "fair",
      undefinedPairs: [],
      unsupportedPairs: 0
    };
    const fetchMock = vi.fn(async () => jsonResponse(body, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchKappaSummary()).resolves.toMatchObject({
      raterCount: 2,
      meanKappa: 0.33,
      meanInterpretation: "fair",
      pairs: [{ reviewerA: "reviewer_a", interpretation: "fair" }]
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/kappa", expect.objectContaining({ credentials: "include" }));
  });

  it("preserves a named undefined κ result instead of treating one-label agreement as perfect", async () => {
    const body = {
      raterCount: 2,
      overlappingCases: 4,
      pairs: [],
      meanKappa: null,
      meanInterpretation: null,
      undefinedPairs: [{
        reviewerA: "reviewer_a",
        reviewerB: "reviewer_b",
        cases: 4,
        observedAgreement: 1,
        expectedAgreement: 1,
        kappa: null,
        interpretation: null,
        reason: "expected_agreement_one"
      }],
      unsupportedPairs: 0
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 200)));

    await expect(fetchKappaSummary()).resolves.toMatchObject({
      meanKappa: null,
      undefinedPairs: [{ reason: "expected_agreement_one", expectedAgreement: 1, kappa: null }]
    });
  });

  it("wraps κ summary parse failures as ApiError with the raw body preserved", async () => {
    const body = { meanKappa: "not-a-number" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 200)));

    const error = await captureError(fetchKappaSummary());

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, body });
  });

  it("parses the judge-human calibration payload (synthetic judge reviewer keyed by judge:<skillVersionId>)", async () => {
    const body = {
      raterCount: 2,
      overlappingCases: 2,
      pairs: [
        {
          reviewerA: "judge:skillv_1_2_0",
          reviewerB: "reviewer_a",
          cases: 2,
          observedAgreement: 1,
          expectedAgreement: 0.5,
          kappa: 1,
          interpretation: "almost_perfect"
        }
      ],
      meanKappa: 1,
      meanInterpretation: "almost_perfect",
      undefinedPairs: [],
      unsupportedPairs: 0
    };
    const fetchMock = vi.fn(async () => jsonResponse(body, 200));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJudgeHumanCalibration()).resolves.toMatchObject({
      raterCount: 2,
      pairs: [{ reviewerA: "judge:skillv_1_2_0", reviewerB: "reviewer_a", kappa: 1 }]
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/judge-human-calibration", expect.objectContaining({ credentials: "include" }));
  });

  it("PR #59: fetchProjectVerdicts builds the query string + parses VerdictRecord[]", async () => {
    const body = {
      verdicts: [
        {
          id: "verdict_1",
          projectId: "proj_t",
          caseId: "case_exc_001",
          skillVersionId: null,
          source: "human",
          actorUserId: "reviewer_a",
          payload: { kind: "binary", pass: true, rationale: "" },
          externalRunId: null,
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ]
    };
    const fetchMock = vi.fn(async () => jsonResponse(body, 200));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchProjectVerdicts({ source: "human", limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toMatchObject({ kind: "binary", pass: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/verdicts?source=human&limit=5", expect.objectContaining({ credentials: "include" }));
  });

  it("PR #59: buildVerdictExportUrl serializes format + source into the query string", () => {
    expect(buildVerdictExportUrl()).toBe("/api/projects/verdicts/export?format=jsonl");
    expect(buildVerdictExportUrl({ format: "csv" })).toBe("/api/projects/verdicts/export?format=csv");
    expect(buildVerdictExportUrl({ format: "jsonl", source: "human" })).toBe("/api/projects/verdicts/export?format=jsonl&source=human");
    expect(buildVerdictExportUrl({ format: "jsonl", skillVersionId: "skillv_2" })).toBe("/api/projects/verdicts/export?format=jsonl&skillVersionId=skillv_2");
    expect(buildVerdictExportUrl({ format: "jsonl", criterionId: "criterion_correctness" })).toBe("/api/projects/verdicts/export?format=jsonl&criterionId=criterion_correctness");
  });

  it("wraps golden-set health parse failures as ApiError", async () => {
    const body = { projectId: "proj_langsmith_support" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 200)));

    const error = await captureError(fetchGoldenSetHealth());

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 200,
      body
    });
  });

  it("records a human verdict and returns the parsed VerdictRecord", async () => {
    const verdictBody = {
      verdict: {
        id: "verdict_abc",
        projectId: "proj_test",
        caseId: "case_exc_001",
        skillVersionId: null,
        source: "human",
        actorUserId: "user_reviewer",
        payload: { kind: "binary", pass: false, rationale: "outdated" },
        externalRunId: null,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    };
    const fetchMock = vi.fn(async () => jsonResponse(verdictBody, 201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await recordHumanVerdict("case_exc_001", { kind: "binary", pass: false, rationale: "outdated" });
    expect(result).toMatchObject({
      id: "verdict_abc",
      source: "human",
      payload: { kind: "binary", pass: false }
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/cases/case_exc_001/verdicts", expect.objectContaining({
      method: "POST",
      credentials: "include"
    }));
  });

  it("recordHumanVerdict wraps non-OK responses as ApiError with status + body", async () => {
    const body = { error: "Case not found in this project" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 404)));

    const error = await captureError(recordHumanVerdict("case_nope", { kind: "binary", pass: true, rationale: "" }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, body });
  });

  it("fetchCaseVerdicts builds the query string + parses the array shape", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      verdicts: [
        {
          id: "verdict_1",
          projectId: "proj_t",
          caseId: "case_exc_001",
          skillVersionId: null,
          source: "human",
          actorUserId: "user_a",
          payload: { kind: "binary", pass: true, rationale: "" },
          externalRunId: null,
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ]
    }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCaseVerdicts("case_exc_001", { source: "human", limit: 25 });
    expect(result).toHaveLength(1);
    expect(result[0]?.payload).toMatchObject({ kind: "binary", pass: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cases/case_exc_001/verdicts?source=human&limit=25",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("fetchReviewQueues parses an array of queue summaries", async () => {
    const queueBody = {
      queues: [
        {
          id: "revq_1",
          projectId: "proj_t",
          name: "October calibration",
          description: null,
          status: "open",
          createdByUserId: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          closedAt: null,
          pendingCount: 3,
          completedCount: 0
        }
      ]
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(queueBody, 200)));
    await expect(fetchReviewQueues()).resolves.toEqual([
      expect.objectContaining({ id: "revq_1", pendingCount: 3, status: "open" })
    ]);
  });

  it("fetchReviewQueueDetail returns null on 404, parsed detail otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    await expect(fetchReviewQueueDetail("revq_nope")).resolves.toBeNull();

    const detailBody = {
      queue: {
        id: "revq_1",
        projectId: "proj_t",
        name: "October calibration",
        description: null,
        status: "open",
        createdByUserId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        closedAt: null,
        pendingCount: 1,
        completedCount: 0
      },
      items: [
        {
          id: "revqi_1",
          queueId: "revq_1",
          caseId: "case_exc_001",
          criterionVersionId: "criterionv_support_quality",
          status: "pending",
          position: 0,
          assignedToUserId: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          completedAt: null
        }
      ]
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(detailBody, 200)));
    const detail = await fetchReviewQueueDetail("revq_1");
    expect(detail?.queue.id).toBe("revq_1");
    expect(detail?.items[0]?.caseId).toBe("case_exc_001");
  });

  it("createReviewQueue posts the input + returns the parsed queue", async () => {
    const queueBody = {
      queue: {
        id: "revq_new",
        projectId: "proj_t",
        name: "ad-hoc",
        description: null,
        status: "open",
        createdByUserId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        closedAt: null,
        pendingCount: 1,
        completedCount: 0
      }
    };
    const fetchMock = vi.fn(async () => jsonResponse(queueBody, 201));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createReviewQueue({ name: "ad-hoc", caseIds: ["case_exc_001"] });
    expect(result.id).toBe("revq_new");
    expect(fetchMock).toHaveBeenCalledWith("/api/review-queues", expect.objectContaining({ method: "POST" }));
  });

  it("still returns failed LangSmith connection test payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: false,
      checkedAt: "2026-05-05T00:00:00.000Z",
      status: 401,
      error: "LangSmith runs request failed: 401"
    }, 502)));

    await expect(testLangSmithIntegration("int_revoked")).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "LangSmith runs request failed: 401"
    });
  });
});

async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected promise to reject");
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
