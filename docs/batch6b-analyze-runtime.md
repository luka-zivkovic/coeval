# Batch 6B Analyze runtime plan

Status: **6B-1 through 6B-5 implemented**

This plan is subordinate to ADR-0002, ADR-0007, ADR-0008, ADR-0009, and
ADR-0010. It adds the governed non-clustering Analyze path without changing
receipt v1, suite v1, governed-review evidence, sealed calibration artifacts,
or Dailies release ownership.

## Delivery sequence

### 6B-1a — ingestion provenance

Population work starts only after every runtime case writer supplies an exact
analysis purpose. The clean database baseline defines a closed, non-null
`cases.ingestion_purpose` vocabulary:

- `analysis_eligible_manual`;
- `analysis_eligible_langsmith`;
- `analysis_eligible_langfuse`;
- `analysis_eligible_ironside`;
- `judge_api`;
- `judge_batch_general`;
- `dataset_example`;
- `trace_test_synthetic`;
- `release_evidence`.

The UI manual-trace import is the only new manual writer classified as
`analysis_eligible_manual`. `/api/v1/judge`, general judge batches, pasted
dataset examples, and trace-test materialization are explicitly ineligible.
The LangSmith, Langfuse, and Ironside workers use their matching eligible
purpose. Release evidence remains explicit.

The database rejects values outside this vocabulary and rejects every later
update of `ingestion_purpose`. The purpose is immutable for the lifetime of a
case. The DemoRepository carries the same required purpose field for type
completeness even though demo mode cannot freeze a population.

The writer audit and clean-install PostgreSQL tests prove that every insertion
path supplies a purpose.

The existing case identity remains
`(projectId, caseSource, trimmedSourceTraceId)`; purpose is immutable evidence
about the first origin, not part of the dedupe key. A later request with a
different purpose returns the deterministic earliest existing case without
changing its purpose or minting a duplicate. PostgreSQL writers serialize this
identity with a transaction-scoped advisory lock before lookup. Bulk dataset imports
pre-acquire their unique identity locks in canonical code-unit order so
opposite item order cannot deadlock.

### 6B-1b — frozen population and one server draw

The first user-visible slice freezes an immutable population, creates the exact
`analysis_authoring` dataset revision, performs one server-generated draw, and
offers a read-only Analyze list/detail view. Studies and coding do not exist in
this slice.

The POST body contains only:

```json
{
  "windowStart": "RFC3339 timestamp",
  "windowEnd": "RFC3339 timestamp",
  "fixedBudget": 100,
  "idempotencyKey": "caller retry identity"
}
```

The server fixes the eligible-source set, ordering, canonicalization,
algorithm, seed, rows, and digests. Unknown fields are rejected. The window is
start-inclusive and end-exclusive over the `timestamptz` `cases.created_at` in
UTC; `windowEnd` must be at least 60 seconds behind the database clock. There
is no separate maximum window span. The frame must be nonempty, contain at
most 100,000 members, and
satisfy `1 <= fixedBudget <= min(N, 10,000)`. Bound errors include exact
`limit` and `observed` values; no query may cap or truncate a frame and still
freeze it.

Missing pre-redaction input identity aborts with
`analysis_population_identity_unresolved`. Sealed overlap
aborts with `analysis_population_sealed_overlap`; any other dataset-revision
constraint failure is `analysis_population_revision_conflict`.
Oversized frames abort with `analysis_population_frame_too_large`. Every error
rolls back the population, revision, and draw.

After request-shape and window-lag validation, multi-fault failures use this
closed precedence independent of query or trigger order:
`analysis_population_identity_unresolved`,
`analysis_population_sealed_overlap`,
`analysis_population_frame_too_large`, empty/budget bounds, then
`analysis_population_revision_conflict`.

The scan covers every in-window case before eligibility is applied. Every
resolved but ineligible row is retained as an exclusion, including judge API,
general batch, dataset-example, trace-test, and release-evidence rows. The
100,000 limit applies only to eligible frame
members; exclusions are never truncated or silently capped, and read surfaces
page them separately from population metadata.

Population membership uses deterministic `(cases.created_at, cases.id)`
ordering. Two cases remain distinct even if they share an upstream trace or
identical content. Each member binds the exact revision item and has the stable
frame-member digest:

