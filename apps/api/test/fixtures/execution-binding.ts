import {
  SEEDED_DEFAULT_EXECUTION_BINDING,
  type ExecutionBinding,
  type ExecutionBindingInput,
  type ResolutionRecord
} from "@rubrist/shared";
import { EvaluatorCallError } from "@rubrist/audit/runtime";
import { resolveExecutionBinding } from "../../src/lib/evaluator-resolution.js";
import type { EvaluatorRuntimeVersion } from "../../src/lib/judge-provider.js";

// Execution bindings for tests (ADR-0014 section 2): the seeded default and
// the local mock, stored and as submitted.

export const SEEDED_BINDING: ExecutionBinding = structuredClone(SEEDED_DEFAULT_EXECUTION_BINDING);

export const MOCK_BINDING: ExecutionBinding = {
  provider: "mock",
  endpoint: { kind: "managed" },
  modelId: "mock-heuristic-v1",
  modelVersion: "mock-heuristic-v1",
  sampling: { temperature: null, topP: null },
  reasoning: null,
  outputTokenLimit: null,
  verdictProtocol: "mock/v1",
  routing: null
};

/** A binding as an API client submits it: a managed endpoint needs no conversion. */
export function bindingInput(binding: ExecutionBinding = SEEDED_BINDING, overrides: Partial<ExecutionBindingInput> = {}): ExecutionBindingInput {
  if (binding.endpoint.kind !== "managed") throw new Error("bindingInput takes a managed binding; pass a custom endpoint as an override");
  return { ...structuredClone(binding), endpoint: { kind: "managed" }, ...overrides };
}

/** What the judge runtime reads from an evaluator version. */
export function runtimeVersion(binding: ExecutionBinding, overrides: Partial<EvaluatorRuntimeVersion> = {}): EvaluatorRuntimeVersion {
  return {
    executionBinding: structuredClone(binding),
    customEndpointUrl: null,
    rubricMarkdown: "Pass grounded answers.",
    prompt: "Judge the trace against the review guide below.\n\n<review_guide>\n{{rubric_markdown}}\n</review_guide>",
    typedQuestion: null,
    decisionThreshold: null,
    ...overrides
  };
}

/**
 * A resolution record from a gate resolution in which the provider accepted
 * every probe: `resolved`, with any unset setting shown accepted.
 */
export async function resolvedRecordFor(binding: ExecutionBinding): Promise<ResolutionRecord> {
  return resolveExecutionBinding({
    binding,
    trigger: "gate",
    check: null,
    published: null,
    documentedDefault: null,
    credentialSource: "project",
    execute: async () => ({ usage: null }),
    now: new Date("2026-09-26T00:00:00.000Z")
  });
}

/**
 * A resolution record in which the model rejects the temperature parameter
 * itself: the saved request (which leaves it unset) is accepted, and the
 * temperature probe is refused naming the parameter.
 */
export async function temperatureRejectingRecordFor(binding: ExecutionBinding): Promise<ResolutionRecord> {
  return resolveExecutionBinding({
    binding,
    trigger: "gate",
    check: null,
    published: null,
    documentedDefault: null,
    credentialSource: "project",
    execute: async (probed) => {
      if (probed.sampling.temperature === null) return { usage: null };
      const message = "`temperature` is deprecated for this model.";
      throw new EvaluatorCallError("provider_rejected_request", message, {
        physicalCall: true,
        status: 400,
        providerError: { type: "invalid_request_error", code: null, param: null, message, raw: null, upstreamProvider: null }
      });
    },
    now: new Date("2026-09-26T00:00:00.000Z")
  });
}
