import { describe, expect, it } from "vitest";
import { LangSmithClient, LangSmithHttpError, langSmithRunToTraceImport } from "../src/lib/langsmith.js";
import {
  FeedbackSyncCredentialsMissingError,
  FeedbackSyncJobNotFoundError,
  LangSmithCredentialsMissingError,
  LangSmithIntegrationNotFoundError,
  NoCurrentSkillError
} from "../src/repository.js";
import { isPermanentFeedbackSyncError } from "../src/workers/feedback-sync.js";
import { isPermanentLangSmithImportError } from "../src/workers/langsmith-import.js";

const run = {
  id: "run_123",
  name: "Support answer",
  run_type: "llm",
  inputs: { question: "Can I get a refund?" },
  outputs: { answer: "Yes." },
  start_time: "2026-05-01T00:00:00.000Z",
  end_time: "2026-05-01T00:00:02.000Z",
  extra: { tenant: "test" }
};

describe("LangSmith client", () => {
  it("normalizes a LangSmith run into a trace import", () => {
    expect(langSmithRunToTraceImport(run)).toEqual({
      sourceTraceId: "run_123",
      input: { question: "Can I get a refund?" },
      output: { answer: "Yes." },
      metadata: {
        source: "langsmith",
        name: "Support answer",
        runType: "llm",
        startTime: "2026-05-01T00:00:00.000Z",
        endTime: "2026-05-01T00:00:02.000Z",
        extra: { tenant: "test" }
      }
    });
  });

  it("accepts array, runs, and results response shapes", async () => {
    await expect(listRunsFrom([run])).resolves.toHaveLength(1);
    await expect(listRunsFrom({ runs: [run] })).resolves.toHaveLength(1);
    await expect(listRunsFrom({ results: [run] })).resolves.toHaveLength(1);
  });

  it("posts feedback to LangSmith runs", async () => {
    let captured: { url: string; init?: RequestInit | undefined } | undefined;
    const client = new LangSmithClient({
      apiKey: "ls_test_key",
      endpointUrl: "https://example.langsmith.test/",
      fetchImpl: (async (input, init) => {
        captured = { url: String(input), init };
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });

    await client.createFeedback({
      feedbackId: "fsync_123",
      runId: "run_123",
      key: "coeval_verdict",
      score: 0.8,
      value: "pass",
      comment: "accepted",
      sourceInfo: { judgeRunId: "judge_123" }
    });

    expect(captured?.url).toBe("https://example.langsmith.test/feedback");
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.headers).toMatchObject({
      "x-api-key": "ls_test_key",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      id: "fsync_123",
      run_id: "run_123",
      key: "coeval_verdict",
      score: 0.8,
      value: "pass",
      comment: "accepted",
      source_info: { judgeRunId: "judge_123" }
    });
  });

  it("treats duplicate deterministic feedback ids as idempotent success", async () => {
    const client = new LangSmithClient({
      apiKey: "ls_test_key",
      fetchImpl: (async () => new Response("{}", { status: 409 })) as typeof fetch
    });

    await expect(client.createFeedback({
      feedbackId: "fsync_existing",
      runId: "run_123",
      key: "coeval_verdict",
      score: 0.8,
      value: "pass",
      comment: "already posted"
    })).resolves.toBeUndefined();
  });

  it("carries HTTP status on failed LangSmith requests", async () => {
    const client = new LangSmithClient({
      apiKey: "ls_test_key",
      fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch
    });

    await expect(client.listRuns({ projectName: "Support Agent", limit: 1 })).rejects.toMatchObject({
      status: 404,
      operation: "listRuns"
    });
    await expect(client.createFeedback({
      runId: "run_missing",
      key: "coeval_verdict",
      score: 0,
      value: "fail",
      comment: "missing"
    })).rejects.toBeInstanceOf(LangSmithHttpError);
  });

  it("classifies LangSmith auth/not-found errors as permanent worker failures", () => {
    expect(isPermanentFeedbackSyncError(new LangSmithHttpError("missing run", 404, "createFeedback"))).toBe(true);
    expect(isPermanentFeedbackSyncError(new FeedbackSyncJobNotFoundError("fsync_missing"))).toBe(true);
    expect(isPermanentFeedbackSyncError(new FeedbackSyncCredentialsMissingError("fsync_missing"))).toBe(true);
    expect(isPermanentFeedbackSyncError(new Error("Feedback sync job not found: fsync_missing"))).toBe(false);
    expect(isPermanentFeedbackSyncError(new LangSmithHttpError("server error", 500, "createFeedback"))).toBe(false);
    expect(isPermanentLangSmithImportError(new LangSmithHttpError("revoked key", 401, "listRuns"))).toBe(true);
    expect(isPermanentLangSmithImportError(new LangSmithIntegrationNotFoundError("int_missing"))).toBe(true);
    expect(isPermanentLangSmithImportError(new LangSmithCredentialsMissingError("int_missing"))).toBe(true);
    expect(isPermanentLangSmithImportError(new NoCurrentSkillError("proj_missing"))).toBe(true);
    expect(isPermanentLangSmithImportError(new Error("No skill version found for project: proj_missing"))).toBe(false);
    expect(isPermanentLangSmithImportError(new LangSmithHttpError("rate limited", 429, "listRuns"))).toBe(false);
  });
});

async function listRunsFrom(body: unknown) {
  const client = new LangSmithClient({
    apiKey: "ls_test_key",
    fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
  });
  return client.listRuns({ projectName: "Support Agent", limit: 1 });
}
