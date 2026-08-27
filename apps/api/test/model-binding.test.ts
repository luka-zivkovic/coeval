import { describe, expect, it } from "vitest";
import {
  ModelBindingInputSchema,
  ModelBindingSchema,
  normalizeJudgeProviderId,
  StoredModelBindingSchema,
  SkillVersionSchema
} from "@coeval/shared";

describe("model binding contract boundaries", () => {
  const outOfRuntimeContractBinding = {
    provider: "Anthropic",
    modelId: "claude-sonnet-4-6",
    modelVersion: "pinned-before-production",
    temperature: 2.5,
    topP: 1.5,
    baseUrl: "not-a-url"
  };

  it("keeps the frozen external contract permissive", () => {
    expect(ModelBindingSchema.parse(outOfRuntimeContractBinding)).toEqual(outOfRuntimeContractBinding);
  });

  it("rejects out-of-contract stored bindings", () => {
    expect(StoredModelBindingSchema.safeParse(outOfRuntimeContractBinding).success).toBe(false);
    expect(SkillVersionSchema.safeParse({
      id: "skillv_current",
      skillId: "skill_current",
      criterionVersionId: "criterionv_current",
      version: "1.0.0",
      status: "production",
      rubricMarkdown: "# Rubric",
      prompt: "Judge the trace.",
      modelBinding: outOfRuntimeContractBinding,
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
    }).success).toBe(false);
  });
});

describe("ModelBindingInput strictness", () => {
  it("normalizes provider casing and whitespace on the way in", () => {
    const parsed = ModelBindingInputSchema.parse({
      provider: " Anthropic ",
      modelId: "claude-sonnet-4-6",
      modelVersion: "claude-sonnet-4-6",
      temperature: 0
    });
    expect(parsed.provider).toBe("anthropic");
  });

  it("rejects out-of-contract new bindings", () => {
    expect(ModelBindingInputSchema.safeParse({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelVersion: "claude-sonnet-4-6",
      temperature: 2.5
    }).success).toBe(false);
    expect(ModelBindingInputSchema.safeParse({
      provider: "custom",
      modelId: "local-judge",
      modelVersion: "local-judge",
      temperature: 0
    }).success).toBe(false);
  });
});

describe("normalizeJudgeProviderId", () => {
  it("normalizes human-entered strings and maps unknowns to null", () => {
    expect(normalizeJudgeProviderId(" Anthropic ")).toBe("anthropic");
    expect(normalizeJudgeProviderId("OPENROUTER")).toBe("openrouter");
    expect(normalizeJudgeProviderId("mock")).toBe("mock");
    expect(normalizeJudgeProviderId("bedrock")).toBeNull();
  });
});
