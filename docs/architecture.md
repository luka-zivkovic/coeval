# Architecture

Coeval is a TypeScript monorepo with a React web application, a Hono API, Postgres persistence, and pg-boss workers. It can also run against deterministic in-memory fixtures for local exploration.

## Documentation authority

This document describes current implementation architecture. `PRODUCT.md`
defines intended product scope, and accepted ADRs under `docs/decisions/`
define binding architectural decisions. When this document conflicts with
those sources, the charter and accepted ADRs win; the conflict is a
documentation or implementation gap rather than a change in product intent.

## Components

| Component | Responsibility |
| --- | --- |
| `apps/web` | Criterion selection, review, calibration, evaluator editing, datasets, integrations, and settings UI |
| `apps/api` | HTTP API, authentication boundaries, project authorization, repositories, and workers |
| `apps/audit` | Provider-independent structured judging and verdict validation |
| `packages/shared` | Zod domain models and transport contracts shared by API and web |
| `packages/db` | Current PostgreSQL baseline and demo fixture data |
| `packages/queue` | Queue names and pg-boss construction |

## Runtime modes

### Postgres mode

Setting `DATABASE_URL` enables persistent storage, Better Auth, project membership checks, migrations on startup, and background workers. This is the production-shaped runtime.

### Demo mode

Without `DATABASE_URL`, the API uses `DemoRepository`. It contains representative fixtures and deterministic mock judging so the product can be explored without external services. Demo data is not persistent and authentication is disabled.

## Core flows

### Trace ingestion

1. A trace arrives through the manual endpoint, the judge API, LangSmith, Langfuse, or Ironside with an exact evaluator-version pin. Singleton projects may resolve that pin when the request is accepted; multi-criterion projects require it explicitly.
2. The raw provider payload is retained for auditability.
3. A normalized case is created with configured exclusions and sensitive-key redaction.
4. A `judge.run` job is queued.
5. The worker loads the exact skill version and its pinned provider binding.
6. The structured verdict, provider metadata, latency, and token usage are appended.

Scheduled integration configuration retains its evaluator pin. Pollers copy it
into the import job, and workers validate the pin's project ownership rather
than selecting a current evaluator when the job eventually runs. This keeps a
queue delay or later criterion edit from changing what the import measures.

### Criteria and evaluator suites

A stable criterion owns one evaluator lineage. Criterion definition revisions
and evaluator versions are append-only; each evaluator version binds one exact
definition revision. Evidence queries, golden registries, regression snapshots,
review queues, agreement metrics, and trust artifacts carry that binding.
Legacy singleton selectors are compatibility surfaces only and return an
explicit ambiguity error once a project has several criteria.

An evaluator suite is a stable project-owned identity with append-only
manifest revisions. The canonical manifest bytes are the artifact of record;
relational member rows support ownership and execution checks. A manifest pins
ordered criterion definitions, exact evaluator versions, applicability, and an
optional independent-repetition plan. It cannot represent customer release
policy. Assessment receipt v1 remains a separate artifact per criterion.

### Human review

Coeval has two non-interchangeable review paths.

The governed path uses a dedicated session-authenticated repository and API.
Immutable instruction versions bind one criterion version. Server-selected
batches bind an exact population, selection plan, fixed stop, assignments,
capability checks, and state-machine version. Opaque reviewer tasks persist the
exact first-view canonical bytes; the allowlisted payload contains only
`input`, `output`, and optional `steps[{name?,input,output}]`. Task and batch
events, labels, alignment, and non-branching adjudications are append-only.
There is no majority vote. Missing coverage, `cannot_determine`, and
unresolvable adjudication remain incomplete.

Sealed intake uses a protected population and governed review items without
creating ordinary cases. It is unreachable through trace feeds, legacy queues,
project API keys, ordinary dataset reads, and verdict exports. Sealed reviewer,
alignment, and adjudication views never include evaluator output. Batch 4 can
freeze the resulting complete pass/fail truth revision. The current Batch 5B
runtime can execute one binary-evaluator trial over that exact case-less
revision and persist a separate aggregate-only calibration artifact. It does
not add evaluator evidence to any reviewer, alignment, or adjudication view.

The pre-existing verdict/review-queue path remains unblinded operational
triage. Human verdicts are appended rather than editing the judge verdict, and
historical adjudication does not delete disagreement. These APIs emit evidence
class `ungoverned_legacy`; they never become governed evidence. Agreement
diagnostics over this ledger keep undefined kappa explicit when expected
agreement is one.

### Sealed binary calibration

In Postgres mode, an owner launches an explicit single-trial run bound to one
binary evaluator, criterion version, complete governed sealed-validation
revision, selection provenance, execution model binding, provider policy, and
authorization/completion exposure snapshots. The repository acquires a
durable revision lease before execution. The worker receives one protected
payload without truth, records provider-call start durably immediately before
physical dispatch, and makes exactly one call with the requested parameters.
Hidden SDK retries and parameter-changing fallbacks are disabled; unsupported
non-null `topP` is rejected before dispatch.

