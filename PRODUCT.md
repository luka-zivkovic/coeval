# Rubrist product charter

Status: **active target-state charter**

Last reviewed: 2026-09-24

This document is the source of truth for what Rubrist is becoming. The README,
architecture notes, UI copy, plans, and code may describe current behavior,
but they do not override this charter. Accepted ADRs in `docs/decisions/` may
refine it. Proposed ADRs record an open decision and are not yet binding.

## User and job

Rubrist serves the quality owner responsible for discovering how an AI system
fails, turning that understanding into human-reviewed criteria, and governing
evaluators that can be trusted and reused.

The job is:

> Analyze representative traces, define how each important failure mode should
> be judged, validate those evaluators against reviewed human truth, execute
> exact versions, and preserve what happened as policy-free evidence.

The same owner also needs to know whether the probabilistic decisions their
system makes in production keep the confidence they state. The second job is:

> Keep the decisions a production system makes and the outcomes that arrive
> later, and show whether its stated probabilities held up, per model version
> and over time, without presenting that feedback as governed evidence.

## Product loop

```text
representative traces and cases
→ open coding and failure taxonomy
→ narrow criteria and governed human review
→ versioned evaluators and policy-free suites
→ iterative development + sealed validation
→ pinned evaluator execution
→ immutable assessment and calibration evidence
```

Rubrist's loop deliberately begins before a finished rubric exists. It supports
trace imports and dataset-first workflows, helps reviewers turn observed
failures into narrow criteria, and preserves independent review and
adjudication history. These are evaluator-governance activities, not release
automation. Semantic clustering may later assist analysis, but it is explicitly
deferred and is not required for this loop.

Production outcome monitoring runs beside that loop:

```text
production decisions, actions, and later outcomes
→ durable project-scoped records
→ production calibration, drift, and model-change reports
→ signals for analysis and governed review, never a substitute for them
```

Monitoring answers a different question from sealed calibration. Sealed
calibration measures an exact evaluator version against governed-blind human
truth on a frozen revision. Monitoring measures a live system against outcomes
posted after it acted, and those outcomes may be shaped by the action the
decision triggered. Both are useful; only the first is validation evidence.

## Rubrist owns

- Analysis workflows that turn representative traces into open codes, failure
  taxonomies, and independently judgeable criteria.
- Governed human review: full trace context, independent labels, rationale,
  defer/undo, disagreement, alignment, adjudication, and reviewer provenance.
- Versioned evaluator definitions: criterion, rubric, prompt, output contract,
  and requested model binding.
- Policy-free evaluator suites that group pinned single-criterion evaluators
  without assigning release weights or thresholds.
- The provenance and validation contract for native or imported human truth.
- Immutable dataset revisions, their analysis/authoring,
  iterative-development, sealed-validation, or regression/golden role, and
  their exposure history.
- Pinned evaluator execution and observed provider provenance.
- Calibration evidence, coverage, uncertainty, and incomplete-run state.
- Policy-free assessment receipts and their versioned wire contracts.
- Production outcome monitoring: durable, project-scoped decision, action,
  and outcome records in the versioned production decision-record format;
  production calibration, drift, and model-change reports computed from them;
  and an advisory threshold sweep. Monitoring is ungoverned development
  feedback and stays visibly separate from governed evidence.

## Decisions Rubrist makes

- What label, score, category, or abstention an evaluator produced.
- Whether an evaluator was measured against human truth, against which
  immutable revision, with which exposure state and metric definition.
- Whether assessment evidence is complete enough to describe what happened.
- How a production system's stated probabilities compared with the outcomes
  recorded for it, for a named question, window, and observed model identity.

## Decisions Rubrist does not make

- Whether a customer's product change should ship.
- Acceptable pass-rate, regression, cost, or latency thresholds for a release.
- Rollout percentages, deployment promotion, rollback, or overrides.
- Whether a static agent capability artifact is safe to install.
- The threshold a production system acts on, or whether to switch models or
  roll back when monitoring shows drift. The threshold advisor recommends; it
  does not decide.

## Inputs and outputs

Inputs include representative traces or cases, native human reviews or
externally reviewed truth, failure codes and criteria, evaluator definitions,
requested model bindings, immutable dataset revisions, and production
decision, action, and outcome records.

Outputs include review and taxonomy provenance, versioned evaluators and
suites, calibration results, execution records, and immutable policy-free
evidence. A consumer may use that evidence in a release decision, but the
decision is not part of Rubrist's evidence.

Rubrist also outputs production monitoring reports. They are ungoverned
feedback about the customer's own traffic, not evidence.

## Relationship to the other products

- **Dailies** consumes Rubrist evidence and applies customer-owned release
  policy. Rubrist does not emit `promote`, `block`, rollout, or override state.
  Production monitoring reports are not part of that evidence unless a later
  versioned contract says so.
- **Casefile** may statically inspect and lock evaluator-related capability
  artifacts. Casefile does not validate model behavior, and Rubrist does not
  perform static supply-chain trust analysis.