```text
analysis-population-frame-member/v1 {
  caseId,
  inputDigest,
  itemDigest,
  ingestionTime,
  position
}
```

The item reference fields are pinned to `referenceLabel = null`,
`referenceFailStep = null`, `note = null`, and
`referenceProvenance = {kind: "unlabeled", sourceId: caseId, verdictIds: [],
actorUserIds: [], basis: "Analysis population member; no reference label."}`.
This makes `itemDigest` stable for the same case evidence rather than dependent
on a mutable dataset-item identity.

The persisted `analysis-population-member/v1` lineage digest adds the new
`revisionItemId`, but neither that lineage digest nor the revision-item ID is an
input to `frameDigest` or sampling rank.

The draw uses one 32-byte server seed and `sha256-rank/v1` without replacement.
The exact rank is
`sha256({basis:"coeval-analysis-rank/v1", seed, caseId,
frameMemberDigest})`, with `(frameMemberDigest, caseId)` as the deterministic
tie-break. Duplicate payloads are therefore legal sampling units. The
persisted algorithm envelope is `coeval-analysis-draw/v1`. Inclusion
probability is stored as the exact integer fraction `K/N`; floating-point
display is derived only at read time.

Exactly one draw exists per population. `frameDigest` binds the window,
eligible-source contract, canonicalization version, and ordered frame-member
digests.
`unique(project_id, frame_digest)` makes an identical frame return the existing
population and draw rather than minting a new seed when the requested fixed
budget is also identical. Because the budget is deliberately not part of the
frame identity and one frame may have only one draw, the same frame with a
different requested budget returns the named
`analysis_population_draw_conflict` response; it never silently returns a
different budget and never redraws. Reads list prior
populations with overlapping members and their overlap counts and draw digests,
so changing a window to redraw remains visible.

The draw row also has an explicit `unique(population_id)` constraint.
POST lookup checks idempotency-key replay and exact request-digest equality
first, then checks the frame digest. A new key that resolves to an existing
identical frame and budget returns that population and draw rather than
conflicting or minting new evidence. Every accepted key is retained in an
append-only request-alias row bound to the exact request digest and population,
including keys that reuse an existing frame, so a later frame change cannot
alter an idempotent replay. Ranking is performed in bounded repository batches,
not with one database round trip per member. Full payload snapshots are never
retained for the entire frame in Node memory: a first bounded pass derives
member/item digests and drops payload bytes, then a second bounded pass inside
the same repeatable-read snapshot recomputes each item digest and inserts
payload rows page by page.

The clean baseline installs the structural identity-boundary registry used by
case identities, nonsealed revision items, protected sealed intake items, and
sealed revision items. Its unique `(projectId,inputDigest)` claim records
`nonsealed` or `sealed` use atomically. This closes the snapshot race that a
trigger-local advisory lock cannot close when a protected intake and a
repeatable-read analysis freeze overlap. Same-class reuse and the one permitted
direct sealed successor remain legal; crossing classes fails regardless of
which transaction wins.

The population transaction runs at `repeatable read` and records
`snapshot_xid8 = pg_current_snapshot()::text` and
`snapshot_taken_at = transaction_timestamp()`. Later representativeness
derivation in 6B-2 recomputes membership; if a late-committing row changes the
frame, the closed reason is `frame_not_reproducible` rather than a claim. No
caller-supplied clock, seed, row, order, digest, representative identifier, or
exclusion is accepted.

All population evidence is append-only except project erasure. The immutable
dataset revision uses `sourceKind = analysis_population`,
`role = analysis_authoring`, `provenanceLevel = unverified`, no mutable source
dataset, `seriesId = analysis-population:<populationId>`, revision number 1,
and no successor revision. `guard_dataset_revision_owner` requires that exact
role, a null `source_dataset_id`, and a null `parent_revision_id`; a separate
guard rejects any later revision whose parent is an analysis-population
revision. The public dataset-revision route and
`decidePublicDatasetRevisionCreation` remain unable to request this source
kind. Population, members, revision, revision items, exclusions, draw, and
selected rows commit atomically.

`drawnFromPopulationId` is present. `representativeOfPopulationId` is always
null in 6B-1b with the exact reason `coding_not_complete`. No prevalence,
coverage, or completed-representative language is exposed.

