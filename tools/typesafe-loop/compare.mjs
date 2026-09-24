#!/usr/bin/env node
// Issue #101 spike: pinned Jev against Rubrist's own LLM judge path, one
// criterion per fixture set, scored against that set's truth. ASSUMPTION-class
// diagnostics on public, nonsealed data: nothing here is a calibration claim
// under ADR-0004 or ADR-0009.
//
// Jev answers the criterion as one noul question over the trace. The LLM judge
// runs exactly what sealed calibration runs: the rubric rendered through
// renderJudgePromptContent with the default prompt template, then
// AnthropicJudgeProvider.judgeStructured with a binary spec. Its probability is
// the verdict's own score ("1 = strong pass, 0 = strong fail").
//
//   node --env-file=.env tools/typesafe-loop/compare.mjs \
//     --sets chaosmnli,mtbench,taubench \
//     --judges jev-1.13.0,claude-haiku-4-5-20251001,claude-sonnet-5 [--limit 20] [--concurrency 4]
//
// Calls are cached under out/typesafe-loop/cache/compare/, so a rerun pays only
// for what is missing. Keys are read from the environment and never written.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AnthropicJudgeProvider } from "../../apps/audit/dist/runtime.js";
import { defaultJudgePromptTemplate, renderJudgePromptContent } from "../../packages/shared/dist/index.js";
import { PRICING } from "./autoloop.mjs";
import { brierScore, expectedCalibrationError, rocAuc, round } from "./metrics.mjs";
import { createTypeSafeProvider } from "./providers.mjs";
import { canonicalJson, criterionQuestion, passProbability } from "./questions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const { values: args } = parseArgs({
  options: {
    sets: { type: "string", default: "chaosmnli,mtbench,taubench" },
    judges: { type: "string", default: "jev-1.13.0,claude-haiku-4-5-20251001" },
    fixtures: { type: "string", default: path.join(here, "fixtures", "compare") },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string", default: path.join(root, "out", "typesafe-loop", "compare", new Date().toISOString().replace(/[:.]/g, "-")) }
  }
});

const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const cacheRoot = path.join(root, "out", "typesafe-loop", "cache", "compare");

function traceState(testCase) {
  return testCase.steps?.length
    ? { input: testCase.input, output: testCase.output, steps: testCase.steps }
    : { input: testCase.input, output: testCase.output };
}

function rubricFor(criterion) {
  return `# ${criterion.title}\n\n${criterion.question}\n\n## Pass\n\n${criterion.passDescription}\n\n## Fail\n\n${criterion.failDescription}`;
}

/** Jev pinned to one version; a served model that differs is an error, never a silent substitution. */
function jevJudge(model) {
  const provider = createTypeSafeProvider({ model, timeoutMs: 30_000 });
  return {
    name: model,
    async judge(criterion, testCase) {
      const result = await provider.systemOne({ state: traceState(testCase), questions: criterionQuestion(criterion) });
      if (result.model !== model) throw new Error(`jev served ${result.model} for pinned ${model}`);
      const { p } = passProbability(result.answers[criterion.key]);
      return { servedModel: result.model, p, label: p >= 0.5 ? "pass" : "fail", usage: result.usage };
    }
  };
}

/**
 * Rubrist's Anthropic judge. Claude 5 models reject `temperature`, which the
 * single-call policy always sends (issue #120), so this uses the ordinary
 * policy: at most one extra call per model to learn that, then no temperature.
 */
function claudeJudge(model) {
  const provider = new AnthropicJudgeProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model, temperature: 0 });
  return {
    name: model,
    async judge(criterion, testCase) {
      const judged = await provider.judgeStructured({
        prompt: {
          id: criterion.key,
          name: criterion.key,
          kind: "unified",
          content: renderJudgePromptContent({ rubricMarkdown: rubricFor(criterion), prompt: defaultJudgePromptTemplate("trace") })
        },
        trace: { id: testCase.id, ...traceState(testCase) },
        spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
      });
      const verdict = judged.verdict;
      if (verdict.kind !== "binary") throw new Error("judge returned a non-binary verdict");
      return {
        servedModel: judged.providerMetadata?.model ?? null,
        p: verdict.score,
        label: verdict.label === "ambiguous" ? "abstain" : verdict.label,
        usage: judged.usage ? { input_tokens: judged.usage.inputTokens, output_tokens: judged.usage.outputTokens } : null
      };
    }
  };
}

async function cached(judge, criterion, testCase) {
  const key = digest({ judge: judge.name, criterion, state: traceState(testCase), rubricTemplate: judge.name.startsWith("jev") ? null : defaultJudgePromptTemplate("trace") });
  const file = path.join(cacheRoot, judge.name, `${key}.json`);
  try {
    return { ...JSON.parse(await readFile(file, "utf8")), cached: true };
  } catch {
    const started = performance.now();
    try {
      const result = await judge.judge(criterion, testCase);
      const record = { ...result, ms: Math.round(performance.now() - started) };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(record));
      return { ...record, cached: false };
    } catch (error) {
      // Errors are reported, not cached, so a rerun retries them.
      return { error: String(error?.message ?? error).slice(0, 300), ms: Math.round(performance.now() - started), cached: false };
    }
  }
}

