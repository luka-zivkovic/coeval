import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { MinimumVerdictOutputSchema } from "@coeval/shared";
import { PgBossQueue, type Queue, type QueueJob, type QueueName, type QueueSendOptions } from "@coeval/queue";
import type { Pool } from "pg";
import { createApp } from "../src/app.js";
import { createStrictJudgeProvider } from "../src/lib/judge-provider.js";
import { PgRepository } from "../src/repository.pg.js";
import { processEvalItemJob, processEvalRunJob, recoverStaleEvalRunItemExecutions } from "../src/workers/eval-run.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; convergence PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

run("PostgreSQL convergence audit", () => {
  it("uses exact latest per-case heads after the former 50k scan boundary", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("convergence_exact");
    try {
      await runMigrations(pool);
      await pool.query(`insert into organizations (id, name) values ('org_convergence', 'Convergence Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_convergence', 'org_convergence', 'Convergence Project', 'manual')`);
      await pool.query(`insert into criteria (id,project_id,stable_key,source_kind) values ('criterion_convergence','proj_convergence','convergence-correctness','native')`);
      await pool.query(`
        insert into criterion_versions
          (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
        values ('criterionv_convergence','proj_convergence','criterion_convergence',1,'Convergence correctness',
                'The response follows the recorded ruling.',
                criterion_v1_digest('criterion_convergence','criterionv_convergence','Convergence correctness',
                                    'The response follows the recorded ruling.'),'native')
      `);
      await pool.query(`insert into skills (id, project_id, name, description, status, criterion_id) values ('skill_convergence', 'proj_convergence', 'Convergence Skill', 'Boundary test', 'draft', 'criterion_convergence')`);
      const versionFixture = [
        "Judge the trace against the criterion.",
        JSON.stringify(MinimumVerdictOutputSchema),
        JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "convergence-test", temperature: 0 })
      ];
      await pool.query(
        `insert into skill_versions
          (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
           criterion_version_id, created_at)
         values
          ('skillv_convergence_1','skill_convergence','proj_convergence','1.0.0','draft','Pass correct answers.',$1,$2,$3,'criterionv_convergence','2026-01-01T00:00:00Z'),
          ('skillv_convergence_2','skill_convergence','proj_convergence','1.1.0','draft','Pass correct answers.',$1,$2,$3,'criterionv_convergence','2026-01-02T00:00:00Z')`,
        versionFixture
      );
      const repository = new PgRepository(pool);
      const imported = await repository.importTrace("proj_convergence", "manual", {
        sourceTraceId: "convergence-boundary-case",
        input: { question: "boundary" },
        output: { answer: "correct" },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });

      // 1 old adjudication + 49,999 repeat judge rows + 1 later correction =
      // 50,001 rows. The former oldest-first LIMIT 50000 silently omitted the
      // correction and reported a disagreement. Exact per-case heads must use
      // the appended correction instead.
      await pool.query(
        `insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
         values ('verdict_boundary_old_ruling','proj_convergence',$1,'skillv_convergence_2','adjudicated','binary',$2,'2026-01-03T00:00:00Z')`,
        [imported.caseId, JSON.stringify({ kind: "binary", pass: false, rationale: "Initial ruling." })]
      );
      await pool.query(
        `insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
         select 'verdict_boundary_judge_' || n,
                'proj_convergence', $1, 'skillv_convergence_2', 'llm_judge', 'binary', $2::jsonb,
                '2026-01-04T00:00:00Z'::timestamptz + n * interval '1 millisecond'
         from generate_series(1, 49999) n`,
        [imported.caseId, JSON.stringify({ kind: "binary", pass: true, rationale: "Repeated current-version judgment." })]
      );
      await pool.query(
        `insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
         values ('verdict_boundary_corrected_ruling','proj_convergence',$1,'skillv_convergence_2','adjudicated','binary',$2,'2026-01-06T00:00:00Z')`,
        [imported.caseId, JSON.stringify({ kind: "binary", pass: true, rationale: "Corrected ruling." })]
      );

      const page = await repository.getConvergenceAudit(
        "proj_convergence",
        "skill_convergence",
        "skillv_convergence_2",
        { limit: 1 }
      );
      expect(page.audit).toMatchObject({
        adjudicatedTotal: 1,
        comparedCases: 1,
        afterAgreed: 1,
        beforeKnown: 0,
        beforeAgreed: 0
      });
      expect(page.audit.cases).toEqual([{
        caseId: imported.caseId,
        adjudicatedLabel: "pass",
        beforeLabel: null,
        afterLabel: "pass",
        change: "still_agree"
      }]);
      expect(page.nextCursor).toBeNull();
      expect(page.nextUncoveredCaseId).toBeNull();
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("matches the discrete in-memory contract for categories, abstention, scalars, and ties", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("convergence_semantics");
    try {
      await runMigrations(pool);
      await seedConvergenceProject(pool, "semantics");
      await pool.query(
        `update skill_versions
         set created_at = case id
           when 'skillv_semantics_1' then '2026-01-01T00:00:00.123455Z'::timestamptz
           else '2026-01-01T00:00:00.123456Z'::timestamptz end
         where id in ('skillv_semantics_1', 'skillv_semantics_2')`
      );
      const repository = new PgRepository(pool);
      const [category, abstention, scalar, tied, microsecond] = await Promise.all([
        importCase(repository, "semantics", "category"),
        importCase(repository, "semantics", "abstention"),
        importCase(repository, "semantics", "scalar"),
        importCase(repository, "semantics", "tied"),
        importCase(repository, "semantics", "microsecond")
      ]);
      const insertVerdict = async (
        id: string,
        caseId: string,
        source: "adjudicated" | "llm_judge",
        kind: "binary" | "categorical" | "scalar",
        payload: object,
        createdAt = "2026-02-01T00:00:00Z"
      ) => pool.query(
        `insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
         values ($1, 'proj_semantics', $2, 'skillv_semantics_2', $3, $4, $5, $6)`,
        [id, caseId, source, kind, JSON.stringify(payload), createdAt]
      );

      await insertVerdict("verdict_category_ruling", category, "adjudicated", "categorical", {
        kind: "categorical", choice: "safe", choiceScores: { safe: 0.2, unsafe: 0.8 }, rationale: "Recorded category."
      });
      await insertVerdict("verdict_category_judge", category, "llm_judge", "categorical", {
        kind: "categorical", choice: "safe", choiceScores: { safe: 0.2, unsafe: 0.8 }, rationale: "Same raw category."
      });
      await pool.query(
        `insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
         values ('verdict_category_before',$1,$2,'skillv_semantics_1','llm_judge','categorical',$3,$4)`,
        [
          "proj_semantics",
          category,
          JSON.stringify({
            kind: "categorical",
            choice: "unsafe",
            choiceScores: { safe: 0.2, unsafe: 0.8 },
            rationale: "Immediate microsecond predecessor."
          }),
          "2026-01-31T00:00:00Z"
        ]
      );
      await insertVerdict("verdict_abstention_ruling", abstention, "adjudicated", "binary", {
        kind: "binary", label: "ambiguous", rationale: "Insufficient evidence."
      });
      await insertVerdict("verdict_abstention_judge", abstention, "llm_judge", "binary", {
        kind: "binary", label: "ambiguous", rationale: "Insufficient evidence."
      });
      await insertVerdict("verdict_scalar_ruling", scalar, "adjudicated", "scalar", {
        kind: "scalar", score: 1, range: [0, 1], rationale: "Unsupported for a discrete comparison."
      });
      await insertVerdict("verdict_scalar_judge", scalar, "llm_judge", "scalar", {
        kind: "scalar", score: 1, range: [0, 1], rationale: "Unsupported for a discrete comparison."
      });
      await insertVerdict("verdict_tie_ruling_a", tied, "adjudicated", "binary", {
        kind: "binary", pass: false, rationale: "Earlier id at the same timestamp."
      });
      await insertVerdict("verdict_tie_ruling_z", tied, "adjudicated", "binary", {
        kind: "binary", pass: true, rationale: "Later id at the same timestamp."
      });
      await insertVerdict("verdict_tie_judge_a", tied, "llm_judge", "binary", {
        kind: "binary", pass: false, rationale: "Earlier id at the same timestamp."
      });
      await insertVerdict("verdict_tie_judge_z", tied, "llm_judge", "binary", {
        kind: "binary", pass: true, rationale: "Later id at the same timestamp."
      });
      await insertVerdict("verdict_microsecond_ruling", microsecond, "adjudicated", "binary", {
        kind: "binary", pass: true, rationale: "Microsecond ruling."
      }, "2026-02-02T00:00:00.123455Z");
      await insertVerdict("verdict_microsecond_judge", microsecond, "llm_judge", "binary", {
        kind: "binary", pass: true, rationale: "Newest row must survive its own snapshot."
      }, "2026-02-02T00:00:00.123456Z");

      const firstPage = await repository.getConvergenceAudit(
        "proj_semantics",
        "skill_semantics",
        "skillv_semantics_2",
        { limit: 2 }
      );
      expect(firstPage.audit).toMatchObject({
        beforeVersionId: "skillv_semantics_1",
        adjudicatedTotal: 4,
        comparedCases: 4,
        afterAgreed: 4,
        beforeKnown: 1
      });
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await repository.getConvergenceAudit(
        "proj_semantics",
        "skill_semantics",
        "skillv_semantics_2",
        { limit: 2, cursor: firstPage.nextCursor }
      );
      expect(secondPage.audit).toMatchObject({ adjudicatedTotal: 4, comparedCases: 4, afterAgreed: 4 });
      const allCases = [...firstPage.audit.cases, ...secondPage.audit.cases];
      expect(new Set(allCases.map((entry) => entry.caseId)).size).toBe(4);
      expect(allCases).toEqual(expect.arrayContaining([
        expect.objectContaining({ caseId: category, adjudicatedLabel: "safe", afterLabel: "safe" }),
        expect.objectContaining({ caseId: abstention, adjudicatedLabel: "ambiguous", afterLabel: "ambiguous" }),
        expect.objectContaining({ caseId: tied, adjudicatedLabel: "pass", afterLabel: "pass" }),
        expect.objectContaining({ caseId: microsecond, adjudicatedLabel: "pass", afterLabel: "pass" })
      ]));
      expect(allCases.some((entry) => entry.caseId === scalar)).toBe(false);
      expect(secondPage.nextCursor).toBeNull();
      expect(secondPage.nextUncoveredCaseId).toBeNull();

      // Equal timestamps still use id as the deterministic predecessor tie.
      await pool.query(
        `insert into skill_versions
          (id, skill_id, project_id, version, status, rubric_markdown, prompt,
           output_schema, model_binding, criterion_version_id, created_at)
         select 'skillv_semantics_3', skill_id, project_id, '1.2.0', status,
                rubric_markdown, prompt, output_schema, model_binding,
                criterion_version_id, created_at
         from skill_versions where id = 'skillv_semantics_2'`
      );
      const tiedVersion = await repository.getConvergenceAudit(
        "proj_semantics",
        "skill_semantics",
        "skillv_semantics_3",
        { limit: 1 }
      );
      expect(tiedVersion.audit.beforeVersionId).toBe("skillv_semantics_2");
    } finally {
      await cleanup();
    }
  });

  it("claims one active coverage run under concurrent PostgreSQL requests and permits terminal retries", async () => {
    const { pool, databaseUrl, cleanup } = await openPostgresTestDatabase("convergence_claim");
    let durableQueue: PgBossQueue | null = null;
    try {
      await runMigrations(pool);
      await seedConvergenceProject(pool, "claim");
      const repository = new PgRepository(pool);
      const caseId = await importCase(repository, "claim", "claim");
      const input = {
        projectId: "proj_claim",
        skillVersionId: "skillv_claim_2",
        caseId
      };

      const claimed = await Promise.all([
        repository.createConvergenceEvalRun(input),
        repository.createConvergenceEvalRun(input)
      ]);
      expect(new Set(claimed.map((entry) => entry.run.id)).size).toBe(1);
      expect(claimed.map((entry) => entry.created).sort()).toEqual([false, true]);
      await expect(pool.query(
        `select count(*)::int as count from eval_runs
         where project_id = 'proj_claim' and skill_version_id = 'skillv_claim_2' and convergence_case_id = $1`,
        [caseId]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });

      await pool.query(
        `update eval_runs set status = 'failed', finished_at = now() where id = $1`,
        [claimed[0]!.run.id]
      );
      const retried = await repository.createConvergenceEvalRun(input);
      expect(retried.created).toBe(true);
      expect(retried.run.id).not.toBe(claimed[0]!.run.id);
      await pool.query(
        `update eval_runs set status = 'canceled', finished_at = now() where id = $1`,
        [retried.run.id]
      );
      const afterCancel = await repository.createConvergenceEvalRun(input);
      expect(afterCancel.created).toBe(true);
      expect(afterCancel.run.id).not.toBe(retried.run.id);
      await expect(pool.query(
        `select count(*)::int as count from eval_runs
         where project_id = 'proj_claim' and skill_version_id = 'skillv_claim_2' and convergence_case_id = $1`,
        [caseId]
      )).resolves.toMatchObject({ rows: [{ count: 3 }] });
      const abandonedDispatch = await repository.claimEvalRunDispatch({
        projectId: "proj_claim",
        evalRunId: afterCancel.run.id,
        dispatchToken: "request_a"
      });
      expect(abandonedDispatch.state).toBe("claimed");
      await pool.query(
        `update eval_runs set queue_dispatch_claimed_at = clock_timestamp() - interval '6 minutes'
         where id = $1`,
        [afterCancel.run.id]
      );
      const recoveredDispatch = await repository.claimEvalRunDispatch({
        projectId: "proj_claim",
        evalRunId: afterCancel.run.id,
        dispatchToken: "request_b"
      });
      expect(recoveredDispatch).toEqual(abandonedDispatch);
      await repository.releaseEvalRunDispatch({
        projectId: "proj_claim",
        evalRunId: afterCancel.run.id,
        dispatchToken: "request_b"
      });

      // Exercise the complete HTTP selection → claim → dispatch boundary with
      // the default project scope used by app.request(). Both requests may
      // select the same uncovered case, but they return one run and one
      // durable queue identity.
      await seedConvergenceProject(pool, "langsmith_support");
      const routeCaseId = await importCase(repository, "langsmith_support", "route-claim");
      await pool.query(
        `insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
         values ('verdict_route_ruling','proj_langsmith_support',$1,'skillv_langsmith_support_2',
                 'adjudicated','binary',$2,'2026-02-01T00:00:00Z')`,
        [routeCaseId, JSON.stringify({ kind: "binary", pass: true, rationale: "Uncovered route ruling." })]
      );
      const queue = new CapturingQueue();
      const app = createApp(repository, { pool, queue });
      const path = "/api/skills/skill_langsmith_support/versions/skillv_langsmith_support_2/convergence/runs";
      const responses = await Promise.all([
        app.request(path, { method: "POST" }),
        app.request(path, { method: "POST" })
      ]);
      const responseStatuses = responses.map((response) => response.status);
      expect(responseStatuses).toContain(202);
      expect(responseStatuses.every((status) => status === 202 || status === 503)).toBe(true);
      const busyConcurrentResponse = responses.find((response) => response.status === 503);
      if (busyConcurrentResponse) expect(busyConcurrentResponse.headers.get("retry-after")).toBe("300");
      const bodies = await Promise.all(responses.map(async (response) => response.json())) as Array<{
        run: { id: string };
        caseId: string;
      }>;
      expect(bodies[0]?.caseId).toBe(routeCaseId);
      expect(bodies[1]?.run.id).toBe(bodies[0]?.run.id);
      expect(queue.jobs).toHaveLength(1);
      const queueJobId = queue.jobs[0]!.options?.id;
      expect(queueJobId).toMatch(/^[0-9a-f-]{36}$/);
      if (!queueJobId) throw new Error("coverage dispatch did not persist a queue job id");
      await expect(pool.query(
        `select count(*)::int as count from eval_runs
         where project_id = 'proj_langsmith_support'
           and skill_version_id = 'skillv_langsmith_support_2'
           and convergence_case_id = $1`,
        [routeCaseId]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });

      // Real pg-boss validation: deterministic job IDs remain unique even if
      // their creation time crosses what used to be an epoch singleton slot.
      durableQueue = new PgBossQueue(databaseUrl);
      await durableQueue.start();
      const queueData = { projectId: "proj_langsmith_support", evalRunId: bodies[0]!.run.id };
      expect(await durableQueue.send("eval.run", queueData, { id: queueJobId })).toBe(queueJobId);
      await pool.query(
        `update pgboss.job set created_on = created_on - interval '2 days'
         where name = 'eval.run' and id = $1`,
        [queueJobId]
      );
      expect(await durableQueue.send("eval.run", queueData, { id: queueJobId })).toBeNull();

      await processEvalRunJob(repository, durableQueue, queueData);
      const firstItemJobs = await pool.query(
        `select id from pgboss.job where name = 'eval.item' and data->>'evalRunId' = $1`,
        [bodies[0]!.run.id]
      );
      expect(firstItemJobs.rows).toHaveLength(1);
      await pool.query(
        `update pgboss.job set created_on = created_on - interval '2 days'
         where name = 'eval.item' and id = $1`,
        [firstItemJobs.rows[0]!.id]
      );
      await processEvalRunJob(repository, durableQueue, queueData);
      const retriedItemJobs = await pool.query(
        `select id from pgboss.job where name = 'eval.item' and data->>'evalRunId' = $1`,
        [bodies[0]!.run.id]
      );
      expect(retriedItemJobs.rows).toEqual(firstItemJobs.rows);

      // Two distinct item deliveries race on the same pending item. The
      // PostgreSQL execution claim admits one provider call and one verdict.
      const detail = await repository.getEvalRunDetail("proj_langsmith_support", bodies[0]!.run.id);
      const item = detail!.items[0]!;
      const itemJob = {
        projectId: "proj_langsmith_support",
        evalRunId: bodies[0]!.run.id,
        evalRunItemId: item.id,
        caseId: routeCaseId,
        skillVersionId: "skillv_langsmith_support_2"
      };
      const base = createStrictJudgeProvider({
        provider: "mock",
        modelId: "mock",
        modelVersion: "mock",
        temperature: 0
      });
      let providerCalls = 0;
      let enteredProvider!: () => void;
      let releaseProvider!: () => void;
      const entered = new Promise<void>((resolve) => { enteredProvider = resolve; });
      const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const provider = {
        name: base.name,
        modelName: base.modelName,
        judge: base.judge.bind(base),
        async judgeStructured(input: Parameters<typeof base.judgeStructured>[0]) {
          providerCalls += 1;
          enteredProvider();
          await release;
          return base.judgeStructured(input);
        }
      };
      // Make the pre-delivery outbox deadline stale and pause recovery while
      // it observes the already-active pg-boss job. The real worker must
      // remain free to acquire the domain claim and enter the provider before
      // recovery refreshes the deadline; the sweep cannot swallow delivery by
      // temporarily installing its own execution token.
      await pool.query(
        `update eval_run_items set delivery_deadline_at = clock_timestamp() - interval '1 minute'
         where id = $1`,
        [item.id]
      );
      await pool.query(
        `update pgboss.job set state = 'active', started_on = clock_timestamp()
         where name = 'eval.item' and id = $1`,
        [firstItemJobs.rows[0]!.id]
      );
      let queueLookupStarted!: () => void;
      let releaseQueueLookup!: () => void;
      const lookupStarted = new Promise<void>((resolve) => { queueLookupStarted = resolve; });
      const lookupRelease = new Promise<void>((resolve) => { releaseQueueLookup = resolve; });
      const racingRecovery = recoverStaleEvalRunItemExecutions(
        repository,
        new BarrierJobStateQueue(durableQueue, queueLookupStarted, lookupRelease)
      );
      await lookupStarted;
      const firstDelivery = processEvalItemJob(repository, itemJob, provider, "delivery_a");
      await entered;
      releaseQueueLookup();
      expect(await racingRecovery).toBe(1);
      expect((await repository.getEvalRunDetail("proj_langsmith_support", bodies[0]!.run.id))?.items[0]).toMatchObject({
        status: "pending"
      });
      await processEvalItemJob(repository, itemJob, provider, "delivery_b");
      expect(providerCalls).toBe(1);
      releaseProvider();
      await firstDelivery;
      expect((await repository.listVerdicts({
        projectId: "proj_langsmith_support",
        caseId: routeCaseId,
        source: "llm_judge",
        limit: 10
      }))).toHaveLength(1);

      // A process death after the DB dispatch claim but before queue.send must
      // never produce an accepted-but-unqueued 202. The route returns a
      // retryable 503 while the lease is live, then reuses the same job UUID.
      const dispatchCrashCaseId = await importCase(repository, "langsmith_support", "dispatch-crash");
      await pool.query(
        `insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
         values ('verdict_dispatch_crash_ruling','proj_langsmith_support',$1,'skillv_langsmith_support_2',
                 'adjudicated','binary',$2,'2026-02-03T00:00:00Z')`,
        [dispatchCrashCaseId, JSON.stringify({ kind: "binary", pass: true, rationale: "Dispatch crash ruling." })]
      );
      const dispatchCrashRun = await repository.createConvergenceEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        caseId: dispatchCrashCaseId
      });
      const preSendClaim = await repository.claimEvalRunDispatch({
        projectId: "proj_langsmith_support",
        evalRunId: dispatchCrashRun.run.id,
        dispatchToken: "request_that_died_before_send"
      });
      expect(preSendClaim.state).toBe("claimed");
      const busyResponse = await app.request(path, { method: "POST" });
      expect(busyResponse.status).toBe(503);
      expect(busyResponse.headers.get("retry-after")).toBe("300");
      expect(queue.jobs).toHaveLength(1);
      await pool.query(
        `update eval_runs set queue_dispatch_claimed_at = clock_timestamp() - interval '6 minutes'
         where id = $1`,
        [dispatchCrashRun.run.id]
      );
      const recoveredResponse = await app.request(path, { method: "POST" });
      expect(recoveredResponse.status).toBe(202);
      expect(queue.jobs).toHaveLength(2);
      expect(queue.jobs[1]!.options?.id).toBe(preSendClaim.jobId);

      // Pre-call crash: once the claim lease is stale, a new generation may
      // safely take over because physical provider dispatch never started.
      const preCallCaseId = await importCase(repository, "langsmith_support", "pre-call-crash");
      const preCallRun = await repository.createEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        trigger: "manual",
        items: [{ caseId: preCallCaseId }]
      });
      expect(await repository.claimEvalRunItemExecution({
        projectId: "proj_langsmith_support",
        evalRunId: preCallRun.id,
        evalRunItemId: preCallRun.items[0]!.id,
        executionToken: "pre_call_generation_a"
      })).toEqual({ state: "claimed" });
      await pool.query(
        `update eval_run_items set execution_claimed_at = clock_timestamp() - interval '16 minutes'
         where id = $1`,
        [preCallRun.items[0]!.id]
      );
      await processEvalItemJob(repository, {
        projectId: "proj_langsmith_support",
        evalRunId: preCallRun.id,
        evalRunItemId: preCallRun.items[0]!.id,
        caseId: preCallCaseId,
        skillVersionId: "skillv_langsmith_support_2"
      }, base, "pre_call_generation_b");
      expect((await repository.getEvalRunDetail("proj_langsmith_support", preCallRun.id))?.items[0]?.status).toBe("completed");

      // A permanent/final pre-call failure retains its generation until the
      // terminal write. PostgreSQL must not expose a release-before-fail gap
      // in which a redelivery can claim and start provider work.
      const terminalPreCallCaseId = await importCase(repository, "langsmith_support", "terminal-pre-call");
      const terminalPreCallRun = await repository.createEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        trigger: "manual",
        items: [{ caseId: terminalPreCallCaseId }]
      });
      const terminalPreCallClaim = {
        projectId: "proj_langsmith_support",
        evalRunId: terminalPreCallRun.id,
        evalRunItemId: terminalPreCallRun.items[0]!.id,
        executionToken: "terminal_pre_call_generation_a"
      };
      expect(await repository.claimEvalRunItemExecution(terminalPreCallClaim)).toEqual({ state: "claimed" });
      expect(await repository.releaseEvalRunItemExecution(
        terminalPreCallClaim,
        { preservePreCallClaim: true }
      )).toEqual({ state: "pre_call_held" });
      expect(await repository.claimEvalRunItemExecution({
        ...terminalPreCallClaim,
        executionToken: "terminal_pre_call_generation_b"
      })).toEqual({ state: "busy" });
      await repository.failEvalRunItem({
        projectId: terminalPreCallClaim.projectId,
        evalRunId: terminalPreCallClaim.evalRunId,
        evalRunItemId: terminalPreCallClaim.evalRunItemId,
        executionToken: terminalPreCallClaim.executionToken,
        error: "Permanent failure before provider dispatch."
      });
      expect((await repository.getEvalRunDetail(
        "proj_langsmith_support",
        terminalPreCallRun.id
      ))?.items[0]?.status).toBe("failed");

      // Provider-call-start with no durable response is also outcome-unknown:
      // recovery fails honestly without inventing a second attempt or verdict.
      const postCallCaseId = await importCase(repository, "langsmith_support", "post-call-crash");
      const postCallRun = await repository.createEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        trigger: "manual",
        items: [{ caseId: postCallCaseId }]
      });
      const postCallClaim = {
        projectId: "proj_langsmith_support",
        evalRunId: postCallRun.id,
        evalRunItemId: postCallRun.items[0]!.id,
        executionToken: "post_call_generation_a"
      };
      expect(await repository.claimEvalRunItemExecution(postCallClaim)).toEqual({ state: "claimed" });
      expect(await repository.beginEvalRunItemProviderCall(postCallClaim)).toBe(true);
      await pool.query(
        `update eval_run_items set execution_claimed_at = clock_timestamp() - interval '16 minutes'
         where id = $1`,
        [postCallRun.items[0]!.id]
      );
      expect(await recoverStaleEvalRunItemExecutions(repository)).toBe(1);
      expect((await repository.getEvalRunDetail("proj_langsmith_support", postCallRun.id))?.items[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("outcome unknown")
      });
      expect(await repository.listVerdicts({
        projectId: "proj_langsmith_support",
        caseId: postCallCaseId,
        source: "llm_judge",
        limit: 10
      })).toHaveLength(0);

      // Post-dispatch/ledger crash: a stale generation with physical-call
      // start recorded is terminalized as outcome-unknown. Recovery never
      // calls the provider again, even when one verdict was already appended.
      const uncertainCaseId = await importCase(repository, "langsmith_support", "post-verdict-crash");
      const uncertainRun = await repository.createEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        trigger: "manual",
        items: [{ caseId: uncertainCaseId }]
      });
      const uncertainItemId = uncertainRun.items[0]!.id;
      const uncertainClaim = {
        projectId: "proj_langsmith_support",
        evalRunId: uncertainRun.id,
        evalRunItemId: uncertainItemId,
        executionToken: "uncertain_generation_a"
      };
      expect(await repository.claimEvalRunItemExecution(uncertainClaim)).toEqual({ state: "claimed" });
      expect(await repository.beginEvalRunItemProviderCall(uncertainClaim)).toBe(true);
      expect(await repository.markEvalRunItemProviderCallReturned(uncertainClaim)).toBe(true);
      await repository.recordVerdict({
        projectId: "proj_langsmith_support",
        caseId: uncertainCaseId,
        skillVersionId: "skillv_langsmith_support_2",
        source: "llm_judge",
        payload: { kind: "binary", pass: true, rationale: "Provider returned before the worker died." }
      });
      let recoveryProviderCalls = 0;
      const forbiddenRecoveryProvider = {
        name: base.name,
        modelName: base.modelName,
        judge: base.judge.bind(base),
        async judgeStructured(input: Parameters<typeof base.judgeStructured>[0]) {
          recoveryProviderCalls += 1;
          return base.judgeStructured(input);
        }
      };
      await processEvalItemJob(repository, {
        projectId: "proj_langsmith_support",
        evalRunId: uncertainRun.id,
        evalRunItemId: uncertainItemId,
        caseId: uncertainCaseId,
        skillVersionId: "skillv_langsmith_support_2"
      }, forbiddenRecoveryProvider, "uncertain_generation_b");
      expect(recoveryProviderCalls).toBe(0);
      const uncertainDetail = await repository.getEvalRunDetail("proj_langsmith_support", uncertainRun.id);
      expect(uncertainDetail?.items[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Provider returned")
      });
      expect((await repository.listVerdicts({
        projectId: "proj_langsmith_support",
        caseId: uncertainCaseId,
        source: "llm_judge",
        limit: 10
      }))).toHaveLength(1);

      // A delayed delivery from a canceled run is terminal before fan-out or
      // provider dispatch; it cannot overwrite canceled or duplicate the
      // replacement convergence run's work.
      const canceledCaseId = await importCase(repository, "langsmith_support", "canceled-delivery");
      const canceledRun = await repository.createEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        trigger: "manual",
        items: [{ caseId: canceledCaseId }]
      });
      await pool.query(
        `update eval_runs set status = 'canceled', finished_at = clock_timestamp() where id = $1`,
        [canceledRun.id]
      );
      let canceledProviderCalls = 0;
      const canceledProvider = {
        name: base.name,
        modelName: base.modelName,
        judge: base.judge.bind(base),
        async judgeStructured(input: Parameters<typeof base.judgeStructured>[0]) {
          canceledProviderCalls += 1;
          return base.judgeStructured(input);
        }
      };
      await processEvalRunJob(repository, durableQueue, {
        projectId: "proj_langsmith_support",
        evalRunId: canceledRun.id
      });
      await processEvalItemJob(repository, {
        projectId: "proj_langsmith_support",
        evalRunId: canceledRun.id,
        evalRunItemId: canceledRun.items[0]!.id,
        caseId: canceledCaseId,
        skillVersionId: "skillv_langsmith_support_2"
      }, canceledProvider, "late_canceled_delivery");
      expect(canceledProviderCalls).toBe(0);
      expect(await repository.getEvalRun("proj_langsmith_support", canceledRun.id)).toMatchObject({
        status: "canceled",
        completedItems: 0,
        failedItems: 0
      });

      // Final eval.run death before fan-out: the accepted run's item deadline
      // expires with no item job. Recovery creates the persisted item UUID and
      // safely enqueues that missing job directly.
      const preFanoutCaseId = await importCase(repository, "langsmith_support", "pre-fanout-death");
      const preFanoutRun = await repository.createEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        trigger: "manual",
        items: [{ caseId: preFanoutCaseId }]
      });
      await repository.armEvalRunItemDeliveryDeadline("proj_langsmith_support", preFanoutRun.id);
      await pool.query(
        `update eval_run_items set delivery_deadline_at = clock_timestamp() - interval '1 minute'
         where id = $1`,
        [preFanoutRun.items[0]!.id]
      );
      const concurrentRecovery = await Promise.all([
        recoverStaleEvalRunItemExecutions(repository, durableQueue),
        recoverStaleEvalRunItemExecutions(repository, durableQueue)
      ]);
      expect(concurrentRecovery).toEqual([1, 1]);
      await expect(pool.query(
        `select count(*)::int count from pgboss.job
         where name = 'eval.item' and data->>'evalRunId' = $1`,
        [preFanoutRun.id]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      expect((await repository.getEvalRunDetail("proj_langsmith_support", preFanoutRun.id))?.items[0]?.status).toBe("pending");

      // Partial fan-out death: one persisted job already exists and one was
      // never sent. At the deadline the existing/exhausted UUID fails
      // explicitly, while the missing UUID is enqueued exactly once.
      const partialCaseA = await importCase(repository, "langsmith_support", "partial-fanout-a");
      const partialCaseB = await importCase(repository, "langsmith_support", "partial-fanout-b");
      const partialRun = await repository.createEvalRun({
        projectId: "proj_langsmith_support",
        skillVersionId: "skillv_langsmith_support_2",
        trigger: "manual",
        items: [{ caseId: partialCaseA }, { caseId: partialCaseB }]
      });
      await repository.markEvalRunRunning("proj_langsmith_support", partialRun.id);
      const partialDispatches = await repository.listPendingEvalRunItemDispatches(
        "proj_langsmith_support",
        partialRun.id
      );
      const sentPartial = partialDispatches[0]!;
      expect(await durableQueue.send("eval.item", {
        projectId: "proj_langsmith_support",
        evalRunId: partialRun.id,
        evalRunItemId: sentPartial.item.id,
        caseId: sentPartial.item.caseId,
        skillVersionId: "skillv_langsmith_support_2"
      }, { id: sentPartial.jobId, retryLimit: 5, retryBackoff: true })).toBe(sentPartial.jobId);
      await pool.query(
        `update pgboss.job set state = 'failed', completed_on = clock_timestamp()
         where name = 'eval.item' and id = $1`,
        [sentPartial.jobId]
      );
      await pool.query(
        `update eval_run_items set delivery_deadline_at = clock_timestamp() - interval '1 minute'
         where eval_run_id = $1`,
        [partialRun.id]
      );
      expect(await recoverStaleEvalRunItemExecutions(repository, durableQueue)).toBe(2);
      const partialDetail = await repository.getEvalRunDetail("proj_langsmith_support", partialRun.id);
      expect(partialDetail?.items.filter((item) => item.status === "failed")).toHaveLength(1);
      expect(partialDetail?.items.filter((item) => item.status === "pending")).toHaveLength(1);
      await expect(pool.query(
        `select count(*)::int count from pgboss.job
         where name = 'eval.item' and data->>'evalRunId' = $1`,
        [partialRun.id]
      )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    } finally {
      await durableQueue?.stop().catch(() => undefined);
      await cleanup();
    }
  });
});

