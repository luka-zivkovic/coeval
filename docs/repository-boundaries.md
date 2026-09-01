# Repository transaction and state boundaries

Status: **CURRENT implementation guidance**

Last reviewed: 2026-08-31

## Purpose

The repository implementations are intentionally being split only after their
consistency boundaries are explicit. A domain filename is not permission to
open a second connection, commit part of an operation early, or duplicate demo
state. This document records the CURRENT boundaries that a structural split
must preserve; it does not define new product behavior.

Run the executable PostgreSQL boundary check from the repository root:

```bash
pnpm repository-boundaries
```

The checked fixture at
[`tools/repository-boundaries.json`](../tools/repository-boundaries.json)
records every connection owner in the CURRENT main `PgRepository`, its ordered
boundary events and control-flow placement, the one session-lock delegation,
and every internal command that accepts a `PoolClient`. It checks
`apps/api/src/repository.pg.ts` plus future internal command modules under
`apps/api/src/repository.pg/`; it does not claim to map the independently
implemented analysis, calibration, governed-review, auth, or migration
repositories. The default command is check-only. After an intentional
boundary change, use `pnpm repository-boundaries -- --write` and review the
entire fixture diff.

The fixture also pins the one approved pool handoff from the main repository:
`authorizeSkillVersionExecution` constructs `PgEvaluatorLifecycleRepository`
with the same pool. That repository owns a separate accepted-ADR lifecycle and
is outside this map; passing the pool to any other constructor fails the guard.

## PostgreSQL ownership rule

Only a mapped connection owner may call `pool.connect()`. A transaction owner
must begin one transaction, retain at least one commit and rollback path,
release its connection exactly once, and never call another connection-owning
repository method. Cross-domain work that belongs to the same atomic operation
must instead call a private client-scoped command with the owner's
`PoolClient`.

The sole non-transaction owner is `runRegressionGateForVersion`. It
intentionally retains its dedicated session-lock connection while delegating
to `runRegressionGateForVersionLocked`, which acquires the one protected
transaction connection. This is the sole approved two-connection nesting in
the mapped repository. Preserve that lock-before-transaction order; do not add
another connection, reverse the ownership, or route either operation through
the general pool while its connection is held.

The 35 transaction owners are grouped by the consistency they protect:

| Consistency group | Connection owners |
| --- | --- |
| Project lifecycle and retention | `updateProjectSettings`, `pruneExpiredTraces`, `deleteProject` |
| Criterion and suite definitions | `createCriterion`, `createCriterionVersion`, `createEvaluatorSuiteManifest` |
| Golden evidence and frozen datasets | `promoteExceptionToGoldenSet`, `retireGoldenSetEntry`, `createDatasetRevision`, `getOrCreateRegressionDatasetRevision` |
| Trace and dataset-example ingestion | `importTrace`, `importDatasetExamples` |
| Credentials and integrations | `setJudgeProviderKey`, `deleteLangSmithIntegration`, `deleteLangfuseIntegration`, `deleteIronsideIntegration` |
| Trace-test lifecycle | `createTraceTest`, `reviseTraceTest`, `recordTraceTestValidation`, `enableTraceTest` |
| Evaluation runs and assessment receipts | `createEvalRunOnce`, `markEvalRunDispatched`, `markEvalRunRunning`, `completeEvalRunItem`, `failEvalRunItem`, `getOrFreezeAssessmentReceipt`, `compareAssessmentReceiptCopy`, `createAssessmentReceiptCorrection` |
| Historical gate evidence | `createGateCheck` |
| Governed review queues | `createReviewQueue`, `addReviewQueueItems` |
| Evaluator version and regression lifecycle | `signOffSkillVersion`, `createSkillVersionPending`, `runRegressionGateForVersionLocked`, `failRegressionGateForVersion` |

This table is a maintained navigation aid, while the JSON fixture is the
executable inventory. Whenever `--write` changes an owner name or count,
compare all 35 transaction names plus the session-lock owner against this
table and update both in the same reviewed change.

