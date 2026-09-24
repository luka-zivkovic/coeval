#!/usr/bin/env node
// Fully automatic improvement loop over one criterion, with a strict referee.
//
//   measure (two judges, shown + held-out)
//   → attribute (evidence packet from shown only)
//   → author proposes one change (stronger Claude, or a script)
//   → gate on held-out truth the author never saw
//   → accept or discard, repeat
//   → report version 0 against the final version
//
// Nothing here activates anything. The output is a report, and the report is
// ASSUMPTION-class evidence on nonsealed data.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropicProvider, createMockProvider, createOracleProvider, createTypeSafeProvider, withCache } from "./providers.mjs";
import { criterionQuestion, passProbability, questionDigest } from "./questions.mjs";
import { brierScore, confusionAt, expectedCalibrationError, rocAuc, round, seededRandom } from "./metrics.mjs";
import { runMinimalPairs } from "./experiments.mjs";
import { CHANGE_KINDS, applyProposal, buildEvidencePacket, createClaudeAuthor, createScriptedAuthor } from "./author.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Per-million-token prices used only for the cost estimate in reports. */
export const PRICING = {
  "jev": { input: 0.042, output: 0 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "mock": { input: 0, output: 0 }
};

export function estimateCost(model, usage) {
  const key = Object.keys(PRICING).find((k) => (model ?? "").startsWith(k)) ?? null;
  if (!key) return null;
  return (usage.input_tokens * PRICING[key].input + usage.output_tokens * PRICING[key].output) / 1_000_000;
}

/** Deterministic disjoint split; held-out ids are the referee's alone. */
export function splitCases(cases, { seed = 11, heldOutFraction = 0.4 } = {}) {
  const random = seededRandom(seed);
  const order = cases.slice();
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const heldOutCount = Math.max(1, Math.round(order.length * heldOutFraction));
  return { heldOut: order.slice(0, heldOutCount), shown: order.slice(heldOutCount) };
}

export function metricsFor(items) {
  const labelled = items.filter((i) => i.label === 0 || i.label === 1);
  const cd = items.map((i) => i.cannotDetermine).filter((v) => typeof v === "number");
  return {
    n: items.length,
    labelled: labelled.length,
    auc: round(rocAuc(labelled)),
    brier: round(brierScore(labelled)),
    ece: round(expectedCalibrationError(labelled).ece),
    confusion: confusionAt(labelled, 0.5),
    cannotDetermineMass: cd.length === 0 ? null : round(cd.reduce((a, b) => a + b, 0) / cd.length)
  };
}

export async function measure({ provider, version, cases }) {
  const questions = criterionQuestion(version);
  const items = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let model = provider.model ?? null;
  for (const item of cases) {
    const result = await provider.systemOne({ state: { input: item.input, output: item.output, steps: item.steps ?? [] }, questions });
    model = result.model ?? model;
    usage.input_tokens += result.usage?.input_tokens ?? 0;
    usage.output_tokens += result.usage?.output_tokens ?? 0;
    const { p, cannotDetermine } = passProbability(result.answers[version.key]);
    items.push({ caseId: item.id, p: round(p, 6), cannotDetermine: cannotDetermine === null ? null : round(cannotDetermine, 6), label: item.humanLabel === "pass" ? 1 : item.humanLabel === "fail" ? 0 : null });
  }
  return { items, metrics: metricsFor(items), model, usage, questionDigest: await questionDigest(questions) };
}

/**
 * The referee. Pure, so it can be tested without a provider. Compares the
 * proposal measured on held-out with the incumbent measured on held-out.
 */
export function gateProposal({ kind, changed, incumbent, proposal, incumbentPairs = null, proposalPairs = null, tolerance = 0, minImprovement = 0.01, maxCannotDetermineGrowth = 0.1 }) {
  const reasons = [];
  const allowed = CHANGE_KINDS[kind];
  if (!allowed) reasons.push(`unknown change kind "${kind}"`);
  else {
    const outside = changed.filter((f) => !allowed.includes(f));
    if (outside.length > 0) reasons.push(`changed fields outside "${kind}": ${outside.join(", ")}`);
    if (changed.length === 0) reasons.push("proposal changed nothing");
  }
  const a = incumbent.metrics;
  const b = proposal.metrics;
  const recall = (m, k) => (m.confusion[k] === null ? 0 : m.confusion[k]);
  if (recall(b, "truthPassRecall") < recall(a, "truthPassRecall") - tolerance) reasons.push(`truth-pass recall fell ${recall(a, "truthPassRecall")} → ${recall(b, "truthPassRecall")}`);
  if (recall(b, "truthFailRecall") < recall(a, "truthFailRecall") - tolerance) reasons.push(`truth-fail recall fell ${recall(a, "truthFailRecall")} → ${recall(b, "truthFailRecall")}`);
  if (b.auc !== null && a.auc !== null && b.auc < a.auc - tolerance) reasons.push(`AUC fell ${a.auc} → ${b.auc}`);
  if (b.brier !== null && a.brier !== null && b.brier > a.brier + minImprovement) reasons.push(`Brier worsened ${a.brier} → ${b.brier}`);
  if (a.cannotDetermineMass !== null && b.cannotDetermineMass !== null && b.cannotDetermineMass > a.cannotDetermineMass + maxCannotDetermineGrowth) reasons.push(`cannot-determine mass grew ${a.cannotDetermineMass} → ${b.cannotDetermineMass}`);
  if (incumbentPairs && proposalPairs) {
    const before = new Map(incumbentPairs.rows.map((r) => [r.pairId, r.separatedByMargin]));
    const regressed = proposalPairs.rows.filter((r) => before.get(r.pairId) && !r.separatedByMargin).map((r) => r.pairId);
    if (regressed.length > 0) reasons.push(`pairs regressed: ${regressed.join(", ")}`);
  }
  const errors = (m) => m.confusion.falsePass + m.confusion.falseFail;
  const improved =
    (b.auc !== null && a.auc !== null && b.auc > a.auc + minImprovement) ||
    (b.brier !== null && a.brier !== null && b.brier < a.brier - minImprovement) ||
    errors(b) < errors(a) ||
    (incumbentPairs && proposalPairs && proposalPairs.summary.separatedByMarginRate > incumbentPairs.summary.separatedByMarginRate);
  if (reasons.length === 0 && !improved) reasons.push("no measurable improvement on held-out");
  return { accepted: reasons.length === 0, reasons, improved: Boolean(improved) };
}

function addUsage(ledger, model, usage) {
  const key = model ?? "unknown";
  ledger[key] ??= { input_tokens: 0, output_tokens: 0 };
  ledger[key].input_tokens += usage.input_tokens ?? 0;
  ledger[key].output_tokens += usage.output_tokens ?? 0;
}

/**
 * @param {{
 *   criterion: object, cases: object[], pairs?: object[],
 *   judges: Record<string, { systemOne: Function, model?: string }>,
 *   author: { propose: Function, model?: string, name?: string },
 *   binding: string, rounds?: number, seed?: number, heldOutFraction?: number,
 *   log?: (line: string) => void
 * }} input
 */
export async function runAutoloop({ criterion, cases, pairs = [], judges, author, binding, rounds = 5, seed = 11, heldOutFraction = 0.4, log = () => {} }) {
  if (!judges[binding]) throw new Error(`binding "${binding}" is not one of the judges: ${Object.keys(judges).join(", ")}`);
  const { shown, heldOut } = splitCases(cases, { seed, heldOutFraction });
  const usageLedger = {};
  const judgeModelOf = (name, measurement) => measurement.model ?? judges[name].model ?? name;
  const independence = Object.values(judges).every((j) => (j.model ?? "") !== (author.model ?? ""));

  const measureAll = async (version) => {
    const shownBy = {};
    const heldOutBy = {};
    for (const name of Object.keys(judges)) {
      shownBy[name] = await measure({ provider: judges[name], version, cases: shown });
      heldOutBy[name] = await measure({ provider: judges[name], version, cases: heldOut });
      addUsage(usageLedger, judgeModelOf(name, shownBy[name]), shownBy[name].usage);
      addUsage(usageLedger, judgeModelOf(name, heldOutBy[name]), heldOutBy[name].usage);
    }
    const pairReports = {};
    if (pairs.length > 0) {
      pairReports[version.binding] = await runMinimalPairs({ provider: judges[version.binding], criterion: version, pairs });
      addUsage(usageLedger, judgeModelOf(version.binding, shownBy[version.binding]), { input_tokens: pairReports[version.binding].summary.inputTokens, output_tokens: 0 });
    }
    return { shownBy, heldOutBy, pairReports };
  };

  let current = { ...criterion, number: 0, parent: null, binding, abstention: Boolean(criterion.abstention) };
  const versions = [current];
  let currentMeasure = await measureAll(current);
  const initial = { version: current, heldOut: Object.fromEntries(Object.entries(currentMeasure.heldOutBy).map(([n, m]) => [n, m.metrics])), shown: Object.fromEntries(Object.entries(currentMeasure.shownBy).map(([n, m]) => [n, m.metrics])), pairs: currentMeasure.pairReports[current.binding]?.summary ?? null };
  log(`v0 on ${current.binding}: held-out AUC ${initial.heldOut[current.binding].auc}, Brier ${initial.heldOut[current.binding].brier}, errors ${initial.heldOut[current.binding].confusion.falsePass + initial.heldOut[current.binding].confusion.falseFail}`);

  const history = [];
  for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
    const packet = buildEvidencePacket({ version: current, judges: currentMeasure.shownBy, cases: shown, pairs, pairReports: currentMeasure.pairReports, history });
    const leaked = packet.includedCaseIds.filter((id) => heldOut.some((h) => h.id === id));
    if (leaked.length > 0) throw new Error(`held-out ids reached the author: ${leaked.join(", ")}`);
    const { proposal, model: authorModel, usage: authorUsage } = await author.propose(packet);
    addUsage(usageLedger, authorModel ?? author.model ?? "author", authorUsage ?? { input_tokens: 0, output_tokens: 0 });
    const applied = applyProposal(current, proposal);
    const candidate = applied.version;
    let entry = { round: roundIndex, kind: proposal.kind, changed: applied.changed, rationale: proposal.rationale, targets: proposal.targets ?? [], accepted: false, reasons: [], candidateNumber: candidate.number };
    if (!judges[candidate.binding]) {
      entry.reasons = [`binding "${candidate.binding}" is not available`];
    } else {
      const candidateMeasure = await measureAll(candidate);
      const verdict = gateProposal({
        kind: proposal.kind,
        changed: applied.changed,
        incumbent: currentMeasure.heldOutBy[current.binding],
        proposal: candidateMeasure.heldOutBy[candidate.binding],
        incumbentPairs: currentMeasure.pairReports[current.binding] ?? null,
        proposalPairs: candidateMeasure.pairReports[candidate.binding] ?? null
      });
      entry = { ...entry, accepted: verdict.accepted, reasons: verdict.reasons, heldOut: candidateMeasure.heldOutBy[candidate.binding].metrics, shown: candidateMeasure.shownBy[candidate.binding].metrics, pairs: candidateMeasure.pairReports[candidate.binding]?.summary ?? null };
      if (verdict.accepted) {
        current = candidate;
        versions.push(current);
        currentMeasure = candidateMeasure;
      }
    }
    history.push(entry);
    log(`round ${roundIndex}: ${entry.kind} on ${candidate.binding} → ${entry.accepted ? "accepted" : "rejected"}${entry.reasons.length ? ` (${entry.reasons.join("; ")})` : ""}`);
  }

  const finalHeldOut = currentMeasure.heldOutBy[current.binding].metrics;
  const cost = Object.fromEntries(Object.entries(usageLedger).map(([model, usage]) => [model, { ...usage, estimatedUsd: round(estimateCost(model, usage), 4) }]));
  return {
    experiment: "autoloop",
    criterion: criterion.key,
    split: { seed, heldOutFraction, shown: shown.map((c) => c.id), heldOut: heldOut.map((c) => c.id) },
    author: { name: author.name, model: author.model ?? null, independentOfJudges: independence },
    judges: Object.fromEntries(Object.keys(judges).map((n) => [n, judges[n].model ?? null])),
    initial,
    final: { version: current, heldOut: finalHeldOut, shown: currentMeasure.shownBy[current.binding].metrics, pairs: currentMeasure.pairReports[current.binding]?.summary ?? null },
    delta: {
      auc: round((finalHeldOut.auc ?? 0) - (initial.heldOut[binding].auc ?? 0)),
      brier: round((finalHeldOut.brier ?? 0) - (initial.heldOut[binding].brier ?? 0)),
      errors: (finalHeldOut.confusion.falsePass + finalHeldOut.confusion.falseFail) - (initial.heldOut[binding].confusion.falsePass + initial.heldOut[binding].confusion.falseFail)
    },
    accepted: history.filter((h) => h.accepted).length,
    rounds: history,
    versions,
    cost
  };
}

