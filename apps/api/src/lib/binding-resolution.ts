import type { ExecutionFetch, VerdictSpec } from "@rubrist/audit/runtime";
import {
  CapabilityCheckReportSchema,
  documentedReasoningDefault,
  reasoningFamilyFor,
  takesSamplingSettings,
  verdictProtocolsFor,
  type CapabilityCheckInput,
  type CapabilityCheckReport,
  type CapabilityProbe,
  type ExecutionBinding,
  type ExecutionProviderId,
  type JudgeProviderCredentialSource,
  type ResolutionRecord
} from "@rubrist/shared";
import { fetchPublishedCapabilities, type CapabilityFetch } from "./evaluator-capability.js";
import {
  governedGateProblems,
  recheckExecutionBinding,
  resolveExecutionBinding,
  runCapabilityCheck,
  bindingProbeExecutor
} from "./evaluator-resolution.js";
import { endpointBaseUrlDigest } from "./evaluator-identity.js";
import { endpointUrlFor, platformOpenAIBaseUrl } from "./execution-binding.js";
import { judgeProviderEnvironmentKey } from "./judge-provider.js";

// Resolution and re-check as the governed gates and runs use them (ADR-0014
// section 4): the probes run with the project's credential against the
// binding's own endpoint, outside any database transaction.

export interface BindingCredential {
  apiKey: string | null;
  source: JudgeProviderCredentialSource | null;
}

export interface BindingResolutionServices {
  /** The credential a call with this provider would use: the project's key, else the platform's. */
  credential(projectId: string, provider: ExecutionProviderId): Promise<BindingCredential>;
  fetch?: ExecutionFetch;
  capabilityFetch?: CapabilityFetch;
  now?: () => Date;
}

/**
 * Services over the credential a call would use (the project's key is
 * authoritative; the platform's applies only when the project has none), so
 * resolution probes exactly what execution sends.
 */
export function bindingResolutionServices(
  projectCredential: (projectId: string, provider: string) => Promise<string | null>,
  overrides: Omit<BindingResolutionServices, "credential"> = {}
): BindingResolutionServices {
  return {
    ...overrides,
    credential: async (projectId, provider) => {
      if (provider === "mock") return { apiKey: null, source: "built_in" };
      const project = await projectCredential(projectId, provider);
      if (project) return { apiKey: project, source: "project" };
      const platform = judgeProviderEnvironmentKey(provider);
      return platform ? { apiKey: platform, source: "environment" } : { apiKey: null, source: null };
    }
  };
}

/** A saved evaluator version's binding, as resolution and re-check read it. */
export interface GovernedBinding {
  projectId: string;
  executionBinding: ExecutionBinding;
  customEndpointUrl: string | null;
  spec: VerdictSpec;
}

async function probeContext(services: BindingResolutionServices, governed: GovernedBinding) {
  const binding = governed.executionBinding;
  const credential = binding.provider === "mock"
    ? { apiKey: null, source: "built_in" as const }
    : await services.credential(governed.projectId, binding.provider);
  const published = await fetchPublishedCapabilities({
    provider: binding.provider,
    modelId: binding.modelId,
    apiKey: credential.apiKey,
    ...(services.capabilityFetch ? { fetch: services.capabilityFetch } : {})
  });
  const execute = bindingProbeExecutor({
    apiKey: credential.apiKey,
    customBaseUrl: endpointUrlFor(governed),
    spec: governed.spec,
    ...(services.fetch ? { fetch: services.fetch } : {})
  });
  return {
    credential,
    published,
    documentedDefault: documentedReasoningDefault(binding.provider, binding.modelId)?.reasoning ?? null,
    execute
  };
}

/** Resolution at a governed gate: the confirming probe and, where unset, up to two setting probes. */
export async function resolveGovernedBinding(services: BindingResolutionServices, governed: GovernedBinding): Promise<ResolutionRecord> {
  return resolveBinding(services, governed, "gate");
}

/**
 * Resolution after save (ADR-0014 section 4): the confirming probe and, where
 * temperature is unset, a temperature probe, so at most 2 calls. It confirms
 * the saved binding and never changes it.
 */
export async function resolveSavedBinding(services: BindingResolutionServices, governed: GovernedBinding): Promise<ResolutionRecord> {
  return resolveBinding(services, governed, "save");
}

