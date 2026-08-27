# E2E AI simulation — runbook

The recurring pre-release ritual: an AI agent walks the whole product loop
against real data and reports findings with fresh eyes. This harness scripts
everything that doesn't need judgment, so sim time goes to the UI walk.

Division of labor:
- **`tools/sim/prelude.mjs`** — deterministic setup (reset, owner, key, batch, baselines).
- **`pnpm sim:checks`** — Playwright suite re-verifying previously-confirmed fix claims, read-only.
- **The AI sim itself** — the open-ended hunt. It should never spend time on the two layers above.

## Per-change verification ritual (every commit, not just releases)

The loop used for every feature slice (most recently the Skill Bench mode + its
review-fix pass), in order:

1. **Machine checks** — all four, every time; a web build only when UI changed:
   ```bash
   pnpm typecheck && pnpm test && pnpm --filter @coeval/web build && git diff --check
   ```
2. **New behavior gets an API test first-class** (`apps/api/test`, vitest over
   `DemoRepository`) — assert the *invariant*, not the implementation (e.g.
   "re-pasting edited content mints a fresh case", "a credential-less eval item
   FAILS and writes nothing to the verdict ledger"). PG-side coverage lives in
   `pg-smoke.test.ts` (real schema + real migrations per test). Run it with:
   `set -a; source .env; set +a; PG_SMOKE_DATABASE_URL="$DATABASE_URL" npx
   vitest run apps/api/test/pg-smoke.test.ts --testTimeout=120000`
   — the committed PG_SMOKE url points at a localhost PG that usually isn't
   running, remote databases may need the raised timeout, and vitest never
   autoloads `.env`. Confirm the suite RAN (not `describe.skip`'d); a failing
   database-backed test is a failure, not an environmental skip.
3. **Adversarial review of the diff, before commit** — a fresh-eyes review
   subagent over `git diff` (+ untracked files), primed with the change's
   *design intents* so it can check code against intent, not just style. Fix
   confirmed findings; ignore nits. This pass has caught bugs that machine
   checks missed, including modal lifecycle and mode-specific UI failures.
4. **Review the fixes themselves** — after applying a batch of review/PR-comment
   fixes, run the machine checks AND a fresh review pass over the *fix diff*.
   Fix passes can introduce their own regressions; a green suite alone has
   missed them before.
5. **PR loop** — push the branch, wait for `gh pr checks` green. Treat incoming
   review comments as *claims*: verify each against the code before changing
   anything, fix the confirmed ones, and keep the reviewer's "accepted
   follow-ups" out of the PR (track them instead of scope-creeping).
6. **Feature-level manual E2E** — walk the real UI flow the change enables,
   using the sim segments below (e.g. the Skill Bench walk) as the script.
   Always include the honesty checks: with no provider key, judging must fail
   loudly — silently green mock verdicts are a P0.

## Artifacts (in `out/sim/`, gitignored — local truth, carried between runs)

| File | What | Written by |
|---|---|---|
| `batch-body.json` | the canonical 40-trace batch (reuse for diffability) | hand-made, keep |
| `ground-truth.json` | private expected labels — never shown to the judge | hand-made, keep |
| `policy.md` | the support policy the traces were written against | hand-made, keep |
| `api-key.txt` | current API key plaintext | prelude `--key` |
| `skill-versions.json` | **rubric/prompt text per version** — snapshot after every sim (the 2026-06 rerun lost diffability because the rubric lived only in a dropped DB) | prelude `--dump` |
| `judge-verdicts-baseline.json` | latest judge label per (trace, version) — diff this run-over-run | prelude `--dump` |
| `human-verdicts-baseline.json` | human/adjudicated labels | prelude `--dump` |
| `bench-walk.mjs` + `bench-walk/*.png` | scripted Skill Bench UI walk (Playwright, mutates: creates a bench project + eval run) + its screenshots | hand-made, keep |
| `bench-credentials.env` | throwaway sim account (SIM_EMAIL/SIM_PASSWORD) minted via an invite row for the seeded project | hand-made, keep |

## Running a sim

```bash
# 0. Stack up (two terminals). tsx does NOT auto-load .env.
set -a; source .env; set +a; TRUSTED_ORIGINS="http://localhost:5175" pnpm dev:api
cd apps/web && npx vite --host 0.0.0.0 --port 5175 --strictPort   # 5173 is taken locally

# 1. Optional clean slate. NEVER implicit. Restart the API afterwards.
pnpm sim:prelude --reset

# 2. Deterministic prelude. Skip --setup when onboarding itself is under test
#    (let the sim walk first-run setup in the browser instead).
export SIM_EMAIL=… SIM_PASSWORD=…
pnpm sim:prelude                      # = --setup --key --batch --dump
pnpm sim:prelude --setup --key        # without the (token-spending) batch

# 3. The AI sim — browser walk, findings report (prompt template below).

# 4. Post-sim: re-verify confirmed fix claims + refresh baselines.
pnpm sim:checks                       # playwright, read-only, needs the seeded env
pnpm sim:prelude --dump

# 5. Diff judge behavior vs the previous run
#    (compare judge-verdicts-baseline.json against the previous run's copy).
```

Misc environment notes (learned the hard way):
- Kill stale dev servers first: `lsof -nP -iTCP:8787 -sTCP:LISTEN` / `:5175`. A
  months-old `pnpm dev:api` without `.env` once kept winning the port-bind race
  in demo mode — if the API answers `authEnabled:false` or rejects a valid key,
  check for an old tsx-watch parent before debugging anything else.
- The shared dev DB contains leftover `auth_*`/`test_*` schemas from pg-smoke
  runs; always qualify ad-hoc SQL with `public.` (`tools/sim/db-query.mjs`).
- Playwright MCP needs the Chrome shim at `/Applications/Google Chrome.app`;
  kill stale `ms-playwright-mcp` Chrome processes on "browser already in use".

## Sim prompt template

Paste into a fresh agent session, adjusting the bracketed parts:

> I want to simulate realistic usage of this app end-to-end with AI-generated
> data. [If a rerun: this is a RERUN — N fix commits landed since the last walk
> (see git log). You have fresh eyes: verify the loop works now and find what
> the fixes missed or newly broke.]
>
> Scenario: a customer-support AI agent for a SaaS company. Use the traces in
> `out/sim/batch-body.json` with my private ground truth in
> `out/sim/ground-truth.json` — don't leak ground-truth labels to the judge.
> The prelude (`tools/sim/RUNBOOK.md`) has already [reset the DB / pushed the
> batch / minted a key — state what ran]. Baselines from the previous run are
> in `out/sim/*-baseline.json` — diff judge behavior against them.
>
> **Naive-persona segment (do this FIRST, before reading any code or docs):**
> you are a new support team lead evaluating this product cold. Starting from
> [the login screen / first-run setup], get to your first promoted golden case
> without reading the docs or the source. Narrate every moment of confusion,
> every dead end, every label you didn't understand. Only after completing (or
> abandoning) this, switch to expert mode for the rest.
>
> Then walk the whole loop as the team using it: review ~8 exceptions (agree
> with some judge verdicts, overturn others), promote 4-5 to golden including
> pass anchors, edit the rubric to be stricter and watch the regression gate,
> create a dataset and run an eval in the UI, and read every trust surface
> (κ, calibration, self-consistency, convergence).
>
> **Skill Bench segment (dataset-first mode, no tracing infra):** create a NEW
> project choosing "Start with examples" (Skill Bench). Verify the bench IA
> (sidebar shows Overview/Skill/Examples/Exceptions/Golden set/Reliability, no
> Traces/Review queues; subtitle says "Skill Bench · N examples · no
> production traces"). Then walk the bench loop: define the skill in the
> editor → Add examples (paste ~8 JSONL rows with expected labels, include one
> malformed line and one row without a label — confirm the parse count calls
> both out and nothing is judged on upload) → Run eval → open the run, check
> agreement is shown as a raw count against your labels (never a bare %) →
> open a disagreeing case and promote it to golden → edit the skill to flip
> that case and confirm the regression gate blocks → re-paste one EDITED
> example and confirm it becomes a fresh case (not a stale reuse). With no
> provider key set, an eval run must FAIL its items with a clear
> provider-unavailable error — silently green mock verdicts are a P0 finding.
>
> Known-open items — do NOT re-report: [list current known-open findings].
> `pnpm sim:checks` covers previously-confirmed fix claims — run it instead of
> re-verifying them by hand; investigate any failure as a regression
> (a regression there outranks any new finding).
>
> Don't fix anything mid-run; collect findings and give me a prioritized list:
> (a) regressions, (b) new findings, (c) confirmations. UX issues count.

## Adding to the fix-claims suite

When a sim confirms a fix, encode it in `e2e/fix-claims.spec.ts` (UI-observable,
read-only — specs must skip gracefully when their data doesn't exist) or in
`apps/api/test` (anything mutating: accept-records-label, promote-conflict 409,
gate 503). The sim prompt's "confirm each claimed fix" list should shrink back
to empty after every run — the suite is where confirmations go to live.
