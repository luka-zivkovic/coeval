import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const setupSkill = readFileSync(resolve(root, "skills/coeval-setup/SKILL.md"), "utf8");
const setupReference = readFileSync(
  resolve(root, "skills/coeval-setup/references/setup-artifacts.md"),
  "utf8"
);
const auditSkill = readFileSync(resolve(root, "skills/coeval-audit/SKILL.md"), "utf8");
const normalizedAuditSkill = auditSkill.replace(/\s+/g, " ");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

describe("coeval-setup skill contract", () => {
  it("uses a short context-first proposal instead of a one-shot guess", () => {
    expect(setupSkill).toContain("Discover before asking");
    expect(setupSkill).toContain("one short question per message");
    expect(setupSkill).toContain("Finish setup (Recommended)");
    expect(setupSkill).toContain("Refine the Check");
    expect(setupSkill).toContain("Decide for me");
    expect(setupSkill).toContain("Starter · unvalidated");
    expect(setupSkill).toContain("What it cannot know");
  });

  it("keeps secrets and human authority outside agent setup", () => {
    expect(setupSkill).toContain("Do not read `.env`");
    expect(setupSkill).toContain("Never invent a demonstration Run");
    expect(setupSkill).toContain("Stop before human adjudication");
    expect(setupReference).toContain("It may not adjudicate");
    expect(setupReference).toContain("Do not advertise automatic capture");
  });

  it("hands ongoing runs to coeval-audit and documents both skills", () => {
    expect(setupSkill).toContain("hand ongoing capture and submission to `coeval-audit`");
    expect(auditSkill).toContain("use the sibling `coeval-setup` skill first");
    expect(normalizedAuditSkill).toContain("Do not replace that flow with a one-shot rubric guess");
    expect(readme).toContain("skills/coeval-setup/");
    expect(readme).toContain("copy both folders");
  });
});
