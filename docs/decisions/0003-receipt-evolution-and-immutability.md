# ADR-0003: Receipt evolution and immutability

Status: **Accepted**

Date: 2026-08-22

## Context

Receipt v1 describes current release-evidence execution, but it has no general
uncertainty or abstention semantics and does not link to calibration. Current
receipts are derived on demand from eval-run rows, so immutability depends on
those rows never changing rather than on a preserved receipt artifact.

## Decision

Keep v1 as the frozen current wire contract. Do not add calibration,
uncertainty, or policy fields to it.

For every externally consumable assessment, persist the exact canonical
receipt bytes and their digest as an append-only artifact. The stored identity
is unique for its assessment and protected from later mutation. Provider
provenance and incomplete state are part of those exact bytes.

A correction never mutates or silently regenerates a published receipt. It
creates a new versioned receipt with a distinct identity and an explicit
relationship to the superseded artifact. Historical consumers can continue to
verify the original bytes.

Before defining v2, jointly specify:

- abstention versus infrastructure failure;
- uncertainty representation and provenance;
- calibration linkage;
- compatibility and downgrade behavior; and
- whether calibration is embedded, separately addressed, or retrieved by
  immutable identity.

## Consequences

- "Immutable evidence" becomes an enforceable storage property rather than a
  documentation promise.
- Receipt reads return the persisted artifact rather than a reconstruction from
  mutable operational rows.
- v1 remains useful historical evidence even if v2 is later introduced.
- The transport shape for calibration remains open; implementation must not
  create a one-off attestation contract before that decision.
