import { describe, expect, it, vi } from "vitest";
import { isPermanentError } from "../src/workers/judge.js";
import type { Queue, QueueJob, QueueJobState, QueueName, QueueSendOptions } from "@coeval/queue";
import type { EvalItemJob } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { createStrictJudgeProvider } from "../src/lib/judge-provider.js";
import { DemoRepository } from "../src/repository.js";
import {
  processEvalItemJob,
  processEvalRunJob,
  recoverStaleEvalRunItemExecutions,
  registerEvalRunWorkers,
  runEvalRunInline
} from "../src/workers/eval-run.js";

const PROJECT = "proj_langsmith_support";
const SKILL_VERSION = "skillv_1_2_0";

class StubQueue implements Queue {
  readonly sent: Array<{ name: QueueName; data: object }> = [];
  readonly states = new Map<string, QueueJobState>();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work(): Promise<void> {}
  async send<T extends object>(name: QueueName, data: T, options?: QueueSendOptions): Promise<string | null> {
    this.sent.push({ name, data });
    const id = options?.id ?? `job_${this.sent.length}`;
    this.states.set(id, "created");
    return id;
  }
  async getJobState(_name: QueueName, id: string): Promise<QueueJobState | null> {
    return this.states.get(id) ?? null;
  }
}

type WorkHandler = (job: QueueJob<object>) => Promise<void>;

// Captures registered work handlers so tests can drive the eval.item worker
// directly with pg-boss-shaped retry metadata.
class WorkerQueue implements Queue {
  readonly sent: Array<{ name: QueueName; data: object }> = [];
  readonly handlers = new Map<QueueName, WorkHandler>();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(name: QueueName, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    this.handlers.set(name, handler as WorkHandler);
  }
  async send<T extends object>(name: QueueName, data: T, _options?: QueueSendOptions): Promise<string> {
    this.sent.push({ name, data });
    return `job_${this.sent.length}`;
  }
}

class ExistingJobQueue implements Queue {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work(): Promise<void> {}
  async send<T extends object>(_name: QueueName, _data: T, _options?: QueueSendOptions): Promise<null> {
    return null;
  }
  async getJobState(): Promise<"failed"> { return "failed"; }
}

// The mock judge is content-deterministic: outputs containing fail terms
// ("wrong", "incorrect", …) fail, clean outputs pass — so expectedLabel
// agreement is assertable.
async function importCase(repository: DemoRepository, sourceTraceId: string, answer: string): Promise<string> {
  const imported = await repository.importTrace(PROJECT, "manual", {
    sourceTraceId,
    input: { question: "Is the refund policy honored?" },
    output: { answer },
    metadata: {}
  }, { ingestionPurpose: "analysis_eligible_manual" });
  return imported.caseId;
}