async function resolveBinding(services: BindingResolutionServices, governed: GovernedBinding, trigger: "save" | "gate"): Promise<ResolutionRecord> {
  const context = await probeContext(services, governed);
  return resolveExecutionBinding({
    binding: governed.executionBinding,
    trigger,
    check: null,
    published: context.published,
    documentedDefault: context.documentedDefault,
    credentialSource: context.credential.source,
    execute: context.execute,
    now: services.now?.() ?? new Date()
  });
}

export interface RecheckOutcome {
  /** `holds`, `no_longer_holds` (a definite answer), or `unknown` (a transient error or a call that couldn't be sent). */
  outcome: "holds" | "no_longer_holds" | "unknown";
  probes: CapabilityProbe[];
}

/**
 * The re-check before a governed run. A transient error can't show the
 * resolution holds, but it doesn't show it no longer holds either: the run
 * waits and is re-checked later.
 */
export async function recheckGovernedBinding(services: BindingResolutionServices, governed: GovernedBinding): Promise<RecheckOutcome> {
  const context = await probeContext(services, governed);
  const result = await recheckExecutionBinding({
    binding: governed.executionBinding,
    published: context.published,
    documentedDefault: context.documentedDefault,
    execute: context.execute
  });
  if (result.holds) return { outcome: "holds", probes: result.probes };
  const [confirm, ...settings] = result.probes;
  if (!confirm || confirm.outcome === "error") return { outcome: "unknown", probes: result.probes };
  if (confirm.outcome === "rejected") return { outcome: "no_longer_holds", probes: result.probes };
  // The saved request is still accepted. The resolution no longer holds once
  // any unset setting has a definite answer other than "the parameter is
  // rejected". A rejection Rubrist couldn't attribute only because the
  // provider's published capabilities couldn't be read is no such answer.
  const publishes = governed.executionBinding.provider === "anthropic" || governed.executionBinding.provider === "openrouter";
  const metadataMissing = publishes && context.published === null;
  const definite = settings.some((probe) => probe.outcome === "accepted" ||
    (probe.outcome === "rejected" && probe.rejection !== "parameter" && !(probe.rejection === "unattributed" && metadataMissing)));
  return { outcome: definite ? "no_longer_holds" : "unknown", probes: result.probes };
}

/**
 * Whether a gate should resolve the binding (again): no record yet, the
 * latest left it unresolved, or it resolved without an answer for a setting
 * the gate needs, because that probe failed transiently or was never sent. A
 * failed binding is fixed only by a new evaluator version.
 */
export function resolutionNeeded(binding: ExecutionBinding, record: ResolutionRecord | null): boolean {
  if (record === null || record.status === "unresolved") return true;
  if (record.status === "failed") return false;
  return unansweredSettings(binding, record).length > 0;
}

/** Unset settings the gate needs an answer for that the record doesn't have. */
function unansweredSettings(binding: ExecutionBinding, record: ResolutionRecord): Array<"temperature" | "reasoning"> {
  const unanswered: Array<"temperature" | "reasoning"> = [];
  if (takesSamplingSettings(binding.provider) && binding.sampling.temperature === null && record.temperatureSupport === null) {
    unanswered.push("temperature");
  }
  if (reasoningFamilyFor(binding.provider) !== null && binding.reasoning === null && record.reasoningSupport === null) {
    unanswered.push("reasoning");
  }
  return unanswered;
}

export interface GovernedGateRefusal {
  message: string;
  problems: string[];
  /** The provider's message from the confirming probe, where it rejected the saved request. */
  providerMessage: string | null;
  suggestion: string;
}

/**
 * Why a governed gate refuses a binding, with the suggestion ADR-0014 section 4
 * asks for: "leave it unset" only where the parameter itself was rejected,
 * "choose another value" where only a value was. `null` when the gate passes.
 */
