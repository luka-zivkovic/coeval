# Production calibration

Status: **CURRENT shared contract, pure analysis, a compute-only preview route, an append-only record store, API-key ingest, an owner import, reports and snapshots over stored records, retention, erasure, and purges, and a project view over records and snapshots; the view has no retention or erasure controls yet**

Production calibration reports whether a classifier's stated probabilities held
up against the outcomes that arrived later on the customer's own traffic. It
lives in `@rubrist/shared`: `packages/shared/src/production-calibration.ts`
holds the two zod contracts and
`packages/shared/src/production-calibration-analysis.ts` the pure functions
that turn an array of decision, action, and outcome records into one report
artifact. Nothing in either module reads a file, a database, a network, or the
clock.

The module is a port of the analysis in jevkit's decision ledger. Its math was
validated there against 3,742 live decisions on two public datasets on
2026-09-20; the ledgers, reports, and write-up are in the experiments
repository under
[`luka-zivkovic/experiments/jev-decision-ledger`](https://github.com/luka-zivkovic/experiments/tree/main/jev-decision-ledger).
The Rubrist tests carry a small fixture copied from that run's live check: two
decision lines and their outcomes, which contain only digests, probabilities,
and option names.

## CURRENT: the preview route and the view

`POST /api/production-calibration/preview` computes the artifact for a ledger
sent with the request and returns it. Nothing is persisted, queued, or read
from the database; each call is a fresh computation. The route is mounted next
to the other session-only analysis surfaces and applies the same checks: it
answers 501 without database-backed session mode, 401 without a project-member
session or with an API key, and 403 when the resolved project has no
membership for the user. The project comes from the session and the
`x-rubrist-project` header exactly as for the neighbouring routes. The body is
capped at 4 MiB (the batch ceiling) and is checked inside the router.

Request body (strict; unknown fields are rejected):

| field | meaning |
| --- | --- |
| `records` | JSON Lines text, or a JSON array of records. Every entry must validate against `ProductionDecisionLedgerRecordSchema`; the first bad line stops the request with `400 production_calibration_invalid_record`, whose message and `details.line` name the one-based line (or array position). An empty ledger is `400 production_calibration_empty_ledger`; two decision records with the same id but different content are `400 production_calibration_conflicting_records`, while identical duplicates are counted once. |
| `question?` | Scopes `threshold` and `costs` to this question; other questions keep the defaults. A question no decision answers is `400 production_calibration_unknown_question`. |
| `threshold?`, `bins?`, `windowDays?` | Passed to `buildProductionCalibrationArtifact`; the shared defaults apply when omitted. |
| `costs?` | `{ falsePositive, falseNegative, humanReview? }` for the advisor; `null` or omitted means no advice. |

The response is `{ artifact, summary, projectRole }`: the
`rubrist/production-calibration/v2` artifact, and a summary with record counts
(total, decisions, actions, outcomes), each question with its answer types and
its decision and outcome counts, the model identities seen, and the
question-set digests. The route is the fourth import shape after Ironside,
LangSmith, and Langfuse in the sense that a decision-record ledger is another
way evidence about an agent's work reaches Rubrist, but unlike those importers
this first slice stores nothing: closing the browser tab discards the reading.

The web view lives at `/production-calibration`, under "Ungoverned
diagnostics" beside Reliability signals in the project navigation (visible in
the Technical display, like the other diagnostics), and needs a project but not
a selected criterion. It reads three sources:

- **Stored records.** A from and through date (UTC; the through day is
  included) build a report from the project's stored records, "Save snapshot"
  saves the stored report on screen with its own window and current
  parameters (it is enabled only while a finished stored report is shown, so
  edited date inputs, a preview, or an open snapshot are never what it
  saves), and owners can
  import a `.jsonl` ledger into the project, seeing how many records were
  inserted, were duplicates, or await their decision.
- **Snapshots.** Saved reports are listed newest first with their window,
  record count, and digest; opening one shows it read-only, with the threshold
  and cost controls disabled because its parameters are fixed.