describe("eval runs — worker fan-out + counter lifecycle", () => {
  it("fans out one eval.item per pending item and marks the run running", async () => {
    const repository = new DemoRepository();
    const caseA = await importCase(repository, "evr_fan_a", "A helpful answer.");
    const caseB = await importCase(repository, "evr_fan_b", "Another helpful answer.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId: caseA }, { caseId: caseB }]
    });

    const queue = new StubQueue();
    await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });

    expect(queue.sent).toHaveLength(2);
    expect(queue.sent.every((job) => job.name === "eval.item")).toBe(true);
    expect((queue.sent[0]!.data as EvalItemJob).skillVersionId).toBe(SKILL_VERSION);
    expect((await repository.getEvalRun(PROJECT, run.id))?.status).toBe("running");
  });

  it("reconciles a final pre-claim worker death by resending a missing durable item job", async () => {
    vi.useFakeTimers();
    try {
      const repository = new DemoRepository();
      const caseId = await importCase(repository, "evr_preclaim_missing", "A helpful answer.");
      const run = await repository.createEvalRun({
        projectId: PROJECT,
        skillVersionId: SKILL_VERSION,
        trigger: "manual",
        items: [{ caseId }]
      });
      await repository.armEvalRunItemDeliveryDeadline(PROJECT, run.id);
      vi.advanceTimersByTime(16 * 60_000);

      const queue = new StubQueue();
      expect(await recoverStaleEvalRunItemExecutions(repository, queue)).toBe(1);
      expect(queue.sent).toEqual([expect.objectContaining({ name: "eval.item" })]);
      expect((await repository.getEvalRunDetail(PROJECT, run.id))?.items[0]?.status).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes an expired pre-claim item when its durable queue id is already exhausted", async () => {
    vi.useFakeTimers();
    try {
      const repository = new DemoRepository();
      const caseId = await importCase(repository, "evr_preclaim_exhausted", "A helpful answer.");
      const run = await repository.createEvalRun({
        projectId: PROJECT,
        skillVersionId: SKILL_VERSION,
        trigger: "manual",
        items: [{ caseId }]
      });
      await repository.armEvalRunItemDeliveryDeadline(PROJECT, run.id);
      vi.advanceTimersByTime(16 * 60_000);

      expect(await recoverStaleEvalRunItemExecutions(repository, new ExistingJobQueue())).toBe(1);
      expect((await repository.getEvalRunDetail(PROJECT, run.id))?.items[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("ended in failed")
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes items with verdict FKs + agreement, and finishes the run on the last item", async () => {
    const repository = new DemoRepository();
    // Mock judge: clean answer → pass (agrees), failing answer → fail (disagrees with expected pass).
    const agreeing = await importCase(repository, "evr_cnt_a", "A correct, helpful answer.");
    const disagreeing = await importCase(repository, "evr_cnt_b", "This answer is wrong and incorrect.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [
        { caseId: agreeing, expectedLabel: "pass" },
        { caseId: disagreeing, expectedLabel: "pass" }
      ]
    });
    const queue = new StubQueue();
    await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });

    for (const job of queue.sent) await processEvalItemJob(repository, job.data as EvalItemJob);

    const detail = await repository.getEvalRunDetail(PROJECT, run.id);
    expect(detail?.status).toBe("completed");
    expect(detail?.completedItems).toBe(2);
    expect(detail?.agreedItems).toBe(1);
    expect(detail?.finishedAt).not.toBeNull();
    for (const item of detail?.items ?? []) {
      expect(item.status).toBe("completed");
      expect(item.verdictId).not.toBeNull();
      expect(item.latencyMs).not.toBeNull();
      // The verdict FK points at a real ledger row pinned to the version.
      const verdicts = await repository.listVerdicts({ projectId: PROJECT, caseId: item.caseId, source: "llm_judge", limit: 5 });
      expect(verdicts.map((verdict) => verdict.id)).toContain(item.verdictId);
    }
    const agreed = detail!.items.find((item) => item.caseId === agreeing);
    const flipped = detail!.items.find((item) => item.caseId === disagreeing);
    expect(agreed?.agreement).toBe(true);
    expect(agreed?.resultLabel).toBe("pass");
    expect(flipped?.agreement).toBe(false);
    expect(flipped?.resultLabel).toBe("fail");
  });

  it("replaying an item job counts nothing (queue-retry idempotency)", async () => {
    const repository = new DemoRepository();
    const caseA = await importCase(repository, "evr_idem", "Fine answer.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId: caseA }]
    });
    const queue = new StubQueue();
    await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });
    const job = queue.sent[0]!.data as EvalItemJob;

    await processEvalItemJob(repository, job);
    await processEvalItemJob(repository, job); // pg-boss redelivery

    const after = await repository.getEvalRun(PROJECT, run.id);
    expect(after?.completedItems).toBe(1);
    expect(after?.totalItems).toBe(1);
    expect(after?.status).toBe("completed");
    const detail = await repository.getEvalRunDetail(PROJECT, run.id);
    expect(detail?.items[0]?.status).toBe("completed");
    // The replay guard returns before the provider call: exactly ONE verdict
    // in the ledger — no duplicate spend, no self-consistency pollution.
    const verdicts = await repository.listVerdicts({ projectId: PROJECT, caseId: caseA, source: "llm_judge", limit: 10 });
    expect(verdicts).toHaveLength(1);
  });

  it("atomically permits only one of two distinct item deliveries to call the provider", async () => {
    const repository = new DemoRepository();
    const caseId = await importCase(repository, "evr_concurrent_item", "Fine answer.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId }]
    });
    const item = run.items[0]!;
    const job: EvalItemJob = {
      projectId: PROJECT,
      evalRunId: run.id,
      evalRunItemId: item.id,
      caseId,
      skillVersionId: SKILL_VERSION
    };
    const base = createStrictJudgeProvider({
      provider: "mock",
      modelId: "mock",
      modelVersion: "mock",
      temperature: 0
    });
    let providerCalls = 0;
    let enteredProvider!: () => void;
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => { enteredProvider = resolve; });
    const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const gatedProvider = {
      name: base.name,
      modelName: base.modelName,
      judge: base.judge.bind(base),
      async judgeStructured(input: Parameters<typeof base.judgeStructured>[0]) {
        providerCalls += 1;
        enteredProvider();
        await release;
        return base.judgeStructured(input);
      }
    };

    const first = processEvalItemJob(repository, job, gatedProvider, "delivery_a");
    await entered;
    const duplicate = processEvalItemJob(repository, job, gatedProvider, "delivery_b");
    await duplicate;
    expect(providerCalls).toBe(1);
    releaseProvider();
    await first;

    expect((await repository.getEvalRunDetail(PROJECT, run.id))?.items[0]?.status).toBe("completed");
    expect(await repository.listVerdicts({ projectId: PROJECT, caseId, source: "llm_judge", limit: 10 })).toHaveLength(1);
  });

  it("keeps a final pre-call generation claimed until its failure is durable", async () => {
    let enteredFailure!: () => void;
    let releaseFailure!: () => void;
    const failureEntered = new Promise<void>((resolve) => { enteredFailure = resolve; });
    const failureRelease = new Promise<void>((resolve) => { releaseFailure = resolve; });
    class GatedFailureRepository extends DemoRepository {
      private gateOnce = true;
      override async failEvalRunItem(...args: Parameters<DemoRepository["failEvalRunItem"]>) {
        if (this.gateOnce && args[0].executionToken) {
          this.gateOnce = false;
          enteredFailure();
          await failureRelease;
        }
        return super.failEvalRunItem(...args);
      }
    }

    const repository = new GatedFailureRepository();
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId: "case_vanished_before_provider" }]
    });
    const queue = new WorkerQueue();
    const base = createStrictJudgeProvider({
      provider: "mock",
      modelId: "mock",
      modelVersion: "mock",
      temperature: 0
    });
    let providerCalls = 0;
    const provider = {
      name: base.name,
      modelName: base.modelName,
      judge: base.judge.bind(base),
      async judgeStructured(input: Parameters<typeof base.judgeStructured>[0]) {
        providerCalls += 1;
        return base.judgeStructured(input);
      }
    };
    await registerEvalRunWorkers(queue, repository, provider);
    await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });
    const job = queue.sent.find((sent) => sent.name === "eval.item")!.data as EvalItemJob;
    const handler = queue.handlers.get("eval.item")!;

    const finalDelivery = handler({
      id: "job_final_pre_call",
      data: job,
      retryCount: 5,
      retryLimit: 5
    });
    await failureEntered;

    // The failing delivery still owns the exact token while its terminal
    // write is paused. A redelivery cannot claim the item or reach provider
    // dispatch in the release-before-fail window that previously existed.
    await processEvalItemJob(repository, job, provider, "racing_delivery");
    expect(providerCalls).toBe(0);

    releaseFailure();
    await expect(finalDelivery).resolves.toBeUndefined();
    expect((await repository.getEvalRunDetail(PROJECT, run.id))?.items[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("not found for judge job")
    });
    expect(providerCalls).toBe(0);
  });

  it("does not call the provider again when item terminalization fails after a response", async () => {
    class TerminalizationFailureRepository extends DemoRepository {
      private failOnce = true;
      override async completeEvalRunItem(...args: Parameters<DemoRepository["completeEvalRunItem"]>) {
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error("database unavailable before item terminalization");
        }
        return super.completeEvalRunItem(...args);
      }
    }
    const repository = new TerminalizationFailureRepository();
    const caseId = await importCase(repository, "evr_terminal_crash", "Fine answer.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId }]
    });
    const queue = new WorkerQueue();
    const base = createStrictJudgeProvider({
      provider: "mock",
      modelId: "mock",
      modelVersion: "mock",
      temperature: 0
    });
    let providerCalls = 0;
    const provider = {
      name: base.name,
      modelName: base.modelName,
      judge: base.judge.bind(base),
      async judgeStructured(input: Parameters<typeof base.judgeStructured>[0]) {
        providerCalls += 1;
        return base.judgeStructured(input);
      }
    };
    await registerEvalRunWorkers(queue, repository, provider);
    await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });
    const job = queue.sent.find((sent) => sent.name === "eval.item")!.data as EvalItemJob;
    const handler = queue.handlers.get("eval.item")!;

    await expect(handler({ id: "job_terminal_crash", data: job, retryCount: 0, retryLimit: 5 })).resolves.toBeUndefined();
    expect(providerCalls).toBe(1);
    expect((await repository.getEvalRunDetail(PROJECT, run.id))?.items[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Provider returned")
    });
    expect(await repository.listVerdicts({ projectId: PROJECT, caseId, source: "llm_judge", limit: 10 })).toHaveLength(1);

    // Even an accidental replay is terminal and cannot spend again.
    await expect(handler({ id: "job_terminal_crash", data: job, retryCount: 1, retryLimit: 5 })).resolves.toBeUndefined();
    expect(providerCalls).toBe(1);
  });

  it("an ambiguous provider rejection fails outcome-unknown without another physical call", async () => {
    const repository = new DemoRepository();
    const caseA = await importCase(repository, "evr_exhaust", "A fine answer.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId: caseA }]
    });
    const queue = new WorkerQueue();
    const transientError = Object.assign(new Error("529 overloaded_error"), { status: 529 });
    let providerCalls = 0;
    const flaky = {
      name: "anthropic",
      modelName: "claude-x",
      async judge() { throw transientError; },
      async judgeStructured() {
        providerCalls += 1;
        throw transientError;
      }
    };
    await registerEvalRunWorkers(queue, repository, flaky as never);
    await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });
    const job = queue.sent.find((sent) => sent.name === "eval.item")!.data as EvalItemJob;
    const handler = queue.handlers.get("eval.item")!;

    // A rejected transport promise cannot prove the remote service did no
    // work. Terminalize honestly on the first delivery rather than retrying.
    await expect(handler({ id: "job_1", data: job, retryCount: 0, retryLimit: 5 })).resolves.toBeUndefined();
    const after = await repository.getEvalRunDetail(PROJECT, run.id);
    expect(after?.items[0]?.status).toBe("failed");
    expect(after?.items[0]?.error).toMatch(/outcome unknown.*overloaded/i);
    expect(after?.failedItems).toBe(1);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/outcome unknown/i);
    expect(after?.finishedAt).not.toBeNull();
    expect(providerCalls).toBe(1);

    await expect(handler({ id: "job_1", data: job, retryCount: 1, retryLimit: 5 })).resolves.toBeUndefined();
    expect(providerCalls).toBe(1);
  });

  it("a failed item still terminates the run, with the failure on record", async () => {
    const repository = new DemoRepository();
    const good = await importCase(repository, "evr_fail_a", "Good answer.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId: good }, { caseId: "case_vanished" }]
    });
    const queue = new StubQueue();
    await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });

    const jobs = queue.sent.map((job) => job.data as EvalItemJob);
    await processEvalItemJob(repository, jobs.find((job) => job.caseId === good)!);
    const doomed = jobs.find((job) => job.caseId === "case_vanished")!;
    await repository.failEvalRunItem({
      projectId: PROJECT,
      evalRunId: run.id,
      evalRunItemId: doomed.evalRunItemId,
      error: "case not found for judge job"
    });

    const after = await repository.getEvalRunDetail(PROJECT, run.id);
    expect(after?.status).toBe("completed");
    expect(after?.completedItems).toBe(1);
    expect(after?.failedItems).toBe(1);
    expect(after?.error).toMatch(/not found/);
    expect(after?.items.find((item) => item.caseId === "case_vanished")?.error).toMatch(/not found/);
  });

  it("M3 S1: an invalid project key fails the item LOUDLY — permanent, error recorded, no verdict, no retry spin", async () => {
    const repository = new DemoRepository();
    await repository.setJudgeProviderKey(PROJECT, "anthropic", "test-anthropic-invalid-team-key-00000000");
    const caseId = await importCase(repository, "evr_auth_fail", "A perfectly fine answer.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId }]
    });

    // Provider rejects the credential the way the SDK does on a bad key.
    const authError = Object.assign(new Error("401 {\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}"), { status: 401 });
    const rejecting = (_binding: unknown, opts?: { apiKey?: string }) => {
      // The project key must be the one in play — never the env fallback.
      expect(opts?.apiKey).toBe("test-anthropic-invalid-team-key-00000000");
      return {
        name: "anthropic",
        modelName: "claude-x",
        async judge() { throw authError; },
        async judgeStructured() { throw authError; }
      };
    };

    // The auth error is PERMANENT — the queue handler's classification.
    expect(isPermanentError(authError)).toBe(true);

    // Inline path (mirrors the queue handler's permanent branch): the item
    // fails with the provider's error; the run terminates; zero verdicts.
    await runEvalRunInline(repository, PROJECT, run.id, rejecting as never);
    const after = await repository.getEvalRunDetail(PROJECT, run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/authentication_error|401/);
    expect(after?.failedItems).toBe(1);
    expect(after?.items[0]?.error).toMatch(/authentication_error|401/);
    expect(after?.items[0]?.verdictId).toBeNull();
    const verdicts = await repository.listVerdicts({ projectId: PROJECT, caseId, source: "llm_judge", limit: 5 });
    expect(verdicts).toHaveLength(0);
  });

  it("pre-completed (cached) items count at creation; an all-cached run is born completed", async () => {
    const repository = new DemoRepository();
    const caseA = await importCase(repository, "evr_cached", "Cached answer.");
    const verdict = await repository.recordVerdict({
      projectId: PROJECT,
      caseId: caseA,
      source: "llm_judge",
      skillVersionId: SKILL_VERSION,
      payload: { kind: "binary", pass: true, rationale: "previously judged" }
    });

    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "api_batch",
      items: [{ caseId: caseA, status: "completed", verdictId: verdict.id, resultLabel: "pass", cached: true, expectedLabel: "pass" }]
    });

    expect(run.status).toBe("completed");
    expect(run.completedItems).toBe(1);
    expect(run.agreedItems).toBe(1);
    expect(run.items[0]?.cached).toBe(true);
    expect(run.finishedAt).not.toBeNull();
  });

  it("runEvalRunInline judges every pending item before returning (demo path)", async () => {
    const repository = new DemoRepository();
    const caseA = await importCase(repository, "evr_inline_a", "Inline answer one.");
    const caseB = await importCase(repository, "evr_inline_b", "Inline answer two.");
    const run = await repository.createEvalRun({
      projectId: PROJECT,
      skillVersionId: SKILL_VERSION,
      trigger: "manual",
      items: [{ caseId: caseA }, { caseId: caseB }]
    });

    await runEvalRunInline(repository, PROJECT, run.id);

    const after = await repository.getEvalRun(PROJECT, run.id);
    expect(after?.status).toBe("completed");
    expect(after?.completedItems).toBe(2);
  });
});

