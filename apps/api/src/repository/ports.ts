import type { Trace } from "@coeval/audit/runtime";
import type {
  ApiKey,
  CaseSource,
  ConvergenceAuditPage,
  CreateCriterionInput,
  CreateCriterionVersionInput,
  CreateEvaluatorSuiteManifestInput,
  CreateSkillVersionInput,
  CreatedApiKey,
  CreatedCriterion,
  Criterion,
  CriterionDetail,
  CriterionVersion,
  DashboardSummary,
  Dataset,
  DatasetDetail,
  DatasetItem,
  DatasetRevision,
  DatasetRevisionDetail,
  DisagreementSummary,
  EvalRun,
  EvalRunDetail,
  EvalRunItem,
  EvaluatorExecutionContext,
  EvaluatorSuite,
  EvaluatorSuiteManifest,
  ExceptionDetail,
  FeedbackSyncJob,
  GateCheck,
  GateCheckDetail,
  GateRunJob,
  GoldenSetEntry,
  GoldenSetHealthSummary,
  ImportJobRecord,
  IronsideConnectionTestResult,
  IronsideEvaluatorContext,
  IronsideImportJob,
  IronsideImportTarget,
  IronsideIntegration,
  IronsideIntegrationInput,
  IronsideSyncState,
  JudgeCardAuditEntry,
  JudgeHumanDisagreementSummary,
  JudgeKeyProvider,
  JudgeProviderKey,
  JudgeRun,
  JudgeRunJob,
  KappaSummary,
  LangSmithConnectionTestResult,
  LangSmithImportJob,
  LangSmithImportTarget,
  LangSmithIntegration,
  LangSmithIntegrationInput,
  LangfuseConnectionTestResult,
  LangfuseImportJob,
  LangfuseImportTarget,
  LangfuseIntegration,
  LangfuseIntegrationInput,
  ManualTraceImportInput,
  OnboardingEvidenceInventory,
  Project,
  ProjectSettings,
  RegressionRunResult,
  RetentionPruneResult,
  ReviewQueue,
  ReviewQueueDetail,
  ReviewQueueItem,
  ReviewQueueStatus,
  RunComparison,
  SelfConsistencyReport,
  Skill,
  SkillFormatExample,
  SkillVersion,
  TraceTestDetail,
  TraceTestSummary,
  TraceTestValidation,
  UpdateIronsideIntegrationInput,
  UpdateLangSmithIntegrationInput,
  UpdateLangfuseIntegrationInput,
  UpdateProjectSettingsInput,
  VerdictRecord
} from "@coeval/shared";
import type {
  AddDatasetItemsInputDb,
  AddQueueItemsInputDb,
  AssessmentReceiptArtifact,
  AssessmentReceiptComparison,
  CaseListEntry,
  ClaimIronsideImportTargetsInput,
  ClaimLangSmithImportTargetsInput,
  ClaimLangfuseImportTargetsInput,
  CompareAssessmentReceiptCopyInput,
  CompleteEvalRunItemInputDb,
  CompleteImportJobInput,
  ConvergenceAuditPageInput,
  CreateApiKeyInputDb,
  CreateAssessmentReceiptCorrectionInput,
  CreateConvergenceEvalRunInputDb,
  CreateDatasetInputDb,
  CreateDatasetRevisionDbInput,
  CreateEvalRunInputDb,
  CreateGateCheckInputDb,
  CreateImportJobInput,
  CreateImportedCaseEvalRunInputDb,
  CreateReviewQueueInputDb,
  CreateRunComparisonInputDb,
  CreateSkillVersionContext,
  CreateTraceTestInputDb,
  EnableTraceTestInputDb,
  EvalRunDispatchClaim,
  EvalRunDispatchInputDb,
  EvalRunItemExecutionClaim,
  EvalRunItemExecutionInputDb,
  EvalRunItemReleaseDisposition,
  EvalRunItemReleaseOptions,
  FailEvalRunItemInputDb,
  FeedbackSyncContext,
  FeedbackSyncJobListItem,
  FeedbackSyncJobRecord,
  FeedbackSyncProvider,
  ImportDatasetExamplesDbInput,
  ImportDatasetExamplesDbResult,
  IronsideImportContext,
  JudgeRunContext,
  LangSmithImportContext,
  LangfuseImportContext,
  ListCasesOptions,
  ListFeedbackSyncJobsInput,
  ListImportJobsInput,
  ListVerdictsInput,
  PromoteExceptionToGoldenSetInput,
  RecordJudgeRunInput,
  RecordTraceTestFunnelEventInputDb,
  RecordTraceTestValidationInputDb,
  RecordVerdictInput,
  RetireGoldenSetEntryInput,
  ReviseTraceTestInputDb,
  StaleEvalRunItemExecution,
  TraceImportContext,
  TraceImportResult
} from "./contracts.js";

