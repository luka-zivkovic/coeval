# ADR-0013: Production outcome monitoring

Status: **Accepted**

Date: 2026-09-23

Decision owner: Luka Živković (founder), explicit approval on 2026-09-23.
The founder placed production monitoring in Rubrist's charter, now recorded
in `PRODUCT.md`, and settled retention, stored snapshots, notifications, and
outcome sources the same day. Runtime work follows its implementation batch
in `docs/implementation-batches.md`.

## Context

Production calibration reports whether a system's stated probabilities held
up against outcomes that arrived later on the customer's own traffic. It is
CURRENT as a compute-only diagnostic: `@rubrist/shared` holds the strict
`rubrist/production-decision-record/v1` input and
`rubrist/production-calibration/v1` report contracts with pure analysis, and
`POST /api/production-calibration/preview` computes a report from a pasted or
uploaded ledger and stores nothing. `docs/production-calibration.md` makes
persistence TARGET only if a decision record accepts it. This is that record.

The governed calibration path cannot serve this job. Sealed binary
calibration (ADR-0004, ADR-0009) measures hard labels of one exact evaluator
version against governed-blind human truth on a frozen revision and publishes
aggregate-only bytes. Production monitoring is continuous, unbounded,
probability-based, and its outcomes are posted after the decision was acted
on, so they may be shaped by that action.

CURRENT facts that constrain the design:

- API keys authenticate only `/api/v1/*`, are scoped to one project, carry no
  capability columns, and are described as read/judge-only. The only
  API-keyed routes that accept traces also judge them.
- Rate limiting is an in-memory token bucket per process, 60 requests a
  minute per key by default.
- Ironside traces are pulled from Ironside's evaluator feed as Langfuse-style
  observations, not received as OpenTelemetry spans. Observation metadata is
  string-to-string, traces over 50 observations are skipped entirely, and
  every import is pinned to a skill version and schedules judging.
- Existing append-only guards reject UPDATE and allow DELETE only when the
  owning project row is gone. Trace retention pruning is manual and
  owner-only; no scheduler runs it.
- The report builder runs in memory. The preview caps a request at 4 MiB and
  rejects the whole ledger when two decision records share an ID with
  different content.
- `binary_calibration_private_ledgers` already uses the word "ledger" for
  protected sealed evidence.
- `stateDigest` is an unsalted `sha256:` over the exact state text.

## Decision

### 1. Scope and separation

Production outcome monitoring is a Rubrist product surface for any system that
writes production decision records. The record format mirrors jevkit's ledger
so its lines validate unchanged, but Rubrist takes no dependency on TypeSafe,
Jev, or jevkit.

Monitoring is ungoverned development feedback. Its records and reports never
become human truth, dataset revisions, exposure events, calibration evidence,
sealed validation, suite members, or receipt content. The report's `evidence`
block stays fixed to `kind: "production_outcomes"`, `sealed: false`, and
`independentHumanValidation: false`. An outcome with `source: "human"` is
still not governed review.

Routing a low-confidence sample from production into governed review is a
separate, later decision. When it exists, reviewers see only the frozen
review item under ADR-0008, never the production probability, action, or
outcome.

Monitoring makes no operating decision. The threshold advisor recommends a
threshold or review band from past outcomes; it does not set one. Drift and
model-change flags are reasons to look, and Rubrist never switches a model,
changes a threshold, or rolls anything back because of them. Notifications on
drift or model change are not part of this decision; they are a recorded
follow-up.

### 2. Records are the source of truth

Decision, action, and outcome records are stored per project in append-only
tables named for production decision records, not "ledgers". Each stored
record keeps its validated `production-decision-record/v1` content and a
content digest over canonical JSON (sorted object keys, preserved array
order), which matches the current rule that key order does not matter and
array order does.

Conflict and duplicate rules move to write time:

- A decision ID is unique within a project. Re-sending an identical decision
  is a no-op. A different decision under an existing ID is rejected with a
  conflict error, so one bad write can never make later reports fail.
- Any record identical to one already stored is a no-op, which makes retries
  safe.
- Actions and outcomes may arrive before their decision. They are stored as
  orphans and join when the decision arrives.
- Several outcomes for one decision and question are kept. The report applies
  the existing rule: the latest `at` wins and differing superseded values
  count as conflicts. A correction is a new outcome record, never an edit.

Rubrist records who submitted each record and when it was received (the API
key or session user, and the receive time) outside the record content. The
record's `by` field stays caller-asserted and is not treated as observed.

The record format stays `production-decision-record/v1`. Rubrist does not add
source values or fields for one deployment or demo. Outcomes from any
population use the existing `source` values, and `by` or `note` can say where
they came from.

### 3. Reports and saved snapshots

