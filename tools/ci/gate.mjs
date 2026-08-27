#!/usr/bin/env node
// coeval gate — turn a labeled examples file into a CI exit code (M1 E3).
//
// Usage (skill gate — the original mode, unchanged):
//   COEVAL_URL=https://… COEVAL_API_KEY=coeval_sk_… \
//     node tools/ci/gate.mjs <examples.jsonl> [--min-agreement 1.0] [--timeout 300]
//
// Examples file: one JSON object per line — { "input": …, "output": …,
// "expected": "pass" | "fail" } ("expectedLabel" also accepted; items without
// a label are judged but never counted in agreement). Malformed lines fail the
// gate loudly (exit 2) — silently dropping examples in CI is false confidence.
//
// `--product` is a removed compatibility mode. It exits 2 locally before
// reading configuration or making an HTTP request. Release systems should
// submit purpose=release_evidence, verify Coeval's assessment receipt, and
// apply their own rollout policy.
//
// Exit codes:
//   0  gate passed
//   1  gate BLOCKED (agreement below threshold or failed items)
//   2  usage/config/infrastructure error (missing env, unreadable file,
//      malformed line, timeout, or removed --product usage)
//
// Zero dependencies. Source ids are content hashes, so re-running unchanged
// examples reuses recorded verdicts (no provider spend); an EDITED
// one is judged fresh. The API key is never printed.
// DRIFT GUARD: skills/coeval-audit/scripts/coeval-submit.mjs adapts this
// file's skill-gate pipeline (JSONL validation + ci_ hash) — keep them in sync.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function fail(code, message) {
  console.error(`coeval-gate: ${message}`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("--product")) {
  fail(
    2,
    '--product has been removed: Coeval does not make release decisions. Submit POST /api/v1/judge/batch with purpose="release_evidence", verify the assessment receipt, and apply rollout policy in your release layer.'
  );
}
const VALUE_FLAGS = new Set(["--min-agreement", "--timeout"]);
const fileArg = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) fail(2, `--${name} needs a value`);
  return value;
}

const baseUrl = (process.env.COEVAL_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.COEVAL_API_KEY ?? "";
if (!baseUrl) fail(2, "COEVAL_URL is not set");
if (!apiKey) fail(2, "COEVAL_API_KEY is not set");
if (!fileArg) {
  fail(2, "usage: node tools/ci/gate.mjs <examples.jsonl> [--min-agreement 1.0] [--timeout 300]");
}
const minAgreement = Number(flag("min-agreement", "1.0"));
if (!Number.isFinite(minAgreement) || minAgreement < 0 || minAgreement > 1) {
  fail(2, "--min-agreement must be a number in [0, 1]");
}
const timeoutSeconds = Number(flag("timeout", "300"));
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  fail(2, "--timeout must be a positive number of seconds");
}

let raw;
try {
  raw = readFileSync(fileArg, "utf8");
} catch (error) {
  fail(2, `cannot read ${fileArg}: ${error instanceof Error ? error.message : error}`);
}

const items = [];
raw.split("\n").forEach((line, index) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let row;
  try {
    row = JSON.parse(trimmed);
  } catch {
    fail(2, `${fileArg}:${index + 1} is not valid JSON`);
  }
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    fail(2, `${fileArg}:${index + 1} must be a JSON object`);
  }
  const label = row.expectedLabel ?? row.expected;
  if (label !== undefined && label !== null && label !== "pass" && label !== "fail") {
    fail(2, `${fileArg}:${index + 1} expected label must be "pass" or "fail" (got ${JSON.stringify(label)})`);
  }
  if (row.steps !== undefined && !Array.isArray(row.steps)) {
    fail(2, `${fileArg}:${index + 1} steps must be an array of {name?, input, output, metadata?}`);
  }
  // Validate locally with a line number — a typo here must read as exit-2
  // "your file is broken", never as exit-1 "your skill regressed" (the server
  // would 400 the whole batch without line context).
  const rawStep = row.expectedFailStep;
  if (rawStep !== undefined && rawStep !== null) {
    if (!Number.isInteger(rawStep) || rawStep < 0) {
      fail(2, `${fileArg}:${index + 1} expectedFailStep must be a non-negative integer (got ${JSON.stringify(rawStep)})`);
    }
    if (label !== "fail") {
      fail(2, `${fileArg}:${index + 1} expectedFailStep is only valid alongside "expected": "fail"`);
    }
    if (!Array.isArray(row.steps) || rawStep >= row.steps.length) {
      fail(2, `${fileArg}:${index + 1} expectedFailStep ${rawStep} must index (0-based) this line's steps`);
    }
  }
  // steps join the content hash ONLY when present — an edited step
  // must mint a new case (stale cached verdicts would defeat a step-level
  // regression demo), while every step-less example keeps its exact pre-M2
  // hash and therefore its existing case. Same rule as the server's ex_ hash.
  const contentHash = createHash("sha256")
    .update(JSON.stringify({
      input: row.input ?? null,
      output: row.output ?? null,
      ...(row.steps ? { steps: row.steps } : {})
    }))
    .digest("hex")
    .slice(0, 32);
  items.push({
    sourceTraceId: `ci_${contentHash}`,
    input: row.input ?? null,
    output: row.output ?? null,
    metadata: typeof row.name === "string" && row.name ? { name: row.name } : {},
    ...(row.steps ? { steps: row.steps } : {}),
    ...(label ? { expectedLabel: label } : {}),
    // Server-validated: fail-only + in range of this item's steps.
    ...(row.expectedFailStep !== undefined && row.expectedFailStep !== null ? { expectedFailStep: row.expectedFailStep } : {})
  });
});
if (items.length === 0) fail(2, `${fileArg} contains no examples`);
if (!items.some((item) => item.expectedLabel)) {
  fail(2, "no example carries an expected label — nothing to gate (add \"expected\": \"pass\"|\"fail\")");
}

