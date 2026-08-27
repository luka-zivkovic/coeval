import { describe, expect, it } from "vitest";
import type { TracePayload } from "@coeval/shared";
import {
  conversationTurns,
  correctionVerdictPayload,
  createManualTraceTestInput,
  defaultSourceSelection,
  intentForVerdict,
  manualFields
} from "../src/lib/trace-test-flow.js";

const trace: TracePayload = {
  id: "trace_refund",
  input: {
    messages: [
      { role: "system", content: "Follow refund policy." },
      { role: "user", content: "Can I cancel and get a refund?" }
    ]
  },
  output: {
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Your refund is guaranteed." }] }
    ]
  },
  metadata: {},
  steps: [{ name: "policy lookup", input: "refund", output: "eligibility unknown" }]
};

describe("manual trace-to-test flow", () => {
  it("normalizes a real conversation and pins the selected response path", () => {
    const turns = conversationTurns(trace);
    expect(turns.map((turn) => [turn.role, turn.body])).toEqual([
      ["system", "Follow refund policy."],
      ["user", "Can I cancel and get a refund?"],
      ["assistant", "Your refund is guaranteed."]
    ]);
    expect(defaultSourceSelection(turns)).toEqual({
      responsePath: ["output", "messages", 0],
      turnIndexes: [0, 1, 2]
    });
  });

  it("creates a human-authored prevent draft without exposing checker configuration", () => {
    const turns = conversationTurns(trace);
    const source = defaultSourceSelection(turns);
    const fields = manualFields({
      turns,
      selectedTurnIndexes: source.turnIndexes,
      responsePath: source.responsePath,
      desiredBehavior: "Check eligibility before promising a refund.",
      job: "response"
    });
    fields.mustDo = "Check eligibility\nExplain the next step";
    fields.mustAvoid = "Guarantee a refund";

    const draft = createManualTraceTestInput({
      sourceCaseId: "case_refund",
      sourceScope: { ...source, stepIndexes: [0] },
      desiredBehavior: "Check eligibility before promising a refund.",
      job: "response",
      fields
    });

    expect(draft).toMatchObject({
      sourceCaseId: "case_refund",
      sourceScope: { responsePath: ["output", "messages", 0], turnIndexes: [0, 1, 2], stepIndexes: [0] },
      expectedBehavior: "Check eligibility before promising a refund.",
      mustDo: ["Check eligibility", "Explain the next step"],
      mustAvoid: ["Guarantee a refund"],
      goodExample: { text: "" },
      badExample: { text: "Your refund is guaranteed." },
      checker: { kind: "manual", label: "Manual behavior check", metadata: { journeyJob: "response" } },
      draftProvenance: { origin: "human", generatedFields: [], generator: null }
    });
  });

  it("preserves assisted checker choices, inferred context, and generator provenance", () => {
    const turns = conversationTurns(trace);
    const source = defaultSourceSelection(turns);
    const fields = manualFields({
      turns,
      selectedTurnIndexes: source.turnIndexes,
      responsePath: source.responsePath,
      desiredBehavior: "Check eligibility before promising a refund.",
      job: "response"
    });
    fields.checkerKind = "judge";
    fields.checkerLabel = "Refund behavior";
    fields.checkerRationale = "The requirement is observable in the answer.";

    const draft = createManualTraceTestInput({
      sourceCaseId: "case_refund",
      sourceScope: { ...source, stepIndexes: [] },
      desiredBehavior: "Check eligibility before promising a refund.",
      job: "response",
      fields,
      inferredContext: ["The customer's eligibility is not known."],
      draftProvenance: {
        origin: "mixed",
        generatedFields: ["scenario", "checker"],
        generator: { provider: "anthropic", model: "claude-sonnet", version: "2026-04-15" }
      }
    });

    expect(draft).toMatchObject({
      checker: {
        kind: "judge",
        label: "Refund behavior",
        metadata: {
          journeyJob: "response",
          recommendationRationale: "The requirement is observable in the answer.",
          inferredContext: ["The customer's eligibility is not known."]
        }
      },
      draftProvenance: {
        origin: "mixed",
        generator: { provider: "anthropic", model: "claude-sonnet", version: "2026-04-15" }
      }
    });
  });

  it("anchors a preserve draft on the observed response", () => {
    const turns = conversationTurns(trace);
    const source = defaultSourceSelection(turns);
    const fields = manualFields({
      turns,
      selectedTurnIndexes: source.turnIndexes,
      responsePath: source.responsePath,
      desiredBehavior: "Keep qualifying the refund outcome.",
      job: "preserve"
    });
    expect(fields.goodExample).toBe("Your refund is guaranteed.");
    expect(fields.badExample).toBe("");
  });

  it("keeps earlier assistant context but never invents a response selection", () => {
    const multiTurn = conversationTurns({
      id: "trace_multi",
      input: { messages: [
        { role: "user", content: "What is my refund window?" },
        { role: "assistant", content: "Which plan are you on?" },
        { role: "user", content: "Annual." }
      ] },
      output: { messages: [{ role: "assistant", content: "You have 30 days." }] },
      metadata: {}
    });
    const source = defaultSourceSelection(multiTurn);
    const fields = manualFields({
      turns: multiTurn,
      selectedTurnIndexes: source.turnIndexes,
      responsePath: source.responsePath,
      desiredBehavior: "Ask for necessary context before answering.",
      job: "preserve"
    });
    expect(fields.scenario).toContain("Which plan are you on?");
    expect(fields.scenario).not.toContain("You have 30 days.");

    const noAssistant = conversationTurns({
      id: "trace_tool_only",
      input: { messages: [{ role: "user", content: "Check status" }] },
      output: { messages: [{ role: "tool", content: "healthy" }] },
      metadata: {}
    });
    expect(defaultSourceSelection(noAssistant)).toEqual({ responsePath: [], turnIndexes: [0, 1] });
  });

  it("maps evaluator correction to the verdict ledger and never to a test input", () => {
    expect(correctionVerdictPayload("needs_review", "The policy evidence is incomplete.")).toEqual({
      kind: "categorical",
      choice: "ambiguous",
      choiceScores: { pass: 0, fail: 0, ambiguous: 1 },
      rationale: "The policy evidence is incomplete."
    });
    expect(intentForVerdict("fail")).toBe("prevent");
    expect(intentForVerdict("pass")).toBe("protect");
    expect(intentForVerdict("ambiguous")).toBe("make");
  });
});
