#!/usr/bin/env node
// Turn the PR corpus (and any rewrites on disk) into autoloop fixture sets,
// one per lexical rule, with exact labels and exact minimal pairs, plus one
// claim-preservation pair set. Output: writing/fixtures/suite/<rule>/.
//
//   node tools/typesafe-loop/writing/build-suite.mjs [--rewrites <dir>]

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, labelText } from "./lexical.mjs";
import { corruptClaim, injectViolation } from "./corrupt.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const RULE_CRITERIA = {
  dash_connective: {
    question: "Does this prose avoid using an em dash or en dash as a generic connective?",
    passDescription: "No em dash (—) or en dash (–) appears in the prose; commas, colons, parentheses, or separate sentences are used instead.",
    failDescription: "At least one em dash or en dash is used as a connective in the prose."
  },
  ai_tell_vocabulary: {
    question: "Does this prose avoid AI-tell vocabulary such as delve, leverage, utilize, robust, seamless, crucial, pivotal, tapestry, realm, landscape, testament, paradigm, synergy, unlock, empower, elevate?",
    passDescription: "None of the AI-tell words or performed-casual openers appear; plain words are used.",
    failDescription: "At least one AI-tell word or performed-casual opener appears in the prose."
  },
  bot_scaffolding: {
    question: "Does this prose avoid bot scaffolding such as 'In conclusion', 'Furthermore', 'Moreover', 'Firstly', 'Let's dive in', 'Without further ado', 'In summary'?",
    passDescription: "The prose states its points directly with no scaffolding phrases.",
    failDescription: "At least one scaffolding phrase appears."
  },
  decorative_bold: {
    question: "Does this text avoid decorative bold, where most bullets open with a bolded lead phrase used only for emphasis?",
    passDescription: "Bullets are plain, or bold is used only as a real structural header naming the item.",
    failDescription: "Most bullets in a list open with a bolded lead phrase for emphasis."
  },
  missing_contractions: {
    question: "Does this prose use contractions naturally, the way a person explaining something to a colleague would?",
    passDescription: "At least one natural contraction such as don't, it's, or you'll appears in prose of any real length.",
    failDescription: "The prose is long enough to expect contractions and contains none."
  }
};

export function buildRuleSet(rule, texts) {
  const cases = texts.map((t) => ({
    id: t.id,
    input: t.title ?? "",
    output: t.text,
    steps: [],
    humanLabel: labelText(t.text).labels[rule],
    reviewerDisagreement: false,
    source: t.source
  }));
  const pairs = [];
  for (const t of texts) {
    if (labelText(t.text).labels[rule] !== "pass") continue;
    const failing = injectViolation(t.text, rule);
    if (!failing || labelText(failing).labels[rule] !== "fail") continue;
    pairs.push({ id: `${t.id}:${rule}`, input: t.title ?? "", steps: [], passOutput: t.text, failOutput: failing, edit: `inject ${rule}` });
    if (pairs.length >= 40) break;
  }
  return { criterion: { key: rule, title: RULES[rule].title, ...RULE_CRITERIA[rule], abstention: false, mockCues: { positive: [], negative: [] } }, cases, pairs };
}

export function buildPreservationSet(texts) {
  const pairs = [];
  for (const t of texts) {
    const corrupted = corruptClaim(t.text);
    if (!corrupted) continue;
    pairs.push({ id: `${t.id}:preserve`, input: t.source === "original" ? t.text : t.original, steps: [], passOutput: t.text, failOutput: corrupted.text, edit: `${corrupted.kind}: ${corrupted.detail}` });
    if (pairs.length >= 60) break;
  }
  return {
    criterion: {
      key: "claims_preserved",
      title: "Revision preserves every claim of the source",
      question: "Does the revised text preserve every factual claim, number, actor, date, causal statement, modal such as 'may' or 'will', and scope qualifier of the source, without inventing, dropping, or strengthening any of them?",
      passDescription: "Every claim in the source appears in the revision with the same strength and scope; nothing is added.",
      failDescription: "At least one claim was dropped, invented, or strengthened, for example 'may' became 'will', a number changed, or a caveat sentence disappeared.",
      abstention: false,
      mockCues: { positive: [], negative: [] }
    },
    cases: [],
    pairs
  };
}

async function loadRewrites(dir) {
  const out = [];
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith("rewrite-")) continue;
      out.push(JSON.parse(await readFile(path.join(dir, name), "utf8")));
    }
  } catch { /* none */ }
  return out;
}

async function main() {
  const rewriteDir = process.argv.includes("--rewrites") ? process.argv[process.argv.indexOf("--rewrites") + 1] : null;
  const corpus = JSON.parse(await readFile(path.join(here, "fixtures", "prs.json"), "utf8"));
  const byId = new Map(corpus.cases.map((c) => [c.id, c]));
  const texts = corpus.cases.map((c) => ({ id: c.id, title: c.title, text: c.body, source: "original" }));
  if (rewriteDir) {
    for (const r of await loadRewrites(rewriteDir)) {
      const original = byId.get(r.id);
      if (original) texts.push({ id: `${r.id}:${r.variant}:${(r.skillDigest ?? "none").slice(0, 8)}`, title: original.title, text: r.text, source: r.variant, original: original.body });
    }
  }
  const root = path.join(here, "fixtures", "suite");
  const summary = [];
  for (const rule of Object.keys(RULES)) {
    const set = buildRuleSet(rule, texts);
    const dir = path.join(root, rule);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "criterion.json"), JSON.stringify(set.criterion, null, 2));
    await writeFile(path.join(dir, "cases.json"), JSON.stringify(set.cases, null, 2));
    await writeFile(path.join(dir, "pairs.json"), JSON.stringify(set.pairs, null, 2));
    const fails = set.cases.filter((c) => c.humanLabel === "fail").length;
    summary.push({ rule, cases: set.cases.length, fail: fails, pass: set.cases.length - fails, pairs: set.pairs.length });
  }
  const preservation = buildPreservationSet(texts);
  const pdir = path.join(root, "claims_preserved");
  await mkdir(pdir, { recursive: true });
  await writeFile(path.join(pdir, "criterion.json"), JSON.stringify(preservation.criterion, null, 2));
  await writeFile(path.join(pdir, "cases.json"), JSON.stringify(preservation.cases, null, 2));
  await writeFile(path.join(pdir, "pairs.json"), JSON.stringify(preservation.pairs, null, 2));
  summary.push({ rule: "claims_preserved", cases: 0, fail: 0, pass: 0, pairs: preservation.pairs.length });
  console.table(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
