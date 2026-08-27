# coeval MCP server

A stdio [MCP](https://modelcontextprotocol.io) server that turns any MCP
harness into a Coeval client with one config line. Each tool is a thin
wrapper over the existing `/api/v1` HTTP API — the same protocol works
against `http://localhost:3001` or a hosted instance.

Configuration is two environment variables:

- `COEVAL_URL` — the Coeval API base URL
- `COEVAL_API_KEY` — a project-scoped `coeval_sk_` key (Settings → API keys).
  It is only ever sent as the bearer header, never printed.

## Tools (exactly six)

| tool | what it does |
| --- | --- |
| `get_findings` | Aggregated judgment intelligence: human overrides, judge–human disagreements, per-stratum verdict distribution, deterministic failure clusters, golden-set delta (`since` cursor). |
| `get_cases` | Cases with full stored inputs/outputs + latest judge/human verdicts; filter by `verdict`, `stratum`, `since`. |
| `get_golden` | Golden-set entries (locked human truth) with their stored traces. |
| `get_project` | Connection check: project id, mode, active skill version. |
| `submit_runs` | Submit examples through the existing batch contract and wait for the run (labels optional, agreement informational). |
| `run_gate_check` | The gate-check contract as a tool: candidate outputs on labeled inputs, disagreements counted, infrastructure failure never passes. |

**Deliberate non-goal, permanent:** there are no `adjudicate` or
`promote_golden` tools and there never will be. The MCP surface is read +
submit; human truth is created in the dashboard by humans. An agent-writable
truth channel would convert the governance model into self-grading.

## Install

From the repo root, install dependencies once (`pnpm install` covers
`tools/mcp` via the workspace).

### Claude Code (one line)

```sh
claude mcp add coeval --env COEVAL_URL=http://localhost:3001 --env COEVAL_API_KEY=$COEVAL_API_KEY -- node /path/to/coeval/tools/mcp/index.mjs
```

### pi (`mcp.json` snippet)

```json
{
  "mcpServers": {
    "coeval": {
      "command": "node",
      "args": ["/path/to/coeval/tools/mcp/index.mjs"],
      "env": {
        "COEVAL_URL": "http://localhost:3001",
        "COEVAL_API_KEY": "coeval_sk_…"
      }
    }
  }
}
```

## Tests

`node --test tools/mcp/*.test.mjs` (also part of the root `pnpm test`). The
tests cover the SDK-free client core (`lib.mjs`) with an injected `fetch` —
no running server or provider spend required.
