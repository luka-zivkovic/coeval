# Coeval agent skills

The two bundled skills, `coeval-setup` and `coeval-audit`, now live inside the
Claude Code plugin at [`plugins/coeval/skills/`](../plugins/coeval/skills/):

- [`plugins/coeval/skills/coeval-setup`](../plugins/coeval/skills/coeval-setup/)
  proposes and connects a first **Starter · unvalidated** Check.
- [`plugins/coeval/skills/coeval-audit`](../plugins/coeval/skills/coeval-audit/)
  captures real examples, submits Runs, and reports Results.

This directory is kept only as a signpost for links that predate the move.

## Install

In Claude Code, add the marketplace published from this repository and install
the plugin:

```text
/plugin marketplace add luka-zivkovic/coeval
/plugin install coeval@coeval
```

Then run `/coeval:coeval-setup` in the project you want to evaluate, and
`/coeval:coeval-audit` for later runs.

For Codex and other harnesses, copy both complete skill folders from
`plugins/coeval/skills/` into the harness's skills directory. The exact
commands are in [`docs/agent-setup.md`](../docs/agent-setup.md#copy-the-skill-folders).
Both folders must be installed as siblings: `coeval-setup` uses the transport
script shipped in `coeval-audit`.
