# ADR-0008: Governed human truth and sealed collection

Status: **Accepted**

Date: 2026-08-23

## Context

ADR-0002 requires independent human labels, instruction and reviewer
provenance, immutable disagreement, selection provenance, and adjudication
history. ADR-0007 deliberately left the first sealed-validation collection
and blind-review plan unresolved. The existing verdict and review-queue flows
show evaluator results and mutable case identities to reviewers, do not retain
the exact instructions or sampling frame, and cannot establish governed blind
truth. They remain useful unblinded triage, but they cannot be upgraded or
backfilled into stronger evidence.

The first implementation is binary. It must not force a reviewer to invent a
pass or fail when the evidence is insufficient. It must also keep semantic
clustering, calibration metrics, release policy, and receipt evolution out of
the review contract.

## Decision

### Evidence boundary

Coeval adds a distinct governed-review path. Legacy `verdicts`, review queues,
golden promotions, and historical adjudications remain explicitly
`ungoverned_legacy` or lower-provenance evidence. They are never inferred to
have been blind, independently assigned, representative, or governed.

Every governed artifact is append-only and project-owned. Project erasure is
the only operation that deletes governed content. User deletion may remove an
account link, but the evidence retains a stable pseudonymous reviewer subject
snapshot and role-at-review; it does not require mutable profile data.

Governed labels are binary with a first-class abstention:

- `pass`;
- `fail`; and
- `cannot_determine`, with a required rationale.

Every label preserves a non-empty reviewer rationale and zero or more
reviewer-authored open failure-code strings verbatim. `cannot_determine`
remains visible as incomplete coverage and never becomes a reference label.

### Immutable instructions, items, batches, and assignments

A review-instruction version binds one exact criterion version and freezes the
reviewer-facing instructions, allowed labels, and open failure-code guidance
under a content digest. Alignment never edits an instruction version; it
creates a successor version and, if more labels are needed, a successor batch.

A governed review operates on immutable governed-review items rather than
mutable cases:

- a nonsealed item must bind one exact immutable dataset-revision item; and
- a sealed-intake item stores a protected, redacted payload snapshot plus its
  pre-redaction `input-identity/v1` digest without creating an ordinary case.

Sealed intake items are unreachable from trace feeds, judge workers, legacy
queue APIs, exports, ordinary case and dataset reads, and project API keys.
They are addressed to reviewers only by an opaque task identity.

A review batch freezes:

- the exact criterion and instruction versions;
- role intent (`analysis_authoring`, `iterative_development`, or
  `sealed_validation`);
- the immutable source population and selection plan;
- the required number of independent labels;
- assignments and deterministic serve order;
- blindness and separation-of-duty capabilities; and
- a state-machine version and idempotent request identity.

Membership and selection provenance cannot change after the batch opens.
Each assignment belongs to one reviewer subject. Submission, task completion,
and the corresponding event append happen atomically. A generic human verdict
cannot satisfy a governed assignment.

### Blind review and event history

The reviewer API returns an allowlisted view constructed only from the frozen
review item, criterion definition, and reviewer instruction version. The
first view persists the exact canonical reviewer-visible bytes, their digest,
and the view-contract and canonicalization versions; every later view returns
that same immutable artifact. Before
the independent-submission barrier closes it never returns or embeds mutable
case or trace identifiers, evaluator labels or rationales, raw judge calls,
expected or golden labels, peer labels, or adjudication data. This boundary is
enforced server-side and responses are not cacheable. In sealed review,
reviewer, alignment, and adjudication views never reveal evaluator outputs at
any phase; only peer independent labels become visible after the barrier.

Task history is an ordered append-only event stream. The first contract
supports `viewed`, `deferred`, `resumed`, `label_submitted`, and
`label_withdrawn`. Withdrawal is allowed only by the same reviewer while the
batch remains open and before that label has been revealed to another actor.
The original label remains immutable and visible in history. A replacement
label links to the withdrawn attempt; no event rewrites an earlier label.

Task state is derived from its ordered event stream:

