import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import { processJudgeRunJob } from "../src/workers/judge.js";

const TRACE = { input: { question: "Refund within 30 days?" }, output: { answer: "Yes, within 30 days." } };

describe("POST /api/v1/judge — eval-as-a-service", () => {
  async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "svc" })
    });
    return (await res.json() as { key: string }).key;
  }

  it("judges a trace synchronously and feeds the trust layer", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    const res = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ trace: TRACE })
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { caseId: string; skillVersionId: string; verdict: { kind: string } };
    expect(body.verdict.kind).toBe("binary");

    // The synchronous call produced a source=llm_judge verdict, just like the async pipeline.
    const verdicts = await repository.listVerdicts({
      projectId: "proj_langsmith_support",
      caseId: body.caseId,
      source: "llm_judge",
      limit: 10
    });
    expect(verdicts).toHaveLength(1);
  });

  it("rejects a request with no API key", async () => {
    const app = createApp(new DemoRepository());
    const res = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trace: TRACE })
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with an invalid API key", async () => {
    const app = createApp(new DemoRepository());
    const res = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer coeval_sk_nope" },
      body: JSON.stringify({ trace: TRACE })
    });
    expect(res.status).toBe(401);
  });

  it("returns the recorded verdict on a re-POSTed trace instead of re-judging", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);
    const request = { trace: { sourceTraceId: "retry_001", ...TRACE } };

    const first = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(request)
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { caseId: string; verdict: unknown };

    const second = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(request)
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { caseId: string; verdict: unknown; cached?: boolean };
    expect(secondBody.cached).toBe(true);
    expect(secondBody.caseId).toBe(firstBody.caseId);
    expect(secondBody.verdict).toEqual(firstBody.verdict);

    // Exactly one llm_judge verdict on record — the retry spent no tokens.
    const verdicts = await repository.listVerdicts({
      projectId: "proj_langsmith_support",
      caseId: firstBody.caseId,
      source: "llm_judge",
      limit: 10
    });
    expect(verdicts).toHaveLength(1);
  });

  it("force: true bypasses the cache and appends a repeat verdict (self-consistency)", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);
    const trace = { sourceTraceId: "force_001", ...TRACE };

    const first = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ trace })
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { caseId: string };

    const second = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ trace, force: true })
    });
    expect(second.status).toBe(201);

    const verdicts = await repository.listVerdicts({
      projectId: "proj_langsmith_support",
      caseId: firstBody.caseId,
      source: "llm_judge",
      limit: 10
    });
    expect(verdicts).toHaveLength(2);
  });

  it("rejects an oversized body with 413", async () => {
    const app = createApp(new DemoRepository());
    const key = await mintKey(app);
    const res = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ trace: { input: { blob: "x".repeat(300 * 1024) }, output: { a: "y" } } })
    });
    expect(res.status).toBe(413);
  });

  it("rate-limits a key once its bucket is exhausted", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    // Bucket capacity is max(rate limit, batch item cap) = 100 — the burst
    // headroom one full-size batch needs — refilled at 60 tokens/min.
    let limited = 0;
    for (let i = 0; i < 101; i++) {
      const res = await app.request("/api/v1/judge", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ trace: { sourceTraceId: `rate_${i}`, ...TRACE } })
      });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThanOrEqual(1);

    // A different key on the same app is not affected by the exhausted bucket.
    const freshKey = await mintKey(app);
    const fresh = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${freshKey}` },
      body: JSON.stringify({ trace: { sourceTraceId: "rate_fresh", ...TRACE } })
    });
    expect(fresh.status).toBe(201);
  });

  it("records provider latency on the judge run", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "latency_001",
      input: TRACE.input,
      output: TRACE.output,
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const run = await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    });
    expect(run.latencyMs).toBeTypeOf("number");
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
