import {
  defaultVerdictProtocol,
  documentedReasoningDefault,
  reasoningFamilyFor,
  takesSamplingSettings,
  verdictProtocolsFor,
  type ExecutionBinding,
  type ExecutionBindingInput,
  type JudgeProviderId,
  type ReasoningSettings,
  type SkillVersion,
  type VerdictProtocolId
} from "@rubrist/shared";

// The editor's execution-binding fields (ADR-0014 section 2). The model
// picker (Batch 8F) edits the provider, model, custom endpoint, temperature,
// reasoning, verdict protocol, and output token limit. A field the editor
// leaves out keeps the base version's setting while the provider and model
// stay the same, and otherwise starts from the family's deterministic
// protocol, the documented default reasoning, and Anthropic's required output
// token limit.

export interface ExecutionBindingFields {
  provider: JudgeProviderId;
  modelId: string;
  modelVersion: string;
  /** A custom provider's endpoint base URL; ignored for other providers. */
  baseUrl: string;
  /** Empty means temperature is not sent. */
  temperature: string;
  /** The reasoning chosen, `null` meaning not sent. */
  reasoning?: ReasoningSettings | null;
  verdictProtocol?: VerdictProtocolId;
  /** Empty means no output token limit is sent. */
  outputTokenLimit?: string;
}

export function executionBindingFields(version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">): Omit<ExecutionBindingFields, "provider"> {
  const binding = version.executionBinding;
  return {
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    baseUrl: version.customEndpointUrl ?? "",
    temperature: binding.sampling.temperature === null ? "" : String(binding.sampling.temperature),
    reasoning: binding.reasoning,
    verdictProtocol: binding.verdictProtocol,
    outputTokenLimit: binding.outputTokenLimit === null ? "" : String(binding.outputTokenLimit)
  };
}

/** The settings a new model starts from: the documented default reasoning, the family's deterministic protocol, and Anthropic's limit. */
export function defaultBindingSettings(provider: JudgeProviderId, modelId: string): Pick<Required<ExecutionBindingFields>, "reasoning" | "verdictProtocol" | "outputTokenLimit"> {
  return {
    reasoning: documentedReasoningDefault(provider, modelId)?.reasoning ?? null,
    verdictProtocol: defaultVerdictProtocol(provider),
    outputTokenLimit: provider === "anthropic" ? "1200" : ""
  };
}

/**
 * What's wrong with an output token limit as the author typed it, or `null`
 * when it can be saved. Anthropic requires a limit, and one above the
 * thinking budget, since the budget counts toward it.
 */
export function outputTokenLimitProblem(
  provider: JudgeProviderId,
  text: string,
  reasoning: ReasoningSettings | null = null
): string | null {
  if (!takesSamplingSettings(provider)) return null;
  const trimmed = text.trim();
  if (trimmed === "") return provider === "anthropic" ? "Anthropic requires an output token limit." : null;
  const limit = Number(trimmed);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) return "Enter a whole number of tokens from 1 to 1,000,000.";
  if (reasoning?.family === "anthropic" && reasoning.thinking.type === "enabled" && limit <= reasoning.thinking.budgetTokens) {
    return `The limit must exceed the thinking budget of ${reasoning.thinking.budgetTokens} tokens.`;
  }
  return null;
}

/** The binding the editor would save, or `null` while a field is invalid. */
export function executionBindingInputFromFields(
  fields: ExecutionBindingFields,
  base: ExecutionBinding | null
): ExecutionBindingInput | null {
  const modelId = fields.modelId.trim();
  const modelVersion = fields.modelVersion.trim();
  if (modelId.length === 0 || modelVersion.length === 0) return null;
  const takesSampling = takesSamplingSettings(fields.provider);
  let temperature: number | null = null;
  if (takesSampling && fields.temperature.trim() !== "") {
    temperature = Number(fields.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return null;
  }
  const sameModel = base !== null && base.provider === fields.provider && base.modelId === modelId;
  const defaults = defaultBindingSettings(fields.provider, modelId);
  const baseUrl = fields.baseUrl.trim();
  if (fields.provider === "custom" && baseUrl.length === 0) return null;

  const reasoning = fields.reasoning !== undefined ? fields.reasoning : sameModel ? base.reasoning : defaults.reasoning;
  if (reasoning !== null && reasoning.family !== reasoningFamilyFor(fields.provider)) return null;
  const verdictProtocol = fields.verdictProtocol ?? (sameModel ? base.verdictProtocol : defaults.verdictProtocol);
  if (!verdictProtocolsFor(fields.provider).includes(verdictProtocol)) return null;
  let outputTokenLimit: number | null;
  if (fields.outputTokenLimit !== undefined) {
    const text = fields.outputTokenLimit.trim();
    outputTokenLimit = text === "" ? null : Number(text);
    if (outputTokenLimit !== null && (!Number.isSafeInteger(outputTokenLimit) || outputTokenLimit < 1 || outputTokenLimit > 1_000_000)) return null;
  } else {
    outputTokenLimit = sameModel ? base.outputTokenLimit : fields.provider === "anthropic" ? 1_200 : null;
  }
  if (!takesSampling) outputTokenLimit = null;
  if (fields.provider === "anthropic" && outputTokenLimit === null) return null;
  if (reasoning?.family === "anthropic" && reasoning.thinking.type === "enabled" && outputTokenLimit !== null &&
    outputTokenLimit <= reasoning.thinking.budgetTokens) return null;

  return {
    provider: fields.provider,
    endpoint: fields.provider === "custom" ? { kind: "custom", baseUrl } : { kind: "managed" },
    modelId,
    modelVersion,
    sampling: { temperature, topP: sameModel && takesSampling ? base.sampling.topP : null },
    reasoning,
    outputTokenLimit,
    verdictProtocol,
    routing: fields.provider === "openrouter" ? { requireParameters: true, allowFallbacks: false } : null
  };
}

const stable = (value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
  : value;

/** Whether two versions state the same binding and endpoint. */
export function sameExecutionBinding(
  left: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">,
  right: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">
): boolean {
  return JSON.stringify(stable(left.executionBinding)) === JSON.stringify(stable(right.executionBinding)) &&
    left.customEndpointUrl === right.customEndpointUrl;
}

/**
 * Whether a submitted binding states what a saved version does. A custom
 * endpoint compares by its URL, since the saved binding names it by digest.
 */
export function inputMatchesVersion(input: ExecutionBindingInput, version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">): boolean {
  const { endpoint, ...rest } = input;
  const { endpoint: savedEndpoint, ...saved } = version.executionBinding;
  // An OpenAI binding saved on the platform override records it as a custom
  // endpoint with no URL of its own; the same managed input saves the same.
  const recordedOverride = rest.provider === "openai" && savedEndpoint.kind === "custom" && version.customEndpointUrl === null;
  const sameEndpoint = endpoint.kind === "custom"
    ? savedEndpoint.kind === "custom" && version.customEndpointUrl === endpoint.baseUrl
    : savedEndpoint.kind === "managed" || recordedOverride;
  return sameEndpoint && JSON.stringify(stable(rest)) === JSON.stringify(stable(saved));
}
