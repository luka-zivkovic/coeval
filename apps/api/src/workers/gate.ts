import { z } from "zod";
import { randomUUID } from "node:crypto";
import { GateRunJobSchema, type EvalRun, type GateRunJob } from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import { GateRunBindingMismatchError, type CoevalRepository } from "../repository.js";
import { runEvalRunInline } from "./eval-run.js";

// gate.run (M0 C5a): executes the golden-set regression gate for a pending
// (calibrating) skill version. Provider failures (RegressionGateJudgeError /
// RegressionGateUnavailableError) retry while budget remains. Permanent and
// exhausted failures are persisted as a failed version + error run.
export async function registerGateRunWorker(queue: Queue, repository: CoevalRepository): Promise<void> {
  await queue.work<GateRunJob>("gate.run", async ({ id, data, retryCount, retryLimit }) => {
    try {
      await processGateRunJob(repository, data, queue);
    } catch (error) {
      const parsed = GateRunJobSchema.safeParse(data);
      if (!parsed.success && error instanceof z.ZodError) {
        console.error(`gate.run job ${id} permanently failed; dropping:`, error);
        return;
      }
      if (parsed.success && error instanceof GateRunBindingMismatchError) {
        console.error(
          `gate.run job ${id} permanently failed; refusing to terminalize ${parsed.data.skillVersionId} because the job pin does not match its immutable binding; the version remains calibrating:`,
          error
        );
        return;
      }
      const retriesExhausted = retryCount !== undefined && retryLimit !== undefined && retryCount >= retryLimit;
      if (parsed.success && (isPermanentGateError(error) || retriesExhausted)) {
        await repository.failRegressionGateForVersion(parsed.data, error);
        console.error(`gate.run job ${id} terminally failed:`, error);
        return;
      }
      throw error;
    }
  });
}

export async function processGateRunJob(
  repository: CoevalRepository,
  job: GateRunJob,
  queue?: Queue | undefined
): Promise<void> {
  const parsed = GateRunJobSchema.parse(job);
  const { version, regressionRun } = await repository.runRegressionGateForVersion(parsed);

  // PR #56 time-scoped backfill, moved behind the gate outcome: existing
  // cases are re-judged with the new version only when it was NOT blocked —
  // a blocked version must never judge traffic.
  if (
    queue &&
    (parsed.timeScope === "existing" || parsed.timeScope === "both") &&
    regressionRun.status !== "blocked"
  ) {
    try {
      await repository.authorizeSkillVersionExecution({
        projectId: parsed.projectId,
        skillVersionId: version.id,
        context: "implicit_production",
        resourceKind: "regression_backfill",
        resourceId: regressionRun.id,
        idempotencyKey: `regression-backfill:${regressionRun.id}`
      });
    } catch {
      // A governed candidate may pass regression but is never backfilled until
      // an explicit owner activation makes it current and admissible.
      return;
    }
    await runExistingCaseBackfill(repository, parsed.projectId, version.id, queue);
  }
}

// Existing-case evaluation is a durable EvalRun, not a loose collection of
// judge.run jobs. The UI can therefore show real pending/running/failed state,
// resume after reload, and open the exact Result that completed onboarding.
// Replaying gate.run reuses the version's single backfill run; eval.item
// delivery has its own deterministic identities and execution claims.
export async function runExistingCaseBackfill(
  repository: CoevalRepository,
  projectId: string,
  skillVersionId: string,
  queue?: Queue | undefined
) {
  const caseIds = await repository.listCaseIdsForProject(projectId);
  if (caseIds.length === 0) return null;
  const existing = (await repository.listEvalRuns(projectId, { limit: 100, skillVersionId }))
    .find((run) => run.trigger === "backfill");
  const run = existing ?? await repository.createEvalRun({
    projectId,
    skillVersionId,
    trigger: "backfill",
    items: caseIds.map((caseId) => ({ caseId }))
  });

  const dispatchState = await dispatchEvalRunOnce(repository, run, queue);
  return {
    run: (await repository.getEvalRun(projectId, run.id)) ?? run,
    dispatchState
  };
}

export type EvalRunDispatchState = "ready" | "busy";

export async function dispatchEvalRunOnce(
  repository: CoevalRepository,
  run: EvalRun,
  queue?: Queue | undefined
): Promise<EvalRunDispatchState> {
  if (run.totalItems === 0 || (run.status !== "pending" && run.status !== "running")) return "ready";
  if (!queue) {
    await repository.armEvalRunItemDeliveryDeadline(run.projectId, run.id);
    await runEvalRunInline(repository, run.projectId, run.id);
    return "ready";
  }

  const dispatchToken = randomUUID();
  const dispatch = await repository.claimEvalRunDispatch({
    projectId: run.projectId,
    evalRunId: run.id,
    dispatchToken
  });
  if (dispatch.state === "dispatched") return "ready";
  if (dispatch.state === "busy") {
    if (!dispatch.jobId || !queue.getJobState) return "busy";
    const state = await queue.getJobState("eval.run", dispatch.jobId);
    return state === "created" || state === "retry" || state === "active" ? "ready" : "busy";
  }
  if (dispatch.state !== "claimed" || !dispatch.jobId) return "busy";
  const jobId = dispatch.jobId;

  try {
    const sent = await queue.send("eval.run", { projectId: run.projectId, evalRunId: run.id }, {
      id: jobId,
      retryLimit: 5,
      retryBackoff: true
    });
    if (sent === null && queue.getJobState && await queue.getJobState("eval.run", jobId) === null) {
      throw new Error("The evaluation queue did not accept the durable run job.");
    }
    await repository.markEvalRunDispatched({
      projectId: run.projectId,
      evalRunId: run.id,
      dispatchToken
    });
    return "ready";
  } catch (error) {
    await repository.releaseEvalRunDispatch({
      projectId: run.projectId,
      evalRunId: run.id,
      dispatchToken
    });
    throw error;
  }
}

function isPermanentGateError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  return error instanceof Error && /not found for gate job/i.test(error.message);
}