async function seedConvergenceProject(pool: Pool, suffix: string): Promise<void> {
  await pool.query(`insert into organizations (id, name) values ($1, $2)`, [`org_${suffix}`, `${suffix} org`]);
  await pool.query(
    `insert into projects (id, organization_id, name, trace_provider) values ($1, $2, $3, 'manual')`,
    [`proj_${suffix}`, `org_${suffix}`, `${suffix} project`]
  );
  await pool.query(
    `insert into criteria (id,project_id,stable_key,source_kind) values ($1,$2,$3,'native')`,
    [`criterion_${suffix}`, `proj_${suffix}`, `${suffix}-correctness`]
  );
  await pool.query(
    `insert into criterion_versions
      (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
     values ($1,$2,$3,1,$4,$5,criterion_v1_digest($3,$1,$4,$5),'native')`,
    [
      `criterionv_${suffix}`,
      `proj_${suffix}`,
      `criterion_${suffix}`,
      `${suffix} correctness`,
      "The response follows the recorded ruling."
    ]
  );
  await pool.query(
    `insert into skills (id, project_id, name, description, status, criterion_id)
     values ($1, $2, $3, 'Convergence contract test', 'draft', $4)`,
    [`skill_${suffix}`, `proj_${suffix}`, `${suffix} skill`, `criterion_${suffix}`]
  );
  const fixture = [
    "Judge the trace against the criterion.",
    JSON.stringify(MinimumVerdictOutputSchema),
    JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "convergence-test", temperature: 0 })
  ];
  await pool.query(
    `insert into skill_versions
      (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
       criterion_version_id, created_at)
     values
      ($4,$1,$2,'1.0.0','draft','Pass correct answers.',$6,$7,$8,$3,'2026-01-01T00:00:00Z'),
      ($5,$1,$2,'1.1.0','draft','Pass correct answers.',$6,$7,$8,$3,'2026-01-02T00:00:00Z')`,
    [
      `skill_${suffix}`,
      `proj_${suffix}`,
      `criterionv_${suffix}`,
      `skillv_${suffix}_1`,
      `skillv_${suffix}_2`,
      ...fixture
    ]
  );
}

