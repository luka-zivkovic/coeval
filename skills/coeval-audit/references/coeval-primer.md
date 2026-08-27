# Coeval primer

Coeval is CI for LLM judging skills: it turns a judge prompt into a shared,
versioned team artifact, judges traces or curated examples with it, routes
uncertain and failing cases to humans, and regression-tests every judge edit
against a human-approved golden set.

## What a judging skill is

A *judging skill* is coeval's versioned judge definition: a rubric (markdown
review guide), few-shot examples, a pinned model binding, and a structured
output schema. Verdicts it produces are labeled `pass`/`fail` (or scalar/
categorical, depending on the schema). Skill versions and verdicts are
**append-only** — history is never silently rewritten, which is also why you
must not submit throwaway sample data to a real project.

**Naming disambiguation:** coeval's portable judging-skill format
(SkillFormat v1, `spec/skill-format-v1.md` in the coeval repo) defines the
*judge* artifact and is unrelated to the Claude Code / Agent Skills
folder-with-SKILL.md format that this `coeval-audit` skill itself is written
in — same word, two different specifications.

## Project modes

- **Bench mode** — dataset-first, for teams without production traces. This
  is the mode to use for auditing an agent skill: you submit curated example
  batches and judge them explicitly. One bench project per audited skill.
- **Tracing mode** — trace-ingest-first (manual import, LangSmith, Langfuse).
  Works with batch submission too, but the audit workflow assumes bench.

## Setup paths (one-time, per audited skill)

Prefer the onboarding pairing: the signed-in owner chooses **Create agent
connection** and pastes its 15-minute instructions into the external agent.
The bundled client then configures that existing project, validates and pins a
real provider model, records the generated rubric as `agent-drafted`, activates
the version, and receives the first project key exactly once. Follow Phase 1
in SKILL.md; the non-secret setup plan must derive its rubric from the target
skill's own SKILL.md.

Use this manual dashboard walkthrough when the user does not want to connect
an agent:

1. **Create a project** — choose **bench** mode; name it after the skill you
   are auditing.
2. **Author the judging skill** — write the rubric that defines what a good
   output of *your* skill looks like. A practical bootstrap: distill your
   skill's own SKILL.md into rubric clauses —
   - its stated purpose → "the output accomplishes X";
   - its constraints ("never do Y") → explicit fail conditions;
   - its output contract (format, tone, required sections) → checkable pass
     criteria.
   Pick a model binding (pinned model, never `latest`) and the binary
   pass/fail output schema to start.
3. **Activate a version** — a draft judges nothing; the batch API refuses to
   run while `currentSkillVersionId` is null (`coeval-submit.mjs check` tells
   you).
4. **Mint an API key** — **Settings → API keys**. The `coeval_sk_` key is
   shown once; store it in `.env` (e.g. `COEVAL_API_KEY=...` or the per-skill
   variable named in `.coeval/config.json`). The key is project-scoped: one
   key, one project, one audited skill.

In either path, agents stop after submitting runs. Only a human adjudicates
exceptions and promotes golden cases. An agent-drafted rubric is scaffolding,
not evidence that the judge is correct; the Judge Card exposes that provenance.

## Reading verdicts honestly

A judge verdict is one signal, not ground truth. Agreement is only measured
against the labels *you* supply (`expected` per line). With zero labels there
is no agreement at all — only the judging skill's opinions. Coeval's own
UI follows the same rules (counts, not percentages; consistent is not
correct), and so does this skill's Phase 4.
