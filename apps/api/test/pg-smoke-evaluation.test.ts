import { expect, it } from "vitest";

import { runMigrations } from "@coeval/db";

import { CreateSkillVersionInputSchema, MinimumVerdictOutputSchema, type JudgeProviderId } from "@coeval/shared";
import { RegressionGateJudgeError, RegressionGateUnavailableError } from "../src/repository.js";
import { PgRepository } from "../src/repository.pg.js";

import { processGateRunJob } from "../src/workers/gate.js";
import { processJudgeRunJob } from "../src/workers/judge.js";

import { EXCLUDED_VALUE, REDACTED_VALUE } from "../src/lib/redaction.js";

import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedCriterion, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("PgRepository smoke", () => {
  it("async regression gate: pending insert -> gate.run worker -> recorded run + status flip (M0 C5a)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedCriterion(pool);
      await pool.query(`insert into skills (id, project_id, name, description, owner_user_id, status, criterion_id) values ('skill_test', 'proj_test', 'Gate Skill', 'gate smoke', null, 'draft', 'criterion_test')`);

      // Submit-time half: pending version lands as `calibrating`, no run yet.
      const pending = await repo.createSkillVersionPending("skill_test", CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "# Gate smoke rubric",
        prompt: "Judge with pass/fail/ambiguous.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
        verdictKind: "binary"
      }), { projectId: "proj_test" });
      const stored = await pool.query(`select status from skill_versions where id = $1`, [pending.id]);
      expect(stored.rows[0]?.status).toBe("calibrating");
      expect(await repo.getRegressionRunForVersion("proj_test", pending.id)).toBeNull();

      // Worker half: gate.run executes, records the run, flips the status.
      // Empty golden set -> advisory pass -> approved.
      await processGateRunJob(repo, {
        projectId: "proj_test",
        skillVersionId: pending.id,
        datasetRevisionId: pending.regressionDatasetRevisionId!,
        timeScope: "new"
      });
      const run = await repo.getRegressionRunForVersion("proj_test", pending.id);
      expect(run?.status).toBe("passed");
      expect(run?.goldenSetMissing).toBe(true);
      const flipped = await pool.query(`select status, approved_at from skill_versions where id = $1`, [pending.id]);
      expect(flipped.rows[0]?.status).toBe("approved");
      expect(flipped.rows[0]?.approved_at).not.toBeNull();

      // Terminal failure path: the version and a readable error run transition
      // together, and replaying the finalizer appends nothing.
      const doomed = await repo.createSkillVersionPending("skill_test", CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "# Gate failure rubric",
        prompt: "Judge with pass/fail/ambiguous.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
        verdictKind: "binary"
      }), { projectId: "proj_test" });
      const doomedJob = {
        projectId: "proj_test",
        skillVersionId: doomed.id,
        datasetRevisionId: doomed.regressionDatasetRevisionId!,
        timeScope: "new" as const
      };
      await repo.failRegressionGateForVersion(
        doomedJob,
        new Error("provider timed out")
      );
      await repo.failRegressionGateForVersion(
        doomedJob,
        new Error("late replay")
      );
      const failedVersion = await pool.query(`select status from skill_versions where id = $1`, [doomed.id]);
      expect(failedVersion.rows[0]?.status).toBe("failed");
      expect(await repo.getRegressionRunForVersion("proj_test", doomed.id)).toMatchObject({
        status: "error",
        error: "provider timed out"
      });
      const failureRuns = await pool.query(`select count(*)::int as count from regression_runs where skill_version_id = $1`, [doomed.id]);
      expect(failureRuns.rows[0]?.count).toBe(1);

      // A missing version is a permanent error, not a retry loop.
      await expect(processGateRunJob(repo, {
        projectId: "proj_test",
        skillVersionId: "skillv_missing",
        datasetRevisionId: "dsr_missing",
        timeScope: "new"
      }))
        .rejects.toThrow(/not found for gate job/);
    } finally {
      await cleanup();
    }
  });

  it("round-trips eval-run counters with status-guard idempotency (migration 0025)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      const importedA = await repo.importTrace("proj_test", "manual", { sourceTraceId: "evr_a", input: {}, output: { a: "ok" }, metadata: {} }, { ingestionPurpose: "analysis_eligible_manual" });
      const importedB = await repo.importTrace("proj_test", "manual", { sourceTraceId: "evr_b", input: {}, output: { a: "ok" }, metadata: {} }, { ingestionPurpose: "analysis_eligible_manual" });

      const verdict = await repo.recordVerdict({
        projectId: "proj_test",
        caseId: importedA.caseId,
        source: "llm_judge",
        skillVersionId: "skillv_test",
        payload: { kind: "binary", pass: true, rationale: "pre-recorded" }
      });

      const run = await repo.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        trigger: "api_batch",
        items: [
          { caseId: importedA.caseId, status: "completed", verdictId: verdict.id, resultLabel: "pass", cached: true, expectedLabel: "pass" },
          { caseId: importedB.caseId, expectedLabel: "fail" }
        ]
      });
      expect(run.status).toBe("pending");
      expect(run.completedItems).toBe(1);
      expect(run.agreedItems).toBe(1);

      await repo.markEvalRunRunning("proj_test", run.id);
      const pending = await repo.listPendingEvalRunItems("proj_test", run.id);
      expect(pending).toHaveLength(1);

      const verdictB = await repo.recordVerdict({
        projectId: "proj_test",
        caseId: importedB.caseId,
        source: "llm_judge",
        skillVersionId: "skillv_test",
        payload: { kind: "binary", pass: true, rationale: "live" }
      });
      const first = await repo.completeEvalRunItem({
        projectId: "proj_test",
        evalRunId: run.id,
        evalRunItemId: pending[0]!.id,
        verdictId: verdictB.id,
        resultLabel: "pass",
        latencyMs: 12
      });
      expect(first.runFinished).toBe(true);
      // Queue-retry replay: the status guard updates zero rows, counts nothing.
      await repo.completeEvalRunItem({
        projectId: "proj_test",
        evalRunId: run.id,
        evalRunItemId: pending[0]!.id,
        verdictId: verdictB.id,
        resultLabel: "pass"
      });

      const after = await repo.getEvalRunDetail("proj_test", run.id);
      expect(after?.status).toBe("completed");
      expect(after?.completedItems).toBe(2);
      expect(after?.failedItems).toBe(0);
      expect(after?.agreedItems).toBe(1); // expected fail, judged pass → disagreement
      expect(after?.finishedAt).not.toBeNull();
      const live = after?.items.find((item) => item.caseId === importedB.caseId);
      expect(live?.agreement).toBe(false);
      expect(live?.latencyMs).toBe(12);
    } finally {
      await cleanup();
    }
  });

  it("creates one backfill eval run per Check under concurrent starts", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "backfill_once",
        input: { question: "q" },
        output: { answer: "a" },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });

      const [first, second] = await Promise.all([
        repo.createEvalRun({
          projectId: "proj_test",
          skillVersionId: "skillv_test",
          trigger: "backfill",
          items: [{ caseId: imported.caseId }]
        }),
        repo.createEvalRun({
          projectId: "proj_test",
          skillVersionId: "skillv_test",
          trigger: "backfill",
          items: [{ caseId: imported.caseId }]
        })
      ]);

      expect(second.id).toBe(first.id);
      const rows = await pool.query(
        `select count(*)::int as count from eval_runs where project_id='proj_test' and skill_version_id='skillv_test' and trigger='backfill'`
      );
      expect(rows.rows[0]?.count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("allows one evaluator lineage per criterion and multiple criteria per project", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedCriterion(pool, "first");
      await seedCriterion(pool, "second");
      await pool.query(`insert into skills (id, project_id, name, description, status, criterion_id) values ('skill_first', 'proj_test', 'First', 'first skill', 'draft', 'criterion_first')`);

      // A second evaluator may coexist when it explicitly binds a distinct
      // immutable criterion lineage.
      await expect(
        pool.query(`insert into skills (id, project_id, name, description, status, criterion_id) values ('skill_second', 'proj_test', 'Second', 'second skill', 'draft', 'criterion_second')`)
      ).resolves.toBeDefined();
      await expect(pool.query(`select id from skills where project_id = 'proj_test'`))
        .resolves.toMatchObject({ rowCount: 2 });

      // But one criterion still owns exactly one evaluator lineage.
      const criterionId = String((await pool.query(
        `select criterion_id from skills where id = 'skill_first'`
      )).rows[0].criterion_id);
      await expect(
        pool.query(
          `insert into skills (id, project_id, name, description, status, criterion_id)
           values ('skill_duplicate', 'proj_test', 'Duplicate', 'duplicate lineage', 'draft', $1)`,
          [criterionId]
        )
      ).rejects.toThrow(/duplicate key|unique constraint|skills_project_criterion_unique/i);
    } finally {
      await cleanup();
    }
  });

  it("never resolves a gate-blocked version as the current skill", { timeout: 20000 }, async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool); // skillv_test, v0.1.0, draft

      // A fresh project has only its seed draft — that draft must still judge.
      const beforeApproval = await repo.getCurrentSkill("proj_test");
      expect(beforeApproval.currentVersion.id).toBe("skillv_test");
      const regressionRevision = await repo.getOrCreateRegressionDatasetRevision(
        "proj_test",
        undefined,
        "criterionv_test"
      );

      const insertVersion = (id: string, version: string, status: string, createdAt: string, regressionRevisionId: string | null = null) =>
        pool.query(
          `insert into skill_versions
           (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
            regression_dataset_revision_id, criterion_version_id, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'criterionv_test',$11)`,
          [
            id,
            "skill_test",
            "proj_test",
            version,
            status,
            "Pass correct answers.",
            "Judge the trace.",
            JSON.stringify(MinimumVerdictOutputSchema),
            JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 }),
            regressionRevisionId,
            createdAt
          ]
        );
      // Timestamps are far-future so both rows are newer than the seed draft
      // (whose created_at defaults to now()) — getLatestSkill must see the
      // blocked version, not the seed, as the newest attempt.
      await insertVersion("skillv_approved", "0.1.1", "approved", "2099-01-02T00:00:00Z");
      // The blocked version is NEWER than the approved one — exactly the state
      // a gate-block leaves behind. Latest-created must not win here: this
      // version never shipped, and its verdicts must not reach production
      // surfaces (case pages, eval runs, the dashboard skill card).
      await insertVersion("skillv_blocked", "0.1.2", "regressing", "2099-01-03T00:00:00Z", regressionRevision.id);

      const current = await repo.getCurrentSkill("proj_test");
      expect(current.currentVersion.id).toBe("skillv_approved");
      expect(current.currentVersion.status).toBe("approved");

      // The editing base is the opposite contract: the blocked version IS the
      // latest attempt and must stay loadable, or its author loses the edit
      // on reload.
      const latest = await repo.getLatestSkill("proj_test");
      expect(latest.currentVersion.id).toBe("skillv_blocked");
      expect(latest.currentVersion.status).toBe("regressing");

      // A newer approval supersedes the older one.
      await insertVersion("skillv_approved_2", "0.1.3", "approved", "2099-01-04T00:00:00Z");
      const superseded = await repo.getCurrentSkill("proj_test");
      expect(superseded.currentVersion.id).toBe("skillv_approved_2");
    } finally {
      await cleanup();
    }
  });

  it("persists the per-case regression diff to the cases JSONB column (migration 0019)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      // A golden entry whose case has a real trace, so the regression run
      // actually compares it (and emits a per-case diff row).
      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "regr_case_trace",
        input: { question: "Is this correct?" },
        output: { answer: "Yes." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_regr', 'proj_test', $1, $2, 'pass', 'Agreed good.', 'Smoke Reviewer', 'skillv_test',
                 'criterionv_test')`,
        [imported.caseId, imported.rawTraceId]
      );

      const { regressionRun } = await repo.createSkillVersion(
        "skill_test",
        {
          rubricMarkdown: "Pass correct answers.",
          prompt: "Judge the trace.",
          modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 },
          outputSchema: MinimumVerdictOutputSchema,
          verdictKind: "binary",
          timeScope: "new"
        },
        { projectId: "proj_test", actorUserId: "user_owner" }
      );

      expect(regressionRun.compared).toBeGreaterThan(0);
      expect(regressionRun.cases.length).toBe(regressionRun.compared);

      // Round-trip: the JSONB column holds the same per-case rows.
      const persisted = await pool.query(
        `select cases from regression_runs where id = $1`,
        [regressionRun.id]
      );
      const storedCases = persisted.rows[0]?.cases as unknown[];
      expect(Array.isArray(storedCases)).toBe(true);
      expect(storedCases.length).toBe(regressionRun.cases.length);
      expect(storedCases[0]).toMatchObject({ caseId: imported.caseId, change: regressionRun.cases[0]!.change });
    } finally {
      await cleanup();
    }
  });

  it("re-judges the golden set with the provider the version pins, not the mock fallback", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const factoryCalls: string[] = [];
      const recordingFactory = (binding: { provider: string; modelId: string }) => {
        factoryCalls.push(`${binding.provider}/${binding.modelId}`);
        return {
          name: "recording",
          modelName: binding.modelId,
          judge: async () => ({ label: "fail" as const, score: 0, reason: "recorded fail", confidence: 1 }),
          judgeStructured: async () => {
            throw new Error("regression gate must use the binary judge path");
          }
        };
      };
      const repo = new PgRepository(pool, recordingFactory as never);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "regr_provider_trace",
        input: { question: "Is this correct?" },
        output: { answer: "Yes." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_provider', 'proj_test', $1, $2, 'pass', 'Agreed good.', 'Smoke Reviewer', 'skillv_test',
                 'criterionv_test')`,
        [imported.caseId, imported.rawTraceId]
      );

      const { regressionRun } = await repo.createSkillVersion(
        "skill_test",
        {
          rubricMarkdown: "Pass correct answers.",
          prompt: "Judge the trace.",
          modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "20251015", temperature: 0 },
          outputSchema: MinimumVerdictOutputSchema,
          verdictKind: "binary",
          timeScope: "new"
        },
        { projectId: "proj_test", actorUserId: "user_owner" }
      );

      // The strict submission preflight and the gate execution both resolve
      // the NEW version's provider binding. The second instance's verdicts
      // (not the mock's unconditional pass) drove the gate: agreed=pass but
      // the recorded judge says fail, so the version must be blocked.
      expect(factoryCalls).toEqual([
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-sonnet-4-6"
      ]);
      expect(regressionRun.status).toBe("blocked");
      expect(regressionRun.cases[0]?.rationale).toBe("recorded fail");
    } finally {
      await cleanup();
    }
  });

  it("refuses to gate with the mock fallback and surfaces provider failures as typed errors", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);

      const versionInput = (binding: { provider: JudgeProviderId }) => ({
        rubricMarkdown: "Pass correct answers.",
        prompt: "Judge the trace.",
        modelBinding: { provider: binding.provider, modelId: "m", modelVersion: "v", temperature: 0 },
        outputSchema: MinimumVerdictOutputSchema,
        verdictKind: "binary" as const,
        timeScope: "new" as const
      });
      const context = { projectId: "proj_test", actorUserId: "user_owner" };

      // Factory degraded to the mock (e.g. missing API key) while the version
      // pins a real provider → the gate must refuse, not silently certify.
      const mockFallbackRepo = new PgRepository(pool, (() => new (class {
        name = "mock";
        modelName = "mock";
        judge = async () => ({ label: "pass" as const, score: 1, reason: "mock", confidence: 1 });
      })()) as never);
      await pool.query(`delete from skills`);
      await seedSkill(pool);
      await expect(
        mockFallbackRepo.createSkillVersion("skill_test", versionInput({ provider: "anthropic" }), context)
      ).rejects.toThrow(RegressionGateUnavailableError);

      // A provider that throws mid-gate surfaces as the typed judge error
      // (502 at the route), never a bare 500 — but only when golden cases
      // force real judging.
      const failingRepo = new PgRepository(pool, (() => new (class {
        name = "anthropic";
        modelName = "m";
        judge = async () => {
          throw new Error("429 rate limited");
        };
      })()) as never);
      const imported = await failingRepo.importTrace("proj_test", "manual", {
        sourceTraceId: "gate_fail_trace",
        input: { q: "?" },
        output: { a: "!" },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_fail', 'proj_test', $1, $2, 'pass', 'Agreed good.', 'Smoke Reviewer', 'skillv_test',
                 'criterionv_test')`,
        [imported.caseId, imported.rawTraceId]
      );
      await expect(
        failingRepo.createSkillVersion("skill_test", versionInput({ provider: "anthropic" }), context)
      ).rejects.toThrow(RegressionGateJudgeError);
    } finally {
      await cleanup();
    }
  });

  it("imports a manual trace and records a judge run", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "manual_trace_smoke",
        input: { question: "Is this correct?", api_key: "sk-live-secret", privateContext: "do not send" },
        output: { answer: "This is correct.", token: "customer-token" },
        metadata: { headers: { authorization: "Bearer customer-token" } }
      }, {
        ingestionPurpose: "analysis_eligible_manual",
        redactionConfig: { excludedPaths: ["input.privateContext"] }
      });
      const payloadRows = await pool.query(
        `select rt.raw_payload, c.normalized_payload
         from raw_traces rt
         join cases c on c.raw_trace_id = rt.id
         where c.id = $1`,
        [imported.caseId]
      );
      expect(payloadRows.rows[0].raw_payload.input.api_key).toBe("sk-live-secret");
      expect(payloadRows.rows[0].normalized_payload.input.api_key).toBe(REDACTED_VALUE);
      expect(payloadRows.rows[0].normalized_payload.input.privateContext).toBe(EXCLUDED_VALUE);
      expect(payloadRows.rows[0].normalized_payload.output.token).toBe(REDACTED_VALUE);
      expect(payloadRows.rows[0].normalized_payload.metadata.headers.authorization).toBe(REDACTED_VALUE);

      const runResult = await processJudgeRunJob(repo, {
        projectId: "proj_test",
        caseId: imported.caseId,
        skillVersionId: "skillv_test"
      });

      expect(runResult.verdict).toBe("pass");
      expect(runResult.providerMetadata).toEqual({
        model: "mock-heuristic-v1",
        requestId: null,
        responseId: null,
        systemFingerprint: null
      });
      const dashboard = await repo.getDashboardSummary("proj_test");
      expect(dashboard.project.importedTraceCount).toBe(1);
      expect(dashboard.project.autoJudgedTraceCount).toBe(1);
      expect(dashboard.currentVersionResultCount).toBe(1);
      expect(dashboard.verdictDistribution.pass).toBe(1);

      // The judge worker now feeds the v2 trust layer too: a real source=llm_judge
      // verdict, pinned to the skill version, lands alongside the legacy judge_run.
      const workerVerdicts = await repo.listVerdicts({
        projectId: "proj_test",
        caseId: imported.caseId,
        source: "llm_judge",
        limit: 10
      });
      expect(workerVerdicts).toHaveLength(1);
      expect(workerVerdicts[0]!.skillVersionId).toBe("skillv_test");
      expect(workerVerdicts[0]!.payload.kind).toBe("binary");

      // v2 verdict roundtrip — all three kinds + source discriminator + external_run
      // dedup. Run on a separate, un-judged case so the counts are exact.
      const roundtrip = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "manual_roundtrip_smoke",
        input: { question: "Roundtrip?" },
        output: { answer: "Yes." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      const llmVerdict = await repo.recordVerdict({
        projectId: "proj_test",
        caseId: roundtrip.caseId,
        source: "llm_judge",
        skillVersionId: "skillv_test",
        payload: { kind: "binary", pass: true, rationale: "smoke binary" }
      });
      const humanVerdict = await repo.recordVerdict({
        projectId: "proj_test",
        caseId: roundtrip.caseId,
        source: "human",
        actorUserId: null as unknown as undefined,
        payload: {
          kind: "categorical",
          choice: "okay",
          choiceScores: { great: 1, okay: 0.5, bad: 0 },
          rationale: "smoke categorical"
        }
      });
      const externalVerdict = await repo.recordVerdict({
        projectId: "proj_test",
        caseId: roundtrip.caseId,
        source: "imported_external",
        externalRunId: "ls_smoke_run_42",
        payload: { kind: "scalar", score: 0.75, range: [0, 1], rationale: "smoke scalar" }
      });

      const dedupAttempt = await repo.recordVerdict({
        projectId: "proj_test",
        caseId: roundtrip.caseId,
        source: "imported_external",
        externalRunId: "ls_smoke_run_42",
        payload: { kind: "scalar", score: 0.0, range: [0, 1], rationale: "should dedup" }
      });
      expect(dedupAttempt.id).toBe(externalVerdict.id);

      const verdicts = await repo.listVerdicts({ projectId: "proj_test", caseId: roundtrip.caseId, limit: 10 });
      expect(verdicts).toHaveLength(3);
      expect(verdicts.map((v) => v.source).sort()).toEqual(["human", "imported_external", "llm_judge"]);
      expect(verdicts.find((v) => v.id === llmVerdict.id)?.payload).toMatchObject({ kind: "binary", pass: true });
      expect(verdicts.find((v) => v.id === humanVerdict.id)?.payload).toMatchObject({ kind: "categorical", choice: "okay" });
      expect(verdicts.find((v) => v.id === externalVerdict.id)?.payload).toMatchObject({ kind: "scalar", score: 0.75 });

      // Both llm_judge verdicts (worker + roundtrip) are present project-wide.
      const onlyLlm = await repo.listVerdicts({ projectId: "proj_test", source: "llm_judge", limit: 10 });
      expect(onlyLlm.map((v) => v.id)).toContain(llmVerdict.id);
      expect(onlyLlm).toHaveLength(2);

      const bySkill = await repo.listVerdicts({ projectId: "proj_test", skillVersionId: "skillv_test", limit: 10 });
      expect(bySkill.map((v) => v.id)).toContain(llmVerdict.id);
    } finally {
      await cleanup();
    }
  });
});
