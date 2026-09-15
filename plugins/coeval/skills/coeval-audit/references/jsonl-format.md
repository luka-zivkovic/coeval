# Results file and config formats

## Results file: `.coeval/<skillName>.jsonl`

One JSON object per line. Malformed lines fail submission loudly (exit 2 with
the line number) — silently dropping examples would be false confidence.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `input` | any JSON | yes* | What the audited skill was asked to do. |
| `output` | any JSON | yes* | What it produced. |
| `name` | string | no | Human title; becomes the case title in the dashboard. |
| `expected` | `"pass"` \| `"fail"` | no | Human label. `expectedLabel` also accepted. Unlabeled lines are judged but never counted in agreement. |
| `steps` | array of `{name?, input, output, metadata?}` | no | Ordered trajectory steps (max 50). |
| `expectedFailStep` | integer >= 0 | no | Only valid with `expected: "fail"`, and must index (0-based) this line's own `steps`. |
| `metadata` | object | no | Passthrough (the capture hook writes provenance here). Does **not** affect the content hash. |

\* `input`/`output` may be omitted and default to `null`, but a line without
them is rarely worth judging.

### Idempotency

`coeval-submit.mjs` derives each line's `sourceTraceId` as `ci_` + the first
32 hex chars of `sha256(JSON.stringify({input, output, ...(steps && {steps})}))`
— the same recipe as `tools/ci/gate.mjs` and the server's example hash.
Re-submitting an unchanged line reuses the recorded verdict (no provider
spend); editing `input`, `output`, or `steps` mints a new case and a fresh
judgment. Editing `name`, labels, or `metadata` does not.

## Config file: `.coeval/config.json`

Maps each audited skill to its coeval connection, and doubles as the capture
hook's allowlist:

```json
{
  "skills": {
    "my-skill": { "keyEnvVar": "COEVAL_KEY_MY_SKILL", "capture": true },
    "other-skill": { "keyEnvVar": "COEVAL_KEY_OTHER", "url": "https://other-coeval.example", "capture": false }
  }
}
```

Per skill entry:

- `keyEnvVar` (string, optional) — the environment/.env variable holding this
  skill's `coeval_sk_` API key. Defaults to `COEVAL_API_KEY`. Pass it to the
  script with `--env-var <NAME>`.
- `url` (string, optional) — per-skill `COEVAL_URL` override (used by the
  hook's auto-submit; for manual submits, set `COEVAL_URL` yourself).
- `capture` (boolean, optional) — `true` enrolls the skill in the Claude Code
  capture hook. The `capture: true` entries ARE the hook allowlist.
  **`coeval-audit` itself is never captured**, even if listed — the server's
  anti-recursion guard covers only coeval-internal metadata, not this skill.

Config keys must match the invoked skill name. Plugin-namespaced invocations
(`plugin:name`) match a key of either the full or the short form.

## The `.coeval/` directory

| Path | Purpose |
| --- | --- |
| `<skillName>.jsonl` | Captured/manual results, one file per audited skill. |
| `config.json` | Connection map + capture allowlist (above). |
| `.gitignore` | Written as `*` on first capture — the directory ignores itself; results and logs never enter git. |
| `.cursor-<sessionId>` | Capture hook's per-session byte offset into the transcript, so each turn is processed once. |
| `submit.log` | Capture and auto-submit outcomes. A background hook has no other error surface — look here first. |
