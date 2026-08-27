import { z } from "zod";
import { GateRunJobSchema, type GateRunJob } from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import { GateRunBindingMismatchError, type CoevalRepository } from "../repository.js";

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
    for (const caseId of await repository.listCaseIdsForProject(parsed.projectId)) {
      await queue.send("judge.run", {
        projectId: parsed.projectId,
        caseId,
        skillVersionId: version.id
      }, { retryLimit: 5, retryBackoff: true });
    }
  }
}

function isPermanentGateError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  return error instanceof Error && /not found for gate job/i.test(error.message);
}
