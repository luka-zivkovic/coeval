import {
  verdictProtocolTokenLimitParameter,
  type VerdictProtocolRequest,
  type VerdictResponse
} from "../protocols/verdict-protocols.js";
import type { PromptedExecutionBinding } from "./binding.js";
import { EvaluatorCallError, failureKindForStatus, providerErrorDetail, type ObservedProvenance } from "./failure.js";

/**
 * The chat-completions body for OpenAI, OpenRouter, and OpenAI-compatible
 * custom endpoints: every setting the binding states and nothing it leaves
 * unset (ADR-0014 section 2). Structured output is sent strict, as the
 * protocol pins; a forced function is sent without `strict`, so it's
 * non-strict. OpenRouter bindings also send their routing requirements, so
 * the call reaches only an upstream that honours them.
 */
export function openAIChatBody(binding: PromptedExecutionBinding, request: VerdictProtocolRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: binding.modelId,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user }
    ]
  };
  if (binding.sampling.temperature !== null) body.temperature = binding.sampling.temperature;
  if (binding.sampling.topP !== null) body.top_p = binding.sampling.topP;
  const limitParameter = verdictProtocolTokenLimitParameter(binding.verdictProtocol, binding.provider);
  if (limitParameter !== null && binding.outputTokenLimit !== null) body[limitParameter] = binding.outputTokenLimit;
  const reasoning = binding.reasoning;
  if (reasoning?.family === "openai") body.reasoning_effort = reasoning.effort;
  if (reasoning?.family === "openrouter") {
    body.reasoning = {
      enabled: reasoning.enabled,
      ...(reasoning.effort !== null ? { effort: reasoning.effort } : {}),
      ...(reasoning.maxTokens !== null ? { max_tokens: reasoning.maxTokens } : {})
    };
  }
  const output = request.output;
  if (output.mechanism === "structured_output") {
    if (output.name === null) throw new Error(`${request.protocol} names no format, which Chat Completions requires`);
    body.response_format = { type: "json_schema", json_schema: { name: output.name, strict: output.strict, schema: output.schema } };
  }
  if (output.mechanism === "forced_tool") {
    body.tools = [{ type: "function", function: { name: output.name, description: output.description, parameters: output.schema } }];
    body.tool_choice = { type: "function", function: { name: output.name } };
  }
  if (binding.routing !== null) {
    body.provider = { require_parameters: binding.routing.requireParameters, allow_fallbacks: binding.routing.allowFallbacks };
  }
  return body;
}

interface ChatMessage {
  content?: unknown;
  refusal?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  reasoning_details?: unknown;
  tool_calls?: unknown;
}

const stringOrNull = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const nonEmptyText = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/**
 * Reads a successful chat completion into observed provenance, usage, and
 * the normalized response the protocol's parse rule reads. OpenRouter can
 * report an upstream error inside a 200; that is classified like the status
 * it names.
 */
export function readOpenAIChatResponse(
  binding: PromptedExecutionBinding,
  body: unknown,
  requestId: string | null
): { response: VerdictResponse; observed: ObservedProvenance; usage: { inputTokens: number; outputTokens: number } | null } {
  const completion = (body ?? {}) as {
    id?: unknown;
    model?: unknown;
    provider?: unknown;
    system_fingerprint?: unknown;
    error?: unknown;
    choices?: Array<{ message?: ChatMessage; finish_reason?: unknown; error?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
  };
  const choice = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = choice?.message;
  const reasoningTokens = completion.usage?.completion_tokens_details?.reasoning_tokens;
  const observed: ObservedProvenance = {
    model: stringOrNull(completion.model),
    requestId,
    responseId: stringOrNull(completion.id),
    systemFingerprint: stringOrNull(completion.system_fingerprint),
    upstreamProvider: binding.provider === "openrouter" ? stringOrNull(completion.provider) : null,
    thinkingReturned: message === undefined
      ? null
      : nonEmptyText(message.reasoning) || nonEmptyText(message.reasoning_content) ||
        (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0),
    reasoningTokens: Number.isSafeInteger(reasoningTokens) && (reasoningTokens as number) >= 0 ? reasoningTokens as number : null
  };

  const embeddedError = completion.error ?? choice?.error;
  if (embeddedError !== undefined && embeddedError !== null) {
    const providerError = providerErrorDetail({ error: embeddedError }, "");
    const status = Number(providerError.code);
    throw new EvaluatorCallError(
      Number.isInteger(status) ? failureKindForStatus(status) : "provider_unavailable",
      `the provider reported an error in a successful response${providerError.message ? `: ${providerError.message}` : ""}`,
      { physicalCall: true, status: 200, providerError, observed }
    );
  }
  if (message === undefined || message === null || typeof message !== "object") {
    throw new EvaluatorCallError("provider_protocol", "the completion has no message", { physicalCall: true, status: 200, observed });
  }
  const finishReason = choice?.finish_reason;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<{ function?: { name?: unknown; arguments?: unknown } }> : [];
  const response: VerdictResponse = {
    stop: nonEmptyText(message.refusal) || finishReason === "content_filter" ? "refusal" : finishReason === "length" ? "max_tokens" : "normal",
    text: typeof message.content === "string" ? message.content : null,
    toolCalls: calls.map((call) => ({
      name: typeof call.function?.name === "string" ? call.function.name : null,
      arguments: call.function?.arguments
    }))
  };
  const usage = typeof completion.usage?.prompt_tokens === "number" && typeof completion.usage?.completion_tokens === "number"
    ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens }
    : null;
  return { response, observed, usage };
}
