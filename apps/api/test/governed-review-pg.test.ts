import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; governed-review PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;
const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

async function digest(client: Pool | PoolClient, kind: string, content: unknown): Promise<string> {
  return String((await client.query(
    `select governed_content_v1_digest($1, $2::jsonb) as digest`,
    [kind, JSON.stringify(content)],
  )).rows[0]?.digest);
}

async function bytesDigest(client: Pool | PoolClient, bytes: Buffer): Promise<string> {
  return String((await client.query(
    `select governed_bytes_v1_digest($1::bytea) as digest`,
    [bytes],
  )).rows[0]?.digest);
}

async function inTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const value = await fn();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

interface Fixture {
  projectId: string;
  criterionVersionId: string;
  instructionId: string;
  revisionId: string;
  revisionItemId: string;
  reviewItemId: string;
  batchId: string;
  batchItemId: string;
  reviewerA: string;
  reviewerB: string;
  adjudicator: string;
  taskA: string;
  taskB: string;
  populationId: string;
}

async function insertSubject(
  client: Pool | PoolClient,
  projectId: string,
  subjectId: string,
  accountUserId: string,
): Promise<void> {
  const subjectDigest = await digest(client, "governed-reviewer-subject/v1", {
    projectId,
    subjectId,
  });
  await client.query(
    `insert into governed_reviewer_subjects
       (id, project_id, account_user_id, subject_digest)
     values ($1,$2,$3,$4)`,
    [subjectId, projectId, accountUserId, subjectDigest],
  );
}