| Current state | Allowed event while the batch is `open` | Next state |
| --- | --- | --- |
| `assigned` | `viewed` | `viewed` |
| `viewed` | `label_submitted` | `submitted` |
| `viewed` | `deferred` | `deferred` |
| `deferred` | `resumed` | `viewed` |
| `submitted` | `label_withdrawn` | `withdrawn` |
| `withdrawn` | replacement `label_submitted` | `submitted` |
| `assigned`, `viewed`, or `withdrawn` | server `expired` at the fixed stop | `expired` |

`submitted`, `deferred`, and `expired` are terminal once labeling closes.
Before the fixed stop, a closure request succeeds only when every task is
submitted or deferred. At the fixed stop it atomically expires other tasks.
Every task action and closure locks the batch before the task, checks the
expected stream version, and appends its evidence in one transaction; in a
race, exactly one operation wins and the other receives a named conflict.

Batch state is likewise an ordered, optimistic-concurrency event stream:

| Current state | Allowed next state |
| --- | --- |
| `draft` | `open` or `abandoned` |
| `open` | `labeling_closed` or `abandoned` |
| `labeling_closed` | `resolved`, `alignment_open`, `adjudicating`, or `incomplete` |
| `alignment_open` | `adjudicating` or `incomplete` |
| `adjudicating` | `resolved` or `incomplete` |
| `resolved` | `frozen` |

`abandoned`, `incomplete`, and `frozen` are terminal. An adjudication whose
authoritative heads include `unresolvable`, or any remaining coverage gap,
terminates the batch as `incomplete` rather than manufacturing resolved truth.

`labeling_closed` is the irreversible independent-submission barrier. No
label, withdrawal, resume, or assignment change is accepted after it. The
system may move to `resolved` only when the resolution table is satisfied, or
to `incomplete` when gaps remain and no adjudication can supply truth.
Independent labels become visible only at this explicit barrier. Alignment
history is append-only and cannot reinterpret labels under new instructions.
An alignment event has a contiguous sequence, actor snapshot, exact active
label IDs visible to that actor, event kind (`comment_recorded`,
`instruction_change_proposed`, or `closed`), non-empty content, and server
time. It may be appended only in `alignment_open`; it cannot alter a task,
label, adjudication, or instruction. A proposed instruction change is realized
only as a new immutable instruction version and successor batch.

### Resolution and adjudication

Truth is derived without majority voting:

| Active independent evidence | Result |
| --- | --- |
| Every required task has an active label, at least two are required, and all are `pass` or all are `fail` | Resolved `unanimous` |
| The sole required task has one active pass/fail label | Resolved `single_rater`, explicitly flagged |
| Any required task is deferred, expired, withdrawn, pending, or otherwise lacks an active label | Unresolved coverage gap |
| Any `cannot_determine` or mixed pass/fail labels | Unresolved until adjudication |
| Adjudication `unresolvable` | No reference label; counted as unresolved |

An adjudication is append-only, names the complete exact active independent
label-ID set at the labeling barrier, requires a non-empty rationale and actor
snapshot, and may resolve only a real disagreement or `cannot_determine` to
`pass`, `fail`, or `unresolvable`. The adjudicator cannot be a rater for that
item. Corrections form one nonbranching compare-and-swap successor chain: the
caller names the expected current adjudication, the database permits at most
one successor, and the authoritative head is the only unsuperseded row rather
than the newest timestamp. A successor re-references the complete frozen label
set and records its reason and basis. After truth is frozen, a correction must
create an eligible direct dataset-revision successor; it never mutates the
existing revision.

Human-human agreement remains a diagnostic. Undefined agreement statistics,
including one-class kappa, stay undefined with a reason rather than becoming a
favorable score.

### Selection provenance and representative claims

The immutable selection record names a versioned method from
`simple_random`, `stratified_random`, `systematic`, `convenience`,
`uncertainty`, `failure_hunting`, or `manual`. It freezes the source-population
definition, time window, population size and digest, seed and RNG version,
fixed budget and stopping rule, draw digest, and any declared strata,
stratum definitions and frozen membership digests, frame counts, inclusion
probabilities or weights, and per-stratum budgets and draws.

