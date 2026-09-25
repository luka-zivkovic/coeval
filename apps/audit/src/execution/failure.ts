// The closed failure taxonomy (ADR-0014 section 6), as the audit package
// sees it. Mirrors EvaluatorFailureKindSchema in @rubrist/shared.
export type EvaluatorFailureKind =
  | "provider_rejected_request"
  | "provider_unavailable"
  | "provider_authentication"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_transport"
  | "provider_protocol"
  | "invalid_evaluator_output"
  | "outcome_unknown"
  | "internal";

/** What the response said about who answered, never inferred from the request. Unknown is `null`. */
export interface ObservedProvenance {
  model: string | null;
  requestId: string | null;
  responseId: string | null;
  systemFingerprint: string | null;
  /** The OpenRouter upstream that served the call; `null` for every other provider. */
  upstreamProvider: string | null;
  /** Whether reasoning content came back in the response; `null` where there is no response. */
  thinkingReturned: boolean | null;
  reasoningTokens: number | null;
}

export const UNOBSERVED: ObservedProvenance = {
  model: null,
  requestId: null,
  responseId: null,
  systemFingerprint: null,
  upstreamProvider: null,
  thinkingReturned: null,
  reasoningTokens: null
};

/** The provider's own error fields, kept for capability attribution (ADR-0014 section 4). */
export interface ProviderErrorDetail {
  type: string | null;
  code: string | null;
  param: string | null;
  message: string | null;
}

export interface EvaluatorCallErrorDetail {
  /**
   * Whether the call reached the transport. `false` means Rubrist refused
   * before sending, so the item was never attempted.
   */
  physicalCall: boolean;
  status?: number | null;
  providerError?: ProviderErrorDetail | null;
  /** Provenance from a response that arrived but couldn't be used; `null` without one. */
  observed?: ObservedProvenance | null;
  cause?: unknown;
}

/**
 * One failed evaluator call, classified once. Rubrist never retries it with
 * changed parameters (ADR-0014 section 2).
 */
export class EvaluatorCallError extends Error {
  readonly physicalCall: boolean;
  readonly status: number | null;
  readonly providerError: ProviderErrorDetail | null;
  readonly observed: ObservedProvenance | null;

  constructor(readonly failureKind: EvaluatorFailureKind, message: string, detail: EvaluatorCallErrorDetail) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = "EvaluatorCallError";
    this.physicalCall = detail.physicalCall;
    this.status = detail.status ?? null;
    this.providerError = detail.providerError ?? null;
    this.observed = detail.observed ?? null;
  }
}

/**
 * An HTTP error status as a failure kind. A 4xx other than authentication,
 * rate limiting, or a request timeout is the provider rejecting the request.
 */
export function failureKindForStatus(status: number): EvaluatorFailureKind {
  if (status === 401 || status === 403) return "provider_authentication";
  if (status === 429) return "provider_rate_limit";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status >= 400 && status < 500) return "provider_rejected_request";
  if (status >= 500 && status < 600) return "provider_unavailable";
  return "provider_protocol";
}

const PROVIDER_MESSAGE_LIMIT = 2_000;

/** Bounded, and never ending in half a surrogate pair. */
export function boundedProviderText(value: string): string {
  if (value.length <= PROVIDER_MESSAGE_LIMIT) return value;
  const cut = value.slice(0, PROVIDER_MESSAGE_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? boundedProviderText(value) : typeof value === "number" ? String(value) : null;

/**
 * The error fields Anthropic (`{error: {type, message}}`), OpenAI
 * (`{error: {message, type, code, param}}`), and OpenRouter
 * (`{error: {code, message}}`) put in an error body.
 */
export function providerErrorDetail(body: unknown, rawText: string): ProviderErrorDetail {
  const error = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (error !== null && typeof error === "object") {
    const fields = error as Record<string, unknown>;
    return { type: text(fields.type), code: text(fields.code), param: text(fields.param), message: text(fields.message) };
  }
  return { type: null, code: null, param: null, message: rawText.length > 0 ? boundedProviderText(rawText) : null };
}
