import {
  verdictProtocolTokenLimitParameter,
  type VerdictProtocolRequest,
  type VerdictResponse
} from "../protocols/verdict-protocols.js";
import type { PromptedExecutionBinding } from "./binding.js";
import {
  EvaluatorCallError,
  failureKindForStatus,
  observedText,
  providerErrorDetail,
  statusFromCode,
  type ObservedProvenance,
  type TokenUsage
} from "./failure.js";

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
    if (output.name === null) {
      throw new EvaluatorCallError("internal", `${request.protocol} names no format, which Chat Completions requires`, { physicalCall: false });
    }
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

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyText = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/** Message text as a string, or joined from the text parts some compatible servers return. */
function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((part): part is Record<string, unknown> => isObject(part) && part.type === "text" && typeof part.text === "string");
  return parts.length > 0 ? parts.map((part) => part.text as string).join("") : null;
}

/**
 * Reads a successful chat completion into observed provenance, usage, and
 * the normalized response the protocol's parse rule reads. OpenRouter can
 * report an upstream error inside a 200: it is classified by the status code
 * it names, and as the provider being unavailable when it names none.
 * ASSUMPTION: OpenRouter names the serving upstream in a top-level
 * `provider` field, which its response reference doesn't document.
 */
export function readOpenAIChatResponse(
  binding: PromptedExecutionBinding,
  body: unknown,
  meta: { status: number; requestId: string | null; secret: string | null }
): { response: VerdictResponse; observed: ObservedProvenance; usage: TokenUsage | null } {
  const completion = isObject(body) ? body : {};
  const usageField = isObject(completion.usage) ? completion.usage : {};
  const usage = typeof usageField.prompt_tokens === "number" && typeof usageField.completion_tokens === "number"
    ? { inputTokens: usageField.prompt_tokens, outputTokens: usageField.completion_tokens }
    : null;
  const choice = Array.isArray(completion.choices) && isObject(completion.choices[0]) ? completion.choices[0] : undefined;
  const message = choice !== undefined && isObject(choice.message) ? choice.message : undefined;
  const reasoningTokens = isObject(usageField.completion_tokens_details) ? usageField.completion_tokens_details.reasoning_tokens : undefined;
  const observed: ObservedProvenance = {
    model: observedText(completion.model),
    requestId: meta.requestId,
    responseId: observedText(completion.id),
    systemFingerprint: observedText(completion.system_fingerprint),
    upstreamProvider: binding.provider === "openrouter" ? observedText(completion.provider) : null,
    thinkingReturned: message === undefined
      ? null
      : nonEmptyText(message.reasoning) || nonEmptyText(message.reasoning_content) ||
        (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0),
    reasoningTokens: Number.isSafeInteger(reasoningTokens) && (reasoningTokens as number) >= 0 ? reasoningTokens as number : null
  };
  const detail = { physicalCall: true, status: meta.status, observed, usage };

  const embeddedError = completion.error ?? choice?.error;
  if ((embeddedError !== undefined && embeddedError !== null) || choice?.finish_reason === "error") {
    const providerError = providerErrorDetail({ error: embeddedError ?? null }, "", meta.secret);
    const status = statusFromCode(providerError.code);
    throw new EvaluatorCallError(
      status === null ? "provider_unavailable" : failureKindForStatus(status),
      `the provider reported an error in a successful response${providerError.message ? `: ${providerError.message}` : ""}`,
      { ...detail, providerError }
    );
  }
  if (message === undefined) throw new EvaluatorCallError("provider_protocol", "the completion has no message", detail);
  const finishReason = choice?.finish_reason;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
  const response: VerdictResponse = {
    stop: nonEmptyText(message.refusal) || finishReason === "content_filter" ? "refusal" : finishReason === "length" ? "max_tokens" : "normal",
    text: messageText(message.content),
    toolCalls: calls.map((call) => {
      const fn = isObject(call.function) ? call.function : {};
      return { name: typeof fn.name === "string" ? fn.name : null, arguments: fn.arguments };
    })
  };
  return { response, observed, usage };
}
