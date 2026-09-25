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
  type ObservedProvenance
} from "./failure.js";
import { openAIChatBody, readOpenAIChatResponse } from "./openai-chat.js";

export type ExecutionFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
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
}

export interface VerdictExecutionResult {
  verdict: StructuredVerdict;
  observed: ObservedProvenance;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** The exact HTTP request one judgment sends, credential excluded. */
export interface VerdictHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
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

async function readBody(response: Response): Promise<{ json: unknown; text: string }> {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

/**
 * Judges one trace with a v2 execution binding in exactly one physical call.
 * Nothing is retried, dropped, or rewritten after a rejection: a failed call
 * is an EvaluatorCallError with its failure kind (ADR-0014 sections 2 and 6).
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
  if (input.apiKey === null || input.apiKey.length === 0) {
    throw new EvaluatorCallError("provider_unavailable", `no ${binding.provider} credential is available`, { physicalCall: false });
  }
  const send = input.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  let body: { json: unknown; text: string };
  try {
    response = await send(http.url, {
      method: "POST",
      headers: { ...http.headers, ...authorization(binding, input.apiKey) },
      body: JSON.stringify(http.body),
      signal: controller.signal
    });
    body = await readBody(response);
  } catch (error) {
    const timedOut = controller.signal.aborted;
    throw new EvaluatorCallError(
      timedOut ? "provider_timeout" : "provider_transport",
      timedOut ? "the provider did not answer before the timeout" : "the request failed in transport",
      { physicalCall: true, observed: UNOBSERVED, cause: error }
    );
  } finally {
    clearTimeout(timer);
  }

  const requestId = response.headers.get(binding.provider === "anthropic" ? "request-id" : "x-request-id");
  if (!response.ok) {
    const providerError = providerErrorDetail(body.json, body.text);
    throw new EvaluatorCallError(
      failureKindForStatus(response.status),
      `the provider answered ${response.status}${providerError.message ? `: ${providerError.message}` : ""}`,
      { physicalCall: true, status: response.status, providerError, observed: { ...UNOBSERVED, requestId } }
    );
  }
  if (body.json === undefined) {
    throw new EvaluatorCallError("provider_protocol", "the provider's response is not JSON", {
      physicalCall: true,
      status: response.status,
      observed: { ...UNOBSERVED, requestId }
    });
  }

  const read = binding.provider === "anthropic"
    ? readAnthropicMessagesResponse(body.json, requestId)
    : readOpenAIChatResponse(binding, body.json, requestId);
  return { verdict: parseVerdict(binding, input, read.response, read.observed), observed: read.observed, usage: read.usage };
}

function parseVerdict(
  binding: PromptedExecutionBinding,
  input: VerdictExecutionInput,
  response: VerdictResponse,
  observed: ObservedProvenance
): StructuredVerdict {
  try {
    return parseVerdictProtocolResponse(binding.verdictProtocol, { spec: input.spec, trace: input.trace, response });
  } catch (error) {
    if (error instanceof VerdictProtocolError) {
      throw new EvaluatorCallError(error.failureKind, error.message, { physicalCall: true, status: 200, observed, cause: error });
    }
    throw error;
  }
}
