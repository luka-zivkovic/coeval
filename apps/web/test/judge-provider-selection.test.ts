import { describe, expect, it } from "vitest";
import type { JudgeProviderAvailabilityItem } from "@coeval/shared";
import { resolveJudgeProviderSelection } from "../src/lib/judge-provider-selection.js";

const providers: JudgeProviderAvailabilityItem[] = [
  {
    provider: "anthropic",
    label: "Anthropic",
    available: true,
    credentialSource: "project",
    modelSelection: "catalog"
  },
  {
    provider: "openai",
    label: "OpenAI",
    available: false,
    credentialSource: null,
    modelSelection: "catalog"
  }
];

describe("resolveJudgeProviderSelection", () => {
  it("preserves an available stored binding", () => {
    expect(resolveJudgeProviderSelection("anthropic", providers)).toEqual({
      provider: "anthropic",
      preservesBinding: true
    });
  });

  it("falls back without carrying a binding across providers", () => {
    expect(resolveJudgeProviderSelection("openai", providers)).toEqual({
      provider: "anthropic",
      preservesBinding: false
    });
  });
});
