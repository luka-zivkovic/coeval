#!/usr/bin/env node
// Larger samples for the #101 evaluator comparison (compare.mjs). The 40-case
// sets beside this file are balanced by label and agreement band for loop
// development; these are seeded simple random samples of the same sources, so
// each set keeps its source's own prevalence and difficulty mix. Criteria are
// read from the development sets; MT-Bench's names the judged turn, and its
// cases are also written with the responses swapped to measure position bias.
// Output is committed; rerunning reproduces it from the same sources.
//
//   NODE_USE_ENV_PROXY=1 node tools/typesafe-loop/fixtures/build/compare-sets.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chaosMnliCounts, fixturesRoot, huggingFaceRows, rawRoot, seededShuffle, writeFixture } from "./common.mjs";

const SIZES = { chaosmnli: 200, mtbench: 150, taubench: 115 };
// The tau-bench commit the committed sample was drawn from.
const TAU_BENCH_COMMIT = "59a200c6d575d595120f1cb70fea53cef0632f6b";
const id = (prefix, i) => `${prefix}${String(i + 1).padStart(3, "0")}`;

async function criterionFor(name, sampling) {
  const criterion = JSON.parse(await readFile(path.join(fixturesRoot, name, "criterion.json"), "utf8"));
  return { ...criterion, notes: `${criterion.notes} Comparison sample: ${sampling}` };
}

async function chaosMnli() {
  const rows = await huggingFaceRows({ dataset: "tasksource/chaos-mnli-ambiguity", split: "train", rawDir: path.join(rawRoot, "chaosmnli") });
  const share = (r) => { const c = chaosMnliCounts(r); const total = (c.e ?? 0) + (c.n ?? 0) + (c.c ?? 0); return total ? (c.e ?? 0) / total : 0; };
  const eligible = rows.filter((r) => r.premise.length <= 600);
  const chosen = seededShuffle(101)(eligible).slice(0, SIZES.chaosmnli);
  const cases = chosen.map((r, i) => ({
    id: id("n", i),
    input: { premise: r.premise },
    output: { hypothesis: r.hypothesis },
    steps: [],
    humanLabel: share(r) >= 0.5 ? "pass" : "fail",
    reviewerDisagreement: share(r) > 0.3 && share(r) < 0.7,
    softLabel: share(r),
    note: `uid ${r.uid}; counts ${JSON.stringify(chaosMnliCounts(r))}`
  }));
  const criterion = await criterionFor("chaosmnli", `seed 101 simple random sample of ${cases.length} of ${eligible.length} items with premises up to 600 characters.`);
  return { name: "chaosmnli", criterion, cases, source: rows.length };
}

