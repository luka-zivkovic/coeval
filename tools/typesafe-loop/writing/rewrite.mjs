// The candidate under test: rewrite a PR description with the natural-writing
// skill text as the operating instructions, or with a plain instruction as the
// no-skill baseline. Results are cached by (variant, skill digest, model, id)
// so a loop round pays only for texts it has not seen under this skill version.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { anthropicTextRequest, untrustedBlock } from "../providers.mjs";

const REWRITE_MODEL = process.env.REWRITE_MODEL ?? "claude-opus-5";

export const BASELINE_INSTRUCTIONS = [
  "Revise the pull request description below so it reads naturally and clearly for a human reviewer.",
  "Keep every factual claim, number, file name, command, and caveat exactly as stated. Do not add anything the source does not say.",
  "Return only the revised description in Markdown, with no preamble."
].join("\n");

export function skillInstructions(skillText) {
  return [
    "You are revising a pull request description. Apply the writing discipline below exactly as written.",
    "Treat the description as multi-sentence human-facing prose in the fallback house style, since the project supplies no voice guide.",
    "Return only the revised description in Markdown, with no preamble and no report.",
    "",
    "<writing_skill>",
    skillText,
    "</writing_skill>"
  ].join("\n");
}

export function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * @param {{ apiKey?: string, baseURL?: string, model?: string, cacheDir: string, fetch?: Function }} options
 */
export function createClaudeRewriter({ apiKey = process.env.TYPESAFE_LOOP_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY, baseURL = process.env.ANTHROPIC_BASE_URL, model = REWRITE_MODEL, cacheDir, fetch: fetchImpl = globalThis.fetch } = {}) {
  return {
    name: "claude-rewriter",
    model,
    async rewrite({ id, body, skillText }) {
      const system = skillText ? skillInstructions(skillText) : BASELINE_INSTRUCTIONS;
      const key = digest(JSON.stringify({ model, system, id, body }));
      const file = cacheDir ? path.join(cacheDir, `rewrite-${key}.json`) : null;
      if (file) {
        try { return { ...JSON.parse(await readFile(file, "utf8")), cached: true }; } catch { /* miss */ }
      }
      const result = await anthropicTextRequest({ apiKey, baseURL, model, system, user: untrustedBlock("pull_request_description", body), fetch: fetchImpl });
      const record = { id, text: result.text, model: result.model, usage: result.usage, variant: skillText ? "skill" : "baseline", skillDigest: skillText ? digest(skillText) : null };
      if (file) { await mkdir(cacheDir, { recursive: true }); await writeFile(file, JSON.stringify(record)); }
      return record;
    }
  };
}

/** Test and demo rewriter: a function from (body, skillText) to text, no network. */
export function createScriptedRewriter(fn, { model = "scripted-rewriter" } = {}) {
  return {
    name: "scripted-rewriter",
    model,
    async rewrite({ id, body, skillText }) {
      return { id, text: fn(body, skillText), model, usage: { input_tokens: 0, output_tokens: 0 }, variant: skillText ? "skill" : "baseline", skillDigest: skillText ? digest(skillText) : null };
    }
  };
}
