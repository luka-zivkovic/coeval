# ADR-0004: Calibration semantics

Status: **Accepted**

Date: 2026-08-22

## Context

Current judge-versus-human reporting uses inter-rater agreement machinery.
That is useful diagnostics, but a governed evaluator compared with human truth
is more directly evaluated as a classifier. Scalar and categorical evaluators
need different definitions and can accidentally import release policy into
Coeval if thresholds are chosen carelessly.

## Decision

Start calibration with binary evaluators on an immutable sealed-validation
revision. Every calibration declares the positive class and explicitly names:

- a **false pass**: the evaluator says `pass` while human truth says `fail`;
- a **false fail**: the evaluator says `fail` while human truth says `pass`.

Report at least:

- the full confusion matrix;
- accuracy, precision, recall/sensitivity (TPR), specificity (TNR), and F1;
- total support, per-class support, class balance, and evaluated coverage;
- false-pass and false-fail counts regardless of which class is positive;
- confidence intervals with a versioned interval method for every primary rate;
- abstained, errored, and otherwise unevaluated counts; and
- evaluator version, truth revision and exposure state, metric-definition
  version, trial configuration, and observed provider provenance.

Keep Cohen's kappa for human-human agreement and as an optional diagnostic for
judge-human comparison. Do not use it as the primary claim that an evaluator
is valid.

Coeval reports measurements and uncertainty without a universal pass
threshold. It identifies undefined or weakly supported metrics rather than
substituting a favorable value. A customer's required TPR, TNR, precision,
coverage, confidence, or sample size is policy and belongs in Dailies or
another consumer.

If repeated trials are used to characterize a nondeterministic evaluator,
Coeval preserves trial identity and reports the observed distribution or
variance. It does not hide trial disagreement behind an unqualified mean.

If a consumer asks Coeval to estimate production failure prevalence, any
confusion-matrix correction or bootstrap interval is a separately named,
versioned estimate with its assumptions and sampling frame. It is not silently
substituted for the observed rate.

Categorical calibration requires an explicit per-class or one-vs-rest
definition before implementation. Scalar calibration is deferred until the
meaning of an error and any threshold can be defined without smuggling release
policy into Coeval.

Blind review means raters do not see the evaluator result before supplying the
reference judgment. Numeric course heuristics are starting hypotheses, not
hard-coded requirements.

## Consequences

- The first valid calibration slice is intentionally binary and sealed.
- Coverage and abstention remain visible instead of disappearing into one
  score.
- Small or imbalanced samples expose uncertainty instead of producing false
  precision.
- This ADR defines the measurement, not its cross-product transport; ADR-0003
  must settle that separately.
