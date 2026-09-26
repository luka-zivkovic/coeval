import { EvaluatorCallError, type StructuredVerdict } from "@rubrist/audit/runtime";
import type { Queue, QueueJob, QueueName, QueueSendOptions } from "@rubrist/queue";
import type { EvalItemJob } from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import { JudgeProviderUnavailableError, createStrictJudgeProvider } from "../src/lib/judge-provider.js";
import { DemoRepository } from "../src/repository.js";
import type { FailEvalRunItemInputDb } from "../src/repository/contracts.js";
import { processEvalItemJob, processEvalRunJob, recoverStaleEvalRunItemExecutions, registerEvalRunWorkers } from "../src/workers/eval-run.js";
import { evaluatorScoreFor } from "../src/workers/judge.js";
import { MOCK_BINDING, runtimeVersion } from "./fixtures/execution-binding.js";

// Per-item provenance for evidence v2 (ADR-0014 section 6): an evaluator's
// verdict records what its call observed and its own score, and a failed item
// records its failure kind or that it was never attempted.

const PROJECT = "proj_langsmith_support";
const SKILL_VERSION = "skillv_1_2_0";
const NOTHING = { model: null, requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null };

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

async function runWith(provider: unknown, repository = new DemoRepository()) {
  const run = await oneItemRun(repository, `prov_${Math.random()}`);
  const queue = new WorkerQueue();
  await registerEvalRunWorkers(queue, repository, provider as never);
  await processEvalRunJob(repository, queue, { projectId: PROJECT, evalRunId: run.id });
  const job = queue.sent.find((sent) => sent.name === "eval.item")!.data as EvalItemJob;
  await queue.handlers.get("eval.item")!({ id: "job_1", data: job, retryCount: 0, retryLimit: 5 });
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
    expect(evaluatorScoreFor(binary, "anthropic.structured-output/v1")).toEqual({ value: 0.2, kind: "self_reported_score" });
    expect(evaluatorScoreFor({ kind: "scalar", score: 4, range: [1, 5], rationale: "r" }, "openai.forced-function/v1"))
      .toEqual({ value: 0.75, kind: "self_reported_score" });
    expect(evaluatorScoreFor({ kind: "categorical", choice: "ok", choiceScores: { ok: 0.5, bad: 0 }, rationale: "r" }, "mock/v1")).toBeNull();
    expect(evaluatorScoreFor(binary, "typed-question/v1")).toEqual({ value: 0.2, kind: "native_probability" });
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
});

describe("a failed item's classification", () => {
  it("keeps a classified call failure's kind and what the call observed", async () => {
    const observed = { ...NOTHING, model: "claude-observed", requestId: "req_1" };
    const item = await runWith(throwing(new EvaluatorCallError("provider_rejected_request", "the provider answered 400", { physicalCall: true, status: 400, observed })));
    expect(item).toMatchObject({ status: "failed", failureKind: "provider_rejected_request", notAttempted: false, observed });
    expect(item.error).toMatch(/judge call failed \(provider_rejected_request\)/);
  });

  it("records outcome unknown when a dispatched call fails without a known kind", async () => {
    const item = await runWith(throwing(Object.assign(new Error("socket hang up"), { status: 529 })));
    expect(item).toMatchObject({ status: "failed", failureKind: "outcome_unknown", observed: NOTHING });
  });

  it("classifies a refusal before any call by its own kind, with nothing observed", async () => {
    const item = await runWith(() => { throw new JudgeProviderUnavailableError("anthropic"); });
    expect(item).toMatchObject({ status: "failed", failureKind: "provider_unavailable", notAttempted: false, observed: NOTHING });
  });

  it("marks an item never taken up as not attempted, and an interrupted call as outcome unknown", async () => {
    const failed: FailEvalRunItemInputDb[] = [];
    const execution = (id: string, started: boolean) => ({
      projectId: "p", evalRunId: "run", evalRunItemId: id, executionToken: `token_${id}`,
      providerCallStarted: started, providerCallReturned: false
    });
    const repository = {
      listStaleEvalRunItemExecutions: async () => [execution("never", false), execution("interrupted", true)],
      failEvalRunItem: async (input: FailEvalRunItemInputDb) => { failed.push(input); }
    };
    await recoverStaleEvalRunItemExecutions(repository as never);
    expect(failed.map((input) => [input.evalRunItemId, input.failure])).toEqual([
      ["never", { state: "not_attempted" }],
      ["interrupted", { state: "failure", failureKind: "outcome_unknown", observed: NOTHING }]
    ]);
  });
});