Content reads are session-only and return the exact frozen redacted snapshot,
never a refetched live case. The first read per `(revision, governed subject)`
atomically records one idempotent `human_access/content_view/development`
dataset exposure event. The subject is an ensured
`governed_reviewer_subjects.id` with `subject_kind = person` and the
`actor_user_id` retained. The key is
`analysis-content-view:<revisionId>:<subjectId>` and concurrent inserts use the
project/key uniqueness to return the existing event. The evidence reference is
`analysis_population` plus the population ID. Only routes that return item
payload or steps record exposure; population metadata, counts, windows,
digests, and overlap lists do not. The list/detail routes are unavailable to
project API keys and demo mode.

### 6B-2 — study, coding, taxonomy, and coverage

The following rules are the **6B-2 Study Coding & Taxonomy Authority v1**:

1. **Member coding authority.** Governed owners and members may append item
   observation, withdrawal, no-failure, reopen, completion, and assignment
   events while coding is open; the role at the event is retained. Only owners
   administer study state or create and revise the taxonomy.
2. **Deadline linearization.** A deadline closure has
   `effectiveClosedAt=closeAt`; `recordedAt` is the later database
   materialization time. At or after the deadline, state-changing paths
   materialize closure and then reject, except for exact replay of a command
   already committed before closure. Content paths materialize closure first,
   then may return content and record a post-close view excluded from the
   closure snapshot.
3. **Assignment as-of semantics.** Every assignment successor targets the
   current taxonomy head and never moves to an earlier revision sequence.
   Coverage at revision R selects the greatest assignment event version whose
   cited sequence is at most R and projects that stable code through R.
4. **One draw, one study.** The project/draw binding is unique forever,
   including abandoned and completed studies. Matching retries replay the
   identity; a different request conflicts.
5. **Closure-claim finality.** Representativeness is derived and persisted only
   by atomic closure. Study completion merely acknowledges that digest. There
   is no study reopen after closure; future restart or superseding-closure
   semantics require a new accepted contract.

This slice introduces the complete study state machine rather than storing a
premature draft in 6B-1. It binds one existing population draw, freezes either
`server_deadline` or `explicit_owner_close`, and adds append-only study and item
event streams with expected-version CAS and idempotency.

The first runtime permits exactly one study identity for one draw, including
an abandoned study. Draft creation binds the immutable population, draw, and
analysis-authoring revision, but it does not choose a stopping rule. The
`draft -> coding_open` event freezes that rule. A competing create or open
request conflicts instead of creating another coding attempt over the same
sample.

Deadline closure uses database time. At or after `closeAt`, every state-changing
path first materializes the single system closure and rejects the attempted
mutation; read paths and a bounded server sweeper also materialize overdue
closures. Closure records `effectiveClosedAt=closeAt` separately from its later
database `recordedAt`. An owner close records its durable governed subject and
reason. An explicit-owner study never closes automatically.

An active `no_failure_observed` event is mutually exclusive with active failure
observations. Switching requires explicit withdrawal or reopen history.
Closure snapshots every selected item and never coerces incomplete work.
`representativeOfPopulationId` is derived only when frame, draw, method, and
coding completion are all valid, using ADR-0010's closed reason precedence.

The closure transaction recomputes the frame and verifies the exact persisted
draw bundle and its ordered rank evidence once. It stores that historical
assessment, its derivation digests, and every ordered selected item
snapshot. Each item snapshot binds the exact item-event version/state,
completion or reopen head, active failure-observation IDs, and active
no-failure ID. Later retention or source deletion cannot rewrite the stored
claim. `coding_closed -> completed` only acknowledges the exact closure digest.

Coding content is served through a study-item path. Its first read atomically
retains both the existing analysis-revision content exposure and a distinct,
idempotent study-item view event for the exact governed subject. Metadata and
pagination do not create either event. Content remains readable after closure,
but the closure snapshot records only views linearized before closure; later
reads cannot improve the stopped workflow denominator.

Successful command replay is resolved before current-state or deadline checks.
An item event committed before closure therefore replays after closure under
the same idempotency key and request digest, while a different body still
conflicts. A completed item must be reopened before failure or no-failure
evidence changes; assignment events may still change while its study remains
open because they do not change coding completion.

