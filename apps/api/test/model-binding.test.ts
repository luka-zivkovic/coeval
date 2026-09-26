import { describe, expect, it } from "vitest";
import {
  ExecutionBindingInputSchema,
  MUTABLE_MODEL_ALIAS_RULE_VERSION,
  mutableModelAlias,
  SkillVersionSchema
} from "@rubrist/shared";
import { endpointBaseUrlDigest } from "../src/lib/evaluator-identity.js";
import {
  ExecutionBindingInputError,
  endpointUrlFor,
  executionBindingFromInput,
  executionBindingInputProblem
} from "../src/lib/execution-binding.js";
import { SEEDED_BINDING, bindingInput } from "./fixtures/execution-binding.js";

describe("mutable model alias rule", () => {
  it.each([
    ["latest", "latest"], ["DEFAULT", "default"], [" auto ", "auto"], ["openrouter/auto", "auto"], ["openrouter/auto/", "auto"],
    ["claude-3-5-sonnet-latest", "-latest"], ["chatgpt-4o-latest", "-latest"], ["jev-latest", "-latest"],
    ["llama3:latest", ":latest"], ["anthropic/claude-sonnet-4.5:latest", ":latest"]
  ])("treats %s as the alias %s", (modelId, alias) => {
    expect(mutableModelAlias(modelId)).toBe(alias);
  });

  it.each([
    "gpt-4o", "gpt-4o-2024-08-06", "claude-sonnet-4-5-20250929", "claude-sonnet-4-5", "jev-1.13.0",
    "mock", "latest-model", "autopilot", "openai/gpt-4o", "default-v2", "my-latest-finetune"
  ])("does not treat %s as an alias under v1", (modelId) => {
    expect(mutableModelAlias(modelId)).toBeNull();
  });

  it("names its rule version", () => {
    expect(MUTABLE_MODEL_ALIAS_RULE_VERSION).toBe("rubrist-mutable-model-alias/v1");
  });
});

const VERSION = {
  id: "skillv_current",
  skillId: "skill_current",
  criterionVersionId: "criterionv_current",
  version: "1.0.0",
  status: "production",
  rubricMarkdown: "# Rubric",
  prompt: "Judge the trace.",
  executionBinding: SEEDED_BINDING,
  customEndpointUrl: null,
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
  regressionDatasetRevisionId: "revision_current",
  createdAt: "2026-01-01T00:00:00.000Z",
  approvedAt: null
};
const CUSTOM_URL = "https://models.example.test/v1";

describe("execution binding input (ADR-0014 section 2)", () => {
  it("accepts the seeded binding and rejects out-of-contract settings", () => {
    expect(ExecutionBindingInputSchema.parse(bindingInput())).toEqual(bindingInput());
    expect(ExecutionBindingInputSchema.safeParse(bindingInput(SEEDED_BINDING, { sampling: { temperature: 2.5, topP: null } })).success).toBe(false);
    expect(ExecutionBindingInputSchema.safeParse({ ...bindingInput(), provider: "typo-provider" }).success).toBe(false);
  });

  it.each([
    ["not a url", false],
    ["ftp://models.example.test/v1", false],
    ["https://user:secret@models.example.test/v1", false],
    ["https://models.example.test/v1?api-version=1", false],
    [CUSTOM_URL, true]
  ])("takes %s as a custom endpoint base URL: %s", (baseUrl, ok) => {
    const input = bindingInput(SEEDED_BINDING, { provider: "custom", endpoint: { kind: "custom", baseUrl }, reasoning: null, verdictProtocol: "openai.forced-function/v1" });
    expect(ExecutionBindingInputSchema.safeParse(input).success).toBe(ok);
  });

  it("names a custom endpoint by digest and keeps its URL beside the binding", () => {
    const input = bindingInput(SEEDED_BINDING, { provider: "custom", endpoint: { kind: "custom", baseUrl: CUSTOM_URL }, reasoning: null, outputTokenLimit: null, verdictProtocol: "openai.forced-function/v1" });
    const saved = executionBindingFromInput(input, { openAIBaseUrl: null });
    expect(saved.executionBinding.endpoint).toEqual({ kind: "custom", baseUrlDigest: endpointBaseUrlDigest(CUSTOM_URL) });
    expect(saved.customEndpointUrl).toBe(CUSTOM_URL);
    expect(endpointUrlFor(saved)).toBe(CUSTOM_URL);
  });

  it("records the platform's OpenAI override as the binding's endpoint instead of applying it implicitly", () => {
    const input = bindingInput(SEEDED_BINDING, { provider: "openai", modelId: "gpt-5", modelVersion: "gpt-5", reasoning: { family: "openai", effort: "low" }, verdictProtocol: "openai.structured-output/v1" });
    const withOverride = executionBindingFromInput(input, { openAIBaseUrl: "https://proxy.example/v1" });
    expect(withOverride).toMatchObject({ executionBinding: { endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest("https://proxy.example/v1") } }, customEndpointUrl: null });
    expect(executionBindingFromInput(input, { openAIBaseUrl: null }).executionBinding.endpoint).toEqual({ kind: "managed" });
  });

  it("refuses a binding the stored rules refuse, with a message that names why", () => {
    expect(() => executionBindingFromInput(bindingInput(SEEDED_BINDING, { endpoint: { kind: "custom", baseUrl: CUSTOM_URL } }), { openAIBaseUrl: null }))
      .toThrow(/anthropic bindings can't name a custom endpoint/);
    expect(() => executionBindingFromInput(bindingInput(SEEDED_BINDING, { outputTokenLimit: null }), { openAIBaseUrl: null }))
      .toThrow(ExecutionBindingInputError);
    expect(executionBindingInputProblem(bindingInput(SEEDED_BINDING, { verdictProtocol: "openai.structured-output/v1" })))
      .toMatch(/^Invalid execution binding: verdictProtocol: openai.structured-output\/v1 is not a anthropic protocol/);
  });
});

describe("evaluator version binding invariants", () => {
  it("keeps a custom endpoint's URL for custom bindings, and only for them", () => {
    expect(SkillVersionSchema.safeParse(VERSION).success).toBe(true);
    expect(SkillVersionSchema.safeParse({ ...VERSION, customEndpointUrl: CUSTOM_URL }).success).toBe(false);
    const custom = { ...SEEDED_BINDING, provider: "custom", endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(CUSTOM_URL) }, reasoning: null, verdictProtocol: "openai.forced-function/v1" };
    expect(SkillVersionSchema.safeParse({ ...VERSION, executionBinding: custom }).success).toBe(false);
    expect(SkillVersionSchema.safeParse({ ...VERSION, executionBinding: custom, customEndpointUrl: CUSTOM_URL }).success).toBe(true);
  });
});