async function createFixture(client: Pool): Promise<Fixture> {
  await client.query(`insert into organizations (id, name) values ('org_gov', 'Governed Org')`);
  for (const [id, name] of [
    ["user_dev", "Developer"],
    ["user_review_a", "Reviewer A"],
    ["user_review_b", "Reviewer B"],
    ["user_adjudicator", "Adjudicator"],
  ]) {
    await client.query(
      `insert into "user" (id, name, email) values ($1,$2,$3)`,
      [id, name, `${id}@example.test`],
    );
  }
  await client.query(`
    insert into projects (id, organization_id, name, trace_provider)
    values ('proj_gov','org_gov','Governed Project','manual')
  `);
  await client.query(`
    insert into criteria (id,project_id,stable_key,source_kind,created_by_user_id)
    values ('criterion_skill_gov','proj_gov','correctness','native','user_dev')
  `);
  const criterionVersionId = "criterionv_skill_gov";
  await client.query(`
    insert into criterion_versions
      (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind,created_by_user_id)
    values ('criterionv_skill_gov','proj_gov','criterion_skill_gov',1,'Correctness',
            'The response is correct.',
            criterion_v1_digest('criterion_skill_gov','criterionv_skill_gov','Correctness','The response is correct.'),
            'native','user_dev')
  `);
  await client.query(`
    insert into skills (id, project_id, name, description, owner_user_id, status, criterion_id)
    values ('skill_gov','proj_gov','Correctness','The response is correct.','user_dev','production','criterion_skill_gov')
  `);

  await insertSubject(client, "proj_gov", "subject_dev", "user_dev");
  await insertSubject(client, "proj_gov", "subject_review_a", "user_review_a");
  await insertSubject(client, "proj_gov", "subject_review_b", "user_review_b");
  await insertSubject(client, "proj_gov", "subject_adjudicator", "user_adjudicator");

  await client.query(`
    insert into skill_versions
      (id, skill_id, project_id, version, status, rubric_markdown, prompt,
       output_schema, model_binding, verdict_kind, rubric_provenance,
       criterion_version_id, created_by_user_id, created_by_subject_id, developer_identity_status, created_at)
    values
      ('skillv_gov','skill_gov','proj_gov','1.0.0','approved','# Rubric','Judge.',
       '{"type":"object"}','{"provider":"mock","modelId":"mock","modelVersion":"1","temperature":0}',
       'binary','human-authored','criterionv_skill_gov','user_dev','subject_dev','recorded',now())
  `);
  expect((await client.query(
    `select developer_subject_id from governed_evaluator_development_events where skill_version_id = 'skillv_gov'`,
  )).rows[0]?.developer_subject_id).toBe("subject_dev");

  const instructionId = "review_instruction_gov";
  const instructionDigest = await digest(client, "review-instruction/v1", {
    allowedLabels: ["pass", "fail", "cannot_determine"],
    criterionVersionId,
    failureCodeGuidance: "Write zero or more verbatim open failure codes.",
    id: instructionId,
    instructions: "Judge only whether the response is factually correct.",
    predecessorInstructionVersionId: null,
    revision: 1,
    title: "Correctness review",
  });
  await client.query(`
    insert into review_instruction_versions
      (id, project_id, criterion_version_id, revision, title, instructions,
       allowed_labels, failure_code_guidance, content_digest, created_by_subject_id)
    values ($1,'proj_gov',$2,1,'Correctness review',
            'Judge only whether the response is factually correct.',
            array['pass','fail','cannot_determine'],
            'Write zero or more verbatim open failure codes.',$3,'subject_dev')
  `, [instructionId, criterionVersionId, instructionDigest]);

  const revisionId = "dsr_gov_source";
  const revisionItemId = "dsri_gov_source";
  await client.query(`
    insert into dataset_revisions
      (id, project_id, series_id, revision_number, role, source_kind, identity_basis,
       content_digest, revision_digest, item_count, provenance_level, criterion_version_id)
    values ($1,'proj_gov','governed-source',1,'analysis_authoring','collection_snapshot',
            'input-identity/v1',$2,$3,1,'unverified',$4)
  `, [revisionId, sha("1"), sha("2"), criterionVersionId]);
  await client.query(`
    insert into dataset_revision_items
      (id, revision_id, project_id, position, input_digest, item_digest,
       payload_snapshot, reference_provenance)
    values ($1,$2,'proj_gov',0,$3,$4,
            '{"input":{"question":"2+2?"},"output":{"answer":"4"},"metadata":{"private":"not-for-review"}}',
            '{"kind":"unlabeled","sourceId":null,"verdictIds":[],"actorUserIds":[],"basis":"source"}')
  `, [revisionItemId, revisionId, sha("3"), sha("4")]);

  const reviewItemId = "gri_gov";
  const safePayload = { input: { question: "2+2?" }, output: { answer: "4" } };
  const reviewItemDigest = await digest(client, "governed-review-item/v1", {
    identityBasis: "input-identity/v1",
    inputDigest: sha("3"),
    redactionProvenance: { projection: "metadata_removed" },
    reviewPayloadProjectionVersion: "governed-review-payload/v1",
    reviewPayloadSnapshot: safePayload,
    sealedFramePosition: null,
    sealedIntakePopulationId: null,
    sealedPredecessorRevisionId: null,
    sealedPredecessorRevisionItemId: null,
    sourceKind: "dataset_revision_item",
    sourceItemDigest: sha("4"),
    sourceRevisionId: revisionId,
    sourceRevisionItemId: revisionItemId,
  });
  await client.query(`
    insert into governed_review_items
      (id, project_id, source_kind, source_revision_id, source_revision_item_id,
       identity_basis, input_digest, source_item_digest, review_payload_projection_version,
       review_payload_snapshot, redaction_provenance, content_digest,
       idempotency_key, request_digest, created_by_subject_id)
    values ($1,'proj_gov','dataset_revision_item',$2,$3,'input-identity/v1',$4,$5,
            'governed-review-payload/v1',$6::jsonb,$7::jsonb,$8,'review-item-once',$9,'subject_dev')
  `, [reviewItemId, revisionId, revisionItemId, sha("3"), sha("4"),
    JSON.stringify(safePayload), JSON.stringify({ projection: "metadata_removed" }),
    reviewItemDigest, sha("5")]);

  const batchId = "grb_gov";
  const batchItemId = "grbi_gov";
  const populationId = "population:governed-source";
  const drawMember = {
    drawPosition: 0,
    frameMemberDigest: sha("6"),
    inclusionProbability: 1,
    reviewItemId,
    samplingWeight: 1,
    stratumKey: null,
  };
  const drawDigest = await digest(client, "governed-review-draw/v1", [drawMember]);
  const stopAt = String((await client.query(
    `select to_jsonb('2099-01-01T00:00:00Z'::timestamptz) as value`,
  )).rows[0]?.value);
  const batchDigest = await digest(client, "governed-review-batch/v1", {
    criterionVersionId,
    custodianRoleAtReview: null,
    custodianSubjectId: null,
    drawDigest,
    drawExecutedBy: "coeval_server",
    evaluatorBlind: true,
    fixedBudget: 1,
    instructionVersionId: instructionId,
    peerBlindUntilLabelingClosed: true,
    populationCollectionProvenance: { source: "immutable_revision" },
    populationDefinition: { revisionId },
    populationDigest: sha("1"),
    populationId,
    populationSize: 1,
    requiredLabelsPerItem: 2,
    rngVersion: "sha256-order/v1",
    roleIntent: "analysis_authoring",
    selectionAlgorithmVersion: "simple-random/v1",
    selectionMethod: "simple_random",
    selectionSeed: "seed-1",
    separationOfDutiesRequired: false,
    sourcePopulationId: revisionId,
    sourcePopulationKind: "dataset_revision",
    stateMachineVersion: "governed-review-state/v1",
    stopAt,
    stoppingRule: "fixed",
    strata: [],
    windowEnd: null,
    windowStart: null,
  });
  await client.query(`
    insert into governed_review_batches
      (id, project_id, criterion_version_id, instruction_version_id, role_intent,
       source_population_kind, source_population_id, population_id, population_definition,
       population_collection_provenance, population_size, population_digest,
       selection_method, selection_seed, rng_version, selection_algorithm_version,
       draw_executed_by, fixed_budget, stopping_rule, stop_at, draw_digest, strata,
       required_labels_per_item, evaluator_blind, peer_blind_until_labeling_closed,
       separation_of_duties_required, state_machine_version, content_digest,
       idempotency_key, request_digest, created_by_subject_id)
    values ($1,'proj_gov',$2,$3,'analysis_authoring','dataset_revision',$4,$5,$6::jsonb,
            $7::jsonb,1,$8,'simple_random','seed-1','sha256-order/v1','simple-random/v1',
            'coeval_server',1,'fixed','2099-01-01T00:00:00Z',$9,'[]',2,true,true,false,
            'governed-review-state/v1',$10,'batch-once',$11,'subject_dev')
  `, [batchId, criterionVersionId, instructionId, revisionId, populationId,
    JSON.stringify({ revisionId }), JSON.stringify({ source: "immutable_revision" }),
    sha("1"), drawDigest, batchDigest, sha("7")]);

  const batchItemDigest = await digest(client, "governed-review-batch-item/v1", {
    batchId,
    ...drawMember,
  });
  await client.query(`
    insert into governed_review_batch_items
      (id, project_id, batch_id, review_item_id, draw_position, frame_member_digest,
       inclusion_probability, sampling_weight, content_digest)
    values ($1,'proj_gov',$2,$3,0,$4,1,1,$5)
  `, [batchItemId, batchId, reviewItemId, sha("6"), batchItemDigest]);

  const tasks = [
    ["grt_a", "subject_review_a", 0],
    ["grt_b", "subject_review_b", 0],
  ] as const;
  for (const [taskId, reviewerSubjectId, serveOrder] of tasks) {
    const taskDigest = await digest(client, "governed-review-task/v1", {
      batchId,
      batchItemId,
      reviewerRoleAtReview: "reviewer",
      reviewerSubjectId,
      serveOrder,
    });
    await client.query(`
      insert into governed_review_tasks
        (id, project_id, batch_id, batch_item_id, reviewer_subject_id,
         reviewer_role_at_review, serve_order, content_digest, idempotency_key, request_digest)
      values ($1,'proj_gov',$2,$3,$4,'reviewer',$5,$6,$7,$8)
    `, [taskId, batchId, batchItemId, reviewerSubjectId, serveOrder,
      taskDigest, `task:${taskId}`, sha(taskId === "grt_a" ? "8" : "9")]);
  }

  return {
    projectId: "proj_gov",
    criterionVersionId,
    instructionId,
    revisionId,
    revisionItemId,
    reviewItemId,
    batchId,
    batchItemId,
    reviewerA: "subject_review_a",
    reviewerB: "subject_review_b",
    adjudicator: "subject_adjudicator",
    taskA: "grt_a",
    taskB: "grt_b",
    populationId,
  };
}

