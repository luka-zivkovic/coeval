import {
  ExecutionBindingSchema,
  type ExecutionBinding,
  type ExecutionBindingInput,
  type ModelBinding,
  type SkillVersion
} from "@rubrist/shared";
import { endpointBaseUrlDigest } from "./evaluator-identity.js";

// Execution bindings at the API boundary (ADR-0014 section 2). An author names
// a custom endpoint by its URL; the saved binding names it only by digest, and
// the URL stays beside it, outside identity and evidence.

export class ExecutionBindingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionBindingInputError";
  }
}

/** The platform's OpenAI base-URL override, recorded in a binding rather than applied implicitly. */
export function platformOpenAIBaseUrl(): string | null {
  return process.env.OPENAI_BASE_URL?.trim() || null;
}

/**
 * The saved form of a submitted binding. A custom provider's URL is named by
 * digest and kept beside the binding. An OpenAI binding on the managed
 * endpoint records the platform's OPENAI_BASE_URL override, when one is set,
 * as its custom endpoint: evidence names the endpoint the calls reach. The
 * result is validated with the stored binding's rules.
 */
export function executionBindingFromInput(
  input: ExecutionBindingInput,
  platform: { openAIBaseUrl: string | null } = { openAIBaseUrl: platformOpenAIBaseUrl() }
): { executionBinding: ExecutionBinding; customEndpointUrl: string | null } {
  const { endpoint, ...rest } = input;
  let stored: ExecutionBinding["endpoint"];
  let customEndpointUrl: string | null = null;
  if (endpoint.kind === "custom") {
    if (input.provider !== "custom") {
      throw new ExecutionBindingInputError(
        `${input.provider} bindings can't name a custom endpoint; use the custom provider for an OpenAI-compatible endpoint`
      );
    }
    stored = { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(endpoint.baseUrl) };
    customEndpointUrl = endpoint.baseUrl;
  } else if (input.provider === "openai" && platform.openAIBaseUrl !== null) {
    stored = { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(platform.openAIBaseUrl) };
  } else {
    stored = { kind: "managed" };
  }
  const parsed = ExecutionBindingSchema.safeParse({ ...rest, endpoint: stored });
  if (!parsed.success) {
    throw new ExecutionBindingInputError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "binding"}: ${issue.message}`).join("; "));
  }
  return { executionBinding: parsed.data, customEndpointUrl };
}

/** Why a submitted binding can't be saved, for a 400; `null` when it can. */
export function executionBindingInputProblem(input: ExecutionBindingInput): string | null {
  try {
    executionBindingFromInput(input);
    return null;
  } catch (error) {
    if (error instanceof ExecutionBindingInputError) return `Invalid execution binding: ${error.message}`;
    throw error;
  }
}

/**
 * The configured base URL a version's calls go to: the custom provider's own,
 * the platform override an OpenAI binding recorded, or `null` for a managed
 * endpoint. The judge runtime refuses it unless its digest is the one the
 * binding names.
 */
export function endpointUrlFor(version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">): string | null {
  const binding = version.executionBinding;
  if (binding.endpoint.kind === "managed") return null;
  return binding.provider === "custom" ? version.customEndpointUrl : platformOpenAIBaseUrl();
}

/**
 * TEMPORARY (Batch 8D): the v1 model binding that v1 receipts, calibration,
 * suite manifests, and skill-format exports still record, derived from the
 * v2 binding. `null` when v1 can't state it, because v1 requires a
 * temperature and knows no typed-question provider. The mock, which takes
 * no sampling, keeps v1's recorded temperature of 0. Deleted with the v1
 * evidence code in 8D-4 and 8D-5.
 */
export function legacyModelBinding(version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">): ModelBinding | null {
  const binding = version.executionBinding;
  const temperature = binding.provider === "mock" ? 0 : binding.sampling.temperature;
  if (temperature === null || binding.provider === "typesafe") return null;
  return {
    provider: binding.provider,
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    temperature,
    ...(binding.sampling.topP !== null ? { topP: binding.sampling.topP } : {}),
    ...(binding.provider === "custom" && version.customEndpointUrl !== null ? { baseUrl: version.customEndpointUrl } : {})
  };
}
