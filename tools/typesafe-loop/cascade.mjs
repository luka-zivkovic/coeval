#!/usr/bin/env node
// Held-out validation of a cheap-then-strong cascade from a compare.mjs report:
// the cheap judge answers every case, and cases whose probability falls
// within `band` of 0.5 go to the strong judge. The band is chosen on one fold
// and scored on the other (two folds by a seeded hash of the case id), so the
// reported accuracy is never measured on the cases that picked the band.
// With --train-report, the band is instead chosen on every case of the paired
// training set (--train-sets, matched to --sets by position) and scored on
// every case of the test set, which shares no case with it.
//
//   node tools/typesafe-loop/cascade.mjs --report <report.json> \
//     [--cheap jev-1.13.0] [--strong claude-opus-5-5] [--sets chaosmnli,mtbench,mtbench-swapped] \
//     [--train-report <report.json> --train-sets chaosmnli,mtbench]
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { rate } from "./compare-stats.mjs";
import { round } from "./metrics.mjs";

const { values: args } = parseArgs({
  options: {
    report: { type: "string" },
    cheap: { type: "string", default: "jev-1.13.0" },
    strong: { type: "string", default: "claude-opus-5-5" },
    sets: { type: "string", default: "chaosmnli,mtbench,mtbench-swapped" },
    seed: { type: "string", default: "cascade-v1" },
    "train-report": { type: "string" },
    "train-sets": { type: "string" }
  }
});
if (!args.report) throw new Error("--report is required");
if (Boolean(args["train-report"]) !== Boolean(args["train-sets"])) throw new Error("--train-report and --train-sets go together");

const BANDS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
const fold = (id) => createHash("sha256").update(`${args.seed}:${id}`).digest()[0] % 2;

/** Accuracy and escalation share for one band over the given cases. */
export function cascadeAt(cases, band) {
  let right = 0;
  let escalated = 0;
  for (const c of cases) {
    const escalate = Math.abs(c.cheap.p - 0.5) < band;
    if (escalate) escalated += 1;
    const label = escalate ? c.strong.label : c.cheap.label;
    if (label === c.truth) right += 1;
  }
  return { right, escalated, n: cases.length };
}

/** The band with the best training accuracy; ties go to the smaller, cheaper band. */
export function chooseBand(cases) {
  let best = { band: 0, accuracy: -1 };
  for (const band of BANDS) {
    const { right, n } = cascadeAt(cases, band);
    if (right / n > best.accuracy) best = { band, accuracy: right / n };
  }
  return best.band;
}

/** The routable cases of one set: both judges answered pass or fail, and the cheap judge gave a probability. */
function loadSet(report, setName) {
  const set = report.sets.find((s) => s.set === setName);
  if (!set) throw new Error(`set ${setName} is not in the report`);
  const summary = (judge) => {
    const found = set.summaries.find((s) => s.judge === judge);
    if (!found) throw new Error(`judge ${judge} is not in set ${setName}`);
    return found;
  };
  const cheap = summary(args.cheap);
  const strong = summary(args.strong);
  const byId = new Map(strong.items.map((i) => [i.id, i]));
  // Cases where either judge failed or abstained can't be routed honestly; they are counted out.
  const cases = cheap.items
    .map((i) => ({ id: i.id, truth: i.truth, cheap: i, strong: byId.get(i.id) }))
    .filter((c) => c.strong && c.cheap.p !== null && ["pass", "fail"].includes(c.cheap.label) && ["pass", "fail"].includes(c.strong.label));
  return { cheap, strong, cases };
}

const report = JSON.parse(await readFile(args.report, "utf8"));
const trainReport = args["train-report"] ? JSON.parse(await readFile(args["train-report"], "utf8")) : null;
const trainSets = args["train-sets"]?.split(",") ?? [];
const testSets = args.sets.split(",");
if (trainReport && trainSets.length !== testSets.length) throw new Error("--train-sets must pair with --sets one to one");
const results = [];
for (const [index, setName] of testSets.entries()) {
  const { cheap, strong, cases } = loadSet(report, setName);
  let right = 0;
  let escalated = 0;
  const bands = [];
  if (trainReport) {
    const train = loadSet(trainReport, trainSets[index]);
    const shared = new Set(train.cases.map((c) => c.id));
    if (cases.some((c) => shared.has(c.id))) throw new Error(`${trainSets[index]} and ${setName} share cases`);
    const band = chooseBand(train.cases);
    bands.push(band);
    ({ right, escalated } = cascadeAt(cases, band));
  } else {
    for (const test of [0, 1]) {
      const band = chooseBand(cases.filter((c) => fold(c.id) !== test));
      bands.push(band);
      const scored = cascadeAt(cases.filter((c) => fold(c.id) === test), band);
      right += scored.right;
      escalated += scored.escalated;
    }
  }
  const accuracyOf = (judge) => rate(cases.filter((c) => c[judge].label === c.truth).length, cases.length);
  const cost = (s) => s.costPer1kUsd;
  results.push({
    set: setName,
    trainedOn: trainReport ? trainSets[index] : "other fold",
    cases: cases.length,
    bandsChosen: bands,
    cheapOnly: { accuracy: accuracyOf("cheap"), costPer1kUsd: cost(cheap) },
    strongOnly: { accuracy: accuracyOf("strong"), costPer1kUsd: cost(strong) },
    cascadeHeldOut: {
      accuracy: rate(right, cases.length),
      escalatedShare: round(escalated / cases.length),
      costPer1kUsd: round(cost(cheap) + (escalated / cases.length) * cost(strong), 3)
    }
  });
}
console.log(JSON.stringify({
  report: args.report,
  trainReport: args["train-report"] ?? null,
  cheap: args.cheap,
  strong: args.strong,
  seed: trainReport ? null : args.seed,
  results
}, null, 2));