async function appendBatchEvent(
  client: Pool | PoolClient,
  fixture: Fixture,
  input: {
    id: string;
    sequence: number;
    kind: string;
    previousEventDigest?: string | null;
    datasetRevisionId?: string | null;
    representativeOfPopulationId?: string | null;
    representativeIneligibleReasons?: string[];
  },
): Promise<string> {
  const eventDigest = await digest(client, "governed-review-batch-event/v1", {
    actorRoleAtReview: "owner",
    actorSubjectId: "subject_dev",
    batchId: fixture.batchId,
    datasetRevisionId: input.datasetRevisionId ?? null,
    details: {},
    eventKind: input.kind,
    previousEventDigest: input.previousEventDigest ?? null,
    representativeIneligibleReasons: input.representativeIneligibleReasons ?? [],
    representativeOfPopulationId: input.representativeOfPopulationId ?? null,
    sequence: input.sequence,
    stateVersion: input.sequence,
  });
  await client.query(`
    insert into governed_review_batch_events
      (id, project_id, batch_id, sequence, state_version, expected_previous_state_version,
       event_kind, actor_subject_id, actor_role_at_review, dataset_revision_id,
       representative_of_population_id, representative_ineligible_reasons, details,
       previous_event_digest, event_digest, idempotency_key, request_digest)
    values ($1,$2,$3,$4,$4,$5,$6,'subject_dev','owner',$7,$8,$9,'{}',$10,$11,$12,$13)
  `, [input.id, fixture.projectId, fixture.batchId, input.sequence, input.sequence - 1,
    input.kind, input.datasetRevisionId ?? null, input.representativeOfPopulationId ?? null,
    input.representativeIneligibleReasons ?? [], input.previousEventDigest ?? null,
    eventDigest, `batch-event:${input.id}`, sha("a")]);
  return eventDigest;
}

async function appendViewed(
  client: Pool,
  fixture: Fixture,
  taskId: string,
  reviewerSubjectId: string,
): Promise<{ eventDigest: string; viewDigest: string }> {
  const bytes = Buffer.from(JSON.stringify({ task: taskId, criterion: "Correctness", input: "2+2?", output: "4" }));
  const base64 = bytes.toString("base64");
  const viewDigest = await bytesDigest(client, bytes);
  const eventDigest = await digest(client, "governed-review-task-event/v1", {
    activity: "governed_review",
    actorRoleAtReview: "reviewer",
    actorSubjectId: reviewerSubjectId,
    canonicalizationVersion: "canonical-json/v1",
    eventKind: "viewed",
    exposureClass: "provenance",
    labelId: null,
    reason: null,
    canonicalViewBytesBase64: base64,
    previousEventDigest: null,
    sequence: 1,
    stateVersion: 1,
    taskId,
    viewContractVersion: "governed-review-view/v1",
    viewDigest,
  });
  await client.query(`
    insert into governed_review_task_events
      (id, project_id, task_id, sequence, state_version, expected_previous_state_version,
       event_kind, actor_subject_id, actor_role_at_review, canonical_view_bytes_base64,
       view_digest, view_contract_version, canonicalization_version, exposure_class,
       activity, event_digest, idempotency_key, request_digest)
    values ($1,$2,$3,1,1,0,'viewed',$4,'reviewer',$5,$6,
            'governed-review-view/v1','canonical-json/v1','provenance','governed_review',$7,$8,$9)
  `, [`view:${taskId}`, fixture.projectId, taskId, reviewerSubjectId, base64, viewDigest,
    eventDigest, `view:${taskId}`, sha("b")]);
  return { eventDigest, viewDigest };
}

async function submitLabel(
  client: PoolClient,
  fixture: Fixture,
  input: {
    id: string;
    taskId: string;
    reviewerSubjectId: string;
    label: "pass" | "fail";
    previousEventDigest: string;
    viewDigest: string;
    idempotencyKey: string;
  },
): Promise<string> {
  return inTransaction(client, async () => {
    const labelDigest = await digest(client, "governed-review-label/v1", {
      attempt: 1,
      blindViewDigest: input.viewDigest,
      failureCodes: input.label === "fail" ? [" factual_error "] : [],
      label: input.label,
      rationale: `${input.label} rationale`,
      replacesLabelId: null,
      reviewerSubjectId: input.reviewerSubjectId,
      taskId: input.taskId,
    });
    await client.query(`
      insert into governed_review_labels
        (id, project_id, task_id, reviewer_subject_id, attempt, label, rationale,
         failure_codes, blind_view_digest, content_digest, idempotency_key, request_digest)
      values ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11)
    `, [input.id, fixture.projectId, input.taskId, input.reviewerSubjectId, input.label,
      `${input.label} rationale`, input.label === "fail" ? [" factual_error "] : [],
      input.viewDigest, labelDigest, input.idempotencyKey, sha("c")]);
    const eventDigest = await digest(client, "governed-review-task-event/v1", {
      activity: null,
      actorRoleAtReview: "reviewer",
      actorSubjectId: input.reviewerSubjectId,
      canonicalizationVersion: null,
      eventKind: "label_submitted",
      exposureClass: null,
      labelId: input.id,
      reason: null,
      canonicalViewBytesBase64: null,
      previousEventDigest: input.previousEventDigest,
      sequence: 2,
      stateVersion: 2,
      taskId: input.taskId,
      viewContractVersion: null,
      viewDigest: null,
    });
    await client.query(`
      insert into governed_review_task_events
        (id, project_id, task_id, sequence, state_version, expected_previous_state_version,
         event_kind, actor_subject_id, actor_role_at_review, label_id,
         previous_event_digest, event_digest, idempotency_key, request_digest)
      values ($1,$2,$3,2,2,1,'label_submitted',$4,'reviewer',$5,$6,$7,$8,$9)
    `, [`submit:${input.id}`, fixture.projectId, input.taskId, input.reviewerSubjectId,
      input.id, input.previousEventDigest, eventDigest, `submit:${input.id}`, sha("d")]);
    return eventDigest;
  });
}

