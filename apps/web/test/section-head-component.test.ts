import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function sectionHeadSource(): Promise<string> {
  return readFile(new URL("../src/components/coeval/section-head.tsx", import.meta.url), "utf8");
}

describe("SectionHead", () => {
  it("keeps title, rule, and description in positive document flow", async () => {
    const source = await sectionHeadSource();
    const rulePosition = source.indexOf('aria-hidden="true"');
    const descriptionPosition = source.indexOf("{sub ? (");

    expect(source).not.toMatch(/-mt-/);
    expect(source).toContain("flex-wrap items-end");
    expect(source).toContain("mt-3 h-px w-full bg-rule");
    expect(source).toContain("mt-3 max-w-[70ch]");
    expect(rulePosition).toBeGreaterThan(-1);
    expect(descriptionPosition).toBeGreaterThan(rulePosition);
  });
});
