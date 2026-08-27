import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { CreateSkillVersionInputSchema } from "@coeval/shared";
import { canonicalJson } from "../src/lib/assessment-receipt.js";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/lib/auth.js";
import {
  GovernedImportedTruthVerificationUnavailableError,
  GovernedReviewIdempotencyConflictError,
  GovernedReviewNotFoundError,
  GovernedReviewSeparationIneligibleError,
  GovernedReviewSeparationUnknownError,
  GovernedReviewTransitionConflictError,
  PgGovernedReviewRepository,
  type GovernedReviewActor
} from "../src/governed-review/index.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; governed repository PostgreSQL tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

const PROJECT_ID = "proj_governed_repository";
const OTHER_PROJECT_ID = "proj_governed_other";
const OWNER: GovernedReviewActor = { projectId: PROJECT_ID, userId: "user_owner", projectRole: "owner" };
const REVIEWER_A: GovernedReviewActor = { projectId: PROJECT_ID, userId: "user_reviewer_a", projectRole: "member" };
const REVIEWER_B: GovernedReviewActor = { projectId: PROJECT_ID, userId: "user_reviewer_b", projectRole: "member" };
const CUSTODIAN: GovernedReviewActor = { projectId: PROJECT_ID, userId: "user_custodian", projectRole: "member" };
const MEMBER: GovernedReviewActor = { projectId: PROJECT_ID, userId: "user_member", projectRole: "member" };
const DEVELOPER: GovernedReviewActor = { projectId: PROJECT_ID, userId: "user_developer", projectRole: "member" };
const OTHER_OWNER: GovernedReviewActor = { projectId: OTHER_PROJECT_ID, userId: "user_other", projectRole: "owner" };
const STOP_AT = "2099-01-01T00:00:00.000Z";

let pool: Pool;
let cleanup: (() => Promise<void>) | undefined;
let repository: PgGovernedReviewRepository;
let platform: PgRepository;
let nonsealedCriterionVersionId: string;
let sealedCriterionVersionId: string;
let unknownCriterionVersionId: string;
let sourceRevisionId: string;