async function createSealedPopulation(
  client: PoolClient,
  fixture: Fixture,
  input: {
    populationId: string;
    itemId: string;
    inputDigest: string;
    idempotencyKey: string;
    predecessorRevisionId?: string | null;
    predecessorRevisionItemId?: string | null;
  },
): Promise<void> {
  const populationDefinition = { kind: "test_frozen_frame" };
  const collectionProvenance = { kind: "test_server_collection" };
  const frameDigest = await digest(client, "governed-sealed-intake-frame/v1", [{
    framePosition: 0,
    inputDigest: input.inputDigest,
    reviewItemId: input.itemId,
  }]);
  const populationDigest = await digest(client, "governed-sealed-intake-population/v1", {
    collectionProvenance,
    custodianRoleAtReview: "custodian",
    custodianSubjectId: "subject_dev",
    frameCount: 1,
    frameDigest,
    populationDefinition,
    predecessorRevisionId: input.predecessorRevisionId ?? null,
    windowEnd: null,
    windowStart: null,
  });
  const reviewPayload = { input: { protected: true }, output: { protected: true } };
  const redactionProvenance = { projection: "test_safe_projection" };
  const itemDigest = await digest(client, "governed-review-item/v1", {
    identityBasis: "input-identity/v1",
    inputDigest: input.inputDigest,
    redactionProvenance,
    reviewPayloadProjectionVersion: "governed-review-payload/v1",
    reviewPayloadSnapshot: reviewPayload,
    sealedFramePosition: 0,
    sealedIntakePopulationId: input.populationId,
    sealedPredecessorRevisionId: input.predecessorRevisionId ?? null,
    sealedPredecessorRevisionItemId: input.predecessorRevisionItemId ?? null,
    sourceKind: "sealed_intake",
    sourceItemDigest: null,
    sourceRevisionId: null,
    sourceRevisionItemId: null,
  });
  await inTransaction(client, async () => {
    await client.query(`
      insert into governed_sealed_intake_populations
        (id,project_id,custodian_subject_id,custodian_role_at_review,population_definition,
         collection_provenance,frame_count,frame_digest,predecessor_revision_id,content_digest,
         idempotency_key,request_digest)
      values ($1,$2,'subject_dev','custodian',$3::jsonb,$4::jsonb,1,$5,$6,$7,$8,$9)
    `, [input.populationId, fixture.projectId, JSON.stringify(populationDefinition),
      JSON.stringify(collectionProvenance), frameDigest, input.predecessorRevisionId ?? null,
      populationDigest, input.idempotencyKey, sha("d")]);
    await client.query(`
      insert into governed_review_items
        (id,project_id,source_kind,sealed_intake_population_id,sealed_frame_position,
         sealed_predecessor_revision_id,sealed_predecessor_revision_item_id,identity_basis,
         input_digest,review_payload_projection_version,review_payload_snapshot,
         redaction_provenance,content_digest,idempotency_key,request_digest,created_by_subject_id)
      values ($1,$2,'sealed_intake',$3,0,$4,$5,'input-identity/v1',$6,
              'governed-review-payload/v1',$7::jsonb,$8::jsonb,$9,$10,$11,'subject_dev')
    `, [input.itemId, fixture.projectId, input.populationId,
      input.predecessorRevisionId ?? null, input.predecessorRevisionItemId ?? null,
      input.inputDigest, JSON.stringify(reviewPayload), JSON.stringify(redactionProvenance),
      itemDigest, `item:${input.idempotencyKey}`, sha("e")]);
  });
}