Binary provider output is pass, fail, or ambiguous. Pass and fail are the two
classification outcomes; ambiguous is an explicit evaluator abstention. The
ordinary path routes it to needs-review/exception surfaces, while sealed
calibration records it as `abstained`, outside the confusion matrix.

An attempt terminalizes once. If a claim expires after durable call start but
before a terminal result, recovery records permanent `outcome_unknown`; it
does not recall the provider. Network work stays outside database
transactions. After all attempts terminalize, one repository transaction
rechecks exposure, derives aggregate statistics from the private salted
ledger, writes exact canonical public artifact bytes, and releases the lease.

The public artifact contains aggregate counts, metrics, confidence intervals,
and requested/observed provider provenance. It contains no item identity,
protected payload, per-item truth or prediction, rationale, provider body, or
request/response identifier. The private ledger has no application, HTTP,
project-key, browser, analytics, CDC, debug, or operator-export read surface.
Current admissibility is served separately from immutable historical artifact
bytes, so later development exposure can revoke admissibility without
rewriting the artifact.

The frozen contract and conformance corpus cover repeated-trial artifacts, but
the current producer runtime accepts only
`{ kind: "single", trialsPerItem: 1 }`. Dailies has an independent local
contract verifier and consumes explicitly configured artifacts through its
config v6, policy v2, report v6, runner, and CLI. It does not perform a network
or latest-status lookup.

### Governed Analyze populations and coding studies

Postgres mode assigns every ingested case an immutable analysis purpose before
it can enter a frame. An owner freezes one finite `[start,end)` database-time
population in a repeatable-read transaction. The revision stores exact frozen
payloads and pre-redaction input identities; resolved ineligible cases remain
separate exclusions. A structural identity registry prevents those nonsealed
inputs from racing into protected or final sealed evidence. The server then
uses one 32-byte seed and `sha256-rank/v1` to select a fixed-budget simple
random draw without replacement. One frame has one draw; a different budget
for the same frame conflicts instead of redrawing.

One immutable study may bind that draw. Opening freezes either an owner-close
rule or a server deadline. Study, item, taxonomy, view, closure, and assignment
events are append-only and compare-and-swap ordered. Owners and members may
code items and assign active observations; only owners administer study state
and taxonomy revisions. Payload reads are explicit, session-only, and record
both the existing governed revision exposure and a study-item view. Metadata
reads do not expose payloads.

At a deadline, state-changing requests first materialize the closure and then
fail; content remains readable and creates a post-close view excluded from the
stopped denominator. Closure atomically snapshots every selected item, active
observation and assignment head, and pre-close view. It recomputes the frozen
frame, verifies the persisted draw bundle and rank evidence, and persists the
one historical representative claim with a
closed negative reason when any gate fails. Taxonomy coverage is orthogonal to
that claim.

An owner can promote one current active failure code from the exact closure
into a reserved revision-1 criterion. The transaction binds the current
taxonomy head, every supporting observation and assignment head, and a complete
development-exposure fanout; it creates no evaluator or truth. The promotion
ID is an explicit nonsealed handoff accepted only by an analysis-authoring
governed batch for that exact criterion and analysis revision. That handoff and
analysis revision cannot enter generic dataset, iterative, or sealed source
branches; a separately created immutable iterative-development revision may
still use the promoted criterion through the existing nonsealed path.
Candidate creation is now an owner-session Analyze command over the exact
promoted criterion, frozen nonsealed governed batch, immutable truth revision,
and at least one resolved pass/fail item. The same transaction creates the
sole stable skill lineage when necessary, one immutable version, a copied
known-failure regression revision, a durable developer exposure, and the
append-only `candidate` seed event. No legacy writer may mint a version on this
lineage without the complete bundle.

Lifecycle state overrides `skill_versions.status` for every
`analysis_promotion` lineage. Candidates and needs-review versions are allowed
only by exact reference in ordinary nonproduction dataset/governed evaluation
or the internal binary-calibration and retained-regression evidence contexts.
Implicit judging, imports, schedules, trace tests, release gates, and suite
publication require `active` plus the exact activation artifact to remain
currently admissible. Activation is owner-only and requires a complete
nonempty `passed` regression run over every retained item and exact complete
sealed calibration evidence. Revocation serializes with activation, appends
`needs_review`, and makes selectors fail closed before the next provider call.

Analyze measurements are a read-only, versioned projection over those exact
artifacts. The report always binds one study, population, draw, and frozen
revision; an optional taxonomy revision and evaluator version add exact
coverage/churn, governed disagreement, calibration, and duration components.
The primary disagreement buckets form a disjoint partition, while adjudication
is a separately named cross-cutting count. Calibration error directions and
Wilson coverage intervals are copied only from the named aggregate artifact;
the private ledger is not read. The historical first-completed duration is
immutable, while the first-currently-admissible duration is re-derived at read
time and may become missing after revocation. No component is combined into a
score or decision.

### Known-failure regression governance

