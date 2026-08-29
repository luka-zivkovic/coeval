# ADR-0011: Pre-launch blank-slate database policy

Status: **Accepted**

Date: 2026-08-26

Exit recorded: **2026-08-28**. The first persistent external Coeval
installation was deployed. The `0001_baseline.sql` bytes at SHA-256
`a2d3f9fd5322303b444c56e6c092ff2fa9f4a8318a07514989aee3a844814973`
are frozen from this point. Later schema changes use new append-only forward
migrations; the blank-slate behavior below remains the authoritative history
for databases created before this exit.

## Context

Coeval has no external users, production data, or deployed database that must
survive an upgrade. The current PostgreSQL implementation nevertheless carries
55 ordered migrations, historical-row backfills, rolling-writer compatibility,
late pinning, and runtime read branches for shapes that can only exist after an
upgrade from an earlier development schema.

That mismatch adds product risk rather than reducing it. Database-backed tests
apply the full history repeatedly, and the compatibility paths make it harder
to see which constraints describe the current product. They also preserve
sentinel values and nullable shapes that no clean-install writer can create.

This decision is deliberately narrower than a general license to weaken
compatibility. Coeval's published evidence contracts and the evidence created
by a running clean installation still require strict versioning, append-only
history, immutability, idempotency, concurrency safety, crash recovery, and
governed separation.

## Decision

### Pre-launch database lifecycle

Until the exit condition below is met, the PostgreSQL database is disposable.
Every schema change targets one clean current-schema baseline. Development and
test databases are recreated instead of upgraded from an earlier Coeval
development schema.

The migration runner remains idempotent and serialized so clean installations
can start concurrently and retry safely. It rejects a database whose migration
bookkeeping contains an identifier that is not present in the current baseline
instead of attempting to layer the baseline over an old schema.

Database tests cover:

- creation from an empty PostgreSQL database;
- a second idempotent migration run;
- current constraints, transactions, retries, concurrency, tamper resistance,
  and failure recovery; and
- application behavior against only the current schema.

They do not preserve or test upgrades from superseded pre-launch schemas.
This is the pre-launch interpretation of the upgrade-test requirement in
`docs/implementation-batches.md`; the vendored batch document itself remains
unchanged.

### Runtime compatibility removed with the old schema history

The clean baseline and current runtime remove only states whose sole purpose is
to represent rows or in-flight work from a superseded development database:

- trace-test validation method `legacy` and its tolerant readers and UI state;
- ingestion purposes `unresolved_legacy` and `gate_candidate_legacy`;
- unresolved pre-tracking case identities and the project-wide serialization
  branch that exists only for their null digests;
- nullable or auto-bound criterion references created for pre-0048 writers;
- evaluator-version regression late pinning for pre-migration queued jobs;
- the project-scoped regression pointer and its criterion-pointer mirroring;
- `legacy_skill_backfill` criteria and bootstrap fixtures;
- pre-receipt optional item identifiers and content digests;
- plaintext credential reads for values created before encryption; and
- backfills, preflights, post-conditions, and tolerant column fallbacks that
  exist only to upgrade a prior development schema.

Where an upgrade test also asserts a current invariant, that assertion is moved
to a clean-install test before the upgrade fixture is deleted.

### Current product semantics retained

Names containing `legacy` or `historical` are not removed mechanically. The
following remain current product semantics until a separate accepted decision
changes them:

- `ungoverned_legacy`, which labels live unblinded human-review surfaces and
  prevents them from being mistaken for governed blind truth;
- fail-closed unknown developer identity for evaluator versions that do not
  have a verified project-member subject;
- lower provenance for a newly frozen regression snapshot that lacks reviewed
  verdict provenance;
- the exposure event emitted when such a visible golden snapshot is frozen;
- `historical_freeze`, the idempotent receipt-artifact source used when a
  terminal run has no root artifact;
- deprecated product-gate reads, the `410 Gone` write behavior, and Coeval's
  distinct evaluator `regression_gate` behavior;
- the lifecycle compatibility projection required by ADR-0010; and
- live prompt, judge-message, and ungoverned-review concepts whose names contain
  `legacy` but whose behavior is not an old-database upgrade path.

This decision does not authorize a string-pattern cleanup across those values.
Schema and runtime removals must be column- and behavior-specific.

### Compatibility and invariant boundary

The baseline must preserve all accepted clean-install guarantees, including:

- exact canonical assessment-receipt bytes and append-only correction lineage;
- immutable evaluator, criterion, suite, dataset, governed-review, calibration,
  analysis, taxonomy, and lifecycle evidence;
- sealed-collection identity, capability, and separation-of-duties guards;
- pinned execution and immutable dataset membership;
- durable provider-call starts and `outcome_unknown` crash recovery;
- database-enforced role compatibility and source authority;
- current uniqueness, idempotency, deferred-constraint, and concurrency rules;
  and
- project erasure as the explicit tenant-deletion boundary.

Frozen schemas in `contracts/` remain unchanged. Blank-slate database policy
does not imply wire-contract reinterpretation or deletion of evidence created
after a clean installation starts serving work.

### Baseline verification

The migration history is replaced in two auditable stages:

1. Produce a single baseline whose normalized schema dump is equivalent to the
   schema produced by the complete migration chain.
2. Apply the approved removals above and require every normalized schema-dump
   difference to map to one explicit removal.

The baseline includes tables, columns, defaults, checks, foreign keys, partial
and `NULLS NOT DISTINCT` indexes, functions, ordinary and deferred constraint
triggers, comments, and extension requirements. Historical data-copy
statements are not seed data and are not retained. Demo/bootstrap fixtures are
updated separately to create only current native shapes.

### Exit condition

This policy ends at the earlier of:

1. the first external user or customer data is stored in a non-disposable
   Coeval database;
2. the first external deployment is declared production or persistent; or
3. an accepted decision explicitly freezes the database baseline.

At that point the current baseline is frozen. Every later schema change uses a
new forward migration with deployment, compatibility, rollback/forward-fix,
and upgrade tests proportional to the stored data and supported application
versions.

## Relationship to earlier decisions

This decision narrowly supersedes pre-launch application of:

- ADR-0007's rolling-deployment late pinning and compatibility for rows or jobs
  that predate the criterion/evaluator schema;
- ADR-0008's handling of unresolved historical case identities where such rows
  can exist only because an earlier development schema lacked identity data;
  and
- migration-runbook requirements to backfill, drain, or preserve writers for
  databases that have never been externally deployed.

It does not supersede ADR-0003 or ADR-0006 receipt immutability, ADR-0007's
current dataset-role and exposure rules, ADR-0008 governed truth and sealed
collection, ADR-0009 calibration evidence, or ADR-0010 representative analysis
and lifecycle semantics.

## Consequences

- PostgreSQL setup and tests become faster, smaller, and representative of the
  schema the first real user will receive.
- Current constraints are reviewable without reconstructing years of
  development-only transition states.
- Developers must recreate a pre-launch database after a baseline change.
- There is intentionally no supported upgrade path from migrations 0001-0055
  to the new baseline.
- The launch exit condition must be recorded when it occurs; failing to freeze
  the baseline at that boundary would turn an explicit pre-launch assumption
  into unsafe data loss.
