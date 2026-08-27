import {
  type JudgeProviderAvailabilityItem,
  type JudgeProviderId
} from "@coeval/shared";

export interface JudgeProviderSelection {
  provider: JudgeProviderId;
  preservesBinding: boolean;
}

// Stored bindings and availability both use canonical provider identifiers.
export function resolveJudgeProviderSelection(
  storedProvider: JudgeProviderId,
  providerOptions: ReadonlyArray<JudgeProviderAvailabilityItem>
): JudgeProviderSelection {
  const currentOption = providerOptions.find((option) => option.provider === storedProvider);
  const provider = currentOption?.available
    ? currentOption.provider
    : providerOptions.find((option) => option.available)?.provider ?? "mock";

  return { provider, preservesBinding: provider === storedProvider };
}