async function importCase(repository: PgRepository, suffix: string, caseName: string): Promise<string> {
  const imported = await repository.importTrace(`proj_${suffix}`, "manual", {
    sourceTraceId: `${suffix}-${caseName}`,
    input: { question: caseName },
    output: { answer: caseName },
    metadata: {}
  }, { ingestionPurpose: "analysis_eligible_manual" });
  return imported.caseId;
}

class CapturingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: object; options?: QueueSendOptions | undefined }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_name: QueueName, _handler: (job: { id: string; data: T }) => Promise<void>): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: QueueSendOptions): Promise<string> {
    this.jobs.push({ name, data, options });
    return `job_${this.jobs.length}`;
  }
}

class BarrierJobStateQueue implements Queue {
  constructor(
    private readonly delegate: Queue,
    private readonly onLookup: () => void,
    private readonly releaseLookup: Promise<void>
  ) {}

  async start(): Promise<void> { await this.delegate.start(); }
  async stop(): Promise<void> { await this.delegate.stop(); }
  async send<T extends object>(name: QueueName, data: T, options?: QueueSendOptions): Promise<string | null> {
    return this.delegate.send(name, data, options);
  }
  async getJobState(name: QueueName, id: string) {
    this.onLookup();
    await this.releaseLookup;
    return this.delegate.getJobState?.(name, id) ?? null;
  }
  async work<T extends object>(name: QueueName, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    await this.delegate.work(name, handler);
  }
}
