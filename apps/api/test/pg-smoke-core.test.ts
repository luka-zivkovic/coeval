import { expect, it } from "vitest";

import { runMigrations } from "@coeval/db";
import { type Queue } from "@coeval/queue";

import { PgRepository } from "../src/repository.pg.js";

import { dispatchEvalRunOnce } from "../src/workers/gate.js";

import { buildAssessmentReceipt, contentDigest, evidenceDigestForReceipt } from "../src/lib/assessment-receipt.js";

import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("PgRepository smoke", () => {
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
});
