# Coeval evidence contracts

## Binary calibration artifact v1

`binary-calibration-v1.schema.json` is the closed, policy-free,
aggregate-only contract for one exact binary evaluator/criterion measured over
one governed-blind sealed-validation revision. It binds exact evaluator,
criterion, truth, exposure, selection, provider-observation, and repeated-trial
identity; publishes semantic confusion counts, exact fractions, coverage, and
pinned Wilson interval bits; and exposes no sealed item or observation record.

The three exact-canonical positive fixtures and adversarial corpus in
`fixtures/` cover valid abstention, repeated trials, permanent
`outcome_unknown`, incomplete execution, schema/runtime parity, canonical
bytes, conservation, provenance, and identity substitution. The normative
rules and private-ledger commitment basis are in
[`binary-calibration-v1.md`](binary-calibration-v1.md).
The producer-internal private-ledger schema and dummy-salt golden fixture pin
the public commitment algorithm; they do not create a private-ledger read API.

## Evaluator suite manifest v1

`evaluator-suite-manifest-v1.schema.json` is the closed, policy-free contract
for an immutable ordered suite. It binds each criterion definition to one exact
evaluator version and output contract, with only `all_items` applicability and
an optional closed independent-repetitions plan. It never contains release
roles, weights, thresholds, aggregation, or a release decision.

The positive fixture and adversarial corpus in `fixtures/` cover schema/runtime
parity, canonical digest verification, and rejection of reordered, missing,
substituted, duplicated, or unknown criteria. The normative rules are in
[`evaluator-suite-manifest-v1.md`](evaluator-suite-manifest-v1.md).

This manifest groups separately verifiable criterion assessments; it does not
replace or alter assessment receipt v1.

## Assessment receipt v1

`assessment-receipt-v1.schema.json` is the closed, policy-free wire contract
for a `release_evidence` assessment receipt. The positive fixture and
conformance corpus in `fixtures/` are portable interoperability vectors:
consumers must verify schema acceptance, canonical digests, exact item
coverage, item ordering, and candidate-content linkage. The normative
canonicalization, digest, mutation, and pinned-file rules are in
[`assessment-receipt-v1.md`](assessment-receipt-v1.md).

## Version policy

- Coeval owns the canonical contract; consumers vendor a reviewed copy and
  independently verify it. See
  [ADR-0001](../docs/decisions/0001-evidence-contract-ownership-and-versioning.md).
- Receipt v1 is frozen. Its parsers are intentionally strict at every object
  boundary, so adding, removing, or renaming a field is a breaking change.
- A breaking change requires a new schema version, new fixtures, and a
  coordinated consumer release. Do not add optional fields to v1.
- Coeval emits governed assessment evidence only. Thresholds and release
  decisions are forbidden from the receipt.
- Calibration does not extend receipt v1. ADR-0009 accepts the separate
  `coeval/binary-calibration/v1` aggregate artifact; its Batch 5B persistence,
  API, sealed execution, and revocation lookup remain runtime work.
- The JSON Schema documents the structural contract. Runtime verifiers must
  additionally recompute the canonical evidence and dataset digests and check
  semantic invariants such as complete counters and exact item coverage.

The contract is vendored by consumers instead of published as a shared runtime
package. This keeps release cadences independent while byte-pinned positive and
negative vectors make schema and semantic drift visible in both test suites.
