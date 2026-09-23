---
name: rubrist-audit
description: Audit a developer's own agent skill with a Rubrist instance — connect an approved first Check, capture real skill runs, submit them for judging, and report Results honestly. Use when the user says "audit my skill with rubrist", "submit results to rubrist", "capture skill runs", or "judge these outputs". For a new or unclear setup, begin with the sibling rubrist-setup skill's context-first interview and approved proposal. Do not use it for human adjudication, Golden promotion, or release decisions; those stay in the Rubrist dashboard.
---

# rubrist-audit

Audit any agent skill by judging its real inputs and outputs with a rubrist
judging skill. One rubrist project (bench mode) per audited skill; results move
through the bundled zero-dependency script (Node >= 18). Three automation
modes:

1. **Manual** — you append example lines yourself, then submit on request.
2. **Capture + submit on command** (recommended default) — a Claude Code hook
   records skill runs automatically; submission stays explicit.
3. **Full auto** — set `RUBRIST_AUTO_SUBMIT=1`; captured runs are submitted in
   the background after each turn. Explicit opt-in only.

Never read the user's `.env` file directly — unrelated secrets live there.
`scripts/rubrist-submit.mjs` parses it itself and never prints the key.

## Phase 1 — Set up or connect

For a new or unclear project, use the sibling `rubrist-setup` skill first. It
inspects safe project context, asks only a short decision-changing question,
shows the exact proposed Check, and waits for **Finish setup** before requesting
the short-lived connection. Do not replace that flow with a one-shot rubric
guess. If `rubrist-setup` is not installed, follow its published instructions at
https://github.com/luka-zivkovic/rubrist/blob/main/plugins/rubrist/skills/rubrist-setup/SKILL.md.

Resume here after the user has approved the non-secret setup proposal.

