import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { PgAnalysisMeasurementRepository } from "../src/analysis-measurement/repository.pg.js";
import { PgAnalysisPopulationRepository } from "../src/analysis-population/repository.pg.js";
import { PgAnalysisStudyRepository } from "../src/analysis-study/repository.pg.js";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { verifyAnalysisWorkflowMeasurementReport } from "../src/lib/analysis-measurement.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; analysis measurement tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

async function withSchema(body: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await openPostgresTestDatabase("analysis_measurement");
  try {
    await runMigrations(pool);
    await body(pool);
  } finally {
    await cleanup();
  }
}

async function seedProject(pool: Pool, suffix: string) {
  const organizationId = `org_${suffix}`;
  const projectId = `proj_${suffix}`;
  const ownerId = `owner_${suffix}`;
  const memberId = `member_${suffix}`;
  await pool.query(
    `insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true),($4,$5,$6,true)`,
    [ownerId, `${suffix} owner`, `${suffix}-owner@example.test`, memberId, `${suffix} member`, `${suffix}-member@example.test`]
  );
  await pool.query(`insert into organizations (id,name) values ($1,$2)`, [organizationId, suffix]);
  await pool.query(
    `insert into projects (id,organization_id,name,trace_provider) values ($1,$2,$3,'manual')`,
    [projectId, organizationId, suffix]
  );
  await pool.query(
    `insert into project_members (id,project_id,user_id,role) values ($1,$2,$3,'owner'),($4,$2,$5,'member')`,
    [`pm_owner_${suffix}`, projectId, ownerId, `pm_member_${suffix}`, memberId]
  );
  return {
    owner: { projectId, userId: ownerId, projectRole: "owner" as const },
    member: { projectId, userId: memberId, projectRole: "member" as const }
  };
}

async function seedEligibleCase(pool: Pool, projectId: string, suffix: string): Promise<void> {
  const payload = { input: { question: suffix }, output: { answer: suffix }, metadata: {} };
  await pool.query(
    `insert into raw_traces (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
     values ($1,$2,$3,$4,'manual-v1','2026-01-10T12:00:00.123456Z')`,
    [`raw_${suffix}`, projectId, `trace-${suffix}`, JSON.stringify(payload)]
  );
  await pool.query(
    `insert into cases (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
     values ($1,$2,$3,'manual',$4,'analysis_eligible_manual','2026-01-10T12:00:00.123456Z')`,
    [`case_${suffix}`, projectId, `raw_${suffix}`, JSON.stringify(payload)]
  );
  await pool.query(
    `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     values ($1,$2,$3,'authoring_import','input-identity/v1',$4)`,
    [`identity_${suffix}`, projectId, `case_${suffix}`, datasetInputIdentity({ input: payload.input }).digest]
  );
}

