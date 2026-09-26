import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import type { ExecutionFetch } from "@rubrist/audit/runtime";
import { CreateSkillVersionInputSchema, TypedQuestionOutputSchema, type ExecutionBinding } from "@rubrist/shared";
import { createBinaryCalibrationProviderExecutor } from "../src/binary-calibration/provider.js";
import { PgBinaryCalibrationRepository } from "../src/binary-calibration/repository.pg.js";
import { processBinaryCalibrationRun } from "../src/binary-calibration/worker.js";
import { saveResolutionRecord } from "../src/evaluator-lifecycle/resolution.pg.js";
import { PgGovernedReviewRepository, type GovernedReviewActor } from "../src/governed-review/index.js";
import { verifyBinaryCalibrationV2PrivateLedgerForArtifact } from "../src/lib/binary-calibration-v2.js";
import { PgRepository } from "../src/repository.pg.js";
import { MOCK_BINDING, bindingInput, resolvedRecordFor } from "./fixtures/execution-binding.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke } from "./pg-smoke-support.js";

// A typed-question evaluator through sealed calibration end to end (ADR-0014
// section 5 and decision 8): authorized with its question and threshold, one
// TypeSafe call per attempt, pass or fail on the threshold, never an
// abstention, and no question, probability, or request id in the evidence.

const PROJECT_ID = "proj_typed_calibration";
const OWNER = { projectId: PROJECT_ID, userId: "typed_owner", projectRole: "owner" as const };
const CUSTODIAN: GovernedReviewActor = { projectId: PROJECT_ID, userId: "typed_custodian", projectRole: "member" };
const REVIEWERS: GovernedReviewActor[] = [
  { projectId: PROJECT_ID, userId: "typed_reviewer_a", projectRole: "member" },
  { projectId: PROJECT_ID, userId: "typed_reviewer_b", projectRole: "member" }
];
const JEV: ExecutionBinding = {
  provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
  sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
  verdictProtocol: "typed-question/v1", routing: null
};
const QUESTION = { type: "noul" as const, instructions: "Is QUESTION_CANARY answered?", criteria: { true: "Answered.", false: "Not answered." } };

