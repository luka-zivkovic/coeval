import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockProvider, createOracleProvider } from "./providers.mjs";
import { criterionQuestion, passProbability } from "./questions.mjs";
import { applyProposal, buildEvidencePacket, createClaudeAuthor, createScriptedAuthor, PROPOSAL_SCHEMA } from "./author.mjs";
import { estimateCost, gateProposal, metricsFor, runAutoloop, splitCases } from "./autoloop.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => JSON.parse(await readFile(path.join(here, "fixtures", name), "utf8"));

describe("abstention-aware questions", () => {
  it("builds a three-way choice when abstention is on and reads pass probability from either shape", () => {
    const q = criterionQuestion({ key: "k", question: "q", passDescription: "p", failDescription: "f", abstention: true });
    assert.equal(q.k.type, "choice");
    assert.deepEqual(Object.keys(q.k.criteria), ["pass", "fail", "cannot_determine"]);
    assert.deepEqual(passProbability({ type: "noul", noul: 0.7 }), { p: 0.7, cannotDetermine: null });
    assert.deepEqual(passProbability({ type: "choice", choice: "pass", confidence: 0.6, probabilities: { pass: 0.6, fail: 0.1, cannot_determine: 0.3 } }), { p: 0.6, cannotDetermine: 0.3 });
  });
});

