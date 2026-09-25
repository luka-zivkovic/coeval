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
  /**
   * Whether reasoning content came back in the response; `null` where no
   * response was read. It says nothing about whether the model reasoned:
   * Chat Completions never returns OpenAI's reasoning, so it is `false` there
   * even when `reasoningTokens` is positive.
   */
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The provider's own error fields, kept for capability attribution (ADR-0014
 * section 4). OpenRouter wraps an upstream's error: `raw` is that upstream's
 * own error text and `upstreamProvider` names it.
 */
export interface ProviderErrorDetail {
  type: string | null;
  code: string | null;
  param: string | null;
  message: string | null;
  raw: string | null;
  upstreamProvider: string | null;
}

export interface EvaluatorCallErrorDetail {
  /**
   * Whether the request left Rubrist. `false` means it was refused before
   * sending, so the item was never attempted.
   */
  physicalCall: boolean;
  status?: number | null;
  providerError?: ProviderErrorDetail | null;
  /** Provenance from a response that arrived but couldn't be used; `null` without one. */
  observed?: ObservedProvenance | null;
  /** What a billed response reported using, so a failed call still records its cost. */
  usage?: TokenUsage | null;
  cause?: unknown;
}

/**
 * One failed evaluator call, classified once. Rubrist never retries it with
 * changed parameters (ADR-0014 section 2). Its message and fields never hold
 * the credential.
 */
export class EvaluatorCallError extends Error {
  readonly physicalCall: boolean;
  readonly status: number | null;
  readonly providerError: ProviderErrorDetail | null;
  readonly observed: ObservedProvenance | null;
  readonly usage: TokenUsage | null;

  constructor(readonly failureKind: EvaluatorFailureKind, message: string, detail: EvaluatorCallErrorDetail) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = "EvaluatorCallError";
    this.physicalCall = detail.physicalCall;
    this.status = detail.status ?? null;
    this.providerError = detail.providerError ?? null;
    this.observed = detail.observed ?? null;
    this.usage = detail.usage ?? null;
  }
}

/**
 * An HTTP status as a failure kind. A 4xx other than authentication, rate
 * limiting, or a request timeout is the provider rejecting the request. 402
 * (credits exhausted) is the credential being unusable, like 401 and 403,
 * not a rejection of the request: it must never fail an evaluator version.
 * A redirect, never followed, is a protocol failure.
 */
export function failureKindForStatus(status: number): EvaluatorFailureKind {
  if (status === 401 || status === 402 || status === 403) return "provider_authentication";
  if (status === 429) return "provider_rate_limit";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status >= 400 && status < 500) return "provider_rejected_request";
  if (status >= 500 && status < 600) return "provider_unavailable";
  return "provider_protocol";
}

/** A status code as text (`"400"`, 400), or `null` when it isn't one. */
export function statusFromCode(code: unknown): number | null {
  const text = typeof code === "number" ? String(code) : code;
  return typeof text === "string" && /^[1-5]\d\d$/.test(text) ? Number(text) : null;
}

const PROVIDER_TEXT_LIMIT = 2_000;

/** Bounded, and never ending in half a surrogate pair. */
export function boundedProviderText(value: string): string {
  if (value.length <= PROVIDER_TEXT_LIMIT) return value;
  const cut = value.slice(0, PROVIDER_TEXT_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Provider text with every occurrence of the credential replaced, then bounded. */
export function redactedProviderText(value: string, secret: string | null): string {
  const redacted = secret !== null && secret.length > 0 ? value.split(secret).join("[redacted]") : value;
  return boundedProviderText(redacted);
}

/**
 * The error fields Anthropic (`{error: {type, message}}`), OpenAI
 * (`{error: {message, type, code, param}}`), and OpenRouter
 * (`{error: {code, message, metadata: {raw, provider_name}}}`) put in an
 * error body, with the credential redacted.
 */
export function providerErrorDetail(body: unknown, rawText: string, secret: string | null): ProviderErrorDetail {
  const text = (value: unknown): string | null =>
    typeof value === "string" ? redactedProviderText(value, secret) : typeof value === "number" ? String(value) : null;
  const error = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (error !== null && typeof error === "object") {
    const fields = error as Record<string, unknown>;
    const metadata = fields.metadata !== null && typeof fields.metadata === "object" ? fields.metadata as Record<string, unknown> : {};
    const raw = typeof metadata.raw === "string" ? metadata.raw : metadata.raw === undefined ? undefined : JSON.stringify(metadata.raw);
    return {
      type: text(fields.type),
      code: text(fields.code),
      param: text(fields.param),
      message: text(fields.message),
      raw: raw === undefined ? null : redactedProviderText(raw, secret),
      upstreamProvider: text(metadata.provider_name)
    };
  }
  const message = typeof error === "string" ? error : rawText;
  return { type: null, code: null, param: null, message: message.length > 0 ? redactedProviderText(message, secret) : null, raw: null, upstreamProvider: null };
}

const OBSERVED_TEXT_LIMIT = 1_024;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * An observed identifier as evidence can carry it: a non-empty string of
 * reasonable length with no lone surrogate. Anything else wasn't usably
 * reported, so it is `null`, never a truncated or repaired value.
 */
export function observedText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= OBSERVED_TEXT_LIMIT && !hasLoneSurrogate(value) ? value : null;
}
