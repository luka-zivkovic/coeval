// Deterministic prelude for the E2E AI simulation. Scripts the judgment-free
// setup so sim time is spent on the UI walk, not plumbing:
//
//   node tools/sim/prelude.mjs [--reset] [--setup] [--key] [--batch] [--dump]
//
// No flags = --setup --key --batch --dump. `--reset` is never implicit: it
// drops the public schema of DATABASE_URL and re-runs migrations. Restart the
// API after a reset (its pool and better-auth state predate the new schema).
// Skip --setup when the sim should walk first-run setup in the browser (i.e.
// whenever onboarding is under test).
//
// Credentials come from SIM_EMAIL / SIM_PASSWORD (no committed defaults).
// Requires: the API running at COEVAL_API (default localhost:8787) for
// everything except --reset/--dump, and a built packages/db for --reset.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_BASE,
  CookieJar,
  SIM_DIR,
  apiFetch,
  closePool,
  getPool,
  query,
  writeArtifact
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const explicit = ["--reset", "--setup", "--key", "--batch", "--dump"].some((flag) => args.has(flag));
const step = (flag) => (explicit ? args.has(flag) : flag !== "--reset");

const log = (message) => console.log(`[prelude] ${message}`);
const fail = (message) => {
  console.error(`[prelude] FATAL: ${message}`);
  process.exit(1);
};

const jar = new CookieJar();

if (step("--reset")) {
  const { runMigrations } = await import("../../packages/db/dist/index.js").catch(() => {
    fail("packages/db is not built — run: pnpm --filter @coeval/db build");
  });
  log("dropping public schema and re-running migrations…");
  await getPool().query("drop schema public cascade; create schema public;");
  await runMigrations(getPool());
  log("schema reset complete — RESTART THE API before continuing (its pool predates the new schema)");
}

if (step("--setup")) {
  const email = process.env.SIM_EMAIL;
  const password = process.env.SIM_PASSWORD;
  if (!email || !password) fail("--setup needs SIM_EMAIL and SIM_PASSWORD in the environment");

  const setup = await apiFetch("/api/auth/setup", {
    jar,
    method: "POST",
    body: JSON.stringify({ email, password, name: process.env.SIM_NAME ?? "Sim Owner" })
  });
  if (setup.ok) {
    log(`owner created and signed in as ${email}`);
  } else if (setup.status === 409) {
    // Already set up — fall back to signing in so later steps have a session.
    const signin = await apiFetch("/api/auth/sign-in/email", {
      jar,
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    if (!signin.ok) fail(`setup already done but sign-in failed (${signin.status}): ${await signin.text()}`);
    log(`setup already complete — signed in as ${email}`);
  } else {
    fail(`setup failed (${setup.status}): ${await setup.text()}`);
  }
}

let apiKey = null;
if (step("--key")) {
  if (jar.cookies.size === 0) fail("--key needs a session — run with --setup (it signs in)");
  const minted = await apiFetch("/api/api-keys", {
    jar,
    method: "POST",
    body: JSON.stringify({ name: `sim-harness-${new Date().toISOString().slice(0, 10)}` })
  });
  if (!minted.ok) fail(`key mint failed (${minted.status}): ${await minted.text()}`);
  const body = await minted.json();
  apiKey = body.key ?? body.apiKey?.key;
  if (!apiKey) fail(`key mint response had no plaintext key: ${JSON.stringify(body).slice(0, 200)}`);
  log(`API key minted: ${apiKey.slice(0, 16)}… → ${writeArtifact("api-key.txt", apiKey + "\n")}`);
}

if (step("--batch")) {
  if (!apiKey) {
    try {
      apiKey = readFileSync(join(SIM_DIR, "api-key.txt"), "utf8").trim();
    } catch {
      fail("--batch needs an API key — run with --key first, or put one in out/sim/api-key.txt");
    }
  }
  let batchBody;
  try {
    batchBody = readFileSync(join(SIM_DIR, "batch-body.json"), "utf8");
  } catch {
    fail("out/sim/batch-body.json not found — the canonical 40-trace batch is a sim artifact, not committed");
  }

  const submitted = await fetch(`${API_BASE}/api/v1/judge/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: batchBody
  });
  if (!submitted.ok) fail(`batch submit failed (${submitted.status}): ${await submitted.text()}`);
  const run = await submitted.json();
  log(`batch accepted: ${run.evalRunId} (${run.totalItems} items, ${run.cachedItems} cached)`);

  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const polled = await fetch(`${API_BASE}${run.pollUrl}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!polled.ok) fail(`poll failed (${polled.status})`);
    const status = await polled.json();
    log(`  ${status.status} ${status.completedItems}/${status.totalItems} (${status.failedItems} failed)`);
    if (status.status === "completed" || status.status === "failed" || status.status === "canceled") {
      if (status.status !== "completed" || status.failedItems > 0) {
        log(`WARNING: batch finished ${status.status} with ${status.failedItems} failed items`);
      }
      break;
    }
    if (Date.now() > deadline) fail("batch did not finish within 15 minutes");
  }
}

if (step("--dump")) {
  // Rubric text snapshots — the 2026-06 rerun lost run-over-run diffability
  // because the rubric lived only in a dropped database. Never again.
  const versions = await query(`
    select sv.version, sv.status, sv.verdict_kind, sv.rubric_markdown, sv.prompt,
           sv.model_binding, sv.golden_set_agreement, sv.too_strict_count,
           sv.too_lenient_count, sv.ambiguous_count, sv.created_at
    from public.skill_versions sv
    order by sv.created_at, sv.id`);
  log(`dumped ${versions.length} skill versions → ${writeArtifact("skill-versions.json", versions)}`);

  // Latest judge verdict per (trace, skill version) — the run-over-run diff
  // baseline. Keyed by trace id so two runs over the same batch line up.
  const verdicts = await query(`
    select distinct on (rt.source_trace_id, sv.version)
           rt.source_trace_id, sv.version as skill_version,
           coalesce(v.payload->>'choice', case when (v.payload->>'pass')::boolean then 'pass' else 'fail' end) as label,
           v.created_at
    from public.verdicts v
    join public.cases c on c.id = v.case_id
    join public.raw_traces rt on rt.id = c.raw_trace_id
    left join public.skill_versions sv on sv.id = v.skill_version_id
    where v.source = 'llm_judge'
    order by rt.source_trace_id, sv.version, v.created_at desc`);
  log(`dumped ${verdicts.length} judge verdicts → ${writeArtifact("judge-verdicts-baseline.json", verdicts)}`);

  const humans = await query(`
    select rt.source_trace_id, v.payload->>'choice' as label, v.payload->>'rationale' as rationale, v.created_at
    from public.verdicts v
    join public.cases c on c.id = v.case_id
    join public.raw_traces rt on rt.id = c.raw_trace_id
    where v.source in ('human', 'adjudicated')
    order by v.created_at`);
  log(`dumped ${humans.length} human/adjudicated verdicts → ${writeArtifact("human-verdicts-baseline.json", humans)}`);
}

await closePool();
log("done");