- **A pasted ledger.** A pasted or uploaded ledger, or the bundled sample (a CI
  flaky-test triage bot's 16 decisions with 32 human outcomes, served from the
  web app's static assets; digests, probabilities, and option names only), is
  previewed without being stored.

Reliability bins and the drift window apply to all three. Every reading names
its source. A question selector lists each question with its type and counts. A
boolean question shows the reliability diagram (inline SVG: predicted on x,
observed rate on y, the diagonal, marks sized by bin count, each bin's Wilson
interval as a vertical range) beside the bin table, a threshold slider that
re-requests the live reading (preview or stored report) scoped to that question and redraws the confusion
matrix and its four rates, the advisor with three cost inputs whose state
(no costs, no outcomes, fewer than 30 outcomes, recommendation or band) is
always visible, the drift table with its model-change and drift flags, and the
by-model and by-digest groups. A choice question shows top-1 accuracy, the
confidence reliability table and diagram, the off-diagonal confusion pairs,
and the by-model groups. A score question shows exact and within-one level
accuracy, mean absolute error, the bias with its direction in words, the ranked
probability score, the confidence reliability table and diagram, the
cumulative level-cut table, the off-diagonal level confusions, and the
by-model groups; when its metrics are undefined it says why instead. Every rate is rendered as numerator over denominator
with its 95% interval, and every reading starts with the provenance line:
"Outcomes from production sources are development feedback. Independent
validation is a separate step." An independently reviewed sample routed
through governed review is a separate, future step; the view does not simulate
it.

## How it differs from sealed binary calibration

[Sealed binary calibration](../contracts/binary-calibration-v1.md) is Rubrist's
governed evidence: one exact evaluator version, one governed-blind
sealed-validation revision, independent human truth, a private salted ledger,
and a digest-pinned aggregate artifact. Production calibration is none of
those things, and its artifact says so in an `evidence` block that is fixed to
`kind: "production_outcomes"`, `sealed: false`, and
`independentHumanValidation: false`.

| | Sealed binary calibration | Production calibration |
| --- | --- | --- |
| Truth | Governed-blind human labels on a sealed revision | Outcomes posted after the fact by a person, an immediate signal, or a delayed signal |
| Timing | One run over a frozen set | Continuous; the report is rebuilt as records accumulate |
| Independence | Reviewers never see evaluator output | The outcome may be influenced by the action the decision triggered |
| Counts | Bounded by the 5,000-item selection cap | Unbounded safe integers |
| Intervals | Wilson bounds as pinned binary64 bits | Wilson bounds as ordinary numbers |
| Identity | Evaluator, criterion, truth, and exposure digests | Question-set digest and the model version the provider reported |

Both use exact numerator/denominator pairs, 95% Wilson score intervals under
`wilson-score/v1`, and an explicit `state: "undefined"` rate with
`undefinedReason: "zero_denominator"` instead of `NaN`. Both group by observed
provider identity. Production intervals use the same pinned z constant,
binary64 operation order, and exact 0/1 endpoint bounds as the sealed contract;
only the bound encoding differs. Production calibration is a measurement of
your traffic, not a governed calibration claim, and it does not extend or replace the
`rubrist/binary-calibration/v1` contract.

## Input records: `rubrist/production-decision-record/v1`

`ProductionDecisionLedgerRecordSchema` accepts three strict record kinds with
the field names of the jevkit ledger, so one of its JSON Lines entries
validates unchanged.

| kind | what | key fields |
| --- | --- | --- |
| `decision` | What the model said for one state | `id`, `at`, `questionSet {name, version, digest}`, `model` (the version the provider reported, or null), `provider`, `stateDigest`, `stateLength`, `answers`, `latencyMs`, `usage`, `tags?` |
| `action` | The policy the caller applied | `decisionId`, `question`, `threshold` (number, `{low, high}`, or null), `action`, `by?` |
| `outcome` | What turned out to be true | `decisionId`, `question`, `value`, `source` (`human`, `automatic`, `delayed`), `by?`, `note?` |

Answers are tagged with their question type: `{ type: "boolean", probability }`,
`{ type: "choice", choice, probabilities, confidence }`, or
`{ type: "score", mean, probabilities }`. The state a decision was made on is
never part of the record: `stateDigest` is `sha256:` over the exact state text
and `stateLength` its length. Question text is not stored either; the
question-set digest identifies it. `note` and `by` are stored as given, so
keep personal data out of them.

`joinProductionDecisionRecords` attaches actions and outcomes to their
decisions. Identical decision records with the same ID are counted once;
object key order does not matter, while array order and every recorded field
do. Conflicting records with the same decision ID reject the report instead
of replacing the prediction or its provenance. When several outcomes exist
for one decision and question, the latest `at` wins and equal timestamps
resolve to input order; superseded outcomes whose value differs from the
winner are counted as conflicts. Actions
and outcomes whose decision is not in the input are dropped from the join and
counted as orphans in the artifact.

## Output artifact: `rubrist/production-calibration/v2`

`buildProductionCalibrationArtifact(records, { now, window?, ... })` produces
one `ProductionCalibrationArtifact`. `now` is a required parameter because the
builder never reads the clock. The artifact carries the window it covers, the
record inventory (decision, action, and outcome totals, orphans, records
outside the window, superseded and conflicting outcomes, decisions tagged
`synthetic: "true"`, question sets seen, model identities seen), the
parameters used, and one entry per question and answer type.

Version 2 replaced version 1 on 2026-09-24, before any report was stored. It
adds score-question metrics and the window, and its metric definitions are
`production-calibration-metrics/v2`. The input record contract is unchanged.

The **window** selects decisions by their `at`: `from` is inclusive, `to` is
exclusive, and either may be null for no bound. The preview route sends no
window, so a preview covers every decision supplied (`{ from: null, to: null }`).
Record totals count everything supplied; `outsideWindow` counts the decisions
before or after the window and the actions and outcomes attached to them, and
those never count as orphans. Every other inventory figure, the outcome
sources, and every question cover the window only. Conflicting decision IDs
are checked across everything supplied, so a window cannot hide one. A window
whose `from` is not earlier than its `to` rejects the report.

Global and per-question classification thresholds must be finite numbers in
`[0, 1]`; invalid values reject the report before a calibration result is returned.

### Boolean questions

- **Reliability bins.** Decisions with an outcome fall into `bins` equal-width
  bins of predicted probability (ten by default). Each bin reports its count,
  mean prediction, and observed rate of the positive class as a Wilson rate.
  Calibrated means the observed rate tracks the mean prediction; predicted 0.7
  and observed 0.45 in the 0.6 to 0.7 bin is overconfidence in that band.
- **Brier score.** Mean of `(probability - outcome)²`. 0 is perfect and 0.25
  is what "always say 0.5" scores. It mixes calibration and sharpness, so
  compare it between model versions on the same question, not across
  questions.
- **ECE.** Expected calibration error, `sum over bins of (count / n) times
  |observed - mean predicted|`: the reliability table collapsed into one
  number weighted by traffic.
- **Confusion at a threshold.** `p >= threshold` counts as predicted positive.
  The four cells and accuracy, precision, recall, and specificity as Wilson
  rates. The **error directions** are spelled out in the artifact, for
  example `predicted true at p >= 0.85 when the outcome was false`, so nobody
  has to remember which is which. `positiveClass: false` flips both the
  probability and the outcome when the event you act on is the `false` answer.
- **By model and by digest.** `n`, `nWithOutcome`, Brier, and ECE grouped by
  observed model identity (`provider` plus the reported model version, or an
  explicit `unreported` group when the provider did not say) and by
  question-set digest. A version change is where calibration usually moves.
- **Drift by window.** Windows of `windowDays` anchored at the UTC midnight
  before the earliest decision. Each window reports the mean prediction, the
  observed rate with its interval, Brier, and the model identities seen.
  `driftFlag` is set when the mean prediction leaves the observed 95% interval
  with at least `minOutcomesToFlag` outcomes (20 by default); `modelChanged`
  is set when a model identity appears that the previous window did not have.

### Choice questions

Top-1 accuracy (the chosen option equalled the outcome) as a Wilson rate, a
reliability table of `confidence` against top-1 correctness using the same
binary machinery, ECE and Brier over that same pairing, a sorted list of
`(truth, chosen, count)` confusion cells, and accuracy and ECE by model
identity.

### Score questions

A score answer is a distribution over an ordered rubric, `probabilities[k]`
for level `k` from 0, with the fractional `mean`; the outcome is the true level
index. Each answer is checked before it is used, and nothing is repaired:

- An answer with fewer than 2 or more than 10 levels, probabilities that do
  not sum to 1 within 0.01, or a `mean` outside `[0, levels - 1]` is counted in
  `excluded.invalidAnswer` and left out. Probabilities within the tolerance
  are divided by their sum.
- A numeric outcome that is not an integer level of that answer's scale is
  counted in `excluded.outcomeOutOfRange` and left out. Outcomes of another
  type are ignored, as for the other question types.

Metrics are defined only when every valid answer to the question uses the
same number of levels: level 3 of five and level 3 of ten are different
claims. Otherwise the entry is `state: "undefined"` with `undefinedReason:
"mixed_levels"` or `"no_valid_answers"`, and it keeps the counts and the level
counts seen. A defined entry reports:

- **Exact and within-one accuracy** of the most likely level (ties resolve to
  the lowest level), as Wilson rates.
- **Mean absolute error and bias** of the stated `mean` against the outcome,
  in levels. They treat the levels as evenly spaced. Positive bias means the
  answers scored above the outcome on average.
- **Confidence reliability.** The most likely level's probability against
  exact correctness, with ECE and Brier: the same pairing as choice questions.
- **Cumulative cuts.** For each `k` from 1 to `levels - 1`, the predicted
  `P(level >= k)` against whether the outcome reached level `k`. Each cut is a
  binary event, so it gets the boolean reliability bins, mean prediction,
  observed Wilson rate, Brier, and ECE.
- **Ranked probability score.** The mean over cuts of each cut's Brier score:
  the ordinal counterpart of Brier. 0 is perfect.
- A sorted list of `(truth, predicted, count)` level confusion cells, and
  exact accuracy, mean absolute error, and ranked probability score by model
  identity.

Score questions have no drift report or threshold advisor, like choice
questions.

## The threshold advisor

`adviseProductionThreshold` turns costs into a threshold or a review band.
Costs are in whatever unit you like; only their ratios matter. Using the
decisions that have outcomes, the advisor sweeps thresholds from 0.05 to 0.95
in steps of 0.05.

- **Single threshold.** Everything is decided automatically at `t`. Expected
  cost per decision is `(FP(t) · costFP + FN(t) · costFN) / n` and the
  cheapest `t` wins. Expensive false positives push the threshold up;
  expensive misses push it down.
- **Review band** (when `humanReview` is given). `p >= high` is auto-yes,
  `p <= low` is auto-no, and the middle goes to a person at the review cost,
  who is assumed to be right. Each pair reports the automated and reviewed
  counts, the automation rate, the error rate among automated decisions as a
  Wilson rate, and the expected cost; the cheapest pair wins and ties go to
  more automation. Pairs with `low == high` are included so "review nothing"
  can win when review is expensive.

The recommendation comes with the full sweep so the flatness of the optimum is
visible. With fewer than 30 outcomes the advice carries
`caveat: "fewer_than_30_outcomes"`; with none it carries `caveat: "no_outcomes"`
and no recommendation. The advisor is an empirical sweep over past traffic,
not a model of it: it assumes tomorrow looks like the outcomes you already
have. It recommends; it does not decide. Release thresholds and
`promote`/`block` decisions stay outside Rubrist.

## CURRENT: the record store

Batch 7B under [ADR-0013](decisions/0013-production-outcome-monitoring.md)
adds the `production_decision_records` table and
`PgProductionDecisionRecordRepository.appendRecords`, which the ingest and
import routes below write through.

- One append-only table holds decision, action, and outcome records per
  project. Each row keeps the record as given, its kind, decision ID, and
  `at`, a content digest, the submitter (an API key or a session user, never
  both), and the receive time. No column can hold state or question text.
- The content digest is `governed_content_v1_digest` over the record under
  `rubrist/production-decision-record/v1`: canonical JSON with sorted keys and
  kept array order. The insert guard recomputes it in SQL, checks that kind,
  decision ID, and time match the content, and sets the receive time from the
  database clock, so a writer can supply none of them.
- A batch of up to 10,000 records is applied atomically. A record identical to
  a stored one, or repeated in the batch, is a no-op counted as a duplicate. A
  decision ID is unique per project: a different decision under a stored or
  repeated ID rejects the whole batch with `conflicting_decision` and the
  record's line, and concurrent writers of one ID cannot both succeed. Rows
  are inserted in one global order (decisions by ID, then actions and outcomes
  by digest), so concurrent batches that share records cannot deadlock; a
  remaining serialization failure is reported as `write_contention`, and a
  retry is safe because identical records are no-ops.
- Actions and outcomes may arrive before their decision; the result counts
  them as awaiting their decision until it is stored.
- A record dated more than five minutes after the database receives it is
  rejected with `future_dated_record` and its line. Older records are
  accepted. A record larger than 64 KiB of JSON is rejected with
  `record_too_large`, and content PostgreSQL JSON cannot hold, such as a NUL
  character, with `invalid_record`; both name the line and write nothing. An
  append to a project that no longer exists fails with `project_not_found`.
- UPDATE is always rejected and DELETE is rejected while the project exists;
  project erasure removes the project's records.

## CURRENT: ingest and import

Every project API key now has one capability. `judge` is the original
`/api/v1` surface and the default. `production_ingest` may only call
`POST /api/v1/production-decisions`, and no other key may call it; the API
key middleware answers `403 api_key_capability_mismatch` either way. An owner
chooses the capability when minting a key (`POST /api/api-keys` with
`capability`, or the Settings key form); keys minted before capabilities
existed are judge keys.

`POST /api/v1/production-decisions` takes the ledger as the raw body in JSON
Lines (`application/x-ndjson`, `application/jsonl`, or `text/plain`) or as
JSON `{ "records": ... }`, parsed exactly like the preview. The body may be
at most 4 MiB. It writes through `appendRecords` with the key as submitter and
answers `{ inserted: { decisions, actions, outcomes }, duplicates,
awaitingDecision }`. Retrying a batch is safe.

- A bad line is `400 production_ingest_invalid_record` with its line.
- Store rejections answer `production_ingest_<code>`: `conflicting_decision`
  is 409; `batch_too_large` and `record_too_large` are 413;
  `future_dated_record`, `invalid_record`, and `empty_batch` are 400;
  `project_not_found` is 404; and `write_contention` is 503 with
  `Retry-After: 1`.
- Each request costs one unit of the key's ingest budget before its body is
  parsed, so malformed bodies are metered too, and each record after the
  first costs one more. The budget is separate from the judge request bucket:
  `PRODUCTION_INGEST_RECORDS_PER_MINUTE` per key (60,000 by default), with a
  burst of at least one full 10,000-record batch. A batch the budget cannot
  cover is `429 production_ingest_rate_limited` and writes nothing. The
  limiter is in memory and per process.
- Without database-backed mode the route answers 501.

A project owner can also import a ledger in a session with
`POST /api/production-calibration/records` (`{ "records": ... }`, 4 MiB). It
uses the same write path and error codes, prefixed `production_calibration_`,
with the owner as submitter. Members get `403
production_calibration_owner_required`.

## CURRENT: stored reports and snapshots

Project members can build a report from the project's stored records and
save it as a snapshot. The server always loads the records itself, so a
stored report or snapshot describes only records Rubrist holds, never a
pasted ledger.

- `POST /api/production-calibration/report` takes an optional window
  (`from` inclusive and `to` exclusive, ISO timestamps with an offset, on
  decision time) and the preview's parameters (`question`, `threshold`,
  `bins`, `windowDays`, `costs`). It loads the decisions whose `at` falls in
  the window with all of their actions and outcomes, plus orphan actions and
  outcomes whose own `at` falls in it, and builds the report with that window.
  It answers the preview's `{ artifact, summary, projectRole }` plus
  `recordCount` and `recordSetDigest`.
