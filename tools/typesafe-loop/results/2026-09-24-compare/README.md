# Jev against Rubrist's LLM judge, 2026-09-24

This is the spike for issue #101. Everything here is **ASSUMPTION-class**
evidence. The data is public and nonsealed, so it isn't Rubrist governed
truth and makes no calibration claim under ADR-0004 or ADR-0009. It only
informs whether a typed-question evaluator is worth an ADR (ADR-0014).

- `report.json` is the corrected run (run 2).
- `report-run1.json` is the first run, kept for the record.

Both reports hold one row per item: id, truth, label, probability, latency,
and whether the result came from the cache. The answered calls cost about
$22 in total.

To rerun:

```sh
pnpm --filter @rubrist/shared --filter @rubrist/audit build
node tools/typesafe-loop/fixtures/build/compare-sets.mjs      # reproduces the committed fixtures
node --env-file=.env tools/typesafe-loop/compare.mjs \
  --judges jev-1.13.0,claude-haiku-4-5-20251001,claude-sonnet-4-6,claude-sonnet-5,claude-opus-5-5
```

## Run 2 is incomplete

The Anthropic account ran out of credit during run 2. The API refused:

- all four Claude judges on 106 of the 109 tau-bench cases;
- Opus 5.5 on 106 of the 150 swapped-order MT-Bench cases.

Failed calls aren't cached, so rerunning after a top-up pays only for those
calls. The tau-bench comparison below therefore falls back to run 1, which
used a different transport.

## What each judge was sent

Every Claude request used Rubrist's verdict protocol: the rubric rendered
with `renderJudgePromptContent` and the default template, then
`AnthropicJudgeProvider.judgeStructured` with a binary spec. The per-judge
differences are listed below; each is also recorded in
`report.json` → `judges[].transport`.