async function api(path, init = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
  } catch (error) {
    // Network-level failure (DNS, refused, TLS) is a config/infra problem —
    // exit 2, never the exit-1 "your change regressed" signal.
    fail(2, `could not reach ${baseUrl}${path}: ${error instanceof Error ? error.message : error}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error : `HTTP ${response.status}`;
    // 429 = the request was rejected before any judging (per-key rate limit)
    // — back off and retry territory, not a judgment. Same class as exit 2.
    fail(response.status === 429 ? 2 : 1, `${path} failed: ${message}`);
  }
  return body;
}

const submitted = await api("/api/v1/judge/batch", {
  method: "POST",
  body: JSON.stringify({ items })
});
console.log(
  `coeval-gate: submitted ${submitted.totalItems} case(s) ` +
  `(${submitted.cachedItems} cached, ${submitted.skippedItems} skipped) → run ${submitted.evalRunId}`
);

const deadline = Date.now() + timeoutSeconds * 1000;
let run;
for (;;) {
  run = await api(submitted.pollUrl);
  if (run.status === "completed" || run.status === "failed") break;
  if (Date.now() > deadline) fail(2, `run still ${run.status} after ${timeoutSeconds}s — raise --timeout or check the API`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

// CI-friendly table. Counts, not percentages, per the product's honesty rules.
// The step column is DISPLAY-ONLY (M2 T5): the exit code is a function of
// overall label agreement alone, unchanged from M1.
const width = Math.max(...run.items.map((item) => item.caseId.length), 4);
console.log(`\n${"case".padEnd(width)}  expected  got        agree  step`);
for (const item of run.items) {
  const agree = item.status === "failed" ? "FAILED" : item.agreement === null ? "—" : item.agreement ? "yes" : "NO";
  const step = item.stepAgreement === null || item.stepAgreement === undefined
    ? "—"
    : item.stepAgreement
      ? `yes (@${item.failingStep})`
      : `NO (judge @${item.failingStep ?? "?"}, you @${item.expectedFailStep})`;
  console.log(
    `${item.caseId.padEnd(width)}  ${String(item.expectedLabel ?? "—").padEnd(8)}  ` +
    `${String(item.resultLabel ?? item.status).padEnd(9)}  ${agree.padEnd(5)}  ${step}`
  );
}

const stepLabeled = run.items.filter((item) => item.expectedFailStep !== null && item.expectedFailStep !== undefined && item.status === "completed").length;
const stepAgreed = run.items.filter((item) => item.stepAgreement === true).length;
if (stepLabeled > 0) {
  console.log(`\ncoeval-gate: judge named the expected failing step on ${stepAgreed} of ${stepLabeled} step-labeled case(s) (informational — does not affect the exit code)`);
}

// informational spend (tokens + counts, never dollars; no exit-code effect).
if (run.spend) {
  const s = run.spend;
  const tokens = s.inputTokens === null && s.outputTokens === null
    ? "usage unavailable"
    : `${s.inputTokens ?? 0} in / ${s.outputTokens ?? 0} out tokens`;
  console.log(
    `coeval-gate: spend — ${s.freshItems} fresh, ${s.cachedItems} cached (no spend), ${tokens}` +
    (s.usageMissingCount > 0 ? ` (usage unavailable for ${s.usageMissingCount} call(s))` : "")
  );
}

const labeledCompleted = run.items.filter((item) => item.expectedLabel !== null && item.status === "completed").length;
const failedItems = run.items.filter((item) => item.status === "failed").length;
const agreement = labeledCompleted === 0 ? 0 : run.agreedItems / labeledCompleted;
console.log(
  `\ncoeval-gate: ${run.agreedItems}/${labeledCompleted} labeled case(s) agree ` +
  `· skill version ${run.skillVersionId}` +
  (failedItems > 0 ? ` · ${failedItems} item(s) FAILED (infrastructure)` : "")
);

if (run.status === "failed" || failedItems > 0) {
  fail(1, "BLOCKED — the run had infrastructure failures; a gate that could not judge must not pass");
}
if (labeledCompleted === 0) fail(2, "no labeled case completed — nothing to gate");
if (agreement < minAgreement) {
  fail(1, `BLOCKED — agreement ${run.agreedItems}/${labeledCompleted} is below the --min-agreement ${minAgreement} threshold`);
}
console.log("coeval-gate: PASSED");
