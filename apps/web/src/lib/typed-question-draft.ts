import { TypedQuestionSchema, type SkillVersion, type TypedQuestion } from "@rubrist/shared";

// The editor's typed-question fields (ADR-0014 section 5, Batch 8F): a binary
// `noul` question, what makes its answer true and false, and the decision
// threshold. The author chooses the threshold on nonsealed data; it has no
// default (founder decision 4).

export interface TypedQuestionDraft {
  instructions: string;
  trueCriterion: string;
  falseCriterion: string;
  /** Empty until the author chooses one. */
  threshold: string;
}

export const EMPTY_TYPED_QUESTION_DRAFT: TypedQuestionDraft = {
  instructions: "",
  trueCriterion: "",
  falseCriterion: "",
  threshold: ""
};

/** A saved version's question and threshold as editor fields; empty for a prompted version. */
export function typedQuestionDraftFrom(version: Pick<SkillVersion, "typedQuestion" | "decisionThreshold">): TypedQuestionDraft {
  if (version.typedQuestion === null) return EMPTY_TYPED_QUESTION_DRAFT;
  return {
    instructions: version.typedQuestion.instructions,
    trueCriterion: version.typedQuestion.criteria.true,
    falseCriterion: version.typedQuestion.criteria.false,
    threshold: version.decisionThreshold === null ? "" : String(version.decisionThreshold)
  };
}

function parsedThreshold(text: string): number | null {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
}

/** What the author still has to fix before the draft can be saved; empty when it can. */
export function typedQuestionDraftProblems(draft: TypedQuestionDraft): string[] {
  const problems: string[] = [];
  if (draft.instructions.trim() === "") problems.push("Write the question.");
  if (draft.trueCriterion.trim() === "") problems.push("Say what makes the answer true.");
  if (draft.falseCriterion.trim() === "") problems.push("Say what makes the answer false.");
  if (parsedThreshold(draft.threshold) === null) {
    problems.push("Choose a decision threshold above 0 and below 1, on nonsealed data.");
  }
  return problems;
}

/** The question and threshold a typed-question version saves, or `null` while the draft has problems. */
export function typedQuestionFromDraft(draft: TypedQuestionDraft): { typedQuestion: TypedQuestion; decisionThreshold: number } | null {
  const decisionThreshold = parsedThreshold(draft.threshold);
  const typedQuestion = TypedQuestionSchema.safeParse({
    type: "noul",
    instructions: draft.instructions,
    criteria: { true: draft.trueCriterion, false: draft.falseCriterion }
  });
  if (decisionThreshold === null || !typedQuestion.success || typedQuestionDraftProblems(draft).length > 0) return null;
  return { typedQuestion: typedQuestion.data, decisionThreshold };
}
