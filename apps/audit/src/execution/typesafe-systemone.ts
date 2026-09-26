import { redactedProviderText, observedText, type ObservedProvenance, type ProviderErrorDetail, type TokenUsage } from "./failure.js";

// TypeSafe's typed-question API as typed-question/v1 calls it: one
// `POST /v1/systemone` with a Bearer credential. Checked against the live API
// on 2026-09-26: a success is `{ model, answers, usage: { input_tokens,
// output_tokens } }` with an `x-typesafe-request-id` header; an error is
// FastAPI's `{ detail }`, where `detail` is a message, an
// `{ error_type, message }` object, or a validation list whose entries echo
// the request.

export const TYPESAFE_PATH = "/systemone";
export const TYPESAFE_REQUEST_ID_HEADER = "x-typesafe-request-id";

export function typesafeHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

/** What a successful response says about the call: the served model, the request id, and usage. */
export function readTypesafeResponse(body: unknown, meta: { requestId: string | null }): { observed: ObservedProvenance; usage: TokenUsage | null } {
  const response = isObject(body) ? body : {};
  const usageField = isObject(response.usage) ? response.usage : {};
  const inputTokens = count(usageField.input_tokens);
  const outputTokens = count(usageField.output_tokens);
  return {
    observed: {
      model: observedText(response.model),
      requestId: meta.requestId,
      responseId: null,
      systemFingerprint: null,
      upstreamProvider: null,
      thinkingReturned: null,
      reasoningTokens: null
    },
    usage: inputTokens !== null && outputTokens !== null ? { inputTokens, outputTokens } : null
  };
}

/**
 * The error fields a TypeSafe error body carries, with the credential
 * redacted. A validation list echoes the request, trace content included, so
 * only its messages and locations are kept, each location cut after `state`
 * since what follows it names the trace; the raw body never is.
 */
export function typesafeErrorDetail(body: unknown, secret: string | null): ProviderErrorDetail {
  const detail = isObject(body) ? body.detail : undefined;
  const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? redactedProviderText(value, secret) : null;
  let type: string | null = null;
  let message: string | null = null;
  if (typeof detail === "string") {
    message = text(detail);
  } else if (isObject(detail)) {
    type = text(detail.error_type);
    message = text(detail.message);
  } else if (Array.isArray(detail)) {
    const issues = detail.filter(isObject).map((issue) => {
      const parts = Array.isArray(issue.loc) ? issue.loc.filter((part) => typeof part === "string" || typeof part === "number") : [];
      const stateAt = parts.indexOf("state");
      const location = (stateAt === -1 ? parts : parts.slice(0, stateAt + 1)).join(".");
      return `${location ? `${location}: ` : ""}${typeof issue.msg === "string" ? issue.msg : "invalid"}`;
    });
    message = issues.length > 0 ? text(issues.join("; ")) : null;
  }
  return { type, code: null, param: null, message, raw: null, upstreamProvider: null };
}
