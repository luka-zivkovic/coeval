# ADR-0010: Representative analysis and taxonomy lifecycle

Status: **Accepted**

Date: 2026-08-23

## Context

The product charter begins Coeval's lifecycle with representative traces, open
coding, and a human-readable failure taxonomy. The current Traces screen is an
exploratory client-selected preview over a capped result set. It does not
freeze a population, time window, eligibility rule, server-recorded seed,
draw, or digest, so it cannot support a representative claim. Coeval also has
no append-only open-coding or taxonomy-revision model and no governed
transition from a failure code to a criterion.

ADR-0002 defines analysis/authoring data and forbids it from becoming sealed
validation. ADR-0008 defines reproducible selection provenance and governed
human truth, but explicitly deferred taxonomy UX. The Batch 6 plan is
subordinate to accepted ADRs and did not by itself resolve the deferred
taxonomy semantics. This accepted decision now authorizes runtime, schema,
API, and UI implementation that satisfies the contract below.

## Decision

### Frozen analysis population and sampling

The first Analyze slice samples normalized imported trace cases. One eligible
normalized case is one sampling unit, even when several cases share an
upstream trace identifier. The population uses Coeval's server-recorded
ingestion time rather than optional provider event time.

An analysis population freezes:

- one project, an inclusive start and exclusive end ingestion-time window, and
  the allowlisted sources `manual`, `langsmith`, `langfuse`, and `ironside`;
- every eligible case identity, complete redacted evaluated-payload snapshot,
  pre-redaction `input-identity/v1`, deterministic order, exclusion reason,
  and source reference needed to reproduce membership;
- the population size, canonicalization version, ordered-membership digest,
  content digest, creation actor, and server time; and
- an immutable `analysis_authoring` dataset revision over the same retained
  item snapshots, so analysis access and later authoring exposure remain
  explicit.

Population creation is a new session-authenticated governed Analyze path. It
does not reuse or expand the ordinary public working-collection freeze route,
and it is unavailable to project API keys.

Release-evidence submissions, evaluator regression jobs, governed sealed
intake, calibration attempts, and synthetic gate scaffolding are ineligible.
If current ingestion provenance cannot distinguish an allowlisted source from
one of those exclusions, population creation fails closed rather than guessing.

The first representative method is server-executed `simple_random` with a
fixed budget. It reuses ADR-0008's versioned selection vocabulary and records
the frozen population, population and draw digests, a server-generated and
server-recorded seed, RNG and algorithm version, budget, fixed stopping rule,
selected item order, inclusion probability, and server execution provenance.
Caller-supplied rows, order, seed, or digests cannot earn the claim.

`drawnFromPopulationId` records the exact frozen frame for a reproducible
server draw independently of later coding progress. The stronger
`representativeOfPopulationId` means representative only of that exact finite
frozen frame and is derived only when the frame and draw are reproducible and
every selected item has completed coding. Otherwise it is omitted, the
selected and completed denominators remain visible, and exactly one closed
reason is recorded from `method_not_eligible`, `frame_not_reproducible`,
`draw_not_complete`, or `coding_not_complete`, using that order as deterministic
precedence when several conditions apply. Convenience, manual, systematic,
uncertainty, and failure-hunting queues remain useful discovery inputs but are
explicitly nonrepresentative in this first slice. No result from incomplete
coding may claim full-sample failure coverage or prevalence.

### Append-only open coding

An analysis study binds one exact population, sample, dataset revision, study
contract version, and actor. Opening freezes exactly one stopping rule:
`server_deadline`, with an immutable `closeAt`, or `explicit_owner_close`.
The rule cannot change after opening. Its state machine is:

| Current state | Allowed next state |
| --- | --- |
| `draft` | `coding_open` or `abandoned` |
| `coding_open` | `coding_closed` or `abandoned` |
| `coding_closed` | `completed` |