Client-scoped commands are the internal seam for future domain modules. They
remain private to the PostgreSQL repository command layer even when their
implementation moves to another file. In particular, golden promotion and
retirement must create the frozen regression revision on the same client;
dataset-example import must create traces and membership on the same client;
candidate creation must bind its revision, credential, and version on the same
client; and terminal evaluation updates must mint receipts on the same client.

## DemoRepository shared store and domain slices (CURRENT; further slices remain TARGET)

`DemoRepositoryStore` owns the demo facade's mutable maps, arrays, sets,
counters, scalar pointers, and promise-deduplication state. `DemoRepository`
allocates exactly one store per facade instance; the store is an internal
composition seam and is not re-exported by the public repository module. The
CURRENT domain slices are `DemoProjectRepository`, which implements the seven
`ProjectRepositoryPort` methods; `DemoCriterionSuiteRepository`, which
implements the nine `CriterionSuiteRepositoryPort` methods; and
`DemoSkillLifecycleRepository`, which implements the fifteen
`SkillLifecycleRepositoryPort` methods. The facade constructs all three once
with its exact store and gives the project and skill-lifecycle slices only
narrow dependencies. The skill slice also receives two same-port facade
callbacks so its composite create operation preserves the CURRENT subclass
dispatch of `createSkillVersionPending` and `runRegressionGateForVersion`.
Every public method path remains a direct facade delegation. Remaining domain
slices are still TARGET work.

The `pnpm repository-boundaries` gate remains PostgreSQL-only, while
`demo-repository-store.test.ts` pins the Demo store inventory and composition
graph. `demo-project-repository.test.ts` pins the first slice's ownership,
single construction, stable facade delegates, and immediate visibility of a
trace imported through another facade domain.
`demo-criterion-repository.test.ts` pins the criterion/suite slice's ownership,
single construction, exact facade delegates, cross-domain evaluator visibility,
and suite binding, retry, and revision behavior.
`demo-skill-repository.test.ts` pins the skill-lifecycle slice's ownership,
single construction, exact store and provider identities, cross-port immutable
regression-revision callbacks, facade polymorphism, selector isolation,
onboarding replay and conflicts, signoff identity, exposure evidence,
terminalization, filtered reads, and shared facade visibility.

The shared store has these rules:

- it owns all mutable collections and mutable scalar state that were fields on
  `DemoRepository`; domain slices do not copy, mirror, or independently seed
  them;
- cross-domain identities remain object identities, not serialized handoffs;
- append-only evidence arrays, immutable revision histories, idempotency maps,
  in-flight promise maps, dispatch leases, and counters keep their current
  lifetime and ordering;
- the public `DemoRepository` remains the single `CoevalRepository` facade and
  creates each CURRENT or future domain slice once in its constructor, never
  per request;
  and
- future slices receive the facade's exact store reference; they do not create
  a store or expose it as public API.

One pre-existing fixture behavior remains outside that extracted field
inventory: signing the seeded demo skill updates the imported
`demoSkill.isStarter` flag. The store guard pins that direct assignment as the
sole syntactically module-origin mutation in the repository graph; code can
also reach the same fixture object through references held by the shared
store. Changing that ownership or behavior requires a separate change rather
than an incidental domain slice.

The shared-store extraction characterizes constructor seeding and every
cross-domain collection before moving methods. A future slice is not complete
merely because its methods compile: behavior tests must prove that writes
through one slice are immediately visible through every other slice that
consumes the same evidence.

CURRENT Demo behavior already has one important compensating transaction:
`importDatasetExamples` snapshots `traces`, `traceSources`,
`caseInputIdentities`, and `datasetItems`, then restores all four after any
mid-flow failure. A shared-store extraction must preserve that whole rollback
boundary; splitting the trace import and dataset-membership writes must not
turn it into partial recovery.

## Extraction order

Repository modules should follow this order:

1. retain `CoevalRepository`, public errors, and the two facade classes at
   their stable import path;
2. introduce the internal client-scoped PostgreSQL command layer and the named
   demo shared store;
3. extract one consistency group at a time, preserving transaction ownership,
   lock order, SQL, return values, and error identity; and
4. move each group's tests with the implementation while retaining the exact
   public repository contract.

Any behavior, schema, authentication, or product change requires its own
authorization and must not be hidden inside these structural batches.
