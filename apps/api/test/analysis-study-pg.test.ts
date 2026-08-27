import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { PgAnalysisPopulationRepository } from "../src/analysis-population/repository.pg.js";
import {
  analysisAssignmentEventDigest,
  analysisAssignmentRequestDigest,
  analysisFailureCodeContentDigest,
  analysisFailureTaxonomyContentDigest,
  analysisFailureTaxonomyRequestDigest,
  analysisStudyClosureContentDigest,
  analysisStudyClosureDigest,
  analysisStudyClosureItemContentDigest,
  analysisStudyContentDigest,
  analysisStudyEventDigest,
  analysisStudyEventRequestDigest,
  analysisStudyItemContentDigest,
  analysisStudyItemEventDigest,
  analysisStudyItemEventRequestDigest,
  analysisStudyItemViewContentDigest,
  analysisStudyItemViewRequestDigest,
  analysisStudyRequestDigest,
  analysisStudyViewSetDigest,
  analysisTaxonomyContentDigest,
  analysisTaxonomyRevisionCodeEntryDigest,
  analysisTaxonomyRevisionDigest,
  analysisTaxonomyRevisionRequestDigest,
  deriveAnalysisStudyRepresentativeAssessment
} from "../src/lib/analysis-study.js";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; analysis study PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;
const placeholderDigest = `sha256:${"0".repeat(64)}`;

