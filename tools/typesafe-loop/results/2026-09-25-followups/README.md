# Follow-ups to the Jev comparison, 2026-09-25

These are ASSUMPTION-class diagnostics on the same public data as
`../2026-09-24-compare`. None of it is governed truth or a calibration claim.

## 1. Held-out cascade (`cascade-heldout.json`)

**Question.** Jev answers every case, and a case goes to Opus 5.5 when Jev's
probability is within a band of 0.5. Does that beat either judge alone when
the band isn't tuned on the cases it's scored on?

**Method.** `cascade.mjs` reads the recorded run-2 answers, so no new API
calls were made. It splits each set into two folds by a seeded hash of the
case id, picks the band on one fold, and scores it on the other. Ties go to
the smaller, cheaper band. The accuracy below pools the two held-out folds.

| Set | Jev alone | Opus alone | Cascade, held out | Sent to Opus | $ per 1,000 |
| --- | --- | --- | --- | --- | --- |
| ChaosMNLI (200) | 0.775 | 0.785 | 0.800 [0.739, 0.850] | 29% | 3.92 vs Opus 13.47 |
| MT-Bench (150) | 0.860 | 0.833 | 0.873 [0.811, 0.917] | 6% | 1.26 vs Opus 20.25 |
| MT-Bench swapped (150) | 0.867 | 0.847 | 0.873 [0.811, 0.917] | 6% | 1.26 vs Opus 20.30 |
| tau-bench (109) | 0.505 | 0.743 | 0.743 [0.654, 0.816] | 91% | 48.16 vs Opus 52.80 |

**What it shows.** On the short sets the held-out cascade was at least as
accurate as either judge alone, at 6–29% of Opus's cost. The intervals
overlap, so "at least as accurate" is the claim, not "more accurate". On
tau-bench Jev's probability doesn't say which cases it gets wrong, so the
cascade only matches Opus by sending it almost everything.

**Limits.** The folds hold 75–100 cases each, the bands are chosen from 11
values, and the Opus answers predate #121. Section 5 tests the cascade on
1,000 new cases, and the result doesn't hold up.

## 2. tau-bench decomposed into short questions (`decomposed-report.json`)

**Question.** Does Jev do better on agent trajectories when the one broad
criterion is split into short yes/no questions?

**Method.** Six positive questions were written from the retail policy
before any decomposed result was seen. They are in
`fixtures/compare/taubench/decomposed.json`. All six are asked in one Jev
call (`jev-1.13.0@decomposed`). A run passes only if every question holds,
and its probability is the smallest of the six.

| Judge | Accuracy | AUC |
| --- | --- | --- |
| Jev, one question | 0.505 [0.412, 0.597] | 0.547 |
| Jev, six questions | 0.560 [0.466, 0.649] | 0.617 |
| Opus 5.5 (run 2, for reference) | 0.743 [0.654, 0.816] | 0.824 |

- **Paired comparison.** The accuracy gain isn't significant (McNemar
  p = 0.21). The AUC gain is small but real: paired bootstrap 0.07
  [0.003, 0.14].
- **AUC of each question alone:**

  | Question | AUC |
  | --- | --- |
  | `right_action` | 0.68 |
  | `resolved` | 0.61 |
  | `permitted` | 0.50 |
  | `changes_confirmed` | 0.49 |
  | `truthful` | 0.49 |
  | `identity_verified` | 0.45 |

**What it shows.** Almost all the signal comes from whether the agent's
actions matched the request. The policy-procedure questions carry none on
these labels. That fits a label that checks the final database state
against a hidden goal, not procedure. Decomposition narrows the gap to Opus
but doesn't close it.

**Limits.**

- The questions were written by the same person who saw Jev fail on the
  single question.
- The per-question AUCs are one post-hoc reading.
- The tau-bench label is an environment reward, not a person.

## 3. The Claude judges rerun after #121 (`post121-report.json`)

**Question.** #121 put the score's direction ("1 means a strong pass") into
the instructions. Before it, several Claude judges read the score as
confidence in their own verdict. Does the fix change their verdicts or their
probability quality?

**Method.** The same four sets and five judges, with the post-#121 request.
The request changed, so the cache missed and every Claude call was new. Jev's
request didn't change, so its answers are the recorded ones. About $29 of
Anthropic spend.

**Scores that contradict their own label** (a fail with a score above 0.5,
or the reverse):

| Judge | ChaosMNLI before | after |
| --- | --- | --- |
| Haiku 4.5 | 81 | 0 |
| Sonnet 4.6 | 64 | 0 |
| Sonnet 5 | 38 | 0 |
| Opus 5.5 | 0 | 0 |

