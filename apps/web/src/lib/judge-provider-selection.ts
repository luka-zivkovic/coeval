import {
  type JudgeProviderAvailabilityItem,
  type JudgeProviderId
} from "@rubrist/shared";

export interface JudgeProviderSelection {
  provider: JudgeProviderId;
  preservesBinding: boolean;
}

/**
 * The providers a prompted evaluator can run on: every one but TypeSafe, which
 * runs only typed questions (their authoring arrives in Batch 8F).
 */
export function promptedProviderOptions(
  providerOptions: ReadonlyArray<JudgeProviderAvailabilityItem>
): JudgeProviderAvailabilityItem[] {
  return providerOptions.filter((option) => option.provider !== "typesafe");
}

// Stored bindings and availability both use canonical provider identifiers.
// Only a prompted provider is ever chosen, even from unfiltered availability.
export function resolveJudgeProviderSelection(
  storedProvider: JudgeProviderId,
  providerOptions: ReadonlyArray<JudgeProviderAvailabilityItem>
): JudgeProviderSelection {
  const prompted = promptedProviderOptions(providerOptions);
  const currentOption = prompted.find((option) => option.provider === storedProvider);
  const provider = currentOption?.available
    ? currentOption.provider
    : prompted.find((option) => option.available)?.provider ?? "mock";

  return { provider, preservesBinding: provider === storedProvider };
}
