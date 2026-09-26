import { EvaluatorCallError } from "@rubrist/audit/runtime";
import type { ExecutionBinding, SkillVersion } from "@rubrist/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { skillDigest } from "../src/lib/assessment-receipt.js";
import { endpointBaseUrlDigest } from "../src/lib/evaluator-identity.js";
import {
  ExecutionBindingInputError,
  LegacyEvidenceUnsupportedError,
  executionBindingFromInput,
  executionBindingInputProblem,
  legacyModelBinding,
  verifiedEndpointUrl
} from "../src/lib/execution-binding.js";
import { createJudgeProvider, createStrictJudgeProvider } from "../src/lib/judge-provider.js";
import { DemoRepository } from "../src/repository.js";
import { recoverStaleEvalRunItemExecutions } from "../src/workers/eval-run.js";
import { isPermanentError } from "../src/workers/judge.js";
import { MOCK_BINDING, SEEDED_BINDING, bindingInput, runtimeVersion } from "./fixtures/execution-binding.js";

// The v2 binding switch (Batch 8D-2) and the temporary v1 evidence view that
// lasts until v2 evidence replaces it.

const PROJECT = "proj_langsmith_support";
const UNSET_TEMPERATURE: ExecutionBinding = { ...SEEDED_BINDING, sampling: { temperature: null, topP: null } };
const OVERRIDE_URL = "https://proxy.example/v1";
const OPENAI_OVERRIDE: ExecutionBinding = {
  ...SEEDED_BINDING,
  provider: "openai",
  endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(OVERRIDE_URL) },
  modelId: "gpt-5",
  modelVersion: "gpt-5",
  reasoning: null,
  outputTokenLimit: null,
  verdictProtocol: "openai.structured-output/v1"
};

const view = (executionBinding: ExecutionBinding, customEndpointUrl: string | null = null) => ({ executionBinding, customEndpointUrl });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_BASE_URL;
});

async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "transition" })
  });
  return (await response.json() as { key: string }).key;
}

describe("the temporary v1 evidence view", () => {
  it("states only bindings v1 can express, and says why it can't otherwise", () => {
    expect(legacyModelBinding(view(SEEDED_BINDING))).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", temperature: 0 });
    expect(legacyModelBinding(view(MOCK_BINDING))).toMatchObject({ provider: "mock", temperature: 0 });
    expect(legacyModelBinding(view(UNSET_TEMPERATURE))).toBeNull();
    expect(legacyModelBinding(view(OPENAI_OVERRIDE))).toBeNull();
    expect(() => skillDigest({ ...view(UNSET_TEMPERATURE) } as SkillVersion)).toThrow(LegacyEvidenceUnsupportedError);
  });
});

describe("release evidence refusal", () => {
  it("refuses a release-evidence batch before any trace or call when v1 can't state the binding", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);
    const created = await app.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rubricMarkdown: "Pass grounded answers.", prompt: "Judge the answer.", executionBinding: bindingInput(UNSET_TEMPERATURE) })
    });
    expect(created.status).toBe(201);
    const versionId = (await created.json() as { version: { id: string } }).version.id;

    const refused = await app.request("/api/v1/judge/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ purpose: "release_evidence", skillVersionId: versionId, items: [{ clientItemId: "a", input: { q: 1 }, output: { a: 1 }, metadata: {} }] })
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "v1_evidence_unsupported_binding" });
    expect((await repository.listEvalRuns(PROJECT)).filter((run) => run.skillVersionId === versionId)).toHaveLength(0);
  });

  it("refuses in the repository too, so no release run can end unable to mint its receipt", async () => {
    const repository = new DemoRepository();
    const version = await repository.createSkillVersion("skill_support_quality", {
      rubricMarkdown: "Pass grounded answers.",
      prompt: "Judge the answer.",
      executionBinding: bindingInput(UNSET_TEMPERATURE),
      outputSchema: { type: "object" },
      verdictKind: "binary",
      timeScope: "new"
    }, { projectId: PROJECT });
    await expect(repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: version.version.id,
      trigger: "release_evidence",
      items: []
    })).rejects.toBeInstanceOf(LegacyEvidenceUnsupportedError);
  });
});