1. **Reachability pre-flight.** Require `RUBRIST_URL` (environment or `.env`)
   and a reachable rubrist instance. Otherwise point the user at the README
   quickstart (https://github.com/luka-zivkovic/rubrist#ten-minute-start) and stop.
2. **Use an existing project when present.** Run
   `node scripts/rubrist-submit.mjs check`. Exit 0 means connected. If the
   project key is absent, connect it as follows.
3. **Prefer an onboarding connection after proposal approval.** Ask the user
   to open the new project's Rubrist Overview, choose **Create agent
   connection**, and paste the generated instructions into this conversation.
   The included `rubrist_pair_...` token is project-scoped, single-use, and
   expires after 15 minutes. Keep it only in `RUBRIST_PAIRING_TOKEN`; never
   write it to a file or repeat it in output.
4. **Use the approved Check.** Translate the exact proposal accepted through
   `rubrist-setup` into concrete pass/fail/insufficient-evidence clauses. Keep
   every claim checkable from the recorded Run; do not require evidence the
   hook cannot capture. See `references/rubrist-primer.md`.
5. **Write the final non-secret setup plan** at `.rubrist/<skillName>.setup.json`:

   ```json
   {
     "owner": { "email": "owner@example.com", "name": "Owner" },
     "project": { "name": "my-skill audit", "apiKeyName": "my-skill agent" },
     "check": {
       "name": "Follows the skill contract",
       "question": "Did this Run follow the target skill's required workflow and constraints?"
     },
     "skill": {
       "name": "My skill audit",
       "rubricMarkdown": "# My skill audit\n\n## Pass when\n- ...\n\n## Fail when\n- ...",
       "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-6", "temperature": 0 }
     }
   }
   ```

   Omit `modelId` for Anthropic/OpenAI/OpenRouter to let the server pin the
   first compatible catalog model. Custom providers require `modelId` and
   `baseUrl`. Never put passwords, pairing/bootstrap tokens, or provider keys
   here.
6. **Configure through the pairing.** If the remote project does not already
   have the provider credential, pass its variable name explicitly:

   ```bash
   node scripts/rubrist-submit.mjs setup .rubrist/<skillName>.setup.json \
     --pairing-env-var RUBRIST_PAIRING_TOKEN \
     --provider-key-env-var ANTHROPIC_API_KEY \
     --env-var RUBRIST_KEY_MY_SKILL
   ```

   The command appends the exact visible quality question, binds the
   agent-drafted evaluator version to it, mints the first project key, and
   saves that key to `.env` without printing it. Machine error codes name
   expired/used pairings, invalid fields, rejected credentials, and
   unavailable models. Ask
   the user to generate a new connection if it expired. For fully headless
   administration with no signed-in human, the deployment owner may instead
   provide `RUBRIST_BOOTSTRAP_TOKEN`; that advanced fallback can create the
   first owner/project and may also require `RUBRIST_OWNER_PASSWORD`.
   If at least one **real** run has already been captured, complete the
   nothing-to-first-verdict path in that same invocation with
   `--first-batch .rubrist/<skillName>.jsonl`. Never invent a throwaway run to
   exercise this flag. If no real run exists yet, finish Phase 2 and then use
   the normal Phase 3 submit command immediately.
7. **Verify.** Run `node scripts/rubrist-submit.mjs check --env-var
   RUBRIST_KEY_MY_SKILL`. `check` exits 2 when the project has no active version;
   `--allow-inactive` downgrades only that condition to a warning.
8. **Record multi-skill routing.** One rubrist project and one key per audited skill.
   Write `.rubrist/config.json`:

   ```json
   { "skills": { "my-skill": { "keyEnvVar": "RUBRIST_KEY_MY_SKILL", "capture": true } } }
   ```

   `capture: true` also enrolls the skill in automatic capture (Claude Code
   only). Full spec: `references/jsonl-format.md`.
9. **Respect the human boundary.** Setup may draft the rubric and submit runs,
   but it must never label exceptions, promote golden cases, or claim the
   release gate is trusted. A human adjudicates; the Judge Card records the
   rubric as `agent-drafted` until a later human-authored version replaces it.
10. **Harness branching.** If the `CLAUDECODE` environment variable is set, the
   user is in Claude Code: offer to install the capture hook (capture-only by
   default). Install it into **`.claude/settings.local.json`** with a
   repo-relative path to `hooks/capture.mjs` — never the committed shared
   `settings.json` unless the user explicitly confirms a change that affects
   all collaborators. In any other harness, say plainly: automatic capture is
   Claude Code-only; use manual capture (Phase 2), `tools/ci/gate.mjs` in CI,
   or a tracing-mode rubrist project fed by LangSmith/Langfuse import — and do
   not touch `.claude/`.

## Phase 2 — Capture

Run the audited skill on real cases. Each case is one JSONL line in
`.rubrist/<skillName>.jsonl` (per-skill files; the hook routes by
`config.json`):

```json
{"name": "short title", "input": "the request", "output": "what the skill produced", "expected": "pass"}
```

- `expected` (`"pass"`/`"fail"`) is optional — but encourage the user to label
  at least a subset by hand; labels are what turn judge opinions into measured
  agreement. Trajectories may add `steps` and (with `expected: "fail"`) a
  0-based `expectedFailStep`. Full format: `references/jsonl-format.md`.
- The `.rubrist/` directory is self-gitignored on first capture.
- **Honest scope of the hook:** it captures the user request and the final
  assistant text of turns where an allowlisted skill ran. File-edit
  deliverables and subagent-internal work are not fully represented — when
  the deliverable was file edits, append a manual line with a diff summary as
  `output`, or let the hook skip it (it logs a note in `.rubrist/submit.log`).

## Phase 3 — Submit

```bash
node scripts/rubrist-submit.mjs submit .rubrist/<skillName>.jsonl [--skill-version ID] [--min-agreement 0.9]
```

- Submission is idempotent: content-hash (`ci_`) source ids mean re-submitting
  unchanged lines reuses recorded verdicts with no provider spend.
- `setup --first-batch` supplies `--skill-version` automatically so the first
  Result is pinned to the exact Check version just created. For later manual
  submissions, provide it whenever the run must stay pinned across concurrent
  evaluator edits.
- `--env-var RUBRIST_KEY_MY_SKILL` selects a per-skill key from `config.json`.
- Exit codes: 0 completed (threshold met, if one was given); 1 infrastructure
  failure or agreement below `--min-agreement`; 2 usage/config error (the
  message names the broken line).
- In full-auto mode the hook submits in the background; outcomes (including
  rate limits, retried next turn) are in `.rubrist/submit.log`.
- The raw HTTP fallback is in `references/api.md`.

## Phase 4 — Report

Read the script's table back to the user. Rules, non-negotiable:

- **Counts, not percentages** — "7 of 9 labeled cases agree", never "78%".
- Report the skill version the verdicts were judged with, and the spend line.
- **If no lines were labeled, never say the skill "passed", was "audited
  successfully", or "looks good".** The script prints the truth banner
  ("N judge verdicts, 0 human labels — no agreement measured; these are the
  judging skill's opinions, not verified correctness.") — repeat that framing,
  and suggest labeling a subset to measure agreement.
- Disagreements are leads to investigate, not automatic defects: the judge can
  be wrong. Suggest reviewing them in the rubrist dashboard.

## Findings (optional follow-up)

```bash
node scripts/rubrist-submit.mjs findings [--since ISO-8601] [--md]
```

Read-only pull of the project's accumulated judgment intelligence — human
overrides of the judge, judge–human disagreements, deterministic failure
clusters, per-stratum verdict distribution, golden-set delta since the cursor.
Prints JSON (default) or a compact markdown brief (`--md`). Every failure is
exit 2: a read never judges anything.

## References

- `references/jsonl-format.md` — results-file format and `.rubrist/config.json` spec.
- `references/rubrist-primer.md` — what rubrist and a judging skill are; dashboard walkthrough.
- `references/api.md` — raw HTTP endpoints and curl fallback.
- `examples/results.example.jsonl` — synthetic sample file. **Demo instances
  only:** verdicts are append-only, so submitting sample data to a real
  project pollutes it permanently.
