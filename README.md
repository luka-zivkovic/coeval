# Coeval

[![CI](https://github.com/luka-zivkovic/coeval/actions/workflows/ci.yml/badge.svg)](https://github.com/luka-zivkovic/coeval/actions/workflows/ci.yml)
[![License: Sustainable Use v1.0](https://img.shields.io/badge/license-Sustainable%20Use%20v1.0-blue)](LICENSE.md)

**Governed evaluators for AI systems.**

Coeval helps quality owners understand where an AI system falls short, define
how each problem should be judged, and improve the evaluator without losing
the history behind it. You can begin with production traces or a small set of
examples; Coeval keeps the human review, evaluator versions, and resulting
evidence connected as the project grows.

## Beginner-friendly by default

You do not need to learn evaluator-governance terminology before you can get
useful work done. Coeval defaults to a **Guided** view that keeps the core
journey visible, explains what each step changes, and leaves secondary
diagnostics and system details out of the way.

A typical first project looks like this:

1. adding traces or a few example input-and-output pairs;
2. defining what the evaluator should check;
3. running it and reviewing the cases where its result needs human attention;
4. protecting reviewed cases as regression tests for future evaluator changes;
5. creating a new evaluator version and seeing whether those checks still pass.

Model identifiers, immutable revision details, calibration evidence, and other
technical records remain available in the **Technical** view. Guided mode
changes the presentation, not the evidence, permissions, or safety rules.

## How the pieces connect

```text
representative traces and cases
→ failure taxonomy + narrow criteria
→ governed review + versioned evaluators
→ iterative development + sealed validation
→ pinned execution
→ verifiable assessment + calibration evidence
```

Coeval complements tracing platforms rather than replacing them. It can import traces from LangSmith or Langfuse and sync recorded verdicts back to the source.

[`PRODUCT.md`](PRODUCT.md) is authoritative for intended product scope. This
README describes the current implementation. See the shared
[glossary](docs/glossary.md) and [architecture decisions](docs/decisions/README.md)
for the boundaries between Coeval, Dailies, and Casefile. The time-sensitive
[positioning note](docs/positioning.md) explains the intended wedge without
turning competitor features into product authority. The cross-product
[implementation batches](docs/implementation-batches.md) sequence target work
without changing those boundaries. Beginner-facing workflow language is kept
in the [beginner onboarding journey](docs/beginner-onboarding-journey.md),
[Analyze journey](docs/analyze-journey.md), and
[trace-to-test journey](docs/trace-to-test-journey.md) contracts.

## What is included

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
- Agent-trajectory evaluation with ordered steps and expected failing-step labels.
- Per-project Anthropic or OpenAI judge keys encrypted at rest.
- Judge Cards and portable [SkillFormat v1](spec/skill-format-v1.md) exports.
- A small CI gate client in [`tools/ci/gate.mjs`](tools/ci/gate.mjs).

## Quickstart

Prerequisites:

- Node.js 24 or newer
- pnpm 10.33 or newer
- Docker, for local Postgres
- An Anthropic or OpenAI API key for real judging

Install dependencies and start Postgres:

```bash
pnpm install
cp .env.example .env
docker compose -f docker-compose.pg.yml up -d
```

Generate a Better Auth secret:

```bash
openssl rand -base64 32
```

Add it to `.env`, together with an optional judge provider key:

```dotenv
DATABASE_URL=postgres://coeval:coeval@localhost:5432/coeval
BETTER_AUTH_SECRET=<generated-secret>
BETTER_AUTH_URL=http://localhost:8787
COEVAL_TRUST_PROXY=0
TRUSTED_ORIGINS=http://localhost:5173

# Optional advanced fallback for setup with no signed-in onboarding session.
# Normal users create a short-lived agent connection in the Coeval UI.
COEVAL_BOOTSTRAP_TOKEN=

# Optional. Without one, local demo judging uses a deterministic mock.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

Set `COEVAL_TRUST_PROXY=1` only when clients cannot bypass your trusted reverse
proxy. Coeval will then use sanitized forwarded client-IP headers for the
pre-auth onboarding rate limit; direct deployments use the socket address.

Start the API and web app in separate terminals:

```bash
# terminal 1 — tsx does not load .env automatically
set -a; source .env; set +a
pnpm dev:api

# terminal 2
pnpm dev:web
```

Open [http://localhost:5173](http://localhost:5173), create the first owner, and
follow the Guided setup ledger. It uses saved project state to show what is
complete and what to do next. The API runs migrations when `DATABASE_URL` is
configured.

To onboard with an external AI agent, choose **Create agent connection** after
creating the owner account (or from a new project's Overview) and paste the
generated instructions into Claude, Codex, or another agent. The connection is
project-scoped, single-use, and expires after 15 minutes; no deployment secret
is required. The returned `coeval_sk_` key is project-scoped and shown exactly
once. `COEVAL_BOOTSTRAP_TOKEN` remains an optional advanced fallback for fully
headless administration. Agents may scaffold rubrics and submit runs, but
human adjudication and golden-set promotion remain session-only.

### Submit a first batch

Coeval mints the first project key when the project is created and shows the
plaintext once during onboarding. Save it then, or mint a replacement under
**Settings → API keys**. Export it as `COEVAL_API_KEY`, then submit a labeled
example:

```bash
curl -X POST http://localhost:8787/api/v1/judge/batch \
  -H "Authorization: Bearer ${COEVAL_API_KEY}" \
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

## Judgment in CI

The repository includes a dependency-free CI client:

```bash
COEVAL_URL=https://your-coeval.example \
COEVAL_API_KEY=coeval_sk_... \
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
apply thresholds or ship/hold policy in the release layer—not in Coeval.
Receipt v1 is a closed wire contract with portable schema and interoperability
fixtures in [`contracts/`](contracts/). Calibration transport is now the
separate aggregate-only `coeval/binary-calibration/v1` contract accepted by
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

## Working collections and immutable revisions

Datasets remain mutable working collections for authoring. An owner can freeze
a collection as an immutable `analysis_authoring` or `iterative_development`
revision and run that exact snapshot later. Each revision retains redacted item
snapshots, exact pre-redaction input identities, reference-label provenance,
content and revision digests, lineage, and append-only exposure evidence.

`sealed_validation` cannot be created through the ordinary collection API:
Coeval will not manufacture a blind-validation claim from visible historical
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
`X-Coeval-Governance-Class: ungoverned_legacy`. They never become governed
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

The frozen contract supports repeated-trial evidence, but the current Coeval
runtime does not execute it. Dailies currently vends and verifies the same
contract and conformance corpus, consumes explicitly configured local
artifacts, and emits calibration-aware release reports. It never fetches a
latest artifact or Coeval status, and it has no access to the private ledger.

See the [binary-calibration contract](contracts/binary-calibration-v1.md),
[ADR-0009](docs/decisions/0009-binary-calibration-artifact-contract.md), and
the [runtime architecture](docs/architecture.md).

## Criteria and evaluator suites

Coeval models one independently judgeable quality claim as a versioned
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
[`coeval/evaluator-suite-manifest/v1`](contracts/evaluator-suite-manifest-v1.md)
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
`coeval/analysis-workflow-measurement/v1` report. Coding completion, named
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

## Audit your skills from Claude Code (and other agents)

The repository also ships [`skills/coeval-audit/`](skills/coeval-audit/), a portable Agent Skills folder (SKILL.md format) that lets a coding agent audit the developer's own agent skills against a Coeval project: connect a repo to a bench-mode project, capture real skill runs as example lines, submit them through `POST /api/v1/judge/batch`, and report the verdicts. It complements the CI gate above: `gate.mjs` gates the judging skill against labeled examples in CI (its legacy `--product` mode is deprecated in favor of release-evidence receipts), while `coeval-audit` submits an external skill's day-to-day runs for judgment interactively.

To install, copy the folder into your agent's skills directory:

- Claude Code: `~/.claude/skills/coeval-audit/` (personal) or `.claude/skills/coeval-audit/` (per repository)
- Other SKILL.md-compatible tools (Codex CLI, Gemini CLI, Cursor, and others): the tool's documented skills directory

Then ask the agent to "audit my skill with coeval". Configuration is `COEVAL_URL` plus a `coeval_sk_` key in `COEVAL_API_KEY`, from the environment or `.env` — the bundled script parses `.env` itself and never prints the key. Three modes are supported: manual capture, automatic capture with explicit submission (recommended; via a Claude Code Stop hook), and full auto-submit behind an explicit `COEVAL_AUTO_SUBMIT=1` opt-in. Automatic capture is Claude Code-only; everything else is tool-agnostic. The bundled scripts require Node.js 18 or newer.

Unlabeled submissions are reported as the judging skill's opinions, never as verified correctness. `skills/coeval-audit/examples/results.example.jsonl` is for demo instances only — verdicts are append-only, so sample data submitted to a real project stays there.

## Development

```bash
pnpm typecheck
pnpm test
pnpm --filter @coeval/web build
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
tools/ci         Standalone CI gate client and examples
tools/sim        Optional end-to-end simulation harness
spec             Portable SkillFormat specification
```

The architectural overview and core invariants are documented in [docs/architecture.md](docs/architecture.md).

## Security and data handling

- Postgres mode uses Better Auth sessions and project-scoped authorization.
- Onboarding agent connections are project-scoped, hashed at rest, single-use,
  and expire after 15 minutes. The optional `COEVAL_BOOTSTRAP_TOKEN` is a
  separate instance-owner secret for headless administration only.
- Provider and integration credentials are encrypted with AES-256-GCM using key material derived from `BETTER_AUTH_SECRET`.
- Normalized trace payloads are redacted before judging and review surfaces.
- Project owners can configure excluded JSON paths, trace retention, and full project deletion.
- Skill versions and verdicts are append-only so audit history is not silently rewritten.

Use a strong unique `BETTER_AUTH_SECRET`, HTTPS, a restrictive `TRUSTED_ORIGINS` allowlist, and a private Postgres network for any networked deployment. See [SECURITY.md](SECURITY.md) for more deployment guidance.

## Project status

Coeval is early-stage software. APIs, migrations, and the SkillFormat specification may evolve before a stable release. Issues and focused pull requests are welcome.

## License

Coeval is **source-available**, not OSI-approved open source, under the [Coeval Sustainable Use License v1.0](LICENSE.md). Internal business, personal, and non-commercial use are permitted. Offering Coeval as a hosted service or embedding it in a third-party product requires a separate commercial agreement.
