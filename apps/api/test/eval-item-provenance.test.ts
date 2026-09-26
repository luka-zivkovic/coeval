import { EvaluatorCallError, MockJudgeProvider, type StructuredVerdict } from "@rubrist/audit/runtime";
import type { Queue, QueueJob, QueueName, QueueSendOptions } from "@rubrist/queue";
import type { EvalItemJob } from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import { JudgeProviderUnavailableError, createStrictJudgeProvider } from "../src/lib/judge-provider.js";
import { DemoRepository } from "../src/repository.js";
import type { FailEvalRunItemInputDb } from "../src/repository/contracts.js";
import {
  processEvalItemJob,
  processEvalRunJob,
  recoverStaleEvalRunItemExecutions,
  registerEvalRunWorkers,
  runEvalRunInline
} from "../src/workers/eval-run.js";
import { evaluatorScoreFor } from "../src/workers/judge.js";
import { MOCK_BINDING, runtimeVersion } from "./fixtures/execution-binding.js";

// Per-item provenance for evidence v2 (ADR-0014 section 6): an evaluator's
// verdict records what its call observed and its own score, and a failed item
// records its failure kind or that it was never attempted.

const PROJECT = "proj_langsmith_support";
const SKILL_VERSION = "skillv_1_2_0";
const NOTHING = { model: null, requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null };
const NOT_ATTEMPTED = { status: "failed", failureKind: null, notAttempted: true, observed: null };

type WorkHandler = (job: QueueJob<object>) => Promise<void>;
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

async function oneItemRun(repository: DemoRepository, sourceTraceId: string) {
  const imported = await repository.importTrace(PROJECT, "manual", {
    sourceTraceId,
    input: { question: "Is the refund policy honored?" },
    output: { answer: "Yes, within 30 days." },
    metadata: {}
  }, { ingestionPurpose: "analysis_eligible_manual" });
  return repository.createEvalRun({ projectId: PROJECT, skillVersionId: SKILL_VERSION, trigger: "manual", items: [{ caseId: imported.caseId }] });
}

/** One item through the queue worker. */
async function runWith(provider: unknown, repository = new DemoRepository()) {
  const run = await oneItemRun(repository, `prov_${Math.random()}`);
  const queue = new WorkerQueue();
  await registerEvalRunWorkers(queue, repository, provider as never);
  await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });
  const job = queue.sent.find((sent) => sent.name === "eval.item")!.data as EvalItemJob;
  await queue.handlers.get("eval.item")!({ id: "job_1", data: job, retryCount: 0, retryLimit: 5 });
  return (await repository.getEvalRunDetail(PROJECT, run.id))!.items[0]!;
}

/** One item through the queue-less inline walk. */
async function runInlineWith(provider: unknown) {
  const repository = new DemoRepository();
  const run = await oneItemRun(repository, `inline_${Math.random()}`);
  await runEvalRunInline(repository, PROJECT, run.id, provider as never);
  return (await repository.getEvalRunDetail(PROJECT, run.id))!.items[0]!;
}

const throwing = (error: unknown) => ({
  name: "anthropic",
  modelName: "claude-x",
  async judge() { throw error; },
  async judgeStructured() { throw error; }
});

describe("the evaluator's own score", () => {
  const binary: StructuredVerdict = { kind: "binary", label: "fail", score: 0.2, rationale: "r" };
  it("is a binary verdict's P(pass), a normalized scalar score, and nothing for a categorical choice", () => {
    expect(evaluatorScoreFor(binary)).toEqual({ value: 0.2, kind: "self_reported_score" });
    expect(evaluatorScoreFor({ kind: "scalar", score: 4, range: [1, 5], rationale: "r" }))
      .toEqual({ value: 0.75, kind: "self_reported_score" });
    expect(evaluatorScoreFor({ kind: "categorical", choice: "ok", choiceScores: { ok: 0.5, bad: 0 }, rationale: "r" })).toBeNull();
  });

  it("is a typed-question verdict's probability, native to its model", () => {
    expect(evaluatorScoreFor({ kind: "typed-question", label: "fail", probability: 0.2, threshold: 0.6, rationaleStatus: "not_provided" }))
      .toEqual({ value: 0.2, kind: "native_probability" });
  });
});

