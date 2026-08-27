import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import { CreateSkillVersionInputSchema } from "@coeval/shared";
import {
  parseCanonicalBinaryCalibrationArtifactBytes,
  verifyBinaryCalibrationPrivateLedgerForArtifact
} from "../src/lib/binary-calibration.js";
import {
  type BinaryCalibrationActor
} from "../src/binary-calibration/repository.js";
import { PgBinaryCalibrationRepository } from "../src/binary-calibration/repository.pg.js";
import { PgGovernedReviewRepository, type GovernedReviewActor } from "../src/governed-review/index.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; calibration persistence tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;
const PROJECT_ID = "proj_binary_calibration";
const OWNER: GovernedReviewActor & BinaryCalibrationActor = {
  projectId: PROJECT_ID,
  userId: "cal_owner",
  projectRole: "owner"
};
const CUSTODIAN: GovernedReviewActor = {
  projectId: PROJECT_ID,
  userId: "cal_custodian",
  projectRole: "member"
};
const REVIEWER_A: GovernedReviewActor = {
  projectId: PROJECT_ID,
  userId: "cal_reviewer_a",
  projectRole: "member"
};
const REVIEWER_B: GovernedReviewActor = {
  projectId: PROJECT_ID,
  userId: "cal_reviewer_b",
  projectRole: "member"
};
const DEVELOPER: GovernedReviewActor = {
  projectId: PROJECT_ID,
  userId: "cal_developer",
  projectRole: "member"
};

