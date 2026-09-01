# Repository transaction and state boundaries

Status: **CURRENT implementation guidance**

Last reviewed: 2026-09-02

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

The first CURRENT internal split keeps pure PostgreSQL value/result conversion
in `repository.pg/mappers.ts`. That module owns no pool, client, mutable state,
or query execution. The golden-retirement context query lives in
`repository.pg/golden-commands.ts`; it accepts its caller's `PoolClient`, owns
no connection or transaction, and is mapped as an internal client-scoped
command. Trace identity locking and trace insertion live together in
`repository.pg/trace-import-commands.ts`; both functions accept the caller's
`PoolClient`, so single-trace and dataset-example ingestion retain their
existing transaction owners and all-or-nothing boundary.
Criterion-version resolution, golden-backed regression snapshot preparation,
immutable dataset-revision insertion, retained input-identity recovery, and
human-verdict loading live in `repository.pg/dataset-revision-commands.ts`.
Its five commands keep golden promotion, retirement, public revision creation,
explicit regression-revision creation, and evaluator-version setup on their
existing caller-owned clients.
Eval-run counter terminalization and immutable assessment-receipt minting live
in `repository.pg/assessment-receipt-commands.ts`. Both commands accept the
caller-owned client, so cached run creation, item completion and failure,
historical freeze, consumer comparison, and correction keep receipt creation
inside their existing transactions. Receipt v1 canonical bytes and source
snapshot construction remain unchanged.
`repository-pg-support.test.ts` pins the support module surfaces, the sole
`PgRepository` implementation owner, the complete 161-method public facade,
and representative retirement-context query behavior;
`repository-pg-trace-import-commands.test.ts` pins trace-lock and import
behavior directly, while `repository-pg-dataset-revision-commands.test.ts`
pins the dataset-revision command surface and representative behavior.
`repository-pg-assessment-receipt-commands.test.ts` pins the two receipt/run
commands, fail-closed gate order, counter transitions, canonical minting,
idempotent replay, and the absence of connection or transaction ownership.

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

## DemoRepository shared store, composition, and domain slices (CURRENT)

