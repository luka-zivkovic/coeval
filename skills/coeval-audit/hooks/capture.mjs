#!/usr/bin/env node
// coeval-audit capture hook — a Claude Code Stop hook that records
// user-request → final-assistant-message pairs for turns in which an
// allowlisted skill ran, appending them to .coeval/<skillName>.jsonl for
// later submission via scripts/coeval-submit.mjs.
//
// Install (Claude Code only, in .claude/settings.local.json — never the
// committed shared settings without explicit consent):
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//     "command": "node <repo-relative-path>/hooks/capture.mjs" } ] } ] } }
//
// Allowlist: the `capture: true` skills in .coeval/config.json —
//   { "skills": { "<skillName>": { "keyEnvVar"?, "url"?, "capture"? } } }
// `coeval-audit` itself is NEVER captured, regardless of config — the
// server's anti-recursion guard only covers coeval-internal metadata, not
// this skill's own turns.
//
// Honest scope: this captures the turn's last plain user message and last
// assistant text. File-edit deliverables and subagent-internal work are not
// fully represented; a turn with no final assistant text is skipped with a
// note in .coeval/submit.log.
//
// FAIL-SOFT EVERYWHERE. The transcript JSONL is an internal, unversioned
// format — any parse or IO problem is logged to .coeval/submit.log and the
// hook exits 0. A capture hook must never break the end of a turn.
//
// Auto-submit: only when COEVAL_AUTO_SUBMIT=1, via a detached/unref'd child
// running coeval-submit.mjs (which POSTs /api/v1/judge/batch — NEVER the
// synchronous single /api/v1/judge — with ci_ content hashes as
// sourceTraceId, so retries and rate-limited turns are idempotent). All
// outcomes land in .coeval/submit.log; a 429 is just logged and the content
// is retried on a later turn.
//
// Zero dependencies; Node >= 18.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let coevalDir = join(process.cwd(), ".coeval");

