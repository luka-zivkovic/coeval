import { describe, expect, it } from "vitest";
import { SEEDED_DEFAULT_EXECUTION_BINDING, type ExecutionBinding } from "@rubrist/shared";
import {
  defaultBindingSettings,
  executionBindingFields,
  executionBindingInputFromFields,
  inputMatchesVersion,
  outputTokenLimitProblem,
  sameExecutionBinding
} from "../src/lib/execution-binding-draft.js";

const SEEDED: ExecutionBinding = structuredClone(SEEDED_DEFAULT_EXECUTION_BINDING);
const version = (executionBinding: ExecutionBinding, customEndpointUrl: string | null = null) => ({ executionBinding, customEndpointUrl });
// The provider, model, endpoint, and temperature; the picker's settings are
// left out, so they come from the base or the family's defaults.
const fields = (overrides: Partial<Parameters<typeof executionBindingInputFromFields>[0]> = {}) => {
  const { reasoning: _reasoning, verdictProtocol: _protocol, outputTokenLimit: _limit, ...basic } = executionBindingFields(version(SEEDED));
  return { provider: SEEDED.provider, ...basic, ...overrides };
};

describe("editor execution-binding fields", () => {
  it("saves a blank temperature as not sent", () => {
    expect(executionBindingInputFromFields(fields({ temperature: "" }), SEEDED)?.sampling).toEqual({ temperature: null, topP: null });
    expect(executionBindingInputFromFields(fields({ temperature: "0.4" }), SEEDED)?.sampling.temperature).toBe(0.4);
    expect(executionBindingInputFromFields(fields({ temperature: "3" }), SEEDED)).toBeNull();
    expect(executionBindingInputFromFields(fields({ temperature: "warm" }), SEEDED)).toBeNull();
  });

  it("sends no sampling for the mock, whatever the field holds", () => {
    const input = executionBindingInputFromFields(fields({ provider: "mock", modelId: "mock-judge", modelVersion: "v1", temperature: "0.7" }), SEEDED);
    expect(input).toMatchObject({ provider: "mock", sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "mock/v1" });
  });

  it("keeps the base settings for the same model, and starts a new model from its family's defaults", () => {
    const base: ExecutionBinding = { ...SEEDED, outputTokenLimit: 4_000, sampling: { temperature: 0, topP: 0.9 } };
    const same = executionBindingInputFromFields(fields({ temperature: "0" }), base);
    expect(same).toMatchObject({ reasoning: base.reasoning, outputTokenLimit: 4_000, verdictProtocol: base.verdictProtocol, sampling: { topP: 0.9 } });

    const other = executionBindingInputFromFields(fields({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6", modelVersion: "anthropic/claude-sonnet-4.6" }), base);
    expect(other).toMatchObject({
      provider: "openrouter",
      outputTokenLimit: null,
      verdictProtocol: "openai.structured-output/v1",
      routing: { requireParameters: true, allowFallbacks: false },
      sampling: { topP: null }
    });
  });

  it("needs a base URL for a custom endpoint", () => {
    const custom = fields({ provider: "custom", modelId: "llama", modelVersion: "llama", baseUrl: " " });
    expect(executionBindingInputFromFields(custom, SEEDED)).toBeNull();
    expect(executionBindingInputFromFields({ ...custom, baseUrl: "https://llm.example/v1" }, SEEDED)?.endpoint)
      .toEqual({ kind: "custom", baseUrl: "https://llm.example/v1" });
  });

  it("recognizes a submitted binding as the saved version's, including the recorded OpenAI override", () => {
    const input = executionBindingInputFromFields(fields(), SEEDED)!;
    expect(inputMatchesVersion(input, version(SEEDED))).toBe(true);
    expect(inputMatchesVersion({ ...input, sampling: { temperature: 1, topP: null } }, version(SEEDED))).toBe(false);

    const openai: ExecutionBinding = { ...SEEDED, provider: "openai", modelId: "gpt-5", modelVersion: "gpt-5", reasoning: null, outputTokenLimit: null, verdictProtocol: "openai.structured-output/v1" };
    const overridden = version({ ...openai, endpoint: { kind: "custom", baseUrlDigest: `sha256:${"a".repeat(64)}` } });
    const { endpoint: _endpoint, ...rest } = openai;
    expect(inputMatchesVersion({ ...rest, endpoint: { kind: "managed" } }, overridden)).toBe(true);

    const customBinding: ExecutionBinding = { ...openai, provider: "custom", endpoint: { kind: "custom", baseUrlDigest: `sha256:${"b".repeat(64)}` } };
    const custom = version(customBinding, "https://llm.example/v1");
    expect(inputMatchesVersion({ ...rest, provider: "custom", endpoint: { kind: "custom", baseUrl: "https://llm.example/v1" } }, custom)).toBe(true);
    expect(inputMatchesVersion({ ...rest, provider: "custom", endpoint: { kind: "custom", baseUrl: "https://other.example/v1" } }, custom)).toBe(false);
  });

  it("reads a saved version's picker settings back as fields, and saves them unchanged", () => {
    const read = executionBindingFields(version(SEEDED));
    expect(read).toMatchObject({ reasoning: SEEDED.reasoning, verdictProtocol: SEEDED.verdictProtocol, outputTokenLimit: String(SEEDED.outputTokenLimit) });
    expect(inputMatchesVersion(executionBindingInputFromFields({ provider: SEEDED.provider, ...read }, SEEDED)!, version(SEEDED))).toBe(true);
  });

  it("saves the reasoning, protocol, and output limit the author picks, and refuses ones the provider can't take", () => {
    const picked = executionBindingInputFromFields(fields({
      reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: null },
      verdictProtocol: "anthropic.forced-tool/v1",
      outputTokenLimit: "2000"
    }), SEEDED);
    expect(picked).toMatchObject({
      reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: null },
      verdictProtocol: "anthropic.forced-tool/v1",
      outputTokenLimit: 2_000
    });
    expect(executionBindingInputFromFields(fields({ reasoning: null }), SEEDED)?.reasoning).toBeNull();
    // Another family's reasoning, another provider's protocol, a bad limit, and no limit for Anthropic.
    expect(executionBindingInputFromFields(fields({ reasoning: { family: "openai", effort: "low" } }), SEEDED)).toBeNull();
    expect(executionBindingInputFromFields(fields({ verdictProtocol: "openai.structured-output/v1" }), SEEDED)).toBeNull();
    expect(executionBindingInputFromFields(fields({ outputTokenLimit: "0" }), SEEDED)).toBeNull();
    expect(executionBindingInputFromFields(fields({ outputTokenLimit: "" }), SEEDED)).toBeNull();
    // Anthropic counts the thinking budget toward the limit.
    const budget = { family: "anthropic" as const, thinking: { type: "enabled" as const, budgetTokens: 2_048 }, effort: null };
    expect(executionBindingInputFromFields(fields({ reasoning: budget, outputTokenLimit: "2048" }), SEEDED)).toBeNull();
    expect(executionBindingInputFromFields(fields({ reasoning: budget, outputTokenLimit: "4096" }), SEEDED)?.outputTokenLimit).toBe(4_096);
  });

  it("states what's wrong with an output token limit", () => {
    expect(outputTokenLimitProblem("anthropic", "")).toBe("Anthropic requires an output token limit.");
    expect(outputTokenLimitProblem("openai", "")).toBeNull();
    for (const text of ["0", "1.5", "abc", "1000001"]) {
      expect(outputTokenLimitProblem("openai", text), text).toBe("Enter a whole number of tokens from 1 to 1,000,000.");
    }
    expect(outputTokenLimitProblem("anthropic", "1024", { family: "anthropic", thinking: { type: "enabled", budgetTokens: 1_024 }, effort: null }))
      .toBe("The limit must exceed the thinking budget of 1024 tokens.");
    expect(outputTokenLimitProblem("mock", "abc")).toBeNull();
  });

  it("starts a new model from its documented default reasoning, or none where the table has no entry", () => {
    expect(defaultBindingSettings("anthropic", "claude-opus-5-5")).toMatchObject({
      reasoning: { family: "anthropic", thinking: { type: "adaptive" } }, outputTokenLimit: "1200"
    });
    expect(defaultBindingSettings("openai", "gpt-unlisted")).toEqual({
      reasoning: null, verdictProtocol: "openai.structured-output/v1", outputTokenLimit: ""
    });
  });

  it("compares saved bindings regardless of key order", () => {
    const reordered = Object.fromEntries(Object.entries(SEEDED).reverse()) as ExecutionBinding;
    expect(sameExecutionBinding(version(SEEDED), version(reordered))).toBe(true);
    expect(sameExecutionBinding(version(SEEDED), version({ ...SEEDED, outputTokenLimit: 900 }))).toBe(false);
  });
});
