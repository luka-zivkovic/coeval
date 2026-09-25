import type { ExecutionBinding } from "@rubrist/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointBaseUrlDigest } from "../src/lib/evaluator-identity.js";
import { createJudgeProvider, createStrictJudgeProvider, judgeProviderAvailability, JudgeProviderUnavailableError, structuredVerdictToLegacy } from "../src/lib/judge-provider.js";
import { MOCK_BINDING, SEEDED_BINDING, runtimeVersion } from "./fixtures/execution-binding.js";

const CUSTOM_URL = "https://models.example.test/v1";
const CUSTOM: ExecutionBinding = {
  ...MOCK_BINDING,
  provider: "custom",
  endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(CUSTOM_URL) },
  modelId: "local-judge",
  modelVersion: "local-judge",
  sampling: { temperature: 0, topP: null },
  verdictProtocol: "openai.forced-function/v1"
};
const OPENROUTER: ExecutionBinding = {
  ...CUSTOM,
  provider: "openrouter",
  endpoint: { kind: "managed" },
  modelId: "anthropic/claude",
  modelVersion: "anthropic/claude",
  routing: { requireParameters: true, allowFallbacks: false }
};

describe("judge provider registry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_BASE_URL;
  });

  it("names the provider and the model id the binding pins", () => {
    const openai = createJudgeProvider(runtimeVersion({ ...SEEDED_BINDING, provider: "openai", modelId: "gpt-5-runtime-id", modelVersion: "catalog-record-2026-08", reasoning: null, verdictProtocol: "openai.structured-output/v1" }), { apiKey: "openai-test-key" });
    expect(openai.name).toBe("openai");
    expect(openai.modelName).toBe("gpt-5-runtime-id");
    const openRouter = createJudgeProvider(runtimeVersion(OPENROUTER), { apiKey: "openrouter-test-key" });
    const custom = createJudgeProvider(runtimeVersion(CUSTOM, { customEndpointUrl: CUSTOM_URL }), { apiKey: "custom-test-key" });
    expect([openRouter.name, openRouter.modelName]).toEqual(["openrouter", "anthropic/claude"]);
    expect([custom.name, custom.modelName]).toEqual(["custom", "local-judge"]);
  });

  it("judges through the v2 executor, sending exactly the binding to the endpoint it names", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify({
        id: "chatcmpl_1", model: "local-judge",
        choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "submit_verdict", arguments: JSON.stringify({ label: "pass", score: 0.9, rationale: "Grounded." }) } }] }, finish_reason: "tool_calls" }]
      }));
    });
    process.env.OPENAI_BASE_URL = "https://ignored.example/v1";
    const version = runtimeVersion(CUSTOM, { customEndpointUrl: CUSTOM_URL });
    const provider = createJudgeProvider(version, { apiKey: "custom-test-key" });
    const result = await provider.judgeStructured({
      prompt: { id: "p", name: "p", kind: "unified", content: "ignored: the protocol renders the version's own prompt" },
      trace: { id: "t1", input: { q: "Refund?" }, output: { a: "Yes." } },
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    });
    expect(result.verdict).toMatchObject({ kind: "binary", label: "pass" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://models.example.test/v1/chat/completions");
    expect(requests[0]!.body).toMatchObject({ model: "local-judge", temperature: 0, tool_choice: { type: "function", function: { name: "submit_verdict" } } });
    expect(requests[0]!.body).not.toHaveProperty("top_p");
    expect(JSON.stringify(requests[0]!.body)).toContain("Pass grounded answers.");
  });

  it("reports project credential sources without exposing keys", () => {
    const availability = judgeProviderAvailability(new Set(["openrouter", "custom"]));
    expect(availability.find((item) => item.provider === "openrouter")).toMatchObject({
      available: true,
      credentialSource: "project",
      modelSelection: "catalog"
    });
    expect(availability.find((item) => item.provider === "custom")).toMatchObject({
      available: true,
      credentialSource: "project",
      modelSelection: "custom"
    });
    expect(availability.find((item) => item.provider === "mock")).toMatchObject({
      available: true,
      credentialSource: "built_in"
    });
    expect(judgeProviderAvailability(undefined, false).find((item) => item.provider === "mock")?.available).toBe(false);
  });

  it("keeps an explicit mock valid on strict paths", () => {
    expect(createStrictJudgeProvider(runtimeVersion(OPENROUTER), { apiKey: "sk-or-test" }).name).toBe("openrouter");
    expect(createStrictJudgeProvider(runtimeVersion(MOCK_BINDING)).name).toBe("mock");
  });

  it("strict factory refuses a real-provider binding that would degrade to the mock", () => {
    // custom with no key has no environment fallback — the guaranteed
    // silent-degradation case if this were permissive.
    expect(() => createStrictJudgeProvider(runtimeVersion(CUSTOM, { customEndpointUrl: CUSTOM_URL }))).toThrow(JudgeProviderUnavailableError);
  });
});

describe("structuredVerdictToLegacy", () => {
  it("keeps the binary score as P(pass) and reports confidence in the returned label", () => {
    const verdict = (label: "pass" | "fail" | "ambiguous", score: number) =>
      structuredVerdictToLegacy({ kind: "binary", label, score, rationale: "r" });
    expect(verdict("pass", 0.9)).toMatchObject({ label: "pass", score: 0.9, confidence: 0.9 });
    expect(verdict("fail", 0.1)).toMatchObject({ label: "fail", score: 0.1, confidence: 0.9 });
    expect(verdict("ambiguous", 0.5)).toMatchObject({ score: 0.5, confidence: 0.5 });
  });
});