function log(message) {
  try {
    mkdirSync(coevalDir, { recursive: true });
    appendFileSync(join(coevalDir, "submit.log"), `[${new Date().toISOString()}] capture: ${message}\n`);
  } catch {
    // Logging must never throw — there is nothing left to report to.
  }
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// Concatenate the text blocks of a message content (string or block array).
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    log("stdin was not valid hook JSON — skipping");
    return;
  }
  if (payload === null || typeof payload !== "object") return;
  // Re-entry guard: a Stop hook firing because of a previous Stop hook's
  // continuation must not capture (or spawn) again.
  if (payload.stop_hook_active) return;
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  coevalDir = join(cwd, ".coeval");
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (typeof sessionId !== "string" || !sessionId || typeof transcriptPath !== "string" || !transcriptPath) {
    log("hook payload missing session_id/transcript_path — skipping");
    return;
  }

  // Allowlist comes from config; no config (or nothing opted in) means
  // capture is off — silence, not an error.
  let config;
  try {
    config = JSON.parse(readFileSync(join(coevalDir, "config.json"), "utf8"));
  } catch {
    return;
  }
  const skills = config && typeof config === "object" && config.skills && typeof config.skills === "object"
    ? config.skills
    : {};
  const allowlist = new Set(
    Object.keys(skills).filter((name) =>
      name !== "coeval-audit" && skills[name] && skills[name].capture === true
    )
  );
  if (allowlist.size === 0) return;

  // Per-session cursor: byte offset into the transcript, so each turn's
  // lines are processed exactly once across Stop firings.
  const safeSession = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const cursorPath = join(coevalDir, `.cursor-${safeSession}`);
  let offset = 0;
  try {
    offset = Number(readFileSync(cursorPath, "utf8").trim());
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
  } catch {
    offset = 0;
  }

  let buffer;
  try {
    buffer = readFileSync(transcriptPath);
  } catch (error) {
    log(`cannot read transcript ${transcriptPath}: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (offset > buffer.length) offset = 0; // transcript rotated/truncated — start over
  const chunk = buffer.subarray(offset).toString("utf8");
  // Only consume complete lines; a partially-flushed last line waits for the
  // next firing.
  const lastNewline = chunk.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : chunk.slice(0, lastNewline + 1);
  const newOffset = offset + Buffer.byteLength(complete, "utf8");

  let userText = "";
  let assistantText = "";
  const skillsRan = new Set();
  let unparseable = 0;
  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      unparseable += 1;
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    if (entry.isSidechain) continue; // subagent-internal lines — out of scope
    const content = entry.message?.content;
    if (entry.type === "user") {
      // Real user prompts carry string content (or text blocks); tool_result
      // deliveries also arrive as type "user" and must not become `input`.
      if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) continue;
      const text = textOf(content);
      if (text.trim()) userText = text;
    } else if (entry.type === "assistant") {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== "tool_use" || block.name !== "Skill") continue;
          const invoked = typeof block.input?.skill === "string" ? block.input.skill : "";
          if (!invoked) continue;
          // Plugin-namespaced invocations ("plugin:name") match a config key
          // of either the full or the short form; coeval-audit never matches.
          const short = invoked.split(":").pop();
          if (invoked === "coeval-audit" || short === "coeval-audit") continue;
          if (allowlist.has(invoked)) skillsRan.add(invoked);
          else if (allowlist.has(short)) skillsRan.add(short);
        }
      }
      const text = textOf(content);
      if (text.trim()) assistantText = text;
    }
  }

  // Advance the cursor even when nothing was captured — these lines are done.
  try {
    mkdirSync(coevalDir, { recursive: true });
    writeFileSync(cursorPath, String(newOffset));
  } catch (error) {
    log(`cannot write cursor ${cursorPath}: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (unparseable > 0) {
    log(`skipped ${unparseable} unparseable transcript line(s) in ${transcriptPath} (internal format may have changed)`);
  }
  if (skillsRan.size === 0) return;
  if (!userText.trim()) {
    log(`skill(s) ${[...skillsRan].join(", ")} ran but no user request text was found in this window — skipped`);
    return;
  }
  if (!assistantText.trim()) {
    log(`skill(s) ${[...skillsRan].join(", ")} ran but the turn ended with no assistant text (file-edit-only deliverable?) — skipped`);
    return;
  }

  // Self-ignoring directory: results, cursors, and logs never enter git.
  const gitignorePath = join(coevalDir, ".gitignore");
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "*\n");

  const captured = [];
  for (const skillName of skillsRan) {
    const file = join(coevalDir, `${skillName.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
    appendFileSync(file, JSON.stringify({
      input: userText,
      output: assistantText,
      metadata: { capture: "claude-code-stop-hook", sessionId, skillName }
    }) + "\n");
    captured.push({ skillName, file });
    log(`captured 1 turn for "${skillName}" → ${file}`);
  }

  // Full auto mode is an explicit opt-in. The child is detached and unref'd
  // so turn end is never delayed by network or judging time.
  if (process.env.COEVAL_AUTO_SUBMIT === "1") {
    const submitScript = fileURLToPath(new URL("../scripts/coeval-submit.mjs", import.meta.url));
    for (const { skillName, file } of captured) {
      const entry = skills[skillName] ?? {};
      const args = [submitScript, "submit", file];
      if (typeof entry.keyEnvVar === "string" && entry.keyEnvVar) args.push("--env-var", entry.keyEnvVar);
      try {
        const out = openSync(join(coevalDir, "submit.log"), "a");
        const child = spawn(process.execPath, args, {
          cwd,
          detached: true,
          stdio: ["ignore", out, out],
          env: {
            ...process.env,
            ...(typeof entry.url === "string" && entry.url ? { COEVAL_URL: entry.url } : {})
          }
        });
        child.unref();
        closeSync(out);
        log(`auto-submit spawned for "${skillName}" (pid ${child.pid}) — its output follows in this log`);
      } catch (error) {
        log(`auto-submit spawn failed for "${skillName}": ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

try {
  await main();
} catch (error) {
  log(`unexpected error — ${error instanceof Error ? (error.stack ?? error.message) : error}`);
}
process.exit(0);
