import { expect, it } from "vitest";

import { runMigrations } from "@coeval/db";
import { createQueue } from "@coeval/queue";

import { GoldenSetEntryAlreadyRetiredError, IronsideIntegrationAlreadyExistsError, IronsideIntegrationRevalidationRequiredError } from "../src/repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { processFeedbackSyncJob } from "../src/workers/feedback-sync.js";

import { processJudgeRunJob, registerJudgeRunWorker } from "../src/workers/judge.js";
import { processLangSmithImportJob } from "../src/workers/langsmith-import.js";

import { ironsideTraceToTraceImport } from "../src/lib/ironside.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { CapturingQueue, FailingOnceQueue, runPgSmoke, seedSkill, waitFor } from "./pg-smoke-support.js";

runPgSmoke("PgRepository smoke", () => {
  it("processes judge.run jobs through the real pg-boss queue", async () => {
    const { pool, databaseUrl: connectionString, cleanup } = await openPostgresTestDatabase("queue_smoke");
    const queue = createQueue(connectionString);
    let queueStarted = false;
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      await queue.start();
      queueStarted = true;
      await registerJudgeRunWorker(queue, repo);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "manual_trace_queue_smoke",
        input: { question: "Is this correct?" },
        output: { answer: "This is correct." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await queue.send("judge.run", {
        projectId: "proj_test",
        caseId: imported.caseId,
        skillVersionId: "skillv_test"
      }, { retryLimit: 5, retryBackoff: true });

      await waitFor(async () => {
        const dashboard = await repo.getDashboardSummary("proj_test");
        return dashboard.project.autoJudgedTraceCount === 1 && dashboard.verdictDistribution.pass === 1;
      }, 10_000);
    } finally {
      if (queueStarted) await queue.stop();
      await cleanup();
    }
  }, 30_000);

  it("imports the same LangSmith run twice idempotently", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-langsmith-import-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const queue = new CapturingQueue();
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      await pool.query(`update skill_versions set status = 'approved', approved_at = now() where id = 'skillv_test'`);

      const integration = await repo.createLangSmithIntegration("proj_test", { apiKey: "ls_test_key", projectName: "Support Agent" });
      const importJob = await repo.createImportJob({
        projectId: "proj_test",
        source: "langsmith",
        sourceIntegrationId: integration.id,
        requestedLimit: 1
      });
      const createClient = () => ({
        async listRuns() {
          return [
            {
              sourceTraceId: "ls_run_123",
              input: { question: "Refund?" },
              output: { answer: "Refunds are available." },
              metadata: { source: "langsmith" }
            }
          ];
        }
      });

      await expect(processLangSmithImportJob(repo, queue, {
        projectId: "proj_test",
        integrationId: integration.id,
        skillVersionId: importJob.skillVersionId!,
        limit: 1,
        importJobId: importJob.id
      }, createClient)).resolves.toEqual({ imported: 1, queued: 1 });
      const firstEvalRunId = (queue.jobs[0]?.data as { evalRunId?: string } | undefined)?.evalRunId;

      const retryJob = await repo.createImportJob({
        projectId: "proj_test",
        source: "langsmith",
        sourceIntegrationId: integration.id,
        requestedLimit: 1
      });
      await expect(processLangSmithImportJob(repo, queue, {
        projectId: "proj_test",
        integrationId: integration.id,
        skillVersionId: retryJob.skillVersionId!,
        limit: 1,
        importJobId: retryJob.id
      }, createClient)).resolves.toEqual({ imported: 0, queued: 1 });
      expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
      const runs = await repo.listEvalRuns("proj_test", { skillVersionId: "skillv_test" });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(firstEvalRunId);
      const runDetail = await repo.getEvalRunDetail("proj_test", runs[0]!.id);
      expect(runDetail?.items).toEqual([
        expect.objectContaining({ caseId: expect.any(String) })
      ]);
      const counts = await pool.query(
        `select
           (select count(*)::int from raw_traces) as raw_count,
           (select count(*)::int from cases) as case_count,
           (select imported_trace_count from projects where id = 'proj_test') as imported_trace_count`
      );
      expect(counts.rows[0]).toMatchObject({ raw_count: 1, case_count: 1, imported_trace_count: 1 });
      const importJobRows = await pool.query(`select status, imported_count, queued_judge_count, created_at, started_at from import_jobs where id = $1`, [importJob.id]);
      expect(importJobRows.rows[0]).toMatchObject({
        status: "completed",
        imported_count: 1,
        queued_judge_count: 1,
        created_at: expect.any(Date),
        started_at: expect.any(Date)
      });
      const retryJobRows = await pool.query(`select status, imported_count, queued_judge_count from import_jobs where id = $1`, [retryJob.id]);
      expect(retryJobRows.rows[0]).toMatchObject({
        status: "completed",
        imported_count: 0,
        queued_judge_count: 1
      });
      const rawTraceRows = await pool.query(`select import_job_id from raw_traces where source_trace_id = $1`, ["ls_run_123"]);
      expect(rawTraceRows.rows[0]?.import_job_id).toBe(importJob.id);

      await repo.deleteLangSmithIntegration("proj_test", integration.id, {});
      await expect(repo.listLangSmithIntegrations("proj_test")).resolves.toEqual([]);
      const sourceRows = await pool.query(`select source_integration_id from raw_traces where source_trace_id = $1`, ["ls_run_123"]);
      expect(sourceRows.rows[0]?.source_integration_id).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("deduplicates Ironside snapshots by trace id and remote trace version", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_ironside_versions");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      const input = {
        sourceTraceId: "ironside_reopened",
        input: { question: "Refund?" },
        output: { answer: "Within 30 days." },
        metadata: { source: "ironside" }
      };
      const firstContext = {
        ingestionPurpose: "analysis_eligible_ironside" as const,
        sourceTraceVersion: "2026-08-01T12:00:00.000Z",
        sourceRemoteProjectId: "remote_project_a"
      };
      const first = await repo.importTrace("proj_test", "ironside", input, firstContext);
      const retry = await repo.importTrace("proj_test", "ironside", input, firstContext);
      const reopened = await repo.importTrace("proj_test", "ironside", input, {
        ...firstContext,
        sourceTraceVersion: "2026-08-01T12:05:00.000Z"
      });
      const otherRemote = await repo.importTrace("proj_test", "ironside", input, {
        ...firstContext,
        sourceRemoteProjectId: "remote_project_b"
      });

      expect(first.created).toBe(true);
      expect(retry).toMatchObject({ created: false, caseId: first.caseId });
      expect(reopened).toMatchObject({ created: true });
      expect(reopened.caseId).not.toBe(first.caseId);
      expect(otherRemote).toMatchObject({ created: true });
      expect(otherRemote.caseId).not.toBe(first.caseId);
      const rows = await pool.query(
        `select source_remote_project_id, source_trace_version from raw_traces
         where project_id = 'proj_test' and source_trace_id = 'ironside_reopened'
         order by source_remote_project_id, source_trace_version`
      );
      expect(rows.rows).toEqual([
        { source_remote_project_id: "remote_project_a", source_trace_version: "2026-08-01T12:00:00.000Z" },
        { source_remote_project_id: "remote_project_a", source_trace_version: "2026-08-01T12:05:00.000Z" },
        { source_remote_project_id: "remote_project_b", source_trace_version: "2026-08-01T12:00:00.000Z" }
      ]);
    } finally {
      await cleanup();
    }
  });

  it("stores PostgreSQL-unsafe Ironside payload strings without collisions or cursor poison", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_ironside_unsafe_strings");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      const input = ironsideTraceToTraceImport({
        id: "ironside_unsafe",
        traceVersion: "2026-08-30T12:00:00.000001Z",
        timestamp: "2026-08-30T12:00:00.000Z",
        name: null,
        userId: null,
        sessionId: null,
        environment: null,
        release: null,
        version: null,
        tags: [],
        metadata: {},
        input: {
          "key\0x": "nul\0value",
          "key\\0x": "literal\\0value",
          lone: "x\ud800y",
          path: "C:\\temp\\trace.json",
          marker: "literal\ue0000value"
        },
        output: null,
        observations: [{
          id: "obs_unsafe",
          parentObservationId: null,
          type: "span",
          name: "step\0name\udfff",
          startTime: "2026-08-30T12:00:00.000Z",
          endTime: null,
          level: "default",
          statusMessage: null,
          model: null,
          modelParameters: {},
          input: null,
          output: null,
          usageDetails: {},
          costDetails: {},
          completionStartTime: null,
          metadata: {},
          children: []
        }]
      });

      await expect(repo.importTrace("proj_test", "ironside", input, {
        ingestionPurpose: "analysis_eligible_ironside",
        sourceTraceVersion: "2026-08-30T12:00:00.000001Z",
        sourceRemoteProjectId: "remote_project_a"
      })).resolves.toMatchObject({ created: true });

      const result = await pool.query<{ raw_payload: unknown }>(
        `select raw_payload from raw_traces
          where project_id = 'proj_test' and source_trace_id = 'ironside_unsafe'`
      );
      expect(JSON.stringify(result.rows[0]?.raw_payload)).not.toContain("\0");
      expect((result.rows[0]?.raw_payload as { input: Record<string, unknown> }).input)
        .toEqual({
          "key\ue0000x": "nul\ue0000value",
          "key\\0x": "literal\\0value",
          lone: "x\ue000ud800y",
          path: "C:\\temp\\trace.json",
          marker: "literal\ue000e0value"
        });
    } finally {
      await cleanup();
    }
  });

  it("does not replace a verified Ironside connection through create", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_ironside_connection_identity");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      const context = (remoteProjectId: string) => ({
        protocolVersion: "ironside/evaluator/v1" as const,
        project: { id: remoteProjectId, name: remoteProjectId },
        capabilities: ["traces:read" as const, "scores:write" as const],
        settlement: { kind: "quiet_period" as const, quietPeriodSeconds: 0 }
      });
      const first = await repo.createIronsideIntegration("proj_test", {
        url: "https://ironside-a.example",
        apiKey: "key_a"
      }, context("remote_a"));
      await expect(repo.createIronsideIntegration("proj_test", {
        url: "https://ironside-b.example",
        apiKey: "key_b"
      }, context("remote_b"))).rejects.toBeInstanceOf(IronsideIntegrationAlreadyExistsError);
      await expect(repo.loadIronsideImportContext({
        projectId: "proj_test",
        integrationId: first.id,
        limit: 1
      })).resolves.toMatchObject({
        url: "https://ironside-a.example",
        remoteProjectId: "remote_a",
        connectionRevision: 1
      });
      const initial = await repo.loadIronsideImportContext({
        projectId: "proj_test",
        integrationId: first.id,
        limit: 1
      });
      await expect(repo.quarantineIronsideIntegration(
        "proj_test",
        first.id,
        { remoteProjectId: "remote_a", connectionRevision: initial.connectionRevision },
        { ok: false, checkedAt: new Date().toISOString(), error: "drift" }
      )).resolves.toBe(true);
      const quarantined = await repo.loadIronsideImportContext({
        projectId: "proj_test",
        integrationId: first.id,
        limit: 1
      });
      await repo.updateIronsideIntegration(
        "proj_test",
        first.id,
        {},
        context("remote_a"),
        {
          remoteProjectId: "remote_a",
          revalidationRequired: true,
          connectionRevision: quarantined.connectionRevision
        }
      );
      await expect(repo.quarantineIronsideIntegration(
        "proj_test",
        first.id,
        { remoteProjectId: "remote_a", connectionRevision: quarantined.connectionRevision },
        { ok: false, checkedAt: new Date().toISOString(), error: "stale response" }
      )).resolves.toBe(false);
      await expect(repo.loadIronsideImportContext({
        projectId: "proj_test",
        integrationId: first.id,
        limit: 1
      })).resolves.toMatchObject({
        revalidationRequired: false,
        connectionRevision: quarantined.connectionRevision + 1
      });
    } finally {
      await cleanup();
    }
  });

  it("counts all net-new traces for the same import job across worker retries", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-import-retry-count-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const queue = new FailingOnceQueue();
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      await pool.query(`update skill_versions set status = 'approved', approved_at = now() where id = 'skillv_test'`);

      const integration = await repo.createLangSmithIntegration("proj_test", { apiKey: "ls_test_key", projectName: "Support Agent" });
      const importJob = await repo.createImportJob({
        projectId: "proj_test",
        source: "langsmith",
        sourceIntegrationId: integration.id,
        requestedLimit: 2
      });
      const createClient = () => ({
        async listRuns() {
          return [
            {
              sourceTraceId: "ls_retry_same_job_1",
              input: { question: "First?" },
              output: { answer: "ok" },
              metadata: { source: "langsmith" }
            },
            {
              sourceTraceId: "ls_retry_same_job_2",
              input: { question: "Second?" },
              output: { answer: "ok" },
              metadata: { source: "langsmith" }
            }
          ];
        }
      });

      await expect(processLangSmithImportJob(repo, queue, {
        projectId: "proj_test",
        integrationId: integration.id,
        skillVersionId: importJob.skillVersionId!,
        limit: 2,
        importJobId: importJob.id
      }, createClient)).rejects.toThrow("Queue unavailable after trace import");

      await expect(processLangSmithImportJob(repo, queue, {
        projectId: "proj_test",
        integrationId: integration.id,
        skillVersionId: importJob.skillVersionId!,
        limit: 2,
        importJobId: importJob.id
      // The worker now imports the complete batch before dispatching its
      // evaluation work. Both rows were therefore durably created on the
      // failed first attempt; the retry schedules them without re-importing.
      }, createClient)).resolves.toEqual({ imported: 0, queued: 2 });

      const counts = await pool.query(
        `select
           (select count(*)::int from raw_traces where import_job_id = $1) as raw_count,
           ij.status,
           ij.imported_count,
           ij.queued_judge_count
         from import_jobs ij
         where ij.id = $1`,
        [importJob.id]
      );
      expect(counts.rows[0]).toMatchObject({
        raw_count: 2,
        status: "completed",
        imported_count: 2,
        queued_judge_count: 2
      });
    } finally {
      await cleanup();
    }
  });

  it("creates and completes a LangSmith feedback sync job", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-feedback-sync-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const queue = new CapturingQueue();
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'langsmith')`);
      await seedSkill(pool);

      const integration = await repo.createLangSmithIntegration("proj_test", { apiKey: "ls_test_key", projectName: "Support Agent" });
      const imported = await repo.importTrace("proj_test", "langsmith", {
        sourceTraceId: "ls_run_feedback_pg",
        input: { question: "Refund?" },
        output: { answer: "Refunds are available." },
        metadata: { source: "langsmith" }
      }, {
        ingestionPurpose: "analysis_eligible_langsmith",
        sourceIntegrationId: integration.id
      });

      const runResult = await processJudgeRunJob(repo, {
        projectId: "proj_test",
        caseId: imported.caseId,
        skillVersionId: "skillv_test"
      }, undefined, queue);

      expect(runResult.verdict).toBe("pass");
      expect(queue.jobs[0]).toMatchObject({
        name: "feedback.sync",
        data: { projectId: "proj_test", feedbackSyncJobId: expect.any(String) }
      });

      let feedbackPayload: unknown;
      await processFeedbackSyncJob(repo, queue.jobs[0]!.data as { projectId: string; feedbackSyncJobId: string }, () => ({
        async createFeedback(input) {
          feedbackPayload = input;
        }
      }));

      expect(feedbackPayload).toMatchObject({
        feedbackId: (queue.jobs[0]!.data as { feedbackSyncJobId: string }).feedbackSyncJobId,
        runId: "ls_run_feedback_pg",
        value: "pass",
        sourceInfo: {
          skillVersionId: "skillv_test",
          modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 }
        }
      });
      const dashboard = await repo.getDashboardSummary("proj_test");
      expect(dashboard.project.syncBackCoverage).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("parks and re-drives Ironside feedback after connection revalidation", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-ironside-feedback-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_ironside_feedback_redrive");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const queue = new CapturingQueue();
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      const remote = {
        protocolVersion: "ironside/evaluator/v1" as const,
        project: { id: "remote_feedback", name: "Remote feedback" },
        capabilities: ["traces:read" as const, "scores:write" as const],
        settlement: { kind: "quiet_period" as const, quietPeriodSeconds: 0 }
      };
      const integration = await repo.createIronsideIntegration("proj_test", {
        url: "https://ironside.example",
        apiKey: "key_feedback"
      }, remote);
      const imported = await repo.importTrace("proj_test", "ironside", {
        sourceTraceId: "ironside_feedback_pg",
        input: { question: "Refund?" },
        output: { answer: "Yes." },
        metadata: { source: "ironside" }
      }, {
        ingestionPurpose: "analysis_eligible_ironside",
        sourceIntegrationId: integration.id,
        sourceRemoteProjectId: remote.project.id,
        sourceTraceVersion: "2026-08-30T12:00:00.000001Z"
      });
      await processJudgeRunJob(repo, {
        projectId: "proj_test",
        caseId: imported.caseId,
        skillVersionId: "skillv_test"
      }, undefined, queue);
      const job = queue.jobs[0]!.data as { projectId: string; feedbackSyncJobId: string };

      await expect(processFeedbackSyncJob(repo, job, () => ({
        async getContext() {
          return { ...remote, project: { id: "remote_other", name: "Other" } };
        },
        async createFeedback() {
          throw new Error("must not write after drift");
        }
      }))).rejects.toBeInstanceOf(IronsideIntegrationRevalidationRequiredError);
      expect((await repo.listFeedbackSyncJobs({
        projectId: "proj_test",
        status: "blocked",
        limit: 10
      }))).toHaveLength(1);

      const quarantined = await repo.loadIronsideImportContext({
        projectId: "proj_test",
        integrationId: integration.id,
        limit: 1
      });
      await repo.updateIronsideIntegration("proj_test", integration.id, {}, remote, {
        remoteProjectId: quarantined.remoteProjectId,
        revalidationRequired: true,
        connectionRevision: quarantined.connectionRevision
      });
      const blocked = await repo.listBlockedIronsideFeedbackSyncJobs("proj_test", integration.id);
      expect(blocked).toEqual([job]);
      await repo.markFeedbackSyncPending(job);
      await processFeedbackSyncJob(repo, job, () => ({
        async getContext() { return remote; },
        async createFeedback() {}
      }));
      expect((await repo.listFeedbackSyncJobs({
        projectId: "proj_test",
        status: "synced",
        limit: 10
      }))).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("returns judged exceptions and promotes one to the golden set", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "manual_exception_trace",
        input: { question: "Is this correct?" },
        output: { answer: "This is incorrect." },
        metadata: { name: "Incorrect answer trace" }
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await processJudgeRunJob(repo, {
        projectId: "proj_test",
        caseId: imported.caseId,
        skillVersionId: "skillv_test"
      });

      const dashboard = await repo.getDashboardSummary("proj_test");
      expect(dashboard.exceptions[0]).toMatchObject({ id: imported.caseId, traceId: "manual_exception_trace", verdict: "fail" });
      await expect(repo.getExceptionDetail("proj_test", imported.caseId)).resolves.toMatchObject({
        exception: { id: imported.caseId },
        trace: { id: "manual_exception_trace" }
      });

      const entry = await repo.promoteExceptionToGoldenSet({
        projectId: "proj_test",
        caseId: imported.caseId,
        agreedLabel: "fail",
        reason: "Frozen incorrect-answer regression case.",
        actorName: "Smoke Reviewer"
      });
      expect(entry).toMatchObject({
        caseId: imported.caseId,
        traceId: "manual_exception_trace",
        agreedLabel: "fail",
        promotedBy: "Smoke Reviewer"
      });
      await expect(repo.listGoldenSet("proj_test")).resolves.toHaveLength(1);
      await pool.query(`update golden_set_entries set promoted_at = $1 where id = $2`, ["2026-01-01T00:00:00.000Z", entry.id]);
      await expect(repo.getGoldenSetHealth("proj_test")).resolves.toMatchObject({
        status: "needs_action",
        totalActive: 1,
        staleCount: 1,
        passCount: 0,
        failCount: 1,
        staleEntries: [
          {
            id: entry.id,
            traceId: "manual_exception_trace",
            agreedLabel: "fail"
          }
        ]
      });
      const dashboardAfterPromotion = await repo.getDashboardSummary("proj_test");
      expect(dashboardAfterPromotion.exceptions.some((item) => item.id === imported.caseId)).toBe(false);
      await repo.retireGoldenSetEntry({
        projectId: "proj_test",
        entryId: entry.id,
        actorUserId: "user_owner",
        reason: "No longer representative."
      });
      await expect(repo.listGoldenSet("proj_test")).resolves.toHaveLength(0);
      await expect(repo.getGoldenSetHealth("proj_test")).resolves.toMatchObject({
        status: "needs_action",
        totalActive: 0,
        staleCount: 0
      });
      const retiredRows = await pool.query(`select retired_at from golden_set_entries where id = $1`, [entry.id]);
      expect(retiredRows.rows[0]?.retired_at).toBeInstanceOf(Date);
      const auditRows = await pool.query(`select action, target_id, metadata from audit_logs where action = 'golden_set.retire'`);
      expect(auditRows.rows[0]).toMatchObject({
        action: "golden_set.retire",
        target_id: entry.id,
        metadata: {
          caseId: imported.caseId,
          reason: "No longer representative."
        }
      });
      const alreadyRetired = repo.retireGoldenSetEntry({
        projectId: "proj_test",
        entryId: entry.id,
        actorUserId: "user_owner",
        reason: "Accidental retry."
      });
      await expect(alreadyRetired).rejects.toBeInstanceOf(GoldenSetEntryAlreadyRetiredError);
      await expect(alreadyRetired).rejects.toMatchObject({
        retirement: {
          retiredAt: expect.any(String),
          retiredByUserId: "user_owner",
          retiredBy: "user_owner",
          reason: "No longer representative."
        }
      });
      const repromoted = await repo.promoteExceptionToGoldenSet({
        projectId: "proj_test",
        caseId: imported.caseId,
        agreedLabel: "fail",
        reason: "Fresh active golden case after retirement.",
        actorName: "Smoke Reviewer"
      });
      expect(repromoted.id).not.toBe(entry.id);
      await expect(repo.listGoldenSet("proj_test")).resolves.toMatchObject([
        {
          id: repromoted.id,
          caseId: imported.caseId,
          reason: "Fresh active golden case after retirement."
        }
      ]);
      const historyRows = await pool.query(
        `select id, retired_at
         from golden_set_entries
         where project_id = $1 and case_id = $2`,
        ["proj_test", imported.caseId]
      );
      expect(historyRows.rows).toHaveLength(2);
      expect(historyRows.rows.find((row) => row.id === entry.id)?.retired_at).toBeInstanceOf(Date);
      expect(historyRows.rows.find((row) => row.id === repromoted.id)?.retired_at).toBeNull();

      const duplicate = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "manual_exception_duplicate_source",
        input: { question: "Duplicate golden case?" },
        output: { answer: "This is incorrect." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_duplicate', 'proj_test', $1, $2, 'fail', 'Duplicate coverage.', 'Smoke Reviewer', 'skillv_test',
                 'criterionv_test')`,
        [duplicate.caseId, repromoted.traceId]
      );
      await expect(repo.getGoldenSetHealth("proj_test")).resolves.toMatchObject({
        status: "needs_action",
        totalActive: 2,
        duplicateCount: 1,
        duplicateGroups: [
          {
            traceId: repromoted.traceId,
            entryCount: 2
          }
        ]
      });
    } finally {
      await cleanup();
    }
  });
});
