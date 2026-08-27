import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { PgAnalysisPopulationRepository } from "../src/analysis-population/repository.pg.js";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; analysis population repository tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

async function withSchema(body: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await openPostgresTestDatabase("analysis_repo");
  try {
    await runMigrations(pool);
    await body(pool);
  } finally {
    await cleanup();
  }
}

async function seedOwner(pool: Pool, suffix: string) {
  const organizationId = `org_${suffix}`;
  const projectId = `proj_${suffix}`;
  const userId = `user_${suffix}`;
  await pool.query(
    `insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)`,
    [userId, suffix, `${suffix}@example.test`]
  );
  await pool.query(`insert into organizations (id,name) values ($1,$2)`, [organizationId, suffix]);
  await pool.query(
    `insert into projects (id,organization_id,name,trace_provider) values ($1,$2,$3,'manual')`,
    [projectId, organizationId, suffix]
  );
  await pool.query(
    `insert into project_members (id,project_id,user_id,role) values ($1,$2,$3,'owner')`,
    [`pm_${suffix}`, projectId, userId]
  );
  return { projectId, userId, projectRole: "owner" as const };
}

async function seedCase(
  pool: Pool,
  input: {
    projectId: string;
    suffix: string;
    createdAt: string;
    purpose: "analysis_eligible_manual" | "judge_api";
  }
): Promise<void> {
  const rawId = `raw_${input.suffix}`;
  const caseId = `case_${input.suffix}`;
  const payload = {
    input: { request: input.suffix },
    output: { response: `response-${input.suffix}` },
    metadata: { retained: true }
  };
  await pool.query(
    `insert into raw_traces
       (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
     values ($1,$2,$3,$4,'manual-v1',$5)`,
    [rawId, input.projectId, `trace-${input.suffix}`, JSON.stringify(payload), input.createdAt]
  );
  await pool.query(
    `insert into cases
       (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
     values ($1,$2,$3,'manual',$4,$5,$6)`,
    [caseId, input.projectId, rawId, JSON.stringify(payload), input.purpose, input.createdAt]
  );
  const identity = datasetInputIdentity({ input: payload.input });
  await pool.query(
    `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     values ($1,$2,$3,'authoring_import','input-identity/v1',$4)`,
    [`ciir_${input.suffix}`, input.projectId, caseId, identity.digest]
  );
}

async function seedCaseBatch(
  pool: Pool,
  input: { projectId: string; suffix: string; createdAt: string; count: number }
): Promise<void> {
  const inputValue = { question: "Bulk frame?" };
  const inputDigest = datasetInputIdentity({ input: inputValue }).digest;
  await pool.query(
    `insert into raw_traces
       (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
     select 'raw_' || $2 || '_' || value::text,$1,
            'trace-' || $2 || '-' || value::text,
            jsonb_build_object(
              'input',jsonb_build_object('question','Bulk frame?'),
              'output',jsonb_build_object('answer',value::text),
              'metadata',jsonb_build_object('batch',true)
            ),
            'manual-v1',$3::timestamptz + value * interval '1 microsecond'
     from generate_series(1,$4::integer) value`,
    [input.projectId, input.suffix, input.createdAt, input.count]
  );
  await pool.query(
    `insert into cases
       (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
     select 'case_' || $2 || '_' || value::text,$1,
            'raw_' || $2 || '_' || value::text,'manual',
            jsonb_build_object(
              'input',jsonb_build_object('question','Bulk frame?'),
              'output',jsonb_build_object('answer',value::text),
              'metadata',jsonb_build_object('batch',true)
            ),
            'analysis_eligible_manual',$3::timestamptz + value * interval '1 microsecond'
     from generate_series(1,$4::integer) value`,
    [input.projectId, input.suffix, input.createdAt, input.count]
  );
  await pool.query(
    `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     select 'ciir_' || $2 || '_' || value::text,$1,
            'case_' || $2 || '_' || value::text,
            'authoring_import','input-identity/v1',$3
     from generate_series(1,$4::integer) value`,
    [input.projectId, input.suffix, inputDigest, input.count]
  );
}

