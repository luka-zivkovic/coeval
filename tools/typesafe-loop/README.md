# TypeSafe loop experiments

Status: **ASSUMPTION-class diagnostics.** Nothing here is governed evidence.
The experiments run on nonsealed synthetic fixtures, produce no calibration
claim under ADR-0004 or ADR-0009, and do not touch the API, the database, or
any evaluator lineage. They exist to test three ideas from the TypeSafe
feasibility review before anyone writes an ADR for them.

## What is being tested

Every experiment asks one binary criterion as a System One question, the
shape TypeSafe's Jev model answers: a `noul` (yes/no) question over a `state`,
returning a probability. The same call runs against three providers:

| `SYSTEM_ONE_PROVIDER` | What answers | Needs |
| --- | --- | --- |
| `mock` (default) | Deterministic lexical scorer | nothing |
| `anthropic` | Claude as a System One stand-in, structured outputs | `ANTHROPIC_API_KEY` |
| `typesafe` | Jev over `POST /v1/systemone` | `TYPESAFE_API_KEY` |

The mock cannot validate any hypothesis about a real model. It proves the
plumbing, shows the report shapes, and demonstrates what a purely lexical
judge gets wrong. Real conclusions need `anthropic` or `typesafe` runs on real
traces, at least a few hundred cases, with governed reviewer-disagreement
flags rather than the hand-set ones in the fixtures.

### 1. Split-view disagreement

Ask the criterion twice per case: once with only the assistant output as
state, once with the full trace (input, output, steps). Where the two views
disagree, the criterion is ambiguous about which evidence matters, which is a
rubric problem rather than a model problem. This is the attribution step the
calibration loop lacks today.

Pass rule: disagreements overlap reviewer disagreement more than a shuffled
subset of the same size (lift above 1) with a one-sided permutation p-value
at or below 0.05.

### 2. Minimal-pair probes

Each pair is one passing trace and a copy edited to fail the criterion in one
named way. The edit is the label, so no human review is needed. Probes measure
sensitivity to the named failure, not accuracy on the production distribution,
and must be filed as their own evidence class if they ever leave this folder.

Pass rule: at least 90% of pairs ordered correctly and at least 80% separated
by the margin (default 0.3).

### 3. Weekly drift replay

Record a per-item probability log (case id, probability, label, model,
question digest; never payloads). Compare this week's log with last week's:
model identity, label flips, distribution shift, and where labels exist,
Brier score, expected calibration error, reliability bins, and the ADR-0004
error directions at a 0.5 threshold. The verdict is `review` or `steady`; it
is a reason to look, never a calibration decision.

This is the detection layer that only becomes affordable with a cheap
probability-returning provider, and the per-item log is what the current
`coeval/binary-calibration/v1` artifact deliberately cannot hold.

## Credentials

Keys are read from the environment only. Nothing here reads a `.env` file,
and nothing writes a key to disk or to a report.

| Provider | Variable | Notes |
| --- | --- | --- |
| Claude | `TYPESAFE_LOOP_ANTHROPIC_API_KEY` (falls back to `ANTHROPIC_API_KEY`) | Use the dedicated name inside a Claude Code session so the harness key cannot shadow the session's own credential |
| Jev | `TYPESAFE_API_KEY`, or none | With no key the request is sent without an `Authorization` header, for a proxy that attaches one |

**In a Claude Code cloud environment.** Open the environment selector at
claude.ai/code, edit the environment, and:

- add the Claude key under **Environment variables** as
  `TYPESAFE_LOOP_ANTHROPIC_API_KEY=...`; `api.anthropic.com` is reachable at
  every network level, but values here are visible to anyone using the
  environment;
- add the Jev key under **API credentials** (Pro and Max only): type
  **Bearer**, allowed website `api.typesafe.ai`, header `Authorization` with
  prefix `Bearer`. The proxy attaches the key after the request leaves the
  VM, the session never sees it, and the host becomes reachable even under
  the **Trusted** network level, which otherwise blocks it. Leave
  `TYPESAFE_API_KEY` unset so the provider runs in proxy mode.

Sessions copy variables once at startup, so start a new session after saving.

**Locally.** Export the variables in your shell, or keep them in an untracked
`.env` file (already gitignored in this repo) and run
`node --env-file=.env tools/typesafe-loop/run.mjs`.

