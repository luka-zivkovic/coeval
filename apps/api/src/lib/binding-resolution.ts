import type { ExecutionFetch, VerdictSpec } from "@rubrist/audit/runtime";
import {
  documentedReasoningDefault,
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
  verdictProbeExecutor
} from "./evaluator-resolution.js";
import { endpointUrlFor } from "./execution-binding.js";
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
      if (provider === "typesafe") return { apiKey: null, source: null };
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
  const execute = verdictProbeExecutor({
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
  const context = await probeContext(services, governed);
  return resolveExecutionBinding({
    binding: governed.executionBinding,
    trigger: "gate",
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
  const unknown = result.probes.length === 0 || result.probes.some((probe) => probe.outcome === "error");
  return { outcome: unknown ? "unknown" : "no_longer_holds", probes: result.probes };
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
    suggestion = "Save a new evaluator version with another verdict protocol.";
  } else if (record?.status === "failed") {
    suggestion = "Save a new evaluator version with settings the model accepts.";
  } else if (record?.status !== "resolved") {
    suggestion = "Try again once the provider is reachable with a working credential.";
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