async function loadFixtures(directory) {
  const read = async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"));
  const criterion = await read("criterion.json");
  const cases = await read("cases.json");
  let pairs = [];
  try { pairs = await read("pairs.json"); } catch { pairs = []; }
  return { criterion, cases, pairs };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const fixtures = path.resolve(arg("fixtures", path.join(here, "fixtures")));
  const rounds = Number(arg("rounds", "5"));
  const seed = Number(arg("seed", "11"));
  const heldOutFraction = Number(arg("heldout", "0.4"));
  const { criterion, cases, pairs } = await loadFixtures(fixtures);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(process.env.TYPESAFE_LOOP_OUT ?? path.join(here, "..", "..", "out", "typesafe-loop", `autoloop-${stamp}`));
  await mkdir(outDir, { recursive: true });
  const cacheDir = path.join(path.dirname(outDir), "cache");

  const judgeSpec = (process.env.AUTOLOOP_JUDGES ?? "mock").split(",").map((s) => s.trim());
  const judges = {};
  const cues = { [criterion.key]: criterion.mockCues ?? { positive: [], negative: [] } };
  for (const name of judgeSpec) {
    if (name === "mock") {
      // Demo pair: "mock-a" ignores every cue (a near-constant judge); "mock-oracle" knows the
      // fixture labels with noise, so the scripted binding switch has something real to find.
      judges["mock-a"] = createMockProvider({ cues: {}, model: "mock-a" });
      judges["mock-oracle"] = createOracleProvider({ cases, key: criterion.key });
    } else if (name === "typesafe") judges.typesafe = await withCache(createTypeSafeProvider(), cacheDir);
    else if (name === "anthropic") judges.anthropic = await withCache(createAnthropicProvider(), cacheDir);
    else throw new Error(`unknown judge "${name}"`);
  }
  const binding = arg("binding", Object.keys(judges)[0]);
  const authorSpec = process.env.AUTOLOOP_AUTHOR ?? (judgeSpec.includes("mock") ? "scripted" : "claude");
  const other = Object.keys(judges).find((n) => n !== binding) ?? binding;
  const author = authorSpec === "claude"
    ? createClaudeAuthor()
    : createScriptedAuthor([
        { kind: "abstention_toggle", abstention: true, cannotDetermineDescription: "The reply neither states the window nor processes a refund, so the outcome cannot be judged from the state." },
        { kind: "binding_switch", binding: other },
        (packet) => ({ kind: "criteria_descriptions", failDescription: `${packet.version.failDescription} Deferring to another team without naming the window is a fail.` })
      ]);

  const report = await runAutoloop({ criterion, cases, pairs, judges, author, binding, rounds, seed, heldOutFraction, log: (line) => console.log(line) });
  await writeFile(path.join(outDir, "autoloop.json"), JSON.stringify(report, null, 2));
  const b0 = report.initial.heldOut[binding];
  const bN = report.final.heldOut;
  console.log("\n== held-out, initial vs final");
  console.log(`version   binding     auc    brier  ece    falsePass  falseFail  cannotDet`);
  console.log(`v0        ${binding.padEnd(10)}  ${b0.auc}  ${b0.brier}  ${b0.ece}  ${b0.confusion.falsePass}          ${b0.confusion.falseFail}          ${b0.cannotDetermineMass}`);
  console.log(`v${report.final.version.number}        ${report.final.version.binding.padEnd(10)}  ${bN.auc}  ${bN.brier}  ${bN.ece}  ${bN.confusion.falsePass}          ${bN.confusion.falseFail}          ${bN.cannotDetermineMass}`);
  console.log(`accepted ${report.accepted} of ${rounds}; author ${report.author.model} independent of judges: ${report.author.independentOfJudges}`);
  console.log(`cost ${JSON.stringify(report.cost)}`);
  console.log(`report written to ${outDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