run("PgBinaryCalibrationRepository", () => {
  let pool: Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repository: PgBinaryCalibrationRepository;
  let governed: PgGovernedReviewRepository;
  let platform: PgRepository;
  let revisionId: string;
  let skillVersionId: string;

  beforeAll(async () => {
    ({ pool, cleanup } = await openPostgresTestDatabase("binary_calibration"));
    await runMigrations(pool);
    repository = new PgBinaryCalibrationRepository(pool);
    governed = new PgGovernedReviewRepository(pool);
    platform = new PgRepository(pool);

    await pool.query(`insert into organizations (id,name) values ('org_binary_calibration','Calibration Org')`);
    for (const userId of [OWNER.userId, CUSTODIAN.userId, REVIEWER_A.userId, REVIEWER_B.userId, DEVELOPER.userId]) {
      await pool.query(`insert into "user" (id,name,email) values ($1,$1,$2)`, [userId, `${userId}@example.test`]);
    }
    await pool.query(
      `insert into projects (id,organization_id,name,trace_provider)
       values ($1,'org_binary_calibration','Calibration Project','manual')`,
      [PROJECT_ID]
    );
    for (const [index, actor] of [OWNER, CUSTODIAN, REVIEWER_A, REVIEWER_B, DEVELOPER].entries()) {
      await pool.query(
        `insert into project_members (id,project_id,user_id,role) values ($1,$2,$3,$4)`,
        [`cal_pm_${index}`, PROJECT_ID, actor.userId, actor.projectRole]
      );
    }
    await pool.query(
      `insert into criteria (id,project_id,stable_key,source_kind,created_by_user_id)
       values ('criterion_cal_skill',$1,'binary-truth','native',$2)`,
      [PROJECT_ID, DEVELOPER.userId]
    );
    await pool.query(
      `insert into criterion_versions
         (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind,created_by_user_id)
       values ('criterionv_cal_skill',$1,'criterion_cal_skill',1,'Binary truth',
               'Binary sealed evaluator',
               criterion_v1_digest('criterion_cal_skill','criterionv_cal_skill','Binary truth','Binary sealed evaluator'),
               'native',$2)`,
      [PROJECT_ID, DEVELOPER.userId]
    );
    await pool.query(
      `insert into skills (id,project_id,name,description,owner_user_id,status,criterion_id)
       values ('cal_skill',$1,'Binary truth','Binary sealed evaluator',$2,'draft','criterion_cal_skill')`,
      [PROJECT_ID, DEVELOPER.userId]
    );
    const version = await platform.createSkillVersionPending(
      "cal_skill",
      CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "# Binary rubric",
        prompt: "Judge the exact protected item.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock-v1", temperature: 0 },
        verdictKind: "binary",
        criterionVersionId: "criterionv_cal_skill"
      }),
      { projectId: PROJECT_ID, actorUserId: DEVELOPER.userId }
    );
    skillVersionId = version.id;

    const instruction = await governed.createInstruction(OWNER, {
      criterionVersionId: version.criterionVersionId,
      title: "Independent sealed binary review",
      instructions: "Use only the protected immutable projection.",
      failureCodeGuidance: "Use bounded failure codes.",
      idempotencyKey: "cal-instruction"
    });
    const intake = await governed.createSealedIntake(CUSTODIAN, {
      populationDefinition: "Complete two-item sealed validation population",
      items: [
        { clientItemId: "cal-a", input: { question: "A?" }, output: { answer: "A" } },
        { clientItemId: "cal-b", input: { question: "B?" }, output: { answer: "B" } }
      ],
      idempotencyKey: "cal-intake"
    });
    const batch = await governed.createBatchDraft(OWNER, {
      instructionVersionId: instruction.instructionVersionId,
      roleIntent: "sealed_validation",
      source: { kind: "sealed_intake", intakeId: intake.intakeId },
      selection: { method: "simple_random", fixedBudget: 2 },
      reviewerUserIds: [REVIEWER_A.userId, REVIEWER_B.userId],
      fixedStopAt: "2099-01-01T00:00:00.000Z",
      idempotencyKey: "cal-batch"
    });
    await governed.transitionBatch(OWNER, batch.batchId, "open", {
      expectedStateVersion: 0,
      idempotencyKey: "cal-open"
    });
    for (const reviewer of [REVIEWER_A, REVIEWER_B]) {
      const tasks = (await governed.listReviewerTasks(reviewer)).filter((task) => task.batchId === batch.batchId);
      expect(tasks).toHaveLength(2);
      for (const task of tasks) {
        const view = await governed.getOrCreateBlindTaskView(reviewer, task.taskId);
        await governed.appendTaskAction(reviewer, task.taskId, {
          kind: "submit_label",
          input: {
            expectedStreamVersion: 1,
            viewDigest: view.viewDigest,
            label: "pass",
            rationale: "The immutable response satisfies the frozen criterion.",
            failureCodes: [],
            idempotencyKey: `cal-label-${reviewer.userId}-${task.taskId}`
          }
        });
      }
    }
    await governed.transitionBatch(OWNER, batch.batchId, "close_labeling", {
      expectedStateVersion: 1,
      idempotencyKey: "cal-close"
    });
    await governed.transitionBatch(OWNER, batch.batchId, "finalize", {
      expectedStateVersion: 2,
      idempotencyKey: "cal-finalize"
    });
    await governed.transitionBatch(OWNER, batch.batchId, "freeze", {
      expectedStateVersion: 3,
      idempotencyKey: "cal-freeze"
    });
    revisionId = String((await pool.query(
      `select dataset_revision_id from governed_review_batch_events
       where batch_id=$1 and event_kind='frozen'`,
      [batch.batchId]
    )).rows[0].dataset_revision_id);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("pins idempotent identity and permits only one active run per revision/evaluator", async () => {
    const input = {
      datasetRevisionId: revisionId,
      skillVersionId,
      positiveClass: "pass" as const,
      trialPlan: { kind: "single" as const, trialsPerItem: 1 as const },
      suiteBinding: null,
      idempotencyKey: "cal-run-root"
    };
    const created = await repository.createRun(OWNER, input);
    expect(created).toMatchObject({ state: "queued", plannedObservations: 2, accountedObservations: 0 });
    expect(await repository.createRun(OWNER, input)).toEqual(created);
    await expect(repository.createRun(OWNER, { ...input, positiveClass: "fail" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repository.createRun(OWNER, { ...input, idempotencyKey: "cal-run-overlap" }))
      .rejects.toMatchObject({ code: "state_conflict" });
    await expect(repository.createRun({ ...OWNER, projectRole: "member" }, {
      ...input,
      idempotencyKey: "cal-run-member"
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("serializes exposure, permanently recovers unknown outcomes, and atomically mints aggregate bytes", async () => {
    const runProjection = (await repository.listRuns({ projectId: PROJECT_ID }))
      .find((candidate) => candidate.state === "queued")!;
    let claim = await repository.claimRun(runProjection.runId, "cal-worker-a", 60_000);
    expect(claim).not.toBeNull();
    const authorized = await repository.authorizeRun(claim!);
    expect(authorized).toMatchObject({ itemCount: 2, requestedModelBinding: { provider: "mock" } });
    expect("getPrivateLedger" in repository).toBe(false);

    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query(`select id from dataset_revisions where id=$1 for update`, [revisionId]);
    const racedExposure = pool.query(
      `insert into dataset_exposure_events
         (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
          reason,details,idempotency_key)
       values ('cal_raced_exposure',$1,$2,'development_use','development','development_run',
               'activity','race','must block','{}','cal-raced-exposure')`,
      [PROJECT_ID, revisionId]
    );
    expect(await Promise.race([
      racedExposure.then(() => "settled", () => "settled"),
      new Promise<"waiting">((resolveWait) => setTimeout(() => resolveWait("waiting"), 50))
    ])).toBe("waiting");
    await blocker.query("commit");
    blocker.release();
    await expect(racedExposure).rejects.toMatchObject({ code: "55000" });

    const first = await repository.getNextAttempt(claim!);
    expect(first).not.toBeNull();
    await repository.recordProviderCallStarted(claim!, first!.attemptId);
    await repository.completeAttempt(claim!, first!.attemptId, {
      terminalEvaluatorOutcome: "evaluator_pass",
      attemptState: "terminal",
      errorCode: null,
      providerObservation: {
        provider: "mock",
        observedModel: "mock-v1",
        observedVersion: null,
        systemFingerprint: null
      }
    });
    const second = await repository.getNextAttempt(claim!);
    await repository.recordProviderCallStarted(claim!, second!.attemptId);
    await pool.query(
      `update binary_calibration_runs set claim_expires_at=clock_timestamp()-interval '1 second'
       where id=$1`,
      [runProjection.runId]
    );
    claim = await repository.claimRun(runProjection.runId, "cal-worker-b", 60_000);
    expect(claim).not.toBeNull();
    expect(await repository.recoverStartedAttempts(claim!)).toBe(1);
    await expect(repository.completeAttempt(authorized.claim, second!.attemptId, {
      terminalEvaluatorOutcome: "evaluator_pass",
      attemptState: "terminal",
      errorCode: null,
      providerObservation: { provider: "mock", observedModel: "late", observedVersion: null, systemFingerprint: null }
    })).rejects.toMatchObject({ code: "state_conflict" });

    const minted = await repository.finalizeRun(claim!);
    expect(minted.run).toMatchObject({ state: "incomplete", accountedObservations: 2 });
    expect(minted.artifact).toMatchObject({
      status: "incomplete",
      incompleteReasons: ["trial_incomplete"],
      trials: [{ outcomes: { planned: 2, classified: 1, errored: 1, providerCalls: 2 } }]
    });
    const copy = await repository.getArtifact({ projectId: PROJECT_ID }, minted.artifact.artifactId);
    expect(parseCanonicalBinaryCalibrationArtifactBytes(copy.canonicalBytes)).toEqual(minted.artifact);
    const privateBytes = (await pool.query(
      `select canonical_bytes from binary_calibration_private_ledgers where run_id=$1`,
      [runProjection.runId]
    )).rows[0].canonical_bytes as Buffer;
    const ledger = JSON.parse(privateBytes.toString("utf8"));
    expect(verifyBinaryCalibrationPrivateLedgerForArtifact(ledger, minted.artifact).ledger.records)
      .toEqual(expect.arrayContaining([expect.objectContaining({ errorCode: "outcome_unknown" })]));
    expect(await repository.getArtifactStatus({ projectId: PROJECT_ID }, minted.artifact.artifactId))
      .toMatchObject({ currentAdmissibility: "admissible", reasons: [] });
    await expect(pool.query(
      `update binary_calibration_artifacts set evidence_digest=$2 where id=$1`,
      [minted.artifact.artifactId, `sha256:${"0".repeat(64)}`]
    )).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(
      `delete from binary_calibration_private_ledgers where run_id=$1`, [runProjection.runId]
    )).rejects.toMatchObject({ code: "55000" });
  }, 20_000);

  it("allows a same-version rerun, rejects a post-test version, and reports later revocation", async () => {
    const sameVersion = await repository.createRun(OWNER, {
      datasetRevisionId: revisionId,
      skillVersionId,
      positiveClass: "pass",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      suiteBinding: null,
      idempotencyKey: "cal-run-same-version"
    });
    const sameClaim = await repository.claimRun(sameVersion.runId, "cal-worker-rerun", 60_000);
    await repository.authorizeRun(sameClaim!);
    for (;;) {
      const attempt = await repository.getNextAttempt(sameClaim!);
      if (!attempt) break;
      await repository.completeAttempt(sameClaim!, attempt.attemptId, {
        terminalEvaluatorOutcome: "unevaluated",
        attemptState: "not_started",
        errorCode: null,
        providerObservation: { provider: "mock", observedModel: null, observedVersion: null, systemFingerprint: null }
      });
    }
    const rerunArtifact = await repository.finalizeRun(sameClaim!);
    expect(rerunArtifact.artifact.status).toBe("incomplete");

    const later = await platform.createSkillVersionPending(
      "cal_skill",
      CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "# Post-test binary rubric",
        prompt: "A version developed after sealed results existed.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock-v2", temperature: 0 },
        verdictKind: "binary",
        criterionVersionId: "criterionv_cal_skill"
      }),
      { projectId: PROJECT_ID, actorUserId: DEVELOPER.userId }
    );
    const laterRun = await repository.createRun(OWNER, {
      datasetRevisionId: revisionId,
      skillVersionId: later.id,
      positiveClass: "pass",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      suiteBinding: null,
      idempotencyKey: "cal-run-post-test-version"
    });
    const laterClaim = await repository.claimRun(laterRun.runId, "cal-worker-later", 60_000);
    await expect(repository.authorizeRun(laterClaim!)).rejects.toMatchObject({ code: "ineligible" });
    expect((await repository.getRun({ projectId: PROJECT_ID }, laterRun.runId)).state).toBe("rejected");

    const completionRecordedAt = new Date((await pool.query(
      `select exposure.recorded_at
       from binary_calibration_runs run
       join binary_calibration_exposure_checks exposure on exposure.id=run.completion_check_id
       where run.id=$1`,
      [sameVersion.runId]
    )).rows[0].recorded_at);
    const callerBackdatedAt = new Date(completionRecordedAt.getTime() - 1).toISOString();
    await pool.query(
      `insert into dataset_exposure_events
         (id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,
          reason,details,idempotency_key,occurred_at)
       values ('cal_later_exposure',$1,$2,'development_use','provenance','development_run',
               'activity','later-development','later use','{}','cal-later-exposure',$3::timestamptz)`,
      [PROJECT_ID, revisionId, callerBackdatedAt]
    );
    const storedExposureAt = new Date((await pool.query(
      `select occurred_at from dataset_exposure_events where id='cal_later_exposure'`
    )).rows[0].occurred_at);
    expect(storedExposureAt.getTime()).toBeGreaterThanOrEqual(completionRecordedAt.getTime());
    expect(await repository.getArtifactStatus(
      { projectId: PROJECT_ID },
      rerunArtifact.artifact.artifactId
    )).toMatchObject({ currentAdmissibility: "revoked", reasons: ["development_exposure"] });
  }, 20_000);

  it("keeps protected identities project-scoped and permits only project-erasure cascades", async () => {
    await pool.query(`insert into "user" (id,name,email) values ('cal_other','cal_other','cal_other@example.test')`);
    await pool.query(
      `insert into projects (id,organization_id,name,trace_provider)
       values ('proj_binary_other','org_binary_calibration','Other Project','manual')`
    );
    await pool.query(
      `insert into project_members (id,project_id,user_id,role)
       values ('cal_pm_other','proj_binary_other','cal_other','owner')`
    );
    await expect(repository.createRun({
      projectId: "proj_binary_other",
      userId: "cal_other",
      projectRole: "owner"
    }, {
      datasetRevisionId: revisionId,
      skillVersionId,
      positiveClass: "pass",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      suiteBinding: null,
      idempotencyKey: "cross-project-calibration"
    })).rejects.toMatchObject({ code: "ineligible" });

    const accountedAttempt = String((await pool.query(
      `select id from binary_calibration_attempts where project_id=$1 and accounting_state='accounted' limit 1`,
      [PROJECT_ID]
    )).rows[0].id);
    await expect(pool.query(
      `update binary_calibration_attempts set physical_provider_calls=0 where id=$1`,
      [accountedAttempt]
    )).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(
      `delete from binary_calibration_attempts where id=$1`, [accountedAttempt]
    )).rejects.toMatchObject({ code: "55000" });
    const terminalRunId = String((await pool.query(
      `select id from binary_calibration_runs where project_id=$1 and state in ('complete','incomplete') limit 1`,
      [PROJECT_ID]
    )).rows[0].id);
    await expect(pool.query(
      `delete from binary_calibration_runs where id=$1`, [terminalRunId]
    )).rejects.toMatchObject({ code: "55000" });

    await pool.query(`delete from projects where id=$1`, [PROJECT_ID]);
    for (const table of [
      "binary_calibration_runs",
      "binary_calibration_attempts",
      "binary_calibration_exposure_checks",
      "binary_calibration_private_ledgers",
      "binary_calibration_artifacts"
    ]) {
      expect(Number((await pool.query(`select count(*)::int as count from ${table}`)).rows[0].count)).toBe(0);
    }
  });
});
