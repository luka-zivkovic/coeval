import { describe, expect, it } from "vitest";
import { deriveGateCheckDecision, type EvalRunStatus, type GateCheckDetail } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

const PROJECT = "proj_langsmith_support";
const SKILL_VERSION = "skillv_1_2_0";

async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "historical-gate-reader" })
  });
  return (await res.json() as { key: string }).key;
}

function post(app: ReturnType<typeof createApp>, key: string, body: unknown) {
  return app.request("/api/v1/gate-checks", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
}

describe("POST /api/v1/gate-checks — removed product-policy write", () => {
  it("still requires an API key", async () => {
    const app = createApp(new DemoRepository());
    const res = await app.request("/api/v1/gate-checks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(res.status).toBe(401);
  });

  it("returns 410 before parsing valid or malformed legacy bodies and creates no state", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const key = await mintKey(app);

    for (const body of [
      { candidates: [{ goldenCaseId: "case_101", output: { answer: "candidate" } }] },
      { malformed: true }
    ]) {
      const res = await post(app, key, body);
      expect(res.status).toBe(410);
      expect(res.headers.get("deprecation")).toBe("true");
      expect(res.headers.get("warning")).toContain("release_evidence");
      expect(await res.json()).toMatchObject({ code: "product_gate_writes_removed" });
    }

    expect(await repository.listEvalRuns(PROJECT)).toHaveLength(0);
    expect(await repository.listGateChecks(PROJECT)).toHaveLength(0);
  });
});

describe("historical gate-check reads", () => {
  it("preserves session and API-keyed reads for existing rows", async () => {
    const repository = new DemoRepository();
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "product_gate",
      items: [{
        caseId: "case_101",
        status: "completed",
        resultLabel: "pass",
        expectedLabel: "pass"
      }]
    });
    const historical = await repository.createGateCheck({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      evalRunId: run.id,
      label: "historical deploy",
      maxDisagreements: 0,
      items: [{
        goldenEntryId: "golden_101",
        goldenCaseId: "case_101",
        caseKey: "ls_run_101",
        candidateCaseId: "case_101",
        expectedLabel: "pass"
      }]
    });
    const app = createApp(repository);
    const key = await mintKey(app);

    const list = await app.request("/api/gate-checks");
    expect(list.status).toBe(200);
    expect((await list.json() as { gateChecks: Array<{ id: string }> }).gateChecks.map((item) => item.id))
      .toEqual([historical.id]);

    const sessionDetail = await app.request(`/api/gate-checks/${historical.id}`);
    expect(sessionDetail.status).toBe(200);
    expect((await sessionDetail.json() as GateCheckDetail).status).toBe("passed");

    const v1Detail = await app.request(`/api/v1/gate-checks/${historical.id}`, {
      headers: { authorization: `Bearer ${key}` }
    });
    expect(v1Detail.status).toBe(200);
    expect(v1Detail.headers.get("deprecation")).toBe("true");
    expect((await v1Detail.json() as GateCheckDetail).items).toHaveLength(1);

    expect((await app.request("/api/gate-checks/gate_missing")).status).toBe(404);
    expect((await app.request("/api/v1/gate-checks/gate_missing", {
      headers: { authorization: `Bearer ${key}` }
    })).status).toBe(404);
  });
});

describe("deriveGateCheckDecision — frozen historical semantics", () => {
  const base = { totalItems: 3, completedItems: 3, failedItems: 0, agreedItems: 3, maxDisagreements: 0 };

  it("passes only a fully-judged, agreement-clean run", () => {
    expect(deriveGateCheckDecision({ ...base, runStatus: "completed" })).toEqual({ status: "passed", disagreements: 0 });
  });

  it("blocks on disagreements above the threshold — and respects a loosened threshold", () => {
    expect(deriveGateCheckDecision({ ...base, runStatus: "completed", agreedItems: 2 }))
      .toEqual({ status: "blocked", disagreements: 1 });
    expect(deriveGateCheckDecision({ ...base, runStatus: "completed", agreedItems: 2, maxDisagreements: 1 }))
      .toEqual({ status: "passed", disagreements: 1 });
  });

  it("never passes on failures: failed runs, failed items, or shortfalls", () => {
    expect(deriveGateCheckDecision({ ...base, runStatus: "completed", completedItems: 2, failedItems: 1, agreedItems: 2 }).status).toBe("error");
    expect(deriveGateCheckDecision({ ...base, runStatus: "failed" }).status).toBe("error");
    expect(deriveGateCheckDecision({ ...base, runStatus: "canceled" }).status).toBe("error");
    expect(deriveGateCheckDecision({ ...base, runStatus: "completed", completedItems: 2, agreedItems: 2 }).status).toBe("error");
  });

  it("stays non-terminal in flight and fails closed on unknown statuses", () => {
    expect(deriveGateCheckDecision({ ...base, runStatus: "pending", completedItems: 0, agreedItems: 0 }).status).toBe("pending");
    expect(deriveGateCheckDecision({ ...base, runStatus: "running", completedItems: 1, agreedItems: 1 }).status).toBe("running");
    expect(deriveGateCheckDecision({ ...base, runStatus: "bogus" as EvalRunStatus }))
      .toEqual({ status: "error", disagreements: 0 });
  });
});