## Running

```sh
pnpm typesafe-loop                 # all three, mock provider
pnpm typesafe-loop split-view      # one experiment
SYSTEM_ONE_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm typesafe-loop
SYSTEM_ONE_PROVIDER=typesafe  TYPESAFE_API_KEY=...  pnpm typesafe-loop
node --test tools/typesafe-loop/*.test.mjs
```

Reports are written to `out/typesafe-loop/<timestamp>/` (gitignored). Set
`TYPESAFE_LOOP_OUT` to choose another directory. `ANTHROPIC_MODEL` and
`TYPESAFE_DEFAULT_MODEL` override the model; the reports record the model
name the provider actually returned, because both `jev-latest` and a Claude
alias can move underneath you.

## Mock results, for orientation only

| Experiment | Mock verdict | Why |
| --- | --- | --- |
| Split-view | pass | The five cases whose evidence sits only in a tool step flip between views; they are exactly the reviewer-split cases, by fixture construction |
| Minimal pairs | fail (75% separated) | A lexical scorer cannot tell that "within our 30-day window" is false, and reads "30-day" as a pass even when the reply then refunds anyway |
| Drift | review | The second run uses a renamed, biased mock; the model-identity change alone triggers review |

The minimal-pair failure is the useful result: it is the blind spot a probe
set is meant to expose, and a real provider should clear it.

## Providers

Every provider makes exactly one physical call and never retries, matching
the single-physical-call policy of Coeval's sealed calibration worker. The
TypeSafe provider speaks the SDK's wire contract directly (`Authorization:
Bearer`, `{ state, questions, model }`) so the harness has no dependency to
install. The Claude stand-in is the TypeScript counterpart of TypeSafe's own
`system-one-adapter-python`: same questions, same probability answers,
obtained with structured outputs, with the state passed as untrusted data
inside a tagged block.

## Relationship to the ADRs

- ADR-0002: uncertainty and disagreement sampling here is discovery, not a
  prevalence estimate, and the fixtures are development data.
- ADR-0004: no threshold is chosen; the 0.5 cut in the drift report is a
  reporting convention, and the reliability table is there so a consumer can
  pick its own operating point.
- ADR-0009: the per-item probability log is exactly the disclosure the sealed
  artifact forbids. It is allowed here only because nothing in this folder is
  sealed. Any product use needs a new accepted decision on access.

## Automatic loop

`autoloop.mjs` closes the loop without a human in the change step, and keeps
a strict referee in the accept step.

```
measure ─► attribute ─► author proposes one change ─► gate on held-out ─► accept or discard
   ▲                                                                              │
   └──────────────────────────────────────────────────────────────────────────────┘
```

- **Split.** Cases are split once, by seed, into a shown set (default 60%)
  and a held-out set. The author only ever sees shown-set evidence; the run
  aborts if a held-out id reaches the packet.
- **Measure.** Every judge answers every case, shown and held-out, for the
  current version. Minimal pairs run on the bound judge.
- **Attribute.** The evidence packet sorts shown items into truth-suspect
  (both judges confidently agree against the label), criterion-suspect (the
  judges disagree), near-threshold, and failed pairs, with excerpts.
- **Author.** A stronger Claude model (default `claude-fable-5-1`, set
  `AUTHOR_MODEL` to change it) proposes exactly one change of one kind:
  question text, criteria descriptions, an abstention toggle to the three-way
  pass/fail/cannot-determine shape, or a binding switch to another judge.
- **Gate.** Pure arithmetic on held-out truth: no fall in either ADR-0004
  recall, no fall in AUC, no Brier worsening beyond the margin, no
  previously passing pair regressing, no cannot-determine balloon, and at
  least one measurable improvement. A proposal that changes fields outside
  its declared kind is rejected regardless of its numbers.
- **Report.** Version 0 against the final version on held-out, every round's
  proposal and reasons, the version chain, token usage and a cost estimate
  per model, and whether the author model differed from every judge model.

```sh
pnpm typesafe-autoloop                                   # two mocks, scripted author
AUTOLOOP_JUDGES=typesafe,anthropic AUTOLOOP_AUTHOR=claude \
  pnpm typesafe-autoloop -- --binding typesafe --rounds 5 --fixtures tools/typesafe-loop/fixtures