`abandoned` and `completed` are terminal. Under `server_deadline`, the server
closes the study at `closeAt`; under `explicit_owner_close`, an owner closes it
with a reason. Closing snapshots every selected item's state, denominator, and
stopping-rule evidence. Unfinished work remains `uncoded` or `in_progress` and
is never dropped or converted into completed work. After closure no coding,
withdrawal, assignment, or reopen event is accepted.

The `coding_closed -> completed` transition is an owner acknowledgment that
names the expected closure digest. It has no completeness meaning and cannot
add or alter coding or taxonomy evidence. Each sampled item derives `uncoded`,
`in_progress`, or `completed` state from an ordered append-only event stream. A
completed item can be reopened only while its study is `coding_open`;
reopening appends an event and never deletes prior work.

Open coding is multi-label: a study item may carry several append-only
observations. Each observation binds the item, actor, server time, verbatim
human-authored label, non-empty rationale, and an exact evidence anchor: either
`case_output` or one zero-based `step` index. Withdrawal appends a successor
event and retains the original observation. Completing an item requires at
least one active observation or an explicit `no_failure_observed` event with
rationale. The latter is evidence about the reviewed item, not proof that it
cannot fail.

Coverage is always computed against one exact taxonomy revision. For each
active failure observation, its authoritative assignment head as of that
revision belongs to exactly one disjoint bucket:

- `categorized`: the head points to a code active in that revision;
- `assigned_to_retired_code`: the head points to a code retired in that
  revision; or
- `uncategorized`: there is no active assignment head as of that revision.

The three counts must sum to the active-failure-observation denominator. Code
retirement preserves the assignment head and moves its observation to
`assigned_to_retired_code`; it never silently makes the observation
`uncategorized`. These buckets are distinct from an item explicitly completed
as `no_failure_observed`. Closing and completing a study never coerce any
bucket into a catch-all category.

### Flat, human-authored taxonomy revisions

A failure taxonomy is a stable, project-owned identity with one direct,
nonbranching compare-and-swap revision chain. Each immutable revision records
its expected predecessor, canonical content and digest, actor, reason, and
server time. A taxonomy revision contains a flat ordered list of human-authored
failure codes.

Each failure code has a stable identity. A successor revision may change its
display label or definition without changing that identity, or retire it while
retaining history. An observation assignment binds an exact observation, code,
and taxonomy revision. Each observation has one authoritative nonbranching
assignment head; reassignment or withdrawal appends a successor rather than
rewriting the earlier assignment. Coverage projects that head through the
named taxonomy revision as defined above. Concurrent taxonomy or assignment
successors from the same head conflict rather than branch.

Hierarchy, aliases, automatic grouping, merge and split semantics, and
machine-authored categories are deferred. Until merge and split lineage has a
separate accepted contract, users create or retire codes explicitly and prior
observation assignments retain their original meaning.

### Narrow failure-code promotion

Promotion is owner-only and binds one active stable failure code, exact
taxonomy revision, selected supporting observations, criterion definition,
actor, rationale, and idempotency key in an immutable promotion record. One
stable failure code may create at most one stable criterion. Retrying the same
request returns the same promotion; a competing promotion fails closed.

The promotion transaction also appends ADR-0007 development-exposure events
on the bound `analysis_authoring` revision. It introduces the new exposure
activity value `criterion_authoring` for the promoter and uses
`example_selection` for every selected supporting observation. Those events
name the promoter, new criterion and definition version, promotion record, and
selected observation identities. Exposure recording and promotion are atomic;
either all evidence is committed or none is.

The promoter and every author of a selected supporting observation become
evaluator-development subjects for the new criterion lineage. Under ADR-0008
they are excluded from custodian, reviewer, and adjudicator roles for a sealed
population or batch used to calibrate that lineage. A single-operator project
may complete analysis, promote a criterion, conduct nonsealed authoring work,
and create a candidate, but it cannot activate that candidate without the
independent people required to produce admissible sealed calibration evidence.

