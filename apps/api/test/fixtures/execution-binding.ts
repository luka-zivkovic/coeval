import {
  SEEDED_DEFAULT_EXECUTION_BINDING,
  type ExecutionBinding,
  type ExecutionBindingInput
} from "@rubrist/shared";
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
    ...overrides
  };
}
