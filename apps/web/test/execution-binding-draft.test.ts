import { describe, expect, it } from "vitest";
import { SEEDED_DEFAULT_EXECUTION_BINDING, type ExecutionBinding } from "@rubrist/shared";
import {
  executionBindingFields,
  executionBindingInputFromFields,
  inputMatchesVersion,
  sameExecutionBinding
} from "../src/lib/execution-binding-draft.js";

const SEEDED: ExecutionBinding = structuredClone(SEEDED_DEFAULT_EXECUTION_BINDING);
const version = (executionBinding: ExecutionBinding, customEndpointUrl: string | null = null) => ({ executionBinding, customEndpointUrl });
const fields = (overrides: Partial<Parameters<typeof executionBindingInputFromFields>[0]> = {}) => ({
  provider: SEEDED.provider,
  ...executionBindingFields(version(SEEDED)),
  ...overrides
});

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

  it("compares saved bindings regardless of key order", () => {
    const reordered = Object.fromEntries(Object.entries(SEEDED).reverse()) as ExecutionBinding;
    expect(sameExecutionBinding(version(SEEDED), version(reordered))).toBe(true);
    expect(sameExecutionBinding(version(SEEDED), version({ ...SEEDED, outputTokenLimit: 900 }))).toBe(false);
  });
});
