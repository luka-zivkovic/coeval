# Code organization and large-file reviews

Status: **CURRENT contributor guidance**

Last reviewed: 2026-08-31

## Purpose

Coeval uses 1,000 lines as a prompt to review a file's cohesion. It is not a
hard cap and does not measure code quality by itself. The goal is to make a
small change understandable without loading several unrelated lifecycles into
the same context, especially for human and agent contributors.

Run the tracked-file report from the repository root:

```bash
pnpm large-files
```

The command reports every tracked file over the threshold and its current
classification. It does not fail because a file is large. New unclassified
files are shown as `review_required` so a reviewer can decide whether to split
or document them. It reads the working tree, so unstaged edits affect the
reported counts. Tracked paths unavailable in the working tree are listed
separately without failing the command, and binary assets are ignored.

## Review rule

A maintained file over 1,000 lines should have one of two outcomes:

1. split it at a boundary where responsibilities change independently; or
2. document a strong reason for keeping it together, with navigation hints and
   a condition for revisiting that decision.

Line count is supporting evidence, not the decision. Files substantially over
the threshold deserve more scrutiny, but there is no second hard limit.

Strong reasons include:

- generated or tool-owned output that should not be hand-edited;
- exact-byte or digest-pinned interoperability fixtures;
- a single checksummed migration artifact required by an accepted database
  lifecycle decision;
- one transaction, state machine, or canonical artifact pipeline whose
  ordering and invariants would become harder to audit if scattered; or
- a cohesive end-to-end test that proves one atomic evidence graph and shares
  expensive, inseparable setup.

Weak reasons include:

- the code has historically lived in one file;
- all contents have the same broad domain name;
- splitting requires introducing explicit dependencies; or
- the file is difficult to refactor.

For an exception, the code or inventory should explain:

- the cohesive responsibility;
- the invariant, ordering rule, transaction, or exact artifact protected by
  colocation;
- how a reader should navigate the file; and
- what future change would trigger another review.

## Structural refactor invariants

Large-file refactors are structural work unless separately authorized. They
must not change Coeval's TARGET product boundary, authentication classes,
project isolation, transaction ownership, lock order, retry behavior,
idempotency, public package exports, canonical bytes, frozen contracts, or
evidence semantics.

In particular:

- Coeval remains Analyze to Measure and policy-free. Release decisions remain
  outside Coeval, and semantic clustering remains deferred.
- Governed review and CURRENT `ungoverned_legacy` review remain distinct
  evidence classes.
- `@coeval/shared` keeps its root public entry point unless a separate public
  API decision authorizes subpath exports.
- During the accepted clean-install period, ADR-0011 keeps
  `0001_baseline.sql` as one current-schema migration, and the migration runner
  checksums it. Its size is not permission to split or reinterpret the schema.

## Current inventory

The machine-readable classification lives in
[`tools/large-files.json`](../tools/large-files.json). On 2026-08-31, Coeval
started this review with 25 tracked files over 1,000 lines:

- 1 generated artifact;
- 2 structural exceptions;
- 13 refactor candidates; and
- 9 cohesive modules that require an individual review before either splitting
  or accepting an exception.

`refactor_candidate` means the file already shows multiple independently
changing responsibilities. `cohesion_review` means the file is domain-focused
enough that transaction or state-machine boundaries must be mapped before a
decision. Neither classification promises that the result will be below 1,000
lines.

The inventory is intentionally per repository. Ironside and other products
maintain their own reports and justifications.

The sorted `@coeval/shared` public and runtime export fixtures under `tools/`
are generated review artifacts. They remain separate so each is readable and
below the current trigger. If either crosses 1,000 lines, classify it as a
generated structural exception rather than splitting an exact export surface.

## Revisit conditions

Re-run the report and revisit a classification when:

- a new tracked file crosses the threshold;
- a file gains a second lifecycle, auth surface, transaction owner, or artifact
  format;
- ordinary changes repeatedly require reading most of an otherwise unrelated
  file;
- transaction or route characterization reveals a safe extraction boundary;
  or
- an accepted ADR changes the reason for a structural exception.

The main PostgreSQL repository is additionally guarded by the executable
connection-owner map described in
[`repository-boundaries.md`](repository-boundaries.md). Split repository code
only along those mapped consistency groups, place its extracted command modules
under the checked `apps/api/src/repository.pg/` inventory, and keep caller-owned
transaction work on the supplied client. Independently implemented specialist
repositories may use domain-local support modules when their own structural
tests preserve connection ownership and module edges.

Do not update a classification merely to silence the report. The explanation
is a review aid and should describe the current code honestly.
