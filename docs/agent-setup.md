# Install Rubrist with your coding agent

[← README](../README.md) · [MCP reference](../tools/mcp/README.md) · [Self-hosting](self-hosting.md)

There are three pieces: the **Rubrist service**, two optional **agent skills**,
and an optional **MCP connection**. Start the service first. Skills guide the
setup and auditing workflow; MCP gives your harness callable tools. The
skills can submit over HTTP without MCP.

## Claude Code: install the plugin

Rubrist publishes a Claude Code plugin marketplace from this repository. In
Claude Code, run:

```text
/plugin marketplace add luka-zivkovic/rubrist
/plugin install rubrist@rubrist
```

Then open a Claude Code session in the project you want to evaluate and run
`/rubrist:rubrist-setup`, or ask "initialize Rubrist for this project." Use
`/rubrist:rubrist-audit` for later runs. The plugin source lives in
[`plugins/rubrist`](../plugins/rubrist); its two skills are described in
[Install the two skills](#install-the-two-skills).

The plugin does not start Rubrist. The setup skill needs a running Rubrist
service in Postgres mode, because the private agent connection it uses is
created from a signed-in owner session. Start the service with one of the
paths in the README's [Ten-minute start](../README.md#ten-minute-start), or
let the agent install it as described next.

## Let your agent install the service

Claude Code, Codex, and other coding agents can follow the same instructions
when they have filesystem and terminal access. Open a session in your projects
directory and paste:

```text
Set up Rubrist locally from https://github.com/luka-zivkovic/rubrist.
Read README.md and docs/agent-setup.md first. Check Node 24+, pnpm 10.33+,
Docker, and ports 5432, 8787, and 5173. Check any existing checkout's branch
and local changes. Do not overwrite configuration or reset a database.

Follow the README's from-source start, generate the auth secret locally, and
keep secrets out of chat and Git. Start Postgres, the API, and the web app.
Verify the API health endpoint and show me the signup URL. Guide me through
the owner account and first Check, then install both bundled skills for
this harness. Identify any missing prerequisite clearly.
```

Use the [from-source steps](../README.md#c-from-source) to inspect or run the
same steps yourself. Commands use a POSIX shell, such as macOS, Linux, or WSL.
For a persistent or networked deployment, see the
[published images](../README.md#b-self-host-the-published-images) and
[self-hosting](self-hosting.md).

| Component | Local default | Verify |
| --- | --- | --- |
| PostgreSQL | `localhost:5432` | `docker compose -f docker-compose.pg.yml ps` |
| API | `http://localhost:8787` | `curl --fail http://localhost:8787/health` |
| Web app | `http://localhost:5173` | Open the page and create the first owner. |

The API needs the environment from `.env`; the README shows how to load it
before `pnpm dev:api`. Keep both application processes running. `pnpm install`
alone neither starts Rubrist nor installs its skills into your harness.

## Install the two skills

| Skill | What it does |
| --- | --- |
| [rubrist-setup](../plugins/rubrist/skills/rubrist-setup/) | Reads safe project context, proposes a **Starter · unvalidated** Check, and connects it after **Finish setup**. |
| [rubrist-audit](../plugins/rubrist/skills/rubrist-audit/) | Captures real input/output examples, submits Runs, and explains the resulting assessments. |

The Claude Code plugin above installs both. Every other harness gets them by
copying the folders.

### Copy the skill folders

Install **both complete directories**. `rubrist-setup` uses transport resources
from its sibling `rubrist-audit`; copying only `SKILL.md` loses those resources.
Run the following from the Rubrist checkout. If either destination already
exists, compare it before replacing an installed copy.

#### Claude Code without the plugin

For your user account:

```sh
mkdir -p "$HOME/.claude/skills"
cp -R plugins/rubrist/skills/rubrist-setup plugins/rubrist/skills/rubrist-audit "$HOME/.claude/skills/"
```

Copied skills are invoked without the plugin prefix: `/rubrist-setup` and
`/rubrist-audit`. For a project-only installation, use that project's
`.claude/skills/` instead.
See [Claude Code's skill documentation](https://code.claude.com/docs/en/skills).

#### Codex

For your user account:

```sh
mkdir -p "$HOME/.agents/skills"
cp -R plugins/rubrist/skills/rubrist-setup plugins/rubrist/skills/rubrist-audit "$HOME/.agents/skills/"
```

In Codex CLI or the IDE extension, invoke `$rubrist-setup` or select it from
`/skills`. Use `$rubrist-audit` for later runs. If a newly installed skill does
not appear, restart the session. For a project-only installation, use that
project's `.agents/skills/` instead.
See [Codex's skill documentation](https://developers.openai.com/codex/skills/).

#### Other harnesses

Use the harness's documented Agent Skills directory and install both folders
as siblings. Discovery, command syntax, and hook support vary by host. If it
can read local files but does not discover skills, point it at the workflow:

```text
Read /absolute/path/to/rubrist/plugins/rubrist/skills/rubrist-setup/SKILL.md and
its referenced resources. Use that workflow to initialize Rubrist for the
current project. The Rubrist API is at http://localhost:8787.
```

Manual example capture and HTTP submission are portable. Automatic capture
uses a **Claude Code Stop hook**, not a universal session recorder. Standalone
scripts require Node.js 18 or newer; the application requires Node.js 24+.

## Connect your project

1. Create the owner account in the web app. Copy the no-secret setup prompt
   from onboarding or the project's Overview into your coding-agent session.
2. Review the proposed **Check**. The setup skill reads safe project context
   and presents the Check as **Starter · unvalidated**.
3. Choose **Finish setup**, then create the private agent connection in Rubrist.
   Follow the generated connection instructions locally. The connection is
   project-scoped, single-use, and expires after 15 minutes.
4. Save the returned project key securely; its plaintext is shown once.
   The audit client uses `RUBRIST_URL` and `RUBRIST_API_KEY`, supplied through its
   environment or a local, uncommitted `.env` file. Existing projects can mint
   a replacement under **Settings → API keys**.

`RUBRIST_BOOTSTRAP_TOKEN` is a separate, optional instance-owner mechanism for
headless administration. It is not needed for normal signed-in onboarding or
MCP, and it is not a substitute for a project key.

## Add MCP tools

Follow the [MCP installation commands](../tools/mcp/README.md#connect-your-harness)
for Claude Code, Codex, or another client with **stdio** support. The harness
launches a local Node process, which calls your local or hosted Rubrist API.
The API URL itself is not an MCP endpoint.

Start with `get_project` to check the connection without submitting examples
or spending judge-model tokens. Then ask for findings or specific cases.
New submissions can incur provider costs and retain project data. MCP does
not provide the entire owner workflow: adjudication, Golden promotion, and
governed calibration remain session-controlled operations in Rubrist.

## Make the first run useful

Ask the agent to audit a real input/output pair from the skill you are working
on. Inspect the example before submission. Add an expected label only when it
comes from a review you can explain; an unlabeled result is the evaluator's
opinion, not verified correctness.

Manual submission is the portable starting point. Claude Code can optionally
capture examples automatically while retaining explicit submission; full
auto-submit requires the separate `RUBRIST_AUTO_SUBMIT=1` opt-in. Sample JSONL
shipped with the audit skill is for demo instances: verdicts are append-only.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| API cannot connect to Postgres | Database health, port conflicts, and the API process's `DATABASE_URL`. |
| Web app cannot reach the API | Both processes are running; API URL and trusted origin match the local setup. |
| `/rubrist:rubrist-setup` is not found | The plugin is installed from the `rubrist` marketplace; restart the session after installing. Copied folders use `/rubrist-setup` without the prefix. |
| Skill is missing or cannot find a script | Both complete sibling folders are in the harness's discovery directory. |
| The agent connection is refused | The service is running in demo mode (no `DATABASE_URL`). Agent connections need the Postgres workspace. |
| MCP cannot start | Node is available to the harness, dependencies are installed, and the server path is absolute. |
| MCP returns unauthorized | Use a current Rubrist project key, not an onboarding token or provider key. |
| Batch selection is ambiguous | MCP submission tools do not accept an evaluator pin. Use the HTTP API with an explicit `skillVersionId` for multi-criterion projects. |

This pre-launch version supports clean database installations. If an existing
database has a different baseline, consult the
[database policy](decisions/0011-prelaunch-blank-slate-database-policy.md);
resetting it is a separate, destructive operation.
