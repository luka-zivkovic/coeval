# ADR-0001: Evidence contract ownership and versioning

Status: **Accepted**

Date: 2026-08-22

## Context

Coeval emits assessment evidence and Dailies consumes it. Sharing runtime
types directly would couple their release cycles, while independently written
schemas could drift. Evidence digests also make an apparently additive field
semantically significant: a consumer must not verify bytes it does not
understand.

## Decision

Coeval owns the canonical assessment-receipt contract and its semantic
invariants. Each contract version includes:

- a versioned schema;
- positive interoperability fixtures;
- negative fixtures for unknown fields, unsupported versions, invalid
  digests, ordering, coverage, and identity mismatches; and
- a canonicalization and digest specification.

Consumers such as Dailies vendor a reviewed copy instead of importing a
Coeval runtime package. Consumer tests pin the canonical schema/fixture digest
and run their own semantic verification.

Receipt v1 is closed. Adding, removing, or changing a field requires another
contract version and a coordinated compatibility window. Multiple receipt
versions may coexist; a new version does not silently reinterpret historical
v1 evidence.

Coeval receipts contain assessment and provenance only. Release thresholds,
`promote`/`block` decisions, rollout state, and override policy are forbidden.

This ADR does **not** decide whether future calibration travels in a receipt,
a separate artifact, or another lookup. That is intentionally deferred to
ADR-0003 and ADR-0004.

## Consequences

- Coeval is accountable for contract meaning; consumers remain accountable
  for independent verification.
- A shared fixture alone is insufficient; schema drift and semantic tampering
  need negative tests.
- Strict v1 parsing is compatible with a future v2 rather than a promise that
  v1 is the only evidence shape forever.