// Narrow consumer/type-composition ports. They organize the facade for callers;
// they are not implementation or transaction boundaries. Cross-port atomic work
// must continue to follow docs/repository-boundaries.md and share one client.
export interface ProjectRepositoryPort {
  listProjects(userId?: string | undefined): Promise<Project[]>;
  getProjectSettings(projectId: string): Promise<ProjectSettings>;
  updateProjectSettings(projectId: string, input: UpdateProjectSettingsInput, context: { actorUserId?: string | undefined }): Promise<ProjectSettings>;
  pruneExpiredTraces(projectId: string, context: { actorUserId?: string | undefined; now?: Date | undefined }): Promise<RetentionPruneResult>;
  deleteProject(projectId: string, input: { confirmProjectName: string; actorUserId?: string | undefined }): Promise<void>;
  getDashboardSummary(projectId: string, criterionId?: string | undefined): Promise<DashboardSummary>;
  getOnboardingEvidenceInventory(projectId: string): Promise<OnboardingEvidenceInventory>;
}

export interface CriterionSuiteRepositoryPort {
  listCriteria(projectId: string): Promise<Criterion[]>;
  getCriterion(projectId: string, criterionId: string): Promise<CriterionDetail | null>;
  createCriterion(
    projectId: string,
    input: CreateCriterionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CreatedCriterion>;
  createCriterionVersion(
    projectId: string,
    criterionId: string,
    input: CreateCriterionVersionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CriterionVersion | null>;
  listEvaluatorSuites(projectId: string): Promise<EvaluatorSuite[]>;
  getEvaluatorSuite(projectId: string, suiteId: string): Promise<EvaluatorSuite | null>;
  createEvaluatorSuiteManifest(
    projectId: string,
    input: CreateEvaluatorSuiteManifestInput,
    context: { actorUserId?: string | undefined }
  ): Promise<EvaluatorSuiteManifest>;
  listEvaluatorSuiteManifests(projectId: string, suiteId?: string | undefined): Promise<EvaluatorSuiteManifest[]>;
  getEvaluatorSuiteManifest(projectId: string, manifestId: string): Promise<EvaluatorSuiteManifest | null>;
}

export interface SkillLifecycleRepositoryPort {
  getCurrentSkill(projectId: string): Promise<Skill>;
  getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill>;
  getLatestSkillForCriterion(projectId: string, criterionId: string): Promise<Skill>;
  // The newest version regardless of status — the editing base and the gate's
  // comparison baseline. getCurrentSkill is what judges production traffic; a
  // gate-blocked draft is only reachable through this method.
  getLatestSkill(projectId: string): Promise<Skill>;
  getSkillVersion(projectId: string, skillVersionId: string): Promise<SkillVersion | null>;
  authorizeSkillVersionExecution(input: {
    projectId: string;
    skillVersionId: string;
    context: EvaluatorExecutionContext;
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }): Promise<void>;
  getCriterionVersionForSkillVersion(
    projectId: string,
    skillVersionId: string
  ): Promise<CriterionVersion | null>;
  // P0-1 onboarding: approve the starter draft as-is, without re-judging.
  // Only a never-approved draft is signable — anything else throws
  // SkillVersionNotSignableError (approved versions go through the gate).
  // Returns null when the version doesn't exist in the project.
  signOffSkillVersion(
    projectId: string,
    skillId: string,
    versionId: string,
    context: { actorUserId?: string | undefined }
  ): Promise<SkillVersion | null>;
  createSkillVersion(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }>;
  // Async gate split (M0 C5a): insert a `calibrating` version with no run
  // (refuses 503-style when the pinned provider has no credentials), then the
  // gate.run worker executes the gate and persists the outcome.
  createSkillVersionPending(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<SkillVersion>;
  runRegressionGateForVersion(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }>;
  // Idempotently terminalize a valid gate job that cannot complete. This is
  // called for permanent failures and on the final queue attempt.
  failRegressionGateForVersion(job: GateRunJob, error: unknown): Promise<void>;
  // skill version history. Returns versions newest first, capped at
  // `limit` (default 50). Used by the dashboard's Version history card to
  // render the audit trail + per-field comparison against the previous
  // version.
  listSkillVersions(projectId: string, skillId: string, limit?: number): Promise<SkillVersion[]>;
  // Batch companion for the version-history ledger. Returns at most the most
  // recent immutable regression receipt for each requested version, without
  // forcing the client to issue one request per history row.
  listRegressionRunsForVersions(projectId: string, skillVersionIds: string[]): Promise<RegressionRunResult[]>;
  // read back the most recent regression run for a skill version (incl.
  // its per-case diff) so the version's Judge Card can show "what flipped when
  // this shipped." Returns null when no run was recorded for the version.
  getRegressionRunForVersion(projectId: string, skillVersionId: string): Promise<RegressionRunResult | null>;
}

export interface GoldenEvidenceRepositoryPort {
  listGoldenSet(projectId: string, criterionVersionId?: string | undefined): Promise<GoldenSetEntry[]>;
  // golden cases as portable SkillFormat examples — label + redacted
  // trace input/output + reason, capped. The examples half of the export.
  getSkillFormatExamples(
    projectId: string,
    cap: number,
    criterionVersionId?: string | undefined
  ): Promise<SkillFormatExample[]>;
  getGoldenSetHealth(projectId: string, criterionVersionId?: string | undefined): Promise<GoldenSetHealthSummary>;
  getExceptionDetail(projectId: string, caseId: string, skillVersionId?: string | undefined): Promise<ExceptionDetail>;
  // generic case detail (any verdict). Null when the case has no judge
  // run. Used by surfaces (e.g. the regression diff) that link to a case which
  // may not be a current exception.
  getCaseDetail(projectId: string, caseId: string, skillVersionId?: string | undefined): Promise<ExceptionDetail | null>;
  promoteExceptionToGoldenSet(input: PromoteExceptionToGoldenSetInput): Promise<GoldenSetEntry>;
  retireGoldenSetEntry(input: RetireGoldenSetEntryInput): Promise<void>;
  // Golden traces (keyed by caseId) supply the input half of each derived
  // candidate case used by the historical gate-evidence compatibility path.
  getGoldenSetTraces(projectId: string, criterionVersionId?: string | undefined): Promise<Map<string, Trace>>;
}

export interface TraceImportRepositoryPort {
  importTrace(projectId: string, source: CaseSource, input: ManualTraceImportInput, context: TraceImportContext): Promise<TraceImportResult>;
  createImportJob(input: CreateImportJobInput): Promise<ImportJobRecord>;
  markImportJobQueued(projectId: string, importJobId: string, queueJobId: string): Promise<ImportJobRecord>;
  markImportJobRunning(projectId: string, importJobId: string): Promise<void>;
  markImportJobCompleted(projectId: string, importJobId: string, result: CompleteImportJobInput): Promise<void>;
  markImportJobFailed(projectId: string, importJobId: string, error: unknown): Promise<ImportJobRecord>;
  listImportJobs(input: ListImportJobsInput): Promise<ImportJobRecord[]>;
}

export interface IntegrationRepositoryPort {
  listLangSmithIntegrations(projectId: string): Promise<LangSmithIntegration[]>;
  createLangSmithIntegration(projectId: string, input: LangSmithIntegrationInput): Promise<LangSmithIntegration>;
  updateLangSmithIntegration(projectId: string, integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration>;
  recordLangSmithConnectionTest(projectId: string, integrationId: string, result: LangSmithConnectionTestResult): Promise<void>;
  deleteLangSmithIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void>;
  claimDueLangSmithImportTargets(input: ClaimLangSmithImportTargetsInput): Promise<LangSmithImportTarget[]>;
  loadLangSmithImportContext(job: LangSmithImportJob): Promise<LangSmithImportContext>;
  listLangfuseIntegrations(projectId: string): Promise<LangfuseIntegration[]>;
  createLangfuseIntegration(projectId: string, input: LangfuseIntegrationInput): Promise<LangfuseIntegration>;
  updateLangfuseIntegration(projectId: string, integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration>;
  recordLangfuseConnectionTest(projectId: string, integrationId: string, result: LangfuseConnectionTestResult): Promise<void>;
  deleteLangfuseIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void>;
  claimDueLangfuseImportTargets(input: ClaimLangfuseImportTargetsInput): Promise<LangfuseImportTarget[]>;
  loadLangfuseImportContext(job: LangfuseImportJob): Promise<LangfuseImportContext>;
  listIronsideIntegrations(projectId: string): Promise<IronsideIntegration[]>;
  createIronsideIntegration(projectId: string, input: IronsideIntegrationInput, remote: IronsideEvaluatorContext): Promise<IronsideIntegration>;
  updateIronsideIntegration(
    projectId: string,
    integrationId: string,
    input: UpdateIronsideIntegrationInput,
    remote?: IronsideEvaluatorContext,
    expected?: { remoteProjectId: string; revalidationRequired: boolean; connectionRevision: number }
  ): Promise<IronsideIntegration>;
  recordIronsideConnectionTest(projectId: string, integrationId: string, result: IronsideConnectionTestResult): Promise<void>;
  quarantineIronsideIntegration(
    projectId: string,
    integrationId: string,
    expected: { remoteProjectId: string; connectionRevision: number },
    result: IronsideConnectionTestResult
  ): Promise<boolean>;
  deleteIronsideIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void>;
  claimDueIronsideImportTargets(input: ClaimIronsideImportTargetsInput): Promise<IronsideImportTarget[]>;
  loadIronsideImportContext(job: IronsideImportJob): Promise<IronsideImportContext>;
  // Persists Ironside's opaque evaluator-feed continuation cursor.
  saveIronsideSyncState(projectId: string, integrationId: string, state: IronsideSyncState, expectedCursor?: string | null): Promise<boolean>;
}

export interface JudgeFeedbackRepositoryPort {
  loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext>;
  recordJudgeRun(input: RecordJudgeRunInput): Promise<JudgeRun>;
  createFeedbackSyncJob(input: { projectId: string; judgeRunId: string; provider: FeedbackSyncProvider }): Promise<FeedbackSyncJobRecord | null>;
  loadFeedbackSyncContext(job: FeedbackSyncJob): Promise<FeedbackSyncContext>;
  listFeedbackSyncJobs(input: ListFeedbackSyncJobsInput): Promise<FeedbackSyncJobListItem[]>;
  markFeedbackSyncSucceeded(job: FeedbackSyncJob): Promise<void>;
  markFeedbackSyncFailed(job: FeedbackSyncJob, error: unknown): Promise<void>;
  markFeedbackSyncBlocked(job: FeedbackSyncJob, error: unknown): Promise<void>;
  markFeedbackSyncPending(job: FeedbackSyncJob): Promise<void>;
  listBlockedIronsideFeedbackSyncJobs(projectId: string, integrationId: string): Promise<FeedbackSyncJob[]>;
}

export interface CaseEvidenceRepositoryPort {
  // Support time-scoped skill edits. The gate worker snapshots these ids into
  // one durable backfill EvalRun when timeScope ∈ {existing, both}.
  // Capped at 10k (defensive bound to keep one skill edit from spawning a
  // million-job backfill — operators can split into batches if they really
  // need more).
  listCaseIdsForProject(projectId: string, limit?: number): Promise<string[]>;
  // Machine read for the /api/v1 findings + cases surface (issue #10): newest
  // cases with their stored (ingest-redacted) trace payloads. Excludes
  // gate/release-evidence scaffolding like listCaseIdsForProject. `since`
  // filters strictly-after on createdAt; ordering is createdAt desc, caseId
  // as the deterministic tiebreak.
  listCases(projectId: string, opts?: ListCasesOptions): Promise<CaseListEntry[]>;
  // v2 verdicts (tagged-union payload). Append-only by contract.
  recordVerdict(input: RecordVerdictInput): Promise<VerdictRecord>;
  listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]>;
  caseExistsForProject(projectId: string, caseId: string): Promise<boolean>;
  // Inter-rater agreement summary over the project's human verdicts. Uses the
  // pure function from apps/api/src/lib/kappa.ts (PR #42); this method loads
  // the relevant rows and delegates the math.
  getProjectKappaSummary(projectId: string, criterionVersionId?: string | undefined): Promise<KappaSummary>;
  // LLM-judge vs human-reviewer calibration. Loads both human and
  // llm_judge verdicts and delegates to computeJudgeHumanCalibration. Same
  // KappaSummary shape — synthetic reviewers carry a `judge:` prefix.
  getProjectJudgeHumanCalibration(
    projectId: string,
    criterionVersionId?: string | undefined,
    skillVersionId?: string | undefined
  ): Promise<KappaSummary>;
  // the specific cases where human reviewers disagreed — the cases that
  // drag κ down, ranked by split severity. The high-confidence SECONDARY feed
  // of the convergence loop (needs reviewer overlap).
  getDisagreementSummary(projectId: string, criterionVersionId?: string | undefined): Promise<DisagreementSummary>;
  // A2.2 PRIMARY feed: cases where the LLM judge and human reviewers disagree.
  // Non-empty under single-reviewer exception triage (every reviewed exception
  // has a judge verdict + a human verdict), unlike the human-human surface.
  getJudgeHumanDisagreementSummary(projectId: string, criterionVersionId?: string | undefined): Promise<JudgeHumanDisagreementSummary>;
  // A2.2c: exact convergence totals for a skill version over recorded legacy
  // adjudications, plus a bounded keyset page of the per-case ledger. Judge
  // verdicts are pinned to explicit version ids (not latest-wins).
  getConvergenceAudit(
    projectId: string,
    skillId: string,
    versionId: string,
    input?: ConvergenceAuditPageInput
  ): Promise<ConvergenceAuditPage>;
  // judge self-consistency for a version — does it return the same verdict
  // when re-run on identical input? Computed from that version's repeated
  // llm_judge verdicts. Part of the judge trust report.
  getSelfConsistencyReport(projectId: string, versionId: string): Promise<SelfConsistencyReport>;
  // recorded audit entries for one target (e.g. a skill version's
  // sign-off/override trail). Demo records none and returns [].
  listAuditEntries(projectId: string, targetType: string, targetId: string): Promise<JudgeCardAuditEntry[]>;
}

export interface ReviewQueueRepositoryPort {
  // Annotation queues (PR #47). Owner-curated cohorts for explicit reviewer
  // attention.
  createReviewQueue(input: CreateReviewQueueInputDb): Promise<ReviewQueue>;
  listReviewQueues(projectId: string, opts?: { status?: ReviewQueueStatus | undefined }): Promise<ReviewQueue[]>;
  getReviewQueueDetail(projectId: string, queueId: string): Promise<ReviewQueueDetail | null>;
  // PR #48 — progression + lifecycle
  getNextPendingQueueItem(projectId: string, queueId: string, opts?: {
    assignedToUserId?: string | undefined;
    criterionVersionId?: string | undefined;
  }): Promise<ReviewQueueItem | null>;
  closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null>;
  reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null>;
  // PR #49 — per-item assignment for explicit overlap sampling.
  addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]>;
}

export interface ApiKeyRepositoryPort {
  // Eval-as-a-service API keys. createApiKey returns the plaintext key exactly
  // once; only its hash is persisted. resolveApiKey maps a presented raw key to
  // its project (or null when missing/revoked).
  createApiKey(input: CreateApiKeyInputDb): Promise<CreatedApiKey>;
  listApiKeys(projectId: string): Promise<ApiKey[]>;
  // Returns true if a matching, not-already-revoked key was revoked; false if
  // nothing matched (so the route can answer 404 instead of a silent ok).
  revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean>;
  resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null>;
}

export interface TraceTestRepositoryPort {
  // Trace-derived Tests. Identities retain complete redacted source evidence;
  // revisions and validation attempts append rather than overwrite. A new
  // draft can coexist with the last enabled revision.
  createTraceTest(input: CreateTraceTestInputDb): Promise<TraceTestDetail>;
  listTraceTests(projectId: string, sourceCaseRef?: string | undefined): Promise<TraceTestSummary[]>;
  getTraceTest(projectId: string, traceTestId: string): Promise<TraceTestDetail | null>;
  reviseTraceTest(input: ReviseTraceTestInputDb): Promise<TraceTestDetail>;
  recordTraceTestValidation(input: RecordTraceTestValidationInputDb): Promise<TraceTestValidation>;
  enableTraceTest(input: EnableTraceTestInputDb): Promise<TraceTestDetail>;
  recordTraceTestFunnelEvent(input: RecordTraceTestFunnelEventInputDb): Promise<void>;
}

export interface DatasetRepositoryPort {
  // Datasets: named case collections (the golden set generalized to a
  // user-curated primitive — the golden set itself stays a separate label
  // registry). Items are deduped per dataset; adding an already-present case
  // is a no-op, not an error, so "add these 50" is idempotent.
  createDataset(input: CreateDatasetInputDb): Promise<Dataset>;
  listDatasets(projectId: string): Promise<Dataset[]>;
  // Null when the dataset doesn't exist (or belongs to another project).
  getDatasetDetail(projectId: string, datasetId: string): Promise<DatasetDetail | null>;
  // True if an active dataset was archived; false when nothing matched.
  archiveDataset(projectId: string, datasetId: string): Promise<boolean>;
  // Validates every caseId belongs to the project (throws CaseNotFoundError on
  // the first miss) and returns the full refreshed item list.
  addDatasetItems(input: AddDatasetItemsInputDb): Promise<DatasetItem[]>;
  // Atomic bulk example ingestion: cases + dataset membership all-or-nothing
  // (PG: one transaction; demo: snapshot-rollback). Throws DatasetNotFoundError
  // on a missing/archived dataset without minting any case.
  importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult>;
  // Immutable evidence snapshots. Mutable datasets remain authoring
  // collections; public Batch 2 creation rejects sealed_validation.
  createDatasetRevision(input: CreateDatasetRevisionDbInput): Promise<DatasetRevisionDetail>;
  listDatasetRevisions(projectId: string, sourceDatasetId?: string | undefined): Promise<DatasetRevision[]>;
  getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null>;
  recordDatasetRevisionContentView(input: {
    projectId: string;
    revisionId: string;
    actorUserId?: string | undefined;
  }): Promise<void>;
  // Materializes/reuses the current active golden registry as an immutable
  // regression revision and moves the project pointer atomically.
  getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string | undefined,
    criterionVersionId?: string | undefined
  ): Promise<DatasetRevisionDetail>;
  // True if the item existed and was removed.
  removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean>;
}

export interface JudgeCredentialRepositoryPort {
  // BYO judge keys. list/set/delete return ONLY masked shapes; the raw
  // credential is reachable solely through getJudgeProviderCredential (the
  // worker-facing loader used at provider-construction time).
  setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string, actorUserId?: string): Promise<JudgeProviderKey>;
  listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]>;
  deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, actorUserId?: string): Promise<boolean>;
  getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null>;
}