A report is built from stored records for an explicit time window and
parameters, with `now` supplied by the server at request time. A build that
would exceed the record ceiling is rejected with an error that names the
ceiling and the window. It is never silently sampled or truncated.

A project member can save a report as a snapshot. A snapshot stores the
report's exact canonical bytes and their digest, append-only, with its build
time, window, parameters, report contract version, and a record-set digest
over the sorted content digests of the records it used. Snapshots keep
history past record retention. The records behind an old snapshot may be
gone, and the record-set digest shows whether a build today would use the
same records. A snapshot is never recomputed in place or reinterpreted under a
later report version, and it carries the same fixed non-evidence `evidence`
block as a live report.

Records stay the source of truth. New metrics, such as score-question
analysis, apply to stored records on the next build, not to saved snapshots.

The report must state the window it covers. That, together with
score-question analysis, changes the `production-calibration` report schema,
so the report version is settled before any snapshot is saved or any
stored-record read is exposed.

### 4. Ingest

The first non-paste path is an append route under `/api/v1/` (working name
`POST /api/v1/production-decisions`) that takes a JSON Lines batch, uses the
existing strict schema and line-numbered errors, and applies a batch
atomically: every record is written or none is. The response reports how
many records were inserted, were duplicates, or are waiting as orphans.

API keys gain explicit capabilities. An ingest key can append production
records for its project and nothing else: it cannot judge, read records or
reports, or read other project data. Existing keys keep their current
capabilities and do not gain ingest. A leaked ingest key can then only add
records, and every record names the key that sent it.

Ingest is batch-first. Rate limits charge for records as well as requests.

An owner can also import a ledger file through the session UI. It uses the
same write path, rules, and submitter provenance. The existing preview route
stays compute-only for exploration.

Ironside ingest is deferred to a later decision. It needs an agreed decision
attribute convention on Ironside observations, an import path that does not
pin a skill version or schedule judging, and a rule for traces over the
observation limit.

### 5. Retention and erasure

Each project has a retention period for production records: 90 days by
default, adjustable by the owner. A scheduled job, not only an owner action,
deletes whole decisions older than the period together with their actions
and outcomes, and deletes orphans by their own `at`. Each run writes an audit
entry with counts and the cutoff.

Records are otherwise append-only. Because `note`, `by`, and `tags` are
caller-controlled and may contain personal data, an owner may erase all
records for one decision ID. The audit entry keeps only the decision ID's
digest and the erased record digests.

Record retention and decision erasure do not rewrite saved snapshots.
Snapshots hold aggregates and carry no `note`, `by`, or `tags` content, but
choice outcome values appear in their confusion cells as given. An owner may
therefore delete a snapshot, with an audit entry that keeps its digest.
Otherwise snapshots go only with project erasure.

### 6. Privacy

Records never store state text or question text. `stateDigest` and
`stateLength` identify the state and the question-set digest identifies the
questions, as today. The documentation must say that an unsalted digest of a
short or predictable state can be guessed, so it identifies the state rather
than anonymizing it. Reads require a project-member session.

## Alternatives considered

- **Stay compute-only and let jevkit or Ironside keep the durable ledger.**
  Set aside by the founder's direction to put monitoring in the charter.
- **Store reports as the source of truth.** Rejected: new metrics and
  parameters could not be applied to old traffic. Snapshots are kept as
  derived history, never as the source.
- **Add a record source value for public or anonymous feedback.** Rejected:
  the record contract does not change for one deployment, and `by` or `note`
  already say where an outcome came from.
- **Reuse today's unscoped project keys for ingest.** Rejected: every judge
  key would gain the power to write outcomes, which are what monitoring treats
  as truth.
- **Start with Ironside ingest.** Deferred: there is no attribute convention,
  the feed is pull-based, and the import path is tied to judging.

## Consequences

- Rubrist gains its first continuous, high-volume write path. Retention bounds
  its growth, and saved snapshots keep aggregate history beyond it.
- Receipt v1, suite manifest v1, and binary-calibration v1 are unchanged.
  Nothing flows from monitoring into governed evidence automatically.
- The API key model gains capabilities, which later key types can reuse.
- Implementation follows Batch 7 in `docs/implementation-batches.md`. Under
  ADR-0011 the tables go into the single baseline with append-only triggers.
  Tests cover clean install, key capabilities, conflict rejection, idempotent
  retries, orphans that later join, the record ceiling, retention and
  erasure, snapshot byte and digest stability, and the absence of any
  state-text storage.
- `docs/production-calibration.md` changes from compute-only to the accepted
  design when that batch lands.

## Follow-ups

These are recorded here so they are not lost. Each needs its own decision
before runtime work.

- **Notifications** on drift or model change, once stored reports and
  snapshots are in use.
- **Ironside ingest**, under the prerequisites in section 4.
- **Governed-review routing** of a low-confidence production sample, under
  the separation in section 1.