describe("a completed item's verdict", () => {
  it("records what the call observed and the evaluator's score", async () => {
    const repository = new DemoRepository();
    const run = await oneItemRun(repository, "prov_complete");
    const item = run.items[0]!;
    await processEvalItemJob(repository, {
      projectId: PROJECT, evalRunId: run.id, evalRunItemId: item.id, caseId: item.caseId, skillVersionId: SKILL_VERSION
    }, () => createStrictJudgeProvider(runtimeVersion(MOCK_BINDING)));
    const detail = await repository.getEvalRunDetail(PROJECT, run.id);
    const verdict = (await repository.listVerdicts({ projectId: PROJECT, caseId: item.caseId, source: "llm_judge", limit: 1 }))[0]!;
    expect(detail!.items[0]).toMatchObject({ status: "completed", verdictId: verdict.id, failureKind: null, notAttempted: false, observed: null });
    expect(verdict.observed).toEqual({ ...NOTHING, model: "mock-heuristic-v1" });
    expect(verdict.evaluatorScore).toMatchObject({ kind: "self_reported_score", value: expect.any(Number) });
  });

  it("records no observation and no score from a provider that executes no binding", async () => {
    const repository = new DemoRepository();
    const run = await oneItemRun(repository, "prov_unbound");
    const item = run.items[0]!;
    await processEvalItemJob(repository, {
      projectId: PROJECT, evalRunId: run.id, evalRunItemId: item.id, caseId: item.caseId, skillVersionId: SKILL_VERSION
    }, () => new MockJudgeProvider());
    const verdict = (await repository.listVerdicts({ projectId: PROJECT, caseId: item.caseId, source: "llm_judge", limit: 1 }))[0]!;
    expect(verdict).toMatchObject({ observed: null, evaluatorScore: null });
  });

  it("is where a cached item's provenance lives; the item itself carries none", async () => {
    const repository = new DemoRepository();
    const first = await oneItemRun(repository, "prov_cached");
    const item = first.items[0]!;
    await processEvalItemJob(repository, {
      projectId: PROJECT, evalRunId: first.id, evalRunItemId: item.id, caseId: item.caseId, skillVersionId: SKILL_VERSION
    }, () => createStrictJudgeProvider(runtimeVersion(MOCK_BINDING)));
    const verdict = (await repository.listVerdicts({ projectId: PROJECT, caseId: item.caseId, source: "llm_judge", limit: 1 }))[0]!;
    const cached = await repository.createEvalRun({
      projectId: PROJECT, skillVersionId: SKILL_VERSION, trigger: "manual",
      items: [{ caseId: item.caseId, status: "completed", verdictId: verdict.id, resultLabel: "pass", cached: true }]
    });
    expect(cached.items[0]).toMatchObject({
      status: "completed", cached: true, verdictId: verdict.id, failureKind: null, notAttempted: false, observed: null
    });
    expect(verdict.observed).toEqual({ ...NOTHING, model: "mock-heuristic-v1" });
  });

  it("refuses provenance on a verdict no evaluator gave, and a score without an observation", async () => {
    const repository = new DemoRepository();
    const run = await oneItemRun(repository, "prov_parity");
    const payload = { kind: "binary" as const, pass: true, rationale: "ok" };
    await expect(repository.recordVerdict({
      projectId: PROJECT, caseId: run.items[0]!.caseId, source: "human", payload, observed: NOTHING
    })).rejects.toThrow(/Only an evaluator's verdict/);
    await expect(repository.recordVerdict({
      projectId: PROJECT, caseId: run.items[0]!.caseId, source: "llm_judge", skillVersionId: SKILL_VERSION, payload,
      evaluatorScore: { value: 0.9, kind: "self_reported_score" }
    })).rejects.toThrow(/needs the call's observation/);
  });
});

describe("a failed item's classification", () => {
  it("keeps a classified call failure's kind and what the call observed", async () => {
    const observed = { ...NOTHING, model: "claude-observed", requestId: "req_1" };
    const item = await runWith(throwing(new EvaluatorCallError("provider_rejected_request", "the provider answered 400", { physicalCall: true, status: 400, observed })));
    expect(item).toMatchObject({ status: "failed", failureKind: "provider_rejected_request", notAttempted: false, observed });
    expect(item.error).toMatch(/judge call failed \(provider_rejected_request\)/);
  });

  it("records only what the executor observed, never an error's own detail, as text a receipt can carry", async () => {
    const upstreamInBody = await runWith(throwing(new EvaluatorCallError("provider_unavailable", "upstream down", {
      physicalCall: true,
      status: 502,
      providerError: { type: null, code: "502", param: null, message: "upstream down", raw: null, upstreamProvider: "Fireworks" }
    })));
    expect(upstreamInBody).toMatchObject({ failureKind: "provider_unavailable", observed: NOTHING });
    const unsafe = await runWith(throwing(new EvaluatorCallError("provider_rejected_request", "rejected", {
      physicalCall: true,
      status: 400,
      observed: { ...NOTHING, model: "bad \ud800 model", requestId: "req_ok" }
    })));
    expect(unsafe.observed).toEqual({ ...NOTHING, requestId: "req_ok" });
  });

  it("records outcome unknown when a dispatched call fails without a known kind", async () => {
    const item = await runWith(throwing(Object.assign(new Error("socket hang up"), { status: 529 })));
    expect(item).toMatchObject({ status: "failed", failureKind: "outcome_unknown", observed: NOTHING });
  });

  it("marks a refusal before the call as not attempted, keeping the reason in its error", async () => {
    const item = await runWith(() => { throw new JudgeProviderUnavailableError("anthropic"); });
    expect(item).toMatchObject(NOT_ATTEMPTED);
    expect(item.error).toMatch(/anthropic/);
  });

  it("marks a request the executor refused to send as not attempted, though the call had started", async () => {
    const item = await runWith(throwing(new EvaluatorCallError("internal", "could not build the request", { physicalCall: false })));
    expect(item).toMatchObject(NOT_ATTEMPTED);
    expect(item.error).toMatch(/refused before sending \(internal\)/);
  });

  it("classifies the inline walk's failures the same way", async () => {
    expect(await runInlineWith(() => { throw new JudgeProviderUnavailableError("anthropic"); })).toMatchObject(NOT_ATTEMPTED);
    const observed = { ...NOTHING, requestId: "req_inline" };
    expect(await runInlineWith(throwing(new EvaluatorCallError("provider_timeout", "timed out", { physicalCall: true, observed }))))
      .toMatchObject({ status: "failed", failureKind: "provider_timeout", notAttempted: false, observed });
    expect(await runInlineWith(throwing(new Error("socket hang up"))))
      .toMatchObject({ status: "failed", failureKind: "outcome_unknown", observed: NOTHING });
  });

  it("marks an item never taken up as not attempted, and an interrupted or unrecorded call as outcome unknown", async () => {
    const failed: FailEvalRunItemInputDb[] = [];
    const execution = (id: string, started: boolean, returned = false) => ({
      projectId: "p", evalRunId: "run", evalRunItemId: id, executionToken: `token_${id}`,
      providerCallStarted: started, providerCallReturned: returned
    });
    const repository = {
      listStaleEvalRunItemExecutions: async () => [execution("never", false), execution("interrupted", true), execution("returned", true, true)],
      failEvalRunItem: async (input: FailEvalRunItemInputDb) => { failed.push(input); }
    };
    await recoverStaleEvalRunItemExecutions(repository as never);
    expect(failed.map((input) => [input.evalRunItemId, input.failure])).toEqual([
      ["never", { state: "not_attempted" }],
      ["interrupted", { state: "failure", failureKind: "outcome_unknown", observed: NOTHING }],
      ["returned", { state: "failure", failureKind: "outcome_unknown", observed: NOTHING }]
    ]);
  });

  it("marks an item whose queue delivery ended before any claim as not attempted", async () => {
    const failed: FailEvalRunItemInputDb[] = [];
    const repository = {
      listStaleEvalRunItemExecutions: async () => [{
        projectId: "p", evalRunId: "run", evalRunItemId: "item", executionToken: null,
        providerCallStarted: false, providerCallReturned: false
      }],
      markEvalRunRunning: async () => {},
      getEvalRun: async () => ({ id: "run", status: "running", skillVersionId: SKILL_VERSION }),
      listPendingEvalRunItemDispatches: async () => [{ item: { id: "item", caseId: "case" }, jobId: "job_item" }],
      claimEvalRunItemRecovery: async () => true,
      failEvalRunItem: async (input: FailEvalRunItemInputDb) => { failed.push(input); }
    };
    const queue = { getJobState: async () => "failed" as const };
    await recoverStaleEvalRunItemExecutions(repository as never, queue as never);
    expect(failed.map((input) => input.failure)).toEqual([{ state: "not_attempted" }]);
  });

  it("marks a redelivered item whose call had started as outcome unknown", async () => {
    const failed: FailEvalRunItemInputDb[] = [];
    const repository = {
      claimEvalRunItemExecution: async () => ({ state: "outcome_unknown", executionToken: "token_prior", providerCallReturned: false }),
      failEvalRunItem: async (input: FailEvalRunItemInputDb) => { failed.push(input); }
    };
    await processEvalItemJob(repository as never, {
      projectId: PROJECT, evalRunId: "run", evalRunItemId: "item", caseId: "case", skillVersionId: SKILL_VERSION
    }, () => { throw new Error("the provider must not be built"); });
    expect(failed.map((input) => [input.executionToken, input.failure])).toEqual([
      ["token_prior", { state: "failure", failureKind: "outcome_unknown", observed: NOTHING }]
    ]);
  });

  it("never records not attempted once the call has started, unless the executor refused it", async () => {
    const repository = new DemoRepository();
    const run = await oneItemRun(repository, "prov_race");
    const target = { projectId: PROJECT, evalRunId: run.id, evalRunItemId: run.items[0]!.id, executionToken: "token_live" };
    expect(await repository.claimEvalRunItemExecution(target)).toMatchObject({ state: "claimed" });
    expect(await repository.beginEvalRunItemProviderCall(target)).toBe(true);

    // A sweep's stale snapshot said the call hadn't started.
    await repository.failEvalRunItem({ ...target, error: "stale snapshot", failure: { state: "not_attempted" } });
    expect((await repository.getEvalRunDetail(PROJECT, run.id))!.items[0]).toMatchObject({ status: "pending" });

    await repository.failEvalRunItem({ ...target, error: "refused", failure: { state: "not_attempted", executorRefused: true } });
    expect((await repository.getEvalRunDetail(PROJECT, run.id))!.items[0]).toMatchObject(NOT_ATTEMPTED);
  });
});