export interface EvalRunRepositoryPort {
  // Eval runs: judge a snapshot of cases with one skill version. Items are
  // snapshotted at creation (later dataset edits don't rewrite history) and
  // may arrive pre-completed (batch idempotency reuses recorded verdicts).
  // Counters are incremental; completion flips status as a side effect of the
  // last item update — completeEvalRunItem/failEvalRunItem are idempotent
  // under queue retries (a non-pending item is a no-op).
  createEvalRun(input: CreateEvalRunInputDb): Promise<EvalRunDetail>;
  // Idempotent durable outbox row for the Reliability coverage action. The
  // same active (project, evaluator version, case) resolves to one eval run;
  // callers may safely retry queue dispatch for that run. A failed/canceled
  // claim may be replaced by a new attempt.
  createConvergenceEvalRun(input: CreateConvergenceEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }>;
  // One automatic import evaluation per immutable (project, version, case).
  // Import retries and concurrent ingestion converge on this durable row.
  createImportedCaseEvalRun(input: CreateImportedCaseEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }>;
  // Durable queue outbox claim for any eval run. Only the claim holder sends
  // the deterministic queue job; a send failure releases the claim, while a
  // crash can be recovered after the lease without creating another job id.
  claimEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<EvalRunDispatchClaim>;
  // A deterministic queue id that reached a terminal queue state cannot be
  // reinserted by pg-boss. The active DB claim may rotate it exactly once per
  // recovery attempt before dispatching a replacement delivery.
  rotateEvalRunDispatchJob(input: EvalRunDispatchInputDb): Promise<string | null>;
  markEvalRunDispatched(input: EvalRunDispatchInputDb): Promise<void>;
  releaseEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<void>;
  armEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string): Promise<void>;
  markEvalRunRunning(projectId: string, evalRunId: string): Promise<void>;
  listPendingEvalRunItems(projectId: string, evalRunId: string): Promise<EvalRunItem[]>;
  listPendingEvalRunItemDispatches(projectId: string, evalRunId: string): Promise<Array<{
    item: EvalRunItem;
    jobId: string;
  }>>;
  // Atomic provider-execution generation. Concurrent/redelivered handlers do
  // not re-enter a live generation; stale post-dispatch work becomes an
  // explicit outcome-unknown failure instead of another provider call.
  claimEvalRunItemExecution(input: EvalRunItemExecutionInputDb): Promise<EvalRunItemExecutionClaim>;
  rearmEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string, evalRunItemId: string): Promise<boolean>;
  claimEvalRunItemRecovery(input: EvalRunItemExecutionInputDb): Promise<boolean>;
  beginEvalRunItemProviderCall(input: EvalRunItemExecutionInputDb): Promise<boolean>;
  markEvalRunItemProviderCallReturned(input: EvalRunItemExecutionInputDb): Promise<boolean>;
  releaseEvalRunItemExecution(
    input: EvalRunItemExecutionInputDb,
    options?: EvalRunItemReleaseOptions
  ): Promise<EvalRunItemReleaseDisposition>;
  listStaleEvalRunItemExecutions(): Promise<StaleEvalRunItemExecution[]>;
  getEvalRunItem(projectId: string, evalRunId: string, evalRunItemId: string): Promise<EvalRunItem | null>;
  completeEvalRunItem(input: CompleteEvalRunItemInputDb): Promise<{ runFinished: boolean }>;
  failEvalRunItem(input: FailEvalRunItemInputDb): Promise<{ runFinished: boolean }>;
  getEvalRun(projectId: string, evalRunId: string): Promise<EvalRun | null>;
  getEvalRunDetail(projectId: string, evalRunId: string): Promise<EvalRunDetail | null>;
  listEvalRuns(
    projectId: string,
    opts?: { limit?: number | undefined; skillVersionId?: string | undefined }
  ): Promise<EvalRun[]>;
  // Cleanup for partial multi-run creation ONLY: removes a run that never
  // dispatched (still pending, nothing judged or failed). A dispatched run is
  // history and must stay — it may carry verdicts, which are append-only.
  deleteUndispatchedEvalRun(projectId: string, evalRunId: string): Promise<void>;
}