`DemoRepositoryStore` owns the demo facade's mutable maps, arrays, sets,
counters, scalar pointers, and promise-deduplication state. `DemoRepository`
allocates exactly one store per facade instance; the store is an internal
composition seam and is not re-exported by the public repository module. The
facade implementation lives in `repository/demo-repository.ts`, while
`repository.ts` remains the stable compatibility barrel for `DemoRepository`,
`CoevalRepository`, public errors, contracts, and pure helpers. The root
re-export preserves the exact class binding and public import path. The
CURRENT domain slices are `DemoProjectRepository`, which implements the seven
`ProjectRepositoryPort` methods; `DemoCriterionSuiteRepository`, which
implements the nine `CriterionSuiteRepositoryPort` methods;
`DemoSkillLifecycleRepository`, which implements the fifteen
`SkillLifecycleRepositoryPort` methods; `DemoGoldenEvidenceRepository`,
which implements the eight `GoldenEvidenceRepositoryPort` methods;
`DemoTraceImportRepository`, which implements the seven
`TraceImportRepositoryPort` methods; `DemoCredentialRepository`, which
implements the four `ApiKeyRepositoryPort` methods and four
`JudgeCredentialRepositoryPort` methods; `DemoIntegrationRepository`,
which implements all twenty-three `IntegrationRepositoryPort` methods for
LangSmith, Langfuse, and Ironside; `DemoJudgeFeedbackRepository`, which
implements all ten `JudgeFeedbackRepositoryPort` methods;
`DemoReviewQueueRepository`, which implements all seven
`ReviewQueueRepositoryPort` methods; `DemoRunComparisonRepository`, which
implements all three `RunComparisonRepositoryPort` methods;
`DemoHistoricalGateEvidenceRepository`, which implements all three deprecated
`HistoricalGateEvidenceRepositoryPort` methods;
`DemoTraceTestRepository`, which implements all seven
`TraceTestRepositoryPort` methods; `DemoDatasetRepository`, which
implements all twelve `DatasetRepositoryPort` methods;
`DemoCaseEvidenceRepository`, which implements all twelve
`CaseEvidenceRepositoryPort` methods; and `DemoEvaluationRepository`, which
implements all twenty-five `EvalRunRepositoryPort` methods and all five
`AssessmentReceiptRepositoryPort` methods. `repository/demo-composition.ts`
seeds the exact fixture graph and constructs all fifteen slices once with the
facade's exact store. It gives the project, skill-lifecycle, golden-evidence,
historical-gate-evidence, trace-import, trace-test, dataset, case-evidence,
evaluation, integration, judge-feedback, and review-queue slices only narrow
dependencies.
The criterion/suite, run-comparison, and credential slices receive only that
shared store. The skill, golden-evidence, and historical-gate-evidence slices
receive same-port facade callbacks where their composite operations must
preserve CURRENT subclass dispatch. The trace-test slice resolves a source case
through a lazy facade callback so existing subclass dispatch remains intact.
The trace-import slice resolves skill versions through the facade boundary.
The evaluation slice keeps eval-run terminalization and assessment-receipt
materialization in one shared-store consistency group. Its lazy same-port and
skill callbacks preserve facade polymorphism while terminal release-evidence
runs mint the frozen receipt artifact against the same run/item identities.
Pure golden regression, prior-verdict projection, and health-summary
computations live in `repository/golden-helpers.ts`. The root repository keeps
the same three public exports and exact function identities while the helper
module owns no repository state or release-policy decision.
The integration slice also uses the resolver boundary so scheduled imports
retain exact evaluator-version selection and subclass dispatch. It owns each
provider's public projection, private worker credential context, poll cadence,
selection-failure job, project isolation, and Ironside connection-revision and
opaque-cursor compare-and-set behavior as one cohesive consistency group.
The judge-feedback slice receives only the exact shared store plus the facade's
built-in trace synthesizer and same-port worker-context callback. It keeps
pinned evaluator-version context, idempotent judge-run recording,
provider/source matching, feedback-job deduplication and state transitions, and
Ironside requeue discovery together. Raw provider credentials remain confined
to worker-only feedback contexts; public job lists never expose the
credential-bearing integration objects.
The review-queue slice receives only the exact shared store plus facade
callbacks for project-scoped case existence and current-evaluator selection.
It preserves all-before-insert case validation, immutable criterion-version
binding, tuple deduplication, FIFO assignment, project isolation, lifecycle
idempotency, and multi-criterion ambiguity. Human verdicts continue to mutate
the exact queue-item identities held by that store, so unassigned and
actor-bound completion remains immediately visible without a serialized
handoff.
The run-comparison slice keeps the dataset revision and both eval-run
participants on the exact shared store. It preserves the immutable-revision
consistency check, project isolation, deterministic newest-first ordering,
bounded reads, and defensive copy boundary without creating another eval-run
or dataset owner.
The historical-gate-evidence slice keeps deprecated compatibility rows on the
exact shared store and projects them through the facade's eval-run reads. It
preserves item status/agreement/error snapshots, historical decision
derivation, project isolation, deterministic newest-first ordering, bounded
reads, and same-port facade dispatch without giving Coeval any release-policy
ownership.
The trace-test slice keeps retained source snapshots, append-only draft and
enabled revisions, validation evidence, and content-free funnel idempotency on
the exact shared store. It preserves source-case fallback through the facade,
revision conflicts, validation eligibility, project isolation, defensive
copies, and deterministic reads without changing the current trace-test wire
or lifecycle semantics.
The dataset slice keeps mutable working collections, immutable revision items,
exposure events, idempotency pointers, and regression revision pointers on the
exact shared store. Lazy facade callbacks preserve polymorphic case checks,
trace import, item insertion, same-port reads, and golden-set selection. In
particular, `importDatasetExamples` still snapshots and restores `traces`,
`traceSources`, `caseInputIdentities`, and `datasetItems` in place and still
calls the facade's overridable `importTrace` and `addDatasetItems` methods.
The case-evidence slice keeps case discovery, append-only verdict evidence,
agreement and disagreement summaries, convergence pagination, and queue-item
completion on the exact shared store. Lazy facade callbacks preserve case and
skill reads, evaluator-version history, criterion resolution, evidence
scaffolding exclusion, and demo reviewer-name projection without introducing
a second evidence owner. Human verdict completion therefore mutates the exact
queue-item identities consumed by the review-queue slice.
The credential slice receives only the shared store: API keys return plaintext
exactly once while the store retains only their hashes, judge-provider reads
remain masked, and raw judge credentials remain available only through the
worker lookup. Every public method path remains a direct facade delegation.
The composition factory owns no repository-domain mutable state and does not
read the facade while constructing the slices; its callbacks remain lazy so
CURRENT subclass dispatch is preserved. The actor-name lookup remains the one
intentional module-level fixture map.

