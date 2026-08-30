import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "@coeval/db";
import { createQueue, type Queue, type QueueName } from "@coeval/queue";
import { CreateSkillVersionInputSchema, MinimumVerdictOutputSchema, type JudgeProviderId } from "@coeval/shared";
import { GoldenSetEntryAlreadyRetiredError, IronsideIntegrationAlreadyExistsError, RegressionGateJudgeError, RegressionGateUnavailableError } from "../src/repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { processFeedbackSyncJob } from "../src/workers/feedback-sync.js";
import { dispatchEvalRunOnce, processGateRunJob } from "../src/workers/gate.js";
import { processJudgeRunJob, registerJudgeRunWorker } from "../src/workers/judge.js";
import { processLangSmithImportJob } from "../src/workers/langsmith-import.js";
import { enqueueDueLangSmithImports } from "../src/workers/langsmith-poller.js";
import { EXCLUDED_VALUE, REDACTED_VALUE } from "../src/lib/redaction.js";
import { buildAssessmentReceipt, contentDigest, evidenceDigestForReceipt } from "../src/lib/assessment-receipt.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
process.env.BETTER_AUTH_SECRET ??= "coeval-postgres-test-secret-at-least-32-bytes";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; Postgres smoke tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

run("PgRepository smoke", () => {
  it("runs migrations and lists projects", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      const projects = await repo.listProjects();
      expect(projects[0]?.id).toBe("proj_test");
    } finally {
      await cleanup();
    }
  });

  it("lists cases for the machine surface with stored payloads, since cursor, and scaffolding excluded", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "machine-read-1",
        input: { question: "Q?" },
        output: { answer: "A." },
        metadata: { stratum: "billing" },
        steps: [{ name: "lookup", input: { q: "Q?" }, output: { found: true } }]
      }, { ingestionPurpose: "analysis_eligible_manual" });
      // Release-evidence scaffolding must stay off the machine surface.
      await repo.importTrace("proj_test", "release_evidence", {
        sourceTraceId: "release-scaffolding-1",
        input: { question: "gate?" },
        output: { answer: "gate." },
        metadata: {}
      }, { ingestionPurpose: "release_evidence" });

      const cases = await repo.listCases("proj_test");
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({
        caseId: imported.caseId,
        sourceTraceId: "machine-read-1",
        trace: {
          input: { question: "Q?" },
          output: { answer: "A." },
          metadata: { stratum: "billing" }
        }
      });
      expect(new Date(cases[0]!.createdAt).toISOString()).toBe(cases[0]!.createdAt);
      await expect(repo.getOnboardingEvidenceInventory("proj_test")).resolves.toEqual({
        runCount: 1,
        inputCount: 1,
        outputCount: 1,
        stepsCount: 1,
        metadataCount: 1
      });

      const afterNow = await repo.listCases("proj_test", { since: new Date(Date.now() + 60_000).toISOString() });
      expect(afterNow).toEqual([]);
      const otherProject = await repo.listCases("proj_other");
      expect(otherProject).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("release evidence migration round-trips caller identity, per-call provenance, and duplicate-case receipt coverage", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      const input = { question: "Release?", api_key: "sk-submitted" };
      const output = { answer: "Yes." };
      const digest = contentDigest(input, output);
      const imported = await repo.importTrace("proj_test", "release_evidence", {
        sourceTraceId: "receipt-shared-content",
        input,
        output,
        metadata: {}
      }, { ingestionPurpose: "release_evidence" });
      const ordinary = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "ordinary-shared-content",
        input: { question: "Ordinary?" },
        output: { answer: "Yes." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await expect(repo.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        trigger: "api_batch",
        items: [{ caseId: ordinary.caseId }, { caseId: ordinary.caseId }]
      })).rejects.toMatchObject({ code: "23505" });
      // One case may legitimately back multiple caller items. Migration 0045
      // retains general uniqueness only where client_item_id is null.
      const run = await repo.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        trigger: "release_evidence",
        items: [
          { caseId: imported.caseId, clientItemId: "dailies-b", contentDigest: digest },
          { caseId: imported.caseId, clientItemId: "dailies-a", contentDigest: digest }
        ]
      });
      expect(run.items).toHaveLength(2);

      for (const [index, item] of run.items.entries()) {
        const verdictId = `receipt_verdict_${index}`;
        await pool.query(
          `insert into verdicts (id, project_id, case_id, skill_version_id, source, verdict_kind, payload)
           values ($1,'proj_test',$2,'skillv_test','llm_judge','binary','{"kind":"binary","pass":true,"rationale":"ok"}')`,
          [verdictId, imported.caseId]
        );
        await repo.completeEvalRunItem({
          projectId: "proj_test",
          evalRunId: run.id,
          evalRunItemId: item.id,
          verdictId,
          resultLabel: "pass",
          providerMetadata: {
            model: "mock-observed-v1",
            requestId: `request-${index}`,
            responseId: `response-${index}`,
            systemFingerprint: null
          }
        });
      }

      const detail = await repo.getEvalRunDetail("proj_test", run.id);
      const version = await repo.getSkillVersion("proj_test", "skillv_test");
      if (!detail || !version) throw new Error("release receipt fixture missing");
      expect(detail.trigger).toBe("release_evidence");
      expect(detail.items.map((item) => item.clientItemId).sort()).toEqual(["dailies-a", "dailies-b"]);
      expect(detail.items.every((item) => item.contentDigest === digest)).toBe(true);
      expect(detail.items.every((item) => item.providerMetadata?.model === "mock-observed-v1")).toBe(true);
      const receipt = buildAssessmentReceipt({ run: detail, skillVersion: version });
      expect(receipt.items.map((item) => item.clientItemId)).toEqual(["dailies-a", "dailies-b"]);
      expect(receipt.items.every((item) => item.caseId === imported.caseId)).toBe(true);
      expect(receipt.evidenceDigest).toBe(evidenceDigestForReceipt(receipt));

      await pool.query(
        `insert into judge_runs (id, project_id, case_id, skill_version_id, verdict, score, reasoning)
         values ('jr_release_evidence_fail', 'proj_test', $1, 'skillv_test', 'fail', 0, 'excluded receipt evidence')`,
        [imported.caseId],
      );
      expect(await repo.listCaseIdsForProject("proj_test")).not.toContain(imported.caseId);
      const dashboard = await repo.getDashboardSummary("proj_test");
      // Only the ordinary fixture counts; release evidence stays invisible.
      expect(dashboard.project.importedTraceCount).toBe(1);
      expect(dashboard.project.autoJudgedTraceCount).toBe(0);
      expect(dashboard.currentVersionResultCount).toBe(0);
      expect(dashboard.verdictDistribution.pass).toBe(0);
      expect(dashboard.verdictDistribution.fail).toBe(0);
      expect(dashboard.exceptions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: imported.caseId })]),
      );
    } finally {
      await cleanup();
    }
  });

  it("keeps imported-case evaluation unique and excludes scaffolding from customer Result probes", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);

      const customer = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "customer-result-case",
        input: { question: "Customer?" },
        output: { answer: "Customer." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      const scaffolding = await repo.importTrace("proj_test", "release_evidence", {
        sourceTraceId: "scaffolding-result-case",
        input: { question: "Gate?" },
        output: { answer: "Gate." },
        metadata: {}
      }, { ingestionPurpose: "release_evidence" });

      await repo.recordVerdict({
        projectId: "proj_test",
        caseId: scaffolding.caseId,
        skillVersionId: "skillv_test",
        source: "llm_judge",
        payload: { kind: "binary", pass: true, rationale: "release-only result" }
      });
      await expect(repo.listVerdicts({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        source: "llm_judge",
        evidenceScope: "customer",
        limit: 10
      })).resolves.toEqual([]);
      await expect(repo.listVerdicts({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        source: "llm_judge",
        evidenceScope: "all",
        limit: 10
      })).resolves.toHaveLength(1);

      const [first, second] = await Promise.all([
        repo.createImportedCaseEvalRun({
          projectId: "proj_test",
          skillVersionId: "skillv_test",
          caseId: customer.caseId
        }),
        repo.createImportedCaseEvalRun({
          projectId: "proj_test",
          skillVersionId: "skillv_test",
          caseId: customer.caseId
        })
      ]);
      expect(first.run.id).toBe(second.run.id);
      expect([first.created, second.created].sort()).toEqual([false, true]);
      const stored = await pool.query(
        `select id, ingestion_case_id from eval_runs
         where project_id = 'proj_test' and skill_version_id = 'skillv_test' and ingestion_case_id = $1`,
        [customer.caseId]
      );
      expect(stored.rows).toEqual([{ id: first.run.id, ingestion_case_id: customer.caseId }]);

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
          return id === attemptedIds[0] ? "cancelled" : null;
        }
      };
      await expect(dispatchEvalRunOnce(repo, first.run, exhaustedQueue)).resolves.toBe("ready");
      expect(attemptedIds).toHaveLength(2);
      expect(attemptedIds[1]).not.toBe(attemptedIds[0]);
      const dispatch = await pool.query(
        `select queue_job_id::text as queue_job_id, queue_dispatched_at
         from eval_runs where id = $1`,
        [first.run.id]
      );
      expect(dispatch.rows[0]).toMatchObject({
        queue_job_id: attemptedIds[1],
        queue_dispatched_at: expect.any(Date)
      });
    } finally {
      await cleanup();
    }
  });

  it("M2 T1: steps[] round-trip — stored redacted in normalized_payload, served on the judge-bound trace", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "steps_trace_1",
        input: { goal: "book a flight" },
        output: { summary: "booked" },
        metadata: {},
        steps: [
          { name: "search", input: { query: "flights" }, output: { results: 3 } },
          { name: "book", input: { api_key: "sk-live-leak", card: "4111" }, output: { confirmation: "OK-1" } }
        ]
      }, { ingestionPurpose: "analysis_eligible_manual" });

      // Stored payload carries steps, redacted at ingestion.
      const row = await pool.query(`select normalized_payload from cases where id = $1`, [imported.caseId]);
      const stored = typeof row.rows[0].normalized_payload === "string"
        ? JSON.parse(row.rows[0].normalized_payload)
        : row.rows[0].normalized_payload;
      expect(stored.steps).toHaveLength(2);
      expect(stored.steps[1].input.api_key).toBe("[REDACTED]");
      expect(stored.steps[1].input.card).toBe("4111");

      // The judge-bound trace built by loadJudgeRunContext delivers them.
      await seedSkill(pool);
      const context = await repo.loadJudgeRunContext({ projectId: "proj_test", caseId: imported.caseId });
      expect(context.trace.steps).toHaveLength(2);
      expect((context.trace.steps?.[0] as { name?: string }).name).toBe("search");

      // A step-less import stays byte-compatible: no steps key at all.
      const plain = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "steps_trace_plain",
        input: { q: "hi" },
        output: { a: "hello" },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      const plainRow = await pool.query(`select normalized_payload from cases where id = $1`, [plain.caseId]);
      const plainStored = typeof plainRow.rows[0].normalized_payload === "string"
        ? JSON.parse(plainRow.rows[0].normalized_payload)
        : plainRow.rows[0].normalized_payload;
      expect("steps" in plainStored).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("M2 T2: SQL upsert invariant — pass clears expected_fail_step, fail-without-step keeps it (migration 0030)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "t2_traj",
        input: { goal: "g" },
        output: { summary: "s" },
        metadata: {},
        steps: [
          { name: "s0", input: 0, output: 0 },
          { name: "s1", input: 1, output: 1 }
        ]
      }, { ingestionPurpose: "analysis_eligible_manual" });
      const dataset = await repo.createDataset({ projectId: "proj_test", name: "StepExp" });
      await seedSkill(pool);

      // fail + step stores both; snapshot lands on run items.
      let items = await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId, expectedLabel: "fail", expectedFailStep: 1 }]
      });
      expect(items[0]).toMatchObject({ expectedLabel: "fail", expectedFailStep: 1 });

      const run = await repo.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_test",
        trigger: "manual",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId, datasetItemId: items[0]!.id, expectedLabel: "fail", expectedFailStep: 1 }]
      });
      expect(run.items[0]).toMatchObject({ expectedFailStep: 1, failingStep: null, stepAgreement: null });

      // completing the item with a judge-named failingStep persists it
      // and resolves the tri-state — pins the SQL parameter ordering against
      // real Postgres (verdict id is fake; only the item row matters here).
      await pool.query(`insert into verdicts (id, project_id, case_id, source, verdict_kind, payload)
                        values ('v_t3', 'proj_test', $1, 'llm_judge', 'binary', '{"kind":"binary","pass":false,"rationale":"step 1 failed","failingStep":1}')`,
                       [imported.caseId]);
      await repo.completeEvalRunItem({
        projectId: "proj_test",
        evalRunId: run.id,
        evalRunItemId: run.items[0]!.id,
        verdictId: "v_t3",
        resultLabel: "fail",
        failingStep: 1,
        latencyMs: 42
      });
      const completedRun = await repo.getEvalRunDetail("proj_test", run.id);
      expect(completedRun?.items[0]).toMatchObject({
        failingStep: 1,
        stepAgreement: true,
        agreement: true,
        latencyMs: 42
      });

      // fail without step keeps it.
      items = await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId, expectedLabel: "fail" }]
      });
      expect(items[0]).toMatchObject({ expectedLabel: "fail", expectedFailStep: 1 });

      // Label-less append keeps both.
      items = await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId }]
      });
      expect(items[0]).toMatchObject({ expectedLabel: "fail", expectedFailStep: 1 });

      // Re-label to pass clears the step.
      items = await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId, expectedLabel: "pass" }]
      });
      expect(items[0]).toMatchObject({ expectedLabel: "pass", expectedFailStep: null });
    } finally {
      await cleanup();
    }
  });

  it("M2 T4: case-detail dataset expectations are project-scoped and exclude archived datasets", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_other', 'org_test', 'Other Project', 'manual')`);
      await seedSkill(pool);

      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "t4_case",
        input: { q: "hi" },
        output: { answer: "This is incorrect." },
        metadata: {},
        steps: [{ name: "s0", input: 0, output: 0 }, { name: "s1", input: 1, output: 1 }]
      }, { ingestionPurpose: "analysis_eligible_manual" });
      const visible = await repo.createDataset({ projectId: "proj_test", name: "Visible set" });
      await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: visible.id,
        items: [{ caseId: imported.caseId, expectedLabel: "fail", expectedFailStep: 1 }]
      });
      const archived = await repo.createDataset({ projectId: "proj_test", name: "Archived set" });
      await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: archived.id,
        items: [{ caseId: imported.caseId, expectedLabel: "fail" }]
      });
      await pool.query(`update datasets set archived_at = now() where id = $1`, [archived.id]);
      // Same-named dataset in ANOTHER project must never surface here.
      const foreign = await repo.createDataset({ projectId: "proj_other", name: "Foreign set" });
      await pool.query(
        `insert into dataset_items (id, dataset_id, project_id, case_id, trace_id, expected_label)
         values ('dsi_foreign', $1, 'proj_other', $2, 't4_case', 'pass')`,
        [foreign.id, imported.caseId]
      );

      // A judge run is required for case detail.
      await pool.query(
        `insert into judge_runs (id, project_id, case_id, skill_version_id, verdict, score, reasoning)
         values ('jr_t4', 'proj_test', $1, 'skillv_test', 'fail', 0.2, 'r')`,
        [imported.caseId]
      );

      const detail = await repo.getCaseDetail("proj_test", imported.caseId);
      expect(detail?.datasetExpectations).toEqual([
        { datasetName: "Visible set", expectedLabel: "fail", expectedFailStep: 1 }
      ]);
    } finally {
      await cleanup();
    }
  });

  it("M3 S1: judge keys encrypt at rest — raw key absent from the row, decrypts only via the worker loader (migration 0031)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);

      const RAW = "test-anthropic-secret-raw-key-abcdef123456";
      const saved = await repo.setJudgeProviderKey("proj_test", "anthropic", RAW, undefined);
      expect(saved.keyDisplay).toBe("test-anthr…3456");

      // At rest: the row never contains the raw key; the ciphertext is GCM-prefixed.
      const row = await pool.query(`select encrypted_credentials, key_display from judge_provider_keys where project_id = 'proj_test'`);
      expect(String(row.rows[0].encrypted_credentials)).not.toContain(RAW);
      expect(String(row.rows[0].encrypted_credentials)).toMatch(/^aes-256-gcm:v1:/);

      // Masked list never exposes it; the worker loader decrypts it.
      const listed = await repo.listJudgeProviderKeys("proj_test");
      expect(JSON.stringify(listed)).not.toContain(RAW);
      expect(await repo.getJudgeProviderCredential("proj_test", "anthropic")).toBe(RAW);

      // Migration 0035 widens the encrypted key slots for the two new picker
      // paths without weakening the provider constraint to arbitrary strings.
      await repo.setJudgeProviderKey("proj_test", "openrouter", "openrouter-secret-key-12345678", undefined);
      await repo.setJudgeProviderKey("proj_test", "custom", "custom-compatible-key-12345678", undefined);
      expect(await repo.getJudgeProviderCredential("proj_test", "openrouter")).toBe("openrouter-secret-key-12345678");
      expect(await repo.getJudgeProviderCredential("proj_test", "custom")).toBe("custom-compatible-key-12345678");

      // Replace overwrites; delete removes; foreign project sees nothing.
      await repo.setJudgeProviderKey("proj_test", "anthropic", "test-anthropic-replacement-key-999999", undefined);
      expect(await repo.getJudgeProviderCredential("proj_test", "anthropic")).toBe("test-anthropic-replacement-key-999999");
      expect(await repo.getJudgeProviderCredential("proj_other", "anthropic")).toBeNull();
      expect(await repo.deleteJudgeProviderKey("proj_test", "anthropic", undefined)).toBe(true);
      expect(await repo.getJudgeProviderCredential("proj_test", "anthropic")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("round-trips datasets and items (migration 0024)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      const imported = await repo.importTrace("proj_test", "manual", {
        sourceTraceId: "ds_trace_1",
        input: { q: "hello" },
        output: { a: "world" },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });

      const dataset = await repo.createDataset({ projectId: "proj_test", name: "Smoke" });
      await expect(repo.createDataset({ projectId: "proj_test", name: "Smoke" })).rejects.toThrow(/already exists/);

      const items = await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId, expectedLabel: "pass", note: "smoke item" }]
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.traceId).toBe("ds_trace_1");

      // Idempotent re-add; unknown case rejects before inserting anything.
      expect(await repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId }]
      })).toHaveLength(1);
      await expect(repo.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: "case_missing" }]
      })).rejects.toThrow(/Case not found/);

      const detail = await repo.getDatasetDetail("proj_test", dataset.id);
      expect(detail?.itemCount).toBe(1);
      expect(detail?.items[0]?.expectedLabel).toBe("pass");

      expect(await repo.archiveDataset("proj_test", dataset.id)).toBe(true);
      expect(await repo.archiveDataset("proj_test", dataset.id)).toBe(false);
      expect(await repo.listDatasets("proj_test")).toHaveLength(0);
      // The partial unique index frees the name once archived.
      await expect(repo.createDataset({ projectId: "proj_test", name: "Smoke" })).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("Skill Bench: mode roundtrip + integration graduation flip (migration 0029)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      // Insert WITHOUT mode: the migration default must be 'tracing'.
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      expect((await repo.getProjectSettings("proj_test")).mode).toBe("tracing");

      // Settings roundtrip flips to bench (and retention passes through).
      const updated = await repo.updateProjectSettings("proj_test", { traceRetentionDays: null, mode: "bench" }, {});
      expect(updated.mode).toBe("bench");
      expect((await repo.getProjectSettings("proj_test")).mode).toBe("bench");
      expect((await repo.listProjects())[0]?.mode).toBe("bench");

      // Connecting a tracer graduates bench -> tracing (additive, no data loss).
      await repo.createLangSmithIntegration("proj_test", { apiKey: "ls_test_key", projectName: "Support Agent" });
      expect((await repo.getProjectSettings("proj_test")).mode).toBe("tracing");

      // Mode omitted on later settings writes stays put (coalesce, not reset).
      const untouched = await repo.updateProjectSettings("proj_test", { traceRetentionDays: 30 }, {});
      expect(untouched.mode).toBe("tracing");
      expect(untouched.traceRetentionDays).toBe(30);
    } finally {
      await cleanup();
    }
  });

  it("Skill Bench: atomic examples ingestion — content-hash dedup + coalescing upsert (M0 C2/C3)", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_smoke");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider, mode) values ('proj_test', 'org_test', 'Bench Project', 'manual', 'bench')`);
      const dataset = await repo.createDataset({ projectId: "proj_test", name: "Bench examples" });

      // First import mints the case with its label.
      const first = await repo.importDatasetExamples({
        ingestionPurpose: "dataset_example",
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ sourceTraceId: "ex_hash_q1", input: "q1", output: "a1", metadata: {}, expectedLabel: "pass" }]
      });
      expect(first.items[0]?.created).toBe(true);
      expect(first.items[0]?.datasetItemId).not.toBeNull();

      // Identical content (same hash id) reuses the case; the labeled re-import
      // UPDATES the stored label (coalescing upsert).
      const relabeled = await repo.importDatasetExamples({
        ingestionPurpose: "dataset_example",
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ sourceTraceId: "ex_hash_q1", input: "q1", output: "a1", metadata: {}, expectedLabel: "fail" }]
      });
      expect(relabeled.items[0]?.created).toBe(false);
      expect(relabeled.items[0]?.caseId).toBe(first.items[0]?.caseId);
      let detail = await repo.getDatasetDetail("proj_test", dataset.id);
      expect(detail?.items).toHaveLength(1);
      expect(detail?.items[0]?.expectedLabel).toBe("fail");

      // A label-less re-add must NOT null the stored label.
      await repo.importDatasetExamples({
        ingestionPurpose: "dataset_example",
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ sourceTraceId: "ex_hash_q1", input: "q1", output: "a1", metadata: {} }]
      });
      detail = await repo.getDatasetDetail("proj_test", dataset.id);
      expect(detail?.items[0]?.expectedLabel).toBe("fail");

      // Edited content (new hash id) mints a FRESH case — the stale-payload
      // dedup trap must not resurrect the old content.
      const edited = await repo.importDatasetExamples({
        ingestionPurpose: "dataset_example",
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ sourceTraceId: "ex_hash_q1_edited", input: "q1", output: "a1 — corrected", metadata: {}, expectedLabel: "pass" }]
      });
      expect(edited.items[0]?.created).toBe(true);
      expect(edited.items[0]?.caseId).not.toBe(first.items[0]?.caseId);
      detail = await repo.getDatasetDetail("proj_test", dataset.id);
      expect(detail?.items).toHaveLength(2);

      // Atomicity: a missing dataset aborts BEFORE minting any case.
      await expect(repo.importDatasetExamples({
        ingestionPurpose: "dataset_example",
        projectId: "proj_test",
        datasetId: "ds_missing",
        items: [{ sourceTraceId: "ex_orphan", input: "qX", output: "aX", metadata: {} }]
      })).rejects.toThrow(/Dataset not found/);
      const orphan = await pool.query(`select count(*)::int as count from raw_traces where source_trace_id = 'ex_orphan'`);
      expect(orphan.rows[0]?.count).toBe(0);
    } finally {
      await cleanup();
    }
  });

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

  // 20s timeout: ~10 round-trips; the default 5s flakes when PG_SMOKE points
  // at a remote database instead of the local PG this suite assumes.
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
        remoteProjectId: "remote_a"
      });
    } finally {
      await cleanup();
    }
  });

  it("reconciles the first native snapshot with a content-identical legacy Ironside case", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_ironside_legacy_cutover");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await pool.query(
        `insert into integrations (id, project_id, provider, encrypted_credentials, config)
         values ('int_legacy', 'proj_test', 'ironside', 'unused', '{}')`
      );
      const input = {
        sourceTraceId: "legacy_trace",
        input: { question: "Refund?" },
        output: { answer: "Within 30 days." },
        metadata: { source: "ironside" }
      };
      await pool.query(
        `insert into raw_traces
           (id, project_id, source_integration_id, source_trace_id, raw_payload, normalization_version)
         values ('raw_legacy', 'proj_test', 'int_legacy', 'legacy_trace', $1::jsonb, 'ironside-v1')`,
        [JSON.stringify({ input: input.input, output: input.output, metadata: input.metadata })]
      );
      await pool.query(
        `insert into cases
           (id, project_id, raw_trace_id, case_type, normalized_payload, ingestion_purpose)
         values ('case_legacy', 'proj_test', 'raw_legacy', 'ironside', $1::jsonb, 'analysis_eligible_ironside')`,
        [JSON.stringify({ input: input.input, output: input.output, metadata: input.metadata })]
      );

      const firstNative = await repo.importTrace("proj_test", "ironside", input, {
        ingestionPurpose: "analysis_eligible_ironside",
        sourceIntegrationId: "int_legacy",
        sourceRemoteProjectId: "remote_project",
        sourceTraceVersion: "2026-08-30T12:00:00.000001Z"
      });
      expect(firstNative).toMatchObject({ created: false, caseId: "case_legacy" });
      expect((await pool.query(
        `select source_trace_version, source_trace_cutover_version, source_trace_cutover_matched
           from raw_traces where id = 'raw_legacy'`
      )).rows).toEqual([{
        source_trace_version: null,
        source_trace_cutover_version: "2026-08-30T12:00:00.000001Z",
        source_trace_cutover_matched: true
      }]);

      const reopened = await repo.importTrace("proj_test", "ironside", {
        ...input,
        output: { answer: "Within 14 days." }
      }, {
        ingestionPurpose: "analysis_eligible_ironside",
        sourceIntegrationId: "int_legacy",
        sourceRemoteProjectId: "remote_project",
        sourceTraceVersion: "2026-08-30T12:05:00.000002Z"
      });
      expect(reopened.created).toBe(true);

      await pool.query(
        `insert into raw_traces
           (id, project_id, source_integration_id, source_trace_id, raw_payload, normalization_version)
         values ('raw_legacy_changed', 'proj_test', 'int_legacy', 'legacy_trace_changed', $1::jsonb, 'ironside-v1')`,
        [JSON.stringify({ input: input.input, output: input.output, metadata: input.metadata })]
      );
      await pool.query(
        `insert into cases
           (id, project_id, raw_trace_id, case_type, normalized_payload, ingestion_purpose)
         values ('case_legacy_changed', 'proj_test', 'raw_legacy_changed', 'ironside', $1::jsonb, 'analysis_eligible_ironside')`,
        [JSON.stringify({ input: input.input, output: input.output, metadata: input.metadata })]
      );
      const changedInput = {
        ...input,
        sourceTraceId: "legacy_trace_changed",
        output: { answer: "The currently retained snapshot changed." }
      };
      const changedContext = {
        ingestionPurpose: "analysis_eligible_ironside" as const,
        sourceIntegrationId: "int_legacy",
        sourceRemoteProjectId: "remote_project",
        sourceTraceVersion: "2026-08-30T12:10:00.000003Z"
      };
      const changed = await repo.importTrace(
        "proj_test",
        "ironside",
        changedInput,
        changedContext
      );
      expect(changed).toMatchObject({ created: true });
      expect(changed.caseId).not.toBe("case_legacy_changed");
      expect((await pool.query(
        `select source_trace_cutover_version, source_trace_cutover_matched
           from raw_traces where id = 'raw_legacy_changed'`
      )).rows).toEqual([{
        source_trace_cutover_version: changedContext.sourceTraceVersion,
        source_trace_cutover_matched: false
      }]);
      await expect(repo.importTrace("proj_test", "ironside", changedInput, changedContext))
        .resolves.toMatchObject({ created: false, caseId: changed.caseId });
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

