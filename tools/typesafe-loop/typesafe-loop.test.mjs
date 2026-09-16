import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerFromProbabilities, buildAnswerSchema, createAnthropicProvider, createMockProvider, createTypeSafeProvider } from "./providers.mjs";
import { choice, criterionQuestion, noul, score, canonicalJson } from "./questions.mjs";
import { brierScore, confusionAt, distributionShift, expectedCalibrationError, overlapPermutationTest, rocAuc } from "./metrics.mjs";
import { compareProbabilityLogs, recordProbabilityLog, runMinimalPairs, runSplitView } from "./experiments.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => JSON.parse(await readFile(path.join(here, "fixtures", name), "utf8"));

describe("question builders", () => {
  it("mirror the SDK question shapes", () => {
    assert.deepEqual(noul("q"), { type: "noul", instructions: "q" });
    assert.deepEqual(choice("q", { a: null, b: null }).type, "choice");
    assert.deepEqual(score("q", ["bad", "good"]).criteria, ["bad", "good"]);
    assert.throws(() => score("q", ["only"]));
    assert.throws(() => choice("q", { a: null }));
  });
  it("orients the criterion question so yes means pass", async () => {
    const criterion = await fixture("criterion.json");
    const questions = criterionQuestion(criterion);
    assert.equal(questions[criterion.key].criteria.true, criterion.passDescription);
  });
  it("canonicalizes JSON with sorted keys", () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  });
});

describe("metrics", () => {
  it("computes Brier, ECE, AUC and confusion counts", () => {
    const items = [{ p: 0.9, label: 1 }, { p: 0.8, label: 1 }, { p: 0.2, label: 0 }, { p: 0.85, label: 0 }];
    assert.ok(Math.abs(brierScore(items) - (0.01 + 0.04 + 0.04 + 0.7225) / 4) < 1e-9);
    assert.equal(rocAuc(items), 0.75);
    const { ece } = expectedCalibrationError(items, 2);
    assert.ok(ece > 0 && ece < 1);
    assert.deepEqual(confusionAt(items).falsePass, 1);
    assert.deepEqual(confusionAt(items).falseFail, 0);
    assert.equal(rocAuc([{ p: 0.5, label: 1 }]), null);
  });
  it("runs a reproducible permutation test", () => {
    const selected = [true, true, true, false, false, false, false, false];
    const reference = [true, true, true, false, false, false, false, false];
    const a = overlapPermutationTest(selected, reference, { permutations: 500, seed: 3 });
    const b = overlapPermutationTest(selected, reference, { permutations: 500, seed: 3 });
    assert.deepEqual(a, b);
    assert.equal(a.observed, 1);
    assert.ok(a.pValue < 0.05);
    assert.equal(overlapPermutationTest([false, false], [true, false]).observed, null);
  });
  it("measures distribution shift and label flips", () => {
    const shift = distributionShift([{ caseId: "a", p: 0.7 }, { caseId: "b", p: 0.2 }], [{ caseId: "a", p: 0.3 }, { caseId: "b", p: 0.25 }, { caseId: "c", p: 0.9 }]);
    assert.equal(shift.compared, 2);
    assert.equal(shift.flips, 1);
    assert.ok(Math.abs(shift.meanDelta - -0.175) < 1e-9);
  });
});

