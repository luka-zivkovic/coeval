<p align="center">
  <img src="apps/web/public/brand/rubrist-app-icon.svg" alt="Rubrist logo" width="80" height="80">
</p>

<h1 align="center">Rubrist</h1>

<p align="center"><strong>Turn examples of your AI failing into evaluators you can check against human judgment, and keep the evidence.</strong></p>

<p align="center">
  <a href="https://github.com/luka-zivkovic/rubrist/actions/workflows/ci.yml"><img src="https://github.com/luka-zivkovic/rubrist/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-475569" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#ten-minute-start">Ten-minute start</a> · <a href="#concepts">Concepts</a> · <a href="#where-rubrist-fits">Where it fits</a> · <a href="#judgment-in-ci">CI</a> · <a href="#mcp">MCP</a> · <a href="#documentation">Documentation</a>
</p>

Rubrist is for the person who owns the quality of an AI feature: you have seen
it fail, you want an automated check for that failure, and you want to know
whether the check agrees with a human before you rely on it. You can start
from production traces or from a handful of examples. Rubrist keeps the human
review, the evaluator versions, and the resulting evidence connected as the
project grows, and it hands that evidence to whoever decides what ships.

## Ten-minute start

Pick the path that matches what you already have. Every path ends at the same
place: a running Rubrist, an owner account, and one Check over one real Run.

### a. Claude Code plugin

If Rubrist is already running somewhere (see paths b, c, or d), let the plugin
do the rest:

```text
/plugin marketplace add luka-zivkovic/rubrist
/plugin install rubrist@rubrist
```

Open Claude Code in the project you want to evaluate and run
`/rubrist:rubrist-setup`. The skill reads safe project text, asks one short
question, shows a plain-language proposed Check, and connects it after you
choose **Finish setup**. `/rubrist:rubrist-audit` then captures real examples
and submits them. The agent connection it uses needs a Rubrist running in
Postgres mode (paths b or c). Codex and other harnesses copy the same two
skill folders; see the [agent setup guide](docs/agent-setup.md).

### b. Self-host the published images

You need Docker Engine with Compose v2. This uses the release-owned bundle in
[`deploy/self-host/compose.yaml`](deploy/self-host/compose.yaml) and the
images published on GHCR. `v0.3.0` is the first release under the Rubrist
name. Create a clean database: the renamed baseline is incompatible with
Coeval `v0.2.0`; do not reuse its database volume or environment file.

```bash
mkdir rubrist && cd rubrist
curl -fsSLO https://raw.githubusercontent.com/luka-zivkovic/rubrist/v0.3.0/deploy/self-host/compose.yaml
cat > .env <<EOF
RUBRIST_VERSION=0.3.0
RUBRIST_POSTGRES_PASSWORD=$(openssl rand -hex 24)
RUBRIST_AUTH_SECRET=$(openssl rand -base64 32)
RUBRIST_PUBLIC_URL=http://localhost:8081
EOF
docker compose up -d
curl --fail http://localhost:8081/health
```

`RUBRIST_VERSION`, `RUBRIST_POSTGRES_PASSWORD`, and `RUBRIST_AUTH_SECRET` are
required; the bundle refuses to start without them. `RUBRIST_PUBLIC_URL`
defaults to `http://localhost:8081` and must match the address you open in a
browser. Optional: `RUBRIST_BIND_ADDRESS` (default `127.0.0.1`), `RUBRIST_PORT`
(default `8081`), `RUBRIST_POSTGRES_DB` (default `rubrist`), and
`RUBRIST_BOOTSTRAP_TOKEN` for headless administration. Keep `.env` out of Git
and keep `RUBRIST_AUTH_SECRET` in a recovery record: it also encrypts stored
credentials.

