import { EvaluatorCallError, type EvaluatorVerdict } from "@rubrist/audit/runtime";
import {
  TypedQuestionOutputSchema,
  payloadRationale,
  type ExecutionBinding,
  type SkillVersion,
  type TypedQuestion,
  type VerdictRecord
} from "@rubrist/shared";
import type { Queue, QueueJob, QueueName, QueueSendOptions } from "@rubrist/queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { buildAssessmentReceiptV2 } from "../src/lib/assessment-receipt-v2.js";
import { contentDigest } from "../src/lib/canonical-json.js";
import { buildFindings, latestDiscreteVerdictByCase } from "../src/lib/findings.js";
import {
  JudgeProviderUnavailableError,
  createJudgeProvider,
  createStrictJudgeProvider,
  structuredVerdictToLegacy,
  structuredVerdictToPayload
} from "../src/lib/judge-provider.js";
import { DemoRepository } from "../src/repository.js";
import type { JudgeRunContext } from "../src/repository/contracts.js";
import { runGoldenSetRegression } from "../src/repository/golden-helpers.js";
import { processEvalItemJob, registerEvalRunWorkers } from "../src/workers/eval-run.js";
import { typedQuestionText } from "@rubrist/audit/runtime";
import { runtimeVersion } from "./fixtures/execution-binding.js";

// A typed-question evaluator (ADR-0014 section 5) judged through the runtime:
// its verdict is pass or fail on its threshold, its probability is the
// evaluator's native score, and it states no rationale anywhere a verdict is
// recorded or shown.

const PROJECT = "proj_langsmith_support";
const SKILL_VERSION = "skillv_1_2_0";
const JEV: ExecutionBinding = {
  provider: "typesafe",
  endpoint: { kind: "managed" },
  modelId: "jev-1.13.0",
  modelVersion: "jev-1.13.0",
  sampling: { temperature: null, topP: null },
  reasoning: null,
  outputTokenLimit: null,
  verdictProtocol: "typed-question/v1",
  routing: null
};
const QUESTION: TypedQuestion = {
  type: "noul",
  instructions: "Is the answer grounded in the refund policy?",
  criteria: { true: "The answer follows the policy.", false: "The answer contradicts or ignores the policy." }
};
const TYPED = runtimeVersion(JEV, { rubricMarkdown: null, prompt: null, typedQuestion: QUESTION, decisionThreshold: 0.6 });
const TRACE = { id: "trace_typed", input: { question: "Can I get a refund?" }, output: { answer: "Yes, within 30 days." }, metadata: {} };

/** Stubs TypeSafe to answer P(pass) = `probability`, recording each request's body and credential. */
function stubTypeSafe(probability: number): Array<{ url: string; body: unknown; authorization: string | undefined }> {
  const sent: Array<{ url: string; body: unknown; authorization: string | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { verdict: { type: "noul", noul: probability } },
      usage: { input_tokens: 120, output_tokens: 4 }
    }), { status: 200, headers: { "content-type": "application/json", "x-typesafe-request-id": "req_typed" } });
  });
  return sent;
}

const prompt = { id: "p", name: "p", kind: "unified" as const, content: typedQuestionText(QUESTION) };
const binarySpec = { verdictKind: "binary" as const, scalarRange: null, categoricalChoiceScores: null };

afterEach(() => vi.unstubAllGlobals());

