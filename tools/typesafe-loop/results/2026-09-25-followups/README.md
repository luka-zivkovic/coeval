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
values, and the Opus answers predate #121. A larger sample with fresh Opus
answers is the next step. It needs a working Anthropic key.

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

## Blocked on a new Anthropic key

The key in `.env` started returning 401 on 2026-09-25. These runs are ready
in `compare.mjs` but not yet made:

- the Claude judges rerun after #121;
- Opus 5.5 on a larger sample for the cascade;
- `claude-opus-5-5@thinking-disabled` and `claude-sonnet-5@thinking-adaptive`
  on tau-bench, to test whether reasoning explains Opus's lead.
