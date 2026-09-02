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
records every connection owner in the CURRENT main PostgreSQL repository graph,
its ordered boundary events and control-flow placement, the one session-lock
delegation, and every internal command that accepts a `PoolClient`. It checks
`apps/api/src/repository.pg.ts` plus checked internal modules under
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
Skill-version numbering, governed reviewer-subject binding, and immutable
version insertion live in `repository.pg/skill-version-commands.ts`. The three
commands accept the caller-owned client, so native criterion setup and pending
evaluator-version creation keep author identity, revision binding, optional
onboarding idempotency, optional credential creation, and version insertion in
their existing transactions.
Judge-provider credential encryption, masked display storage, and the paired
audit record live in `repository.pg/credential-commands.ts`. The command
accepts the caller-owned client, so direct key replacement and agent setup keep
the credential write and audit append inside their existing transactions.
Immutable regression-run insertion lives in
`repository.pg/regression-run-commands.ts`. The command accepts the
caller-owned client, so successful and failed evaluator-gate finalization keep
version status, run evidence, exposure records, and any override audit in their
existing transactions.
Imported-trace, auto-judged-case, and sync-back counter recomputation lives in
`repository.pg/project-counter-commands.ts`. The command accepts the
caller-owned client, so retention pruning refreshes project coverage before its
audit and commit without opening another transaction. All mapped client-scoped
commands are now internal module functions; no `PgRepository` private method is
a mapped client command.
The complete nine-method criterion and policy-free evaluator-suite port lives
in `repository.pg/criterion-suite-repository.ts`. `PgRepository` constructs the
slice once with its exact application pool and retains all nine public facade
methods as direct delegates. Criterion creation, versioning, and immutable
suite-manifest publication therefore keep their existing transaction owners,
client commands, canonical artifacts, errors, and return values while moving
as one consistency group.
The complete seven-method project port lives in
`repository.pg/project-repository.ts`. `PgRepository` constructs the slice
once with the same application pool and lazy callbacks for current evaluator,
golden-set, and exception reads. Project settings, retention, deletion,
dashboard projection, membership-scoped listing, and onboarding evidence
therefore keep their existing transaction boundaries and resolve cross-port
reads through the stable facade rather than binding to future implementation
slices.
The complete four-method project API-key port lives in
`repository.pg/api-key-repository.ts`. `PgRepository` constructs this
stateless slice once with the same pool and keeps direct facade delegates.
Plaintext generation and one-time return, digest-only persistence,
project-scoped listing and revocation, and revoked-key rejection therefore
remain one cohesive credential-lookup boundary without acquiring a connection
or transaction.
The complete five-method assessment-receipt port lives in
`repository.pg/assessment-receipt-repository.ts`. The facade constructs it
once with the same pool. Historical freeze, exact-byte consumer comparison,
and append-only correction each retain their existing transaction owner and
caller-owned mint command; project-scoped reads keep returning persisted bytes
and deterministic revision order. Receipt v1, canonicalization, terminal mint
atomicity, and correction lineage remain unchanged.
The complete four-method judge-provider credential port lives in
`repository.pg/judge-credential-repository.ts`. The facade constructs it once
with the same pool. Masked owner reads never select encrypted credentials,
worker lookup is the sole decrypting path, deletion appends its audit only
after a project-scoped removal, and key replacement retains one mapped
transaction around the existing caller-owned credential command.
The complete three-method run-comparison port lives in
`repository.pg/run-comparison-repository.ts`. The facade constructs it once
with the same pool. Creation preserves the supplied dataset, immutable
revision, evaluator-version, and eval-run identities; project-scoped reads
retain deterministic newest-first ordering and the existing default limit.
The per-case comparison remains a read-time projection outside this storage
slice.
The complete three-method historical gate-evidence compatibility port lives in
`repository.pg/historical-gate-evidence-repository.ts`. The facade constructs
it once with the same pool. Gate and item rows retain their existing atomic
write, and project-scoped reads continue deriving status from recorded eval-run
evidence. This slice preserves deprecated artifacts only; it owns no release
decision, threshold, rollout, or deployment override.
The complete seven-method governed review-queue port lives in
`repository.pg/review-queue-repository.ts`. The facade constructs it once with
the same pool and a lazy current-skill callback. Queue creation and item
addition retain their existing transaction owners, pre-transaction project
validation, immutable criterion-version binding, tuple deduplication, and
position ordering. Project-scoped reads and idempotent close/reopen behavior
remain unchanged. This slice schedules explicit human attention; it owns no
release decision or policy threshold.
The complete seven-method trace/import-job port lives in
`repository.pg/trace-import-repository.ts`. The facade constructs it once with
the same pool plus lazy callbacks to the existing exact-version resolver and
execution authorizer. Single-trace ingestion retains one transaction and its
caller-owned trace command. Import jobs bind the exact authorized evaluator
version before insertion, and every lifecycle read or write remains
project-scoped. Integration selection still resolves through the stable
facade; this slice owns no release decision or policy threshold.
The complete seven-method trace-test port lives in
`repository.pg/trace-test-repository.ts`. The facade constructs it once with
the same pool. Trace-derived source snapshots, append-only draft revisions,
validation attempts, reviewed enablement, and idempotent funnel evidence keep
their existing project scope and transaction owners. A new draft may coexist
with the last enabled revision; this test lifecycle owns no release decision
or policy threshold.
The complete twelve-method dataset port lives in
`repository.pg/dataset-repository.ts`. The facade constructs it once with the
same pool. Mutable collection authoring, atomic bulk example ingestion,
immutable revision creation and reads, content-view exposure evidence, and
governed regression-revision materialization retain their existing project
scope, caller-owned commands, transaction owners, and overlap protections.
Dataset evidence remains input to evaluation rather than a release decision.
The complete eight-method golden-evidence port lives in
`repository.pg/golden-evidence-repository.ts`. The facade constructs it once
with the same pool and lazy singleton-criterion and criterion-version
resolvers. Golden registry reads, portable examples, health, case detail,
promotion, retirement, and trace projection preserve their project scope and
existing atomic evidence boundaries. Golden curation evidence remains
descriptive input to regression governance and does not own a release decision.
The complete twelve-method case-evidence port lives in
`repository.pg/case-evidence-repository.ts`. The facade constructs it once
with the same pool and lazy singleton-criterion, current-skill, and
criterion-version resolvers. Case/verdict reads and writes, agreement and
disagreement summaries, convergence/self-consistency reports, audit reads,
and the project dashboard's exception feed retain their existing scope,
ordering, redaction, and exact evaluator binding. These read models neither
adjudicate truth nor create release policy.
The complete twenty-five-method eval-run port lives in
`repository.pg/eval-run-repository.ts`. The facade constructs it once with the
same pool. Run creation, durable dispatch claims, item execution leases,
terminal counters, receipt minting, and project-scoped reads preserve their
existing transaction owners, idempotency, recovery ordering, and immutable
evidence boundaries. Evaluation results remain measured evidence and do not
make release decisions.
The complete fifteen-method skill-lifecycle port lives in
`repository.pg/skill-lifecycle-repository.ts`. The facade constructs it once
with the same pool, the exact judge-provider factory, and lazy callbacks for
singleton-criterion validation, immutable dataset revision reads, and judge
credentials. Current/latest selection, sign-off, version authoring, regression
execution, terminal failure, and history reads retain their existing locks,
transactions, exact evaluator and dataset bindings, and policy-free status
semantics.
The complete 23-method provider-integration port lives in
`repository.pg/integration-repository.ts`. The facade constructs it once with
the same pool plus lazy callbacks to the exact-version resolver and execution
authorizer. LangSmith, Langfuse, and Ironside configuration, credential tests,
poll claims, import context, remote quarantine, and opaque cursor
compare-and-set therefore remain project-scoped and bind the same authorized
evaluator version. The three provider deletions retain their existing
transaction owners, cleanup ordering, and rollback paths. Failed poll
selection still records fail-closed import evidence; this operational slice
owns no release decision or policy threshold.
The complete ten-method judge-feedback port lives in
`repository.pg/judge-feedback-repository.ts`. The facade constructs it once
with the same pool plus lazy callbacks for the current evaluator version and
execution authorization. Judge-run reads and idempotent writes, feedback-sync
job claims and lifecycle updates, blocked Ironside retry reads, and sync-back
coverage refreshes preserve their existing project scope, ordering, provider
set, and exact-version authorization. Feedback delivery remains assessment
evidence and does not create a release decision.
`repository-pg-support.test.ts` pins the support module surfaces, the sole
`PgRepository` implementation owner, the complete 161-method public facade,
and representative retirement-context query behavior;
`repository-pg-trace-import-commands.test.ts` pins trace-lock and import
behavior directly, while `repository-pg-dataset-revision-commands.test.ts`
pins the dataset-revision command surface and representative behavior.
`repository-pg-assessment-receipt-commands.test.ts` pins the two receipt/run
commands, fail-closed gate order, counter transitions, canonical minting,
idempotent replay, and the absence of connection or transaction ownership.
`repository-pg-assessment-receipt-repository.test.ts` pins the complete
receipt port, one allocation, exact pool identity and facade delegates,
transaction wrappers, exact-byte comparison, project-scoped artifact reads,
revision ordering, and append-only correction bindings.
`repository-pg-skill-version-commands.test.ts` pins the three skill-version
commands, deterministic version numbering, verified durable author subjects,
unknown-legacy handling, complete immutable insert bindings, and the absence
of connection or transaction ownership.
`repository-pg-credential-commands.test.ts` pins the credential upsert,
encrypted payload, masked display, actor-aware audit append, write order, and
the absence of connection or transaction ownership.
`repository-pg-regression-run-commands.test.ts` pins the regression-run insert,
criterion-version binding, optional actor/override/error handling, complete
case evidence, and the absence of connection or transaction ownership.
`repository-pg-project-counter-commands.test.ts` pins all three counter
expressions, product-gate exclusions, distinct-case counting, sync provider
scope, and the absence of connection or transaction ownership.
`repository-pg-criterion-suite-repository.test.ts` pins the complete port,
single allocation, exact pool identity, facade delegates, module surface, and
project-scoped read queries. The existing database-backed criterion/suite suite
continues to pin transaction behavior and immutable manifest evidence.
`repository-pg-project-repository.test.ts` pins the complete project port,
the exact facade constructor composition, one project-slice allocation, exact
pool identity, lazy cross-port callbacks, direct facade delegates, and
project-scoped dashboard and onboarding reads. Existing database-backed project
tests continue to pin settings, retention, deletion, and membership behavior.
`repository-pg-api-key-repository.test.ts` pins the complete API-key port,
single allocation, exact pool identity, direct facade delegates, digest-only
persistence, project scoping, revocation outcomes, and raw-key resolution.
`repository-pg-judge-credential-repository.test.ts` pins the complete
judge-credential port, one allocation, exact pool identity and transaction
wrapper, masked owner reads, audited deletion, and worker-only decryption.
`repository-pg-run-comparison-repository.test.ts` pins the complete
run-comparison port, one allocation, exact pool identity, direct facade
delegates, insert bindings, project scoping, deterministic ordering, limits,
and row mapping.
`repository-pg-historical-gate-evidence-repository.test.ts` pins the complete
historical compatibility port, one allocation, exact pool identity and
transaction wrapper, gate/item bindings, post-commit projection, rollback,
project scoping, derived states, ordering, and limits.
`repository-pg-review-queue-repository.test.ts` pins the complete review-queue
port, one allocation, exact pool identity and lazy facade callback, direct
facade delegates, transaction rollback, immutable criterion selection,
project-scoped reads, ambiguity rejection, tuple deduplication, successful
position ordering, and idempotent close/reopen behavior.
`repository-pg-trace-import-repository.test.ts` pins the complete trace/import
port, one allocation, exact pool identity and lazy facade callbacks, direct
facade delegates, transaction ordering and rollback, exact-version
authorization before insertion, project-scoped lifecycle writes and reads,
database-derived completion counts, row mapping, ordering, limits, and
missing-job failures.
`repository-pg-provider-operations.test.ts` pins the complete integration and
judge-feedback ports, their sole canonical allocations and module edges, exact
pool identity and lazy facade callbacks, direct facade delegates, provider
selection failure evidence, project-scoped provider reads, Ironside cursor
compare-and-set, judge-run idempotency, and ordered sync-back coverage updates.
`repository-pg-trace-dataset-repositories.test.ts` pins the complete trace-test
and dataset ports, their sole canonical allocations and module edges, exact
pool identity, direct facade delegates, project-scoped ordering, idempotent
funnel evidence, dataset content-view exposure, and active-name conflict
translation. It also pins fail-closed sealed/regression role rejection before
a transaction client is acquired. Existing database-backed trace-test and
dataset-revision suites continue to pin the complete transaction and
immutable-evidence behavior.
`repository-pg-golden-case-repositories.test.ts` pins the complete golden and
case evidence ports, their internal read-model helpers, sole canonical
allocations and module edges, exact pool identity, lazy facade dependencies,
direct facade delegates, project-scoped ordering, and fail-closed ambiguous
human-verdict binding. Existing golden, findings, convergence, calibration,
and database-backed suites continue to pin the evidence behavior.
`repository-pg-eval-skill-repositories.test.ts` pins the complete eval-run and
skill-lifecycle ports, internal transaction helpers, sole canonical
allocations and module edges, exact pool and judge-provider-factory identity,
lazy facade dependencies, direct facade delegates with exact signature and
default parity, and fail-closed rejection of analysis-population revisions
before ordinary eval-run insertion. It also pins credential and immutable
revision reads before their transaction connections are acquired. Existing
evaluation, skill-version, regression, receipt, and database-backed suites
continue to pin the complete transaction and lifecycle behavior.

