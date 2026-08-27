import { describe, expect, it } from "vitest";
import { renderJudgeCardMarkdown } from "../src/lib/judge-card.js";
import type { JudgeCard } from "@coeval/shared";

// Every string field a user can control on the card. C1's job is to neutralize
// each of these so a crafted value can't inject markdown/HTML/newlines.
function card(overrides: Partial<JudgeCard> = {}): JudgeCard {
  return {
    generatedAt: "2026-07-05T00:00:00.000Z",
    project: { id: "proj_1", name: "Acme Support" },
    skill: { id: "skill_1", name: "Support Answer Quality", ownerName: "Dana" },
    version: {
      id: "skillv_1",
      version: "0.1.3",
      status: "approved",
      verdictKind: "binary",
      rubricProvenance: "human-authored",
      createdAt: "2026-07-05T00:00:00.000Z",
      approvedAt: "2026-07-05T00:00:00.000Z"
    },
    modelBinding: { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "20260101", temperature: 0 },
    goldenSet: { size: 3, agreement: 0.9, tooStrict: 0, tooLenient: 1, ambiguous: 0 },
    regression: { status: "passed", compared: 3, regressed: 0, improved: 1, flipped: 0, overrideReason: null, createdAt: "2026-07-05T00:00:00.000Z" },
    judgeHumanKappa: [{ humanRater: "user_dana", kappa: 0.8, interpretation: "substantial", cases: 6 }],
    selfConsistency: { comparedCases: 4, consistentCases: 4, meanAgreement: 1 },
    audit: [{ id: "audit_1", action: "skill.signoff", actorUserId: "user_dana", createdAt: "2026-07-05T00:00:00.000Z", metadata: null }],
    basis: ["This card reports recorded evidence only; it is not a composite score and consistency is not correctness."],
    ...overrides
  };
}

const PAYLOADS = [
  "[x](javascript:alert(1))",
  "![](http://evil.example/beacon)",
  "</td><script>alert(1)</script>",
  "line1\nline2\r\n- forged bullet",
  "# forged heading",
  "**forged bold** `code`",
  "~~forged strike~~"
];

describe("renderJudgeCardMarkdown — C1 injection safety", () => {
  // Assert a rendered card carrying `payload` in `field` neutralizes it: no
  // raw HTML tag, no live markdown link/image syntax, no injected line break.
  function assertInert(md: string, where: string) {
    expect(md, `${where}: raw <script> tag`).not.toContain("<script>");
    expect(md, `${where}: live markdown link`).not.toMatch(/[^\\]\]\(javascript:/);
    expect(md, `${where}: live markdown image`).not.toMatch(/[^\\]!\[/);
    // The payload's embedded newline must not create a new markdown line: every
    // line the card emits is either blank, a heading, a bullet, or a known
    // prose line — a forged "- forged bullet" line must not appear on its own.
    expect(md.split("\n").some((line) => line.trim() === "- forged bullet"), `${where}: newline-injected bullet`).toBe(false);
    expect(md.split("\n").some((line) => line.trim() === "# forged heading"), `${where}: newline-injected heading`).toBe(false);
    expect(md, `${where}: live GFM strikethrough`).not.toMatch(/[^\\]~~/);
  }

  const fields: Array<{ name: string; apply: (c: JudgeCard, p: string) => JudgeCard }> = [
    { name: "skill.name", apply: (c, p) => ({ ...c, skill: { ...c.skill, name: p } }) },
    { name: "project.name", apply: (c, p) => ({ ...c, project: { ...c.project, name: p } }) },
    { name: "skill.ownerName", apply: (c, p) => ({ ...c, skill: { ...c.skill, ownerName: p } }) },
    { name: "modelBinding.modelId", apply: (c, p) => ({ ...c, modelBinding: { ...c.modelBinding, modelId: p } }) },
    { name: "modelBinding.modelVersion", apply: (c, p) => ({ ...c, modelBinding: { ...c.modelBinding, modelVersion: p } }) },
    { name: "regression.overrideReason", apply: (c, p) => ({ ...c, regression: { ...c.regression!, status: "overridden", overrideReason: p } }) },
    { name: "judgeHumanKappa[].humanRater", apply: (c, p) => ({ ...c, judgeHumanKappa: [{ ...c.judgeHumanKappa[0]!, humanRater: p }] }) },
    { name: "audit[].action", apply: (c, p) => ({ ...c, audit: [{ ...c.audit[0]!, action: p }] }) }
  ];

  for (const field of fields) {
    it(`neutralizes injection through ${field.name}`, () => {
      for (const payload of PAYLOADS) {
        const md = renderJudgeCardMarkdown(field.apply(card(), payload));
        assertInert(md, `${field.name} / ${JSON.stringify(payload)}`);
      }
    });
  }

  it("leaves ordinary content readable (hyphenated model ids, semver, plain names)", () => {
    const md = renderJudgeCardMarkdown(card());
    expect(md).toContain("# Judge Card — Support Answer Quality 0.1.3");
    expect(md).toContain("anthropic/claude-sonnet-4-6");
    expect(md).toContain("skill owner Dana");
    // Escaping must not mangle unremarkable text into backslash soup.
    expect(md).not.toContain("\\-");
    expect(md).not.toContain("Support Answer Quality\\");
    expect(md).toContain("**Requested model**");
    expect(md).toContain("catalog identity 20260101");
    expect(md).not.toContain("Model (pinned)");
  });

  it("renders agent-drafted rubric provenance explicitly", () => {
    const base = card();
    const md = renderJudgeCardMarkdown({
      ...base,
      version: { ...base.version, rubricProvenance: "agent-drafted" },
      basis: [...base.basis, "rubric provenance: agent-drafted scaffold — human adjudication is still required."]
    });
    expect(md).toContain("Rubric provenance**: agent-drafted");
    expect(md).toContain("human adjudication is still required");
  });

  it("keeps the honesty rules intact (basis note, counts not percentages, no composite)", () => {
    const md = renderJudgeCardMarkdown(card());
    expect(md).toContain("## Basis");
    expect(md).toContain("not a composite score");
    expect(md).toContain("agreement recorded ratio 0.90"); // ratio, never a bare %
    expect(md).not.toContain("%");
  });
});
