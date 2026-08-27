import { JudgePrompt, JudgePromptSchema } from "../schema.js";
import { DEFAULT_OUTPUT_SCHEMA } from "./default-output-schema.js";
import { DEFAULT_RUBRIC_TEMPLATE } from "./default-rubric-template.js";

export async function compileUnifiedSkill(prompts: JudgePrompt[]): Promise<JudgePrompt> {
  const template = DEFAULT_RUBRIC_TEMPLATE;
  const submittedCriteria = prompts
    .map((prompt, index) => {
      return [
        `## Submitted judge ${index + 1}: ${prompt.name}`,
        "",
        prompt.content.trim()
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const content = [
    template.trim(),
    "",
    "# Customer/team submitted judging prompts to merge",
    "",
    submittedCriteria,
    "",
    "# Output contract",
    "",
    "Return only JSON matching this schema:",
    "",
    "```json",
    JSON.stringify(DEFAULT_OUTPUT_SCHEMA, null, 2),
    "```",
    "",
    "When submitted prompts conflict, prefer the stricter interpretation only if the trace contains concrete evidence of customer-facing risk. Otherwise mark `ambiguous` and explain the conflict."
  ].join("\n");

  return JudgePromptSchema.parse({
    id: "unified-skill-v1",
    name: "Unified Skill v1",
    content,
    kind: "unified"
  });
}

export function compileRegressionDemoSkill(unifiedSkill: JudgePrompt): JudgePrompt {
  return JudgePromptSchema.parse({
    id: "regression-demo-overstrict",
    name: "Regression Demo: Over-strict Skill",
    kind: "regression-demo",
    content: `${unifiedSkill.content}\n\n# Regression demo edit\n\nFor this demonstration, be noticeably stricter: fail borderline cases, minor omissions, tone issues, and any answer that is not perfect. This simulates an unsafe skill edit that may regress the golden set.`
  });
}