class CapturingQueue implements Queue {
  readonly jobs: Array<{ name: QueueName; data: object; options?: object | undefined }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_name: QueueName, _handler: (job: { id: string; data: T }) => Promise<void>): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    this.jobs.push({ name, data, options });
    return `job_${this.jobs.length}`;
  }
}

class FailingOnceQueue extends CapturingQueue {
  private failed = false;

  override async send<T extends object>(name: QueueName, data: T, options?: object): Promise<string> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Queue unavailable after trace import");
    }
    return super.send(name, data, options);
  }
}

async function seedSkill(pool: Pool): Promise<void> {
  await seedCriterion(pool);
  await pool.query(`insert into skills (id, project_id, name, description, status, criterion_id) values ('skill_test', 'proj_test', 'Test Skill', 'Smoke skill', 'draft', 'criterion_test')`);
  await pool.query(
    `insert into skill_versions
     (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
      criterion_version_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      "skillv_test",
      "skill_test",
      "proj_test",
      "0.1.0",
      "draft",
      "Pass correct answers; fail incorrect answers.",
      "Judge the trace.",
      JSON.stringify(MinimumVerdictOutputSchema),
      JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 }),
      "criterionv_test"
    ]
  );
}

async function seedCriterion(pool: Pool, suffix = "test"): Promise<void> {
  const criterionId = `criterion_${suffix}`;
  const criterionVersionId = `criterionv_${suffix}`;
  const stableKey = `criterion-${suffix}`;
  await pool.query(
    `insert into criteria (id,project_id,stable_key,source_kind)
     values ($1,'proj_test',$2,'native')`,
    [criterionId, stableKey]
  );
  await pool.query(
    `insert into criterion_versions
       (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
     values ($1,'proj_test',$2,1,$3,$4,criterion_v1_digest($2,$1,$3,$4),'native')`,
    [criterionVersionId, criterionId, `Criterion ${suffix}`, `Criterion ${suffix} definition.`]
  );
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("waitFor timeout");
}
