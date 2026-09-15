# Setup artifacts and handoff

Read this file when persisting or applying a Coeval setup proposal. The files
below are local working artifacts, not governed truth.

## Resumable draft

Write `.coeval/<slug>.setup-draft.json` before requesting a connection. Keep it
non-secret and small enough for a later agent to review:

```json
{
  "schemaVersion": 1,
  "target": {
    "name": "Support response agent",
    "kind": "agent",
    "source": "README.md"
  },
  "evidence": {
    "available": true,
    "source": "recorded support runs",
    "fields": ["input.customer_message", "output.response", "steps[].tool_name"],
    "cannotKnow": ["whether a promised refund completed outside the record"]
  },
  "check": {
    "question": "Did the response resolve the customer's request without making an unsupported promise?",
    "passWhen": ["The response addresses the request", "Every promise is supported by recorded tool evidence"],
    "failWhen": ["The request is not addressed", "The response promises an action not shown in the record"],
    "insufficientWhen": ["The record omits the evidence needed to verify a material promise"]
  },
  "assumptions": [
    { "text": "Tool results are included in steps", "origin": "artifact", "source": "docs/tracing.md" }
  ],
  "status": "starter_unvalidated"
}
```

Use only fields and artifacts actually found. Do not copy full production Runs
into this file. Allowed assumption origins are `user`, `artifact`, and
`agent_decided`.

## Final setup plan

After the user chooses **Finish setup**, translate the exact approved proposal
to `.coeval/<slug>.setup.json`, which is consumed by the existing
`coeval-audit` transport:

```json
{
  "owner": { "email": "owner@example.com", "name": "Owner" },
  "project": { "name": "support-response Check", "apiKeyName": "support-response agent" },
  "check": {
    "name": "Supported resolution",
    "question": "Did the response resolve the customer's request without making an unsupported promise?"
  },
  "skill": {
    "name": "Supported resolution",
    "rubricMarkdown": "# Supported resolution\n\n## Pass when\n- ...\n\n## Fail when\n- ...\n\n## Insufficient evidence\n- ...",
    "model": { "provider": "anthropic", "temperature": 0 }
  }
}
```

The `check.question` must be the exact quality question shown in the proposal;
the server appends it as an immutable criterion definition and binds the new
evaluator version to it atomically. Omit `modelId` for Anthropic, OpenAI, or OpenRouter to let Coeval choose the
first compatible catalog model. Custom providers require `modelId` and
`baseUrl`. A provider choice is reversible setup configuration; credentials
are not. Never persist any credential in either JSON file.

## Apply through the existing transport

Resolve `scripts/coeval-submit.mjs` from the installed `coeval-audit` skill
directory and run:

```bash
node <coeval-audit-dir>/scripts/coeval-submit.mjs setup .coeval/<slug>.setup.json \
  --pairing-env-var COEVAL_PAIRING_TOKEN \
  --provider-key-env-var ANTHROPIC_API_KEY \
  --env-var COEVAL_KEY_<SLUG>
```

Use the provider credential variable already authorized by the user. If a real
Run has already been captured, add:

```bash
--first-batch .coeval/<slug>.jsonl
```

Do not add `--first-batch` for a synthetic or invented example. The transport
mints a project key and saves it without printing it. Verify through its
`check` command before reporting completion.

## Completion receipt

Use factual language:

```text
Created the Check “<quality question>”.
It reads <exact fields> and cannot verify <missing evidence>.
<N real Runs were submitted and a first Result is available | No Run was submitted, so there is no Result yet.>
Status: Starter · unvalidated.
Saved the non-secret setup files at <paths>.
Next: <capture real runs with coeval-audit | submit examples | connect the trace source>.
```

Do not say passed, accurate, trusted, calibrated, human-approved, or ready to
ship unless separate evidence with exactly that scope exists.

## Harness limits

- Claude Code may install the optional `coeval-audit` Stop hook after explicit
  permission. The default is capture plus explicit submission.
- Codex, Gemini, Cursor, and generic MCP clients use manual JSONL capture, CI,
  or a tracing integration. Do not advertise automatic capture for them.
- An agent may propose a Check and submit Runs. It may not adjudicate, promote
  Golden examples, create governed human truth, activate a governed evaluator,
  or make a release decision.