beforeAll(async () => {
  if (!databaseUrl) return;
  ({ pool, cleanup } = await openPostgresTestDatabase("governed_repository"));
  await runMigrations(pool);
  repository = new PgGovernedReviewRepository(pool);
  platform = new PgRepository(pool);

  await pool.query(`insert into organizations (id,name) values ('org_governed_repository','Governed Repository')`);
  for (const userId of [
    "user_owner", "user_reviewer_a", "user_reviewer_b", "user_custodian",
    "user_member", "user_developer", "user_other"
  ]) {
    await pool.query(
      `insert into "user" (id,name,email) values ($1,$2,$3)`,
      [userId, userId.replaceAll("_", " "), `${userId}@example.test`]
    );
  }
  await pool.query(
    `insert into projects (id,organization_id,name,trace_provider) values
       ($1,'org_governed_repository','Governed Repository','manual'),
       ($2,'org_governed_repository','Other Governed Project','manual')`,
    [PROJECT_ID, OTHER_PROJECT_ID]
  );
  let memberSequence = 0;
  for (const [userId, role] of [
    ["user_owner", "owner"], ["user_reviewer_a", "member"], ["user_reviewer_b", "member"],
    ["user_custodian", "member"], ["user_member", "member"], ["user_developer", "member"]
  ] as const) {
    await pool.query(
      `insert into project_members (id,project_id,user_id,role) values ($1,$2,$3,$4)`,
      [`pm_governed_${memberSequence++}`, PROJECT_ID, userId, role]
    );
  }
  await pool.query(
    `insert into project_members (id,project_id,user_id,role)
     values ('pm_governed_other',$1,'user_other','owner')`,
    [OTHER_PROJECT_ID]
  );

  await pool.query(
    `insert into criteria (id,project_id,stable_key,source_kind) values
       ('criterion_nonsealed',$1,'nonsealed-review','native'),
       ('criterion_sealed',$1,'sealed-review','native'),
       ('criterion_unknown',$1,'unknown-author-review','native')`,
    [PROJECT_ID]
  );
  for (const [criterionId, versionId, name, definition] of [
    ["criterion_nonsealed", "criterionv_nonsealed", "Nonsealed criterion", "Nonsealed governed review."],
    ["criterion_sealed", "criterionv_sealed", "Sealed criterion", "Sealed governed review."],
    ["criterion_unknown", "criterionv_unknown", "Unknown author criterion", "Evaluator authorship may remain unknown."],
  ]) {
    await pool.query(
      `insert into criterion_versions
         (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind,
          created_by_user_id)
       values ($1,$2,$3,1,$4,$5,criterion_v1_digest($3,$1,$4,$5),'native',$6)`,
      [versionId, PROJECT_ID, criterionId, name, definition, DEVELOPER.userId],
    );
  }
  await pool.query(
    `insert into skills (id,project_id,name,description,owner_user_id,status,criterion_id) values
       ('skill_nonsealed',$1,'Nonsealed criterion','Nonsealed governed review','user_developer','draft','criterion_nonsealed'),
       ('skill_sealed',$1,'Sealed criterion','Sealed governed review','user_developer','draft','criterion_sealed'),
       ('skill_unknown',$1,'Unknown provenance criterion','Unknown author evaluator','user_developer','draft','criterion_unknown')`,
    [PROJECT_ID]
  );
  nonsealedCriterionVersionId = "criterionv_nonsealed";
  sealedCriterionVersionId = "criterionv_sealed";
  unknownCriterionVersionId = "criterionv_unknown";

  const evaluatorInput = CreateSkillVersionInputSchema.parse({
    rubricMarkdown: "# Sealed evaluator rubric",
    prompt: "Judge the immutable criterion.",
    modelBinding: { provider: "mock", modelId: "mock", modelVersion: "1", temperature: 0 },
    verdictKind: "binary",
    criterionVersionId: sealedCriterionVersionId
  });
  const recordedVersion = await platform.createSkillVersionPending(
    "skill_sealed",
    evaluatorInput,
    { projectId: PROJECT_ID, actorUserId: DEVELOPER.userId }
  );
  const recorded = (await pool.query(
    `select created_by_user_id,created_by_subject_id,developer_identity_status
     from skill_versions where id=$1`, [recordedVersion.id]
  )).rows[0];
  expect(recorded).toMatchObject({
    created_by_user_id: DEVELOPER.userId,
    developer_identity_status: "recorded"
  });
  expect(String(recorded.created_by_subject_id)).toMatch(/^grs_/);
  expect((await pool.query(
    `select developer_subject_id from governed_evaluator_development_events where skill_version_id=$1`,
    [recordedVersion.id]
  )).rows).toEqual([{ developer_subject_id: recorded.created_by_subject_id }]);

  // Regression for the subject-identity split: a person who first appears as
  // an evaluator author must resolve to that same account-bound subject when
  // they are later assigned a nonsealed governed review task.
  const reviewerAuthoredVersion = await platform.createSkillVersionPending(
    "skill_nonsealed",
    CreateSkillVersionInputSchema.parse({
      ...evaluatorInput,
      rubricMarkdown: "# Nonsealed evaluator authored by the later reviewer",
      criterionVersionId: nonsealedCriterionVersionId
    }),
    { projectId: PROJECT_ID, actorUserId: REVIEWER_A.userId }
  );
  const reviewerAuthor = (await pool.query(
    `select subject.id
     from governed_reviewer_subjects subject
     join skill_versions version on version.created_by_subject_id=subject.id
     where version.id=$1 and subject.account_user_id=$2`,
    [reviewerAuthoredVersion.id, REVIEWER_A.userId]
  )).rows[0];
  expect(String(reviewerAuthor?.id)).toMatch(/^grs_[0-9a-f]{48}$/);

  const unknownVersion = await platform.createSkillVersionPending(
    "skill_unknown",
    CreateSkillVersionInputSchema.parse({
      ...evaluatorInput,
      rubricMarkdown: "# Historical evaluator rubric",
      criterionVersionId: unknownCriterionVersionId
    }),
    { projectId: PROJECT_ID }
  );
  expect((await pool.query(
    `select created_by_user_id,created_by_subject_id,developer_identity_status
     from skill_versions where id=$1`, [unknownVersion.id]
  )).rows[0]).toMatchObject({
    created_by_user_id: null,
    created_by_subject_id: null,
    developer_identity_status: "unknown_legacy"
  });

  const dataset = await platform.createDataset({ projectId: PROJECT_ID, name: "Governed source" });
  for (const [sourceTraceId, question, answer] of [
    ["governed-source-1", "What is two plus two?", "Four"],
    ["governed-source-2", "What is three plus three?", "Six"]
  ] as const) {
    const imported = await platform.importTrace(PROJECT_ID, "manual", {
      sourceTraceId,
      input: { question },
      output: { answer },
      metadata: { expected_label: "must-never-reach-blind-review" }
    }, { ingestionPurpose: "analysis_eligible_manual" });
    await platform.addDatasetItems({
      projectId: PROJECT_ID,
      datasetId: dataset.id,
      items: [{ caseId: imported.caseId }]
    });
  }
  sourceRevisionId = (await platform.createDatasetRevision({
    projectId: PROJECT_ID,
    datasetId: dataset.id,
    role: "analysis_authoring",
    idempotencyKey: "governed-source-revision",
    createdByUserId: OWNER.userId
  })).id;
}, 30_000);

afterAll(async () => {
  await cleanup?.();
});

