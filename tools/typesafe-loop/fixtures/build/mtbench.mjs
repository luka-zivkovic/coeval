#!/usr/bin/env node
// Fixture set "mtbench" from lmsys/mt_bench_human_judgments (expert pairwise votes,
// several judges per pair). Criterion: "Is response A better than response B?"
// humanLabel is the judges' majority; reviewerDisagreement is true when the judges
// were not unanimous, tie votes included. Pairs swap the two responses, so the edit
// is the label.
//
//   NODE_USE_ENV_PROXY=1 node tools/typesafe-loop/fixtures/build/mtbench.mjs
import path from "node:path";
import { huggingFaceRows, pad, rawRoot, seededShuffle, writeFixture } from "./common.mjs";

const rows = await huggingFaceRows({ dataset: "lmsys/mt_bench_human_judgments", split: "human", rawDir: path.join(rawRoot, "mtbench") });
const groups = new Map();
for (const r of rows) {
  const key = `${r.question_id}|${r.model_a}|${r.model_b}|${r.turn}`;
  if (!groups.has(key)) groups.set(key, { question_id: r.question_id, model_a: r.model_a, model_b: r.model_b, turn: r.turn, conversation_a: r.conversation_a, conversation_b: r.conversation_b, votes: [] });
  groups.get(key).votes.push(r.winner.startsWith("tie") ? "tie" : r.winner);
}
const shuffle = seededShuffle(11);
const turns = (conv, turn) => conv.slice(0, turn * 2);
const candidates = [];
for (const g of groups.values()) {
  if (g.votes.length < 2) continue;
  const tally = { model_a: 0, model_b: 0, tie: 0 };
  for (const v of g.votes) tally[v] += 1;
  const majority = tally.model_a > tally.model_b && tally.model_a > tally.tie ? "model_a" : tally.model_b > tally.model_a && tally.model_b > tally.tie ? "model_b" : null;
  if (!majority) continue;
  const conv = turns(g.conversation_a, g.turn);
  const convB = turns(g.conversation_b, g.turn);
  if (JSON.stringify(conv).length + JSON.stringify(convB).length > 9000) continue;
  candidates.push({ g, majority, unanimous: new Set(g.votes).size === 1, judges: g.votes.length, tally, conv, convB });
}
const pick = (filter, n) => shuffle(candidates.filter(filter)).slice(0, n);
const chosen = [
  ...pick((c) => c.unanimous && c.majority === "model_a", 10),
  ...pick((c) => c.unanimous && c.majority === "model_b", 10),
  ...pick((c) => !c.unanimous && c.majority === "model_a", 10),
  ...pick((c) => !c.unanimous && c.majority === "model_b", 10)
];
const userTurns = (conv) => conv.filter((m) => m.role === "user").map((m) => m.content);
const assistantTurns = (conv) => conv.filter((m) => m.role === "assistant").map((m) => m.content);
const cases = chosen.map((c, i) => ({
  id: `m${pad(i + 1)}`,
  input: { user_turns: userTurns(c.conv) },
  output: { response_a: assistantTurns(c.conv), response_b: assistantTurns(c.convB) },
  steps: [],
  humanLabel: c.majority === "model_a" ? "pass" : "fail",
  reviewerDisagreement: !c.unanimous,
  note: `q${c.g.question_id} turn ${c.g.turn} ${c.g.model_a} vs ${c.g.model_b}; judges ${c.judges}; votes a=${c.tally.model_a} b=${c.tally.model_b} tie=${c.tally.tie}`
}));
const pairs = pick((c) => c.unanimous && c.majority === "model_a" && c.judges >= 3, 8).map((c, i) => ({
  id: `mp${pad(i + 1)}`,
  input: { user_turns: userTurns(c.conv) },
  steps: [],
  passOutput: { response_a: assistantTurns(c.conv), response_b: assistantTurns(c.convB) },
  failOutput: { response_a: assistantTurns(c.convB), response_b: assistantTurns(c.conv) },
  edit: "swap responses"
}));
const criterion = {
  key: "response_a_better",
  title: "Response A is better than response B",
  question: "Given the user's turns, is response A the better answer than response B (more helpful, relevant, accurate, and complete)?",
  passDescription: "Response A is better than response B overall.",
  failDescription: "Response B is better than response A overall.",
  notes: "Adapted from lmsys/mt_bench_human_judgments (expert pairwise votes, multiple judges per pair). humanLabel is the majority vote; reviewerDisagreement is true when judges were not unanimous (including any tie vote).",
  mockCues: { positive: [], negative: [] }
};
const dir = await writeFixture("mtbench", { criterion, cases, pairs });
console.log(`${dir}: ${cases.length} cases (${cases.filter((c) => c.reviewerDisagreement).length} reviewer-split, ${cases.filter((c) => c.humanLabel === "pass").length} pass), ${pairs.length} pairs, from ${groups.size} judged pairs`);
