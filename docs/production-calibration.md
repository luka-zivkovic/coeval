# Production calibration

Status: **CURRENT shared contract, pure analysis, a compute-only preview route, and a project view; no persistence or ingest wiring**

Production calibration reports whether a classifier's stated probabilities held
up against the outcomes that arrived later on the customer's own traffic. It
lives in `@coeval/shared`: `packages/shared/src/production-calibration.ts`
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
The Coeval tests carry a small fixture copied from that run's live check: two
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
`x-coeval-project` header exactly as for the neighbouring routes. The body is
capped at 4 MiB (the batch ceiling) and is checked inside the router.

Request body (strict; unknown fields are rejected):

| field | meaning |
| --- | --- |
| `records` | JSON Lines text, or a JSON array of records. Every entry must validate against `ProductionDecisionLedgerRecordSchema`; the first bad line stops the request with `400 production_calibration_invalid_record`, whose message and `details.line` name the one-based line (or array position). An empty ledger is `400 production_calibration_empty_ledger`; two decision records with the same id but different content are `400 production_calibration_conflicting_records`, while identical duplicates are counted once. |
| `question?` | Scopes `threshold` and `costs` to this question; other questions keep the defaults. A question no decision answers is `400 production_calibration_unknown_question`. |
| `threshold?`, `bins?`, `windowDays?` | Passed to `buildProductionCalibrationArtifact`; the shared defaults apply when omitted. |
| `costs?` | `{ falsePositive, falseNegative, humanReview? }` for the advisor; `null` or omitted means no advice. |

The response is `{ artifact, summary, projectRole }`: the
`coeval/production-calibration/v1` artifact, and a summary with record counts
(total, decisions, actions, outcomes), each question with its answer types and
its decision and outcome counts, the model identities seen, and the
question-set digests. The route is the fourth import shape after Ironside,
LangSmith, and Langfuse in the sense that a decision-record ledger is another
way evidence about an agent's work reaches Coeval, but unlike those importers
this first slice stores nothing: closing the browser tab discards the reading.

The web view lives at `/production-calibration`, under "Ungoverned
diagnostics" beside Reliability signals in the project navigation (visible in
the Technical display, like the other diagnostics), and needs a project but not
a selected criterion. It takes a pasted or uploaded ledger, or the bundled
sample (a CI flaky-test triage bot's 16 decisions with 32 human outcomes, served
from the web app's static assets; digests, probabilities, and option names
only). A question selector lists each question with its type and counts. A
boolean question shows the reliability diagram (inline SVG: predicted on x,
observed rate on y, the diagonal, marks sized by bin count, each bin's Wilson
interval as a vertical range) beside the bin table, a threshold slider that
re-requests the preview scoped to that question and redraws the confusion
matrix and its four rates, the advisor with three cost inputs whose state
(no costs, no outcomes, fewer than 30 outcomes, recommendation or band) is
always visible, the drift table with its model-change and drift flags, and the
by-model and by-digest groups. A choice question shows top-1 accuracy, the
confidence reliability table and diagram, the off-diagonal confusion pairs,
and the by-model groups. A score question shows the artifact's
not-implemented notice. Every rate is rendered as numerator over denominator
with its 95% interval, and every reading starts with the provenance line:
"Outcomes from production sources are development feedback. Independent
validation is a separate step." An independently reviewed sample routed
through governed review is a separate, future step; the view does not simulate
it.

## How it differs from sealed binary calibration

[Sealed binary calibration](../contracts/binary-calibration-v1.md) is Coeval's
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
`coeval/binary-calibration/v1` contract.

## Input records: `coeval/production-decision-record/v1`

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

## Output artifact: `coeval/production-calibration/v1`

`buildProductionCalibrationArtifact(records, { now, ... })` produces one
`ProductionCalibrationArtifact`. `now` is a required parameter because the
builder never reads the clock. The artifact carries the record inventory
(decision, action, and outcome totals, orphans, superseded and conflicting
outcomes, decisions tagged `synthetic: "true"`, question sets seen, model
identities seen), the parameters used, and one entry per question and answer
type.

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

Reported with `implemented: false` and
`reason: "ordinal_calibration_not_implemented"`, plus the decision and
outcome counts. Nothing else is claimed.

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
`promote`/`block` decisions stay outside Coeval.

## Not implemented

- **Score (ordinal) calibration.** Reported as not implemented, with counts.
- **Persistence of decision records.** The preview route and the view are
  compute-only. No table, worker, or history stores a ledger, an artifact, or
  a reading; a refresh starts over. Persistence is TARGET only if a decision
  record accepts it.
- **Live import.** No poller or sink reads decisions from a running system;
  the ledger arrives as pasted or uploaded text.
- **Governed-review routing of a low-confidence sample.** The advisor names
  a review band, but nothing sends the decisions inside it to governed review
  or brings independent labels back. The view says this step is separate; it
  does not fake it.
- **Ironside ingest.** No sink reads decisions from, or writes outcomes to,
  Ironside or OpenTelemetry. The records are shaped so a decision maps to a
  span with attributes and an outcome to a later event on the same id.
- **Outcome validation against question types.** Outcome values are stored
  as given; the analysis ignores values of the wrong type for a question.
- **Governed evidence.** The artifact is not digest-pinned, has no private
  ledger commitment, and is not admissible where a sealed
  `coeval/binary-calibration/v1` artifact is required.
