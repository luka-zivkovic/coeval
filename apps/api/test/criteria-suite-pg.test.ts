import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import {
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest,
} from "../src/lib/dataset-revision.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import {
  EvaluatorSuiteBindingError,
  EvaluatorSuiteIdempotencyConflictError,
} from "../src/repository.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; criteria/suite PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite fixture number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`unsupported fixture value: ${typeof value}`);
}

function sha256Bytes(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Json(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

async function seedCurrentCriteriaSuite(client: PoolClient): Promise<void> {
  await client.query(`insert into organizations (id, name) values ('org_batch3', 'Batch 3 Org')`);
  await client.query(`
    insert into projects (id, organization_id, name, trace_provider)
    values ('proj_batch3', 'org_batch3', 'Batch 3 Project', 'manual')
  `);
  await client.query(`
    insert into criteria (id,project_id,stable_key,source_kind)
    values ('criterion_legacy_skill_legacy','proj_batch3','correctness','native')
  `);
  await client.query(`
    insert into criterion_versions
      (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
    values ('criterionv_legacy_skill_legacy','proj_batch3','criterion_legacy_skill_legacy',1,
            'Correctness','The answer is factually correct.',
            criterion_v1_digest('criterion_legacy_skill_legacy','criterionv_legacy_skill_legacy',
                                'Correctness','The answer is factually correct.'),'native')
  `);
  await client.query(`
    insert into skills (id, project_id, name, description, owner_user_id, status, criterion_id)
    values ('skill_legacy', 'proj_batch3', 'Correctness', 'The answer is factually correct.', null,
            'production','criterion_legacy_skill_legacy')
  `);
  for (const [id, version] of [["skillv_legacy_1", "1.0.0"], ["skillv_legacy_2", "1.0.1"]]) {
    await client.query(`
      insert into skill_versions
        (id, skill_id, project_id, version, status, rubric_markdown, prompt,
         output_schema, model_binding, verdict_kind, rubric_provenance, criterion_version_id, created_at)
      values ($1, 'skill_legacy', 'proj_batch3', $2, 'approved', '# Correct', 'Judge.',
              '{"type":"object"}',
              '{"provider":"mock","modelId":"mock","modelVersion":"1","temperature":0}',
              'binary', 'human-authored', 'criterionv_legacy_skill_legacy', now())
    `, [id, version]);
  }
  await client.query(`
    insert into raw_traces
      (id, project_id, source_trace_id, raw_payload, normalization_version)
    values ('raw_case_shared', 'proj_batch3', 'trace-1',
            '{"input":"q","output":"a"}', 'v1')
  `);
  await client.query(`
    insert into cases (id, project_id, raw_trace_id, case_type, normalized_payload, ingestion_purpose)
    values ('case_shared', 'proj_batch3', 'raw_case_shared', 'manual',
            '{"input":"q","output":"a"}', 'judge_api')
  `);
  await client.query(`
    insert into judge_runs
      (id, project_id, case_id, skill_version_id, verdict, score, reasoning, created_at)
    values ('judge_legacy', 'proj_batch3', 'case_shared', 'skillv_legacy_2',
            'pass', 1, 'legacy judge evidence', now())
  `);
  await client.query(`
    insert into verdicts
      (id, project_id, case_id, skill_version_id, source, verdict_kind, payload, created_at)
    values ('verdict_legacy_human', 'proj_batch3', 'case_shared', 'skillv_legacy_2', 'human',
            'binary', '{"kind":"binary","pass":true,"rationale":"legacy human pass"}', now())
  `);
  await client.query(`
    insert into review_queues (id, project_id, name)
    values ('queue_legacy', 'proj_batch3', 'Legacy review queue')
  `);
  await client.query(`
    insert into review_queue_items (id, queue_id, case_id, criterion_version_id, position)
    values ('queue_item_legacy', 'queue_legacy', 'case_shared', 'criterionv_legacy_skill_legacy', 0)
  `);
  await client.query(`
    insert into golden_set_entries
      (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by,
       source_skill_version_id, criterion_version_id)
    values ('gold_legacy', 'proj_batch3', 'case_shared', 'trace-1', 'pass', 'known case',
            'Reviewer', 'skillv_legacy_1', 'criterionv_legacy_skill_legacy')
  `);
  await client.query(`
    insert into dataset_revisions
      (id, project_id, series_id, revision_number, role, source_kind, identity_basis,
       content_digest, revision_digest, item_count, provenance_level, criterion_version_id)
    values ('dsr_legacy', 'proj_batch3', 'golden:proj_batch3', 1,
            'regression_golden', 'golden_snapshot', 'input-identity/v1',
            $1, $2, 0, 'legacy', 'criterionv_legacy_skill_legacy')
  `, [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  await client.query(`
    insert into criterion_regression_revisions (project_id, criterion_version_id, revision_id)
    values ('proj_batch3', 'criterionv_legacy_skill_legacy', 'dsr_legacy')
  `);
  await client.query(`
    update skill_versions
    set regression_dataset_revision_id = 'dsr_legacy'
    where id in ('skillv_legacy_1', 'skillv_legacy_2')
  `);
  await client.query(`
    insert into regression_runs
      (id, project_id, skill_version_id, dataset_revision_id, status,
       compared, regressed, improved, flipped, golden_set_missing, criterion_version_id)
    values ('regrun_legacy', 'proj_batch3', 'skillv_legacy_2', 'dsr_legacy',
            'passed', 0, 0, 0, 0, false, 'criterionv_legacy_skill_legacy')
  `);
}

run("Batch 3 criteria and evaluator suite PostgreSQL invariants", () => {
  it("enforces current criterion-scoped immutable suite evidence", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("criteria_suite");
    try {
      await runMigrations(pool);
      const before = await pool.connect();
      try {
        await before.query("begin");
        await seedCurrentCriteriaSuite(before);
        await before.query("commit");
      } catch (error) {
        await before.query("rollback");
        throw error;
      } finally {
        before.release();
      }
      const repository = new PgRepository(pool);

      const escapedDigest = (await pool.query(
        `select criterion_v1_digest($1, $2, $3, $4) as digest`,
        ["criterion-quoted", "criterionv-quoted", "Café \"quality\"", "Line one\nLine two ✓"],
      )).rows[0]?.digest;
      expect(escapedDigest).toBe(sha256Json({
        criterionId: "criterion-quoted",
        criterionVersionId: "criterionv-quoted",
        criterionName: "Café \"quality\"",
        criterionDefinition: "Line one\nLine two ✓",
      }));

      const legacy = await pool.query(`
        select skill.criterion_id,
               array_agg(distinct version.criterion_version_id) as version_criteria,
               criterion_version.name,
               criterion_version.definition,
               criterion_version.criterion_digest,
               criterion_version.source_kind,
               revision.criterion_version_id as regression_criterion,
               run.criterion_version_id as run_criterion
        from skills skill
        join skill_versions version on version.skill_id = skill.id
        join criterion_versions criterion_version on criterion_version.id = version.criterion_version_id
        join dataset_revisions revision on revision.id = 'dsr_legacy'
        join regression_runs run on run.id = 'regrun_legacy'
        where skill.id = 'skill_legacy'
        group by skill.criterion_id, criterion_version.name, criterion_version.definition,
                 criterion_version.criterion_digest,
                 criterion_version.source_kind, revision.criterion_version_id, run.criterion_version_id
      `);
      expect(legacy.rows[0]).toMatchObject({
        criterion_id: "criterion_legacy_skill_legacy",
        version_criteria: ["criterionv_legacy_skill_legacy"],
        name: "Correctness",
        definition: "The answer is factually correct.",
        source_kind: "native",
        regression_criterion: "criterionv_legacy_skill_legacy",
        run_criterion: "criterionv_legacy_skill_legacy",
      });
      expect(legacy.rows[0]?.criterion_digest).toBe(sha256Json({
        criterionId: "criterion_legacy_skill_legacy",
        criterionVersionId: "criterionv_legacy_skill_legacy",
        criterionName: "Correctness",
        criterionDefinition: "The answer is factually correct.",
      }));
      expect((await pool.query(`
        select revision_id from criterion_regression_revisions
        where project_id = 'proj_batch3'
          and criterion_version_id = 'criterionv_legacy_skill_legacy'
      `)).rows[0]?.revision_id).toBe("dsr_legacy");
      expect((await pool.query(`
        select skill_version_id from verdicts where id = 'verdict_legacy_human'
      `)).rows[0]?.skill_version_id).toBe("skillv_legacy_2");
      expect((await pool.query(`
        select criterion_version_id from review_queue_items where id = 'queue_item_legacy'
      `)).rows[0]?.criterion_version_id).toBe("criterionv_legacy_skill_legacy");

      await expect(pool.query(`
        insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload)
        values ('verdict_singleton_writer', 'proj_batch3', 'case_shared', null,
                'adjudicated', 'binary', '{"kind":"binary","pass":true,"rationale":"singleton pass"}')
      `)).rejects.toMatchObject({ code: "23514" });

      await pool.query(`
        insert into criteria (id,project_id,stable_key,source_kind)
        values ('criterion_legacy_skill_tone','proj_batch3','tone','native')
      `);
      await pool.query(`
        insert into criterion_versions
          (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind)
        values ('criterionv_legacy_skill_tone','proj_batch3','criterion_legacy_skill_tone',1,
                'Tone','The response uses an appropriate tone.',
                criterion_v1_digest('criterion_legacy_skill_tone','criterionv_legacy_skill_tone',
                                    'Tone','The response uses an appropriate tone.'),'native')
      `);
      await pool.query(`
        insert into skills (id, project_id, name, description, owner_user_id, status, criterion_id)
        values ('skill_tone', 'proj_batch3', 'Tone', 'The response uses an appropriate tone.', null,
                'production','criterion_legacy_skill_tone')
      `);
      await pool.query(`
        insert into skill_versions
          (id, skill_id, project_id, version, status, rubric_markdown, prompt,
           output_schema, model_binding, verdict_kind, rubric_provenance,
           criterion_version_id, created_at)
        values ('skillv_tone_1', 'skill_tone', 'proj_batch3', '1.0.0', 'approved',
                '# Tone', 'Judge.', '{"type":"object"}',
                '{"provider":"mock","modelId":"mock","modelVersion":"1","temperature":0}',
                'binary', 'human-authored', 'criterionv_legacy_skill_tone', now())
      `);
      const tone = (await pool.query(`
        select skill.criterion_id, version.criterion_version_id
        from skills skill join skill_versions version on version.skill_id = skill.id
        where skill.id = 'skill_tone'
      `)).rows[0];
      expect(tone).toMatchObject({
        criterion_id: "criterion_legacy_skill_tone",
        criterion_version_id: "criterionv_legacy_skill_tone",
      });
      await pool.query(`
        insert into integrations
          (id, project_id, provider, encrypted_credentials, config,
           poll_enabled, poll_interval_seconds, poll_limit)
        values
          ('int_unpinned_langsmith', 'proj_batch3', 'langsmith', 'not-read', '{}'::jsonb, true, 1, 5),
          ('int_unpinned_langfuse', 'proj_batch3', 'langfuse', 'not-read', '{}'::jsonb, true, 1, 5),
          ('int_unpinned_ironside', 'proj_batch3', 'ironside', 'not-read', '{}'::jsonb, true, 1, 5)
      `);
      const unsafePollAt = new Date("2026-08-23T12:00:00.000Z");
      await expect(repository.claimDueLangSmithImportTargets({
        now: unsafePollAt, intervalMs: 1, batchSize: 10, defaultLimit: 25
      })).resolves.toEqual([]);
      await expect(repository.claimDueLangfuseImportTargets({
        now: unsafePollAt, intervalMs: 1, batchSize: 10, defaultLimit: 25
      })).resolves.toEqual([]);
      await expect(repository.claimDueIronsideImportTargets({
        now: unsafePollAt, intervalMs: 1, batchSize: 10, defaultLimit: 25
      })).resolves.toEqual([]);
      expect((await pool.query(`
        select source, skill_version_id, status, error
        from import_jobs
        where source_integration_id like 'int_unpinned_%'
        order by source
      `)).rows).toEqual([
        { source: "ironside", skill_version_id: null, status: "failed", error: expect.stringMatching(/^skill_version_required:/) },
        { source: "langfuse", skill_version_id: null, status: "failed", error: expect.stringMatching(/^skill_version_required:/) },
        { source: "langsmith", skill_version_id: null, status: "failed", error: expect.stringMatching(/^skill_version_required:/) },
      ]);
      await expect(pool.query(`
        insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload)
        values ('verdict_ambiguous_writer', 'proj_batch3', 'case_shared', null,
                'human', 'binary', '{"kind":"binary","pass":true,"rationale":"ambiguous pass"}')
      `)).rejects.toMatchObject({ code: "23514" });
      await pool.query(`
        insert into review_queues (id, project_id, name)
        values ('queue_ambiguous', 'proj_batch3', 'Ambiguous rolling-writer queue')
      `);
      await expect(pool.query(`
        insert into review_queue_items (id, queue_id, case_id, position)
        values ('queue_item_ambiguous', 'queue_ambiguous', 'case_shared', 0)
      `)).rejects.toMatchObject({ code: "23514" });
      await pool.query(`
        insert into review_queue_items
          (id, queue_id, case_id, criterion_version_id, position)
        values
          ('queue_item_correctness', 'queue_ambiguous', 'case_shared',
           'criterionv_legacy_skill_legacy', 1),
          ('queue_item_tone', 'queue_ambiguous', 'case_shared',
           'criterionv_legacy_skill_tone', 2)
      `);
      await expect(pool.query(`
        insert into review_queue_items
          (id, queue_id, case_id, criterion_version_id, position)
        values ('queue_item_correctness_duplicate', 'queue_ambiguous', 'case_shared',
                'criterionv_legacy_skill_legacy', 3)
      `)).rejects.toMatchObject({ code: "23505" });
      await expect(repository.getNextPendingQueueItem(
        "proj_batch3",
        "queue_ambiguous"
      )).rejects.toMatchObject({ name: "AmbiguousProjectSkillError" });
      await expect(repository.getNextPendingQueueItem(
        "proj_batch3",
        "queue_ambiguous",
        { criterionVersionId: "criterionv_legacy_skill_tone" }
      )).resolves.toMatchObject({ id: "queue_item_tone" });
      await repository.recordVerdict({
        projectId: "proj_batch3",
        caseId: "case_shared",
        source: "human",
        skillVersionId: "skillv_legacy_2",
        payload: { kind: "binary", pass: true, rationale: "Criterion-scoped review." },
      });
      expect((await pool.query(`
        select id, status
        from review_queue_items
        where id in ('queue_item_correctness', 'queue_item_tone')
        order by id
      `)).rows).toEqual([
        { id: "queue_item_correctness", status: "completed" },
        { id: "queue_item_tone", status: "pending" },
      ]);
      await expect(pool.query(`
        insert into skills (id, project_id, name, description, status, criterion_id)
        values ('skill_duplicate_lineage', 'proj_batch3', 'Duplicate', 'Duplicate', 'draft',
                'criterion_legacy_skill_tone')
      `)).rejects.toMatchObject({ code: "23505" });

      // The same case may be active for two distinct criteria, but never twice
      // for the same immutable criterion definition.
      await pool.query(`
        insert into golden_set_entries
          (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by,
           source_skill_version_id, criterion_version_id)
        values ('gold_tone', 'proj_batch3', 'case_shared', 'trace-1', 'fail',
                'tone failure', 'Reviewer', 'skillv_tone_1', 'criterionv_legacy_skill_tone')
      `);
      await expect(pool.query(`
        insert into golden_set_entries
          (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by,
           source_skill_version_id, criterion_version_id)
        values ('gold_tone_duplicate', 'proj_batch3', 'case_shared', 'trace-1', 'fail',
                'duplicate', 'Reviewer', 'skillv_tone_1', 'criterionv_legacy_skill_tone')
      `)).rejects.toMatchObject({ code: "23505" });
      await expect(pool.query(`
        insert into golden_set_entries
          (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by,
           source_skill_version_id, criterion_version_id)
        values ('gold_tone_swapped', 'proj_batch3', 'case_shared', 'trace-1', 'fail',
                'swapped', 'Reviewer', 'skillv_tone_1', 'criterionv_legacy_skill_legacy')
      `)).rejects.toMatchObject({ code: "23514" });

      await pool.query(`
        insert into dataset_revisions
          (id, project_id, series_id, revision_number, role, source_kind, identity_basis,
           content_digest, revision_digest, item_count, provenance_level, criterion_version_id)
        values ('dsr_tone', 'proj_batch3', 'golden:proj_batch3:tone', 1,
                'regression_golden', 'golden_snapshot', 'input-identity/v1', $1, $2, 0,
                'reviewed_unblinded', 'criterionv_legacy_skill_tone')
      `, [`sha256:${"3".repeat(64)}`, `sha256:${"4".repeat(64)}`]);
      await pool.query(`
        insert into criterion_regression_revisions
          (project_id, criterion_version_id, revision_id)
        values ('proj_batch3', 'criterionv_legacy_skill_tone', 'dsr_tone')
      `);
      // A new definition is a separate criterion-scoped evidence lineage.
      await pool.query(`
        insert into criterion_versions
          (id, project_id, criterion_id, revision, name, definition, criterion_digest, source_kind)
        values (
          'criterionv_legacy_skill_legacy_2',
          'proj_batch3',
          'criterion_legacy_skill_legacy',
          2,
          'Correctness v2',
          'The answer remains factually correct.',
          criterion_v1_digest(
            'criterion_legacy_skill_legacy',
            'criterionv_legacy_skill_legacy_2',
            'Correctness v2',
            'The answer remains factually correct.'
          ),
          'native'
        )
      `);
      await pool.query(`
        insert into dataset_revisions
          (id, project_id, series_id, revision_number, role, source_kind, identity_basis,
           content_digest, revision_digest, item_count, provenance_level, criterion_version_id)
        values ('dsr_legacy_v2', 'proj_batch3', 'golden:proj_batch3:correctness-v2', 1,
                'regression_golden', 'golden_snapshot', 'input-identity/v1', $1, $2, 0,
                'reviewed_unblinded', 'criterionv_legacy_skill_legacy_2')
      `, [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`]);
      await pool.query(`
        insert into criterion_regression_revisions
          (project_id, criterion_version_id, revision_id)
        values ('proj_batch3', 'criterionv_legacy_skill_legacy_2', 'dsr_legacy_v2')
      `);
      // A new definition in the same stable criterion is a separate evidence
      // scope. Its first evaluator must not treat a v1 regression result as
      // the prior baseline for v2, even though both versions belong to the
      // same skill lineage.
      await pool.query(`
        insert into skill_versions
          (id, skill_id, project_id, version, status, rubric_markdown, prompt,
           output_schema, model_binding, verdict_kind, rubric_provenance,
           regression_dataset_revision_id, criterion_version_id, created_at)
        values ('skillv_legacy_definition_2', 'skill_legacy', 'proj_batch3', '2.0.0',
                'calibrating', '# Correctness v2', 'Judge.', '{"type":"object"}',
                '{"provider":"mock","modelId":"mock","modelVersion":"1","temperature":0}',
                'binary', 'human-authored', 'dsr_legacy_v2', 'criterionv_legacy_skill_legacy_2', now())
      `);
      await pool.query(`
        insert into judge_runs
          (id, project_id, case_id, skill_version_id, verdict, score, reasoning, created_at)
        values ('judge_legacy_definition_2', 'proj_batch3', 'case_shared',
                'skillv_legacy_definition_2', 'pass', 1, 'v2 judge evidence', now())
      `);
      await pool.query(`
        insert into verdicts
          (id, project_id, case_id, skill_version_id, source, verdict_kind, payload)
        values ('verdict_tone_human', 'proj_batch3', 'case_shared', 'skillv_tone_1',
                'human', 'binary',
                '{"kind":"binary","pass":true,"rationale":"tone-specific human pass"}')
      `);
      await repository.promoteExceptionToGoldenSet({
        projectId: "proj_batch3",
        caseId: "case_shared",
        skillVersionId: "skillv_legacy_definition_2",
        agreedLabel: "pass",
        reason: "Correctness v2 known-good case.",
        actorName: "Batch 3 test",
      });
      const definitionV2RevisionId = String((await pool.query(`
        select revision_id
        from criterion_regression_revisions
        where project_id = 'proj_batch3'
          and criterion_version_id = 'criterionv_legacy_skill_legacy_2'
      `)).rows[0]?.revision_id);
      expect(definitionV2RevisionId).not.toBe("dsr_legacy_v2");

      const definitionV2Item = (await pool.query(`
        select item.payload_snapshot, item.input_digest, item.reference_label,
               item.reference_fail_step, item.reference_provenance, item.note,
               item.item_digest, revision.content_digest, revision.revision_digest
        from dataset_revision_items item
        join dataset_revisions revision on revision.id = item.revision_id
        where item.revision_id = $1 and item.source_case_id = 'case_shared'
      `, [definitionV2RevisionId])).rows[0];
      const definitionV2VerdictIds = (await pool.query(`
        select verdict.id
        from verdicts verdict
        join skill_versions evaluator
          on evaluator.id = verdict.skill_version_id
         and evaluator.project_id = verdict.project_id
        where verdict.project_id = 'proj_batch3'
          and verdict.case_id = 'case_shared'
          and verdict.source in ('human', 'adjudicated')
          and evaluator.criterion_version_id = 'criterionv_legacy_skill_legacy_2'
        order by verdict.created_at, verdict.id
      `)).rows.map((row) => String(row.id));
      expect(definitionV2VerdictIds).toHaveLength(1);
      expect(definitionV2Item?.reference_provenance.verdictIds).toEqual(definitionV2VerdictIds);
      expect(definitionV2Item?.reference_provenance.verdictIds).not.toContain("verdict_legacy_human");
      expect(definitionV2Item?.reference_provenance.verdictIds).not.toContain("verdict_tone_human");

      const definitionV2ItemDigest = datasetRevisionItemDigest({
        inputIdentity: {
          basis: "input-identity/v1",
          digest: String(definitionV2Item?.input_digest),
        },
        redactedPayload: definitionV2Item?.payload_snapshot,
        referenceLabel: definitionV2Item?.reference_label,
        expectedFailStep: definitionV2Item?.reference_fail_step === null
          ? null
          : Number(definitionV2Item?.reference_fail_step),
        reviewProvenance: definitionV2Item?.reference_provenance,
        note: definitionV2Item?.note ?? null,
      });
      expect(definitionV2Item?.item_digest).toBe(definitionV2ItemDigest);
      expect(definitionV2Item?.content_digest).toBe(
        datasetRevisionContentDigest([definitionV2ItemDigest]),
      );
      expect(definitionV2Item?.revision_digest).toBe(datasetRevisionDigest({
        role: "regression_golden",
        itemDigests: [definitionV2ItemDigest],
      }));
      await pool.query(`
        update skill_versions
        set regression_dataset_revision_id = $1
        where id = 'skillv_legacy_definition_2'
      `, [definitionV2RevisionId]);

      // Deliberately record a contradictory v1 result for the same case. A
      // cross-definition lookup would classify the v2 pass as an improvement;
      // an exact criterion-version lookup has no v2 predecessor and reports
      // the result simply as agreement.
      await pool.query(`
        insert into regression_runs
          (id, project_id, skill_version_id, dataset_revision_id, status,
           compared, regressed, improved, flipped, golden_set_missing, cases, created_at,
           criterion_version_id)
        values ('regrun_legacy_latest_v1', 'proj_batch3', 'skillv_legacy_2', 'dsr_legacy',
                'blocked', 1, 1, 0, 0, false,
                '[{"caseId":"case_shared","traceId":"trace-1","agreedLabel":"pass","newLabel":"fail","change":"regress","rationale":"v1 disagreed"}]',
                now() + interval '1 second', 'criterionv_legacy_skill_legacy')
      `);
      const definitionV2Gate = await repository.runRegressionGateForVersion({
        projectId: "proj_batch3",
        skillVersionId: "skillv_legacy_definition_2",
        datasetRevisionId: definitionV2RevisionId,
        timeScope: "new"
      });
      expect(definitionV2Gate.regressionRun).toMatchObject({
        compared: 1,
        regressed: 0,
        improved: 0,
        flipped: 0,
      });
      expect(definitionV2Gate.regressionRun.cases).toEqual([
        expect.objectContaining({
          caseId: "case_shared",
          agreedLabel: "pass",
          newLabel: "pass",
          change: "agree",
        }),
      ]);

      // The API validates stable criterion identity after resolving exact
      // bindings, so two definition versions of one criterion fail with the
      // domain error rather than leaking PostgreSQL's member uniqueness 23505.
      await expect(repository.createEvaluatorSuiteManifest("proj_batch3", {
        idempotencyKey: "duplicate-stable-criterion",
        members: [
          {
            criterionVersionId: "criterionv_legacy_skill_legacy",
            skillVersionId: "skillv_legacy_2",
          },
          {
            criterionVersionId: "criterionv_legacy_skill_legacy_2",
            skillVersionId: "skillv_legacy_definition_2",
          },
        ],
        trialPlan: null,
      }, {})).rejects.toBeInstanceOf(EvaluatorSuiteBindingError);
      expect((await pool.query(`
        select count(*)::int as count
        from evaluator_suite_manifests
        where project_id = 'proj_batch3'
          and idempotency_key = 'duplicate-stable-criterion'
      `)).rows[0]?.count).toBe(0);

      await expect(pool.query(`
        insert into criterion_regression_revisions
          (project_id, criterion_version_id, revision_id)
        values ('proj_batch3', 'criterionv_legacy_skill_tone', 'dsr_legacy')
        on conflict (project_id, criterion_version_id) do update
        set revision_id = excluded.revision_id
      `)).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(`
        update skill_versions
        set regression_dataset_revision_id = 'dsr_tone'
        where id = 'skillv_legacy_2'
      `)).rejects.toMatchObject({ code: "23514" });

      await expect(pool.query(`
        update criterion_versions set definition = 'rewritten'
        where id = 'criterionv_legacy_skill_legacy'
      `)).rejects.toMatchObject({ code: "55000" });
      await expect(pool.query(`
        update skills set criterion_id = 'criterion_legacy_skill_tone'
        where id = 'skill_legacy'
      `)).rejects.toMatchObject({ code: "55000" });

      const criterionRows = await pool.query(`
        select version.id, version.criterion_id, version.name, version.definition,
               version.criterion_digest, skill.id as skill_id, skill_version.id as skill_version_id
        from criterion_versions version
        join skills skill on skill.criterion_id = version.criterion_id
        join skill_versions skill_version
          on skill_version.skill_id = skill.id
         and skill_version.criterion_version_id = version.id
        where skill_version.id in ('skillv_legacy_2', 'skillv_tone_1')
        order by version.id
      `);
      const members = criterionRows.rows.map((row, position) => ({
        position,
        criterionId: String(row.criterion_id),
        criterionVersionId: String(row.id),
        criterionName: String(row.name),
        criterionDefinition: String(row.definition),
        criterionDigest: String(row.criterion_digest),
        skillId: String(row.skill_id),
        skillVersionId: String(row.skill_version_id),
        skillDigest: `sha256:${String(position + 5).repeat(64)}`,
        outputContractDigest: `sha256:${String(position + 7).repeat(64)}`,
        applicability: { kind: "all_items" as const },
      }));
      const unsignedManifest = {
        contract: "coeval/evaluator-suite-manifest/v1" as const,
        schemaVersion: 1 as const,
        manifestId: "manifest_batch3_1",
        suiteId: "suite_batch3",
        projectId: "proj_batch3",
        revision: 1,
        members,
        trialPlan: null,
      };
      const manifest = { ...unsignedManifest, manifestDigest: sha256Json(unsignedManifest) };
      const canonicalBytes = Buffer.from(canonicalJson(manifest), "utf8");
      const createRequestDigest = sha256Json({
        suiteId: "suite_batch3",
        members: members.map((member) => ({
          criterionVersionId: member.criterionVersionId,
          skillVersionId: member.skillVersionId,
        })),
        trialPlan: null,
      });

      await pool.query(`insert into evaluator_suites (id, project_id) values ('suite_batch3', 'proj_batch3')`);
      const suiteClient = await pool.connect();
      try {
        await suiteClient.query("begin");
        await suiteClient.query(`
          insert into evaluator_suite_manifests
            (id, suite_id, project_id, idempotency_key, request_digest, revision, contract, schema_version, member_count,
             trial_plan, canonical_bytes, artifact_digest, manifest_digest)
          values ('manifest_batch3_1', 'suite_batch3', 'proj_batch3', 'create-suite-request-1', $5, 1,
                  'coeval/evaluator-suite-manifest/v1', 1, $1, 'null'::jsonb, $2, $3, $4)
        `, [members.length, canonicalBytes, sha256Bytes(canonicalBytes), manifest.manifestDigest, createRequestDigest]);
        for (const member of members) {
          await suiteClient.query(`
            insert into evaluator_suite_manifest_members
              (manifest_id, suite_id, project_id, position, criterion_id, criterion_version_id,
               criterion_name, criterion_definition, criterion_digest, skill_id, skill_version_id,
               skill_digest, output_contract_digest, applicability)
            values ('manifest_batch3_1', 'suite_batch3', 'proj_batch3', $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10, $11)
          `, [
            member.position,
            member.criterionId,
            member.criterionVersionId,
            member.criterionName,
            member.criterionDefinition,
            member.criterionDigest,
            member.skillId,
            member.skillVersionId,
            member.skillDigest,
            member.outputContractDigest,
            JSON.stringify(member.applicability),
          ]);
        }
        await suiteClient.query("commit");
      } catch (error) {
        await suiteClient.query("rollback");
        throw error;
      } finally {
        suiteClient.release();
      }

      const stored = await pool.query(`
        select canonical_bytes, artifact_digest, manifest_digest
        from evaluator_suite_manifests where id = 'manifest_batch3_1'
      `);
      expect(Buffer.from(stored.rows[0]?.canonical_bytes)).toEqual(canonicalBytes);
      expect(stored.rows[0]?.artifact_digest).toBe(sha256Bytes(canonicalBytes));
      expect(stored.rows[0]?.manifest_digest).toBe(manifest.manifestDigest);

      const noncanonicalUnsigned = {
        ...unsignedManifest,
        manifestId: "manifest_noncanonical",
        revision: 7,
      };
      const noncanonicalManifest = {
        ...noncanonicalUnsigned,
        manifestDigest: sha256Json(noncanonicalUnsigned),
      };
      const noncanonicalBytes = Buffer.from(JSON.stringify(noncanonicalManifest), "utf8");
      expect(noncanonicalBytes).not.toEqual(Buffer.from(canonicalJson(noncanonicalManifest), "utf8"));
      await expect(pool.query(`
        insert into evaluator_suite_manifests
          (id, suite_id, project_id, idempotency_key, request_digest, revision, contract, schema_version, member_count,
           trial_plan, canonical_bytes, artifact_digest, manifest_digest)
        values ('manifest_noncanonical', 'suite_batch3', 'proj_batch3', 'noncanonical-request', $4, 7,
                'coeval/evaluator-suite-manifest/v1', 1, $1, 'null'::jsonb, $2, $3, $5)
      `, [
        members.length,
        noncanonicalBytes,
        sha256Bytes(noncanonicalBytes),
        createRequestDigest,
        noncanonicalManifest.manifestDigest,
      ])).rejects.toMatchObject({ code: "23514" });

      const forgedUnsigned = {
        ...unsignedManifest,
        manifestId: "manifest_forged_digest",
        revision: 8,
      };
      const forgedManifest = {
        ...forgedUnsigned,
        manifestDigest: `sha256:${"0".repeat(64)}`,
      };
      const forgedBytes = Buffer.from(canonicalJson(forgedManifest), "utf8");
      await expect(pool.query(`
        insert into evaluator_suite_manifests
          (id, suite_id, project_id, idempotency_key, request_digest, revision, contract, schema_version, member_count,
           trial_plan, canonical_bytes, artifact_digest, manifest_digest)
        values ('manifest_forged_digest', 'suite_batch3', 'proj_batch3', 'forged-digest-request', $4, 8,
                'coeval/evaluator-suite-manifest/v1', 1, $1, 'null'::jsonb, $2, $3, $5)
      `, [
        members.length,
        forgedBytes,
        sha256Bytes(forgedBytes),
        createRequestDigest,
        forgedManifest.manifestDigest,
      ])).rejects.toMatchObject({ code: "23514" });

      // A transport retry can build a fresh artifact identity, but the same
      // project-scoped idempotency key still permits exactly one stored
      // manifest. Repository code returns the already stored canonical bytes.
      const replayUnsigned = {
        ...unsignedManifest,
        manifestId: "manifest_batch3_replay",
        revision: 2,
      };
      const replayManifest = {
        ...replayUnsigned,
        manifestDigest: sha256Json(replayUnsigned),
      };
      const replayBytes = Buffer.from(canonicalJson(replayManifest), "utf8");
      const replay = await pool.query(`
        insert into evaluator_suite_manifests
          (id, suite_id, project_id, idempotency_key, request_digest, revision, contract, schema_version, member_count,
           trial_plan, canonical_bytes, artifact_digest, manifest_digest)
        values ('manifest_batch3_replay', 'suite_batch3', 'proj_batch3', 'create-suite-request-1', $5, 2,
                'coeval/evaluator-suite-manifest/v1', 1, $1, 'null'::jsonb, $2, $3, $4)
        on conflict (project_id, idempotency_key) do nothing
        returning id
      `, [members.length, replayBytes, sha256Bytes(replayBytes), replayManifest.manifestDigest, createRequestDigest]);
      expect(replay.rowCount).toBe(0);
      expect((await pool.query(`
        select id, canonical_bytes from evaluator_suite_manifests
        where project_id = 'proj_batch3' and idempotency_key = 'create-suite-request-1'
      `)).rows).toEqual([{ id: "manifest_batch3_1", canonical_bytes: canonicalBytes }]);

      // Reusing that key for a different semantic request is a conflict, not
      // an alias for the first artifact. The repository compares request
      // identity after this lookup and exposes a typed conflict.
      const conflictingUnsigned = {
        ...unsignedManifest,
        manifestId: "manifest_batch3_conflict",
        revision: 2,
        trialPlan: { kind: "independent_repetitions" as const, trialsPerItem: 3 },
      };
      const conflictingManifest = {
        ...conflictingUnsigned,
        manifestDigest: sha256Json(conflictingUnsigned),
      };
      const conflictingBytes = Buffer.from(canonicalJson(conflictingManifest), "utf8");
      const conflictingRequestDigest = sha256Json({
        suiteId: "suite_batch3",
        members: members.map((member) => ({
          criterionVersionId: member.criterionVersionId,
          skillVersionId: member.skillVersionId,
        })),
        trialPlan: conflictingManifest.trialPlan,
      });
      await expect(pool.query(`
        insert into evaluator_suite_manifests
          (id, suite_id, project_id, idempotency_key, request_digest, revision, contract, schema_version, member_count,
           trial_plan, canonical_bytes, artifact_digest, manifest_digest)
        values ('manifest_batch3_conflict', 'suite_batch3', 'proj_batch3', 'create-suite-request-1', $6, 2,
                'coeval/evaluator-suite-manifest/v1', 1, $1, $2, $3, $4, $5)
      `, [
        members.length,
        JSON.stringify(conflictingManifest.trialPlan),
        conflictingBytes,
        sha256Bytes(conflictingBytes),
        conflictingManifest.manifestDigest,
        conflictingRequestDigest,
      ])).rejects.toMatchObject({ code: "23505" });

      const policyLeakUnsigned = {
        ...unsignedManifest,
        manifestId: "manifest_policy_leak",
        revision: 4,
        threshold: 0.95,
      };
      const policyLeak = {
        ...policyLeakUnsigned,
        manifestDigest: sha256Json(policyLeakUnsigned),
      };
      const policyLeakBytes = Buffer.from(canonicalJson(policyLeak), "utf8");
      await expect(pool.query(`
        insert into evaluator_suite_manifests
          (id, suite_id, project_id, idempotency_key, request_digest, revision, contract, schema_version, member_count,
           trial_plan, canonical_bytes, artifact_digest, manifest_digest)
        values ('manifest_policy_leak', 'suite_batch3', 'proj_batch3', 'policy-leak-request', $4, 4,
                'coeval/evaluator-suite-manifest/v1', 1, 2, 'null'::jsonb, $1, $2, $3)
      `, [policyLeakBytes, sha256Bytes(policyLeakBytes), policyLeak.manifestDigest, createRequestDigest]))
        .rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(`
        update evaluator_suite_manifests set member_count = 1 where id = 'manifest_batch3_1'
      `)).rejects.toMatchObject({ code: "55000" });
      await expect(pool.query(`
        update evaluator_suite_manifest_members set skill_digest = $1
        where manifest_id = 'manifest_batch3_1' and position = 0
      `, [`sha256:${"9".repeat(64)}`])).rejects.toMatchObject({ code: "55000" });

      // Exercise the repository lock/idempotency path against PostgreSQL, not
      // only DemoRepository or direct unique constraints.
      const repositoryRequest = {
        idempotencyKey: "repository-concurrent-create",
        members: members.map((member) => ({
          criterionVersionId: member.criterionVersionId,
          skillVersionId: member.skillVersionId,
        })),
        trialPlan: null,
      };
      const [repositoryReplayA, repositoryReplayB] = await Promise.all([
        repository.createEvaluatorSuiteManifest("proj_batch3", repositoryRequest, {}),
        repository.createEvaluatorSuiteManifest("proj_batch3", repositoryRequest, {}),
      ]);
      expect(canonicalJson(repositoryReplayA)).toBe(canonicalJson(repositoryReplayB));
      expect((await pool.query(`
        select count(*)::int as count
        from evaluator_suite_manifests
        where project_id = 'proj_batch3'
          and idempotency_key = 'repository-concurrent-create'
      `)).rows[0]?.count).toBe(1);
      await expect(repository.createEvaluatorSuiteManifest("proj_batch3", {
        ...repositoryRequest,
        trialPlan: { kind: "independent_repetitions", trialsPerItem: 2 },
      }, {})).rejects.toBeInstanceOf(EvaluatorSuiteIdempotencyConflictError);

      const concurrentSuiteId = repositoryReplayA.suiteId;
      const concurrentAppends = await Promise.all([
        repository.createEvaluatorSuiteManifest("proj_batch3", {
          ...repositoryRequest,
          idempotencyKey: "repository-append-a",
          suiteId: concurrentSuiteId,
        }, {}),
        repository.createEvaluatorSuiteManifest("proj_batch3", {
          ...repositoryRequest,
          idempotencyKey: "repository-append-b",
          suiteId: concurrentSuiteId,
        }, {}),
      ]);
      expect(concurrentAppends.map((entry) => entry.revision).sort((left, right) => left - right))
        .toEqual([2, 3]);

      // Deferred completeness makes an exact manifest inseparable from every
      // ordered member row.
      const incomplete = await pool.connect();
      try {
        const incompleteUnsigned = {
          ...unsignedManifest,
          manifestId: "manifest_incomplete",
          revision: 2,
        };
        const incompleteManifest = {
          ...incompleteUnsigned,
          manifestDigest: sha256Json(incompleteUnsigned),
        };
        const incompleteBytes = Buffer.from(canonicalJson(incompleteManifest), "utf8");
        await incomplete.query("begin");
        await incomplete.query(`
          insert into evaluator_suite_manifests
            (id, suite_id, project_id, idempotency_key, request_digest, revision, contract, schema_version, member_count,
             trial_plan, canonical_bytes, artifact_digest, manifest_digest)
          values ('manifest_incomplete', 'suite_batch3', 'proj_batch3', 'incomplete-request', $4, 2,
                  'coeval/evaluator-suite-manifest/v1', 1, 2, 'null'::jsonb, $1, $2, $3)
        `, [incompleteBytes, sha256Bytes(incompleteBytes), incompleteManifest.manifestDigest, createRequestDigest]);
        await expect(incomplete.query("commit")).rejects.toMatchObject({ code: "23514" });
      } finally {
        await incomplete.query("rollback").catch(() => undefined);
        incomplete.release();
      }

      // Explicit tenant erasure remains the only cascade boundary for these
      // append-only criterion and manifest artifacts.
      await pool.query(`delete from projects where id = 'proj_batch3'`);
      expect((await pool.query(`select count(*)::int as count from criteria where project_id = 'proj_batch3'`)).rows[0]?.count)
        .toBe(0);
      expect((await pool.query(`select count(*)::int as count from evaluator_suite_manifests where project_id = 'proj_batch3'`)).rows[0]?.count)
        .toBe(0);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
