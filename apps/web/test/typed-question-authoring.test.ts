import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TYPED_QUESTION_DRAFT,
  typedQuestionDraftFrom,
  typedQuestionDraftProblems,
  typedQuestionFromDraft
} from "../src/lib/typed-question-draft.js";

vi.mock("@/components/rubrist", () => ({ Eyebrow: ({ children }: { children?: unknown }) => createElement("span", null, children as never) }));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children?: unknown }) => createElement("section", null, children as never),
  CardContent: ({ children }: { children?: unknown }) => createElement("div", null, children as never),
  CardDescription: ({ children }: { children?: unknown }) => createElement("p", null, children as never),
  CardHeader: ({ children }: { children?: unknown }) => createElement("header", null, children as never),
  CardTitle: ({ children }: { children?: unknown }) => createElement("h2", null, children as never)
}));

const { TypedQuestionView } = await import("../src/components/typed-question-view.js");
const { TypedQuestionCard } = await import("../src/screens/skill-edit/typed-question.js");

// Typed-question authoring (ADR-0014 section 5, Batch 8F): a question, what
// makes its answer true and false, and a threshold the author must choose.

const QUESTION = { type: "noul" as const, instructions: "Does the reply answer in the user's language?", criteria: { true: "It does.", false: "It doesn't." } };
const DRAFT = { instructions: QUESTION.instructions, trueCriterion: "It does.", falseCriterion: "It doesn't.", threshold: "0.62" };

describe("the typed-question draft", () => {
  it("round-trips a saved version's question and threshold", () => {
    expect(typedQuestionDraftFrom({ typedQuestion: QUESTION, decisionThreshold: 0.62 })).toEqual(DRAFT);
    expect(typedQuestionFromDraft(DRAFT)).toEqual({ typedQuestion: QUESTION, decisionThreshold: 0.62 });
    expect(typedQuestionDraftFrom({ typedQuestion: null, decisionThreshold: null })).toEqual(EMPTY_TYPED_QUESTION_DRAFT);
  });

  it("has no default threshold, and refuses one at or outside 0 and 1", () => {
    for (const threshold of ["", " ", "0", "1", "1.5", "-0.1", "abc"]) {
      expect(typedQuestionFromDraft({ ...DRAFT, threshold }), threshold).toBeNull();
      expect(typedQuestionDraftProblems({ ...DRAFT, threshold })).toEqual(["Choose a decision threshold above 0 and below 1, on nonsealed data."]);
    }
    expect(typedQuestionFromDraft({ ...DRAFT, threshold: "0.001" })?.decisionThreshold).toBe(0.001);
  });

  it("names each missing part of the question", () => {
    expect(typedQuestionDraftProblems(EMPTY_TYPED_QUESTION_DRAFT)).toEqual([
      "Write the question.",
      "Say what makes the answer true.",
      "Say what makes the answer false.",
      "Choose a decision threshold above 0 and below 1, on nonsealed data."
    ]);
    expect(typedQuestionFromDraft({ ...DRAFT, falseCriterion: "  " })).toBeNull();
    expect(typedQuestionDraftProblems(DRAFT)).toEqual([]);
  });

  it("refuses text the question contract rejects", () => {
    expect(typedQuestionFromDraft({ ...DRAFT, instructions: "Is it \ud800 grounded?" })).toBeNull();
  });
});

describe("the typed-question editor card", () => {
  it("asks for the question, both criteria, and a threshold with no default, listing what's missing", () => {
    const empty = renderToStaticMarkup(createElement(TypedQuestionCard, { draft: EMPTY_TYPED_QUESTION_DRAFT, setDraft: vi.fn() }));
    expect(empty).toContain("Typed question");
    expect(empty).toContain('placeholder="choose one"');
    expect(empty).toContain("Choose a decision threshold above 0 and below 1, on nonsealed data.");
    expect(empty).toContain("it never abstains and states no rationale");
    const complete = renderToStaticMarkup(createElement(TypedQuestionCard, { draft: DRAFT, setDraft: vi.fn() }));
    expect(complete).not.toContain("<li>");
    expect(complete).toContain('value="0.62"');
  });
});

describe("the typed-question view", () => {
  it("shows the question, its criteria, and the threshold that decides pass", () => {
    const html = renderToStaticMarkup(createElement(TypedQuestionView, { question: QUESTION, threshold: 0.62 }));
    expect(html).toContain("Typed question · answered by TypeSafe");
    expect(html).toContain("Does the reply answer in the user&#x27;s language?");
    expect(html).toContain("It doesn&#x27;t.");
    expect(html).toContain("pass when p ≥ 0.62");
    expect(html).toContain("it never abstains and states no rationale");
  });
});
