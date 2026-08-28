#!/usr/bin/env node
// coeval-submit — the coeval-audit skill's bundled client: connection check +
// results submission for auditing a developer's own agent skill.
//
// Adapted from tools/ci/gate.mjs (the CI skill gate). DRIFT GUARD: the JSONL
// validation rules and the `ci_` content-hash recipe below MUST stay in sync
// with tools/ci/gate.mjs (and the server's ex_ hash) — identical content must
// keep minting identical sourceTraceIds, or idempotency breaks across the two
// clients. This file deliberately does NOT carry gate.mjs's --product deploy
// gate: auditing a skill submits examples, never golden-set candidates.
//
// Usage:
//   node coeval-submit.mjs setup <setup.json> [--first-batch results.jsonl]
//     [--pairing-env-var NAME]
//     [--bootstrap-env-var NAME]
//     [--owner-password-env-var NAME] [--provider-key-env-var NAME]
//     [--env-var NAME]
//   node coeval-submit.mjs check [--allow-inactive] [--env-var NAME]
//   node coeval-submit.mjs submit <results.jsonl> [--min-agreement 0.9]
//     [--timeout 300] [--env-var NAME]
//   node coeval-submit.mjs findings [--since ISO-8601] [--md] [--env-var NAME]
//
// COEVAL_URL and the API key come from the environment, falling back to a
// ./.env file that THIS SCRIPT parses itself — the calling agent must never
// read .env directly (unrelated secrets live there). Real environment
// variables win over .env. --env-var NAME reads the key from $NAME instead of
// COEVAL_API_KEY (multi-skill repos map one key per skill in
// .coeval/config.json). The API key is never printed.
//
// Results file: one JSON object per line —
//   { "name"?, "input", "output", "expected"? ("pass"|"fail"),
//     "steps"?, "expectedFailStep"?, "metadata"? }
// ("expectedLabel" also accepted.) Labels are OPTIONAL here — a deliberate
// divergence from gate.mjs, which refuses unlabeled files: auditing a skill
// without ground truth is allowed, but the report then carries the judging
// skill's opinions, not verified correctness (the script prints that banner
// itself so it cannot be paraphrased away).
//
// Exit codes (per subcommand):
//   check:   0 connected (warnings allowed)
//            2 anything submit would trip over — missing env, unreachable
//              URL, bad key (401), no active skill version (downgrade that
//              last one to a warning with --allow-inactive)
//   findings: 0 findings printed (JSON, or a markdown brief with --md)
//            2 any failure — a read never judges anything, so every error is
//              config/infra territory
//   submit:  0 run completed (and agreement met --min-agreement, when given)
//            1 infrastructure failure, or agreement below the threshold
//            2 usage/config error (missing env, unreadable file, malformed
//              line, rate limit, timeout)
//
// Zero dependencies; Node >= 18 (global fetch).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

function fail(code, message) {
  console.error(`coeval-submit: ${message}`);
  process.exit(code);
}

// ~10-line .env parse: KEY=value, optional `export `, quotes stripped,
// comment lines skipped. Values are only ever consumed, never printed.
function loadDotEnv() {
  const vars = {};
  let raw;
  try {
    raw = readFileSync(".env", "utf8");
  } catch {
    return vars; // no .env — environment variables only
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith("#")) continue;
    let value = match[2];
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    vars[match[1]] = value;
  }
  return vars;
}
const dotEnv = loadDotEnv();
// Environment takes precedence over .env — same direction as every dotenv
// implementation, and the one that lets CI override a checked-out .env.
const envVal = (name) => process.env[name] ?? dotEnv[name] ?? "";

const [command, ...rest] = process.argv.slice(2);
const VALUE_FLAGS = new Set([
  "--min-agreement",
  "--timeout",
  "--env-var",
  "--since",
  "--first-batch",
  "--pairing-env-var",
  "--bootstrap-env-var",
  "--owner-password-env-var",
  "--provider-key-env-var"
]);
const fileArg = rest.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(rest[i - 1] ?? ""));
function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = rest[i + 1];
  if (value === undefined || value.startsWith("--")) fail(2, `--${name} needs a value`);
  return value;
}

const USAGE = "usage: node coeval-submit.mjs setup <setup.json> [--first-batch results.jsonl] [--pairing-env-var NAME] [--bootstrap-env-var NAME] [--owner-password-env-var NAME] [--provider-key-env-var NAME] [--env-var NAME] [--min-agreement 0.9] [--timeout 300] | check [--allow-inactive] [--env-var NAME] | submit <results.jsonl> [--min-agreement 0.9] [--timeout 300] [--env-var NAME] | findings [--since ISO-8601] [--md] [--env-var NAME]";
if (command !== "setup" && command !== "check" && command !== "submit" && command !== "findings") fail(2, USAGE);

