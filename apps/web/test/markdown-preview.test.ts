import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MarkdownPreview,
  normalizeReviewGuideMarkdown,
  safeMarkdownHref
} from "../src/components/markdown-preview.js";
import { verdictKindDescription } from "../src/lib/verdict-kind.js";

describe("MarkdownPreview", () => {
  it("renders common review-guide Markdown as semantic React elements", () => {
    const markdown = [
      "# Review guide",
      "",
      "Use **grounded** answers with `evidence`.",
      "",
      "- Cite the source",
      "- Explain the result",
      "",
      "| Label | Meaning |",
      "| --- | --- |",
      "| Pass | Meets the guide |",
      "",
      "[Read policy](https://example.com/policy)"
    ].join("\n");
    const html = renderToStaticMarkup(
      createElement(MarkdownPreview, { markdown })
    );

    expect(html).toContain("<h1");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).toContain("<ul");
    expect(html).toContain("<table");
    expect(html).toContain('href="https://example.com/policy"');
  });

  it("preserves escaped text, nested lists, table code spans, and relative links", () => {
    const html = renderToStaticMarkup(createElement(MarkdownPreview, { markdown: [
      "| Allowed output |",
      "| --- |",
      "| `pass|fail` |",
      "",
      "- Parent",
      "  - Nested",
      "",
      "Escaped: \\*literal\\* and identifier foo_bar_baz.",
      "",
      "[Local guide](../docs/review-guide)"
    ].join("\n") }));

    expect(html).toContain("pass|fail");
    expect((html.match(/<ul/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("*literal*");
    expect(html).not.toContain("<em>literal</em>");
    expect(html).toContain("foo_bar_baz");
    expect(html).not.toContain("<em>bar</em>");
    expect(html).toContain('href="../docs/review-guide"');
  });

  it("leaves literal table examples untouched and repairs tables inside containers", () => {
    const fenced = renderToStaticMarkup(createElement(MarkdownPreview, { markdown: [
      "```md",
      "| Allowed output |",
      "| --- |",
      "| `pass|fail` |",
      "```"
    ].join("\n") }));
    const quoted = renderToStaticMarkup(createElement(MarkdownPreview, { markdown: [
      "> | Allowed output |",
      "> | --- |",
      "> | `pass|fail` |"
    ].join("\n") }));
    const nested = renderToStaticMarkup(createElement(MarkdownPreview, { markdown: [
      "- Accepted formats:",
      "",
      "  | Allowed output |",
      "  | --- |",
      "  | `pass|fail` |"
    ].join("\n") }));

    expect(fenced).toContain("`pass|fail`");
    expect(fenced).not.toContain("pass\\|fail");
    expect(quoted).toContain("<blockquote");
    expect(quoted).toContain("<table");
    expect(quoted).toContain("<code>pass|fail</code>");
    expect(nested).toContain("<li>");
    expect(nested).toContain("<table");
    expect(nested).toContain("<code>pass|fail</code>");
  });

  it("does not treat escaped or unmatched backticks as code-span delimiters", () => {
    const source = [
      "| First | Second |",
      "| --- | --- |",
      "| literal \\` marker | keep |",
      "| unmatched ` marker | separate |"
    ].join("\n");
    const html = renderToStaticMarkup(createElement(MarkdownPreview, { markdown: source }));

    expect(normalizeReviewGuideMarkdown(source)).toBe(source);
    expect((html.match(/<td/g) ?? []).length).toBe(4);
    expect(html).toContain("keep");
    expect(html).toContain("separate");
  });

  it("accepts a matching closer after a literal backslash inside a code span", () => {
    const source = [
      "| First | Second |",
      "| --- | --- |",
      "| `a|b\\` | keep |"
    ].join("\n");
    const normalized = normalizeReviewGuideMarkdown(source);
    const html = renderToStaticMarkup(createElement(MarkdownPreview, { markdown: source }));

    expect(normalized).toContain("`a\\|b\\`");
    expect((html.match(/<td/g) ?? []).length).toBe(2);
    expect(html).toContain("a|b\\");
    expect(html).toContain("keep");
  });

  it("renders near-limit guides without recursive stack growth", () => {
    const markdown = "*grounded* ".repeat(9_000);
    expect(markdown.length).toBeGreaterThan(90_000);
    expect(() => renderToStaticMarkup(createElement(MarkdownPreview, { markdown }))).not.toThrow();
  });

  it("keeps raw HTML inert and rejects executable link schemes", () => {
    const source = '<script>alert("x")</script> [run](javascript:alert(1))';
    const html = renderToStaticMarkup(createElement(MarkdownPreview, { markdown: source }));

    expect(source).toBe('<script>alert("x")</script> [run](javascript:alert(1))');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(safeMarkdownHref("data:text/html,boom")).toBeNull();
    expect(safeMarkdownHref("//example.com/track")).toBeNull();
    expect(safeMarkdownHref("https://example.com")).toBe("https://example.com");
    expect(safeMarkdownHref("../docs/guide")).toBe("../docs/guide");
  });

  it("uses the renderer only for review guides and keeps exact source views explicit", async () => {
    const [skill, versions, editor] = await Promise.all([
      readFile(new URL("../src/screens/skill.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/screens/skill-versions.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/screens/skill-edit.tsx", import.meta.url), "utf8")
    ]);

    expect(skill).toContain("<MarkdownPreview markdown={markdown}");
    expect(skill).toContain("Judge instructions · exact compiled text");
    expect(skill).toContain("Result format · exact JSON schema");
    expect(skill).toContain("Requested model · immutable settings");
    expect(skill).not.toContain("Model used");
    expect(skill).not.toContain("Coeval flips this skill to");
    expect(versions).toContain("<MarkdownPreview markdown={v.rubricMarkdown}");
    expect(versions).toContain("{compiledPrompt.content");
    expect(editor).toContain('rubricMode === "preview"');
    expect(editor).toContain('aria-label="Review guide Markdown source"');
    expect(editor).toContain("requested-versus-observed mismatch is recorded evidence");
  });

  it("explains each result type consistently", () => {
    expect(verdictKindDescription("binary")).toContain("pass or fail");
    expect(verdictKindDescription("scalar", { scalarRange: [0, 5] })).toContain("0 to 5");
    expect(verdictKindDescription("categorical", {
      categoricalChoiceScores: { faithful: 1, unsupported: 0 }
    })).toContain("faithful, unsupported");
  });
});