async function pool(items, concurrency, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

/** Wilson 95% interval for k of n, the interval ADR-0004 reporting uses. */
function wilson(k, n) {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

function rate(k, n) {
  return { k, n, rate: n ? round(k / n) : null, wilson95: wilson(k, n) };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function spearman(xs, ys) {
  const ranks = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(values.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      for (let k = i; k <= j; k += 1) r[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? round(num / Math.sqrt(dx * dy)) : null;
}

function costPerThousand(model, rows) {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k)) ?? null;
  const priced = rows.filter((r) => r.usage);
  if (!key || priced.length === 0) return null;
  const perCall = priced.reduce((sum, r) => sum + r.usage.input_tokens * PRICING[key].input + r.usage.output_tokens * PRICING[key].output, 0) / priced.length / 1_000_000;
  return round(perCall * 1000, 4);
}

function summarize(set, judgeName, cases, results) {
  const rows = cases.map((c, i) => ({ id: c.id, truth: c.humanLabel, split: c.reviewerDisagreement, soft: c.softLabel ?? null, ...results[i] }));
  const answered = rows.filter((r) => !r.error);
  const decided = answered.filter((r) => r.label !== "abstain");
  const truthPass = decided.filter((r) => r.truth === "pass");
  const truthFail = decided.filter((r) => r.truth === "fail");
  const correct = decided.filter((r) => r.label === r.truth);
  const probability = answered.map((r) => ({ p: r.p, label: r.truth === "pass" ? 1 : 0 }));
  const fresh = answered.filter((r) => !r.cached).map((r) => r.ms).sort((a, b) => a - b);
  const bySplit = (split) => {
    const subset = decided.filter((r) => r.split === split);
    return rate(subset.filter((r) => r.label === r.truth).length, subset.length);
  };
  const soft = answered.filter((r) => typeof r.soft === "number");
  return {
    set,
    judge: judgeName,
    servedModels: [...new Set(answered.map((r) => r.servedModel).filter(Boolean))],
    cases: rows.length,
    errors: rows.length - answered.length,
    abstained: answered.length - decided.length,
    accuracy: rate(correct.length, decided.length),
    passRecall: rate(truthPass.filter((r) => r.label === "pass").length, truthPass.length),
    failRecall: rate(truthFail.filter((r) => r.label === "fail").length, truthFail.length),
    falsePass: truthFail.filter((r) => r.label === "pass").length,
    falseFail: truthPass.filter((r) => r.label === "fail").length,
    accuracyWhenReviewersAgree: bySplit(false),
    accuracyWhenReviewersSplit: bySplit(true),
    brier: probability.length ? round(brierScore(probability)) : null,
    auc: probability.length ? round(rocAuc(probability)) : null,
    ece: probability.length ? round(expectedCalibrationError(probability).ece) : null,
    softLabel: soft.length
      ? { spearman: spearman(soft.map((r) => r.p), soft.map((r) => r.soft)), brier: round(soft.reduce((s, r) => s + (r.p - r.soft) ** 2, 0) / soft.length) }
      : null,
    latencyMs: { measured: fresh.length, p50: quantile(fresh, 0.5), p95: quantile(fresh, 0.95) },
    meanInputTokens: answered.some((r) => r.usage) ? Math.round(answered.filter((r) => r.usage).reduce((s, r) => s + r.usage.input_tokens, 0) / answered.filter((r) => r.usage).length) : null,
    costPer1kUsd: costPerThousand(judgeName, answered),
    items: rows.map((r) => ({ id: r.id, truth: r.truth, label: r.label ?? null, p: r.p ?? null, ms: r.ms, error: r.error ?? null }))
  };
}

function agreement(a, b) {
  const pairs = a.items.map((item, i) => [item, b.items[i]]).filter(([x, y]) => x.label && y.label && x.label !== "abstain" && y.label !== "abstain");
  return rate(pairs.filter(([x, y]) => x.label === y.label).length, pairs.length);
}

const judges = args.judges.split(",").map((name) => (name.startsWith("jev") ? jevJudge(name) : claudeJudge(name)));
const report = { generatedAt: new Date().toISOString(), judges: judges.map((j) => j.name), sets: [] };
for (const set of args.sets.split(",")) {
  const dir = path.join(args.fixtures, set);
  const criterion = JSON.parse(await readFile(path.join(dir, "criterion.json"), "utf8"));
  const all = JSON.parse(await readFile(path.join(dir, "cases.json"), "utf8"));
  const cases = args.limit ? all.slice(0, Number(args.limit)) : all;
  const summaries = [];
  for (const judge of judges) {
    const results = await pool(cases, Number(args.concurrency), (c) => cached(judge, criterion, c));
    const summary = summarize(set, judge.name, cases, results);
    summaries.push(summary);
    console.error(`${set} ${judge.name}: accuracy ${summary.accuracy.rate} ${JSON.stringify(summary.accuracy.wilson95)}, errors ${summary.errors}, abstained ${summary.abstained}, p50 ${summary.latencyMs.p50} ms`);
  }
  const agreements = [];
  for (let i = 0; i < summaries.length; i += 1) {
    for (let j = i + 1; j < summaries.length; j += 1) agreements.push({ a: summaries[i].judge, b: summaries[j].judge, ...agreement(summaries[i], summaries[j]) });
  }
  report.sets.push({ set, criterion: { key: criterion.key, question: criterion.question, notes: criterion.notes }, cases: cases.length, prevalence: round(cases.filter((c) => c.humanLabel === "pass").length / cases.length), summaries, agreements });
}

await mkdir(args.out, { recursive: true });
await writeFile(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.error(`report: ${path.join(args.out, "report.json")}`);
