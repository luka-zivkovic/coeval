# Coeval product charter

Status: **active target-state charter**

Last reviewed: 2026-08-23

This document is the source of truth for what Coeval is becoming. The README,
architecture notes, UI copy, plans, and code may describe current behavior,
but they do not override this charter. Accepted ADRs in `docs/decisions/` may
refine it. Proposed ADRs record an open decision and are not yet binding.

## User and job

Coeval serves the quality owner responsible for discovering how an AI system
fails, turning that understanding into human-reviewed criteria, and governing
evaluators that can be trusted and reused.

The job is:

> Analyze representative traces, define how each important failure mode should
> be judged, validate those evaluators against reviewed human truth, execute
> exact versions, and preserve what happened as policy-free evidence.

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

Coeval's loop deliberately begins before a finished rubric exists. It supports
trace imports and dataset-first workflows, helps reviewers turn observed
failures into narrow criteria, and preserves independent review and
adjudication history. These are evaluator-governance activities, not release
automation. Semantic clustering may later assist analysis, but it is explicitly
deferred and is not required for this loop.

## Coeval owns

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

## Decisions Coeval makes

- What label, score, category, or abstention an evaluator produced.
- Whether an evaluator was measured against human truth, against which
  immutable revision, with which exposure state and metric definition.
- Whether assessment evidence is complete enough to describe what happened.

## Decisions Coeval does not make

- Whether a customer's product change should ship.
- Acceptable pass-rate, regression, cost, or latency thresholds for a release.
- Rollout percentages, deployment promotion, rollback, or overrides.
- Whether a static agent capability artifact is safe to install.

## Inputs and outputs

Inputs include representative traces or cases, native human reviews or
externally reviewed truth, failure codes and criteria, evaluator definitions,
requested model bindings, and immutable dataset revisions.

Outputs include review and taxonomy provenance, versioned evaluators and
suites, calibration results, execution records, and immutable policy-free
evidence. A consumer may use that evidence in a release decision, but the
decision is not part of Coeval's evidence.

## Relationship to the other products

- **Dailies** consumes Coeval evidence and applies customer-owned release
  policy. Coeval does not emit `promote`, `block`, rollout, or override state.
- **Casefile** may statically inspect and lock evaluator-related capability
  artifacts. Casefile does not validate model behavior, and Coeval does not
  perform static supply-chain trust analysis.

The products share explicit evidence contracts, not product ownership.

## Current state versus target state

Current Coeval already imports traces, versions judging skills, records human
and model judgments, runs evaluation batches, and persists exact terminal
receipt v1 bytes as append-only artifacts with historical freeze and linked
correction lineage. It has immutable, role-bound dataset revisions with
append-only exposure history; versioned criteria and policy-free evaluator
suites; governed independent review and adjudication, including case-less
sealed intake; and owner-launched single-trial binary calibration with
aggregate-only immutable artifacts and separate current admissibility.

Coeval now freezes a finite trace population and reproducible one-time draw,
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

After governed criterion authoring, Coeval now creates an explicit candidate
only from exact frozen nonsealed truth. Candidate, active, needs-review, and
retired state is append-only; implicit execution requires an active version,
a complete passed retained regression run, and currently admissible sealed
calibration evidence. Revocation appends needs-review and immediately removes
implicit eligibility even if a legacy version status says approved.

Coeval now exposes the integrated, digest-bound component measurement view for
coding completion, named taxonomy coverage and churn, governed reviewer
disagreement, aggregate binary-calibration error direction and coverage, and
the two accepted calibration-artifact durations. Missing, running, incomplete,
revoked, and unavailable evidence remains explicit; the view creates no
composite score or authority decision.

The producer runtime still does not run the repeated-trial contract or
calibrate scalar and categorical evaluators. Those remaining gaps are distinct
from the retained agreement diagnostics on the legacy ungoverned review path.

These gaps are implementation facts, not permission to move release policy
into Coeval.

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

## Success signals

- A quality owner can explain why an evaluator is trusted and reproduce the
  evidence behind that claim.
- Evaluator changes cannot silently reuse analysis or development cases as
  sealed validation.
- A release consumer can verify evidence without trusting Coeval's UI or a
  prose report.
- The same Coeval evidence can support different Dailies policies without
  Coeval changing its result.

## Accepted planning constraints

The accepted ADRs define native and imported human truth, four exposure-aware
dataset roles, persisted immutable receipts, classifier-style calibration,
and policy-free evaluator suites. ADR-0009 defines a separate aggregate-only
binary-calibration artifact. Coeval currently executes and persists one sealed
binary trial, exposes owner-only artifact and admissibility reads, and records
later revocation without rewriting historical bytes. Dailies currently
verifies explicitly configured local artifacts and applies customer policy
through its config v6, policy v2, report v6, runner, and CLI; it performs no
network or latest-artifact lookup. This does not reopen product boundaries or
change receipt v1 candidate provenance.
