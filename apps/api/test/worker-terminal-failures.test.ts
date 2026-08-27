import { describe, expect, it, vi } from "vitest";
import { MockJudgeProvider } from "@coeval/audit/runtime";
import type { Queue, QueueJob, QueueName, QueueSendOptions } from "@coeval/queue";
import { CreateSkillVersionInputSchema, type EvalItemJob, type GateRunJob } from "@coeval/shared";
import { DemoRepository, GateRunBindingMismatchError } from "../src/repository.js";
import { registerEvalRunWorkers } from "../src/workers/eval-run.js";
import { registerGateRunWorker } from "../src/workers/gate.js";

const PROJECT = "proj_langsmith_support";

class WorkerHarnessQueue implements Queue {
  readonly sent: Array<{ name: QueueName; data: object }> = [];
  private readonly handlers = new Map<QueueName, (job: QueueJob<object>) => Promise<void>>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, _options?: QueueSendOptions): Promise<string> {
    this.sent.push({ name, data });
    return `job_${this.sent.length}`;
  }
  async work<T extends object>(name: QueueName, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    this.handlers.set(name, handler as (job: QueueJob<object>) => Promise<void>);
  }
  async run<T extends object>(name: QueueName, data: T, retryCount: number, retryLimit: number): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler for ${name}`);
    await handler({ id: `${name}_${retryCount}`, data, retryCount, retryLimit });
  }
}

class TransientEvalContextRepository extends DemoRepository {
  override async loadJudgeRunContext(
    ..._args: Parameters<DemoRepository["loadJudgeRunContext"]>
  ): ReturnType<DemoRepository["loadJudgeRunContext"]> {
    throw new Error("database timed out before provider dispatch");
  }
}

class TransientGateRepository extends DemoRepository {
  override async runRegressionGateForVersion(_job: GateRunJob): Promise<never> {
    throw new Error("provider temporarily unavailable");
  }
}

class MismatchedGateRepository extends DemoRepository {
  finalized = false;

  override async runRegressionGateForVersion(job: GateRunJob): Promise<never> {
    throw new GateRunBindingMismatchError(job.datasetRevisionId, "revision_current");
  }

  override async failRegressionGateForVersion(): Promise<void> {
    this.finalized = true;
  }
}

describe("queue retry exhaustion terminalizes domain state", () => {
  it("drops a malformed gate job instead of retrying an unterminalizable payload", async () => {
    const repository = new DemoRepository();
    const queue = new WorkerHarnessQueue();
    await registerGateRunWorker(queue, repository);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(queue.run("gate.run", {} as GateRunJob, 0, 5)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("permanently failed; dropping"),
      expect.anything()
    );
    consoleError.mockRestore();
  });

  it("drops a pin-mismatched gate job without retries or false terminal evidence", async () => {
    const repository = new MismatchedGateRepository();
    const queue = new WorkerHarnessQueue();
    await registerGateRunWorker(queue, repository);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(queue.run("gate.run", {
      projectId: PROJECT,
      skillVersionId: "skillv_mismatch",
      datasetRevisionId: "revision_job",
      timeScope: "new"
    } satisfies GateRunJob, 0, 5)).resolves.toBeUndefined();
    expect(repository.finalized).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("version remains calibrating"),
      expect.any(GateRunBindingMismatchError)
    );
    consoleError.mockRestore();
  });

  it("keeps an eval item retryable before the limit, then fails it and completes its run", async () => {
    const repository = new TransientEvalContextRepository();
    const imported = await repository.importTrace(PROJECT, "manual", {
      sourceTraceId: "retry_exhaustion_eval",
      input: { question: "q" },
      output: { answer: "a" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: "skillv_1_2_0",
      trigger: "manual",
      items: [{ caseId: imported.caseId }]
    });
    await repository.markEvalRunRunning(PROJECT, run.id);
    const item = run.items[0]!;
    const job: EvalItemJob = {
      projectId: PROJECT,
      evalRunId: run.id,
      evalRunItemId: item.id,
      caseId: item.caseId,
      skillVersionId: "skillv_1_2_0"
    };
    const queue = new WorkerHarnessQueue();
    await registerEvalRunWorkers(queue, repository, new MockJudgeProvider());

    await expect(queue.run("eval.item", job, 4, 5)).rejects.toThrow("database timed out before provider dispatch");
    expect((await repository.getEvalRunDetail(PROJECT, run.id))?.items[0]?.status).toBe("pending");
    expect((await repository.getEvalRun(PROJECT, run.id))?.status).toBe("running");

    await expect(queue.run("eval.item", job, 5, 5)).rejects.toThrow("database timed out before provider dispatch");
    const terminal = await repository.getEvalRunDetail(PROJECT, run.id);
    expect(terminal?.status).toBe("failed");
    expect(terminal?.failedItems).toBe(1);
    expect(terminal?.items[0]?.status).toBe("failed");
    expect(terminal?.items[0]?.error).toContain("after 6 attempt(s): database timed out before provider dispatch");

    // A late exhausted redelivery observes terminal item state before calling
    // the provider and must not double-count or rewrite the first error.
    await expect(queue.run("eval.item", job, 5, 5)).resolves.toBeUndefined();
    expect(await repository.getEvalRunDetail(PROJECT, run.id)).toEqual(terminal);
  });

  it("keeps a gate calibrating before the limit, then records one failed version and error run", async () => {
    const repository = new TransientGateRepository();
    const version = await repository.createSkillVersionPending(
      "skill_support_quality",
      CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "Judge support quality.",
        prompt: "Judge the answer.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 }
      }),
      { projectId: PROJECT }
    );
    const job: GateRunJob = {
      projectId: PROJECT,
      skillVersionId: version.id,
      datasetRevisionId: version.regressionDatasetRevisionId!,
      timeScope: "new"
    };
    const queue = new WorkerHarnessQueue();
    await registerGateRunWorker(queue, repository);

    await expect(queue.run("gate.run", job, 4, 5)).rejects.toThrow("temporarily unavailable");
    expect((await repository.listSkillVersions(PROJECT, version.skillId)).find((v) => v.id === version.id)?.status).toBe("calibrating");
    expect(await repository.getRegressionRunForVersion(PROJECT, version.id)).toBeNull();

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(queue.run("gate.run", job, 5, 5)).resolves.toBeUndefined();
    const failed = (await repository.listSkillVersions(PROJECT, version.skillId)).find((v) => v.id === version.id);
    const errorRun = await repository.getRegressionRunForVersion(PROJECT, version.id);
    expect(failed?.status).toBe("failed");
    expect(errorRun).toMatchObject({ status: "error", compared: 0, error: "provider temporarily unavailable" });

    // Finalizer is idempotent under a late redelivery.
    await expect(queue.run("gate.run", job, 5, 5)).resolves.toBeUndefined();
    expect((await repository.getRegressionRunForVersion(PROJECT, version.id))?.id).toBe(errorRun?.id);
    consoleError.mockRestore();
  });
});
