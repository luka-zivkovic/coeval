# Rubrist agent skills

The two bundled skills, `rubrist-setup` and `rubrist-audit`, now live inside the
Claude Code plugin at [`plugins/rubrist/skills/`](../plugins/rubrist/skills/):

- [`plugins/rubrist/skills/rubrist-setup`](../plugins/rubrist/skills/rubrist-setup/)
  proposes and connects a first **Starter · unvalidated** Check.
- [`plugins/rubrist/skills/rubrist-audit`](../plugins/rubrist/skills/rubrist-audit/)
  captures real examples, submits Runs, and reports Results.

This directory is kept only as a signpost for links that predate the move.

## Install

In Claude Code, add the marketplace published from this repository and install
the plugin:

```text
/plugin marketplace add luka-zivkovic/rubrist
/plugin install rubrist@rubrist
```

Then run `/rubrist:rubrist-setup` in the project you want to evaluate, and
`/rubrist:rubrist-audit` for later runs.

For Codex and other harnesses, copy both complete skill folders from
`plugins/rubrist/skills/` into the harness's skills directory. The exact
commands are in [`docs/agent-setup.md`](../docs/agent-setup.md#copy-the-skill-folders).
Both folders must be installed as siblings: `rubrist-setup` uses the transport
script shipped in `rubrist-audit`.
