import { EvaluatorCallError, type EvaluatorVerdict } from "@rubrist/audit/runtime";
import {
  TypedQuestionOutputSchema,
  payloadRationale,
  type ExecutionBinding,
  type SkillVersion,
  type TypedQuestion,
  type VerdictRecord
} from "@rubrist/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { buildFindings } from "../src/lib/findings.js";
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
import { processEvalItemJob } from "../src/workers/eval-run.js";
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

/** Stubs TypeSafe to answer P(pass) = `probability`, recording each request body. */
function stubTypeSafe(probability: number): Array<{ url: string; body: unknown }> {
  const sent: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { verdict: { type: "noul", noul: probability } },
      usage: { input_tokens: 120, output_tokens: 4 }
    }), { status: 200, headers: { "content-type": "application/json", "x-typesafe-request-id": "req_typed" } });
  });
  return sent;
}

const prompt = { id: "p", name: "p", kind: "unified" as const, content: JSON.stringify(QUESTION) };
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

  it("refuses, before any call, a typed binding without its question, and falls back only where the mock may stand in", () => {
    const sent = stubTypeSafe(0.9);
    let refusal: unknown = null;
    try {
      createJudgeProvider({ ...TYPED, typedQuestion: null }, { apiKey: "typesafe-test-key" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(EvaluatorCallError);
    expect(refusal).toMatchObject({ failureKind: "internal", physicalCall: false });
    // Without a TypeSafe key the strict factory refuses; the demo factory falls back to the mock.
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(() => createStrictJudgeProvider(TYPED)).toThrow(JudgeProviderUnavailableError);
      expect(createJudgeProvider(TYPED).name).toBe("mock");
    } finally {
      if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
    }
    expect(sent).toHaveLength(0);
  });
});

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
    const response = await app.request("/api/cases/case_exc_002/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationaleStatus: "not_provided" } })
    });
    expect(response.status).toBe(400);
    await expect(new DemoRepository().recordVerdict({
      projectId: PROJECT, caseId: "case_exc_002", source: "human", payload: { kind: "binary", pass: true, rationaleStatus: "not_provided" }
    })).rejects.toThrow(/Only an evaluator's verdict may state no rationale/);
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
  });
});
