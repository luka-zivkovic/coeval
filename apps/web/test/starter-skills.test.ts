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

  // The verdict protocol names the output mechanism and the evidence block
  // (ADR-0014 section 3); a template that does too would contradict it.
  it("never names a verdict mechanism or an evidence block", () => {
    for (const starter of STARTER_SKILLS) {
      // A judged agent's own tool calls are evidence and may be named.
      expect(starter.prompt, starter.id).not.toMatch(/submit_verdict|verdict tool|structured verdict|trace_to_judge|\breturn (?:only |strictly )?(?:the )?json\b/i);
    }
  });
});
