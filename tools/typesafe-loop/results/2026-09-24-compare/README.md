# Jev against Rubrist's LLM judge, 2026-09-24

Spike for issue #101. Status: **ASSUMPTION-class diagnostics.** The data is
public and nonsealed, so this is not governed truth and makes no calibration
claim under ADR-0004 or ADR-0009. It only answers whether a Jev-backed
evaluator is worth an ADR.

`report.json` holds every number below, plus one row per item (id, truth,
label, probability, latency). Rerun with:

```sh
node tools/typesafe-loop/fixtures/build/compare-sets.mjs
node --env-file=.env tools/typesafe-loop/compare.mjs \
  --judges jev-1.13.0,claude-haiku-4-5-20251001,claude-sonnet-5
```

## What ran

| Judge | How it was called |
| --- | --- |
| `jev-1.13.0` | One `noul` question per case over `{input, output, steps}` via `POST /v1/systemone`, pinned. All 459 calls were served by `jev-1.13.0`. |
| `claude-haiku-4-5-20251001` | Rubrist's sealed-calibration path: the rubric rendered with `renderJudgePromptContent` and the default template, then `AnthropicJudgeProvider.judgeStructured` with a binary spec, temperature 0. |
| `claude-sonnet-5` | Same path. Claude 5 models reject `temperature`, which Rubrist's single-call policy always sends (#120), so this ran on the ordinary policy without temperature. Rubrist can't run this judge in production today. |

Each judge made one call per case, with no repeated trials. Both judges were
given the same criterion text: question, pass description and fail
description. The LLM's probability is its verdict `score` ("1 = strong pass, 0
= strong fail").

| Set | Cases | Truth | Criterion |
| --- | --- | --- | --- |
| ChaosMNLI | 200, seed-101 random sample of 1,599 | Pass when at least half of 100 annotators chose entailment; the share is kept as a soft label | Premise entails hypothesis |
| MT-Bench | 150, seed-103 random sample of 2,396 judged pairs | Expert majority vote; 146 of 150 have a single vote or unanimous votes | Response A is better than response B |
| tau-bench retail | 109, one trajectory per task | Environment reward (database and output check), **not human**, known to be noisy | Request resolved correctly under the retail policy |

## Results

Accuracy is shown as rate [Wilson 95%]. Latency counts only calls that
weren't served from cache. Cost per 1,000 traces uses list prices checked on
2026-09-24: Jev $0.042 per million input tokens with free output; Haiku 4.5
$1/$5; Sonnet 5 $2/$10.

| Set | Judge | Accuracy | Pass / fail recall | AUC | Brier | ECE | p50 / p95 ms | $ per 1k |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChaosMNLI | Jev | 0.775 [0.712, 0.827] | 0.476 / 0.983 | 0.944 | 0.142 | 0.152 | 264 / 338 | 0.017 |
| | Haiku 4.5 | 0.764 [0.699, 0.819] | 0.459 / 0.957 | 0.343 | 0.499 | 0.501 | 2,239 / 2,875 | 2.12 |
| | Sonnet 5 | 0.775 [0.712, 0.827] | 0.463 / 0.992 | 0.787 | 0.182 | 0.143 | 2,971 / 4,157 | 5.10 |
| MT-Bench | Jev | 0.867 [0.803, 0.912] | 0.867 / 0.866 | 0.939 | 0.098 | 0.058 | 258 / 309 | 0.043 |
| | Haiku 4.5 | 0.780 [0.707, 0.839] | 0.928 / 0.597 | 0.757 | 0.187 | 0.086 | 3,043 / 4,047 | 3.14 |
| | Sonnet 5 | 0.823 [0.753, 0.876] | 0.790 / 0.864 | 0.892 | 0.136 | 0.091 | 4,680 / 8,885 | 8.60 |
| tau-bench | Jev | 0.486 [0.394, 0.579] | 0.349 / 0.674 | 0.549 | 0.294 | 0.196 | 265 / 354 | 0.20 |
| | Haiku 4.5 | 0.431 [0.342, 0.525] | 0.159 / 0.804 | 0.501 | 0.431 | 0.436 | 4,326 / 6,142 | 7.34 |
| | Sonnet 5 | 0.606 [0.512, 0.692] | 0.746 / 0.413 | 0.635 | 0.336 | 0.324 | 5,537 / 9,599 | 19.06 |

Haiku abstained on 9 ChaosMNLI cases. Sonnet returned 2 MT-Bench verdicts
without a rationale, which Rubrist's verdict schema rejects, and abstained on
1. Jev had no errors.

## What it shows

1. **Short-context criteria: Jev is as accurate as the LLM judges.** It ties
   Sonnet on ChaosMNLI and has the highest point estimate on MT-Bench. Every
   accuracy interval overlaps, so no difference in accuracy is established at
   this sample size. On ChaosMNLI all three judges agree
   with each other about 90% of the time and share the same low pass recall
   (about 0.47). The gap to the human majority there comes from the
   criterion's wording ("definitely true") compared with a 50% annotator
   threshold, not from the model.
2. **Jev's probability behaves like a probability. The LLM verdict score
   doesn't.** Jev's AUC is 0.94 on both human-labeled sets. On ChaosMNLI its
   probability tracks the share of 100 annotators who chose entailment
   (Spearman 0.85, Brier 0.054 against the soft label). Rubrist's LLM `score`
   isn't consistently oriented: Haiku's score contradicts its own label in
   81 of 191 decided ChaosMNLI verdicts, and Sonnet's in 48 of 200. That's
   why Haiku's AUC falls below 0.5 there. Any probability-based use, such as
   #102's uncertainty selection or the per-item log in the README's drift
   replay, needs a real probability source.
3. **Long agent trajectories: Jev is at chance.** On tau-bench (about 4,800
   input tokens per case) Jev scores AUC 0.55, and its accuracy (0.49) is
   below the 0.58 you'd get by always answering pass. Sonnet's AUC (0.64) is
   the only one clearly above 0.5, and its accuracy (0.61) barely beats that
   baseline against these noisy environment-reward labels. This matches Jev's documented weakness with
   long, mostly irrelevant context. A Jev evaluator would need a guard or
   guidance for trace length.
4. **Cost and latency differ by about two orders of magnitude.** Jev costs
   $0.017–$0.20 per 1,000 traces, against $2–$7 for Haiku and $5–$19 for
   Sonnet. Its p95 latency stays under 360 ms; the LLM judges' p50 is 2.2–5.5
   seconds.
5. **Operational.** Pinning works: `jev-latest` resolved to `jev-1.13.0`, and
   every call pinned to it was served by it. Under #108's rule, `jev-latest`
   is an alias Rubrist would refuse at governed gates.

## Limits

- The data is public and isn't Rubrist governed truth. MT-Bench truth is
  mostly one expert vote. tau-bench truth is an environment reward.
- There was one run per judge with no trial variance. The samples are a few
  hundred items, and most intervals overlap.
- The LLM judges wrote a rationale; Jev can't. What a verdict without a
  rationale means as evidence is one of #101's open questions.
- Prompt injection wasn't tested.

## Decision this informs

On short-context criteria the case for an ADR is strong: comparable accuracy,
a real probability, 1–3% of Haiku's cost, and a tenth of the latency or less.
The ADR needs to settle #101's open questions: how a typed-question
evaluator is identified and digested; where its probability goes in
`assessment-receipt/v1` (ADR-0003); how evidence without a rationale is
stated; and how to guard trace length and injection. Calibration against
governed truth stays per criterion. That's exactly what this spike couldn't
do, and it's what Rubrist is for.
