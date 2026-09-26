# Rubrist evidence contracts

## Binary calibration artifact v2

`binary-calibration-v2.schema.json` is the contract Rubrist emits for sealed
calibration. It replaced calibration v1 (Rubrist ADR-0014 section 7, decision
6) and keeps every v1 rule except what ADR-0014 changes:
the evaluator is the v2 evaluator identity with `skillDigest` and
`requestedBindingDigest` recomputed from it, error codes are the shared
failure taxonomy, never-attempted items are `notAttempted`, private-ledger v2
records carry the shared item result, and provider groups record the
OpenRouter upstream. Three exact-canonical positive fixtures cover a prompted,
a typed-question, and an OpenRouter evaluator, and the adversarial corpus
carries every v1 case forward with the binding cases rewritten for the v2
execution binding. The normative rules are in
[`binary-calibration-v2.md`](binary-calibration-v2.md).

## Evaluator suite manifest v2

`evaluator-suite-manifest-v2.schema.json` is the suite manifest Rubrist
publishes. It replaced manifest v1 (Rubrist ADR-0014 section 7, decision 6)
and keeps its shape and verification: an immutable ordered suite that binds
each criterion definition to one exact evaluator version and output contract,
with no release roles, weights, thresholds, aggregation, or release decision.
Members
carry the v2 `skillDigest`, which receipt v2 and calibration v2 recompute from
their evaluator identity, and the v2 output-contract digest. The positive
fixture names a prompted and a typed-question evaluator, and the corpus
carries every v1 case forward with the raw-input guards of receipt v2. The
normative rules are in
[`evaluator-suite-manifest-v2.md`](evaluator-suite-manifest-v2.md).

## Skill format v2

`skill-format-v2.schema.json` is the portable export of one evaluator version,
replacing the informal `spec/skill-format-v1.md`. It carries the full
definition, the execution binding, and a typed question's text, with the
digests an importer recomputes and compares with the identity it expected.
The normative rules are in [`skill-format-v2.md`](skill-format-v2.md).

## Assessment receipt v2

`assessment-receipt-v2.schema.json` is the closed, policy-free wire contract
that replaces receipt v1 (Rubrist ADR-0014 sections 6 and 7, decisions 5 and
6). It carries the execution binding and a digest of the evaluator
definition, never rubric, prompt, or question text, and `skillDigest` v2 is
recomputed from them. Each item has exactly one outcome, failure, or
`not_attempted` result, a score whose kind the verdict protocol fixes, and
observed provider provenance. An abstention leaves a receipt complete.

Two positive vectors cover a complete prompted receipt with an abstention and
an incomplete typed-question receipt, and the conformance corpus covers
schema/runtime parity, every digest, the binding's rules, and each semantic
rule. The normative rules and pinned file digests are in
[`assessment-receipt-v2.md`](assessment-receipt-v2.md).

## Assessment receipt v1 (superseded)

`assessment-receipt-v1.schema.json` is the closed, policy-free wire contract
for a `release_evidence` assessment receipt. The positive fixture and
conformance corpus in `fixtures/` are portable interoperability vectors:
consumers must verify schema acceptance, canonical digests, exact item
coverage, item ordering, and candidate-content linkage. The normative
canonicalization, digest, mutation, and pinned-file rules are in
[`assessment-receipt-v1.md`](assessment-receipt-v1.md).

## Version policy

- Rubrist owns the canonical contract; consumers vendor a reviewed copy and
  independently verify it. See
  [ADR-0001](../docs/decisions/0001-evidence-contract-ownership-and-versioning.md).
- Receipt v1 is frozen, and receipt v2 replaces it (ADR-0014 decision 6):
  before launch, Rubrist and Dailies switch together and neither keeps code
  that emits or verifies v1. The v1 files here are deleted with that code,
  and at the launch baseline every contract restarts at v1 (decision 7).
- Every contract's parsers are intentionally strict at every object
  boundary, so adding, removing, or renaming a field is a breaking change.
- After launch, a breaking change requires a new schema version, new
  fixtures, and a coordinated consumer release, and no optional field is
  added to a published version. Before launch, ADR-0014 decision 7
  renumbers instead of keeping history.
- Rubrist emits governed assessment evidence only. Thresholds and release
  decisions are forbidden from the receipt.
- Calibration does not extend the receipt. ADR-0009 accepts a separate
  aggregate-only calibration artifact, now `rubrist/binary-calibration/v2`,
  which Rubrist mints from its sealed execution runtime.
- The JSON Schema documents the structural contract. Runtime verifiers must
  additionally recompute the canonical evidence and dataset digests and check
  semantic invariants such as complete counters and exact item coverage.

The contract is vendored by consumers instead of published as a shared runtime
package. This keeps release cadences independent while byte-pinned positive and
negative vectors make schema and semantic drift visible in both test suites.
