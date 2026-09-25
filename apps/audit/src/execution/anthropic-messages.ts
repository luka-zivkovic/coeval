import {
  verdictProtocolTokenLimitParameter,
  type VerdictProtocolRequest,
  type VerdictResponse
} from "../protocols/verdict-protocols.js";
import type { PromptedExecutionBinding } from "./binding.js";
import { EvaluatorCallError, type ObservedProvenance } from "./failure.js";

export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The Messages API body for one judgment: every setting the binding states
 * and nothing it leaves unset (ADR-0014 section 2). Effort and the
 * structured-output format both live in `output_config`; the format is
 * always enforced, so it takes no `strict` flag or name.
 */
export function anthropicMessagesBody(binding: PromptedExecutionBinding, request: VerdictProtocolRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: binding.modelId };
  const limitParameter = verdictProtocolTokenLimitParameter(binding.verdictProtocol, "anthropic");
  if (limitParameter !== null && binding.outputTokenLimit !== null) body[limitParameter] = binding.outputTokenLimit;
  body.system = request.system;
  body.messages = [{ role: "user", content: request.user }];
  if (binding.sampling.temperature !== null) body.temperature = binding.sampling.temperature;
  if (binding.sampling.topP !== null) body.top_p = binding.sampling.topP;
  const reasoning = binding.reasoning?.family === "anthropic" ? binding.reasoning : null;
  if (reasoning !== null) {
    body.thinking = reasoning.thinking.type === "enabled"
      ? { type: "enabled", budget_tokens: reasoning.thinking.budgetTokens }
      : { type: reasoning.thinking.type };
  }
  const outputConfig: Record<string, unknown> = {};
  if (reasoning?.effort != null) outputConfig.effort = reasoning.effort;
  if (request.output.mechanism === "structured_output") {
    outputConfig.format = { type: "json_schema", schema: request.output.schema };
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
  if (request.output.mechanism === "forced_tool") {
    body.tools = [{ name: request.output.name, description: request.output.description, input_schema: request.output.schema }];
    body.tool_choice = { type: "tool", name: request.output.name };
  }
  return body;
}

interface AnthropicBlock {
  type?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
}

const stringOrNull = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

/**
 * Reads a successful Messages response into observed provenance, usage, and
 * the normalized response the protocol's parse rule reads.
 */
export function readAnthropicMessagesResponse(
  body: unknown,
  requestId: string | null
): { response: VerdictResponse; observed: ObservedProvenance; usage: { inputTokens: number; outputTokens: number } | null } {
  const message = (body ?? {}) as { id?: unknown; model?: unknown; content?: unknown; stop_reason?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  const content: AnthropicBlock[] = Array.isArray(message.content) ? message.content as AnthropicBlock[] : [];
  const observed: ObservedProvenance = {
    model: stringOrNull(message.model),
    requestId,
    responseId: stringOrNull(message.id),
    systemFingerprint: null,
    upstreamProvider: null,
    thinkingReturned: content.some((block) => block.type === "thinking" || block.type === "redacted_thinking"),
    // The Messages API folds thinking into output tokens; it reports no separate count.
    reasoningTokens: null
  };
  if (!Array.isArray(message.content)) {
    throw new EvaluatorCallError("provider_protocol", "the Messages response has no content array", { physicalCall: true, status: 200, observed });
  }
  const texts = content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string);
  const response: VerdictResponse = {
    stop: message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "max_tokens" : "normal",
    text: texts.length > 0 ? texts.join("") : null,
    toolCalls: content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ name: typeof block.name === "string" ? block.name : null, arguments: block.input }))
  };
  const usage = typeof message.usage?.input_tokens === "number" && typeof message.usage?.output_tokens === "number"
    ? { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
    : null;
  return { response, observed, usage };
}