Open [http://localhost:8081](http://localhost:8081), create the first owner,
and follow the Guided setup ledger. Judge-provider keys are not part of the
bundle; add an Anthropic or OpenAI key per project under **Settings**, where
it is encrypted at rest. Use an exact version, never `latest`; see
[self-hosting](docs/self-hosting.md) for updates, backups, and Coolify.

### c. From source

Prerequisites: Node.js 24 or newer, pnpm 10.33 or newer, Docker for local
Postgres, and an optional Anthropic or OpenAI API key for real judging.

```bash
git clone https://github.com/luka-zivkovic/rubrist.git
cd rubrist
pnpm install
cp .env.example .env
docker compose -f docker-compose.pg.yml up -d
```

Generate a Better Auth secret with `openssl rand -base64 32` and add it to
`.env`, together with an optional judge provider key:

```dotenv
DATABASE_URL=postgres://rubrist:rubrist@localhost:5432/rubrist
BETTER_AUTH_SECRET=<generated-secret>
BETTER_AUTH_URL=http://localhost:8787
RUBRIST_TRUST_PROXY=0
TRUSTED_ORIGINS=http://localhost:5173

# Optional advanced fallback for setup with no signed-in onboarding session.
# Normal users create a short-lived agent connection in the Rubrist UI.
RUBRIST_BOOTSTRAP_TOKEN=

# Optional. Without one, local demo judging uses a deterministic mock.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

Set `RUBRIST_TRUST_PROXY=1` only when clients cannot bypass your trusted reverse
proxy. Rubrist will then use sanitized forwarded client-IP headers for the
pre-auth onboarding rate limit; direct deployments use the socket address.

Start the API and web app in separate terminals:

```bash
# terminal 1 — tsx does not load .env automatically
set -a; source .env; set +a
pnpm dev:api

# terminal 2
pnpm dev:web
```

Open [http://localhost:5173](http://localhost:5173), create the first owner,
and follow the Guided setup ledger. It uses saved project state to show what
is complete and what to do next. The API runs migrations when `DATABASE_URL`
is configured.

### d. Zero-infrastructure demo mode

Without `DATABASE_URL`, the API starts against in-memory fixtures instead of
Postgres. From a checkout with dependencies installed, and without sourcing
`.env`:

```bash
pnpm dev:api    # prints "Rubrist API listening on http://localhost:8787 (demo)"
pnpm dev:web    # second terminal
```

Open [http://localhost:5173](http://localhost:5173). There is no signup: the
dashboard renders seeded projects directly, judging runs inline with a
deterministic mock unless a provider key is exported, and **Settings → API
keys** mints keys you can use with the batch endpoint below.

Demo mode is for looking around. Its limits: nothing persists across a
restart; authentication is off, so do not expose it on a network; the agent
connection used by the plugin, `RUBRIST_BOOTSTRAP_TOKEN`, independent
(governed) human review, protected sealed calibration, the Analyze study
runtime, and evaluator activation all require the persistent Postgres
workspace.

### Your first Check

You do not need to learn evaluator-governance terminology first. Rubrist
defaults to a **Guided** view that keeps the core journey visible, explains
what each step changes, and leaves secondary diagnostics and system details
out of the way. A typical first project looks like this:

1. adding traces or a few example input-and-output pairs;
2. defining what the evaluator should check;
3. running it and reviewing the cases where its result needs human attention;
4. protecting reviewed cases as regression tests for future evaluator changes;
5. creating a new evaluator version and seeing whether those checks still pass.

Model identifiers, immutable revision details, calibration evidence, and other
technical records remain available in the **Technical** view. Guided mode
changes the presentation, not the evidence, permissions, or safety rules.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset="docs/assets/workflow-mobile.svg">
    <img src="docs/assets/workflow.svg" width="100%" alt="Rubrist workflow: understand failures, review human labels, version evaluators, and retain assessment and calibration evidence.">
  </picture>
</p>

To onboard with an external AI agent, copy the no-secret setup prompt after
creating the owner account (or from a new project's Overview). The bundled
`rubrist-setup` skill inspects safe project context, asks one short question,
and shows a plain-language proposed Check. After you choose **Finish setup**,
create the private agent connection and paste those instructions into Claude,
Codex, or another agent. The connection is project-scoped, single-use, and
expires after 15 minutes; no deployment secret is required. The returned
`rubrist_sk_` key is project-scoped and shown exactly once.
`RUBRIST_BOOTSTRAP_TOKEN` remains an optional advanced fallback for fully
headless administration. Agents may create an explicitly unvalidated Check
and submit real Runs, but human adjudication and Golden promotion remain
session-only.

#### Submit a first batch

Rubrist mints the first project key when the project is created and shows the
plaintext once during onboarding. Save it then, or mint a replacement under
**Settings → API keys**. Export it as `RUBRIST_API_KEY`, then submit a labeled
example (use port `8081` for the self-host bundle):

```bash
curl -X POST http://localhost:8787/api/v1/judge/batch \
  -H "Authorization: Bearer ${RUBRIST_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "sourceTraceId": "quickstart-001",
        "input": { "question": "Can I get a refund?" },
        "output": { "answer": "Refunds are available within 30 days." },
        "expectedLabel": "pass"
      }
    ]
  }'
