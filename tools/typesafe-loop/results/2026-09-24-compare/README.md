# Jev against Rubrist's LLM judge, 2026-09-24

This is the spike for issue #101. Everything here is **ASSUMPTION-class**
evidence. The data is public and nonsealed, so it isn't Rubrist governed
truth and makes no calibration claim under ADR-0004 or ADR-0009. It only
informs whether a typed-question evaluator is worth an ADR (ADR-0014).

- `report.json` is the corrected run (run 2).
- `report-run1.json` is the first run, kept for the record.

Both reports hold one row per item: id, truth, label, probability, latency,
and whether the result came from the cache. A cached row keeps the latency
measured when its call was made. The answered calls cost $34.90 across both
runs.

To rerun:

```sh
pnpm --filter @rubrist/shared --filter @rubrist/audit build
node tools/typesafe-loop/fixtures/build/compare-sets.mjs      # reproduces the committed fixtures
node --env-file=.env tools/typesafe-loop/compare.mjs \
  --judges jev-1.13.0,claude-haiku-4-5-20251001,claude-sonnet-4-6,claude-sonnet-5,claude-opus-5-5
```

## How run 2 was completed

The first Anthropic key ran out of credit partway through run 2, and the API
refused about 530 Claude calls. After the key was replaced, the same command
resumed. Failed calls are never cached, so only the refused calls were
sent, with exactly the same requests.

Three verdicts had arrived without a rationale and been rejected. They were
retried while the report was regenerated, and the retries succeeded. One
Sonnet 5 MT-Bench verdict still has no rationale.

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
| Jev | 0.775 [0.712, 0.827] | 0.944 | 0 | 257 / 297 | 0.017 |
| Haiku 4.5 | 0.764 [0.699, 0.819] (9 abstained) | 0.338 | 81 of 191 | 2,218 / 2,861 | 2.12 |
| Sonnet 4.6 | 0.750 [0.686, 0.805] | 0.700 | 64 of 200 | 3,534 / 4,846 | 6.09 |
| Sonnet 5 | 0.780 [0.718, 0.832] | 0.834 | 38 of 200 | 2,967 / 4,244 | 5.04 |
| Opus 5.5 | 0.785 [0.723, 0.836] | 0.948 | 0 | 3,980 / 6,289 | 13.47 |

On ChaosMNLI, Jev's probability also tracks the share of annotators who chose
entailment: Spearman 0.849, and Brier 0.055 against the soft label. Opus
5.5's score does the same (Spearman 0.835).

**MT-Bench, original order** (55% "A is better"):

| Judge | Accuracy | AUC | p50 / p95 ms | $ per 1k |
| --- | --- | --- | --- | --- |
| Jev | 0.860 [0.795, 0.907] | 0.938 | 258 / 646 | 0.044 |
| Haiku 4.5 | 0.793 [0.722, 0.850] | 0.773 | 3,015 / 4,129 | 3.16 |
| Sonnet 4.6 | 0.839 [0.772, 0.889] (1 abstained) | 0.907 | 5,107 / 7,334 | 9.24 |
| Sonnet 5 | 0.823 [0.753, 0.876] (1 error, 2 abstained) | 0.887 | 4,944 / 9,008 | 8.85 |
| Opus 5.5 | 0.833 [0.766, 0.884] | 0.932 | 5,395 / 8,410 | 20.25 |

Sonnet 5's error is a verdict without a rationale, which Rubrist's schema
rejects. Jev's p95 includes three cold-start calls from a dry run.

In the swapped order, accuracies were:

| Judge | Accuracy |
| --- | --- |
| Jev | 0.867 |
| Sonnet 5 | 0.847 |
| Opus 5.5 | 0.847 |
| Sonnet 4.6 | 0.826 |
| Haiku 4.5 | 0.667 |

**Order consistency on MT-Bench** is how often a judge picks the same
response when the two responses are swapped:

| Judge | Same pick in both orders |
| --- | --- |
| Jev | 143 of 150 (95%) |
| Haiku 4.5 | 81 of 150 (54%) |
| Sonnet 4.6 | 130 of 148 (88%) |
| Sonnet 5 | 128 of 147 (87%) |
| Opus 5.5 | 148 of 150 (99%) |

**Paired comparisons with Jev.** McNemar tests correctness on the same
cases; p-values are two-sided and exact.

