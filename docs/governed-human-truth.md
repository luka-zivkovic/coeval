# Governed human truth

Status: Batch 4 implementation contract

Coeval has two deliberately separate human-review paths. They must not be
combined in queries, exports, UI claims, or migrations.

## Governed review

The governed path implements [ADR-0008](decisions/0008-governed-human-truth-and-sealed-collection.md).
It uses immutable instruction versions, governed review items, server-selected
batches, opaque reviewer assignments, append-only task and batch events,
independent labels, and non-branching adjudication. A label is `pass`, `fail`,
or `cannot_determine`; every label requires a rationale. There is no majority
vote, and unresolved coverage never becomes truth.

Reviewer task responses are exact canonical bytes. The first view persists
those bytes and their digest, and later reads replay the same artifact. The
projection allowlists only `input`, `output`, and optional ordered
`steps[{name?,input,output}]`. Exact-byte tests and forbidden-key canaries can
show that a known field is absent; they cannot prove that arbitrary content is
anonymous, non-identifying, or free of semantic leakage. Custodians must still
redact content before intake and review the selected population.

Relational governed evidence uses the separate `governed-content-json/v1`
digest basis: SHA-256 over the whitespace-free object `{content,kind}` with
recursive UTF-16 key ordering and exponent-free finite JSON numbers. Both the
application and PostgreSQL implement that canonicalization independently, and
cross-runtime golden vectors cover nested values, Unicode ordering, escaping,
and numeric edge cases. PostgreSQL rejects NUL and unpaired UTF-16 surrogates,
so the application rejects those values before it computes governed evidence.
`governedReviewInstructionDigest` is aligned to the relational
`review-instruction/v1` trigger projection. Other closed shared-model helpers
are explicitly named `...DomainArtifactDigest` and use distinct full
`coeval/...-domain-artifact/v1` kinds because those models do not contain every
field in the relational evidence row. Persisted rows are verified by supplying
the migration's exact kind and content projection to the generic verifier;
unlike row shapes are never treated as the same digest artifact.
The exact first-view byte contract above remains `coeval-canonical-json/v1`;
its locked receipt-style canonicalization is intentionally unchanged.

Sealed intake is case-less. Protected payload snapshots never enter ordinary
`cases`, trace feeds, legacy queues, project-key APIs, or legacy exports.
Any signed-in project member may act as the immutable intake custodian. This
does not authorize that member to open or freeze a sealed batch: the owner-only
control plane re-checks the custodian and every content-exposed subject against
the entire criterion's evaluator-development lineage before either transition.
Reviewer, alignment, and adjudication views never reveal evaluator output for
a sealed batch. Batch 4 can freeze complete pass/fail human truth, but it does
not execute an evaluator over that case-less sealed population. That final
sealed evaluator execution and its calibration artifacts belong to Batch 5.

Representativeness is a scoped provenance claim, not a property of a label.
`representativeOfPopulationId` is available only for a complete simple or
stratified random draw from one exact finite, frozen population with a fixed
stop. Systematic, convenience, manual, uncertainty, failure-hunting, and
incomplete samples remain explicitly nonrepresentative.

## Legacy review

Existing `verdicts`, review queues, golden promotions, and historical
adjudications remain `ungoverned_legacy`. They are useful for unblinded
exception triage and evaluator development, but they do not prove independent
assignment, blindness, representativeness, governed instructions, or governed
adjudication. The legacy HTTP surfaces emit
`X-Coeval-Governance-Class: ungoverned_legacy` without changing their existing
JSON, CSV, or JSONL shapes.

The clean baseline creates no governed rows from unblinded triage. No
operational or reporting code may infer a stronger class from a verdict, queue, golden
entry, or adjudication. Cohen's kappa remains a diagnostic over this legacy
ledger. If chance-expected agreement is one, kappa is reported as undefined
with reason `expected_agreement_one`; raw one-label agreement is not converted
to favorable `kappa = 1`.

## Imports and deferred analysis

Imported truth is classified from verified server evidence as
`imported_verified_attested`, `imported_self_attested`, or `unverified`. An
import is never relabeled `governed_blind`.
Batch 4's session upload accepts opaque provenance JSON and can mint at most
`imported_self_attested`; non-null caller fields are preserved claims, not
independent proof. The stricter closed `ImportedHumanTruth` domain artifact
requires normalized rater, instruction, adjudication, and binary-truth fields,
so its pure classifier is intentionally not interchangeable with this opaque
intake projection. A future trusted connector or signature verifier must use a
separate server-owned path before `imported_verified_attested` is possible.

Semantic clustering is deferred by the product charter. Batch 4 does not add a
clusterer, cluster-derived sampling, or a cluster-based representativeness
claim. Failure codes remain reviewer-authored open strings until a later,
explicitly accepted analysis design says otherwise.

## Operations

Create the database from the current baseline described by
[ADR-0011](decisions/0011-prelaunch-blank-slate-database-policy.md). Governed
evidence is append-only while its project exists; project erasure is the only
supported deletion path.