```

The endpoint returns `202` with a `pollUrl`. Poll that URL until the eval run is complete. `expectedLabel` is optional; unlabeled items are judged but are not counted in agreement.

Trajectory items may also include `steps`, an ordered array of `{ name?, input, output, metadata? }`. Expected failures can include a zero-based `expectedFailStep`.

## Concepts

The Guided view uses the first three words; the Technical view and the
contracts below use the rest.

| Term | Plain meaning |
| --- | --- |
| **Run** | One recorded example of what your AI did: input, output, and optionally the steps in between. |
| **Check** | One reusable automated evaluation of one thing that matters, with a review guide saying when it passes, fails, or lacks evidence. |
| **Result** | What a Check concluded about one Run. It is the evaluator's opinion, not a human decision or permission to ship. |
| **Criterion** | The named quality question a Check measures. Each evaluator measures exactly one; its definition is versioned and never edited in place. |
| **Evaluator version** | One exact rubric, prompt, output contract, and pinned model for a criterion. Runs are judged by a named version, never by "latest". |
| **Human truth** | A person's independent label and rationale for a Run, collected without seeing the evaluator's Result. |
| **Calibration** | Measuring how often an exact evaluator version agrees with human truth on a set it has never been tuned on, with the uncertainty of that measurement shown. |
| **Dataset roles** | Every immutable set of Runs is marked by how it has been used: analysis, iterative development, sealed validation, or regression/golden. Rubrist records exposure so a set used for tuning cannot later be passed off as a blind validation set. |
| **Receipt** | The persisted, byte-exact record of one assessment: which evaluator version judged which Runs and what it returned. It carries no pass threshold or ship decision. |
| **Suite** | An ordered list of criteria, each bound to an exact evaluator version, with no weights, thresholds, or combined score. |

## Rubrist is not

These are decisions Rubrist deliberately leaves to other tools or to people,
per the [product charter](PRODUCT.md):

- **Not a release gate.** It does not decide whether a product change should
  ship.
- **Not a threshold policy.** It does not set acceptable pass-rate,
  regression, cost, or latency limits for a release.
- **Not a deployment tool.** It does not manage rollout percentages,
  promotion, rollback, or overrides.
- **Not a supply-chain scanner.** It does not decide whether a static agent
  capability artifact is safe to install.
- **Not a replacement for your tracing platform.** It imports from LangSmith,
  Langfuse, or Ironside and syncs assessments back rather than storing your
  traces for you.

## Where Rubrist fits

Rubrist is one of a few small, separately installable tools. Each does one job;
none requires the others.

| Tool | Job | Status with Rubrist |
| --- | --- | --- |
| [Ironside](https://github.com/luka-zivkovic/ironside) | Records what your AI did: traces via the SDK, JSON, or OTLP. | Trace source. Rubrist consumes Ironside's native versioned evaluator feed and writes criterion-specific assessments back; verified end to end. Imported traces link back to Ironside's viewer, and Ironside can deep-link into Rubrist's copy of a trace ([trace links](docs/ironside-integration.md#trace-links)). |
| [Dailies](https://github.com/luka-zivkovic/dailies) | Decides whether an AI change meets customer-owned release rules. | Evidence consumer. Dailies verifies Rubrist receipts and binary-calibration artifacts and applies its own policy; implemented, with no network lookup of Rubrist. |
| [Casefile](https://github.com/luka-zivkovic/casefile) | Statically inspects agent skills and plugins before installation. | No runtime integration. It is the scanner used on the plugin in this repository. |

Use `dailies@0.4.0` or later with Rubrist 0.3.0 evidence. The older
`dailies@0.3.x` packages expect Coeval identifiers and are incompatible.
[Rubrist Stack](https://github.com/luka-zivkovic/rubrist-stack) pins the
compatible released server, consumer and plugins together.

Traces in Ironside can feed Rubrist, and Rubrist's evidence can feed Dailies,
without any of the three owning the others' data. Many mature products
combine traces, datasets, experiments, human annotation, and judge
calibration; the claims Rubrist still has to prove are recorded in
[docs/positioning.md](docs/positioning.md).

## How the pieces connect

| You want to… | Rubrist helps you… |
| --- | --- |
| Understand recurring failures | Inspect traces and develop a human-authored failure taxonomy. |
| Judge a specific behavior | Define one criterion and version the evaluator that measures it. |
| Check the evaluator itself | Compare its judgments with reviewed human labels and retain calibration evidence. |
| Improve it without losing history | Re-run known failures and inspect evidence for exact evaluator versions. |

Rubrist complements tracing platforms rather than replacing them. It can import traces from LangSmith or Langfuse, or use Ironside's native versioned evaluator feed, and sync recorded assessments back to the source.

<details>
<summary><strong>Explore the full feature set</strong></summary>

- Multiple independently versioned evaluation criteria per project, each with
  its own judging-skill lineage, human evidence, and exact definition binding.
- Immutable, policy-free evaluator-suite manifests that bind ordered criterion
  definitions to exact evaluator versions without changing assessment receipt v1.
- Binary, scalar, and categorical structured verdicts. Binary evaluators can
  explicitly return `ambiguous` to abstain instead of being forced to pass or fail.
- Bulk trace judging with asynchronous eval runs.
- Governed human review with immutable instructions, independent assignments,
  abstention, append-only alignment/adjudication, and case-less sealed intake.
- Owner-launched, single-trial sealed binary calibration with crash-safe
  execution, aggregate-only immutable artifacts, and separate current
  admissibility status.
- Legacy human exception review, adjudication, and named review queues for
  unblinded triage, explicitly classified `ungoverned_legacy`.
- A human-curated known-failure set, materialized as immutable revisions, that checks evaluator-version regressions.
- Mutable working collections plus immutable, digest-addressed analysis and development revisions.
- Dataset-first **Skill Bench** projects for teams without production traces.
- LangSmith and Langfuse import, polling, and feedback sync.
- Native Ironside project verification, settled trace-version import, cursor recovery, and criterion-specific assessment writeback.
- Agent-trajectory evaluation with ordered steps and expected failing-step labels.
- Per-project Anthropic or OpenAI judge keys encrypted at rest.
- Judge Cards and portable [SkillFormat v1](spec/skill-format-v1.md) exports.
- A small CI gate client in [`tools/ci/gate.mjs`](tools/ci/gate.mjs).

</details>

## Set up and audit from Claude Code (and other agents)

Two bundled skills carry the workflow into your agent. The Claude Code plugin
in [`plugins/rubrist`](plugins/rubrist/) ships both:

| Skill | What it does |
| --- | --- |
| [rubrist-setup](plugins/rubrist/skills/rubrist-setup/) | Reads safe project context, proposes a **Starter · unvalidated** Check, and connects it after **Finish setup**. |
| [rubrist-audit](plugins/rubrist/skills/rubrist-audit/) | Captures real input/output examples, submits Runs, and explains the resulting assessments. |

Claude Code users install the plugin as shown in the
[ten-minute start](#a-claude-code-plugin). Codex and other harnesses
copy both folders in full using the
[harness-specific commands](docs/agent-setup.md#copy-the-skill-folders).
Then ask your agent to "initialize Rubrist for this project" or "audit my skill
with Rubrist." Manual capture works across harnesses; the optional automatic
capture hook is specific to Claude Code. Submission is explicit by default.

Unlabeled assessments are evaluator opinions, not verified correctness.
Human adjudication and Golden promotion stay in the dashboard.

You can also hand the whole installation to a coding agent. Paste this into a
Claude Code, Codex, or other terminal-capable agent session in the directory
where you keep your projects:

```text
Set up Rubrist locally from https://github.com/luka-zivkovic/rubrist.
Read its README and docs/agent-setup.md first, check the prerequisites,
and follow the local installation steps. Keep existing files and services
intact. Start the API and web app, verify their URLs, and guide me through
owner signup and my first Check. Keep credentials out of chat and Git.
Then help me install rubrist-setup and rubrist-audit for this harness.
```

The [agent setup guide](docs/agent-setup.md) covers the plugin, Codex skill
installation, other harnesses, first-run verification, and the optional
[MCP connection](tools/mcp/README.md). The skills help you set up and use a
Rubrist project; the Rubrist service still needs to be running.

## Judgment in CI

The repository includes a dependency-free CI client:

```bash
RUBRIST_URL=https://your-rubrist.example \
RUBRIST_API_KEY=rubrist_sk_... \
node tools/ci/gate.mjs tools/ci/examples.jsonl --min-agreement 1.0
```

Input is JSONL with one object per line:

```json
{"input":{"question":"Refund?"},"output":{"answer":"Within 30 days."},"expected":"pass"}
```

Exit codes are:

- `0`: agreement met the configured threshold
- `1`: the gate was blocked or judging infrastructure failed
- `2`: invalid configuration or input

Unchanged examples reuse recorded verdicts; edited examples are judged again. Infrastructure errors never become passing judgments.

`gate.mjs --product` now exits locally with code `2`, and
`POST /api/v1/gate-checks` returns `410 Gone`; historical gate reads remain
available. New release integrations submit `purpose: "release_evidence"` to
`POST /api/v1/judge/batch`, verify the policy-free assessment receipt, and
apply thresholds or ship/hold policy in the release layer—not in Rubrist.
Receipt v1 is a closed wire contract with portable schema and interoperability
fixtures in [`contracts/`](contracts/). Calibration transport is now the
separate aggregate-only `rubrist/binary-calibration/v1` contract accepted by
ADR-0009. The current Postgres runtime executes one trial per governed sealed
binary item and mints that separate artifact; it is not added to receipt v1.
Dailies independently verifies the frozen calibration contract and corpus and
consumes explicitly configured local artifacts through config v6, policy v2,
report v6, runner, and CLI paths. It performs no network or latest-artifact
lookup. Other uncertainty transport remains unresolved. Current receipts are
derived once at terminalization and persisted as exact canonical bytes in
append-only PostgreSQL artifacts. Historical terminal v1 runs freeze once on
their first receipt read. Later source-row changes cannot alter the stored
root; governed
corrections append linked successors, and consumer-held canonical copies can
be recorded as exact matches or divergences without overwriting history. See
[the storage contract](docs/receipt-artifact-v1.md) and
[ADR-0006](docs/decisions/0006-receipt-artifact-storage-and-freeze.md).

<details>
<summary><strong>Technical reference: datasets, human review, calibration, and evaluator lifecycle</strong></summary>

## Working collections and immutable revisions

Datasets remain mutable working collections for authoring. An owner can freeze
a collection as an immutable `analysis_authoring` or `iterative_development`
revision and run that exact snapshot later. Each revision retains redacted item
snapshots, exact pre-redaction input identities, reference-label provenance,
content and revision digests, lineage, and append-only exposure evidence.

`sealed_validation` cannot be created through the ordinary collection API:
Rubrist will not manufacture a blind-validation claim from visible historical
data. It is created only from the governed case-less sealed-intake path
described below. `regression_golden` is likewise not a public
collection-freeze role;
golden promotion and retirement alone materialize immutable
`regression_golden` revisions. Every new evaluator version pins one before its
regression job is queued, so queue delay cannot change the evaluated corpus.
See [ADR-0007](docs/decisions/0007-dataset-role-compatibility-and-exposure.md).

## Governed human truth

Governed review is a separate evidence path from the existing verdict and
review-queue ledger. It freezes exact instructions and reviewer-visible bytes,
uses opaque independent assignments, preserves defer/withdraw/alignment and
adjudication events, and never resolves `cannot_determine` or missing coverage
into truth. Sealed intake is case-less and unavailable to ordinary cases,
traces, review queues, exports, and project API keys.

Legacy verdict, adjudication, review-queue, and export responses remain useful
for unblinded triage and carry
`X-Rubrist-Governance-Class: ungoverned_legacy`. They never become governed
evidence. Legacy Cohen's kappa is reported as
undefined, not `1`, when chance-expected agreement is one.

Batch 4 freezes complete sealed human truth, and Batch 5B can now execute one
binary evaluator trial over that case-less revision without copying it into
ordinary cases. Leakage controls are exact projection and byte-replay
guarantees, not a claim that arbitrary content is anonymous.
Representativeness applies only to the named frozen population and qualifying
complete random draw recorded by the batch. Semantic clustering remains
deferred.

See the [governed human-truth contract](docs/governed-human-truth.md),
and [ADR-0008](docs/decisions/0008-governed-human-truth-and-sealed-collection.md).

## Sealed binary calibration

In Postgres mode, a project owner can launch an explicit
`{ kind: "single", trialsPerItem: 1 }` binary calibration from the governed
human-truth screen. The run binds one exact binary evaluator, criterion,
governed sealed-validation revision, selection provenance, provider policy,
and authorization/completion exposure snapshots. The worker records call
start durably before its one provider dispatch; a stranded started attempt is
accounted permanently as `outcome_unknown` and is never called again in that
run. An explicit binary `ambiguous` result is recorded as `abstained`: it is a
valid terminal outcome that lowers classified coverage and never enters the
confusion matrix.

The immutable public-contract artifact is aggregate-only. It carries support,
coverage, confusion-matrix cells, exact metrics and Wilson bounds, error and
unevaluated counts, and requested/observed provider provenance without item
identity, labels, payloads, rationale, or request/response identifiers. Its
private salted ledger is used only inside atomic minting and has no HTTP,
project-key, browser, operator-export, or application read surface.

Run control requires a signed-in project session and launch is owner-only.
Canonical artifact bytes and their separate current-admissibility status are
also restricted to project-owner sessions—even though the aggregate artifact
route is under `/api/v1`; project API keys and member sessions are denied.
Later development exposure can revoke current admissibility without rewriting
the historical artifact.

The frozen contract supports repeated-trial evidence, but the current Rubrist
runtime does not execute it. Dailies currently vends and verifies the same
contract and conformance corpus, consumes explicitly configured local
artifacts, and emits calibration-aware release reports. It never fetches a
latest artifact or Rubrist status, and it has no access to the private ledger.

See the [binary-calibration contract](contracts/binary-calibration-v1.md),
[ADR-0009](docs/decisions/0009-binary-calibration-artifact-contract.md), and
the [runtime architecture](docs/architecture.md).

## Criteria and evaluator suites

Rubrist models one independently judgeable quality claim as a versioned
criterion. Each evaluator lineage belongs to one stable criterion, and every
evaluator version pins the exact criterion definition revision it measures.
Golden evidence, regression revisions, human review, calibration, imports,
and trust views retain that criterion identity instead of pooling unrelated
quality dimensions.

Projects with several criteria select one explicitly in the web app. Manual,
LangSmith, Langfuse, and Ironside imports snapshot an exact evaluator version
before work is queued; workers never resolve a project-wide “latest” evaluator
at execution time. Single-criterion routes continue to work for projects with
one criterion and fail closed when selection would be ambiguous.

An owner can publish an immutable
[`rubrist/evaluator-suite-manifest/v1`](contracts/evaluator-suite-manifest-v1.md)
artifact that orders criterion definitions and binds each one to an exact
evaluator version, frozen `skillDigest`, output contract, applicability rule,
and optional independent-trial plan. The manifest contains no release roles,
weights, thresholds, aggregate score, or ship decision. Each criterion is
still assessed through a separate, unchanged receipt-v1 artifact; Dailies or
another release layer applies customer policy to that evidence.

## Analyze workflow status

Postgres mode now implements the governed Analyze-to-Measure runtime. Owners can
freeze an exact finite trace population over a database-time window, retain
every resolved exclusion, execute one server-seeded reproducible draw, and
open one append-only coding study over that draw. Governed owners and members
can record multi-label observations, explicit no-failure evidence, completion
and reopening events, revise a flat human-authored taxonomy, and assign active
observations with exact historical coverage. Deadline or owner closure freezes
all selected-item heads and derives the representative claim once; later
completion is acknowledgment only.

An owner may promote one current active taxonomy code from that exact closed
evidence into a revision-1 criterion. Promotion binds every selected
observation and assignment head, atomically records criterion-authoring and
example-selection exposure, and creates no evaluator or truth. Its immutable
ID is the only handoff accepted by an analysis-authoring governed batch for the
exact criterion and source revision. The handoff and analysis-population
revision cannot enter generic dataset, iterative, or sealed source branches; a
separate immutable iterative-development revision may later use the criterion
through the existing nonsealed path. The web flow carries the handoff through
instruction authoring into batch creation without exposing analysis labels or
rationales to blind reviewers.

The separate Traces screen remains an exploratory preview. Its capped,
client-selected sample does not freeze a population, time window, draw, or
digest and must not be described as representative evidence. Analysis payloads
are available only through the dedicated session route that records governed
revision and study-item exposure; ordinary dataset, eval, and governed-review
paths reject these revisions.

[ADR-0010](docs/decisions/0010-representative-analysis-and-taxonomy-lifecycle.md)
is accepted and authorizes this additive runtime. Candidate creation now
requires exact frozen governed nonsealed truth and records one immutable
regression snapshot plus a durable authoring exposure. Lifecycle state—not the
mutable evaluator status—governs every selector: candidates may run only in
explicit nonproduction evaluation, binary-calibration, and retained-regression
contexts; imports, suites, trace tests, release gates, scheduled work, and
implicit judging require an active evaluator with currently admissible sealed
calibration. Activation is an owner action over exact complete calibration and
full passed regression evidence; revocation appends `needs_review`.

The integrated Analyze view now emits one digest-bound
`rubrist/analysis-workflow-measurement/v1` report. Coding completion, named
taxonomy coverage, taxonomy churn, governed reviewer disagreement, calibration
error directions and coverage intervals, and the two artifact durations remain
separate components. Missing, running, incomplete, revoked, or unavailable
evidence remains explicit. Reports contain no composite score, threshold,
customer decision, or evaluator-authority mutation. Project members may read
the database-backed session route; Analyze still renders when no criterion or
evaluator is selected.

The intended runtime and sequencing are documented in
[the architecture](docs/architecture.md),
[ADR-0010](docs/decisions/0010-representative-analysis-and-taxonomy-lifecycle.md),
and the accepted [pre-launch database policy](docs/decisions/0011-prelaunch-blank-slate-database-policy.md).

</details>

## MCP

Rubrist includes a **Model Context Protocol (MCP) server** for harnesses that
support local stdio tools. It lets an agent read project findings and cases,
submit examples, and check agreement on labeled examples.

The harness starts `tools/mcp/index.mjs`; that process connects to the Rubrist
HTTP API using your project key. It is optional: the audit skill can submit
over HTTP without MCP.

**[Connect Claude Code, Codex, or another MCP client →](tools/mcp/README.md)**

## Documentation

- [Agent setup](docs/agent-setup.md) — install the plugin or skills, install the service, and verify the connection.
- [MCP reference](tools/mcp/README.md) — commands, available tools, and current limitations.
- [Self-hosting](docs/self-hosting.md) — deployment and operations.
- [Architecture](docs/architecture.md) — runtime components and evidence boundaries.
- [Guided onboarding](docs/beginner-onboarding-journey.md), [Analyze](docs/analyze-journey.md), and [trace-to-test](docs/trace-to-test-journey.md) — detailed workflows.
- [Product charter](PRODUCT.md), [glossary](docs/glossary.md), and [architecture decisions](docs/decisions/README.md) — product scope and terminology.

This README describes the current implementation. The product charter and
accepted architecture decisions define intended scope; the
[implementation batches](docs/implementation-batches.md) track its delivery.

## Development

```bash
pnpm typecheck
pnpm test
pnpm --filter @rubrist/web build
```

Database-backed tests run against a disposable PostgreSQL 17 container. The
runner migrates one template database, clones it per test, and removes all
test databases and the container afterward:

```bash
pnpm test:pg
```

Set `PG_SMOKE_DATABASE_URL` only when you want the runner to use an existing
local PostgreSQL server instead of starting its own container.

GitHub CI always supplies Postgres; a collection-time guard fails CI if the
database suites would be skipped. Judge execution also has an adversarial
instruction/data-boundary gate. See [Governed judge correctness gates](docs/governed-judge-gates.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Repository layout

```text
apps/api         Hono API, Postgres repository, and pg-boss workers
apps/web         Vite + React dashboard
apps/audit       Structured LLM judge runtime
packages/shared  Shared Zod schemas and API contracts
packages/db      Current PostgreSQL baseline and demo fixtures
packages/queue   pg-boss queue wrapper
plugins/rubrist   Claude Code plugin bundling the rubrist-setup and rubrist-audit skills
deploy           Release-owned Compose bundles for self-hosting
tools/ci         Standalone CI gate client and examples
tools/mcp        Stdio MCP server over the HTTP API
tools/sim        Optional end-to-end simulation harness
spec             Portable SkillFormat specification
```

The architectural overview and core invariants are documented in [docs/architecture.md](docs/architecture.md).

## Security and data handling

- Postgres mode uses Better Auth sessions and project-scoped authorization.
- Onboarding agent connections are project-scoped, hashed at rest, single-use,
  and expire after 15 minutes. The optional `RUBRIST_BOOTSTRAP_TOKEN` is a
  separate instance-owner secret for headless administration only.
- Provider and integration credentials are encrypted with AES-256-GCM using key material derived from `BETTER_AUTH_SECRET`.
- Normalized trace payloads are redacted before judging and review surfaces.
- Project owners can configure excluded JSON paths, trace retention, and full project deletion.
- Skill versions and verdicts are append-only so audit history is not silently rewritten.

Use a strong unique `BETTER_AUTH_SECRET`, HTTPS, a restrictive `TRUSTED_ORIGINS` allowlist, and a private Postgres network for any networked deployment. See [SECURITY.md](SECURITY.md) for more deployment guidance.

## Project status

Rubrist is early-stage software. APIs, migrations, and the SkillFormat specification may evolve before a stable release. Issues and focused pull requests are welcome.

## License

Rubrist is open source under the [MIT License](LICENSE.md). You are free to use, modify, distribute, and self-host it, including in commercial products and hosted services, subject to the license terms.