describe("split and gate", () => {
  it("splits deterministically into disjoint shown and held-out sets", async () => {
    const cases = await fixture("cases.json");
    const a = splitCases(cases, { seed: 3, heldOutFraction: 0.4 });
    const b = splitCases(cases, { seed: 3, heldOutFraction: 0.4 });
    assert.deepEqual(a.heldOut.map((c) => c.id), b.heldOut.map((c) => c.id));
    assert.equal(a.heldOut.length, 8);
    assert.equal(a.shown.length, 12);
    const overlap = a.heldOut.filter((h) => a.shown.some((s) => s.id === h.id));
    assert.equal(overlap.length, 0);
  });
  const m = (over) => ({ metrics: { auc: 0.8, brier: 0.2, ece: 0.1, cannotDetermineMass: null, confusion: { truePass: 4, trueFail: 4, falsePass: 1, falseFail: 1, truthPassRecall: 0.8, truthFailRecall: 0.8 }, ...over } });
  it("accepts a one-kind change that improves held-out and rejects regressions", () => {
    const ok = gateProposal({ kind: "question_text", changed: ["question"], incumbent: m({}), proposal: m({ auc: 0.9, brier: 0.15 }) });
    assert.equal(ok.accepted, true);
    const worse = gateProposal({ kind: "question_text", changed: ["question"], incumbent: m({}), proposal: m({ auc: 0.7 }) });
    assert.equal(worse.accepted, false);
    assert.ok(worse.reasons.some((r) => r.includes("AUC fell")));
    const flat = gateProposal({ kind: "question_text", changed: ["question"], incumbent: m({}), proposal: m({}) });
    assert.equal(flat.accepted, false);
    assert.ok(flat.reasons.some((r) => r.includes("no measurable improvement")));
  });
  it("rejects proposals that change more than their declared kind, or nothing", () => {
    const wide = gateProposal({ kind: "binding_switch", changed: ["binding", "question"], incumbent: m({}), proposal: m({ auc: 0.95 }) });
    assert.equal(wide.accepted, false);
    assert.ok(wide.reasons.some((r) => r.includes("outside")));
    const none = gateProposal({ kind: "question_text", changed: [], incumbent: m({}), proposal: m({ auc: 0.95 }) });
    assert.equal(none.accepted, false);
  });
  it("rejects when a previously passing pair regresses or cannot-determine mass balloons", () => {
    const pairs = (ids) => ({ rows: ids.map(([id, ok]) => ({ pairId: id, separatedByMargin: ok })), summary: { separatedByMarginRate: ids.filter(([, ok]) => ok).length / ids.length } });
    const regressed = gateProposal({ kind: "question_text", changed: ["question"], incumbent: m({}), proposal: m({ auc: 0.95 }), incumbentPairs: pairs([["p1", true], ["p2", true]]), proposalPairs: pairs([["p1", true], ["p2", false]]) });
    assert.ok(regressed.reasons.some((r) => r.includes("pairs regressed: p2")));
    const cd = gateProposal({ kind: "abstention_toggle", changed: ["abstention"], incumbent: m({ cannotDetermineMass: 0.1 }), proposal: m({ auc: 0.95, cannotDetermineMass: 0.5 }) });
    assert.ok(cd.reasons.some((r) => r.includes("cannot-determine mass grew")));
  });
  it("estimates cost from the model prefix", () => {
    assert.equal(estimateCost("jev-1.13.0", { input_tokens: 1_000_000, output_tokens: 0 }), 0.042);
    assert.equal(estimateCost("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 100_000 }), 7.5);
    assert.equal(estimateCost("unknown-model", { input_tokens: 1, output_tokens: 1 }), null);
  });
});

describe("author", () => {
  it("builds a packet from shown items only and sorts evidence into buckets", async () => {
    const cases = (await fixture("cases.json")).slice(0, 6);
    const version = { number: 0, key: "k", question: "q", passDescription: "p", failDescription: "f", binding: "a" };
    const items = (ps) => cases.map((c, i) => ({ caseId: c.id, p: ps[i], cannotDetermine: null, label: c.humanLabel === "pass" ? 1 : 0 }));
    // c01..c05 are pass, c06 is fail. Judge a and b agree and are confidently wrong on c01 (truth suspect),
    // disagree on c02 (criterion suspect), and are near threshold on c03.
    const judges = {
      a: { items: items([0.1, 0.9, 0.55, 0.9, 0.9, 0.1]), metrics: {} },
      b: { items: items([0.15, 0.2, 0.5, 0.9, 0.9, 0.1]), metrics: {} }
    };
    const packet = buildEvidencePacket({ version, judges, cases });
    assert.deepEqual(packet.truthSuspect.map((r) => r.caseId), ["c01"]);
    assert.deepEqual(packet.criterionSuspect.map((r) => r.caseId), ["c02"]);
    assert.deepEqual(packet.nearThreshold.map((r) => r.caseId), ["c03"]);
    assert.deepEqual(packet.includedCaseIds.sort(), cases.map((c) => c.id).sort());
    assert.ok(packet.truthSuspect[0].excerpt.length <= 601);
    assert.throws(() => buildEvidencePacket({ version, judges: { a: { items: [{ caseId: "zzz", p: 0.5, cannotDetermine: null, label: 1 }], metrics: {} } }, cases }), /held-out leak/);
  });
  it("applies a proposal and reports exactly which fields changed", () => {
    const version = { number: 0, key: "k", question: "q", passDescription: "p", failDescription: "f", binding: "a", abstention: false };
    const { version: next, changed } = applyProposal(version, { kind: "binding_switch", question: "q", passDescription: "p", failDescription: "f", cannotDetermineDescription: "", abstention: false, binding: "b", rationale: "r", targets: [] });
    assert.equal(next.number, 1);
    assert.equal(next.parent, 0);
    assert.deepEqual(changed, ["binding"]);
    const toggled = applyProposal(version, { kind: "abstention_toggle", question: "q", passDescription: "p", failDescription: "f", cannotDetermineDescription: "cd", abstention: true, binding: "a", rationale: "r", targets: [] });
    assert.deepEqual(toggled.changed.sort(), ["abstention", "cannotDetermineDescription"]);
  });
  it("claude author sends the packet as untrusted data with the proposal schema", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      const proposal = { kind: "question_text", question: "sharper q", passDescription: "p", failDescription: "f", cannotDetermineDescription: "", abstention: false, binding: "a", rationale: "r", targets: ["c01"] };
      return new Response(JSON.stringify({ model: "claude-fable-5-1", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(proposal) }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
    };
    const author = createClaudeAuthor({ apiKey: "k", baseURL: "https://api.anthropic.com", fetch });
    const { proposal, model } = await author.propose({ version: { question: "<q>" }, includedCaseIds: [] });
    assert.equal(model, "claude-fable-5-1");
    assert.equal(proposal.question, "sharper q");
    assert.deepEqual(calls[0].output_config.format.schema, PROPOSAL_SCHEMA);
    assert.ok(calls[0].messages[0].content.startsWith("<evidence_packet_json>"));
    assert.ok(!calls[0].messages[0].content.includes("<q>"));
  });
});

describe("autoloop end to end with mocks", () => {
  it("runs rounds, keeps held-out away from the author, and reports v0 against the final version", async () => {
    const criterion = await fixture("criterion.json");
    const cases = await fixture("cases.json");
    const pairs = await fixture("pairs.json");
    const cues = { [criterion.key]: criterion.mockCues };
    // "weak" sees no cues at all, so it is a near-constant judge; "strong" reads the cue book.
    const judges = { weak: createMockProvider({ cues: {}, model: "mock-weak" }), strong: createOracleProvider({ cases, key: criterion.key, model: "mock-oracle" }) };
    let sawHeldOut = false;
    const scripted = createScriptedAuthor([
      { kind: "question_text", question: "Reworded question" },
      { kind: "binding_switch", binding: "strong" },
      { kind: "criteria_descriptions", failDescription: "f2" }
    ]);
    const author = { ...scripted, model: "author-model", async propose(packet) { if (packet.includedCaseIds.length !== 12) sawHeldOut = true; return scripted.propose(packet); } };
    const report = await runAutoloop({ criterion, cases, pairs, judges, author, binding: "weak", rounds: 3, seed: 5, heldOutFraction: 0.4 });
    assert.equal(sawHeldOut, false);
    assert.equal(report.rounds.length, 3);
    assert.equal(report.split.heldOut.length, 8);
    assert.equal(report.rounds[1].kind, "binding_switch");
    assert.equal(report.rounds[1].accepted, true, JSON.stringify(report.rounds[1].reasons));
    assert.equal(report.final.version.binding, "strong");
    assert.ok(report.final.heldOut.auc >= report.initial.heldOut.weak.auc);
    assert.equal(report.author.independentOfJudges, true);
    assert.ok(report.versions.length >= 2);
    assert.ok(Object.keys(report.cost).includes("mock-weak"));
  });
  it("metricsFor reports cannot-determine mass only for three-way answers", () => {
    const m = metricsFor([{ caseId: "a", p: 0.9, cannotDetermine: 0.2, label: 1 }, { caseId: "b", p: 0.1, cannotDetermine: 0.4, label: 0 }]);
    assert.equal(m.cannotDetermineMass, 0.3);
    assert.equal(m.auc, 1);
    assert.equal(metricsFor([{ caseId: "a", p: 0.9, cannotDetermine: null, label: 1 }]).cannotDetermineMass, null);
  });
});
