#!/usr/bin/env node
// Fixture set "taubench" from tau-bench's retail historical trajectories (gpt-4o,
// sierra-research/tau-bench). Criterion: did the agent resolve the request correctly
// under the retail policy? humanLabel is the ENVIRONMENT REWARD (a database-state
// and output check), not a human label, and it is known to be noisy; do not use this
// set as a gate. reviewerDisagreement is a PROXY: true when the same task passed in
// some of its four trials and failed in others. Tool outputs are clipped to 1500
// characters. The repository is shallow-cloned into out/typesafe-loop/raw/.
//
//   node tools/typesafe-loop/fixtures/build/taubench.mjs
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pad, rawRoot, seededShuffle, writeFixture } from "./common.mjs";

const repo = path.join(rawRoot, "tau-bench");
if (!existsSync(repo)) execSync(`git clone --depth 1 --quiet https://github.com/sierra-research/tau-bench "${repo}"`, { stdio: "inherit" });
const entries = JSON.parse(await readFile(path.join(repo, "historical_trajectories", "gpt-4o-retail.json"), "utf8"));
const trials = new Map();
for (const e of entries) { if (!trials.has(e.task_id)) trials.set(e.task_id, []); trials.get(e.task_id).push(e.reward); }
const unstable = (taskId) => new Set(trials.get(taskId)).size > 1;

const CAP = 1500;
const clip = (s) => (typeof s === "string" && s.length > CAP ? `${s.slice(0, CAP)} …[truncated ${s.length - CAP} chars]` : s);
const stripCalls = (s) => (typeof s === "string" ? s.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "").trim() : "");
function convert(entry) {
  const traj = entry.traj;
  const policy = traj[0].role === "system" ? traj[0].content : "";
  const userTurns = traj.filter((m) => m.role === "user").map((m) => m.content);
  const assistantText = traj.filter((m) => m.role === "assistant" && !(m.tool_calls && m.tool_calls.length)).map((m) => stripCalls(m.content)).filter(Boolean);
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
  return { policy, userTurns, assistantText, steps };
}

const shuffle = seededShuffle(23);
const candidates = entries.map((e) => ({ e, len: JSON.stringify(e.traj).length })).filter((c) => c.len <= 24000);
const seen = new Set();
const uniq = shuffle(candidates).filter((c) => { if (seen.has(c.e.task_id)) return false; seen.add(c.e.task_id); return true; });
const pick = (filter, n) => uniq.filter(filter).slice(0, n);
const chosen = [
  ...pick((c) => c.e.reward === 1 && !unstable(c.e.task_id), 10),
  ...pick((c) => c.e.reward === 1 && unstable(c.e.task_id), 10),
  ...pick((c) => c.e.reward === 0 && !unstable(c.e.task_id), 4),
  ...pick((c) => c.e.reward === 0 && unstable(c.e.task_id), 16)
];
const cases = chosen.map((c, i) => {
  const v = convert(c.e);
  const ri = c.e.info?.reward_info?.info ?? {};
  return {
    id: `t${pad(i + 1)}`,
    input: { policy: v.policy, user_turns: v.userTurns },
    output: { assistant_turns: v.assistantText },
    steps: v.steps,
    humanLabel: c.e.reward === 1 ? "pass" : "fail",
    reviewerDisagreement: unstable(c.e.task_id),
    note: `task ${c.e.task_id} trial ${c.e.trial}; reward ${c.e.reward}; r_actions ${ri.r_actions ?? "n/a"} r_outputs ${ri.r_outputs ?? "n/a"}; trials ${JSON.stringify(trials.get(c.e.task_id))}`
  };
});
const criterion = {
  key: "request_resolved_per_policy",
  title: "Request resolved correctly under the retail policy",
  question: "Did the agent correctly and completely resolve the customer's request while following the retail agent policy (authenticate first, confirm before database changes, no invented information, only permitted actions)?",
  passDescription: "The agent took the right actions with the right details, obtained confirmation where required, gave correct information, and did not violate the policy.",
  failDescription: "The agent took a wrong, missing, or unconfirmed action, gave incorrect information, violated the policy, or left the request unresolved.",
  notes: "Adapted from tau-bench retail historical trajectories (gpt-4o). humanLabel is the environment reward from a database-state and output check, not a human label. reviewerDisagreement is a PROXY: true when the same task passed in some of its 4 trials and failed in others.",
  mockCues: { positive: [], negative: [] }
};
const dir = await writeFixture("taubench", { criterion, cases, pairs: [] });
console.log(`${dir}: ${cases.length} cases (${cases.filter((c) => c.reviewerDisagreement).length} unstable tasks, ${cases.filter((c) => c.humanLabel === "pass").length} reward 1), from ${entries.length} trajectories over ${trials.size} tasks`);
