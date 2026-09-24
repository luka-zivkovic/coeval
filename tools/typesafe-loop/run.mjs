#!/usr/bin/env node
// Run the TypeSafe loop experiments against fixtures and write JSON reports.
//
//   node tools/typesafe-loop/run.mjs                 # all three, mock provider
//   node tools/typesafe-loop/run.mjs split-view      # one experiment
//   SYSTEM_ONE_PROVIDER=anthropic node tools/typesafe-loop/run.mjs
//   SYSTEM_ONE_PROVIDER=typesafe  node tools/typesafe-loop/run.mjs
//
// Reports land in out/typesafe-loop/<timestamp>/ (gitignored).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockProvider, createProviderFromEnv } from "./providers.mjs";
import { compareProbabilityLogs, recordProbabilityLog, runMinimalPairs, runSplitView } from "./experiments.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadJson(name) {
  return JSON.parse(await readFile(path.join(here, "fixtures", name), "utf8"));
}

function table(rows) {
  const keys = Object.keys(rows[0] ?? {});
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  return [line(keys), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(keys.map((k) => r[k])))].join("\n");
}

async function main() {
  const which = process.argv[2] ?? "all";
  const criterion = await loadJson("criterion.json");
  const cases = await loadJson("cases.json");
  const pairs = await loadJson("pairs.json");
  const cues = { [criterion.key]: criterion.mockCues };
  const provider = createProviderFromEnv({ cues });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(process.env.TYPESAFE_LOOP_OUT ?? path.join(here, "..", "..", "out", "typesafe-loop", stamp));
  await mkdir(outDir, { recursive: true });
  const reports = [];

  if (which === "all" || which === "split-view") {
    const report = await runSplitView({ provider, criterion, cases });
    reports.push(report);
    await writeFile(path.join(outDir, "split-view.json"), JSON.stringify(report, null, 2));
    console.log(`\n== split-view disagreement (${provider.name}) -> ${report.verdict}`);
    console.log(table(report.rows.map((r) => ({ case: r.caseId, out: r.pOutputOnly, full: r.pFullTrace, delta: r.absDelta, disagree: r.disagreement ? "yes" : "", reviewers: r.reviewerDisagreement ? "split" : "" }))));
    console.log(JSON.stringify(report.summary));
  }

  if (which === "all" || which === "minimal-pairs") {
    const report = await runMinimalPairs({ provider, criterion, pairs });
    reports.push(report);
    await writeFile(path.join(outDir, "minimal-pairs.json"), JSON.stringify(report, null, 2));
    console.log(`\n== minimal-pair probes (${provider.name}) -> ${report.verdict}`);
    console.log(table(report.rows.map((r) => ({ pair: r.pairId, edit: r.edit, pass: r.pPassingTrace, fail: r.pFailingTrace, sep: r.separation, ok: r.separatedByMargin ? "yes" : "" }))));
    console.log(JSON.stringify(report.summary));
  }

  if (which === "all" || which === "drift") {
    const previous = await recordProbabilityLog({ provider, criterion, cases, recordedAt: "week-1" });
    // With the mock, simulate a provider that drifted: same cues, shifted bias.
    // With a real provider the second log is simply a later run, so both
    // logs come from the same provider and the diff is the real signal.
    const later = provider.name === "mock" ? createMockProvider({ cues, bias: -1.2, model: "mock-lexical-v1-drifted" }) : provider;
    const current = await recordProbabilityLog({ provider: later, criterion, cases, recordedAt: "week-2" });
    const report = compareProbabilityLogs({ previous, current });
    reports.push(report);
    await writeFile(path.join(outDir, "log-week-1.json"), JSON.stringify(previous, null, 2));
    await writeFile(path.join(outDir, "log-week-2.json"), JSON.stringify(current, null, 2));
    await writeFile(path.join(outDir, "drift.json"), JSON.stringify(report, null, 2));
    console.log(`\n== weekly drift replay (${provider.name}) -> ${report.verdict}`);
    console.log(table([
      { run: "week-1", model: report.previous.model, brier: report.previous.brier, ece: report.previous.ece, auc: report.previous.auc, falsePass: report.previous.confusionAt050.falsePass, falseFail: report.previous.confusionAt050.falseFail },
      { run: "week-2", model: report.current.model, brier: report.current.brier, ece: report.current.ece, auc: report.current.auc, falsePass: report.current.confusionAt050.falsePass, falseFail: report.current.confusionAt050.falseFail }
    ]));
    console.log(JSON.stringify({ shift: report.shift, reasons: report.reasons }));
  }

  console.log(`\nreports written to ${outDir}`);
  return reports;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
