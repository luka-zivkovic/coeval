import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import {
  ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
  ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
  CreateSkillVersionInputSchema,
  MinimumVerdictOutputSchema,
  type AnalysisCriterionPromotionCreateInput,
  type AnalysisCriterionPromotionHandoff,
  type AnalysisCriterionPromotionSupportArtifact
} from "@coeval/shared";
import { PgAnalysisPopulationRepository } from "../src/analysis-population/repository.pg.js";
import { PgAnalysisPromotionRepository } from "../src/analysis-promotion/repository.pg.js";
import { PgAnalysisStudyRepository } from "../src/analysis-study/repository.pg.js";
import { PgAnalysisMeasurementRepository } from "../src/analysis-measurement/repository.pg.js";
import { PgBinaryCalibrationRepository } from "../src/binary-calibration/repository.pg.js";
import { PgEvaluatorLifecycleRepository } from "../src/evaluator-lifecycle/repository.pg.js";
import { PgGovernedReviewRepository } from "../src/governed-review/repository.pg.js";
import {
  analysisCriterionPromotionContentDigest,
  analysisCriterionPromotionHandoffDigest,
  analysisCriterionPromotionRequestDigest,
  analysisCriterionPromotionStableKey,
  analysisCriterionPromotionSupportContentDigest,
  analysisCriterionPromotionSupportSetDigest
} from "../src/lib/analysis-promotion.js";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { evaluatorSuiteCriterionDigest } from "../src/lib/evaluator-suite.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; analysis promotion PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

async function withSchema(
  name: string,
  migrate: boolean,
  body: (pool: Pool, schema: string) => Promise<void>
): Promise<void> {
  const { pool, schema, cleanup } = await openPostgresTestDatabase(name);
  try {
    if (migrate) await runMigrations(pool);
    await body(pool, schema);
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
    `insert into "user" (id,name,email,email_verified) values
       ($1,$2,$3,true),($4,$5,$6,true)`,
    [ownerId, `${suffix} owner`, `${suffix}-owner@example.test`,
      memberId, `${suffix} member`, `${suffix}-member@example.test`]
  );
  await pool.query("insert into organizations (id,name) values ($1,$2)", [organizationId, suffix]);
  await pool.query(
    `insert into projects (id,organization_id,name,trace_provider)
     values ($1,$2,$3,'manual')`,
    [projectId, organizationId, suffix]
  );
  await pool.query(
    `insert into project_members (id,project_id,user_id,role) values
       ($1,$2,$3,'owner'),($4,$2,$5,'member')`,
    [`pm_owner_${suffix}`, projectId, ownerId, `pm_member_${suffix}`, memberId]
  );
  return {
    owner: { projectId, userId: ownerId, projectRole: "owner" as const },
    member: { projectId, userId: memberId, projectRole: "member" as const }
  };
}

