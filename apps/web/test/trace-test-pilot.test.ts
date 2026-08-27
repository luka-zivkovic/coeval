import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTraceTestFunnel,
  dismissTraceTestPrompt,
  traceTestPromptDismissed
} from "../src/lib/trace-test-pilot.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("trace-to-test pilot helpers", () => {
  it("keeps a dismissed entry prompt dismissed for that conversation", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(traceTestPromptDismissed("case_one")).toBe(false);
    dismissTraceTestPrompt("case_one");
    expect(traceTestPromptDismissed("case_one")).toBe(true);
    expect(traceTestPromptDismissed("case_two")).toBe(false);
  });

  it("deduplicates funnel stages and never sends source content", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const funnel = createTraceTestFunnel("protect");

    funnel.record("started");
    funnel.record("started");
    funnel.record("draft_saved");
    funnel.complete();
    funnel.abandon();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    const bodies = fetcher.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
    expect(bodies.map((body) => body.event)).toEqual(["started", "draft_saved"]);
    expect(bodies.every((body) => Object.keys(body).sort().join(",") === "elapsedMs,event,intent,journeyId")).toBe(true);
  });
});