export interface AssessmentReceiptRepositoryPort {
  getOrFreezeAssessmentReceipt(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact | null>;
  getAssessmentReceiptArtifactByReceiptId(projectId: string, receiptId: string): Promise<AssessmentReceiptArtifact | null>;
  listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]>;
  compareAssessmentReceiptCopy(input: CompareAssessmentReceiptCopyInput): Promise<AssessmentReceiptComparison>;
  createAssessmentReceiptCorrection(input: CreateAssessmentReceiptCorrectionInput): Promise<AssessmentReceiptArtifact>;
}

export interface RunComparisonRepositoryPort {
  // Run comparisons (Incident Bisect): a persisted pairing of two eval runs
  // over one dataset. The row only pins the participants — the per-case diff
  // is joined from the runs' items at read time (lib/run-comparison.ts).
  createRunComparison(input: CreateRunComparisonInputDb): Promise<RunComparison>;
  getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null>;
  listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]>;
}

export interface HistoricalGateEvidenceRepositoryPort {
  // CURRENT compatibility ledger for deprecated product-gate evidence. Coeval
  // preserves these historical artifacts but does not decide releases.
  createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail>;
  getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null>;
  listGateChecks(projectId: string, opts?: { limit?: number | undefined }): Promise<GateCheck[]>;
}