run("PostgreSQL analysis workflow measurements", () => {
  it("derives exact coding, coverage, and churn without requiring a criterion", async () => {
    await withSchema(async (pool) => {
      const actors = await seedProject(pool, "measurement");
      await seedEligibleCase(pool, actors.owner.projectId, "measurement");
      const populations = new PgAnalysisPopulationRepository(pool);
      const population = await populations.createPopulation(actors.owner, {
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-02-01T00:00:00.000Z",
        fixedBudget: 1,
        idempotencyKey: "measurement-frame"
      });
      const studies = new PgAnalysisStudyRepository(pool);
      const created = await studies.createStudy(actors.owner, {
        populationId: population.population.id,
        idempotencyKey: "measurement-study"
      });
      const studyId = created.study.study.id;
      await studies.openStudy(actors.owner, studyId, {
        expectedVersion: "0",
        stoppingRule: { kind: "explicit_owner_close", closeAt: null },
        idempotencyKey: "measurement-open"
      });
      const item = (await studies.listStudyItems(actors.member, studyId, { limit: 10, cursor: null }))!.items[0]!;
      await studies.getStudyItemContent(actors.member, studyId, item.item.id);
      const observed = await studies.appendStudyItemEvent(actors.member, studyId, item.item.id, {
        eventType: "failure_observed",
        expectedVersion: "0",
        failureLabel: "Wrong answer",
        rationale: "The frozen answer is wrong.",
        evidenceAnchor: { kind: "case_output" },
        idempotencyKey: "measurement-observe"
      });
      await studies.appendStudyItemEvent(actors.member, studyId, item.item.id, {
        eventType: "coding_completed",
        expectedVersion: "1",
        idempotencyKey: "measurement-complete-item"
      });
      const taxonomy = await studies.createTaxonomy(actors.owner, {
        name: "Measurement taxonomy",
        description: "Flat human-authored analysis codes.",
        reason: "Initial measurement revision.",
        codes: [{ kind: "new", clientToken: "wrong", label: "Wrong answer", definition: "The answer is incorrect." }],
        idempotencyKey: "measurement-taxonomy"
      });
      await studies.appendObservationAssignment(actors.member, taxonomy.taxonomy.id, {
        eventType: "assigned",
        observationEventId: observed.event.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        codeId: taxonomy.revision.codes[0]!.codeId,
        expectedVersion: "0",
        expectedPredecessorEventId: null,
        expectedPredecessorEventDigest: null,
        rationale: "Exact active code.",
        idempotencyKey: "measurement-assign"
      });
      const second = await studies.createTaxonomyRevision(actors.owner, taxonomy.taxonomy.id, {
        expectedPredecessorRevisionId: taxonomy.revision.revision.id,
        expectedPredecessorRevisionDigest: taxonomy.revision.revision.revisionDigest,
        expectedPredecessorSequence: 1,
        reason: "Add a second code without changing the first.",
        codes: [
          { kind: "existing", codeId: taxonomy.revision.codes[0]!.codeId, label: "Wrong answer", definition: "The answer is incorrect.", status: "active" },
          { kind: "new", clientToken: "missing", label: "Missing support", definition: "The answer lacks necessary support." }
        ],
        idempotencyKey: "measurement-taxonomy-2" // gitleaks:allow — deterministic test fixture
      });

      const measurements = new PgAnalysisMeasurementRepository(pool);
      const report = await measurements.getReport(actors.member, studyId, {
        taxonomyRevisionId: second.revision.revision.id,
        skillVersionId: null,
        calibrationArtifactId: null
      });
      expect(report).not.toBeNull();
      expect(verifyAnalysisWorkflowMeasurementReport(report!)).toEqual(report);
      expect(report).toMatchObject({
        projectId: actors.owner.projectId,
        studyId,
        coding: {
          selectedItemCount: 1,
          viewedItemCount: 1,
          inProgressItemCount: 0,
          completedItemCount: 1,
          noFailureObservedItemCount: 0,
          missingItemCount: 0
        },
        taxonomy: {
          state: "available",
          coverage: {
            activeFailureObservationCount: "1",
            categorized: "1",
            assignedToRetiredCode: "0",
            uncategorized: "0"
          },
          churn: {
            additions: 1,
            labelChanges: 0,
            definitionChanges: 0,
            retirements: 0,
            observationReassignments: 0
          }
        },
        evaluator: null
      });
      expect(JSON.stringify(report)).not.toMatch(/trusted|threshold|promote|release/i);

      expect(await measurements.getReport({ ...actors.member, projectId: "foreign" }, studyId, {
        taxonomyRevisionId: null,
        skillVersionId: null,
        calibrationArtifactId: null
      })).toBeNull();
      await expect(measurements.getReport(actors.member, studyId, {
        taxonomyRevisionId: null,
        skillVersionId: null,
        calibrationArtifactId: "artifact"
      })).rejects.toMatchObject({ code: "invalid_binding" });
    });
  }, 20_000);
});
