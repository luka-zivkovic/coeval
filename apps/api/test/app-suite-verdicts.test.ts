import { describe, expect, it } from "vitest";

import { verdictLabelFromPayload } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

import { processLangSmithImportJob } from "../src/workers/langsmith-import.js";

import { CapturingQueue, FailingOnceQueue } from "./app-test-support.js";

describe("Coeval Hono API", () => {
  it("seeds demo verdicts when opted in, populating κ + both disagreement feeds", async () => {
    const seeded = new DemoRepository(undefined, { seedVerdicts: true });
    const projectId = "proj_langsmith_support";

    const kappa = await seeded.getProjectKappaSummary(projectId);
    expect(kappa.raterCount).toBeGreaterThanOrEqual(2);
    expect(kappa.pairs.length).toBeGreaterThan(0);

    const humanDisagree = await seeded.getDisagreementSummary(projectId);
    expect(humanDisagree.disagreedCases).toBeGreaterThan(0);

    const judgeDisagree = await seeded.getJudgeHumanDisagreementSummary(projectId);
    expect(judgeDisagree.disagreedCases).toBeGreaterThan(0);

    const detail = await seeded.getCaseDetail(projectId, "case_exc_002");
    expect(detail?.verdictHistory.filter((verdict) => verdict.source === "llm_judge").length).toBeGreaterThan(1);
    expect(detail?.verdictHistory.some((verdict) => verdict.source === "human")).toBe(true);
    const latestJudgeEvidence = detail?.verdictHistory.find((verdict) => verdict.source === "llm_judge");
    expect(latestJudgeEvidence).toBeDefined();
    expect(detail?.judgeRun).toMatchObject({
      verdict: verdictLabelFromPayload(latestJudgeEvidence!.payload),
      reasoning: latestJudgeEvidence!.payload.rationale,
      createdAt: latestJudgeEvidence!.createdAt
    });

    // The demo server opts into these seeded verdicts. Its unresolved queue
    // must therefore use the same projection as PG instead of showing cases
    // with already-recorded human rulings as still needing review.
    const dashboard = await seeded.getDashboardSummary(projectId);
    expect(dashboard.exceptions).toEqual([]);

    // The judge-run sink lands before the v2 verdict sink. If the latter
    // fails, PG still reopens from judge_runs; demo mode must do the same and
    // expose the durable run in case history rather than hiding the new work.
    const runOnly = await seeded.recordJudgeRun({
      projectId,
      caseId: "case_exc_003",
      skillVersionId: "skillv_1_2_0",
      verdict: {
        label: "ambiguous",
        score: 0.5,
        reason: "The evaluator re-ran, but its verdict-ledger write did not land.",
        confidence: 0.5
      }
    });
    const reopenedDashboard = await seeded.getDashboardSummary(projectId);
    expect(reopenedDashboard.exceptions.map((exception) => exception.id)).toContain("case_exc_003");
    expect(reopenedDashboard.currentVersionResultCount).toBe(dashboard.currentVersionResultCount);
    const reopenedDetail = await seeded.getCaseDetail(projectId, "case_exc_003");
    expect(reopenedDetail?.judgeRun.id).toBe(runOnly.id);
    expect(reopenedDetail?.verdictHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `verdict_from_${runOnly.id}`,
        source: "llm_judge",
        payload: expect.objectContaining({
          choice: "ambiguous",
          rationale: "The evaluator re-ran, but its verdict-ledger write did not land."
        })
      })
    ]));

    // Default (no opt-in) stays empty so other tests start clean.
    const empty = new DemoRepository();
    expect((await empty.getProjectKappaSummary(projectId)).raterCount).toBe(0);
  });

  it("records and filters v2 verdicts across sources via DemoRepository", async () => {
    const repository = new DemoRepository();
    const projectId = "proj_langsmith_support";
    const imported = await repository.importTrace(projectId, "manual", {
      sourceTraceId: "manual_verdict_target",
      input: { question: "Should the bot apologize?" },
      output: { answer: "Yes, with reasoning." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const llm = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "Apology with reasoning." }
    });
    const human = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "human",
      actorUserId: "user_reviewer",
      payload: {
        kind: "categorical",
        choice: "okay",
        choiceScores: { great: 1, okay: 0.5, bad: 0 },
        rationale: "Reasoning could be tighter."
      }
    });
    const ext = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "imported_external",
      externalRunId: "ls_run_external_42",
      payload: { kind: "scalar", score: 0.8, range: [0, 1], rationale: "LangSmith eval." }
    });

    // imported_external dedup keyed on (project, externalRunId).
    const extAgain = await repository.recordVerdict({
      projectId,
      caseId: imported.caseId,
      source: "imported_external",
      externalRunId: "ls_run_external_42",
      payload: { kind: "scalar", score: 0.0, range: [0, 1], rationale: "ignored — should dedup" }
    });
    expect(extAgain.id).toBe(ext.id);
    expect(extAgain.payload).toEqual(ext.payload);

    const all = await repository.listVerdicts({ projectId, caseId: imported.caseId, limit: 10 });
    expect(all.map((v) => v.id).sort()).toEqual([ext.id, human.id, llm.id].sort());
    expect(all).toHaveLength(3);

    const humansOnly = await repository.listVerdicts({ projectId, source: "human", limit: 10 });
    expect(humansOnly).toEqual([human]);

    const bySkill = await repository.listVerdicts({ projectId, skillVersionId: "skillv_1_2_0", limit: 10 });
    // Human/adjudicated verdicts now carry the same immutable evaluator
    // identity instead of an unscoped NULL binding.
    expect(bySkill).toHaveLength(2);
    expect(new Set(bySkill.map((verdict) => verdict.id))).toEqual(new Set([human.id, llm.id]));
  });

  it("records human verdicts on a case via the /verdicts endpoint", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const caseId = "case_exc_001"; // exists in demoExceptions

    const create = await localApp.request(`/api/cases/${caseId}/verdicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { kind: "binary", pass: false, rationale: "Cited outdated policy." }
      })
    });
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as { verdict: { id: string; source: string; payload: { kind: string } } };
    expect(createBody.verdict).toMatchObject({
      source: "human",
      payload: { kind: "binary", pass: false }
    });

    const list = await localApp.request(`/api/cases/${caseId}/verdicts`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { verdicts: Array<{ id: string }> };
    expect(listBody.verdicts.map((v) => v.id)).toEqual([createBody.verdict.id]);

    // Filter by source: human matches, llm_judge does not.
    const llmFiltered = await localApp.request(`/api/cases/${caseId}/verdicts?source=llm_judge`);
    expect(llmFiltered.status).toBe(200);
    await expect(llmFiltered.json()).resolves.toEqual({ verdicts: [] });
  });

  it("returns 404 when recording a verdict on a case not in this project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_does_not_exist/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationale: "ok" } })
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Case not found in this project" });
  });

  it("adjudicates a disagreed case, annotating the feed and leaving κ untouched (A2.2b-2)", async () => {
    // The seed leaves case_exc_001 as a live judge-vs-human disagreement (judge
    // fail, jules pass). Adjudicating it should mark it resolved without κ moving.
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const localApp = createApp(repository);

    const before = (await (await localApp.request("/api/projects/judge-human-disagreements")).json()) as {
      resolvedCases: number;
      cases: Array<{ caseId: string; adjudicatedLabel: string | null }>;
    };
    // The seed pre-adjudicates case_exc_003 (A2.2c regression story), so one of
    // the two judge-human disagreements starts resolved; case_exc_001 is open.
    expect(before.resolvedCases).toBe(1);
    const kappaBefore = await (await localApp.request("/api/projects/kappa")).json();

    const adjudicate = await localApp.request("/api/cases/case_exc_001/adjudicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: false, rationale: "Cited outdated policy — fail." } })
    });
    expect(adjudicate.status).toBe(201);
    await expect(adjudicate.json()).resolves.toMatchObject({ verdict: { source: "adjudicated", payload: { kind: "binary", pass: false } } });

    const after = (await (await localApp.request("/api/projects/judge-human-disagreements")).json()) as {
      resolvedCases: number;
      cases: Array<{ caseId: string; adjudicatedLabel: string | null }>;
    };
    expect(after.resolvedCases).toBe(2); // case_exc_003 (seeded) + case_exc_001 (just now)
    expect(after.cases.find((c) => c.caseId === "case_exc_001")?.adjudicatedLabel).toBe("fail");

    // κ is over human verdicts only — adjudication must not move it.
    const kappaAfter = await (await localApp.request("/api/projects/kappa")).json();
    expect(kappaAfter).toEqual(kappaBefore);
  });

  it("rejects a scalar adjudication payload (can't resolve a discrete split)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_exc_001/adjudicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "scalar", score: 0.5, range: [0, 1], rationale: "mid" } })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("discrete") });
  });

  it("returns 404 when adjudicating a case not in this project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_does_not_exist/adjudicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationale: "ok" } })
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Case not found in this project" });
  });

  it("runs the pinned evaluator on the server-selected uncovered adjudicated case", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      skillVersionId: "skillv_1_2_0",
      source: "adjudicated",
      actorUserId: "user_priya",
      payload: { kind: "binary", pass: true, rationale: "Recorded legacy ruling for coverage test." }
    });
    const localApp = createApp(repository);
    const base = "/api/skills/skill_support_quality/versions/skillv_1_1_0/convergence";
    const before = await (await localApp.request(base)).json() as {
      audit: { adjudicatedTotal: number; comparedCases: number };
      nextUncoveredCaseId: string | null;
    };
    expect(before.audit.adjudicatedTotal).toBe(4);
    expect(before.audit.comparedCases).toBe(3);
    expect(before.nextUncoveredCaseId).toBe("case_exc_002");

    const response = await localApp.request(`${base}/runs`, { method: "POST" });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      caseId: "case_exc_002",
      run: { skillVersionId: "skillv_1_1_0", totalItems: 1, completedItems: 1, status: "completed" }
    });
    const after = await (await localApp.request(base)).json() as typeof before;
    expect(after.audit.comparedCases).toBe(4);
    expect(after.nextUncoveredCaseId).toBeNull();
  });

  it("deduplicates concurrent coverage-run requests before provider dispatch", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      skillVersionId: "skillv_1_2_0",
      source: "adjudicated",
      actorUserId: "user_priya",
      payload: { kind: "binary", pass: true, rationale: "Recorded legacy ruling for concurrency test." }
    });
    const queue = new CapturingQueue();
    const localApp = createApp(repository, { queue });
    const path = "/api/skills/skill_support_quality/versions/skillv_1_1_0/convergence/runs";
    const responses = await Promise.all([
      localApp.request(path, { method: "POST" }),
      localApp.request(path, { method: "POST" })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 503]);
    expect(responses.find((response) => response.status === 503)?.headers.get("retry-after")).toBe("300");
    const bodies = await Promise.all(responses.map(async (response) => response.json())) as Array<{
      run: { id: string };
      caseId: string;
    }>;
    expect(bodies[0]?.caseId).toBe("case_exc_002");
    expect(bodies[1]?.run.id).toBe(bodies[0]?.run.id);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      data: { projectId: "proj_langsmith_support", evalRunId: bodies[0]!.run.id },
      options: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) }
    });
    expect((await localApp.request(path, { method: "POST" })).status).toBe(202);
    expect(queue.jobs).toHaveLength(1);
  });

  it("releases a failed coverage dispatch claim and durably records the successful retry", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      skillVersionId: "skillv_1_2_0",
      source: "adjudicated",
      actorUserId: "user_priya",
      payload: { kind: "binary", pass: true, rationale: "Recorded legacy ruling for dispatch retry." }
    });
    const queue = new FailingOnceQueue();
    const localApp = createApp(repository, { queue });
    const path = "/api/skills/skill_support_quality/versions/skillv_1_1_0/convergence/runs";

    expect((await localApp.request(path, { method: "POST" })).status).toBe(500);
    const retried = await localApp.request(path, { method: "POST" });
    expect(retried.status).toBe(202);
    const body = await retried.json() as { run: { id: string } };
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      data: { evalRunId: body.run.id },
      options: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) }
    });

    expect((await localApp.request(path, { method: "POST" })).status).toBe(202);
    expect(queue.jobs).toHaveLength(1);
  });

  it("skips coeval-internal traces on manual import (anti-recursion guard)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const before = (await (await localApp.request("/api/dashboard")).json()) as { project: { importedTraceCount: number } };

    const response = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceTraceId: "internal_judge_call_123",
        input: { question: "internal probe" },
        output: { answer: "internal response" },
        metadata: { coeval: { internal: true } }
      })
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ skipped: true, reason: "coeval_internal" });

    const after = (await (await localApp.request("/api/dashboard")).json()) as { project: { importedTraceCount: number } };
    expect(after.project.importedTraceCount).toBe(before.project.importedTraceCount);
  });

  it("skips coeval-internal traces in the LangSmith import worker", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    const integration = await repository.createLangSmithIntegration("proj_langsmith_support", {
      apiKey: "ls_test_key",
      projectName: "Support Agent"
    });

    const result = await processLangSmithImportJob(repository, queue, {
      projectId: "proj_langsmith_support",
      integrationId: integration.id,
      skillVersionId: "skillv_1_2_0",
      limit: 3
    }, () => ({
      async listRuns() {
        return [
          {
            sourceTraceId: "ls_run_internal",
            input: { question: "internal probe" },
            output: { answer: "internal" },
            metadata: { coeval: { internal: true } }
          },
          {
            sourceTraceId: "ls_run_real",
            input: { question: "real customer question" },
            output: { answer: "real customer answer" },
            metadata: {}
          }
        ];
      }
    }));

    // Only one trace was actually imported; the coeval-internal one was skipped
    // without creating another tracked evaluation.
    expect(result.imported).toBe(1);
    expect(result.queued).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      name: "eval.run",
      data: { projectId: "proj_langsmith_support", evalRunId: expect.any(String) }
    });
  });
});
