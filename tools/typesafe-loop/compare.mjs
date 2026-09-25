#!/usr/bin/env node
// Issue #101 spike: pinned Jev against Rubrist's own LLM judge, one criterion
// per fixture set, scored against that set's truth. ASSUMPTION-class
// diagnostics on public, nonsealed data: nothing here is a calibration claim
// under ADR-0004 or ADR-0009.
//
// Jev answers the criterion as one noul question over the trace, pinned to a
// version; a response that doesn't report the pinned model is an error. Claude
// judges run Rubrist's sealed-calibration request exactly: the rubric rendered
// through renderJudgePromptContent with the default template, then
// AnthropicJudgeProvider.judgeStructured with a binary spec, single physical
// call, no SDK retries. Models that reject `temperature` (issue #120) get the
// same request without it, and models that reject a forced tool choice get
// `tool_choice: auto` with the same verdict tool; the report names each
// deviation. The LLM probability is the verdict score.
//
// A judge name may carry one variant after "@", which becomes part of its
// name, cache key, and report row:
//   jev-…@decomposed           ask the set's decomposed.json questions in one
//                              call; the run passes only if all hold, and its
//                              probability is the smallest one
//   claude-…@thinking-disabled send thinking {type: "disabled"}
//   claude-…@thinking-adaptive send thinking {type: "adaptive"} with
//                              tool_choice auto, since a forced tool can't
//                              follow thinking
//
//   node --env-file=.env tools/typesafe-loop/compare.mjs \
//     --judges jev-1.13.0,claude-haiku-4-5-20251001,claude-sonnet-4-6 [--limit 20]
//
// Needs `pnpm --filter @rubrist/shared --filter @rubrist/audit build` first.
// Calls are cached under out/typesafe-loop/cache/compare/v2/, keyed by the
// exact request, so a rerun pays only for what is missing and never reuses a
// verdict for a request that changed. Keys come from the environment only.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AnthropicJudgeProvider } from "../../apps/audit/dist/runtime.js";
import { defaultJudgePromptTemplate, renderJudgePromptContent } from "../../packages/shared/dist/index.js";
import { estimateCost } from "./autoloop.mjs";
import { mcnemarExact, orderConsistency, pairedBootstrap, quantile, rate, spearman } from "./compare-stats.mjs";
import { brierScore, expectedCalibrationError, rocAuc, round } from "./metrics.mjs";
import { createTypeSafeProvider } from "./providers.mjs";
import { canonicalJson, criterionQuestion, noul, passProbability } from "./questions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const CACHE_VERSION = "v2";
const BINARY = { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null };

const { values: args } = parseArgs({
  options: {
    sets: { type: "string", default: "chaosmnli,mtbench,mtbench-swapped,taubench" },
    judges: { type: "string", default: "jev-1.13.0,claude-haiku-4-5-20251001" },
    "no-temperature": { type: "string", default: "claude-sonnet-5,claude-opus-5-5,claude-fable-5-1" },
    "auto-tool-choice": { type: "string", default: "claude-opus-5-5,claude-fable-5-1" },
    fixtures: { type: "string", default: path.join(here, "fixtures", "compare") },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string", default: path.join(root, "out", "typesafe-loop", "compare", new Date().toISOString().replace(/[:.]/g, "-")) }
  }
});

const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const cacheRoot = path.join(root, "out", "typesafe-loop", "cache", "compare", CACHE_VERSION);
const noTemperature = new Set(args["no-temperature"].split(",").filter(Boolean));
const autoToolChoice = new Set(args["auto-tool-choice"].split(",").filter(Boolean));
const Anthropic = await (async () => {
  const resolved = createRequire(path.join(root, "apps", "audit", "package.json")).resolve("@anthropic-ai/sdk");
  const module = await import(pathToFileURL(resolved).href);
  return module.default?.default ?? module.default ?? module.Anthropic;
})();

