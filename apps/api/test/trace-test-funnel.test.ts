import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

const validEvent = {
  journeyId: "e137f8a5-98f5-40c9-a0cb-75a74be7fa37",
  event: "validation_completed",
  elapsedMs: 42_000,
  intent: "prevent"
} as const;

describe("trace-to-test funnel events", () => {
  it("records only the bounded, content-free funnel shape", async () => {
    const repository = new DemoRepository();
    const record = vi.spyOn(repository, "recordTraceTestFunnelEvent");
    const response = await createApp(repository).request("/api/trace-tests/funnel-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validEvent)
    });

    expect(response.status).toBe(204);
    expect(record).toHaveBeenCalledWith({ projectId: "proj_langsmith_support", ...validEvent });
  });

  it("rejects arbitrary source or draft content at the analytics boundary", async () => {
    const repository = new DemoRepository();
    const record = vi.spyOn(repository, "recordTraceTestFunnelEvent");
    const response = await createApp(repository).request("/api/trace-tests/funnel-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validEvent, prompt: "customer conversation content" })
    });

    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });
});