runPgSmoke("typed-question sealed calibration", () => {
  it("calibrates a typed-question evaluator on its threshold, recording no question, probability, or request id", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("typed_calibration");
    try {
      await runMigrations(pool);
      const repository = new PgBinaryCalibrationRepository(pool);
      const governed = new PgGovernedReviewRepository(pool);
      const platform = new PgRepository(pool);
      await pool.query(`insert into organizations (id,name) values ('org_typed','Typed Org')`);
      for (const [index, actor] of [OWNER, CUSTODIAN, ...REVIEWERS].entries()) {
        await pool.query(`insert into "user" (id,name,email) values ($1,$1,$2)`, [actor.userId, `${actor.userId}@example.test`]);
        if (index === 0) {
          await pool.query(`insert into projects (id,organization_id,name,trace_provider) values ($1,'org_typed','Typed','manual')`, [PROJECT_ID]);
        }
        await pool.query(`insert into project_members (id,project_id,user_id,role) values ($1,$2,$3,$4)`, [`typed_pm_${index}`, PROJECT_ID, actor.userId, actor.projectRole]);
      }
      await pool.query(
        `insert into criteria (id,project_id,stable_key,source_kind,created_by_user_id) values ('criterion_typed',$1,'typed-truth','native',$2)`,
        [PROJECT_ID, OWNER.userId]
      );
      await pool.query(
        `insert into criterion_versions (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind,created_by_user_id)
         values ('criterionv_typed',$1,'criterion_typed',1,'Typed truth','Typed sealed evaluator',
                 criterion_v1_digest('criterion_typed','criterionv_typed','Typed truth','Typed sealed evaluator'),'native',$2)`,
        [PROJECT_ID, OWNER.userId]
      );
      await pool.query(
        `insert into skills (id,project_id,name,description,owner_user_id,status,criterion_id)
         values ('typed_skill',$1,'Typed truth','Typed sealed evaluator',$2,'draft','criterion_typed')`,
        [PROJECT_ID, OWNER.userId]
      );
      // Saved on the mock (its gate needs no key), then rewritten as the typed-question evaluator.
      const version = await platform.createSkillVersionPending("typed_skill", CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "# Rubric", prompt: "Judge.", executionBinding: bindingInput(MOCK_BINDING),
        verdictKind: "binary", criterionVersionId: "criterionv_typed"
      }), { projectId: PROJECT_ID, actorUserId: OWNER.userId });
      await pool.query(
        `update skill_versions set execution_binding=$2::jsonb, rubric_markdown=null, prompt=null,
                typed_question=$3::jsonb, decision_threshold=0.5, output_schema=$4::jsonb where id=$1`,
        [version.id, JSON.stringify(JEV), JSON.stringify(QUESTION), JSON.stringify(TypedQuestionOutputSchema)]
      );
      await saveResolutionRecord(pool, PROJECT_ID, version.id, JEV, await resolvedRecordFor(JEV));

      // A complete two-item sealed revision, labeled pass by two reviewers.
      const instruction = await governed.createInstruction(OWNER, {
        criterionVersionId: "criterionv_typed", title: "Sealed typed review", instructions: "Use only the protected projection.",
        failureCodeGuidance: "Use bounded failure codes.", idempotencyKey: "typed-instruction"
      });
      const intake = await governed.createSealedIntake(CUSTODIAN, {
        populationDefinition: "Two sealed items",
        items: [
          { clientItemId: "typed-a", input: { question: "INPUT_CANARY A?" }, output: { answer: "OUTPUT_CANARY A" } },
          { clientItemId: "typed-b", input: { question: "INPUT_CANARY B?" }, output: { answer: "OUTPUT_CANARY B" } }
        ],
        idempotencyKey: "typed-intake"
      });
      const batch = await governed.createBatchDraft(OWNER, {
        instructionVersionId: instruction.instructionVersionId, roleIntent: "sealed_validation",
        source: { kind: "sealed_intake", intakeId: intake.intakeId }, selection: { method: "simple_random", fixedBudget: 2 },
        reviewerUserIds: REVIEWERS.map((reviewer) => reviewer.userId), fixedStopAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "typed-batch"
      });
      await governed.transitionBatch(OWNER, batch.batchId, "open", { expectedStateVersion: 0, idempotencyKey: "typed-open" });
      for (const reviewer of REVIEWERS) {
        for (const task of (await governed.listReviewerTasks(reviewer)).filter((candidate) => candidate.batchId === batch.batchId)) {
          const view = await governed.getOrCreateBlindTaskView(reviewer, task.taskId);
          await governed.appendTaskAction(reviewer, task.taskId, {
            kind: "submit_label",
            input: {
              expectedStreamVersion: 1, viewDigest: view.viewDigest, label: "pass",
              rationale: "The response satisfies the frozen criterion.", failureCodes: [],
              idempotencyKey: `typed-label-${reviewer.userId}-${task.taskId}`
            }
          });
        }
      }
      for (const [transition, expectedStateVersion] of [["close_labeling", 1], ["finalize", 2], ["freeze", 3]] as const) {
        await governed.transitionBatch(OWNER, batch.batchId, transition, { expectedStateVersion, idempotencyKey: `typed-${transition}` });
      }
      const revisionId = String((await pool.query(
        `select dataset_revision_id from governed_review_batch_events where batch_id=$1 and event_kind='frozen'`, [batch.batchId]
      )).rows[0].dataset_revision_id);

      const created = await repository.createRun(OWNER, {
        datasetRevisionId: revisionId, skillVersionId: version.id, positiveClass: "pass",
        trialPlan: { kind: "single", trialsPerItem: 1 }, suiteBinding: null, idempotencyKey: "typed-run"
      });
      // The authorized run judges with the question and threshold.
      const claim = await repository.claimRun(created.runId, "typed-probe", 60_000);
      expect(await repository.authorizeRun(claim!)).toMatchObject({
        executionBinding: JEV, evaluator: { kind: "typed-question", question: QUESTION, threshold: 0.5 }
      });
      await pool.query(`update binary_calibration_runs set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1`, [created.runId]);

      // One item answered at the threshold (pass), one just below (fail).
      const probabilities = [0.5, 0.49];
      const sent: string[] = [];
      const fetch: ExecutionFetch = async (_url, init) => {
        sent.push(init.body);
        return new Response(JSON.stringify({
          model: "jev-1.13.0", answers: { verdict: { type: "noul", noul: probabilities[sent.length - 1] } }, usage: { input_tokens: 9, output_tokens: 1 }
        }), { status: 200, headers: { "x-typesafe-request-id": `REQUEST_ID_CANARY_${sent.length}` } });
      };
      const minted = await processBinaryCalibrationRun({
        repository,
        executeProvider: createBinaryCalibrationProviderExecutor({ resolveProjectCredential: async () => "typesafe-project-key", fetch }),
        runId: created.runId,
        workerId: "typed-worker"
      });
      expect(sent).toHaveLength(2);
      expect(sent.every((body) => body.includes("QUESTION_CANARY") && body.includes("INPUT_CANARY"))).toBe(true);
      expect(minted!.artifact).toMatchObject({
        status: "complete",
        trials: [{ outcomes: { planned: 2, classified: 2, abstained: 0, errored: 0, providerCalls: 2 } }]
      });
      const ledger = JSON.parse(((await pool.query(
        `select canonical_bytes from binary_calibration_private_ledgers where run_id=$1`, [created.runId]
      )).rows[0].canonical_bytes as Buffer).toString("utf8"));
      const records = verifyBinaryCalibrationV2PrivateLedgerForArtifact(ledger, minted!.artifact).ledger.records;
      expect(records.map((record: { result: unknown }) => record.result)).toEqual(expect.arrayContaining([
        { state: "outcome", outcome: "pass" }, { state: "outcome", outcome: "fail" }
      ]));
      const evidence = JSON.stringify({ artifact: minted!.artifact, ledger });
      expect(evidence).not.toMatch(/CANARY|0\.49|typesafe-project-key/);
    } finally {
      await cleanup();
    }
  }, 30_000);
});
