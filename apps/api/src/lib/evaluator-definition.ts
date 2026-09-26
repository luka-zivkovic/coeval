import type { SkillVersion } from "@rubrist/shared";

// An evaluator version's definition text (ADR-0014 section 1). A prompted
// version has a rubric and a prompt; a typed-question version asks a question
// instead and has neither.

/** A prompted version's rubric and prompt; a typed-question version has none to give. */
export function promptedText(version: Pick<SkillVersion, "rubricMarkdown" | "prompt">): { rubricMarkdown: string; prompt: string } {
  if (version.rubricMarkdown === null || version.prompt === null) {
    throw new Error("A typed-question evaluator version has no rubric or prompt");
  }
  return { rubricMarkdown: version.rubricMarkdown, prompt: version.prompt };
}
