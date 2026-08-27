import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "@coeval/db";
import { AssessmentReceiptSchema, MinimumVerdictOutputSchema, type AssessmentReceipt } from "@coeval/shared";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import {
  canonicalJson,
  contentDigest,
  evidenceDigestForReceipt,
  receiptArtifactDigest
} from "../src/lib/assessment-receipt.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; immutable receipt tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

async function withDatabase(test: (pool: Pool, repo: PgRepository) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await openPostgresTestDatabase("receipt_artifact");
  try {
    await runMigrations(pool);
    await runMigrations(pool);
    await pool.query(`insert into organizations (id, name) values ('org_receipt', 'Receipt Org')`);
    await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_receipt', 'org_receipt', 'Receipt Project', 'manual')`);
    await pool.query(`insert into criteria (id,project_id,stable_key,source_kind) values ('criterion_receipt','proj_receipt','receipt-correctness','native')`);
    await pool.query(`
      insert into criterion_versions
        (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
      values ('criterionv_receipt','proj_receipt','criterion_receipt',1,'Receipt correctness',
              'The assessed response is correct.',
              criterion_v1_digest('criterion_receipt','criterionv_receipt','Receipt correctness',
                                  'The assessed response is correct.'),'native')
    `);
    await pool.query(`insert into skills (id, project_id, name, description, status, criterion_id) values ('skill_receipt', 'proj_receipt', 'Receipt Skill', 'Receipt tests', 'draft', 'criterion_receipt')`);
    await pool.query(
      `insert into skill_versions
       (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
        criterion_version_id)
       values ('skillv_receipt','skill_receipt','proj_receipt','1.0.0','draft',$1,$2,$3,$4,
               'criterionv_receipt')`,
      [
        "Pass correct answers; fail incorrect answers.",
        "Judge the trace.",
        JSON.stringify(MinimumVerdictOutputSchema),
        JSON.stringify({ provider: "mock", modelId: "mock", modelVersion: "receipt-test", temperature: 0 })
      ]
    );
    await test(pool, new PgRepository(pool));
  } finally {
    await cleanup();
  }
}

async function releaseCase(repo: PgRepository, suffix: string) {
  return repo.importTrace("proj_receipt", "release_evidence", {
    sourceTraceId: `release-${suffix}`,
    input: { question: suffix },
    output: { answer: "Yes." },
    metadata: {}
  }, { ingestionPurpose: "release_evidence" });
}

async function verdict(pool: Pool, caseId: string, id: string): Promise<void> {
  await pool.query(
    `insert into verdicts (id, project_id, case_id, skill_version_id, source, verdict_kind, payload)
     values ($1,'proj_receipt',$2,'skillv_receipt','llm_judge','binary','{"kind":"binary","pass":true,"rationale":"ok"}')`,
    [id, caseId]
  );
}

