import { describe, expect, it } from "vitest";
import { findStarterSkill, STARTER_SKILLS } from "../src/lib/starter-skills.js";

describe("starter skills", () => {
  it("opens first projects on a concrete task-outcome example", () => {
    const starter = findStarterSkill("task-outcome-quality");

    expect(starter).toMatchObject({
      name: "Task outcome quality",
      verdictKind: "binary"
    });
    expect(starter?.rubricMarkdown).toContain("## Worked example");
    expect(starter?.prompt).toContain("{{rubric_markdown}}");
  });

  it("offers an agent-skill audit template for the bundled external-agent flow", () => {
    const starter = findStarterSkill("agent-skill-audit");

    expect(starter).toMatchObject({
      name: "Agent skill audit",
      verdictKind: "binary"
    });
    expect(starter?.rubricMarkdown).toContain("audited skill's own purpose");
    expect(starter?.rubricMarkdown).toContain("never\" rules");
    expect(starter?.prompt).toContain("external agent skill");
    expect(STARTER_SKILLS.at(-1)?.id).toBe("agent-skill-audit");
  });
});