Promotion creates the stable criterion and its initial immutable definition
revision only. It does not create, select, approve, or execute an evaluator.
The next step is a governed, nonsealed review batch using that exact criterion
definition and an immutable analysis/authoring or iterative-development
revision. Analysis observations help author the criterion but never become
human truth merely because they were coded or assigned to a taxonomy.

Candidate creation requires a governed nonsealed batch bound to that exact
criterion definition to be `frozen`, with its resulting immutable truth
revision containing at least one resolved `pass` or `fail` reference item. The
new evaluator uses the existing immutable `skill_versions` row and exact
criterion-version binding, plus a separate append-only evaluator-lifecycle
record initialized as `candidate` in the same transaction.

A candidate is never returned by an implicit current-evaluator selector,
pinned by a new trace import, published in a suite, or described as approved.
Its execution requires an explicit exact evaluator-version reference. For any
evaluator with a lifecycle record, every implicit selector and import pin must
require lifecycle state `active` regardless of the legacy `skill_versions`
status; a legacy status can never override the lifecycle guard. Existing
lineages without a lifecycle record retain their compatibility behavior, but
the existing legacy draft-selection behavior cannot be reused for a Batch
6-created lineage.

For a Batch 6-created lineage, evaluator governance is the nonbranching state
machine `candidate -> active | retired`, `active -> needs_review | retired`,
and `needs_review -> active | retired`. Transitions are append-only,
compare-and-swap events over the expected current state. At most one evaluator
version in a criterion lineage may be `active`. Activation locks the lineage
and either names and atomically retires the expected prior active version or
fails on conflict.

Activation is an explicit owner action after a complete, currently admissible
calibration artifact exists and the retained known-failure regression gate is
not blocked; it records that exact artifact and an owner rationale. No metric
threshold causes the transition. A later calibration revocation appends
`needs_review` and makes implicit current selection fail closed. It neither
rewrites the activation record nor silently substitutes another evaluator;
reactivation requires a new owner action citing currently admissible evidence.

The initial runtime deliberately closes “not blocked” to one portable terminal
meaning: the regression result must be `passed`, nonempty, and account for
every item in the candidate's exact retained revision once. Missing, running,
partial, blocked, overridden, or error results cannot activate. Exact candidate
execution is likewise a closed context set: ordinary nonproduction dataset or
governed nonsealed evaluation, binary-calibration evidence, and candidate
regression evidence. Trace-test, release-gate, import, scheduled, suite, and
implicit production contexts require an active evaluator whose cited
calibration remains currently admissible.

Sealed binary calibration uses a separately collected, protected revision and
the accepted ADR-0009 runtime. Analysis populations, coding samples,
supporting observations, nonsealed governed review, and iterative-development
data cannot seed that sealed revision. Calibration completion or a metric
threshold never promotes an evaluator automatically. Any later activation is
a separate explicit owner action under evaluator-governance rules and retains
the calibration identity and current-admissibility status that informed it.

### Honest workflow measurements

Analyze workflow measurements are versioned evidence bound to the applicable
study, taxonomy revision, criterion, evaluator, and calibration identities.
They define explicit start/end events, denominators, missing state, and a
calculation version. Coeval reports components rather than a composite score:

- coding completion: selected, viewed, in-progress, completed,
  `no_failure_observed`, and missing counts;
- taxonomy coverage for one named revision: active failure-observation heads
  in `categorized`, `assigned_to_retired_code`, and `uncategorized`, over the
  active-failure-observation denominator, plus selected and completed item
  counts containing each bucket over their separately named denominators;
- governed reviewer disagreement: unanimous, mixed pass/fail,
  `cannot_determine`, coverage gap, adjudicated, and unresolvable counts from
  governed review only;
- taxonomy churn per successor revision: code additions, label changes,
  definition changes, retirements, and observation reassignments, reported
  separately rather than collapsed into one stability score;
