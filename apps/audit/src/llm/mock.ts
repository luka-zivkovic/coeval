import { JudgeProvider, StructuredJudgeResult } from "./provider.js";
import { JudgePrompt, JudgeVerdict, JudgeVerdictSchema, Trace } from "../schema.js";
import { StructuredVerdict, StructuredVerdictSchema, VerdictSpec } from "./verdict-spec.js";

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// deterministic usage so spend plumbing is testable without a provider.
const MOCK_USAGE = { inputTokens: 100, outputTokens: 20 };
const MOCK_PROVIDER_METADATA = { model: "mock-heuristic-v1", requestId: null, responseId: null, systemFingerprint: null };

const FAIL_TERMS = ["incorrect", "wrong", "failed", "failure", "error", "unsafe", "hallucinated", "bad"];
const AMBIGUOUS_TERMS = ["ambiguous", "unclear", "unknown", "not enough context", "unjudgeable"];
const BORDERLINE_TERMS = ["minor", "partial", "maybe", "borderline", "warning"];
const STRICT_PROMPT_TERMS = ["noticeably stricter", "fail borderline", "require perfect", "not perfect", "minor omissions"];

export class MockJudgeProvider implements JudgeProvider {
  readonly name = "mock";
  readonly modelName = "mock-heuristic-v1";

  async judge(input: Parameters<JudgeProvider["judge"]>[0]): Promise<JudgeVerdict> {
    // Steps join the scan so a trajectory whose failure lives inside a step
    // is judged fail like any other fail-term content (M2 T3).
    const text = stringifyUnknown({ input: input.trace.input, output: input.trace.output, metadata: input.trace.metadata, steps: input.trace.steps }).toLowerCase();
    const prompt = input.prompt.content.toLowerCase();
    const isRegressionDemo = input.prompt.kind === "regression-demo" || STRICT_PROMPT_TERMS.some((term) => prompt.includes(term));

    let label: JudgeVerdict["label"] = "pass";
    let score = 0.92;
    let reason = "Mock judge found no obvious quality issue.";
    let confidence = 0.82;

    if (AMBIGUOUS_TERMS.some((term) => text.includes(term))) {
      label = "ambiguous";
      score = 0.5;
      reason = "Mock judge found missing or unclear context.";
      confidence = 0.62;
    }

    if (FAIL_TERMS.some((term) => text.includes(term))) {
      label = "fail";
      score = 0.18;
      reason = "Mock judge found language indicating an incorrect or risky output.";
      confidence = 0.86;
    }

    if (isRegressionDemo && label === "pass" && BORDERLINE_TERMS.some((term) => text.includes(term))) {
      label = "fail";
      score = 0.38;
      reason = "Regression demo skill is over-strict on a borderline case.";
      confidence = 0.7;
    }

    return JudgeVerdictSchema.parse({
      label,
      score,
      reason,
      confidence,
      failureCategory: label === "fail" ? "mock_quality_signal" : undefined,
      expectedBehavior: label === "fail" ? "Output should satisfy the user without correctness or safety risk." : undefined
    });
  }

  // Verdict-kind-aware mock: run the label heuristic, then project it onto the
  // requested kind so demo mode renders a non-trivial verdict of every shape.
  async judgeStructured(input: { prompt: JudgePrompt; trace: Trace; spec: VerdictSpec }): Promise<StructuredJudgeResult> {
    const base = await this.judge({ prompt: input.prompt, trace: input.trace, outputSchema: {} });
    const rationale = base.reason;
    const spec = input.spec;
    // Deterministic failingStep for tests (M2 T3): on a fail verdict over a
    // trajectory, name the first step whose content carries a fail term;
    // omit when none does (mirrors the real judge's "otherwise omit").
    const failingStep = (() => {
      if (base.label !== "fail" || !Array.isArray(input.trace.steps)) return undefined;
      const index = input.trace.steps.findIndex((step) =>
        FAIL_TERMS.some((term) => stringifyUnknown(step).toLowerCase().includes(term))
      );
      return index === -1 ? undefined : index;
    })();
    const withStep = failingStep !== undefined ? { failingStep } : {};

    if (spec.verdictKind === "scalar") {
      const [min, max] = spec.scalarRange ?? [0, 1];
      const score = min + base.score * (max - min);
      return { verdict: StructuredVerdictSchema.parse({ kind: "scalar", score, range: [min, max], rationale, ...withStep }), usage: MOCK_USAGE, providerMetadata: MOCK_PROVIDER_METADATA };
    }

    if (spec.verdictKind === "categorical") {
      const entries = Object.entries(spec.categoricalChoiceScores ?? {});
      // Pass → highest-scoring choice; fail/ambiguous → lowest-scoring choice.
      const sorted = entries.sort((a, b) => a[1] - b[1]);
      const pick = base.label === "pass" ? sorted[sorted.length - 1] : sorted[0];
      const choice = pick ? pick[0] : entries[0]?.[0] ?? "unknown";
      return {
        verdict: StructuredVerdictSchema.parse({
          kind: "categorical",
          choice,
          choiceScores: spec.categoricalChoiceScores ?? {},
          rationale,
          ...withStep
        }),
        usage: MOCK_USAGE,
        providerMetadata: MOCK_PROVIDER_METADATA
      };
    }

    return {
      verdict: StructuredVerdictSchema.parse({
        kind: "binary",
        label: base.label,
        score: base.score,
        rationale,
        ...withStep
      }),
      usage: MOCK_USAGE,
      providerMetadata: MOCK_PROVIDER_METADATA
    };
  }
}
