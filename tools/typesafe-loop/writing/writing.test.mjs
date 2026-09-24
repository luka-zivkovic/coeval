import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { labelText } from "./lexical.mjs";
import { corruptClaim, injectViolation } from "./corrupt.mjs";
import { buildPreservationSet, buildRuleSet } from "./build-suite.mjs";
import { createScriptedRewriter, skillInstructions } from "./rewrite.mjs";
import { applySkillEdit, createScriptedSkillAuthor, gateSkillEdit, lexicalScore, runSkillLoop, splitCorpus } from "./skilloop.mjs";
import { createMockProvider } from "../providers.mjs";

const CLEAN = "We don't ship on Fridays, because the on-call rota is thin. The build takes about 12 minutes. It may fail on a cold cache, so retry once before paging anyone.\n\n- run the tests\n- check the summary\n- ship it";

describe("corruption and pairs", () => {
  it("injects exactly one violation per rule into clean text", () => {
    for (const rule of ["dash_connective", "ai_tell_vocabulary", "bot_scaffolding", "decorative_bold", "missing_contractions"]) {
      const source = rule === "missing_contractions" ? Array(14).fill(CLEAN).join(" ") : CLEAN;
      assert.equal(labelText(source).labels[rule], "pass", `${rule} clean baseline`);
      const failing = injectViolation(source, rule);
      assert.ok(failing, `${rule} injection point`);
      assert.equal(labelText(failing).labels[rule], "fail", `${rule} injected`);
    }
  });
  it("corrupts a claim by strengthening a modal first", () => {
    const c = corruptClaim(CLEAN);
    assert.equal(c.kind, "modal_strengthened");
    assert.ok(c.text.includes("It will fail"));
    assert.equal(corruptClaim("Nothing numeric or modal here at all."), null);
  });
  it("builds rule sets with exact labels and preservation pairs", () => {
    const texts = [{ id: "a", title: "t", text: CLEAN, source: "original" }, { id: "b", title: "t", text: "We leverage a robust — seamless paradigm.", source: "original" }];
    const set = buildRuleSet("ai_tell_vocabulary", texts);
    assert.deepEqual(set.cases.map((c) => c.humanLabel), ["pass", "fail"]);
    assert.equal(set.pairs.length, 1);
    assert.equal(set.pairs[0].id, "a:ai_tell_vocabulary");
    const preserve = buildPreservationSet(texts);
    assert.equal(preserve.criterion.key, "claims_preserved");
    assert.ok(preserve.pairs.length >= 1);
  });
});

describe("rewriter and skill loop", () => {
  it("wraps the skill text as operating instructions", () => {
    assert.ok(skillInstructions("RULES").includes("<writing_skill>\nRULES"));
  });
  it("splits deterministically and scores lexical violations", () => {
    const corpus = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, body: i % 2 ? "We leverage it — now." : CLEAN }));
    const { shown, heldOut } = splitCorpus(corpus, { seed: 2, heldOutFraction: 0.4 });
    assert.equal(heldOut.length, 4);
    assert.equal(shown.length, 6);
    const score = lexicalScore(corpus.map((c) => ({ id: c.id, text: c.body })));
    assert.equal(score.textsFailingByRule.ai_tell_vocabulary, 5);
    assert.equal(score.textsFailingByRule.dash_connective, 5);
  });
  it("gates a skill edit on violations and preservation", () => {
    const lex = (v, rules = {}) => ({ violationsPerText: v, cleanRate: 0, textsFailingByRule: { dash_connective: 0, ai_tell_vocabulary: 0, bot_scaffolding: 0, decorative_bold: 0, missing_contractions: 0, ...rules } });
    const pres = (f, s) => ({ meanFaithful: f, pairSeparationRate: s });
    assert.equal(gateSkillEdit({ incumbent: { lexical: lex(1.0), preservation: pres(0.9, 0.9) }, proposal: { lexical: lex(0.5), preservation: pres(0.9, 0.9) } }).accepted, true);
    const worse = gateSkillEdit({ incumbent: { lexical: lex(1.0), preservation: pres(0.9, 0.9) }, proposal: { lexical: lex(0.5), preservation: pres(0.7, 0.9) } });
    assert.ok(worse.reasons.some((r) => r.includes("faithfulness fell")));
    const flat = gateSkillEdit({ incumbent: { lexical: lex(1.0) }, proposal: { lexical: lex(0.95) } });
    assert.ok(flat.reasons.some((r) => r.includes("no improvement")));
    const regress = gateSkillEdit({ incumbent: { lexical: lex(1.0) }, proposal: { lexical: lex(0.5, { bot_scaffolding: 3 }) } });
    assert.ok(regress.reasons.some((r) => r.includes("bot_scaffolding got worse")));
  });
  it("applies only unique verbatim edits", () => {
    assert.equal(applySkillEdit("a b c", { kind: "replace_passage", target: "b", replacement: "B" }).text, "a B c");
    assert.equal(applySkillEdit("a b b", { kind: "replace_passage", target: "b", replacement: "B" }).reason, "target not unique");
    assert.equal(applySkillEdit("a b c", { kind: "replace_passage", target: "z", replacement: "B" }).reason, "target not found");
    assert.equal(applySkillEdit("a", { kind: "stop", target: "", replacement: "" }).changed, false);
  });
  it("runs the loop end to end with a scripted rewriter, mock judge and scripted author", async () => {
    const corpus = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, title: "t", body: `We leverage the cache — it may help. Furthermore, it's ${i} minutes faster.` }));
    const rewriter = createScriptedRewriter((body, skill) => {
      if (!skill) return body;
      let out = body.replace(/[—–]/g, ",");
      if (skill.includes("leverage")) out = out.replace(/leverage/g, "use");
      if (skill.includes("Furthermore")) out = out.replace(/Furthermore, /g, "");
      return out;
    });
    const judge = createMockProvider({ cues: { claims_preserved: { positive: [], negative: ["will"] } } });
    const author = createScriptedSkillAuthor([
      { kind: "replace_passage", target: "dash", replacement: "dash; leverage → use" },
      { kind: "replace_passage", target: "nothing here", replacement: "x" },
      { kind: "replace_passage", target: "use", replacement: "use; no Furthermore" },
      { kind: "stop", target: "", replacement: "" }
    ]);
    const report = await runSkillLoop({ corpus, skillText: "Avoid the dash.", rewriter, judge, author, rounds: 4, seed: 3, preservationLimit: 4 });
    assert.equal(report.rounds.length, 4);
    assert.equal(report.rounds[0].accepted, true, JSON.stringify(report.rounds[0].reasons));
    assert.equal(report.rounds[1].reasons[0], "target not found");
    assert.equal(report.rounds[2].accepted, true, JSON.stringify(report.rounds[2].reasons));
    assert.equal(report.rounds[3].kind, "stop");
    assert.equal(report.final.version, 2);
    assert.ok(report.final.heldOut.lexical.violationsPerText < report.initial.heldOut.lexical.violationsPerText);
    assert.ok(report.versions[2].text.includes("no Furthermore"));
  });
});
