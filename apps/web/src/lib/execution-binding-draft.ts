import {
  defaultVerdictProtocol,
  documentedReasoningDefault,
  type ExecutionBinding,
  type ExecutionBindingInput,
  type JudgeProviderId,
  type SkillVersion
} from "@rubrist/shared";

// The editor's execution-binding fields (ADR-0014 section 2). Until the
// capability-driven model picker (Batch 8F), the editor edits the provider,
// model, custom endpoint, and temperature. The rest of the binding keeps the
// base version's settings while the provider and model stay the same, and
// otherwise starts from the family's deterministic protocol, the documented
// default reasoning, and Anthropic's required output token limit.

export interface ExecutionBindingFields {
  provider: JudgeProviderId;
  modelId: string;
  modelVersion: string;
  /** A custom provider's endpoint base URL; ignored for other providers. */
  baseUrl: string;
  /** Empty means temperature is not sent. */
  temperature: string;
}

export function executionBindingFields(version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">): Omit<ExecutionBindingFields, "provider"> {
  const binding = version.executionBinding;
  return {
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    baseUrl: version.customEndpointUrl ?? "",
    temperature: binding.sampling.temperature === null ? "" : String(binding.sampling.temperature)
  };
}

/** The binding the editor would save, or `null` while a field is invalid. */
export function executionBindingInputFromFields(
  fields: ExecutionBindingFields,
  base: ExecutionBinding | null
): ExecutionBindingInput | null {
  const modelId = fields.modelId.trim();
  const modelVersion = fields.modelVersion.trim();
  if (modelId.length === 0 || modelVersion.length === 0) return null;
  const takesSampling = fields.provider !== "mock";
  let temperature: number | null = null;
  if (takesSampling && fields.temperature.trim() !== "") {
    temperature = Number(fields.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return null;
  }
  const sameModel = base !== null && base.provider === fields.provider && base.modelId === modelId;
  const baseUrl = fields.baseUrl.trim();
  if (fields.provider === "custom" && baseUrl.length === 0) return null;
  return {
    provider: fields.provider,
    endpoint: fields.provider === "custom" ? { kind: "custom", baseUrl } : { kind: "managed" },
    modelId,
    modelVersion,
    sampling: { temperature, topP: sameModel && takesSampling ? base.sampling.topP : null },
    reasoning: sameModel ? base.reasoning : documentedReasoningDefault(fields.provider, modelId)?.reasoning ?? null,
    outputTokenLimit: sameModel ? base.outputTokenLimit : fields.provider === "anthropic" ? 1_200 : null,
    verdictProtocol: sameModel ? base.verdictProtocol : defaultVerdictProtocol(fields.provider),
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
  const sameEndpoint = endpoint.kind === "custom"
    ? savedEndpoint.kind === "custom" && version.customEndpointUrl === endpoint.baseUrl
    : savedEndpoint.kind === "managed";
  return sameEndpoint && JSON.stringify(stable(rest)) === JSON.stringify(stable(saved));
}
