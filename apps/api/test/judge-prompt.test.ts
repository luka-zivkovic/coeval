import { describe, expect, it } from "vitest";
import {
  compileJudgePrompt,
  promptReferencesRubric,
  renderJudgePromptContent,
  RUBRIC_TEMPLATE_VARIABLE
} from "@coeval/shared";

describe("renderJudgePromptContent", () => {
  it("substitutes {{rubric_markdown}} in place", () => {
    const content = renderJudgePromptContent({
      rubricMarkdown: "# Rubric\n\nPass good answers.",
      prompt: `Judge the trace.\n\n<review_guide>\n${RUBRIC_TEMPLATE_VARIABLE}\n</review_guide>`
    });
    expect(content).toBe("Judge the trace.\n\n<review_guide>\n# Rubric\n\nPass good answers.\n</review_guide>");
  });

  it("substitutes every occurrence", () => {
    const content = renderJudgePromptContent({
      rubricMarkdown: "R",
      prompt: `${RUBRIC_TEMPLATE_VARIABLE} and again ${RUBRIC_TEMPLATE_VARIABLE}`
    });
    expect(content).toBe("R and again R");
  });

  // Versions saved before templating existed must judge byte-identically.
  it("prepends the rubric when the prompt never references it", () => {
    const content = renderJudgePromptContent({
      rubricMarkdown: "# Rubric",
      prompt: "Judge the trace using pass/fail/ambiguous JSON output."
    });
    expect(content).toBe("# Rubric\n\nJudge the trace using pass/fail/ambiguous JSON output.");
  });

  it("does not treat rubric content as a template", () => {
    const content = renderJudgePromptContent({
      rubricMarkdown: `contains ${RUBRIC_TEMPLATE_VARIABLE} literally`,
      prompt: `<review_guide>${RUBRIC_TEMPLATE_VARIABLE}</review_guide>`
    });
    expect(content).toBe(`<review_guide>contains ${RUBRIC_TEMPLATE_VARIABLE} literally</review_guide>`);
  });
});

describe("promptReferencesRubric", () => {
  it("detects the variable", () => {
    expect(promptReferencesRubric(`a ${RUBRIC_TEMPLATE_VARIABLE} b`)).toBe(true);
    expect(promptReferencesRubric("no reference")).toBe(false);
  });
});

describe("compileJudgePrompt", () => {
  it("reports the legacy implicit-rubric fallback", () => {
    expect(compileJudgePrompt({ rubricMarkdown: "# Rubric", prompt: "Judge this." })).toEqual({
      content: "# Rubric\n\nJudge this.",
      rubricMode: "legacy-prepend",
      diagnostics: [{ code: "implicit-rubric" }]
    });
  });

  it("reports each unsupported variable once and leaves it literal", () => {
    const compiled = compileJudgePrompt({
      rubricMarkdown: "# Rubric",
      prompt: `${RUBRIC_TEMPLATE_VARIABLE}\n{{input}} {{input}} {{ conversation }}`
    });

    expect(compiled).toEqual({
      content: "# Rubric\n{{input}} {{input}} {{ conversation }}",
      rubricMode: "template",
      diagnostics: [
        { code: "unknown-variable", variable: "{{input}}" },
        { code: "unknown-variable", variable: "{{ conversation }}" }
      ]
    });
  });
});