describe("providers", () => {
  it("mock is deterministic and reacts to hidden evidence", async () => {
    const provider = createMockProvider({ cues: { k: { positive: ["30-day"], negative: ["processed your refund"] } } });
    const questions = { k: noul("q") };
    const a = await provider.systemOne({ state: { output: "we'll follow up" }, questions });
    const b = await provider.systemOne({ state: { output: "we'll follow up" }, questions });
    const c = await provider.systemOne({ state: { output: "we'll follow up", steps: [{ output: "30-day window" }] }, questions });
    assert.equal(a.answers.k.noul, b.answers.k.noul);
    assert.ok(c.answers.k.noul > a.answers.k.noul);
  });
  it("derives choice and score answers from probability maps", () => {
    const c = answerFromProbabilities(choice("q", { a: null, b: null }), { a: 3, b: 1 });
    assert.equal(c.choice, "a");
    assert.ok(Math.abs(c.confidence - 0.75) < 1e-9);
    const s = answerFromProbabilities(score("q", ["low", "mid", "high"]), { 0: 0, 1: 0.5, 2: 0.5 });
    assert.equal(s.score, 1.5);
    assert.deepEqual(s.legend, { 0: "low", 1: "mid", 2: "high" });
  });
  it("typesafe provider sends the SDK wire shape once with bearer auth", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ model: "jev-2026-09-15", answers: { k: { type: "noul", noul: 0.81 } }, usage: { input_tokens: 12, output_tokens: 0 } }), { status: 200, headers: { "x-typesafe-request-id": "req_1" } });
    };
    const provider = createTypeSafeProvider({ apiKey: "sk-test", baseURL: "https://api.typesafe.ai/", model: "jev-latest", fetch });
    const result = await provider.systemOne({ state: "text", questions: { k: noul("q") } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
    assert.deepEqual(JSON.parse(calls[0].init.body), { state: "text", questions: { k: { type: "noul", instructions: "q" } }, model: "jev-latest" });
    assert.equal(result.model, "jev-2026-09-15");
    assert.equal(result.requestId, "req_1");
    assert.equal(result.answers.k.noul, 0.81);
  });
  it("typesafe provider omits the auth header when a proxy is expected to attach it", async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push(init); return new Response(JSON.stringify({ model: "jev", answers: { k: { type: "noul", noul: 0.5 } } }), { status: 200 }); };
    const provider = createTypeSafeProvider({ apiKey: undefined, fetch });
    assert.equal(provider.authMode, "proxy");
    await provider.systemOne({ state: "x", questions: { k: noul("q") } });
    assert.equal(calls[0].headers.Authorization, undefined);
  });
  it("typesafe provider surfaces non-2xx without retrying", async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: "rate" }), { status: 429 }); };
    const provider = createTypeSafeProvider({ apiKey: "k", fetch });
    await assert.rejects(provider.systemOne({ state: "x", questions: { k: noul("q") } }), /typesafe 429/);
    assert.equal(calls, 1);
  });
  it("anthropic stand-in uses structured outputs and validates probabilities", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ k: { true: 0.7 }, c: { a: 0.2, b: 0.8 } }) }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { "request-id": "req_a" } });
    };
    const provider = createAnthropicProvider({ apiKey: "sk-ant", baseURL: "https://api.anthropic.com", model: "claude-opus-5", fetch });
    const questions = { k: noul("q", { true: "yes desc", false: "no desc" }), c: choice("pick", { a: null, b: null }) };
    const result = await provider.systemOne({ state: { output: "<tag> & text" }, questions });
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.output_config.format.type, "json_schema");
    assert.deepEqual(body.output_config.format.schema, buildAnswerSchema(questions));
    assert.equal(body.fallbacks, "default");
    assert.equal(calls[0].init.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.ok(!body.messages[0].content.includes("<tag>"), "state is escaped inside the untrusted block");
    assert.equal(result.answers.k.noul, 0.7);
    assert.equal(result.answers.c.choice, "b");
    assert.equal(result.requestId, "req_a");
  });
  it("anthropic stand-in rejects refusals and out-of-range numbers", async () => {
    const refusing = async () => new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), { status: 200 });
    await assert.rejects(createAnthropicProvider({ apiKey: "k", fetch: refusing }).systemOne({ state: "x", questions: { k: noul("q") } }), /refused/);
    const bad = async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ k: { true: 1.4 } }) }] }), { status: 200 });
    await assert.rejects(createAnthropicProvider({ apiKey: "k", fetch: bad }).systemOne({ state: "x", questions: { k: noul("q") } }), /out of range/);
  });
});

describe("experiments on fixtures with the mock", () => {
  it("split-view flags the cases whose evidence sits only in steps", async () => {
    const criterion = await fixture("criterion.json");
    const cases = await fixture("cases.json");
    const provider = createMockProvider({ cues: { [criterion.key]: criterion.mockCues } });
    const report = await runSplitView({ provider, criterion, cases, permutations: 300 });
    assert.equal(report.rows.length, 20);
    assert.ok(report.summary.disagreements >= 5);
    assert.ok(report.summary.lift > 1);
    assert.equal(report.verdict, "pass");
  });
  it("minimal pairs separate the passing and edited-to-fail traces", async () => {
    const criterion = await fixture("criterion.json");
    const pairs = await fixture("pairs.json");
    const provider = createMockProvider({ cues: { [criterion.key]: criterion.mockCues } });
    const report = await runMinimalPairs({ provider, criterion, pairs });
    assert.equal(report.rows.length, 8);
    assert.ok(report.summary.pairwiseAuc >= 0.875);
    const blindSpot = report.rows.find((r) => r.pairId === "p03");
    assert.equal(blindSpot.separatedByMargin, false, "a lexical judge cannot see that 'within our 30-day window' is false");
  });
  it("drift replay reports review when the provider identity or probabilities move", async () => {
    const criterion = await fixture("criterion.json");
    const cases = await fixture("cases.json");
    const cues = { [criterion.key]: criterion.mockCues };
    const previous = await recordProbabilityLog({ provider: createMockProvider({ cues }), criterion, cases, recordedAt: "t1" });
    const same = await recordProbabilityLog({ provider: createMockProvider({ cues }), criterion, cases, recordedAt: "t2" });
    const steady = compareProbabilityLogs({ previous, current: same });
    assert.equal(steady.verdict, "steady");
    assert.equal(steady.shift.flips, 0);
    const drifted = await recordProbabilityLog({ provider: createMockProvider({ cues, bias: -1.2, model: "mock-drifted" }), criterion, cases, recordedAt: "t3" });
    const review = compareProbabilityLogs({ previous, current: drifted });
    assert.equal(review.verdict, "review");
    assert.ok(review.reasons.some((r) => r.includes("model changed")));
    assert.equal(previous.items[0].p !== undefined && previous.items[0].input, undefined, "log stores no payloads");
  });
});
