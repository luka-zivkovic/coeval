import { describe, expect, it } from "vitest";
import {
  EvaluatorCandidateCreateInputSchema,
  EvaluatorLifecycleActivateInputSchema,
  EvaluatorLifecycleEventSchema,
  JudgeRunJobSchema,
  MinimumVerdictOutputSchema,
  TypedQuestionOutputSchema,
  type EvaluatorExecutionContext,
  type EvaluatorLifecycleState
} from "@rubrist/shared";
import {
  evaluatorCandidateRequestDigest,
  evaluatorExecutionContextAllowsState,
  evaluatorLifecycleTransitionAllowed
} from "../src/lib/evaluator-lifecycle.js";
import { SEEDED_BINDING, bindingInput } from "./fixtures/execution-binding.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("evaluator lifecycle authority", () => {
  it("freezes the nonbranching state graph", () => {
    const states: EvaluatorLifecycleState[] = ["candidate", "active", "needs_review", "retired"];
    const allowed = new Set([
      "candidate:active",
      "candidate:retired",
      "active:needs_review",
      "active:retired",
      "needs_review:active",
      "needs_review:retired"
    ]);
    for (const from of states) {
      for (const to of states) {
        expect(evaluatorLifecycleTransitionAllowed(from, to), `${from}->${to}`)
          .toBe(allowed.has(`${from}:${to}`));
      }
    }
  });

  it("keeps candidate evidence contexts separate from implicit execution", () => {
    const contexts: EvaluatorExecutionContext[] = [
      "implicit_production", "manual_import", "scheduled_import", "suite_publication",
      "trace_test", "release_gate", "explicit_nonproduction_dataset",
      "governed_nonsealed_evaluation", "binary_calibration_evidence",
      "candidate_regression_evidence"
    ];
    const candidateContexts = new Set([
      "explicit_nonproduction_dataset", "governed_nonsealed_evaluation",
      "binary_calibration_evidence", "candidate_regression_evidence"
    ]);
    for (const context of contexts) {
      expect(evaluatorExecutionContextAllowsState(context, {
        state: "candidate",
        currentCalibrationAdmissibility: "not_applicable"
      }), context).toBe(candidateContexts.has(context));
      expect(evaluatorExecutionContextAllowsState(context, {
        state: "retired",
        currentCalibrationAdmissibility: "admissible"
      }), `${context}:retired`).toBe(false);
    }
    expect(evaluatorExecutionContextAllowsState("implicit_production", {
      state: "active",
      currentCalibrationAdmissibility: "admissible"
    })).toBe(true);
    expect(evaluatorExecutionContextAllowsState("implicit_production", {
      state: "active",
      currentCalibrationAdmissibility: "revoked"
    })).toBe(false);
  });

  it("canonicalizes candidate requests without their idempotency alias", () => {
    const input = EvaluatorCandidateCreateInputSchema.parse({
      criterionId: "criterion",
      criterionVersionId: "criterion-version",
      governedBatchId: "batch",
      expectedBatchDigest: digest,
      truthDatasetRevisionId: "truth",
      expectedTruthRevisionDigest: digest,
      expectedTruthContentDigest: digest,
      skillName: "Evaluator",
      skillDescription: "Exact governed candidate.",
      rubricMarkdown: "Return pass or fail.",
      prompt: "Judge the response.",
      executionBinding: bindingInput(SEEDED_BINDING, {
        provider: "openai",
        modelId: "gpt-4o-mini",
        modelVersion: "2024-07-18",
        reasoning: null,
        outputTokenLimit: null,
        verdictProtocol: "openai.structured-output/v1"
      }),
      outputSchema: MinimumVerdictOutputSchema,
      idempotencyKey: "first"
    });
    expect(evaluatorCandidateRequestDigest("project", input)).toBe(
      evaluatorCandidateRequestDigest("project", { ...input, idempotencyKey: "second" })
    );
  });

  it("takes a typed-question candidate's question and threshold in place of a rubric and prompt", () => {
    const base = {
      criterionId: "criterion",
      criterionVersionId: "criterion-version",
      governedBatchId: "batch",
      expectedBatchDigest: digest,
      truthDatasetRevisionId: "truth",
      expectedTruthRevisionDigest: digest,
      expectedTruthContentDigest: digest,
      skillName: "Evaluator",
      skillDescription: "Exact governed candidate.",
      idempotencyKey: "first"
    };
    const typed = {
      ...base,
      typedQuestion: { type: "noul", instructions: "Is it correct?", criteria: { true: "Correct.", false: "Incorrect." } },
      decisionThreshold: 0.6,
      executionBinding: {
        provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
        sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
        verdictProtocol: "typed-question/v1", routing: null
      }
    };
    const parsed = EvaluatorCandidateCreateInputSchema.parse(typed);
    expect(parsed.outputSchema).toEqual(TypedQuestionOutputSchema);
    // A parsed request parses again unchanged, and its digest ignores the idempotency alias.
    expect(EvaluatorCandidateCreateInputSchema.parse(parsed)).toEqual(parsed);
    expect(evaluatorCandidateRequestDigest("project", parsed)).toBe(evaluatorCandidateRequestDigest("project", { ...parsed, idempotencyKey: "second" }));
    // The threshold is part of the request.
    expect(evaluatorCandidateRequestDigest("project", parsed)).not.toBe(evaluatorCandidateRequestDigest("project", { ...parsed, decisionThreshold: 0.5 }));
    const { decisionThreshold: _threshold, ...noThreshold } = typed;
    for (const [name, input] of [
      ["typed with a rubric", { ...typed, rubricMarkdown: "Return pass or fail." }],
      ["typed without a threshold", noThreshold],
      ["prompted with a question", { ...base, rubricMarkdown: "r", prompt: "p", typedQuestion: typed.typedQuestion, executionBinding: bindingInput(SEEDED_BINDING) }]
    ] as const) {
      expect(EvaluatorCandidateCreateInputSchema.safeParse(input).success, name).toBe(false);
    }
  });

  it("rejects active-to-active activation and partial eval provenance", () => {
    expect(EvaluatorLifecycleActivateInputSchema.safeParse({
      expectedState: "active",
      expectedSequence: "2",
      expectedEventId: "event",
      expectedEventDigest: digest,
      calibrationArtifactId: "artifact",
      expectedCalibrationArtifactDigest: digest,
      expectedCalibrationEvidenceDigest: digest,
      regressionRunId: "run",
      expectedPriorActiveSkillVersionId: null,
      expectedPriorActiveEventId: null,
      expectedPriorActiveEventDigest: null,
      rationale: "No-op activation is forbidden.",
      idempotencyKey: "activation"
    }).success).toBe(false);
    expect(JudgeRunJobSchema.safeParse({
      projectId: "project",
      caseId: "case",
      evalRunId: "run"
    }).success).toBe(false);
  });

  it("rejects a system-authored activation even when every other field is well shaped",()=>{
    expect(EvaluatorLifecycleEventSchema.safeParse({
      id:"event",contractVersion:"rubrist/evaluator-lifecycle-event/v1",
      lifecycleId:"lifecycle",projectId:"project",criterionId:"criterion",skillVersionId:"version",
      sequence:"2",transition:"activated",state:"active",predecessorEventId:"prior",
      predecessorEventDigest:digest,activationBundleId:"bundle",activationEvidence:{
        calibrationArtifactId:"artifact",calibrationArtifactDigest:digest,
        calibrationEvidenceDigest:digest,regressionRunId:"regression",
        regressionDatasetRevisionId:"revision"
      },replacedSkillVersionId:null,actorUserId:null,actorSubjectId:null,actorRole:"system",
      reason:"Forged system activation.",idempotencyKey:"forged",requestDigest:digest,
      contentDigest:digest,occurredAt:"2026-08-24T00:00:00.000Z"
    }).success).toBe(false);
  });
});
