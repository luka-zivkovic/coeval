# ADR-0007: Dataset-role compatibility and exposure

Status: **Accepted**

Date: 2026-08-22

## Context

ADR-0002 established immutable dataset revisions, four exposure roles, and
input-only exact leakage checks. It intentionally left the directional role
compatibility matrix and first sealed-intake boundary unresolved.

Current datasets and golden membership are mutable and visible. Existing
cases may already have been judged, reviewed, exported, or used to shape an
evaluator, so they cannot be treated as historically blind.

## Decision

Mutable datasets remain working collections. Freezing a collection creates a
new immutable revision; it never changes the collection or an earlier
revision.

Exact overlap is directional:

| Existing input state | Analysis/authoring | Iterative development | Regression/golden | Sealed validation |
| --- | --- | --- | --- | --- |
| Legacy or any nonsealed role | allow | allow | allow | reject |
| Protected sealed revision | explicit declassification | explicit declassification | explicit declassification | direct unexposed successor only |
| Exposed or declassified sealed revision | explicit declassification | explicit declassification | explicit declassification | reject |

The three nonsealed roles may overlap. That overlap is visible by design and
never supports a sealed accuracy claim.

Role compatibility is not role-creation authority. The ordinary collection
freeze API can create only analysis/authoring and iterative-development
revisions. Regression/golden revisions are created only by the governed
promotion/retirement path; the database requires their source kind to be a
golden snapshot. Callers therefore cannot relabel an arbitrary working
collection as trusted regression evidence.

Nonsealed content never transitions into sealed content. Sealed content may
be opened for a nonsealed purpose only through an explicit declassification
that records an append-only, disqualifying exposure before access or child
creation. A sealed-to-sealed correction is permitted only as one direct,
nonbranching successor while the parent remains protected and has no
disqualifying exposure. Roles and content never mutate in place.

Public sealed-revision creation remains unavailable in Batch 2. The first
valid sealed corpus requires the separately accepted collection and governed
blind-review plan from Batch 4. Batch 2 implements the fail-closed storage,
identity, transition, and access boundary without manufacturing historical
blindness.

Although the revision-level model reserves an explicit declassification
transition, Batch 2 intentionally rejects every exact sealed/nonsealed item
crossing. A later governed-declassification batch must enable both layers
together; no partial declassification path is implemented here.

Input identity uses `input-identity/v1`: SHA-256 over canonical JSON of the
normalized, pre-redaction top-level input only. Output, trajectory steps,
metadata, labels, notes, and evaluator results are excluded. Raw input is not
stored in the revision merely to support identity; revision payload snapshots
remain redacted. Legacy rows without raw input use a separately named
lower-provenance basis and can never seed sealed validation.

Input identity is exact only. Unicode-normalization variants, paraphrases,
and semantic near-duplicates may remain distinct. Semantic clustering remains
deferred.

Exposure events are append-only and written atomically with the activity they
describe. They name the revision, activity, actor/subject, evidence reference,
and server time. Development runs, exports, example selection, prompt or
rubric tuning, and explicit declassification are disqualifying for later
evaluator versions. A declared final-validation run is recorded against its
exact evaluator version; it is not retroactively disqualifying for that same
assessment.

Golden membership remains a curation registry. Promotion and retirement move
a project pointer to a new immutable regression/golden revision. A skill
version pins that revision before its regression job is enqueued, so a delayed
worker cannot observe a different corpus. Regression results remain
known-failure governance rather than calibration, representative accuracy, or
customer release policy.

For rolling deployment, a gate job queued before this schema existed may
encounter a legacy version with no binding. Its first post-migration delivery
pins the then-current immutable regression revision once and appends an audit
record; subsequent retries use that stored binding.

Revision items retain a complete redacted evaluated-payload snapshot and
reference-label provenance so trace retention or later collection changes
cannot rewrite historical evidence. A source case backing a revision cannot
change its normalized payload, and revision-bound eval items must bind the
matching frozen item and case. Receipt v1 is unchanged.

## Consequences

- Existing data is honestly marked exposed/lower-provenance and cannot be
  laundered into a sealed claim.
- Correcting an unexposed sealed corpus remains possible without allowing
  branching or role laundering.
- Regression gates become reproducible across queue delay and retries.
- Exact leakage detection is enforceable now while its semantic limitation is
  explicit.
- Governed sealed intake and blind review remain a separate, fail-closed
  product step rather than a role dropdown over visible cases.
