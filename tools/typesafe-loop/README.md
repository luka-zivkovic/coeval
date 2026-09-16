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
