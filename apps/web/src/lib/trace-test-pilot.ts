import type { TraceTestFunnelEventInput, TraceTestFunnelEventName } from "@coeval/shared";
import { recordTraceTestFunnelEvent } from "./api.js";

const PROMPT_DISMISSAL_PREFIX = "coeval.trace-test-prompt-dismissed:";

export function traceTestPromptDismissed(sourceCaseId: string): boolean {
  try {
    return localStorage.getItem(`${PROMPT_DISMISSAL_PREFIX}${sourceCaseId}`) === "1";
  } catch {
    return false;
  }
}

export function dismissTraceTestPrompt(sourceCaseId: string): void {
  try {
    localStorage.setItem(`${PROMPT_DISMISSAL_PREFIX}${sourceCaseId}`, "1");
  } catch {
    // Storage can be disabled; dismissal still applies to the current render.
  }
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export interface TraceTestFunnel {
  record: (event: TraceTestFunnelEventName) => void;
  complete: () => void;
  abandon: () => void;
}

export function createTraceTestFunnel(intent: TraceTestFunnelEventInput["intent"]): TraceTestFunnel {
  const journeyId = uuid();
  const startedAt = Date.now();
  const recorded = new Set<TraceTestFunnelEventName>();
  let complete = false;

  const record = (event: TraceTestFunnelEventName) => {
    if (recorded.has(event)) return;
    recorded.add(event);
    void recordTraceTestFunnelEvent({
      journeyId,
      event,
      elapsedMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)),
      intent
    }).catch(() => {
      // Activation metrics must never interrupt or expose the user journey.
    });
  };

  return {
    record,
    complete: () => { complete = true; },
    abandon: () => {
      if (!complete) record("abandoned");
    }
  };
}