run("Batch 4 governed human truth PostgreSQL invariants", () => {
  it("enforces immutable blind streams, exact overlap, CAS adjudication, truth linkage, and erasure", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("governed_clean");
    try {
      await runMigrations(pool);
      const fixture = await createFixture(pool);

      // Cross-project/criterion swaps fail at the persistence boundary.
      await pool.query(`insert into organizations (id,name) values ('org_other','Other')`);
      await pool.query(`insert into projects (id,organization_id,name,trace_provider) values ('proj_other','org_other','Other','manual')`);
      await expect(pool.query(`
        insert into review_instruction_versions
          (id,project_id,criterion_version_id,revision,title,instructions,allowed_labels,
           failure_code_guidance,content_digest)
        values ('instruction_cross','proj_other',$1,2,'Cross','No','{pass,fail,cannot_determine}',
                'No',$2)
      `, [fixture.criterionVersionId, sha("e")])).rejects.toMatchObject({ code: "23514" });

      await pool.query(`
        insert into criteria (id,project_id,stable_key,source_kind,created_by_user_id)
        values ('criterion_skill_other_criterion',$1,'other-criterion','native','user_dev')
      `, [fixture.projectId]);
      await pool.query(`
        insert into criterion_versions
          (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind,created_by_user_id)
        values ('criterionv_skill_other_criterion',$1,'criterion_skill_other_criterion',1,
                'Other criterion','Another criterion.',
                criterion_v1_digest('criterion_skill_other_criterion','criterionv_skill_other_criterion',
                                    'Other criterion','Another criterion.'),'native','user_dev')
      `, [fixture.projectId]);
      await pool.query(`
        insert into skills (id,project_id,name,description,owner_user_id,status,criterion_id)
        values ('skill_other_criterion',$1,'Other criterion','Another criterion.','user_dev',
                'production','criterion_skill_other_criterion')
      `, [fixture.projectId]);
      await pool.query(`
        insert into skill_versions
          (id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,
           model_binding,verdict_kind,rubric_provenance,created_by_user_id,
           created_by_subject_id,developer_identity_status,criterion_version_id)
        values ('skillv_other_criterion','skill_other_criterion',$1,'1.0.0','approved','# Other',
                'Judge other.','{"type":"object"}','{"provider":"mock"}','binary',
                'human-authored','user_dev','subject_dev','recorded','criterionv_skill_other_criterion')
      `, [fixture.projectId]);
      await expect(pool.query(`
        insert into review_instruction_versions
          (id,project_id,criterion_version_id,revision,predecessor_instruction_version_id,
           title,instructions,allowed_labels,failure_code_guidance,content_digest)
        values ('instruction_cross_criterion',$1,'criterionv_skill_other_criterion',2,$2,
                'Cross criterion','No','{pass,fail,cannot_determine}','',$3)
      `, [fixture.projectId, fixture.instructionId, sha("e")])).rejects.toMatchObject({ code: "23514" });

      // Batch 4 deliberately has no trusted issuer-key registry or verified
      // connector. Even a complete, proof-shaped direct SQL record cannot
      // manufacture the reserved verified evidence class.
      const importedSourceBytes = Buffer.from("{}", "utf8");
      const importedSourceDigest = await bytesDigest(pool, importedSourceBytes);
      const importedProvenance = {
        adjudication: { decision: "pass" },
        blindAttestation: { statement: "blind" },
        instructions: { digest: sha("1") },
        issuer: "Caller-claimed lab",
        raters: [{ subject: "reviewer" }],
        sourceArtifactDigest: importedSourceDigest,
        subject: "record-one",
        transport: { kind: "claimed-signed-json" },
        verificationEvidence: { signature: "unverified-caller-bytes" },
        verificationMethod: "verified_signature",
      };
      const importedProvenanceDigest = await digest(
        pool,
        "governed-imported-truth-provenance/v1",
        importedProvenance,
      );
      const importedContent = {
        criterionVersionId: fixture.criterionVersionId,
        evidenceClass: "imported_verified_attested",
        failureCodes: [],
        identityBasis: "input-identity/v1",
        inputDigest: sha("2"),
        label: "pass",
        payloadSnapshot: { input: { prompt: "2+2" }, output: { answer: "4" } },
        provenanceDigest: importedProvenanceDigest,
        rationale: "Claimed complete evidence",
      };
      const importedContentDigest = await digest(
        pool,
        "governed-imported-truth/v1",
        importedContent,
      );
      await expect(pool.query(`
        insert into governed_imported_truth
          (id,project_id,criterion_version_id,issuer,subject,source_artifact_bytes,
           source_artifact_digest,transport_provenance,verification_method,verification_evidence,
           instructions_provenance,rater_provenance,adjudication_provenance,blind_attestation,
           identity_basis,input_digest,payload_snapshot,label,rationale,failure_codes,evidence_class,
           provenance_digest,content_digest,idempotency_key,request_digest)
        values ('import_forged_verified',$1,$2,'Caller-claimed lab','record-one',$3,$4,$5::jsonb,
                'verified_signature',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
                'input-identity/v1',$11,$12::jsonb,'pass','Claimed complete evidence','{}',
                'imported_verified_attested',$13,$14,'forged-verified',$15)
      `, [fixture.projectId, fixture.criterionVersionId, importedSourceBytes, importedSourceDigest,
        JSON.stringify(importedProvenance.transport), JSON.stringify(importedProvenance.verificationEvidence),
        JSON.stringify(importedProvenance.instructions), JSON.stringify(importedProvenance.raters),
        JSON.stringify(importedProvenance.adjudication), JSON.stringify(importedProvenance.blindAttestation),
        importedContent.inputDigest, JSON.stringify(importedContent.payloadSnapshot),
        importedProvenanceDigest, importedContentDigest, sha("3")])).rejects.toMatchObject({ code: "23514" });

      const futureOpenDigest = await digest(pool, "governed-review-batch-event/v1", {
        actorRoleAtReview: "owner",
        actorSubjectId: "subject_dev",
        batchId: fixture.batchId,
        datasetRevisionId: null,
        details: {},
        eventKind: "open",
        previousEventDigest: null,
        representativeIneligibleReasons: [],
        representativeOfPopulationId: null,
        sequence: 1,
        stateVersion: 1,
      });
      await expect(pool.query(`
        insert into governed_review_batch_events
          (id,project_id,batch_id,sequence,state_version,expected_previous_state_version,
           event_kind,actor_subject_id,actor_role_at_review,representative_ineligible_reasons,
           details,event_digest,idempotency_key,request_digest,occurred_at)
        values ('batch_open_from_future',$1,$2,1,1,0,'open','subject_dev','owner','{}','{}',
                $3,'future-open',$4,clock_timestamp() + interval '1 hour')
      `, [fixture.projectId, fixture.batchId, futureOpenDigest, sha("4")]))
        .rejects.toMatchObject({ code: "23514" });

      // Opening is a CAS event: concurrent state_version=1 attempts yield one winner.
      const openerA = await pool.connect();
      const openerB = await pool.connect();
      const openAttempt = (client: PoolClient, id: string) => appendBatchEvent(client, fixture, {
        id,
        sequence: 1,
        kind: "open",
      });
      const openResults = await Promise.allSettled([
        openAttempt(openerA, "batch_open_a"),
        openAttempt(openerB, "batch_open_b"),
      ]);
      openerA.release();
      openerB.release();
      expect(openResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(openResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      const openRow = (await pool.query(`select event_digest from governed_review_batch_events where batch_id=$1`, [fixture.batchId])).rows[0];

      const viewA = await appendViewed(pool, fixture, fixture.taskA, fixture.reviewerA);
      const viewB = await appendViewed(pool, fixture, fixture.taskB, fixture.reviewerB);
      const clientA = await pool.connect();
      const clientRace = await pool.connect();
      const labelRace = await Promise.allSettled([
        submitLabel(clientA, fixture, {
          id: "label_a_pass",
          taskId: fixture.taskA,
          reviewerSubjectId: fixture.reviewerA,
          label: "pass",
          previousEventDigest: viewA.eventDigest,
          viewDigest: viewA.viewDigest,
          idempotencyKey: "label-a-once",
        }),
        submitLabel(clientRace, fixture, {
          id: "label_a_racing_fail",
          taskId: fixture.taskA,
          reviewerSubjectId: fixture.reviewerA,
          label: "fail",
          previousEventDigest: viewA.eventDigest,
          viewDigest: viewA.viewDigest,
          idempotencyKey: "label-a-race",
        }),
      ]);
      clientA.release();
      clientRace.release();
      expect(labelRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const activeA = (await pool.query(`select label_id,label from governed_active_review_labels where task_id=$1`, [fixture.taskA])).rows[0];
      const desiredB = activeA.label === "pass" ? "fail" : "pass";
      const clientB = await pool.connect();
      await submitLabel(clientB, fixture, {
        id: `label_b_${desiredB}`,
        taskId: fixture.taskB,
        reviewerSubjectId: fixture.reviewerB,
        label: desiredB,
        previousEventDigest: viewB.eventDigest,
        viewDigest: viewB.viewDigest,
        idempotencyKey: "label-b-once",
      });
      clientB.release();

      const closeDigest = await appendBatchEvent(pool, fixture, {
        id: "batch_labeling_closed",
        sequence: 2,
        kind: "labeling_closed",
        previousEventDigest: String(openRow.event_digest),
      });
      await expect(pool.query(`update governed_review_labels set rationale='tampered' where id=$1`, [activeA.label_id]))
        .rejects.toMatchObject({ code: "55000" });
      await expect(pool.query(`delete from governed_review_task_events where task_id=$1`, [fixture.taskA]))
        .rejects.toMatchObject({ code: "55000" });

      const alignmentOpenDigest = await appendBatchEvent(pool, fixture, {
        id: "batch_alignment_open",
        sequence: 3,
        kind: "alignment_open",
        previousEventDigest: closeDigest,
      });
      const activeLabels = (await pool.query(`
        select label_id from governed_active_review_labels where batch_id=$1 order by label_id
      `, [fixture.batchId])).rows.map((row) => String(row.label_id));
      const labelSetDigest = String((await pool.query(
        `select governed_review_label_set_digest($1) as digest`, [fixture.batchId],
      )).rows[0]?.digest);
      let previousAlignmentDigest: string | null = null;
      for (const [sequence, kind, content] of [
        [1, "comment_recorded", "Reviewers discussed the disagreement without changing labels."],
        [2, "closed", "Alignment discussion closed; proceed to adjudication."],
      ] as const) {
        const eventDigest = await digest(pool, "governed-review-alignment-event/v1", {
          actorRoleAtReview: "adjudicator",
          actorSubjectId: fixture.adjudicator,
          batchId: fixture.batchId,
          content,
          eventKind: kind,
          previousEventDigest: previousAlignmentDigest,
          proposedInstructionVersionId: null,
          sequence,
          visibleLabelCount: activeLabels.length,
          visibleLabelSetDigest: labelSetDigest,
        });
        const alignmentId = `alignment_${sequence}`;
        const alignmentClient = await pool.connect();
        await inTransaction(alignmentClient, async () => {
          await alignmentClient.query(`
            insert into governed_review_alignment_events
              (id,project_id,batch_id,sequence,expected_previous_sequence,event_kind,
               actor_subject_id,actor_role_at_review,content,visible_label_count,
               visible_label_set_digest,previous_event_digest,event_digest,idempotency_key,request_digest)
            values ($1,$2,$3,$4,$5,$6,$7,'adjudicator',$8,$9,$10,$11,$12,$13,$14)
          `, [alignmentId, fixture.projectId, fixture.batchId, sequence, sequence - 1, kind,
            fixture.adjudicator, content, activeLabels.length, labelSetDigest,
            previousAlignmentDigest, eventDigest, `alignment:${sequence}`, sha("f")]);
          for (const labelId of activeLabels) {
            await alignmentClient.query(`
              insert into governed_review_alignment_event_labels
                (project_id,alignment_event_id,label_id) values ($1,$2,$3)
            `, [fixture.projectId, alignmentId, labelId]);
          }
        });
        alignmentClient.release();
        previousAlignmentDigest = eventDigest;
      }
      const adjudicatingDigest = await appendBatchEvent(pool, fixture, {
        id: "batch_adjudicating",
        sequence: 4,
        kind: "adjudicating",
        previousEventDigest: alignmentOpenDigest,
      });

      const itemLabelSetDigest = String((await pool.query(
        `select governed_review_item_label_set_digest($1) as digest`, [fixture.batchItemId],
      )).rows[0]?.digest);
      const adjudicate = async (client: PoolClient, id: string, decision: "pass" | "fail") =>
        inTransaction(client, async () => {
          const contentDigest = await digest(client, "governed-review-adjudication/v1", {
            adjudicatorRoleAtReview: "adjudicator",
            adjudicatorSubjectId: fixture.adjudicator,
            basis: "Full trace and both independent labels.",
            batchId: fixture.batchId,
            batchItemId: fixture.batchItemId,
            chainVersion: 1,
            consideredLabelCount: activeLabels.length,
            consideredLabelSetDigest: itemLabelSetDigest,
            correctionReason: null,
            decision,
            rationale: `Adjudicated ${decision}.`,
            supersedesAdjudicationId: null,
          });
          await client.query(`
            insert into governed_review_adjudications
              (id,project_id,batch_id,batch_item_id,chain_version,expected_previous_chain_version,
               adjudicator_subject_id,adjudicator_role_at_review,decision,rationale,basis,
               considered_label_count,considered_label_set_digest,content_digest,idempotency_key,request_digest)
            values ($1,$2,$3,$4,1,0,$5,'adjudicator',$6,$7,$8,$9,$10,$11,$12,$13)
          `, [id, fixture.projectId, fixture.batchId, fixture.batchItemId, fixture.adjudicator,
            decision, `Adjudicated ${decision}.`, "Full trace and both independent labels.",
            activeLabels.length, itemLabelSetDigest, contentDigest, `adjudicate:${id}`, sha("0")]);
          for (const labelId of activeLabels) {
            await client.query(`
              insert into governed_review_adjudication_labels
                (project_id,adjudication_id,label_id) values ($1,$2,$3)
            `, [fixture.projectId, id, labelId]);
          }
        });
      const adjudicatorA = await pool.connect();
      const adjudicatorB = await pool.connect();
      const adjudicationRace = await Promise.allSettled([
        adjudicate(adjudicatorA, "adjudication_pass", "pass"),
        adjudicate(adjudicatorB, "adjudication_fail", "fail"),
      ]);
      adjudicatorA.release();
      adjudicatorB.release();
      expect(adjudicationRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const head = (await pool.query(`
        select * from governed_review_adjudications adjudication
        where batch_item_id=$1 and not exists (
          select 1 from governed_review_adjudications successor
          where successor.supersedes_adjudication_id=adjudication.id
        )
      `, [fixture.batchItemId])).rows[0];
      expect(head).toBeTruthy();

      const resolvedDigest = await appendBatchEvent(pool, fixture, {
        id: "batch_resolved",
        sequence: 5,
        kind: "resolved",
        previousEventDigest: adjudicatingDigest,
      });
      await expect(pool.query(`
        insert into governed_review_labels
          (id,project_id,task_id,reviewer_subject_id,attempt,label,rationale,failure_codes,
           blind_view_digest,content_digest,idempotency_key,request_digest)
        values ('late_label',$1,$2,$3,2,'pass','late','{}',$4,$5,'late',$6)
      `, [fixture.projectId, fixture.taskA, fixture.reviewerA, viewA.viewDigest, sha("1"), sha("2")]))
        .rejects.toMatchObject({ code: "55000" });

      const targetRevisionId = "dsr_gov_truth";
      const targetItemId = "dsri_gov_truth";
      const badTargetRevisionId = "dsr_gov_truth_bad_pointer";
      const badTargetItemId = "dsri_gov_truth_bad_pointer";
      await pool.query(`
        insert into dataset_revisions
          (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
           content_digest,revision_digest,item_count,provenance_level,criterion_version_id)
        values ($1,$2,'governed-truth-bad-pointer',1,'analysis_authoring','collection_snapshot',
                'input-identity/v1',$3,$4,1,'governed_blind',$5)
      `, [badTargetRevisionId, fixture.projectId, sha("7"), sha("8"), fixture.criterionVersionId]);
      await pool.query(`
        insert into dataset_revision_items
          (id,revision_id,project_id,position,input_digest,item_digest,payload_snapshot,
           reference_label,reference_provenance)
        select $1,$2,$3,0,input_digest,$4,payload_snapshot,$5,
               '{"kind":"dataset_claim","sourceId":"wrong_truth_link","verdictIds":[],"actorUserIds":[],"basis":"mismatched compatibility pointer"}'
        from dataset_revision_items where id=$6
      `, [badTargetItemId, badTargetRevisionId, fixture.projectId, sha("9"), head.decision, fixture.revisionItemId]);
      const badTruthContent = {
        adjudicationId: head.id,
        batchItemId: fixture.batchItemId,
        criterionVersionId: fixture.criterionVersionId,
        datasetRevisionId: badTargetRevisionId,
        datasetRevisionItemId: badTargetItemId,
        governedLabelIds: [],
        importedTruthId: null,
        resolutionKind: "adjudicated",
        resolvedLabel: head.decision,
        sourceKind: "adjudication",
        supportingLabelCount: activeLabels.length,
      };
      const badTruthDigest = await digest(pool, "governed-dataset-truth-link/v1", badTruthContent);
      await expect(pool.query(`
        insert into governed_dataset_truth_links
          (id,project_id,dataset_revision_id,dataset_revision_item_id,criterion_version_id,
           source_kind,batch_item_id,governed_label_ids,adjudication_id,resolution_kind,
           resolved_label,supporting_label_count,content_digest,idempotency_key,request_digest)
        values ('truth_link_bad',$1,$2,$3,$4,'adjudication',$5,'{}',$6,'adjudicated',$7,$8,$9,
                'truth-bad-pointer',$10)
      `, [fixture.projectId, badTargetRevisionId, badTargetItemId, fixture.criterionVersionId,
        fixture.batchItemId, head.id, head.decision, activeLabels.length, badTruthDigest, sha("a")]))
        .rejects.toMatchObject({ code: "23514" });

      await pool.query(`
        insert into dataset_revisions
          (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
           content_digest,revision_digest,item_count,provenance_level,criterion_version_id)
        values ($1,$2,'governed-truth',1,'analysis_authoring','collection_snapshot',
                'input-identity/v1',$3,$4,1,'governed_blind',$5)
      `, [targetRevisionId, fixture.projectId, sha("3"), sha("4"), fixture.criterionVersionId]);
      await pool.query(`
        insert into dataset_revision_items
          (id,revision_id,project_id,position,input_digest,item_digest,payload_snapshot,
           reference_label,reference_provenance)
        select $1,$2,$3,0,input_digest,$4,payload_snapshot,$5,
               '{"kind":"dataset_claim","sourceId":"truth_link","verdictIds":[],"actorUserIds":[],"basis":"Non-authoritative compatibility projection; authoritative governed truth is truth_link."}'
        from dataset_revision_items where id=$6
      `, [targetItemId, targetRevisionId, fixture.projectId, sha("5"), head.decision, fixture.revisionItemId]);
      const truthDigest = await digest(pool, "governed-dataset-truth-link/v1", {
        adjudicationId: head.id,
        batchItemId: fixture.batchItemId,
        criterionVersionId: fixture.criterionVersionId,
        datasetRevisionId: targetRevisionId,
        datasetRevisionItemId: targetItemId,
        governedLabelIds: [],
        importedTruthId: null,
        resolutionKind: "adjudicated",
        resolvedLabel: head.decision,
        sourceKind: "adjudication",
        supportingLabelCount: activeLabels.length,
      });
      await pool.query(`
        insert into governed_dataset_truth_links
          (id,project_id,dataset_revision_id,dataset_revision_item_id,criterion_version_id,
           source_kind,batch_item_id,governed_label_ids,adjudication_id,resolution_kind,
           resolved_label,supporting_label_count,content_digest,idempotency_key,request_digest)
        values ('truth_link',$1,$2,$3,$4,'adjudication',$5,'{}',$6,'adjudicated',$7,$8,$9,'truth-once',$10)
      `, [fixture.projectId, targetRevisionId, targetItemId, fixture.criterionVersionId,
        fixture.batchItemId, head.id, head.decision, activeLabels.length, truthDigest, sha("6")]);

      await appendBatchEvent(pool, fixture, {
        id: "batch_frozen",
        sequence: 6,
        kind: "frozen",
        previousEventDigest: resolvedDigest,
        datasetRevisionId: targetRevisionId,
        representativeOfPopulationId: fixture.populationId,
      });
      expect((await pool.query(`
        select representative_of_population_id from governed_review_batch_events
        where batch_id=$1 and event_kind='frozen'
      `, [fixture.batchId])).rows[0]?.representative_of_population_id).toBe(fixture.populationId);

      // Sealed intake is one atomic parent+frame, with exact overlap serialized.
      const overlapA = await pool.connect();
      const overlapB = await pool.connect();
      const overlapResults = await Promise.allSettled([
        createSealedPopulation(overlapA, fixture, {
          populationId: "sealed_population_overlap_a",
          itemId: "sealed_item_overlap_a",
          inputDigest: sha("a"),
          idempotencyKey: "sealed-overlap-a",
        }),
        createSealedPopulation(overlapB, fixture, {
          populationId: "sealed_population_overlap_b",
          itemId: "sealed_item_overlap_b",
          inputDigest: sha("a"),
          idempotencyKey: "sealed-overlap-b",
        }),
      ]);
      overlapA.release();
      overlapB.release();
      expect(overlapResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await pool.query(`
        select count(*)::int as count from governed_review_items
        where project_id=$1 and source_kind='sealed_intake' and input_digest=$2
      `, [fixture.projectId, sha("a")])).rows[0]?.count).toBe(1);

      const idempotentA = await pool.connect();
      const idempotentB = await pool.connect();
      const idempotencyResults = await Promise.allSettled([
        createSealedPopulation(idempotentA, fixture, {
          populationId: "sealed_population_idempotent_a",
          itemId: "sealed_item_idempotent_a",
          inputDigest: sha("b"),
          idempotencyKey: "sealed-population-once",
        }),
        createSealedPopulation(idempotentB, fixture, {
          populationId: "sealed_population_idempotent_b",
          itemId: "sealed_item_idempotent_b",
          inputDigest: sha("c"),
          idempotencyKey: "sealed-population-once",
        }),
      ]);
      idempotentA.release();
      idempotentB.release();
      expect(idempotencyResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await pool.query(`
        select count(*)::int as count from governed_sealed_intake_populations
        where project_id=$1 and idempotency_key='sealed-population-once'
      `, [fixture.projectId])).rows[0]?.count).toBe(1);

      const nonsealedOverlapClient = await pool.connect();
      await expect(createSealedPopulation(nonsealedOverlapClient, fixture, {
        populationId: "sealed_population_nonsealed_overlap",
        itemId: "sealed_item_nonsealed_overlap",
        inputDigest: sha("3"),
        idempotencyKey: "sealed-nonsealed-overlap",
      })).rejects.toMatchObject({ code: "23514" });
      nonsealedOverlapClient.release();

      // ADR-0007's exception is one exact protected, unexposed direct successor.
      await pool.query(`
        insert into dataset_revisions
          (id,project_id,series_id,revision_number,role,source_kind,identity_basis,
           content_digest,revision_digest,item_count,provenance_level,criterion_version_id)
        values ('dsr_sealed_predecessor',$1,'sealed-successor',1,'sealed_validation','sealed_intake',
                'input-identity/v1',$2,$3,1,'governed_blind',$4)
      `, [fixture.projectId, sha("4"), sha("5"), fixture.criterionVersionId]);
      await pool.query(`
        insert into dataset_revision_items
          (id,revision_id,project_id,position,input_digest,item_digest,payload_snapshot,
           reference_label,reference_provenance)
        values ('dsri_sealed_predecessor','dsr_sealed_predecessor',$1,0,$2,$3,
                '{"input":{"protected":true},"output":{"protected":true}}','pass',
                '{"kind":"adjudication","sourceId":null,"verdictIds":[],"actorUserIds":[],"basis":"protected predecessor"}')
      `, [fixture.projectId, sha("f"), sha("6")]);
      const successorA = await pool.connect();
      await createSealedPopulation(successorA, fixture, {
        populationId: "sealed_successor_population",
        itemId: "sealed_successor_item",
        inputDigest: sha("f"),
        idempotencyKey: "sealed-successor",
        predecessorRevisionId: "dsr_sealed_predecessor",
        predecessorRevisionItemId: "dsri_sealed_predecessor",
      });
      successorA.release();
      const successorB = await pool.connect();
      await expect(createSealedPopulation(successorB, fixture, {
        populationId: "sealed_successor_population_branch",
        itemId: "sealed_successor_item_branch",
        inputDigest: sha("f"),
        idempotencyKey: "sealed-successor-branch",
        predecessorRevisionId: "dsr_sealed_predecessor",
        predecessorRevisionItemId: "dsri_sealed_predecessor",
      })).rejects.toBeTruthy();
      successorB.release();

      await pool.query(`delete from projects where id=$1`, [fixture.projectId]);
      expect((await pool.query(`select count(*)::int as count from governed_review_batches where project_id=$1`, [fixture.projectId])).rows[0]?.count)
        .toBe(0);
      expect((await pool.query(`select count(*)::int as count from governed_review_labels where project_id=$1`, [fixture.projectId])).rows[0]?.count)
        .toBe(0);
    } finally {
      await cleanup();
    }
  });
});