describe("eval runs — session endpoints over a dataset", () => {
  it("POST /api/eval-runs snapshots the dataset and (queue-less) completes inline", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const caseA = await importCase(repository, "evr_api_a", "A clean answer.");
    const caseB = await importCase(repository, "evr_api_b", "This one is wrong and failed.");
    const dataset = await repository.createDataset({ projectId: PROJECT, name: "Endpoint run" });
    await repository.addDatasetItems({
      projectId: PROJECT,
      datasetId: dataset.id,
      items: [{ caseId: caseA, expectedLabel: "pass" }, { caseId: caseB, expectedLabel: "pass" }]
    });

    const start = await localApp.request("/api/eval-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId: dataset.id })
    });
    expect(start.status).toBe(202);
    const { run } = (await start.json()) as { run: { id: string; status: string; totalItems: number; agreedItems: number; datasetId: string } };
    expect(run.datasetId).toBe(dataset.id);
    expect(run.status).toBe("completed");
    expect(run.totalItems).toBe(2);
    expect(run.agreedItems).toBe(1);

    const detail = await localApp.request(`/api/eval-runs/${run.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { items: Array<{ datasetItemId: string | null; verdictId: string | null }> };
    expect(detailBody.items).toHaveLength(2);
    expect(detailBody.items.every((item) => item.datasetItemId && item.verdictId)).toBe(true);

    const list = await localApp.request("/api/eval-runs");
    expect(((await list.json()) as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("404s on a missing or archived dataset, 400s on an empty one", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const post = (datasetId: string) => localApp.request("/api/eval-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId })
    });

    expect((await post("ds_missing")).status).toBe(404);

    const empty = await repository.createDataset({ projectId: PROJECT, name: "Empty" });
    expect((await post(empty.id)).status).toBe(400);

    const archived = await repository.createDataset({ projectId: PROJECT, name: "Archived" });
    await repository.archiveDataset(PROJECT, archived.id);
    expect((await post(archived.id)).status).toBe(404);
  });
});

// Skill Bench honesty guard: eval-run agreement numbers are the product for
// bench users, so a non-mock binding with no credentials must FAIL the item
// with a clear error — never silently record mock verdicts under a
// real-provider skill version. (The permissive factory stays the default so
// demo mode and provider-injecting tests keep working.)
describe("eval runs — strict judge provider (no credentials)", () => {
  it("fails items instead of mock-judging when the pinned provider has no key", async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const repository = new DemoRepository();
      const caseA = await importCase(repository, "evr_strict", "A helpful answer.");
      const run = await repository.createEvalRun({
        projectId: PROJECT,
        skillVersionId: SKILL_VERSION, // demo version pins anthropic
        trigger: "manual",
        items: [{ caseId: caseA, expectedLabel: "pass" }]
      });

      await runEvalRunInline(repository, PROJECT, run.id, createStrictJudgeProvider);

      const detail = await repository.getEvalRunDetail(PROJECT, run.id);
      expect(detail?.status).toBe("failed");
      expect(detail?.error).toMatch(/anthropic.*unavailable|unavailable.*anthropic/i);
      expect(detail?.failedItems).toBe(1);
      expect(detail?.items[0]?.status).toBe("failed");
      expect(detail?.items[0]?.error).toMatch(/anthropic.*unavailable|unavailable.*anthropic/i);
      expect(detail?.items[0]?.verdictId).toBeNull();
      // Nothing landed in the verdict ledger — no simulated judgments.
      const verdicts = await repository.listVerdicts({ projectId: PROJECT, caseId: caseA, source: "llm_judge", limit: 5 });
      expect(verdicts).toHaveLength(0);
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});
