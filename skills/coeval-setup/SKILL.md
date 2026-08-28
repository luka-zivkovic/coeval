---
name: coeval-setup
description: Guide a beginner through setting up Coeval for an AI agent, workflow, prompt, or skill. Inspect safe project text, identify the target and recorded evidence, ask a short context-aware question, propose one plain-language Check, then connect and create it as Starter · unvalidated. Use when the user asks to initialize, set up, configure, connect, onboard, or get started with Coeval, especially when they do not know eval terminology or say "use your best judgment" or "decide for me".
---

# Coeval setup

Help the user create one useful first Check without requiring them to know eval
terminology. A **Run** is a record of what their AI did. A **Check** asks one
reusable quality question about that record. A **Result** is the Check's
opinion, not a human decision or permission to ship.

Treat "initialize it" as permission to begin discovery, not permission to
guess an unknown target, read sensitive data, or make human decisions.

## Workflow

### 1. Discover before asking

Inspect safe, relevant text already available in the project. Start narrowly:

- README, AGENTS, CONTRIBUTING, and architecture or product documents;
- package manifests and obvious entry points;
- the target agent skill's `SKILL.md`, prompt, or workflow definition;
- documented examples and schemas that explain recorded inputs, outputs,
  steps, or tool calls.

Do not read `.env`, credential files, key stores, private recordings, or
customer data. Ask permission before inspecting or transmitting content that
may be sensitive. Do not scan the whole repository when a few likely files can
answer the setup question.

Reflect the facts found, the likely target, the available Run evidence, and
material uncertainty. Ask the user to correct the reflection instead of
making them repeat information already present.

### 2. Ask only a decision-changing question

Ask when the answer can change the target, first Check, available evidence,
data permission, or required authority. Do not ask about cosmetic or technical
preferences that can be chosen reversibly.

- Prefer one short question per message; never exceed two tightly related
  questions.
- Give two to four concrete, context-derived options.
- Put the supported recommendation first and explain it in one sentence.
- Offer **Decide for me** only for a reversible choice supported by evidence.
- Treat terse replies, repeated skips, and delegation as signals to shorten
  the flow.
- Stop asking as soon as the current context can produce a useful proposal.

Never use **Decide for me** to choose an unknown system or repository, grant
access to sensitive data, enter credentials, create human labels, adjudicate a
Run, promote a protected/Golden example, approve or activate a governed
evaluator, change shared hooks, or make a release decision.

If the target is still ambiguous, ask what is being evaluated. If no evidence
source can be found, ask where the AI's recorded input, output, steps, or tool
calls live. These questions are not skippable because guessing would change
the meaning of the Check.

### 3. Show the proposed Check

After the minimum clarification, show this compact proposal:

```text
What this Check decides
  <one plain-language quality question>

What it reads
  <exact fields or artifacts found, not generic capabilities>

What it cannot know
  <missing side effects, external state, or absent evidence>

Review guide
  Pass when: ...
  Fail when: ...
  Insufficient evidence when: ...

Assumptions
  <user-stated, artifact-derived, or agent-decided origins>

Status
  Starter · unvalidated
```

Then offer exactly two paths:

1. **Finish setup (Recommended)** — create the Check from this proposal.
2. **Refine the Check** — ask one next highest-impact question, update the
   proposal, and show both paths again.

Do not treat silence or a default selection as approval. Keep **Finish setup**
available during refinement so the user is never trapped in an interview.

### 4. Save a resumable non-secret draft

Before connecting to Coeval, write the agreed working draft to
`.coeval/<slug>.setup-draft.json`. This file may contain the reflected target,
evidence inventory, proposal, assumptions, and their origins. It must not
contain passwords, API keys, pairing tokens, provider keys, or copied customer
data. Keep `.coeval/` local by ensuring `.coeval/.gitignore` contains `*`;
preserve an existing stricter ignore rule.

Read [references/setup-artifacts.md](references/setup-artifacts.md) before
writing or applying setup artifacts. Reuse an existing draft when a later
conversation resumes; re-check any material assumption that the project has
invalidated.

### 5. Connect only after approval

After the user chooses **Finish setup**, ask them to open Coeval and choose
**Create agent connection**. Keep the returned one-time token only in the
`COEVAL_PAIRING_TOKEN` environment variable. Never write it to a file, repeat
it in chat, or include it in the setup JSON.

Finalize `.coeval/<slug>.setup.json` from the exact proposal the user saw. Use
the bundled transport in the sibling `coeval-audit` skill to apply it. If that
skill is unavailable, tell the user to install both bundled skills or finish
in the Coeval app; do not invent an API contract.

Submit a first batch only when at least one real Run is already available and
the user has authorized its use. Never invent a demonstration Run. If no Run
exists, create the Check and say plainly that no Result exists yet.

### 6. Return an honest receipt

State:

- the exact quality question created;
- the Run fields it can read and what remains invisible;
- whether a real Run was submitted and whether a Result exists;
- that the Check is **Starter · unvalidated**;
- the non-secret setup and draft file paths;
- the next source-specific action.

For an Agent Skill, hand ongoing capture and submission to `coeval-audit`.
For supplied examples, use the bench batch flow. For production Runs, use the
selected trace integration or manual import. Automatic capture is currently a
Claude Code-only option; do not claim that Codex, Gemini, Cursor, or a generic
MCP client is automatically captured.

Stop before human adjudication, Golden promotion, governed activation,
calibration approval, release thresholds, or deployment decisions. Never say
that an unvalidated Check is accurate, trusted, calibrated, or verified.

## Failure behavior

- If the target cannot be found, ask one short target question and pause.
- If evidence is absent, offer to create an untested Check or wait for a real
  Run; do not fabricate evidence.
- If the connection expires, preserve the non-secret draft and ask for a new
  connection only when ready to retry.
- If setup partly fails, name the last confirmed durable artifact. Do not
  report completion merely because a request was sent.

## Reference

- [references/setup-artifacts.md](references/setup-artifacts.md) — draft and
  final artifact shapes, application command, receipt, and harness limits.
