import { createHash } from "node:crypto";
import {
  PROMPTED_VERDICT_PROTOCOLS,
  verdictProtocolRunsOn,
  type PromptedProviderId,
  type PromptedVerdictProtocolId
} from "../protocols/verdict-protocols.js";
import { EvaluatorCallError } from "./failure.js";

// The execution binding exactly as Rubrist's shared contract defines it
// (packages/shared/src/evaluator-execution.ts, ADR-0014 section 2). The audit
// package keeps no dependency on @rubrist/shared; an API type test holds the
// two equal.

export type ExecutionProviderId = PromptedProviderId | "typesafe";
export type VerdictProtocolId = PromptedVerdictProtocolId | "typed-question/v1";

export type ReasoningSettings =
  | {
      family: "anthropic";
      thinking: { type: "disabled" } | { type: "enabled"; budgetTokens: number } | { type: "adaptive" };
      effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
    }
  | { family: "openai"; effort: "none" | "minimal" | "low" | "medium" | "high" }
  | { family: "openrouter"; enabled: boolean; effort: "low" | "medium" | "high" | null; maxTokens: number | null };

export interface ExecutionBinding {
  provider: ExecutionProviderId;
  endpoint: { kind: "managed" } | { kind: "custom"; baseUrlDigest: string };
  modelId: string;
  modelVersion: string;
  sampling: { temperature: number | null; topP: number | null };
  reasoning: ReasoningSettings | null;
  outputTokenLimit: number | null;
  verdictProtocol: VerdictProtocolId;
  routing: { requireParameters: true; allowFallbacks: false } | null;
}

/** A binding the prompted adapters can run: its provider and protocol are prompted ones. */
export type PromptedExecutionBinding = ExecutionBinding & {
  provider: PromptedProviderId;
  verdictProtocol: PromptedVerdictProtocolId;
};

/** Managed endpoints, called exactly; nothing in the environment can redirect them. */
export const MANAGED_BASE_URLS = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1"
} as const;

/**
 * The digest a binding names a custom endpoint by (ADR-0014 section 2):
 * SHA-256 over the UTF-8 bytes of a domain-separation prefix and the base URL
 * exactly as configured. Same construction as the API's endpointBaseUrlDigest.
 */
export function endpointBaseUrlDigest(baseUrl: string): string {
  return `sha256:${createHash("sha256").update("rubrist/endpoint-base-url/v1\0", "utf8").update(baseUrl, "utf8").digest("hex")}`;
}

const REASONING_FAMILY: Record<PromptedProviderId, ReasoningSettings["family"] | null> = {
  mock: null,
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  custom: "openai"
};

function refuse(message: string): never {
  throw new EvaluatorCallError("internal", message, { physicalCall: false });
}

/**
 * Refuses, before any call, a binding the prompted adapters can't send
 * exactly. The shared schema validates bindings where they are saved; this
 * repeats the rules that would otherwise produce a different request.
 */
export function assertPromptedBinding(binding: ExecutionBinding): asserts binding is PromptedExecutionBinding {
  if (binding.provider === "typesafe" || binding.verdictProtocol === "typed-question/v1") {
    refuse("typed-question evaluators run on the typesafe provider, which the prompted adapters don't cover");
  }
  const protocol = binding.verdictProtocol;
  if (!(PROMPTED_VERDICT_PROTOCOLS as readonly string[]).includes(protocol) || !verdictProtocolRunsOn(protocol, binding.provider)) {
    refuse(`${protocol} is not a ${binding.provider} protocol`);
  }
  if (binding.reasoning !== null && binding.reasoning.family !== REASONING_FAMILY[binding.provider]) {
    refuse(`${binding.provider} has no ${binding.reasoning.family} reasoning shape`);
  }
  if ((binding.provider === "openrouter") !== (binding.routing !== null)) {
    refuse("OpenRouter bindings state their routing requirements; others have none");
  }
  if (binding.provider === "anthropic" && binding.outputTokenLimit === null) {
    refuse("Anthropic requires an output token limit");
  }
}

/**
 * The base URL a call goes to. A managed endpoint is the provider's own; a
 * custom one is the configured URL, and only when its digest is the one the
 * binding names, so evidence never names an endpoint the call didn't use.
 */
export function resolveEndpointBaseUrl(binding: PromptedExecutionBinding, customBaseUrl: string | null): string {
  if (binding.endpoint.kind === "managed") {
    if (customBaseUrl !== null) refuse("a managed endpoint takes no custom base URL");
    if (binding.provider === "custom" || binding.provider === "mock") refuse(`${binding.provider} bindings have no managed endpoint`);
    return MANAGED_BASE_URLS[binding.provider];
  }
  if (customBaseUrl === null) {
    throw new EvaluatorCallError("provider_unavailable", "the binding's custom endpoint has no configured base URL", { physicalCall: false });
  }
  if (endpointBaseUrlDigest(customBaseUrl) !== binding.endpoint.baseUrlDigest) {
    refuse("the configured base URL does not match the endpoint digest the binding names");
  }
  return customBaseUrl.replace(/\/+$/, "");
}
