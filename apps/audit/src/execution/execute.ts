import type { StructuredVerdict, VerdictSpec } from "../llm/verdict-spec.js";
import { MockJudgeProvider } from "../llm/mock.js";
import type { Trace } from "../schema.js";
import {
  VerdictProtocolError,
  buildVerdictProtocolRequest,
  parseVerdictProtocolResponse,
  renderEvaluatorPrompt,
  type VerdictProtocolRequest,
  type VerdictResponse
} from "../protocols/verdict-protocols.js";
import { ANTHROPIC_VERSION, anthropicMessagesBody, readAnthropicMessagesResponse } from "./anthropic-messages.js";
import {
  assertCredential,
  assertPromptedBinding,
  resolveEndpointBaseUrl,
  type ExecutionBinding,
  type PromptedExecutionBinding
} from "./binding.js";
import {
  EvaluatorCallError,
  UNOBSERVED,
  failureKindForStatus,
  providerErrorDetail,
  type ObservedProvenance,
  type TokenUsage
} from "./failure.js";
import { openAIChatBody, readOpenAIChatResponse } from "./openai-chat.js";

export type ExecutionFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Never follow a redirect: the call goes exactly where the binding says. */
  redirect: "manual";
  signal: AbortSignal;
}) => Promise<Response>;

export interface VerdictExecutionInput {
  binding: ExecutionBinding;
  /** The provider credential; `null` for the mock. */
  apiKey: string | null;
  /** The configured base URL of a custom endpoint, checked against the binding's digest; otherwise `null`. */
  customBaseUrl: string | null;
  /** The prompted definition's rubric and prompt template; the protocol renders them. */
  rubricMarkdown: string;
  prompt: string;
  trace: unknown;
  spec: VerdictSpec;
  timeoutMs?: number;
  fetch?: ExecutionFetch;
  /**
   * Runs once every check before the call has passed and just before the one
   * physical call is sent, so a durable call-start record never precedes a
   * refusal. If it throws, nothing is sent and its error propagates as is.
   * The mock makes no physical call, so it never runs there. After it runs,
   * every failure counts as a physical call, even one the runtime refuses
   * locally (such as a port fetch blocks): evidence errs toward a request
   * having left.
   */
  beforeDispatch?: () => Promise<void>;
}

export interface VerdictExecutionResult {
  verdict: StructuredVerdict;
  observed: ObservedProvenance;
  usage: TokenUsage | null;
}

/** The exact HTTP request one judgment sends, credential excluded. */
export interface VerdictHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MOCK_OBSERVED: ObservedProvenance = { ...UNOBSERVED, model: "mock-heuristic-v1" };

/**
 * The request a binding sends for one judgment (ADR-0014 section 2): the
 * binding's endpoint, model, and settings, and the protocol's text and
 * output mechanism. Unset settings are not sent.
 */