async function seedEligibleCase(pool: Pool, projectId: string, suffix: string): Promise<void> {
  const payload = {
    input: { question: `Question ${suffix}?` },
    output: { answer: `Wrong ${suffix}` },
    metadata: { retained: true },
    steps: [{ name: "answer", input: { prompt: "answer" }, output: `Wrong ${suffix}` }]
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
  await pool.query(
    `insert into case_input_identity_records
       (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
     values ($1,$2,$3,'authoring_import','input-identity/v1',$4)`,
    [`identity_${suffix}`, projectId, `case_${suffix}`, datasetInputIdentity({ input: payload.input }).digest]
  );
}

interface PromotionEvidence {
  projectId: string;
  ownerUserId: string;
  ownerSubjectId: string;
  memberUserId: string;
  memberSubjectId: string;
  studyId: string;
  closureId: string;
  closureDigest: string;
  populationId: string;
  drawId: string;
  sourceRevisionId: string;
  sourceRevisionContentDigest: string;
  sourceRevisionDigest: string;
  sourceRevisionProvenanceLevel: string;
  sourceRevisionItemId: string;
  sourceItemDigest: string;
  studyItemId: string;
  closureItemId: string;
  closureItemDigest: string;
  observationEventId: string;
  observationEventDigest: string;
  assignmentEventId: string;
  assignmentEventDigest: string;
  taxonomyId: string;
  taxonomyRevisionId: string;
  taxonomyRevisionSequence: number;
  taxonomyRevisionDigest: string;
  codeId: string;
  codeEntryId: string;
  codeEntryDigest: string;
  codeLabel: string;
  codeDefinition: string;
}

async function seedPromotionEvidence(pool: Pool, suffix: string): Promise<PromotionEvidence> {
  const actors = await seedProject(pool, suffix);
  await seedEligibleCase(pool, actors.owner.projectId, suffix);
  const population = await new PgAnalysisPopulationRepository(pool).createPopulation(actors.owner, {
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-02-01T00:00:00.000Z",
    fixedBudget: 1,
    idempotencyKey: `${suffix}-population`
  });
  const repository = new PgAnalysisStudyRepository(pool);
  const created = await repository.createStudy(actors.owner, {
    populationId: population.population.id,
    idempotencyKey: `${suffix}-study`
  });
  const opened = await repository.openStudy(actors.owner, created.study.study.id, {
    expectedVersion: "0",
    stoppingRule: { kind: "explicit_owner_close", closeAt: null },
    idempotencyKey: `${suffix}-open`
  });
  const page = await repository.listStudyItems(actors.owner, created.study.study.id, {
    limit: 10,
    cursor: null
  });
  const item = page!.items[0]!;
  const observed = await repository.appendStudyItemEvent(
    actors.member,
    created.study.study.id,
    item.item.id,
    {
      eventType: "failure_observed",
      expectedVersion: "0",
      failureLabel: "Incorrect answer",
      rationale: "The retained answer is substantively incorrect.",
      evidenceAnchor: { kind: "case_output" },
      idempotencyKey: `${suffix}-observe`
    }
  );
  const taxonomy = await repository.createTaxonomy(actors.owner, {
    name: "Promotion taxonomy",
    description: "Exact failure codes for promotion tests.",
    reason: "Initial promotion evidence.",
    codes: [{
      kind: "new",
      clientToken: "incorrect-answer",
      label: "Incorrect answer",
      definition: "The final answer is substantively incorrect."
    }],
    idempotencyKey: `${suffix}-taxonomy`
  });
  const assigned = await repository.appendObservationAssignment(
    actors.member,
    taxonomy.taxonomy.id,
    {
      eventType: "assigned",
      observationEventId: observed.event.id,
      taxonomyRevisionId: taxonomy.revision.revision.id,
      codeId: taxonomy.revision.codes[0]!.codeId,
      expectedVersion: "0",
      expectedPredecessorEventId: null,
      expectedPredecessorEventDigest: null,
      rationale: "The observation matches the exact active code.",
      idempotencyKey: `${suffix}-assign`
    }
  );
  await repository.appendStudyItemEvent(
    actors.member,
    created.study.study.id,
    item.item.id,
    { eventType: "coding_completed", expectedVersion: "1", idempotencyKey: `${suffix}-complete-item` }
  );
  await repository.closeStudy(actors.owner, created.study.study.id, {
    expectedVersion: opened.event.version,
    reason: "Coding evidence is complete.",
    idempotencyKey: `${suffix}-close`
  });
  const evidence = (await pool.query(
    `select study.id as study_id,study.population_id,study.draw_id,
            revision.id as source_revision_id,
            revision.content_digest as source_revision_content_digest,
            revision.revision_digest as source_revision_digest,
            revision.provenance_level as source_revision_provenance_level,
            closure.id as closure_id,closure.closure_digest,
            study_item.id as study_item_id,study_item.revision_item_id,
            revision_item.item_digest as source_item_digest,
            closure_item.id as closure_item_id,closure_item.content_digest as closure_item_digest,
            observation.id as observation_event_id,observation.event_digest as observation_event_digest,
            assignment.id as assignment_event_id,assignment.event_digest as assignment_event_digest,
            taxonomy.id as taxonomy_id,taxonomy_revision.id as taxonomy_revision_id,
            taxonomy_revision.sequence as taxonomy_revision_sequence,
            taxonomy_revision.revision_digest as taxonomy_revision_digest,
            code_entry.code_id,code_entry.id as code_entry_id,
            code_entry.entry_digest as code_entry_digest,
            code_entry.label as code_label,code_entry.definition as code_definition,
            owner_subject.id as owner_subject_id,member_subject.id as member_subject_id
     from analysis_studies study
     join dataset_revisions revision on revision.id=study.dataset_revision_id
     join analysis_study_closures closure on closure.study_id=study.id
     join analysis_study_items study_item on study_item.study_id=study.id
     join dataset_revision_items revision_item on revision_item.id=study_item.revision_item_id
     join analysis_study_closure_items closure_item
       on closure_item.closure_id=closure.id and closure_item.study_item_id=study_item.id
     join analysis_study_item_events observation on observation.id=$2
     join analysis_observation_assignment_events assignment on assignment.id=$3
     join analysis_failure_taxonomies taxonomy on taxonomy.id=$4
     join analysis_failure_taxonomy_revisions taxonomy_revision on taxonomy_revision.id=$5
     join analysis_failure_taxonomy_revision_codes code_entry
       on code_entry.taxonomy_revision_id=taxonomy_revision.id and code_entry.code_id=$6
     join governed_reviewer_subjects owner_subject
       on owner_subject.project_id=study.project_id and owner_subject.account_user_id=$7
     join governed_reviewer_subjects member_subject
       on member_subject.project_id=study.project_id and member_subject.account_user_id=$8
     where study.id=$1`,
    [created.study.study.id, observed.event.id, assigned.event.id, taxonomy.taxonomy.id,
      taxonomy.revision.revision.id, taxonomy.revision.codes[0]!.codeId,
      actors.owner.userId, actors.member.userId]
  )).rows[0]!;
  return {
    projectId: actors.owner.projectId,
    ownerUserId: actors.owner.userId,
    ownerSubjectId: String(evidence.owner_subject_id),
    memberUserId: actors.member.userId,
    memberSubjectId: String(evidence.member_subject_id),
    studyId: String(evidence.study_id),
    closureId: String(evidence.closure_id),
    closureDigest: String(evidence.closure_digest),
    populationId: String(evidence.population_id),
    drawId: String(evidence.draw_id),
    sourceRevisionId: String(evidence.source_revision_id),
    sourceRevisionContentDigest: String(evidence.source_revision_content_digest),
    sourceRevisionDigest: String(evidence.source_revision_digest),
    sourceRevisionProvenanceLevel: String(evidence.source_revision_provenance_level),
    sourceRevisionItemId: String(evidence.revision_item_id),
    sourceItemDigest: String(evidence.source_item_digest),
    studyItemId: String(evidence.study_item_id),
    closureItemId: String(evidence.closure_item_id),
    closureItemDigest: String(evidence.closure_item_digest),
    observationEventId: String(evidence.observation_event_id),
    observationEventDigest: String(evidence.observation_event_digest),
    assignmentEventId: String(evidence.assignment_event_id),
    assignmentEventDigest: String(evidence.assignment_event_digest),
    taxonomyId: String(evidence.taxonomy_id),
    taxonomyRevisionId: String(evidence.taxonomy_revision_id),
    taxonomyRevisionSequence: Number(evidence.taxonomy_revision_sequence),
    taxonomyRevisionDigest: String(evidence.taxonomy_revision_digest),
    codeId: String(evidence.code_id),
    codeEntryId: String(evidence.code_entry_id),
    codeEntryDigest: String(evidence.code_entry_digest),
    codeLabel: String(evidence.code_label),
    codeDefinition: String(evidence.code_definition)
  };
}

interface InsertedPromotion {
  promotionId: string;
  supportId: string;
  criterionId: string;
  criterionVersionId: string;
  criterionDigest: string;
  createdAt: string;
}

async function insertPromotionBundle(
  client: PoolClient,
  evidence: PromotionEvidence,
  suffix: string,
  options: {
    omitCriterion?: boolean;
    omitSupport?: boolean;
    omitExposures?: boolean;
    contentDigestOverride?: string;
    assignmentEventIdOverride?: string;
    beforeExposures?: (
      client: PoolClient,
      promotion: InsertedPromotion
    ) => Promise<void>;
    afterExposures?: (
      client: PoolClient,
      promotion: InsertedPromotion
    ) => Promise<void>;
  } = {}
): Promise<InsertedPromotion> {
  const promotionId = `promotion_${suffix}`;
  const supportId = `promotion_support_${suffix}`;
  const criterionId = `criterion_${suffix}`;
  const criterionVersionId = `criterionv_${suffix}`;
  const criterionAuthoringExposureEventId = `exposure_authoring_${suffix}`;
  const exampleSelectionExposureEventId = `exposure_support_${suffix}`;
  const criterionName = "Incorrect answer criterion";
  const criterionDefinition = "The response must provide a substantively correct final answer.";
  const rationale = "The exact closed study observation supports a narrow reusable criterion.";
  const criterionDigest = evaluatorSuiteCriterionDigest({
    criterionId,
    criterionVersionId,
    criterionName,
    criterionDefinition
  });
  const supportContent = {
    promotionId,
    position: 0,
    studyId: evidence.studyId,
    studyItemId: evidence.studyItemId,
    closureId: evidence.closureId,
    closureItemId: evidence.closureItemId,
    closureItemDigest: evidence.closureItemDigest,
    sourceDatasetRevisionId: evidence.sourceRevisionId,
    sourceDatasetRevisionItemId: evidence.sourceRevisionItemId,
    sourceItemDigest: evidence.sourceItemDigest,
    observationEventId: evidence.observationEventId,
    observationEventDigest: evidence.observationEventDigest,
    assignmentEventId: options.assignmentEventIdOverride ?? evidence.assignmentEventId,
    assignmentEventDigest: evidence.assignmentEventDigest,
    observationAuthorSubjectId: evidence.memberSubjectId,
    exampleSelectionExposureEventId
  };
  const support: AnalysisCriterionPromotionSupportArtifact = {
    id: supportId,
    projectId: evidence.projectId,
    ...supportContent,
    contentDigest: analysisCriterionPromotionSupportContentDigest(supportContent),
    createdAt: "1970-01-01T00:00:00.000Z"
  };
  const supportSetDigest = analysisCriterionPromotionSupportSetDigest(promotionId, [support]);
  const handoffWithoutDigest: Omit<AnalysisCriterionPromotionHandoff, "handoffDigest"> = {
    handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    promotionId,
    projectId: evidence.projectId,
    criterionId,
    criterionVersionId,
    criterionDigest,
    sourceDatasetRevisionId: evidence.sourceRevisionId,
    sourceDatasetRevisionContentDigest: evidence.sourceRevisionContentDigest,
    sourceDatasetRevisionDigest: evidence.sourceRevisionDigest,
    roleIntent: "analysis_authoring",
    sourceKind: "analysis_promotion_handoff",
    evidenceClass: "development_authoring_not_truth",
    createsTruth: false,
    createsEvaluator: false
  };
  const handoffDigest = analysisCriterionPromotionHandoffDigest(handoffWithoutDigest);
  const createInput: AnalysisCriterionPromotionCreateInput = {
    studyId: evidence.studyId,
    expectedClosureId: evidence.closureId,
    expectedClosureDigest: evidence.closureDigest,
    taxonomyId: evidence.taxonomyId,
    taxonomyRevisionId: evidence.taxonomyRevisionId,
    expectedTaxonomyRevisionDigest: evidence.taxonomyRevisionDigest,
    codeId: evidence.codeId,
    expectedCodeEntryDigest: evidence.codeEntryDigest,
    criterionName,
    criterionDefinition,
    rationale,
    supportingObservations: [{
      studyItemId: evidence.studyItemId,
      closureItemId: evidence.closureItemId,
      closureItemDigest: evidence.closureItemDigest,
      observationEventId: evidence.observationEventId,
      observationEventDigest: evidence.observationEventDigest,
      assignmentEventId: options.assignmentEventIdOverride ?? evidence.assignmentEventId,
      assignmentEventDigest: evidence.assignmentEventDigest
    }],
    idempotencyKey: `${suffix}-promotion-command`
  };
  const criterionStableKey = analysisCriterionPromotionStableKey(evidence.codeId);
  const promotionContent = {
    contractVersion: ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
    projectId: evidence.projectId,
    studyId: evidence.studyId,
    studyClosureId: evidence.closureId,
    studyClosureDigest: evidence.closureDigest,
    populationId: evidence.populationId,
    drawId: evidence.drawId,
    sourceDatasetRevisionId: evidence.sourceRevisionId,
    sourceDatasetRevisionContentDigest: evidence.sourceRevisionContentDigest,
    sourceDatasetRevisionDigest: evidence.sourceRevisionDigest,
    taxonomyId: evidence.taxonomyId,
    taxonomyRevisionId: evidence.taxonomyRevisionId,
    taxonomyRevisionSequence: evidence.taxonomyRevisionSequence,
    taxonomyRevisionDigest: evidence.taxonomyRevisionDigest,
    codeId: evidence.codeId,
    codeEntryId: evidence.codeEntryId,
    codeEntryDigest: evidence.codeEntryDigest,
    codeLabel: evidence.codeLabel,
    codeDefinition: evidence.codeDefinition,
    criterionId,
    criterionVersionId,
    criterionStableKey,
    criterionName,
    criterionDefinition,
    criterionDigest,
    rationale,
    supportCount: 1,
    supportSetDigest,
    criterionAuthoringExposureEventId,
    promotedBySubjectId: evidence.ownerSubjectId,
    handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
    handoffDigest
  } as const;
  const contentDigest = options.contentDigestOverride
    ?? analysisCriterionPromotionContentDigest(promotionContent);
  const requestDigest = analysisCriterionPromotionRequestDigest(evidence.projectId, createInput);

  await client.query("begin");
  try {
    const inserted = (await client.query(
      `insert into analysis_criterion_promotions
        (id,project_id,contract_version,study_id,study_closure_id,study_closure_digest,
         population_id,draw_id,source_dataset_revision_id,
         source_dataset_revision_content_digest,source_dataset_revision_digest,
         taxonomy_id,taxonomy_revision_id,taxonomy_revision_sequence,taxonomy_revision_digest,
         code_id,code_entry_id,code_entry_digest,code_label,code_definition,
         criterion_id,criterion_version_id,criterion_stable_key,criterion_name,
         criterion_definition,criterion_digest,rationale,support_count,support_set_digest,
         criterion_authoring_exposure_event_id,promoted_by_user_id,promoted_by_subject_id,
         promoter_role,idempotency_key,request_digest,content_digest,handoff_version,handoff_digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,1,$28,$29,$30,$31,'owner',$32,$33,$34,$35,$36)
       returning created_at`,
      [promotionId, evidence.projectId, ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
        evidence.studyId, evidence.closureId, evidence.closureDigest, evidence.populationId,
        evidence.drawId, evidence.sourceRevisionId, evidence.sourceRevisionContentDigest,
        evidence.sourceRevisionDigest, evidence.taxonomyId, evidence.taxonomyRevisionId,
        evidence.taxonomyRevisionSequence, evidence.taxonomyRevisionDigest, evidence.codeId,
        evidence.codeEntryId, evidence.codeEntryDigest, evidence.codeLabel, evidence.codeDefinition,
        criterionId, criterionVersionId, criterionStableKey, criterionName, criterionDefinition,
        criterionDigest, rationale, supportSetDigest, criterionAuthoringExposureEventId,
        evidence.ownerUserId, evidence.ownerSubjectId, createInput.idempotencyKey, requestDigest,
        contentDigest, ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION, handoffDigest]
    )).rows[0]!;
    const createdAt = new Date(inserted.created_at).toISOString();
    if (!options.omitCriterion) await client.query(
      `insert into criteria
        (id,project_id,stable_key,source_kind,created_by_user_id,created_at)
       values ($1,$2,$3,'analysis_promotion',$4,$5)`,
      [criterionId, evidence.projectId, criterionStableKey, evidence.ownerUserId, createdAt]
    );
    if (!options.omitCriterion) await client.query(
      `insert into criterion_versions
        (id,project_id,criterion_id,revision,name,definition,criterion_digest,
         source_kind,created_by_user_id,created_at)
       values ($1,$2,$3,1,$4,$5,$6,'analysis_promotion',$7,$8)`,
      [criterionVersionId, evidence.projectId, criterionId, criterionName, criterionDefinition,
        criterionDigest, evidence.ownerUserId, createdAt]
    );
    if (!options.omitSupport) await client.query(
      `insert into analysis_criterion_promotion_supports
        (id,project_id,promotion_id,position,study_id,study_item_id,closure_id,
         closure_item_id,closure_item_digest,source_dataset_revision_id,
         source_dataset_revision_item_id,source_item_digest,observation_event_id,
         observation_event_digest,assignment_event_id,assignment_event_digest,
         observation_author_user_id,observation_author_subject_id,
         example_selection_exposure_event_id,content_digest,created_at)
       values ($1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [supportId, evidence.projectId, promotionId, evidence.studyId, evidence.studyItemId,
        evidence.closureId, evidence.closureItemId, evidence.closureItemDigest,
        evidence.sourceRevisionId, evidence.sourceRevisionItemId, evidence.sourceItemDigest,
        evidence.observationEventId, evidence.observationEventDigest, evidence.assignmentEventId,
        evidence.assignmentEventDigest, evidence.memberUserId, evidence.memberSubjectId,
        exampleSelectionExposureEventId, support.contentDigest, createdAt]
    );
    if (options.beforeExposures) await options.beforeExposures(client, {
      promotionId,
      supportId,
      criterionId,
      criterionVersionId,
      criterionDigest,
      createdAt
    });
    if (!options.omitExposures) await client.query(
      `insert into dataset_exposure_events
        (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,
         subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,
         reason,details,idempotency_key,occurred_at)
       values ($1,$2,$3,null,'development_use','development','criterion_authoring',
               'person',$4,$5,'analysis_criterion_promotion',$6,
               'Analysis failure-code criterion authoring',$7::jsonb,$8,$9)`,
      [criterionAuthoringExposureEventId, evidence.projectId, evidence.sourceRevisionId,
        evidence.ownerSubjectId, evidence.ownerUserId, promotionId, JSON.stringify({
          contract: "coeval/analysis-criterion-promotion-exposure/v1",
          promotionId,
          criterionId,
          criterionVersionId,
          studyId: evidence.studyId,
          studyClosureId: evidence.closureId,
          taxonomyId: evidence.taxonomyId,
          taxonomyRevisionId: evidence.taxonomyRevisionId,
          codeId: evidence.codeId
        }), `analysis-promotion:criterion-authoring:${promotionId}`, createdAt]
    );
    if (!options.omitExposures && !options.omitSupport) await client.query(
      `insert into dataset_exposure_events
        (id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,
         subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,
         reason,details,idempotency_key,occurred_at)
       values ($1,$2,$3,$4,'development_use','development','example_selection',
               'person',$5,$6,'analysis_criterion_promotion',$7,
               'Analysis promotion supporting observation',$8::jsonb,$9,$10)`,
      [exampleSelectionExposureEventId, evidence.projectId, evidence.sourceRevisionId,
        evidence.sourceRevisionItemId, evidence.memberSubjectId, evidence.ownerUserId, promotionId,
        JSON.stringify({
          contract: "coeval/analysis-criterion-promotion-support-exposure/v1",
          promotionId,
          promotionSupportId: supportId,
          criterionId,
          criterionVersionId,
          studyId: evidence.studyId,
          studyItemId: evidence.studyItemId,
          closureItemId: evidence.closureItemId,
          observationEventId: evidence.observationEventId,
          assignmentEventId: evidence.assignmentEventId
        }), `analysis-promotion:example-selection:${promotionId}:${supportId}`, createdAt]
    );
    if (options.afterExposures) await options.afterExposures(client, {
      promotionId,
      supportId,
      criterionId,
      criterionVersionId,
      criterionDigest,
      createdAt
    });
    await client.query("commit");
    return { promotionId, supportId, criterionId, criterionVersionId, criterionDigest, createdAt };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function dbDigest(client: PoolClient, kind: string, value: unknown): Promise<string> {
  return String((await client.query(
    "select governed_content_v1_digest($1,$2::jsonb) as digest",
    [kind, JSON.stringify(value)]
  )).rows[0]!.digest);
}

async function insertPromotionHandoffBatch(
  client: PoolClient,
  evidence: PromotionEvidence,
  promotion: InsertedPromotion,
  suffix: string
): Promise<string> {
  const instructionId = `instruction_${suffix}`;
  const instruction = {
    allowedLabels: ["pass", "fail", "cannot_determine"],
    criterionVersionId: promotion.criterionVersionId,
    failureCodeGuidance: "Record exact observed failures only.",
    id: instructionId,
    instructions: "Review the immutable analysis item against this exact criterion.",
    predecessorInstructionVersionId: null,
    revision: 1,
    title: "Promoted criterion review"
  };
  await client.query(
    `insert into review_instruction_versions
      (id,project_id,criterion_version_id,revision,title,instructions,allowed_labels,
       failure_code_guidance,content_digest,created_by_subject_id)
     values ($1,$2,$3,1,$4,$5,array['pass','fail','cannot_determine'],$6,$7,$8)`,
    [instructionId, evidence.projectId, promotion.criterionVersionId, instruction.title,
      instruction.instructions, instruction.failureCodeGuidance,
      await dbDigest(client, "review-instruction/v1", instruction), evidence.ownerSubjectId]
  );
  const promotionRow = (await client.query(
    "select handoff_digest from analysis_criterion_promotions where id=$1",
    [promotion.promotionId]
  )).rows[0]!;
  const populationDefinition = {
    kind: "analysis_promotion_handoff",
    promotionId: promotion.promotionId,
    sourceDatasetRevisionId: evidence.sourceRevisionId,
    criterionVersionId: promotion.criterionVersionId,
    handoffDigest: String(promotionRow.handoff_digest)
  };
  const collectionProvenance = {
    kind: "analysis_promotion_handoff",
    promotionId: promotion.promotionId,
    handoffDigest: String(promotionRow.handoff_digest),
    revisionDigest: evidence.sourceRevisionDigest,
    provenanceLevel: evidence.sourceRevisionProvenanceLevel,
    sourceKind: "analysis_population",
    evidenceClass: "development_authoring_not_truth",
    createsTruth: false,
    createsEvaluator: false
  };
  const batchId = `review_batch_${suffix}`;
  const stopAt = "2027-01-01T00:00:00.000Z";
  const drawDigest = `sha256:${"a".repeat(64)}`;
  const batchDigest = String((await client.query(
    `select governed_content_v1_digest('governed-review-batch/v1', jsonb_build_object(
       'criterionVersionId',$1::text,
       'custodianRoleAtReview',null,
       'custodianSubjectId',null,
       'drawDigest',$2::text,
       'drawExecutedBy','coeval_server',
       'evaluatorBlind',true,
       'fixedBudget',1,
       'instructionVersionId',$3::text,
       'peerBlindUntilLabelingClosed',true,
       'populationCollectionProvenance',$4::jsonb,
       'populationDefinition',$5::jsonb,
       'populationDigest',$6::text,
       'populationId',$7::text,
       'populationSize',1,
       'requiredLabelsPerItem',1,
       'rngVersion',null,
       'roleIntent','analysis_authoring',
       'selectionAlgorithmVersion','manual/v1',
       'selectionMethod','manual',
       'selectionSeed',null,
       'separationOfDutiesRequired',false,
       'sourcePopulationId',$8::text,
       'sourcePopulationKind','analysis_promotion_handoff',
       'stateMachineVersion','governed-review-state/v1',
       'stopAt',$9::timestamptz,
       'stoppingRule','fixed',
       'strata','[]'::jsonb,
       'windowEnd',null,
       'windowStart',null
     )) as digest`,
    [promotion.criterionVersionId, drawDigest, instructionId,
      JSON.stringify(collectionProvenance), JSON.stringify(populationDefinition),
      evidence.sourceRevisionContentDigest, evidence.sourceRevisionId,
      promotion.promotionId, stopAt]
  )).rows[0]!.digest);
  await client.query(
    `insert into governed_review_batches
      (id,project_id,criterion_version_id,instruction_version_id,role_intent,
       source_population_kind,source_population_id,population_id,population_definition,
       population_collection_provenance,population_size,population_digest,
       window_start,window_end,selection_method,selection_seed,rng_version,
       selection_algorithm_version,draw_executed_by,fixed_budget,stopping_rule,stop_at,
       draw_digest,strata,required_labels_per_item,evaluator_blind,
       peer_blind_until_labeling_closed,separation_of_duties_required,
       custodian_subject_id,custodian_role_at_review,state_machine_version,content_digest,
       idempotency_key,request_digest,created_by_subject_id)
     values ($1,$2,$3,$4,'analysis_authoring','analysis_promotion_handoff',$5,$6,$7::jsonb,
             $8::jsonb,1,$9,null,null,'manual',null,null,'manual/v1','coeval_server',1,
             'fixed',$10,$11,'[]'::jsonb,1,true,true,false,null,null,
             'governed-review-state/v1',$12,$13,$14,$15)`,
    [batchId, evidence.projectId, promotion.criterionVersionId, instructionId,
      promotion.promotionId, evidence.sourceRevisionId, JSON.stringify(populationDefinition),
      JSON.stringify(collectionProvenance), evidence.sourceRevisionContentDigest, stopAt,
      drawDigest, batchDigest, `${suffix}-batch`, `sha256:${"b".repeat(64)}`,
      evidence.ownerSubjectId]
  );
  return batchId;
}

async function insertEligibleCapabilityCheck(
  client: PoolClient,
  input: {
    id: string;
    projectId: string;
    batchId: string;
    criterionVersionId: string;
    subjectId: string;
  }
): Promise<void> {
  const coveredCapabilities = [
    "criterion_authoring", "instruction_authoring", "evaluator_authoring",
    "rubric_authoring", "prompt_authoring", "example_selection", "development_exposure"
  ];
  const evidence = { basis: "promotion-capability-predevelopment/v1" };
  const evidenceDigest = await dbDigest(client, "sealed-separation-evidence/v1", evidence);
  const contentDigest = await dbDigest(client, "governed-review-capability-check/v1", {
    batchId: input.batchId,
    capabilityQueryVersion: "sealed-separation/v1",
    checkScope: "batch_open",
    coveredCapabilities,
    evidenceDigest,
    evaluatorVersionId: null,
    excludedCapabilities: [],
    result: "eligible",
    sequence: 1,
    subjectId: input.subjectId,
    unknownCapabilities: [],
    verificationMethod: "system_derived"
  });
  await client.query(
    `insert into governed_review_capability_checks
      (id,project_id,batch_id,criterion_version_id,evaluator_version_id,subject_id,
       sequence,expected_previous_sequence,check_scope,result,verification_method,
       capability_query_version,covered_capabilities,excluded_capabilities,
       unknown_capabilities,evidence,evidence_digest,content_digest,idempotency_key,
       request_digest)
     values ($1,$2,$3,$4,null,$5,1,0,'batch_open','eligible','system_derived',
       'sealed-separation/v1',$6::text[],array[]::text[],array[]::text[],
       $7::jsonb,$8,$9,$10,$11)`,
    [input.id, input.projectId, input.batchId, input.criterionVersionId, input.subjectId,
      coveredCapabilities, JSON.stringify(evidence), evidenceDigest, contentDigest,
      `${input.id}-idempotency`, `sha256:${"d".repeat(64)}`]
  );
}

async function expectPgCode(
  action: Promise<unknown>,
  codes: readonly string[]
): Promise<void> {
  try {
    await action;
    throw new Error("expected PostgreSQL rejection");
  } catch (error) {
    expect(codes).toContain((error as { code?: string }).code);
  }
}

run("PostgreSQL analysis criterion promotion persistence", () => {
  it("does not invent an evaluator lifecycle for a criterion promotion", async () => {
    await withSchema("promotion_without_lifecycle", true, async (pool) => {
      const client = await pool.connect();
      try {
        const evidence = await seedPromotionEvidence(pool, "promotion_without_lifecycle");
        const promotion = await insertPromotionBundle(client, evidence, "promotion_without_lifecycle");
        expect(Number((await pool.query(
          `select count(*) as count from skills where criterion_id=$1`, [promotion.criterionId]
        )).rows[0]!.count)).toBe(0);
        expect(Number((await pool.query(
          `select count(*) as count from evaluator_lifecycles where criterion_id=$1`,
          [promotion.criterionId]
        )).rows[0]!.count)).toBe(0);
        expect((await pool.query(
          `select source_kind from criteria where id=$1`, [promotion.criterionId]
        )).rows).toEqual([{ source_kind: "analysis_promotion" }]);
      } finally {
        client.release();
      }
    });
  });

  it("rolls back incomplete and tampered direct-SQL bundles without laundering evidence", async () => {
    await withSchema("promotion_tamper", true, async (pool) => {
      const evidence = await seedPromotionEvidence(pool, "promotion_tamper");
      const client = await pool.connect();
      try {
        await expectPgCode(
          insertPromotionBundle(client, evidence, "missing_criterion", { omitCriterion: true }),
          ["23503", "23514"]
        );
        await expectPgCode(
          insertPromotionBundle(client, evidence, "missing_support", { omitSupport: true }),
          ["23503", "23514"]
        );
        await expectPgCode(
          insertPromotionBundle(client, evidence, "missing_exposure", { omitExposures: true }),
          ["23503", "23514"]
        );
        await expectPgCode(
          insertPromotionBundle(client, evidence, "tampered_digest", {
            contentDigestOverride: `sha256:${"f".repeat(64)}`
          }),
          ["23514"]
        );
        await expectPgCode(
          insertPromotionBundle(client, evidence, "swapped_assignment", {
            assignmentEventIdOverride: "assignment_from_another_observation"
          }),
          ["23503", "23514"]
        );
        await expect(insertPromotionBundle(client, evidence, "same_tx_sealed_batch", {
          beforeExposures: async (transaction, promotion) => {
            await transaction.query(
              `insert into governed_review_batches
                (id,project_id,criterion_version_id,instruction_version_id,role_intent,
                 source_population_kind,source_population_id,population_id,
                 population_definition,population_collection_provenance,population_size,
                 population_digest,window_start,window_end,selection_method,selection_seed,
                 rng_version,selection_algorithm_version,draw_executed_by,fixed_budget,
                 stopping_rule,stop_at,draw_digest,strata,required_labels_per_item,
                 evaluator_blind,peer_blind_until_labeling_closed,
                 separation_of_duties_required,custodian_subject_id,custodian_role_at_review,
                 state_machine_version,content_digest,idempotency_key,request_digest,
                 created_by_subject_id)
               values ('same_tx_sealed_attack',$1,$2,'sealed_attack_instruction',
                 'sealed_validation','sealed_intake','sealed_attack_population',
                 'sealed_attack_population','{}','{}',1,$3,null,null,'manual',null,null,
                 'manual/v1','coeval_server',1,'fixed','2099-01-01T00:00:00.000Z',$3,
                 '[]',2,true,true,true,$4,'owner','governed-review-state/v1',$3,
                 'same-tx-sealed-attack',$3,$4)`,
              [evidence.projectId, promotion.criterionVersionId,
                `sha256:${"a".repeat(64)}`, evidence.ownerSubjectId]
            );
          }
        })).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining(
            "previously committed complete promotion and exposure bundle"
          )
        });
        expect(Number((await client.query(
          `select count(*) as count from analysis_criterion_promotions where project_id=$1`,
          [evidence.projectId]
        )).rows[0]!.count)).toBe(0);
        expect(Number((await client.query(
          `select count(*) as count from criteria where project_id=$1`,
          [evidence.projectId]
        )).rows[0]!.count)).toBe(0);
        await expect(insertPromotionBundle(client, evidence, "same_tx_after_exposures", {
          afterExposures: async (transaction, promotion) => {
            await insertPromotionHandoffBatch(
              transaction,
              evidence,
              promotion,
              "same_tx_after_exposures"
            );
          }
        })).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining(
            "previously committed complete promotion and exposure bundle"
          )
        });
        expect(Number((await client.query(
          `select count(*) as count from analysis_criterion_promotions where project_id=$1`,
          [evidence.projectId]
        )).rows[0]!.count)).toBe(0);
        await insertPromotionBundle(client, evidence, "tamper_recovery");
        expect(Number((await client.query(
          `select count(*) as count from analysis_criterion_promotions where project_id=$1`,
          [evidence.projectId]
        )).rows[0]!.count)).toBe(1);
      } finally {
        client.release();
      }
    });
  });

  it("serializes competing promotions for one stable code without branching", async () => {
    await withSchema("promotion_race", true, async (pool) => {
      const evidence = await seedPromotionEvidence(pool, "promotion_race");
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        const results = await Promise.allSettled([
          insertPromotionBundle(first, evidence, "race_a"),
          insertPromotionBundle(second, evidence, "race_b")
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "23505" });
        const rows = await pool.query(
          `select code_id,count(*)::int as count
           from analysis_criterion_promotions where project_id=$1 group by code_id`,
          [evidence.projectId]
        );
        expect(rows.rows).toEqual([{ code_id: evidence.codeId, count: 1 }]);
        expect(Number((await pool.query(
          `select count(*) as count from criteria where project_id=$1`, [evidence.projectId]
        )).rows[0]!.count)).toBe(1);
      } finally {
        first.release();
        second.release();
      }
    });
  });

  it("rejects stale taxonomy heads and retired current codes", async () => {
    await withSchema("promotion_taxonomy_stale", true, async (pool) => {
      const evidence = await seedPromotionEvidence(pool, "promotion_taxonomy_stale");
      const repository = new PgAnalysisStudyRepository(pool);
      const actor = {
        projectId: evidence.projectId,
        userId: evidence.ownerUserId,
        projectRole: "owner" as const
      };
      const successor = await repository.createTaxonomyRevision(actor, evidence.taxonomyId, {
        expectedPredecessorRevisionId: evidence.taxonomyRevisionId,
        expectedPredecessorRevisionDigest: evidence.taxonomyRevisionDigest,
        expectedPredecessorSequence: evidence.taxonomyRevisionSequence,
        reason: "Retire the code before attempted promotion.",
        codes: [{
          kind: "existing",
          codeId: evidence.codeId,
          label: evidence.codeLabel,
          definition: evidence.codeDefinition,
          status: "retired"
        }],
        idempotencyKey: "promotion-taxonomy-retire"
      });
      const client = await pool.connect();
      try {
        await expectPgCode(
          insertPromotionBundle(client, evidence, "stale_head"),
          ["23514"]
        );
        const retiredEntry = successor.revision.codes.find((entry) => entry.codeId === evidence.codeId)!;
        await expectPgCode(
          insertPromotionBundle(client, {
            ...evidence,
            taxonomyRevisionId: successor.revision.revision.id,
            taxonomyRevisionSequence: successor.revision.revision.sequence,
            taxonomyRevisionDigest: successor.revision.revision.revisionDigest,
            codeEntryId: retiredEntry.id,
            codeEntryDigest: retiredEntry.entryDigest,
            codeLabel: retiredEntry.label,
            codeDefinition: retiredEntry.definition
          }, "retired_head"),
          ["23514"]
        );
        expect(Number((await client.query(
          `select count(*) as count from analysis_criterion_promotions where project_id=$1`,
          [evidence.projectId]
        )).rows[0]!.count)).toBe(0);
      } finally {
        client.release();
      }
    });
  });

  it("uses UTF-16 code-unit ordering for canonical support identity", async () => {
    await withSchema("promotion_utf16", true, async (pool) => {
      const rows = await pool.query(
        `select array_agg(value order by governed_utf16_sort_key_v1(value)) as values
         from unnest(array[$1::text,$2::text]) value`,
        ["observation_\u{1f600}", "observation_\ue000"]
      );
      expect(rows.rows[0]!.values).toEqual(["observation_\u{1f600}", "observation_\ue000"]);
      const definition = String((await pool.query(
        `select pg_get_functiondef('guard_analysis_criterion_promotion_complete()'::regprocedure) as definition`
      )).rows[0]!.definition);
      expect(definition.match(/governed_utf16_sort_key_v1/g)).toHaveLength(4);
    });
  });

  it("runs the repository promotion path with replay, no aliasing, and bounded reads", async () => {
    await withSchema("promotion_repository", true, async (pool) => {
      const evidence = await seedPromotionEvidence(pool, "promotion_repository");
      const repository = new PgAnalysisPromotionRepository(pool);
      const actor = {
        projectId: evidence.projectId,
        userId: evidence.ownerUserId,
        projectRole: "owner" as const
      };
      const input: AnalysisCriterionPromotionCreateInput = {
        studyId: evidence.studyId,
        expectedClosureId: evidence.closureId,
        expectedClosureDigest: evidence.closureDigest,
        taxonomyId: evidence.taxonomyId,
        taxonomyRevisionId: evidence.taxonomyRevisionId,
        expectedTaxonomyRevisionDigest: evidence.taxonomyRevisionDigest,
        codeId: evidence.codeId,
        expectedCodeEntryDigest: evidence.codeEntryDigest,
        criterionName: "Repository promoted criterion",
        criterionDefinition: "The answer must be substantively correct.",
        rationale: "The exact closure evidence supports this narrow criterion.",
        supportingObservations: [{
          studyItemId: evidence.studyItemId,
          closureItemId: evidence.closureItemId,
          closureItemDigest: evidence.closureItemDigest,
          observationEventId: evidence.observationEventId,
          observationEventDigest: evidence.observationEventDigest,
          assignmentEventId: evidence.assignmentEventId,
          assignmentEventDigest: evidence.assignmentEventDigest
        }],
        idempotencyKey: "repository-promotion-command"
      };
      const candidates = await repository.listCandidates(actor, {
        studyId: evidence.studyId,
        taxonomyRevisionId: evidence.taxonomyRevisionId,
        codeId: evidence.codeId,
        limit: 10,
        cursor: null
      });
      expect(candidates.totalCount).toBe("1");
      expect(candidates.items[0]).toMatchObject({
        observationEventId: evidence.observationEventId,
        assignmentEventId: evidence.assignmentEventId,
        closureItemId: evidence.closureItemId
      });
      const pair = await Promise.all([
        repository.createPromotion(actor, input),
        repository.createPromotion(actor, input)
      ]);
      expect(pair.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(new Set(pair.map((result) => result.promotion.id)).size).toBe(1);
      const created = pair[0]!;
      await expect(repository.createPromotion(actor, {
        ...input,
        idempotencyKey: "repository-promotion-alias-forbidden"
      })).rejects.toMatchObject({ code: "analysis_promotion_code_already_promoted" });
      expect(await repository.getPromotion(actor, created.promotion.id)).toMatchObject({
        promotion: { id: created.promotion.id, codeId: evidence.codeId },
        handoff: { promotionId: created.promotion.id, createsTruth: false, createsEvaluator: false }
      });
      const listed = await repository.listPromotions(actor, evidence.studyId, {
        limit: 10,
        cursor: null
      });
      expect(listed.totalCount).toBe("1");
      expect(listed.items).toHaveLength(1);
      const supports = await repository.listSupports(actor, created.promotion.id, {
        limit: 10,
        cursor: null
      });
      expect(supports).toMatchObject({ totalCount: 1, nextCursor: null });
      expect(supports!.items).toHaveLength(1);
      expect((await pool.query(
        `select activity,count(*)::int as count from dataset_exposure_events
         where evidence_ref_kind='analysis_criterion_promotion' and evidence_ref_id=$1
         group by activity order by activity`, [created.promotion.id]
      )).rows).toEqual([
        { activity: "criterion_authoring", count: 1 },
        { activity: "example_selection", count: 1 }
      ]);
      expect(Number((await pool.query(
        `select count(*) as count from skills where criterion_id=$1`, [created.criterion.id]
      )).rows[0]!.count)).toBe(0);

      const platform = new PgRepository(pool);
      expect(await platform.getCriterion(evidence.projectId, created.criterion.id)).toMatchObject({
        criterion: {
          id: created.criterion.id,
          sourceKind: "analysis_promotion"
        },
        versions: [{
          id: created.criterionVersion.id,
          sourceKind: "analysis_promotion"
        }]
      });
      await expect(platform.createCriterionVersion(
        evidence.projectId,
        created.criterion.id,
        { name: "Forbidden successor", definition: "This version must not be created." },
        { actorUserId: evidence.ownerUserId }
      )).rejects.toMatchObject({ code: "23514" });

      const governed = new PgGovernedReviewRepository(pool);
      const reviewerUserId = "promotion_repository_reviewer";
      await pool.query(
        `insert into "user" (id,name,email,email_verified)
         values ($1,'Promotion reviewer','promotion-reviewer@example.test',true)`,
        [reviewerUserId]
      );
      await pool.query(
        `insert into project_members (id,project_id,user_id,role)
         values ('pm_promotion_repository_reviewer',$1,$2,'member')`,
        [evidence.projectId, reviewerUserId]
      );
      const instruction = await governed.createInstruction(actor, {
        criterionVersionId: created.criterionVersion.id,
        title: "Independent promoted-criterion review",
        instructions: "Use only the frozen criterion and immutable payload supplied in the blind view.",
        failureCodeGuidance: "Use short reviewer-authored failure codes.",
        idempotencyKey: "promotion-repository-instruction"
      });
      const batchInput = {
        instructionVersionId: instruction.instructionVersionId,
        roleIntent: "analysis_authoring" as const,
        source: { kind: "analysis_promotion_handoff" as const, promotionId: created.promotion.id },
        selection: { method: "simple_random" as const, fixedBudget: 1 },
        reviewerUserIds: [reviewerUserId],
        fixedStopAt: "2099-01-01T00:00:00.000Z",
        idempotencyKey: "promotion-repository-batch"
      };
      const batch = await governed.createBatchDraft(actor, batchInput);
      expect(batch).toMatchObject({
        sourcePopulationKind: "analysis_promotion_handoff",
        sourcePopulationId: created.promotion.id,
        roleIntent: "analysis_authoring",
        criterionVersionId: created.criterionVersion.id
      });
      expect((await pool.query(
        `select population_id from governed_review_batches where id=$1`, [batch.batchId]
      )).rows).toEqual([{ population_id: evidence.sourceRevisionId }]);
      await expect(governed.createBatchDraft(actor, {
        ...batchInput,
        source: { kind: "dataset_revision" as const, revisionId: evidence.sourceRevisionId },
        idempotencyKey: "promotion-repository-generic-dataset-bypass"
      })).rejects.toBeTruthy();
      await governed.transitionBatch(actor, batch.batchId, "open", {
        expectedStateVersion: 0,
        idempotencyKey: "promotion-repository-batch-open"
      });
      const reviewer = {
        projectId: evidence.projectId,
        userId: reviewerUserId,
        projectRole: "member" as const
      };
      const tasks = (await governed.listReviewerTasks(reviewer))
        .filter((task) => task.batchId === batch.batchId);
      expect(tasks).toHaveLength(1);
      const view = await governed.getOrCreateBlindTaskView(reviewer, tasks[0]!.taskId);
      const blind = JSON.parse(Buffer.from(view.canonicalBytes).toString("utf8"));
      expect(blind).toMatchObject({
        criterion: {
          criterionId: created.criterion.id,
          criterionVersionId: created.criterionVersion.id,
          name: input.criterionName,
          definition: input.criterionDefinition
        },
        instruction: {
          instructionVersionId: instruction.instructionVersionId,
          title: "Independent promoted-criterion review"
        }
      });
      const blindJson = JSON.stringify(blind);
      for (const secret of [
        created.promotion.id,
        evidence.codeId,
        evidence.observationEventId,
        evidence.assignmentEventId,
        input.rationale
      ]) {
        expect(blindJson).not.toContain(secret);
      }
      await governed.appendTaskAction(reviewer, tasks[0]!.taskId, {
        kind: "submit_label",
        input: {
          expectedStreamVersion: 1,
          viewDigest: view.viewDigest,
          label: "fail",
          rationale: "The frozen answer is substantively incorrect under the promoted criterion.",
          failureCodes: [],
          idempotencyKey: "promotion-repository-label"
        }
      });
      await governed.transitionBatch(actor, batch.batchId, "close_labeling", {
        expectedStateVersion: 1,
        idempotencyKey: "promotion-repository-close"
      });
      await governed.transitionBatch(actor, batch.batchId, "finalize", {
        expectedStateVersion: 2,
        idempotencyKey: "promotion-repository-finalize"
      });
      const frozen = await governed.transitionBatch(actor, batch.batchId, "freeze", {
        expectedStateVersion: 3,
        idempotencyKey: "promotion-repository-freeze"
      });
      expect(frozen.datasetRevisionId).toBeTruthy();
      const frozenEvidence = (await pool.query(
        `select batch.content_digest as batch_digest,revision.revision_digest,
                revision.content_digest as truth_content_digest
         from governed_review_batches batch
         join dataset_revisions revision on revision.id=$2
         where batch.id=$1`,
        [batch.batchId, frozen.datasetRevisionId]
      )).rows[0]!;
      const lifecycle = new PgEvaluatorLifecycleRepository(pool);
      const candidate = await lifecycle.createCandidate(actor, {
        criterionId: created.criterion.id,
        criterionVersionId: created.criterionVersion.id,
        governedBatchId: batch.batchId,
        expectedBatchDigest: String(frozenEvidence.batch_digest),
        truthDatasetRevisionId: frozen.datasetRevisionId!,
        expectedTruthRevisionDigest: String(frozenEvidence.revision_digest),
        expectedTruthContentDigest: String(frozenEvidence.truth_content_digest),
        skillName: "Repository promoted evaluator",
        skillDescription: "Candidate evaluator derived from exact governed nonsealed truth.",
        rubricMarkdown: "Fail when the answer is substantively incorrect.",
        prompt: "Judge only the supplied response against the exact promoted criterion.",
        modelBinding: {
          provider: "openai",
          modelId: "gpt-4o-mini",
          modelVersion: "2024-07-18",
          temperature: 0
        },
        outputSchema: MinimumVerdictOutputSchema,
        idempotencyKey: "promotion-repository-candidate"
      });
      expect(candidate).toMatchObject({
        replayed: false,
        projection: {
          currentEvent: { state: "candidate", transition: "candidate_created" },
          implicitExecutionAllowed: false
        }
      });
      await expect(pool.query(
        `insert into evaluator_lifecycle_events
           (id,contract_version,lifecycle_id,project_id,criterion_id,skill_version_id,sequence,
            transition,state,predecessor_event_id,predecessor_event_digest,actor_role,reason,
            idempotency_key,request_digest,content_digest)
         values ('elce_forged_system_retire','coeval/evaluator-lifecycle-event/v1',$1,$2,$3,$4,2,
                 'retired','retired',$5,$6,'system','Forged system retirement.',
                 'forged-system-retire',$7,$7)`,
        [candidate.projection.lifecycle.id,evidence.projectId,created.criterion.id,
          candidate.skill.currentVersion.id,candidate.projection.currentEvent.id,
          candidate.projection.currentEvent.contentDigest,`sha256:${"f".repeat(64)}`]
      )).rejects.toMatchObject({code:"23514"});
      await expect(platform.createSkillVersionPending(candidate.skill.id,
        CreateSkillVersionInputSchema.parse({
          rubricMarkdown:"# Generic bypass",prompt:"This version must not commit.",
          modelBinding:{provider:"mock",modelId:"mock",modelVersion:"v1",temperature:0},
          verdictKind:"binary",criterionVersionId:created.criterionVersion.id
        }),
        {projectId:evidence.projectId,actorUserId:evidence.ownerUserId}
      )).rejects.toBeTruthy();
      await expect(platform.getCurrentSkillForCriterion(
        evidence.projectId,
        created.criterion.id
      )).rejects.toThrow("No skill version found");
      await expect(platform.createEvaluatorSuiteManifest(evidence.projectId,{
        idempotencyKey:"candidate-suite-denied",
        members:[{
          criterionVersionId:created.criterionVersion.id,
          skillVersionId:candidate.skill.currentVersion.id
        }],
        trialPlan:null
      },{actorUserId:evidence.ownerUserId})).rejects.toThrow("must bind a criterion version");
      await expect(platform.createLangSmithIntegration(evidence.projectId,{
        apiKey:"ls_candidate_must_not_pin",projectName:"Candidate denied",
        skillVersionId:candidate.skill.currentVersion.id
      })).rejects.toThrow("is not eligible for scheduled_import");
      await expect(platform.getLatestSkillForCriterion(
        evidence.projectId,
        created.criterion.id
      )).resolves.toMatchObject({
        status: "calibrating",
        currentVersion: { id: candidate.skill.currentVersion.id, status: "calibrating" }
      });
      await pool.query(
        `update skill_versions set status='approved',approved_at=clock_timestamp()
         where id=$1 and project_id=$2`,
        [candidate.skill.currentVersion.id,evidence.projectId]
      );
      await expect(platform.getCurrentSkillForCriterion(
        evidence.projectId,
        created.criterion.id
      )).rejects.toThrow("No skill version found");
      await expect(platform.getSkillVersion(
        evidence.projectId,
        candidate.skill.currentVersion.id
      )).resolves.toMatchObject({ status: "calibrating" });
      expect(await lifecycle.createCandidate(actor, {
        criterionId: created.criterion.id,
        criterionVersionId: created.criterionVersion.id,
        governedBatchId: batch.batchId,
        expectedBatchDigest: String(frozenEvidence.batch_digest),
        truthDatasetRevisionId: frozen.datasetRevisionId!,
        expectedTruthRevisionDigest: String(frozenEvidence.revision_digest),
        expectedTruthContentDigest: String(frozenEvidence.truth_content_digest),
        skillName: "Repository promoted evaluator",
        skillDescription: "Candidate evaluator derived from exact governed nonsealed truth.",
        rubricMarkdown: "Fail when the answer is substantively incorrect.",
        prompt: "Judge only the supplied response against the exact promoted criterion.",
        modelBinding: {
          provider: "openai",
          modelId: "gpt-4o-mini",
          modelVersion: "2024-07-18",
          temperature: 0
        },
        outputSchema: MinimumVerdictOutputSchema,
        idempotencyKey: "promotion-repository-candidate"
      })).toMatchObject({ replayed: true });
      await expect(lifecycle.authorizeExecution({
        projectId: evidence.projectId,
        skillVersionId: candidate.skill.currentVersion.id,
        context: "implicit_production",
        resourceKind: "test",
        resourceId: "candidate-denied",
        idempotencyKey: "candidate-denied"
      })).rejects.toMatchObject({ code: "execution_forbidden" });
      await lifecycle.authorizeExecution({
        projectId: evidence.projectId,
        skillVersionId: candidate.skill.currentVersion.id,
        context: "candidate_regression_evidence",
        resourceKind: "regression_revision",
        resourceId: candidate.projection.lifecycle.regressionDatasetRevisionId,
        idempotencyKey: "candidate-regression-authorized"
      });
      await lifecycle.authorizeExecution({
        projectId: evidence.projectId,
        skillVersionId: candidate.skill.currentVersion.id,
        context: "candidate_regression_evidence",
        resourceKind: "regression_revision",
        resourceId: candidate.projection.lifecycle.regressionDatasetRevisionId,
        idempotencyKey: "candidate-regression-authorized"
      });
      await expect(lifecycle.authorizeExecution({
        projectId: evidence.projectId,
        skillVersionId: candidate.skill.currentVersion.id,
        context: "candidate_regression_evidence",
        resourceKind: "regression_revision",
        resourceId: "different-revision",
        idempotencyKey: "candidate-regression-authorized"
      })).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(Number((await pool.query(
        `select count(*) as count from evaluator_execution_authorizations
         where project_id=$1 and idempotency_key='candidate-regression-authorized'`,
        [evidence.projectId]
      )).rows[0]!.count)).toBe(1);

      const sealedActors = ["custodian", "reviewer_a", "reviewer_b"].map((role) => ({
        projectId: evidence.projectId,
        userId: `promotion_repository_${role}`,
        projectRole: "member" as const
      }));
      for (const sealedActor of sealedActors) {
        await pool.query(
          `insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)`,
          [sealedActor.userId,sealedActor.userId,`${sealedActor.userId}@example.test`]
        );
        await pool.query(
          `insert into project_members (id,project_id,user_id,role) values ($1,$2,$3,'member')`,
          [`pm_${sealedActor.userId}`,evidence.projectId,sealedActor.userId]
        );
      }
      const intake = await governed.createSealedIntake(sealedActors[0]!, {
        populationDefinition: "Independent one-item sealed validation population.",
        items: [{
          clientItemId: "promotion-repository-sealed-item",
          input: { question: "Independent sealed question?" },
          output: { answer: "Substantively wrong sealed answer" }
        }],
        idempotencyKey: "promotion-repository-sealed-intake"
      });
      const sealedBatch = await governed.createBatchDraft(actor, {
        instructionVersionId: instruction.instructionVersionId,
        roleIntent: "sealed_validation",
        source: { kind: "sealed_intake", intakeId: intake.intakeId },
        selection: { method: "simple_random", fixedBudget: 1 },
        reviewerUserIds: [sealedActors[1]!.userId,sealedActors[2]!.userId],
        fixedStopAt: "2099-01-01T00:00:00.000Z",
        idempotencyKey: "promotion-repository-sealed-batch"
      });
      await governed.transitionBatch(actor,sealedBatch.batchId,"open",{
        expectedStateVersion:0,idempotencyKey:"promotion-repository-sealed-open"
      });
      for (const sealedReviewer of sealedActors.slice(1)) {
        const sealedTasks = (await governed.listReviewerTasks(sealedReviewer))
          .filter((task) => task.batchId===sealedBatch.batchId);
        expect(sealedTasks).toHaveLength(1);
        const sealedView = await governed.getOrCreateBlindTaskView(sealedReviewer,sealedTasks[0]!.taskId);
        await governed.appendTaskAction(sealedReviewer,sealedTasks[0]!.taskId,{
          kind:"submit_label",
          input:{
            expectedStreamVersion:1,viewDigest:sealedView.viewDigest,label:"fail",
            rationale:"The answer is substantively incorrect.",failureCodes:[],
            idempotencyKey:`promotion-repository-sealed-label-${sealedReviewer.userId}`
          }
        });
      }
      await governed.transitionBatch(actor,sealedBatch.batchId,"close_labeling",{
        expectedStateVersion:1,idempotencyKey:"promotion-repository-sealed-close"
      });
      await governed.transitionBatch(actor,sealedBatch.batchId,"finalize",{
        expectedStateVersion:2,idempotencyKey:"promotion-repository-sealed-finalize"
      });
      const sealedFrozen = await governed.transitionBatch(actor,sealedBatch.batchId,"freeze",{
        expectedStateVersion:3,idempotencyKey:"promotion-repository-sealed-freeze"
      });
      const calibration = new PgBinaryCalibrationRepository(pool);
      const calibrationRun = await calibration.createRun(actor,{
        datasetRevisionId:sealedFrozen.datasetRevisionId!,
        skillVersionId:candidate.skill.currentVersion.id,
        positiveClass:"pass",trialPlan:{kind:"single",trialsPerItem:1},suiteBinding:null,
        idempotencyKey:"promotion-repository-calibration"
      });
      const calibrationClaim = await calibration.claimRun(calibrationRun.runId,"promotion-worker",60_000);
      expect(calibrationClaim).not.toBeNull();
      await calibration.authorizeRun(calibrationClaim!);
      const calibrationAttempt = await calibration.getNextAttempt(calibrationClaim!);
      expect(calibrationAttempt).not.toBeNull();
      await calibration.recordProviderCallStarted(calibrationClaim!,calibrationAttempt!.attemptId);
      await calibration.completeAttempt(calibrationClaim!,calibrationAttempt!.attemptId,{
        terminalEvaluatorOutcome:"evaluator_fail",attemptState:"terminal",errorCode:null,
        providerObservation:{provider:"openai",observedModel:"gpt-4o-mini",observedVersion:"2024-07-18",systemFingerprint:null}
      });
      const calibrationMint = await calibration.finalizeRun(calibrationClaim!);
      expect(calibrationMint.artifact.status).toBe("complete");
      const calibrationRow = (await pool.query(
        `select artifact_digest,evidence_digest from binary_calibration_artifacts where id=$1`,
        [calibrationMint.artifact.artifactId]
      )).rows[0]!;
      const regressionItem = (await pool.query(
        `select id,reference_label from dataset_revision_items where revision_id=$1`,
        [candidate.projection.lifecycle.regressionDatasetRevisionId]
      )).rows[0]!;
      const incompleteRegressionRunId = "reg_promotion_repository_incomplete";
      await pool.query(
        `insert into regression_runs
           (id,project_id,skill_version_id,dataset_revision_id,status,compared,regressed,improved,flipped,
            override_reason,override_actor_user_id,golden_set_missing,cases,error_message,
            criterion_version_id)
         values ($1,$2,$3,$4,'passed',0,0,0,0,null,null,false,'[]'::jsonb,null,$5)`,
        [incompleteRegressionRunId,evidence.projectId,candidate.skill.currentVersion.id,
          candidate.projection.lifecycle.regressionDatasetRevisionId,
          candidate.skill.currentVersion.criterionVersionId]
      );
      const activationEvidence = {
        expectedState:"candidate" as const,expectedSequence:candidate.projection.currentEvent.sequence,
        expectedEventId:candidate.projection.currentEvent.id,
        expectedEventDigest:candidate.projection.currentEvent.contentDigest,
        calibrationArtifactId:calibrationMint.artifact.artifactId,
        expectedCalibrationArtifactDigest:String(calibrationRow.artifact_digest),
        expectedCalibrationEvidenceDigest:String(calibrationRow.evidence_digest),
        expectedPriorActiveSkillVersionId:null,expectedPriorActiveEventId:null,
        expectedPriorActiveEventDigest:null,
        rationale:"Independent sealed calibration and complete regression evidence are admissible."
      };
      await expect(lifecycle.activate(actor,candidate.skill.currentVersion.id,{
        ...activationEvidence,regressionRunId:incompleteRegressionRunId,
        idempotencyKey:"promotion-repository-incomplete-activation"
      })).rejects.toMatchObject({code:"state_conflict"});
      const regressionRunId = "reg_promotion_repository_candidate";
      await pool.query(
        `insert into regression_runs
           (id,project_id,skill_version_id,dataset_revision_id,status,compared,regressed,improved,flipped,
            override_reason,override_actor_user_id,golden_set_missing,cases,error_message,
            criterion_version_id)
         values ($1,$2,$3,$4,'passed',1,0,0,0,null,null,false,$5::jsonb,null,$6)`,
        [regressionRunId,evidence.projectId,candidate.skill.currentVersion.id,
          candidate.projection.lifecycle.regressionDatasetRevisionId,JSON.stringify([{
            caseId:String(regressionItem.id),traceId:String(regressionItem.id),
            agreedLabel:String(regressionItem.reference_label),newLabel:String(regressionItem.reference_label),
            change:"agree",rationale:"Exact retained regression item agrees."
          }]),candidate.skill.currentVersion.criterionVersionId]
      );
      const activated = await lifecycle.activate(actor,candidate.skill.currentVersion.id,{
        ...activationEvidence,regressionRunId,
        idempotencyKey:"promotion-repository-activate"
      });
      expect(activated).toMatchObject({
        replayed:false,projection:{currentEvent:{state:"active"},implicitExecutionAllowed:true}
      });
      const measurements = new PgAnalysisMeasurementRepository(pool);
      const activeMeasurement = await measurements.getReport(actor,evidence.studyId,{
        taxonomyRevisionId:evidence.taxonomyRevisionId,
        skillVersionId:candidate.skill.currentVersion.id,
        calibrationArtifactId:calibrationMint.artifact.artifactId
      });
      expect(activeMeasurement).toMatchObject({
        projectId:evidence.projectId,
        studyId:evidence.studyId,
        taxonomy:{state:"available",coverage:{activeFailureObservationCount:"1",categorized:"1"}},
        evaluator:{
          lifecycleId:candidate.projection.lifecycle.id,
          promotionId:created.promotion.id,
          skillVersionId:candidate.skill.currentVersion.id,
          governedDisagreement:{selectedItemCount:1,singleRater:1,adjudicated:0},
          calibration:{
            state:"complete",
            artifactId:calibrationMint.artifact.artifactId,
            currentAdmissibility:"admissible",
            currentAdmissibilityReasons:[]
          },
          timeToFirstCompletedCalibrationArtifact:{state:"defined"},
          timeToFirstCurrentlyAdmissibleCalibrationArtifact:{state:"defined"}
        }
      });
      await expect(pool.query(
        `update regression_runs set status='blocked' where id=$1 and project_id=$2`,
        [regressionRunId,evidence.projectId]
      )).rejects.toMatchObject({code:"55000"});
      await expect(platform.getCurrentSkillForCriterion(
        evidence.projectId,created.criterion.id
      )).resolves.toMatchObject({
        status:"production",currentVersion:{id:candidate.skill.currentVersion.id,status:"production"}
      });
      await lifecycle.authorizeExecution({
        projectId:evidence.projectId,skillVersionId:candidate.skill.currentVersion.id,
        context:"implicit_production",resourceKind:"test",resourceId:"active",
        idempotencyKey:"promotion-repository-active-auth"
      });
      await pool.query(
        `insert into binary_calibration_revocation_events
           (id,artifact_id,run_id,project_id,reason,evidence_ref_kind,evidence_ref_id)
         values ('bcre_promotion_repository',$1,$2,$3,'provenance_invalidated','test','revoked')`,
        [calibrationMint.artifact.artifactId,calibrationRun.runId,evidence.projectId]
      );
      const revokedProjection = await lifecycle.getLifecycle(actor,candidate.skill.currentVersion.id);
      expect(revokedProjection).toMatchObject({
        currentEvent:{state:"needs_review",transition:"calibration_revoked"},implicitExecutionAllowed:false
      });
      const revokedMeasurement = await measurements.getReport(actor,evidence.studyId,{
        taxonomyRevisionId:evidence.taxonomyRevisionId,
        skillVersionId:candidate.skill.currentVersion.id,
        calibrationArtifactId:calibrationMint.artifact.artifactId
      });
      expect(revokedMeasurement).toMatchObject({
        evaluator:{
          calibration:{
            state:"complete",
            artifactId:calibrationMint.artifact.artifactId,
            currentAdmissibility:"revoked",
            currentAdmissibilityReasons:["provenance_invalidated"]
          },
          timeToFirstCompletedCalibrationArtifact:{state:"defined"},
          timeToFirstCurrentlyAdmissibleCalibrationArtifact:{state:"missing"}
        }
      });
      await expect(lifecycle.activate(actor,candidate.skill.currentVersion.id,{
        ...activationEvidence,expectedState:"needs_review",
        expectedSequence:revokedProjection!.currentEvent.sequence,
        expectedEventId:revokedProjection!.currentEvent.id,
        expectedEventDigest:revokedProjection!.currentEvent.contentDigest,
        regressionRunId,idempotencyKey:"promotion-repository-reactivate-revoked"
      })).rejects.toMatchObject({code:"state_conflict"});
      await expect(platform.getCurrentSkillForCriterion(
        evidence.projectId,created.criterion.id
      )).rejects.toThrow("No skill version found");
      await expect(lifecycle.authorizeExecution({
        projectId:evidence.projectId,skillVersionId:candidate.skill.currentVersion.id,
        context:"implicit_production",resourceKind:"test",resourceId:"revoked",
        idempotencyKey:"promotion-repository-revoked-auth"
      })).rejects.toMatchObject({code:"execution_forbidden"});
      expect(Number((await pool.query(
        `select count(*) as count from skills where criterion_id=$1`, [created.criterion.id]
      )).rows[0]!.count)).toBe(1);
    });
  });

  it("commits one exact immutable promotion bundle with JS/PG digest parity and no evaluator", async () => {
    await withSchema("promotion_happy", true, async (pool) => {
      const evidence = await seedPromotionEvidence(pool, "promotion_happy");
      const client = await pool.connect();
      try {
        const inserted = await insertPromotionBundle(client, evidence, "promotion_happy");
        const row = (await client.query(
          `select promotion.*,
                  analysis_criterion_promotion_request_digest_v1(promotion.id) as db_request,
                  analysis_criterion_promotion_support_set_digest_v1(promotion.id) as db_support_set,
                  analysis_criterion_promotion_handoff_digest_v1(promotion) as db_handoff,
                  analysis_criterion_promotion_content_digest_v1(promotion) as db_content
           from analysis_criterion_promotions promotion where promotion.id=$1`,
          [inserted.promotionId]
        )).rows[0]!;
        expect(row.request_digest).toBe(row.db_request);
        expect(row.support_set_digest).toBe(row.db_support_set);
        expect(row.handoff_digest).toBe(row.db_handoff);
        expect(row.content_digest).toBe(row.db_content);
        expect((await client.query(
          `select source_kind from criteria where id=$1`, [inserted.criterionId]
        )).rows).toEqual([{ source_kind: "analysis_promotion" }]);
        expect((await client.query(
          `select source_kind,revision from criterion_versions where id=$1`, [inserted.criterionVersionId]
        )).rows).toEqual([{ source_kind: "analysis_promotion", revision: 1 }]);
        expect(Number((await client.query(
          `select count(*) as count from skills where criterion_id=$1`, [inserted.criterionId]
        )).rows[0]!.count)).toBe(0);
        expect((await client.query(
          `select activity,subject_id from dataset_exposure_events
           where evidence_ref_kind='analysis_criterion_promotion' and evidence_ref_id=$1
           order by activity`, [inserted.promotionId]
        )).rows).toEqual([
          { activity: "criterion_authoring", subject_id: evidence.ownerSubjectId },
          { activity: "example_selection", subject_id: evidence.memberSubjectId }
        ]);
        const batchId = await insertPromotionHandoffBatch(
          client, evidence, inserted, "promotion_happy"
        );
        expect((await client.query(
          `select source_population_kind,source_population_id,population_id,criterion_version_id
           from governed_review_batches where id=$1`, [batchId]
        )).rows).toEqual([{
          source_population_kind: "analysis_promotion_handoff",
          source_population_id: inserted.promotionId,
          population_id: evidence.sourceRevisionId,
          criterion_version_id: inserted.criterionVersionId
        }]);

        const lateUserId = "late_developer_promotion_happy";
        const lateSubjectId = "late_subject_promotion_happy";
        await client.query(
          `insert into "user" (id,name,email,email_verified)
           values ($1,'Late developer','late-developer@example.test',true)`,
          [lateUserId]
        );
        await client.query(
          `insert into governed_reviewer_subjects
            (id,project_id,account_user_id,subject_digest)
           values ($1,$2,$3,governed_content_v1_digest(
             'governed-reviewer-subject/v1',jsonb_build_object('projectId',$2::text,'subjectId',$1::text)
           ))`,
          [lateSubjectId, evidence.projectId, lateUserId]
        );
        await insertEligibleCapabilityCheck(client, {
          id: "capability_before_development",
          projectId: evidence.projectId,
          batchId,
          criterionVersionId: inserted.criterionVersionId,
          subjectId: lateSubjectId
        });
        expect((await client.query(
          `select governed_review_has_eligible_capability_check($1,'batch_open',$2,null) as eligible`,
          [batchId, lateSubjectId]
        )).rows).toEqual([{ eligible: true }]);
        await client.query(
          `insert into dataset_exposure_events
            (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,
             subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,reason,details,
             idempotency_key)
           values ('late_development_exposure',$1,$2,'development_use','development',
             'rubric_authoring','person',$3,$4,'test','late','late development','{}',
             'late-development-exposure')`,
          [evidence.projectId, evidence.sourceRevisionId, lateSubjectId, evidence.ownerUserId]
        );
        expect((await client.query(
          `select governed_review_has_eligible_capability_check($1,'batch_open',$2,null) as eligible`,
          [batchId, lateSubjectId]
        )).rows).toEqual([{ eligible: false }]);
        await client.query(`delete from "user" where id=$1`, [lateUserId]);
        expect((await client.query(
          `select governed_review_has_eligible_capability_check($1,'batch_open',$2,null) as eligible`,
          [batchId, lateSubjectId]
        )).rows).toEqual([{ eligible: false }]);

        await expect(client.query(
          `insert into dataset_exposure_events
            (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,
             subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,reason,
             details,idempotency_key)
           values ('poison_promotion',$1,$2,'development_use','development',
             'criterion_authoring','person',$3,$4,'analysis_criterion_promotion',$5,
             'wrong','{}','analysis-promotion:criterion-authoring:poison')`,
          [evidence.projectId, evidence.sourceRevisionId, evidence.ownerSubjectId,
            evidence.ownerUserId, inserted.promotionId]
        )).rejects.toMatchObject({ code: "23514" });
        await expect(client.query(
          `insert into criteria
            (id,project_id,stable_key,source_kind,created_by_user_id)
           values ('criterion_reserved_poison',$1,'analysis-failure-code:poison','native',$2)`,
          [evidence.projectId, evidence.ownerUserId]
        )).rejects.toMatchObject({ code: "23514" });
        await expect(client.query(
          `insert into skills
            (id,project_id,name,description,owner_user_id,status,is_starter,criterion_id)
           values ('skill_forbidden',$1,'Forbidden','Forbidden',$2,'draft',false,$3)`,
          [evidence.projectId, evidence.ownerUserId, inserted.criterionId]
        )).rejects.toMatchObject({ code: "23514" });
        await expect(client.query(
          `insert into eval_runs (id,project_id,dataset_revision_id)
           values ('eval_forbidden',$1,$2)`,
          [evidence.projectId, evidence.sourceRevisionId]
        )).rejects.toMatchObject({ code: "23514" });

        await expect(client.query(
          `update analysis_criterion_promotions set rationale='tampered' where id=$1`,
          [inserted.promotionId]
        )).rejects.toMatchObject({ code: "55000" });
        await expect(client.query(
          `delete from analysis_criterion_promotion_supports where promotion_id=$1`,
          [inserted.promotionId]
        )).rejects.toMatchObject({ code: "55000" });
        await expect(client.query(
          `insert into criterion_versions
            (id,project_id,criterion_id,revision,name,definition,criterion_digest,
             source_kind,created_by_user_id)
           values ('criterionv_forbidden',$1,$2,2,'Changed','Changed',
             criterion_v1_digest($2,'criterionv_forbidden','Changed','Changed'),'native',$3)`,
          [evidence.projectId, inserted.criterionId, evidence.ownerUserId]
        )).rejects.toMatchObject({ code: "23514" });

        await client.query(`delete from "user" where id=$1`, [evidence.memberUserId]);
        expect((await client.query(
          `select account_user_id from governed_reviewer_subjects where id=$1`,
          [evidence.memberSubjectId]
        )).rows).toEqual([{ account_user_id: null }]);
        await expect(client.query(
          `insert into governed_review_capability_checks
            (id,project_id,batch_id,criterion_version_id,evaluator_version_id,
             subject_id,sequence,expected_previous_sequence,check_scope,result,
             verification_method,capability_query_version,covered_capabilities,
             excluded_capabilities,unknown_capabilities,evidence,evidence_digest,
             content_digest,idempotency_key,request_digest)
           values ('capability_erased',$1,$2,$3,null,$4,1,0,'batch_open','eligible',
             'system_derived','sealed-separation/v1',array[
               'criterion_authoring','instruction_authoring','evaluator_authoring',
               'rubric_authoring','prompt_authoring','example_selection','development_exposure'
             ]::text[],array[]::text[],array[]::text[],'{}',$5,$5,
             'capability-erased',$5)`,
          [evidence.projectId, batchId, inserted.criterionVersionId,
            evidence.memberSubjectId, `sha256:${"c".repeat(64)}`]
        )).rejects.toMatchObject({ code: "23514" });

        await client.query(`delete from projects where id=$1`, [evidence.projectId]);
        expect(Number((await client.query(
          `select count(*) as count from analysis_criterion_promotions where id=$1`,
          [inserted.promotionId]
        )).rows[0]!.count)).toBe(0);
        expect(Number((await client.query(
          `select count(*) as count from analysis_criterion_promotion_supports where promotion_id=$1`,
          [inserted.promotionId]
        )).rows[0]!.count)).toBe(0);
      } finally {
        client.release();
      }
    });
  });
});