function traceState(testCase) {
  return testCase.steps?.length
    ? { input: testCase.input, output: testCase.output, steps: testCase.steps }
    : { input: testCase.input, output: testCase.output };
}

function rubricFor(criterion) {
  return `# ${criterion.title}\n\n${criterion.question}\n\n## Pass\n\n${criterion.passDescription}\n\n## Fail\n\n${criterion.failDescription}`;
}

function jevJudge(model, variant) {
  if (variant && variant !== "decomposed") throw new Error(`unknown Jev variant ${variant}`);
  const provider = createTypeSafeProvider({ model, timeoutMs: 30_000 });
  const questionsFor = (criterion) => {
    if (!variant) return criterionQuestion(criterion);
    if (!criterion.decomposed) throw new Error(`set for ${criterion.key} has no decomposed.json`);
    return Object.fromEntries(Object.entries(criterion.decomposed.questions)
      .map(([name, q]) => [name, noul(q.instructions, q.criteria)]));
  };
  const request = (criterion, testCase) => ({ model, state: traceState(testCase), questions: questionsFor(criterion) });
  return {
    name: variant ? `${model}@${variant}` : model,
    transport: variant ? "POST /v1/systemone, one attempt, decomposed questions (all must hold)" : "POST /v1/systemone, one attempt",
    requestKey: async (criterion, testCase) => request(criterion, testCase),
    async judge(criterion, testCase) {
      const { state, questions } = request(criterion, testCase);
      const result = await provider.systemOne({ state, questions });
      if (result.model !== model) throw new Error(`jev reported ${result.model ?? "no model"} for pinned ${model}`);
      if (!variant) {
        const { p } = passProbability(result.answers[criterion.key]);
        return { servedModel: result.model, p, label: p >= 0.5 ? "pass" : "fail", usage: result.usage };
      }
      const parts = Object.fromEntries(Object.keys(questions).map((name) => [name, passProbability(result.answers[name]).p]));
      const p = Math.min(...Object.values(parts));
      return { servedModel: result.model, p, label: p >= 0.5 ? "pass" : "fail", usage: result.usage, parts };
    }
  };
}

