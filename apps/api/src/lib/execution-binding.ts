import {
  ExecutionBindingInputSchema,
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
 * result is validated with the stored binding's rules. Typed-question
 * bindings arrive with their definitions in Batch 8E, so none is accepted yet.
 */
export function executionBindingFromInput(
  raw: ExecutionBindingInput,
  platform: { openAIBaseUrl: string | null } = { openAIBaseUrl: platformOpenAIBaseUrl() }
): { executionBinding: ExecutionBinding; customEndpointUrl: string | null } {
  const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
    error.issues.map((issue) => `${issue.path.map(String).join(".") || "binding"}: ${issue.message}`).join("; ");
  const input = ExecutionBindingInputSchema.safeParse(raw);
  if (!input.success) throw new ExecutionBindingInputError(issues(input.error));
  if (input.data.provider === "typesafe" || input.data.verdictProtocol === "typed-question/v1") {
    throw new ExecutionBindingInputError("typed-question evaluators aren't available yet; bind a prompted evaluator to a prompted provider");
  }
  const { endpoint, ...rest } = input.data;
  let stored: ExecutionBinding["endpoint"];
  let customEndpointUrl: string | null = null;
  if (endpoint.kind === "custom") {
    if (input.data.provider !== "custom") {
      throw new ExecutionBindingInputError(
        `${input.data.provider} bindings can't name a custom endpoint; use the custom provider for an OpenAI-compatible endpoint`
      );
    }
    stored = { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(endpoint.baseUrl) };
    customEndpointUrl = endpoint.baseUrl;
  } else if (input.data.provider === "openai" && platform.openAIBaseUrl !== null) {
    stored = { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(platform.openAIBaseUrl) };
  } else {
    stored = { kind: "managed" };
  }
  const parsed = ExecutionBindingSchema.safeParse({ ...rest, endpoint: stored });
  if (!parsed.success) throw new ExecutionBindingInputError(issues(parsed.error));
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
 * The endpoint for calls outside the judge runtime (trace-test drafting and
 * validation), checked as the runtime checks it: a custom endpoint only at
 * the URL whose digest the binding names. A `null` base URL means managed.
 */
export function verifiedEndpointUrl(
  version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">
): { ok: true; baseUrl: string | null } | { ok: false } {
  const binding = version.executionBinding;
  if (binding.endpoint.kind === "managed") return { ok: true, baseUrl: null };
  const baseUrl = endpointUrlFor(version);
  return baseUrl !== null && endpointBaseUrlDigest(baseUrl) === binding.endpoint.baseUrlDigest
    ? { ok: true, baseUrl }
    : { ok: false };
}

/** v1 evidence can't state this version's binding (Batch 8D). */
export class LegacyEvidenceUnsupportedError extends Error {
  readonly code = "v1_evidence_unsupported_binding";

  constructor(what: string) {
    super(`${what} can't state this evaluator's execution binding; it needs an explicit temperature and a v1-expressible endpoint until v2 evidence replaces v1 (Batch 8D)`);
    this.name = "LegacyEvidenceUnsupportedError";
  }
}

/**
 * TEMPORARY (Batch 8D): the v1 model binding that v1 receipts and
 * skill-format exports still record, derived from the v2 binding. `null` when v1 can't state it: an unset temperature (the mock,
 * which takes no sampling, keeps v1's recorded 0), a typed-question
 * provider, or an OpenAI binding on a recorded override endpoint.
 *
 * It is lossy: v1 has no protocol, reasoning, output token limit, or
 * routing, so distinct v2 bindings can share a v1 view and a v1 skillDigest.
 * v2 evidence, which carries the whole binding, replaces it in 8D-5.
 */
export function legacyModelBinding(version: Pick<SkillVersion, "executionBinding" | "customEndpointUrl">): ModelBinding | null {
  const binding = version.executionBinding;
  const temperature = binding.provider === "mock" ? 0 : binding.sampling.temperature;
  if (temperature === null || binding.provider === "typesafe") return null;
  if (binding.provider === "openai" && binding.endpoint.kind === "custom") return null;
  return {
    provider: binding.provider,
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    temperature,
    ...(binding.sampling.topP !== null ? { topP: binding.sampling.topP } : {}),
    ...(binding.provider === "custom" && version.customEndpointUrl !== null ? { baseUrl: version.customEndpointUrl } : {})
  };
}