Promoting or retiring a reviewed reference case advances an immutable
regression/golden revision. Creating a skill version pins the current revision
before queue dispatch; the queue payload carries that revision and the worker
cross-checks it against the version before re-judging the exact snapshot with
the version's pinned provider. Regression-run rows always retain that pin.
Drafts and starter versions approved by direct human sign-off are the only
version states that may have no regression binding. Later registry edits
cannot alter a run. A regressing
version remains in history and cannot replace the approved version unless an
owner records an explicit override reason. This is evaluator governance, not
customer release policy or representative accuracy.

The public collection-freeze path creates only analysis/authoring or iterative
development revisions. Regression/golden revisions require a golden snapshot,
and sealed validation is produced only through the current governed case-less
intake and blind-review path. Repeated run comparisons over byte-identical
collection evidence reuse one immutable revision so both evaluator runs remain
directly comparable without producing duplicate lineage rows.

### Dataset evaluation and CI

Datasets are named mutable working collections of cases with optional expected
labels. Freezing creates an append-only, content-identified revision with a
redacted payload snapshot and input-only exact identity per item. Ordinary eval
runs may bind either a working collection snapshot or an existing nonsealed
revision; bindings and exposure events are persisted with the run. Public
ordinary-collection sealed-validation creation remains unavailable. Sealed
revisions are produced only by the governed case-less intake and review flow,
never by upgrading visible historical data. See accepted [ADR-0002](decisions/0002-human-truth-and-dataset-revisions.md)
and [ADR-0007](decisions/0007-dataset-role-compatibility-and-exposure.md).

### Trace-derived tests

A trace-derived Test stores a complete redacted source snapshot plus the smaller
response/turn scope selected in the journey. Content edits append revisions;
validation attempts append evidence with a distinct operational-failure state.
Enabling appends a reviewed revision that points to a successful validation.
A later draft does not rewrite or disable the last enabled revision.

## Data and trust invariants

- Skill versions are immutable.
- Criterion versions and evaluator-suite manifests are immutable.
- One evaluator version measures exactly one criterion definition revision.
- Multi-criterion reads and writes require an explicit criterion/evaluator
  selection; unscoped evidence is never treated as a wildcard.
- Verdicts are append-only.
- On the legacy path, human labels outrank judge labels when a canonical
  triage label is required. Governed truth follows ADR-0008 resolution and
  adjudication rules instead.
- Golden cases are promoted explicitly by a person.
- Every judge result is attributable to a skill version and model binding.
- Infrastructure failures are never projected as judge failures or passing gate results.
- Missing evidence is represented as missing; trust metrics are not collapsed into a composite score.
- API keys and integration credentials are scoped to a project and never returned after creation.
- Trace-derived test revisions and validation attempts are append-only.
- Generated draft provenance never implies review or enablement; an enabled
  revision requires successful good/bad evidence and a recorded human reviewer.
- Governed and legacy human evidence never satisfy one another's contracts.
- Exact blind-view projection prevents named forbidden fields from crossing
  the API boundary; it does not establish semantic anonymity of arbitrary
  content.
- A representativeness claim is scoped to one exact finite frozen population
  and a complete qualifying random draw. Manual, systematic, convenience,
  uncertainty, and failure-hunting samples are nonrepresentative.
- Calibration artifact status/completeness is evidence state, never a customer
  threshold outcome or release verdict.
- Public calibration artifacts are aggregate-only and immutable. Their current
  admissibility status is separate and may change after later development
  exposure without changing historical bytes.
- A durable provider-call start is never retried after uncertain completion;
  recovery accounts it as `outcome_unknown`.
- Semantic clustering is deferred and supplies no Batch 4 sampling or truth
  claim.

## Authorization boundaries

Session-authenticated `/api/*` routes resolve a project membership before accessing project data. Owner-only operations include invitations, credential management, retention changes, destructive project actions, gate overrides, and binary-calibration launch. `/api/v1/*` judge routes use project-scoped API keys instead of browser sessions. Binary-calibration artifact and current-status reads are an explicit exception to that path convention: they require a project-owner browser session and reject project API keys and member sessions.

## Database migrations

Coeval is pre-launch. `packages/db/migrations/0001_baseline.sql` is the only
supported database starting point and PostgreSQL 17 is the development and CI
target. The API applies that baseline on startup. If `coeval_migrations`
contains any upgrade-era identifier, startup fails with instructions to drop
and recreate the database; there is no supported `0001`–`0055` upgrade path.

Schema changes update the baseline and its invariant tests directly. Runtime
writers must supply current required identities—criterion bindings, regression
pins, ingestion purpose, validation method, and immutable content identity—at
creation time. They must not add backfills, nullable compatibility branches,
late pinning, or plaintext credential fallbacks for hypothetical deployed
data. This policy is governed by
[ADR-0011](decisions/0011-prelaunch-blank-slate-database-policy.md).

`pnpm test:pg` creates one migrated template database in a disposable
PostgreSQL 17 container, clones a fresh database for each test, and deletes all
clones and the container after the run. CI provides an existing server via
`PG_SMOKE_DATABASE_URL`; without a prepared template, each database test uses
an isolated schema migrated from the same baseline.