- Records reach the builder ordered by `at`, then receive time, then content
  digest, so outcome ties resolve the same way every time: two builds over
  the same records with the same `now` produce identical canonical bytes.
  Because identical records are stored once, a stored build can count fewer
  outcomes than a preview of the same pasted ledger.
- `recordSetDigest` is `governed_content_v1_digest` over the sorted content
  digests of the loaded records, under `rubrist/production-record-set/v1`.
  It shows whether a later build would use the same records.
- A window that would load more than `PRODUCTION_REPORT_MAX_RECORDS` records
  (100,000 by default) is `422 production_calibration_record_ceiling_exceeded`,
  naming the ceiling and the window. It is never sampled. A `from` that is not
  earlier than `to` is `400 production_calibration_invalid_window`.
- `POST /api/production-calibration/snapshots` builds the same report and
  saves it: the exact canonical bytes (`canonicalJson`), their digest, the
  window, the request parameters, the record count, the record-set digest,
  the build time, and the member who saved it. It answers `201 { snapshot }`.
  A report larger than 16 MiB of canonical JSON is `422
  production_calibration_snapshot_too_large`; choose a narrower window.
- `GET /api/production-calibration/snapshots` lists them newest first, and
  `GET /api/production-calibration/snapshots/:id` answers `{ snapshot,
  artifact }`, parsing the artifact from the stored bytes only after they
  still hash to their digest; an unknown ID is 404.