describe("a typed-question version's provider", () => {
  it("asks its question through TypeSafe and returns a typed-question verdict", async () => {
    const sent = stubTypeSafe(0.83);
    const result = await createStrictJudgeProvider(TYPED, { apiKey: "typesafe-test-key" }).judgeStructured({ prompt, trace: TRACE, spec: binarySpec });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent[0]!.body).toMatchObject({ questions: { verdict: QUESTION }, model: "jev-1.13.0" });
    expect(result.verdict).toEqual({ kind: "typed-question", label: "pass", probability: 0.83, threshold: 0.6, rationaleStatus: "not_provided" });
    expect(result.observed).toMatchObject({ model: "jev-1.13.0", requestId: "req_typed" });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 4 });
  });

  it("records the verdict as pass or fail with no rationale, and scores it by its probability", () => {
    const fail: EvaluatorVerdict = { kind: "typed-question", label: "fail", probability: 0.2, threshold: 0.6, rationaleStatus: "not_provided" };
    expect(structuredVerdictToPayload(fail)).toEqual({ kind: "binary", pass: false, rationaleStatus: "not_provided" });
    expect(structuredVerdictToLegacy(fail)).toEqual({ label: "fail", score: 0.2, confidence: 0.8 });
    expect(payloadRationale(structuredVerdictToPayload(fail))).toBeNull();
  });

  it("refuses, before any call, a definition that doesn't match its protocol", () => {
    const sent = stubTypeSafe(0.9);
    const refusal = (version: typeof TYPED) => {
      try {
        createJudgeProvider(version, { apiKey: "typesafe-test-key" });
      } catch (error) {
        return error;
      }
      return null;
    };
    for (const version of [
      { ...TYPED, typedQuestion: null },
      { ...runtimeVersion(JEV), executionBinding: { ...JEV, provider: "anthropic" as const, verdictProtocol: "anthropic.structured-output/v1" as const, outputTokenLimit: 100 }, typedQuestion: QUESTION, decisionThreshold: 0.6 }
    ]) {
      const error = refusal(version);
      expect(error).toBeInstanceOf(EvaluatorCallError);
      expect(error).toMatchObject({ failureKind: "internal", physicalCall: false });
    }
    expect(sent).toHaveLength(0);
  });

  it("without a TypeSafe key, refuses on strict paths and stands in with a typed-question mock in the demo", async () => {
    const sent = stubTypeSafe(0.9);
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(() => createStrictJudgeProvider(TYPED)).toThrow(JudgeProviderUnavailableError);
    const demo = createJudgeProvider(TYPED);
    expect(demo.name).toBe("mock");
    const result = await demo.judgeStructured({ prompt, trace: TRACE, spec: binarySpec });
    // The stand-in keeps the typed-question shape and observes no call, so it is never evidence.
    expect(result.verdict).toMatchObject({ kind: "typed-question", threshold: 0.6, rationaleStatus: "not_provided" });
    expect(["pass", "fail"]).toContain((result.verdict as { label: string }).label);
    expect(result.observed).toBeUndefined();
    expect(sent).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});

type WorkHandler = (job: QueueJob<object>) => Promise<void>;
/** A queue that keeps its handlers, so a test can run one job through the worker. */
class WorkerQueue implements Queue {
  readonly handlers = new Map<QueueName, WorkHandler>();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(name: QueueName, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    this.handlers.set(name, handler as WorkHandler);
  }
  async send<T extends object>(_name: QueueName, _data: T, _options?: QueueSendOptions): Promise<string> {
    return "job";
  }
}

/** The demo repository, with its current version rewritten as a typed-question evaluator. */
class TypedRepository extends DemoRepository {
  override async loadJudgeRunContext(job: Parameters<DemoRepository["loadJudgeRunContext"]>[0]): Promise<JudgeRunContext> {
    const context = await super.loadJudgeRunContext(job);
    return {
      ...context,
      skillVersion: {
        ...context.skillVersion,
        ...TYPED,
        outputSchema: TypedQuestionOutputSchema as unknown as SkillVersion["outputSchema"],
        verdictKind: "binary",
        scalarRange: null,
        categoricalChoiceScores: null
      }
    };
  }
}

