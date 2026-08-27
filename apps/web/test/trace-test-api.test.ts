import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateTraceTestInput, TraceTestDetail, TraceTestRunResult, TraceTestValidation } from "@coeval/shared";
import {
  assistTraceTestDraft,
  createTraceTest,
  enableTraceTest,
  fetchTraceTest,
  fetchTraceTests,
  recordManualTraceTestValidation,
  reviseTraceTest,
  runTraceTestValidation,
  startTraceTestRun
} from "../src/lib/api.js";

const input: CreateTraceTestInput = {
  sourceCaseId: "case_refund",
  sourceScope: { responsePath: ["output"], turnIndexes: [0, 1], stepIndexes: [] },
  desiredBehavior: "Check eligibility before promising a refund.",
  scenario: "A customer asks for a refund.",
  expectedBehavior: "Check eligibility before promising a refund.",
  mustDo: ["Check eligibility"],
  mustAvoid: ["Promise a refund"],
  goodExample: { text: "I will check eligibility." },
  badExample: { text: "Your refund is guaranteed." },
  checker: { kind: "manual", label: "Manual behavior check", metadata: { journeyJob: "response" } },
  draftProvenance: { origin: "human", generatedFields: [], generator: null }
};

function detail(revision = 1): TraceTestDetail {
  return {
    id: "tt_refund",
    projectId: "proj_test",
    sourceCaseId: "case_refund",
    sourceCaseRef: "case_refund",
    sourceTraceRef: "trace_refund",
    sourceSnapshot: { input: "Can I get a refund?", output: "Your refund is guaranteed." },
    sourceScope: input.sourceScope,
    lifecycle: "draft",
    currentRevision: revision,
    enabledRevision: null,
    hasUnpublishedChanges: false,
    createdByUserId: "user_reviewer",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    revisions: [{
      id: `ttr_${revision}`,
      traceTestId: "tt_refund",
      revision,
      lifecycle: "draft",
      desiredBehavior: input.desiredBehavior,
      scenario: input.scenario,
      expectedBehavior: input.expectedBehavior,
      mustDo: input.mustDo,
      mustAvoid: input.mustAvoid,
      goodExample: input.goodExample,
      badExample: input.badExample,
      checker: input.checker,
      draftProvenance: input.draftProvenance,
      validationId: null,
      validatedRevision: null,
      createdByUserId: "user_reviewer",
      reviewedByUserId: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      reviewedAt: null
    }],
    validations: []
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function validation(method: "automated" | "manual_override" = "automated"): TraceTestValidation {
  return {
    id: "ttv_refund",
    traceTestId: "tt_refund",
    revision: 1,
    status: "passed",
    badEvidence: { output: input.badExample, expectedResult: "fail", result: "fail", note: "Fails as expected.", attempts: 1, usage: null },
    goodEvidence: { output: input.goodExample, expectedResult: "pass", result: "pass", note: "Passes as expected.", attempts: 1, usage: null },
    method,
    diagnostic: null,
    evaluator: method === "automated" ? { provider: "anthropic", model: "claude-sonnet", version: "2026-08-20" } : null,
    overrideReason: method === "manual_override" ? "I confirmed the two examples show opposite behavior." : null,
    recordedByUserId: "user_reviewer",
    createdAt: "2026-08-20T00:00:00.000Z"
  };
}

describe("trace-test web API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a validated manual draft through the authenticated project request", async () => {
    const fetchMock = vi.fn(async () => json({ test: detail() }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createTraceTest(input)).resolves.toMatchObject({ id: "tt_refund", lifecycle: "draft" });
    expect(fetchMock).toHaveBeenCalledWith("/api/trace-tests", expect.objectContaining({
      method: "POST",
      credentials: "include"
    }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      sourceCaseId: "case_refund",
      checker: { kind: "manual" },
      draftProvenance: { origin: "human" }
    });
  });

  it("requests assistance with source identity and scope, never trace content", async () => {
    const fetchMock = vi.fn(async () => json({
      status: "generated",
      content: {
        scenario: "A customer asks for a refund.",
        expectedBehavior: "Check eligibility.",
        mustDo: ["Check eligibility"],
        mustAvoid: ["Guarantee a refund"],
        goodExample: "I can check eligibility.",
        badExample: "Your refund is guaranteed.",
        checker: { kind: "judge", label: "Refund behavior", metadata: {} },
        inferredContext: []
      },
      sourceScope: input.sourceScope,
      draftProvenance: {
        origin: "generated",
        generatedFields: ["scenario", "expectedBehavior", "mustDo", "mustAvoid", "goodExample", "badExample", "checker"],
        generator: { provider: "anthropic", model: "claude-sonnet-4-6", version: "2026-04-15" }
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(assistTraceTestDraft({
      sourceCaseId: "case_refund",
      sourceScope: input.sourceScope,
      desiredBehavior: input.desiredBehavior,
      job: "response"
    })).resolves.toMatchObject({ status: "generated" });
    expect(fetchMock).toHaveBeenCalledWith("/api/trace-tests/assist", expect.objectContaining({ method: "POST", credentials: "include" }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toEqual({
      sourceCaseId: "case_refund",
      sourceScope: input.sourceScope,
      desiredBehavior: input.desiredBehavior,
      job: "response"
    });
    expect(JSON.stringify(body)).not.toContain("Your refund is guaranteed.");
  });

  it("lists drafts for one source conversation and fetches the resumable detail", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ tests: [detail()] }))
      .mockResolvedValueOnce(json({ test: detail() }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTraceTests("case refund")).resolves.toEqual([expect.objectContaining({ id: "tt_refund" })]);
    await expect(fetchTraceTest("tt_refund")).resolves.toMatchObject({ sourceCaseId: "case_refund", currentRevision: 1 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/trace-tests?sourceCaseId=case%20refund", expect.objectContaining({ credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/trace-tests/tt_refund", expect.objectContaining({ credentials: "include" }));
  });

  it("appends a revision instead of overwriting a resumed draft", async () => {
    const fetchMock = vi.fn(async () => json({ test: detail(2) }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await reviseTraceTest("tt_refund", {
      expectedRevision: 1,
      desiredBehavior: input.desiredBehavior,
      scenario: input.scenario,
      expectedBehavior: input.expectedBehavior,
      mustDo: input.mustDo,
      mustAvoid: input.mustAvoid,
      goodExample: input.goodExample,
      badExample: input.badExample,
      checker: input.checker,
      draftProvenance: input.draftProvenance
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/trace-tests/tt_refund/revisions", expect.objectContaining({ method: "POST", credentials: "include" }));
  });

  it("runs, manually records, and enables validation through authenticated project requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ validation: validation() }, 201))
      .mockResolvedValueOnce(json({ validation: validation("manual_override") }, 201))
      .mockResolvedValueOnce(json({ test: { ...detail(2), lifecycle: "enabled", enabledRevision: 2 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runTraceTestValidation("tt_refund", { revision: 1 })).resolves.toMatchObject({ status: "passed", method: "automated" });
    await expect(recordManualTraceTestValidation("tt_refund", {
      revision: 1,
      badResult: "fail",
      goodResult: "pass",
      overrideReason: "I confirmed the two examples show opposite behavior."
    })).resolves.toMatchObject({ method: "manual_override" });
    await expect(enableTraceTest("tt_refund", { expectedRevision: 1, validationId: "ttv_refund" })).resolves.toMatchObject({ lifecycle: "enabled" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/trace-tests/tt_refund/checks", expect.objectContaining({ method: "POST", credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/trace-tests/tt_refund/validations", expect.objectContaining({ method: "POST", credentials: "include" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/trace-tests/tt_refund/enable", expect.objectContaining({ method: "POST", credentials: "include" }));
  });

  it("starts an enabled test through the existing eval-run contract", async () => {
    const result: TraceTestRunResult = {
      dataset: {
        id: "ds_regression",
        projectId: "proj_test",
        name: "Regression tests",
        description: "Enabled tests saved from real conversations.",
        kind: "custom",
        itemCount: 1,
        createdAt: "2026-08-20T00:00:00.000Z",
        archivedAt: null
      },
      outcome: "passed",
      run: {
        id: "evr_test",
        projectId: "proj_test",
        datasetId: "ds_regression",
        skillVersionId: "skillv_1",
        trigger: "manual",
        status: "completed",
        blocking: false,
        totalItems: 1,
        completedItems: 1,
        failedItems: 0,
        agreedItems: 1,
        error: null,
        sourceTraceTest: { traceTestId: "tt_refund", revision: 2, validationRevision: 1, validationId: "ttv_refund", sourceCaseRef: "case_refund", caseId: "case_derived", datasetItemId: "dsi_1" },
        createdAt: "2026-08-20T00:00:00.000Z",
        startedAt: "2026-08-20T00:00:00.000Z",
        finishedAt: "2026-08-20T00:00:01.000Z",
        items: [],
        spend: { freshItems: 0, cachedItems: 0, inputTokens: null, outputTokens: null, usageMissingCount: 0, totalLatencyMs: null }
      }
    };
    const fetchMock = vi.fn(async () => json(result, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startTraceTestRun("tt_refund")).resolves.toMatchObject({ outcome: "passed", run: { id: "evr_test" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/trace-tests/tt_refund/runs", expect.objectContaining({ method: "POST", credentials: "include" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({});
  });
});