- evaluator error direction from an exact calibration artifact: false-pass,
  false-fail, abstained, error, unevaluated, support, coverage, and interval
  fields without a universal acceptable threshold; and
- elapsed time from study creation to the first completed calibration artifact,
  and separately to a calibration artifact that is currently admissible when
  read.

The last two durations are named
`timeToFirstCompletedCalibrationArtifact` and
`timeToFirstCurrentlyAdmissibleCalibrationArtifact`. The first is an immutable
historical duration. The second is a read-time derivation over artifacts whose
separate current-admissibility status is admissible at that read; it is absent
when none qualify and may disappear after revocation without rewriting any
artifact or prior response. Coeval does not report `time-to-trusted-evaluator`,
because “trusted” would hide a customer policy threshold. Missing,
still-running, censored, incomplete, and later-revoked states remain explicit
rather than becoming zero or success.

## Compatibility and non-goals

The current Traces preview remains exploratory and is never upgraded or
backfilled into representative evidence. Existing legacy verdict/review queues
remain `ungoverned_legacy`. Existing receipts, suite manifests, governed truth,
dataset revisions, and binary-calibration artifact bytes remain unchanged.

The `docs/implementation-batches.md` file is copied verbatim across the three
product repositories. On acceptance, its earlier
`time-to-trusted-evaluator` wording was replaced by the two explicit
calibration-artifact durations in this decision, and the accepted gate was
recorded identically in the Coeval, Dailies, and Casefile copies.

This decision does not add:

- semantic clustering, embeddings, automated category suggestions, taxonomy
  hierarchy, or merge/split inference;
- a competitor leaderboard or a claim of universal evaluator quality;
- a production-prevalence estimate beyond descriptive results for the exact
  finite sampled frame;
- release thresholds, release roles, a composite quality score, or a ship
  decision;
- promotion of analysis or development cases into sealed validation;
- implicit execution or approval of a candidate evaluator; or
- repeated-trial producer execution, scalar calibration, or categorical
  calibration.

## Consequences

- A representative claim becomes reproducible and narrowly scoped instead of
  being inferred from the current UI sample.
- Failure discovery, taxonomy changes, and promotion preserve who changed what
  without rewriting history.
- Criterion creation cannot silently make an unreviewed evaluator current.
- Analysis remains useful for authoring while staying disqualified from sealed
  calibration truth.
- Workflow reports expose missing work, disagreement, churn, and directional
  error without inventing a universal trust score.
- The first runtime slice requires additive persistence and session-only
  Analyze APIs; its exact schema and routes are implementation details that
  must satisfy this contract after acceptance.

## Accepted contract choices

The founder accepted all of the following contract choices on 2026-08-23.
Changing one requires a superseding accepted ADR:

1. One normalized imported case is the sampling unit; the finite frame uses
   Coeval ingestion time and the four allowlisted trace sources.
2. The first representative sampler is server-executed simple random sampling
   with a fixed budget, and its representative identifier additionally
   requires completed coding for every selected item; other methods remain
   explicitly nonrepresentative in the first slice.
3. Open coding is multi-label and append-only; study stopping and closure are
   frozen, and taxonomy-revision coverage keeps `categorized`,
   `assigned_to_retired_code`, `uncategorized`, and `no_failure_observed`
   semantically distinct.
4. Taxonomy v1 is flat and human-authored with stable code identity and a
   nonbranching revision chain; hierarchy and merge/split semantics remain
   deferred.
5. Failure-code promotion atomically records development exposure and creates
   a criterion only. A frozen governed nonsealed truth revision for the exact
   criterion precedes creation of a `skill_versions` row with a separate,
   non-current `candidate` lifecycle; calibration uses separately collected
   sealed truth and the named development subjects cannot perform its protected
   duties.
6. Coeval reports component metrics and the two calibration-artifact durations
   above; it does not define or report a universal “trusted evaluator” state.
