# Rubrist MCP server

[← README](../../README.md) · [Agent setup](../../docs/agent-setup.md)

Connect Rubrist to Claude Code, Codex, or another harness that supports local
**stdio MCP servers**. MCP—the Model Context Protocol—lets the agent call
named tools to read findings, inspect examples, and submit evaluation runs.

```text
Your harness  ← stdio MCP →  local Node process  →  Rubrist HTTP API
                              tools/mcp/              localhost:8787
                                                      or your host
```

The harness launches the Node process. You do not need to run another HTTP
server or expose a new port. `RUBRIST_URL` points to the Rubrist API, not to an
MCP endpoint. Registering `http://localhost:8787` as an HTTP MCP server will
not work.

## Prerequisites

1. A running Rubrist instance and a project. See the [ten-minute start](../../README.md#ten-minute-start).
2. A local checkout with dependencies installed using `pnpm install` from
   its root. `@rubrist/mcp` is a private workspace package, not a published
   `npx` installer.
3. A project-scoped `rubrist_sk_` key from onboarding or **Settings → API keys**.

Set `RUBRIST_API_KEY` in your shell using your local secret workflow before
running the registration commands. It is the Rubrist project key, not an
Anthropic/OpenAI key or `RUBRIST_BOOTSTRAP_TOKEN`.

## Connect your harness

Run the examples from the Rubrist repository root. They record an absolute
server path, so the checkout must remain at that location.

### Claude Code

```sh
claude mcp add --scope user \
  --env "RUBRIST_URL=http://localhost:8787" \
  --env "RUBRIST_API_KEY=${RUBRIST_API_KEY:?Set RUBRIST_API_KEY in this shell first}" \
  --transport stdio rubrist -- node "$PWD/tools/mcp/index.mjs"

claude mcp list
```

This registers the server for your user account. For a single project, use
`--scope local` while working in that project and supply the absolute path to
the Rubrist checkout. The key is stored in Claude Code's private local
configuration; do not copy it into a committed `.mcp.json`.

Open Claude Code, inspect `/mcp`, and ask it to call Rubrist's `get_project`.
See [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

### Codex

```sh
codex mcp add rubrist \
  --env "RUBRIST_URL=http://localhost:8787" \
  --env "RUBRIST_API_KEY=${RUBRIST_API_KEY:?Set RUBRIST_API_KEY in this shell first}" \
  -- node "$PWD/tools/mcp/index.mjs"

codex mcp list
```

The CLI stores this in your local Codex configuration. Keep it private.
Start a new Codex session and ask it to call Rubrist's `get_project`.

If you prefer to supply the key through the environment inherited by Codex,
configure the server manually in `~/.codex/config.toml`:

```toml
[mcp_servers.rubrist]
command = "node"
args = ["/absolute/path/to/rubrist/tools/mcp/index.mjs"]
env_vars = ["RUBRIST_API_KEY"]

[mcp_servers.rubrist.env]
RUBRIST_URL = "http://localhost:8787"
```

Use either method, keeping one server entry. With `env_vars`, the key must be
present in the process that starts Codex; a separately launched desktop app
may not inherit your terminal's environment.
See [Codex's MCP documentation](https://developers.openai.com/codex/mcp/).

### Other MCP clients

Choose a local/stdio server in your client's MCP settings and supply:

| Setting | Value |
| --- | --- |
| Command | `node`, or its absolute path if the host cannot find it |
| Arguments | `/absolute/path/to/rubrist/tools/mcp/index.mjs` |
| Environment: `RUBRIST_URL` | `http://localhost:8787` or your deployed API origin |
| Environment: `RUBRIST_API_KEY` | Your Rubrist project key |

Clients that use an `mcpServers` JSON configuration can adapt this example:

```json
{
  "mcpServers": {
    "rubrist": {
      "command": "node",
      "args": ["/absolute/path/to/rubrist/tools/mcp/index.mjs"],
      "env": {
        "RUBRIST_URL": "http://localhost:8787",
        "RUBRIST_API_KEY": "REPLACE_WITH_YOUR_PROJECT_KEY"
      }
    }
  }
}
```

Filenames and secret interpolation differ by harness. Use its documented
private settings or secret mechanism. A host with only remote HTTP MCP
support cannot run this stdio server directly.

## Verify the connection

Ask the agent:

```text
Use Rubrist's get_project tool to check which project is connected.
Do not submit any examples yet.
```

`get_project` makes a read request and does not call a judge model. If it fails,
check the API URL, project key, installed dependencies, and Node executable.
Once connected, try `get_findings` or `get_cases` before submitting real work.

## Available tools

| Tool | Purpose |
| --- | --- |
| `get_project` | Read project identity, mode, and current evaluator information. |
| `get_findings` | Read overrides, disagreements, distributions, and deterministic rationale groupings. |
| `get_cases` | Read stored inputs/outputs and judgments; filter by verdict, stratum, time, or limit. |
| `get_golden` | Read curated regression examples; supply `criterionVersionId` when needed. |
| `submit_runs` | Submit examples through `/api/v1/judge/batch` and wait for completion. Labels are optional. |
| `run_gate_check` | Submit labeled examples and compute an agreement check locally; incomplete execution cannot pass. |

New submissions can spend judge-model tokens and retain project data.
Unchanged example content uses the same content-derived identity; do not
assume every submission triggers a fresh provider call. The default polling
timeout is 300 seconds, with a `timeoutSeconds` override on submission tools.

## Current boundaries

- Submission tools do not accept `skillVersionId` or a suite manifest. Use
  them where Rubrist can select an eligible evaluator unambiguously. For
  multi-criterion or pinned execution, use the HTTP batch API with
  `skillVersionId` instead. A newly created unvalidated Check may also need
  owner review before ordinary judging is allowed.
- `run_gate_check` is an agreement helper over the batch API. It does not
  call the removed `/api/v1/gate-checks` write route, activate an evaluator,
  produce sealed calibration, or make a Dailies release decision.
- The tools do not request `purpose: "release_evidence"` or retrieve its
  assessment receipt. Use the documented
  [release-evidence integration](../../README.md#judgment-in-ci) for that job.
- There are no human-adjudication or Golden-promotion tools. Those decisions
  remain in the dashboard. Submitted expected labels do not create governed
  human truth; unlabeled assessments do not establish correctness.
- Retrieved inputs and outputs are project data exposed to the connected
  harness. The server uses the key in the HTTP authorization header.

## Tests

```sh
node --test tools/mcp/*.test.mjs
```

Run from the repository root. These tests exercise the SDK-free client core
with an injected HTTP client; no live Rubrist service or provider key is needed.