```

Flags: `--fixtures <dir>` (needs `criterion.json`, `cases.json`, optional
`pairs.json`), `--rounds`, `--seed`, `--heldout`, `--binding`. Judge calls are
cached under `out/typesafe-loop/cache/` so a rerun after a transient failure
pays only for what is missing.

What the mock demo shows: a near-constant judge (`mock-a`) as the initial
binding, a label-aware mock (`mock-oracle`, which knows the fixture labels
with noise) as the alternative, and a scripted author whose binding switch
the gate accepts while its no-effect text edits are discarded. It exercises
the accept and reject paths; it says nothing about real models.

What this does not do: activate a version, touch sealed truth, or choose a
threshold. An accepted version is a candidate with proposal provenance, and
the run's held-out set is development data under ADR-0002, not a sealed
claim.

## Natural-writing experiment (`writing/`)

A second subject for both loops: the `natural-writing` skill from
luka-zivkovic/overclock, tested on real pull-request descriptions. It is a
better subject than the public benchmarks because five of the skill's rules
are decidable by pattern, so labels are exact and unlimited.

- `build-corpus.mjs` pulls PR bodies from the public repos through the
  GitHub REST API (footers and collapsed HTML stripped, three sentences or
  more) and vendors the skill text at a pinned commit. In a cloud session the
  GitHub proxy answers 403 for repos not attached to the session; those are
  skipped with a warning. Run with `NODE_USE_ENV_PROXY=1` in a cloud session
  so Node's fetch uses the session proxy.
- `lexical.mjs` decides rules 1, 2, 3, 6 and 12 (dash connectives, AI-tell
  vocabulary, bot scaffolding, contractions, decorative bold) with exact
  spans. Judgment rules are deliberately not here.
- `corrupt.mjs` injects one violation of a rule into clean text, and one
  claim corruption (strengthened modal, changed number, dropped caveat) into
  any text. The edit is the label.
- `build-suite.mjs` writes one autoloop fixture set per rule under
  `writing/fixtures/suite/<rule>/`, plus a `claims_preserved` pair set. Loop
  A (`autoloop.mjs --fixtures ...`) runs on these unchanged, now with exact
  labels and no ceiling problem.
- `rewrite.mjs` is the candidate: rewrite a PR body with the skill text as
  operating instructions, or with a plain instruction as the no-skill
  baseline. Cached by skill digest.
- `skilloop.mjs` is Loop B. Each round rewrites shown and held-out PRs with
  the current skill text, scores exact violations, judge-scored style rules
  the patterns cannot decide (varied rhythm, no flourish, concreteness), and
  judge-based claim preservation (faithfulness of the rewrite, and separation
  from a corrupted copy). A stronger Claude proposes one verbatim passage
  replacement in the skill (or stop). The gate on held-out: violations per
  text fall by 0.1 or judged style rises by 0.05, nothing regresses, and
  faithfulness and pair separation do not fall.

  Base rates on the corpus matter here. The PR bodies were mostly written by
  Claude Code sessions under a house style, so on the originals only the
  dash rule (19 of 113) and the contractions rule (112 of 113) have any
  failures; AI-tell words and scaffolding are absent. Headroom for Loop B is
  in contractions, dashes and the judged rules, not in the vocabulary lists. The report shows originals, the no-skill baseline, skill v0 and the
  final skill on held-out, every proposal with reasons, and the full text of
  each accepted skill version.

```sh
NODE_USE_ENV_PROXY=1 pnpm typesafe-writing-corpus
pnpm typesafe-writing-suite                      # exact-label fixtures for Loop A
pnpm typesafe-skilloop                           # mock demo of Loop B
SKILLOOP_MODE=live SKILLOOP_JUDGE=typesafe pnpm typesafe-skilloop -- --rounds 4 --limit 80
```

`REWRITE_MODEL` (default `claude-opus-5`) sets the rewriter, `AUTHOR_MODEL`
(default `claude-fable-5-1`) the skill author, `SKILLOOP_JUDGE` the
preservation judge. The loop optimises a rewriter against style rules, so
the preservation gate is the anchor; a skill edit that makes rewrites
shorter and cleaner by dropping caveats is a rejection by construction.