- The `production_calibration_snapshots` table is append-only like the record
  store. Its insert guard recomputes the digest over the bytes and checks that
  the contract, window, and build time columns match the bytes. A snapshot
  keeps the report version it was built with and is never recomputed.
- Without database-backed mode these routes answer 501.

## CURRENT: retention, erasure, and purges

Records and snapshots are append-only (ADR-0013 section 5). UPDATE is always
rejected. DELETE is allowed once the project row is gone, or inside the four
operations below, which set a transaction-local marker
(`rubrist.production_deletion`) that the append-only guards check and write
their `audit_logs` entry in the same transaction. Audit entries are not
append-only themselves; that is unchanged.

- **Retention.** Each project keeps production records for
  `production_record_retention_days`: 90 by default, 1 to 730, and it cannot
  be switched off. Members read it with `GET /api/production-calibration/settings`
  and owners change it with `PUT` (`{ "retentionDays": n }`, audited as
  `production.retention.update`). Every API process runs a sweep hourly
  (`PRODUCTION_RETENTION_INTERVAL_MS`, 0 disables the timer), and an advisory
  lock lets one run delete at a time. A sweep uses Rubrist's receive time, never
  the caller's `at`: a decision received before its project's cutoff is
  deleted with all of its actions and outcomes, even newer ones, and an orphan
  goes by its own receive time. Each project that loses records gets a
  `production.retention.apply` entry with the cutoff and counts.