Across all four sets, after the fix, one Sonnet 5 score on each MT-Bench
order still contradicted its label.

**AUC, before → after.** "Before" is the published run in
`../2026-09-24-compare/report.json`.

| Judge | ChaosMNLI | MT-Bench | MT-Bench swapped | tau-bench |
| --- | --- | --- | --- | --- |
| Jev (unchanged) | 0.944 | 0.938 | 0.940 | 0.547 |
| Haiku 4.5 | 0.338 → 0.896 | 0.773 → 0.793 | 0.713 → 0.794 | 0.469 → 0.414 |
| Sonnet 4.6 | 0.700 → 0.916 | 0.907 → 0.904 | 0.901 → 0.893 | 0.519 → 0.561 |
| Sonnet 5 | 0.834 → 0.929 | 0.887 → 0.892 | 0.906 → 0.914 | 0.614 → 0.632 |
| Opus 5.5 | 0.948 → 0.950 | 0.932 → 0.935 | 0.933 → 0.934 | 0.824 → 0.818 |

**Accuracy** moved by at most 0.053 (Haiku, swapped order), and verdicts
flipped on 2–12 cases per judge and set. There is no repeat of the Claude
judges with the same request, so these flips can't be split between the fix
and ordinary non-determinism.

**Paired against Jev after the fix:**
- **Opus 5.5.** No accuracy difference on ChaosMNLI (p = 0.83), MT-Bench
  (p = 0.55) or the swapped order (p = 0.07). The AUC differences were
  −0.006, 0.003 and 0.006, with intervals that straddle zero.
- **Sonnet 4.6 and Sonnet 5.**
  - No accuracy difference on ChaosMNLI.
  - On MT-Bench, Jev's AUC was higher by 0.035 and 0.047, and on the
    swapped order by 0.047 and 0.028. The intervals exclude zero or touch it.
  - On the swapped order, Jev's accuracy was higher than Sonnet 4.6's by
    0.054 [0.007, 0.101] (McNemar p = 0.057).
- **Haiku 4.5.** Jev beat it on AUC everywhere. On the swapped order it also
  beat it on accuracy, by 0.147 (p < 0.001).
- **tau-bench.** Unchanged: Opus beat Jev by 0.24 in accuracy (p < 0.001)
  and by 0.27 in AUC.

**Keeping the same pick when the answer order is swapped:**

| Judge | Before | After |
| --- | --- | --- |
| Opus 5.5 | 0.987 | 0.966 |
| Jev (unchanged) | 0.953 | 0.953 |
| Sonnet 4.6 | 0.878 | 0.899 |
| Sonnet 5 | 0.871 | 0.865 |
| Haiku 4.5 | 0.540 | 0.591 |

**What it shows.**
- The fix removed the contradiction. The low ChaosMNLI AUCs reported for
  Haiku and Sonnet 4.6 were mostly our prompt, not the models.
- On short criteria every post-fix Claude judge's probability is useful.
  Jev's is still as good as Opus's and at least as good as the Sonnets'.
- The tau-bench picture doesn't change.
- **Missing rationale.** Sonnet 5 left out the required `rationale` in 8 of
  300 MT-Bench verdicts under the forced tool call. Those count as errors,
  because the rerun didn't retry them. Native structured output, as
  ADR-0014's protocols plan, is the fix.

## 4. Does reasoning explain Opus's tau-bench lead? (`variants-report.json`)

**Question.** Opus 5.5 reasons by default, and the other judges didn't. Is
that why only Opus beats chance on tau-bench?

**Method.** Two new variants on the same 109 runs, with the post-#121
request:
- `claude-opus-5-5@effort-low`: `output_config.effort` set to `low`.
  Opus 5.5 refuses `thinking: disabled`, so this is the closest to "less
  reasoning" it accepts.
- `claude-sonnet-5@thinking-adaptive`: tool choice `auto`, adaptive
  thinking, and at least 16,000 output tokens.

About $10.

| Judge | Accuracy | AUC | $ per 1,000 | p50 / p95 latency |
| --- | --- | --- | --- | --- |
| Opus 5.5 (default: adaptive) | 0.743 [0.654, 0.816] | 0.818 | 52.92 | 8.8 / 11.5 s |
| Opus 5.5, effort low | 0.725 [0.634, 0.800] | 0.783 | 47.54 | 6.2 / 8.3 s |
| Sonnet 5 (no thinking) | 0.596 [0.502, 0.684] | 0.632 | 19.02 | 5.1 / 10.4 s |
| Sonnet 5, adaptive thinking | 0.633 [0.539, 0.718] | 0.669 | 43.41 | 25.7 / 72.1 s |

