import { describe, expect, it, vi } from "vitest";
import {
  traceTestRunOutcome,
  type CreateTraceTestInput,
  type EvalRunDetail,
  type TraceTestDetail,
  type TraceTestRunResult,
  type TraceTestValidation
} from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

// The mock judge scans metadata for failure terms, so a random UUID containing
// "bad" can make this route contract nondeterministic without changing input.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  let sequence = 0;
  return {
    ...actual,
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  };
});

const PROJECT = "proj_langsmith_support";

class PurposeCapturingRepository extends DemoRepository {
  readonly datasetPurposes = new Array<string>();

  override async importDatasetExamples(
    input: Parameters<DemoRepository["importDatasetExamples"]>[0]
  ) {
    this.datasetPurposes.push(input.ingestionPurpose);
    return super.importDatasetExamples(input);
  }
}

function draft(sourceCaseId: string, journeyJob: "response" | "preserve" = "response"): CreateTraceTestInput {
  return {
    sourceCaseId,
    sourceScope: { responsePath: ["output"], turnIndexes: [0, 1], stepIndexes: [] },
    desiredBehavior: "Do not give an incorrect refund answer.",
    scenario: "A customer asks whether a refund is available.",
    expectedBehavior: "Give the policy-qualified answer.",
    mustDo: ["State the answer accurately"],
    mustAvoid: ["Give an incorrect answer"],
    goodExample: { text: "I will check the policy first." },
    badExample: { text: "This is a wrong refund answer." },
    checker: { kind: "judge", label: "Refund answer", metadata: { journeyJob } },
    draftProvenance: { origin: "human", generatedFields: [], generator: null }
  };
}

async function createEnabledTest(input: {
  repository: DemoRepository;
  app: ReturnType<typeof createApp>;
  sourceTraceId: string;
  output: unknown;
  journeyJob?: "response" | "preserve";
}): Promise<{ test: TraceTestDetail; validation: TraceTestValidation }> {
  const imported = await input.repository.importTrace(PROJECT, "manual", {
    sourceTraceId: input.sourceTraceId,
    input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
    output: input.output,
    metadata: { channel: "support" }
  }, { ingestionPurpose: "analysis_eligible_manual" });
  const createdResponse = await input.app.request("/api/trace-tests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft(imported.caseId, input.journeyJob))
  });
  const created = ((await createdResponse.json()) as { test: TraceTestDetail }).test;
  const validationResponse = await input.app.request(`/api/trace-tests/${created.id}/validations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      revision: created.currentRevision,
      badResult: "fail",
      goodResult: "pass",
      overrideReason: "I checked both examples against the stated behavior and confirmed the outcomes."
    })
  });
  const validation = ((await validationResponse.json()) as { validation: TraceTestValidation }).validation;
  const enableResponse = await input.app.request(`/api/trace-tests/${created.id}/enable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: created.currentRevision, validationId: validation.id })
  });
  expect(enableResponse.status).toBe(200);
  return { test: ((await enableResponse.json()) as { test: TraceTestDetail }).test, validation };
}

