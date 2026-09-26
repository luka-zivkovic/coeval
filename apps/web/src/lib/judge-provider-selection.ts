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
 * runs only typed questions. Flows that author only prompted evaluators, such
 * as first-project setup, offer these.
 */
export function promptedProviderOptions(
  providerOptions: ReadonlyArray<JudgeProviderAvailabilityItem>
): JudgeProviderAvailabilityItem[] {
  return providerOptions.filter((option) => option.provider !== "typesafe");
}

// Stored bindings and availability both use canonical provider identifiers.
// The stored provider is kept while it is offered and available; otherwise
// the first available prompted provider is chosen, since TypeSafe runs only
// a typed question, which a version on another provider doesn't have.
export function resolveJudgeProviderSelection(
  storedProvider: JudgeProviderId,
  providerOptions: ReadonlyArray<JudgeProviderAvailabilityItem>
): JudgeProviderSelection {
  const currentOption = providerOptions.find((option) => option.provider === storedProvider);
  const provider = currentOption?.available
    ? currentOption.provider
    : promptedProviderOptions(providerOptions).find((option) => option.available)?.provider ?? "mock";

  return { provider, preservesBinding: provider === storedProvider };
}
