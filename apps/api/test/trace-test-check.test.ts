import { describe, expect, it, vi } from "vitest";
import type { CreateTraceTestInput, TraceTestDetail, TraceTestValidation } from "@coeval/shared";
import { createApp } from "../src/app.js";
import type { TraceTestValidationRunner } from "../src/lib/trace-test-validator.js";
import { DemoRepository } from "../src/repository.js";

const projectId = "proj_langsmith_support";

const draft = (sourceCaseId: string, overrides: Partial<CreateTraceTestInput> = {}): CreateTraceTestInput => ({
  sourceCaseId,
  sourceScope: { responsePath: ["output"], turnIndexes: [0, 1], stepIndexes: [] },
  desiredBehavior: "Check eligibility before promising a refund.",
  scenario: "A customer asks for a refund.",
  expectedBehavior: "Check eligibility before stating the outcome.",
  mustDo: ["Check eligibility"],
  mustAvoid: ["Guarantee an unknown outcome"],
  goodExample: { text: "I will check eligibility first." },
  badExample: { text: "Your refund is guaranteed." },
  checker: { kind: "judge", label: "Refund behavior", metadata: {} },
  draftProvenance: { origin: "human", generatedFields: [], generator: null },
  ...overrides
});

async function createDraft(repository: DemoRepository, app: ReturnType<typeof createApp>, overrides: Partial<CreateTraceTestInput> = {}): Promise<TraceTestDetail> {
  const imported = await repository.importTrace(projectId, "manual", {
    sourceTraceId: `trace_check_${Math.random()}`,
    input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
    output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
    metadata: {}
  }, { ingestionPurpose: "analysis_eligible_manual" });
  const response = await app.request("/api/trace-tests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft(imported.caseId, overrides))
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { test: TraceTestDetail }).test;
}

describe("trace-test check API", () => {
  it("records versioned automated evidence and enables only the proven revision", async () => {
    const repository = new DemoRepository();
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const runner: TraceTestValidationRunner = async (input) => ({
      label: input.userPrompt.includes("Your refund is guaranteed.") ? "fail" : "pass",
      reason: "Compared with the observable requirements.",
      ...(input.userPrompt.includes("Your refund is guaranteed.")
        ? { usage: { inputTokens: 30, outputTokens: 5 } }
        : {})
    });
    const app = createApp(repository, { traceTestValidationRunner: runner });
    const test = await createDraft(repository, app, { badExample: { text: "An edited comparison response." } });

    const response = await app.request(`/api/trace-tests/${test.id}/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 })
    });
    expect(response.status).toBe(201);
    const validation = ((await response.json()) as { validation: TraceTestValidation }).validation;
    expect(validation).toMatchObject({
      revision: 1,
      status: "passed",
      method: "automated",
      diagnostic: null,
      evaluator: { provider: "anthropic", model: "claude-sonnet-4-6", version: "2026-04-15" },
      badEvidence: { output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] }, result: "fail", attempts: 1, usage: { inputTokens: 30, outputTokens: 5 } },
      goodEvidence: { output: { text: "I will check eligibility first." }, result: "pass", attempts: 1, usage: null }
    });

    const enable = await app.request(`/api/trace-tests/${test.id}/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, validationId: validation.id })
    });
    expect(enable.status).toBe(200);
    await expect(enable.json()).resolves.toMatchObject({ test: { lifecycle: "enabled", enabledRevision: 2 } });
  });

  it("treats the original response as the should-pass example for preserve journeys", async () => {
    const repository = new DemoRepository();
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const runner: TraceTestValidationRunner = async (input) => ({
      label: input.userPrompt.includes("Known bad comparison") ? "fail" : "pass",
      reason: "Compared the preserved response with a known-bad counterexample."
    });
    const app = createApp(repository, { traceTestValidationRunner: runner });
    const test = await createDraft(repository, app, {
      goodExample: { text: "An edited good example that must not replace the source." },
      badExample: { text: "Known bad comparison" },
      checker: { kind: "judge", label: "Preserve behavior", metadata: { journeyJob: "preserve" } }
    });

    const response = await app.request(`/api/trace-tests/${test.id}/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 })
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      validation: {
        status: "passed",
        badEvidence: { output: { text: "Known bad comparison" }, result: "fail" },
        goodEvidence: {
          output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
          result: "pass"
        }
      }
    });
  });

  it("detects always-pass behavior and refuses to enable it", async () => {
    const repository = new DemoRepository();
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const app = createApp(repository, {
      traceTestValidationRunner: async () => ({ label: "pass", reason: "The checker accepted the response." })
    });
    const test = await createDraft(repository, app);
    const response = await app.request(`/api/trace-tests/${test.id}/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 })
    });
    const validation = ((await response.json()) as { validation: TraceTestValidation }).validation;
    expect(validation).toMatchObject({ status: "non_discriminating", diagnostic: "always_pass" });

    const enable = await app.request(`/api/trace-tests/${test.id}/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, validationId: validation.id })
    });
    expect(enable.status).toBe(409);
  });

  it("records exhausted retries as evaluator errors, never behavior failures", async () => {
    const repository = new DemoRepository();
    await repository.setJudgeProviderKey(projectId, "anthropic", "test-key");
    const runner = vi.fn<TraceTestValidationRunner>(async () => { throw new Error("transient provider failure"); });
    const app = createApp(repository, { traceTestValidationRunner: runner });
    const test = await createDraft(repository, app);
    const response = await app.request(`/api/trace-tests/${test.id}/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 })
    });
    const validation = ((await response.json()) as { validation: TraceTestValidation }).validation;
    expect(validation).toMatchObject({
      status: "evaluator_error",
      badEvidence: { result: "evaluator_error", attempts: 2 },
      goodEvidence: { result: "evaluator_error", attempts: 2 }
    });
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("requires a reason and derives manual evidence from the saved revision", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const test = await createDraft(repository, app, { checker: { kind: "manual", label: "Human review", metadata: {} } });
    const tooShort = await app.request(`/api/trace-tests/${test.id}/validations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, badResult: "fail", goodResult: "pass", overrideReason: "because" })
    });
    expect(tooShort.status).toBe(400);

    const response = await app.request(`/api/trace-tests/${test.id}/validations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        badResult: "fail",
        goodResult: "pass",
        overrideReason: "The unwanted response invents an outcome while the good response checks eligibility.",
        badEvidence: { output: "spoofed" }
      })
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      validation: {
        status: "passed",
        method: "manual_override",
        badEvidence: { output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] }, result: "fail", attempts: 0 },
        goodEvidence: { output: { text: "I will check eligibility first." }, result: "pass", attempts: 0 }
      }
    });
  });
});