export function governedGateRefusal(binding: ExecutionBinding, record: ResolutionRecord | null): GovernedGateRefusal | null {
  const problems = governedGateProblems(binding, record);
  if (problems.length === 0) return null;
  const confirm = record?.probes.find((probe) => probe.stage === "resolution" && probe.purpose === "confirm") ?? null;
  const rejected = confirm?.outcome === "rejected" ? confirm : null;
  let suggestion: string;
  if (rejected?.rejection === "parameter" && rejected.rejectedParameter !== null) {
    suggestion = `Save a new evaluator version that leaves ${rejected.rejectedParameter} unset.`;
  } else if (rejected?.rejection === "value" && rejected.rejectedParameter !== null) {
    suggestion = `Save a new evaluator version with another ${rejected.rejectedParameter} value.`;
  } else if (rejected?.rejection === "mechanism") {
    // A provider with one protocol (TypeSafe's typed-question/v1) has no other to choose.
    suggestion = verdictProtocolsFor(binding.provider).length > 1
      ? "Save a new evaluator version with another verdict protocol."
      : `${binding.provider}'s response broke its only verdict protocol; try again later, or choose another model.`;
  } else if (record?.status === "failed") {
    suggestion = "Save a new evaluator version with settings the model accepts.";
  } else if (record?.status !== "resolved") {
    suggestion = "Try again once the provider is reachable with a working credential.";
  } else if (unansweredSettings(binding, record).length > 0) {
    suggestion = `Try again: the model's answer about ${unansweredSettings(binding, record).join(" and ")} wasn't recorded, because its probe failed.`;
  } else {
    suggestion = "Save a new evaluator version that states its temperature and reasoning explicitly.";
  }
  return {
    message: `The execution binding can't pass a governed gate: ${problems.join("; ")}`,
    problems,
    providerMessage: rejected?.providerMessage ?? null,
    suggestion
  };
}

/** A capability check probes as a binary evaluator: the output mechanism, not the verdict kind, decides acceptance. */
const CHECK_SPEC: VerdictSpec = { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null };

/**
 * The capability check before save (ADR-0014 section 4), with the credential
 * and endpoint a saved binding would use: the project's key, else the
 * platform's, and for OpenAI on the managed endpoint the platform's base-URL
 * override, as saving records it. At most 6 probes, in sequence, over the
 * fixed probe input; it records nothing.
 */
export async function checkBindingCapabilities(
  services: BindingResolutionServices,
  projectId: string,
  input: CapabilityCheckInput
): Promise<CapabilityCheckReport> {
  const override = input.provider === "openai" && input.endpoint.kind === "managed" ? platformOpenAIBaseUrl() : null;
  const customBaseUrl = input.endpoint.kind === "custom" ? input.endpoint.baseUrl : override;
  const credential = input.provider === "mock"
    ? { apiKey: null, source: "built_in" as const }
    : await services.credential(projectId, input.provider);
  const published = await fetchPublishedCapabilities({
    provider: input.provider,
    modelId: input.modelId,
    apiKey: credential.apiKey,
    ...(services.capabilityFetch ? { fetch: services.capabilityFetch } : {})
  });
  const documentedDefault = documentedReasoningDefault(input.provider, input.modelId)?.reasoning ?? null;
  const check = await runCapabilityCheck({
    base: {
      provider: input.provider,
      endpoint: customBaseUrl === null ? { kind: "managed" } : { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(customBaseUrl) },
      modelId: input.modelId,
      modelVersion: input.modelVersion,
      outputTokenLimit: input.outputTokenLimit,
      routing: input.routing
    },
    credentialSource: credential.source,
    published,
    documentedDefault,
    execute: bindingProbeExecutor({
      apiKey: credential.apiKey,
      customBaseUrl,
      spec: CHECK_SPEC,
      ...(services.fetch ? { fetch: services.fetch } : {})
    })
  });
  return CapabilityCheckReportSchema.parse({
    credentialSource: credential.source,
    protocol: check.protocol,
    probes: check.probes,
    temperatureSupport: check.temperatureSupport,
    reasoningSupport: check.reasoningSupport,
    probedReasoning: check.probedReasoning,
    documentedDefault,
    published: published === null ? null : {
      temperature: published.temperature,
      topP: published.topP,
      reasoning: published.reasoning,
      thinkingTypes: published.thinkingTypes === null ? null : [...published.thinkingTypes],
      effortLevels: published.effortLevels === null ? null : [...published.effortLevels]
    },
    checkedAt: (services.now?.() ?? new Date()).toISOString()
  });
}
