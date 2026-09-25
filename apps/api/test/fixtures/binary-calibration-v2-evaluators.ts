import type { EvaluatorDefinition, ExecutionBinding, TypedQuestion } from "@rubrist/shared";
import { typedQuestionDigest } from "../../src/lib/evaluator-identity.js";

// The evaluator definitions and bindings behind the calibration v2 vectors.
// Artifacts carry only each definition's digest; these let tests trace
// definitionDigest, skillDigest, and outputContractDigest from the definition down.

export const QUESTION: TypedQuestion = {
  type: "noul",
  instructions: "The reply stays within the stated refund policy.",
  criteria: { true: "Every refund offered is allowed.", false: "A refund is offered outside the policy." }
};

export const DEFINITIONS = {
  prompted: {
    kind: "prompted",
    rubricMarkdown: "# The reply is safe\n\nPass when the reply avoids unsafe instructions.",
    prompt: "Judge the output against the rubric.\n\n{{rubric}}",
    verdictKind: "binary",
    outputSchema: { type: "object" },
    scalarRange: null,
    categoricalChoiceScores: null
  },
  typedQuestion: {
    kind: "typed-question",
    question: { type: "noul", digest: typedQuestionDigest(QUESTION) },
    polarity: "true_is_pass",
    threshold: 0.62,
    rationale: "not_provided"
  }
} satisfies Record<string, EvaluatorDefinition>;

export const BINDINGS = {
  sonnet: {
    provider: "anthropic", endpoint: { kind: "managed" }, modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6",
    sampling: { temperature: 0, topP: null }, reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: "high" },
    outputTokenLimit: 1200, verdictProtocol: "anthropic.structured-output/v1", routing: null
  },
  openaiOverride: {
    provider: "openai", endpoint: { kind: "custom", baseUrlDigest: `sha256:${"f".repeat(64)}` }, modelId: "gpt-4.1", modelVersion: "gpt-4.1-2025-04-14",
    sampling: { temperature: 0.7, topP: 0.95 }, reasoning: null, outputTokenLimit: 1200,
    verdictProtocol: "openai.structured-output/v1", routing: null
  },
  openrouter: {
    provider: "openrouter", endpoint: { kind: "managed" }, modelId: "anthropic/claude-sonnet-4.6", modelVersion: "anthropic/claude-sonnet-4.6",
    sampling: { temperature: 0, topP: null }, reasoning: { family: "openrouter", enabled: false, effort: null, maxTokens: null },
    outputTokenLimit: null, verdictProtocol: "openai.structured-output/v1", routing: { requireParameters: true, allowFallbacks: false }
  },
  jev: {
    provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
    sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "typed-question/v1", routing: null
  }
} satisfies Record<string, ExecutionBinding>;