The `pnpm repository-boundaries` gate remains PostgreSQL-only, while
`demo-repository-store.test.ts` pins the Demo store inventory and composition
graph. `demo-repository-facade.test.ts` pins the root re-export, deep-module
surface, type-only facade edge, and complete 161-method implementation owner.
`demo-repository-composition.test.ts` pins the composition module's
exact export and declaration surface, fifteen-property order, construction and
return order, one root handoff, lazy facade access, and shared store/provider
identities. `demo-project-repository.test.ts` pins the first slice's ownership,
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
`demo-golden-repository.test.ts` pins the golden-evidence slice's ownership,
single construction, exact store and callback identities, facade polymorphism,
criterion-version scoping, case/example/health projections, promotion and
retirement error identity, frozen revision refresh, and shared visibility.
`demo-trace-import-repository.test.ts` pins the trace-import slice's ownership,
single construction, exact store and resolver identity, facade polymorphism,
trace deduplication and immutable origin metadata, raw-input identity before
redaction, recursion rejection, and import-job lifecycle/counting behavior.
`demo-credential-repository.test.ts` pins the credential slice's dual-port
ownership, single construction, exact store identity, facade delegates,
one-time API-key plaintext and hash-only persistence, revocation, project
isolation, masked judge-provider reads, replacement, and worker-only raw-secret
lookup.
`demo-integration-repository.test.ts` pins the integration slice's whole-port
ownership, single construction, exact shared store and facade resolver,
credential-private public projections, project-isolated worker contexts,
polling cadence and bounded claims, failed exact-version selection evidence,
Ironside quarantine and opaque-cursor compare-and-set behavior, and source
detachment on deletion.
`demo-feedback-repository.test.ts` pins the judge-feedback slice's whole-port
ownership, single construction, exact shared store and both facade callbacks,
pinned-version context, idempotent run recording, source/provider/project
matching, worker-only credential context, sync deduplication, attempts/errors,
and blocked/pending/succeeded transitions.
`demo-review-queue-repository.test.ts` pins the review-queue slice's whole-port
ownership, single construction, exact shared store and both facade callbacks,
all-before-insert validation, criterion binding and ambiguity, tuple dedupe,
FIFO assignment, lifecycle and project isolation, and cross-domain verdict
completion on the same item identities.
`demo-run-comparison-repository.test.ts` pins the run-comparison slice's
whole-port ownership, single construction, exact shared store, facade
delegates, immutable revision/run validation, project isolation, ordering,
limits, legacy nullable-revision behavior, and defensive copies.
`demo-historical-gate-repository.test.ts` pins the historical compatibility
slice's whole-port ownership, single construction, exact shared store and
facade callbacks, polymorphic eval-run and same-port reads, item projection,
vanished-row behavior, project isolation, historical decision derivation,
ordering, filtering, limits, and the default bounded read.
`demo-trace-test-repository.test.ts` pins the trace-test slice's whole-port
ownership, single construction, exact shared store and source-case callback,
facade polymorphism, source snapshots, imported-trace visibility, revisions,
validation defaults and eligibility, enablement, project isolation, ordering,
filtering, defensive copies, and content-free funnel idempotency.
`demo-dataset-repository.test.ts` pins the dataset slice's whole-port ownership,
single construction, exact shared store, six lazy facade callbacks, and the
golden-trace helper identity. It also pins project isolation, immutable
revision defensive copies, and the in-place four-collection rollback plus
successful cross-domain visibility.
`demo-case-evidence-repository.test.ts` pins the case-evidence slice's
whole-port ownership, single construction, exact shared store and eight narrow
dependencies, facade polymorphism across case/skill/convergence reads, project
isolation, demo actor projection, and cross-domain human-verdict completion on
the review queue's exact item identities.
`demo-evaluation-repository.test.ts` pins the evaluation and assessment-receipt
slice's whole-port ownership, single construction, exact shared store and eight
lazy facade callbacks, facade polymorphism across convergence, run-detail,
skill-version, and receipt reads, and defensive frozen-artifact copies on the
same store-owned evidence identities. It directly pins complete and incomplete
terminal receipt minting plus in-place run/item rollback when minting fails.
`golden-repository-helpers.test.ts` pins the three root helper identities, the
complete helper-module export boundary, all six public/private function
signatures, and the absence of classes or module-level mutable variables.

The shared store has these rules:

- it owns all mutable collections and mutable scalar state that were fields on
  `DemoRepository`; domain slices do not copy, mirror, or independently seed
  them;
- cross-domain identities remain object identities, not serialized handoffs;
- append-only evidence arrays, immutable revision histories, idempotency maps,
  in-flight promise maps, dispatch leases, and counters keep their current
  lifetime and ordering;
- the public `DemoRepository` remains the single `CoevalRepository` facade and
  delegates its one-time fixture seeding and fifteen-slice construction to the
  composition factory, never constructing a slice per request;
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
boundary. The orchestration now belongs to the dataset slice but continues to
call the facade's public `importTrace` and `addDatasetItems` methods through
lazy dependencies, so extraction does not split the rollback or bypass
subclass dispatch. Later slices must not turn that four-collection recovery
into partial recovery.

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
