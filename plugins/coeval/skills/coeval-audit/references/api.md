# Raw HTTP fallback

Use these endpoints directly when Node >= 18 is unavailable. Setup and normal
project use have different credentials by design:

- Preferred: `POST /api/v1/bootstrap` uses a short-lived `coeval_pair_...`
  token created by a signed-in owner during onboarding.
- Headless fallback: the same endpoint accepts the optional instance-scoped
  `COEVAL_BOOTSTRAP_TOKEN`.
- Every other `/api/v1/*` request uses the project-scoped `coeval_sk_...` key
  returned exactly once by setup or Settings.

All requests:

```
Authorization: Bearer <pairing/bootstrap-or-project-key>
Content-Type: application/json
```

Rate limiting: every project-key `/api/v1/*` request costs 1 token from a per-key bucket
(default 60/minute); a batch additionally costs 1 token per freshly judged
item beyond the first (cached items are free). `429` means back off and retry
— it is rejected before any judging happens. Setup does not consume the
project-key bucket.

## Preferred authorization — onboarding pairing

A signed-in project owner calls `POST /api/agent-setup/pairings`. The `201`
response contains a `coeval_pair_...` token exactly once. Only its SHA-256 hash
is stored. It is scoped to that existing project, expires after 15 minutes,
and is consumed by one successful setup. Creating another connection revokes
the previous one. Pairing is limited to new projects with no imported cases;
it cannot overwrite an established project. Poll
`GET /api/agent-setup/pairings/:id` for
`pending`, `claimed`, `completed`, `expired`, or `revoked`; status responses
never return the token. `DELETE` revokes an active connection.

The onboarding UI creates and copies this connection for beginners. Do not
persist the pairing token in setup JSON or `.env`.

## `POST /api/v1/bootstrap` — configure the paired project

Use `Authorization: Bearer coeval_pair_...`. The request's owner/project text
helps the client produce a readable setup plan, but the token—not those
fields—selects the existing owner and project.

For a fully headless deployment with no browser session, an administrator may
instead enable `COEVAL_BOOTSTRAP_TOKEN` with a random value of at least 32
characters. That fallback creates the project and, on an empty instance,
requires `owner.password` to create the first owner.

```bash
curl -s -X POST "$COEVAL_URL/api/v1/bootstrap" \
  -H "Authorization: Bearer $COEVAL_PAIRING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": { "email": "owner@example.com" },
    "project": { "name": "my-skill audit", "apiKeyName": "audit agent" },
    "check": {
      "name": "Follows the skill contract",
      "question": "Did this Run follow the target skill's required workflow and constraints?"
    },
    "skill": {
      "name": "My skill audit",
      "rubricMarkdown": "# My skill audit\n\n## Pass when\n- The run follows the skill contract.\n\n## Fail when\n- It violates a required constraint.",
      "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-6", "temperature": 0 }
    },
    "providerApiKey": "optional-project-scoped-provider-key"
  }'
```

Omit `skill.prompt` for the safe built-in template containing
`{{rubric_markdown}}`. A supplied prompt that disconnects the rubric or uses
unsupported variables is rejected. Omit `modelId` for catalog providers to
let the server choose and pin the first compatible model; custom providers
require `modelId`, `baseUrl`, and a provider key.

The server appends `check.question` as an immutable criterion definition and
atomically binds the new evaluator version to it. The `201` response includes
that exact Check id, version, question, and digest alongside project/skill/version ids, the pinned model,
`rubricProvenance: "agent-drafted"`, `apiKey`, and `connect` — ready-to-paste
agent wiring snippets (Claude Code one-liner, generic `mcp.json` block, plain
CLI) with the URL and the one-time key pre-filled. The raw
`apiKey.key` is shown once and only its hash is stored. The bundled script
saves it to `.env` without printing it and echoes the `connect` snippets with
the key masked as its saved env-var name. Pass `--first-batch results.jsonl` to
that script's `setup` command when a real captured batch already exists; it
then submits and polls the first verdict with the newly minted key.

Machine-actionable failures carry a stable `code`, including
`invalid_or_expired_pairing_token`, `pairing_already_claimed`,
`bootstrap_unavailable`, `invalid_bootstrap_token`, `owner_password_required`,
`owner_not_found`, `rubric_not_referenced`, `unsupported_prompt_variables`,
`provider_key_required`, `provider_key_rejected`, and `model_not_available`.
The headless fallback removes its newly created project if later configuration
fails. A pairing never deletes the human's existing project.