The fixture also pins the one approved external pool handoff from the main
repository:
`authorizeSkillVersionExecution` constructs `PgEvaluatorLifecycleRepository`
with the same pool. That repository owns a separate accepted-ADR lifecycle and
is outside this map; passing `this.pool` to any other external constructor
fails the guard. The internal API-key, assessment-receipt, case-evidence,
criterion/suite, dataset, eval-run, golden-evidence, historical-gate, integration,
judge-credential, judge-feedback, project, review-queue, run-comparison,
skill-lifecycle, trace/import, and trace-test compositions each receive the
constructor's exact pool once and are separately pinned by structural tests.
The project composition also pins its four facade callbacks so later
implementation slices cannot bypass facade dispatch.

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
| Project lifecycle and retention | `PgProjectRepository.updateProjectSettings`, `PgProjectRepository.pruneExpiredTraces`, `PgProjectRepository.deleteProject` |
| Criterion and suite definitions | `PgCriterionSuiteRepository.createCriterion`, `PgCriterionSuiteRepository.createCriterionVersion`, `PgCriterionSuiteRepository.createEvaluatorSuiteManifest` |
| Golden evidence and frozen datasets | `PgGoldenEvidenceRepository.promoteExceptionToGoldenSet`, `PgGoldenEvidenceRepository.retireGoldenSetEntry`, `PgDatasetRepository.createDatasetRevision`, `PgDatasetRepository.getOrCreateRegressionDatasetRevision` |
| Trace and dataset-example ingestion | `PgTraceImportRepository.importTrace`, `PgDatasetRepository.importDatasetExamples` |
| Credentials and integrations | `PgJudgeCredentialRepository.setJudgeProviderKey`, `PgIntegrationRepository.deleteLangSmithIntegration`, `PgIntegrationRepository.deleteLangfuseIntegration`, `PgIntegrationRepository.deleteIronsideIntegration` |
| Trace-test lifecycle | `PgTraceTestRepository.createTraceTest`, `PgTraceTestRepository.reviseTraceTest`, `PgTraceTestRepository.recordTraceTestValidation`, `PgTraceTestRepository.enableTraceTest` |
| Evaluation runs and assessment receipts | `PgEvalRunRepository.createEvalRunOnce`, `PgEvalRunRepository.markEvalRunDispatched`, `PgEvalRunRepository.markEvalRunRunning`, `PgEvalRunRepository.completeEvalRunItem`, `PgEvalRunRepository.failEvalRunItem`, `PgAssessmentReceiptRepository.getOrFreezeAssessmentReceipt`, `PgAssessmentReceiptRepository.compareAssessmentReceiptCopy`, `PgAssessmentReceiptRepository.createAssessmentReceiptCorrection` |
| Historical gate evidence | `PgHistoricalGateEvidenceRepository.createGateCheck` |
| Governed review queues | `PgReviewQueueRepository.createReviewQueue`, `PgReviewQueueRepository.addReviewQueueItems` |
| Evaluator version and regression lifecycle | `PgSkillLifecycleRepository.signOffSkillVersion`, `PgSkillLifecycleRepository.createSkillVersionPending`, `PgSkillLifecycleRepository.runRegressionGateForVersionLocked`, `PgSkillLifecycleRepository.failRegressionGateForVersion` |

This table is a maintained navigation aid, while the JSON fixture is the
executable inventory. Whenever `--write` changes an owner name or count,
compare all 35 transaction names plus the session-lock owner against this
table and update both in the same reviewed change. For module-owned class
methods the table uses the `Class.method` suffix; the JSON fixture also records
the checked source path.

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