describe("trace-test run API", () => {
  it("creates the recommended suite, snapshots provenance, and reuses the same case on rerun", async () => {
    const repository = new PurposeCapturingRepository();
    const app = createApp(repository);
    const { test, validation } = await createEnabledTest({
      repository,
      app,
      sourceTraceId: "trace_test_run_response",
      output: { answer: "This answer is wrong." }
    });

    const firstResponse = await app.request(`/api/trace-tests/${test.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json()) as TraceTestRunResult;
    expect(first).toMatchObject({
      dataset: { name: "Regression tests", itemCount: 1 },
      outcome: "passed",
      run: {
        status: "completed",
        sourceTraceTest: {
          traceTestId: test.id,
          revision: test.enabledRevision,
          validationRevision: 1,
          validationId: validation.id,
          sourceCaseRef: test.sourceCaseRef
        }
      }
    });
    const sourceItem = first.run.items.find((item) => item.id && item.datasetItemId === first.run.sourceTraceTest?.datasetItemId);
    expect(sourceItem).toMatchObject({ expectedLabel: "fail", resultLabel: "fail", agreement: true });

    const secondResponse = await app.request(`/api/trace-tests/${test.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const second = (await secondResponse.json()) as TraceTestRunResult;
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.dataset.id).toBe(first.dataset.id);
    expect(second.dataset.itemCount).toBe(1);
    expect(second.run.sourceTraceTest).toMatchObject({
      caseId: first.run.sourceTraceTest?.caseId,
      datasetItemId: first.run.sourceTraceTest?.datasetItemId
    });
    expect(repository.datasetPurposes).toEqual(["trace_test_synthetic", "trace_test_synthetic"]);
  });

  it("uses pass as the source expectation for a preserve journey and accepts an existing suite", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const suite = await repository.createDataset({ projectId: PROJECT, name: "Checkout safety" });
    const { test } = await createEnabledTest({
      repository,
      app,
      sourceTraceId: "trace_test_run_preserve",
      output: { answer: "I will check the policy first." },
      journeyJob: "preserve"
    });

    const response = await app.request(`/api/trace-tests/${test.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId: suite.id })
    });
    expect(response.status).toBe(202);
    const result = (await response.json()) as TraceTestRunResult;
    expect(result.dataset.id).toBe(suite.id);
    expect(result.outcome).toBe("passed");
    expect(result.run.items.find((item) => item.datasetItemId === result.run.sourceTraceTest?.datasetItemId))
      .toMatchObject({ expectedLabel: "pass", resultLabel: "pass", agreement: true });
  });

  it("requires an enabled project-scoped test and an active project-scoped suite", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const imported = await repository.importTrace(PROJECT, "manual", {
      sourceTraceId: "trace_test_run_draft",
      input: { question: "Refund?" },
      output: { answer: "This is wrong." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const createResponse = await app.request("/api/trace-tests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft(imported.caseId))
    });
    const draftTest = ((await createResponse.json()) as { test: TraceTestDetail }).test;

    const notEnabled = await app.request(`/api/trace-tests/${draftTest.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(notEnabled.status).toBe(409);
    await expect(notEnabled.json()).resolves.toMatchObject({ error: "Enable this test before running it." });

    const missingTest = await app.request("/api/trace-tests/tt_other_project/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(missingTest.status).toBe(404);

    const { test } = await createEnabledTest({
      repository,
      app,
      sourceTraceId: "trace_test_run_missing_suite",
      output: { answer: "This is wrong." }
    });
    const missingSuite = await app.request(`/api/trace-tests/${test.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId: "ds_other_project" })
    });
    expect(missingSuite.status).toBe(404);
  });

  it("maps behavior disagreement, ambiguity, and runtime failures to distinct beginner outcomes", () => {
    const base = {
      id: "evr_1",
      projectId: PROJECT,
      datasetId: "ds_1",
      skillVersionId: "skillv_1_2_0",
      trigger: "manual",
      status: "completed",
      blocking: false,
      totalItems: 1,
      completedItems: 1,
      failedItems: 0,
      agreedItems: 0,
      error: null,
      sourceTraceTest: {
        traceTestId: "tt_1",
        revision: 2,
        validationRevision: 1,
        validationId: "ttv_1",
        sourceCaseRef: "case_source",
        caseId: "case_1",
        datasetItemId: "dsi_1"
      },
      createdAt: "2026-08-20T00:00:00.000Z",
      startedAt: "2026-08-20T00:00:01.000Z",
      finishedAt: "2026-08-20T00:00:02.000Z",
      spend: { freshItems: 1, cachedItems: 0, inputTokens: 1, outputTokens: 1, usageMissingCount: 0, totalLatencyMs: 1 },
      items: [{
        id: "evi_1",
        evalRunId: "evr_1",
        caseId: "case_1",
        datasetItemId: "dsi_1",
        clientItemId: null,
        contentDigest: null,
        status: "completed",
        verdictId: "verdict_1",
        expectedLabel: "fail",
        expectedFailStep: null,
        failingStep: null,
        resultLabel: "pass",
        agreement: false,
        stepAgreement: null,
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        cached: false,
        error: null,
        createdAt: "2026-08-20T00:00:00.000Z",
        finishedAt: "2026-08-20T00:00:02.000Z"
      }]
    } satisfies EvalRunDetail;

    expect(traceTestRunOutcome(base)).toBe("regressed");
    expect(traceTestRunOutcome({
      ...base,
      items: [{ ...base.items[0]!, resultLabel: "ambiguous", agreement: false }]
    })).toBe("needs_review");
    expect(traceTestRunOutcome({
      ...base,
      status: "failed",
      completedItems: 0,
      failedItems: 1,
      error: "provider unavailable",
      items: [{ ...base.items[0]!, status: "failed", verdictId: null, resultLabel: null, agreement: null, error: "provider unavailable" }]
    })).toBe("could_not_run");
  });
});