| Judge | Request as sent |
| --- | --- |
| `jev-1.13.0` | One `noul` question over `{input, output, steps}`. Every answer reported `jev-1.13.0`; a response that didn't report the pinned model would have been an error. |
| `claude-haiku-4-5-20251001` | One physical call, no SDK retries, temperature 0. This is Rubrist's exact request. |
| `claude-sonnet-4-6` (Rubrist's seeded default) | Same as Haiku. |
| `claude-sonnet-5` | Same, but without `temperature`, which the model rejects (#120). |
| `claude-opus-5-5` | Same, but without `temperature` and with `tool_choice: auto`. The model rejects both the parameter and a forced tool choice (#120). |

All Claude runs came before #121, so their instructions didn't say which way
the binary score points. The Claude probability is the verdict `score`.
Before #121 many judges reported confidence in their own label instead, so
`report.json` also gives `scoreContradictsLabel` and
`aucIfScoreIsOwnLabelConfidence` as a sensitivity check.

## Sets

| Set | Cases | Truth | Sampling frame |
| --- | --- | --- | --- |
| ChaosMNLI | 200 | Pass when at least half of 100 annotators chose entailment; the entailment share is kept as a soft label | Seed-101 random sample of the 1,592 items with premises up to 600 characters |
| MT-Bench | 150, run in both orders | Expert majority vote; 146 of the 150 pairs have one vote or unanimous votes | Seed-103 random sample of 1,632 pairs, drawn from 2,396 after dropping 691 without a strict majority and 73 over 9,000 characters. Cases name the judged turn. |
| tau-bench retail | 109 | Environment reward, **not human** and known to be noisy | Seed 107, one trajectory per task. Tasks were limited to trajectories up to 24,000 characters, which excluded 6 of 115 tasks and dropped long trials from 23 more. |

## Results (run 2)

- Accuracy covers the verdicts each judge decided, as rate [Wilson 95%].
  `report.json` also gives accuracy with abstentions and errors counted as
  wrong.
- Latency counts only calls that weren't served from the cache.
- Cost per 1,000 traces uses list prices checked on 2026-09-24:
  - Jev: $0.042 per million input tokens; output is free.
  - Haiku 4.5: $1/$5 per million input/output tokens.
  - Sonnet 4.6: $3/$15.
  - Sonnet 5: $2/$10.
  - Opus 5.5: $4/$20.

**ChaosMNLI** (41% pass):

| Judge | Accuracy | AUC | Score contradicts its own label | p50 / p95 ms | $ per 1k |
| --- | --- | --- | --- | --- | --- |
| Jev | 0.775 [0.712, 0.827] | 0.944 | 0 | 257 / 296 | 0.017 |
| Haiku 4.5 | 0.764 [0.699, 0.819] (9 abstained) | 0.338 | 81 of 191 | 2,218 / 2,861 | 2.12 |
| Sonnet 4.6 | 0.750 [0.686, 0.805] | 0.700 | 64 of 200 | 3,534 / 4,880 | 6.09 |
| Sonnet 5 | 0.780 [0.718, 0.832] | 0.834 | 38 of 200 | 2,969 / 4,246 | 5.04 |
| Opus 5.5 | 0.785 [0.723, 0.836] | 0.948 | 0 | 3,981 / 6,332 | 13.47 |

On ChaosMNLI, Jev's probability also tracks the share of annotators who chose
entailment: Spearman 0.849, and Brier 0.055 against the soft label. Opus
5.5's score does the same (Spearman 0.835).

**MT-Bench, original order** (55% "A is better"):

| Judge | Accuracy | AUC | p50 / p95 ms | $ per 1k |
| --- | --- | --- | --- | --- |
| Jev | 0.860 [0.795, 0.907] | 0.938 | 257 / 311 | 0.044 |
| Haiku 4.5 | 0.793 [0.722, 0.850] | 0.773 | 3,015 / 4,129 | 3.16 |
| Sonnet 4.6 | 0.839 [0.772, 0.889] (1 abstained) | 0.907 | 5,110 / 7,292 | 9.24 |
| Sonnet 5 | 0.829 [0.759, 0.881] (2 errors, 2 abstained) | 0.894 | 4,944 / 8,517 | 8.81 |
| Opus 5.5 | 0.833 [0.766, 0.884] | 0.932 | 5,418 / 8,410 | 20.25 |

Sonnet 5's two errors were verdicts without a rationale, which Rubrist's
schema rejects.

**Order consistency on MT-Bench** is how often a judge picks the same
response when the two responses are swapped:

| Judge | Same pick in both orders |
| --- | --- |
| Jev | 143 of 150 (95%) |
| Haiku 4.5 | 81 of 150 (54%) |
| Sonnet 4.6 | 130 of 148 (88%) |
| Sonnet 5 | 127 of 145 (88%) |
| Opus 5.5 | 43 of 44 (the swapped run is partial) |

**Paired comparisons with Jev.** McNemar tests correctness on the same
cases; p-values are two-sided and exact.

| Against | ChaosMNLI | MT-Bench original | MT-Bench swapped |
| --- | --- | --- | --- |
| Haiku 4.5 | p = 0.50 | p = 0.087 | p < 0.001 (Jev better) |
| Sonnet 4.6 | p = 0.42 | p = 0.45 | p = 0.18 |
| Sonnet 5 | p = 1.0 | p = 0.11 | p = 0.55 |
| Opus 5.5 | p = 0.85 | p = 0.39 | partial |

`report.json` also gives paired bootstrap intervals for the differences in
accuracy and AUC.

**tau-bench.**
- In run 2, Jev scored accuracy 0.505 [0.412, 0.597] and AUC 0.547. Always
  answering pass would score 0.578.
- The Claude judges have 3 answered cases each in run 2, which isn't enough
  to compare.
- Run 1 sent the same prompt pre-#121, on the ordinary transport (SDK
  retries on, Sonnet 5 without temperature). It gave:

  | Judge | Accuracy | AUC |
  | --- | --- | --- |
  | Jev | 0.486 | 0.549 |
  | Haiku 4.5 | 0.431 | 0.501 |
  | Sonnet 5 | 0.606 | 0.635 |

## What it shows, with labels

1. **ASSUMPTION: no accuracy difference was detected on short-context
   criteria.** On ChaosMNLI and on MT-Bench in its original order, no paired
   test found a significant difference between Jev and Sonnet 4.6, Sonnet 5,
   or Opus 5.5. That is not a proof of equivalence: on original-order
   MT-Bench, Jev against Sonnet 5 is p = 0.11, with a paired difference CI of
   [0, 0.082]. Against Haiku 4.5, Jev is better in the swapped order and
   borderline in the original.
2. **ASSUMPTION: on these sets Jev's probability is at least as well ordered
   as the LLM scores.**
   - Jev's AUC is 0.94 on both human-labeled sets. Opus 5.5, whose score
     follows its label, matches it on ChaosMNLI.
   - The weaker LLM AUCs are partly the pre-#121 orientation problem.
     Re-reading each score as confidence in its own label raises Haiku's
     ChaosMNLI AUC to 0.81.
   - A rerun after #121 is needed before comparing probability quality
     further.
3. **ASSUMPTION: Haiku 4.5 strongly prefers the first response.** It picks
   the same response in both orders only 54% of the time. Jev is at 95% and
   the Sonnets at 88%. Haiku's MT-Bench accuracy therefore depends on
   response order.
4. **CURRENT: Jev costs 0.8–1.4% of Haiku 4.5 per trace on these sets, and
   0.3–0.5% of Sonnet 4.6.** Its median latency is 8–12% of Haiku's.
5. **ASSUMPTION: long agent trajectories are unresolved.**
   - Jev is at chance on tau-bench, below the always-pass baseline.
   - In run 1, Haiku was at chance too and Sonnet 5 was only weakly above it.
   - An earlier review found Jev's AUC was *higher* on the longer half of
     tau-bench, so trace length isn't established as the cause.
   - The label (a hidden task goal checked against the database) and its
     noise (46 of 109 tasks have mixed rewards) explain it at least as well.
   - Finishing run 2 would settle whether any judge does well here.
6. **CURRENT:**
   - Rubrist can't run Sonnet 5 or Opus 5.5 with its own request today
     (#120); the rows above needed the listed deviations.
   - Pinning works: every Jev answer reported `jev-1.13.0`.
   - Under #108, `jev-latest` is an alias that Rubrist refuses at governed
     gates.

## Limits

- The data is public, not governed truth. MT-Bench truth is mostly one
  expert vote, and tau-bench truth is an environment reward.
- All the datasets are public, so any of these models may have seen them in
  training.
- Each judge ran once, with no repeated trials. Sonnet 4.6 and Haiku ran at
  temperature 0; Sonnet 5 and Opus 5.5 ran at the provider default.
- Prompt injection wasn't tested.
- Latency was measured at concurrency 4 on warm connections.
- Run 2 is incomplete; see above.
