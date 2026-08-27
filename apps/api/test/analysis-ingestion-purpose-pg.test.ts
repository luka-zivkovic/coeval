import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { IngestionPurposeSchema } from "@coeval/shared";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; analysis ingestion-purpose PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

const resolvedPurposes = [
  "analysis_eligible_manual",
  "analysis_eligible_langsmith",
  "analysis_eligible_langfuse",
  "analysis_eligible_ironside",
  "judge_api",
  "judge_batch_general",
  "dataset_example",
  "trace_test_synthetic",
  "release_evidence"
] as const;

async function seedProject(client: Pool | PoolClient, suffix: string): Promise<{ projectId: string }> {
  const organizationId = `org_${suffix}`;
  const projectId = `proj_${suffix}`;
  await client.query("insert into organizations (id,name) values ($1,$2)", [organizationId, suffix]);
  await client.query(
    "insert into projects (id,organization_id,name,trace_provider) values ($1,$2,$3,'manual')",
    [projectId, organizationId, suffix]
  );
  return { projectId };
}

async function withSchema(name: string, body: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await openPostgresTestDatabase(name);
  try {
    await body(pool);
  } finally {
    await cleanup();
  }
}

run("analysis ingestion-purpose PostgreSQL invariants", () => {
  it("clean-installs the closed vocabulary, insert/update guards, and project erasure", async () => {
    await withSchema("analysis_purpose_clean", async (pool) => {
      await runMigrations(pool);
      const { projectId } = await seedProject(pool, "purpose_clean");

      const purposeShapes: Record<(typeof resolvedPurposes)[number], { caseType: string; rawRequired: boolean }> = {
        analysis_eligible_manual: { caseType: "manual", rawRequired: true },
        analysis_eligible_langsmith: { caseType: "langsmith", rawRequired: true },
        analysis_eligible_langfuse: { caseType: "langfuse", rawRequired: true },
        analysis_eligible_ironside: { caseType: "ironside", rawRequired: true },
        judge_api: { caseType: "manual", rawRequired: true },
        judge_batch_general: { caseType: "manual", rawRequired: true },
        dataset_example: { caseType: "manual", rawRequired: true },
        trace_test_synthetic: { caseType: "manual", rawRequired: true },
        release_evidence: { caseType: "release_evidence", rawRequired: true }
      };
      for (const [index, purpose] of resolvedPurposes.entries()) {
        const shape = purposeShapes[purpose];
        const rawTraceId = shape.rawRequired ? `raw_purpose_${index}` : null;
        if (rawTraceId) {
          await pool.query(
            `insert into raw_traces
               (id,project_id,source_trace_id,raw_payload,normalization_version)
             values ($1,$2,$3,'{"input":{},"output":{}}','runtime-v1')`,
            [rawTraceId, projectId, `purpose-trace-${index}`]
          );
        }
        await pool.query(
          `insert into cases
             (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose)
           values ($1,$2,$3,$4,'{"input":{},"output":{}}',$5)`,
          [`case_purpose_${index}`, projectId, rawTraceId, shape.caseType, purpose]
        );
      }
      expect((await pool.query(
        "select ingestion_purpose from cases where project_id=$1 order by ingestion_purpose",
        [projectId]
      )).rows.map((row) => row.ingestion_purpose)).toEqual([...resolvedPurposes].sort());
      const vocabularyConstraint = (await pool.query(
        `select pg_get_constraintdef(oid) as definition
         from pg_constraint
         where conrelid='cases'::regclass and conname='cases_ingestion_purpose_check'`
      )).rows[0]?.definition as string;
      const databaseVocabulary = [...vocabularyConstraint.matchAll(/'([^']+)'::text/g)]
        .map((match) => match[1]!)
        .sort();
      expect(databaseVocabulary).toEqual([...IngestionPurposeSchema.options].sort());

      await expect(pool.query(
        `insert into cases (id,project_id,case_type,normalized_payload,ingestion_purpose)
         values ('case_unresolved_new',$1,'manual','{"input":{},"output":{}}','unresolved_legacy')`,
        [projectId]
      )).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(
        `insert into cases (id,project_id,case_type,normalized_payload,ingestion_purpose)
         values ('case_invalid_new',$1,'manual','{"input":{},"output":{}}','not_a_purpose')`,
        [projectId]
      )).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(
        `insert into cases (id,project_id,case_type,normalized_payload)
         values ('case_missing_purpose',$1,'manual','{"input":{},"output":{}}')`,
        [projectId]
      )).rejects.toMatchObject({ code: "23502" });

      for (const [id, caseType, purpose, rawTraceId] of [
        ["case_gate_laundered", "gate_candidate", "analysis_eligible_manual", "raw_purpose_0"],
        ["case_manual_as_provider", "manual", "analysis_eligible_langsmith", "raw_purpose_0"],
        ["case_provider_without_raw", "langsmith", "analysis_eligible_langsmith", null],
        ["case_judge_without_raw", "manual", "judge_api", null],
        ["case_manual_as_release", "manual", "release_evidence", "raw_purpose_0"]
      ] as const) {
        await expect(pool.query(
          `insert into cases
             (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose)
           values ($1,$2,$3,$4,'{"input":{},"output":{}}',$5)`,
          [id, projectId, rawTraceId, caseType, purpose]
        )).rejects.toMatchObject({ code: "23514" });
      }

      await expect(pool.query(
        "update cases set ingestion_purpose='judge_api' where id='case_purpose_0'"
      )).rejects.toMatchObject({ code: "55000" });
      await expect(pool.query(
        "update cases set ingestion_purpose=ingestion_purpose where id='case_purpose_1'"
      )).rejects.toMatchObject({ code: "55000" });

      await pool.query("delete from projects where id=$1", [projectId]);
      expect((await pool.query("select count(*)::int as count from cases where project_id=$1", [projectId])).rows[0]?.count)
        .toBe(0);
    });
  });

  it("preserves the first origin when a later request reuses the same source identity", async () => {
    await withSchema("analysis_purpose_dedupe", async (pool) => {
      await runMigrations(pool);
      const { projectId } = await seedProject(pool, "purpose_dedupe");
      const repository = new PgRepository(pool);
      const trace = {
        sourceTraceId: "shared-upstream-identity",
        input: { question: "What purpose produced this case?" },
        output: { answer: "The persisted purpose is part of its identity." },
        metadata: {}
      };

      const first = await repository.importTrace(projectId, "manual", trace, {
        ingestionPurpose: "judge_api"
      });
      expect((await pool.query(
        "select ingestion_purpose from cases where id=$1",
        [first.caseId]
      )).rows[0]?.ingestion_purpose).toBe("judge_api");
      const replay = await repository.importTrace(projectId, "manual", trace, {
        ingestionPurpose: "judge_api"
      });
      expect(replay).toEqual({ ...first, created: false });

      const differentRequestedPurpose = await repository.importTrace(projectId, "manual", trace, {
        ingestionPurpose: "dataset_example"
      });
      expect(differentRequestedPurpose).toEqual({ ...first, created: false });

      const rows = await pool.query(
        `select case_row.id,case_row.ingestion_purpose,raw.source_trace_id
         from cases case_row
         join raw_traces raw on raw.id=case_row.raw_trace_id
         where case_row.project_id=$1
         order by case_row.ingestion_purpose`,
        [projectId]
      );
      expect(rows.rows).toEqual([
        {
          id: first.caseId,
          ingestion_purpose: "judge_api",
          source_trace_id: "shared-upstream-identity"
        }
      ]);
    });
  });

  it("serializes simultaneous cross-purpose imports into one immutable origin", async () => {
    await withSchema("analysis_purpose_dedupe_race", async (pool) => {
      await runMigrations(pool);
      const { projectId } = await seedProject(pool, "purpose_dedupe_race");
      const repository = new PgRepository(pool);
      expect((await pool.query(
        `select hashtextextended(jsonb_build_array('ab','c','d')::text,0)
                  <> hashtextextended(jsonb_build_array('a','bc','d')::text,0)
                  as keys_differ`
      )).rows[0]?.keys_differ).toBe(true);
      await pool.query(`
        create function pause_concurrent_origin_insert()
        returns trigger
        language plpgsql
        as $$
        begin
          if new.source_trace_id = 'simultaneous-upstream-identity' then
            perform pg_sleep(0.2);
          end if;
          return new;
        end;
        $$;

        create trigger raw_traces_pause_concurrent_origin
        before insert on raw_traces
        for each row execute function pause_concurrent_origin_insert();
      `);
      const trace = {
        sourceTraceId: "simultaneous-upstream-identity",
        input: { question: "Which concurrent product path arrived first?" },
        output: { answer: "Exactly one immutable origin is retained." },
        metadata: {}
      };

      const [judgeOrigin, datasetOrigin] = await Promise.all([
        repository.importTrace(projectId, "manual", trace, { ingestionPurpose: "judge_api" }),
        repository.importTrace(projectId, "manual", trace, { ingestionPurpose: "dataset_example" })
      ]);
      expect([judgeOrigin.created, datasetOrigin.created].sort()).toEqual([false, true]);
      expect(datasetOrigin.caseId).toBe(judgeOrigin.caseId);
      expect(datasetOrigin.rawTraceId).toBe(judgeOrigin.rawTraceId);

      const stored = (await pool.query(
        `select case_row.id,case_row.ingestion_purpose,case_row.raw_trace_id,
                raw.source_trace_id
         from cases case_row
         join raw_traces raw on raw.id=case_row.raw_trace_id
         where case_row.project_id=$1 and raw.source_trace_id=$2`,
        [projectId, trace.sourceTraceId]
      )).rows;
      expect(stored).toHaveLength(1);
      expect(["judge_api", "dataset_example"]).toContain(stored[0]?.ingestion_purpose);
      expect(stored[0]).toMatchObject({
        id: judgeOrigin.caseId,
        raw_trace_id: judgeOrigin.rawTraceId,
        source_trace_id: trace.sourceTraceId
      });
      expect((await pool.query(
        "select count(*)::int as count from raw_traces where project_id=$1 and source_trace_id=$2",
        [projectId, trace.sourceTraceId]
      )).rows[0]?.count).toBe(1);

      const retry = await repository.importTrace(projectId, "manual", trace, {
        ingestionPurpose: "trace_test_synthetic"
      });
      expect(retry).toEqual({ ...judgeOrigin, created: false });
      expect((await pool.query(
        "select ingestion_purpose from cases where id=$1",
        [judgeOrigin.caseId]
      )).rows[0]?.ingestion_purpose).toBe(stored[0]?.ingestion_purpose);
    });
  });

  it("prelocks reverse-order overlapping bulk imports without deadlock or duplicate origins", async () => {
    await withSchema("analysis_purpose_bulk_lock_order", async (pool) => {
      await runMigrations(pool);
      const { projectId } = await seedProject(pool, "purpose_bulk_lock_order");
      const repository = new PgRepository(pool);
      const datasetA = await repository.createDataset({ projectId, name: "Forward order" });
      const datasetB = await repository.createDataset({ projectId, name: "Reverse order" });
      await pool.query(`
        create function pause_bulk_origin_insert()
        returns trigger
        language plpgsql
        as $$
        begin
          if new.source_trace_id in ('bulk-origin-x','bulk-origin-y') then
            perform pg_sleep(0.2);
          end if;
          return new;
        end;
        $$;

        create trigger raw_traces_pause_bulk_origin
        before insert on raw_traces
        for each row execute function pause_bulk_origin_insert();
      `);
      const itemX = {
        sourceTraceId: "bulk-origin-x",
        input: { item: "x" },
        output: { answer: "x" },
        metadata: {}
      };
      const itemY = {
        sourceTraceId: "bulk-origin-y",
        input: { item: "y" },
        output: { answer: "y" },
        metadata: {}
      };

      const [forward, reverse] = await Promise.all([
        repository.importDatasetExamples({
          projectId,
          datasetId: datasetA.id,
          ingestionPurpose: "dataset_example",
          items: [itemX, itemY]
        }),
        repository.importDatasetExamples({
          projectId,
          datasetId: datasetB.id,
          ingestionPurpose: "dataset_example",
          items: [itemY, itemX]
        })
      ]);
      const combined = [...forward.items, ...reverse.items];
      for (const sourceTraceId of [itemX.sourceTraceId, itemY.sourceTraceId]) {
        expect(combined
          .filter((item) => item.sourceTraceId === sourceTraceId)
          .map((item) => item.created)
          .sort()).toEqual([false, true]);
        expect(new Set(combined
          .filter((item) => item.sourceTraceId === sourceTraceId)
          .map((item) => item.caseId)).size).toBe(1);
      }

      expect((await pool.query(
        `select raw.source_trace_id,
                count(distinct raw.id)::int as raw_count,
                count(distinct case_row.id)::int as case_count
         from raw_traces raw
         left join cases case_row on case_row.raw_trace_id=raw.id
         where raw.project_id=$1 and raw.source_trace_id in ('bulk-origin-x','bulk-origin-y')
         group by raw.source_trace_id
         order by raw.source_trace_id`,
        [projectId]
      )).rows).toEqual([
        { source_trace_id: "bulk-origin-x", raw_count: 1, case_count: 1 },
        { source_trace_id: "bulk-origin-y", raw_count: 1, case_count: 1 }
      ]);
      expect((await pool.query(
        `select item.dataset_id,count(*)::int as count
         from dataset_items item
         where item.dataset_id=any($1::text[])
         group by item.dataset_id
         order by item.dataset_id`,
        [[datasetA.id, datasetB.id]]
      )).rows).toEqual([
        { dataset_id: [datasetA.id, datasetB.id].sort()[0], count: 2 },
        { dataset_id: [datasetA.id, datasetB.id].sort()[1], count: 2 }
      ]);
    });
  });

  it("rejects live cross-project case/raw-trace bindings", async () => {
    await withSchema("analysis_purpose_ownership_clean", async (pool) => {
      await runMigrations(pool);
      const first = await seedProject(pool, "ownership_clean_first");
      const second = await seedProject(pool, "ownership_clean_second");
      await pool.query(
        `insert into raw_traces
           (id,project_id,source_trace_id,raw_payload,normalization_version)
         values ('raw_first_project',$1,'first-project','{"input":{},"output":{}}','runtime-v1'),
                ('raw_second_project',$2,'second-project','{"input":{},"output":{}}','runtime-v1')`,
        [first.projectId, second.projectId]
      );
      await expect(pool.query(
        `insert into cases
           (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose)
         values ('case_bad_insert',$1,'raw_first_project','manual','{"input":{},"output":{}}','judge_api')`,
        [second.projectId]
      )).rejects.toMatchObject({ code: "23503" });

      await pool.query(
        `insert into cases
           (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose)
         values ('case_owned',$1,'raw_first_project','manual','{"input":{},"output":{}}','judge_api')`,
        [first.projectId]
      );
      await expect(pool.query(
        "update cases set raw_trace_id='raw_second_project' where id='case_owned'"
      )).rejects.toMatchObject({ code: "23503" });
      await expect(pool.query(
        "update cases set project_id=$1 where id='case_owned'",
        [second.projectId]
      )).rejects.toMatchObject({ code: "23503" });
      await expect(pool.query(
        "update raw_traces set project_id=$1 where id='raw_first_project'",
        [second.projectId]
      )).rejects.toMatchObject({ code: "23503" });

      await pool.query("delete from projects where id=$1", [first.projectId]);
      expect((await pool.query(
        "select count(*)::int as count from cases where id='case_owned'"
      )).rows[0]?.count).toBe(0);
      expect((await pool.query(
        "select count(*)::int as count from raw_traces where id='raw_first_project'"
      )).rows[0]?.count).toBe(0);
    });
  });
});
