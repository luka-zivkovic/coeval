# Analyze journey

Status: **implemented product-language contract**

Last reviewed: 2026-08-27

## The question Analyze answers

> Review a reproducible sample of recent runs, describe what went wrong in
> your own words, organize those observations into failure types you name, and
> turn one important type into a criterion.

Analyze is the discovery and authoring stage of Coeval. It does not cluster
findings automatically, create human truth, approve an evaluator, calibrate an
evaluator, or decide whether a release ships.

## Beginner journey

1. **Choose runs to review.** Pick a recent time window and a sample size.
   Coeval freezes the eligible frame and performs the reproducible draw.
2. **Review the sample.** Open each selected run, record one or more exact
   failure observations with a rationale and evidence anchor, or record that
   no failure was observed. Unfinished items stay visible.
3. **Organize findings.** Create a flat list of human-authored failure types
   and assign each observation to one type. Coeval does not infer, cluster,
   merge, or split types.
4. **Create a criterion.** After the study is closed, choose one failure type
   and supporting observations. Promotion creates one immutable criterion and
   a governed nonsealed review handoff—nothing more.

## First-value moment

The first-value moment is seeing human-authored findings with exact aggregate
counts and links back to the review queue. Project owners can additionally
inspect per-type promotion counts and their exact reviewed runs before creating
a criterion. It is not a generated cluster, score, prevalence estimate, or
“trusted evaluator” claim.

## Product language

| Internal or expert term | Beginner language | Consequence to explain |
| --- | --- | --- |
| population / frame | eligible runs in this time window | The result can apply only to this frozen set. |
| draw / fixed K | review sample / sample size | Coeval chooses the sample; the caller cannot choose rows or the seed. |
| study | analysis | One append-only review of one exact sample. |
| open coding | review runs | Observations are human-authored and remain attributable. |
| taxonomy / code | failure types / failure type | The list is flat and human-authored. |
| taxonomy coverage | organized findings | Missing and uncategorized observations remain visible. |
| close study | finish review | Unfinished work remains missing; closing does not complete it. |
| promote code | create criterion | Creates a criterion and review handoff only. |
| representativeOfPopulationId | applies to this exact frozen set | This claim exists only after every selected item is completed. |
| digest, seed, RNG, revision ID | technical evidence | Available for audit, not required to follow the default journey. |

## Banned or qualified language

- Do not say **cluster**, **clustered findings**, **AI-generated categories**,
  or imply semantic similarity. Taxonomy v1 is flat and human-authored.
- Do not say **ground truth** or **human truth** for analysis observations.
  Coding evidence helps author a criterion but is not governed truth.
- Do not say **production prevalence**, **overall failure rate**, or
  **representative sample** without the exact finite-frame eligibility and
  completion qualifier.
- Do not say criterion promotion creates or approves an evaluator. It creates
  only the criterion and exact governed-review handoff.
- Do not expose `K`, idempotency keys, seeds, digests, revision IDs, or state
  machine names in the default path. Keep them in Technical evidence.

## Durable receipts and evidence

- Starting records the exact frozen frame, server draw, and immutable sample.
- Every observation, withdrawal, assignment, reopen, and completion is
  append-only.
- Finishing records selected, viewed, completed, and missing denominators.
- Organizing records coverage against one exact taxonomy revision.
- Criterion creation records the exact failure type, supports, actor,
  development exposures, and handoff.

The default UI may simplify the language, but it must not hide missing work,
change evidence class, or broaden what the evidence can prove.