const keyVarName = flag("env-var", "COEVAL_API_KEY");
const baseUrl = envVal("COEVAL_URL").replace(/\/$/, "");
const apiKey = envVal(keyVarName);
if (!baseUrl) fail(2, "COEVAL_URL is not set (environment or ./.env)");
if (command !== "setup" && !apiKey) fail(2, `${keyVarName} is not set (environment or ./.env) — run the setup command or mint one in Settings → API keys`);

const timeoutSeconds = Number(flag("timeout", "300"));
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  fail(2, "--timeout must be a positive number of seconds");
}
// No default threshold: unlike gate.mjs (a CI gate needs a pass/fail), an
// audit without --min-agreement reports agreement informationally and exits 0.
const minAgreementRaw = flag("min-agreement", null);
const minAgreement = minAgreementRaw === null ? null : Number(minAgreementRaw);
if (minAgreement !== null && (!Number.isFinite(minAgreement) || minAgreement < 0 || minAgreement > 1)) {
  fail(2, "--min-agreement must be a number in [0, 1]");
}

// httpFailCode: `submit` keeps gate.mjs's exit-1 on HTTP errors mid-pipeline
// (the run is the thing that failed); `check` maps EVERY failure — 401
// included — to exit 2, because a failed check is always a config problem.
async function apiWithToken(path, token, init = {}, httpFailCode = 1) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
  } catch (error) {
    // Network-level failure (DNS, refused, TLS) is a config/infra problem —
    // exit 2, never the exit-1 "your skill regressed" signal.
    fail(2, `could not reach ${baseUrl}${path}: ${error instanceof Error ? error.message : error}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const baseMessage = body && typeof body === "object" && "error" in body ? body.error : `HTTP ${response.status}`;
    const code = body && typeof body === "object" && typeof body.code === "string" ? ` [${body.code}]` : "";
    const message = `${baseMessage}${code}`;
    // 429 = rejected before any judging (per-key rate limit) — back off and
    // retry territory, not a judgment. Same class as exit 2.
    fail(response.status === 429 ? 2 : httpFailCode, `${path} failed: ${message}`);
  }
  return body;
}

const api = (path, init = {}, httpFailCode = 1) => apiWithToken(path, apiKey, init, httpFailCode);

function hasEnvValue(name) {
  // Value truthiness, not key presence: a template-style `COEVAL_API_KEY=`
  // line (or an exported-empty variable) holds nothing worth protecting, and
  // treating it as "already exists" dead-ends setup on a key that could never
  // have worked. This mirrors envVal, which already treats empty as unset.
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.trim() !== "") return true;
  const fromDotEnv = dotEnv[name];
  return typeof fromDotEnv === "string" && fromDotEnv.trim() !== "";
}

function saveProjectKey(name, key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(2, `invalid environment variable name: ${name}`);
  if (hasEnvValue(name)) {
    fail(2, `${name} already exists — choose a new --env-var before setup so the one-time key is not lost`);
  }
  let existing = "";
  try {
    existing = readFileSync(".env", "utf8");
  } catch {
    // Created below with owner-only permissions where the platform honors it.
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(".env", `${prefix}${name}=${key}\n`, { mode: 0o600 });
  mkdirSync(".coeval", { recursive: true });
  try {
    writeFileSync(".coeval/.gitignore", "*\n", { flag: "wx" });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
  }
}

// --- setup: instance token → project + judge + first project key ---------
if (command === "setup") {
  if (!fileArg) fail(2, USAGE);
  const firstBatch = flag("first-batch", "");
  const pairingVarName = flag("pairing-env-var", "");
  const bootstrapVarName = flag("bootstrap-env-var", "COEVAL_BOOTSTRAP_TOKEN");
  const defaultPairingToken = envVal("COEVAL_PAIRING_TOKEN");
  const setupTokenVarName = pairingVarName || (defaultPairingToken ? "COEVAL_PAIRING_TOKEN" : bootstrapVarName);
  const setupToken = pairingVarName ? envVal(pairingVarName) : defaultPairingToken || envVal(bootstrapVarName);
  if (!setupToken) fail(2, `${setupTokenVarName} is not set (environment or ./.env)`);
  if (hasEnvValue(keyVarName)) {
    fail(2, `${keyVarName} already exists — choose a new --env-var before setup so the one-time key is not lost`);
  }

  let setupInput;
  try {
    setupInput = JSON.parse(readFileSync(fileArg, "utf8"));
  } catch (error) {
    fail(2, `cannot read valid setup JSON from ${fileArg}: ${error instanceof Error ? error.message : error}`);
  }
  if (typeof setupInput !== "object" || setupInput === null || Array.isArray(setupInput)) {
    fail(2, `${fileArg} must contain one JSON object`);
  }
  if (
    typeof setupInput.check?.name !== "string" || !setupInput.check.name.trim() ||
    typeof setupInput.check?.question !== "string" || !setupInput.check.question.trim()
  ) {
    fail(2, `${fileArg} requires check.name and check.question from the approved Check proposal`);
  }
  if (setupInput.owner?.password !== undefined || setupInput.providerApiKey !== undefined) {
    fail(2, `${fileArg} must not contain owner.password or providerApiKey; pass their environment variable names as flags`);
  }

  const ownerPasswordVar = flag("owner-password-env-var", "COEVAL_OWNER_PASSWORD");
  const ownerPassword = envVal(ownerPasswordVar);
  const providerKeyVar = flag("provider-key-env-var", "");
  const providerApiKey = providerKeyVar ? envVal(providerKeyVar) : "";
  if (providerKeyVar && !providerApiKey) fail(2, `${providerKeyVar} is not set (environment or ./.env)`);

  const requestBody = {
    ...setupInput,
    owner: {
      ...(setupInput.owner ?? {}),
      ...(ownerPassword ? { password: ownerPassword } : {})
    },
    ...(providerApiKey ? { providerApiKey } : {})
  };
  const result = await apiWithToken("/api/v1/bootstrap", setupToken, {
    method: "POST",
    body: JSON.stringify(requestBody)
  }, 2);
  const minted = result && typeof result === "object" && result.apiKey && typeof result.apiKey === "object"
    ? result.apiKey.key
    : null;
  if (typeof minted !== "string" || !minted) {
    fail(2, "/api/v1/bootstrap returned no one-time project key");
  }
  saveProjectKey(keyVarName, minted);
  console.log(
    `coeval-submit: configured ${result.mode ?? "bench"} project "${result.projectId}" · ` +
    `Check "${result.check?.question ?? "unknown quality question"}" · ` +
    `agent-drafted version ${result.skillVersionId} · saved project key as ${keyVarName} in ./.env`
  );
  if (result.check?.criterionVersionId) {
    console.log(
      `coeval-submit: exact Check binding ${result.check.criterionVersionId} · ${result.check.digest ?? "digest unavailable"} · Starter · unvalidated`
    );
  }
  console.log("coeval-submit: setup stops before adjudication — submit runs next; a human must label exceptions and promote golden cases");
  // The server's `connect` block carries the same wiring snippets the app
  // shows at the key-mint moment, PRE-FILLED with the one-time key. "The API
  // key is never printed" holds here too: every occurrence is replaced with
  // the env-var name the key was just saved under before anything is echoed.
  const connect = result.connect && typeof result.connect === "object" ? result.connect : null;
  if (connect) {
    const masked = (value) => typeof value === "string" && value.length > 0
      ? value.split(minted).join(`$${keyVarName}`)
      : null;
    const wiring = [
      ["Claude Code", masked(connect.claudeCode)],
      ["mcp.json", masked(connect.mcpJson)],
      ["plain CLI", masked(connect.cli)]
    ].filter(([, snippet]) => snippet !== null);
    if (wiring.length > 0) {
      console.log(`coeval-submit: wire your agent next — the key is saved in ./.env and shown below as $${keyVarName}; where your client needs the literal key (mcp.json, or a shell without ./.env sourced), substitute it from ./.env:`);
      for (const [label, snippet] of wiring) {
        console.log(`--- ${label} ---`);
        console.log(snippet);
      }
    }
  }
  if (firstBatch) {
    // Re-enter the same validated submit/poll path instead of maintaining a
    // second JSONL parser. The one-time project key travels in the child
    // environment (and the just-written .env), never argv or output.
    const submitArgs = [
      process.argv[1],
      "submit",
      firstBatch,
      "--env-var",
      keyVarName,
      "--timeout",
      String(timeoutSeconds)
    ];
    if (minAgreement !== null) submitArgs.push("--min-agreement", String(minAgreement));
    const child = spawnSync(process.execPath, submitArgs, {
      cwd: process.cwd(),
      env: { ...process.env, [keyVarName]: minted },
      stdio: "inherit"
    });
    if (child.error) {
      fail(2, `project setup succeeded, but the first batch could not start: ${child.error.message}`);
    }
    if (child.status !== 0) {
      console.error(`coeval-submit: project setup succeeded, but the first batch exited ${child.status ?? 1}; the saved project key can be used to retry`);
      process.exit(child.status ?? 1);
    }
    console.log("coeval-submit: first batch completed — exceptions are ready for human review");
  }
  process.exit(0);
}

// --- check: GET /api/v1/project — free connection check ------------------
// Costs 1 rate-limit token and zero provider spend.
if (command === "check") {
  const project = await api("/api/v1/project", {}, 2);
  if (project === null || typeof project !== "object" || typeof project.projectId !== "string") {
    fail(2, "/api/v1/project returned an unexpected response shape — check COEVAL_URL points at the Coeval API");
  }
  console.log(
    `coeval-submit: connected — project "${project.name}" (${project.projectId}) · ` +
    `mode ${project.mode} · active skill version ${project.currentSkillVersionId ?? "none"}`
  );
  if (project.mode !== "bench") {
    // Warning only: tracing-mode projects can still take batch submissions,
    // but the recommended setup is one bench-mode project per audited skill.
    console.error(`coeval-submit: warning — project mode is "${project.mode}", not "bench"; the recommended setup is one bench-mode coeval project per audited skill`);
  }
  if (project.currentSkillVersionId === null) {
    const message = "no active judging skill version — author and activate one in the dashboard before submitting (the batch endpoint refuses to judge without it)";
    if (rest.includes("--allow-inactive")) {
      console.error(`coeval-submit: warning — ${message}`);
    } else {
      fail(2, `${message}; pass --allow-inactive to downgrade this to a warning`);
    }
  }
  process.exit(0);
}

// --- findings: GET /api/v1/findings — aggregated judgment intelligence ----
// Read-only: overrides, disagreements, failure clusters, per-stratum verdict
// distribution, golden-set delta. Prints JSON by default; --md renders a
// compact brief for humans/PR descriptions. Every failure is exit 2 — a read
// never judges anything, so there is no "your skill regressed" signal here.
if (command === "findings") {
  const since = flag("since", "");
  if (since && Number.isNaN(Date.parse(since))) {
    fail(2, "--since must be an ISO-8601 timestamp (e.g. 2026-08-01T00:00:00Z)");
  }
  const path = since ? `/api/v1/findings?since=${encodeURIComponent(since)}` : "/api/v1/findings";
  const findings = await api(path, {}, 2);
  if (!rest.includes("--md")) {
    console.log(JSON.stringify(findings, null, 2));
    process.exit(0);
  }
  const lines = [];
  lines.push(`# Coeval findings — ${findings.generatedAt}`);
  const golden = findings.goldenSet ?? {};
  lines.push("");
  lines.push(`- golden set: ${golden.size ?? 0} entries` +
    (golden.entriesSince === null || golden.entriesSince === undefined
      ? ""
      : ` (${golden.entriesSince} since ${findings.since})`) +
    (golden.latestPromotedAt ? ` · latest promoted ${golden.latestPromotedAt}` : ""));
  const disagreements = findings.judgeHumanDisagreements ?? {};
  lines.push(`- judge–human disagreements: ${disagreements.disagreedCases ?? 0} of ${disagreements.comparedCases ?? 0} compared cases (${disagreements.resolvedCases ?? 0} resolved)`);
  lines.push(`- human overrides: ${(findings.humanOverrides ?? []).length}`);
  const clusters = findings.failureClusters ?? [];
  if (clusters.length > 0) {
    lines.push("");
    lines.push("## Failure clusters");
    for (const cluster of clusters) {
      lines.push(`- [${cluster.source}] ${cluster.key} — ${cluster.count} rationale(s), cases: ${cluster.caseIds.join(", ")}`);
    }
  }
  const overrides = findings.humanOverrides ?? [];
  if (overrides.length > 0) {
    lines.push("");
    lines.push("## Human overrides");
    for (const override of overrides) {
      lines.push(`- ${override.caseId}: judge ${override.judgeLabel} → ${override.source} ${override.label} — ${override.rationale}`);
    }
  }
  const distribution = findings.verdictDistribution ?? [];
  if (distribution.length > 0) {
    lines.push("");
    lines.push("## Verdict distribution");
    lines.push("| stratum | cases | judge | human |");
    lines.push("| --- | --- | --- | --- |");
    const counts = (record) => Object.entries(record ?? {}).map(([label, count]) => `${label} ${count}`).join(", ") || "—";
    for (const row of distribution) {
      lines.push(`| ${row.stratum ?? "(unstratified)"} | ${row.cases} | ${counts(row.judge)} | ${counts(row.human)} |`);
    }
  }
  console.log(lines.join("\n"));
  process.exit(0);
}

// --- submit: validate → hash → batch → poll → table -----------------------
if (!fileArg) fail(2, USAGE);
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
  // would 400 the whole batch without line context). Same rules as gate.mjs.
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
  // Content hash IDENTICAL to gate.mjs (and the server's ex_ hash): steps
  // join only when present; metadata never joins — provenance edits must not
  // mint a new case. Re-submitting unchanged content reuses recorded
  // verdicts (no provider spend); an edited line is judged fresh.
  const contentHash = createHash("sha256")
    .update(JSON.stringify({
      input: row.input ?? null,
      output: row.output ?? null,
      ...(row.steps ? { steps: row.steps } : {})
    }))
    .digest("hex")
    .slice(0, 32);
  // Metadata passthrough (capture provenance rides along); `name` wins over
  // a metadata.name collision so the dashboard title stays the explicit one.
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? { ...row.metadata }
    : {};
  if (typeof row.name === "string" && row.name) metadata.name = row.name;
  items.push({
    sourceTraceId: `ci_${contentHash}`,
    input: row.input ?? null,
    output: row.output ?? null,
    metadata,
    ...(row.steps ? { steps: row.steps } : {}),
    ...(label ? { expectedLabel: label } : {}),
    ...(row.expectedFailStep !== undefined && row.expectedFailStep !== null ? { expectedFailStep: row.expectedFailStep } : {})
  });
});
if (items.length === 0) fail(2, `${fileArg} contains no examples`);
// DIVERGENCE from gate.mjs: no "at least one label" requirement — an
// unlabeled audit is legal here (both this pre-submit gate and the post-run
// labeledCompleted === 0 gate are relaxed; see the zero-label banner below).

