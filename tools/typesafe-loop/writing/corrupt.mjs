// Exact minimal pairs for prose rules. Given a text that passes a rule, inject
// one violation of that rule; given any text, inject one claim corruption.
// The edit is the label, so these pairs need no human review.

const CONTRACTION_EXPANSIONS = [
  [/\bdon't\b/gi, "do not"], [/\bdoesn't\b/gi, "does not"], [/\bisn't\b/gi, "is not"], [/\bcan't\b/gi, "cannot"],
  [/\bwon't\b/gi, "will not"], [/\bit's\b/gi, "it is"], [/\bthat's\b/gi, "that is"], [/\bwe're\b/gi, "we are"],
  [/\byou'll\b/gi, "you will"], [/\bthere's\b/gi, "there is"], [/\bwe've\b/gi, "we have"], [/\bI'm\b/g, "I am"]
];

/** Inject one violation of a lexical rule. Returns null when the text offers no safe injection point. */
export function injectViolation(text, rule) {
  const t = String(text);
  if (rule === "dash_connective") {
    const m = t.match(/, (?=[a-z])/);
    return m ? t.replace(/, (?=[a-z])/, " — ") : null;
  }
  if (rule === "ai_tell_vocabulary") {
    if (/\buse(s|d)?\b/i.test(t)) return t.replace(/\buse(s|d)?\b/i, (w) => (w.endsWith("d") ? "leveraged" : w.endsWith("s") ? "leverages" : "leverage"));
    if (/\bimportant\b/i.test(t)) return t.replace(/\bimportant\b/i, "crucial");
    // No swappable word: add one short sentence after the first prose sentence.
    return t.replace(/([.!?])(\s+)/, "$1 This is crucial.$2");
  }
  if (rule === "bot_scaffolding") {
    const paragraphs = t.split("\n\n");
    let index = paragraphs.findIndex((p, i) => i > 0 && /^[A-Z]/.test(p) && !/^#/.test(p) && !/^[-*]/.test(p));
    if (index < 0) index = paragraphs.findIndex((p) => /^[A-Z]/.test(p) && !/^#/.test(p) && !/^[-*]/.test(p));
    if (index < 0) return null;
    paragraphs[index] = `Furthermore, ${paragraphs[index][0].toLowerCase()}${paragraphs[index].slice(1)}`;
    return paragraphs.join("\n\n");
  }
  if (rule === "decorative_bold") {
    const lines = t.split("\n");
    const bullets = lines.map((l, i) => [l, i]).filter(([l]) => /^\s*[-*]\s+(?!\*\*)\S/.test(l));
    if (bullets.length < 3) return null;
    for (const [line, i] of bullets) {
      lines[i] = line.replace(/^(\s*[-*]\s+)(\S+(?:\s+\S+)?)/, (_, lead, phrase) => `${lead}**${phrase.replace(/[.,:]$/, "")}.** `);
    }
    return lines.join("\n");
  }
  if (rule === "missing_contractions") {
    let out = t;
    let changed = false;
    for (const [pattern, replacement] of CONTRACTION_EXPANSIONS) {
      if (pattern.test(out)) { out = out.replace(pattern, replacement); changed = true; }
    }
    return changed ? out : null;
  }
  throw new Error(`unknown rule ${rule}`);
}

const MODALS = [[/\bmay\b/, "will"], [/\bmight\b/, "does"], [/\bcould\b/, "does"], [/\bshould\b/, "does"]];

/**
 * Inject one claim corruption: strengthen a modal, alter a number, or drop a
 * caveat sentence. Returns { text, kind, detail } or null.
 */
export function corruptClaim(text) {
  const t = String(text);
  for (const [pattern, replacement] of MODALS) {
    const m = t.match(pattern);
    if (m) return { text: t.replace(pattern, replacement), kind: "modal_strengthened", detail: `${m[0]} → ${replacement}` };
  }
  const number = t.match(/\b(\d{2,4})\b(?![^\[]*\]\()/);
  if (number) {
    const n = Number(number[1]);
    const altered = String(n + Math.max(1, Math.round(n * 0.1)));
    return { text: t.replace(number[0], altered), kind: "number_changed", detail: `${number[1]} → ${altered}` };
  }
  const sentences = t.split(/(?<=[.!?])\s+/);
  const caveat = sentences.findIndex((s) => /\b(only|unless|except|not|no|never|does not|without)\b/i.test(s) && s.length < 240);
  if (caveat >= 0) {
    const dropped = sentences[caveat];
    sentences.splice(caveat, 1);
    return { text: sentences.join(" "), kind: "caveat_dropped", detail: dropped.slice(0, 120) };
  }
  return null;
}