run("PostgreSQL analysis population repository", () => {
  it("freezes one exact frame/draw, reuses aliases, paginates, and records one governed content exposure", async () => {
    await withSchema(async (pool) => {
      const actor = await seedOwner(pool, "analysis_repo_happy");
      await seedCase(pool, {
        projectId: actor.projectId,
        suffix: "analysis_repo_a",
        createdAt: "2026-01-10T12:00:00.123456Z",
        purpose: "analysis_eligible_manual"
      });
      await seedCase(pool, {
        projectId: actor.projectId,
        suffix: "analysis_repo_b",
        createdAt: "2026-01-10T12:00:00.123789Z",
        purpose: "analysis_eligible_manual"
      });
      await seedCase(pool, {
        projectId: actor.projectId,
        suffix: "analysis_repo_excluded",
        createdAt: "2026-01-10T13:00:00.000001Z",
        purpose: "judge_api"
      });

      const repository = new PgAnalysisPopulationRepository(pool);
      const request = {
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-02-01T00:00:00.000Z",
        fixedBudget: 2,
        idempotencyKey: "analysis-repo-happy"
      };
      const created = await repository.createPopulation(actor, request);
      expect(created.reusedPopulation).toBe(false);
      expect(created.population.populationSize).toBe(2);
      expect(created.population.exclusionCount).toBe("1");
      expect(created.draw.fixedBudget).toBe(2);
      expect(created.claim).toEqual({
        drawnFromPopulationId: created.population.id,
        representativeOfPopulationId: null,
        representativeReason: "coding_not_complete"
      });

      const replay = await repository.createPopulation(actor, request);
      expect(replay).toMatchObject({
        population: { id: created.population.id },
        draw: { id: created.draw.id },
        reusedPopulation: true,
        reusedDraw: true
      });
      const alias = await repository.createPopulation(actor, {
        ...request,
        idempotencyKey: "analysis-repo-alias"
      });
      expect(alias.population.id).toBe(created.population.id);
      expect(alias.reusedPopulation).toBe(true);

      await expect(repository.createPopulation(actor, {
        ...request,
        fixedBudget: 1,
        idempotencyKey: "analysis-repo-budget-conflict"
      })).rejects.toMatchObject({
        code: "analysis_population_draw_conflict"
      });

      const secondPopulation = await repository.createPopulation(actor, {
        ...request,
        windowStart: "2026-01-05T00:00:00.000Z",
        idempotencyKey: "analysis-repo-second-window"
      });
      expect(secondPopulation.population.id).not.toBe(created.population.id);

      const summaries = await repository.listPopulations(actor, { limit: 1, cursor: null });
      expect(summaries.items).toHaveLength(1);
      expect(summaries.totalCount).toBe("2");
      expect(summaries.nextCursor).not.toBeNull();
      const summariesTail = await repository.listPopulations(actor, {
        limit: 1,
        cursor: summaries.nextCursor
      });
      expect(summariesTail.items).toHaveLength(1);
      expect(summariesTail.items[0]!.population.id).not.toBe(summaries.items[0]!.population.id);
      const malformedCursor = Buffer.from(JSON.stringify({
        v: 1,
        kind: "chronological",
        createdAt: "bogus",
        id: "population_1"
      })).toString("base64url");
      await expect(repository.listPopulations(actor, { limit: 1, cursor: malformedCursor }))
        .rejects.toMatchObject({ code: "analysis_population_invalid_cursor" });
      const detail = await repository.getPopulation(actor, created.population.id);
      expect(detail?.population.id).toBe(created.population.id);
      expect(detail?.overlapCount).toBe("1");
      const overlaps = await repository.listOverlaps(actor, created.population.id, { limit: 10, cursor: null });
      expect(overlaps?.totalCount).toBe("1");
      const members = await repository.listMembers(actor, created.population.id, { limit: 1, cursor: null });
      expect(members?.items).toHaveLength(1);
      expect(members?.totalCount).toBe(2);
      expect(members?.nextCursor).not.toBeNull();
      const membersTail = await repository.listMembers(actor, created.population.id, {
        limit: 1,
        cursor: members!.nextCursor
      });
      expect(membersTail?.items).toHaveLength(1);
      const exclusions = await repository.listExclusions(actor, created.population.id, { limit: 10, cursor: null });
      expect(exclusions?.totalCount).toBe("1");
      expect(exclusions?.items[0]?.ingestionPurpose).toBe("judge_api");
      const selections = await repository.listSelections(actor, created.population.id, { limit: 10, cursor: null });
      expect(selections?.items).toHaveLength(2);

      const [first, second] = await Promise.all([
        repository.getSelectedContent(actor, created.population.id, 0),
        repository.getSelectedContent(actor, created.population.id, 0)
      ]);
      expect(first).toEqual(second);
      expect(first?.populationId).toBe(created.population.id);
      const exposures = await pool.query(
        `select kind,exposure_class,activity,subject_kind,evidence_ref_kind,evidence_ref_id
         from dataset_exposure_events
         where project_id=$1 and idempotency_key like 'analysis-content-view:%'`,
        [actor.projectId]
      );
      expect(exposures.rows).toEqual([expect.objectContaining({
        kind: "human_access",
        exposure_class: "development",
        activity: "content_view",
        subject_kind: "person",
        evidence_ref_kind: "analysis_population",
        evidence_ref_id: created.population.id
      })]);

      // Cross both repository page boundaries. Full snapshots are read in
      // bounded payload pages and inserted without retaining all 1,001 JSON
      // payloads in the prepared frame.
      await seedCaseBatch(pool, {
        projectId: actor.projectId,
        suffix: "analysis_repo_scale",
        createdAt: "2026-03-10T12:00:00.000000Z",
        count: 1_001
      });
      const scaled = await repository.createPopulation(actor, {
        windowStart: "2026-03-01T00:00:00.000Z",
        windowEnd: "2026-04-01T00:00:00.000Z",
        fixedBudget: 3,
        idempotencyKey: "analysis-repo-scale"
      });
      expect(scaled.population.populationSize).toBe(1_001);
      expect(scaled.draw).toMatchObject({ fixedBudget: 3, populationSize: 1_001 });
      const scaledMembers = await repository.listMembers(actor, scaled.population.id, {
        limit: 1,
        cursor: null
      });
      expect(scaledMembers?.totalCount).toBe(1_001);

      await seedCase(pool, {
        projectId: actor.projectId,
        suffix: "analysis_repo_ambiguous_identity",
        createdAt: "2026-05-10T12:00:00.000001Z",
        purpose: "analysis_eligible_manual"
      });
      await pool.query(
        `insert into case_input_identity_records
           (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
         values ($1,$2,$3,'identity_resolved','input-identity/v1',$4)`,
        [
          "ciir_analysis_repo_ambiguous_identity_second",
          actor.projectId,
          "case_analysis_repo_ambiguous_identity",
          `sha256:${"f".repeat(64)}`
        ]
      );
      await expect(repository.createPopulation(actor, {
        windowStart: "2026-05-01T00:00:00.000Z",
        windowEnd: "2026-06-01T00:00:00.000Z",
        fixedBudget: 1,
        idempotencyKey: "analysis-repo-ambiguous-identity"
      })).rejects.toMatchObject({ code: "analysis_population_identity_unresolved" });
    });
  }, 60_000);
});