export function buildVerdictHttpRequest(
  binding: PromptedExecutionBinding,
  request: VerdictProtocolRequest,
  customBaseUrl: string | null
): VerdictHttpRequest {
  const baseUrl = resolveEndpointBaseUrl(binding, customBaseUrl);
  if (binding.provider === "anthropic") {
    return {
      url: `${baseUrl}/messages`,
      headers: { "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: anthropicMessagesBody(binding, request)
    };
  }
  return {
    url: `${baseUrl}/chat/completions`,
    headers: { "content-type": "application/json" },
    body: openAIChatBody(binding, request)
  };
}

function authorization(binding: PromptedExecutionBinding, apiKey: string): Record<string, string> {
  return binding.provider === "anthropic" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
}

/** Reads at most MAX_RESPONSE_BYTES of the body; `null` when it's longer. */
async function readBoundedText(response: Response): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A transport failure's own error can quote request headers, so only its
// code or name is kept, never the error itself.
function transportReason(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  const code = cause !== null && typeof cause === "object" && typeof cause.code === "string" ? cause.code : null;
  return code ?? (error instanceof Error ? error.name : "unknown");
}

/**
 * Judges one trace with a v2 execution binding in exactly one physical call.
 * Nothing is retried, dropped, or rewritten after a rejection, and no
 * redirect is followed: a failed call is an EvaluatorCallError with its
 * failure kind (ADR-0014 sections 2 and 6).
 */
export async function executeVerdict(input: VerdictExecutionInput): Promise<VerdictExecutionResult> {
  const binding = input.binding;
  assertPromptedBinding(binding);
  const request = buildVerdictProtocolRequest(binding.verdictProtocol, {
    rubricMarkdown: input.rubricMarkdown,
    prompt: input.prompt,
    trace: input.trace,
    spec: input.spec
  });

  if (binding.provider === "mock") {
    const result = await new MockJudgeProvider().judgeStructured({
      prompt: { id: "mock", name: "mock", content: renderEvaluatorPrompt(input), kind: "unified" },
      trace: input.trace as Trace,
      spec: input.spec
    });
    return { verdict: result.verdict, observed: MOCK_OBSERVED, usage: result.usage ?? null };
  }

  const http = buildVerdictHttpRequest(binding, request, input.customBaseUrl);
  const apiKey = input.apiKey;
  assertCredential(binding.provider, apiKey);
  const send = input.fetch ?? ((url, init) => fetch(url, init));
  // Everything the call sends is built before the dispatch hook, so only the
  // send itself follows it.
  const headers = { ...http.headers, ...authorization(binding, apiKey) };
  const body = JSON.stringify(http.body);
  await input.beforeDispatch?.();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const failedInTransit = (error: unknown, observed: ObservedProvenance): EvaluatorCallError => {
    const timedOut = controller.signal.aborted;
    return new EvaluatorCallError(
      timedOut ? "provider_timeout" : "provider_transport",
      timedOut ? "the provider did not answer before the timeout" : `the request failed in transport (${transportReason(error)})`,
      { physicalCall: true, observed }
    );
  };

  let response: Response;
  let text: string | null;
  let requestId: string | null = null;
  try {
    try {
      response = await send(http.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      throw failedInTransit(error, UNOBSERVED);
    }
    requestId = response.headers.get(binding.provider === "anthropic" ? "request-id" : "x-request-id");
    try {
      text = await readBoundedText(response);
    } catch (error) {
      throw failedInTransit(error, { ...UNOBSERVED, requestId });
    }
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  const headerOnly = { ...UNOBSERVED, requestId };
  if (text === null) {
    throw new EvaluatorCallError("provider_protocol", "the provider's response exceeds the size limit", { physicalCall: true, status, observed: headerOnly });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const providerError = providerErrorDetail(json, text, apiKey);
    throw new EvaluatorCallError(
      failureKindForStatus(status),
      `the provider answered ${status}${providerError.message ? `: ${providerError.message}` : ""}`,
      { physicalCall: true, status, providerError, observed: headerOnly }
    );
  }
  if (json === undefined) {
    throw new EvaluatorCallError("provider_protocol", "the provider's response is not JSON", { physicalCall: true, status, observed: headerOnly });
  }

  let read: { response: VerdictResponse; observed: ObservedProvenance; usage: TokenUsage | null };
  try {
    read = binding.provider === "anthropic"
      ? readAnthropicMessagesResponse(json, { status, requestId })
      : readOpenAIChatResponse(binding, json, { status, requestId, secret: apiKey });
  } catch (error) {
    if (error instanceof EvaluatorCallError) throw error;
    throw new EvaluatorCallError("provider_protocol", "the provider's response has an unexpected shape", { physicalCall: true, status, observed: headerOnly });
  }
  try {
    const verdict = parseVerdictProtocolResponse(binding.verdictProtocol, { spec: input.spec, trace: input.trace, response: read.response });
    return { verdict, observed: read.observed, usage: read.usage };
  } catch (error) {
    if (error instanceof VerdictProtocolError) {
      throw new EvaluatorCallError(error.failureKind, error.message, { physicalCall: true, status, observed: read.observed, usage: read.usage, cause: error });
    }
    throw error;
  }
}
