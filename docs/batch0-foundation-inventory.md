# Batch 0 foundation inventory

Status: **active checkpoint record**

Captured: 2026-08-22 before Batch 0 commits

## Repository state

- Batch branch: `codex/batch0-foundation`
- Preserved base: `1a2804c306d83eddfcbd60a9883a0d7f9b58a78c`
- Observed `origin/main`: `3b2b05fc96fe8ac40e4f912a51cbd087545b8a81`
- Relationship at capture: the preserved base was 23 commits behind
  `origin/main` and had no unique committed changes.
- Dirty state at capture: 40 tracked files plus 22 untracked files before this
  inventory was added.

The uncommitted foundation covers release-evidence receipt v1, provider
provenance, terminal worker failure handling, prompt-boundary hardening,
database migrations, UI evidence display, tests, CI, contracts, and the
authoritative documentation stack. It predates the Ironside work currently on
`origin/main`.

## Integration hazard

`origin/main` added Ironside migrations numbered `0039` through `0043`. The
preserved foundation independently added release-evidence migrations numbered
`0039` and `0040`. After documentation and foundation changes are committed on
this branch, integrate `origin/main` without discarding either line of work and
renumber the release-evidence migrations above the then-highest migration.
Re-run clean-install and upgrade migration tests after reconciliation.

## Preserved stash

`stash@{0}` was observed as:

> On coeval-v2-verdict-shape: v2-foundation: stash docs/08 + README changes for
> separate PR

Its diff is one README insertion. Batch 0 leaves this stash untouched because
its intended branch and owner are historical context not recoverable from the
stash message alone. It must not be dropped to make the repository appear
clean.

## Checkpoint order

1. Commit authoritative documentation only.
2. Complete and verify the receipt conformance corpus.
3. Commit the preserved runtime/test foundation in reviewable units.
4. Integrate current `origin/main`, resolve overlapping code, and renumber
   migrations.
5. Run the full Node 24, Postgres, typecheck, test, and build matrix.
6. Obtain an independent read-only audit before merge.
