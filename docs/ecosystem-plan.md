# Ecosystem plan — Track B

> **Status: historical implementation plan, not product authority.** This file
> records an earlier build track and may be useful when reading existing code.
> New product work follows [`../PRODUCT.md`](../PRODUCT.md) and accepted ADRs
> in [`decisions/`](decisions/). In particular, do not infer new target scope
> from the milestones below.

Working plan for the Coeval "incident and trust" track. Sibling products in the
wider ecosystem: **ironside**, **casefile** (formerly skillguard), **dailies** (formerly release-layer).
This document records the Track B build order and the binding corrections from
the design review — implementations must follow these, not the earlier drafts.

The beginner-facing trace-to-test milestone is tracked separately in
[`trace-to-test-journey.md`](trace-to-test-journey.md). Its first milestone
deliberately does not change the incident/trust build order below.

## Build order

1. **Incident Bisect** (shipped in this track's first slice) — compare one
   dataset across two skill versions via two ordinary eval runs plus a
   persisted `run_comparisons` pairing; per-case diff is joined from
   `eval_run_items` at read time. See `POST /api/run-comparisons` and
   `apps/api/src/lib/run-comparison.ts`.
2. **Trust Reports** — the roadmap's "persisted report artifact". Assembled
   from the already-shipped pure builders: `apps/api/src/lib/judge-card.ts`,
   `apps/api/src/lib/trust-digest.ts`, and `apps/api/src/lib/kappa.ts`. The
   feature is persistence + retrieval of a point-in-time artifact, not new
   metric math.
3. **Drift Sentinel** — scheduled re-judging of a pinned dataset to detect
   verdict drift under an unchanged skill version.
4. **Remedy** — proposed skill-version fixes generated from incident evidence.

## Binding review corrections

These four corrections came out of review and are binding on the milestones
above:

- **Remedy must not judge production traffic by accident.** Remedy needs a
  distinct `proposal` status (or an approved-version precondition) on skill
  versions. `getCurrentSkill` only RANKS approved versions above drafts —
  on a fresh project with no approved version, drafts DO judge live traffic —
  and a Remedy-minted draft would also hijack `getLatestSkill`, which is the
  editing base the skill editor reloads. A remedy proposal must be neither
  judgeable nor the implicit editing base until a human promotes it.
- **Drift Sentinel is implemented as eval runs, not judge re-triggers.**
  Eval-run items always call the provider fresh (the replay guard protects
  retries, not scheduled re-measurement); the maskable dedup that would
  swallow a drift measurement lives only in the single-trace endpoint and the
  legacy `judge_runs` (project, case, skillVersion) dedup. Adding the
  `scheduled_drift` trigger requires a migration altering the CHECK constraint
  on `eval_runs.trigger` (0025 pins it to
  `('manual','api_batch','regression_gate')`).
- **There is no `token_spend` table.** Spend reporting aggregates from the
  `eval_run_items` token columns (`input_tokens` / `output_tokens`, plus the
  `cached` flag and `usageMissingCount` semantics in `computeEvalRunSpend`) —
  do not design against a table that does not exist. (Migration
  `0032_token_spend.sql` adds those item columns; it does not create a table.)
- **Trust Reports reuse, never recompute.** The artifact is assembled from
  `judge-card.ts` + `trust-digest.ts` + `kappa.ts` outputs; the report layer
  adds versioned persistence and an audit trail only. Metric definitions stay
  single-sourced in those libs.