describe("a typed-question verdict through the eval worker", () => {
  it("is recorded with its native score and observation, and the judge run states no reasoning", async () => {
    stubTypeSafe(0.31);
    const repository = new TypedRepository();
    const imported = await repository.importTrace(PROJECT, "manual", {
      sourceTraceId: "typed_worker", input: TRACE.input, output: TRACE.output, metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const run = await repository.createEvalRun({ projectId: PROJECT, skillVersionId: SKILL_VERSION, trigger: "manual", items: [{ caseId: imported.caseId }] });
    const item = run.items[0]!;
    await processEvalItemJob(repository, {
      projectId: PROJECT, evalRunId: run.id, evalRunItemId: item.id, caseId: item.caseId, skillVersionId: SKILL_VERSION
    }, (version) => createStrictJudgeProvider(version, { apiKey: "typesafe-test-key" }));

    const verdict = (await repository.listVerdicts({ projectId: PROJECT, caseId: item.caseId, source: "llm_judge", limit: 1 }))[0]!;
    expect(verdict.payload).toEqual({ kind: "binary", pass: false, rationaleStatus: "not_provided" });
    expect(verdict.evaluatorScore).toEqual({ value: 0.31, kind: "native_probability" });
    expect(verdict.observed).toMatchObject({ model: "jev-1.13.0", requestId: "req_typed" });
    const detail = await repository.getEvalRunDetail(PROJECT, run.id);
    expect(detail!.items[0]).toMatchObject({ status: "completed", verdictId: verdict.id, resultLabel: "fail" });
    const caseDetail = await repository.getCaseDetail(PROJECT, item.caseId);
    expect(caseDetail?.judgeRun).toMatchObject({ verdict: "fail", reasoning: null });
  });
});

describe("a typed-question item's credential and refusals", () => {
  async function oneItem(repository: DemoRepository, sourceTraceId: string) {
    const imported = await repository.importTrace(PROJECT, "manual", {
      sourceTraceId, input: TRACE.input, output: TRACE.output, metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const run = await repository.createEvalRun({ projectId: PROJECT, skillVersionId: SKILL_VERSION, trigger: "manual", items: [{ caseId: imported.caseId }] });
    const item = run.items[0]!;
    return { run, job: { projectId: PROJECT, evalRunId: run.id, evalRunItemId: item.id, caseId: item.caseId, skillVersionId: SKILL_VERSION } };
  }

  it("is judged with the project's stored TypeSafe key over the platform's", async () => {
    const sent = stubTypeSafe(0.7);
    vi.stubEnv("TYPESAFE_API_KEY", "typesafe-platform-key");
    const repository = new TypedRepository();
    await repository.setJudgeProviderKey(PROJECT, "typesafe", "typesafe-project-key-1234");
    const { run, job } = await oneItem(repository, "typed_project_key");
    await processEvalItemJob(repository, job, createStrictJudgeProvider);
    expect(sent.map((request) => request.authorization)).toEqual(["Bearer typesafe-project-key-1234"]);
    expect((await repository.getEvalRunDetail(PROJECT, run.id))!.items[0]).toMatchObject({ status: "completed", resultLabel: "pass" });
    vi.unstubAllEnvs();
  });

  it("is recorded as never attempted when its credential is refused before the call", async () => {
    const sent = stubTypeSafe(0.7);
    const repository = new TypedRepository();
    const { run, job } = await oneItem(repository, "typed_refused");
    // Through the queue worker, which records a permanent failure on the item.
    const queue = new WorkerQueue();
    await registerEvalRunWorkers(queue, repository, (version) => createStrictJudgeProvider(version, { apiKey: "not header text" }));
    await queue.handlers.get("eval.item")!({ id: "job_typed", data: job, retryCount: 0, retryLimit: 5 });
    expect((await repository.getEvalRunDetail(PROJECT, run.id))!.items[0]).toMatchObject({ status: "failed", failureKind: null, notAttempted: true, observed: null });
    expect(sent).toHaveLength(0);
  });
});

describe("a typed-question release receipt", () => {
  it("carries each item's outcome and native score, and no rationale", async () => {
    const repository = new DemoRepository();
    const base = (await repository.getSkillVersion(PROJECT, SKILL_VERSION))!;
    const version: SkillVersion = {
      ...base, ...TYPED, outputSchema: TypedQuestionOutputSchema as unknown as SkillVersion["outputSchema"],
      verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null
    };
    const created = await repository.createEvalRun({
      projectId: PROJECT, skillVersionId: SKILL_VERSION, trigger: "release_evidence",
      items: ["a", "b"].map((id) => ({ caseId: `case_${id}`, clientItemId: id, contentDigest: contentDigest({ q: id }, { a: id }) }))
    });
    const labels = ["pass", "fail"] as const;
    const run = {
      ...created, status: "completed" as const, completedItems: 2,
      items: created.items.map((item, index) => ({ ...item, status: "completed" as const, verdictId: `v_${item.clientItemId}`, resultLabel: labels[index]! }))
    };
    const verdicts = new Map(run.items.map((item, index): [string, VerdictRecord] => [item.verdictId, {
      id: item.verdictId, projectId: PROJECT, caseId: item.caseId, source: "llm_judge", skillVersionId: SKILL_VERSION,
      actorUserId: null, externalRunId: null, createdAt: "2026-09-26T00:00:00.000Z",
      payload: { kind: "binary", pass: labels[index] === "pass", rationaleStatus: "not_provided" },
      observed: { model: "jev-1.13.0", requestId: `req_${index}`, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null },
      evaluatorScore: { value: labels[index] === "pass" ? 0.8 : 0.2, kind: "native_probability" }
    }]));
    const receipt = buildAssessmentReceiptV2({ run: { ...run, spend: created.spend }, skillVersion: version, verdicts });
    expect(receipt.status).toBe("complete");
    expect(receipt.items.map((item) => [item.result, item.evaluatorScore])).toEqual([
      [{ state: "outcome", outcome: "pass" }, { value: 0.8, kind: "native_probability" }],
      [{ state: "outcome", outcome: "fail" }, { value: 0.2, kind: "native_probability" }]
    ]);
    expect(JSON.stringify(receipt)).not.toContain("not_provided");
  });
});

describe("the regression gate on a typed-question version", () => {
  it("compares its labels and records no rationale", async () => {
    stubTypeSafe(0.9);
    const version = {
      ...(await new DemoRepository().getSkillVersion(PROJECT, SKILL_VERSION))!,
      ...TYPED,
      outputSchema: TypedQuestionOutputSchema as unknown as SkillVersion["outputSchema"]
    };
    const regression = await runGoldenSetRegression({
      skillVersion: version,
      goldenSet: [{
        id: "golden_typed", caseId: "case_typed", traceId: TRACE.id, agreedLabel: "fail", reason: "Refund outside the window.",
        promotedBy: "owner", promotedAt: "2026-09-01T00:00:00.000Z", sourceSkillVersionId: SKILL_VERSION, criterionVersionId: "criterionv_1"
      }],
      traces: new Map([["case_typed", TRACE]]),
      judgeProvider: createStrictJudgeProvider(version, { apiKey: "typesafe-test-key" })
    });
    expect(regression.cases).toEqual([expect.objectContaining({ newLabel: "pass", change: "regress", rationale: null })]);
  });
});

describe("where a verdict states no rationale", () => {
  it("is never a person's verdict", async () => {
    const app = createApp(new DemoRepository());
    for (const route of ["verdicts", "adjudicate"]) {
      const response = await app.request(`/api/cases/case_exc_002/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { kind: "binary", pass: true, rationaleStatus: "not_provided" } })
      });
      expect(response.status, route).toBe(400);
    }
    await expect(new DemoRepository().recordVerdict({
      projectId: PROJECT, caseId: "case_exc_002", source: "human", payload: { kind: "binary", pass: true, rationaleStatus: "not_provided" }
    })).rejects.toThrow(/Only an evaluator's verdict may state no rationale/);
  });

  it("is exported as an empty rationale marked not provided", async () => {
    const repository = new DemoRepository();
    await repository.recordVerdict({
      projectId: PROJECT, caseId: "case_exc_002", source: "llm_judge", skillVersionId: SKILL_VERSION,
      payload: { kind: "binary", pass: false, rationaleStatus: "not_provided" },
      observed: { model: "jev-1.13.0", requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null },
      evaluatorScore: { value: 0.31, kind: "native_probability" }
    });
    const csv = await (await createApp(repository).request("/api/projects/verdicts/export?format=csv&source=llm_judge")).text();
    expect(csv.split("\n")[0]).toContain(",rationale,rationale_status,");
    expect(csv).toContain(",binary,false,,not_provided,");
  });

  it("forms no failure cluster, and reads back as a null rationale", () => {
    const typedFail: VerdictRecord = {
      id: "verdict_typed", projectId: PROJECT, caseId: "case_typed", skillVersionId: SKILL_VERSION, source: "llm_judge",
      actorUserId: null, payload: { kind: "binary", pass: false, rationaleStatus: "not_provided" }, externalRunId: null,
      createdAt: "2026-09-02T00:00:00.000Z"
    };
    const findings = buildFindings({
      generatedAt: "2026-09-03T00:00:00.000Z",
      since: null,
      verdicts: [typedFail],
      disagreements: { comparedCases: 0, disagreedCases: 0, resolvedCases: 0, cases: [] },
      golden: [],
      cases: []
    });
    expect(findings.failureClusters).toEqual([]);
    expect(latestDiscreteVerdictByCase([typedFail], ["llm_judge"]).get("case_typed")).toMatchObject({ label: "fail", rationale: null });
  });
});