describe("stale eval item recovery", () => {
  it("recovers every other item when one can't be recovered", async () => {
    const failed: string[] = [];
    const execution = (id: string) => ({
      projectId: "p", evalRunId: `run_${id}`, evalRunItemId: id, executionToken: `token_${id}`,
      providerCallStarted: true, providerCallReturned: false
    });
    const repository = {
      listStaleEvalRunItemExecutions: async () => [execution("poisoned"), execution("healthy")],
      failEvalRunItem: async (input: { evalRunItemId: string }) => {
        if (input.evalRunItemId === "poisoned") throw new LegacyEvidenceUnsupportedError("An assessment receipt v1");
        failed.push(input.evalRunItemId);
      }
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recoverStaleEvalRunItemExecutions(repository as never)).resolves.toBe(2);
    expect(failed).toEqual(["healthy"]);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});

describe("executor failures in the workers", () => {
  it.each([
    ["provider_rate_limit", true, false],
    ["provider_timeout", true, false],
    ["provider_unavailable", true, false],
    ["provider_transport", true, false],
    ["provider_unavailable", false, true],
    ["provider_rejected_request", true, true],
    ["provider_authentication", true, true],
    ["provider_protocol", true, true],
    ["invalid_evaluator_output", true, true],
    ["internal", false, true]
  ] as const)("%s (physical call %s) is permanent: %s", (kind, physicalCall, permanent) => {
    expect(isPermanentError(new EvaluatorCallError(kind, "x", { physicalCall }))).toBe(permanent);
  });
});

describe("the provider refuses what can't be sent, when it is built", () => {
  it("refuses an override-bound OpenAI version once the override is unset or changed, before any call", () => {
    const version = runtimeVersion(OPENAI_OVERRIDE);
    const unset = (() => { try { createStrictJudgeProvider(version, { apiKey: "sk-test" }); } catch (error) { return error; } })();
    expect(unset).toMatchObject({ failureKind: "provider_unavailable", physicalCall: false });
    process.env.OPENAI_BASE_URL = "https://elsewhere.example/v1";
    const changed = (() => { try { createStrictJudgeProvider(version, { apiKey: "sk-test" }); } catch (error) { return error; } })();
    expect(changed).toMatchObject({ failureKind: "internal", physicalCall: false });
    process.env.OPENAI_BASE_URL = OVERRIDE_URL;
    expect(createStrictJudgeProvider(version, { apiKey: "sk-test" }).name).toBe("openai");
    const badKey = (() => { try { createStrictJudgeProvider(version, { apiKey: "sk-a\nsk-b" }); } catch (error) { return error; } })();
    expect(badKey).toMatchObject({ failureKind: "provider_unavailable", physicalCall: false });
  });

  it("never applies OPENAI_BASE_URL to a managed OpenAI binding", async () => {
    process.env.OPENAI_BASE_URL = OVERRIDE_URL;
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: "c", model: "gpt-5", choices: [{ message: { content: JSON.stringify({ label: "pass", score: 0.9, rationale: "ok", failingStep: null }) }, finish_reason: "stop" }] }));
    });
    const managed: ExecutionBinding = { ...OPENAI_OVERRIDE, endpoint: { kind: "managed" } };
    await createJudgeProvider(runtimeVersion(managed), { apiKey: "sk-test" }).judgeStructured({
      prompt: { id: "p", name: "p", kind: "unified", content: "c" },
      trace: { id: "t", input: {}, output: {} },
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    });
    expect(urls).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });
});

describe("binding input at the API boundary", () => {
  it("refuses typed-question bindings until their definitions exist", async () => {
    expect(() => executionBindingFromInput({
      ...bindingInput(MOCK_BINDING), provider: "typesafe", verdictProtocol: "typed-question/v1"
    }, { openAIBaseUrl: null })).toThrow(/typed-question evaluators aren't available yet/);
    const app = createApp(new DemoRepository());
    const response = await app.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "r", prompt: "p",
        executionBinding: { ...bindingInput(MOCK_BINDING), provider: "typesafe", modelId: "jev-1.13.0", modelVersion: "jev-1.13.0", verdictProtocol: "typed-question/v1" }
      })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/^Invalid execution binding: /) });
  });

  it("takes canonical provider ids only, since the binding is identity", () => {
    expect(() => executionBindingFromInput({ ...bindingInput(MOCK_BINDING), provider: " Mock " as never }, { openAIBaseUrl: null })).toThrow(ExecutionBindingInputError);
  });

  it("checks the stored binding's rules, not just the input schema", () => {
    expect(executionBindingInputProblem(bindingInput(SEEDED_BINDING, { outputTokenLimit: null })))
      .toMatch(/^Invalid execution binding: /);
    expect(executionBindingInputProblem(bindingInput(MOCK_BINDING, { verdictProtocol: "anthropic.forced-tool/v1" })))
      .toMatch(/^Invalid execution binding: /);
    expect(executionBindingInputProblem(bindingInput(SEEDED_BINDING))).toBeNull();
  });

  it("parses the input schema, so a hand-built base URL with a query is refused", () => {
    expect(() => executionBindingFromInput({
      ...bindingInput(SEEDED_BINDING), provider: "custom", reasoning: null, verdictProtocol: "openai.forced-function/v1",
      endpoint: { kind: "custom", baseUrl: "https://llm.example/v1?key=secret" }
    }, { openAIBaseUrl: null })).toThrow(/no credentials, query, or fragment/);
  });

  it("checks a custom endpoint for auxiliary calls as the runtime does", () => {
    const url = "https://llm.example/v1";
    const custom: ExecutionBinding = { ...SEEDED_BINDING, provider: "custom", endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(url) }, reasoning: null, verdictProtocol: "openai.forced-function/v1" };
    expect(verifiedEndpointUrl(view(custom, url))).toEqual({ ok: true, baseUrl: url });
    expect(verifiedEndpointUrl(view(custom, "https://other.example/v1"))).toEqual({ ok: false });
    expect(verifiedEndpointUrl(view(OPENAI_OVERRIDE))).toEqual({ ok: false });
    expect(verifiedEndpointUrl(view(SEEDED_BINDING))).toEqual({ ok: true, baseUrl: null });
  });
});