run("PgGovernedReviewRepository", () => {
  it("completes a nonsealed blind review with exact views, privacy, idempotency, and atomic freeze", async () => {
    const instructionInput = {
      criterionVersionId: nonsealedCriterionVersionId,
      title: "Independent factual review",
      instructions: "Use only the immutable input and output supplied in the blind view.",
      failureCodeGuidance: "Use short open failure codes.",
      idempotencyKey: "instruction-nonsealed"
    };
    const instruction = await repository.createInstruction(OWNER, instructionInput);
    expect(await repository.createInstruction(OWNER, instructionInput)).toEqual(instruction);
    await expect(repository.createInstruction(OWNER, {
      ...instructionInput,
      title: "Conflicting title"
    })).rejects.toBeInstanceOf(GovernedReviewIdempotencyConflictError);

    const batch = await repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "analysis_authoring",
      source: { kind: "dataset_revision", revisionId: sourceRevisionId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [REVIEWER_A.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-nonsealed"
    });
    expect(batch).toMatchObject({
      state: "draft",
      sourcePopulationId: sourceRevisionId,
      evaluatorBlind: true,
      peerBlindUntilLabelingClosed: true,
      completeness: null,
      items: [{ resolutionKind: null, resolvedLabel: null }]
    });
    expect(await repository.listReviewerTasks(REVIEWER_A)).toEqual([]);
    await expect(repository.getBatchSummary(OTHER_OWNER, batch.batchId)).rejects
      .toBeInstanceOf(GovernedReviewNotFoundError);
    await expect(repository.createBatchDraft(OTHER_OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "analysis_authoring",
      source: { kind: "dataset_revision", revisionId: sourceRevisionId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [OTHER_OWNER.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "cross-project-source"
    })).rejects.toBeInstanceOf(GovernedReviewNotFoundError);

    await repository.transitionBatch(OWNER, batch.batchId, "open", {
      expectedStateVersion: 0,
      idempotencyKey: "open-nonsealed"
    });
    const [task] = await repository.listReviewerTasks(REVIEWER_A);
    expect(task).toBeTruthy();
    await expect(repository.getOrCreateBlindTaskView(MEMBER, task!.taskId)).rejects
      .toBeInstanceOf(GovernedReviewNotFoundError);
    const [firstView, repeatedView] = await Promise.all([
      repository.getOrCreateBlindTaskView(REVIEWER_A, task!.taskId),
      repository.getOrCreateBlindTaskView(REVIEWER_A, task!.taskId)
    ]);
    expect(Buffer.from(firstView.canonicalBytes).equals(Buffer.from(repeatedView.canonicalBytes))).toBe(true);
    expect(firstView.viewDigest).toBe(repeatedView.viewDigest);
    const decodedView = JSON.parse(Buffer.from(firstView.canonicalBytes).toString("utf8"));
    expect(decodedView).not.toHaveProperty("viewDigest");
    expect(JSON.stringify(decodedView)).not.toContain("expected_label");

    const submitInput = {
      expectedStreamVersion: 1,
      viewDigest: firstView.viewDigest,
      label: "pass" as const,
      rationale: "The output answers the supplied arithmetic question.",
      failureCodes: [] as string[],
      idempotencyKey: "label-nonsealed"
    };
    const submitted = await repository.appendTaskAction(REVIEWER_A, task!.taskId, {
      kind: "submit_label",
      input: submitInput
    });
    expect(await repository.appendTaskAction(REVIEWER_A, task!.taskId, {
      kind: "submit_label",
      input: submitInput
    })).toEqual(submitted);
    await expect(repository.appendTaskAction(REVIEWER_A, task!.taskId, {
      kind: "submit_label",
      input: { ...submitInput, rationale: "Conflicting replay" }
    })).rejects.toBeInstanceOf(GovernedReviewIdempotencyConflictError);

    const preBarrier = await repository.getBatchSummary(REVIEWER_A, batch.batchId);
    expect(preBarrier.completeness).toBeNull();
    expect(preBarrier.items).toEqual([
      expect.objectContaining({ resolutionKind: null, resolvedLabel: null })
    ]);
    expect(JSON.stringify(preBarrier)).not.toContain(submitInput.rationale);

    await repository.transitionBatch(OWNER, batch.batchId, "close_labeling", {
      expectedStateVersion: 1,
      idempotencyKey: "close-nonsealed"
    });
    await repository.transitionBatch(OWNER, batch.batchId, "finalize", {
      expectedStateVersion: 2,
      idempotencyKey: "finalize-nonsealed"
    });
    const frozen = await repository.transitionBatch(OWNER, batch.batchId, "freeze", {
      expectedStateVersion: 3,
      idempotencyKey: "freeze-nonsealed"
    });
    expect(frozen).toMatchObject({
      state: "frozen",
      evidenceClass: "governed_blind",
      representativeness: { status: "eligible", populationId: `dataset-revision:${sourceRevisionId}` },
      items: [{ resolutionKind: "single_rater", resolvedLabel: "pass" }]
    });
    expect(frozen.datasetRevisionId).toBeTruthy();
    const governedProvenance = (await pool.query(
      `select item.reference_provenance,truth.id as truth_link_id
       from dataset_revision_items item
       join governed_dataset_truth_links truth on truth.dataset_revision_item_id=item.id
       where item.revision_id=$1`,
      [frozen.datasetRevisionId]
    )).rows;
    expect(governedProvenance).toHaveLength(1);
    expect(governedProvenance[0]?.reference_provenance).toMatchObject({
      kind: "dataset_claim",
      sourceId: governedProvenance[0]?.truth_link_id,
      basis: expect.stringContaining("Non-authoritative receipt-v1 compatibility projection")
    });
  });

  it("rejects a draft before persistence when its exact blind view would exceed 2 MiB", async () => {
    const dataset = await platform.createDataset({ projectId: PROJECT_ID, name: "Oversize governed source" });
    const imported = await platform.importTrace(PROJECT_ID, "manual", {
      sourceTraceId: "governed-oversize-source",
      input: { question: "Can this exact view fit?" },
      output: { blob: "x".repeat(2_000_000) },
      metadata: {}
    }, {
      ingestionPurpose: "analysis_eligible_manual",
      redactionConfig: { maxStringChars: 2_010_000 }
    });
    await platform.addDatasetItems({
      projectId: PROJECT_ID,
      datasetId: dataset.id,
      items: [{ caseId: imported.caseId }]
    });
    const revision = await platform.createDatasetRevision({
      projectId: PROJECT_ID,
      datasetId: dataset.id,
      role: "analysis_authoring",
      idempotencyKey: "oversize-source-revision"
    });
    const predecessor = (await repository.listInstructions(OWNER, nonsealedCriterionVersionId))[0]!;
    const instruction = await repository.createInstruction(OWNER, {
      criterionVersionId: nonsealedCriterionVersionId,
      predecessorInstructionVersionId: predecessor.instructionVersionId,
      title: "Oversize exact-view preflight",
      instructions: "I".repeat(100_000),
      failureCodeGuidance: "No draft may survive if its exact view exceeds the limit.",
      idempotencyKey: "instruction-oversize"
    });
    await expect(repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "analysis_authoring",
      source: { kind: "dataset_revision", revisionId: revision.id },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [REVIEWER_A.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-oversize"
    })).rejects.toMatchObject({ code: "governed_review_transition_conflict" });
    expect((await pool.query(
      `select count(*)::int as count from governed_review_batches where idempotency_key='batch-oversize'`
    )).rows[0].count).toBe(0);
  });

  it("handles submit/close concurrency, incomplete freeze, systematic provenance, and adjudicated abstention", async () => {
    const instruction = (await repository.listInstructions(OWNER, nonsealedCriterionVersionId))[0]!;

    const race = await repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "analysis_authoring",
      source: { kind: "dataset_revision", revisionId: sourceRevisionId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [REVIEWER_B.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-race"
    });
    await repository.transitionBatch(OWNER, race.batchId, "open", { expectedStateVersion: 0, idempotencyKey: "open-race" });
    const raceTask = (await repository.listReviewerTasks(REVIEWER_B)).find((task) => task.batchId === race.batchId)!;
    const raceView = await repository.getOrCreateBlindTaskView(REVIEWER_B, raceTask.taskId);
    const raced = await Promise.allSettled([
      repository.appendTaskAction(REVIEWER_B, raceTask.taskId, {
        kind: "submit_label",
        input: {
          expectedStreamVersion: 1,
          viewDigest: raceView.viewDigest,
          label: "pass",
          rationale: "The selected answer is correct.",
          failureCodes: [],
          idempotencyKey: "race-submit"
        }
      }),
      repository.transitionBatch(OWNER, race.batchId, "close_labeling", {
        expectedStateVersion: 1,
        idempotencyKey: "race-close"
      })
    ]);
    expect(raced[0].status).toBe("fulfilled");
    if (raced[1].status === "rejected") {
      await repository.transitionBatch(OWNER, race.batchId, "close_labeling", {
        expectedStateVersion: 1,
        idempotencyKey: "race-close-retry"
      });
    }
    expect((await repository.getBatchSummary(OWNER, race.batchId)).state).toBe("labeling_closed");

    const incomplete = await repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "analysis_authoring",
      source: { kind: "dataset_revision", revisionId: sourceRevisionId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [REVIEWER_A.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-incomplete"
    });
    await repository.transitionBatch(OWNER, incomplete.batchId, "open", { expectedStateVersion: 0, idempotencyKey: "open-incomplete" });
    const incompleteTask = (await repository.listReviewerTasks(REVIEWER_A)).find((task) => task.batchId === incomplete.batchId)!;
    await repository.getOrCreateBlindTaskView(REVIEWER_A, incompleteTask.taskId);
    const deferred = await repository.appendTaskAction(REVIEWER_A, incompleteTask.taskId, {
      kind: "defer",
      input: {
        expectedStreamVersion: 1,
        reason: "Insufficient context",
        // This was the exact internal first-view key shape before P3. It must
        // remain a valid caller key without colliding with the viewed event.
        idempotencyKey: `view:${incompleteTask.taskId}`
      }
    });
    expect(deferred.state).toBe("deferred");
    await repository.transitionBatch(OWNER, incomplete.batchId, "close_labeling", { expectedStateVersion: 1, idempotencyKey: "close-incomplete" });
    const incompleteFinal = await repository.transitionBatch(OWNER, incomplete.batchId, "finalize", { expectedStateVersion: 2, idempotencyKey: "finalize-incomplete" });
    expect(incompleteFinal.state).toBe("incomplete");
    const revisionsBefore = Number((await pool.query(`select count(*)::int as count from dataset_revisions`)).rows[0].count);
    await expect(repository.transitionBatch(OWNER, incomplete.batchId, "freeze", {
      expectedStateVersion: 3,
      idempotencyKey: "freeze-incomplete"
    })).rejects.toBeInstanceOf(GovernedReviewTransitionConflictError);
    expect(Number((await pool.query(`select count(*)::int as count from dataset_revisions`)).rows[0].count))
      .toBe(revisionsBefore);

    const systematic = await completeSingleRaterBatch({
      batchKey: "batch-systematic",
      instructionVersionId: instruction.instructionVersionId,
      reviewer: REVIEWER_A,
      selectionMethod: "systematic"
    });
    expect(systematic.representativeness).toMatchObject({
      status: "ineligible",
      populationId: null,
      reasons: expect.arrayContaining(["selection_method_not_representative"])
    });

    const abstention = await repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "analysis_authoring",
      source: { kind: "dataset_revision", revisionId: sourceRevisionId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [REVIEWER_A.userId, REVIEWER_B.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-adjudicated-abstention"
    });
    await repository.transitionBatch(OWNER, abstention.batchId, "open", { expectedStateVersion: 0, idempotencyKey: "open-abstention" });
    for (const [reviewer, label] of [[REVIEWER_A, "cannot_determine"], [REVIEWER_B, "pass"]] as const) {
      const task = (await repository.listReviewerTasks(reviewer)).find((candidate) => candidate.batchId === abstention.batchId)!;
      const view = await repository.getOrCreateBlindTaskView(reviewer, task.taskId);
      await repository.appendTaskAction(reviewer, task.taskId, {
        kind: "submit_label",
        input: {
          expectedStreamVersion: 1,
          viewDigest: view.viewDigest,
          label,
          rationale: label === "cannot_determine" ? "The reviewer abstains on the supplied evidence." : "The answer is supported.",
          failureCodes: label === "cannot_determine" ? ["insufficient_context"] : [],
          idempotencyKey: `label-abstention-${reviewer.userId}`
        }
      });
    }
    await repository.transitionBatch(OWNER, abstention.batchId, "close_labeling", { expectedStateVersion: 1, idempotencyKey: "close-abstention" });
    await repository.transitionBatch(OWNER, abstention.batchId, "start_adjudication", { expectedStateVersion: 2, idempotencyKey: "start-abstention" });
    await repository.appendAdjudication(OWNER, abstention.batchId, abstention.items[0]!.batchItemId, {
      expectedHeadAdjudicationId: null,
      decision: "pass",
      rationale: "The complete immutable response supports a pass decision.",
      basis: "Both independent labels and the immutable payload were considered.",
      idempotencyKey: "adjudicate-abstention"
    });
    await repository.transitionBatch(OWNER, abstention.batchId, "finalize", { expectedStateVersion: 3, idempotencyKey: "finalize-abstention" });
    const abstentionFrozen = await repository.transitionBatch(OWNER, abstention.batchId, "freeze", { expectedStateVersion: 4, idempotencyKey: "freeze-abstention" });
    expect(abstentionFrozen.representativeness).toMatchObject({
      status: "ineligible",
      populationId: null,
      reasons: expect.arrayContaining(["cannot_determine_present"])
    });
  });

  it("enforces sealed separation, protected access, frozen generic redaction, and unknown provenance", async () => {
    const instruction = await repository.createInstruction(OWNER, {
      criterionVersionId: sealedCriterionVersionId,
      title: "Sealed independent review",
      instructions: "Judge only the protected immutable projection.",
      failureCodeGuidance: "Use short open codes.",
      idempotencyKey: "instruction-sealed"
    });
    const intake = await repository.createSealedIntake(CUSTODIAN, {
      populationDefinition: "Complete finite protected validation corpus",
      items: [{ clientItemId: "sealed-one", input: { question: "Protected question" }, output: { answer: "Protected answer" } }],
      idempotencyKey: "intake-sealed"
    });
    const batch = await repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "sealed_validation",
      source: { kind: "sealed_intake", intakeId: intake.intakeId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [REVIEWER_A.userId, REVIEWER_B.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-sealed"
    });
    expect(await repository.listReviewerTasks(REVIEWER_A)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ batchId: batch.batchId })])
    );
    await repository.transitionBatch(OWNER, batch.batchId, "open", { expectedStateVersion: 0, idempotencyKey: "open-sealed" });
    for (const reviewer of [REVIEWER_A, REVIEWER_B]) {
      const task = (await repository.listReviewerTasks(reviewer)).find((candidate) => candidate.batchId === batch.batchId)!;
      const view = await repository.getOrCreateBlindTaskView(reviewer, task.taskId);
      await repository.appendTaskAction(reviewer, task.taskId, {
        kind: "submit_label",
        input: {
          expectedStreamVersion: 1,
          viewDigest: view.viewDigest,
          label: "pass",
          rationale: "The protected response satisfies the criterion.",
          failureCodes: [],
          idempotencyKey: `label-sealed-${reviewer.userId}`
        }
      });
    }
    expect((await repository.getBatchSummary(REVIEWER_A, batch.batchId)).completeness).toBeNull();
    await repository.transitionBatch(OWNER, batch.batchId, "close_labeling", { expectedStateVersion: 1, idempotencyKey: "close-sealed" });
    await expect(repository.getPostBarrierItemView(MEMBER, batch.batchId, batch.items[0]!.batchItemId, "alignment"))
      .rejects.toMatchObject({ code: "governed_review_forbidden" });
    const peerEvidence = await repository.getPostBarrierItemView(
      REVIEWER_A, batch.batchId, batch.items[0]!.batchItemId, "alignment"
    );
    expect(peerEvidence.activeLabels).toHaveLength(2);
    await repository.transitionBatch(OWNER, batch.batchId, "finalize", { expectedStateVersion: 2, idempotencyKey: "finalize-sealed" });
    const frozen = await repository.transitionBatch(OWNER, batch.batchId, "freeze", { expectedStateVersion: 3, idempotencyKey: "freeze-sealed" });
    expect(frozen).toMatchObject({
      state: "frozen",
      evidenceClass: "governed_blind",
      items: [{ resolutionKind: null, resolvedLabel: null }]
    });

    const ineligibleIntake = await repository.createSealedIntake(CUSTODIAN, {
      populationDefinition: "Protected ineligible-participant corpus",
      items: [{ clientItemId: "sealed-ineligible", input: { q: "Unique ineligible input" }, output: { a: "Answer" } }],
      idempotencyKey: "intake-sealed-ineligible"
    });
    const ineligibleBatch = await repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "sealed_validation",
      source: { kind: "sealed_intake", intakeId: ineligibleIntake.intakeId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [DEVELOPER.userId, REVIEWER_A.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-sealed-ineligible"
    });
    await expect(repository.transitionBatch(OWNER, ineligibleBatch.batchId, "open", {
      expectedStateVersion: 0,
      idempotencyKey: "open-sealed-ineligible"
    })).rejects.toBeInstanceOf(GovernedReviewSeparationIneligibleError);

    const sealedCriterionId = String((await pool.query(
      `select criterion_id from criterion_versions where id=$1`,
      [sealedCriterionVersionId]
    )).rows[0].criterion_id);
    const sealedCriterionV2 = await platform.createCriterionVersion(
      PROJECT_ID,
      sealedCriterionId,
      { name: "Sealed criterion v2", definition: "A revised immutable definition in the same lineage." },
      { actorUserId: OWNER.userId }
    );
    expect(sealedCriterionV2).not.toBeNull();
    const lineageInstruction = await repository.createInstruction(OWNER, {
      criterionVersionId: sealedCriterionV2!.id,
      title: "Same-lineage developer exclusion",
      instructions: "Review the protected response against definition v2.",
      failureCodeGuidance: "Use short open codes.",
      idempotencyKey: "instruction-sealed-lineage-v2"
    });
    const lineageIntake = await repository.createSealedIntake(CUSTODIAN, {
      populationDefinition: "Protected v2 corpus",
      items: [{ clientItemId: "sealed-lineage-v2", input: { q: "Unique v2 input" }, output: { a: "Answer" } }],
      idempotencyKey: "intake-sealed-lineage-v2"
    });
    const lineageBatch = await repository.createBatchDraft(OWNER, {
      instructionVersionId: lineageInstruction.instructionVersionId,
      roleIntent: "sealed_validation",
      source: { kind: "sealed_intake", intakeId: lineageIntake.intakeId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [DEVELOPER.userId, REVIEWER_A.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-sealed-lineage-v2"
    });
    await expect(repository.transitionBatch(OWNER, lineageBatch.batchId, "open", {
      expectedStateVersion: 0,
      idempotencyKey: "open-sealed-lineage-v2"
    })).rejects.toBeInstanceOf(GovernedReviewSeparationIneligibleError);

    // Reverse ordinary writes and sealed intake share the same project/digest
    // advisory locks. An uncommitted ordinary identity must win or lose
    // atomically; both sides may never commit the same exact input.
    const racingInput = { q: "Concurrent ordinary-versus-sealed identity" };
    const racingDigest = datasetInputIdentity({ input: racingInput }).digest;
    const ordinary = await pool.connect();
    await ordinary.query("begin");
    await ordinary.query(
      `insert into case_input_identity_records
         (id,project_id,source_case_id,record_kind,identity_basis,input_digest)
       values ('identity_race_ordinary',$1,'race-source','authoring_import','input-identity/v1',$2)`,
      [PROJECT_ID, racingDigest]
    );
    const sealedAttempt = repository.createSealedIntake(CUSTODIAN, {
      populationDefinition: "Concurrent protected intake",
      items: [{ clientItemId: "sealed-race", input: racingInput, output: { a: "Answer" } }],
      idempotencyKey: "intake-sealed-race"
    });
    const beforeCommit = await Promise.race([
      sealedAttempt.then(() => "settled", () => "settled"),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50))
    ]);
    expect(beforeCommit).toBe("waiting");
    await ordinary.query("commit");
    ordinary.release();
    await expect(sealedAttempt).rejects.toBeTruthy();
    expect((await pool.query(
      `select count(*)::int as count from governed_review_items
       where project_id=$1 and source_kind='sealed_intake' and input_digest=$2`,
      [PROJECT_ID, racingDigest]
    )).rows[0].count).toBe(0);

    const unknownInstruction = await repository.createInstruction(OWNER, {
      criterionVersionId: unknownCriterionVersionId,
      title: "Unknown evaluator provenance review",
      instructions: "This must fail closed before content exposure.",
      failureCodeGuidance: "No codes should be produced.",
      idempotencyKey: "instruction-unknown"
    });
    const unknownIntake = await repository.createSealedIntake(CUSTODIAN, {
      populationDefinition: "Protected unknown-provenance corpus",
      items: [{ clientItemId: "sealed-unknown", input: { q: "Unknown provenance input" }, output: { a: "Answer" } }],
      idempotencyKey: "intake-sealed-unknown"
    });
    const unknownBatch = await repository.createBatchDraft(OWNER, {
      instructionVersionId: unknownInstruction.instructionVersionId,
      roleIntent: "sealed_validation",
      source: { kind: "sealed_intake", intakeId: unknownIntake.intakeId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [REVIEWER_A.userId, REVIEWER_B.userId],
      fixedStopAt: STOP_AT,
      idempotencyKey: "batch-sealed-unknown"
    });
    await expect(repository.transitionBatch(OWNER, unknownBatch.batchId, "open", {
      expectedStateVersion: 0,
      idempotencyKey: "open-sealed-unknown"
    })).rejects.toBeInstanceOf(GovernedReviewSeparationUnknownError);
  });

  it("uses one persisted DB clock at the fixed-stop close boundary", async () => {
    const instruction = (await repository.listInstructions(OWNER, nonsealedCriterionVersionId))[0]!;
    const stopAt = String((await pool.query(
      `select to_jsonb(clock_timestamp() + interval '1 second') as stop_at`
    )).rows[0].stop_at);
    const batch = await repository.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "analysis_authoring",
      source: { kind: "dataset_revision", revisionId: sourceRevisionId },
      selection: { method: "simple_random", fixedBudget: 1 },
      reviewerUserIds: [MEMBER.userId],
      fixedStopAt: stopAt,
      idempotencyKey: "batch-fixed-stop-boundary"
    });
    await repository.transitionBatch(OWNER, batch.batchId, "open", {
      expectedStateVersion: 0,
      idempotencyKey: "open-fixed-stop-boundary"
    });
    const task = (await repository.listReviewerTasks(MEMBER))
      .find((candidate) => candidate.batchId === batch.batchId)!;

    // Begin the close transaction before stop_at, but block its batch lock
    // until after stop_at. PostgreSQL now() would retain the wrong pre-stop
    // transaction timestamp; the explicit event clock must expire the task.
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query(`lock table governed_review_batches in access exclusive mode`);
    const closePromise = repository.transitionBatch(OWNER, batch.batchId, "close_labeling", {
      expectedStateVersion: 1,
      idempotencyKey: "close-fixed-stop-boundary"
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    while (!(await pool.query(
      `select clock_timestamp() >= $1::timestamptz as reached`, [stopAt]
    )).rows[0].reached) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await blocker.query("commit");
    blocker.release();
    const closed = await closePromise;
    expect(closed.state).toBe("labeling_closed");
    expect(closed.completeness).toMatchObject({ expiredTasks: 1, pendingTasks: 0 });

    const evidence = (await pool.query(
      `select event.occurred_at,event.details,batch.stop_at,
              governed_review_current_task_state($2) as task_state
       from governed_review_batch_events event
       join governed_review_batches batch on batch.id=event.batch_id
       where event.batch_id=$1 and event.event_kind='labeling_closed'`,
      [batch.batchId, task.taskId]
    )).rows[0];
    expect(new Date(evidence.occurred_at).getTime()).toBeGreaterThanOrEqual(
      new Date(evidence.stop_at).getTime()
    );
    expect(evidence.details).toMatchObject({
      closedAtFixedStop: true,
      expiredTaskIds: [task.taskId]
    });
    expect(evidence.task_state).toBe("expired");
  });

  it("stores exact imported artifacts while refusing caller-minted verified trust", async () => {
    const sourceArtifact = { envelope: { b: 2, a: 1 }, signature: "caller-claim" };
    const complete = {
      criterionVersionId: nonsealedCriterionVersionId,
      issuer: "External review lab",
      subject: "external-record-42",
      sourceArtifact,
      transportProvenance: { transport: "manual upload" },
      verificationMethod: "self_attested" as const,
      verificationEvidence: null,
      instructionsProvenance: { digest: `sha256:${"1".repeat(64)}` },
      raterProvenance: { raters: ["external-rater"] },
      adjudicationProvenance: { method: "single-rater" },
      blindAttestation: { statement: "self-attested blind" },
      payloadSnapshot: { input: { question: "Imported?" }, output: { answer: "Yes" } },
      label: "pass" as const,
      rationale: "The external record reports a passing result.",
      failureCodes: [] as string[],
      idempotencyKey: "imported-self"
    };
    const imported = await repository.createImportedTruth(OWNER, complete);
    expect(imported.evidenceClass).toBe("imported_self_attested");
    expect(await repository.createImportedTruth(OWNER, complete)).toEqual(imported);
    await expect(repository.createImportedTruth(OWNER, { ...complete, subject: "conflict" }))
      .rejects.toBeInstanceOf(GovernedReviewIdempotencyConflictError);

    const stored = (await pool.query(
      `select source_artifact_bytes,source_artifact_digest from governed_imported_truth where id=$1`,
      [imported.importedTruthId]
    )).rows[0];
    expect(Buffer.from(stored.source_artifact_bytes).toString("utf8")).toBe(canonicalJson(sourceArtifact));
    expect(String(stored.source_artifact_digest)).toBe(imported.sourceArtifactDigest);
    await expect(pool.query(
      `update governed_imported_truth set rationale='tampered' where id=$1`, [imported.importedTruthId]
    )).rejects.toMatchObject({ code: "55000" });

    const unverified = await repository.createImportedTruth(OWNER, {
      ...complete,
      transportProvenance: null,
      verificationMethod: "none",
      instructionsProvenance: null,
      raterProvenance: null,
      adjudicationProvenance: null,
      blindAttestation: null,
      idempotencyKey: "imported-unverified"
    });
    expect(unverified.evidenceClass).toBe("unverified");
    await expect(repository.createImportedTruth(OWNER, {
      ...complete,
      verificationMethod: "verified_signature",
      verificationEvidence: { signature: "proof-shaped-but-unverified" },
      idempotencyKey: "imported-forged-verified"
    })).rejects.toBeInstanceOf(GovernedImportedTruthVerificationUnavailableError);
    expect(await repository.listImportedTruth(OTHER_OWNER, {})).toEqual([]);
  });

  it("mounts the real repository behind createApp session auth while API keys and demo mode fail closed", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ||
      "governed-review-integration-secret-at-least-32-bytes";
    const auth = createAuth(pool);
    const signedUp = await auth.api.signUpEmail({
      body: {
        email: "governed-route-member@example.test",
        password: "governed-route-password",
        name: "Governed Route Member"
      }
    }) as { user?: { id: string } };
    expect(signedUp.user?.id).toBeTruthy();
    await pool.query(
      `insert into project_members (id,project_id,user_id,role) values ($1,$2,$3,'member')`,
      ["pm_governed_route_member", PROJECT_ID, signedUp.user!.id]
    );
    const app = createApp(platform, { pool, auth });
    const signIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "governed-route-member@example.test",
        password: "governed-route-password"
      })
    });
    expect(signIn.status).toBe(200);
    const sessionCookie = String(signIn.headers.get("set-cookie"))
      .split(/,(?=\s*[^;,]+=)/)
      .map((cookie) => cookie.split(";")[0]?.trim())
      .filter(Boolean)
      .join("; ");
    const sessionRead = await app.request(
      `/api/governed-review/instructions?criterionVersionId=${nonsealedCriterionVersionId}`,
      { headers: { cookie: sessionCookie, "x-coeval-project": PROJECT_ID } }
    );
    expect(sessionRead.status).toBe(200);
    const sessionBody = await sessionRead.json() as { instructions: unknown[] };
    expect(sessionBody.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterionVersionId: nonsealedCriterionVersionId })
    ]));
    expect(sessionRead.headers.get("cache-control")).toBe("private, no-store");
    expect(sessionRead.headers.get("vary")).toContain("Cookie");

    const key = await platform.createApiKey({
      projectId: PROJECT_ID,
      name: "Governed route must reject this key",
      createdByUserId: signedUp.user!.id
    });
    const keyRead = await app.request("/api/governed-review/instructions", {
      headers: { authorization: `Bearer ${key.key}`, "x-coeval-project": PROJECT_ID }
    });
    expect(keyRead.status).toBe(401);

    const demoRead = await createApp().request("/api/governed-review/instructions");
    expect(demoRead.status).toBe(501);
    await expect(demoRead.json()).resolves.toMatchObject({ code: "governed_review_requires_auth" });
  });
});

