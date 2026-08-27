import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { CreateSkillVersionInputSchema, MinimumVerdictOutputSchema } from "@coeval/shared";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { DatasetRevisionConflictError, SealedValidationUnavailableError } from "../src/repository.js";
import { PgRepository } from "../src/repository.pg.js";
import { REDACTED_VALUE } from "../src/lib/redaction.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; dataset revision Postgres tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

run("dataset revision PostgreSQL invariants", () => {
  it("pins immutable evidence, serializes idempotent freezes, and rejects role/binding drift", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("dataset_revision");
    try {
      await runMigrations(pool);
      const repository = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await pool.query(`insert into criteria (id,project_id,stable_key,source_kind) values ('criterion_test','proj_test','correctness','native')`);
      await pool.query(`
        insert into criterion_versions
          (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
        values ('criterionv_test','proj_test','criterion_test',1,'Correctness','The answer is correct.',
                criterion_v1_digest('criterion_test','criterionv_test','Correctness','The answer is correct.'),'native')
      `);
      await pool.query(`insert into skills (id, project_id, name, description, owner_user_id, status, criterion_id) values ('skill_test', 'proj_test', 'Judge', 'revision fixture', null, 'production', 'criterion_test')`);
      await pool.query(
        `insert into skill_versions
         (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
          golden_set_agreement, too_strict_count, too_lenient_count, ambiguous_count, known_limitations,
          verdict_kind, scalar_range, categorical_choice_scores, rubric_provenance, criterion_version_id,
          created_at, approved_at)
         values ('skillv_base','skill_test','proj_test','1.0.0','approved','# Rubric','Judge.', $1, $2,
                 null,0,0,0,'{}','binary',null,null,'human-authored','criterionv_test',now(),now())`,
        [
          JSON.stringify(MinimumVerdictOutputSchema),
          JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 })
        ]
      );

      const dataset = await repository.createDataset({ projectId: "proj_test", name: "Working examples" });
      const rawInput = { question: "Refund?", api_key: "pre-redaction-secret" };
      const imported = await repository.importTrace("proj_test", "manual", {
        sourceTraceId: "revision-source",
        input: rawInput,
        output: { answer: "Within thirty days." },
        metadata: { token: "metadata-secret" }
      }, {
        ingestionPurpose: "analysis_eligible_manual",
        redactionConfig: {}
      });
      await repository.addDatasetItems({
        projectId: "proj_test",
        datasetId: dataset.id,
        items: [{ caseId: imported.caseId, expectedLabel: "pass", note: "human expectation" }]
      });

      const first = await repository.createDatasetRevision({
        projectId: "proj_test",
        datasetId: dataset.id,
        role: "analysis_authoring",
        idempotencyKey: "freeze-once"
      });
      expect(first).toMatchObject({
        role: "analysis_authoring",
        revisionNumber: 1,
        itemCount: 1,
        exposureState: "visible_by_design"
      });
      expect(first.items[0]?.payloadSnapshot.input).toEqual({ question: "Refund?", api_key: REDACTED_VALUE });
      expect(first.items[0]?.payloadSnapshot.metadata).toEqual({ token: REDACTED_VALUE });
      expect(first.items[0]?.inputDigest).toBe(datasetInputIdentity({ input: rawInput }).digest);
      expect(first.items[0]?.referenceProvenance.kind).toBe("dataset_claim");

      const historical = await repository.importTrace("proj_test", "manual", {
        sourceTraceId: "historical-payload-shape",
        input: { question: "Old row?" },
        output: { answer: "Still judgeable." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(`update cases set normalized_payload = normalized_payload - 'metadata' where id = $1`, [historical.caseId]);
      const historicalDataset = await repository.createDataset({ projectId: "proj_test", name: "Historical shape" });
      await repository.addDatasetItems({
        projectId: "proj_test",
        datasetId: historicalDataset.id,
        items: [{ caseId: historical.caseId, expectedLabel: "pass" }]
      });
      const historicalRevision = await repository.createDatasetRevision({
        projectId: "proj_test",
        datasetId: historicalDataset.id,
        role: "analysis_authoring"
      });
      expect(historicalRevision.items[0]?.payloadSnapshot.metadata).toEqual({});

      const [retryA, retryB] = await Promise.all([
        repository.createDatasetRevision({
          projectId: "proj_test",
          datasetId: dataset.id,
          role: "iterative_development",
          idempotencyKey: "concurrent-freeze"
        }),
        repository.createDatasetRevision({
          projectId: "proj_test",
          datasetId: dataset.id,
          role: "iterative_development",
          idempotencyKey: "concurrent-freeze"
        })
      ]);
      expect(retryA.id).toBe(retryB.id);
      expect(retryA).toMatchObject({ parentRevisionId: first.id, revisionNumber: 2 });
      await expect(repository.createDatasetRevision({
        projectId: "proj_test",
        datasetId: dataset.id,
        role: "analysis_authoring",
        idempotencyKey: "concurrent-freeze"
      })).rejects.toBeInstanceOf(DatasetRevisionConflictError);

      await expect(pool.query(
        `update dataset_revisions set item_count = 99 where id = $1`,
        [first.id]
      )).rejects.toMatchObject({ code: "55000" });
      await expect(pool.query(
        `update cases set normalized_payload = '{"input":{},"output":{},"metadata":{}}'
         where id = $1`,
        [imported.caseId]
      )).rejects.toMatchObject({ code: "55000" });
      await expect(repository.createDatasetRevision({
        projectId: "proj_test",
        datasetId: dataset.id,
        role: "sealed_validation"
      })).rejects.toBeInstanceOf(SealedValidationUnavailableError);
      await expect(repository.createDatasetRevision({
        projectId: "proj_test",
        datasetId: dataset.id,
        role: "regression_golden"
      })).rejects.toBeInstanceOf(DatasetRevisionConflictError);
      await expect(pool.query(
        `insert into dataset_revisions
         (id, project_id, series_id, revision_number, source_dataset_id, role, source_kind,
          identity_basis, content_digest, revision_digest, item_count, provenance_level)
         values ('dsr_laundered_regression','proj_test','dataset:laundered',1,$1,'regression_golden',
                 'collection_snapshot','input-identity/v1',$2,$3,0,'unverified')`,
        [dataset.id, `sha256:${"6".repeat(64)}`, `sha256:${"7".repeat(64)}`]
      )).rejects.toMatchObject({ code: "23514" });

      await expect(pool.query(
        `insert into dataset_revision_items
         (id, revision_id, project_id, position, source_case_id, source_trace_id,
          source_dataset_item_id, input_digest, item_digest, payload_snapshot, reference_provenance)
         values ('dsri_payload_mismatch',$1,'proj_test',99,$2,'revision-source',null,$3,$4,
                 '{"input":{"tampered":true},"output":{},"metadata":{}}',
                 '{"kind":"unlabeled","sourceId":null,"verdictIds":[],"actorUserIds":[],"basis":"tampered"}')`,
        [first.id, imported.caseId, first.items[0]!.inputDigest, `sha256:${"8".repeat(64)}`]
      )).rejects.toMatchObject({ code: "23514" });

      const evalRun = await repository.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_base",
        trigger: "manual",
        datasetRevisionId: first.id,
        items: [{
          caseId: imported.caseId,
          datasetRevisionItemId: first.items[0]!.id,
          expectedLabel: "pass",
          status: "completed",
          resultLabel: "pass"
        }]
      });
      expect(evalRun.datasetRevisionId).toBe(first.id);
      expect(evalRun.items[0]?.datasetRevisionItemId).toBe(first.items[0]?.id);
      await expect(repository.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_base",
        trigger: "manual",
        datasetRevisionId: first.id,
        items: [{ caseId: "case_wrong", datasetRevisionItemId: first.items[0]!.id }]
      })).rejects.toMatchObject({ code: "23514" });
      expect((await repository.getDatasetRevisionDetail("proj_test", first.id))?.exposures)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "development_use", evidenceRefId: evalRun.id })
        ]));
      const evalRunB = await repository.createEvalRun({
        projectId: "proj_test",
        skillVersionId: "skillv_base",
        trigger: "manual",
        datasetRevisionId: first.id,
        items: [{
          caseId: imported.caseId,
          datasetRevisionItemId: first.items[0]!.id,
          expectedLabel: "pass",
          status: "completed",
          resultLabel: "pass"
        }]
      });
      const comparison = await repository.createRunComparison({
        projectId: "proj_test",
        datasetId: dataset.id,
        datasetRevisionId: first.id,
        versionAId: "skillv_base",
        versionBId: "skillv_base",
        runAId: evalRun.id,
        runBId: evalRunB.id
      });
      expect(comparison.datasetRevisionId).toBe(first.id);
      await expect(repository.createRunComparison({
        projectId: "proj_test",
        datasetId: dataset.id,
        datasetRevisionId: retryA.id,
        versionAId: "skillv_base",
        versionBId: "skillv_base",
        runAId: evalRun.id,
        runBId: evalRunB.id
      })).rejects.toMatchObject({ code: "23514" });

      await pool.query(`update raw_traces set created_at = '2020-01-01T00:00:00Z' where id = $1`, [imported.rawTraceId]);
      await repository.updateProjectSettings("proj_test", { traceRetentionDays: 1 }, {});
      expect(await repository.pruneExpiredTraces("proj_test", { now: new Date("2026-08-22T00:00:00Z") }))
        .toMatchObject({ deletedCases: 0, deletedRawTraces: 0, skippedImmutableRevisionCases: 1 });
      expect((await pool.query(`select count(*)::int as count from cases where id = $1`, [imported.caseId])).rows[0]?.count)
        .toBe(1);

      await expect(pool.query(
        `insert into dataset_revisions
         (id, project_id, series_id, revision_number, source_dataset_id, parent_revision_id,
          role, source_kind, identity_basis, content_digest, revision_digest, item_count, provenance_level)
         values ('dsr_bad_sealed','proj_test','sealed:test',1,$1,null,'sealed_validation','sealed_intake',
                 'input-identity/v1',$2,$3,0,'governed_blind')`,
        [dataset.id, `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]
      )).rejects.toMatchObject({ code: "23514" });

      await pool.query(
        `insert into dataset_revisions
         (id, project_id, series_id, revision_number, role, source_kind, identity_basis,
          content_digest, revision_digest, item_count, provenance_level)
         values ('dsr_sealed','proj_test','sealed:test',1,'sealed_validation','sealed_intake',
                 'input-identity/v1',$1,$2,1,'governed_blind')`,
        [`sha256:${"3".repeat(64)}`, `sha256:${"4".repeat(64)}`]
      );
      await expect(pool.query(
        `insert into dataset_revision_items
         (id, revision_id, project_id, position, input_digest, item_digest, payload_snapshot, reference_provenance)
         values ('dsri_sealed','dsr_sealed','proj_test',0,$1,$2,'{"input":{},"output":{},"metadata":{}}','{"kind":"unlabeled","sourceId":null,"verdictIds":[],"actorUserIds":[],"basis":"blind"}')`,
        [first.items[0]!.inputDigest, `sha256:${"5".repeat(64)}`]
      )).rejects.toMatchObject({ code: "23514" });

      const golden = await repository.importTrace("proj_test", "manual", {
        sourceTraceId: "golden-source",
        input: { question: "Known good?" },
        output: { answer: "Yes." },
        metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      await pool.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id,
          criterion_version_id)
         values ('gold_test','proj_test',$1,'golden-source','pass','known good','Reviewer','skillv_base',
                 'criterionv_test')`,
        [golden.caseId]
      );
      const pending = await repository.createSkillVersionPending(
        "skill_test",
        CreateSkillVersionInputSchema.parse({
          rubricMarkdown: "# Revised rubric",
          prompt: "Judge this answer.",
          modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
        }),
        { projectId: "proj_test" }
      );
      expect(pending.regressionDatasetRevisionId).toBeTruthy();
      await repository.retireGoldenSetEntry({ projectId: "proj_test", entryId: "gold_test", reason: "fixture mutation" });
      const pointer = await repository.getOrCreateRegressionDatasetRevision("proj_test");
      expect(pointer.id).not.toBe(pending.regressionDatasetRevisionId);
      expect(pointer.itemCount).toBe(0);

      const { regressionRun } = await repository.runRegressionGateForVersion({
        projectId: "proj_test",
        skillVersionId: pending.id,
        datasetRevisionId: pending.regressionDatasetRevisionId!,
        timeScope: "new"
      });
      expect(regressionRun.datasetRevisionId).toBe(pending.regressionDatasetRevisionId);
      expect(regressionRun.compared).toBe(1);
      expect(regressionRun.goldenSetMissing).toBe(false);
      expect((await repository.getDatasetRevisionDetail("proj_test", pending.regressionDatasetRevisionId!))?.exposures)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "evaluator_execution", evidenceRefId: regressionRun.id })
        ]));

      await pool.query(`insert into organizations (id, name) values ('org_other', 'Other Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_other', 'org_other', 'Other', 'manual')`);
      await pool.query(`insert into criteria (id,project_id,stable_key,source_kind) values ('criterion_other','proj_other','correctness','native')`);
      await pool.query(`
        insert into criterion_versions
          (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
        values ('criterionv_other','proj_other','criterion_other',1,'Correctness','The answer is correct.',
                criterion_v1_digest('criterion_other','criterionv_other','Correctness','The answer is correct.'),'native')
      `);
      await pool.query(`insert into skills (id, project_id, name, description, owner_user_id, status, criterion_id) values ('skill_other', 'proj_other', 'Other Judge', 'fixture', null, 'draft', 'criterion_other')`);
      await expect(pool.query(
        `insert into skill_versions
         (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
          golden_set_agreement, too_strict_count, too_lenient_count, ambiguous_count, known_limitations,
          verdict_kind, scalar_range, categorical_choice_scores, rubric_provenance, regression_dataset_revision_id,
          criterion_version_id, created_at)
         values ('skillv_other','skill_other','proj_other','1.0.0','calibrating','# R','Judge.', $1,$2,
                 null,0,0,0,'{}','binary',null,null,'human-authored',$3,'criterionv_other',now())`,
        [
          JSON.stringify(MinimumVerdictOutputSchema),
          JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }),
          pending.regressionDatasetRevisionId
        ]
      )).rejects.toMatchObject({ code: "23514" });

      await repository.deleteProject("proj_test", { confirmProjectName: "Test Project" });
      expect((await pool.query(`select count(*)::int as count from dataset_revisions where project_id = 'proj_test'`)).rows[0]?.count)
        .toBe(0);
    } finally {
      await cleanup();
    }
  });
});