The products share explicit evidence contracts, not product ownership.

## Current state versus target state

Current Rubrist already imports traces, versions judging skills, records human
and model judgments, runs evaluation batches, and persists exact terminal
receipt v1 bytes as append-only artifacts with historical freeze and linked
correction lineage. It has immutable, role-bound dataset revisions with
append-only exposure history; versioned criteria and policy-free evaluator
suites; governed independent review and adjudication, including case-less
sealed intake; and owner-launched single-trial binary calibration with
aggregate-only immutable artifacts and separate current admissibility.

Rubrist now freezes a finite trace population and reproducible one-time draw,
then runs a stopped, append-only multi-label coding study with explicit
no-failure evidence, flat human-authored taxonomy revisions, historical
assignment coverage, and an immutable closure-time representative claim. The
ordinary Traces preview remains exploratory and is not this evidence path.

From one closed study, an owner can promote a current active failure code into
one immutable criterion and an exact nonsealed governed-review handoff.
Promotion preserves the supporting observation and assignment evidence,
records every development exposure, and creates no evaluator, truth,
calibration, approval, or release outcome. Blind reviewers receive only the
frozen task evidence and instructions; analysis labels and rationales remain
outside that view.

After governed criterion authoring, Rubrist now creates an explicit candidate
only from exact frozen nonsealed truth. Candidate, active, needs-review, and
retired state is append-only; implicit execution requires an active version,
a complete passed retained regression run, and currently admissible sealed
calibration evidence. Revocation appends needs-review and immediately removes
implicit eligibility even if a legacy version status says approved.

Rubrist now exposes the integrated, digest-bound component measurement view for
coding completion, named taxonomy coverage and churn, governed reviewer
disagreement, aggregate binary-calibration error direction and coverage, and
the two accepted calibration-artifact durations. Missing, running, incomplete,
revoked, and unavailable evidence remains explicit; the view creates no
composite score or authority decision.

Production outcome monitoring is now CURRENT as ungoverned development
feedback under accepted
[ADR-0013](docs/decisions/0013-production-outcome-monitoring.md). Keys with the
production-ingest capability, and owners importing a ledger, append
`rubrist/production-decision-record/v1` records to an append-only project store
that rejects conflicting decisions and future-dated records. Members build
`rubrist/production-calibration/v2` reports for boolean, choice, and score
questions over an explicit window of stored records and save them as
digest-bound snapshots; a compute-only preview of a pasted ledger remains.
Retention by receive time (90 days by default), decision erasure with
tombstones, revoked-key purges, and snapshot deletion are audited owner
operations. Ironside ingest, governed-review routing of a production sample,
and notifications remain ADR-0013 follow-ups.

The producer runtime still does not run the repeated-trial contract or
calibrate scalar and categorical evaluators. Those remaining gaps are distinct
from the retained agreement diagnostics on the legacy ungoverned review path.

These gaps are implementation facts, not permission to move release policy
into Rubrist.

## Product principles

1. Human truth and evaluator output are different kinds of evidence.
2. Missing or failed evaluation is never converted into a favorable result.
3. Validation evidence names the exact evaluator, truth revision, exposure
   role, and metric definition.
4. Provider requests and observed provider responses are distinguished.
5. Evidence stays policy-free so different consumers can reach different
   legitimate decisions from the same assessment.
6. Numeric heuristics from courses or competitors are hypotheses to test, not
   product requirements.
7. Each evaluator measures one named criterion; suites preserve separate
   criterion evidence rather than hiding it in one score.
8. Review alignment improves the rubric or resolves truth while preserving
   independent labels; it never rewrites disagreement out of history.
9. Semantic clustering is explicitly deferred and outside the current plan.
10. Production outcomes are development feedback, not human truth. They can
    direct attention and select items for governed review, but only
    independent governed review produces truth or validation evidence; the
    outcome itself never becomes either.

## Success signals

- A quality owner can explain why an evaluator is trusted and reproduce the
  evidence behind that claim.
- Evaluator changes cannot silently reuse analysis or development cases as
  sealed validation.
- A release consumer can verify evidence without trusting Rubrist's UI or a
  prose report.
- The same Rubrist evidence can support different Dailies policies without
  Rubrist changing its result.
- A quality owner can see, from records that outlive the session, when a model
  version change moved a production system's calibration on their own traffic.

## Accepted planning constraints

The accepted ADRs define native and imported human truth, four exposure-aware
dataset roles, persisted immutable receipts, classifier-style calibration,
and policy-free evaluator suites. ADR-0009 defines a separate aggregate-only
binary-calibration artifact. Rubrist currently executes and persists one sealed
binary trial, exposes owner-only artifact and admissibility reads, and records
later revocation without rewriting historical bytes. Dailies currently
verifies explicitly configured local artifacts and applies customer policy
through its config v6, policy v2, report v6, runner, and CLI; it performs no
network or latest-artifact lookup. This does not reopen product boundaries or
change receipt v1 candidate provenance.
