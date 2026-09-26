import { typedQuestionText } from "@rubrist/audit/runtime";
import { renderJudgePromptContent, type SkillVersion } from "@rubrist/shared";

// An evaluator version's definition text (ADR-0014 section 1). A prompted
// version has a rubric and a prompt; a typed-question version asks a question
// instead and has neither.

/** A prompted version's rubric and prompt; a typed-question version has none to give. */
export function promptedText(version: Pick<SkillVersion, "rubricMarkdown" | "prompt">): { rubricMarkdown: string; prompt: string } {
  if (version.rubricMarkdown === null || version.prompt === null) {
    throw new Error("This evaluator version has no rubric and prompt to judge with");
  }
  return { rubricMarkdown: version.rubricMarkdown, prompt: version.prompt };
}

/**
 * What a judge request records as its prompt: a prompted version's rendered
 * prompt, or a typed-question version's question exactly as typed-question/v1
 * sends it, which is what that model is asked about the trace.
 */
export function judgePromptContent(version: Pick<SkillVersion, "rubricMarkdown" | "prompt" | "typedQuestion">): string {
  return version.typedQuestion !== null ? typedQuestionText(version.typedQuestion) : renderJudgePromptContent(promptedText(version));
}
