import type { ObservedProvenance } from "@rubrist/audit/runtime";
import { ObservedCallSchema, containsLoneUtf16Surrogate, type ObservedCall } from "@rubrist/shared";

// What evidence records of one attempted call (ADR-0014 section 6), taken
// field by field from the executor's observation, so a new executor field
// never breaks recording. A call that reported nothing has every field null.
// Every value is one a receipt can carry, so recording a call can never leave
// a run unable to mint its receipt.

export const NOTHING_OBSERVED: ObservedCall = Object.freeze({
  model: null,
  requestId: null,
  responseId: null,
  systemFingerprint: null,
  upstreamProvider: null,
  thinkingReturned: null,
  reasoningTokens: null
});

const OBSERVED_TEXT_LIMIT = 1_024;

/** Text a receipt can carry: bounded, and no lone UTF-16 surrogate. */
function evidenceText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= OBSERVED_TEXT_LIMIT && !containsLoneUtf16Surrogate(value)
    ? value
    : null;
}

/**
 * The evidence observation of a call. The executor records an upstream only
 * for an OpenRouter binding, from its response or its error body; an error's
 * own detail is diagnostic, never evidence.
 */
export function observedCallFrom(observed: ObservedProvenance | null | undefined): ObservedCall {
  const parsed = ObservedCallSchema.safeParse({
    model: evidenceText(observed?.model),
    requestId: evidenceText(observed?.requestId),
    responseId: evidenceText(observed?.responseId),
    systemFingerprint: evidenceText(observed?.systemFingerprint),
    upstreamProvider: evidenceText(observed?.upstreamProvider),
    thinkingReturned: observed?.thinkingReturned ?? null,
    reasoningTokens: observed?.reasoningTokens ?? null
  });
  return parsed.success ? parsed.data : NOTHING_OBSERVED;
}