| Against | ChaosMNLI | MT-Bench original | MT-Bench swapped | tau-bench |
| --- | --- | --- | --- | --- |
| Haiku 4.5 | p = 0.50 | p = 0.087 | p < 0.001 (Jev better) | p = 0.11 |
| Sonnet 4.6 | p = 0.42 | p = 0.45 | p = 0.18 | p = 0.86 |
| Sonnet 5 | p = 1.0 | p = 0.065 | p = 0.55 | p = 0.23 |
| Opus 5.5 | p = 0.85 | p = 0.39 | p = 0.55 | p < 0.001 (Opus better) |

`report.json` also gives paired bootstrap intervals for the differences in
accuracy and AUC.

**tau-bench** (58% pass, so always answering pass scores 0.578):

| Judge | Accuracy | AUC | p50 / p95 ms | $ per 1k |
| --- | --- | --- | --- | --- |
| Jev | 0.505 [0.412, 0.597] | 0.547 | 266 / 638 | 0.20 |
| Haiku 4.5 | 0.413 [0.325, 0.507] | 0.469 | 4,268 / 5,434 | 7.33 |
| Sonnet 4.6 | 0.523 [0.430, 0.614] | 0.519 | 8,214 / 16,770 | 22.72 |
| Sonnet 5 | 0.587 [0.493, 0.675] | 0.614 | 5,670 / 10,517 | 19.13 |
| Opus 5.5 | 0.743 [0.654, 0.816] | 0.824 | 8,639 / 13,502 | 52.80 |

Against Opus 5.5 on tau-bench, Jev's paired accuracy difference is −0.24
[−0.34, −0.14] and its AUC difference is −0.28 [−0.38, −0.18].

## What it shows, with labels

1. **ASSUMPTION: no accuracy difference was detected on short-context
   criteria.**
   - On ChaosMNLI and on MT-Bench in both orders, McNemar found no
     significant accuracy difference between Jev and Sonnet 4.6, Sonnet 5, or
     Opus 5.5.
   - Where the paired bootstrap does separate them, Jev comes out ahead:
     - on original-order MT-Bench accuracy against Sonnet 5, by 0.048
       [0.007, 0.088];
     - on AUC against both Sonnets, on several sets.
   - Against Opus 5.5, even the AUCs agree closely: the difference is −0.004
     [−0.029, 0.019] on ChaosMNLI and 0.006 [−0.015, 0.030] on MT-Bench.
   - That is not a proof of equivalence. At 150–200 cases only a gap of
     about 5–7 points would reliably show up.
   - Against Haiku 4.5, Jev is better in the swapped order and borderline in
     the original.
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
   the same response in both orders only 54% of the time, against Opus 5.5
   at 99%, Jev at 95%, and the Sonnets at 87–88%. Haiku's MT-Bench accuracy
   therefore depends on response order.
4. **CURRENT: Jev costs 0.8–1.4% of Haiku 4.5 per trace on the
   short-context sets, and 0.3–0.5% of Sonnet 4.6.** Its median latency is
   8–12% of Haiku's. On tau-bench, Opus 5.5 costs $52.80 per 1,000 traces
   against Jev's $0.20.
5. **ASSUMPTION: on long agent trajectories only Opus 5.5 works, and Jev
   doesn't.**
   - On tau-bench, Opus 5.5 is the only judge well above the always-pass
     baseline (accuracy 0.743, AUC 0.824). It is clearly better than Jev
     (McNemar p < 0.001).
   - Jev, Haiku 4.5, and Sonnet 4.6 are at chance, and Sonnet 5 is only
     slightly above.
   - Opus 5.5 ran with its default adaptive thinking; the other Claude
     judges didn't reason first. Whether reasoning is what makes the
     difference wasn't isolated.
   - Why Jev fails here is also unknown. An earlier review found Jev's AUC
     was *higher* on the longer half of tau-bench, so trace length alone
     isn't the explanation. The label is a hidden task goal checked against
     the database, which a judge must reconstruct from the trajectory.
   - Opus's result on these noisy labels also suggests the label noise
     (46 of 109 tasks have mixed rewards) isn't what holds the other judges
     back.
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
- Latency was measured at concurrency 4. Apart from three dry-run calls,
  connections were warm.