- **Decision erasure.** `POST /api/production-calibration/records/erase`
  (`{ "decisionId": ... }`) deletes every record of that decision and leaves a
  tombstone holding only the decision ID's SHA-256. Later records for that ID
  are rejected: `410 production_ingest_erased_decision` (or
  `production_calibration_erased_decision`) naming the line, and the insert
  guard enforces the same rule. The `production.decision.erase` entry keeps
  the decision ID's digest and the erased record digests, never the ID or the
  record content. Erasing again is harmless.
- **Revoked-key purge.** `POST /api/production-calibration/records/purge`
  (`{ "apiKeyId": ... }`) deletes every record that API key sent, including
  outcomes posted in advance for decisions that never arrived. The key must
  already be revoked (`409 production_calibration_api_key_not_revoked`; an
  unknown key is 404). Audited as `production.api_key.purge`.
- **Snapshot deletion.** `DELETE /api/production-calibration/snapshots/:id`
  answers 204, or 404 for an unknown ID, and is audited as
  `production.snapshot.delete` with the snapshot's digest. Retention and
  erasure never touch snapshots.

Changing retention, erasing, purging, and deleting snapshots are owner-only
(`403 production_calibration_owner_required` for members).

## Not implemented

- **Retention and erasure controls in the view.** The web view reads stored
  records and snapshots but has no retention setting, erasure, purge, or
  snapshot deletion controls; the API routes above are the owners' current
  surface.
- **Pulled import.** Rubrist does not poll a running system for decisions;
  producers push them to the ingest route or an owner imports a file.
- **Governed-review routing of a low-confidence sample.** The advisor names
  a review band, but nothing sends the decisions inside it to governed review
  or brings independent labels back. The view says this step is separate; it
  does not fake it. ADR-0013 records it as a follow-up that needs its own
  decision.
- **Ironside ingest.** No sink reads decisions from, or writes outcomes to,
  Ironside. Ironside delivers observations with string metadata, not spans,
  and there is no attribute convention for decisions yet; ADR-0013 defers
  this path until one exists.
- **Outcome validation against question types.** Outcome values are stored
  as given; the analysis ignores values of the wrong type for a question.
- **Governed evidence.** The artifact is not digest-pinned, has no private
  ledger commitment, and is not admissible where a sealed
  `rubrist/binary-calibration/v1` artifact is required.
