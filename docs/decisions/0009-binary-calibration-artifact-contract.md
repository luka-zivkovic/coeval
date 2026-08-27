# ADR-0009: Binary calibration artifact contract

Status: **Accepted**

Date: 2026-08-23

## Context

ADR-0003 freezes assessment receipt v1 and requires an explicit calibration
transport decision. ADR-0004 defines binary classifier measurements but not
their wire representation. ADR-0005 requires separately verifiable evidence
per criterion, and ADR-0008 supplies governed-blind case-less sealed truth.

A public item ledger would unnecessarily reveal sealed item identity and
outcome linkage. Aggregate-only evidence is safer, but it must still conserve
support, expose incomplete execution, bind exact provenance, and let an
independent consumer recompute every public metric. Floating JSON values and
unspecified interval formulae would make canonical cross-product verification
fragile.

## Decision

Accept the separate closed `coeval/binary-calibration/v1` artifact specified in
`contracts/binary-calibration-v1.md`.

The public artifact is aggregate-only. It exposes no item, label, payload,
rationale, provider request/response ID, or observation commitment. It commits
holistically to a protected, non-readable
`coeval/binary-calibration-private-ledger/v1`; that ledger has no public or
project-key read surface. Any later ledger read or export is development
exposure. Its commitment covers exact canonical records ordered by trial and
revision item digest, including truth, terminal evaluator outcome, attempt
state/error, physical provider-call count, provider observation, and a private
per-record salt. The strict internal schema and golden vector do not create a
ledger read surface.

The artifact binds the exact criterion version and digest, evaluator version
and digests, canonical string requested binding, optional suite member, sealed
revision and origin provenance, authorization and completion exposure
snapshots, provider data-handling policy, positive class, trial plan, and
observation-level provider-strength groups. `revisionDigest` binds the role and
multiset of item digests, not item presentation order; no redundant truth-set
digest is introduced. Semantic-leakage detection is explicitly unsupported in
v1 rather than implied. Selection method and provenance are bound explicitly;
population representativeness is either tied to a population ID or rejected
under closed reasons.

The confusion matrix uses invariant human-truth/evaluator semantic cells.
Truth-pass and truth-fail recall stay invariant, while precision, recall, and
F1 are also emitted for the declared positive class. All public values are
safe integers, exact fractions, canonical decimal strings, digests, or exact
binary64 bits. Negative zero is invalid.

Primary binomial rates use the exact 95% `wilson-score/v1` operation order and
pinned z bits. Bounds are lowercase 16-hex big-endian binary64 encodings. F1
has no confidence interval in v1. Repeated trials preserve ordered trial
aggregates; they are not pooled, averaged into one claim, or voted.

Wilson intervals condition on the frozen revision only. They are not
population/design-weighted intervals and do not incorporate stratification,
finite-population correction, clustering, or selection uncertainty.

Complete means every planned item in every trial produced a terminal valid
classification or explicit abstention, with no execution error or unevaluated
item, and the completion exposure recheck remains protected and eligible.
Abstentions lower policy-visible classified coverage but do not make the
artifact incomplete. Execution error, `outcome_unknown`, an unevaluated item,
or an exposed/ineligible completion recheck makes the artifact incomplete
under closed reasons without turning it into a failed or favorable label.
`outcome_unknown` is permanent for that logical attempt and is not retried in
the same run.

`providerCalls` counts physical calls and transport retries separately.
Provider-strength groups count logical observations and conserve `planned`, so
a retry does not weaken a successfully observed outcome. Every group retains
the globally requested provider; observations without returned identity remain
`requested_only` and cannot be omitted. Public call count cannot be lower than
classified, abstained, and `outcome_unknown` attempts; the private ledger also
enforces physically possible call counts per record.

Published artifacts are immutable. A correction appends one nonbranching
successor artifact. A later exposure or provenance discovery is recorded as a
separate revocation/admissibility fact and does not rewrite historical bytes.

Batch 5B must enforce one nonterminal run per exact evaluator and sealed
revision, protected start and completion snapshots, and the sealed-reuse
barrier: an evaluator version created or developed after the earliest prior
final-validation completion for that revision and stable criterion lineage
cannot reuse it. Unknown ordering fails closed.

Dailies consumes calibration under a separate calibration scope. It does not
upgrade receipt-v1 candidate `producerProvenance`, which remains
`not_provided`. Calibration integrity and provider-strength failures are scoped
to the required criterion. They make that criterion inconclusive and cannot be
repaired by advisory evidence, while an independently complete admissible
blocking failure retains Dailies' already accepted precedence over unrelated
incompleteness.

## Consequences

- Receipt v1 and suite manifest v1 remain byte-for-byte unchanged.
- Consumers can recompute all public metrics without receiving sealed item
  evidence.
- Wilson interoperability is pinned by exact bytes and golden vectors rather
  than an allegedly equivalent formula.
- Provider identity weakness stays visible and cannot be filtered out of a
  criterion after execution.
- Calibration provenance does not launder missing candidate provenance.
- Batch 5A changes no migration, API, worker, UI, provider call, or runtime
  orchestration; those remain Batch 5B work.
