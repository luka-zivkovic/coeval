# ADR-0013: Production outcome monitoring

Status: **Accepted**

Date: 2026-09-23

Decision owner: Luka Živković (founder), explicit approval on 2026-09-23.
The founder placed production monitoring in Rubrist's charter, now recorded
in `PRODUCT.md`, and settled retention, stored snapshots, notifications, and
outcome sources the same day. Runtime work follows its implementation batch
in `docs/implementation-batches.md`. An independent review on 2026-09-24
added retention by receive time and its bounds, rejection of future-dated
records, erasure tombstones, revoked-key purges, the deletion mechanism, the
stored build order, and the ingest budget, under the founder's instruction to
resolve review findings before merging.

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
still not governed review. The calibration requirements of ADR-0002 and
ADR-0004 govern evaluator calibration evidence only; production analysis of
boolean, choice, or score questions neither satisfies nor reopens them.

Routing a low-confidence sample from production into governed review is a
separate, later decision. When it exists, the reviewer view includes only the
frozen review item under ADR-0008, never the production probability, action,
or outcome. That decision must also stop a reviewer from finding the item's
production record another way, for example by hashing the item's text to
match an unsalted `stateDigest`: routed reviewers get no per-record reads, or
such a read counts as exposure.

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
- A record whose `at` is more than five minutes after Rubrist receives it is
  rejected, so a future-dated outcome cannot win every later build. Older
  records, including backfills, are accepted.

Rubrist records who submitted each record and when it was received (the API
key or session user, and the receive time) outside the record content. The
record's `by` field stays caller-asserted and is not treated as observed.

The record format stays `production-decision-record/v1`. Rubrist does not add
source values or fields for one deployment or demo. Outcomes from any
population use the existing `source` values, and `by` or `note` can say where
they came from. Reports do not filter on `by` or `note`; populations that must
be read apart belong in separate projects, or in a later report filter on
decision `tags`, which needs no contract change.

### 3. Reports and saved snapshots

A report is built from stored records for an explicit time window and
parameters, with `now` supplied by the server at request time. A windowed
build loads the decisions whose `at` falls in the window with all of their
actions and outcomes, plus orphan actions and outcomes whose own `at` falls in
the window. Records reach the builder ordered by `at`, then receive time, then
content digest, so outcome ties resolve the same way on every build. A build
whose loaded records would exceed the record ceiling is rejected with an error
that names the ceiling and the window. It is never silently sampled or
truncated.

Because identical records are stored once, a stored build counts them once,
and its outcome and superseded totals can be lower than a preview of the same
pasted ledger.

A project member can save a report built from stored records as a snapshot; a
preview of a pasted ledger cannot be saved. A snapshot stores the
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

Ingest is batch-first. A batch holds at most 10,000 records and 4 MiB. Ingest
keys have their own records-per-minute budget, separate from the judge request
bucket, with a burst no smaller than one full batch; like the existing
guardrails, the limits are configurable. The current limiter is in memory and
per process, which is acceptable only while ADR-0011's pre-launch conditions
hold. A shared quota is required before more than one API instance serves
ingest.

An owner can also import a ledger file through the session UI. It uses the
same write path, rules, and submitter provenance. The existing preview route
stays compute-only for exploration.

Ironside ingest is deferred to a later decision. It needs an agreed decision
attribute convention on Ironside observations, an import path that does not
pin a skill version or schedule judging, and a rule for traces over the
observation limit.

### 5. Retention and erasure

Each project has a retention period for production records: 90 days by
default, adjustable by the owner between 1 and 730 days. It cannot be switched
off. Retention runs on the time Rubrist received a record, not on the caller's
`at`, so neither a future-dated record nor an old backfill escapes it. A
scheduled job, not only an owner action, deletes whole decisions received
before the cutoff together with their actions and outcomes, and deletes
orphans by their own receive time. Each run writes an audit entry with counts
and the cutoff.

Records are otherwise append-only. Because `note`, `by`, and `tags` are
caller-controlled and may contain personal data, an owner may erase all
records for one decision ID. Erasure leaves a tombstone holding only the
decision ID's digest, and later records for that decision ID are rejected, so
a producer replaying its own ledger cannot bring erased data back. The audit
entry keeps only the decision ID's digest and the erased record digests.

An owner may also purge every record sent by a revoked API key. That removes
what a leaked key added, including outcomes posted in advance for decisions
that had not arrived yet. The audit entry names the key and the counts.

Records and snapshots reject every UPDATE. DELETE is allowed once the project
row is gone, or inside Rubrist's retention, erasure, purge, and
snapshot-deletion operations, which write their audit entry in the same
transaction; the trigger checks a transaction-local marker that only those
operations set. Audit entries go to the existing `audit_logs` table, which is
not append-only today; this ADR does not change that.

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

### 7. Pre-launch status

Until ADR-0011's exit condition is met, stored records and snapshots are as
disposable as every other pre-launch table, and the baseline may be rebuilt
under them. The first persistent ingest of records from a system outside the
founder's own testing is an ADR-0011 exit event and is recorded as one before
it happens.

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
- **Run retention on the caller's `at`.** Rejected: a future-dated record
  would never expire and an old backfill would be deleted on the next run.

## Consequences

- Rubrist gains its first continuous, high-volume write path. Retention bounds
  its growth, and saved snapshots keep aggregate history beyond it.
- Receipt v1, suite manifest v1, and binary-calibration v1 are unchanged.
  Nothing flows from monitoring into governed evidence automatically.
- The API key model gains capabilities, which later key types can reuse.
- Implementation follows Batch 7 in `docs/implementation-batches.md`. Under
  ADR-0011 the tables go into the single baseline with append-only triggers.
  Tests cover clean install, key capabilities, conflict rejection, idempotent
  retries, future-dated rejection, orphans that later join, deterministic
  build order, the record ceiling, retention by receive time, erasure
  tombstones, revoked-key purges, snapshot byte and digest stability, and the
  absence of any state-text storage.
- `docs/production-calibration.md` changes from compute-only to the accepted
  design when that batch lands.

## Follow-ups

These are recorded here so they are not lost. Each needs its own decision
before runtime work.

- **Notifications** on drift or model change, once stored reports and
  snapshots are in use.
- **Ironside ingest**, under the prerequisites in section 4.
- **Governed-review routing** of a low-confidence production sample, under
  the separation in section 1, including the `stateDigest` lookup it must
  prevent.
