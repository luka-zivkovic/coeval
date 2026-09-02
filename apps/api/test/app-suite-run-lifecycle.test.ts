import { describe, expect, it } from "vitest";

import type { Queue } from "@coeval/queue";
import { type GateRunJob } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

import { dispatchEvalRunOnce, processGateRunJob, runExistingCaseBackfill } from "../src/workers/gate.js";

import { scheduleImportedCaseJudging } from "../src/workers/import-judging.js";

import { CapturingQueue, EmptySkillRepository } from "./app-test-support.js";

describe("Coeval Hono API", () => {
  it("PR #56/C5a: timeScope='new' (default) — async gate approves, no backfill", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const appWithQueue = createApp(repository, { queue });
    const response = await appWithQueue.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Updated rubric\n\nKeep judging support quality, just clarified phrasing.",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 }
      })
    });
    // Async gate (C5a): submit lands the version in `calibrating` (202) and
    // enqueues gate.run; the worker flips the status.
    expect(response.status).toBe(202);
    const body = (await response.json()) as { version: { id: string; status: string }; queued: boolean };
    expect(body.version.status).toBe("calibrating");
    expect(body.queued).toBe(true);
    const gateJobs = queue.jobs.filter((job) => job.name === "gate.run");
    expect(gateJobs).toHaveLength(1);

    await processGateRunJob(repository, gateJobs[0]!.data as GateRunJob, queue);
    const run = await repository.getRegressionRunForVersion("proj_langsmith_support", body.version.id);
    expect(run?.status).toBe("passed");
    const versions = await repository.listSkillVersions("proj_langsmith_support", "skill_support_quality");
    expect(versions.find((v) => v.id === body.version.id)?.status).toBe("approved");
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("records timeScope='both' backfill as one durable eval run after the gate passes", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const appWithQueue = createApp(repository, { queue });

    // Seed a few imported traces so backfill has something to chew on.
    for (let i = 0; i < 3; i += 1) {
      await repository.importTrace("proj_langsmith_support", "manual", {
        sourceTraceId: `backfill_seed_${i}`,
        input: { question: `q${i}` },
        output: { answer: `a${i}` },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
    }

    const response = await appWithQueue.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Updated rubric\n\nKeep judging support quality.",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 },
        timeScope: "both"
      })
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { version: { id: string } };
    const gateJob = queue.jobs.find((job) => job.name === "gate.run")!;
    expect((gateJob.data as { timeScope?: string }).timeScope).toBe("both");

    await processGateRunJob(repository, gateJob.data as GateRunJob, queue);
    const caseIds = await repository.listCaseIdsForProject("proj_langsmith_support");
    const evalRuns = await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: body.version.id });
    expect(evalRuns).toHaveLength(1);
    expect(evalRuns[0]).toMatchObject({
      trigger: "backfill",
      status: "pending",
      totalItems: caseIds.length,
      skillVersionId: body.version.id
    });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toEqual([
      expect.objectContaining({
        data: { projectId: "proj_langsmith_support", evalRunId: evalRuns[0]!.id }
      })
    ]);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);

    // A replay observes the same durable run instead of creating another
    // provider-spending batch.
    await processGateRunJob(repository, gateJob.data as GateRunJob, queue);
    expect(await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: body.version.id })).toHaveLength(1);
  });

  it("records and completes the same backfill lifecycle in queue-less demo mode", async () => {
    const repository = new DemoRepository();
    const demoApp = createApp(repository);
    const response = await demoApp.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "## Updated rubric\n\nKeep judging support quality with clearer wording.",
        prompt: "Judge support answer quality.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 },
        timeScope: "both"
      })
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { version: { id: string } };
    const runs = await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: body.version.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: "backfill",
      status: "completed",
      skillVersionId: body.version.id
    });
    expect(runs[0]!.completedItems).toBeGreaterThan(0);
  });

  it("does not poison a Check with an empty backfill before its first Run arrives", async () => {
    class InitiallyEmptyRepository extends DemoRepository {
      empty = true;
      override async listCaseIdsForProject(...args: Parameters<DemoRepository["listCaseIdsForProject"]>) {
        return this.empty ? [] : super.listCaseIdsForProject(...args);
      }
    }
    const repository = new InitiallyEmptyRepository();

    await expect(runExistingCaseBackfill(
      repository,
      "proj_langsmith_support",
      "skillv_1_2_0"
    )).resolves.toBeNull();
    await expect(repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    })).resolves.toHaveLength(0);

    repository.empty = false;
    const backfill = await runExistingCaseBackfill(repository, "proj_langsmith_support", "skillv_1_2_0");
    expect(backfill?.run).toMatchObject({ trigger: "backfill", status: "completed" });
    expect(backfill!.run.totalItems).toBeGreaterThan(0);
  });

  it("idempotently starts the first Result when a Check existed before its Runs", async () => {
    const repository = new DemoRepository();
    const demoApp = createApp(repository);
    const path = "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill";
    const first = await demoApp.request(path, { method: "POST" });
    const second = await demoApp.request(path, { method: "POST" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { run: { id: string; trigger: string; status: string } };
    const secondBody = (await second.json()) as { run: { id: string } };
    expect(firstBody.run).toMatchObject({ trigger: "backfill", status: "completed" });
    expect(secondBody.run.id).toBe(firstBody.run.id);
    expect(await repository.listEvalRuns("proj_langsmith_support", { skillVersionId: "skillv_1_2_0" })).toHaveLength(1);
  });

  it("puts a clean install's first imported Run in the same tracked Result lifecycle", async () => {
    class CleanInstallRepository extends DemoRepository {
      importedCaseId: string | null = null;

      override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
        const result = await super.importTrace(...args);
        this.importedCaseId = result.caseId;
        return result;
      }

      override async listCaseIdsForProject(
        _projectId: string,
        limit?: number | undefined
      ): Promise<string[]> {
        const ids = this.importedCaseId ? [this.importedCaseId] : [];
        return limit === undefined ? ids : ids.slice(0, limit);
      }
    }
    const queue = new CapturingQueue();
    const repository = new CleanInstallRepository();
    const cleanApp = createApp(repository, { queue });

    const imported = await cleanApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: "skillv_1_2_0",
        sourceTraceId: "clean-install-first-run",
        input: { question: "Can I return this?" },
        output: { answer: "Yes." },
        metadata: {}
      })
    });
    expect(imported.status).toBe(201);
    await expect(imported.json()).resolves.toMatchObject({ queued: true, queueJobId: null });

    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "backfill", totalItems: 1, status: "pending" });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);

    const continued = await cleanApp.request(
      "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill",
      { method: "POST" }
    );
    expect(continued.status).toBe(202);
    await expect(continued.json()).resolves.toMatchObject({ run: { id: runs[0]!.id } });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("lets the owner keep polling a current starter draft that already queued its first Result", async () => {
    class StarterDraftRepository extends DemoRepository {
      override async getSkillVersion(...args: Parameters<DemoRepository["getSkillVersion"]>) {
        const version = await super.getSkillVersion(...args);
        return version?.id === "skillv_1_2_0"
          ? { ...version, status: "draft" as const, approvedAt: null }
          : version;
      }

      override async getCurrentSkillForCriterion(...args: Parameters<DemoRepository["getCurrentSkillForCriterion"]>) {
        const skill = await super.getCurrentSkillForCriterion(...args);
        return skill.currentVersion.id === "skillv_1_2_0"
          ? {
              ...skill,
              isStarter: true,
              currentVersion: { ...skill.currentVersion, status: "draft" as const, approvedAt: null }
            }
          : skill;
      }
    }
    const repository = new StarterDraftRepository();
    const queue = new CapturingQueue();
    const localApp = createApp(repository, { queue });
    const imported = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: "skillv_1_2_0",
        sourceTraceId: "starter-draft-first-run",
        input: { question: "Can a starter Check run?" },
        output: { answer: "Yes, while remaining unvalidated." },
        metadata: {}
      })
    });
    expect(imported.status).toBe(201);
    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    expect(runs).toHaveLength(1);

    const continued = await localApp.request(
      "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill",
      { method: "POST" }
    );
    expect(continued.status).toBe(202);
    await expect(continued.json()).resolves.toMatchObject({ run: { id: runs[0]!.id } });
  });

  it("converges concurrent first imports on durable runs without loose judge jobs", async () => {
    class CleanInstallRepository extends DemoRepository {
      readonly importedCaseIds: string[] = [];

      override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
        const result = await super.importTrace(...args);
        if (!this.importedCaseIds.includes(result.caseId)) this.importedCaseIds.push(result.caseId);
        return result;
      }

      override async listCaseIdsForProject(
        _projectId: string,
        limit?: number | undefined
      ): Promise<string[]> {
        return limit === undefined
          ? [...this.importedCaseIds]
          : this.importedCaseIds.slice(0, limit);
      }

      override async listVerdicts(input: Parameters<DemoRepository["listVerdicts"]>[0]) {
        if (input.evidenceScope === "customer" && input.source === "llm_judge") return [];
        return super.listVerdicts(input);
      }
    }
    const repository = new CleanInstallRepository();
    const queue = new CapturingQueue();
    const first = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "concurrent-first-a",
      input: { question: "A?" },
      output: { answer: "A." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const second = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "concurrent-first-b",
      input: { question: "B?" },
      output: { answer: "B." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    await Promise.all([
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [first.caseId]
      }),
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [second.caseId]
      })
    ]);

    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    const details = await Promise.all(runs.map((run) => repository.getEvalRunDetail(
      "proj_langsmith_support",
      run.id
    )));
    const evaluatedCaseIds = details.flatMap((detail) => detail?.items.map((item) => item.caseId) ?? []);
    expect(evaluatedCaseIds.sort()).toEqual([first.caseId, second.caseId].sort());
    expect(new Set(evaluatedCaseIds).size).toBe(2);
    expect(runs.filter((run) => run.trigger === "backfill")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("uses one durable per-case run when concurrent import retries follow an existing Result", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      skillVersionId: "skillv_1_2_0",
      source: "llm_judge",
      payload: { kind: "binary", pass: true, rationale: "Existing customer Result." }
    });
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "concurrent-later-case",
      input: { question: "Later?" },
      output: { answer: "Later." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    await Promise.all([
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [imported.caseId]
      }),
      scheduleImportedCaseJudging(repository, queue, {
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_1_2_0",
        caseIds: [imported.caseId]
      })
    ]);

    const runs = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    const matching = [];
    for (const run of runs) {
      const detail = await repository.getEvalRunDetail("proj_langsmith_support", run.id);
      if (detail?.items.some((item) => item.caseId === imported.caseId)) matching.push(detail);
    }
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ trigger: "api_batch", totalItems: 1 });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
  });

  it("does not claim an undispatched Result run is queued and recovers on retry", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const [caseId] = await repository.listCaseIdsForProject("proj_langsmith_support", 1);
    const run = await repository.createEvalRun({
      projectId: "proj_langsmith_support",
      skillVersionId: "skillv_1_2_0",
      trigger: "backfill",
      items: [{ caseId: caseId! }]
    });
    const abandonedToken = "abandoned-first-result-dispatch";
    await expect(repository.claimEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: abandonedToken
    })).resolves.toMatchObject({ state: "claimed" });
    const localApp = createApp(repository, { queue });
    const path = "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill";

    const busy = await localApp.request(path, { method: "POST" });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("300");
    await expect(busy.json()).resolves.toMatchObject({
      error: expect.stringContaining("not durably queued"),
      run: { id: run.id, status: "pending" }
    });
    expect(queue.jobs).toHaveLength(0);

    await repository.releaseEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: abandonedToken
    });
    const recovered = await localApp.request(path, { method: "POST" });
    expect(recovered.status).toBe(202);
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
  });

  it("rotates an exhausted deterministic queue id before marking a run dispatched", async () => {
    const repository = new DemoRepository();
    const [caseId] = await repository.listCaseIdsForProject("proj_langsmith_support", 1);
    const run = await repository.createEvalRun({
      projectId: "proj_langsmith_support",
      skillVersionId: "skillv_1_2_0",
      trigger: "api_batch",
      items: [{ caseId: caseId! }]
    });
    const attemptedIds: string[] = [];
    const exhaustedQueue: Queue = {
      async start() {},
      async stop() {},
      async work() {},
      async send(_name, _data, options) {
        attemptedIds.push(String(options?.id));
        return attemptedIds.length === 1 ? null : String(options?.id);
      },
      async getJobState(_name, id) {
        return id === attemptedIds[0] ? "failed" : null;
      }
    };

    await expect(dispatchEvalRunOnce(repository, run, exhaustedQueue)).resolves.toBe("ready");
    expect(attemptedIds).toHaveLength(2);
    expect(attemptedIds[1]).not.toBe(attemptedIds[0]);
    await expect(repository.claimEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: "verification-claim"
    })).resolves.toMatchObject({ state: "dispatched", jobId: attemptedIds[1] });
  });

  it("PR #56/C5a: blocked gate leaves the version regressing and skips backfill even when timeScope=existing", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const appWithQueue = createApp(repository, { queue });
    const response = await appWithQueue.request("/api/skills/skill_support_quality/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rubricMarkdown: "Fail borderline cases and require perfect answers.",
        prompt: "Be stricter than before.",
        modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "2026-04-15", temperature: 0 },
        timeScope: "existing"
      })
    });
    // The async submit always 202s; the BLOCK surfaces via the recorded run
    // (which the web client polls) and the `regressing` version status.
    expect(response.status).toBe(202);
    const body = (await response.json()) as { version: { id: string } };
    const gateJob = queue.jobs.find((job) => job.name === "gate.run")!;

    await processGateRunJob(repository, gateJob.data as GateRunJob, queue);
    const run = await repository.getRegressionRunForVersion("proj_langsmith_support", body.version.id);
    expect(run?.status).toBe("blocked");
    const versions = await repository.listSkillVersions("proj_langsmith_support", "skill_support_quality");
    expect(versions.find((v) => v.id === body.version.id)?.status).toBe("regressing");
    expect(queue.jobs.filter((job) => job.name === "judge.run")).toHaveLength(0);
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(0);

    const rejectedImport = await appWithQueue.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: body.version.id,
        sourceTraceId: "blocked-version-import",
        input: { question: "Should not run" },
        output: { answer: "Should not be judged" },
        metadata: {}
      })
    });
    expect(rejectedImport.status).toBe(409);
    await expect(rejectedImport.json()).resolves.toMatchObject({
      code: "skill_version_not_runnable",
      error: "Imported Runs can be evaluated only by the current runnable Check."
    });
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(0);

    const rejected = await appWithQueue.request(
      `/api/skills/skill_support_quality/versions/${body.version.id}/backfill`,
      { method: "POST" }
    );
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: "Only the current runnable Check can produce the first Result."
    });
    expect(await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: body.version.id
    })).toHaveLength(0);
  });

  it("PR #59: GET /api/projects/verdicts returns project-scope verdicts with filter + limit", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    // Seed verdicts of mixed sources.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "ok" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: false, rationale: "auto" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_b",
      payload: { kind: "binary", pass: true, rationale: "" }
    });

    // No filter → 3 verdicts (newest first per repository sort).
    const all = await localApp.request("/api/projects/verdicts");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { verdicts: Array<{ id: string; source: string }> };
    expect(allBody.verdicts).toHaveLength(3);

    // source=human → 2 verdicts.
    const humans = await localApp.request("/api/projects/verdicts?source=human");
    const humansBody = (await humans.json()) as { verdicts: Array<{ id: string; source: string }> };
    expect(humansBody.verdicts).toHaveLength(2);
    expect(humansBody.verdicts.every((v) => v.source === "human")).toBe(true);

    // limit=1 → 1 verdict (the newest).
    const limited = await localApp.request("/api/projects/verdicts?limit=1");
    const limitedBody = (await limited.json()) as { verdicts: Array<{ id: string }> };
    expect(limitedBody.verdicts).toHaveLength(1);

    // Bad query → 400.
    const bad = await localApp.request("/api/projects/verdicts?source=zombies");
    expect(bad.status).toBe(400);
  });

  it("PR #58: exports verdicts as JSONL with content-disposition + jsonl content-type", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "ok" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "categorical", choice: "okay", choiceScores: { good: 1, okay: 0.5, bad: 0 }, rationale: "borderline" }
    });

    const response = await localApp.request("/api/projects/verdicts/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="coeval-verdicts-\d{4}-\d{2}-\d{2}\.jsonl"/);
    const text = await response.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { source: string; payload: { kind: string } };
    expect(first.source).toBe("human");
    expect(first.payload.kind).toBeDefined();
  });

  it("PR #58: exports verdicts as CSV with RFC-4180-style quoting + filter query params", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: false, rationale: 'They said: "nope, wrong policy"' } // intentional comma + quote
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "auto" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_101",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", label: "ambiguous", rationale: "insufficient evidence" }
    });

    // No source filter → all rows + header.
    const allResponse = await localApp.request("/api/projects/verdicts/export?format=csv");
    expect(allResponse.status).toBe(200);
    expect(allResponse.headers.get("content-type")).toMatch(/text\/csv/);
    expect(allResponse.headers.get("content-disposition")).toMatch(/\.csv"/);
    const allText = await allResponse.text();
    expect(allText.split("\n")).toHaveLength(4); // header + 3 rows
    expect(allText.split("\n")[0]).toContain("verdict_kind,verdict_value,rationale");
    expect(allText).toContain("binary,ambiguous,insufficient evidence");
    // Rationale with a quote + colon gets properly escaped:
    expect(allText).toContain(`"They said: ""nope, wrong policy"""`);

    // source=human filter → just the human row.
    const humanResponse = await localApp.request("/api/projects/verdicts/export?format=csv&source=human");
    expect(humanResponse.status).toBe(200);
    const humanText = await humanResponse.text();
    expect(humanText.split("\n")).toHaveLength(2); // header + 1 row
    expect(humanText).toContain("reviewer_a");
    expect(humanText).not.toContain("llm_judge");
  });

  it("PR #58: rejects invalid export query (bad format, source out of enum)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const badFormat = await localApp.request("/api/projects/verdicts/export?format=parquet");
    expect(badFormat.status).toBe(400);
    const badSource = await localApp.request("/api/projects/verdicts/export?source=ghosts");
    expect(badSource.status).toBe(400);
  });

  it("imports a manual trace and enqueues one durable evaluation run", async () => {
    const queue = new CapturingQueue();
    const appWithQueue = createApp(new DemoRepository(), { queue });
    const response = await appWithQueue.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceTraceId: "manual_trace_001",
        input: { question: "Can I get a refund?" },
        output: { answer: "Yes, refunds are available." },
        metadata: { source: "test" }
      })
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { caseId: string; queued: boolean; queueJobId: string | null };
    expect(body.queued).toBe(true);
    expect(body.queueJobId).toBeNull();
    expect(queue.jobs).toEqual([
      {
        name: "eval.run",
        data: {
          projectId: "proj_langsmith_support",
          evalRunId: expect.any(String)
        },
        options: { id: expect.any(String), retryLimit: 5, retryBackoff: true }
      }
    ]);
  });

  it("does not call a terminal-failed import evaluation newly queued on retry", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    const localApp = createApp(repository, { queue });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      skillVersionId: "skillv_1_2_0",
      source: "llm_judge",
      payload: { kind: "binary", pass: true, rationale: "Existing customer Result." }
    });
    const body = {
      skillVersionId: "skillv_1_2_0",
      sourceTraceId: "terminal-failed-import-retry",
      input: { question: "Retry?" },
      output: { answer: "Do not overstate it." },
      metadata: {}
    };
    const first = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ created: true, queued: true });
    const [run] = await repository.listEvalRuns("proj_langsmith_support", {
      skillVersionId: "skillv_1_2_0"
    });
    const detail = await repository.getEvalRunDetail("proj_langsmith_support", run!.id);
    await repository.failEvalRunItem({
      projectId: "proj_langsmith_support",
      evalRunId: run!.id,
      evalRunItemId: detail!.items[0]!.id,
      error: "provider unavailable"
    });
    queue.jobs.length = 0;

    const retried = await localApp.request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(retried.status).toBe(201);
    await expect(retried.json()).resolves.toMatchObject({ created: false, queued: false });
    expect(queue.jobs).toHaveLength(0);
  });

  it("keeps a Run saved but does not evaluate it if the current Check changes during import", async () => {
    class CheckChangesDuringImportRepository extends DemoRepository {
      changed = false;

      override async importTrace(...args: Parameters<DemoRepository["importTrace"]>) {
        const imported = await super.importTrace(...args);
        this.changed = true;
        return imported;
      }

      override async getCurrentSkillForCriterion(...args: Parameters<DemoRepository["getCurrentSkillForCriterion"]>) {
        const current = await super.getCurrentSkillForCriterion(...args);
        return this.changed
          ? {
              ...current,
              currentVersion: { ...current.currentVersion, id: "skillv_replaced_during_import" }
            }
          : current;
      }
    }
    const repository = new CheckChangesDuringImportRepository();
    const queue = new CapturingQueue();
    const response = await createApp(repository, { queue }).request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillVersionId: "skillv_1_2_0",
        sourceTraceId: "check-changed-mid-import",
        input: { question: "Was this saved?" },
        output: { answer: "Yes, without judging the old Check." },
        metadata: {}
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      queued: false,
      queueJobId: null,
      code: "skill_version_not_runnable",
      error: "The Run was saved, but the selected Check changed before evaluation could start."
    });
    expect(queue.jobs).toHaveLength(0);
  });

  it("returns 400 before importing when no skill version exists", async () => {
    const repository = new EmptySkillRepository();
    const response = await createApp(repository, { queue: new CapturingQueue() }).request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { question: "Can I get a refund?" },
        output: { answer: "Yes." },
        metadata: {}
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "No active skill version. Define one before judging." });
    expect(repository.importCalled).toBe(false);
  });

  it("returns 500 when skill lookup unexpectedly fails before importing", async () => {
    const repository = new class extends DemoRepository {
      override async getCurrentSkill(): Promise<never> {
        throw new Error("Skill lookup unavailable");
      }
    }();

    const manualResponse = await createApp(repository, { queue: new CapturingQueue() }).request("/api/traces/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { question: "Can I get a refund?" },
        output: { answer: "Yes." },
        metadata: {}
      })
    });
    expect(manualResponse.status).toBe(500);
    await expect(manualResponse.json()).resolves.toMatchObject({ error: "Internal server error" });

    const langSmithResponse = await createApp(repository, { queue: new CapturingQueue() }).request("/api/integrations/langsmith/int_boom/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 })
    });
    expect(langSmithResponse.status).toBe(500);
    await expect(langSmithResponse.json()).resolves.toMatchObject({ error: "Internal server error" });
  });
});