- **Opus at low effort.** Its accuracy didn't change detectably
  (McNemar p = 0.63). Its AUC fell slightly, by 0.034 [0.006, 0.066]. The
  saving was about 10% of the cost.
- **Sonnet 5 with adaptive thinking.** Not detectably better than without it
  (p = 0.48, AUC +0.037 [−0.045, 0.126]), at 2.3× the cost and 5× the median
  latency.
- **Against Opus.** Sonnet 5 with thinking still trailed default Opus by
  0.11 in accuracy (p = 0.05) and by 0.15 [0.08, 0.23] in AUC.

**What it shows.** On these runs, Opus's tau-bench lead doesn't come from
reasoning effort: Opus keeps it at low effort, and thinking doesn't give it
to Sonnet 5. The model is the likelier explanation. This is one sample of
109 labels from an automated check, so it rules out a large reasoning
effect, not a small one.

## 5. 1,000 new cases, and the cascade out of sample (`extra-report.json`, `cascade-transfer.json`, `cascade-heldout-extra.json`)

**Question.** Do the short-criterion results hold on a larger sample? Does a
cascade band chosen on the first sets work on cases it has never seen?

**Method.**
- **Cases.** `compare-sets.mjs` drew the next 500 ChaosMNLI items and the
  next 500 MT-Bench pairs in the same seeded order. They are disjoint from
  the first sets, and MT-Bench runs in the original order only.
- **Judges.** Jev, and Opus 5.5 with the post-#121 request. About $17.

**Results.**

| Set | Jev | Opus 5.5 | Paired |
| --- | --- | --- | --- |
| ChaosMNLI (500) | 0.764 [0.725, 0.799], AUC 0.915 | 0.742 [0.702, 0.778], AUC 0.917 | McNemar p = 0.16; accuracy +0.022 [−0.006, 0.050] for Jev; AUC −0.002 [−0.017, 0.013] |
| MT-Bench (500) | 0.842 [0.807, 0.871], AUC 0.926 | 0.878 [0.846, 0.904] of 493 answered, AUC 0.938 | McNemar p = 0.011; accuracy −0.032 [−0.057, −0.008] for Jev; AUC −0.013 [−0.026, 0.000] |

- **Opus non-answers.** On MT-Bench, Opus abstained on 5 pairs and failed
  on 2. Counting those as wrong, its accuracy is 0.866.
- **Calibration error (ECE).** Jev 0.037 vs Opus 0.050 on MT-Bench, and
  0.151 vs 0.185 on ChaosMNLI.

**Cascade, band chosen on the first sets and scored on the new ones:**

| Set | Band | Sent to Opus | Cascade | Jev alone | Opus alone | $ per 1,000 |
| --- | --- | --- | --- | --- | --- | --- |
| ChaosMNLI (500) | 0.30 | 32% | 0.748 [0.708, 0.784] | 0.764 | 0.742 | 4.41 |
| MT-Bench (493) | 0.05 | 3% | 0.852 [0.818, 0.881] | 0.846 | 0.878 | 0.76 |

**Cascade, two folds within the new cases** (the section 1 method):

| Set | Bands | Sent to Opus | Cascade | $ per 1,000 |
| --- | --- | --- | --- | --- |
| ChaosMNLI (500) | 0, 0.10 | 5% | 0.762 [0.723, 0.797] | 0.70 |
| MT-Bench (493) | 0.25, 0.35 | 30% | 0.874 [0.842, 0.901] | 6.28 vs Opus 20.62 |

**What it shows.**
- **A gap below what the first samples could detect.**
  - On MT-Bench, Opus is more accurate than Jev by about three points. The
    first run's 150 pairs couldn't have seen that; they could detect five
    to seven. The AUC difference is small and its interval touches zero.
  - On ChaosMNLI there is still no difference.
- **The first cascade result doesn't hold.** Section 1 found the cascade at
  least as accurate as either judge alone, at 6–29% of Opus's cost. A band
  chosen on 150–200 cases didn't carry over:
  - On ChaosMNLI it sent 32% of cases to a judge that was no better, and
    ended below Jev alone.
  - On MT-Bench it sent almost nothing, and stayed at Jev's accuracy.
- **What does work.** With two folds of about 250 new cases each, the MT-Bench
  cascade matched Opus's accuracy at 30% of its cost. It escalated 30% of
  pairs.
- **The practical reading.** Where a stronger judge is better by a few
  points, a cascade can recover most of that for a fraction of the cost.
  But the band has to be tuned per criterion on a few hundred labelled
  cases, and re-checked, because at 150–200 cases the sign of the gap isn't
  even stable.

**Limits.**
- One run of each judge.
- MT-Bench labels mostly rest on one expert's vote.
- The paired intervals come from a bootstrap over the cases, not from
  repeated runs.

