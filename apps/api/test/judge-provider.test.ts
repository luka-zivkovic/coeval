import { describe, expect, it } from "vitest";
import { createJudgeProvider, createStrictJudgeProvider, judgeProviderAvailability, JudgeProviderUnavailableError } from "../src/lib/judge-provider.js";

describe("judge provider registry", () => {
  it("uses modelId as the runtime request target, not catalog-only modelVersion", () => {
    const provider = createJudgeProvider(
      { provider: "openai", modelId: "gpt-5-runtime-id", modelVersion: "catalog-record-2026-08", temperature: 0 },
      { apiKey: "openai-test-key" }
    );
    expect(provider.modelName).toBe("gpt-5-runtime-id");
    expect(provider.modelName).not.toBe("catalog-record-2026-08");
  });

  it("constructs OpenRouter and custom providers through the OpenAI-compatible runtime", () => {
    const openRouter = createJudgeProvider(
      { provider: "openrouter", modelId: "anthropic/claude", modelVersion: "anthropic/claude", temperature: 0 },
      { apiKey: "openrouter-test-key" }
    );
    const custom = createJudgeProvider(
      {
        provider: "custom",
        modelId: "local-judge",
        modelVersion: "local-judge",
        temperature: 0,
        baseUrl: "https://models.example.test/v1"
      },
      { apiKey: "custom-test-key" }
    );

    expect(openRouter.name).toBe("openrouter");
    expect(openRouter.modelName).toBe("anthropic/claude");
    expect(custom.name).toBe("custom");
    expect(custom.modelName).toBe("local-judge");
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

  it("dispatches canonical stored provider identifiers", () => {
    const anthropic = createJudgeProvider(
      { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", temperature: 0 },
      { apiKey: "sk-ant-test" }
    );
    expect(anthropic.name).toBe("anthropic");
    expect((anthropic as unknown as { requestPolicy: string }).requestPolicy).toBe("single_physical_call");

    const strict = createStrictJudgeProvider(
      { provider: "openrouter", modelId: "anthropic/claude", modelVersion: "anthropic/claude", temperature: 0 },
      { apiKey: "sk-or-test" }
    );
    expect(strict.name).toBe("openrouter");

    // Explicit mock remains valid on strict paths.
    expect(createStrictJudgeProvider(
      { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
    ).name).toBe("mock");
  });

  it("strict factory refuses a real-provider binding that would degrade to the mock", () => {
    expect(() =>
      createStrictJudgeProvider(
        // custom with no key has no environment fallback — the guaranteed
        // silent-degradation case if this were permissive.
        { provider: "custom", modelId: "local-judge", modelVersion: "local-judge", temperature: 0, baseUrl: "https://models.example.test/v1" }
      )
    ).toThrow(JudgeProviderUnavailableError);
  });
});