async function mtBench() {
  const rows = await huggingFaceRows({ dataset: "lmsys/mt_bench_human_judgments", split: "human", rawDir: path.join(rawRoot, "mtbench") });
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.question_id}|${r.model_a}|${r.model_b}|${r.turn}`;
    if (!groups.has(key)) groups.set(key, { question_id: r.question_id, model_a: r.model_a, model_b: r.model_b, turn: r.turn, conversation_a: r.conversation_a, conversation_b: r.conversation_b, votes: [] });
    groups.get(key).votes.push(r.winner.startsWith("tie") ? "tie" : r.winner);
  }
  const turns = (conv, turn) => conv.slice(0, turn * 2);
  const eligible = [];
  for (const g of groups.values()) {
    const tally = { model_a: 0, model_b: 0, tie: 0 };
    for (const v of g.votes) tally[v] += 1;
    const majority = tally.model_a > tally.model_b && tally.model_a > tally.tie ? "model_a" : tally.model_b > tally.model_a && tally.model_b > tally.tie ? "model_b" : null;
    if (!majority) continue;
    const conv = turns(g.conversation_a, g.turn);
    const convB = turns(g.conversation_b, g.turn);
    if (JSON.stringify(conv).length + JSON.stringify(convB).length > 9000) continue;
    eligible.push({ g, majority, tally, conv, convB });
  }
  const chosen = seededShuffle(103)(eligible).slice(0, SIZES.mtbench);
  const userTurns = (conv) => conv.filter((m) => m.role === "user").map((m) => m.content);
  const assistantTurns = (conv) => conv.filter((m) => m.role === "assistant").map((m) => m.content);
  const cases = chosen.map((c, i) => ({
    id: id("m", i),
    input: { user_turns: userTurns(c.conv), judged_turn: c.g.turn },
    output: { response_a: assistantTurns(c.conv), response_b: assistantTurns(c.convB) },
    steps: [],
    humanLabel: c.majority === "model_a" ? "pass" : "fail",
    reviewerDisagreement: new Set(c.g.votes).size > 1,
    note: `q${c.g.question_id} turn ${c.g.turn} ${c.g.model_a} vs ${c.g.model_b}; votes a=${c.tally.model_a} b=${c.tally.model_b} tie=${c.tally.tie}`
  }));
  const base = await criterionFor("mtbench", `seed 103 simple random sample of ${cases.length} of ${eligible.length} judged pairs with a strict majority and under 9,000 characters (of ${groups.size}).`);
  const criterion = {
    ...base,
    question: "Given the user's turns, is response A the better answer than response B at the judged turn (input.judged_turn; earlier turns are context)?"
  };
  return { name: "mtbench", criterion, cases, source: groups.size };
}

async function tauBench() {
  const repo = path.join(rawRoot, "tau-bench");
  if (!existsSync(repo)) {
    execFileSync("git", ["clone", "--depth", "1", "--quiet", "https://github.com/sierra-research/tau-bench", repo], { stdio: "inherit" });
  }
  if (execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== TAU_BENCH_COMMIT) {
    execFileSync("git", ["-C", repo, "fetch", "--quiet", "--depth", "1", "origin", TAU_BENCH_COMMIT], { stdio: "inherit" });
    execFileSync("git", ["-C", repo, "checkout", "--quiet", TAU_BENCH_COMMIT], { stdio: "inherit" });
  }
  const entries = JSON.parse(await readFile(path.join(repo, "historical_trajectories", "gpt-4o-retail.json"), "utf8"));
  const trials = new Map();
  for (const e of entries) { if (!trials.has(e.task_id)) trials.set(e.task_id, []); trials.get(e.task_id).push(e.reward); }
  const CAP = 1500;
  const clip = (s) => (typeof s === "string" && s.length > CAP ? `${s.slice(0, CAP)} …[truncated ${s.length - CAP} chars]` : s);
  const stripCalls = (s) => (typeof s === "string" ? s.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "").trim() : "");
  const convert = (traj) => {
    const steps = [];
    for (let i = 0; i < traj.length; i += 1) {
      const m = traj[i];
      if (m.role !== "assistant" || !m.tool_calls) continue;
      for (const call of m.tool_calls) {
        const fn = call.function ?? call;
        const result = traj.slice(i + 1).find((n) => n.role === "tool" && (n.tool_call_id === call.id || n.name === fn.name));
        let args = fn.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep the string */ } }
        steps.push({ name: fn.name, input: args, output: clip(result?.content ?? null) });
      }
    }
    return {
      policy: traj[0].role === "system" ? traj[0].content : "",
      userTurns: traj.filter((m) => m.role === "user").map((m) => m.content),
      assistantText: traj.filter((m) => m.role === "assistant" && !(m.tool_calls && m.tool_calls.length)).map((m) => stripCalls(m.content)).filter(Boolean),
      steps
    };
  };
  // One trajectory per task, its trial chosen by the seeded shuffle, so no task
  // counts twice.
  const seen = new Set();
  const eligible = seededShuffle(107)(entries.filter((e) => JSON.stringify(e.traj).length <= 24000))
    .filter((e) => { if (seen.has(e.task_id)) return false; seen.add(e.task_id); return true; });
  const chosen = eligible.slice(0, SIZES.taubench);
  const cases = chosen.map((e, i) => {
    const v = convert(e.traj);
    return {
      id: id("t", i),
      input: { policy: v.policy, user_turns: v.userTurns },
      output: { assistant_turns: v.assistantText },
      steps: v.steps,
      humanLabel: e.reward === 1 ? "pass" : "fail",
      reviewerDisagreement: new Set(trials.get(e.task_id)).size > 1,
      note: `task ${e.task_id} trial ${e.trial}; reward ${e.reward}; trials ${JSON.stringify(trials.get(e.task_id))}`
    };
  });
  const criterion = await criterionFor("taubench", `seed 107 sample of one trajectory per task, ${cases.length} of the ${eligible.length} tasks (of ${trials.size}) that have a trajectory up to 24,000 characters, from tau-bench ${TAU_BENCH_COMMIT.slice(0, 7)}. The label is the environment reward, not a human label.`);
  return { name: "taubench", criterion, cases, source: entries.length };
}

/** The same MT-Bench cases with the responses swapped, so the label flips. */
function swapped({ name, criterion, cases, source }) {
  return {
    name: `${name}-swapped`,
    criterion: { ...criterion, notes: `${criterion.notes} Responses swapped: response_a is the original response_b.` },
    cases: cases.map((c) => ({
      ...c,
      id: `${c.id}s`,
      output: { response_a: c.output.response_b, response_b: c.output.response_a },
      humanLabel: c.humanLabel === "pass" ? "fail" : "pass"
    })),
    source
  };
}

const sets = [await chaosMnli(), await mtBench(), await tauBench()];
sets.splice(2, 0, swapped(sets[1]));
for (const { name, criterion, cases, source } of sets) {
  const dir = await writeFixture(path.join("compare", name), { criterion, cases, pairs: [] });
  const pass = cases.filter((c) => c.humanLabel === "pass").length;
  console.log(`${dir}: ${cases.length} cases (${pass} pass, ${cases.filter((c) => c.reviewerDisagreement).length} split), from ${source} source rows`);
}