const submitted = await api("/api/v1/judge/batch", {
  method: "POST",
  body: JSON.stringify({ items })
});
console.log(
  `coeval-submit: submitted ${submitted.totalItems} case(s) ` +
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

// Table: counts, not percentages, per the product's honesty rules. The step
// column is display-only — the exit code is a function of overall label
// agreement alone.
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
  console.log(`\ncoeval-submit: judge named the expected failing step on ${stepAgreed} of ${stepLabeled} step-labeled case(s) (informational — does not affect the exit code)`);
}

// Informational spend (tokens + counts, never dollars; no exit-code effect).
if (run.spend) {
  const s = run.spend;
  const tokens = s.inputTokens === null && s.outputTokens === null
    ? "usage unavailable"
    : `${s.inputTokens ?? 0} in / ${s.outputTokens ?? 0} out tokens`;
  console.log(
    `coeval-submit: spend — ${s.freshItems} fresh, ${s.cachedItems} cached (no spend), ${tokens}` +
    (s.usageMissingCount > 0 ? ` (usage unavailable for ${s.usageMissingCount} call(s))` : "")
  );
}

const labeledCompleted = run.items.filter((item) => item.expectedLabel !== null && item.status === "completed").length;
const failedItems = run.items.filter((item) => item.status === "failed").length;
const completedItems = run.items.filter((item) => item.status === "completed").length;
console.log(
  `\ncoeval-submit: ${run.agreedItems}/${labeledCompleted} labeled case(s) agree ` +
  `· skill version ${run.skillVersionId}` +
  (failedItems > 0 ? ` · ${failedItems} item(s) FAILED (infrastructure)` : "")
);

if (run.status === "failed" || failedItems > 0) {
  fail(1, "the run had infrastructure failures — these verdicts are incomplete and must not be reported as an audit");
}
if (labeledCompleted === 0) {
  // Printed by the script, verbatim, so a summarizing agent cannot soften it.
  console.log(`\n${completedItems} judge verdicts, 0 human labels — no agreement measured; these are the judging skill's opinions, not verified correctness.`);
  process.exit(0);
}
const agreement = run.agreedItems / labeledCompleted;
if (minAgreement !== null && agreement < minAgreement) {
  fail(1, `BLOCKED — agreement ${run.agreedItems}/${labeledCompleted} is below the --min-agreement ${minAgreement} threshold`);
}
console.log(minAgreement === null
  ? "coeval-submit: done (no --min-agreement threshold set — agreement above is informational)"
  : "coeval-submit: PASSED");
