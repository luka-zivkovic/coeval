import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import {
  ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
  ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
  ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
  ANALYSIS_POPULATION_ORDERING_VERSION
} from "@coeval/shared";
import {
  analysisPopulationContentDigest,
  analysisPopulationDrawContentDigest,
  analysisPopulationDrawDigest,
  analysisPopulationDrawItemContentDigest,
  analysisPopulationExclusionDigest,
  analysisPopulationFrameDigest,
  analysisPopulationFrameMemberDigest,
  analysisPopulationItemDigest,
  analysisPopulationMemberLineageDigest,
  analysisPopulationRankDigest,
  analysisPopulationReferenceProvenance,
  analysisPopulationRequestDigest
} from "../src/lib/analysis-population.js";
import {
  datasetInputIdentity,
  datasetRevisionContentDigest,
  datasetRevisionDigest
} from "../src/lib/dataset-revision.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; analysis population PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

async function withSchema(name: string, body: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await openPostgresTestDatabase(name);
  try {
    await body(pool);
  } finally {
    await cleanup();
  }
}

async function seedProject(pool: Pool | PoolClient, suffix: string): Promise<{
  projectId: string;
  userId: string;
  subjectId: string;
}> {
  const organizationId = `org_${suffix}`;
  const projectId = `proj_${suffix}`;
  const userId = `user_${suffix}`;
  const subjectId = `subject_${suffix}`;
  await pool.query(
    `insert into "user" (id,name,email,email_verified)
     values ($1,$2,$3,true)`,
    [userId, suffix, `${suffix}@example.test`]
  );
  await pool.query("insert into organizations (id,name) values ($1,$2)", [organizationId, suffix]);
  await pool.query(
    "insert into projects (id,organization_id,name,trace_provider) values ($1,$2,$3,'manual')",
    [projectId, organizationId, suffix]
  );
  await pool.query(
    `insert into governed_reviewer_subjects (id,project_id,account_user_id,subject_digest)
     values ($1,$2,$3,governed_content_v1_digest(
       'governed-reviewer-subject/v1', jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
     ))`,
    [subjectId, projectId, userId]
  );
  return { projectId, userId, subjectId };
}

interface BundleIds {
  populationId: string;
  revisionId: string;
  memberId: string;
  drawId: string;
  requestId: string;
  exclusionId: string;
  drawItemId: string;
  caseId: string;
  rawTraceId: string;
}

