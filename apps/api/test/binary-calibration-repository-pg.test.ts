import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { CreateSkillVersionInputSchema, TypedQuestionOutputSchema, type ExecutionBinding } from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "../src/lib/canonical-json.js";
import {
  parseCanonicalBinaryCalibrationV2ArtifactBytes,
  verifyBinaryCalibrationV2PrivateLedgerForArtifact
} from "../src/lib/binary-calibration-v2.js";
import { evaluatorIdentityFor, skillDigestV2 } from "../src/lib/evaluator-identity.js";
import {
  type BinaryCalibrationActor
} from "../src/binary-calibration/repository.js";
import { PgBinaryCalibrationRepository } from "../src/binary-calibration/repository.pg.js";
import { PgGovernedReviewRepository, type GovernedReviewActor } from "../src/governed-review/index.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { MOCK_BINDING, SEEDED_BINDING, bindingInput, resolvedRecordFor, temperatureRejectingRecordFor } from "./fixtures/execution-binding.js";
import { loadResolutionRecord, saveResolutionRecord } from "../src/evaluator-lifecycle/resolution.pg.js";

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
        executionBinding: bindingInput(MOCK_BINDING),
        verdictKind: "binary",
        criterionVersionId: "criterionv_cal_skill"
      }),
      { projectId: PROJECT_ID, actorUserId: DEVELOPER.userId }
    );
    skillVersionId = version.id;
    // Sealed calibration calls a provider; the mock makes no call. The version
    // is saved on the mock (its regression gate needs no key) and then bound
    // to the seeded Anthropic binding, which the executor stub below never calls.
    await pool.query(`update skill_versions set execution_binding=$2::jsonb where id=$1`, [skillVersionId, JSON.stringify(SEEDED_BINDING)]);
    await saveResolutionRecord(pool, PROJECT_ID, skillVersionId, SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING));

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
    // Sealed calibration refuses a mutable model alias; the stored binding is
    // swapped here because every current writer already refuses one.
    const storedBinding = (await pool.query(`select execution_binding from skill_versions where id=$1`, [skillVersionId])).rows[0]!.execution_binding;
    try {
      for (const alias of ["latest", "openrouter/auto", "chatgpt-4o-latest"]) {
        await pool.query(`update skill_versions set execution_binding = jsonb_set(execution_binding, '{modelId}', to_jsonb($2::text)) where id=$1`, [skillVersionId, alias]);
        await expect(repository.createRun(OWNER, input)).rejects.toMatchObject({
          code: "ineligible",
          message: expect.stringContaining("mutable alias")
        });
      }
      // The mock makes no call, so it can't produce sealed evidence.
      await pool.query(`update skill_versions set execution_binding = $2::jsonb where id=$1`, [skillVersionId, JSON.stringify(MOCK_BINDING)]);
      await expect(repository.createRun(OWNER, input)).rejects.toMatchObject({ code: "unsupported" });
      // A typed-question evaluator calibrates like any other once its binding
      // resolves (ADR-0014 section 5).
      const typedQuestion = { ...MOCK_BINDING, provider: "typesafe", modelId: "jev-1.13.0", modelVersion: "jev-1.13.0", verdictProtocol: "typed-question/v1" } as ExecutionBinding;
      const prompted = (await pool.query(`select rubric_markdown,prompt,output_schema from skill_versions where id=$1`, [skillVersionId])).rows[0]!;
      await pool.query(
        `update skill_versions set execution_binding = $2::jsonb, rubric_markdown = null, prompt = null,
                typed_question = $3::jsonb, decision_threshold = 0.5, output_schema = $4::jsonb where id=$1`,
        [
          skillVersionId, JSON.stringify(typedQuestion),
          JSON.stringify({ type: "noul", instructions: "Is it correct?", criteria: { true: "Yes.", false: "No." } }),
          JSON.stringify(TypedQuestionOutputSchema)
        ]
      );
      await expect(repository.createRun(OWNER, input)).rejects.toMatchObject({ code: "ineligible", message: expect.stringContaining("unresolved") });
      await saveResolutionRecord(pool, PROJECT_ID, skillVersionId, typedQuestion, await resolvedRecordFor(typedQuestion));
      const typedRun = await repository.createRun(OWNER, { ...input, idempotencyKey: "cal-run-typed" });
      expect(typedRun).toMatchObject({ state: "queued" });
      await pool.query(`update binary_calibration_runs set state='rejected',rejection_reason='test_cleanup',completed_at=clock_timestamp() where id=$1`, [typedRun.runId]);
      await pool.query(`delete from evaluator_resolution_records where skill_version_id=$1`, [skillVersionId]);
      await pool.query(
        `update skill_versions set execution_binding = $2::jsonb, rubric_markdown = $3, prompt = $4,
                typed_question = null, decision_threshold = null, output_schema = $5::jsonb where id=$1`,
        [skillVersionId, JSON.stringify(MOCK_BINDING), prompted.rubric_markdown, prompted.prompt, JSON.stringify(prompted.output_schema)]
      );
      // Governed gate (ADR-0014 section 2): a resolved binding that states
      // its temperature and reasoning, unless the model rejects the parameter.
      for (const [binding, setting] of [
        [{ ...SEEDED_BINDING, sampling: { temperature: null, topP: null } }, "temperature"],
        [{ ...SEEDED_BINDING, reasoning: null }, "reasoning"]
      ] as const) {
        await pool.query(`update skill_versions set execution_binding = $2::jsonb where id=$1`, [skillVersionId, JSON.stringify(binding)]);
        await expect(repository.createRun(OWNER, input)).rejects.toMatchObject({
          code: "ineligible",
          message: expect.stringContaining(`${setting} must be explicit`)
        });
      }
      const opus = { ...SEEDED_BINDING, modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", sampling: { temperature: null, topP: null } };
      await pool.query(`update skill_versions set execution_binding = $2::jsonb where id=$1`, [skillVersionId, JSON.stringify(opus)]);
      await saveResolutionRecord(pool, PROJECT_ID, skillVersionId, opus, await temperatureRejectingRecordFor(opus));
      const opusRun = await repository.createRun(OWNER, { ...input, idempotencyKey: "cal-run-opus" });
      expect(opusRun).toMatchObject({ state: "queued" });
      await pool.query(`update binary_calibration_runs set state='rejected',rejection_reason='test_cleanup',completed_at=clock_timestamp() where id=$1`, [opusRun.runId]);
      await pool.query(`delete from evaluator_resolution_records where skill_version_id=$1`, [skillVersionId]);
      await pool.query(`update skill_versions set execution_binding = $2::jsonb where id=$1`, [skillVersionId, JSON.stringify(storedBinding)]);
      await expect(repository.createRun(OWNER, input)).rejects.toMatchObject({ code: "ineligible", message: expect.stringContaining("unresolved") });

      // A failed record stays failed for its binding, even under a concurrent
      // resolution; a record resolved for another binding is no record; and a
      // record can't be filed under another project.
      const failed = await temperatureRejectingRecordFor(SEEDED_BINDING);
      expect(failed.status).toBe("failed");
      await saveResolutionRecord(pool, PROJECT_ID, skillVersionId, SEEDED_BINDING, failed);
      expect(await saveResolutionRecord(pool, PROJECT_ID, skillVersionId, SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING)))
        .toMatchObject({ status: "failed" });
      await expect(repository.createRun(OWNER, input)).rejects.toMatchObject({ code: "ineligible", message: expect.stringContaining("failed") });
      expect(await loadResolutionRecord(pool, PROJECT_ID, skillVersionId, { ...SEEDED_BINDING, modelVersion: "claude-sonnet-4-6-20270101" })).toBeNull();
      await pool.query(`insert into projects (id,organization_id,name,trace_provider) values ('proj_binary_records','org_binary_calibration','Records','manual')`);
      await expect(saveResolutionRecord(pool, "proj_binary_records", skillVersionId, SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING)))
        .rejects.toThrow("another project");
      await pool.query(`delete from evaluator_resolution_records where skill_version_id=$1`, [skillVersionId]);
      await expect(saveResolutionRecord(pool, "proj_binary_records", skillVersionId, SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING)))
        .rejects.toMatchObject({ code: "23503" });
      await pool.query(`delete from projects where id='proj_binary_records'`);
      await pool.query(`delete from evaluator_resolution_records where skill_version_id=$1`, [skillVersionId]);
      await saveResolutionRecord(pool, PROJECT_ID, skillVersionId, SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING));
      // A version whose text the definition's limits refuse has no identity.
      await pool.query(`update skill_versions set execution_binding = $2::jsonb, rubric_markdown = repeat('x', 100001) where id=$1`, [skillVersionId, JSON.stringify(storedBinding)]);
      await expect(repository.createRun(OWNER, input)).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringContaining("rubricMarkdown")
      });
    } finally {
      await pool.query(`update skill_versions set execution_binding = $2::jsonb, rubric_markdown = '# Binary rubric' where id=$1`, [skillVersionId, JSON.stringify(storedBinding)]);
    }
    const created = await repository.createRun(OWNER, input);
    expect(created).toMatchObject({ state: "queued", plannedObservations: 2, accountedObservations: 0 });
    // The run pins the evaluator's v2 identity: the binding exactly as stored,
    // its digest, and skillDigest v2.
    const pinned = (await pool.query(
      `select run.execution_binding,run.requested_binding_digest,run.skill_digest,run.definition_digest,run.requested_provider,
              version.rubric_markdown,version.prompt,version.verdict_kind,version.output_schema,version.execution_binding as version_binding
       from binary_calibration_runs run join skill_versions version on version.id=run.skill_version_id where run.id=$1`,
      [created.runId]
    )).rows[0]!;
    const identity = evaluatorIdentityFor({
      rubricMarkdown: String(pinned.rubric_markdown), prompt: String(pinned.prompt), typedQuestion: null, decisionThreshold: null, verdictKind: "binary",
      outputSchema: pinned.output_schema, scalarRange: null, categoricalChoiceScores: null, executionBinding: pinned.version_binding
    });
    expect(canonicalJson(pinned.execution_binding)).toBe(canonicalJson(SEEDED_BINDING));
    expect(pinned).toMatchObject({
      requested_provider: "anthropic",
      requested_binding_digest: sha256Digest(SEEDED_BINDING),
      skill_digest: skillDigestV2(identity)
    });
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
    expect(authorized).toMatchObject({
      itemCount: 2, executionBinding: SEEDED_BINDING, customEndpointUrl: null,
      evaluator: { kind: "prompted", rubricMarkdown: "# Binary rubric" }
    });
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
      result: { state: "outcome", outcome: "pass" },
      attemptState: "terminal",
      providerObservation: {
        provider: "anthropic",
        observedModel: "claude-sonnet-4-6-observed",
        observedVersion: null,
        systemFingerprint: null,
        upstreamProvider: null
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
      result: { state: "outcome", outcome: "pass" },
      attemptState: "terminal",
      providerObservation: { provider: "anthropic", observedModel: "late", observedVersion: null, systemFingerprint: null, upstreamProvider: null }
    })).rejects.toMatchObject({ code: "state_conflict" });

    const minted = await repository.finalizeRun(claim!);
    expect(minted.run).toMatchObject({ state: "incomplete", accountedObservations: 2 });
    expect(minted.artifact).toMatchObject({
      status: "incomplete",
      incompleteReasons: ["trial_incomplete"],
      trials: [{ outcomes: { planned: 2, classified: 1, errored: 1, providerCalls: 2 } }]
    });
    const copy = await repository.getArtifact({ projectId: PROJECT_ID }, minted.artifact.artifactId);
    expect(parseCanonicalBinaryCalibrationV2ArtifactBytes(copy.canonicalBytes)).toEqual(minted.artifact);
    expect(minted.artifact.evaluator).toMatchObject({
      identity: { basis: "rubrist/evaluator-identity/v2", executionBinding: SEEDED_BINDING },
      requestedBindingDigest: sha256Digest(SEEDED_BINDING)
    });
    const privateBytes = (await pool.query(
      `select canonical_bytes from binary_calibration_private_ledgers where run_id=$1`,
      [runProjection.runId]
    )).rows[0].canonical_bytes as Buffer;
    const ledger = JSON.parse(privateBytes.toString("utf8"));
    expect(verifyBinaryCalibrationV2PrivateLedgerForArtifact(ledger, minted.artifact).ledger.records)
      .toEqual(expect.arrayContaining([expect.objectContaining({ result: { state: "failure", failureKind: "outcome_unknown" } })]));
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
        result: { state: "not_attempted" },
        attemptState: "not_started",
        providerObservation: { provider: "anthropic", observedModel: null, observedVersion: null, systemFingerprint: null, upstreamProvider: null }
      });
    }
    const rerunArtifact = await repository.finalizeRun(sameClaim!);
    expect(rerunArtifact.artifact.status).toBe("incomplete");

    // A version that no longer holds the identity its run pinned is refused
    // at authorization, before any lease or exposure.
    const pinnedRun = await repository.createRun(OWNER, {
      datasetRevisionId: revisionId,
      skillVersionId,
      positiveClass: "pass",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      suiteBinding: null,
      idempotencyKey: "cal-run-pin-changed"
    });
    const exposuresBefore = Number((await pool.query(`select count(*)::int as count from dataset_exposure_events where revision_id=$1`, [revisionId])).rows[0].count);
    await pool.query(`update skill_versions set rubric_markdown = '# Changed out of band' where id=$1`, [skillVersionId]);
    try {
      const pinnedClaim = await repository.claimRun(pinnedRun.runId, "cal-worker-pin", 60_000);
      await expect(repository.authorizeRun(pinnedClaim!)).rejects.toMatchObject({ code: "ineligible" });
    } finally {
      await pool.query(`update skill_versions set rubric_markdown = '# Binary rubric' where id=$1`, [skillVersionId]);
    }
    expect((await pool.query(`select state,rejection_reason from binary_calibration_runs where id=$1`, [pinnedRun.runId])).rows[0])
      .toEqual({ state: "rejected", rejection_reason: "evaluator_version_changed" });
    expect(Number((await pool.query(`select count(*)::int as count from dataset_exposure_events where revision_id=$1`, [revisionId])).rows[0].count))
      .toBe(exposuresBefore);
    expect((await pool.query(`select 1 from binary_calibration_revision_leases where run_id=$1`, [pinnedRun.runId])).rows).toHaveLength(0);

    // The re-check before the first authorization is recorded against the
    // run it guards; one that no longer holds rejects the run before exposure.
    const recheckRun = await repository.createRun(OWNER, {
      datasetRevisionId: revisionId,
      skillVersionId,
      positiveClass: "pass",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      suiteBinding: null,
      idempotencyKey: "cal-run-recheck"
    });
    const recheckClaim = await repository.claimRun(recheckRun.runId, "cal-worker-recheck", 60_000);
    expect(await repository.getRecheckTarget(recheckClaim!)).toMatchObject({
      authorized: false,
      msSinceUnknownRecheck: null,
      binding: { executionBinding: SEEDED_BINDING, customEndpointUrl: null }
    });
    await repository.recordRecheck(recheckClaim!, { outcome: "unknown", probes: [] });
    expect((await repository.getRecheckTarget(recheckClaim!)).msSinceUnknownRecheck).toBeGreaterThanOrEqual(0);
    await repository.rejectBeforeAuthorization(recheckClaim!, "resolution_no_longer_holds");
    expect((await pool.query(`select state,rejection_reason,authorization_check_id from binary_calibration_runs where id=$1`, [recheckRun.runId])).rows[0])
      .toEqual({ state: "rejected", rejection_reason: "resolution_no_longer_holds", authorization_check_id: null });
    expect((await pool.query(
      `select kind,trigger_kind,outcome,skill_version_id from evaluator_resolution_attempts where trigger_ref=$1`, [recheckRun.runId]
    )).rows).toEqual([{ kind: "recheck", trigger_kind: "binary_calibration_run", outcome: "unknown", skill_version_id: skillVersionId }]);
    await expect(pool.query(`update evaluator_resolution_attempts set outcome='holds' where trigger_ref=$1`, [recheckRun.runId]))
      .rejects.toMatchObject({ code: "55000" });

    const later = await platform.createSkillVersionPending(
      "cal_skill",
      CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "# Post-test binary rubric",
        prompt: "A version developed after sealed results existed.",
        executionBinding: bindingInput(MOCK_BINDING),
        verdictKind: "binary",
        criterionVersionId: "criterionv_cal_skill"
      }),
      { projectId: PROJECT_ID, actorUserId: DEVELOPER.userId }
    );
    await pool.query(`update skill_versions set execution_binding=$2::jsonb where id=$1`, [later.id, JSON.stringify(SEEDED_BINDING)]);
    await saveResolutionRecord(pool, PROJECT_ID, later.id, SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING));
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

    // Only an OpenRouter run can record the upstream that served a call.
    const bound = (await pool.query(
      `select run_id,dataset_revision_item_id,dataset_revision_item_digest from binary_calibration_attempts where project_id=$1 limit 1`,
      [PROJECT_ID]
    )).rows[0]!;
    await expect(pool.query(
      `insert into binary_calibration_attempts
         (id,run_id,project_id,dataset_revision_item_id,dataset_revision_item_digest,trial_index,truth_label,
          provider,upstream_provider,physical_provider_calls,attempt_state,commitment_salt)
       values ('cal_upstream_probe',$1,$2,$3,$4,0,'pass','anthropic','Anthropic',1,'started',$5)`,
      [bound.run_id, PROJECT_ID, bound.dataset_revision_item_id, bound.dataset_revision_item_digest, "c".repeat(64)]
    )).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("requested provider") });

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
