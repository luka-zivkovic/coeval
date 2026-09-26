import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";

// Per-item provenance for evidence v2 (ADR-0014 section 6), as stored: an
// evaluator verdict's observation and score, and a failed item's
// classification, which the database requires.

const NOTHING = { model: null, requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null };

runPgSmoke("eval item provenance storage", () => {
  it("stores an evaluator verdict's provenance and requires every failed item to be classified", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      const cases = [];
      for (const id of ["a", "b", "c"]) {
        cases.push((await repo.importTrace("proj_test", "manual", {
          sourceTraceId: `provenance_${id}`, input: { q: id }, output: { a: id }, metadata: {}
        }, { ingestionPurpose: "analysis_eligible_manual" })).caseId);
      }

      const observed = { ...NOTHING, model: "claude-observed", upstreamProvider: null, reasoningTokens: 12, thinkingReturned: false };
      const verdict = await repo.recordVerdict({
        projectId: "proj_test", caseId: cases[0]!, source: "llm_judge", skillVersionId: "skillv_test",
        payload: { kind: "binary", pass: true, rationale: "grounded" }, observed, evaluatorScore: { value: 0.91, kind: "self_reported_score" }
      });
      expect(verdict).toMatchObject({ observed, evaluatorScore: { value: 0.91, kind: "self_reported_score" } });
      await expect(pool.query(
        `insert into verdicts (id,project_id,case_id,source,verdict_kind,payload,observed) values ('v_human','proj_test',$1,'human','binary','{"kind":"binary","pass":true,"rationale":"ok"}',$2::jsonb)`,
        [cases[0], JSON.stringify(observed)]
      )).rejects.toMatchObject({ code: "23514" });

      const run = await repo.createEvalRun({
        projectId: "proj_test", skillVersionId: "skillv_test", trigger: "manual",
        items: cases.map((caseId) => ({ caseId }))
      });
      const [first, second, third] = run.items;
      await expect(pool.query(`update eval_run_items set status='failed', error='unclassified', finished_at=now() where id=$1`, [first!.id]))
        .rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(`update eval_run_items set status='failed', error='x', not_attempted=true, observed=$2::jsonb, finished_at=now() where id=$1`, [first!.id, JSON.stringify(NOTHING)]))
        .rejects.toMatchObject({ code: "23514" });

      await repo.failEvalRunItem({
        projectId: "proj_test", evalRunId: run.id, evalRunItemId: first!.id, error: "rejected",
        failure: { state: "failure", failureKind: "provider_rejected_request", observed }
      });
      await repo.failEvalRunItem({
        projectId: "proj_test", evalRunId: run.id, evalRunItemId: second!.id, error: "never started",
        failure: { state: "not_attempted" }
      });
      const detail = await repo.getEvalRunDetail("proj_test", run.id);
      expect(detail!.items.find((item) => item.id === first!.id)).toMatchObject({ failureKind: "provider_rejected_request", notAttempted: false, observed });
      expect(detail!.items.find((item) => item.id === second!.id)).toMatchObject({ failureKind: null, notAttempted: true, observed: null });
      expect(detail!.items.find((item) => item.id === third!.id)).toMatchObject({ status: "pending", failureKind: null, notAttempted: false, observed: null });
    } finally {
      await cleanup();
    }
  });
});