Coeval executes the draw from the already frozen frame; caller-supplied method,
seed, or digest fields cannot earn a representative claim. Batch 4 supports
only a fixed stopping rule. A derived `representativeOfPopulationId` is
present only for a complete simple-random or declared-stratified draw whose
population-collection provenance, frame, and draw can be reproduced and whose
required review coverage is complete. It means representative of that exact
named finite population only, never of production or a wider population.
Partial coverage, deferral, `cannot_determine`, convenience, systematic,
uncertainty, failure hunting, or manual selection omits it and records an
explicit reason. Batch 4 emits no prevalence estimate.

### Sealed collection and separation of duties

Sealed collection is session-only and fails closed:

1. A custodian creates a protected intake population and immutable selection
   plan. Ordinary project APIs and workers cannot access its items.
2. Intake computes the exact pre-redaction input identity and rejects overlap
   with any nonsealed case or revision, unrelated sealed intake, or any
   unresolved legacy identity in the project. The only sealed overlap allowed
   is ADR-0007's one direct, nonbranching successor while its predecessor is
   still protected and has no disqualifying exposure.
3. A sealed batch is always evaluator-blind and requires at least two
   independent labels. Anyone who can access intake content as custodian,
   reviewer, or adjudicator must lack evaluator-development capability for the
   covered criterion lineage. The exclusion set includes recorded criterion,
   instruction, evaluator, rubric, prompt, example, and threshold-independent
   development authors and development-exposure subjects. Unknown historical
   developer identity fails closed in Batch 4; there is no self-attested
   bypass. The system re-checks this separation at batch open, truth freeze,
   and final-validation execution. If a content-exposed person later performs
   evaluator-development activity, that exposure disqualifies the batch for
   later evaluator versions. An adjudicator also cannot be a rater.
4. Governed reviewer views record provenance-class `governed_review` access;
   they are not development exposure. Any non-governed or ordinary content
   view remains development exposure under ADR-0007, and later developer use
   of knowledge acquired in review is disqualifying as described above.
5. Freezing materializes a `sealed_validation` revision only when every drawn
   item has a resolved pass/fail truth and the batch is `resolved`. It preserves
   batch, selection, coverage, reviewer-exposure, label, conflict, and
   adjudication provenance. Any deferred, expired, unresolved
   `cannot_determine`, or `unresolvable` item makes the batch `incomplete`; its full selected
   denominator and per-item gap reasons remain in batch evidence, but it cannot
   be partially frozen or presented as a sealed truth revision.

A project without enough independent people for these duties cannot create a
weaker sealed claim. It may use the same workflow with a nonsealed role.

### Imported truth

Imported truth uses a separate immutable record. It always preserves the named
issuer and subject, immutable source artifact and digest, transport and
verification method, instructions, raters, label, adjudication, and blind
attestation when supplied. Evidence with a verified signature or independently
verified transport may be `imported_verified_attested`; complete but
unverifiable claims are `imported_self_attested`; missing required provenance
is `unverified`. Field completeness alone never upgrades trust. Imports are
never relabeled `governed_blind`, because Coeval did not enforce their
collection boundary.

### Compatibility and non-goals

The existing receipt v1 contract remains byte-for-byte unchanged. Calibration
artifacts and metrics belong to Batch 5. Semantic clustering and taxonomy UX
remain deferred. This decision adds no release threshold, deployment decision,
majority-vote truth, scalar or categorical review, or prevalence correction.

## Consequences

- Resolved human truth can be reconstructed from immutable instructions,
  reviewer-visible snapshots, independent labels, ordered events, and exact
  adjudications without erasing disagreement.
- Sealed inputs cannot leak through ordinary trace and evaluator surfaces.
- Abstention and incomplete coverage remain visible rather than being coerced
  into pass or fail.
- Representative claims are machine-derived from reproducible collection and
  complete review, not queue descriptions.
- Small or single-operator teams can still run governed nonsealed review, but
  cannot manufacture a sealed-validation claim.
- Legacy and imported evidence retain honest, lower provenance instead of
  being upgraded by migration.
