#!/usr/bin/env node
// Fixture set "chaosmnli" from metaeval/chaos-mnli-ambiguity, the MNLI subset of
// ChaosNLI (Nie et al., 2020) with 100 annotators per item. Criterion: does the
// premise entail the hypothesis? humanLabel is pass when at least half of the
// annotators chose entailment; reviewerDisagreement is true when the entailment
// share is strictly between 0.3 and 0.7; softLabel keeps the share itself. Pairs
// put a high-agreement entailed hypothesis against a high-agreement contradicting
// one (same premise when the data has one, otherwise another premise).
//
//   NODE_USE_ENV_PROXY=1 node tools/typesafe-loop/fixtures/build/chaosmnli.mjs
import path from "node:path";
import { huggingFaceRows, pad, rawRoot, seededShuffle, writeFixture } from "./common.mjs";

const rows = await huggingFaceRows({ dataset: "metaeval/chaos-mnli-ambiguity", split: "train", rawDir: path.join(rawRoot, "chaosmnli") });
const share = (r) => { const c = r.label_counter; const total = (c.e ?? 0) + (c.n ?? 0) + (c.c ?? 0); return total ? (c.e ?? 0) / total : 0; };
const shuffle = seededShuffle(5);
const items = shuffle(rows.map((r) => ({ r, s: share(r) })).filter((x) => x.r.premise.length <= 600));
const pick = (filter, n) => items.filter(filter).slice(0, n);
const chosen = [
  ...pick((x) => x.s >= 0.85, 10),
  ...pick((x) => x.s <= 0.15, 10),
  ...pick((x) => x.s >= 0.5 && x.s < 0.7, 10),
  ...pick((x) => x.s > 0.3 && x.s < 0.5, 10)
];
const cases = chosen.map((x, i) => ({
  id: `n${pad(i + 1)}`,
  input: { premise: x.r.premise },
  output: { hypothesis: x.r.hypothesis },
  steps: [],
  humanLabel: x.s >= 0.5 ? "pass" : "fail",
  reviewerDisagreement: x.s > 0.3 && x.s < 0.7,
  softLabel: x.s,
  note: `uid ${x.r.uid}; counts ${JSON.stringify(x.r.label_counter)}; majority ${x.r.majority_label}; original 5 labels ${JSON.stringify(x.r.old_labels)}`
}));
const byPremise = new Map();
for (const x of items) { if (!byPremise.has(x.r.premise)) byPremise.set(x.r.premise, []); byPremise.get(x.r.premise).push(x); }
const pairs = [];
for (const [premise, xs] of byPremise) {
  const e = xs.find((x) => x.s >= 0.85);
  const c = xs.find((x) => x.r.majority_label === "c" && (x.r.label_counter.c ?? 0) >= 85);
  if (e && c) pairs.push({ id: `np${pad(pairs.length + 1)}`, input: { premise }, steps: [], passOutput: { hypothesis: e.r.hypothesis }, failOutput: { hypothesis: c.r.hypothesis }, edit: "contradicting hypothesis, same premise" });
  if (pairs.length === 8) break;
}
if (pairs.length < 8) {
  const es = items.filter((x) => x.s >= 0.9);
  const cs = items.filter((x) => x.r.majority_label === "c" && (x.r.label_counter.c ?? 0) >= 90);
  for (let i = 0; pairs.length < 8 && i < Math.min(es.length, cs.length); i += 1) {
    pairs.push({ id: `np${pad(pairs.length + 1)}`, input: { premise: es[i].r.premise }, steps: [], passOutput: { hypothesis: es[i].r.hypothesis }, failOutput: { hypothesis: cs[i].r.hypothesis }, edit: "contradicting hypothesis from another premise" });
  }
}
const criterion = {
  key: "premise_entails_hypothesis",
  title: "Premise entails hypothesis",
  question: "Given the premise, is the hypothesis definitely true (entailed)?",
  passDescription: "A reasonable reader would say the hypothesis is definitely true given the premise.",
  failDescription: "The hypothesis is not established by the premise: it might be true (neutral) or it contradicts the premise.",
  notes: "Adapted from metaeval/chaos-mnli-ambiguity (ChaosNLI MNLI subset, 100 annotators per item). humanLabel is pass when at least half the annotators chose entailment. reviewerDisagreement is true when the entailment share is between 0.3 and 0.7. softLabel holds the entailment share.",
  mockCues: { positive: [], negative: [] }
};
const dir = await writeFixture("chaosmnli", { criterion, cases, pairs });
console.log(`${dir}: ${cases.length} cases (${cases.filter((c) => c.reviewerDisagreement).length} reviewer-split, ${cases.filter((c) => c.humanLabel === "pass").length} pass), ${pairs.length} pairs, from ${rows.length} rows`);