async function withSchema(name: string, body: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await openPostgresTestDatabase(name);
  try {
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

async function seedEligibleCase(pool: Pool, projectId: string, suffix: string): Promise<void> {
  const payload = {
    input: { request: suffix },
    output: { response: `response-${suffix}` },
    steps: [{ name: "first", input: { prompt: suffix }, output: "ok" }],
    metadata: { retained: true }
  };
  await pool.query(
    `insert into raw_traces
       (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
     values ($1,$2,$3,$4,'manual-v1','2026-01-10T12:00:00.123456Z')`,
    [`raw_${suffix}`, projectId, `trace-${suffix}`, JSON.stringify(payload)]
  );
  await pool.query(
    `insert into cases
       (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
     values ($1,$2,$3,'manual',$4,'analysis_eligible_manual','2026-01-10T12:00:00.123456Z')`,
    [`case_${suffix}`, projectId, `raw_${suffix}`, JSON.stringify(payload)]
  );
  const identity = datasetInputIdentity({ input: payload.input });
  await pool.query(
    `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     values ($1,$2,$3,'authoring_import','input-identity/v1',$4)`,
    [`ciir_${suffix}`, projectId, `case_${suffix}`, identity.digest]
  );
}

interface StudyFixture {
  projectId: string;
  userId: string;
  subjectId: string;
  populationId: string;
  drawId: string;
  revisionId: string;
  drawItemId: string;
  memberId: string;
  revisionItemId: string;
  caseId: string;
  studyId: string;
  studyItemId: string;
}

interface TaxonomyFixture {
  taxonomyId: string;
  revisionId: string;
  revisionDigest: string;
  codeId: string;
  label: string;
  definition: string;
}

async function seedStudy(pool: Pool, suffix: string): Promise<StudyFixture> {
  const actor = await seedOwner(pool, suffix);
  await seedEligibleCase(pool, actor.projectId, suffix);
  const populationRepository = new PgAnalysisPopulationRepository(pool);
  const created = await populationRepository.createPopulation(actor, {
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-02-01T00:00:00.000Z",
    fixedBudget: 1,
    idempotencyKey: `population-${suffix}`
  });
  const lineage = (await pool.query(
    `select draw_item.id draw_item_id,draw_item.member_id,draw_item.revision_item_id,
            draw_item.case_id
     from analysis_population_draw_items draw_item where draw_item.draw_id=$1`,
    [created.draw.id]
  )).rows[0]!;
  const studyId = `study_${suffix}`;
  const studyItemId = `study_item_${suffix}`;
  const subjectId = created.population.createdBySubjectId;
  const studyRequestDigest = analysisStudyRequestDigest(actor.projectId, created.population.id);
  const studyContentDigest = analysisStudyContentDigest({
    projectId: actor.projectId,
    populationId: created.population.id,
    drawId: created.draw.id,
    datasetRevisionId: created.population.datasetRevisionId,
    contractVersion: "analysis-study/v1"
  });
  const itemContentDigest = analysisStudyItemContentDigest({
    studyId,
    drawItemId: String(lineage.draw_item_id),
    memberId: String(lineage.member_id),
    revisionItemId: String(lineage.revision_item_id),
    caseId: String(lineage.case_id),
    position: 0
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into analysis_studies
         (id,project_id,population_id,draw_id,dataset_revision_id,contract_version,
          idempotency_key,request_digest,content_digest,created_by_user_id,created_by_subject_id)
       values ($1,$2,$3,$4,$5,'analysis-study/v1',$6,$7,$8,$9,$10)`,
      [studyId, actor.projectId, created.population.id, created.draw.id,
        created.population.datasetRevisionId, `study-${suffix}`, studyRequestDigest,
        studyContentDigest, actor.userId, subjectId]
    );
    await client.query(
      `insert into analysis_study_items
         (id,project_id,study_id,draw_item_id,member_id,revision_item_id,case_id,position,content_digest)
       values ($1,$2,$3,$4,$5,$6,$7,0,$8)`,
      [studyItemId, actor.projectId, studyId, lineage.draw_item_id, lineage.member_id,
        lineage.revision_item_id, lineage.case_id, itemContentDigest]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    projectId: actor.projectId, userId: actor.userId, subjectId,
    populationId: created.population.id, drawId: created.draw.id,
    revisionId: created.population.datasetRevisionId,
    drawItemId: String(lineage.draw_item_id), memberId: String(lineage.member_id),
    revisionItemId: String(lineage.revision_item_id), caseId: String(lineage.case_id),
    studyId, studyItemId
  };
}

async function seedTaxonomy(
  pool: Pool,
  fixture: StudyFixture,
  suffix: string
): Promise<TaxonomyFixture> {
  const taxonomyId = `taxonomy_${suffix}`;
  const revisionId = `taxonomy_revision_${suffix}_1`;
  const codeId = `taxonomy_code_${suffix}`;
  const label = "Initial failure";
  const definition = "The selected result contains this initial failure mode.";
  const input = {
    name: `Taxonomy ${suffix}`,
    description: "A deterministic regression taxonomy.",
    reason: "Create the initial regression taxonomy.",
    codes: [{ kind: "new" as const, clientToken: `initial-${suffix}`, label, definition }],
    idempotencyKey: `taxonomy-${suffix}`
  };
  const requestPayload = {
    name: input.name,
    description: input.description,
    reason: input.reason,
    codes: input.codes
  };
  const requestDigest = analysisFailureTaxonomyRequestDigest(fixture.projectId, input);
  const taxonomyContentDigest = analysisFailureTaxonomyContentDigest({
    projectId: fixture.projectId,
    contractVersion: "analysis-taxonomy/v1",
    name: input.name,
    description: input.description
  });
  const codeContentDigest = analysisFailureCodeContentDigest({
    projectId: fixture.projectId,
    taxonomyId,
    codeId,
    createdInRevisionId: revisionId
  });
  const entryDigest = analysisTaxonomyRevisionCodeEntryDigest({
    taxonomyId,
    taxonomyRevisionId: revisionId,
    codeId,
    position: 0,
    label,
    definition,
    status: "active"
  });
  const revisionContentDigest = analysisTaxonomyContentDigest([entryDigest]);
  const revisionDigest = analysisTaxonomyRevisionDigest({
    taxonomyId,
    sequence: 1,
    predecessorRevisionId: null,
    predecessorRevisionDigest: null,
    reason: input.reason,
    contentDigest: revisionContentDigest
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into analysis_failure_taxonomies
         (id,project_id,contract_version,name,description,idempotency_key,
          request_payload,request_digest,content_digest,created_by_user_id,created_by_subject_id)
       values ($1,$2,'analysis-taxonomy/v1',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [taxonomyId, fixture.projectId, input.name, input.description, input.idempotencyKey,
        JSON.stringify(requestPayload), requestDigest, taxonomyContentDigest,
        fixture.userId, fixture.subjectId]
    );
    await client.query(
      `insert into analysis_failure_taxonomy_revisions
         (id,project_id,taxonomy_id,sequence,predecessor_revision_id,
          predecessor_revision_digest,code_count,reason,content_digest,revision_digest,
          created_by_user_id,created_by_subject_id,idempotency_key,request_payload,request_digest)
       values ($1,$2,$3,1,null,null,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [revisionId, fixture.projectId, taxonomyId, input.reason, revisionContentDigest,
        revisionDigest, fixture.userId, fixture.subjectId, input.idempotencyKey,
        JSON.stringify(requestPayload), requestDigest]
    );
    await client.query(
      `insert into analysis_failure_codes
         (id,project_id,taxonomy_id,created_in_revision_id,client_token,content_digest,
          created_by_user_id,created_by_subject_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [codeId, fixture.projectId, taxonomyId, revisionId, input.codes[0]!.clientToken,
        codeContentDigest, fixture.userId, fixture.subjectId]
    );
    await client.query(
      `insert into analysis_failure_taxonomy_revision_codes
         (id,project_id,taxonomy_id,taxonomy_revision_id,code_id,position,
          label,definition,status,entry_digest)
       values ($1,$2,$3,$4,$5,0,$6,$7,'active',$8)`,
      [`taxonomy_entry_${suffix}_1`, fixture.projectId, taxonomyId, revisionId,
        codeId, label, definition, entryDigest]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { taxonomyId, revisionId, revisionDigest, codeId, label, definition };
}

function taxonomySuccessorEvidence(
  fixture: StudyFixture,
  taxonomy: TaxonomyFixture,
  sequence: number,
  predecessorRevisionId: string,
  predecessorRevisionDigest: string,
  label: string,
  definition: string,
  status: "active" | "retired",
  suffix: string
) {
  const revisionId = `taxonomy_revision_${suffix}_${sequence}`;
  const input = {
    expectedPredecessorRevisionId: predecessorRevisionId,
    expectedPredecessorRevisionDigest: predecessorRevisionDigest,
    expectedPredecessorSequence: sequence - 1,
    reason: `Create taxonomy revision ${sequence}.`,
    codes: [{ kind: "existing" as const, codeId: taxonomy.codeId, label, definition, status }],
    idempotencyKey: `taxonomy-revision-${suffix}-${sequence}`
  };
  const requestPayload = {
    expectedPredecessorRevisionId: input.expectedPredecessorRevisionId,
    expectedPredecessorRevisionDigest: input.expectedPredecessorRevisionDigest,
    expectedPredecessorSequence: input.expectedPredecessorSequence,
    reason: input.reason,
    codes: input.codes
  };
  const requestDigest = analysisTaxonomyRevisionRequestDigest(taxonomy.taxonomyId, input);
  const entryDigest = analysisTaxonomyRevisionCodeEntryDigest({
    taxonomyId: taxonomy.taxonomyId,
    taxonomyRevisionId: revisionId,
    codeId: taxonomy.codeId,
    position: 0,
    label,
    definition,
    status
  });
  const contentDigest = analysisTaxonomyContentDigest([entryDigest]);
  const revisionDigest = analysisTaxonomyRevisionDigest({
    taxonomyId: taxonomy.taxonomyId,
    sequence,
    predecessorRevisionId,
    predecessorRevisionDigest,
    reason: input.reason,
    contentDigest
  });
  return {
    revisionId,
    sequence,
    predecessorRevisionId,
    predecessorRevisionDigest,
    label,
    definition,
    status,
    input,
    requestPayload,
    requestDigest,
    entryDigest,
    contentDigest,
    revisionDigest,
    fixture,
    taxonomy
  };
}

async function insertTaxonomySuccessor(
  pool: Pool,
  evidence: ReturnType<typeof taxonomySuccessorEvidence>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into analysis_failure_taxonomy_revisions
         (id,project_id,taxonomy_id,sequence,predecessor_revision_id,
          predecessor_revision_digest,code_count,reason,content_digest,revision_digest,
          created_by_user_id,created_by_subject_id,idempotency_key,request_payload,request_digest)
       values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [evidence.revisionId, evidence.fixture.projectId, evidence.taxonomy.taxonomyId,
        evidence.sequence, evidence.predecessorRevisionId, evidence.predecessorRevisionDigest,
        evidence.input.reason, evidence.contentDigest, evidence.revisionDigest,
        evidence.fixture.userId, evidence.fixture.subjectId, evidence.input.idempotencyKey,
        JSON.stringify(evidence.requestPayload), evidence.requestDigest]
    );
    await client.query(
      `insert into analysis_failure_taxonomy_revision_codes
         (id,project_id,taxonomy_id,taxonomy_revision_id,code_id,position,
          label,definition,status,entry_digest)
       values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9)`,
      [`taxonomy_entry_${evidence.revisionId}`, evidence.fixture.projectId,
        evidence.taxonomy.taxonomyId, evidence.revisionId, evidence.taxonomy.codeId,
        evidence.label, evidence.definition, evidence.status, evidence.entryDigest]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

async function pgCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

async function openStudy(
  pool: Pool | PoolClient,
  fixture: StudyFixture,
  suffix: string,
  stoppingRule: { kind: "explicit_owner_close"; closeAt: null } |
    { kind: "server_deadline"; closeAt: string }
) {
  const request = {
    studyId: fixture.studyId,
    expectedVersion: "0",
    eventType: "coding_opened" as const,
    stoppingRule
  };
  return (await pool.query(
    `insert into analysis_study_events
       (id,project_id,study_id,version,predecessor_event_id,predecessor_event_digest,
        event_type,from_state,to_state,stopping_rule,close_at,close_cause,closure_id,
        closure_digest,expected_closure_digest,reason,actor_subject_id,actor_user_id,
        actor_role,idempotency_key,request_digest,event_digest)
     values ($1,$2,$3,1,null,null,'coding_opened','draft','coding_open',$4,$5,
             null,null,null,null,null,$6,$7,'owner',$8,$9,$10)
     returning *`,
    [`study_open_${suffix}`, fixture.projectId, fixture.studyId, stoppingRule.kind,
      stoppingRule.closeAt, fixture.subjectId, fixture.userId, `open-${suffix}`,
      analysisStudyEventRequestDigest(request), placeholderDigest]
  )).rows[0]!;
}

async function seedExposure(
  pool: Pool | PoolClient,
  fixture: StudyFixture,
  suffix: string,
  userId = fixture.userId,
  subjectId = fixture.subjectId
): Promise<string> {
  const exposureId = `exposure_${suffix}`;
  await pool.query(
    `insert into dataset_exposure_events
       (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,
        subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,idempotency_key)
     values ($1,$2,$3,'human_access','development','content_view','person',$4,$5,
             'analysis_population',$6,$7)`,
    [exposureId, fixture.projectId, fixture.revisionId, subjectId, userId,
      fixture.populationId, `analysis-content-view:${fixture.revisionId}:${subjectId}`]
  );
  return exposureId;
}

run("PostgreSQL analysis studies and taxonomies", () => {
  it("clean-installs the exact study and taxonomy helper surface", async () => {
    await withSchema("analysis_study_helpers", async (pool) => {
      const client = await pool.connect();
      try {
        await runMigrations(pool);
        const installed = await client.query(
          `select to_regclass('analysis_studies') study,
                  to_regclass('analysis_study_deadline_retry_state') retry_state,
                  to_regclass('analysis_failure_taxonomy_revisions') revision,
                  to_regprocedure('analysis_study_item_projection_v1(text,timestamptz)') item_projection,
                  to_regprocedure('analysis_taxonomy_coverage_v1(text,text)') coverage,
                  to_regprocedure('analysis_record_deadline_retry_v1(text,text,text)') record_retry,
                  to_regprocedure('analysis_clear_deadline_retry_v1(text,text)') clear_retry`
        );
        expect(installed.rows[0]).toEqual({
          study: "analysis_studies",
          retry_state: "analysis_study_deadline_retry_state",
          revision: "analysis_failure_taxonomy_revisions",
          item_projection: "analysis_study_item_projection_v1(text,timestamp with time zone)",
          coverage: "analysis_taxonomy_coverage_v1(text,text)",
          record_retry: "analysis_record_deadline_retry_v1(text,text,text)",
          clear_retry: "analysis_clear_deadline_retry_v1(text,text)"
        });
      } finally {
        client.release();
      }
    });
  });

  it("freezes canonical study, coding, taxonomy, assignment, view, closure, and coverage evidence", async () => {
    await withSchema("analysis_study_lifecycle", async (pool) => {
      await runMigrations(pool);
      const fixture = await seedStudy(pool, "lifecycle");

      const openRequest = {
        studyId: fixture.studyId,
        expectedVersion: "0",
        eventType: "coding_opened" as const,
        stoppingRule: { kind: "explicit_owner_close" as const, closeAt: null }
      };
      const opened = (await pool.query(
        `insert into analysis_study_events
           (id,project_id,study_id,version,predecessor_event_id,predecessor_event_digest,
            event_type,from_state,to_state,stopping_rule,close_at,close_cause,closure_id,
            closure_digest,expected_closure_digest,reason,actor_subject_id,actor_user_id,
            actor_role,idempotency_key,request_digest,event_digest)
         values ($1,$2,$3,1,null,null,'coding_opened','draft','coding_open',
                 'explicit_owner_close',null,null,null,null,null,null,$4,$5,'owner',$6,$7,$8)
         returning *`,
        [`study_open_lifecycle`, fixture.projectId, fixture.studyId, fixture.subjectId,
          fixture.userId, "open-lifecycle", analysisStudyEventRequestDigest(openRequest), placeholderDigest]
      )).rows[0]!;
      expect(opened.event_digest).toBe(analysisStudyEventDigest({
        id: opened.id, projectId: fixture.projectId, studyId: fixture.studyId,
        version: "1", predecessorEventId: null, predecessorEventDigest: null,
        eventType: "coding_opened", fromState: "draft", toState: "coding_open",
        stoppingRule: openRequest.stoppingRule, closeCause: null, closureId: null,
        closureDigest: null, expectedClosureDigest: null, reason: null,
        actorUserId: fixture.userId, actorSubjectId: fixture.subjectId, actorRole: "owner",
        idempotencyKey: "open-lifecycle", requestDigest: opened.request_digest,
        occurredAt: iso(opened.occurred_at)
      }));

      const exposureId = "exposure_lifecycle";
      await pool.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,
            subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,idempotency_key)
         values ($1,$2,$3,'human_access','development','content_view','person',$4,$5,
                 'analysis_population',$6,$7)`,
        [exposureId, fixture.projectId, fixture.revisionId, fixture.subjectId,
          fixture.userId, fixture.populationId,
          `analysis-content-view:${fixture.revisionId}:${fixture.subjectId}`]
      );
      const viewRequestDigest = analysisStudyItemViewRequestDigest({
        projectId: fixture.projectId, studyId: fixture.studyId,
        studyItemId: fixture.studyItemId, viewerUserId: fixture.userId,
        viewerSubjectId: fixture.subjectId, datasetRevisionId: fixture.revisionId
      });
      const view = (await pool.query(
        `insert into analysis_study_item_views
           (id,project_id,study_id,study_item_id,dataset_exposure_event_id,
            viewer_user_id,viewer_subject_id,idempotency_key,request_digest,
            content_digest,counts_toward_closure)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) returning *`,
        ["study_view_lifecycle", fixture.projectId, fixture.studyId, fixture.studyItemId,
          exposureId, fixture.userId, fixture.subjectId, "view-lifecycle", viewRequestDigest,
          placeholderDigest]
      )).rows[0]!;
      expect(view.counts_toward_closure).toBe(true);
      expect(view.content_digest).toBe(analysisStudyItemViewContentDigest({
        id: view.id, projectId: fixture.projectId, studyId: fixture.studyId,
        studyItemId: fixture.studyItemId, viewerUserId: fixture.userId,
        viewerSubjectId: fixture.subjectId, datasetExposureEventId: exposureId,
        idempotencyKey: "view-lifecycle", requestDigest: viewRequestDigest,
        countsTowardClosure: true, viewedAt: iso(view.viewed_at)
      }));

      const failureInput = {
        expectedVersion: "0", idempotencyKey: "failure-lifecycle",
        eventType: "failure_observed" as const, failureLabel: "Wrong answer",
        rationale: "The frozen output is incorrect.", evidenceAnchor: { kind: "case_output" as const }
      };
      const failureRequestDigest = analysisStudyItemEventRequestDigest(
        fixture.projectId, fixture.studyId, fixture.studyItemId, failureInput
      );
      const failure = (await pool.query(
        `insert into analysis_study_item_events
           (id,project_id,study_id,study_item_id,version,predecessor_event_id,
            predecessor_event_digest,event_type,target_event_id,target_event_digest,
            failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
            actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ($1,$2,$3,$4,1,null,null,'failure_observed',null,null,$5,$6,
                 'case_output',null,$7,$8,'owner',$9,$10,$11) returning *`,
        ["failure_lifecycle", fixture.projectId, fixture.studyId, fixture.studyItemId,
          failureInput.failureLabel, failureInput.rationale, fixture.subjectId, fixture.userId,
          failureInput.idempotencyKey, failureRequestDigest, placeholderDigest]
      )).rows[0]!;
      expect(failure.event_digest).toBe(analysisStudyItemEventDigest({
        id: failure.id, projectId: fixture.projectId, studyId: fixture.studyId,
        studyItemId: fixture.studyItemId, version: "1", predecessorEventId: null,
        predecessorEventDigest: null, eventType: "failure_observed",
        failureLabel: failureInput.failureLabel, rationale: failureInput.rationale,
        evidenceAnchor: failureInput.evidenceAnchor, actorUserId: fixture.userId,
        actorSubjectId: fixture.subjectId, actorRole: "owner",
        idempotencyKey: failureInput.idempotencyKey, requestDigest: failureRequestDigest,
        occurredAt: iso(failure.occurred_at)
      }));

      const completeInput = {
        expectedVersion: "1", idempotencyKey: "complete-item-lifecycle",
        eventType: "coding_completed" as const
      };
      const completed = (await pool.query(
        `insert into analysis_study_item_events
           (id,project_id,study_id,study_item_id,version,predecessor_event_id,
            predecessor_event_digest,event_type,target_event_id,target_event_digest,
            failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
            actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ($1,$2,$3,$4,2,$5,$6,'coding_completed',null,null,null,null,null,null,
                 $7,$8,'owner',$9,$10,$11) returning *`,
        ["complete_item_lifecycle", fixture.projectId, fixture.studyId, fixture.studyItemId,
          failure.id, failure.event_digest, fixture.subjectId, fixture.userId,
          completeInput.idempotencyKey,
          analysisStudyItemEventRequestDigest(
            fixture.projectId, fixture.studyId, fixture.studyItemId, completeInput
          ), placeholderDigest]
      )).rows[0]!;
      expect(completed.event_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

      const taxonomyInput = {
        name: "Failure taxonomy", description: "Stable failure categories.",
        reason: "Create the initial coding taxonomy.",
        codes: [{ kind: "new" as const, clientToken: "wrong-answer",
          label: "Wrong answer", definition: "The answer is factually incorrect." }],
        idempotencyKey: "taxonomy-lifecycle"
      };
      const taxonomyId = "taxonomy_lifecycle";
      const taxonomyRevisionId = "taxonomy_revision_lifecycle";
      const codeId = "failure_code_lifecycle";
      const taxonomyRequestPayload = {
        name: taxonomyInput.name, description: taxonomyInput.description,
        reason: taxonomyInput.reason, codes: taxonomyInput.codes
      };
      const taxonomyRequestDigest = analysisFailureTaxonomyRequestDigest(
        fixture.projectId, taxonomyInput
      );
      const taxonomyContentDigest = analysisFailureTaxonomyContentDigest({
        projectId: fixture.projectId, contractVersion: "analysis-taxonomy/v1",
        name: taxonomyInput.name, description: taxonomyInput.description
      });
      const codeContentDigest = analysisFailureCodeContentDigest({
        projectId: fixture.projectId, taxonomyId, codeId,
        createdInRevisionId: taxonomyRevisionId
      });
      const entryDigest = analysisTaxonomyRevisionCodeEntryDigest({
        taxonomyId, taxonomyRevisionId, codeId, position: 0,
        label: taxonomyInput.codes[0]!.label,
        definition: taxonomyInput.codes[0]!.definition, status: "active"
      });
      const taxonomyRevisionContentDigest = analysisTaxonomyContentDigest([entryDigest]);
      const taxonomyRevisionDigest = analysisTaxonomyRevisionDigest({
        taxonomyId, sequence: 1, predecessorRevisionId: null,
        predecessorRevisionDigest: null, reason: taxonomyInput.reason,
        contentDigest: taxonomyRevisionContentDigest
      });
      const taxonomyClient = await pool.connect();
      try {
        await taxonomyClient.query("begin");
        await taxonomyClient.query(
          `insert into analysis_failure_taxonomies
             (id,project_id,contract_version,name,description,idempotency_key,
              request_payload,request_digest,content_digest,created_by_user_id,created_by_subject_id)
           values ($1,$2,'analysis-taxonomy/v1',$3,$4,$5,$6,$7,$8,$9,$10)`,
          [taxonomyId, fixture.projectId, taxonomyInput.name, taxonomyInput.description,
            taxonomyInput.idempotencyKey, JSON.stringify(taxonomyRequestPayload),
            taxonomyRequestDigest, taxonomyContentDigest, fixture.userId, fixture.subjectId]
        );
        await taxonomyClient.query(
          `insert into analysis_failure_taxonomy_revisions
             (id,project_id,taxonomy_id,sequence,predecessor_revision_id,
              predecessor_revision_digest,code_count,reason,content_digest,revision_digest,
              created_by_user_id,created_by_subject_id,idempotency_key,request_payload,request_digest)
           values ($1,$2,$3,1,null,null,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [taxonomyRevisionId, fixture.projectId, taxonomyId, taxonomyInput.reason,
            taxonomyRevisionContentDigest, taxonomyRevisionDigest, fixture.userId,
            fixture.subjectId, taxonomyInput.idempotencyKey,
            JSON.stringify(taxonomyRequestPayload), taxonomyRequestDigest]
        );
        await taxonomyClient.query(
          `insert into analysis_failure_codes
             (id,project_id,taxonomy_id,created_in_revision_id,client_token,content_digest,
              created_by_user_id,created_by_subject_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [codeId, fixture.projectId, taxonomyId, taxonomyRevisionId,
            taxonomyInput.codes[0]!.clientToken, codeContentDigest,
            fixture.userId, fixture.subjectId]
        );
        await taxonomyClient.query(
          `insert into analysis_failure_taxonomy_revision_codes
             (id,project_id,taxonomy_id,taxonomy_revision_id,code_id,position,
              label,definition,status,entry_digest)
           values ($1,$2,$3,$4,$5,0,$6,$7,'active',$8)`,
          ["taxonomy_entry_lifecycle", fixture.projectId, taxonomyId,
            taxonomyRevisionId, codeId, taxonomyInput.codes[0]!.label,
            taxonomyInput.codes[0]!.definition, entryDigest]
        );
        await taxonomyClient.query("commit");
      } catch (error) {
        await taxonomyClient.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        taxonomyClient.release();
      }

      const assignmentInput = {
        observationEventId: failure.id, taxonomyRevisionId,
        expectedVersion: "0", expectedPredecessorEventId: null,
        expectedPredecessorEventDigest: null, rationale: "Matches the stable category.",
        idempotencyKey: "assignment-lifecycle", eventType: "assigned" as const, codeId
      };
      const assignmentRequestDigest = analysisAssignmentRequestDigest(assignmentInput);
      const assignment = (await pool.query(
        `insert into analysis_observation_assignment_events
           (id,project_id,study_id,study_item_id,observation_event_id,version,
            predecessor_event_id,predecessor_event_digest,event_type,taxonomy_id,
            taxonomy_revision_id,taxonomy_revision_sequence,code_id,rationale,
            actor_subject_id,actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ($1,$2,$3,$4,$5,1,null,null,'assigned',$6,$7,1,$8,$9,$10,$11,
                 'owner',$12,$13,$14) returning *`,
        ["assignment_lifecycle", fixture.projectId, fixture.studyId, fixture.studyItemId,
          failure.id, taxonomyId, taxonomyRevisionId, codeId, assignmentInput.rationale,
          fixture.subjectId, fixture.userId, assignmentInput.idempotencyKey,
          assignmentRequestDigest, placeholderDigest]
      )).rows[0]!;
      expect(assignment.event_digest).toBe(analysisAssignmentEventDigest({
        id: assignment.id, projectId: fixture.projectId, taxonomyId,
        taxonomyRevisionId, taxonomyRevisionSequence: 1, studyId: fixture.studyId,
        studyItemId: fixture.studyItemId, observationEventId: failure.id,
        version: "1", predecessorEventId: null, predecessorEventDigest: null,
        eventType: "assigned", codeId, rationale: assignmentInput.rationale,
        actorUserId: fixture.userId, actorSubjectId: fixture.subjectId, actorRole: "owner",
        idempotencyKey: assignmentInput.idempotencyKey,
        requestDigest: assignmentRequestDigest, occurredAt: iso(assignment.occurred_at)
      }));

      const coverage = (await pool.query(
        `select * from analysis_taxonomy_coverage_v1($1,$2)`,
        [fixture.studyId, taxonomyRevisionId]
      )).rows[0]!;
      expect(coverage).toMatchObject({
        project_id: fixture.projectId, taxonomy_id: taxonomyId,
        active_failure_observation_count: "1", categorized: "1",
        assigned_to_retired_code: "0", uncategorized: "0"
      });

      const projection = (await pool.query(
        `select * from analysis_study_item_projection_v1($1,null)`,
        [fixture.studyItemId]
      )).rows[0]!;
      const closureItemInput = {
        studyId: fixture.studyId, studyItemId: fixture.studyItemId,
        drawItemId: fixture.drawItemId, caseId: fixture.caseId, position: 0,
        itemState: "completed" as const, itemEventVersion: String(projection.current_version),
        currentEventId: projection.current_event_id,
        currentEventDigest: projection.current_event_digest,
        viewEventIds: projection.view_event_ids,
        viewEventDigests: projection.view_event_digests,
        activeFailureObservationEventIds: projection.active_failure_observation_event_ids,
        activeFailureObservationEventDigests: projection.active_failure_observation_event_digests,
        activeFailureAssignmentEventIds: projection.active_failure_assignment_event_ids,
        activeFailureAssignmentEventDigests: projection.active_failure_assignment_event_digests,
        activeNoFailureEventId: projection.active_no_failure_event_id,
        activeNoFailureEventDigest: projection.active_no_failure_event_digest,
        completionEventId: projection.completion_event_id,
        completionEventDigest: projection.completion_event_digest
      };
      const closureItemDigest = analysisStudyClosureItemContentDigest(closureItemInput);
      const viewSetDigest = analysisStudyViewSetDigest(projection.view_event_digests);
      const closureContentDigest = analysisStudyClosureContentDigest([closureItemDigest]);
      const sourceDigests = (await pool.query(
        `select population.frame_digest,draw.draw_digest,draw.method,
                analysis_recomputed_population_frame_digest_v1(population.id) recomputed_frame_digest,
                analysis_population_draw_digest_v1(draw.id) recomputed_draw_digest
         from analysis_populations population
         join analysis_population_draws draw on draw.population_id=population.id
         where population.id=$1`,
        [fixture.populationId]
      )).rows[0]!;
      const assessment = deriveAnalysisStudyRepresentativeAssessment({
        populationId: fixture.populationId, methodEligible: true,
        frozenFrameDigest: sourceDigests.frame_digest,
        recomputedFrameDigest: sourceDigests.recomputed_frame_digest,
        frozenDrawDigest: sourceDigests.draw_digest,
        recomputedDrawDigest: sourceDigests.recomputed_draw_digest,
        selectedItemCount: 1,
        closureItems: [{ studyItemId: fixture.studyItemId, position: 0, itemState: "completed" }]
      });
      const closureClient = await pool.connect();
      let closure: Record<string, unknown>;
      let closed: Record<string, unknown>;
      try {
        await closureClient.query("begin");
        closure = (await closureClient.query(
          `insert into analysis_study_closures
             (id,project_id,study_id,population_id,draw_id,dataset_revision_id,
              stopping_rule,close_at,close_cause,close_actor_user_id,close_actor_subject_id,
              close_actor_role,close_reason,effective_closed_at,selected_item_count,
              viewed_item_count,completed_item_count,view_set_digest,assessment_version,
              method,frozen_frame_digest,recomputed_frame_digest,frozen_draw_digest,
              recomputed_draw_digest,method_eligible,frame_reproducible,draw_complete,
              coding_complete,closure_item_count,drawn_from_population_id,
              representative_of_population_id,representative_reason,assessment_digest,
              content_digest,closure_digest)
           values ($1,$2,$3,$4,$5,$6,'explicit_owner_close',null,'explicit_owner_close',
                   $7,$8,'owner',$9,now(),1,1,1,$10,'representative-assessment-time/v1',
                   $11,$12,$13,$14,$15,true,true,true,true,1,$4,$4,null,$16,$17,$18)
           returning *`,
          ["closure_lifecycle", fixture.projectId, fixture.studyId, fixture.populationId,
            fixture.drawId, fixture.revisionId, fixture.userId, fixture.subjectId,
            "Owner completed coding.", viewSetDigest, sourceDigests.method,
            sourceDigests.frame_digest, sourceDigests.recomputed_frame_digest,
            sourceDigests.draw_digest, sourceDigests.recomputed_draw_digest,
            placeholderDigest, closureContentDigest, placeholderDigest]
        )).rows[0]!;
        await closureClient.query(
          `insert into analysis_study_closure_items
             (id,project_id,study_id,closure_id,study_item_id,draw_item_id,case_id,
              position,item_state,item_event_version,current_event_id,current_event_digest,
              active_failure_observation_event_ids,active_failure_observation_event_digests,
              active_failure_assignment_event_ids,active_failure_assignment_event_digests,
              active_no_failure_event_id,active_no_failure_event_digest,completion_event_id,
              completion_event_digest,view_event_ids,view_event_digests,content_digest)
           values ($1,$2,$3,$4,$5,$6,$7,0,'completed',$8,$9,$10,$11,$12,$13,$14,
                   $15,$16,$17,$18,$19,$20,$21)`,
          ["closure_item_lifecycle", fixture.projectId, fixture.studyId, closure.id,
            fixture.studyItemId, fixture.drawItemId, fixture.caseId,
            projection.current_version, projection.current_event_id,
            projection.current_event_digest, projection.active_failure_observation_event_ids,
            projection.active_failure_observation_event_digests,
            projection.active_failure_assignment_event_ids,
            projection.active_failure_assignment_event_digests,
            projection.active_no_failure_event_id, projection.active_no_failure_event_digest,
            projection.completion_event_id, projection.completion_event_digest,
            projection.view_event_ids, projection.view_event_digests, closureItemDigest]
        );
        const closeRequestDigest = analysisStudyEventRequestDigest({
          studyId: fixture.studyId, expectedVersion: "1",
          eventType: "coding_closed", reason: "Owner completed coding."
        });
        closed = (await closureClient.query(
          `insert into analysis_study_events
             (id,project_id,study_id,version,predecessor_event_id,predecessor_event_digest,
              event_type,from_state,to_state,stopping_rule,close_at,close_cause,closure_id,
              closure_digest,expected_closure_digest,reason,actor_subject_id,actor_user_id,
              actor_role,idempotency_key,request_digest,event_digest)
           values ($1,$2,$3,2,$4,$5,'coding_closed','coding_open','coding_closed',null,null,
                   'explicit_owner_close',$6,$7,null,$8,$9,$10,'owner',$11,$12,$13)
           returning *`,
          ["study_closed_lifecycle", fixture.projectId, fixture.studyId, opened.id,
            opened.event_digest, closure.id, closure.closure_digest,
            "Owner completed coding.", fixture.subjectId, fixture.userId,
            "close-lifecycle", closeRequestDigest, placeholderDigest]
        )).rows[0]!;
        await closureClient.query("commit");
      } catch (error) {
        await closureClient.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        closureClient.release();
      }
      expect(iso(closed!.occurred_at)).toBe(iso(closure!.recorded_at));
      expect(closure!.assessment_digest).toBe(assessment.assessmentDigest);
      expect(closure!.closure_digest).toBe(analysisStudyClosureDigest({
        studyId: fixture.studyId, populationId: fixture.populationId,
        drawId: fixture.drawId, datasetRevisionId: fixture.revisionId,
        stoppingRule: { kind: "explicit_owner_close", closeAt: null },
        closeCause: "explicit_owner_close", closeActorUserId: fixture.userId,
        closeActorSubjectId: fixture.subjectId, closeActorRole: "owner",
        closeReason: "Owner completed coding.",
        effectiveClosedAt: iso(closure!.effective_closed_at), recordedAt: iso(closure!.recorded_at),
        selectedItemCount: 1, viewedItemCount: 1, completedItemCount: 1,
        viewSetDigest, assessmentVersion: "representative-assessment-time/v1",
        method: sourceDigests.method, frozenFrameDigest: sourceDigests.frame_digest,
        recomputedFrameDigest: sourceDigests.recomputed_frame_digest,
        frozenDrawDigest: sourceDigests.draw_digest,
        recomputedDrawDigest: sourceDigests.recomputed_draw_digest,
        methodEligible: true, frameReproducible: true, drawComplete: true,
        codingComplete: true, closureItemCount: 1,
        drawnFromPopulationId: fixture.populationId,
        representativeOfPopulationId: fixture.populationId, representativeReason: null,
        assessmentDigest: assessment.assessmentDigest, contentDigest: closureContentDigest
      }));
      expect(closed!.event_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

      const lateUserId = "user_lifecycle_late";
      const lateSubjectId = "subject_lifecycle_late";
      await pool.query(
        `insert into "user" (id,name,email,email_verified) values ($1,'Late viewer',$2,true)`,
        [lateUserId, "late-viewer@example.test"]
      );
      await pool.query(
        `insert into project_members (id,project_id,user_id,role)
         values ('pm_lifecycle_late',$1,$2,'member')`,
        [fixture.projectId, lateUserId]
      );
      await pool.query(
        `insert into governed_reviewer_subjects
           (id,project_id,account_user_id,subject_digest)
         values ($1,$2,$3,governed_content_v1_digest(
           'governed-reviewer-subject/v1',jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
         ))`,
        [lateSubjectId, fixture.projectId, lateUserId]
      );
      const lateExposureId = "exposure_lifecycle_late";
      await pool.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,
            subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,idempotency_key)
         values ($1,$2,$3,'human_access','development','content_view','person',$4,$5,
                 'analysis_population',$6,$7)`,
        [lateExposureId, fixture.projectId, fixture.revisionId, lateSubjectId,
          lateUserId, fixture.populationId,
          `analysis-content-view:${fixture.revisionId}:${lateSubjectId}`]
      );
      const lateViewRequest = analysisStudyItemViewRequestDigest({
        projectId: fixture.projectId, studyId: fixture.studyId,
        studyItemId: fixture.studyItemId, viewerUserId: lateUserId,
        viewerSubjectId: lateSubjectId, datasetRevisionId: fixture.revisionId
      });
      const lateView = (await pool.query(
        `insert into analysis_study_item_views
           (id,project_id,study_id,study_item_id,dataset_exposure_event_id,
            viewer_user_id,viewer_subject_id,idempotency_key,request_digest,
            content_digest,counts_toward_closure)
         values ('study_view_lifecycle_late',$1,$2,$3,$4,$5,$6,'view-lifecycle-late',
                 $7,$8,true) returning *`,
        [fixture.projectId, fixture.studyId, fixture.studyItemId, lateExposureId,
          lateUserId, lateSubjectId, lateViewRequest, placeholderDigest]
      )).rows[0]!;
      expect(lateView.counts_toward_closure).toBe(false);
      const afterLateView = (await pool.query(
        `select viewed_item_count,view_set_digest,closure_digest
         from analysis_study_closures where id=$1`,
        [closure!.id]
      )).rows[0]!;
      expect(afterLateView).toEqual({
        viewed_item_count: 1,
        view_set_digest: closure!.view_set_digest,
        closure_digest: closure!.closure_digest
      });

      const appendOnlyRelations = [
        "analysis_studies", "analysis_study_items", "analysis_study_events",
        "analysis_study_item_events", "analysis_study_closures",
        "analysis_study_closure_items", "analysis_study_item_views",
        "analysis_failure_taxonomies", "analysis_failure_codes",
        "analysis_failure_taxonomy_revisions",
        "analysis_failure_taxonomy_revision_codes",
        "analysis_observation_assignment_events"
      ];
      for (const relation of appendOnlyRelations) {
        const id = String((await pool.query(`select id from ${relation} limit 1`)).rows[0]!.id);
        await pgCode(pool.query(`update ${relation} set id=id where id=$1`, [id]), "55000");
        await pgCode(pool.query(`delete from ${relation} where id=$1`, [id]), "55000");
      }
      await pool.query(`delete from projects where id=$1`, [fixture.projectId]);
      for (const relation of appendOnlyRelations) {
        expect((await pool.query(`select count(*)::integer count from ${relation}`)).rows[0]!.count).toBe(0);
      }
    });
  });

  it("keeps taxonomy successors nonbranching and makes retirement status-only", async () => {
    await withSchema("analysis_taxonomy_successor", async (pool) => {
      await runMigrations(pool);
      const fixture = await seedStudy(pool, "taxonomy_successor");
      const taxonomy = await seedTaxonomy(pool, fixture, "taxonomy_successor");
      const activeEdit = taxonomySuccessorEvidence(
        fixture,
        taxonomy,
        2,
        taxonomy.revisionId,
        taxonomy.revisionDigest,
        "Edited active failure",
        "Active taxonomy entries may change before retirement.",
        "active",
        "taxonomy_successor"
      );
      const insertRevision = (executor: Pool | PoolClient, id = activeEdit.revisionId) =>
        executor.query(
          `insert into analysis_failure_taxonomy_revisions
             (id,project_id,taxonomy_id,sequence,predecessor_revision_id,
              predecessor_revision_digest,code_count,reason,content_digest,revision_digest,
              created_by_user_id,created_by_subject_id,idempotency_key,request_payload,request_digest)
           values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, fixture.projectId, taxonomy.taxonomyId, activeEdit.sequence,
            activeEdit.predecessorRevisionId, activeEdit.predecessorRevisionDigest,
            activeEdit.input.reason, activeEdit.contentDigest, activeEdit.revisionDigest,
            fixture.userId, fixture.subjectId, activeEdit.input.idempotencyKey,
            JSON.stringify(activeEdit.requestPayload), activeEdit.requestDigest]
        );
      const winner = await pool.connect();
      try {
        await winner.query("begin");
        await winner.query(`select analysis_taxonomy_lock_v1($1)`, [taxonomy.taxonomyId]);
        await insertRevision(winner);
        await winner.query(
          `insert into analysis_failure_taxonomy_revision_codes
             (id,project_id,taxonomy_id,taxonomy_revision_id,code_id,position,
              label,definition,status,entry_digest)
           values ($1,$2,$3,$4,$5,0,$6,$7,'active',$8)`,
          [`taxonomy_entry_${activeEdit.revisionId}`, fixture.projectId,
            taxonomy.taxonomyId, activeEdit.revisionId, taxonomy.codeId,
            activeEdit.label, activeEdit.definition, activeEdit.entryDigest]
        );
        const replay = pgCode(insertRevision(pool, `${activeEdit.revisionId}_replay`), "23505");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await winner.query("commit");
        await replay;
      } finally {
        await winner.query("rollback").catch(() => undefined);
        winner.release();
      }
      expect((await pool.query(
        `select label,definition,status from analysis_failure_taxonomy_revision_codes
         where taxonomy_revision_id=$1`,
        [activeEdit.revisionId]
      )).rows[0]).toEqual({
        label: activeEdit.label,
        definition: activeEdit.definition,
        status: "active"
      });

      const retireWithEdit = taxonomySuccessorEvidence(
        fixture,
        taxonomy,
        3,
        activeEdit.revisionId,
        activeEdit.revisionDigest,
        "Edited while retiring",
        activeEdit.definition,
        "retired",
        "taxonomy_retire_edit"
      );
      await pgCode(insertTaxonomySuccessor(pool, retireWithEdit), "23514");

      const retired = taxonomySuccessorEvidence(
        fixture,
        taxonomy,
        3,
        activeEdit.revisionId,
        activeEdit.revisionDigest,
        activeEdit.label,
        activeEdit.definition,
        "retired",
        "taxonomy_retired"
      );
      await insertTaxonomySuccessor(pool, retired);
      const unretire = taxonomySuccessorEvidence(
        fixture,
        taxonomy,
        4,
        retired.revisionId,
        retired.revisionDigest,
        activeEdit.label,
        activeEdit.definition,
        "active",
        "taxonomy_unretire"
      );
      await pgCode(insertTaxonomySuccessor(pool, unretire), "23514");

      await pgCode(pool.query(
        `insert into analysis_failure_taxonomy_revision_codes
           (id,project_id,taxonomy_id,taxonomy_revision_id,code_id,position,
            label,definition,status,entry_digest,created_at)
         select 'taxonomy_entry_post_commit',$1,$2,$3,$4,1,label,definition,status,
                entry_digest,created_at
         from analysis_failure_taxonomy_revision_codes
         where taxonomy_revision_id=$3 and code_id=$4`,
        [fixture.projectId, taxonomy.taxonomyId, retired.revisionId, taxonomy.codeId]
      ), "23514");
    });
  });

  it("serializes assignment replay after both locks and preserves one observation head", async () => {
    await withSchema("analysis_assignment_race", async (pool) => {
      await runMigrations(pool);
      const fixture = await seedStudy(pool, "assignment_race");
      await openStudy(pool, fixture, "assignment_race", {
        kind: "explicit_owner_close", closeAt: null
      });
      const failureInput = {
        expectedVersion: "0",
        idempotencyKey: "assignment-race-failure",
        eventType: "failure_observed" as const,
        failureLabel: "Assignment race",
        rationale: "This observation receives one concurrent assignment.",
        evidenceAnchor: { kind: "case_output" as const }
      };
      const failure = (await pool.query(
        `insert into analysis_study_item_events
           (id,project_id,study_id,study_item_id,version,predecessor_event_id,
            predecessor_event_digest,event_type,target_event_id,target_event_digest,
            failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
            actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ('assignment_race_failure',$1,$2,$3,1,null,null,'failure_observed',
                 null,null,$4,$5,'case_output',null,$6,$7,'owner',$8,$9,$10)
         returning *`,
        [fixture.projectId, fixture.studyId, fixture.studyItemId,
          failureInput.failureLabel, failureInput.rationale, fixture.subjectId,
          fixture.userId, failureInput.idempotencyKey,
          analysisStudyItemEventRequestDigest(
            fixture.projectId, fixture.studyId, fixture.studyItemId, failureInput
          ), placeholderDigest]
      )).rows[0]!;
      const taxonomy = await seedTaxonomy(pool, fixture, "assignment_race");
      const assignmentInput = {
        observationEventId: failure.id,
        taxonomyRevisionId: taxonomy.revisionId,
        expectedVersion: "0",
        expectedPredecessorEventId: null,
        expectedPredecessorEventDigest: null,
        rationale: "Use the initial stable code.",
        idempotencyKey: "assignment-race-key",
        eventType: "assigned" as const,
        codeId: taxonomy.codeId
      };
      const requestDigest = analysisAssignmentRequestDigest(assignmentInput);
      const insertAssignment = (executor: Pool | PoolClient, id: string) => executor.query(
        `insert into analysis_observation_assignment_events
           (id,project_id,study_id,study_item_id,observation_event_id,version,
            predecessor_event_id,predecessor_event_digest,event_type,taxonomy_id,
            taxonomy_revision_id,taxonomy_revision_sequence,code_id,rationale,
            actor_subject_id,actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ($1,$2,$3,$4,$5,1,null,null,'assigned',$6,$7,1,$8,$9,$10,$11,
                 'owner',$12,$13,$14)`,
        [id, fixture.projectId, fixture.studyId, fixture.studyItemId, failure.id,
          taxonomy.taxonomyId, taxonomy.revisionId, taxonomy.codeId,
          assignmentInput.rationale, fixture.subjectId, fixture.userId,
          assignmentInput.idempotencyKey, requestDigest, placeholderDigest]
      );
      const winner = await pool.connect();
      try {
        await winner.query("begin");
        await winner.query(`select analysis_study_lock_v1($1)`, [fixture.studyId]);
        await winner.query(`select analysis_taxonomy_lock_v1($1)`, [taxonomy.taxonomyId]);
        await insertAssignment(winner, "assignment_race_winner");
        const replay = pgCode(insertAssignment(pool, "assignment_race_replay"), "23505");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await winner.query("commit");
        await replay;
      } finally {
        await winner.query("rollback").catch(() => undefined);
        winner.release();
      }
      expect((await pool.query(
        `select count(*)::integer count from analysis_observation_assignment_events
         where observation_event_id=$1`,
        [failure.id]
      )).rows[0]!.count).toBe(1);
      const conflictingInput = {
        ...assignmentInput,
        rationale: "A different command body with the same key."
      };
      await pgCode(pool.query(
        `insert into analysis_observation_assignment_events
           (id,project_id,study_id,study_item_id,observation_event_id,version,
            predecessor_event_id,predecessor_event_digest,event_type,taxonomy_id,
            taxonomy_revision_id,taxonomy_revision_sequence,code_id,rationale,
            actor_subject_id,actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ('assignment_race_conflict',$1,$2,$3,$4,1,null,null,'assigned',$5,$6,1,
                 $7,$8,$9,$10,'owner',$11,$12,$13)`,
        [fixture.projectId, fixture.studyId, fixture.studyItemId, failure.id,
          taxonomy.taxonomyId, taxonomy.revisionId, taxonomy.codeId,
          conflictingInput.rationale, fixture.subjectId, fixture.userId,
          conflictingInput.idempotencyKey,
          analysisAssignmentRequestDigest(conflictingInput), placeholderDigest]
      ), "23514");
    });
  });

  it("fails frame recomputation closed when retained lineage or identity is ambiguous", async () => {
    await withSchema("analysis_recompute_fail_closed", async (pool) => {
      await runMigrations(pool);
      const missingLineage = await seedStudy(pool, "missing_lineage");
      expect((await pool.query(
        `select analysis_recomputed_population_frame_digest_v1($1) digest`,
        [missingLineage.populationId]
      )).rows[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      await pool.query(`delete from cases where id=$1 and project_id=$2`, [
        missingLineage.caseId,
        missingLineage.projectId
      ]);
      await pool.query(`delete from raw_traces where id=$1 and project_id=$2`, [
        `raw_missing_lineage`,
        missingLineage.projectId
      ]);
      expect((await pool.query(
        `select analysis_recomputed_population_frame_digest_v1($1) digest`,
        [missingLineage.populationId]
      )).rows[0]!.digest).toBeNull();

      const ambiguousIdentity = await seedStudy(pool, "ambiguous_identity");
      const digest = (await pool.query(
        `select input_digest from case_input_identity_records
         where project_id=$1 and source_case_id=$2 and record_kind='authoring_import'`,
        [ambiguousIdentity.projectId, ambiguousIdentity.caseId]
      )).rows[0]!.input_digest;
      await pool.query(
        `insert into case_input_identity_records
           (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
         values ('ciir_ambiguous_identity_second',$1,$2,'identity_resolved',
                 'input-identity/v1',$3)`,
        [ambiguousIdentity.projectId, ambiguousIdentity.caseId, digest]
      );
      expect((await pool.query(
        `select analysis_recomputed_population_frame_digest_v1($1) digest`,
        [ambiguousIdentity.populationId]
      )).rows[0]!.digest).toBeNull();
    });
  });

  it("rejects direct digest tampering and truncated closure evidence", async () => {
    await withSchema("analysis_direct_tamper", async (pool) => {
      await runMigrations(pool);
      const fixture = await seedStudy(pool, "direct_tamper");
      await openStudy(pool, fixture, "direct_tamper", {
        kind: "explicit_owner_close", closeAt: null
      });
      await pgCode(pool.query(
        `insert into analysis_study_item_events
           (id,project_id,study_id,study_item_id,version,predecessor_event_id,
            predecessor_event_digest,event_type,target_event_id,target_event_digest,
            failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
            actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ('failure_direct_tamper',$1,$2,$3,1,null,null,'failure_observed',
                 null,null,'Tampered request','The request digest is not canonical.',
                 'case_output',null,$4,$5,'owner','failure-direct-tamper',$6,$6)`,
        [fixture.projectId, fixture.studyId, fixture.studyItemId,
          fixture.subjectId, fixture.userId, placeholderDigest]
      ), "23514");
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_item_events where study_id=$1`,
        [fixture.studyId]
      )).rows[0]!.count).toBe(0);

      const source = (await pool.query(
        `select population.frame_digest,draw.draw_digest,draw.method,
                analysis_recomputed_population_frame_digest_v1(population.id)
                  recomputed_frame_digest,
                analysis_population_draw_digest_v1(draw.id) recomputed_draw_digest
         from analysis_populations population
         join analysis_population_draws draw on draw.population_id=population.id
         where population.id=$1`,
        [fixture.populationId]
      )).rows[0]!;
      await pgCode(pool.query(
        `insert into analysis_study_closures
           (id,project_id,study_id,population_id,draw_id,dataset_revision_id,
            stopping_rule,close_at,close_cause,close_actor_user_id,close_actor_subject_id,
            close_actor_role,close_reason,effective_closed_at,selected_item_count,
            viewed_item_count,completed_item_count,view_set_digest,assessment_version,
            method,frozen_frame_digest,recomputed_frame_digest,frozen_draw_digest,
            recomputed_draw_digest,method_eligible,frame_reproducible,draw_complete,
            coding_complete,closure_item_count,drawn_from_population_id,
            representative_of_population_id,representative_reason,assessment_digest,
            content_digest,closure_digest)
         values ('closure_direct_tamper',$1,$2,$3,$4,$5,'explicit_owner_close',null,
                 'explicit_owner_close',$6,$7,'owner','Attempt a truncated closure.',now(),
                 1,0,0,$8,'representative-assessment-time/v1',$9,$10,$11,$12,$13,
                 true,true,true,false,1,$3,null,'coding_not_complete',$14,$14,$14)`,
        [fixture.projectId, fixture.studyId, fixture.populationId, fixture.drawId,
          fixture.revisionId, fixture.userId, fixture.subjectId,
          analysisStudyViewSetDigest([]), source.method, source.frame_digest,
          source.recomputed_frame_digest, source.draw_digest, source.recomputed_draw_digest,
          placeholderDigest]
      ), "23514");
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_closures where study_id=$1`,
        [fixture.studyId]
      )).rows[0]!.count).toBe(0);
    });
  });

  it("serializes same-key study and item event races before CAS/deadline checks", async () => {
    await withSchema("analysis_study_event_race", async (pool) => {
      await runMigrations(pool);

      const itemFixture = await seedStudy(pool, "item_race");
      await openStudy(pool, itemFixture, "item_race", {
        kind: "explicit_owner_close", closeAt: null
      });
      const failureInput = {
        expectedVersion: "0", idempotencyKey: "failure-race-key",
        eventType: "failure_observed" as const, failureLabel: "Race failure",
        rationale: "Both commands have the same canonical body.",
        evidenceAnchor: { kind: "case_output" as const }
      };
      const failureRequestDigest = analysisStudyItemEventRequestDigest(
        itemFixture.projectId, itemFixture.studyId, itemFixture.studyItemId, failureInput
      );
      const insertFailure = (id: string, executor: Pool | PoolClient) => executor.query(
        `insert into analysis_study_item_events
           (id,project_id,study_id,study_item_id,version,predecessor_event_id,
            predecessor_event_digest,event_type,target_event_id,target_event_digest,
            failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
            actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ($1,$2,$3,$4,1,null,null,'failure_observed',null,null,$5,$6,
                 'case_output',null,$7,$8,'owner',$9,$10,$11) returning id,event_digest`,
        [id, itemFixture.projectId, itemFixture.studyId, itemFixture.studyItemId,
          failureInput.failureLabel, failureInput.rationale, itemFixture.subjectId,
          itemFixture.userId, failureInput.idempotencyKey, failureRequestDigest,
          placeholderDigest]
      );
      const winner = await pool.connect();
      try {
        await winner.query("begin");
        await winner.query(`select analysis_study_lock_v1($1)`, [itemFixture.studyId]);
        await insertFailure("failure_race_winner", winner);
        const replay = pgCode(insertFailure("failure_race_replay", pool), "23505");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await winner.query("commit");
        await replay;
      } finally {
        await winner.query("rollback").catch(() => undefined);
        winner.release();
      }
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_item_events where study_item_id=$1`,
        [itemFixture.studyItemId]
      )).rows[0]!.count).toBe(1);
      await pgCode(insertFailure("failure_race_conflict", pool).then(async (result) => result), "23505");
      await pgCode(pool.query(
        `insert into analysis_study_item_events
           (id,project_id,study_id,study_item_id,version,predecessor_event_id,
            predecessor_event_digest,event_type,target_event_id,target_event_digest,
            failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
            actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
         values ('failure_race_bad_request',$1,$2,$3,1,null,null,'failure_observed',
                 null,null,'Race failure','Different request.','case_output',null,
                 $4,$5,'owner','failure-race-key',$6,$7)`,
        [itemFixture.projectId, itemFixture.studyId, itemFixture.studyItemId,
          itemFixture.subjectId, itemFixture.userId, placeholderDigest, placeholderDigest]
      ), "23514");

      const studyFixture = await seedStudy(pool, "study_race");
      const opened = await openStudy(pool, studyFixture, "study_race", {
        kind: "explicit_owner_close", closeAt: null
      });
      const abandonRequest = analysisStudyEventRequestDigest({
        studyId: studyFixture.studyId, expectedVersion: "1",
        eventType: "study_abandoned", reason: "No longer needed."
      });
      const insertAbandon = (id: string, executor: Pool | PoolClient) => executor.query(
        `insert into analysis_study_events
           (id,project_id,study_id,version,predecessor_event_id,predecessor_event_digest,
            event_type,from_state,to_state,stopping_rule,close_at,close_cause,closure_id,
            closure_digest,expected_closure_digest,reason,actor_subject_id,actor_user_id,
            actor_role,idempotency_key,request_digest,event_digest)
         values ($1,$2,$3,2,$4,$5,'study_abandoned','coding_open','abandoned',null,
                 null,null,null,null,null,'No longer needed.',$6,$7,'owner',
                 'abandon-race-key',$8,$9)`,
        [id, studyFixture.projectId, studyFixture.studyId, opened.id, opened.event_digest,
          studyFixture.subjectId, studyFixture.userId, abandonRequest, placeholderDigest]
      );
      const studyWinner = await pool.connect();
      try {
        await studyWinner.query("begin");
        await studyWinner.query(`select analysis_study_lock_v1($1)`, [studyFixture.studyId]);
        await insertAbandon("abandon_race_winner", studyWinner);
        const replay = pgCode(insertAbandon("abandon_race_replay", pool), "23505");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await studyWinner.query("commit");
        await replay;
      } finally {
        await studyWinner.query("rollback").catch(() => undefined);
        studyWinner.release();
      }
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_events where study_id=$1`,
        [studyFixture.studyId]
      )).rows[0]!.count).toBe(2);
    });
  });

  it("samples the wall clock after the study lock and rejects pre-started overdue mutations", async () => {
    await withSchema("analysis_study_deadline_race", async (pool) => {
      await runMigrations(pool);
      const fixture = await seedStudy(pool, "deadline_race");
      const closeAt = new Date(Date.now() + 700).toISOString();
      const opened = await openStudy(pool, fixture, "deadline_race", {
        kind: "server_deadline", closeAt
      });
      const exposureId = await seedExposure(pool, fixture, "deadline_race");
      const failureInput = {
        expectedVersion: "0", idempotencyKey: "failure-deadline-race",
        eventType: "failure_observed" as const, failureLabel: "Too late",
        rationale: "This transaction began before the deadline.",
        evidenceAnchor: { kind: "case_output" as const }
      };
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query(`select analysis_study_lock_v1($1)`, [fixture.studyId]);
        const lateFailure = pool.query(
          `insert into analysis_study_item_events
             (id,project_id,study_id,study_item_id,version,predecessor_event_id,
              predecessor_event_digest,event_type,target_event_id,target_event_digest,
              failure_label,rationale,anchor_kind,anchor_step_index,actor_subject_id,
              actor_user_id,actor_role,idempotency_key,request_digest,event_digest)
           values ('failure_deadline_race',$1,$2,$3,1,null,null,'failure_observed',
                   null,null,$4,$5,'case_output',null,$6,$7,'owner',$8,$9,$10)`,
          [fixture.projectId, fixture.studyId, fixture.studyItemId,
            failureInput.failureLabel, failureInput.rationale, fixture.subjectId,
            fixture.userId, failureInput.idempotencyKey,
            analysisStudyItemEventRequestDigest(
              fixture.projectId, fixture.studyId, fixture.studyItemId, failureInput
            ), placeholderDigest]
        );
        const lateAbandon = pool.query(
          `insert into analysis_study_events
             (id,project_id,study_id,version,predecessor_event_id,predecessor_event_digest,
              event_type,from_state,to_state,stopping_rule,close_at,close_cause,closure_id,
              closure_digest,expected_closure_digest,reason,actor_subject_id,actor_user_id,
              actor_role,idempotency_key,request_digest,event_digest)
           values ('abandon_deadline_race',$1,$2,2,$3,$4,'study_abandoned',
                   'coding_open','abandoned',null,null,null,null,null,null,'Too late.',
                   $5,$6,'owner','abandon-deadline-race',$7,$8)`,
          [fixture.projectId, fixture.studyId, opened.id, opened.event_digest,
            fixture.subjectId, fixture.userId,
            analysisStudyEventRequestDigest({
              studyId: fixture.studyId, expectedVersion: "1",
              eventType: "study_abandoned", reason: "Too late."
            }), placeholderDigest]
        );
        const viewRequest = analysisStudyItemViewRequestDigest({
          projectId: fixture.projectId, studyId: fixture.studyId,
          studyItemId: fixture.studyItemId, viewerUserId: fixture.userId,
          viewerSubjectId: fixture.subjectId, datasetRevisionId: fixture.revisionId
        });
        const lateView = pool.query(
          `insert into analysis_study_item_views
             (id,project_id,study_id,study_item_id,dataset_exposure_event_id,
              viewer_user_id,viewer_subject_id,idempotency_key,request_digest,
              content_digest,counts_toward_closure)
           values ('view_deadline_race',$1,$2,$3,$4,$5,$6,'view-deadline-race',
                   $7,$8,true)`,
          [fixture.projectId, fixture.studyId, fixture.studyItemId, exposureId,
            fixture.userId, fixture.subjectId, viewRequest, placeholderDigest]
        );
        const remaining = Math.max(0, Date.parse(closeAt) - Date.now() + 75);
        await new Promise((resolve) => setTimeout(resolve, remaining));
        await blocker.query("commit");
        const outcomes = await Promise.allSettled([lateFailure, lateAbandon, lateView]);
        expect(outcomes).toHaveLength(3);
        for (const outcome of outcomes) {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "23514" });
        }
      } finally {
        await blocker.query("rollback").catch(() => undefined);
        blocker.release();
      }
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_item_events where study_id=$1`,
        [fixture.studyId]
      )).rows[0]!.count).toBe(0);
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_item_views where study_id=$1`,
        [fixture.studyId]
      )).rows[0]!.count).toBe(0);
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_events where study_id=$1`,
        [fixture.studyId]
      )).rows[0]!.count).toBe(1);
    });
  }, 15_000);

  it("persists bounded deadline retry backoff without joining the immutable evidence graph", async () => {
    await withSchema("analysis_deadline_retry", async (pool) => {
      await runMigrations(pool);
      const fixture = await seedStudy(pool, "deadline_retry");
      const closeAt = new Date(Date.now() + 200).toISOString();
      await openStudy(pool, fixture, "deadline_retry", {
        kind: "server_deadline", closeAt
      });
      const foreign = await seedOwner(pool, "deadline_retry_foreign");
      const holder = await pool.connect();
      const foreignCaller = await pool.connect();
      try {
        await holder.query("begin");
        await holder.query(`select analysis_study_lock_v1($1)`, [fixture.studyId]);
        await foreignCaller.query("begin");
        await foreignCaller.query(`set local lock_timeout='100ms'`);
        expect((await foreignCaller.query(
          `select analysis_clear_deadline_retry_v1($1,$2) cleared`,
          [foreign.projectId, fixture.studyId]
        )).rows[0]!.cleared).toBe(false);
        await foreignCaller.query("commit");
      } finally {
        await foreignCaller.query("rollback").catch(() => undefined);
        await holder.query("rollback").catch(() => undefined);
        foreignCaller.release();
        holder.release();
      }
      await pgCode(pool.query(
        `select * from analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
        [fixture.projectId, fixture.studyId]
      ), "23514");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await pgCode(pool.query(
        `select * from analysis_record_deadline_retry_v1($1,$2,'unbounded_message')`,
        [fixture.projectId, fixture.studyId]
      ), "23514");
      await pgCode(pool.query(
        `select * from analysis_record_deadline_retry_v1('wrong_project',$1,'closure_failed')`,
        [fixture.studyId]
      ), "23514");
      const first = (await pool.query(
        `select * from analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
        [fixture.projectId, fixture.studyId]
      )).rows[0]!;
      expect(first).toMatchObject({
        study_id: fixture.studyId,
        project_id: fixture.projectId,
        failure_count: 1,
        last_error_code: "closure_failed"
      });
      expect(Date.parse(first.next_retry_at) - Date.parse(first.last_failed_at)).toBe(5_000);
      const second = (await pool.query(
        `select * from analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
        [fixture.projectId, fixture.studyId]
      )).rows[0]!;
      expect(second.failure_count).toBe(2);
      expect(Date.parse(second.next_retry_at) - Date.parse(second.last_failed_at)).toBe(10_000);

      await pool.query(
        `update analysis_study_deadline_retry_state set failure_count=1000000
         where project_id=$1 and study_id=$2`,
        [fixture.projectId, fixture.studyId]
      );
      const saturated = (await pool.query(
        `select * from analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
        [fixture.projectId, fixture.studyId]
      )).rows[0]!;
      expect(saturated.failure_count).toBe(1_000_000);
      expect(Date.parse(saturated.next_retry_at) - Date.parse(saturated.last_failed_at)).toBe(3_600_000);

      expect((await pool.query(
        `select analysis_clear_deadline_retry_v1($1,$2) cleared`,
        [fixture.projectId, fixture.studyId]
      )).rows[0]!.cleared).toBe(true);
      expect((await pool.query(
        `select analysis_clear_deadline_retry_v1($1,$2) cleared`,
        [fixture.projectId, fixture.studyId]
      )).rows[0]!.cleared).toBe(false);
      await pool.query(
        `select * from analysis_record_deadline_retry_v1($1,$2,'closure_failed')`,
        [fixture.projectId, fixture.studyId]
      );
      await pool.query(`delete from projects where id=$1`, [fixture.projectId]);
      expect((await pool.query(
        `select count(*)::integer count from analysis_study_deadline_retry_state`
      )).rows[0]!.count).toBe(0);
      await pool.query(`delete from projects where id=$1`, [foreign.projectId]);
    });
  });
});