Agent setup ends before governance: project keys cannot adjudicate exceptions
or promote golden cases.

## `GET /api/v1/project` — connection check

Free (no provider spend; 1 rate token). What `coeval-submit.mjs check` calls.

```bash
curl -s "$COEVAL_URL/api/v1/project" -H "Authorization: Bearer $COEVAL_API_KEY"
```

```json
{ "projectId": "proj_...", "name": "my-skill audit", "mode": "bench", "currentSkillVersionId": "sv_..." }
```

- `mode` is `"bench"` or `"tracing"`.
- `currentSkillVersionId: null` means no judging skill version is active —
  batch submission will be refused with a 400 until one is activated in the
  dashboard.
- `401` — missing/invalid/revoked key.

## `POST /api/v1/judge/batch` — submit results (fire-and-poll)

```bash
curl -s -X POST "$COEVAL_URL/api/v1/judge/batch" \
  -H "Authorization: Bearer $COEVAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "sourceTraceId": "ci_<sha256-of-content-first-32-hex>",
        "input": { "question": "Can I get a refund?" },
        "output": { "answer": "Refunds are available within 30 days." },
        "metadata": { "name": "refund-happy-path" },
        "expectedLabel": "pass"
      }
    ]
  }'
```

Item fields: `sourceTraceId?`, `input`, `output`, `metadata?` (object),
`steps?` (array of `{name?, input, output, metadata?}`, max 50),
`expectedLabel?` (`"pass"`/`"fail"`), `expectedFailStep?` (fail-only, 0-based
into that item's own `steps`). Optional top-level: `skillVersionId` (defaults
to the project's current version), `datasetId`.

Response is `202`:

```json
{ "evalRunId": "run_...", "status": "pending", "totalItems": 1, "cachedItems": 0, "skippedItems": 0, "pollUrl": "/api/v1/eval-runs/run_..." }
```

- `cachedItems` — items whose verdict was already recorded for this skill
  version (a re-POST of the same `sourceTraceId` content); no provider spend.
- `skippedItems` — items refused by the anti-recursion guard.
- `400` — invalid body, or no active skill version.

## `GET /api/v1/eval-runs/:evalRunId` — poll the run

```bash
curl -s "$COEVAL_URL$POLL_URL" -H "Authorization: Bearer $COEVAL_API_KEY"
```

Poll every ~2s until `status` is `"completed"` or `"failed"`. The fields the
script's table reads, per item: `caseId`, `status`
(`completed`/`failed`/`pending`/`skipped`), `resultLabel`, `expectedLabel`,
`agreement` (null when unlabeled), `expectedFailStep`, `failingStep`,
`stepAgreement`, `cached`. Run-level: `agreedItems`, `skillVersionId`, and
`spend` (`freshItems`, `cachedItems`, `inputTokens`, `outputTokens`,
`usageMissingCount` — tokens and counts, never dollars).

## `GET /api/v1/findings` — aggregated judgment intelligence

```bash
curl -s "$COEVAL_URL/api/v1/findings?since=2026-08-01T00:00:00Z" -H "Authorization: Bearer $COEVAL_API_KEY"
```

What the `findings` command wraps. Read-only: `humanOverrides` (human or
adjudicated verdicts that contradict the judge, with rationales),
`judgeHumanDisagreements`, `verdictDistribution` (per `metadata.stratum`),
`failureClusters` (deterministic — rationales grouped by normalized first
sentence, no LLM), and `goldenSet` (`size`, `entriesSince` for the optional
`since` cursor, `latestPromotedAt`). Companion machine reads:
`GET /api/v1/cases` (full stored inputs/outputs + latest verdicts; filters
`verdict`, `stratum`, `since`, `limit`) and `GET /api/v1/golden-set`
(entries + stored traces; optional `since`, `criterionVersionId`). All three
are read-only — adjudication and golden promotion stay in the dashboard.

## Why not `POST /api/v1/judge`?

The single-trace endpoint exists but this skill never uses it: it is
synchronous (blocks up to the server's judge timeout — unacceptable inside a
Stop hook), its body nests the trace (`{ "trace": { ... } }`), and it carries
no label fields, so agreement can't be reported. Always use the batch
endpoint, even for one item.


Note: machine reads (`/api/v1/cases`, golden traces) re-apply the DEFAULT
redaction patterns on read as defense-in-depth — a project whose write-time
redaction config whitelists a default-sensitive key will still see it masked
on these endpoints. Patch validation therefore re-runs on the redacted form.