function claudeJudge(model, variant) {
  if (variant && !["thinking-disabled", "thinking-adaptive"].includes(variant)) throw new Error(`unknown Claude variant ${variant}`);
  const omitTemperature = noTemperature.has(model);
  const autoTool = autoToolChoice.has(model) || variant === "thinking-adaptive";
  const thinking = variant === "thinking-disabled" ? { type: "disabled" } : variant === "thinking-adaptive" ? { type: "adaptive" } : null;
  const shape = (params) => {
    const { temperature, ...rest } = params;
    return {
      ...rest,
      ...(omitTemperature ? {} : { temperature }),
      ...(autoTool ? { tool_choice: { type: "auto" } } : {}),
      ...(thinking ? { thinking, max_tokens: Math.max(rest.max_tokens, 16_000) } : {})
    };
  };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const provider = new AnthropicJudgeProvider({
    model,
    temperature: 0,
    requestPolicy: "single_physical_call",
    messagesCreate: (params) => client.messages.create(shape(params))
  });
  const judgeInput = (criterion, testCase) => ({
    prompt: {
      id: criterion.key,
      name: criterion.key,
      kind: "unified",
      content: renderJudgePromptContent({ rubricMarkdown: rubricFor(criterion), prompt: defaultJudgePromptTemplate("trace") })
    },
    trace: { id: testCase.id, ...traceState(testCase) },
    spec: BINARY
  });
  const captured = Symbol("captured");
  return {
    name: variant ? `${model}@${variant}` : model,
    transport: [
      "single physical call, no SDK retries",
      omitTemperature ? "temperature not sent (#120)" : "temperature 0",
      ...(autoTool ? ["tool_choice auto instead of the forced verdict tool"] : []),
      ...(thinking ? [`thinking ${thinking.type}`] : [])
    ].join(", "),
    /** The exact Messages request Rubrist's provider builds, captured without sending it. */
    async requestKey(criterion, testCase) {
      let request = null;
      const capture = new AnthropicJudgeProvider({
        model,
        temperature: 0,
        requestPolicy: "single_physical_call",
        messagesCreate: async (params) => { request = shape(params); throw captured; }
      });
      await capture.judgeStructured(judgeInput(criterion, testCase)).catch((error) => { if (error !== captured) throw error; });
      return request;
    },
    async judge(criterion, testCase) {
      const judged = await provider.judgeStructured(judgeInput(criterion, testCase));
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
  const file = path.join(cacheRoot, judge.name, `${digest({ judge: judge.name, request: await judge.requestKey(criterion, testCase) })}.json`);
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
      // A failed call is reported and never cached, so a rerun retries it.
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
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

function costPerThousand(model, rows) {
  const costs = rows.filter((r) => r.usage).map((r) => estimateCost(model, r.usage)).filter((c) => c !== null);
  return costs.length ? round((costs.reduce((a, b) => a + b, 0) / costs.length) * 1000, 4) : null;
}

function summarize(judge, cases, results) {
  const rows = cases.map((c, i) => ({ id: c.id, truth: c.humanLabel, split: c.reviewerDisagreement, soft: c.softLabel ?? null, ...results[i] }));
  const answered = rows.filter((r) => !r.error);
  const decided = answered.filter((r) => r.label !== "abstain");
  const truthPass = decided.filter((r) => r.truth === "pass");
  const truthFail = decided.filter((r) => r.truth === "fail");
  const correct = decided.filter((r) => r.label === r.truth).length;
  const truth01 = (r) => (r.truth === "pass" ? 1 : 0);
  const probability = answered.map((r) => ({ p: r.p, label: truth01(r) }));
  // Sensitivity: the same scores read as confidence in the judge's own label.
  const ownLabel = answered.map((r) => ({ p: r.label === "pass" ? r.p : r.label === "fail" ? 1 - r.p : 0.5, label: truth01(r) }));
  // A cached record keeps the latency measured when its call was made.
  const measured = answered.map((r) => r.ms).sort((a, b) => a - b);
  const bySplit = (split) => {
    const subset = decided.filter((r) => r.split === split);
    return rate(subset.filter((r) => r.label === r.truth).length, subset.length);
  };
  const soft = answered.filter((r) => typeof r.soft === "number");
  const withUsage = answered.filter((r) => r.usage);
  return {
    judge: judge.name,
    transport: judge.transport,
    servedModels: [...new Set(answered.map((r) => r.servedModel).filter(Boolean))],
    cases: rows.length,
    errors: rows.length - answered.length,
    abstained: answered.length - decided.length,
    accuracy: rate(correct, decided.length),
    accuracyCountingAbstentionsAndErrorsWrong: rate(correct, rows.length),
    passRecall: rate(truthPass.filter((r) => r.label === "pass").length, truthPass.length),
    failRecall: rate(truthFail.filter((r) => r.label === "fail").length, truthFail.length),
    falsePass: truthFail.filter((r) => r.label === "pass").length,
    falseFail: truthPass.filter((r) => r.label === "fail").length,
    scoreContradictsLabel: decided.filter((r) => (r.label === "pass" && r.p < 0.5) || (r.label === "fail" && r.p > 0.5)).length,
    accuracyWhenReviewersAgree: bySplit(false),
    accuracyWhenReviewersSplit: bySplit(true),
    brier: probability.length ? round(brierScore(probability)) : null,
    auc: probability.length ? round(rocAuc(probability)) : null,
    aucIfScoreIsOwnLabelConfidence: ownLabel.length ? round(rocAuc(ownLabel)) : null,
    ece: probability.length ? round(expectedCalibrationError(probability).ece) : null,
    softLabel: soft.length
      ? { spearman: spearman(soft.map((r) => r.p), soft.map((r) => r.soft)), brier: round(soft.reduce((s, r) => s + (r.p - r.soft) ** 2, 0) / soft.length) }
      : null,
    latencyMs: { calls: measured.length, p50: quantile(measured, 0.5), p95: quantile(measured, 0.95) },
    meanInputTokens: withUsage.length ? Math.round(withUsage.reduce((s, r) => s + r.usage.input_tokens, 0) / withUsage.length) : null,
    costPer1kUsd: costPerThousand(judge.name, answered),
    items: rows.map((r) => ({ id: r.id, truth: r.truth, label: r.label ?? null, p: r.p ?? null, ms: r.ms, cached: r.cached, error: r.error ?? null, ...(r.parts ? { parts: r.parts } : {}) }))
  };
}

function paired(a, b) {
  const items = a.items
    .map((x, i) => [x, b.items[i]])
    .filter(([x, y]) => x.label && y.label)
    .map(([x, y]) => ({ truth: x.truth === "pass" ? 1 : 0, a: { label: x.label, p: x.p }, b: { label: y.label, p: y.p } }));
  const decided = items.filter((i) => i.a.label !== "abstain" && i.b.label !== "abstain");
  const right = (side, i) => (i[side].label === "pass" ? 1 : 0) === i.truth;
  return {
    a: a.judge,
    b: b.judge,
    decisionAgreement: rate(decided.filter((i) => i.a.label === i.b.label).length, decided.length),
    mcnemar: mcnemarExact(decided.filter((i) => right("a", i) && !right("b", i)).length, decided.filter((i) => !right("a", i) && right("b", i)).length),
    ...pairedBootstrap(items)
  };
}

const judges = args.judges.split(",").map((spec) => {
  const [name, variant] = spec.split("@");
  return name.startsWith("jev") ? jevJudge(name, variant) : claudeJudge(name, variant);
});
const report = { generatedAt: new Date().toISOString(), cacheVersion: CACHE_VERSION, judges: judges.map((j) => ({ name: j.name, transport: j.transport })), sets: [] };
for (const set of args.sets.split(",")) {
  const dir = path.join(args.fixtures, set);
  const criterion = JSON.parse(await readFile(path.join(dir, "criterion.json"), "utf8"));
  criterion.decomposed = await readFile(path.join(dir, "decomposed.json"), "utf8").then(JSON.parse, () => undefined);
  const all = JSON.parse(await readFile(path.join(dir, "cases.json"), "utf8"));
  const cases = args.limit ? all.slice(0, Number(args.limit)) : all;
  const summaries = [];
  for (const judge of judges) {
    const summary = summarize(judge, cases, await pool(cases, Number(args.concurrency), (c) => cached(judge, criterion, c)));
    summaries.push(summary);
    console.error(`${set} ${judge.name}: accuracy ${summary.accuracy.rate} ${JSON.stringify(summary.accuracy.wilson95)}, errors ${summary.errors}, abstained ${summary.abstained}, p50 ${summary.latencyMs.p50} ms`);
  }
  const comparisons = [];
  for (let i = 0; i < summaries.length; i += 1) {
    for (let j = i + 1; j < summaries.length; j += 1) comparisons.push(paired(summaries[i], summaries[j]));
  }
  report.sets.push({ set, criterion: { key: criterion.key, question: criterion.question, notes: criterion.notes }, cases: cases.length, prevalence: round(cases.filter((c) => c.humanLabel === "pass").length / cases.length), summaries, comparisons });
}
const original = report.sets.find((s) => s.set === "mtbench");
const swapped = report.sets.find((s) => s.set === "mtbench-swapped");
if (original && swapped) {
  report.positionConsistency = original.summaries.map((summary, i) => ({ judge: summary.judge, ...orderConsistency(summary.items, swapped.summaries[i].items) }));
}

await mkdir(args.out, { recursive: true });
await writeFile(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.error(`report: ${path.join(args.out, "report.json")}`);
