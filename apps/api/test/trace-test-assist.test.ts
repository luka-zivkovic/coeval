import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistTraceTestDraftResult } from "@coeval/shared";
import { createApp } from "../src/app.js";
import type { TraceTestDraftGeneratorInput } from "../src/lib/trace-test-drafter.js";
import { DemoRepository } from "../src/repository.js";

const projectId = "proj_langsmith_support";
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

async function source(repository: DemoRepository): Promise<string> {
  const imported = await repository.importTrace(projectId, "manual", {
    sourceTraceId: "conversation_assist_1",
    input: {
      messages: [
        { role: "system", content: "Use current policy." },
        { role: "user", content: "Can I get a refund?", password: "never-send" }
      ]
    },
    output: {
      messages: [{ role: "assistant", content: "Your refund is guaranteed.", apiKey: "never-send-either" }]
    },
    metadata: { channel: "support", authorization: "Bearer private" },
    steps: [{ name: "lookup", input: { token: "private", query: "refund" }, output: "eligibility unknown" }]
  }, { ingestionPurpose: "analysis_eligible_manual" });
  await repository.recordJudgeRun({
    projectId,
    caseId: imported.caseId,
    skillVersionId: "skillv_1_2_0",
    verdict: { label: "fail", score: 0.1, reason: "The response guarantees an unknown outcome.", confidence: 0.9 }
  });
  return imported.caseId;
}

function request(sourceCaseId: string, overrides: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceCaseId,
      sourceScope: {
        responsePath: ["output", "messages", 0, "content"],
        turnIndexes: [1, 2],
        stepIndexes: [0]
      },
      desiredBehavior: "Check eligibility before promising a refund.",
      job: "response",
      ...overrides
    })
  };
}

describe("assisted trace-test drafting API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  });

  it("falls back to the manual flow when provider credentials are missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const repository = new DemoRepository();
    const caseId = await source(repository);
    const generator = vi.fn();
    const response = await createApp(repository, { traceTestDraftGenerator: generator }).request(
      "/api/trace-tests/assist",
      request(caseId)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", reason: "missing_credentials" });
    expect(generator).not.toHaveBeenCalled();
  });

  it("sends only redacted selected evidence and returns auditable provenance", async () => {
    const repository = new DemoRepository();
    const caseId = await source(repository);
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const generator = vi.fn(async (_input: TraceTestDraftGeneratorInput) => ({
      scenario: "A customer asks for a refund.",
      expectedBehavior: "Check eligibility before stating an outcome.",
      mustDo: ["Check eligibility"],
      mustAvoid: ["Guarantee a refund"],
      goodExample: "I can check whether this qualifies.",
      badExample: "Your refund is guaranteed.",
      checkerKind: "judge",
      checkerLabel: "Refund behavior",
      checkerRationale: "Observable in the response.",
      inferredContext: ["Eligibility is not known from the selected evidence."]
    }));
    const response = await createApp(repository, { traceTestDraftGenerator: generator }).request(
      "/api/trace-tests/assist",
      request(caseId)
    );
    const result = await response.json() as AssistTraceTestDraftResult;

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      status: "generated",
      sourceScope: { responsePath: ["output", "messages", 0, "content"], turnIndexes: [1, 2], stepIndexes: [0] },
      draftProvenance: {
        origin: "generated",
        generator: { provider: "anthropic", model: "claude-sonnet-4-6", version: "2026-04-15" }
      }
    });
    expect(generator).toHaveBeenCalledOnce();
    const call = generator.mock.calls[0]![0];
    expect(call.systemPrompt).toContain("untrusted data");
    expect(call.userPrompt).toContain("Check eligibility before promising a refund.");
    expect(call.userPrompt).toContain("[REDACTED]");
    expect(call.userPrompt).not.toContain("never-send");
    expect(call.userPrompt).not.toContain("Use current policy.");
    expect(call.apiKey).toBe("test-key");
  });

  it("keeps provider and parse failures inside the manual fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = new DemoRepository();
    const caseId = await source(repository);
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const response = await createApp(repository, {
      traceTestDraftGenerator: async () => { throw new Error("provider secret diagnostic"); }
    }).request("/api/trace-tests/assist", request(caseId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", reason: "provider_error" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${projectId} using anthropic: invalid provider response`));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("provider secret diagnostic");

    const invalid = await createApp(repository, {
      traceTestDraftGenerator: async () => ({ scenario: "incomplete" })
    }).request("/api/trace-tests/assist", request(caseId));
    expect(invalid.status).toBe(200);
    await expect(invalid.json()).resolves.toMatchObject({ status: "unavailable", reason: "provider_error" });
  });

  it("classifies an aborted provider call as a safe timeout fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = new DemoRepository();
    const caseId = await source(repository);
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const response = await createApp(repository, {
      traceTestDraftGenerator: async () => { throw new DOMException("aborted", "AbortError"); }
    }).request("/api/trace-tests/assist", request(caseId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", reason: "provider_error" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("using anthropic: timeout"));
  });

  it("rejects a missing source and a stale scope before model use", async () => {
    const repository = new DemoRepository();
    const caseId = await source(repository);
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const generator = vi.fn();
    const app = createApp(repository, { traceTestDraftGenerator: generator });

    const missing = await app.request("/api/trace-tests/assist", request("case_from_another_project"));
    expect(missing.status).toBe(404);

    const stale = await app.request("/api/trace-tests/assist", request(caseId, {
      sourceScope: { responsePath: ["output", "messages", 0, "content"], turnIndexes: [99], stepIndexes: [] }
    }));
    expect(stale.status).toBe(409);
    expect(generator).not.toHaveBeenCalled();
  });
});