Taxonomy v1 is flat. Revisions form one nonbranching CAS chain. Code retirement
is irreversible in v1. New assignments may reference only a code active in the
exact named revision. Later retirement projects an existing assignment into
`assigned_to_retired_code`. Coverage must conserve
`categorized + assigned_to_retired_code + uncategorized` over the exact active
failure-observation denominator; `no_failure_observed` is separate.

There is one taxonomy identity per project in v1. Stable code IDs are generated
by the server; an initial revision is non-empty; every successor retains every
prior ID exactly once. Retirement is a status-only transition: its revision
retains the predecessor label and definition. Retired code content remains
frozen and cannot be reactivated.
Active display labels are unique by their exact trimmed, case-sensitive value,
avoiding locale-dependent case folding. Reordering remains allowed and is
digest-bound.

Project members may append, reassign, or withdraw assignment events while the
study is open; study administration and taxonomy revision remain owner-only.
Assignments target only the taxonomy's current head revision. Successors may
remain at that revision or move to a later revision but never backward.
Coverage at revision R selects the latest assignment event whose cited revision
ordinal is at most R, then projects the stable code through R. Once a taxonomy
successor exists, older revisions accept no new assignments, so their as-of
coverage cannot be rewritten.

### 6B-3 — promotion and governed development handoff

Owner-only promotion binds one active code, exact taxonomy revision, exact
supporting observation heads, criterion definition, rationale, actor, and
idempotency key. It atomically creates one stable criterion and initial
definition plus `criterion_authoring` and per-observation `example_selection`
exposure. It creates no evaluator, review batch, suite, or calibration run.

The promotion must name one closed or completed study and its exact immutable
closure. The taxonomy revision must still be the current head and the code
must still be active when the study and taxonomy locks linearize. Each of the
1–1,000 unique supports must be an active failure observation in that closure,
and its exact assignment head as of the named revision must assign it to the
named code. A promotion therefore cannot use an open study, an old taxonomy
head, a retired code, a withdrawn observation, an uncategorized observation,
or an observation later reassigned to another code.

The server reserves `analysis-failure-code:<codeId>` as the criterion stable
key. The owner supplies an exact criterion name, definition, rationale, and
support set. The first request creates revision 1 with
`sourceKind=analysis_promotion`; an exact retry of the same key and request
replays it, while a different request under that key conflicts. A new key for
an already-promoted code also conflicts rather than aliasing or creating a
second criterion. Generic criterion and evaluator writers cannot mint or
extend this lineage.

The promotion ID is also the immutable governed handoff ID. The only consumer
is the explicit `analysis_promotion_handoff` source on an
`analysis_authoring` governed batch for the exact promoted criterion version
and source revision. The ordinary dataset-revision route continues to reject
`analysis_population`; iterative and sealed roles cannot use the handoff.
A later, separately created immutable iterative-development revision may use
the promoted criterion through the existing nonsealed governed-review path.
Blind review materializes only the frozen input, output, steps, criterion, and
reviewer instructions. Analysis labels, failure-code assignments, rationales,
promotion support metadata, trace identities, and evaluator evidence do not
enter the reviewer view.

The promoter, observation authors, viewers, and content-exposed subjects remain
durable governed subjects. The existing governed nonsealed review path must
produce a frozen truth revision for the exact criterion before candidate
creation. Analysis evidence never becomes truth or sealed calibration input.
Capability checks are re-evaluated when consumed, so an eligible check recorded
before a later development exposure cannot be reused. Durable subject identity
continues to enforce that separation after an account link is erased. A
governed batch may bind an analysis-promotion criterion only after the complete
promotion and exposure fanout has committed in an earlier transaction.

### 6B-4 — candidate evaluator lifecycle

Implementation status: **complete in the clean baseline and the dedicated
session/API, repository, worker, and web lifecycle surfaces.**

Candidate creation requires the exact frozen governed nonsealed batch and at
least one resolved pass/fail reference item. Candidate lifecycle events are
append-only and nonbranching:

```text
candidate -> active | retired
active -> needs_review | retired
needs_review -> active | retired
```

