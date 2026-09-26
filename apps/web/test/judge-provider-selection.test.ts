import { describe, expect, it } from "vitest";
import type { JudgeProviderAvailabilityItem } from "@rubrist/shared";
import { promptedProviderOptions, resolveJudgeProviderSelection } from "../src/lib/judge-provider-selection.js";

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

  it("keeps TypeSafe only for a typed version, and never falls back to it", () => {
    const typesafeOnly: JudgeProviderAvailabilityItem[] = [
      { provider: "anthropic", label: "Anthropic", available: false, credentialSource: null, modelSelection: "catalog" },
      { provider: "typesafe", label: "TypeSafe", available: true, credentialSource: "project", modelSelection: "custom" },
      { provider: "mock", label: "Mock (local testing)", available: false, credentialSource: "built_in", modelSelection: "catalog" }
    ];
    // A prompted version never moves onto TypeSafe, even when it is the only keyed provider.
    expect(resolveJudgeProviderSelection("anthropic", typesafeOnly)).toEqual({ provider: "mock", preservesBinding: false });
    // A typed version keeps TypeSafe in the editor, which offers every provider...
    expect(resolveJudgeProviderSelection("typesafe", typesafeOnly)).toEqual({ provider: "typesafe", preservesBinding: true });
    // ...but not in a flow that offers only prompted providers.
    expect(resolveJudgeProviderSelection("typesafe", promptedProviderOptions(typesafeOnly))).toEqual({ provider: "mock", preservesBinding: false });
    expect(promptedProviderOptions(typesafeOnly).map((option) => option.provider)).toEqual(["anthropic", "mock"]);
  });
});