run("immutable assessment receipt PostgreSQL storage", () => {
  it("atomically mints one root under concurrent terminalization and survives source mutation", async () => {
    await withDatabase(async (pool, repo) => {
      const imported = await releaseCase(repo, "concurrent");
      const digest = contentDigest({ question: "concurrent" }, { answer: "Yes." });
      const created = await repo.createEvalRun({
        projectId: "proj_receipt",
        skillVersionId: "skillv_receipt",
        trigger: "release_evidence",
        items: [
          { caseId: imported.caseId, clientItemId: "a", contentDigest: digest },
          { caseId: imported.caseId, clientItemId: "b", contentDigest: digest }
        ]
      });
      await repo.markEvalRunRunning("proj_receipt", created.id);
      await verdict(pool, imported.caseId, "verdict_concurrent_a");
      await verdict(pool, imported.caseId, "verdict_concurrent_b");

      await Promise.all(created.items.map((item, index) => repo.completeEvalRunItem({
        projectId: "proj_receipt",
        evalRunId: created.id,
        evalRunItemId: item.id,
        verdictId: `verdict_concurrent_${index === 0 ? "a" : "b"}`,
        resultLabel: "pass",
        providerMetadata: {
          model: "observed-model",
          requestId: `request-${index}`,
          responseId: `response-${index}`,
          systemFingerprint: null
        }
      })));

      const artifacts = await repo.listAssessmentReceiptArtifacts("proj_receipt", created.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ artifactRevision: 1, sourceKind: "terminal_mint" });
      const originalBytes = Buffer.from(artifacts[0]!.canonicalBytes);

      await pool.query(
        `update eval_run_items set result_label = 'fail', provider_metadata = '{"model":"tampered"}'::jsonb
         where eval_run_id = $1`,
        [created.id]
      );
      await pool.query(
        `update eval_runs set trigger = 'api_batch', status = 'running', agreed_items = 99 where id = $1`,
        [created.id]
      );
      const reread = await repo.getOrFreezeAssessmentReceipt("proj_receipt", created.id);
      expect(reread?.canonicalBytes.equals(originalBytes)).toBe(true);

      await expect(pool.query(
        `update assessment_receipt_artifacts set canonical_bytes = '\\x00' where id = $1`,
        [artifacts[0]!.id]
      )).rejects.toMatchObject({ code: "55000" });
      await expect(pool.query(
        `delete from assessment_receipt_artifacts where id = $1`,
        [artifacts[0]!.id]
      )).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("rolls terminalization back when artifact minting fails", async () => {
    await withDatabase(async (pool, repo) => {
      const imported = await releaseCase(repo, "atomic-failure");
      const created = await repo.createEvalRun({
        projectId: "proj_receipt",
        skillVersionId: "skillv_receipt",
        trigger: "release_evidence",
        items: [{
          caseId: imported.caseId,
          clientItemId: "atomic",
          contentDigest: contentDigest({ question: "atomic-failure" }, { answer: "Yes." })
        }]
      });
      await repo.markEvalRunRunning("proj_receipt", created.id);
      await verdict(pool, imported.caseId, "verdict_atomic_failure");
      await pool.query(`
        create function reject_receipt_insert() returns trigger language plpgsql as $$
        begin raise exception 'injected receipt failure'; end $$;
        create trigger reject_receipt_insert before insert on assessment_receipt_artifacts
        for each row execute function reject_receipt_insert();
      `);

      await expect(repo.completeEvalRunItem({
        projectId: "proj_receipt",
        evalRunId: created.id,
        evalRunItemId: created.items[0]!.id,
        verdictId: "verdict_atomic_failure",
        resultLabel: "pass"
      })).rejects.toThrow(/injected receipt failure/);
      expect(await repo.getEvalRunDetail("proj_receipt", created.id)).toMatchObject({
        status: "running",
        completedItems: 0,
        items: [expect.objectContaining({ status: "pending" })]
      });
      expect(await repo.listAssessmentReceiptArtifacts("proj_receipt", created.id)).toEqual([]);

      await pool.query(`drop trigger reject_receipt_insert on assessment_receipt_artifacts`);
      await repo.completeEvalRunItem({
        projectId: "proj_receipt",
        evalRunId: created.id,
        evalRunItemId: created.items[0]!.id,
        verdictId: "verdict_atomic_failure",
        resultLabel: "pass"
      });
      expect(await repo.listAssessmentReceiptArtifacts("proj_receipt", created.id)).toHaveLength(1);
    });
  });

  it("mints incomplete evidence in the same transaction as the final failed item", async () => {
    await withDatabase(async (_pool, repo) => {
      const imported = await releaseCase(repo, "terminal-failure");
      const created = await repo.createEvalRun({
        projectId: "proj_receipt",
        skillVersionId: "skillv_receipt",
        trigger: "release_evidence",
        items: [{
          caseId: imported.caseId,
          clientItemId: "terminal-failure",
          contentDigest: contentDigest({ question: "terminal-failure" }, { answer: "Yes." })
        }]
      });
      await repo.markEvalRunRunning("proj_receipt", created.id);
      await repo.failEvalRunItem({
        projectId: "proj_receipt",
        evalRunId: created.id,
        evalRunItemId: created.items[0]!.id,
        error: "provider exhausted retries"
      });

      const artifacts = await repo.listAssessmentReceiptArtifacts("proj_receipt", created.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ sourceKind: "terminal_mint", artifactRevision: 1 });
      const receipt = AssessmentReceiptSchema.parse(JSON.parse(artifacts[0]!.canonicalBytes.toString("utf8")));
      expect(receipt).toMatchObject({
        status: "incomplete",
        run: { status: "failed", completedItems: 0, failedItems: 1 },
        items: [expect.objectContaining({ status: "failed", error: "provider exhausted retries" })]
      });
    });
  });

  it("freezes a historical terminal run once, records consumer divergence, and appends a correction", async () => {
    await withDatabase(async (pool, repo) => {
      const imported = await releaseCase(repo, "historical");
      const digest = contentDigest({ question: "historical" }, { answer: "Yes." });
      await verdict(pool, imported.caseId, "verdict_historical");
      await pool.query(
        `insert into eval_runs
         (id, project_id, skill_version_id, trigger, status, total_items, completed_items, failed_items, agreed_items, finished_at)
         values ('evr_historical','proj_receipt','skillv_receipt','release_evidence','completed',1,1,0,0,now())`
      );
      await pool.query(
        `insert into eval_run_items
         (id, eval_run_id, project_id, case_id, client_item_id, content_digest, status, verdict_id,
          result_label, cached, provider_metadata, finished_at)
         values ('evi_historical','evr_historical','proj_receipt',$1,'historical-item',$2,'completed',
                 'verdict_historical','pass',false,'{"model":"historical-model","requestId":"req","responseId":"resp","systemFingerprint":null}',now())`,
        [imported.caseId, digest]
      );

      const [first, second] = await Promise.all([
        repo.getOrFreezeAssessmentReceipt("proj_receipt", "evr_historical"),
        repo.getOrFreezeAssessmentReceipt("proj_receipt", "evr_historical")
      ]);
      expect(first?.id).toBe(second?.id);
      expect(first?.sourceKind).toBe("historical_freeze");
      expect(await repo.listAssessmentReceiptArtifacts("proj_receipt", "evr_historical")).toHaveLength(1);

      const match = await repo.compareAssessmentReceiptCopy({
        projectId: "proj_receipt",
        evalRunId: "evr_historical",
        consumerCanonicalBytes: first!.canonicalBytes
      });
      expect(match.comparisonStatus).toBe("match");
      const rootReceipt = AssessmentReceiptSchema.parse(JSON.parse(first!.canonicalBytes.toString("utf8")));
      const divergent = structuredClone(rootReceipt);
      divergent.items[0]!.judgedLabel = "fail";
      divergent.evidenceDigest = evidenceDigestForReceipt(divergent);
      const divergence = await repo.compareAssessmentReceiptCopy({
        projectId: "proj_receipt",
        evalRunId: "evr_historical",
        consumerCanonicalBytes: Buffer.from(canonicalJson(divergent), "utf8")
      });
      expect(divergence.comparisonStatus).toBe("diverged");
      await expect(pool.query(
        `update assessment_receipt_comparisons set comparison_status = 'match' where id = $1`,
        [divergence.id]
      )).rejects.toMatchObject({ code: "55000" });

      const correctionUnsigned = {
        ...structuredClone(rootReceipt),
        receiptId: `${rootReceipt.receiptId}_correction_2`,
        items: rootReceipt.items.map((item) => ({ ...item, judgedLabel: "fail" as const }))
      };
      const { evidenceDigest: _old, ...correctionWithoutDigest } = correctionUnsigned;
      const correctionReceipt = AssessmentReceiptSchema.parse({
        ...correctionWithoutDigest,
        evidenceDigest: evidenceDigestForReceipt(correctionWithoutDigest as AssessmentReceipt)
      });
      const correction = await repo.createAssessmentReceiptCorrection({
        projectId: "proj_receipt",
        evalRunId: "evr_historical",
        receipt: correctionReceipt,
        reason: "Historical correction test."
      });
      expect(correction).toMatchObject({ artifactRevision: 2, predecessorArtifactId: first!.id });
      expect((await repo.getOrFreezeAssessmentReceipt("proj_receipt", "evr_historical"))?.id).toBe(first!.id);

      await repo.deleteProject("proj_receipt", { confirmProjectName: "Receipt Project" });
      expect((await pool.query(`select count(*)::int as count from assessment_receipt_artifacts`)).rows[0]?.count).toBe(0);
      expect((await pool.query(`select count(*)::int as count from assessment_receipt_comparisons`)).rows[0]?.count).toBe(0);
    });
  });

  it("fails closed when directly inserted artifact or consumer-copy rows disagree with their bytes", async () => {
    await withDatabase(async (pool, repo) => {
      const imported = await releaseCase(repo, "tampered-storage");
      const created = await repo.createEvalRun({
        projectId: "proj_receipt",
        skillVersionId: "skillv_receipt",
        trigger: "release_evidence",
        items: [{
          caseId: imported.caseId,
          clientItemId: "tampered-storage",
          contentDigest: contentDigest({ question: "tampered-storage" }, { answer: "Yes." })
        }]
      });
      await repo.markEvalRunRunning("proj_receipt", created.id);
      await verdict(pool, imported.caseId, "verdict_tampered_storage");
      await repo.completeEvalRunItem({
        projectId: "proj_receipt",
        evalRunId: created.id,
        evalRunItemId: created.items[0]!.id,
        verdictId: "verdict_tampered_storage",
        resultLabel: "pass"
      });
      const root = await repo.getOrFreezeAssessmentReceipt("proj_receipt", created.id);
      expect(root).not.toBeNull();

      await expect(pool.query(
        `insert into assessment_receipt_artifacts
         (id, project_id, eval_run_id, receipt_id, contract_version, artifact_revision,
          canonical_bytes, artifact_digest, evidence_digest, source_snapshot_digest,
          source_kind, predecessor_artifact_id, correction_reason)
         values ('rart_skipped_revision','proj_receipt',$1,'receipt_skipped_revision',1,3,$2,$3,$4,$3,
                 'correction',$5,'invalid skipped revision')`,
        [created.id, root!.canonicalBytes, root!.artifactDigest, root!.evidenceDigest, root!.id]
      )).rejects.toMatchObject({ code: "23514" });

      await pool.query(
        `insert into assessment_receipt_artifacts
         (id, project_id, eval_run_id, receipt_id, contract_version, artifact_revision,
          canonical_bytes, artifact_digest, evidence_digest, source_snapshot_digest,
          source_kind, predecessor_artifact_id, correction_reason)
         values ('rart_tampered','proj_receipt',$1,'receipt_tampered',1,2,$2,$3,$4,$3,
                 'correction',$5,'tamper fixture')`,
        [
          created.id,
          root!.canonicalBytes,
          "sha256:" + "0".repeat(64),
          root!.evidenceDigest,
          root!.id
        ]
      );
      await expect(
        repo.getAssessmentReceiptArtifactByReceiptId("proj_receipt", "receipt_tampered")
      ).rejects.toThrow(/artifactDigest mismatch/);

      const expectedConsumerDigest = receiptArtifactDigest(root!.canonicalBytes);
      const unrelatedRun = await repo.createEvalRun({
        projectId: "proj_receipt",
        skillVersionId: "skillv_receipt",
        trigger: "api_batch",
        items: [{ caseId: imported.caseId }]
      });
      await expect(pool.query(
        `insert into assessment_receipt_comparisons
         (id, project_id, eval_run_id, artifact_id, consumer_receipt_id,
          consumer_canonical_bytes, consumer_artifact_digest, comparison_status)
         values ('rcomp_wrong_owner','proj_receipt',$1,$2,$3,$4,$5,'match')`,
        [unrelatedRun.id, root!.id, root!.receiptId, root!.canonicalBytes, expectedConsumerDigest]
      )).rejects.toMatchObject({ code: "23514" });

      await pool.query(
        `insert into assessment_receipt_comparisons
         (id, project_id, eval_run_id, artifact_id, consumer_receipt_id,
          consumer_canonical_bytes, consumer_artifact_digest, comparison_status)
         values ('rcomp_tampered','proj_receipt',$1,$2,$3,'{}'::text::bytea,$4,'match')`,
        [created.id, root!.id, root!.receiptId, expectedConsumerDigest]
      );
      await expect(repo.compareAssessmentReceiptCopy({
        projectId: "proj_receipt",
        evalRunId: created.id,
        consumerCanonicalBytes: root!.canonicalBytes
      })).rejects.toThrow(/consumer receipt bytes failed validation/);

      const rootReceipt = AssessmentReceiptSchema.parse(JSON.parse(root!.canonicalBytes.toString("utf8")));
      const divergentUnsigned = {
        ...structuredClone(rootReceipt),
        items: rootReceipt.items.map((item) => ({ ...item, judgedLabel: "fail" as const }))
      };
      const { evidenceDigest: _old, ...divergentWithoutDigest } = divergentUnsigned;
      const divergentReceipt = AssessmentReceiptSchema.parse({
        ...divergentWithoutDigest,
        evidenceDigest: evidenceDigestForReceipt(divergentWithoutDigest as AssessmentReceipt)
      });
      const divergentBytes = Buffer.from(canonicalJson(divergentReceipt), "utf8");
      const divergentDigest = receiptArtifactDigest(divergentBytes);
      await pool.query(
        `insert into assessment_receipt_comparisons
         (id, project_id, eval_run_id, artifact_id, consumer_receipt_id,
          consumer_canonical_bytes, consumer_artifact_digest, comparison_status)
         values ('rcomp_wrong_status','proj_receipt',$1,$2,$3,$4,$5,'match')`,
        [created.id, root!.id, root!.receiptId, divergentBytes, divergentDigest]
      );
      await expect(repo.compareAssessmentReceiptCopy({
        projectId: "proj_receipt",
        evalRunId: created.id,
        consumerCanonicalBytes: divergentBytes
      })).rejects.toThrow(/comparison does not match/);
    });
  });
});
