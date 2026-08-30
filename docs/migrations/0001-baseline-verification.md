# 0001 baseline verification evidence

Status: **Historical verification record**

Date: 2026-08-26

This records the original baseline replacement required by
[ADR-0011](../decisions/0011-prelaunch-blank-slate-database-policy.md). The
hashes below apply to that 2026-08-26 snapshot; the active clean-install
baseline may continue to change during founder-only disposable testing.

## Inputs and method

- Historical source: commit
  `8ab889886f65c040bd8e9c948be2f9c950bada57`, the PR base containing
  migrations `0001` through `0055`.
- Current source: `packages/db/migrations/0001_baseline.sql` in PR #174 after
  the review fixes recorded here.
- Database engine: PostgreSQL 17.11.
- Each historical migration was applied in filename order and in its own
  transaction to one empty database. The baseline was applied in one
  transaction to a second empty database.
- Both databases were dumped with `pg_dump --schema-only --no-owner
  --no-privileges`. Only dump-version, database-name, timestamp, and
  `\\restrict`/`\\unrestrict` session noise was removed before comparison.
  Schema comments remained in the comparison.

The auditable sequence was:

1. `git archive` the historical migration directory from the immutable base
   commit.
2. Apply the historical chain and current baseline to separate empty
   PostgreSQL 17 databases.
3. Normalize the two schema-only dumps as described above.
4. Compare them with `diff -U 2` and classify every hunk against ADR-0011.

## Result

The historical dump contained 19,568 normalized lines; the current baseline
contained 19,246. The comparison contained 40 hunks. Every hunk mapped to one
of ADR-0011's approved removals or the stricter invariant that replaces it:

| Difference group | Approved ADR-0011 change |
| --- | --- |
| Removed nullable criterion references, auto-binding triggers, and `legacy_skill_backfill` creation/source values | Nullable or auto-bound criterion references created for pre-0048 writers; upgrade-only tolerant fallbacks |
| Removed `unresolved_legacy` and `gate_candidate_legacy` purposes, checks, and insert guard | Pre-launch-only ingestion purposes and their runtime compatibility |
| Required input identity digests and removed unresolved pre-tracking guards | Unresolved pre-tracking case identities and their project-wide serialization branch |
| Removed `project_regression_revisions` plus its guard, mirror functions, triggers, constraints, and foreign keys | Project-scoped regression pointer and criterion-pointer mirroring |
| Required immutable evaluator/dataset pins and changed their foreign keys from `SET NULL` to `RESTRICT` | Evaluator-version regression late pinning and nullable historical pins |
| Removed trace-test validation method `legacy` | Upgrade-only trace-test validation state |

There were no unclassified schema differences. During review, two
semantically equivalent `BETWEEN` expressions and two unchanged error-message
strings were restored to the historical definitions so they did not appear as
unapproved normalized-dump drift.

Verification hashes:

- historical normalized dump:
  `943d969544aa3cc6fc46516dad17699ab7794a989f464e5da042cba907c7ce8a`
- current normalized dump:
  `51ec0f4afe6def94650a2df0c96814dafc6717c582560387d0eec2287e190f9e`
- classified unified diff:
  `6558ce52ef358b6f9a4514a09a3d2092a1b02161feff8a357a48d722503520f6`

The full historical chain remains recoverable from the immutable Git commit;
duplicating it in the current tree or CI would contradict the accepted
blank-slate policy.
