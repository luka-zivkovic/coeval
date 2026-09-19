// Deterministic checks for the natural-writing rules that can be decided by
// pattern. Each rule returns the offending spans, so a label is exact and a
// report can show why. These are the free labels the evaluator experiments
// have lacked: no human, no model, no ambiguity about what "pass" means.
//
// Rules are transcribed from plugins/natural-writing/skills/natural-writing/SKILL.md
// in luka-zivkovic/overclock (rules 1, 2, 3, 6 and 12). The judgment rules
// (rhythm, flourish, concreteness, voice) are deliberately not here.

const AI_TELL_WORDS = [
  "delve", "delves", "delving", "leverage", "leverages", "leveraging", "utilize", "utilizes", "utilizing",
  "tapestry", "realm", "landscape", "testament", "underscore", "underscores", "crucial", "pivotal", "vital",
  "robust", "seamless", "seamlessly", "synergy", "paradigm", "boasts", "unlock", "unlocks", "empower", "empowers",
  "elevate", "elevates", "supercharge", "supercharges"
];

const AI_TELL_PHRASES = [
  "here's the thing", "here's the kicker", "the magic is", "let's be real", "my honest take", "to be frank",
  "game-changer", "game changer"
];

const SCAFFOLDING = [
  "in conclusion", "furthermore", "moreover", "firstly", "secondly", "thirdly", "let's dive in", "let's dive into",
  "without further ado", "buckle up", "in summary", "to sum up", "in this post", "in this article"
];

const CONTRACTIONS = /\b(?:don't|doesn't|didn't|isn't|aren't|wasn't|weren't|can't|couldn't|won't|wouldn't|shouldn't|it's|that's|there's|here's|what's|you'll|you're|you've|we'll|we're|we've|they're|they've|i'm|i've|i'll|let's)\b/i;

/** Strip fenced code, inline code, links' URLs and HTML so prose rules do not fire on code. */
export function proseOnly(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<details>[\s\S]*?<\/details>/gi, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ");
}

function findAll(text, pattern) {
  const out = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, match: m[0] });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

function wordPattern(words) {
  return new RegExp(`\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
}

/** Rule 1: em or en dash used as a connective in prose. */
export function dashConnectives(text) {
  const prose = proseOnly(text);
  // A dash between words or after a space; not a numeric range like 2024-2026 (that uses a hyphen anyway).
  return findAll(prose, /[—–]/g).map((hit) => ({ ...hit, rule: "dash_connective" }));
}

/** Rule 2: AI-tell vocabulary and performed-casual openers. */
export function aiTellVocabulary(text) {
  const prose = proseOnly(text);
  return [
    ...findAll(prose, wordPattern(AI_TELL_WORDS)),
    ...findAll(prose, wordPattern(AI_TELL_PHRASES))
  ].map((hit) => ({ ...hit, rule: "ai_tell_vocabulary" }));
}

/** Rule 3: bot scaffolding. */
export function botScaffolding(text) {
  const prose = proseOnly(text);
  return findAll(prose, wordPattern(SCAFFOLDING)).map((hit) => ({ ...hit, rule: "bot_scaffolding" }));
}

/** Rule 12: decorative bold, most bullets in a list opening with a bold lead. */
export function decorativeBold(text) {
  const lines = String(text ?? "").split("\n");
  const bullets = lines.filter((l) => /^\s*[-*]\s+/.test(l));
  const boldLead = bullets.filter((l) => /^\s*[-*]\s+\*\*[^*]+\*\*/.test(l));
  if (bullets.length >= 3 && boldLead.length / bullets.length >= 0.6) {
    return boldLead.map((l) => ({ index: -1, match: l.trim().slice(0, 80), rule: "decorative_bold" }));
  }
  return [];
}

/** Rule 6, positive form: the prose uses at least one contraction. Returns a violation when none appears. */
export function missingContractions(text) {
  const prose = proseOnly(text);
  const words = prose.split(/\s+/).filter(Boolean).length;
  if (words < 60) return [];
  return CONTRACTIONS.test(prose) ? [] : [{ index: -1, match: "(no contractions in prose)", rule: "missing_contractions" }];
}

export const RULES = {
  dash_connective: { check: dashConnectives, title: "No em or en dash used as a connective" },
  ai_tell_vocabulary: { check: aiTellVocabulary, title: "No AI-tell vocabulary" },
  bot_scaffolding: { check: botScaffolding, title: "No bot scaffolding" },
  decorative_bold: { check: decorativeBold, title: "No decorative bold on bullet leads" },
  missing_contractions: { check: missingContractions, title: "Uses contractions naturally" }
};

/** Run every rule; returns violations by rule and a pass/fail label per rule. */
export function labelText(text) {
  const violations = {};
  const labels = {};
  for (const [name, rule] of Object.entries(RULES)) {
    violations[name] = rule.check(text);
    labels[name] = violations[name].length === 0 ? "pass" : "fail";
  }
  return { violations, labels, violationCount: Object.values(violations).reduce((n, v) => n + v.length, 0) };
}
