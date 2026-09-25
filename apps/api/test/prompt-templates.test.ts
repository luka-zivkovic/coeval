import { demoSkill, demoSkillPrevVersion } from "@rubrist/db";
import { defaultJudgePromptTemplate, renderJudgePromptContent } from "@rubrist/shared";
import { renderEvaluatorPrompt } from "@rubrist/audit/runtime";
import { describe, expect, it } from "vitest";

// The verdict protocol names the output mechanism and the evidence block
// (ADR-0014 section 3), so the default and seeded templates name neither.
// A judged agent's own tool calls are evidence and may be named.
const MECHANISM = /submit_verdict|verdict tool|structured verdict|trace_to_judge|\breturn (?:only |strictly )?(?:the )?json\b/i;

describe("prompt templates", () => {
  it("never name a verdict mechanism or an evidence block", () => {
    for (const subject of ["trace", "case", "captured agent-skill run"]) {
      expect(defaultJudgePromptTemplate(subject)).not.toMatch(MECHANISM);
    }
    for (const version of [demoSkill.currentVersion, demoSkillPrevVersion]) {
      expect(version?.prompt).not.toMatch(MECHANISM);
    }
  });

  it("render the same way in the judge runtime as in the shared contract", () => {
    const cases = [
      { rubricMarkdown: "Grounded answers pass.", prompt: defaultJudgePromptTemplate("trace") },
      { rubricMarkdown: "R", prompt: "A {{rubric_markdown}} B {{rubric_markdown}}" },
      { rubricMarkdown: "R", prompt: "No variable here." },
      { rubricMarkdown: "", prompt: "Judge." },
      { rubricMarkdown: "R", prompt: "{{unknown}} stays literal" }
    ];
    for (const input of cases) expect(renderEvaluatorPrompt(input)).toBe(renderJudgePromptContent(input));
  });
});
