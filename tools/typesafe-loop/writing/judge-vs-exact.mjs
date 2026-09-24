#!/usr/bin/env node
// Measure a judge against the exact lexical labels, rule by rule, and against
// the exact claim-corruption pairs. No loop, no author: one pass, one report.
//
//   SYSTEM_ONE_PROVIDER=anthropic node tools/typesafe-loop/writing/judge-vs-exact.mjs --rules dash_connective,missing_contractions --limit 113

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderFromEnv, withCache } from "../providers.mjs";
import { measure, estimateCost } from "../autoloop.mjs";
import { runMinimalPairs } from "../experiments.mjs";
import { round } from "../metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }

async function main() {
  const rules = arg("rules", "dash_connective,missing_contractions").split(",");
  const limit = Number(arg("limit", "0"));
  const pairLimit = Number(arg("pairs", "30"));
  const outDir = path.resolve(process.env.TYPESAFE_LOOP_OUT ?? path.join(here, "..", "..", "..", "out", "typesafe-loop", "judge-vs-exact"));
  await mkdir(outDir, { recursive: true });
  const provider = await withCache(createProviderFromEnv({ cues: {} }), path.join(path.dirname(outDir), "cache"));
  const report = { provider: provider.name, model: provider.model ?? null, rules: {}, pairs: {}, usage: {} };
  const ledger = {};
  const add = (model, usage) => { ledger[model] ??= { input_tokens: 0, output_tokens: 0 }; ledger[model].input_tokens += usage.input_tokens ?? 0; ledger[model].output_tokens += usage.output_tokens ?? 0; };
  for (const rule of rules) {
    const dir = path.join(here, "fixtures", "suite", rule);
    const criterion = JSON.parse(await readFile(path.join(dir, "criterion.json"), "utf8"));
    let cases = JSON.parse(await readFile(path.join(dir, "cases.json"), "utf8"));
    if (limit > 0) cases = cases.slice(0, limit);
    const m = await measure({ provider, version: { ...criterion, binding: provider.name }, cases });
    add(m.model ?? provider.name, m.usage);
    const confidentWrong = m.items.filter((i) => (i.label === 1 && i.p < 0.25) || (i.label === 0 && i.p > 0.75)).map((i) => i.caseId);
    report.rules[rule] = { cases: cases.length, labelled: m.metrics.labelled, model: m.model, ...m.metrics, confidentWrong };
    console.log(`${rule}: n=${cases.length} auc=${m.metrics.auc} brier=${m.metrics.brier} ece=${m.metrics.ece} falsePass=${m.metrics.confusion.falsePass} falseFail=${m.metrics.confusion.falseFail} confidentWrong=${confidentWrong.length}`);
    const pairs = JSON.parse(await readFile(path.join(dir, "pairs.json"), "utf8")).slice(0, pairLimit);
    if (pairs.length > 0) {
      const pr = await runMinimalPairs({ provider, criterion, pairs });
      add(m.model ?? provider.name, { input_tokens: pr.summary.inputTokens, output_tokens: 0 });
      report.pairs[rule] = pr.summary;
      console.log(`${rule} pairs: ordered=${pr.summary.pairwiseAuc} overMargin=${pr.summary.separatedByMarginRate} meanSep=${pr.summary.meanSeparation}`);
    }
  }
  const pdir = path.join(here, "fixtures", "suite", "claims_preserved");
  const pcrit = JSON.parse(await readFile(path.join(pdir, "criterion.json"), "utf8"));
  const ppairs = JSON.parse(await readFile(path.join(pdir, "pairs.json"), "utf8")).slice(0, pairLimit);
  const pr = await runMinimalPairs({ provider, criterion: pcrit, pairs: ppairs });
  add(provider.model ?? provider.name, { input_tokens: pr.summary.inputTokens, output_tokens: 0 });
  const byKind = {};
  for (const row of pr.rows) { const kind = row.edit.split(":")[0]; byKind[kind] ??= { pairs: 0, separated: 0, ordered: 0 }; byKind[kind].pairs += 1; byKind[kind].separated += row.separatedByMargin ? 1 : 0; byKind[kind].ordered += row.ordered ? 1 : 0; }
  report.pairs.claims_preserved = { ...pr.summary, byKind };
  console.log(`claims_preserved pairs: ordered=${pr.summary.pairwiseAuc} overMargin=${pr.summary.separatedByMarginRate} byKind=${JSON.stringify(byKind)}`);
  report.usage = Object.fromEntries(Object.entries(ledger).map(([m, u]) => [m, { ...u, estimatedUsd: round(estimateCost(m, u), 4) }]));
  console.log(`usage ${JSON.stringify(report.usage)}`);
  await writeFile(path.join(outDir, `judge-vs-exact-${provider.name}.json`), JSON.stringify(report, null, 2));
  console.log(`report written to ${outDir}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