async function completeSingleRaterBatch(input: {
  batchKey: string;
  instructionVersionId: string;
  reviewer: GovernedReviewActor;
  selectionMethod: "simple_random" | "systematic";
}) {
  const batch = await repository.createBatchDraft(OWNER, {
    instructionVersionId: input.instructionVersionId,
    roleIntent: "analysis_authoring",
    source: { kind: "dataset_revision", revisionId: sourceRevisionId },
    selection: { method: input.selectionMethod, fixedBudget: 1 },
    reviewerUserIds: [input.reviewer.userId],
    fixedStopAt: STOP_AT,
    idempotencyKey: input.batchKey
  });
  await repository.transitionBatch(OWNER, batch.batchId, "open", {
    expectedStateVersion: 0,
    idempotencyKey: `open-${input.batchKey}`
  });
  const task = (await repository.listReviewerTasks(input.reviewer))
    .find((candidate) => candidate.batchId === batch.batchId)!;
  const view = await repository.getOrCreateBlindTaskView(input.reviewer, task.taskId);
  await repository.appendTaskAction(input.reviewer, task.taskId, {
    kind: "submit_label",
    input: {
      expectedStreamVersion: 1,
      viewDigest: view.viewDigest,
      label: "pass",
      rationale: "The answer is supported by the immutable payload.",
      failureCodes: [],
      idempotencyKey: `label-${input.batchKey}`
    }
  });
  await repository.transitionBatch(OWNER, batch.batchId, "close_labeling", {
    expectedStateVersion: 1,
    idempotencyKey: `close-${input.batchKey}`
  });
  await repository.transitionBatch(OWNER, batch.batchId, "finalize", {
    expectedStateVersion: 2,
    idempotencyKey: `finalize-${input.batchKey}`
  });
  return repository.transitionBatch(OWNER, batch.batchId, "freeze", {
    expectedStateVersion: 3,
    idempotencyKey: `freeze-${input.batchKey}`
  });
}
