# ADR-0006: Receipt artifact storage, historical freeze, and legacy gate removal

Status: **Accepted**

Date: 2026-08-22

## Context

ADR-0003 requires exact, append-only assessment receipt artifacts. Receipt v1
currently exists only as a deterministic projection over mutable eval-run,
item, skill-version, and provider-provenance rows. The API rebuilds that
projection on every read, so a later source-row change can silently change the
bytes returned for the same receipt identity.

Some terminal v1 runs predate artifact storage. Consumers may already hold a
copy of a receipt generated from those rows. Coeval also retains deprecated
product-release gate writes while Dailies migrates to the receipt boundary.

## Decision

### Exact representation

Persist the exact canonical UTF-8 receipt bytes in PostgreSQL `bytea`. Store a
separate SHA-256 digest over those complete bytes, alongside the receipt's own
`evidenceDigest` (which covers the canonical receipt without that field).
Queryable identity and lineage columns are indexes, not an alternative source
of receipt truth.

Each artifact records:

- project, eval-run, receipt, contract-version, and artifact-revision identity;
- exact canonical bytes and their whole-artifact digest;
- the receipt's evidence digest;
- a digest of the source-row snapshot used to mint it, or of the governed
  correction artifact supplied for an appended correction;
- source kind: terminal mint, historical freeze, or correction;
- predecessor identity and correction reason where applicable; and
- creation and actor provenance outside receipt v1.

The root artifact is revision 1 and unique per `(eval_run_id,
contract_version)`. A correction appends a higher revision with a distinct
`receiptId` and an explicit predecessor. It never updates, deletes, or silently
replaces an earlier artifact. The established eval-run receipt URL continues
to return the root bytes. Successors are retrieved by their own receipt
identity.

Artifact and consumer-comparison rows reject direct update and deletion while
their project exists. Explicit project deletion remains the existing
tenant-erasure boundary and may cascade the rows; erasure is not a correction
or a new historical receipt.

### Terminal minting and reads

For new `release_evidence` runs, mint the root artifact in the same repository
transaction that first makes the run terminal. This includes a run that is
already terminal when created from cached items. If artifact creation fails,
the terminal state change fails with it.

The receipt endpoint does not mint or return evidence for a nonterminal run.
Once a root exists, every read returns the stored bytes without rebuilding
from source rows.

### Historical one-time freeze

A terminal pre-artifact v1 run is frozen once under the eval-run row lock. The
ordinary GET path may perform this idempotent freeze to preserve compatibility,
and an operator may pre-freeze runs during rollout. Freeze provenance and the
source-row snapshot digest are stored outside receipt v1.

When a consumer-held canonical copy is available, the consumer may submit its
exact bytes for comparison. Coeval stores that copy and its whole-byte digest
in an append-only comparison row, records `match` or `diverged`, and never uses
the submitted copy to overwrite the server artifact. A divergence is evidence
to investigate, not permission to rewrite either history.

### Deprecated release gates

`product_gate`, `POST /api/v1/gate-checks`, and `gate.mjs --product` accept no
new integrations. Their write behavior remains compatibility-frozen through
the Dailies report/config v4 migration. In Batch 2 the deprecated write paths
will return `410 Gone`; historical gate reads remain available. Coeval's
evaluator-version `regression_gate` is not part of this removal.

## Consequences

- Receipt v1's wire schema and canonicalization remain unchanged.
- Source-row mutation cannot alter an already minted receipt.
- Concurrent terminalization and historical reads converge on one root.
- Corrections remain visible as lineage instead of retroactive mutation.
- Historical first freeze cannot recreate bytes that were never retained;
  consumer comparison makes any known divergence explicit.
- Exact-byte retention is subject to explicit tenant deletion, consistent with
  the existing project-erasure contract.
