import type { ObservedProvenance, ProviderErrorDetail } from "@rubrist/audit/runtime";
import { ObservedCallSchema, type ObservedCall } from "@rubrist/shared";

// What evidence records of one attempted call (ADR-0014 section 6), taken
// field by field from the executor's observation, so a new executor field
// never breaks recording. A call that reported nothing has every field null.

export const NOTHING_OBSERVED: ObservedCall = Object.freeze({
  model: null,
  requestId: null,
  responseId: null,
  systemFingerprint: null,
  upstreamProvider: null,
  thinkingReturned: null,
  reasoningTokens: null
});

/**
 * The evidence observation of a call. An OpenRouter error names the upstream
 * that answered in its body, so a failed call keeps it too.
 */
export function observedCallFrom(
  observed: ObservedProvenance | null | undefined,
  providerError?: ProviderErrorDetail | null
): ObservedCall {
  const parsed = ObservedCallSchema.safeParse({
    model: observed?.model ?? null,
    requestId: observed?.requestId ?? null,
    responseId: observed?.responseId ?? null,
    systemFingerprint: observed?.systemFingerprint ?? null,
    upstreamProvider: observed?.upstreamProvider ?? providerError?.upstreamProvider ?? null,
    thinkingReturned: observed?.thinkingReturned ?? null,
    reasoningTokens: observed?.reasoningTokens ?? null
  });
  return parsed.success ? parsed.data : NOTHING_OBSERVED;
}
