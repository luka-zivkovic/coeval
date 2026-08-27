# Coeval positioning note

Status: **time-sensitive market context; not product authority**

Last verified against linked official documentation: 2026-08-22

Refresh this note before using it in external claims. `PRODUCT.md` and accepted
ADRs define Coeval even when competitors change.

## Category context

Several mature products already combine traces, datasets, experiments, human
annotation, and automated evaluators:

- [Langfuse annotation queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues)
  support domain-expert scoring and comments on traces, observations, and
  sessions. Its
  [judge-calibration workflow](https://langfuse.com/guides/llm-as-a-judge-calibration-skill)
  can report a confusion matrix, precision, recall, F1, TPR, and TNR.
- [Arize Phoenix](https://arize.com/docs/phoenix/) is an open-source
  observability and evaluation platform. Its
  [experiment workflow](https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments)
  connects datasets, tasks, code or LLM evaluators, trace inspection, and
  failure-mode review.
- [Braintrust evaluations](https://www.braintrust.dev/docs/evaluate) span
  playground iteration, immutable experiments, CI, production scoring, and
  human feedback. Its
  [experiment runner](https://www.braintrust.dev/docs/evaluate/run-evaluations)
  also supports repeated trials for variance.

These are real overlaps, not straw competitors. Coeval should not claim that
trace review, datasets, experiments, human annotation, evaluator calibration,
or immutable experiment history are unique.

## Intended wedge

Coeval's differentiated product thesis is the governed path from observed
failure to independently verifiable evaluator evidence:

1. representative traces become open failure codes and a reviewable taxonomy;
2. each important failure mode becomes a narrow criterion;
3. human truth retains independent labels, rationale, adjudication, and
   exposure provenance;
4. each evaluator is calibrated as a classifier on a sealed revision with
   uncertainty visible;
5. policy-free suites preserve separate criterion evidence; and
6. exact execution produces persisted, verifiable assessment receipts for
   external consumers.

The defensible claim is not “another eval dashboard.” It is truth lineage,
evaluator-governance discipline, and portable evidence whose release meaning
is intentionally decided elsewhere.

## What Coeval must prove

- The analyze-to-measure workflow helps teams find and encode real failure
  modes faster and more consistently than ad-hoc dataset work.
- Exposure-aware data roles prevent misleading validation claims in practice.
- Human review and calibration evidence make evaluator weaknesses easier to
  understand, not merely more formally recorded.
- Persisted receipts are useful to independent release consumers such as
  Dailies.

Until comparative tests establish those outcomes, they remain product
hypotheses rather than superiority claims.
