import { describe, expect, it } from "vitest";
import { MockJudgeProvider } from "@coeval/audit/runtime";
import type { SkillVersion } from "@coeval/shared";
import { DemoRepository, type JudgeRunContext } from "../src/repository.js";
import { judgeAndRecord, processJudgeRunJob } from "../src/workers/judge.js";

const TRACE = { input: { question: "Refund within 30 days?" }, output: { answer: "Yes, within 30 days." } };

function skillVersion(overrides: Partial<SkillVersion>): SkillVersion {
  return {
    id: "skillv_kind",
    skillId: "skill_test",
    criterionVersionId: "criterionv_test",
    version: "1.0.0",
    status: "production",
    rubricMarkdown: "Rate the answer.",
    prompt: "Rate it.",
    modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 },
    outputSchema: { type: "object" },
    goldenSetAgreement: null,
    tooStrictCount: 0,
    tooLenientCount: 0,
    ambiguousCount: 0,
    knownLimitations: [],
    verdictKind: "binary",
    scalarRange: null,
    categoricalChoiceScores: null,
    rubricProvenance: "human-authored",
    regressionDatasetRevisionId: "revision_test",
    createdAt: new Date().toISOString(),
    approvedAt: null,
    ...overrides
  };
}

// DemoRepository always judges the binary demo skill; override the context so we
// can exercise the scalar + categorical dual-write paths end to end.
class KindRepository extends DemoRepository {
  constructor(
    private readonly version: SkillVersion,
    private readonly output: unknown = { answer: "a good answer" }
  ) {
    super();
  }
  async loadJudgeRunContext(): Promise<JudgeRunContext> {
    return {
      projectId: "proj_langsmith_support",
      caseId: "case_kind",
      skillVersion: this.version,
      trace: { id: "trace_kind", input: { q: "x" }, output: this.output, metadata: {} }
    };
  }
}

describe("judge worker → v2 verdicts (trust layer)", () => {
  it("records a source=llm_judge verdict pinned to the skill version", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "manual_trust",
      input: TRACE.input,
      output: TRACE.output,
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    await processJudgeRunJob(repository, {
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0"
    });

    const verdicts = await repository.listVerdicts({
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      source: "llm_judge",
      limit: 10
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.source).toBe("llm_judge");
    expect(verdicts[0]!.skillVersionId).not.toBeNull();
    expect(verdicts[0]!.payload.kind).toBe("binary");
  });

  it("dual-writes a scalar verdict (v2 payload + legacy judge_run) for a scalar skill", async () => {
    const repo = new KindRepository(skillVersion({ verdictKind: "scalar", scalarRange: [1, 5] }));
    const { run, payload } = await judgeAndRecord(repo, { projectId: "proj_langsmith_support", caseId: "case_kind", skillVersionId: "skillv_kind" }, new MockJudgeProvider());

    expect(payload.kind).toBe("scalar");
    if (payload.kind === "scalar") {
      expect(payload.range).toEqual([1, 5]);
      expect(payload.score).toBeGreaterThanOrEqual(1);
      expect(payload.score).toBeLessThanOrEqual(5);
    }
    // Legacy judge_run carries a normalized pass/fail projection.
    expect(["pass", "fail", "ambiguous"]).toContain(run.verdict);
    expect(run.providerMetadata).toEqual({
      model: "mock-heuristic-v1",
      requestId: null,
      responseId: null,
      systemFingerprint: null
    });

    const verdicts = await repo.listVerdicts({ projectId: "proj_langsmith_support", source: "llm_judge", limit: 10 });
    expect(verdicts[0]!.payload.kind).toBe("scalar");
  });

  it("persists explicit binary ambiguity and projects it to the legacy needs-review label", async () => {
    const repo = new KindRepository(
      skillVersion({}),
      { answer: "There is not enough context to classify this response." }
    );
    const { run, payload } = await judgeAndRecord(
      repo,
      { projectId: "proj_langsmith_support", caseId: "case_kind", skillVersionId: "skillv_kind" },
      new MockJudgeProvider()
    );

    expect(payload).toEqual({
      kind: "binary",
      label: "ambiguous",
      rationale: "Mock judge found missing or unclear context."
    });
    expect(run.verdict).toBe("ambiguous");
    expect(run.score).toBe(0.5);
  });

  it("records unavailable provider response identity as explicit nulls", async () => {
    const repo = new KindRepository(skillVersion({}));
    const provider = new class extends MockJudgeProvider {
      override async judgeStructured(input: Parameters<MockJudgeProvider["judgeStructured"]>[0]) {
        const { verdict, usage } = await super.judgeStructured(input);
        return { verdict, ...(usage ? { usage } : {}) };
      }
    }();

    const { run, providerMetadata } = await judgeAndRecord(
      repo,
      { projectId: "proj_langsmith_support", caseId: "case_kind", skillVersionId: "skillv_kind" },
      provider
    );

    expect(providerMetadata).toEqual({ model: null, requestId: null, responseId: null, systemFingerprint: null });
    expect(run.providerMetadata).toEqual(providerMetadata);
  });

  it("renders the rubric template before calling the structured judge provider", async () => {
    const repo = new KindRepository(skillVersion({
      rubricMarkdown: "# Review guide\n\nPass grounded answers.",
      prompt: "Before\n{{rubric_markdown}}\nAfter"
    }));
    let receivedPrompt = "";
    const provider = new class extends MockJudgeProvider {
      override async judgeStructured(input: Parameters<MockJudgeProvider["judgeStructured"]>[0]) {
        receivedPrompt = input.prompt.content;
        return super.judgeStructured(input);
      }
    }();

    await judgeAndRecord(
      repo,
      { projectId: "proj_langsmith_support", caseId: "case_kind", skillVersionId: "skillv_kind" },
      provider
    );

    expect(receivedPrompt).toBe("Before\n# Review guide\n\nPass grounded answers.\nAfter");
  });

  it("dual-writes a categorical verdict for a categorical skill", async () => {
    const repo = new KindRepository(
      skillVersion({ verdictKind: "categorical", categoricalChoiceScores: { great: 1, ok: 0.5, bad: 0 } })
    );
    const { payload } = await judgeAndRecord(repo, { projectId: "proj_langsmith_support", caseId: "case_kind", skillVersionId: "skillv_kind" }, new MockJudgeProvider());

    expect(payload.kind).toBe("categorical");
    if (payload.kind === "categorical") {
      expect(["great", "ok", "bad"]).toContain(payload.choice);
      expect(payload.choiceScores).toEqual({ great: 1, ok: 0.5, bad: 0 });
    }
  });

  it("appends a second llm_judge verdict when the same case is re-judged (self-consistency)", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "manual_rejudge",
      input: TRACE.input,
      output: TRACE.output,
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const job = { projectId: "proj_langsmith_support", caseId: imported.caseId, skillVersionId: "skillv_1_2_0" };
    await processJudgeRunJob(repository, job);
    await processJudgeRunJob(repository, job);

    const verdicts = await repository.listVerdicts({
      projectId: "proj_langsmith_support",
      caseId: imported.caseId,
      source: "llm_judge",
      limit: 10
    });
    expect(verdicts).toHaveLength(2);
  });
});
