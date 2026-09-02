import { expect, it } from "vitest";

import { runMigrations } from "@coeval/db";

import { CreateSkillVersionInputSchema } from "@coeval/shared";

import { PgRepository } from "../src/repository.pg.js";

import { processJudgeRunJob } from "../src/workers/judge.js";

import { enqueueDueLangSmithImports } from "../src/workers/langsmith-poller.js";
import { REDACTED_VALUE } from "../src/lib/redaction.js";

import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { CapturingQueue, runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("PgRepository smoke", () => {
  it("prunes expired non-golden traces while preserving active golden cases", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      await repo.updateProjectSettings("proj_test", { traceRetentionDays: 7 }, {});

      const expired = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "expired_trace",
        input: { question: "Expired?" },
        output: { answer: "This is incorrect." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await processJudgeRunJob(repo, {
        projectId: "proj_test",
        caseId: expired.caseId,
        skillVersionId: "skillv_test"
      });

      const golden = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "expired_golden_trace",
        input: { question: "Expired but golden?" },
        output: { answer: "This is incorrect." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await processJudgeRunJob(repo, {
        projectId: "proj_test",
        caseId: golden.caseId,
        skillVersionId: "skillv_test"
      });
      await repo.promoteExceptionToGoldenSet({
        projectId: "proj_test",
        caseId: golden.caseId,
        agreedLabel: "fail",
        reason: "Keep golden cases beyond trace retention.",
        actorName: "Smoke Reviewer"
      });

      const current = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "current_trace",
        input: { question: "Current?" },
        output: { answer: "This is correct." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `update raw_traces set created_at = $1 where id in ($2,$3)`,
        ["2026-04-01T00:00:00.000Z", expired.rawTraceId, golden.rawTraceId]
      );

      const result = await repo.pruneExpiredTraces("proj_test", { now: new Date("2026-05-03T00:00:00.000Z") });
      expect(result).toMatchObject({
        traceRetentionDays: 7,
        deletedCases: 1,
        deletedRawTraces: 1,
        skippedActiveGoldenCases: 1,
        skippedImmutableRevisionCases: 0
      });
      await expect(pool.query(`select id from cases where id = $1`, [expired.caseId])).resolves.toMatchObject({ rowCount: 0 });
      await expect(pool.query(`select id from cases where id = $1`, [golden.caseId])).resolves.toMatchObject({ rowCount: 1 });
      await expect(pool.query(`select id from raw_traces where id = $1`, [current.rawTraceId])).resolves.toMatchObject({ rowCount: 1 });
      await expect(repo.getDashboardSummary("proj_test")).resolves.toMatchObject({
        project: {
          importedTraceCount: 2,
          autoJudgedTraceCount: 1
        }
      });
      await expect(repo.pruneExpiredTraces("proj_test", { now: new Date("2026-05-03T00:00:30.000Z") })).resolves.toMatchObject({
        deletedCases: 0,
        deletedRawTraces: 0,
        skippedActiveGoldenCases: 0,
        skippedImmutableRevisionCases: 0
      });
    } finally {
      await cleanup();
    }
  });

  it("deletes projects after confirmation and preserves anonymized audit history", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await pool.query(`insert into project_members (id, project_id, user_id, role) values ('pm_test', 'proj_test', 'user_owner', 'owner')`);
      await seedSkill(pool);
      await repo.createSkillVersion("skill_test", CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "Pass correct answers; fail incorrect answers.",
        prompt: "Judge the trace.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 }
      }), { projectId: "proj_test", actorUserId: "user_owner" });
      await repo.updateProjectSettings("proj_test", { traceRetentionDays: 30 }, { actorUserId: "user_owner" });
      const integration = await repo.createLangSmithIntegration("proj_test", { apiKey: "ls_test_key", projectName: "Delete Test" });
      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "delete_trace",
        input: { question: "Delete?" },
        output: { answer: "This is correct." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      const run = await processJudgeRunJob(repo, {
        projectId: "proj_test",
        caseId: imported.caseId,
        skillVersionId: "skillv_test"
      });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_delete', 'proj_test', $1, 'delete_trace', 'pass', 'Delete cascade coverage.', 'Smoke Reviewer', 'skillv_test',
                 'criterionv_test')`,
        [imported.caseId]
      );
      await pool.query(
        `insert into feedback_sync_jobs (id, project_id, judge_run_id, provider, status)
         values ('fsync_delete', 'proj_test', $1, 'langsmith', 'pending')`,
        [run.id]
      );
      expect(integration.projectId).toBe("proj_test");

      await expect(repo.deleteProject("proj_test", { confirmProjectName: "Wrong" })).rejects.toThrow(/confirmation/i);
      await repo.deleteProject("proj_test", { confirmProjectName: "Test Project", actorUserId: "user_owner" });

      await expect(pool.query(`select * from projects where id = 'proj_test'`)).resolves.toMatchObject({ rowCount: 0 });
      await expect(pool.query(`select * from raw_traces where project_id = 'proj_test'`)).resolves.toMatchObject({ rowCount: 0 });
      await expect(pool.query(`select * from cases where project_id = 'proj_test'`)).resolves.toMatchObject({ rowCount: 0 });
      for (const table of ["skills", "skill_versions", "golden_set_entries", "judge_runs", "regression_runs", "feedback_sync_jobs", "integrations", "project_members"]) {
        const rows = await pool.query(`select count(*)::int as count from ${table} where project_id = $1`, ["proj_test"]);
        expect(rows.rows[0]?.count, `${table} should cascade on project deletion`).toBe(0);
      }
      const auditRows = await pool.query(`select action, project_id, target_id, metadata from audit_logs order by created_at asc`);
      expect(auditRows.rows.some((row) => row.action === "project.delete" && row.project_id === null && row.target_id === "proj_test")).toBe(true);
      expect(auditRows.rows.every((row) => row.project_id === null)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("claims due LangSmith integrations for scheduled polling", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-langsmith-poller-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const queue = new CapturingQueue();
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'langsmith')`);
      await seedSkill(pool);

      const integration = await repo.createLangSmithIntegration("proj_test", { apiKey: "ls_test_key", projectName: "Support Agent", pollLimit: 5 });
      expect(integration.lastTestResult).toBeNull();
      await repo.recordLangSmithConnectionTest("proj_test", integration.id, {
        ok: false,
        checkedAt: "2026-05-01T00:00:00.000Z",
        status: 401,
        error: "LangSmith runs request failed: 401"
      });
      await expect(repo.listLangSmithIntegrations("proj_test")).resolves.toMatchObject([
        {
          id: integration.id,
          lastTestedAt: "2026-05-01T00:00:00.000Z",
          lastTestResult: {
            ok: false,
            status: 401
          }
        }
      ]);

      const now = new Date("2026-05-02T00:00:00.000Z");
      await expect(enqueueDueLangSmithImports(repo, queue, { now, importLimit: 5 })).resolves.toEqual({ claimed: 1, queued: 1 });
      expect(queue.jobs[0]).toMatchObject({
        name: "langsmith.import",
        data: { projectId: "proj_test", integrationId: integration.id, limit: 5, importJobId: expect.any(String) }
      });
      await expect(repo.listImportJobs({ projectId: "proj_test", limit: 5 })).resolves.toMatchObject([
        {
          source: "langsmith",
          sourceIntegrationId: integration.id,
          status: "queued",
          requestedLimit: 5,
          queueJobId: "job_1"
        }
      ]);

      await expect(enqueueDueLangSmithImports(repo, queue, { now, importLimit: 5 })).resolves.toEqual({ claimed: 0, queued: 0 });
      expect(queue.jobs).toHaveLength(1);
      await expect(pool.query(`select last_polled_at from integrations where id = $1`, [integration.id]))
        .resolves.toMatchObject({ rows: [{ last_polled_at: expect.any(Date) }] });

      await expect(repo.updateLangSmithIntegration("proj_test", integration.id, {
        pollEnabled: false,
        pollIntervalSeconds: 600,
        pollLimit: 3
      })).resolves.toMatchObject({
        pollEnabled: false,
        pollIntervalSeconds: 600,
        pollLimit: 3
      });
      await expect(repo.listLangSmithIntegrations("proj_test")).resolves.toMatchObject([
        { id: integration.id, pollEnabled: false, pollIntervalSeconds: 600, pollLimit: 3 }
      ]);
      await expect(enqueueDueLangSmithImports(repo, queue, {
        now: new Date("2026-05-02T00:20:00.000Z"),
        importLimit: 5
      })).resolves.toEqual({ claimed: 0, queued: 0 });
    } finally {
      await cleanup();
    }
  });

  it("M4 C3: golden case maps to a SkillFormat example with NON-NULL redacted trace input+output", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      // A golden case whose trace carries a real input+output AND a secret, so
      // the mapping proves two things at once: examples are non-null (sourced
      // from the trace payload), and they are redacted like every trace surface.
      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "skillfmt_case",
        input: { question: "Ship it?", api_key: "sk-live-should-redact" },
        output: { answer: "Yes." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_skillfmt', 'proj_test', $1, $2, 'pass', 'Agreed good.', 'Smoke Reviewer', 'skillv_test',
                 'criterionv_test')`,
        [imported.caseId, imported.rawTraceId]
      );

      const examples = await repo.getSkillFormatExamples("proj_test", 50);
      expect(examples.length).toBe(1);
      const example = examples[0]!;
      // Non-null input+output — the contract's core promise (not hollowed to null).
      expect(example.input).not.toBeNull();
      expect(example.output).not.toBeNull();
      expect(example.label).toBe("pass");
      expect(example.output).toMatchObject({ answer: "Yes." });
      // Redacted like every other trace surface — the secret never leaves.
      expect((example.input as Record<string, unknown>).api_key).toBe(REDACTED_VALUE);
      expect((example.input as Record<string, unknown>).question).toBe("Ship it?");

      // Cap is honoured against the real query path.
      const capped = await repo.getSkillFormatExamples("proj_test", 0);
      expect(capped.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("product deploy gate: gate check rows persist, join the eval run, and derive passed/blocked/error", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      // Golden case + its trace; the derived candidate case pairs this
      // trace's input with the candidate output.
      const golden = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "gate_golden_trace",
        input: { question: "Refund policy?" },
        output: { answer: "30 days." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_gate', 'proj_test', $1, 'gate_golden_trace', 'pass', 'Agreed good.', 'Smoke Reviewer', 'skillv_test',
                 'criterionv_test')`,
        [golden.caseId]
      );
      const goldenTraces = await repo.getGoldenSetTraces("proj_test");
      expect(goldenTraces.get(golden.caseId)?.input).toMatchObject({ question: "Refund policy?" });

      // Deprecated gate reads remain deterministic for explicitly synthetic
      // cases, but the blank-slate schema no longer admits the historical
      // gate-candidate ingestion sentinel.
      const candidate = { caseId: "case_gate_candidate" };
      await pool.query(
        `insert into raw_traces
           (id,project_id,source_trace_id,raw_payload,normalization_version)
         values ('raw_gate_candidate','proj_test','gate_candidate_trace',$1,'gate-candidate-v1')`,
        [JSON.stringify({
          input: goldenTraces.get(golden.caseId)!.input,
          output: { answer: "30 days, per policy." },
          metadata: { goldenCaseId: golden.caseId }
        })]
      );
      await pool.query(
        `insert into cases
           (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose)
         values ($1,'proj_test','raw_gate_candidate','manual',$2,'trace_test_synthetic')`,
        [candidate.caseId, JSON.stringify({
          input: goldenTraces.get(golden.caseId)!.input,
          output: { answer: "30 days, per policy." },
          metadata: { goldenCaseId: golden.caseId }
        })]
      );
      const candidateType = await pool.query(`select case_type from cases where id = $1`, [candidate.caseId]);
      expect(candidateType.rows[0]?.case_type).toBe("manual");

      // The deprecated read model still derives state from its eval-run rows.
      const evalRun = await repo.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        trigger: "product_gate",
        items: [{ caseId: candidate.caseId, expectedLabel: "pass" }]
      });
      const check = await repo.createGateCheck({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        evalRunId: evalRun.id,
        label: "deploy abc123",
        metadata: { sha: "abc123" },
        maxDisagreements: 0,
        items: [{
          goldenEntryId: "gold_gate",
          goldenCaseId: golden.caseId,
          caseKey: "gate_golden_trace",
          candidateCaseId: candidate.caseId,
          expectedLabel: "pass"
        }]
      });
      expect(check.status).toBe("pending");
      expect(check.items[0]).toMatchObject({
        caseKey: "gate_golden_trace",
        expectedLabel: "pass",
        status: "pending",
        judgedLabel: null
      });

      // Completing the underlying eval-run item flips the derived decision —
      // no gate-side write happens at all.
      await pool.query(`insert into verdicts (id, project_id, case_id, source, verdict_kind, payload)
                        values ('v_gate', 'proj_test', $1, 'llm_judge', 'binary', '{"kind":"binary","pass":true,"rationale":"good"}')`,
                       [candidate.caseId]);
      await repo.completeEvalRunItem({
        projectId: "proj_test",
        evalRunId: evalRun.id,
        evalRunItemId: evalRun.items[0]!.id,
        verdictId: "v_gate",
        resultLabel: "pass",
        latencyMs: 5
      });
      const passed = await repo.getGateCheckDetail("proj_test", check.id);
      expect(passed).toMatchObject({
        status: "passed",
        disagreements: 0,
        judgedCandidates: 1,
        erroredCandidates: 0,
        label: "deploy abc123",
        metadata: { sha: "abc123" }
      });
      expect(passed?.items[0]).toMatchObject({ status: "completed", judgedLabel: "pass", agreement: true });
      expect(passed?.finishedAt).not.toBeNull();

      // A failed item derives 'error' — never 'passed' (locked invariant).
      const errRun = await repo.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        trigger: "product_gate",
        items: [{ caseId: candidate.caseId, expectedLabel: "pass" }]
      });
      const errCheck = await repo.createGateCheck({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        evalRunId: errRun.id,
        maxDisagreements: 0,
        items: [{
          goldenEntryId: "gold_gate",
          goldenCaseId: golden.caseId,
          caseKey: "gate_golden_trace",
          candidateCaseId: candidate.caseId,
          expectedLabel: "pass"
        }]
      });
      await repo.failEvalRunItem({
        projectId: "proj_test",
        evalRunId: errRun.id,
        evalRunItemId: errRun.items[0]!.id,
        error: "provider unavailable"
      });
      const errored = await repo.getGateCheckDetail("proj_test", errCheck.id);
      expect(errored?.status).toBe("error");
      expect(errored?.items[0]).toMatchObject({ status: "failed", error: "provider unavailable" });
      // Issue #152: with every item failed and NOTHING judged the run itself
      // is terminal 'failed' with the first item error surfaced — never a
      // forever-'running' poll target.
      const erroredRun = await repo.getEvalRun("proj_test", errRun.id);
      expect(erroredRun?.status).toBe("failed");
      expect(erroredRun?.error).toBe("provider unavailable");
      expect(erroredRun?.finishedAt).not.toBeNull();

      // List derives per-row statuses via the eval-run join, newest first.
      const listed = await repo.listGateChecks("proj_test");
      expect(listed.map((row) => row.status)).toEqual(["error", "passed"]);
      // Cross-project scoping: nothing leaks to another project id.
      expect(await repo.getGateCheckDetail("proj_other", check.id)).toBeNull();
      expect(await repo.listGateChecks("proj_other")).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