async function insertAnalysisBundle(
  client: PoolClient,
  actor: { projectId: string; userId: string; subjectId: string },
  suffix: string,
  options: {
    fixedBudget?: number;
    idempotencyKey?: string;
    frameDigest?: string;
    identityBasis?: "input-identity/v1" | "redacted-input-identity/v1";
    memberRevisionItemIdOverride?: string;
    originSuffix?: string;
    skipOriginInsert?: boolean;
    populationInsertMarker?: string;
    exclusionKind?: "release-null" | "manual-judge";
    revisionCreatedByUserIdOverride?: string | null;
  } = {}
): Promise<BundleIds> {
  const populationId = `apop_${suffix}`;
  const revisionId = `dsr_${suffix}`;
  const revisionItemId = `dsri_${suffix}`;
  const memberId = `apm_${suffix}`;
  const drawId = `apd_${suffix}`;
  const drawItemId = `apdi_${suffix}`;
  const requestId = `apr_${suffix}`;
  const originSuffix = options.originSuffix ?? suffix;
  const caseId = `case_${originSuffix}`;
  const rawTraceId = `raw_${originSuffix}`;
  const sourceTraceId = `trace-${originSuffix}`;
  const exclusionCaseId = `case_excluded_${originSuffix}`;
  const manualExclusion = options.exclusionKind === "manual-judge";
  const exclusionRawTraceId = manualExclusion ? `raw_excluded_${originSuffix}` : null;
  const exclusionSourceTraceId = manualExclusion ? `trace-excluded-${originSuffix}` : null;
  const exclusionCaseType = manualExclusion ? "manual" as const : "release_evidence" as const;
  const exclusionPurpose = manualExclusion ? "judge_api" as const : "release_evidence" as const;
  const ingestionTime = "2026-01-10T12:00:00.123456Z";
  const exclusionTime = "2026-01-10T12:00:00.456789Z";
  const windowStart = "2026-01-01T00:00:00.000Z";
  const windowEnd = "2026-02-01T00:00:00.000Z";
  const input = { prompt: `hello-${originSuffix}` };
  const payloadSnapshot = { input, output: { answer: "world" }, metadata: {} };
  const inputIdentity = datasetInputIdentity({ input });
  const referenceProvenance = analysisPopulationReferenceProvenance(caseId);
  const itemDigest = analysisPopulationItemDigest({ caseId, inputIdentity, payloadSnapshot });
  const frameMemberDigest = analysisPopulationFrameMemberDigest({
    caseId,
    inputDigest: inputIdentity.digest,
    itemDigest,
    ingestionTime,
    position: 0
  });
  const lineageDigest = analysisPopulationMemberLineageDigest({
    caseId,
    revisionItemId,
    inputDigest: inputIdentity.digest,
    itemDigest,
    ingestionTime,
    position: 0
  });
  const frameDigest = options.frameDigest ?? analysisPopulationFrameDigest({
    projectId: actor.projectId,
    windowStart,
    windowEnd,
    frameMemberDigests: [frameMemberDigest]
  });
  const populationContentDigest = analysisPopulationContentDigest([itemDigest]);
  const revisionContentDigest = datasetRevisionContentDigest([itemDigest]);
  const revisionDigest = datasetRevisionDigest({ role: "analysis_authoring", itemDigests: [itemDigest] });
  const exclusionDigest = manualExclusion
    ? analysisPopulationExclusionDigest({
        caseId: exclusionCaseId,
        rawTraceId: exclusionRawTraceId!,
        sourceTraceId: exclusionSourceTraceId!,
        caseType: "manual",
        ingestionPurpose: "judge_api",
        ingestionTime: exclusionTime,
        position: "0",
        reason: "ineligible_ingestion_purpose"
      })
    : analysisPopulationExclusionDigest({
        caseId: exclusionCaseId,
        rawTraceId: null,
        sourceTraceId: null,
        caseType: "release_evidence",
        ingestionPurpose: "release_evidence",
        ingestionTime: exclusionTime,
        position: "0",
        reason: "ineligible_ingestion_purpose"
      });
  const fixedBudget = options.fixedBudget ?? 1;
  const seed = "12".repeat(32);
  const rankDigest = analysisPopulationRankDigest({ seed, caseId, frameMemberDigest });
  const drawItemDigest = analysisPopulationDrawItemContentDigest({
    memberId,
    revisionItemId,
    caseId,
    frameMemberDigest,
    rankDigest,
    position: 0
  });
  const drawContentDigest = analysisPopulationDrawContentDigest([drawItemDigest]);
  const drawDigest = analysisPopulationDrawDigest({
    populationId,
    datasetRevisionId: revisionId,
    frameDigest,
    contentDigest: drawContentDigest,
    seed,
    fixedBudget,
    populationSize: 1,
    drawItemContentDigests: [drawItemDigest]
  });
  const requestDigest = analysisPopulationRequestDigest({
    projectId: actor.projectId,
    windowStart,
    windowEnd,
    fixedBudget
  });

  if (!options.skipOriginInsert) {
    await client.query(
      `insert into raw_traces
       (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
     values ($1,$2,$3,$4,'manual-v1',$5)`,
      [rawTraceId, actor.projectId, sourceTraceId, JSON.stringify(payloadSnapshot), ingestionTime]
    );
    await client.query(
      `insert into cases
       (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
     values ($1,$2,$3,'manual',$4,'analysis_eligible_manual',$5)`,
      [caseId, actor.projectId, rawTraceId, JSON.stringify(payloadSnapshot), ingestionTime]
    );
    await client.query(
      `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     values ($1,$2,$3,$4,$5,$6)`,
      [
        `ciir_${originSuffix}`,
        actor.projectId,
        caseId,
        options.identityBasis === "redacted-input-identity/v1" ? "identity_resolved" : "authoring_import",
        options.identityBasis ?? "input-identity/v1",
        inputIdentity.digest
      ]
    );
    if (manualExclusion) {
      await client.query(
        `insert into raw_traces
           (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
         values ($1,$2,$3,$4,'manual-v1',$5)`,
        [exclusionRawTraceId, actor.projectId, exclusionSourceTraceId, JSON.stringify(payloadSnapshot), exclusionTime]
      );
    }
    await client.query(
      `insert into cases
         (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        exclusionCaseId,
        actor.projectId,
        exclusionRawTraceId,
        exclusionCaseType,
        JSON.stringify(payloadSnapshot),
        exclusionPurpose,
        exclusionTime
      ]
    );
  }
  await client.query(
    `${options.populationInsertMarker ?? ""} insert into analysis_populations
       (id,project_id,dataset_revision_id,window_start,window_end,eligible_sources,
        eligible_ingestion_purposes,canonicalization_version,ordering_version,
        population_size,exclusion_count,frame_digest,content_digest,snapshot_xid8,
        snapshot_taken_at,created_by_user_id,created_by_subject_id,created_at)
     select $1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,$11,pg_current_snapshot()::text,
            transaction_timestamp(),$12,$13,transaction_timestamp()`,
    [
      populationId,
      actor.projectId,
      revisionId,
      windowStart,
      windowEnd,
      [...ANALYSIS_POPULATION_ELIGIBLE_SOURCES],
      [...ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES],
      ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
      ANALYSIS_POPULATION_ORDERING_VERSION,
      frameDigest,
      populationContentDigest,
      actor.userId,
      actor.subjectId
    ]
  );
  await client.query(
    `insert into dataset_revisions
       (id,project_id,series_id,revision_number,source_dataset_id,parent_revision_id,
        role,source_kind,identity_basis,content_digest,revision_digest,item_count,
        provenance_level,created_by_user_id,idempotency_key,analysis_population_id)
     values ($1,$2,$3,1,null,null,'analysis_authoring','analysis_population',
             'input-identity/v1',$4,$5,1,'unverified',$6,null,$7)`,
    [
      revisionId,
      actor.projectId,
      `analysis-population:${populationId}`,
      revisionContentDigest,
      revisionDigest,
      options.revisionCreatedByUserIdOverride === undefined
        ? actor.userId
        : options.revisionCreatedByUserIdOverride,
      populationId
    ]
  );
  await client.query(
    `insert into dataset_revision_items
       (id,revision_id,project_id,position,source_case_id,source_trace_id,
        source_dataset_item_id,source_golden_entry_id,input_digest,item_digest,
        payload_snapshot,reference_label,reference_fail_step,reference_provenance,note)
     values ($1,$2,$3,0,$4,$5,null,null,$6,$7,$8,null,null,$9,null)`,
    [revisionItemId, revisionId, actor.projectId, caseId, sourceTraceId, inputIdentity.digest, itemDigest, JSON.stringify(payloadSnapshot), JSON.stringify(referenceProvenance)]
  );
  await client.query(
    `insert into analysis_population_members
       (id,project_id,population_id,revision_item_id,case_id,raw_trace_id,
        source_trace_id,case_type,ingestion_purpose,position,ingestion_time,
        input_digest,item_digest,frame_member_digest,lineage_digest)
     values ($1,$2,$3,$4,$5,$6,$7,'manual','analysis_eligible_manual',0,$8,$9,$10,$11,$12)`,
    [memberId, actor.projectId, populationId, options.memberRevisionItemIdOverride ?? revisionItemId, caseId, rawTraceId, sourceTraceId, ingestionTime, inputIdentity.digest, itemDigest, frameMemberDigest, lineageDigest]
  );
  await client.query(
    `insert into analysis_population_exclusions
       (id,project_id,population_id,case_id,raw_trace_id,source_trace_id,case_type,
        ingestion_purpose,position,ingestion_time,reason,content_digest)
     values ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,'ineligible_ingestion_purpose',$10)`,
    [
      `apx_${suffix}`,
      actor.projectId,
      populationId,
      exclusionCaseId,
      exclusionRawTraceId,
      exclusionSourceTraceId,
      exclusionCaseType,
      exclusionPurpose,
      exclusionTime,
      exclusionDigest
    ]
  );
  await client.query(
    `insert into analysis_population_draws
       (id,project_id,population_id,dataset_revision_id,method,stopping_rule,
        draw_executor,seed,rng_version,algorithm_version,fixed_budget,population_size,
        inclusion_numerator,inclusion_denominator,draw_digest,content_digest,
        executed_by_subject_id,executed_at)
     select $1,$2,$3,$4,'simple_random','fixed','coeval_server',$5,'sha256-rank/v1',
            'coeval-analysis-draw/v1',$6,1,$6,1,$7,$8,$9,transaction_timestamp()`,
    [drawId, actor.projectId, populationId, revisionId, seed, fixedBudget, drawDigest, drawContentDigest, actor.subjectId]
  );
  await client.query(
    `insert into analysis_population_draw_items
       (id,project_id,draw_id,population_id,member_id,revision_item_id,case_id,
        position,frame_member_digest,rank_digest,content_digest)
     values ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10)`,
    [drawItemId, actor.projectId, drawId, populationId, memberId, revisionItemId, caseId, frameMemberDigest, rankDigest, drawItemDigest]
  );
  await client.query(
    `insert into analysis_population_requests
       (id,project_id,idempotency_key,request_digest,population_id)
     values ($1,$2,$3,$4,$5)`,
    [requestId, actor.projectId, options.idempotencyKey ?? `key-${suffix}`, requestDigest, populationId]
  );
  return {
    populationId,
    revisionId,
    memberId,
    drawId,
    requestId,
    exclusionId: `apx_${suffix}`,
    drawItemId,
    caseId,
    rawTraceId
  };
}

async function insertProtectedSealedItem(
  client: PoolClient,
  actor: { projectId: string; userId: string; subjectId: string },
  suffix: string,
  inputDigest: string,
  queryMarker = ""
): Promise<void> {
  const populationId = `sealed_population_${suffix}`;
  const reviewItemId = `sealed_item_${suffix}`;
  const populationDefinition = { basis: "test-sealed-population/v1" };
  const collectionProvenance = { basis: "test-collection/v1" };
  const reviewPayload = { input: { secret: "retained" }, output: { answer: "retained" } };
  const redactionProvenance = { basis: "test-redaction/v1" };
  const frameDigest = String((await client.query(
    `select governed_content_v1_digest(
       'governed-sealed-intake-frame/v1',
       jsonb_build_array(jsonb_build_object(
         'framePosition',0,'inputDigest',$1::text,'reviewItemId',$2::text
       ))
     ) as digest`,
    [inputDigest, reviewItemId]
  )).rows[0]?.digest);
  const populationContentDigest = String((await client.query(
    `select governed_content_v1_digest(
       'governed-sealed-intake-population/v1',
       jsonb_build_object(
         'collectionProvenance',$1::jsonb,
         'custodianRoleAtReview','owner',
         'custodianSubjectId',$2::text,
         'frameCount',1,
         'frameDigest',$3::text,
         'populationDefinition',$4::jsonb,
         'predecessorRevisionId',null,
         'windowEnd',null,
         'windowStart',null
       )
     ) as digest`,
    [JSON.stringify(collectionProvenance), actor.subjectId, frameDigest, JSON.stringify(populationDefinition)]
  )).rows[0]?.digest);
  const itemContentDigest = String((await client.query(
    `select governed_content_v1_digest(
       'governed-review-item/v1',
       jsonb_build_object(
         'identityBasis','input-identity/v1',
         'inputDigest',$1::text,
         'redactionProvenance',$2::jsonb,
         'reviewPayloadProjectionVersion','governed-review-payload/v1',
         'reviewPayloadSnapshot',$3::jsonb,
         'sealedFramePosition',0,
         'sealedIntakePopulationId',$4::text,
         'sealedPredecessorRevisionId',null,
         'sealedPredecessorRevisionItemId',null,
         'sourceKind','sealed_intake',
         'sourceItemDigest',null,
         'sourceRevisionId',null,
         'sourceRevisionItemId',null
       )
     ) as digest`,
    [inputDigest, JSON.stringify(redactionProvenance), JSON.stringify(reviewPayload), populationId]
  )).rows[0]?.digest);
  await client.query(
    `insert into governed_sealed_intake_populations
       (id,project_id,custodian_subject_id,custodian_role_at_review,population_definition,
        collection_provenance,frame_count,frame_digest,content_digest,idempotency_key,request_digest)
     values ($1,$2,$3,'owner',$4,$5,1,$6,$7,$8,$9)`,
    [
      populationId,
      actor.projectId,
      actor.subjectId,
      JSON.stringify(populationDefinition),
      JSON.stringify(collectionProvenance),
      frameDigest,
      populationContentDigest,
      `sealed-${suffix}`,
      `sha256:${"8".repeat(64)}`
    ]
  );
  await client.query(
    `${queryMarker} insert into governed_review_items
       (id,project_id,source_kind,source_revision_id,source_revision_item_id,
        sealed_intake_population_id,sealed_frame_position,sealed_predecessor_revision_id,
        sealed_predecessor_revision_item_id,identity_basis,input_digest,source_item_digest,
        review_payload_projection_version,review_payload_snapshot,redaction_provenance,
        content_digest,idempotency_key,request_digest,created_by_subject_id)
     values ($1,$2,'sealed_intake',null,null,$3,0,null,null,'input-identity/v1',$4,null,
             'governed-review-payload/v1',$5,$6,$7,$8,$9,$10)`,
    [
      reviewItemId,
      actor.projectId,
      populationId,
      inputDigest,
      JSON.stringify(reviewPayload),
      JSON.stringify(redactionProvenance),
      itemContentDigest,
      `sealed-item-${suffix}`,
      `sha256:${"9".repeat(64)}`,
      actor.subjectId
    ]
  );
}

async function seedSharedAnalysisOrigin(
  pool: Pool,
  actor: { projectId: string },
  suffix: string
): Promise<void> {
  const input = { prompt: `hello-${suffix}` };
  const payload = { input, output: { answer: "world" }, metadata: {} };
  const inputDigest = datasetInputIdentity({ input }).digest;
  await pool.query(
    `insert into raw_traces
       (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
     values ($1,$2,$3,$4,'manual-v1','2026-01-10T12:00:00.123456Z')`,
    [`raw_${suffix}`, actor.projectId, `trace-${suffix}`, JSON.stringify(payload)]
  );
  await pool.query(
    `insert into cases
       (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
     values ($1,$2,$3,'manual',$4,'analysis_eligible_manual','2026-01-10T12:00:00.123456Z')`,
    [`case_${suffix}`, actor.projectId, `raw_${suffix}`, JSON.stringify(payload)]
  );
  await pool.query(
    `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     values ($1,$2,$3,'authoring_import','input-identity/v1',$4)`,
    [`ciir_${suffix}`, actor.projectId, `case_${suffix}`, inputDigest]
  );
  await pool.query(
    `insert into cases
       (id,project_id,case_type,normalized_payload,ingestion_purpose,created_at)
     values ($1,$2,'release_evidence',$3,'release_evidence','2026-01-10T12:00:00.456789Z')`,
    [`case_excluded_${suffix}`, actor.projectId, JSON.stringify(payload)]
  );
}

async function waitForBlockedQuery(pool: Pool, marker: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query(
      `select wait_event_type from pg_stat_activity
       where query like $1 and state='active' and wait_event_type is not null`,
      [`%${marker}%`]
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked PostgreSQL query: ${marker}`);
}

run("analysis population PostgreSQL invariants", () => {
  it("preserves ordinary revision source kinds and current identity claims", async () => {
    await withSchema("analysis_population_upgrade", async (pool) => {
      await runMigrations(pool);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const actor = await seedProject(client, "analysis_population_upgrade");
        const digest = `sha256:${"1".repeat(64)}`;
        await client.query(
          `insert into dataset_revisions
             (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
              content_digest,revision_digest,item_count,provenance_level)
           values ('dsr_existing',$1,'existing',1,'analysis_authoring','collection_snapshot',
                   'input-identity/v1',$2,$2,0,'unverified')`,
          [actor.projectId, digest]
        );
        await client.query(
          `insert into case_input_identity_records
             (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
           values ('identity_existing',$1,'case_existing','authoring_import','input-identity/v1',$2)`,
          [actor.projectId, `sha256:${"2".repeat(64)}`]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      expect((await pool.query(
        "select source_kind,analysis_population_id from dataset_revisions where id='dsr_existing'"
      )).rows[0]).toEqual({ source_kind: "collection_snapshot", analysis_population_id: null });
      const sourceKindDefinition = String((await pool.query(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
         where conrelid='dataset_revisions'::regclass
           and conname='dataset_revisions_source_kind_check'`
      )).rows[0]?.definition);
      expect(sourceKindDefinition).toContain("analysis_population");
      expect((await pool.query(
        "select input_digest,usage_class from governed_input_identity_claims"
      )).rows).toEqual([{
        input_digest: `sha256:${"2".repeat(64)}`,
        usage_class: "nonsealed"
      }]);
      const bundleGuardDefinition = String((await pool.query(
        `select pg_get_functiondef('guard_analysis_population_bundle_complete()'::regprocedure) as definition`
      )).rows[0]?.definition);
      expect(bundleGuardDefinition).toMatch(/row_number\(\) over \(order by case_row\.created_at, case_row\.id\)/i);
      expect(bundleGuardDefinition).not.toMatch(/from cases earlier/i);
      expect((await pool.query(
        `select indexdef from pg_indexes
         where schemaname=current_schema() and indexname='cases_project_created_id_idx'`
      )).rows[0]?.indexdef).toContain("(project_id, created_at, id)");
    });
  });

  it("commits one exact bundle, enforces parity and append-only evidence, and preserves project erasure", async () => {
    await withSchema("analysis_population_bundle", async (pool) => {
      await runMigrations(pool);
      const actor = await seedProject(pool, "analysis_population_bundle");
      const client = await pool.connect();
      let ids: BundleIds;
      try {
        await client.query("begin isolation level repeatable read");
        ids = await insertAnalysisBundle(client, actor, "bundle");
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      expect((await pool.query(
        `select p.population_size,p.exclusion_count::text,d.fixed_budget,d.inclusion_numerator,d.inclusion_denominator
         from analysis_populations p join analysis_population_draws d on d.population_id=p.id
         where p.id=$1`,
        [ids.populationId]
      )).rows[0]).toEqual({
        population_size: 1,
        exclusion_count: "1",
        fixed_budget: 1,
        inclusion_numerator: 1,
        inclusion_denominator: 1
      });
      expect((await pool.query(
        `select analysis_population_frame_digest_v1($1) as frame,
                analysis_population_content_digest_v1($1) as content`,
        [ids.populationId]
      )).rows[0]).toEqual((await pool.query(
        "select frame_digest as frame,content_digest as content from analysis_populations where id=$1",
        [ids.populationId]
      )).rows[0]);
      const parity = (await pool.query(
        `select member.*,revision_item.payload_snapshot,exclusion.position::text as exclusion_position,
                exclusion.case_id as exclusion_case_id,exclusion.raw_trace_id as exclusion_raw_trace_id,
                exclusion.source_trace_id as exclusion_source_trace_id,
                exclusion.case_type as exclusion_case_type,
                exclusion.ingestion_purpose as exclusion_ingestion_purpose,
                exclusion.ingestion_time as exclusion_ingestion_time,
                exclusion.reason as exclusion_reason,
                exclusion.content_digest as exclusion_content_digest,
                draw.seed,draw.dataset_revision_id,draw.fixed_budget,draw.population_size,
                draw.content_digest as draw_content_digest,draw.draw_digest,
                selection.rank_digest,selection.content_digest as selection_content_digest,
                selection.position as selection_position
         from analysis_population_members member
         join dataset_revision_items revision_item on revision_item.id=member.revision_item_id
         join analysis_population_exclusions exclusion on exclusion.population_id=member.population_id
         join analysis_population_draws draw on draw.population_id=member.population_id
         join analysis_population_draw_items selection on selection.draw_id=draw.id
         where member.population_id=$1`,
        [ids.populationId]
      )).rows[0];
      const ingestionTime = new Date(parity.ingestion_time).toISOString();
      expect(parity.item_digest).toBe(analysisPopulationItemDigest({
        caseId: parity.case_id,
        inputIdentity: { basis: "input-identity/v1", digest: parity.input_digest },
        payloadSnapshot: parity.payload_snapshot
      }));
      expect(parity.frame_member_digest).toBe(analysisPopulationFrameMemberDigest({
        caseId: parity.case_id,
        inputDigest: parity.input_digest,
        itemDigest: parity.item_digest,
        ingestionTime,
        position: parity.position
      }));
      expect(parity.lineage_digest).toBe(analysisPopulationMemberLineageDigest({
        caseId: parity.case_id,
        revisionItemId: parity.revision_item_id,
        inputDigest: parity.input_digest,
        itemDigest: parity.item_digest,
        ingestionTime,
        position: parity.position
      }));
      expect(parity.exclusion_content_digest).toBe(analysisPopulationExclusionDigest({
        caseId: parity.exclusion_case_id,
        rawTraceId: parity.exclusion_raw_trace_id,
        sourceTraceId: parity.exclusion_source_trace_id,
        caseType: parity.exclusion_case_type,
        ingestionPurpose: parity.exclusion_ingestion_purpose,
        ingestionTime: new Date(parity.exclusion_ingestion_time).toISOString(),
        position: parity.exclusion_position,
        reason: parity.exclusion_reason
      }));
      expect(parity.rank_digest).toBe(analysisPopulationRankDigest({
        seed: parity.seed,
        caseId: parity.case_id,
        frameMemberDigest: parity.frame_member_digest
      }));
      expect(parity.selection_content_digest).toBe(analysisPopulationDrawItemContentDigest({
        memberId: parity.id,
        revisionItemId: parity.revision_item_id,
        caseId: parity.case_id,
        frameMemberDigest: parity.frame_member_digest,
        rankDigest: parity.rank_digest,
        position: parity.selection_position
      }));
      expect(parity.draw_content_digest).toBe(analysisPopulationDrawContentDigest([
        parity.selection_content_digest
      ]));
      expect(parity.draw_digest).toBe(analysisPopulationDrawDigest({
        populationId: ids.populationId,
        datasetRevisionId: parity.dataset_revision_id,
        frameDigest: (await pool.query(
          "select frame_digest from analysis_populations where id=$1",
          [ids.populationId]
        )).rows[0]?.frame_digest,
        contentDigest: parity.draw_content_digest,
        seed: parity.seed,
        fixedBudget: parity.fixed_budget,
        populationSize: parity.population_size,
        drawItemContentDigests: [parity.selection_content_digest]
      }));

      const exposureInsert = (id: string) => pool.query(
        `/* concurrent-analysis-content-exposure */ insert into dataset_exposure_events
           (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,
            subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,
            idempotency_key)
         values ($1,$2,$3,null,'human_access','development','content_view',
                 'person',$4,$5,'analysis_population',$6,$7)`,
        [
          id,
          actor.projectId,
          ids.revisionId,
          actor.subjectId,
          actor.userId,
          ids.populationId,
          `analysis-content-view:${ids.revisionId}:${actor.subjectId}`
        ]
      );
      const exposureRace = await Promise.allSettled([
        exposureInsert("exposure_analysis_content_a"),
        exposureInsert("exposure_analysis_content_b")
      ]);
      expect(exposureRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(exposureRace.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((exposureRace.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
        .toMatchObject({ code: "23505" });
      expect((await pool.query(
        "select count(*)::int as count from dataset_exposure_events where revision_id=$1 and activity='content_view'",
        [ids.revisionId]
      )).rows[0]?.count).toBe(1);
      await expect(pool.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
            actor_user_id,evidence_ref_kind,evidence_ref_id,idempotency_key)
         values ('exposure_analysis_wrong',$1,$2,'human_access','development','content_view',
                 'system',$3,$4,'analysis_population',$5,'wrong-key')`,
        [actor.projectId, ids.revisionId, actor.subjectId, actor.userId, ids.populationId]
      )).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
            actor_user_id,evidence_ref_kind,evidence_ref_id,idempotency_key)
         values ('exposure_analysis_poison',$1,$2,'created','lineage','revision_create',
                 'system',null,null,null,null,$3)`,
        [
          actor.projectId,
          ids.revisionId,
          `analysis-content-view:${ids.revisionId}:poison-subject`
        ]
      )).rejects.toMatchObject({ code: "23514" });

      const originalRequest = (await pool.query(
        "select request_digest from analysis_population_requests where id=$1",
        [ids.requestId]
      )).rows[0]?.request_digest as string;
      await pool.query(
        `insert into analysis_population_requests
           (id,project_id,idempotency_key,request_digest,population_id)
         values ('request_frame_alias',$1,'same-frame-alias',$2,$3)`,
        [actor.projectId, originalRequest, ids.populationId]
      );
      await pool.query(
        `insert into raw_traces
           (id,project_id,source_trace_id,raw_payload,normalization_version,created_at)
         values ('raw_late_commit',$1,'late-commit','{"input":{"late":true},"output":{}}',
                 'manual-v1','2026-01-20T00:00:00.000Z')`,
        [actor.projectId]
      );
      await pool.query(
        `insert into cases
           (id,project_id,raw_trace_id,case_type,normalized_payload,ingestion_purpose,created_at)
         values ('case_late_commit',$1,'raw_late_commit','manual',
                 '{"input":{"late":true},"output":{},"metadata":{}}',
                 'analysis_eligible_manual','2026-01-20T00:00:00.000Z')`,
        [actor.projectId]
      );
      await pool.query(
        `insert into case_input_identity_records
           (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
         values ('identity_late_commit',$1,'case_late_commit','authoring_import','input-identity/v1',
                 analysis_sha256_v1('{"late":true}'::jsonb))`,
        [actor.projectId]
      );
      await pool.query(
        `insert into analysis_population_requests
           (id,project_id,idempotency_key,request_digest,population_id)
         values ('request_frame_alias_retry',$1,'same-frame-alias-retry',$2,$3)`,
        [actor.projectId, originalRequest, ids.populationId]
      );
      expect((await pool.query(
        "select count(*)::int as count from analysis_population_requests where population_id=$1",
        [ids.populationId]
      )).rows[0]?.count).toBe(3);

      const population = (await pool.query(
        "select window_start,window_end from analysis_populations where id=$1",
        [ids.populationId]
      )).rows[0];
      const differentBudgetDigest = analysisPopulationRequestDigest({
        projectId: actor.projectId,
        windowStart: new Date(population.window_start).toISOString(),
        windowEnd: new Date(population.window_end).toISOString(),
        fixedBudget: 2
      });
      await expect(pool.query(
        `insert into analysis_population_requests
           (id,project_id,idempotency_key,request_digest,population_id)
         values ('request_different_budget',$1,'different-budget',$2,$3)`,
        [actor.projectId, differentBudgetDigest, ids.populationId]
      )).rejects.toMatchObject({ code: "23514" });

      for (const [table, id] of [
        ["analysis_populations", ids.populationId],
        ["analysis_population_requests", ids.requestId],
        ["analysis_population_members", ids.memberId],
        ["analysis_population_exclusions", ids.exclusionId],
        ["analysis_population_draws", ids.drawId],
        ["analysis_population_draw_items", ids.drawItemId]
      ] as const) {
        await expect(pool.query(`update ${table} set id=id where id=$1`, [id]))
          .rejects.toMatchObject({ code: "55000" });
        await expect(pool.query(`delete from ${table} where id=$1`, [id]))
          .rejects.toMatchObject({ code: "55000" });
      }
      await expect(pool.query(
        `insert into dataset_revisions
           (id,project_id,series_id,revision_number,parent_revision_id,role,source_kind,
            identity_basis,content_digest,revision_digest,item_count,provenance_level)
         select 'dsr_illegal_successor',project_id,series_id,2,id,'analysis_authoring',
                'collection_snapshot','input-identity/v1',content_digest,revision_digest,0,'unverified'
         from dataset_revisions where id=$1`,
        [ids.revisionId]
      )).rejects.toMatchObject({ code: "23514" });

      await expect(pool.query(
        `insert into governed_review_items
           (id,project_id,source_kind,source_revision_id,source_revision_item_id)
         values ('gri_analysis_population_bypass',$1,'dataset_revision_item',$2,
                 'dsri_exact_bundle')`,
        [actor.projectId, ids.revisionId]
      )).rejects.toMatchObject({ code: "23514" });

      await expect(pool.query(
        `insert into governed_review_batches
           (id,project_id,source_population_kind,source_population_id)
         values ('grb_analysis_population_bypass',$1,'dataset_revision',$2)`,
        [actor.projectId, ids.revisionId]
      )).rejects.toMatchObject({ code: "23514" });

      await expect(pool.query(
        `insert into eval_runs
           (id,project_id,skill_version_id,trigger,status,total_items,dataset_revision_id)
         values ('eval_analysis_population_bypass',$1,'skill_version_missing','manual',
                 'pending',0,$2)`,
        [actor.projectId, ids.revisionId]
      )).rejects.toMatchObject({ code: "23514" });

      await pool.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
            actor_user_id,evidence_ref_kind,evidence_ref_id,details,idempotency_key)
         values ('exposure_analysis_created',$1,$2,'created','lineage','revision_create',
                 'person',$3,$4,'dataset_revision',$2,'{}','analysis-created-valid')`,
        [actor.projectId, ids.revisionId, actor.subjectId, actor.userId]
      );
      await expect(pool.query(
        `insert into dataset_exposure_events
           (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
            actor_user_id,evidence_ref_kind,evidence_ref_id,details,idempotency_key)
         values ('exposure_analysis_created_wrong_activity',$1,$2,'created','lineage',
                 'analysis_authoring','person',$3,$4,'dataset_revision',$2,'{}',
                 'analysis-created-wrong-activity')`,
        [actor.projectId, ids.revisionId, actor.subjectId, actor.userId]
      )).rejects.toMatchObject({ code: "23514" });

      await pool.query("delete from projects where id=$1", [actor.projectId]);
      for (const table of [
        "analysis_populations",
        "analysis_population_requests",
        "analysis_population_members",
        "analysis_population_exclusions",
        "analysis_population_draws",
        "analysis_population_draw_items",
        "governed_input_identity_claims"
      ]) {
        expect((await pool.query(`select count(*)::int as count from ${table}`)).rows[0]?.count).toBe(0);
      }
    });
  });

  it("rolls back incomplete/cross-owned bundles and rejects same-frame second evidence", async () => {
    await withSchema("analysis_population_adversarial", async (pool) => {
      await runMigrations(pool);
      const actor = await seedProject(pool, "analysis_population_adversarial");
      const readCommitted = await pool.connect();
      try {
        await readCommitted.query("begin");
        await expect(insertAnalysisBundle(readCommitted, actor, "read_committed"))
          .rejects.toMatchObject({ code: "23514" });
        await readCommitted.query("rollback");
      } finally {
        readCommitted.release();
      }
      expect((await pool.query(
        "select count(*)::int as count from cases where id='case_read_committed'"
      )).rows[0]?.count).toBe(0);

      const incomplete = await pool.connect();
      try {
        await incomplete.query("begin isolation level repeatable read");
        await incomplete.query(
          `insert into analysis_populations
             (id,project_id,dataset_revision_id,window_start,window_end,eligible_sources,
              eligible_ingestion_purposes,canonicalization_version,ordering_version,
              population_size,exclusion_count,frame_digest,content_digest,snapshot_xid8,
              snapshot_taken_at,created_by_user_id,created_by_subject_id,created_at)
           select 'apop_incomplete',$1,'dsr_incomplete','2026-01-01T00:00:00.000Z',
                  '2026-02-01T00:00:00.000Z',$2,$3,$4,$5,1,0,$6,$7,
                  pg_current_snapshot()::text,transaction_timestamp(),$8,$9,transaction_timestamp()`,
          [
            actor.projectId,
            [...ANALYSIS_POPULATION_ELIGIBLE_SOURCES],
            [...ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES],
            ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
            ANALYSIS_POPULATION_ORDERING_VERSION,
            `sha256:${"3".repeat(64)}`,
            `sha256:${"4".repeat(64)}`,
            actor.userId,
            actor.subjectId
          ]
        );
        await incomplete.query(
          `insert into dataset_revisions
             (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
              content_digest,revision_digest,item_count,provenance_level,created_by_user_id,
              analysis_population_id)
           values ('dsr_incomplete',$1,'analysis-population:apop_incomplete',1,
                   'analysis_authoring','analysis_population','input-identity/v1',$2,$3,1,
                   'unverified',$4,'apop_incomplete')`,
          [actor.projectId, `sha256:${"4".repeat(64)}`, `sha256:${"5".repeat(64)}`, actor.userId]
        );
        await expect(incomplete.query("commit")).rejects.toMatchObject({ code: "23514" });
        await incomplete.query("rollback");
      } finally {
        incomplete.release();
      }
      expect((await pool.query(
        "select count(*)::int as count from analysis_populations where id='apop_incomplete'"
      )).rows[0]?.count).toBe(0);

      const redactedOnly = await pool.connect();
      try {
        await redactedOnly.query("begin isolation level repeatable read");
        await expect(insertAnalysisBundle(redactedOnly, actor, "redacted_identity", {
          identityBasis: "redacted-input-identity/v1"
        })).rejects.toMatchObject({ code: "23514" });
        await redactedOnly.query("rollback");
      } finally {
        redactedOnly.release();
      }
      expect((await pool.query(
        "select count(*)::int as count from cases where id='case_redacted_identity'"
      )).rows[0]?.count).toBe(0);

      const crossActor = await pool.connect();
      try {
        await crossActor.query("begin isolation level repeatable read");
        await expect(insertAnalysisBundle(crossActor, actor, "cross_actor", {
          revisionCreatedByUserIdOverride: null
        })).rejects.toMatchObject({ code: "23514" });
        await crossActor.query("rollback");
      } finally {
        crossActor.release();
      }

      const client = await pool.connect();
      let ids: BundleIds;
      try {
        await client.query("begin isolation level repeatable read");
        ids = await insertAnalysisBundle(client, actor, "first");
        await client.query("commit");
      } finally {
        client.release();
      }

      const sameFrame = (await pool.query(
        "select frame_digest from analysis_populations where id=$1",
        [ids.populationId]
      )).rows[0]?.frame_digest as string;
      const second = await pool.connect();
      try {
        await second.query("begin isolation level repeatable read");
        await expect(insertAnalysisBundle(second, actor, "second", {
          fixedBudget: 1,
          idempotencyKey: "new-key-same-frame",
          frameDigest: sameFrame
        })).rejects.toMatchObject({ code: "23505" });
        await second.query("rollback");
      } finally {
        second.release();
      }
      expect((await pool.query(
        "select count(*)::int as count from analysis_populations where project_id=$1",
        [actor.projectId]
      )).rows[0]?.count).toBe(1);

      const crossSwap = await pool.connect();
      try {
        await crossSwap.query("begin isolation level repeatable read");
        await expect(insertAnalysisBundle(crossSwap, actor, "cross_swap", {
          memberRevisionItemIdOverride: "dsri_first"
        })).rejects.toMatchObject({ code: "23514" });
        await crossSwap.query("rollback");
      } finally {
        crossSwap.release();
      }

      await expect(pool.query(
        `insert into dataset_revisions
           (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
            content_digest,revision_digest,item_count,provenance_level,analysis_population_id)
         select 'dsr_cross_swap',project_id,series_id,1,'analysis_authoring','analysis_population',
                'input-identity/v1',content_digest,revision_digest,item_count,'unverified',$1
         from dataset_revisions where id=$2`,
        [ids.populationId, ids.revisionId]
      )).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(
        `insert into dataset_revisions
           (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
            content_digest,revision_digest,item_count,provenance_level,analysis_population_id)
         select 'dsr_public_laundered',project_id,'public:laundered',1,'analysis_authoring',
                'collection_snapshot','input-identity/v1',content_digest,revision_digest,0,
                'unverified',$1
         from dataset_revisions where id=$2`,
        [ids.populationId, ids.revisionId]
      )).rejects.toMatchObject({ code: "23514" });

      const wrongShape = await pool.connect();
      try {
        await wrongShape.query("begin isolation level repeatable read");
        await wrongShape.query(
          `insert into datasets (id,project_id,name) values ('dataset_analysis_wrong_shape',$1,'wrong shape')`,
          [actor.projectId]
        );
        await wrongShape.query(
          `insert into analysis_populations
             (id,project_id,dataset_revision_id,window_start,window_end,eligible_sources,
              eligible_ingestion_purposes,canonicalization_version,ordering_version,
              population_size,exclusion_count,frame_digest,content_digest,snapshot_xid8,
              snapshot_taken_at,created_by_user_id,created_by_subject_id,created_at)
           select 'apop_wrong_revision_shape',$1,'dsr_wrong_revision_shape',
                  '2025-01-01T00:00:00.000Z','2025-02-01T00:00:00.000Z',$2,$3,$4,$5,
                  1,0,$6,$7,pg_current_snapshot()::text,transaction_timestamp(),$8,$9,
                  transaction_timestamp()`,
          [
            actor.projectId,
            [...ANALYSIS_POPULATION_ELIGIBLE_SOURCES],
            [...ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES],
            ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
            ANALYSIS_POPULATION_ORDERING_VERSION,
            `sha256:${"0".repeat(63)}1`,
            `sha256:${"0".repeat(63)}2`,
            actor.userId,
            actor.subjectId
          ]
        );
        await expect(wrongShape.query(
          `insert into dataset_revisions
             (id,project_id,series_id,revision_number,source_dataset_id,role,source_kind,
              identity_basis,content_digest,revision_digest,item_count,provenance_level,
              idempotency_key,analysis_population_id)
           values ('dsr_wrong_revision_shape',$1,'analysis-population:apop_wrong_revision_shape',1,
                   'dataset_analysis_wrong_shape','iterative_development','analysis_population',
                   'input-identity/v1',$2,$3,1,'unverified','forbidden-public-key',
                   'apop_wrong_revision_shape')`,
          [actor.projectId, `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]
        )).rejects.toMatchObject({ code: "23514" });
        await wrongShape.query("rollback");
      } finally {
        wrongShape.release();
      }
      await expect(pool.query(
        `insert into analysis_population_draws
           (id,project_id,population_id,dataset_revision_id,method,stopping_rule,draw_executor,
            seed,rng_version,algorithm_version,fixed_budget,population_size,inclusion_numerator,
            inclusion_denominator,draw_digest,content_digest,executed_by_subject_id)
         select 'draw_cross_swap',project_id,population_id,'dsr_cross_swap',method,stopping_rule,
                draw_executor,seed,rng_version,algorithm_version,fixed_budget,population_size,
                inclusion_numerator,inclusion_denominator,draw_digest,content_digest,executed_by_subject_id
         from analysis_population_draws where id=$1`,
        [ids.drawId]
      )).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(
        `insert into analysis_population_draw_items
           (id,project_id,draw_id,population_id,member_id,revision_item_id,case_id,position,
            frame_member_digest,rank_digest,content_digest)
         select 'draw_item_cross_swap',project_id,draw_id,population_id,'member_missing',
                revision_item_id,case_id,position,frame_member_digest,rank_digest,content_digest
         from analysis_population_draw_items where draw_id=$1`,
        [ids.drawId]
      )).rejects.toMatchObject({ code: "23514" });

      await expect(pool.query(
        `insert into analysis_population_requests
           (id,project_id,idempotency_key,request_digest,population_id)
         values ('request_wrong_digest',$1,'wrong-digest',$2,$3)`,
        [actor.projectId, `sha256:${"f".repeat(64)}`, ids.populationId]
      )).rejects.toMatchObject({ code: "23514" });

      const otherActor = await seedProject(pool, "analysis_population_other_project");
      await expect(pool.query(
        `insert into analysis_population_requests
           (id,project_id,idempotency_key,request_digest,population_id)
         select 'request_cross_project',$1,'cross-project',request_digest,population_id
         from analysis_population_requests where id=$2`,
        [otherActor.projectId, ids.requestId]
      )).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("serializes concurrent creation of the same exact frame to one population and draw", async () => {
    await withSchema("analysis_population_frame_race", async (pool) => {
      await runMigrations(pool);
      const actor = await seedProject(pool, "analysis_population_frame_race");
      await seedSharedAnalysisOrigin(pool, actor, "shared_frame");
      const winner = await pool.connect();
      const loser = await pool.connect();
      try {
        await winner.query("begin isolation level repeatable read");
        await loser.query("begin isolation level repeatable read");
        const winningBundle = await insertAnalysisBundle(winner, actor, "frame_winner", {
          originSuffix: "shared_frame",
          skipOriginInsert: true,
          idempotencyKey: "frame-winner"
        });
        const blockedLoser = insertAnalysisBundle(loser, actor, "frame_loser", {
          originSuffix: "shared_frame",
          skipOriginInsert: true,
          idempotencyKey: "frame-loser",
          populationInsertMarker: "/* duplicate-frame-loser */"
        });
        const loserOutcome = blockedLoser.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );
        await waitForBlockedQuery(pool, "duplicate-frame-loser");
        await winner.query("commit");
        const loserResult = await loserOutcome;
        expect(loserResult.ok).toBe(false);
        if (!loserResult.ok) expect(loserResult.error).toMatchObject({ code: "23505" });
        await loser.query("rollback");
        expect((await pool.query(
          `select p.id as population_id,d.id as draw_id,count(item.id)::int as selected
           from analysis_populations p
           join analysis_population_draws d on d.population_id=p.id
           join analysis_population_draw_items item on item.draw_id=d.id
           where p.project_id=$1
           group by p.id,d.id`,
          [actor.projectId]
        )).rows).toEqual([{
          population_id: winningBundle.populationId,
          draw_id: winningBundle.drawId,
          selected: 1
        }]);
      } finally {
        winner.release();
        loser.release();
      }
    });
  });

  it("keeps durable exclusion lineage without blocking retention of old manual ineligible traces", async () => {
    await withSchema("analysis_population_exclusion_retention", async (pool) => {
      await runMigrations(pool);
      const actor = await seedProject(pool, "analysis_population_exclusion_retention");
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read");
        await insertAnalysisBundle(client, actor, "retention", { exclusionKind: "manual-judge" });
        await client.query("commit");
      } finally {
        client.release();
      }
      await pool.query("delete from cases where id='case_excluded_retention'");
      await pool.query("delete from raw_traces where id='raw_excluded_retention'");
      await pool.query("delete from cases where id='case_retention'");
      await pool.query("delete from raw_traces where id='raw_retention'");
      expect((await pool.query(
        `select case_id,raw_trace_id,source_trace_id,case_type,ingestion_purpose
         from analysis_population_exclusions where id='apx_retention'`
      )).rows).toEqual([{
        case_id: "case_excluded_retention",
        raw_trace_id: "raw_excluded_retention",
        source_trace_id: "trace-excluded-retention",
        case_type: "manual",
        ingestion_purpose: "judge_api"
      }]);
      expect((await pool.query(
        `select member.case_id,member.raw_trace_id,item.payload_snapshot
         from analysis_population_members member
         join dataset_revision_items item on item.id=member.revision_item_id
         where member.id='apm_retention'`
      )).rows).toEqual([{
        case_id: "case_retention",
        raw_trace_id: "raw_retention",
        payload_snapshot: {
          input: { prompt: "hello-retention" },
          output: { answer: "world" },
          metadata: {}
        }
      }]);
    });
  });

  it("reuses visible same-class claims without locking duplicate ingestion against a population freeze", async () => {
    await withSchema("analysis_population_same_class_claim", async (pool) => {
      await runMigrations(pool);

      const freezeFirstActor = await seedProject(pool, "same_class_freeze_first");
      await seedSharedAnalysisOrigin(pool, freezeFirstActor, "same_class_freeze_first");
      const freezeFirstDigest = datasetInputIdentity({
        input: { prompt: "hello-same_class_freeze_first" }
      }).digest;
      const freezeFirst = await pool.connect();
      const duplicateSecond = await pool.connect();
      try {
        await freezeFirst.query("begin isolation level repeatable read");
        await insertAnalysisBundle(freezeFirst, freezeFirstActor, "same_class_freeze_first", {
          skipOriginInsert: true
        });
        await duplicateSecond.query("begin");
        await duplicateSecond.query("set local lock_timeout='250ms'");
        await duplicateSecond.query(
          `/* duplicate-after-population-freeze */ insert into case_input_identity_records
             (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
           values ('identity_duplicate_after_freeze',$1,'case_duplicate_after_freeze',
                   'authoring_import','input-identity/v1',$2)`,
          [freezeFirstActor.projectId, freezeFirstDigest]
        );
        await duplicateSecond.query("commit");
        await freezeFirst.query("commit");
      } finally {
        await Promise.allSettled([
          freezeFirst.query("rollback"),
          duplicateSecond.query("rollback")
        ]);
        freezeFirst.release();
        duplicateSecond.release();
      }

      const duplicateFirstActor = await seedProject(pool, "same_class_duplicate_first");
      await seedSharedAnalysisOrigin(pool, duplicateFirstActor, "same_class_duplicate_first");
      const duplicateFirstDigest = datasetInputIdentity({
        input: { prompt: "hello-same_class_duplicate_first" }
      }).digest;
      const duplicateFirst = await pool.connect();
      const freezeSecond = await pool.connect();
      try {
        await duplicateFirst.query("begin");
        await duplicateFirst.query(
          `/* duplicate-before-population-freeze */ insert into case_input_identity_records
             (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
           values ('identity_duplicate_before_freeze',$1,'case_duplicate_before_freeze',
                   'authoring_import','input-identity/v1',$2)`,
          [duplicateFirstActor.projectId, duplicateFirstDigest]
        );
        await freezeSecond.query("begin isolation level repeatable read");
        await freezeSecond.query("set local lock_timeout='250ms'");
        await insertAnalysisBundle(freezeSecond, duplicateFirstActor, "same_class_duplicate_first", {
          skipOriginInsert: true
        });
        await freezeSecond.query("commit");
        await duplicateFirst.query("commit");
      } finally {
        await Promise.allSettled([
          duplicateFirst.query("rollback"),
          freezeSecond.query("rollback")
        ]);
        duplicateFirst.release();
        freezeSecond.release();
      }

      expect((await pool.query(
        `select project_id,usage_class,count(*)::int as count
         from governed_input_identity_claims
         where project_id in ($1,$2)
         group by project_id,usage_class
         order by project_id`,
        [freezeFirstActor.projectId, duplicateFirstActor.projectId]
      )).rows).toEqual([
        { project_id: duplicateFirstActor.projectId, usage_class: "nonsealed", count: 1 },
        { project_id: freezeFirstActor.projectId, usage_class: "nonsealed", count: 1 }
      ]);
    });
  });

  it("structurally serializes nonsealed analysis identity against protected and finalized sealed evidence", async () => {
    await withSchema("analysis_population_identity_race", async (pool) => {
      await runMigrations(pool);
      const actor = await seedProject(pool, "analysis_population_identity_race");
      const nonsealedWinsDigest = `sha256:${"a".repeat(64)}`;
      const nonsealedWinner = await pool.connect();
      const protectedLoser = await pool.connect();
      try {
        await nonsealedWinner.query("begin isolation level repeatable read");
        await protectedLoser.query("begin isolation level repeatable read");
        await nonsealedWinner.query(
          `/* nonsealed-winner */ insert into case_input_identity_records
             (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
           values ('identity_nonsealed_winner',$1,'case_nonsealed_winner','authoring_import',
                   'input-identity/v1',$2)`,
          [actor.projectId, nonsealedWinsDigest]
        );
        const blockedProtected = insertProtectedSealedItem(
          protectedLoser,
          actor,
          "protected_loser",
          nonsealedWinsDigest,
          "/* protected-sealed-loser */"
        );
        const protectedOutcome = blockedProtected.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );
        await waitForBlockedQuery(pool, "protected-sealed-loser");
        await nonsealedWinner.query("commit");
        const protectedResult = await protectedOutcome;
        expect(protectedResult.ok).toBe(false);
        if (!protectedResult.ok) {
          expect(protectedResult.error).toMatchObject({ code: expect.stringMatching(/^(23514|40001)$/) });
        }
        await protectedLoser.query("rollback");
      } finally {
        nonsealedWinner.release();
        protectedLoser.release();
      }
      expect((await pool.query(
        `select usage_class from governed_input_identity_claims
         where project_id=$1 and input_digest=$2`,
        [actor.projectId, nonsealedWinsDigest]
      )).rows).toEqual([{ usage_class: "nonsealed" }]);

      const sealedWinsDigest = `sha256:${"b".repeat(64)}`;
      await pool.query(
        `insert into dataset_revisions
           (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
            content_digest,revision_digest,item_count,provenance_level)
         values ('dsr_finalized_sealed',$1,'sealed:race',1,'sealed_validation','sealed_intake',
                 'input-identity/v1',$2,$3,1,'governed_blind')`,
        [actor.projectId, `sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`]
      );
      const sealedWinner = await pool.connect();
      const nonsealedLoser = await pool.connect();
      try {
        await sealedWinner.query("begin isolation level repeatable read");
        await nonsealedLoser.query("begin isolation level repeatable read");
        await sealedWinner.query(
          `/* finalized-sealed-winner */ insert into dataset_revision_items
             (id,revision_id,project_id,position,source_case_id,source_trace_id,
              source_dataset_item_id,source_golden_entry_id,input_digest,item_digest,
              payload_snapshot,reference_provenance)
           values ('dsri_finalized_sealed','dsr_finalized_sealed',$1,0,null,null,null,null,
                   $2,$3,'{"input":{},"output":{},"metadata":{}}',
                   '{"kind":"unlabeled","sourceId":null,"verdictIds":[],"actorUserIds":[],"basis":"sealed race"}')`,
          [actor.projectId, sealedWinsDigest, `sha256:${"e".repeat(64)}`]
        );
        const blockedNonsealed = nonsealedLoser.query(
          `/* finalized-nonsealed-loser */ insert into case_input_identity_records
             (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
           values ('identity_nonsealed_loser',$1,'case_nonsealed_loser','authoring_import',
                   'input-identity/v1',$2)`,
          [actor.projectId, sealedWinsDigest]
        );
        const nonsealedOutcome = blockedNonsealed.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );
        await waitForBlockedQuery(pool, "finalized-nonsealed-loser");
        await sealedWinner.query("commit");
        const nonsealedResult = await nonsealedOutcome;
        expect(nonsealedResult.ok).toBe(false);
        if (!nonsealedResult.ok) {
          expect(nonsealedResult.error).toMatchObject({ code: expect.stringMatching(/^(23514|40001)$/) });
        }
        await nonsealedLoser.query("rollback");
      } finally {
        sealedWinner.release();
        nonsealedLoser.release();
      }
      expect((await pool.query(
        `select usage_class from governed_input_identity_claims
         where project_id=$1 and input_digest=$2`,
        [actor.projectId, sealedWinsDigest]
      )).rows).toEqual([{ usage_class: "sealed" }]);
    });
  });
});
