import { describe, expect, it } from "vitest";
import { LangfuseClient, LangfuseHttpError, langfuseTraceToTraceImport } from "../src/lib/langfuse.js";
import {
  LangfuseCredentialsMissingError,
  LangfuseIntegrationNotFoundError,
  NoCurrentSkillError
} from "../src/repository.js";
import { isPermanentLangfuseImportError } from "../src/workers/langfuse-import.js";

const trace = {
  id: "trace_123",
  name: "Support answer",
  input: { question: "Can I get a refund?" },
  output: { answer: "Yes." },
  timestamp: "2026-05-01T00:00:00.000Z",
  metadata: { tenant: "test" },
  userId: "user_123",
  sessionId: "session_123"
};

describe("Langfuse client", () => {
  it("normalizes a Langfuse trace into a trace import", () => {
    expect(langfuseTraceToTraceImport(trace)).toEqual({
      sourceTraceId: "trace_123",
      input: { question: "Can I get a refund?" },
      output: { answer: "Yes." },
      metadata: {
        source: "langfuse",
        name: "Support answer",
        timestamp: "2026-05-01T00:00:00.000Z",
        userId: "user_123",
        sessionId: "session_123",
        extra: { tenant: "test" }
      }
    });
  });

  it("accepts array, data, and traces response shapes", async () => {
    await expect(listTracesFrom([trace])).resolves.toHaveLength(1);
    await expect(listTracesFrom({ data: [trace] })).resolves.toHaveLength(1);
    await expect(listTracesFrom({ traces: [trace] })).resolves.toHaveLength(1);
  });

  it("posts Coeval verdicts as Langfuse scores", async () => {
    let captured: { url: string; init?: RequestInit | undefined } | undefined;
    const client = new LangfuseClient({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      endpointUrl: "https://example.langfuse.test/",
      fetchImpl: (async (input, init) => {
        captured = { url: String(input), init };
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });

    await client.createFeedback({
      feedbackId: "fsync_123",
      runId: "trace_123",
      key: "coeval_verdict",
      score: 0.8,
      value: "pass",
      comment: "accepted",
      sourceInfo: { judgeRunId: "judge_123" }
    });

    expect(captured?.url).toBe("https://example.langfuse.test/api/public/scores");
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.headers).toMatchObject({
      authorization: "Basic cGstbGYtdGVzdDpzay1sZi10ZXN0",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      id: "fsync_123",
      traceId: "trace_123",
      name: "coeval_verdict",
      value: 0.8,
      comment: "pass: accepted",
      metadata: {
        verdict: "pass",
        judgeRunId: "judge_123"
      }
    });
  });

  it("classifies Langfuse auth/not-found errors as permanent worker failures", () => {
    expect(isPermanentLangfuseImportError(new LangfuseHttpError("revoked key", 401, "listTraces"))).toBe(true);
    expect(isPermanentLangfuseImportError(new LangfuseIntegrationNotFoundError("int_missing"))).toBe(true);
    expect(isPermanentLangfuseImportError(new LangfuseCredentialsMissingError("int_missing"))).toBe(true);
    expect(isPermanentLangfuseImportError(new NoCurrentSkillError("proj_missing"))).toBe(true);
    expect(isPermanentLangfuseImportError(new LangfuseHttpError("rate limited", 429, "listTraces"))).toBe(false);
  });
});

async function listTracesFrom(body: unknown) {
  const client = new LangfuseClient({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
  });
  return client.listTraces({ limit: 1 });
}
