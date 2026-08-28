import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EvalItemJobSchema,
  EvalRunJobSchema,
  verdictLabelFromPayload,
  type EvalItemJob,
  type EvalRunJob
} from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import type { CoevalRepository } from "../repository.js";
import { createJudgeProvider } from "../lib/judge-provider.js";
import { isPermanentError, judgeAndRecord, type ProviderArg } from "./judge.js";

// Eval-run fan-out: one `eval.run` job per run, which enqueues one `eval.item`
// job per pending item. Per-item jobs get pg-boss retry/backoff individually,
// parallelism comes from worker concurrency, and a crash mid-run loses at most
// one item's progress — the repository's status-guard updates make item
// completion idempotent under replays. A durable atomic execution token also
// keeps distinct duplicate deliveries from calling the provider concurrently.
//
// An item failure must always reach the run (issue #152): permanent errors
// mark the item failed immediately, and a TRANSIENT failure on the FINAL
// pg-boss attempt (retry budget exhausted — the job dead-letters on rethrow)
// marks it failed too. Otherwise the run polls as 'running' with zero
// counters forever — infrastructure failure masquerading as progress.
export async function registerEvalRunWorkers(
  queue: Queue,
  repository: CoevalRepository,
  provider: ProviderArg = createJudgeProvider
): Promise<void> {
  await queue.work<EvalRunJob>("eval.run", async ({ id, data }) => {
    try {
      await processEvalRunJob(repository, queue, data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error(`eval.run job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });

  await queue.work<EvalItemJob>("eval.item", async ({ id, data, retryCount, retryLimit }) => {
    const executionToken = `${id}:${randomUUID()}`;
    try {
      await processEvalItemJob(repository, data, provider, executionToken, queue);
    } catch (error) {
      // Failures proven to occur before physical provider dispatch may use
      // pg-boss retries. Permanent/final pre-call failures terminalize the
      // item first; every post-dispatch failure terminalizes outcome-unknown
      // and returns so the provider is never called twice.
      const permanent = isPermanentError(error);
      const finalAttempt = retryCount !== undefined &&
        retryLimit !== undefined &&
        retryCount >= retryLimit;
      const parsed = EvalItemJobSchema.safeParse(data);
      if (parsed.success) {
        // First determine whether physical dispatch ever started. A release
        // succeeds only for a proven pre-call failure. Any error after the
        // durable call-start marker — including auth/status rejections,
        // response parsing, persistence, and a final pg-boss attempt — is
        // outcome-unknown and must never be retried or described as an
        // ordinary judge failure.
        const terminalPreCall = permanent || finalAttempt;
        const disposition = await repository.releaseEvalRunItemExecution(
          {
            projectId: parsed.data.projectId,
            evalRunId: parsed.data.evalRunId,
            evalRunItemId: parsed.data.evalRunItemId,
            executionToken
          },
          terminalPreCall ? { preservePreCallClaim: true } : undefined
        );
        if (disposition.state === "provider_started") {
          await repository.failEvalRunItem({
            projectId: parsed.data.projectId,
            evalRunId: parsed.data.evalRunId,
            evalRunItemId: parsed.data.evalRunItemId,
            executionToken,
            error: postDispatchFailureMessage(error, disposition.providerCallReturned)
          });
          return;
        }
        if (disposition.state === "lost") return;
        if (disposition.state === "pre_call_held") {
          await repository.failEvalRunItem({
            projectId: parsed.data.projectId,
            evalRunId: parsed.data.evalRunId,
            evalRunItemId: parsed.data.evalRunItemId,
            executionToken,
            error: finalAttempt && !permanent
              ? `Judge failed after ${retryCount + 1} attempt(s): ${errorMessage(error)}`
              : errorMessage(error)
          });
        }
      }
      if (permanent) {
        console.error(`eval.item job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });

  // pg-boss cannot invoke handler cleanup when a worker process dies on its
  // final attempt. Sweep durable claims on startup and periodically so such
  // items become explicit failures instead of pending forever. The timer is
  // unref'd so test/CLI processes can exit normally.
  await recoverStaleEvalRunItemExecutions(repository, queue);
  const recoveryTimer = setInterval(() => {
    void recoverStaleEvalRunItemExecutions(repository, queue).catch((error) => {
      console.error("eval.item stale-execution recovery failed:", error);
    });
  }, 60_000);
  recoveryTimer.unref();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postDispatchFailureMessage(error: unknown, providerCallReturned: boolean): string {
  return providerCallReturned
    ? `Provider returned, but durable item completion failed; the evaluator was not called again: ${errorMessage(error)}`
    : `Provider outcome unknown after a dispatched call failed without a durable result; the evaluator was not called again: ${errorMessage(error)}`;
}

export async function recoverStaleEvalRunItemExecutions(
  repository: CoevalRepository,
  queue?: Queue | undefined
): Promise<number> {
  const stale = await repository.listStaleEvalRunItemExecutions();
  for (const execution of stale) {
    // No handler ever claimed this item. Reconcile the durable item outbox
    // using pg-boss state to distinguish a live/existing UUID from a terminal
    // one. Live/missing jobs never sit behind a recovery execution token: a
    // queue delivery racing this sweep must remain free to claim the item.
    if (execution.executionToken === null) {
      if (!queue?.getJobState) continue;
      await repository.markEvalRunRunning(execution.projectId, execution.evalRunId);
      const run = await repository.getEvalRun(execution.projectId, execution.evalRunId);
      const dispatches = run && (run.status === "pending" || run.status === "running")
        ? await repository.listPendingEvalRunItemDispatches(execution.projectId, execution.evalRunId)
        : [];
      const dispatch = dispatches.find(({ item }) => item.id === execution.evalRunItemId);
      if (!run || !dispatch) continue;

      const queueState = await queue.getJobState("eval.item", dispatch.jobId);
      if (queueState === "created" || queueState === "retry" || queueState === "active") {
        await repository.rearmEvalRunItemDeliveryDeadline(
          execution.projectId,
          execution.evalRunId,
          execution.evalRunItemId
        );
        continue;
      }
      if (queueState === null) {
        const rearmed = await repository.rearmEvalRunItemDeliveryDeadline(
          execution.projectId,
          execution.evalRunId,
          execution.evalRunItemId
        );
        if (!rearmed) continue;
        await queue.send("eval.item", {
          projectId: execution.projectId,
          evalRunId: execution.evalRunId,
          evalRunItemId: dispatch.item.id,
          caseId: dispatch.item.caseId,
          skillVersionId: run.skillVersionId
        } satisfies EvalItemJob, {
          id: dispatch.jobId,
          retryLimit: 5,
          retryBackoff: true,
          expireInSeconds: 15 * 60
        });
        // A null insert only means another sender won the same UUID. Its state
        // is reconciled after the refreshed deadline if it never does work.
        continue;
      }

      // Terminal queue state is the only path that needs a recovery execution
      // token. Claim and re-check before failing so a stale queue snapshot can
      // never overwrite a domain handler that won the item concurrently.
      const recoveryToken = `recovery:${randomUUID()}`;
      const recoveryClaimed = await repository.claimEvalRunItemRecovery({
        projectId: execution.projectId,
        evalRunId: execution.evalRunId,
        evalRunItemId: execution.evalRunItemId,
        executionToken: recoveryToken
      });
      if (!recoveryClaimed) continue;
      const confirmedState = await queue.getJobState("eval.item", dispatch.jobId);
      if (confirmedState !== "completed" && confirmedState !== "cancelled" && confirmedState !== "failed") {
        await repository.releaseEvalRunItemExecution({
          projectId: execution.projectId,
          evalRunId: execution.evalRunId,
          evalRunItemId: execution.evalRunItemId,
          executionToken: recoveryToken
        });
        continue;
      }
      await repository.failEvalRunItem({
        projectId: execution.projectId,
        evalRunId: execution.evalRunId,
        evalRunItemId: execution.evalRunItemId,
        executionToken: recoveryToken,
        error: `Queue delivery ended in ${confirmedState} before the evaluator started; the evaluation did not run.`
      });
      continue;
    }
    await repository.failEvalRunItem({
      projectId: execution.projectId,
      evalRunId: execution.evalRunId,
      evalRunItemId: execution.evalRunItemId,
      executionToken: execution.executionToken,
      error: execution.providerCallReturned
        ? "Provider returned, but durable item completion was interrupted; the evaluator was not called again."
        : execution.providerCallStarted
          ? "Provider outcome unknown after worker interruption; the evaluator was not called again."
          : "Worker interrupted before provider dispatch; the evaluation did not run."
    });
  }
  return stale.length;
}

export async function processEvalRunJob(
  repository: CoevalRepository,
  queue: Queue,
  job: EvalRunJob
): Promise<void> {
  const parsed = EvalRunJobSchema.parse(job);
  const run = await repository.getEvalRun(parsed.projectId, parsed.evalRunId);
  if (!run) {
    console.error(`eval.run: run not found, dropping: ${parsed.evalRunId}`);
    return;
  }
  if (run.status !== "pending" && run.status !== "running") return;
  await repository.markEvalRunRunning(parsed.projectId, parsed.evalRunId);
  await repository.armEvalRunItemDeliveryDeadline(parsed.projectId, parsed.evalRunId);
  // Only still-pending items are enqueued, so re-running this job (pg-boss
  // retry after a partial fan-out) tops up the missing sends. Each item keeps
  // one durable queue id, so repeated sends share one pg-boss job and retry
  // budget; the execution claim remains the final concurrency guard.
  const pending = await repository.listPendingEvalRunItemDispatches(parsed.projectId, parsed.evalRunId);
  for (const { item, jobId } of pending) {
    await queue.send("eval.item", {
      projectId: parsed.projectId,
      evalRunId: parsed.evalRunId,
      evalRunItemId: item.id,
      caseId: item.caseId,
      skillVersionId: run.skillVersionId
    } satisfies EvalItemJob, {
      id: jobId,
      retryLimit: 5,
      retryBackoff: true,
      expireInSeconds: 15 * 60
    });
  }
}

export async function processEvalItemJob(
  repository: CoevalRepository,
  job: EvalItemJob,
  provider: ProviderArg = createJudgeProvider,
  executionToken = `direct:${randomUUID()}`,
  queue?: Queue | undefined
): Promise<void> {
  const parsed = EvalItemJobSchema.parse(job);
  // Atomic generation BEFORE the provider call: concurrent or redelivered
  // handlers cannot both observe pending and spend. A stale pre-call claim can
  // be replaced; a stale post-dispatch claim fails outcome-unknown below.
  const claimed = await repository.claimEvalRunItemExecution({
    projectId: parsed.projectId,
    evalRunId: parsed.evalRunId,
    evalRunItemId: parsed.evalRunItemId,
    executionToken
  });
  if (claimed.state === "outcome_unknown") {
    await repository.failEvalRunItem({
      projectId: parsed.projectId,
      evalRunId: parsed.evalRunId,
      evalRunItemId: parsed.evalRunItemId,
      executionToken: claimed.executionToken,
      error: claimed.providerCallReturned
        ? "Provider returned, but durable item completion was interrupted; the evaluator was not called again."
        : "Provider outcome unknown after worker interruption; the evaluator was not called again."
    });
    return;
  }
  if (claimed.state !== "claimed") return;
  const { run: judgeRun, payload, verdict, latencyMs, usage, providerMetadata } = await judgeAndRecord(repository, {
    projectId: parsed.projectId,
    caseId: parsed.caseId,
    skillVersionId: parsed.skillVersionId,
    evalRunId: parsed.evalRunId,
    evalRunItemId: parsed.evalRunItemId
  }, provider, {
    beforeProviderCall: async () => {
      const started = await repository.beginEvalRunItemProviderCall({
        projectId: parsed.projectId,
        evalRunId: parsed.evalRunId,
        evalRunItemId: parsed.evalRunItemId,
        executionToken
      });
      if (!started) throw new Error("Eval item provider-call claim was lost before dispatch");
    },
    providerCallReturned: async () => {
      const returned = await repository.markEvalRunItemProviderCallReturned({
        projectId: parsed.projectId,
        evalRunId: parsed.evalRunId,
        evalRunItemId: parsed.evalRunItemId,
        executionToken
      });
      if (!returned) throw new Error("Eval item provider response could not be durably recorded");
    }
  });
  await repository.completeEvalRunItem({
    projectId: parsed.projectId,
    evalRunId: parsed.evalRunId,
    evalRunItemId: parsed.evalRunItemId,
    executionToken,
    verdictId: verdict.id,
    // Label projected from the verdict this item links to — NOT from the
    // legacy judge_run, whose (project, case, skillVersion) dedup returns the
    // FIRST run's verdict and could contradict the fresh one.
    resultLabel: verdictLabelFromPayload(payload),
    // the judge-named failing step (absent for step-less cases or
    // when the judge omitted/was-dropped).
    ...("failingStep" in payload && payload.failingStep !== undefined ? { failingStep: payload.failingStep } : {}),
    // THIS call's usage — rides the item even when recordJudgeRun
    // deduped to an older judge_runs row (the known repeat-call limit).
    ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
    providerMetadata,
    latencyMs
  });
  if (queue) {
    for (const feedbackProvider of ["langsmith", "langfuse", "ironside"] as const) {
      try {
        const feedbackJob = await repository.createFeedbackSyncJob({
          projectId: judgeRun.projectId,
          judgeRunId: judgeRun.id,
          provider: feedbackProvider
        });
        if (!feedbackJob) continue;
        await queue.send("feedback.sync", {
          projectId: feedbackJob.projectId,
          feedbackSyncJobId: feedbackJob.id
        }, { retryLimit: 5, retryBackoff: true });
      } catch (error) {
        // The evaluation item is already terminal and must never re-enter the
        // provider call because optional upstream feedback preparation or
        // dispatch failed.
        console.error(`feedback.sync preparation or dispatch failed for ${feedbackProvider}:`, error);
      }
    }
  }
}

// Queue-less path (demo mode): judge every pending item sequentially before
// the route responds. Caps are small and the provider is the mock, so the
// synchronous walk is cheap; PG-mode keeps the async 202-then-poll contract.
export async function runEvalRunInline(
  repository: CoevalRepository,
  projectId: string,
  evalRunId: string,
  provider: ProviderArg = createJudgeProvider
): Promise<void> {
  const run = await repository.getEvalRun(projectId, evalRunId);
  if (!run) return;
  await repository.markEvalRunRunning(projectId, evalRunId);
  for (const item of await repository.listPendingEvalRunItems(projectId, evalRunId)) {
    const executionToken = `inline:${evalRunId}:${item.id}`;
    try {
      await processEvalItemJob(repository, {
        projectId,
        evalRunId,
        evalRunItemId: item.id,
        caseId: item.caseId,
        skillVersionId: run.skillVersionId
      }, provider, executionToken);
    } catch (error) {
      const disposition = await repository.releaseEvalRunItemExecution(
        {
          projectId,
          evalRunId,
          evalRunItemId: item.id,
          executionToken
        },
        { preservePreCallClaim: true }
      );
      if (disposition.state === "lost") continue;
      await repository.failEvalRunItem({
        projectId,
        evalRunId,
        evalRunItemId: item.id,
        executionToken,
        error: disposition.state === "pre_call_held" || disposition.state === "released"
          ? errorMessage(error)
          : postDispatchFailureMessage(error, disposition.providerCallReturned)
      });
    }
  }
}