Retired is terminal. At most one version per lineage is active. Lifecycle state
overrides mutable `skill_versions.status` for Batch-6 lineages; that status
never becomes lifecycle authority.

As a deliberate narrowing of ADR-0010's general exact-reference permission,
candidate execution is allowed only by exact version in explicit,
non-production dataset or governed nonsealed evaluation, plus the two internal
evidence contexts `binary_calibration_evidence` and
`candidate_regression_evidence`. Manual/provider trace imports, scheduled
integrations, implicit current selectors, trace tests, release gates, and suite
publication require `active` and currently admissible calibration evidence.
Authorization is persisted at command/run creation and checked again
immediately before upstream or evaluator calls.

Activation requires an exact complete currently admissible calibration
artifact and a terminal `passed` regression run whose case ledger covers every
item in the exact retained revision once. Missing, empty, partial, running,
blocked, overridden, error, unknown, revoked, exposed, or mismatched evidence
fails closed. Revocation serializes on the criterion, appends `needs_review`,
and selectors independently re-derive admissibility so a missed event cannot
re-admit a version. Retired is terminal; replacing an active version atomically
retires the exact prior head in the same activation bundle.

### 6B-5 — measurements and integrated UI

The final slice reports only the component measurements accepted by ADR-0010.
Governed-review primary disagreement is a disjoint partition; `adjudicated` is
a separate cross-cutting count, `cannot_determine` takes precedence over mixed
pass/fail, and `single_rater` remains explicit. Calibration durations are the
two accepted artifact durations, never `timeToTrustedEvaluator`.

The implemented `coeval/analysis-workflow-measurement/v1` report binds the
project, study, population, draw, frozen dataset revision, calculation version,
and a semantic report digest. Coding completion is always present. A named
taxonomy revision adds exact coverage and successor churn; an exact evaluator
version adds its promotion/lifecycle, frozen governed batch disagreement,
latest or explicitly named aggregate calibration artifact, and both durations.
The report includes a bounded evaluator roster for the study so the view works
before any criterion is selected. The public route never reads the private
calibration ledger and never mutates lifecycle or evidence.

`GET /api/analysis-measurements/:studyId` is database-backed, session-only,
project-scoped, member-readable, strict-query, and `no-store`. Optional
`taxonomyRevisionId`, `skillVersionId`, and `calibrationArtifactId` parameters
are reciprocally checked against the returned report; an artifact requires an
exact evaluator version. Demo returns 501, API keys and signed-out callers 401,
absent membership 403, and absent or cross-bound evidence fails closed.

## API and authorization boundary

Analyze uses a dedicated `/api/analyze` module mounted after session and
project resolution. It is database-backed and session-only: demo returns 501,
signed-out and API-key requests return 401, absent membership or a forbidden
owner action returns 403, absent/cross-project resource identity returns 404,
and state, CAS, idempotency, provenance, or frame conflicts return named 409s.
Bodies are bounded and strict; responses use `no-store`.

Population and study administration, taxonomy revision, promotion, and
lifecycle transitions are owner-only. Project members may read frozen Analyze
evidence and, in 6B-2, append coding events through repository-scoped
authorization.

Analyze is project-scoped and must render without a selected criterion. The
current Traces shuffle remains labeled exploratory and cannot submit rows or a
seed into Analyze. Legacy review queues and free-text governed failure codes
are not taxonomy identities. Existing capability-gap groupings are not called
clusters or taxonomy codes.

## Required verification

Every slice requires clean install and baseline idempotency, direct SQL
immutability tests, project erasure, canonical digest parity, Cartesian
identity swaps, idempotent replay/body conflict, actual overlapping PostgreSQL
CAS races, strict API auth/unknown-field tests, web route/component tests, full
typecheck/build, and independent review.

6B-1 additionally requires one assertion per case writer,
duplicate-payload sampling, exact window boundaries, future-window rejection,
same-frame concurrency, seed/rank golden vectors, K=1 and K=N, no truncation,
late-commit frame invalidation, exact exposure recording, and explicit
nonrepresentative UI copy.

Hard stops: do not start promotion until taxonomy as-of coverage is stable; do
not create a candidate until promotion/exposure atomicity and separation are
proven; do not expose activation until the selector/import/suite inventory is
mechanically covered; and do not display representative language until the
negative-claim matrix is green.
