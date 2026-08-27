import { randomUUID } from "node:crypto";
import { MockJudgeProvider, DEFAULT_OUTPUT_SCHEMA, type JudgeProvider, type JudgePrompt, type JudgeVerdict, type Trace } from "@coeval/audit/runtime";
import { demoExceptions, demoGoldenSet, demoProject, demoSkill, demoSkillPrevVersion, demoVerdicts, getDemoDashboardSummary } from "@coeval/db";
import { capabilityGapsFromExceptions } from "./lib/capability-gaps.js";
import {
  type AssessmentReceipt,
  type Criterion,
  type CriterionDetail,
  type CriterionVersion,
  type CreateCriterionInput,
  type CreateCriterionVersionInput,
  type CreatedCriterion,
  type CreateEvaluatorSuiteManifestInput,
  type EvaluatorSuite,
  type EvaluatorSuiteManifest,
  type EvaluatorExecutionContext,
  type JudgeCardAuditEntry,
  type GateRunJob,
  ApiKey,
  CreatedApiKey,
  CreateSkillVersionInput,
  DashboardSummary,
  Dataset,
  DatasetDetail,
  DatasetExposureEvent,
  DatasetItem,
  DatasetKind,
  DatasetReferenceProvenance,
  DatasetRevision,
  DatasetRevisionDetail,
  DatasetRevisionItem,
  DatasetRevisionPayloadSnapshot,
  DatasetRevisionRole,
  EvalRun,
  EvalRunDetail,
  EvalRunItem,
  EvalRunTrigger,
  GateCheck,
  GateCheckDetail,
  GateCheckItem,
  ExceptionCase,
  ExceptionDetail,
  FeedbackSyncJob,
  GOLDEN_SET_STALE_AFTER_DAYS,
  GoldenSetHealthSummary,
  GoldenSetRetirementContext,
  GoldenSetEntry,
  ConvergenceAuditPage,
  ConvergenceCaseChange,
  CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT,
  CONVERGENCE_CASE_PAGE_MAX_LIMIT,
  SelfConsistencyReport,
  DisagreementSummary,
  ImportJobRecord,
  ImportJobStatus,
  JudgeHumanDisagreementSummary,
  JudgeRun,
  KappaSummary,
  LangfuseConnectionTestResult,
  LangfuseImportJob,
  LangfuseImportTarget,
  LangfuseIntegration,
  LangfuseIntegrationInput,
  IronsideConnectionTestResult,
  IronsideImportJob,
  IronsideImportTarget,
  IronsideIntegration,
  IronsideIntegrationInput,
  IronsideSyncState,
  RuntimeIngestionPurpose,
  UpdateIronsideIntegrationInput,
  ReviewQueue,
  ReviewQueueDetail,
  ReviewQueueItem,
  ReviewQueueStatus,
  JudgeRunJob,
  LangSmithConnectionTestResult,
  LangSmithImportJob,
  LangSmithImportTarget,
  LangSmithIntegration,
  LangSmithIntegrationInput,
  ManualTraceImportInput,
  ManualTraceImportResult,
  MinimumVerdictOutputSchema,
  Project,
  ProjectSettings,
  ProviderResponseMetadata,
  PromoteGoldenSetInput,
  REGRESSION_RATIONALE_MAX_LENGTH,
  RegressionCaseDiff,
  RegressionRunResult,
  RetentionPruneResult,
  RunComparison,
  Skill,
  EvalRunSpend,
  JudgeKeyProvider,
  JudgeProviderKey,
  SkillFormatExample,
  SkillVersion,
  TraceRedactionConfig,
  TraceTestDetail,
  TraceTestDraftContent,
  TraceTestRevision,
  TraceTestSourceScope,
  TraceTestSummary,
  TraceTestRunSource,
  TraceTestFunnelEventInput,
  TraceTestValidation,
  TraceTestValidationDiagnostic,
  TraceTestValidationEvidenceInput,
  TraceTestValidationEvaluator,
  TraceTestValidationMethod,
  TraceTestValidationStatus,
  CaseSource,
  TraceSource,
  TraceStep,
  UpdateLangfuseIntegrationInput,
  UpdateLangSmithIntegrationInput,
  UpdateProjectSettingsInput,
  VerdictLabel,
  VerdictPayload,
  VerdictRecord,
  VerdictSource
} from "@coeval/shared";
import { deriveGateCheckDecision, effectiveHumanLabel, isInternalTraceMetadata, regressionDirectionCounts, renderJudgePromptContent, verdictLabelFromPayload } from "@coeval/shared";
import { normalizeTracePayload, redactNormalizedTracePayload, redactTrace, type NormalizedTraceStep } from "./lib/redaction.js";
import { generateApiKey, hashApiKey } from "./lib/api-keys.js";
import {
  buildAssessmentReceipt,
  canonicalReceiptBytes,
  parseCanonicalReceiptBytes,
  receiptArtifactDigest,
  receiptSourceSnapshotDigest
} from "./lib/assessment-receipt.js";
import {
  buildEvaluatorSuiteManifest,
  canonicalEvaluatorSuiteManifestBytes,
  evaluatorSuiteCreateRequestDigest,
  evaluatorSuiteCriterionDigest,
  parseCanonicalEvaluatorSuiteManifestBytes
} from "./lib/evaluator-suite.js";
import {
  datasetInputIdentity,
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest,
  decidePublicDatasetRevisionCreation
} from "./lib/dataset-revision.js";

// Subset of JudgeProvider needed by the binary golden-set regression gate. A
// full JudgeProvider satisfies it structurally; declaring it narrowly lets
// tests pass a `{ name, judge }` mock without implementing judgeStructured.
type BinaryJudgeProvider = Pick<JudgeProvider, "name" | "modelName" | "judge">;
import { computeConvergenceAudit, computeDisagreementSummary, computeJudgeHumanCalibration, computeJudgeHumanDisagreement, computeKappaSummary, computeSelfConsistency } from "./lib/kappa.js";

export interface CreateSkillVersionContext {
  projectId: string;
  actorUserId?: string | undefined;
  rubricProvenance?: SkillVersion["rubricProvenance"] | undefined;
  agentSetup?: {
    pairingId?: string | undefined;
    skillName: string;
    skillDescription: string;
    providerCredential?: { provider: JudgeKeyProvider; apiKey: string } | undefined;
  } | undefined;
}

export interface ConvergenceAuditPageInput {
  limit?: number | undefined;
  cursor?: string | null | undefined;
}

export class InvalidConvergenceCursorError extends Error {
  constructor() {
    super("Invalid convergence case cursor");
    this.name = "InvalidConvergenceCursorError";
  }
}

export type AssessmentReceiptArtifactSource = "terminal_mint" | "historical_freeze" | "correction";

export interface AssessmentReceiptArtifact {
  id: string;
  projectId: string;
  evalRunId: string;
  receiptId: string;
  contractVersion: number;
  artifactRevision: number;
  canonicalBytes: Buffer;
  artifactDigest: string;
  evidenceDigest: string;
  sourceSnapshotDigest: string;
  sourceKind: AssessmentReceiptArtifactSource;
  predecessorArtifactId: string | null;
  correctionReason: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface AssessmentReceiptComparison {
  id: string;
  projectId: string;
  evalRunId: string;
  artifactId: string;
  consumerReceiptId: string;
  consumerCanonicalBytes: Buffer;
  consumerArtifactDigest: string;
  comparisonStatus: "match" | "diverged";
  createdAt: string;
}

export interface CompareAssessmentReceiptCopyInput {
  projectId: string;
  evalRunId: string;
  consumerCanonicalBytes: Buffer;
}

export interface CreateAssessmentReceiptCorrectionInput {
  projectId: string;
  evalRunId: string;
  receipt: AssessmentReceipt;
  reason: string;
  createdByUserId?: string | undefined;
}

export class AssessmentReceiptUnavailableError extends Error {
  constructor(readonly reason: "not_release_evidence" | "not_terminal" | "missing_source", message: string) {
    super(message);
    this.name = "AssessmentReceiptUnavailableError";
  }
}

export class AssessmentReceiptIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssessmentReceiptIntegrityError";
  }
}

export class DatasetRevisionNotFoundError extends Error {
  constructor(readonly revisionId: string) {
    super(`Dataset revision not found in this project: ${revisionId}`);
    this.name = "DatasetRevisionNotFoundError";
  }
}

export class SealedValidationUnavailableError extends Error {
  constructor() {
    super("Sealed validation intake is unavailable until governed blind collection and review are enabled.");
    this.name = "SealedValidationUnavailableError";
  }
}

export class DatasetRevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetRevisionConflictError";
  }
}

export class GateRunBindingMismatchError extends Error {
  constructor(readonly jobDatasetRevisionId: string, readonly versionDatasetRevisionId: string) {
    super(`Gate job dataset revision does not match skill version binding: ${jobDatasetRevisionId}`);
    this.name = "GateRunBindingMismatchError";
  }
}

export interface CoevalRepository {
  listProjects(userId?: string | undefined): Promise<Project[]>;
  getProjectSettings(projectId: string): Promise<ProjectSettings>;
  updateProjectSettings(projectId: string, input: UpdateProjectSettingsInput, context: { actorUserId?: string | undefined }): Promise<ProjectSettings>;
  pruneExpiredTraces(projectId: string, context: { actorUserId?: string | undefined; now?: Date | undefined }): Promise<RetentionPruneResult>;
  deleteProject(projectId: string, input: { confirmProjectName: string; actorUserId?: string | undefined }): Promise<void>;
  getDashboardSummary(projectId: string, criterionId?: string | undefined): Promise<DashboardSummary>;
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
  importTrace(projectId: string, source: CaseSource, input: ManualTraceImportInput, context: TraceImportContext): Promise<TraceImportResult>;
  createImportJob(input: CreateImportJobInput): Promise<ImportJobRecord>;
  markImportJobQueued(projectId: string, importJobId: string, queueJobId: string): Promise<ImportJobRecord>;
  markImportJobRunning(projectId: string, importJobId: string): Promise<void>;
  markImportJobCompleted(projectId: string, importJobId: string, result: CompleteImportJobInput): Promise<void>;
  markImportJobFailed(projectId: string, importJobId: string, error: unknown): Promise<ImportJobRecord>;
  listImportJobs(input: ListImportJobsInput): Promise<ImportJobRecord[]>;
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
  createIronsideIntegration(projectId: string, input: IronsideIntegrationInput): Promise<IronsideIntegration>;
  updateIronsideIntegration(projectId: string, integrationId: string, input: UpdateIronsideIntegrationInput): Promise<IronsideIntegration>;
  recordIronsideConnectionTest(projectId: string, integrationId: string, result: IronsideConnectionTestResult): Promise<void>;
  deleteIronsideIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void>;
  claimDueIronsideImportTargets(input: ClaimIronsideImportTargetsInput): Promise<IronsideImportTarget[]>;
  loadIronsideImportContext(job: IronsideImportJob): Promise<IronsideImportContext>;
  // Persists the reconciliation state (settlement watermark + mid-window
  // keyset cursor) for one ironside connection.
  saveIronsideSyncState(projectId: string, integrationId: string, state: IronsideSyncState): Promise<void>;
  loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext>;
  recordJudgeRun(input: RecordJudgeRunInput): Promise<JudgeRun>;
  createFeedbackSyncJob(input: { projectId: string; judgeRunId: string; provider: FeedbackSyncProvider }): Promise<FeedbackSyncJobRecord | null>;
  loadFeedbackSyncContext(job: FeedbackSyncJob): Promise<FeedbackSyncContext>;
  listFeedbackSyncJobs(input: ListFeedbackSyncJobsInput): Promise<FeedbackSyncJobListItem[]>;
  markFeedbackSyncSucceeded(job: FeedbackSyncJob): Promise<void>;
  markFeedbackSyncFailed(job: FeedbackSyncJob, error: unknown): Promise<void>;
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
  // Eval-as-a-service API keys. createApiKey returns the plaintext key exactly
  // once; only its hash is persisted. resolveApiKey maps a presented raw key to
  // its project (or null when missing/revoked).
  createApiKey(input: CreateApiKeyInputDb): Promise<CreatedApiKey>;
  listApiKeys(projectId: string): Promise<ApiKey[]>;
  // Returns true if a matching, not-already-revoked key was revoked; false if
  // nothing matched (so the route can answer 404 instead of a silent ok).
  revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean>;
  resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null>;
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
  // BYO judge keys. list/set/delete return ONLY masked shapes; the raw
  // credential is reachable solely through getJudgeProviderCredential (the
  // worker-facing loader used at provider-construction time).
  setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string, actorUserId?: string): Promise<JudgeProviderKey>;
  listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]>;
  deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, actorUserId?: string): Promise<boolean>;
  getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null>;
  // True if the item existed and was removed.
  removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean>;
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
  // Durable queue outbox claim for an eval run. Only the claim holder sends
  // the deterministic queue job; a send failure releases the claim, while a
  // crash can be recovered after the lease without creating another job id.
  claimEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<EvalRunDispatchClaim>;
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
  getOrFreezeAssessmentReceipt(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact | null>;
  getAssessmentReceiptArtifactByReceiptId(projectId: string, receiptId: string): Promise<AssessmentReceiptArtifact | null>;
  listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]>;
  compareAssessmentReceiptCopy(input: CompareAssessmentReceiptCopyInput): Promise<AssessmentReceiptComparison>;
  createAssessmentReceiptCorrection(input: CreateAssessmentReceiptCorrectionInput): Promise<AssessmentReceiptArtifact>;
  // Cleanup for partial multi-run creation ONLY: removes a run that never
  // dispatched (still pending, nothing judged or failed). A dispatched run is
  // history and must stay — it may carry verdicts, which are append-only.
  deleteUndispatchedEvalRun(projectId: string, evalRunId: string): Promise<void>;
  // Run comparisons (Incident Bisect): a persisted pairing of two eval runs
  // over one dataset. The row only pins the participants — the per-case diff
  // is joined from the runs' items at read time (lib/run-comparison.ts).
  createRunComparison(input: CreateRunComparisonInputDb): Promise<RunComparison>;
  getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null>;
  listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]>;
  // Product deploy gate. Golden traces (keyed by caseId) supply the input half
  // of each derived candidate case; a gate check persists identity/config and
  // points at a 'product_gate' eval run — its status is derived from that
  // run's counters via deriveGateCheckDecision (see migration 0034), never
  // dual-written.
  getGoldenSetTraces(projectId: string, criterionVersionId?: string | undefined): Promise<Map<string, Trace>>;
  createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail>;
  getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null>;
  listGateChecks(projectId: string, opts?: { limit?: number | undefined }): Promise<GateCheck[]>;
}

export interface CreateGateCheckInputDb {
  projectId: string;
  skillVersionId: string;
  evalRunId: string;
  label?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  maxDisagreements: number;
  createdByUserId?: string | undefined;
  items: Array<{
    goldenEntryId: string;
    goldenCaseId: string;
    // Snapshot of the golden entry's trace id — the CI-facing candidate key.
    caseKey: string;
    candidateCaseId: string;
    expectedLabel: "pass" | "fail";
  }>;
}

export interface CreateRunComparisonInputDb {
  projectId: string;
  datasetId: string;
  datasetRevisionId?: string | undefined;
  versionAId: string;
  versionBId: string;
  runAId: string;
  runBId: string;
}

export interface CreateEvalRunInputDb {
  projectId: string;
  skillVersionId: string;
  trigger: EvalRunTrigger;
  datasetId?: string | undefined;
  datasetRevisionId?: string | undefined;
  blocking?: boolean | undefined;
  createdByUserId?: string | undefined;
  sourceTraceTest?: TraceTestRunSource | undefined;
  items: Array<{
    caseId: string;
    datasetItemId?: string | undefined;
    datasetRevisionItemId?: string | undefined;
    clientItemId?: string | undefined;
    contentDigest?: string | undefined;
    expectedLabel?: "pass" | "fail" | undefined;
    expectedFailStep?: number | undefined;
    // cached items reuse the recorded verdict's failingStep.
    failingStep?: number | undefined;
    // Pre-terminal items (batch idempotency / recursive-trace skips) land in
    // the run already counted, so the queue only sees genuinely pending work.
    status?: "pending" | "completed" | "skipped" | undefined;
    verdictId?: string | undefined;
    resultLabel?: string | undefined;
    cached?: boolean | undefined;
    providerMetadata?: ProviderResponseMetadata | undefined;
  }>;
}

export interface CreateConvergenceEvalRunInputDb {
  projectId: string;
  skillVersionId: string;
  caseId: string;
  createdByUserId?: string | undefined;
}

export interface EvalRunDispatchInputDb {
  projectId: string;
  evalRunId: string;
  dispatchToken: string;
}

export type EvalRunDispatchClaim =
  | { state: "claimed"; jobId: string }
  | { state: "busy" | "dispatched"; jobId: string | null };

export interface EvalRunItemExecutionInputDb {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken: string;
}

export type EvalRunItemExecutionClaim =
  | { state: "claimed" }
  | { state: "busy" | "terminal" }
  | { state: "outcome_unknown"; executionToken: string; providerCallReturned: boolean };

export type EvalRunItemReleaseDisposition =
  | { state: "released" }
  | { state: "pre_call_held" }
  | { state: "provider_started"; providerCallReturned: boolean }
  | { state: "lost" };

export interface EvalRunItemReleaseOptions {
  // A terminal pre-call failure must keep its exact execution generation
  // until failEvalRunItem commits. Releasing first would let a redelivery
  // start the provider before an older handler's failure write.
  preservePreCallClaim?: boolean;
}

export interface StaleEvalRunItemExecution {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken: string | null;
  providerCallStarted: boolean;
  providerCallReturned: boolean;
}

export interface CompleteEvalRunItemInputDb {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken?: string | undefined;
  verdictId: string;
  resultLabel: string;
  // the judge-named failing step from the verdict payload (absent when
  // omitted/dropped).
  failingStep?: number | undefined;
  latencyMs?: number | undefined;
  // this call's token usage (absent when the provider didn't report).
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  providerMetadata?: ProviderResponseMetadata | undefined;
}

export interface FailEvalRunItemInputDb {
  projectId: string;
  evalRunId: string;
  evalRunItemId: string;
  executionToken?: string | undefined;
  error: string;
}

export interface CreateApiKeyInputDb {
  projectId: string;
  name: string;
  createdByUserId?: string | undefined;
}

export interface CreateTraceTestInputDb extends TraceTestDraftContent {
  projectId: string;
  sourceCaseId: string;
  sourceScope: TraceTestSourceScope;
  desiredBehavior: string;
  createdByUserId?: string | undefined;
}

export interface ReviseTraceTestInputDb extends TraceTestDraftContent {
  projectId: string;
  traceTestId: string;
  expectedRevision: number;
  desiredBehavior: string;
  createdByUserId?: string | undefined;
}

export interface RecordTraceTestValidationInputDb {
  projectId: string;
  traceTestId: string;
  revision: number;
  badEvidence: TraceTestValidationEvidenceInput;
  goodEvidence: TraceTestValidationEvidenceInput;
  method?: TraceTestValidationMethod | undefined;
  diagnostic?: TraceTestValidationDiagnostic | null | undefined;
  evaluator?: TraceTestValidationEvaluator | null | undefined;
  overrideReason?: string | null | undefined;
  badAttempts?: number | undefined;
  goodAttempts?: number | undefined;
  badUsage?: { inputTokens: number; outputTokens: number } | null | undefined;
  goodUsage?: { inputTokens: number; outputTokens: number } | null | undefined;
  recordedByUserId?: string | undefined;
}

export interface EnableTraceTestInputDb {
  projectId: string;
  traceTestId: string;
  expectedRevision: number;
  validationId: string;
  reviewedByUserId: string;
}

export interface RecordTraceTestFunnelEventInputDb extends TraceTestFunnelEventInput {
  projectId: string;
  actorUserId?: string | undefined;
}

export interface CreateDatasetInputDb {
  projectId: string;
  name: string;
  description?: string | undefined;
  kind?: DatasetKind | undefined;
  createdByUserId?: string | undefined;
}

export interface AddDatasetItemsInputDb {
  projectId: string;
  datasetId: string;
  items: Array<{ caseId: string; expectedLabel?: "pass" | "fail" | undefined; expectedFailStep?: number | undefined; note?: string | undefined }>;
}

export function traceTestValidationStatus(
  badResult: TraceTestValidation["badEvidence"]["result"],
  goodResult: TraceTestValidation["goodEvidence"]["result"]
): TraceTestValidationStatus {
  const results = [badResult, goodResult];
  if (results.includes("unavailable")) return "unavailable";
  if (results.includes("evaluator_error")) return "evaluator_error";
  if (results.includes("ambiguous")) return "ambiguous";
  if (results.includes("could_not_run")) return "could_not_run";
  if (results.includes("needs_review")) return "needs_review";
  if (badResult === "fail" && goodResult === "pass") return "passed";
  if (badResult === goodResult) return "non_discriminating";
  return "failed";
}

export function traceTestValidationDiagnostic(
  badResult: TraceTestValidation["badEvidence"]["result"],
  goodResult: TraceTestValidation["goodEvidence"]["result"]
): TraceTestValidationDiagnostic | null {
  const status = traceTestValidationStatus(badResult, goodResult);
  if (status === "passed") return null;
  if (status === "non_discriminating") return badResult === "pass" ? "always_pass" : "always_fail";
  if (status === "failed") return "reversed";
  if (status === "ambiguous" || status === "needs_review") return "ambiguous";
  if (status === "evaluator_error") return "evaluator_error";
  return "unavailable";
}

export function traceTestValidationIsEnableEligible(validation: TraceTestValidation): boolean {
  if (validation.status !== "passed") return false;
  if (validation.method === "automated") return validation.evaluator !== null;
  if (validation.method === "manual_override") {
    return typeof validation.overrideReason === "string" && validation.overrideReason.trim().length >= 10;
  }
  return false;
}

// Skill Bench bulk ingestion (M0 C2): example cases + their dataset membership
// land atomically — a mid-flow failure must not strand membership-less cases.
// Items are pre-deduped by sourceTraceId (the route coalesces duplicates).
export interface ImportDatasetExamplesDbInput {
  projectId: string;
  datasetId: string;
  ingestionPurpose: Extract<RuntimeIngestionPurpose, "dataset_example" | "trace_test_synthetic">;
  items: Array<{
    sourceTraceId: string;
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown>;
    steps?: TraceStep[] | undefined;
    expectedLabel?: "pass" | "fail" | undefined;
    expectedFailStep?: number | undefined;
    note?: string | undefined;
  }>;
}

// run-level spend from the items — tokens and counts, never dollars.
// Null token sums mean "nothing reported usage" (no fresh calls, or all
// calls unreported); zero is a real recorded zero. Cached items never count.
export function computeEvalRunSpend(items: EvalRunItem[]): EvalRunSpend {
  const fresh = items.filter((item) => !item.cached && item.status === "completed");
  const cached = items.filter((item) => item.cached);
  // BOTH sides must be present to count as reported — a partial envelope is
  // treated as unreported (usageMissingCount), never zero-filled on one side.
  const reported = fresh.filter((item) => item.inputTokens !== null && item.outputTokens !== null);
  const latencies = items.map((item) => item.latencyMs).filter((ms): ms is number => ms !== null);
  return {
    freshItems: fresh.length,
    cachedItems: cached.length,
    inputTokens: reported.length === 0 ? null : reported.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
    outputTokens: reported.length === 0 ? null : reported.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    usageMissingCount: fresh.length - reported.length,
    totalLatencyMs: latencies.length === 0 ? null : latencies.reduce((sum, ms) => sum + ms, 0)
  };
}

// the ONLY renderable form of a stored judge key.
export function judgeKeyDisplay(apiKey: string): string {
  if (apiKey.length <= 14) return `${apiKey.slice(0, 4)}…`;
  return `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}`;
}

export interface ImportDatasetExamplesDbResult {
  items: Array<{ sourceTraceId: string; caseId: string; created: boolean; datasetItemId: string | null }>;
}

export interface CreateDatasetRevisionDbInput {
  projectId: string;
  datasetId: string;
  role: DatasetRevisionRole;
  expectedParentRevisionId?: string | undefined;
  idempotencyKey?: string | undefined;
  // Internal comparison runs may reuse the latest byte-identical snapshot;
  // explicit user freezes always create a new lineage revision.
  reuseLatestContent?: boolean | undefined;
  createdByUserId?: string | undefined;
}

export interface PreparedDatasetRevisionItem {
  sourceCaseId: string | null;
  sourceTraceId: string | null;
  sourceDatasetItemId: string | null;
  sourceGoldenEntryId: string | null;
  payloadSnapshot: DatasetRevisionPayloadSnapshot;
  inputDigest: string;
  itemDigest: string;
  referenceLabel: "pass" | "fail" | null;
  referenceFailStep: number | null;
  referenceProvenance: DatasetReferenceProvenance;
  note: string | null;
}

export interface AddQueueItemsInputDb {
  projectId: string;
  queueId: string;
  items: Array<{
    caseId: string;
    criterionVersionId?: string | undefined;
    assignedToUserId?: string | undefined;
  }>;
}

export interface CreateReviewQueueInputDb {
  projectId: string;
  name: string;
  description?: string | undefined;
  criterionVersionId?: string | undefined;
  caseIds: string[];
  createdByUserId?: string | undefined;
}

export interface RecordVerdictInput {
  projectId: string;
  caseId: string;
  source: VerdictSource;
  payload: VerdictPayload;
  skillVersionId?: string | undefined;
  actorUserId?: string | undefined;
  externalRunId?: string | undefined;
}

export interface ListCasesOptions {
  since?: string | undefined;
  limit?: number | undefined;
}

export interface CaseListEntry {
  caseId: string;
  sourceTraceId: string;
  createdAt: string;
  trace: {
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown>;
    steps?: NormalizedTraceStep[] | undefined;
  };
}

export interface ListVerdictsInput {
  projectId: string;
  caseId?: string | undefined;
  source?: VerdictSource | undefined;
  skillVersionId?: string | undefined;
  criterionId?: string | undefined;
  limit: number;
}

export type TraceImportResult = Omit<ManualTraceImportResult, "queued" | "queueJobId"> & {
  created: boolean;
};

export class RecursiveTraceSkippedError extends Error {
  constructor(sourceTraceId?: string) {
    super(sourceTraceId
      ? `Trace marked coeval-internal was skipped on ingest: ${sourceTraceId}`
      : "Trace marked coeval-internal was skipped on ingest");
    this.name = "RecursiveTraceSkippedError";
  }
}

export class GoldenSetEntryAlreadyRetiredError extends Error {
  constructor(entryId: string, readonly retirement: GoldenSetRetirementContext | null = null) {
    super(`Golden-set entry already retired: ${entryId}`);
    this.name = "GoldenSetEntryAlreadyRetiredError";
  }
}

export class GoldenSetEntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Golden-set entry not found: ${entryId}`);
    this.name = "GoldenSetEntryNotFoundError";
  }
}

export class CaseNotFoundError extends Error {
  constructor(caseId: string) {
    super(`Case not found in this project: ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

// The skill version pins a real provider but the factory could only produce
// the mock fallback (missing API key / unknown provider). The gate must
// refuse to run rather than certify a version with meaningless verdicts.
export class SkillVersionNotSignableError extends Error {
  constructor(versionId: string, status: string) {
    super(`Skill version ${versionId} is ${status} — only a never-approved draft can be signed off as-is`);
    this.name = "SkillVersionNotSignableError";
  }
}

export class AgentSetupEligibilityError extends Error {
  constructor(
    readonly code: "project_not_empty" | "project_already_configured" | "pairing_no_longer_active",
    message: string
  ) {
    super(message);
    this.name = "AgentSetupEligibilityError";
  }
}

export class RegressionGateUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(
      `Regression gate cannot run: skill version pins provider "${provider}" but no usable credentials are configured (the judge would fall back to the mock). Set the provider API key or pin provider "mock" explicitly.`
    );
    this.name = "RegressionGateUnavailableError";
  }
}

// A provider call failed while re-judging the golden set. Surfaced as a typed
// error so the route can answer 502 with context instead of a bare 500.
export class RegressionGateJudgeError extends Error {
  constructor(caseId: string, cause: unknown) {
    super(
      `Regression gate failed while judging golden case ${caseId}: ${cause instanceof Error ? cause.message : String(cause)}. No version was created; retry once the provider recovers.`
    );
    this.name = "RegressionGateJudgeError";
  }
}

// Promotion would freeze a label that contradicts the team's recorded human
// decision on the case. 409 — the caller must read the recorded label first.
export class GoldenSetLabelConflictError extends Error {
  constructor(caseId: string, requested: string, recorded: string) {
    super(
      `Cannot promote ${caseId} as "${requested}": the recorded human decision on this case is "${recorded}". Record a new human verdict first, or promote with the recorded label.`
    );
    this.name = "GoldenSetLabelConflictError";
  }
}

export class LangSmithIntegrationNotFoundError extends Error {
  constructor(integrationId: string) {
    super(`LangSmith integration not found: ${integrationId}`);
    this.name = "LangSmithIntegrationNotFoundError";
  }
}

export class LangfuseIntegrationNotFoundError extends Error {
  constructor(integrationId: string) {
    super(`Langfuse integration not found: ${integrationId}`);
    this.name = "LangfuseIntegrationNotFoundError";
  }
}

export class NoCurrentSkillError extends Error {
  constructor(projectId: string) {
    super(`No skill version found for project: ${projectId}`);
    this.name = "NoCurrentSkillError";
  }
}

export class ImportSkillVersionBindingError extends Error {
  constructor(message = "Import jobs must be pinned to an evaluator version in the same project") {
    super(message);
    this.name = "ImportSkillVersionBindingError";
  }
}

export class AmbiguousProjectSkillError extends Error {
  constructor(readonly projectId: string, readonly criterionCount: number) {
    super(
      `Project ${projectId} has ${criterionCount} evaluator scopes; choose a criterion or skillVersionId explicitly.`
    );
    this.name = "AmbiguousProjectSkillError";
  }
}

export class CriterionStableKeyConflictError extends Error {
  constructor(readonly stableKey: string) {
    super(`Criterion stableKey already exists in this project: ${stableKey}`);
    this.name = "CriterionStableKeyConflictError";
  }
}

export class EvaluatorSuiteBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorSuiteBindingError";
  }
}

export class EvaluatorSuiteIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Evaluator suite idempotency key was already used for different semantics: ${idempotencyKey}`);
    this.name = "EvaluatorSuiteIdempotencyConflictError";
  }
}

export class LangSmithCredentialsMissingError extends Error {
  constructor(integrationId: string) {
    super(`LangSmith integration credentials missing API key: ${integrationId}`);
    this.name = "LangSmithCredentialsMissingError";
  }
}

export class LangfuseCredentialsMissingError extends Error {
  constructor(integrationId: string) {
    super(`Langfuse integration credentials missing public/secret key: ${integrationId}`);
    this.name = "LangfuseCredentialsMissingError";
  }
}

export class IronsideIntegrationNotFoundError extends Error {
  constructor(integrationId: string) {
    super(`Ironside integration not found: ${integrationId}`);
    this.name = "IronsideIntegrationNotFoundError";
  }
}

export class IronsideCredentialsMissingError extends Error {
  constructor(integrationId: string) {
    super(`Ironside integration credentials missing API key: ${integrationId}`);
    this.name = "IronsideCredentialsMissingError";
  }
}

export class FeedbackSyncJobNotFoundError extends Error {
  constructor(feedbackSyncJobId: string) {
    super(`Feedback sync job not found: ${feedbackSyncJobId}`);
    this.name = "FeedbackSyncJobNotFoundError";
  }
}

export class FeedbackSyncCredentialsMissingError extends Error {
  constructor(feedbackSyncJobId: string) {
    super(`Feedback sync credentials missing API key: ${feedbackSyncJobId}`);
    this.name = "FeedbackSyncCredentialsMissingError";
  }
}

export class DatasetNotFoundError extends Error {
  constructor(datasetId: string) {
    super(`Dataset not found in this project: ${datasetId}`);
    this.name = "DatasetNotFoundError";
  }
}

export class DatasetNameTakenError extends Error {
  constructor(name: string) {
    super(`An active dataset named "${name}" already exists in this project`);
    this.name = "DatasetNameTakenError";
  }
}

export class TraceTestSourceNotFoundError extends Error {
  constructor(sourceCaseId: string) {
    super(`Source conversation not found in this project: ${sourceCaseId}`);
    this.name = "TraceTestSourceNotFoundError";
  }
}

export class TraceTestNotFoundError extends Error {
  constructor(traceTestId: string) {
    super(`Test not found in this project: ${traceTestId}`);
    this.name = "TraceTestNotFoundError";
  }
}

export class TraceTestRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly currentRevision: number) {
    super(`Test changed from revision ${expectedRevision} to ${currentRevision}`);
    this.name = "TraceTestRevisionConflictError";
  }
}

export class TraceTestValidationNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceTestValidationNotReadyError";
  }
}

export class DemoRepository implements CoevalRepository {
  private readonly traces = new Map<string, Trace>();
  private readonly caseInputIdentities = new Map<string, ReturnType<typeof datasetInputIdentity>>();
  private readonly traceSources = new Map<string, {
    source: CaseSource;
    sourceTraceId: string;
    rawTraceId: string;
    ingestionPurpose: RuntimeIngestionPurpose;
    createdAt: string;
    sourceIntegrationId?: string | undefined;
    importJobId?: string | undefined;
  }>();
  private readonly judgeRuns: JudgeRun[] = [];
  // Empty by default (tests construct DemoRepository directly and assert on
  // recordVerdict behaviour from a clean slate). The demo *server* opts into
  // seeding via the constructor so κ / disagreement feeds / calibration are
  // non-empty in a real demo. recordVerdict appends (append-only).
  private readonly verdicts: VerdictRecord[];
  // skill version history. Seeded with the demo version on first
  // access (lazy so we don't have to thread the seed through the constructor)
  // and appended on every createSkillVersion call.
  private skillVersions: SkillVersion[] | null = null;
  // regression runs keyed by skill version id, so the version's Judge
  // Card can read back "what flipped when this shipped." Newest run wins per
  // version (the override re-submit produces a second run for the same edit).
  private readonly regressionRuns = new Map<string, RegressionRunResult>();
  private readonly reviewQueues: Array<{
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    status: ReviewQueueStatus;
    createdByUserId: string | null;
    createdAt: string;
    closedAt: string | null;
  }> = [];
  private readonly reviewQueueItems: ReviewQueueItem[] = [];
  private readonly langSmithIntegrations = new Map<string, LangSmithImportContext & { pollEnabled: boolean; pollIntervalMs: number }>();
  private readonly langSmithLastPolledAt = new Map<string, number>();
  private readonly langfuseIntegrations = new Map<string, LangfuseImportContext & { pollEnabled: boolean; pollIntervalMs: number }>();
  private readonly langfuseLastPolledAt = new Map<string, number>();
  private readonly ironsideIntegrations = new Map<string, IronsideImportContext & { pollEnabled: boolean; pollIntervalMs: number }>();
  private readonly ironsideLastPolledAt = new Map<string, number>();
  private readonly feedbackJobs = new Map<string, FeedbackSyncContext & { status: FeedbackSyncStatus }>();
  private readonly feedbackJobAttempts = new Map<string, number>();
  private readonly feedbackJobLastError = new Map<string, string>();
  private readonly feedbackJobRunIds = new Map<string, string>();
  private readonly promotedGoldenSet: GoldenSetEntry[] = [];
  private readonly retiredGoldenSetEntries = new Map<string, GoldenSetRetirementContext>();
  private readonly importJobs: ImportJobRecord[] = [];
  // Eval-as-a-service API keys (in-memory). Stores the record + the key hash;
  // the plaintext key is returned only at creation.
  private readonly apiKeys: Array<{ record: ApiKey; keyHash: string }> = [];
  private readonly traceTests: Array<{
    id: string;
    projectId: string;
    sourceCaseId: string | null;
    sourceCaseRef: string;
    sourceTraceRef: string;
    sourceSnapshot: unknown;
    sourceScope: TraceTestSourceScope;
    currentRevision: number;
    enabledRevision: number | null;
    createdByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [];
  private readonly traceTestRevisions: TraceTestRevision[] = [];
  private readonly traceTestValidations: TraceTestValidation[] = [];
  private readonly traceTestFunnelEvents = new Set<string>();
  private readonly datasets: Array<{
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    kind: DatasetKind;
    createdAt: string;
    archivedAt: string | null;
  }> = [];
  private readonly datasetItems: DatasetItem[] = [];
  private readonly datasetRevisions: DatasetRevision[] = [];
  private readonly datasetRevisionItems: DatasetRevisionItem[] = [];
  private readonly datasetExposureEvents: DatasetExposureEvent[] = [];
  private readonly datasetRevisionIdempotency = new Map<string, string>();
  private regressionDatasetRevisionId: string | null = null;
  private readonly regressionDatasetRevisionIdsByCriterion = new Map<string, string>();
  private readonly evalRuns: EvalRun[] = [];
  private readonly evalRunItems: EvalRunItem[] = [];
  private readonly convergenceEvalRuns = new Map<string, Promise<EvalRunDetail>>();
  private readonly evalRunDispatches = new Map<string, {
    jobId: string;
    dispatchToken: string | null;
    claimedAt: number | null;
    dispatched: boolean;
  }>();
  private readonly evalRunItemQueueJobs = new Map<string, string>();
  private readonly evalRunItemDeliveryDeadlines = new Map<string, number>();
  private readonly evalRunItemExecutions = new Map<string, {
    executionToken: string;
    claimedAt: number;
    providerCallStarted: boolean;
    providerCallReturned: boolean;
  }>();
  private readonly assessmentReceiptArtifacts: AssessmentReceiptArtifact[] = [];
  private readonly assessmentReceiptComparisons: AssessmentReceiptComparison[] = [];
  private readonly runComparisons: RunComparison[] = [];
  private readonly criteria: Criterion[] = [];
  private readonly criterionVersions: CriterionVersion[] = [];
  private readonly evaluatorSuites: EvaluatorSuite[] = [];
  private readonly evaluatorSuiteManifests: Array<{
    manifest: EvaluatorSuiteManifest;
    canonicalBytes: Buffer;
    idempotencyKey: string;
    requestDigest: string;
  }> = [];
  private readonly skillVersionCriteria = new Map<string, string>();
  private readonly criterionSkills = new Map<string, Skill>();

  constructor(
    private readonly judgeProvider: JudgeProvider = new MockJudgeProvider(),
    options: { seedVerdicts?: boolean } = {}
  ) {
    const criterionId = demoSkill.criterionId;
    const criterionVersionId = demoSkill.currentVersion.criterionVersionId;
    this.criteria.push({
      id: criterionId,
      projectId: demoProject.id,
      stableKey: `skill:${demoSkill.id}`,
      sourceKind: "native",
      createdByUserId: null,
      createdAt: demoProject.updatedAt
    });
    this.criterionVersions.push({
      id: criterionVersionId,
      projectId: demoProject.id,
      criterionId,
      revision: 1,
      name: demoSkill.name,
      definition: demoSkill.description,
      criterionDigest: evaluatorSuiteCriterionDigest({
        criterionId,
        criterionVersionId,
        criterionName: demoSkill.name,
        criterionDefinition: demoSkill.description
      }),
      sourceKind: "native",
      createdByUserId: null,
      createdAt: demoProject.updatedAt
    });
    this.skillVersionCriteria.set(demoSkillPrevVersion.id, criterionVersionId);
    this.skillVersionCriteria.set(demoSkill.currentVersion.id, criterionVersionId);
    this.criterionSkills.set(criterionId, demoSkill);
    this.verdicts = options.seedVerdicts ? [...demoVerdicts] : [];
    // Demo fixtures are authored in source rather than imported through the
    // runtime redaction path. Capture their original input identity up front
    // so the demo never hashes a redacted fallback while calling it exact.
    for (const entry of demoGoldenSet) {
      this.caseInputIdentities.set(
        entry.caseId,
        datasetInputIdentity({ input: demoTraceForGoldenEntry(entry).input })
      );
    }
    for (const exception of demoExceptions) {
      const trace = this.syntheticTraceForBuiltinCase(exception.id);
      if (trace) this.caseInputIdentities.set(exception.id, datasetInputIdentity({ input: trace.input }));
    }
    // A2.2c: when seeding, expose the predecessor version too so the convergence
    // audit has a real before→after to compare. Without seeding, the version
    // list lazy-inits to just the current version (existing behaviour).
    this.skillVersions = options.seedVerdicts
      ? [structuredClone(demoSkillPrevVersion), structuredClone(demoSkill.currentVersion)]
      : null;
  }

  async listProjects(): Promise<Project[]> {
    return [demoProject];
  }

  async getProjectSettings(): Promise<ProjectSettings> {
    return {
      projectId: demoProject.id,
      name: demoProject.name,
      mode: demoProject.mode,
      traceRetentionDays: demoProject.traceRetentionDays
    };
  }

  async updateProjectSettings(_projectId: string, input: UpdateProjectSettingsInput): Promise<ProjectSettings> {
    return {
      projectId: demoProject.id,
      name: demoProject.name,
      mode: input.mode ?? demoProject.mode,
      traceRetentionDays: input.traceRetentionDays
    };
  }

  async pruneExpiredTraces(): Promise<RetentionPruneResult> {
    return {
      projectId: demoProject.id,
      traceRetentionDays: demoProject.traceRetentionDays,
      cutoff: null,
      deletedCases: 0,
      deletedRawTraces: 0,
      skippedActiveGoldenCases: 0,
      skippedImmutableRevisionCases: 0
    };
  }

  async deleteProject(_projectId: string, input: { confirmProjectName: string }): Promise<void> {
    if (input.confirmProjectName !== demoProject.name) throw new Error("Project confirmation did not match");
  }

  async getDashboardSummary(projectId = demoProject.id, criterionId?: string | undefined): Promise<DashboardSummary> {
    const summary = getDemoDashboardSummary();
    const skill = criterionId
      ? await this.getCurrentSkillForCriterion(projectId, criterionId)
      : await this.getCurrentSkill(projectId);
    const criterionVersionId = skill.currentVersion.criterionVersionId;
    // Gate candidates and release evidence are invisible to
    // every dashboard number — trace counts, coverage, and the verdict chart
    // (mirrors the PG exclusions on case_type = 'gate_candidate').
    const countedRuns = this.judgeRuns.filter((run) =>
      !this.isEvidenceScaffoldingCase(run.caseId) &&
      this.skillVersionCriteria.get(run.skillVersionId) === criterionVersionId
    );
    const isLegacyCriterion = criterionId === undefined || criterionId === demoSkill.criterionId;
    const exceptions = isLegacyCriterion
      ? summary.exceptions.filter((exception) => {
          const scopedVerdicts = this.verdicts.filter((verdict) =>
            verdict.projectId === projectId &&
            verdict.caseId === exception.id &&
            verdict.skillVersionId !== null &&
            this.skillVersionCriteria.get(verdict.skillVersionId) === criterionVersionId
          );
          const latestResolution = scopedVerdicts
            .filter((verdict) => verdict.source === "human" || verdict.source === "adjudicated")
            .sort((left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
            )[0];
          const latestJudge = scopedVerdicts
            .filter((verdict) => verdict.source === "llm_judge")
            .sort((left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
            )[0];
          const latestRecordedRun = countedRuns
            .filter((run) => run.caseId === exception.id)
            .sort((left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
            )[0];
          const latestJudgeAt = [latestJudge?.createdAt, latestRecordedRun?.createdAt]
            .filter((createdAt): createdAt is string => Boolean(createdAt))
            .sort((left, right) => right.localeCompare(left))[0];
          // Match the PG queue projector: a human/owner ruling closes the
          // exception until a strictly newer evaluator run reopens it.
          return !latestResolution || Boolean(latestJudgeAt && latestJudgeAt > latestResolution.createdAt);
        })
      : [];
    const goldenSetSize = (await this.listGoldenSet(projectId, criterionVersionId)).length;
    const topCapabilityGaps = isLegacyCriterion ? capabilityGapsFromExceptions(exceptions) : [];
    const dynamicCurrentVersionResultCount = new Set(
      countedRuns
        .filter((run) =>
          run.skillVersionId === skill.currentVersion.id &&
          // The aggregate demo baseline already includes every built-in
          // case. A runtime re-judge of one of those identities replaces its
          // Result; it is not another covered case. Dynamically imported
          // cases remain outside that baseline and do increase coverage.
          !(isLegacyCriterion && skill.currentVersion.id === demoSkill.currentVersion.id &&
            this.syntheticTraceForBuiltinCase(run.caseId))
        )
        .map((run) => run.caseId)
    ).size;
    const currentVersionResultCount = isLegacyCriterion && skill.currentVersion.id === demoSkill.currentVersion.id
      ? summary.currentVersionResultCount + dynamicCurrentVersionResultCount
      : dynamicCurrentVersionResultCount;
    if (countedRuns.length === 0) {
      return {
        ...summary,
        skill,
        currentVersionResultCount,
        verdictDistribution: isLegacyCriterion
          ? summary.verdictDistribution
          : { pass: 0, fail: 0, ambiguous: 0 },
        exceptions,
        topCapabilityGaps,
        goldenSetSize
      };
    }
    const countedTraces = [...this.traceSources.values()]
      .filter((traceSource) => traceSource.source !== "gate_candidate" && traceSource.source !== "release_evidence").length;
    // P1-4 parity with PG: one vote per case — the latest judge verdict on
    // each judged case, not every run row (re-judges and repeat probes would
    // inflate the chart).
    const latestByCase = new Map<string, (typeof this.judgeRuns)[number]>();
    for (const run of countedRuns) {
      const prior = latestByCase.get(run.caseId);
      if (!prior || run.createdAt >= prior.createdAt) latestByCase.set(run.caseId, run);
    }
    const verdictDistribution = { pass: 0, fail: 0, ambiguous: 0 };
    for (const run of latestByCase.values()) verdictDistribution[run.verdict] += 1;
    return {
      ...summary,
      skill,
      currentVersionResultCount,
      exceptions,
      topCapabilityGaps,
      goldenSetSize,
      project: {
        ...summary.project,
        importedTraceCount: summary.project.importedTraceCount + countedTraces,
        // Distinct judged cases, not judge_runs rows — re-judges under a new
        // skill version are not new coverage (mirrors the PG recount).
        autoJudgedTraceCount:
          summary.project.autoJudgedTraceCount + new Set(countedRuns.map((run) => run.caseId)).size
      },
      verdictDistribution
    };
  }

  // Derived product-gate cases (case source 'gate_candidate') are judging
  // scaffolding: excluded from dashboards, exceptions, and backfills.
  private isEvidenceScaffoldingCase(caseId: string): boolean {
    const source = this.traceSources.get(caseId)?.source;
    return source === "gate_candidate" || source === "release_evidence";
  }

  async listCriteria(projectId: string): Promise<Criterion[]> {
    return this.criteria
      .filter((criterion) => criterion.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((criterion) => structuredClone(criterion));
  }

  async getCriterion(projectId: string, criterionId: string): Promise<CriterionDetail | null> {
    const criterion = this.criteria.find((candidate) =>
      candidate.projectId === projectId && candidate.id === criterionId
    );
    if (!criterion) return null;
    return {
      criterion: structuredClone(criterion),
      versions: this.criterionVersions
        .filter((version) => version.projectId === projectId && version.criterionId === criterionId)
        .sort((left, right) => right.revision - left.revision || right.id.localeCompare(left.id))
        .map((version) => structuredClone(version))
    };
  }

  async createCriterion(
    projectId: string,
    input: CreateCriterionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CreatedCriterion> {
    if (this.criteria.some((criterion) =>
      criterion.projectId === projectId && criterion.stableKey === input.stableKey
    )) {
      throw new CriterionStableKeyConflictError(input.stableKey);
    }
    const createdAt = new Date().toISOString();
    const criterion: Criterion = {
      id: `criterion_${randomUUID()}`,
      projectId,
      stableKey: input.stableKey,
      sourceKind: "native",
      createdByUserId: context.actorUserId ?? null,
      createdAt
    };
    const versionId = `criterionv_${randomUUID()}`;
    const version: CriterionVersion = {
      id: versionId,
      projectId,
      criterionId: criterion.id,
      revision: 1,
      name: input.name,
      definition: input.definition,
      criterionDigest: evaluatorSuiteCriterionDigest({
        criterionId: criterion.id,
        criterionVersionId: versionId,
        criterionName: input.name,
        criterionDefinition: input.definition
      }),
      sourceKind: "native",
      createdByUserId: context.actorUserId ?? null,
      createdAt
    };
    const skillVersion: SkillVersion = {
      id: `skillv_${randomUUID()}`,
      skillId: `skill_${randomUUID()}`,
      criterionVersionId: version.id,
      version: "0.1.0",
      status: "draft",
      rubricMarkdown: input.evaluator.rubricMarkdown,
      prompt: input.evaluator.prompt,
      modelBinding: input.evaluator.modelBinding,
      outputSchema: input.evaluator.outputSchema,
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: input.evaluator.verdictKind,
      scalarRange: input.evaluator.verdictKind === "scalar" ? input.evaluator.scalarRange ?? null : null,
      categoricalChoiceScores: input.evaluator.verdictKind === "categorical"
        ? input.evaluator.categoricalChoiceScores ?? null
        : null,
      rubricProvenance: "human-authored",
      regressionDatasetRevisionId: null,
      createdAt,
      approvedAt: null
    };
    const evaluator: Skill = {
      id: skillVersion.skillId,
      projectId,
      criterionId: criterion.id,
      name: input.name,
      description: input.definition,
      ownerName: context.actorUserId ?? "API key",
      status: "draft",
      isStarter: false,
      currentVersion: skillVersion
    };
    this.criteria.push(criterion);
    this.criterionVersions.push(version);
    if (this.skillVersions === null) this.skillVersions = [structuredClone(demoSkill.currentVersion)];
    this.skillVersions.push(skillVersion);
    this.skillVersionCriteria.set(skillVersion.id, version.id);
    this.criterionSkills.set(criterion.id, evaluator);
    return {
      criterion: structuredClone(criterion),
      versions: [structuredClone(version)],
      evaluator: structuredClone(evaluator)
    };
  }

  async createCriterionVersion(
    projectId: string,
    criterionId: string,
    input: CreateCriterionVersionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CriterionVersion | null> {
    if (!this.criteria.some((criterion) =>
      criterion.projectId === projectId && criterion.id === criterionId
    )) return null;
    const prior = this.criterionVersions.filter((version) =>
      version.projectId === projectId && version.criterionId === criterionId
    );
    const id = `criterionv_${randomUUID()}`;
    const version: CriterionVersion = {
      id,
      projectId,
      criterionId,
      revision: Math.max(0, ...prior.map((entry) => entry.revision)) + 1,
      name: input.name,
      definition: input.definition,
      criterionDigest: evaluatorSuiteCriterionDigest({
        criterionId,
        criterionVersionId: id,
        criterionName: input.name,
        criterionDefinition: input.definition
      }),
      sourceKind: "native",
      createdByUserId: context.actorUserId ?? null,
      createdAt: new Date().toISOString()
    };
    this.criterionVersions.push(version);
    return structuredClone(version);
  }

  async listEvaluatorSuites(projectId: string): Promise<EvaluatorSuite[]> {
    return this.evaluatorSuites
      .filter((suite) => suite.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((suite) => structuredClone(suite));
  }

  async getEvaluatorSuite(projectId: string, suiteId: string): Promise<EvaluatorSuite | null> {
    const suite = this.evaluatorSuites.find((candidate) =>
      candidate.projectId === projectId && candidate.id === suiteId
    );
    return suite ? structuredClone(suite) : null;
  }

  async createEvaluatorSuiteManifest(
    projectId: string,
    input: CreateEvaluatorSuiteManifestInput,
    context: { actorUserId?: string | undefined }
  ): Promise<EvaluatorSuiteManifest> {
    if (
      new Set(input.members.map((member) => member.criterionVersionId)).size !== input.members.length ||
      new Set(input.members.map((member) => member.skillVersionId)).size !== input.members.length
    ) {
      throw new EvaluatorSuiteBindingError("Evaluator suite members must bind distinct criteria and evaluator versions.");
    }
    const retried = this.evaluatorSuiteManifests.find((entry) =>
      entry.manifest.projectId === projectId && entry.idempotencyKey === input.idempotencyKey
    );
    if (retried) {
      if (retried.requestDigest !== evaluatorSuiteCreateRequestDigest(input)) {
        throw new EvaluatorSuiteIdempotencyConflictError(input.idempotencyKey);
      }
      return parseCanonicalEvaluatorSuiteManifestBytes(retried.canonicalBytes);
    }
    const existingSuite = input.suiteId
      ? this.evaluatorSuites.find((suite) => suite.projectId === projectId && suite.id === input.suiteId)
      : undefined;
    if (input.suiteId && !existingSuite) {
      throw new EvaluatorSuiteBindingError(`Evaluator suite not found in this project: ${input.suiteId}`);
    }
    const suiteId = existingSuite?.id ?? `suite_${randomUUID()}`;
    const memberInputs = input.members.map((binding, position) => {
      const criterionVersion = this.criterionVersions.find((version) =>
        version.projectId === projectId && version.id === binding.criterionVersionId
      );
      const skillVersion = (this.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
        .find((version) => version.id === binding.skillVersionId);
      if (!criterionVersion || !skillVersion || this.skillVersionCriteria.get(skillVersion.id) !== criterionVersion.id) {
        throw new EvaluatorSuiteBindingError(
          `Suite member ${position} must bind a criterion version to its exact evaluator version in this project.`
        );
      }
      return {
        criterionId: criterionVersion.criterionId,
        criterionVersionId: criterionVersion.id,
        criterionName: criterionVersion.name,
        criterionDefinition: criterionVersion.definition,
        skillVersion
      };
    });
    if (new Set(memberInputs.map((member) => member.criterionId)).size !== memberInputs.length) {
      throw new EvaluatorSuiteBindingError(
        "Evaluator suite members must bind distinct stable criteria, not multiple versions of one criterion."
      );
    }
    const priorRevisions = this.evaluatorSuiteManifests
      .filter((entry) => entry.manifest.projectId === projectId && entry.manifest.suiteId === suiteId)
      .map((entry) => entry.manifest.revision);
    const manifest = buildEvaluatorSuiteManifest({
      manifestId: `manifest_${randomUUID()}`,
      suiteId,
      projectId,
      revision: Math.max(0, ...priorRevisions) + 1,
      members: memberInputs,
      trialPlan: input.trialPlan
    });
    const canonicalBytes = canonicalEvaluatorSuiteManifestBytes(manifest);
    parseCanonicalEvaluatorSuiteManifestBytes(canonicalBytes);
    if (!existingSuite) {
      this.evaluatorSuites.push({
        id: suiteId,
        projectId,
        createdByUserId: context.actorUserId ?? null,
        createdAt: new Date().toISOString()
      });
    }
    this.evaluatorSuiteManifests.push({
      manifest,
      canonicalBytes,
      idempotencyKey: input.idempotencyKey,
      requestDigest: evaluatorSuiteCreateRequestDigest(input)
    });
    return structuredClone(manifest);
  }

  async listEvaluatorSuiteManifests(
    projectId: string,
    suiteId?: string | undefined
  ): Promise<EvaluatorSuiteManifest[]> {
    return this.evaluatorSuiteManifests
      .filter((entry) => entry.manifest.projectId === projectId && (!suiteId || entry.manifest.suiteId === suiteId))
      .sort((left, right) =>
        left.manifest.suiteId.localeCompare(right.manifest.suiteId) ||
        right.manifest.revision - left.manifest.revision ||
        right.manifest.manifestId.localeCompare(left.manifest.manifestId)
      )
      .map((entry) => parseCanonicalEvaluatorSuiteManifestBytes(entry.canonicalBytes));
  }

  async getEvaluatorSuiteManifest(
    projectId: string,
    manifestId: string
  ): Promise<EvaluatorSuiteManifest | null> {
    const entry = this.evaluatorSuiteManifests.find((candidate) =>
      candidate.manifest.projectId === projectId && candidate.manifest.manifestId === manifestId
    );
    return entry ? parseCanonicalEvaluatorSuiteManifestBytes(entry.canonicalBytes) : null;
  }

  async getCurrentSkill(projectId = demoProject.id): Promise<Skill> {
    const criteria = this.criteria.filter((criterion) => criterion.projectId === projectId);
    const criterionCount = criteria.length;
    if (criterionCount > 1) throw new AmbiguousProjectSkillError(projectId, criterionCount);
    const criterionId = criteria[0]?.id;
    if (!criterionId) throw new NoCurrentSkillError(projectId);
    return this.getSkillForCriterion(projectId, criterionId, "current");
  }

  async getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.getSkillForCriterion(projectId, criterionId, "current");
  }

  async authorizeSkillVersionExecution(_input: {
    projectId: string;
    skillVersionId: string;
    context: EvaluatorExecutionContext;
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }): Promise<void> {
    // Demo fixtures have no governed lifecycle store.
  }

  async getLatestSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.getSkillForCriterion(projectId, criterionId, "latest");
  }

  async getLatestSkill(projectId = demoProject.id): Promise<Skill> {
    const criteria = this.criteria.filter((criterion) => criterion.projectId === projectId);
    const criterionCount = criteria.length;
    if (criterionCount > 1) throw new AmbiguousProjectSkillError(projectId, criterionCount);
    const criterionId = criteria[0]?.id;
    if (!criterionId) throw new NoCurrentSkillError(projectId);
    return this.getSkillForCriterion(projectId, criterionId, "latest");
  }

  private getSkillForCriterion(
    projectId: string,
    criterionId: string,
    scope: "current" | "latest"
  ): Skill {
    const base = this.criterionSkills.get(criterionId);
    if (!base || base.projectId !== projectId) throw new NoCurrentSkillError(projectId);
    const versions = (this.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
      .filter((version) => version.skillId === base.id);
    const ranked = [...versions].sort((left, right) => {
      if (scope === "current") {
        const rank = (status: SkillVersion["status"]) =>
          status === "approved" || status === "production" ? 0
            : status === "regressing" || status === "failed" || status === "deprecated" ? 2
              : 1;
        const rankDiff = rank(left.status) - rank(right.status);
        if (rankDiff !== 0) return rankDiff;
      }
      return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
    });
    const selected = ranked[0];
    if (!selected) throw new NoCurrentSkillError(projectId);
    return structuredClone({ ...base, currentVersion: selected });
  }

  async getSkillVersion(projectId: string, skillVersionId: string): Promise<SkillVersion | null> {
    if (projectId !== demoProject.id) return null;
    return (this.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
      .find((version) => version.id === skillVersionId) ?? null;
  }

  async getCriterionVersionForSkillVersion(
    projectId: string,
    skillVersionId: string
  ): Promise<CriterionVersion | null> {
    const criterionVersionId = this.skillVersionCriteria.get(skillVersionId);
    if (!criterionVersionId) return null;
    return this.criterionVersions.find((candidate) =>
      candidate.projectId === projectId && candidate.id === criterionVersionId
    ) ?? null;
  }

  async signOffSkillVersion(
    _projectId: string,
    _skillId: string,
    versionId: string,
    _context: { actorUserId?: string | undefined }
  ): Promise<SkillVersion | null> {
    const versions = this.skillVersions ?? [demoSkill.currentVersion];
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) return null;
    if (version.status !== "draft" || version.approvedAt !== null) {
      throw new SkillVersionNotSignableError(versionId, version.status);
    }
    version.status = "approved";
    version.approvedAt = new Date().toISOString();
    demoSkill.isStarter = false;
    return version;
  }

  async listGoldenSet(
    projectId = demoProject.id,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetEntry[]> {
    const resolvedCriterionVersionId = await this.resolveGoldenCriterionVersion(
      projectId,
      criterionVersionId
    );
    return [...this.promotedGoldenSet, ...demoGoldenSet].filter((entry) =>
      entry.criterionVersionId === resolvedCriterionVersionId &&
      !this.retiredGoldenSetEntries.has(entry.id)
    );
  }

  async getSkillFormatExamples(
    projectId: string,
    cap: number,
    criterionVersionId?: string | undefined
  ): Promise<SkillFormatExample[]> {
    const golden = (await this.listGoldenSet(projectId, criterionVersionId)).slice(0, cap);
    const examples: SkillFormatExample[] = [];
    for (const entry of golden) {
      // Reuse the redacted case-detail trace (demo parity with the PG join).
      const detail = await this.getCaseDetail(projectId, entry.caseId, entry.sourceSkillVersionId).catch(() => null);
      examples.push({
        id: entry.id,
        label: entry.agreedLabel,
        input: detail?.trace.input ?? null,
        output: detail?.trace.output ?? null,
        reason: entry.reason,
        ...(detail?.trace.metadata && Object.keys(detail.trace.metadata).length > 0 ? { metadata: detail.trace.metadata } : {})
      });
    }
    return examples;
  }

  async getGoldenSetHealth(
    projectId = demoProject.id,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetHealthSummary> {
    return buildGoldenSetHealthSummary(
      projectId,
      await this.listGoldenSet(projectId, criterionVersionId),
      new Date(demoProject.updatedAt)
    );
  }

  async getExceptionDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail> {
    const detail = await this.getCaseDetail(projectId, caseId, skillVersionId);
    if (!detail || detail.judgeRun.verdict === "pass") throw new Error(`Exception not found: ${caseId}`);
    return detail;
  }

  // generic case detail. Resolves an exception, a golden case, OR any
  // runtime-judged case to its trace — PgRepository resolves any case with a
  // judge run, and promotion ("any judged case is promotable") relies on the
  // same contract holding in demo mode.
  async getCaseDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail | null> {
    const criterionCount = this.criteria.filter((criterion) => criterion.projectId === projectId).length;
    if (!skillVersionId && criterionCount > 1) {
      throw new AmbiguousProjectSkillError(projectId, criterionCount);
    }
    const judged = [...this.judgeRuns]
      .filter((run) => run.caseId === caseId && (!skillVersionId || run.skillVersionId === skillVersionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (judged) {
      const trace = this.traces.get(caseId);
      return this.buildDemoCaseDetail(
        caseId,
        trace?.id ?? caseId,
        judged.verdict,
        judged.reasoning,
        undefined,
        judged
      );
    }
    const summary = getDemoDashboardSummary();
    const exception = summary.exceptions.find((candidate) => candidate.id === caseId);
    if (exception && (!skillVersionId || skillVersionId === demoSkill.currentVersion.id)) {
      return this.buildDemoCaseDetail(exception.id, exception.traceId, exception.verdict, exception.reason, exception.capabilityGap);
    }
    const goldenCriterionVersionId = skillVersionId
      ? this.skillVersionCriteria.get(skillVersionId)
      : undefined;
    const golden = (await this.listGoldenSet(projectId, goldenCriterionVersionId)).find((entry) =>
      entry.caseId === caseId && (!skillVersionId || entry.sourceSkillVersionId === skillVersionId)
    );
    if (golden) {
      return this.buildDemoCaseDetail(golden.caseId, golden.traceId, golden.agreedLabel, golden.reason, undefined);
    }
    return null;
  }

  private buildDemoCaseDetail(
    caseId: string,
    traceId: string,
    verdict: ExceptionDetail["judgeRun"]["verdict"],
    reason: string,
    capabilityGap: string | undefined,
    recordedRun?: JudgeRun | undefined
  ): ExceptionDetail {
    const skillVersionId = recordedRun?.skillVersionId ?? demoSkill.currentVersion.id;
    const criterionVersionId = this.skillVersionCriteria.get(skillVersionId);
    let verdictHistory: VerdictRecord[] = this.verdicts
      .filter((record) => record.projectId === demoProject.id && record.caseId === caseId)
      .filter((record) => record.source === "llm_judge" || record.source === "human" || record.source === "adjudicated")
      .filter((record) => !criterionVersionId || (
        record.skillVersionId !== null && this.skillVersionCriteria.get(record.skillVersionId) === criterionVersionId
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((record) => ({
        ...record,
        actorName: record.actorName ?? (
          record.actorUserId
            ? DEMO_ACTOR_NAMES.get(record.actorUserId) ?? null
            : record.source === "human" || record.source === "adjudicated"
              ? "Demo reviewer"
              : null
        )
      }));
    // recordJudgeRun is the first, independently durable write in the worker.
    // When the companion verdict write fails, keep that evaluator evidence in
    // the demo history instead of displaying a latest run that the audit trail
    // cannot explain. A later/equal v2 verdict for the same immutable version
    // is the normal paired-write state and avoids a duplicate projection.
    if (recordedRun && !verdictHistory.some((record) =>
      record.source === "llm_judge" &&
      record.skillVersionId === recordedRun.skillVersionId &&
      record.createdAt >= recordedRun.createdAt
    )) {
      const recordedRunEvidence: VerdictRecord = {
        id: `verdict_from_${recordedRun.id}`,
        projectId: recordedRun.projectId,
        caseId: recordedRun.caseId,
        skillVersionId: recordedRun.skillVersionId,
        source: "llm_judge",
        actorUserId: null,
        actorName: null,
        payload: {
          kind: "categorical",
          choice: recordedRun.verdict,
          choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
          rationale: recordedRun.reasoning
        },
        externalRunId: null,
        createdAt: recordedRun.createdAt
      };
      verdictHistory = [
        ...verdictHistory,
        recordedRunEvidence
      ].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      );
    }
    const latestHistoricalJudge = verdictHistory.find((record) => record.source === "llm_judge");
    const displayedSkillVersionId = recordedRun?.skillVersionId ?? latestHistoricalJudge?.skillVersionId ?? skillVersionId;
    const displayedVerdict = recordedRun?.verdict ?? (
      latestHistoricalJudge ? verdictLabelFromPayload(latestHistoricalJudge.payload) : verdict
    );
    const displayedReason = recordedRun?.reasoning ?? latestHistoricalJudge?.payload.rationale ?? reason;
    const displayedCreatedAt = recordedRun?.createdAt ?? latestHistoricalJudge?.createdAt ?? demoProject.updatedAt;
    const displayedJudgeRunId = recordedRun?.id ?? (
      latestHistoricalJudge ? `judge_from_${latestHistoricalJudge.id}` : `judge_${caseId}`
    );
    const exceptionVerdict: ExceptionCase["verdict"] = displayedVerdict;
    const goldenSetEntry = [...this.promotedGoldenSet, ...demoGoldenSet].find((entry) =>
      entry.caseId === caseId &&
      (!criterionVersionId || entry.criterionVersionId === criterionVersionId) &&
      !this.retiredGoldenSetEntries.has(entry.id)
    ) ?? null;
    // Imported cases serve their REAL stored payload (already redacted at
    // ingestion — PG parity, and the only way steps reach case detail);
    // the synthetic placeholder remains for built-in fixture cases only.
    const stored = this.traces.get(caseId);
    const trace = stored
      ? { ...stored, id: traceId, metadata: stored.metadata ?? {} }
      : redactTrace({
          id: traceId,
          input: { text: "Demo customer support question" },
          output: { text: "Demo AI answer for case drill-down" },
          metadata: { source: "demo", ...(capabilityGap ? { capabilityGap } : {}) }
        });
    return {
      exception: {
        id: caseId,
        traceId,
        title: displayedReason.slice(0, 80) || caseId,
        verdict: exceptionVerdict,
        reason: displayedReason,
        skillVersionId: displayedSkillVersionId,
        criterionVersionId: this.skillVersionCriteria.get(
          displayedSkillVersionId
        ),
        ...(capabilityGap ? { capabilityGap } : {}),
        reviewerState: "needs_review",
        createdAt: demoProject.updatedAt
      },
      trace: {
        id: trace.id,
        input: trace.input,
        output: trace.output,
        metadata: trace.metadata ?? {},
        ...(trace.steps ? { steps: trace.steps } : {})
      },
      // every dataset's expectation for this case, by name.
      datasetExpectations: this.datasetItems
        .filter((item) => item.caseId === caseId)
        .map((item) => ({
          datasetName: this.datasets.find((d) => d.id === item.datasetId && !d.archivedAt)?.name ?? null,
          expectedLabel: item.expectedLabel,
          expectedFailStep: item.expectedFailStep
        }))
        .filter((expectation): expectation is { datasetName: string; expectedLabel: "pass" | "fail" | null; expectedFailStep: number | null } =>
          expectation.datasetName !== null
        ),
      judgeRun: {
        id: displayedJudgeRunId,
        projectId: demoProject.id,
        caseId,
        skillVersionId: displayedSkillVersionId,
        verdict: displayedVerdict,
        score: displayedVerdict === "fail" ? 0.2 : displayedVerdict === "pass" ? 0.9 : 0.5,
        reasoning: displayedReason,
        createdAt: displayedCreatedAt
      },
      latestHumanLabel: effectiveHumanLabel(verdictHistory),
      verdictHistory,
      goldenSetEntry,
      rawResponse: {
        label: displayedVerdict,
        reason: displayedReason,
        ...(capabilityGap ? { failureCategory: capabilityGap } : {})
      }
    };
  }

  async promoteExceptionToGoldenSet(input: PromoteExceptionToGoldenSetInput): Promise<GoldenSetEntry> {
    // Any judged case is promotable (pass anchors included), matching
    // PgRepository — see its rationale.
    const detail = await this.getCaseDetail(input.projectId, input.caseId, input.skillVersionId);
    if (!detail) throw new CaseNotFoundError(input.caseId);
    if (this.traceSources.get(input.caseId)?.source === "release_evidence") {
      throw new CaseNotFoundError(input.caseId);
    }
    // Mirror PgRepository: a label that contradicts the recorded human
    // decision must not be frozen.
    if (
      detail.latestHumanLabel &&
      detail.latestHumanLabel !== "ambiguous" &&
      detail.latestHumanLabel !== input.agreedLabel
    ) {
      throw new GoldenSetLabelConflictError(input.caseId, input.agreedLabel, detail.latestHumanLabel);
    }
    // Mirror PgRepository: a promotion records a source=human verdict in the
    // v2 ledger (visible to κ / calibration). Pushed directly rather than via
    // recordVerdict so it does NOT complete pending review-queue items — only
    // an explicit human verdict does that.
    this.verdicts.push({
      id: `verdict_${randomUUID()}`,
      projectId: input.projectId,
      caseId: input.caseId,
      skillVersionId: detail.judgeRun.skillVersionId,
      source: "human",
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? "Demo reviewer",
      payload: {
        kind: "categorical",
        choice: input.agreedLabel,
        choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
        rationale: input.reason
      },
      externalRunId: null,
      createdAt: new Date().toISOString()
    });
    const criterionVersionId = this.skillVersionCriteria.get(detail.judgeRun.skillVersionId);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Judge evaluator has no immutable criterion version binding");
    }
    const existing = this.promotedGoldenSet.find((entry) =>
      entry.caseId === input.caseId &&
      this.skillVersionCriteria.get(entry.sourceSkillVersionId) === criterionVersionId &&
      !this.retiredGoldenSetEntries.has(entry.id)
    );
    if (existing) {
      existing.agreedLabel = input.agreedLabel;
      existing.reason = input.reason;
      existing.promotedBy = input.actorName ?? "Reviewer";
      existing.promotedAt = new Date().toISOString();
      await this.getOrCreateRegressionDatasetRevision(input.projectId, input.actorUserId, criterionVersionId);
      return existing;
    }
    const entry: GoldenSetEntry = {
      id: `gold_${randomUUID()}`,
      caseId: input.caseId,
      traceId: detail.trace.id,
      agreedLabel: input.agreedLabel,
      reason: input.reason,
      promotedBy: input.actorName ?? "Reviewer",
      promotedAt: new Date().toISOString(),
      sourceSkillVersionId: detail.judgeRun.skillVersionId,
      criterionVersionId
    };
    this.promotedGoldenSet.unshift(entry);
    await this.getOrCreateRegressionDatasetRevision(input.projectId, input.actorUserId, criterionVersionId);
    return entry;
  }

  async retireGoldenSetEntry(input: RetireGoldenSetEntryInput): Promise<void> {
    const entry = [...this.promotedGoldenSet, ...demoGoldenSet].find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new GoldenSetEntryNotFoundError(input.entryId);
    const retirement = this.retiredGoldenSetEntries.get(entry.id);
    if (retirement) throw new GoldenSetEntryAlreadyRetiredError(input.entryId, retirement);
    this.retiredGoldenSetEntries.set(entry.id, {
      retiredAt: new Date().toISOString(),
      retiredByUserId: input.actorUserId ?? null,
      retiredBy: input.actorUserId ?? "Unknown",
      reason: input.reason ?? null
    });
    const criterionVersionId = this.skillVersionCriteria.get(entry.sourceSkillVersionId);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Golden evidence has no immutable criterion version binding");
    }
    await this.getOrCreateRegressionDatasetRevision(input.projectId, input.actorUserId, criterionVersionId);
  }

  async importTrace(_projectId: string, source: CaseSource, input: ManualTraceImportInput, context: TraceImportContext): Promise<TraceImportResult> {
    assertTraceIngestionPurpose(source, context.ingestionPurpose);
    if (isInternalTraceMetadata(input.metadata)) {
      throw new RecursiveTraceSkippedError(input.sourceTraceId);
    }
    const rawTraceId = `raw_${randomUUID()}`;
    const caseId = `case_${randomUUID()}`;
    const sourceTraceId = input.sourceTraceId?.trim() || `${source}_${caseId}`;
    // Purpose is immutable origin metadata, not part of trace identity. A
    // later product path that sees the same trace reuses the first case
    // without reclassifying it; Map iteration keeps that choice deterministic.
    for (const [existingCaseId, traceSource] of this.traceSources.entries()) {
      if (traceSource.source === source && traceSource.sourceTraceId === sourceTraceId) {
        return {
          rawTraceId: traceSource.rawTraceId,
          caseId: existingCaseId,
          sourceTraceId,
          created: false
        };
      }
    }
    const normalizedPayload = redactNormalizedTracePayload(normalizeTracePayload(input), context.redactionConfig);
    this.traces.set(caseId, {
      id: sourceTraceId,
      input: normalizedPayload.input,
      output: normalizedPayload.output,
      metadata: normalizedPayload.metadata,
      ...(normalizedPayload.steps ? { steps: normalizedPayload.steps } : {})
    });
    this.traceSources.set(caseId, {
      source,
      sourceTraceId,
      rawTraceId,
      ingestionPurpose: context.ingestionPurpose,
      createdAt: new Date().toISOString(),
      sourceIntegrationId: context.sourceIntegrationId,
      importJobId: context.importJobId
    });
    this.caseInputIdentities.set(caseId, datasetInputIdentity({ input: input.input }));
    return { rawTraceId, caseId, sourceTraceId, created: true };
  }

  // plaintext in-memory — encrypt-at-rest is a PG-only property
  // (locked shape; encryptJson needs BETTER_AUTH_SECRET, which demo may lack).
  private judgeProviderKeys = new Map<string, { apiKey: string; keyDisplay: string; createdAt: string }>();

  async setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string): Promise<JudgeProviderKey> {
    const createdAt = new Date().toISOString();
    const keyDisplay = judgeKeyDisplay(apiKey);
    this.judgeProviderKeys.set(`${projectId}:${provider}`, { apiKey, keyDisplay, createdAt });
    return { provider, keyDisplay, createdAt };
  }

  async listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]> {
    return [...this.judgeProviderKeys.entries()]
      .filter(([mapKey]) => mapKey.startsWith(`${projectId}:`))
      .map(([mapKey, value]) => ({
        provider: mapKey.split(":")[1] as JudgeKeyProvider,
        keyDisplay: value.keyDisplay,
        createdAt: value.createdAt
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider): Promise<boolean> {
    return this.judgeProviderKeys.delete(`${projectId}:${provider}`);
  }

  async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
    return this.judgeProviderKeys.get(`${projectId}:${provider}`)?.apiKey ?? null;
  }

  private async resolveImportSkillVersionId(projectId: string, requested?: string | undefined): Promise<string> {
    if (requested) {
      const version = await this.getSkillVersion(projectId, requested);
      if (!version) throw new DatasetRevisionConflictError(`Unknown import skillVersionId for this project: ${requested}`);
      return version.id;
    }
    return (await this.getCurrentSkill(projectId)).currentVersion.id;
  }

  private async resolveIntegrationSkillVersionId(
    projectId: string,
    requested?: string | undefined
  ): Promise<string | null> {
    if (requested) return this.resolveImportSkillVersionId(projectId, requested);
    try {
      return await this.resolveImportSkillVersionId(projectId);
    } catch (error) {
      if (error instanceof NoCurrentSkillError) return null;
      throw error;
    }
  }

  async createImportJob(input: CreateImportJobInput): Promise<ImportJobRecord> {
    const now = new Date().toISOString();
    const skillVersionId = await this.resolveImportSkillVersionId(input.projectId, input.skillVersionId);
    const job: ImportJobRecord = {
      id: `import_${randomUUID()}`,
      projectId: input.projectId,
      source: input.source,
      sourceIntegrationId: input.sourceIntegrationId ?? null,
      skillVersionId,
      actorUserId: input.actorUserId ?? null,
      actorEmail: null,
      actorName: null,
      queueJobId: null,
      status: "queued",
      requestedLimit: input.requestedLimit ?? null,
      importedCount: 0,
      queuedJudgeCount: 0,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      error: null
    };
    this.importJobs.unshift(job);
    return { ...job };
  }

  async markImportJobQueued(projectId: string, importJobId: string, queueJobId: string): Promise<ImportJobRecord> {
    const job = this.getImportJob(projectId, importJobId);
    job.queueJobId = queueJobId;
    return { ...job };
  }

  async markImportJobRunning(projectId: string, importJobId: string): Promise<void> {
    const job = this.getImportJob(projectId, importJobId);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.error = null;
  }

  async markImportJobCompleted(projectId: string, importJobId: string, result: CompleteImportJobInput): Promise<void> {
    const job = this.getImportJob(projectId, importJobId);
    const totalImportedForJob = [...this.traceSources.values()].filter((traceSource) => traceSource.importJobId === importJobId).length;
    job.status = "completed";
    job.importedCount = totalImportedForJob > 0 ? totalImportedForJob : result.importedCount;
    job.queuedJudgeCount = result.queuedJudgeCount;
    job.completedAt = new Date().toISOString();
    job.error = null;
  }

  async markImportJobFailed(projectId: string, importJobId: string, error: unknown): Promise<ImportJobRecord> {
    const job = this.getImportJob(projectId, importJobId);
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? error.message : String(error);
    return { ...job };
  }

  async listImportJobs(input: ListImportJobsInput): Promise<ImportJobRecord[]> {
    return this.importJobs
      .filter((job) => job.projectId === input.projectId && (!input.status || job.status === input.status))
      .slice(0, input.limit)
      .map((job) => ({ ...job }));
  }

  private recordImportSelectionFailure(
    projectId: string,
    source: "langsmith" | "langfuse" | "ironside",
    integrationId: string,
    requestedLimit: number,
    now: Date
  ): void {
    const timestamp = now.toISOString();
    this.importJobs.unshift({
      id: `import_${randomUUID()}`,
      projectId,
      source,
      sourceIntegrationId: integrationId,
      skillVersionId: null,
      actorUserId: null,
      actorEmail: null,
      actorName: null,
      queueJobId: null,
      status: "failed",
      requestedLimit,
      importedCount: 0,
      queuedJudgeCount: 0,
      createdAt: timestamp,
      startedAt: null,
      completedAt: timestamp,
      error: "skill_version_required: configure an exact evaluator version before scheduled import"
    });
  }

  async createLangSmithIntegration(projectId: string, input: LangSmithIntegrationInput): Promise<LangSmithIntegration> {
    const id = `int_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const integration: LangSmithIntegration = {
      id,
      projectId,
      provider: "langsmith",
      skillVersionId,
      projectName: input.projectName ?? null,
      endpointUrl: input.endpointUrl ?? null,
      pollEnabled,
      pollIntervalSeconds,
      pollLimit,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt
    };
    this.langSmithIntegrations.set(id, {
      ...integration,
      apiKey: input.apiKey,
      limit: pollLimit,
      pollEnabled,
      pollIntervalMs: pollIntervalSeconds * 1000,
      redactionConfig: input.redaction ?? {}
    });
    return integration;
  }

  async listLangSmithIntegrations(projectId: string): Promise<LangSmithIntegration[]> {
    return [...this.langSmithIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicLangSmithIntegration);
  }

  async updateLangSmithIntegration(projectId: string, integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration> {
    const integration = this.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    if (input.pollEnabled !== undefined) integration.pollEnabled = input.pollEnabled;
    if (input.pollIntervalSeconds !== undefined) {
      integration.pollIntervalSeconds = input.pollIntervalSeconds;
      integration.pollIntervalMs = input.pollIntervalSeconds * 1000;
    }
    if (input.pollLimit !== undefined) {
      integration.pollLimit = input.pollLimit;
      integration.limit = input.pollLimit;
    }
    if (input.skillVersionId !== undefined) {
      integration.skillVersionId = await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    }
    return toPublicLangSmithIntegration(integration);
  }

  async recordLangSmithConnectionTest(projectId: string, integrationId: string, result: LangSmithConnectionTestResult): Promise<void> {
    const integration = this.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async deleteLangSmithIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    this.langSmithIntegrations.delete(integrationId);
    this.langSmithLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueLangSmithImportTargets(input: ClaimLangSmithImportTargetsInput): Promise<LangSmithImportTarget[]> {
    const targets: LangSmithImportTarget[] = [];
    for (const integration of this.langSmithIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.langSmithLastPolledAt.get(integration.id);
      if (!integration.pollEnabled) continue;
      if (lastPolledAt !== undefined && input.now.getTime() - lastPolledAt < integration.pollIntervalMs) continue;
      try {
        targets.push({
          projectId: integration.projectId,
          integrationId: integration.id,
          skillVersionId: integration.skillVersionId ?? await this.resolveImportSkillVersionId(integration.projectId),
          limit: Math.max(1, Math.min(integration.limit, 100))
        });
      } catch (error) {
        if (!(error instanceof NoCurrentSkillError) && !(error instanceof AmbiguousProjectSkillError)) throw error;
        this.recordImportSelectionFailure(
          integration.projectId,
          "langsmith",
          integration.id,
          Math.max(1, Math.min(integration.limit, 100)),
          input.now
        );
        this.langSmithLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.langSmithLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadLangSmithImportContext(job: LangSmithImportJob): Promise<LangSmithImportContext> {
    const integration = this.langSmithIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new LangSmithIntegrationNotFoundError(job.integrationId);
    return { ...integration, limit: job.limit };
  }

  async createLangfuseIntegration(projectId: string, input: LangfuseIntegrationInput): Promise<LangfuseIntegration> {
    const id = `int_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const integration: LangfuseIntegration = {
      id,
      projectId,
      provider: "langfuse",
      skillVersionId,
      projectName: null,
      endpointUrl: input.endpointUrl ?? null,
      pollEnabled,
      pollIntervalSeconds,
      pollLimit,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt
    };
    this.langfuseIntegrations.set(id, {
      ...integration,
      publicKey: input.publicKey,
      secretKey: input.secretKey,
      limit: pollLimit,
      pollEnabled,
      pollIntervalMs: pollIntervalSeconds * 1000,
      redactionConfig: input.redaction ?? {}
    });
    return integration;
  }

  async listLangfuseIntegrations(projectId: string): Promise<LangfuseIntegration[]> {
    return [...this.langfuseIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicLangfuseIntegration);
  }

  async updateLangfuseIntegration(projectId: string, integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration> {
    const integration = this.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    if (input.pollEnabled !== undefined) integration.pollEnabled = input.pollEnabled;
    if (input.pollIntervalSeconds !== undefined) {
      integration.pollIntervalSeconds = input.pollIntervalSeconds;
      integration.pollIntervalMs = input.pollIntervalSeconds * 1000;
    }
    if (input.pollLimit !== undefined) {
      integration.pollLimit = input.pollLimit;
      integration.limit = input.pollLimit;
    }
    if (input.skillVersionId !== undefined) {
      integration.skillVersionId = await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    }
    return toPublicLangfuseIntegration(integration);
  }

  async recordLangfuseConnectionTest(projectId: string, integrationId: string, result: LangfuseConnectionTestResult): Promise<void> {
    const integration = this.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async deleteLangfuseIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    this.langfuseIntegrations.delete(integrationId);
    this.langfuseLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueLangfuseImportTargets(input: ClaimLangfuseImportTargetsInput): Promise<LangfuseImportTarget[]> {
    const targets: LangfuseImportTarget[] = [];
    for (const integration of this.langfuseIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.langfuseLastPolledAt.get(integration.id);
      if (!integration.pollEnabled) continue;
      if (lastPolledAt !== undefined && input.now.getTime() - lastPolledAt < integration.pollIntervalMs) continue;
      try {
        targets.push({
          projectId: integration.projectId,
          integrationId: integration.id,
          skillVersionId: integration.skillVersionId ?? await this.resolveImportSkillVersionId(integration.projectId),
          limit: Math.max(1, Math.min(integration.limit, 100))
        });
      } catch (error) {
        if (!(error instanceof NoCurrentSkillError) && !(error instanceof AmbiguousProjectSkillError)) throw error;
        this.recordImportSelectionFailure(
          integration.projectId,
          "langfuse",
          integration.id,
          Math.max(1, Math.min(integration.limit, 100)),
          input.now
        );
        this.langfuseLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.langfuseLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadLangfuseImportContext(job: LangfuseImportJob): Promise<LangfuseImportContext> {
    const integration = this.langfuseIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new LangfuseIntegrationNotFoundError(job.integrationId);
    return { ...integration, limit: job.limit };
  }

  async createIronsideIntegration(projectId: string, input: IronsideIntegrationInput): Promise<IronsideIntegration> {
    const id = `int_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const integration: IronsideIntegration = {
      id,
      projectId,
      provider: "ironside",
      skillVersionId,
      url: input.url,
      pollEnabled,
      pollIntervalSeconds,
      pollLimit,
      quietPeriodSeconds: input.quietPeriodSeconds ?? 300,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt
    };
    this.ironsideIntegrations.set(id, {
      ...integration,
      apiKey: input.apiKey,
      limit: pollLimit,
      pollEnabled,
      pollIntervalMs: pollIntervalSeconds * 1000,
      redactionConfig: input.redaction ?? {},
      syncState: { watermark: null, cursor: null, windowTo: null }
    });
    return integration;
  }

  async listIronsideIntegrations(projectId: string): Promise<IronsideIntegration[]> {
    return [...this.ironsideIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicIronsideIntegration);
  }

  async updateIronsideIntegration(projectId: string, integrationId: string, input: UpdateIronsideIntegrationInput): Promise<IronsideIntegration> {
    const integration = this.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    if (input.pollEnabled !== undefined) integration.pollEnabled = input.pollEnabled;
    if (input.pollIntervalSeconds !== undefined) {
      integration.pollIntervalSeconds = input.pollIntervalSeconds;
      integration.pollIntervalMs = input.pollIntervalSeconds * 1000;
    }
    if (input.pollLimit !== undefined) {
      integration.pollLimit = input.pollLimit;
      integration.limit = input.pollLimit;
    }
    if (input.skillVersionId !== undefined) {
      integration.skillVersionId = await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    }
    return toPublicIronsideIntegration(integration);
  }

  async recordIronsideConnectionTest(projectId: string, integrationId: string, result: IronsideConnectionTestResult): Promise<void> {
    const integration = this.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async deleteIronsideIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    this.ironsideIntegrations.delete(integrationId);
    this.ironsideLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueIronsideImportTargets(input: ClaimIronsideImportTargetsInput): Promise<IronsideImportTarget[]> {
    const targets: IronsideImportTarget[] = [];
    for (const integration of this.ironsideIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.ironsideLastPolledAt.get(integration.id);
      if (!integration.pollEnabled) continue;
      if (lastPolledAt !== undefined && input.now.getTime() - lastPolledAt < integration.pollIntervalMs) continue;
      try {
        targets.push({
          projectId: integration.projectId,
          integrationId: integration.id,
          skillVersionId: integration.skillVersionId ?? await this.resolveImportSkillVersionId(integration.projectId),
          limit: Math.max(1, Math.min(integration.limit, 100))
        });
      } catch (error) {
        if (!(error instanceof NoCurrentSkillError) && !(error instanceof AmbiguousProjectSkillError)) throw error;
        this.recordImportSelectionFailure(
          integration.projectId,
          "ironside",
          integration.id,
          Math.max(1, Math.min(integration.limit, 100)),
          input.now
        );
        this.ironsideLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.ironsideLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadIronsideImportContext(job: IronsideImportJob): Promise<IronsideImportContext> {
    const integration = this.ironsideIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new IronsideIntegrationNotFoundError(job.integrationId);
    return { ...integration, syncState: { ...integration.syncState }, limit: job.limit };
  }

  async saveIronsideSyncState(projectId: string, integrationId: string, state: IronsideSyncState): Promise<void> {
    const integration = this.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    integration.syncState = { ...state };
  }

  private getImportJob(projectId: string, importJobId: string): ImportJobRecord {
    const job = this.importJobs.find((candidate) => candidate.id === importJobId && candidate.projectId === projectId);
    if (!job) throw new Error(`Import job not found: ${importJobId}`);
    return job;
  }

  async loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext> {
    // Imported traces first; built-in fixture cases (exceptions, golden set)
    // get the same synthesized traces the case-detail and regression surfaces
    // use, so demo eval runs can judge them instead of failing the item.
    const trace = this.traces.get(job.caseId) ?? this.syntheticTraceForBuiltinCase(job.caseId);
    if (!trace) throw new Error(`Case not found for judge job: ${job.caseId}`);
    // Honor the pinned version like PgRepository does — an eval run pinned to
    // an older version must record verdicts under THAT version id, or the run
    // claims one judge while the ledger says another (the A2.2c trap).
    const skillVersion = job.skillVersionId
      ? (this.skillVersions ?? [demoSkill.currentVersion]).find((version) => version.id === job.skillVersionId)
      : demoSkill.currentVersion;
    if (!skillVersion) throw new Error(`Skill version not found for judge job: ${job.skillVersionId}`);
    return {
      projectId: demoProject.id,
      caseId: job.caseId,
      skillVersion,
      trace
    };
  }

  private syntheticTraceForBuiltinCase(caseId: string): Trace | null {
    const exception = demoExceptions.find((candidate) => candidate.id === caseId);
    if (exception) {
      // Embedding the judge's original reason keeps the mock heuristic
      // coherent: a failing exception re-judges as fail.
      return {
        id: exception.traceId,
        input: { text: "Demo customer support question" },
        output: { text: `Demo AI answer. Judge note: ${exception.reason}` },
        metadata: { source: "demo" }
      };
    }
    const golden = demoGoldenSet.find((entry) => entry.caseId === caseId);
    if (golden) return demoTraceForGoldenEntry(golden);
    return null;
  }

  async recordJudgeRun(input: RecordJudgeRunInput): Promise<JudgeRun> {
    const existing = this.judgeRuns.find((candidate) =>
      candidate.projectId === input.projectId &&
      candidate.caseId === input.caseId &&
      candidate.skillVersionId === input.skillVersionId
    );
    if (existing) return existing;

    const run: JudgeRun = {
      id: `judge_${randomUUID()}`,
      projectId: input.projectId,
      caseId: input.caseId,
      skillVersionId: input.skillVersionId,
      verdict: input.verdict.label,
      score: input.verdict.score,
      reasoning: input.verdict.reason,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      providerMetadata: input.providerMetadata ?? {
        model: null,
        requestId: null,
        responseId: null,
        systemFingerprint: null
      },
      createdAt: new Date().toISOString()
    };
    this.judgeRuns.push(run);
    return run;
  }

  async recordVerdict(input: RecordVerdictInput): Promise<VerdictRecord> {
    if (input.externalRunId) {
      const existing = this.verdicts.find(
        (candidate) =>
          candidate.projectId === input.projectId &&
          candidate.source === "imported_external" &&
          candidate.externalRunId === input.externalRunId
      );
      if (existing) return existing;
    }
    let skillVersionId = input.skillVersionId;
    if (input.source === "human" || input.source === "adjudicated") {
      const criterionCount = this.criteria.filter((criterion) => criterion.projectId === input.projectId).length;
      const definitionCount = this.criterionVersions.filter((version) => version.projectId === input.projectId).length;
      if (!skillVersionId && (criterionCount > 1 || definitionCount > 1)) {
        throw new AmbiguousProjectSkillError(input.projectId, Math.max(criterionCount, definitionCount));
      }
      const detail = await this.getCaseDetail(input.projectId, input.caseId, skillVersionId);
      if (detail) {
        skillVersionId = detail.judgeRun.skillVersionId;
      } else if (skillVersionId) {
        const version = await this.getSkillVersion(input.projectId, skillVersionId);
        if (!version || !(await this.caseExistsForProject(input.projectId, input.caseId))) {
          throw new CaseNotFoundError(input.caseId);
        }
      } else if (!skillVersionId) {
        // Legacy singleton behavior allowed a reviewer to label an imported
        // case before its first judge run. Preserve that flow by binding the
        // verdict to the sole evaluator instead of writing an unscoped NULL.
        skillVersionId = (await this.getCurrentSkill(input.projectId)).currentVersion.id;
      }
    }
    const createdAt = new Date().toISOString();
    const record: VerdictRecord = {
      id: `verdict_${randomUUID()}`,
      projectId: input.projectId,
      caseId: input.caseId,
      skillVersionId: skillVersionId ?? null,
      source: input.source,
      actorUserId: input.actorUserId ?? null,
      payload: input.payload,
      externalRunId: input.externalRunId ?? null,
      createdAt
    };
    this.verdicts.push(record);
    // a human verdict completes pending queue items pointing at
    // this case, scoped to:
    //   - items unassigned (any reviewer covered them); AND
    //   - items assigned specifically to this verdict's actor.
    // Items assigned to OTHER reviewers stay pending — they're the κ-overlap
    // partner row and must wait for that reviewer's own verdict.
    if (input.source === "human") {
      const criterionVersionId = skillVersionId
        ? this.skillVersionCriteria.get(skillVersionId)
        : undefined;
      for (const item of this.reviewQueueItems) {
        if (item.caseId !== input.caseId || item.status !== "pending") continue;
        if (!criterionVersionId || item.criterionVersionId !== criterionVersionId) continue;
        const isMine = item.assignedToUserId === null || item.assignedToUserId === input.actorUserId;
        if (!isMine) continue;
        item.status = "completed";
        item.completedAt = createdAt;
      }
    }
    return record;
  }

  async createApiKey(input: CreateApiKeyInputDb): Promise<CreatedApiKey> {
    const generated = generateApiKey();
    const record: ApiKey = {
      id: `apikey_${randomUUID()}`,
      projectId: input.projectId,
      name: input.name,
      keyPrefix: generated.keyPrefix,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null
    };
    this.apiKeys.push({ record, keyHash: generated.keyHash });
    return { ...record, key: generated.key };
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    return this.apiKeys
      .filter((entry) => entry.record.projectId === projectId)
      .map((entry) => entry.record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean> {
    const entry = this.apiKeys.find((candidate) => candidate.record.id === apiKeyId && candidate.record.projectId === projectId);
    if (!entry || entry.record.revokedAt) return false;
    entry.record.revokedAt = new Date().toISOString();
    return true;
  }

  async resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null> {
    const keyHash = hashApiKey(rawKey);
    const entry = this.apiKeys.find((candidate) => candidate.keyHash === keyHash && !candidate.record.revokedAt);
    if (!entry) return null;
    entry.record.lastUsedAt = new Date().toISOString();
    return { projectId: entry.record.projectId, apiKeyId: entry.record.id };
  }

  async createTraceTest(input: CreateTraceTestInputDb): Promise<TraceTestDetail> {
    if (input.projectId !== demoProject.id) throw new TraceTestSourceNotFoundError(input.sourceCaseId);
    const stored = this.traces.get(input.sourceCaseId);
    const detail = stored ? null : await this.getCaseDetail(input.projectId, input.sourceCaseId);
    if (!stored && !detail) throw new TraceTestSourceNotFoundError(input.sourceCaseId);
    const source = stored ?? detail!.trace;
    const sourceSnapshot = {
      input: source.input,
      output: source.output,
      metadata: source.metadata ?? {},
      ...(source.steps ? { steps: source.steps } : {})
    };
    const traceSource = this.traceSources.get(input.sourceCaseId);
    const createdAt = new Date().toISOString();
    const record = {
      id: `tt_${randomUUID()}`,
      projectId: input.projectId,
      sourceCaseId: input.sourceCaseId,
      sourceCaseRef: input.sourceCaseId,
      sourceTraceRef: traceSource?.sourceTraceId ?? source.id,
      sourceSnapshot: structuredClone(sourceSnapshot),
      sourceScope: structuredClone(input.sourceScope),
      currentRevision: 1,
      enabledRevision: null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt,
      updatedAt: createdAt
    };
    this.traceTests.push(record);
    this.traceTestRevisions.push({
      id: `ttr_${randomUUID()}`,
      traceTestId: record.id,
      revision: 1,
      lifecycle: "draft",
      desiredBehavior: input.desiredBehavior,
      scenario: input.scenario,
      expectedBehavior: input.expectedBehavior,
      mustDo: structuredClone(input.mustDo),
      mustAvoid: structuredClone(input.mustAvoid),
      goodExample: structuredClone(input.goodExample),
      badExample: structuredClone(input.badExample),
      checker: structuredClone(input.checker),
      draftProvenance: structuredClone(input.draftProvenance),
      validationId: null,
      validatedRevision: null,
      createdByUserId: input.createdByUserId ?? null,
      reviewedByUserId: null,
      createdAt,
      reviewedAt: null
    });
    return this.toTraceTestDetail(record);
  }

  async listTraceTests(projectId: string, sourceCaseRef?: string): Promise<TraceTestSummary[]> {
    return this.traceTests
      .filter((test) => test.projectId === projectId && (!sourceCaseRef || test.sourceCaseRef === sourceCaseRef))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .map((test) => this.toTraceTestSummary(test));
  }

  async getTraceTest(projectId: string, traceTestId: string): Promise<TraceTestDetail | null> {
    const test = this.traceTests.find((candidate) => candidate.id === traceTestId && candidate.projectId === projectId);
    return test ? this.toTraceTestDetail(test) : null;
  }

  async reviseTraceTest(input: ReviseTraceTestInputDb): Promise<TraceTestDetail> {
    const test = this.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.expectedRevision) {
      throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    }
    const createdAt = new Date().toISOString();
    const revision = test.currentRevision + 1;
    this.traceTestRevisions.push({
      id: `ttr_${randomUUID()}`,
      traceTestId: test.id,
      revision,
      lifecycle: "draft",
      desiredBehavior: input.desiredBehavior,
      scenario: input.scenario,
      expectedBehavior: input.expectedBehavior,
      mustDo: structuredClone(input.mustDo),
      mustAvoid: structuredClone(input.mustAvoid),
      goodExample: structuredClone(input.goodExample),
      badExample: structuredClone(input.badExample),
      checker: structuredClone(input.checker),
      draftProvenance: structuredClone(input.draftProvenance),
      validationId: null,
      validatedRevision: null,
      createdByUserId: input.createdByUserId ?? null,
      reviewedByUserId: null,
      createdAt,
      reviewedAt: null
    });
    test.currentRevision = revision;
    test.updatedAt = createdAt;
    return this.toTraceTestDetail(test);
  }

  async recordTraceTestValidation(input: RecordTraceTestValidationInputDb): Promise<TraceTestValidation> {
    const test = this.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.revision) {
      throw new TraceTestRevisionConflictError(input.revision, test.currentRevision);
    }
    const validation: TraceTestValidation = {
      id: `ttv_${randomUUID()}`,
      traceTestId: test.id,
      revision: input.revision,
      status: traceTestValidationStatus(input.badEvidence.result, input.goodEvidence.result),
      badEvidence: {
        output: structuredClone(input.badEvidence.output),
        result: input.badEvidence.result,
        note: input.badEvidence.note,
        expectedResult: "fail",
        attempts: input.badAttempts ?? 0,
        usage: input.badUsage ?? null
      },
      goodEvidence: {
        output: structuredClone(input.goodEvidence.output),
        result: input.goodEvidence.result,
        note: input.goodEvidence.note,
        expectedResult: "pass",
        attempts: input.goodAttempts ?? 0,
        usage: input.goodUsage ?? null
      },
      method: input.method ?? "automated",
      diagnostic: input.diagnostic ?? traceTestValidationDiagnostic(input.badEvidence.result, input.goodEvidence.result),
      evaluator: input.evaluator ?? null,
      overrideReason: input.overrideReason ?? null,
      recordedByUserId: input.recordedByUserId ?? null,
      createdAt: new Date().toISOString()
    };
    this.traceTestValidations.push(validation);
    return structuredClone(validation);
  }

  async enableTraceTest(input: EnableTraceTestInputDb): Promise<TraceTestDetail> {
    const test = this.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.expectedRevision) {
      throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    }
    const validation = this.traceTestValidations.find(
      (candidate) => candidate.id === input.validationId && candidate.traceTestId === test.id && candidate.revision === input.expectedRevision
    );
    if (!validation || !traceTestValidationIsEnableEligible(validation)) {
      throw new TraceTestValidationNotReadyError("A successful validation for the current draft is required before enabling this test");
    }
    const current = this.traceTestRevisions.find(
      (candidate) => candidate.traceTestId === test.id && candidate.revision === input.expectedRevision
    );
    if (!current) throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    if (current.lifecycle !== "draft") {
      throw new TraceTestValidationNotReadyError("Create a new draft revision before enabling this test again");
    }
    const reviewedAt = new Date().toISOString();
    const revision = test.currentRevision + 1;
    this.traceTestRevisions.push({
      ...structuredClone(current),
      id: `ttr_${randomUUID()}`,
      revision,
      lifecycle: "enabled",
      validationId: validation.id,
      validatedRevision: input.expectedRevision,
      createdByUserId: current.createdByUserId,
      reviewedByUserId: input.reviewedByUserId,
      createdAt: reviewedAt,
      reviewedAt
    });
    test.currentRevision = revision;
    test.enabledRevision = revision;
    test.updatedAt = reviewedAt;
    return this.toTraceTestDetail(test);
  }

  async recordTraceTestFunnelEvent(input: RecordTraceTestFunnelEventInputDb): Promise<void> {
    // Demo mode mirrors production idempotency without retaining source or
    // draft content. The set is intentionally not exposed as a product API.
    this.traceTestFunnelEvents.add(`${input.projectId}:${input.journeyId}:${input.event}`);
  }

  private toTraceTestSummary(test: (typeof this.traceTests)[number]): TraceTestSummary {
    return {
      id: test.id,
      projectId: test.projectId,
      sourceCaseId: test.sourceCaseId,
      sourceCaseRef: test.sourceCaseRef,
      sourceTraceRef: test.sourceTraceRef,
      lifecycle: test.enabledRevision === null ? "draft" : "enabled",
      currentRevision: test.currentRevision,
      enabledRevision: test.enabledRevision,
      hasUnpublishedChanges: test.enabledRevision !== null && test.currentRevision !== test.enabledRevision,
      createdAt: test.createdAt,
      updatedAt: test.updatedAt
    };
  }

  private toTraceTestDetail(test: (typeof this.traceTests)[number]): TraceTestDetail {
    return {
      ...this.toTraceTestSummary(test),
      sourceSnapshot: structuredClone(test.sourceSnapshot),
      sourceScope: structuredClone(test.sourceScope),
      createdByUserId: test.createdByUserId,
      revisions: this.traceTestRevisions
        .filter((revision) => revision.traceTestId === test.id)
        .sort((left, right) => left.revision - right.revision)
        .map((revision) => structuredClone(revision)),
      validations: this.traceTestValidations
        .filter((validation) => validation.traceTestId === test.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((validation) => structuredClone(validation))
    };
  }

  async createDataset(input: CreateDatasetInputDb): Promise<Dataset> {
    const name = input.name.trim();
    const duplicate = this.datasets.find(
      (candidate) => candidate.projectId === input.projectId && candidate.name === name && !candidate.archivedAt
    );
    if (duplicate) throw new DatasetNameTakenError(name);
    const record = {
      id: `ds_${randomUUID()}`,
      projectId: input.projectId,
      name,
      description: input.description ?? null,
      kind: input.kind ?? ("custom" as DatasetKind),
      createdAt: new Date().toISOString(),
      archivedAt: null as string | null
    };
    this.datasets.push(record);
    return this.toDataset(record);
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    return this.datasets
      .filter((dataset) => dataset.projectId === projectId && !dataset.archivedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((dataset) => this.toDataset(dataset));
  }

  async getDatasetDetail(projectId: string, datasetId: string): Promise<DatasetDetail | null> {
    const dataset = this.datasets.find((candidate) => candidate.id === datasetId && candidate.projectId === projectId);
    if (!dataset) return null;
    return {
      ...this.toDataset(dataset),
      items: this.datasetItems
        .filter((item) => item.datasetId === datasetId)
        .sort((left, right) => left.addedAt.localeCompare(right.addedAt))
    };
  }

  async archiveDataset(projectId: string, datasetId: string): Promise<boolean> {
    const dataset = this.datasets.find(
      (candidate) => candidate.id === datasetId && candidate.projectId === projectId && !candidate.archivedAt
    );
    if (!dataset) return false;
    dataset.archivedAt = new Date().toISOString();
    return true;
  }

  async addDatasetItems(input: AddDatasetItemsInputDb): Promise<DatasetItem[]> {
    const dataset = this.datasets.find(
      (candidate) => candidate.id === input.datasetId && candidate.projectId === input.projectId && !candidate.archivedAt
    );
    if (!dataset) throw new DatasetNotFoundError(input.datasetId);
    // Validate every case before inserting any — matches addReviewQueueItems.
    for (const item of input.items) {
      if (!(await this.caseExistsForProject(input.projectId, item.caseId))) {
        throw new CaseNotFoundError(item.caseId);
      }
    }
    const addedAt = new Date().toISOString();
    for (const item of input.items) {
      // Idempotent add with label upsert (PG parity): a repeat can update the
      // expected label / note, but a label-less append never nulls a stored one.
      const existing = this.datasetItems.find(
        (candidate) => candidate.datasetId === input.datasetId && candidate.caseId === item.caseId
      );
      if (existing) {
        existing.expectedLabel = item.expectedLabel ?? existing.expectedLabel;
        // Locked M2 invariant (PG parity): an explicit re-label to pass
        // CLEARS the stored step; a fail/label-less upsert without a step
        // keeps it.
        if (item.expectedLabel === "pass") existing.expectedFailStep = null;
        else if (item.expectedFailStep !== undefined) existing.expectedFailStep = item.expectedFailStep;
        existing.note = item.note ?? existing.note;
        continue;
      }
      this.datasetItems.push({
        id: `dsi_${randomUUID()}`,
        datasetId: input.datasetId,
        caseId: item.caseId,
        traceId: this.traceIdForCase(item.caseId),
        expectedLabel: item.expectedLabel ?? null,
        expectedFailStep: item.expectedFailStep ?? null,
        note: item.note ?? null,
        addedAt
      });
    }
    return this.datasetItems
      .filter((item) => item.datasetId === input.datasetId)
      .sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  async importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult> {
    const dataset = this.datasets.find(
      (candidate) => candidate.id === input.datasetId && candidate.projectId === input.projectId && !candidate.archivedAt
    );
    if (!dataset) throw new DatasetNotFoundError(input.datasetId);

    // In-memory "transaction": snapshot the collections this flow mutates and
    // restore them on any failure, so a mid-flow throw can't strand cases
    // without dataset membership (PG gets the same guarantee from a real
    // transaction).
    const tracesSnapshot = new Map(this.traces);
    const traceSourcesSnapshot = new Map(this.traceSources);
    const inputIdentitiesSnapshot = new Map(this.caseInputIdentities);
    const datasetItemsSnapshot = [...this.datasetItems];
    try {
      const results: ImportDatasetExamplesDbResult["items"] = [];
      for (const item of input.items) {
        const imported = await this.importTrace(input.projectId, "manual", {
          sourceTraceId: item.sourceTraceId,
          input: item.input,
          output: item.output,
          metadata: item.metadata,
          ...(item.steps ? { steps: item.steps } : {})
        }, { ingestionPurpose: input.ingestionPurpose });
        const [datasetItem] = await this.addDatasetItems({
          projectId: input.projectId,
          datasetId: input.datasetId,
          items: [{
            caseId: imported.caseId,
            ...(item.expectedLabel ? { expectedLabel: item.expectedLabel } : {}),
            ...(item.expectedFailStep !== undefined ? { expectedFailStep: item.expectedFailStep } : {}),
            ...(item.note ? { note: item.note } : {})
          }]
        }).then((items) => [items.find((candidate) => candidate.caseId === imported.caseId)]);
        results.push({
          sourceTraceId: imported.sourceTraceId,
          caseId: imported.caseId,
          created: imported.created,
          datasetItemId: datasetItem ? datasetItem.id : null
        });
      }
      return { items: results };
    } catch (error) {
      this.traces.clear();
      for (const [key, value] of tracesSnapshot) this.traces.set(key, value);
      this.traceSources.clear();
      for (const [key, value] of traceSourcesSnapshot) this.traceSources.set(key, value);
      this.caseInputIdentities.clear();
      for (const [key, value] of inputIdentitiesSnapshot) this.caseInputIdentities.set(key, value);
      this.datasetItems.length = 0;
      this.datasetItems.push(...datasetItemsSnapshot);
      throw error;
    }
  }

  async createDatasetRevision(input: CreateDatasetRevisionDbInput): Promise<DatasetRevisionDetail> {
    const creation = decidePublicDatasetRevisionCreation(input.role);
    if (!creation.allowed) {
      if (creation.code === "rejected_public_sealed_creation_unavailable") throw new SealedValidationUnavailableError();
      if (creation.code === "rejected_public_regression_creation_unavailable") {
        throw new DatasetRevisionConflictError(
          "Regression/golden revisions are created only by promotion and retirement governance"
        );
      }
      throw new DatasetRevisionConflictError("Unknown dataset revision role");
    }
    const dataset = await this.getDatasetDetail(input.projectId, input.datasetId);
    if (!dataset || dataset.archivedAt) throw new DatasetNotFoundError(input.datasetId);
    if (dataset.items.length === 0) throw new DatasetRevisionConflictError("Cannot freeze an empty working collection");

    const idempotencyLookup = input.idempotencyKey ? `${input.projectId}:${input.idempotencyKey}` : null;
    if (idempotencyLookup) {
      const priorId = this.datasetRevisionIdempotency.get(idempotencyLookup);
      if (priorId) {
        const prior = await this.getDatasetRevisionDetail(input.projectId, priorId);
        if (!prior) throw new DatasetRevisionConflictError("Idempotent dataset revision vanished");
        if (prior.sourceDatasetId !== input.datasetId || prior.role !== input.role) {
          throw new DatasetRevisionConflictError("Idempotency key was already used for a different dataset revision request");
        }
        return prior;
      }
    }

    const seriesId = `dataset:${dataset.id}`;
    const series = this.datasetRevisions
      .filter((revision) => revision.projectId === input.projectId && revision.seriesId === seriesId)
      .sort((left, right) => right.revisionNumber - left.revisionNumber);
    const parent = series[0] ?? null;
    if (input.expectedParentRevisionId !== undefined && input.expectedParentRevisionId !== parent?.id) {
      throw new DatasetRevisionConflictError(
        `Working collection revision changed from ${input.expectedParentRevisionId} to ${parent?.id ?? "none"}`
      );
    }

    const now = new Date().toISOString();
    const revisionId = `dsr_${randomUUID()}`;
    const items = dataset.items.map((item, position) => {
      const trace = this.traces.get(item.caseId);
      if (!trace) throw new DatasetRevisionConflictError(`Case ${item.caseId} has no retained payload to freeze`);
      const payloadSnapshot: DatasetRevisionPayloadSnapshot = {
        input: structuredClone(trace.input),
        output: structuredClone(trace.output),
        metadata: structuredClone(trace.metadata ?? {}),
        ...(trace.steps ? { steps: structuredClone(trace.steps) } : {})
      };
      const inputIdentity = this.caseInputIdentities.get(item.caseId);
      if (!inputIdentity) {
        throw new DatasetRevisionConflictError(
          `Case ${item.caseId} has no retained pre-redaction input identity and cannot be frozen as exact evidence`
        );
      }
      const matching = item.expectedLabel
        ? this.verdicts.filter((verdict) =>
            verdict.caseId === item.caseId && verdictLabelFromPayload(verdict.payload) === item.expectedLabel
          )
        : [];
      const adjudicated = matching.filter((verdict) => verdict.source === "adjudicated");
      const human = matching.filter((verdict) => verdict.source === "human");
      const supporting = adjudicated.length > 0 ? adjudicated : human;
      const referenceProvenance: DatasetReferenceProvenance = !item.expectedLabel
        ? {
            kind: "unlabeled",
            sourceId: item.id,
            verdictIds: [],
            actorUserIds: [],
            basis: "No reference label was present when the collection was frozen."
          }
        : supporting.length > 0
          ? {
              kind: adjudicated.length > 0 ? "adjudication" : "human_verdict",
              sourceId: item.id,
              verdictIds: supporting.map((verdict) => verdict.id),
              actorUserIds: supporting.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
              basis: adjudicated.length > 0
                ? "Dataset expectation matched retained adjudicated truth."
                : "Dataset expectation matched retained human verdict history."
            }
          : {
              kind: "dataset_claim",
              sourceId: item.id,
              verdictIds: [],
              actorUserIds: [],
              basis: "Mutable collection expectation; not adjudicated human truth."
            };
      const itemDigest = datasetRevisionItemDigest({
        inputIdentity,
        redactedPayload: payloadSnapshot,
        referenceLabel: item.expectedLabel,
        expectedFailStep: item.expectedFailStep,
        reviewProvenance: referenceProvenance,
        note: item.note
      });
      return {
        id: `dsri_${randomUUID()}`,
        revisionId,
        position,
        sourceCaseId: item.caseId,
        sourceTraceId: item.traceId,
        sourceDatasetItemId: item.id,
        sourceGoldenEntryId: null,
        inputDigest: inputIdentity.digest,
        itemDigest,
        payloadSnapshot,
        referenceLabel: item.expectedLabel,
        referenceFailStep: item.expectedFailStep,
        referenceProvenance,
        note: item.note,
        createdAt: now
      } satisfies DatasetRevisionItem;
    });
    const itemDigests = items.map((item) => item.itemDigest);
    const contentDigest = datasetRevisionContentDigest(itemDigests);
    if (input.reuseLatestContent && parent?.role === input.role && parent.contentDigest === contentDigest) {
      const detail = await this.getDatasetRevisionDetail(input.projectId, parent.id);
      if (!detail) throw new DatasetRevisionConflictError("Reusable dataset revision vanished");
      return detail;
    }
    const sealedInputDigests = new Set(
      this.datasetRevisionItems
        .filter((item) => this.datasetRevisions.some((revision) =>
          revision.id === item.revisionId && revision.projectId === input.projectId && revision.role === "sealed_validation"
        ))
        .map((item) => item.inputDigest)
    );
    if (items.some((item) => sealedInputDigests.has(item.inputDigest))) {
      throw new DatasetRevisionConflictError(
        "Working collection overlaps sealed validation input; explicit governed declassification is required before nonsealed use"
      );
    }
    const revision: DatasetRevision = {
      id: revisionId,
      projectId: input.projectId,
      seriesId,
      revisionNumber: (parent?.revisionNumber ?? 0) + 1,
      sourceDatasetId: dataset.id,
      parentRevisionId: parent?.id ?? null,
      role: input.role,
      sourceKind: "collection_snapshot",
      identityBasis: "input-identity/v1",
      contentDigest,
      revisionDigest: datasetRevisionDigest({ role: input.role, itemDigests }),
      itemCount: items.length,
      provenanceLevel: "unverified",
      exposureState: "visible_by_design",
      semanticLeakageDetection: "unsupported",
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now
    };
    const exposure = this.createDemoExposure(revision, {
      kind: "created",
      exposureClass: "lineage",
      activity: "revision_create",
      subjectKind: input.createdByUserId ? "person" : "system",
      subjectId: input.createdByUserId ?? null,
      actorUserId: input.createdByUserId ?? null,
      idempotencyKey: `revision-created:${revision.id}`
    });
    this.datasetRevisions.push(revision);
    this.datasetRevisionItems.push(...items);
    this.datasetExposureEvents.push(exposure);
    if (idempotencyLookup) this.datasetRevisionIdempotency.set(idempotencyLookup, revision.id);
    return { ...structuredClone(revision), items: structuredClone(items), exposures: [structuredClone(exposure)] };
  }

  async listDatasetRevisions(projectId: string, sourceDatasetId?: string): Promise<DatasetRevision[]> {
    return this.datasetRevisions
      .filter((revision) => revision.projectId === projectId && (!sourceDatasetId || revision.sourceDatasetId === sourceDatasetId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((revision) => structuredClone(revision));
  }

  async getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null> {
    const revision = this.datasetRevisions.find((candidate) => candidate.projectId === projectId && candidate.id === revisionId);
    if (!revision) return null;
    return {
      ...structuredClone(revision),
      items: this.datasetRevisionItems
        .filter((item) => item.revisionId === revision.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => structuredClone(item)),
      exposures: this.datasetExposureEvents
        .filter((event) => event.revisionId === revision.id)
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
        .map((event) => structuredClone(event))
    };
  }

  async recordDatasetRevisionContentView(input: {
    projectId: string;
    revisionId: string;
    actorUserId?: string | undefined;
  }): Promise<void> {
    const revision = this.datasetRevisions.find((candidate) =>
      candidate.projectId === input.projectId && candidate.id === input.revisionId
    );
    if (!revision) throw new DatasetRevisionNotFoundError(input.revisionId);
    this.datasetExposureEvents.push({
      id: `dse_${randomUUID()}`,
      projectId: input.projectId,
      revisionId: input.revisionId,
      revisionItemId: null,
      kind: "human_access",
      exposureClass: "development",
      activity: "content_view",
      subjectKind: input.actorUserId ? "person" : "system",
      subjectId: input.actorUserId ?? null,
      actorUserId: input.actorUserId ?? null,
      evidenceRefKind: "dataset_revision",
      evidenceRefId: input.revisionId,
      reason: null,
      details: {},
      occurredAt: new Date().toISOString()
    });
  }

  async getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string,
    criterionVersionId?: string
  ): Promise<DatasetRevisionDetail> {
    const projectCriteria = this.criteria.filter((criterion) => criterion.projectId === projectId);
    const resolvedCriterionVersionId = criterionVersionId ?? (() => {
      if (projectCriteria.length !== 1) {
        throw new DatasetRevisionConflictError(
          `Project ${projectId} requires an explicit criterionVersionId for regression evidence.`
        );
      }
      const latest = this.criterionVersions
        .filter((version) => version.criterionId === projectCriteria[0]!.id)
        .sort((left, right) => right.revision - left.revision)[0];
      if (!latest) throw new DatasetRevisionConflictError("Criterion has no immutable definition.");
      return latest.id;
    })();
    const golden = await this.listGoldenSet(projectId, resolvedCriterionVersionId);
    const now = new Date().toISOString();
    const revisionId = `dsr_${randomUUID()}`;
    const items = golden.map((entry, position) => {
      const trace = this.traces.get(entry.caseId) ?? demoTraceForGoldenEntry(entry);
      const payloadSnapshot: DatasetRevisionPayloadSnapshot = {
        input: structuredClone(trace.input),
        output: structuredClone(trace.output),
        metadata: structuredClone(trace.metadata ?? {}),
        ...(trace.steps ? { steps: structuredClone(trace.steps) } : {})
      };
      const inputIdentity = this.caseInputIdentities.get(entry.caseId);
      if (!inputIdentity) {
        throw new DatasetRevisionConflictError(
          `Case ${entry.caseId} has no retained pre-redaction input identity and cannot be frozen as exact evidence`
        );
      }
      const matchingHuman = this.verdicts.filter((verdict) =>
        verdict.caseId === entry.caseId &&
        (verdict.source === "human" || verdict.source === "adjudicated") &&
        verdict.skillVersionId !== null &&
        this.skillVersionCriteria.get(verdict.skillVersionId) === resolvedCriterionVersionId &&
        verdictLabelFromPayload(verdict.payload) === entry.agreedLabel
      );
      const referenceProvenance: DatasetReferenceProvenance = {
        kind: "golden_promotion",
        sourceId: entry.id,
        verdictIds: matchingHuman.map((verdict) => verdict.id),
        actorUserIds: matchingHuman.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
        basis: "Visible golden promotion; known-failure governance, not sealed validation."
      };
      const itemDigest = datasetRevisionItemDigest({
        inputIdentity,
        redactedPayload: payloadSnapshot,
        referenceLabel: entry.agreedLabel,
        expectedFailStep: null,
        reviewProvenance: referenceProvenance,
        note: entry.reason
      });
      return {
        id: `dsri_${randomUUID()}`,
        revisionId,
        position,
        sourceCaseId: entry.caseId,
        sourceTraceId: entry.traceId,
        sourceDatasetItemId: null,
        sourceGoldenEntryId: entry.id,
        inputDigest: inputIdentity.digest,
        itemDigest,
        payloadSnapshot,
        referenceLabel: entry.agreedLabel,
        referenceFailStep: null,
        referenceProvenance,
        note: entry.reason,
        createdAt: now
      } satisfies DatasetRevisionItem;
    });
    const itemDigests = items.map((item) => item.itemDigest);
    const revisionDigest = datasetRevisionDigest({ role: "regression_golden", itemDigests });
    const currentRevisionId = this.regressionDatasetRevisionIdsByCriterion.get(resolvedCriterionVersionId)
      ?? (projectCriteria.length === 1 ? this.regressionDatasetRevisionId : null);
    const current = currentRevisionId
      ? this.datasetRevisions.find((revision) => revision.id === currentRevisionId)
      : undefined;
    if (current?.revisionDigest === revisionDigest) {
      const detail = await this.getDatasetRevisionDetail(projectId, current.id);
      if (!detail) throw new DatasetRevisionConflictError("Current regression revision vanished");
      return detail;
    }
    const series = this.datasetRevisions.filter((revision) =>
      revision.projectId === projectId && revision.seriesId === `golden:${projectId}:${resolvedCriterionVersionId}`
    );
    const parent = [...series].sort((left, right) => right.revisionNumber - left.revisionNumber)[0] ?? null;
    const revision: DatasetRevision = {
      id: revisionId,
      projectId,
      seriesId: `golden:${projectId}:${resolvedCriterionVersionId}`,
      revisionNumber: (parent?.revisionNumber ?? 0) + 1,
      sourceDatasetId: null,
      parentRevisionId: parent?.id ?? null,
      role: "regression_golden",
      sourceKind: "golden_snapshot",
      identityBasis: "input-identity/v1",
      contentDigest: datasetRevisionContentDigest(itemDigests),
      revisionDigest,
      itemCount: items.length,
      provenanceLevel: items.length > 0 && items.every((item) => item.referenceProvenance.verdictIds.length > 0)
        ? "reviewed_unblinded"
        : "legacy",
      exposureState: "visible_by_design",
      semanticLeakageDetection: "unsupported",
      createdByUserId: actorUserId ?? null,
      createdAt: now
    };
    const created = this.createDemoExposure(revision, {
      kind: "created",
      exposureClass: "lineage",
      activity: "revision_create",
      subjectKind: actorUserId ? "person" : "system",
      subjectId: actorUserId ?? null,
      actorUserId: actorUserId ?? null,
      idempotencyKey: `revision-created:${revision.id}`
    });
    const visible = this.createDemoExposure(revision, {
      kind: "legacy_pretracking",
      exposureClass: "development",
      activity: "legacy_import",
      subjectKind: "system",
      subjectId: "golden-registry",
      actorUserId: actorUserId ?? null,
      idempotencyKey: `regression-visible:${revision.id}`
    });
    this.datasetRevisions.push(revision);
    this.datasetRevisionItems.push(...items);
    this.datasetExposureEvents.push(created, visible);
    this.regressionDatasetRevisionIdsByCriterion.set(resolvedCriterionVersionId, revision.id);
    if (projectCriteria.length === 1) this.regressionDatasetRevisionId = revision.id;
    return { ...structuredClone(revision), items: structuredClone(items), exposures: [structuredClone(created), structuredClone(visible)] };
  }

  private createDemoExposure(
    revision: DatasetRevision,
    input: Pick<DatasetExposureEvent, "kind" | "exposureClass" | "activity" | "subjectKind" | "subjectId" | "actorUserId"> & { idempotencyKey: string }
  ): DatasetExposureEvent {
    return {
      id: `dse_${randomUUID()}`,
      projectId: revision.projectId,
      revisionId: revision.id,
      revisionItemId: null,
      kind: input.kind,
      exposureClass: input.exposureClass,
      activity: input.activity,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      actorUserId: input.actorUserId,
      evidenceRefKind: null,
      evidenceRefId: null,
      reason: null,
      details: {},
      occurredAt: new Date().toISOString()
    };
  }

  async removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean> {
    const dataset = this.datasets.find((candidate) => candidate.id === datasetId && candidate.projectId === projectId);
    if (!dataset) return false;
    const index = this.datasetItems.findIndex((item) => item.datasetId === datasetId && item.id === itemId);
    if (index < 0) return false;
    this.datasetItems.splice(index, 1);
    return true;
  }

  private toDataset(record: {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    kind: DatasetKind;
    createdAt: string;
    archivedAt: string | null;
  }): Dataset {
    return {
      ...record,
      itemCount: this.datasetItems.filter((item) => item.datasetId === record.id).length
    };
  }

  private cloneAssessmentReceiptArtifact(artifact: AssessmentReceiptArtifact): AssessmentReceiptArtifact {
    return { ...artifact, canonicalBytes: Buffer.from(artifact.canonicalBytes) };
  }

  private cloneAssessmentReceiptComparison(comparison: AssessmentReceiptComparison): AssessmentReceiptComparison {
    return { ...comparison, consumerCanonicalBytes: Buffer.from(comparison.consumerCanonicalBytes) };
  }

  private isTerminalEvalRun(run: EvalRun): boolean {
    return run.status === "completed" || run.status === "failed" || run.status === "canceled";
  }

  private materializeDemoRootArtifact(
    run: EvalRunDetail,
    skillVersion: SkillVersion,
    sourceKind: Exclude<AssessmentReceiptArtifactSource, "correction">
  ): AssessmentReceiptArtifact {
    const receipt = buildAssessmentReceipt({ run, skillVersion });
    const canonicalBytes = canonicalReceiptBytes(receipt);
    return {
      id: `rart_${run.id}_v1_r1`,
      projectId: run.projectId,
      evalRunId: run.id,
      receiptId: receipt.receiptId,
      contractVersion: 1,
      artifactRevision: 1,
      canonicalBytes,
      artifactDigest: receiptArtifactDigest(canonicalBytes),
      evidenceDigest: receipt.evidenceDigest,
      sourceSnapshotDigest: receiptSourceSnapshotDigest({ run, skillVersion }),
      sourceKind,
      predecessorArtifactId: null,
      correctionReason: null,
      createdByUserId: null,
      createdAt: new Date().toISOString()
    };
  }

  private async mintDemoRootArtifact(
    run: EvalRun,
    sourceKind: Exclude<AssessmentReceiptArtifactSource, "correction">
  ): Promise<AssessmentReceiptArtifact> {
    const existing = this.assessmentReceiptArtifacts.find(
      (artifact) => artifact.evalRunId === run.id && artifact.contractVersion === 1 && artifact.artifactRevision === 1
    );
    if (existing) return this.cloneAssessmentReceiptArtifact(existing);
    if (run.trigger !== "release_evidence") {
      throw new AssessmentReceiptUnavailableError(
        "not_release_evidence",
        "Assessment receipts are available only for release_evidence runs"
      );
    }
    if (!this.isTerminalEvalRun(run)) {
      throw new AssessmentReceiptUnavailableError("not_terminal", "Assessment receipt is not available until the eval run is terminal");
    }
    const skillVersion = await this.getSkillVersion(run.projectId, run.skillVersionId);
    if (!skillVersion) {
      throw new AssessmentReceiptUnavailableError("missing_source", "Eval run skill version not found");
    }
    const detail = await this.getEvalRunDetail(run.projectId, run.id);
    if (!detail) throw new AssessmentReceiptUnavailableError("missing_source", "Eval run detail not found");
    const prepared = this.materializeDemoRootArtifact(detail, skillVersion, sourceKind);
    const raced = this.assessmentReceiptArtifacts.find(
      (artifact) => artifact.evalRunId === run.id && artifact.contractVersion === 1 && artifact.artifactRevision === 1
    );
    if (raced) return this.cloneAssessmentReceiptArtifact(raced);
    this.assessmentReceiptArtifacts.push(prepared);
    return this.cloneAssessmentReceiptArtifact(prepared);
  }

  async createEvalRun(input: CreateEvalRunInputDb): Promise<EvalRunDetail> {
    if (input.trigger === "backfill") {
      const existing = this.evalRuns.find((candidate) =>
        candidate.projectId === input.projectId &&
        candidate.skillVersionId === input.skillVersionId &&
        candidate.trigger === "backfill"
      );
      if (existing) {
        const detail = await this.getEvalRunDetail(input.projectId, existing.id);
        if (detail) return detail;
      }
    }
    const createdAt = new Date().toISOString();
    const runId = `evr_${randomUUID()}`;
    const revision = input.datasetRevisionId
      ? this.datasetRevisions.find((candidate) => candidate.id === input.datasetRevisionId && candidate.projectId === input.projectId)
      : null;
    if (input.datasetRevisionId && !revision) throw new DatasetRevisionNotFoundError(input.datasetRevisionId);
    const revisionItems = revision
      ? new Map(
          this.datasetRevisionItems
            .filter((candidate) => candidate.revisionId === revision.id)
            .map((candidate) => [candidate.id, candidate] as const)
        )
      : null;
    for (const item of input.items) {
      if (revisionItems) {
        if (!item.datasetRevisionItemId) {
          throw new DatasetRevisionConflictError(
            `Revision-bound eval item for case ${item.caseId} has no immutable item binding`
          );
        }
        const revisionItem = revisionItems.get(item.datasetRevisionItemId);
        if (!revisionItem || revisionItem.sourceCaseId !== item.caseId) {
          throw new DatasetRevisionConflictError(
            `Eval item ${item.datasetRevisionItemId} does not bind case ${item.caseId} in revision ${input.datasetRevisionId}`
          );
        }
      } else if (item.datasetRevisionItemId) {
        throw new DatasetRevisionConflictError("Eval item cannot bind a revision item without a revision-bound run");
      }
    }
    const items: EvalRunItem[] = input.items.map((item) => {
      const status = item.status ?? "pending";
      const resultLabel = item.resultLabel ?? null;
      const expectedLabel = item.expectedLabel ?? null;
      return {
        id: `evi_${randomUUID()}`,
        evalRunId: runId,
        caseId: item.caseId,
        datasetItemId: item.datasetItemId ?? null,
        datasetRevisionItemId: item.datasetRevisionItemId ?? null,
        clientItemId: item.clientItemId ?? null,
        contentDigest: item.contentDigest ?? null,
        status,
        verdictId: item.verdictId ?? null,
        expectedLabel,
        expectedFailStep: item.expectedFailStep ?? null,
        failingStep: item.failingStep ?? null,
        resultLabel,
        agreement: status === "completed" && expectedLabel ? resultLabel === expectedLabel : null,
        stepAgreement: item.expectedFailStep != null && item.failingStep != null
          ? item.failingStep === item.expectedFailStep
          : null,
        latencyMs: null,
        // Cached items spend nothing; fresh items get usage at completion.
        inputTokens: null,
        outputTokens: null,
        providerMetadata: item.providerMetadata ?? null,
        cached: item.cached ?? false,
        error: null,
        createdAt,
        finishedAt: status === "pending" ? null : createdAt
      };
    });
    // totalItems counts only verdict-bearing items; skips are recorded but
    // excluded so the completion check stays `completed + failed >= total`.
    const counted = items.filter((item) => item.status !== "skipped");
    const completed = counted.filter((item) => item.status === "completed");
    const run: EvalRun = {
      id: runId,
      projectId: input.projectId,
      datasetId: input.datasetId ?? null,
      datasetRevisionId: input.datasetRevisionId ?? null,
      skillVersionId: input.skillVersionId,
      trigger: input.trigger,
      status: completed.length >= counted.length ? "completed" : "pending",
      blocking: input.blocking ?? false,
      totalItems: counted.length,
      completedItems: completed.length,
      failedItems: 0,
      agreedItems: completed.filter((item) => item.agreement === true).length,
      error: null,
      sourceTraceTest: input.sourceTraceTest ?? null,
      createdAt,
      startedAt: null,
      finishedAt: completed.length >= counted.length ? createdAt : null
    };
    let terminalArtifact: AssessmentReceiptArtifact | null = null;
    if (run.trigger === "release_evidence" && this.isTerminalEvalRun(run)) {
      const skillVersion = await this.getSkillVersion(run.projectId, run.skillVersionId);
      if (!skillVersion) {
        throw new AssessmentReceiptUnavailableError("missing_source", "Eval run skill version not found");
      }
      terminalArtifact = this.materializeDemoRootArtifact(
        { ...run, items, spend: computeEvalRunSpend(items) },
        skillVersion,
        "terminal_mint"
      );
    }
    this.evalRuns.push(run);
    this.evalRunItems.push(...items);
    if (revision && this.isTerminalEvalRun(run)) {
      this.datasetExposureEvents.push({
        id: `dse_${randomUUID()}`,
        projectId: revision.projectId,
        revisionId: revision.id,
        revisionItemId: null,
        kind: "development_use",
        exposureClass: "development",
        activity: "development_run",
        subjectKind: "evaluator_version",
        subjectId: input.skillVersionId,
        actorUserId: input.createdByUserId ?? null,
        evidenceRefKind: "eval_run",
        evidenceRefId: run.id,
        reason: null,
        details: { trigger: input.trigger },
        occurredAt: createdAt
      });
    }
    if (terminalArtifact) this.assessmentReceiptArtifacts.push(terminalArtifact);
    return { ...run, items, spend: computeEvalRunSpend(items) };
  }

  async createConvergenceEvalRun(input: CreateConvergenceEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    const key = `${input.projectId}:${input.skillVersionId}:${input.caseId}`;
    const existing = this.convergenceEvalRuns.get(key);
    if (existing) {
      const original = await existing;
      const current = await this.getEvalRunDetail(input.projectId, original.id);
      if (current && current.status !== "failed" && current.status !== "canceled") {
        return { run: current, created: false };
      }
      if (this.convergenceEvalRuns.get(key) === existing) this.convergenceEvalRuns.delete(key);
      return this.createConvergenceEvalRun(input);
    }
    const creation = this.createEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "manual",
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      items: [{ caseId: input.caseId }]
    });
    this.convergenceEvalRuns.set(key, creation);
    try {
      return { run: await creation, created: true };
    } catch (error) {
      if (this.convergenceEvalRuns.get(key) === creation) this.convergenceEvalRuns.delete(key);
      throw error;
    }
  }

  async claimEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<EvalRunDispatchClaim> {
    const run = this.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run) return { state: "busy", jobId: null };
    const current = this.evalRunDispatches.get(run.id) ?? {
      jobId: randomUUID(),
      dispatchToken: null,
      claimedAt: null,
      dispatched: false
    };
    this.evalRunDispatches.set(run.id, current);
    if (current.dispatched) return { state: "dispatched", jobId: current.jobId };
    const leaseExpired = current.claimedAt !== null && current.claimedAt <= Date.now() - 5 * 60_000;
    if (current.dispatchToken !== null && !leaseExpired) return { state: "busy", jobId: current.jobId };
    current.dispatchToken = input.dispatchToken;
    current.claimedAt = Date.now();
    return { state: "claimed", jobId: current.jobId };
  }

  async markEvalRunDispatched(input: EvalRunDispatchInputDb): Promise<void> {
    const current = this.evalRunDispatches.get(input.evalRunId);
    if (!current || current.dispatchToken !== input.dispatchToken) return;
    current.dispatched = true;
    current.dispatchToken = null;
    current.claimedAt = null;
    await this.armEvalRunItemDeliveryDeadline(input.projectId, input.evalRunId);
  }

  async releaseEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<void> {
    const current = this.evalRunDispatches.get(input.evalRunId);
    if (!current || current.dispatched || current.dispatchToken !== input.dispatchToken) return;
    current.dispatchToken = null;
    current.claimedAt = null;
  }

  async armEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string): Promise<void> {
    const run = this.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return;
    const deadline = Date.now() + 15 * 60_000;
    for (const item of this.evalRunItems) {
      if (item.evalRunId === evalRunId && item.status === "pending") {
        this.evalRunItemDeliveryDeadlines.set(item.id, deadline);
      }
    }
  }

  async markEvalRunRunning(projectId: string, evalRunId: string): Promise<void> {
    const run = this.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return;
    const starting = run.status === "pending";
    if (starting) {
      run.status = "running";
      run.startedAt = new Date().toISOString();
    }
    if (starting && run.datasetRevisionId && run.startedAt) {
      this.datasetExposureEvents.push({
        id: `dse_${randomUUID()}`,
        projectId,
        revisionId: run.datasetRevisionId,
        revisionItemId: null,
        kind: "development_use",
        exposureClass: "development",
        activity: "development_run",
        subjectKind: "evaluator_version",
        subjectId: run.skillVersionId,
        actorUserId: null,
        evidenceRefKind: "eval_run",
        evidenceRefId: run.id,
        reason: null,
        details: { trigger: run.trigger },
        occurredAt: run.startedAt
      });
    }
  }

  async listPendingEvalRunItems(projectId: string, evalRunId: string): Promise<EvalRunItem[]> {
    const run = this.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return [];
    return this.evalRunItems.filter((item) => item.evalRunId === evalRunId && item.status === "pending");
  }

  async listPendingEvalRunItemDispatches(projectId: string, evalRunId: string): Promise<Array<{
    item: EvalRunItem;
    jobId: string;
  }>> {
    const pending = await this.listPendingEvalRunItems(projectId, evalRunId);
    return pending.map((item) => {
      const jobId = this.evalRunItemQueueJobs.get(item.id) ?? randomUUID();
      this.evalRunItemQueueJobs.set(item.id, jobId);
      return { item, jobId };
    });
  }

  async claimEvalRunItemExecution(input: EvalRunItemExecutionInputDb): Promise<EvalRunItemExecutionClaim> {
    const run = this.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return { state: "terminal" };
    const item = this.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    if (!item || item.status !== "pending") return { state: "terminal" };
    const current = this.evalRunItemExecutions.get(item.id);
    if (current) {
      if (current.providerCallReturned) {
        return { state: "outcome_unknown", executionToken: current.executionToken, providerCallReturned: true };
      }
      if (current.claimedAt > Date.now() - 15 * 60_000) return { state: "busy" };
      if (current.providerCallStarted) {
        return { state: "outcome_unknown", executionToken: current.executionToken, providerCallReturned: false };
      }
    }
    this.evalRunItemExecutions.set(item.id, {
      executionToken: input.executionToken,
      claimedAt: Date.now(),
      providerCallStarted: false,
      providerCallReturned: false
    });
    return { state: "claimed" };
  }

  async claimEvalRunItemRecovery(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const run = this.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    const item = this.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    const deadline = this.evalRunItemDeliveryDeadlines.get(input.evalRunItemId);
    if (
      !run || (run.status !== "pending" && run.status !== "running") ||
      !item || item.status !== "pending" || this.evalRunItemExecutions.has(item.id) ||
      deadline === undefined || deadline > Date.now()
    ) return false;
    this.evalRunItemExecutions.set(item.id, {
      executionToken: input.executionToken,
      claimedAt: Date.now(),
      providerCallStarted: false,
      providerCallReturned: false
    });
    return true;
  }

  async rearmEvalRunItemDeliveryDeadline(
    projectId: string,
    evalRunId: string,
    evalRunItemId: string
  ): Promise<boolean> {
    const run = this.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    const item = this.evalRunItems.find(
      (candidate) => candidate.id === evalRunItemId && candidate.evalRunId === evalRunId
    );
    const deadline = this.evalRunItemDeliveryDeadlines.get(evalRunItemId);
    if (
      !run || (run.status !== "pending" && run.status !== "running") ||
      !item || item.status !== "pending" || this.evalRunItemExecutions.has(item.id) ||
      deadline === undefined || deadline > Date.now()
    ) return false;
    this.evalRunItemDeliveryDeadlines.set(evalRunItemId, Date.now() + 15 * 60_000);
    return true;
  }

  async beginEvalRunItemProviderCall(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const current = this.evalRunItemExecutions.get(input.evalRunItemId);
    if (!current || current.executionToken !== input.executionToken || current.providerCallStarted) return false;
    current.providerCallStarted = true;
    return true;
  }

  async markEvalRunItemProviderCallReturned(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const current = this.evalRunItemExecutions.get(input.evalRunItemId);
    if (!current || current.executionToken !== input.executionToken || !current.providerCallStarted) return false;
    current.providerCallReturned = true;
    return true;
  }

  async releaseEvalRunItemExecution(
    input: EvalRunItemExecutionInputDb,
    options: EvalRunItemReleaseOptions = {}
  ): Promise<EvalRunItemReleaseDisposition> {
    const current = this.evalRunItemExecutions.get(input.evalRunItemId);
    if (!current || current.executionToken !== input.executionToken) return { state: "lost" };
    if (current.providerCallStarted) {
      return { state: "provider_started", providerCallReturned: current.providerCallReturned };
    }
    if (options.preservePreCallClaim) return { state: "pre_call_held" };
    this.evalRunItemExecutions.delete(input.evalRunItemId);
    this.evalRunItemDeliveryDeadlines.set(input.evalRunItemId, Date.now() + 15 * 60_000);
    return { state: "released" };
  }

  async listStaleEvalRunItemExecutions(): Promise<StaleEvalRunItemExecution[]> {
    const stale: StaleEvalRunItemExecution[] = [];
    for (const item of this.evalRunItems) {
      if (item.status !== "pending") continue;
      const evalRunItemId = item.id;
      const run = this.evalRuns.find((candidate) => candidate.id === item.evalRunId);
      if (!run || (run.status !== "pending" && run.status !== "running")) continue;
      const execution = this.evalRunItemExecutions.get(evalRunItemId);
      if (execution) {
        if (execution.claimedAt > Date.now() - 15 * 60_000) continue;
      } else if ((this.evalRunItemDeliveryDeadlines.get(evalRunItemId) ?? Number.POSITIVE_INFINITY) > Date.now()) {
        continue;
      }
      stale.push({
        projectId: run.projectId,
        evalRunId: run.id,
        evalRunItemId,
        executionToken: execution?.executionToken ?? null,
        providerCallStarted: execution?.providerCallStarted ?? false,
        providerCallReturned: execution?.providerCallReturned ?? false
      });
    }
    return stale;
  }

  async getEvalRunItem(projectId: string, evalRunId: string, evalRunItemId: string): Promise<EvalRunItem | null> {
    const run = this.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run) return null;
    const item = this.evalRunItems.find(
      (candidate) => candidate.id === evalRunItemId && candidate.evalRunId === evalRunId
    );
    return item ? { ...item } : null;
  }

  async completeEvalRunItem(input: CompleteEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    const run = this.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run) return { runFinished: false };
    if (run.status !== "pending" && run.status !== "running") return { runFinished: this.isRunFinished(run) };
    const item = this.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    // Retry replay of an already-terminal item: count nothing.
    if (
      !item ||
      item.status !== "pending" ||
      (input.executionToken !== undefined && this.evalRunItemExecutions.get(item.id)?.executionToken !== input.executionToken)
    ) return { runFinished: this.isRunFinished(run) };
    const runBefore = structuredClone(run);
    const itemBefore = structuredClone(item);
    try {
      item.status = "completed";
      item.verdictId = input.verdictId;
      item.resultLabel = input.resultLabel;
      item.agreement = item.expectedLabel ? input.resultLabel === item.expectedLabel : null;
      item.failingStep = input.failingStep ?? null;
      item.stepAgreement = item.expectedFailStep !== null && item.failingStep !== null
        ? item.failingStep === item.expectedFailStep
        : null;
      item.latencyMs = input.latencyMs ?? null;
      item.inputTokens = input.inputTokens ?? null;
      item.outputTokens = input.outputTokens ?? null;
      item.providerMetadata = input.providerMetadata ?? null;
      item.finishedAt = new Date().toISOString();
      this.evalRunItemExecutions.delete(item.id);
      run.completedItems += 1;
      if (item.agreement === true) run.agreedItems += 1;
      const runFinished = this.maybeFinishRun(run);
      if (runFinished && run.trigger === "release_evidence") {
        await this.mintDemoRootArtifact(run, "terminal_mint");
      }
      this.evalRunItemDeliveryDeadlines.delete(item.id);
      return { runFinished };
    } catch (error) {
      Object.assign(run, runBefore);
      Object.assign(item, itemBefore);
      throw error;
    }
  }

  async failEvalRunItem(input: FailEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    const run = this.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run) return { runFinished: false };
    if (run.status !== "pending" && run.status !== "running") return { runFinished: this.isRunFinished(run) };
    const item = this.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    if (
      !item ||
      item.status !== "pending" ||
      (input.executionToken !== undefined && this.evalRunItemExecutions.get(item.id)?.executionToken !== input.executionToken)
    ) return { runFinished: this.isRunFinished(run) };
    const runBefore = structuredClone(run);
    const itemBefore = structuredClone(item);
    try {
      item.status = "failed";
      item.error = input.error;
      item.finishedAt = new Date().toISOString();
      this.evalRunItemExecutions.delete(item.id);
      run.failedItems += 1;
      // Surface the FIRST item error at run level — the poll signal clients
      // read (issue #152).
      if (run.error === null) run.error = input.error;
      const runFinished = this.maybeFinishRun(run);
      if (runFinished && run.trigger === "release_evidence") {
        await this.mintDemoRootArtifact(run, "terminal_mint");
      }
      this.evalRunItemDeliveryDeadlines.delete(item.id);
      return { runFinished };
    } catch (error) {
      Object.assign(run, runBefore);
      Object.assign(item, itemBefore);
      throw error;
    }
  }

  async getEvalRun(projectId: string, evalRunId: string): Promise<EvalRun | null> {
    const run = this.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    return run ? { ...run } : null;
  }

  async getEvalRunDetail(projectId: string, evalRunId: string): Promise<EvalRunDetail | null> {
    const run = await this.getEvalRun(projectId, evalRunId);
    if (!run) return null;
    const items = this.evalRunItems
      .filter((item) => item.evalRunId === evalRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { ...run, items, spend: computeEvalRunSpend(items) };
  }

  async listEvalRuns(
    projectId: string,
    opts?: { limit?: number | undefined; skillVersionId?: string | undefined }
  ): Promise<EvalRun[]> {
    return this.evalRuns
      .filter((run) => run.projectId === projectId)
      .filter((run) => !opts?.skillVersionId || run.skillVersionId === opts.skillVersionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, opts?.limit ?? 50)
      .map((run) => ({ ...run }));
  }

  async getOrFreezeAssessmentReceipt(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact | null> {
    const run = this.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run) return null;
    return this.mintDemoRootArtifact(run, "historical_freeze");
  }

  async getAssessmentReceiptArtifactByReceiptId(
    projectId: string,
    receiptId: string
  ): Promise<AssessmentReceiptArtifact | null> {
    const artifact = this.assessmentReceiptArtifacts.find(
      (candidate) => candidate.projectId === projectId && candidate.receiptId === receiptId
    );
    return artifact ? this.cloneAssessmentReceiptArtifact(artifact) : null;
  }

  async listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]> {
    return this.assessmentReceiptArtifacts
      .filter((artifact) => artifact.projectId === projectId && artifact.evalRunId === evalRunId)
      .sort((left, right) => left.artifactRevision - right.artifactRevision)
      .map((artifact) => this.cloneAssessmentReceiptArtifact(artifact));
  }

  async compareAssessmentReceiptCopy(input: CompareAssessmentReceiptCopyInput): Promise<AssessmentReceiptComparison> {
    const root = await this.getOrFreezeAssessmentReceipt(input.projectId, input.evalRunId);
    if (!root) throw new AssessmentReceiptUnavailableError("missing_source", "Eval run not found");
    let consumerReceipt: AssessmentReceipt;
    try {
      consumerReceipt = parseCanonicalReceiptBytes(input.consumerCanonicalBytes);
    } catch (error) {
      throw new AssessmentReceiptIntegrityError(error instanceof Error ? error.message : String(error));
    }
    const rootReceipt = parseCanonicalReceiptBytes(root.canonicalBytes);
    if (
      consumerReceipt.projectId !== input.projectId ||
      consumerReceipt.evalRunId !== input.evalRunId ||
      consumerReceipt.receiptId !== rootReceipt.receiptId
    ) {
      throw new AssessmentReceiptIntegrityError("Consumer receipt identity does not match the persisted root assessment");
    }
    const consumerArtifactDigest = receiptArtifactDigest(input.consumerCanonicalBytes);
    const existing = this.assessmentReceiptComparisons.find(
      (comparison) => comparison.artifactId === root.id && comparison.consumerArtifactDigest === consumerArtifactDigest
    );
    if (existing) return this.cloneAssessmentReceiptComparison(existing);
    const comparison: AssessmentReceiptComparison = {
      id: `rcomp_${randomUUID()}`,
      projectId: input.projectId,
      evalRunId: input.evalRunId,
      artifactId: root.id,
      consumerReceiptId: consumerReceipt.receiptId,
      consumerCanonicalBytes: Buffer.from(input.consumerCanonicalBytes),
      consumerArtifactDigest,
      comparisonStatus: input.consumerCanonicalBytes.equals(root.canonicalBytes) ? "match" : "diverged",
      createdAt: new Date().toISOString()
    };
    this.assessmentReceiptComparisons.push(comparison);
    return this.cloneAssessmentReceiptComparison(comparison);
  }

  async createAssessmentReceiptCorrection(
    input: CreateAssessmentReceiptCorrectionInput
  ): Promise<AssessmentReceiptArtifact> {
    const reason = input.reason.trim();
    if (!reason) throw new AssessmentReceiptIntegrityError("Assessment receipt correction reason is required");
    const root = await this.getOrFreezeAssessmentReceipt(input.projectId, input.evalRunId);
    if (!root) throw new AssessmentReceiptUnavailableError("missing_source", "Eval run not found");
    let receipt: AssessmentReceipt;
    let canonicalBytes: Buffer;
    try {
      canonicalBytes = canonicalReceiptBytes(input.receipt);
      receipt = parseCanonicalReceiptBytes(canonicalBytes);
    } catch (error) {
      throw new AssessmentReceiptIntegrityError(error instanceof Error ? error.message : String(error));
    }
    if (receipt.projectId !== input.projectId || receipt.evalRunId !== input.evalRunId) {
      throw new AssessmentReceiptIntegrityError("Correction receipt identity does not match its assessment");
    }
    const existingReceipt = this.assessmentReceiptArtifacts.find(
      (artifact) => artifact.projectId === input.projectId && artifact.receiptId === receipt.receiptId
    );
    if (existingReceipt) {
      if (
        existingReceipt.sourceKind === "correction" &&
        existingReceipt.evalRunId === input.evalRunId &&
        existingReceipt.canonicalBytes.equals(canonicalBytes)
      ) {
        return this.cloneAssessmentReceiptArtifact(existingReceipt);
      }
      throw new AssessmentReceiptIntegrityError("Correction receiptId is already in use");
    }
    const rootReceipt = parseCanonicalReceiptBytes(root.canonicalBytes);
    if (
      receipt.schemaVersion !== rootReceipt.schemaVersion ||
      receipt.skillId !== rootReceipt.skillId ||
      receipt.skillVersionId !== rootReceipt.skillVersionId
    ) {
      throw new AssessmentReceiptIntegrityError("Correction cannot change the receipt contract or evaluator identity");
    }
    const lineage = this.assessmentReceiptArtifacts
      .filter((artifact) => artifact.projectId === input.projectId && artifact.evalRunId === input.evalRunId)
      .sort((left, right) => left.artifactRevision - right.artifactRevision);
    const predecessor = lineage.at(-1)!;
    const artifactRevision = predecessor.artifactRevision + 1;
    const artifactDigest = receiptArtifactDigest(canonicalBytes);
    const correction: AssessmentReceiptArtifact = {
      id: `rart_${input.evalRunId}_v1_r${artifactRevision}`,
      projectId: input.projectId,
      evalRunId: input.evalRunId,
      receiptId: receipt.receiptId,
      contractVersion: 1,
      artifactRevision,
      canonicalBytes,
      artifactDigest,
      evidenceDigest: receipt.evidenceDigest,
      sourceSnapshotDigest: artifactDigest,
      sourceKind: "correction",
      predecessorArtifactId: predecessor.id,
      correctionReason: reason,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: new Date().toISOString()
    };
    this.assessmentReceiptArtifacts.push(correction);
    return this.cloneAssessmentReceiptArtifact(correction);
  }

  async deleteUndispatchedEvalRun(projectId: string, evalRunId: string): Promise<void> {
    const index = this.evalRuns.findIndex((run) => run.id === evalRunId && run.projectId === projectId);
    if (index === -1) return;
    const run = this.evalRuns[index]!;
    // Guarded: once anything judged or failed, the run stays (append-only).
    if (run.status !== "pending" || run.completedItems > 0 || run.failedItems > 0) return;
    this.evalRuns.splice(index, 1);
    for (let i = this.evalRunItems.length - 1; i >= 0; i--) {
      if (this.evalRunItems[i]!.evalRunId === evalRunId) this.evalRunItems.splice(i, 1);
    }
  }

  async createRunComparison(input: CreateRunComparisonInputDb): Promise<RunComparison> {
    if (input.datasetRevisionId) {
      const revision = this.datasetRevisions.find((candidate) =>
        candidate.id === input.datasetRevisionId &&
        candidate.projectId === input.projectId &&
        candidate.sourceDatasetId === input.datasetId
      );
      const runA = this.evalRuns.find((candidate) => candidate.id === input.runAId && candidate.projectId === input.projectId);
      const runB = this.evalRuns.find((candidate) => candidate.id === input.runBId && candidate.projectId === input.projectId);
      if (!revision || runA?.datasetRevisionId !== revision.id || runB?.datasetRevisionId !== revision.id) {
        throw new DatasetRevisionConflictError(
          "Run comparison revision must match its dataset and both eval runs"
        );
      }
    }
    const comparison: RunComparison = {
      id: `rcmp_${randomUUID()}`,
      projectId: input.projectId,
      datasetId: input.datasetId,
      datasetRevisionId: input.datasetRevisionId ?? null,
      versionAId: input.versionAId,
      versionBId: input.versionBId,
      runAId: input.runAId,
      runBId: input.runBId,
      createdAt: new Date().toISOString()
    };
    this.runComparisons.push(comparison);
    return { ...comparison };
  }

  async getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null> {
    const comparison = this.runComparisons.find(
      (candidate) => candidate.id === runComparisonId && candidate.projectId === projectId
    );
    return comparison ? { ...comparison } : null;
  }

  async listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]> {
    return this.runComparisons
      .filter((comparison) => comparison.projectId === projectId)
      // id desc tiebreaker mirrors the PG repository: same-millisecond rows
      // still list in a stable order.
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      )
      .slice(0, opts?.limit ?? 50)
      .map((comparison) => ({ ...comparison }));
  }

  // --- Product deploy gate ---------------------------------------------------

  private readonly gateChecks: Array<{
    id: string;
    projectId: string;
    skillVersionId: string;
    evalRunId: string;
    label: string | null;
    metadata: Record<string, unknown>;
    maxDisagreements: number;
    createdAt: string;
    items: Array<{
      id: string;
      goldenEntryId: string;
      goldenCaseId: string;
      caseKey: string;
      candidateCaseId: string;
      expectedLabel: "pass" | "fail";
      createdAt: string;
    }>;
  }> = [];

  async getGoldenSetTraces(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<Map<string, Trace>> {
    const traces = new Map<string, Trace>();
    for (const entry of await this.listGoldenSet(projectId, criterionVersionId)) {
      // Imported (promoted) cases first; built-in fixture golden cases get the
      // same synthesized traces the judge context uses.
      const trace = this.traces.get(entry.caseId) ?? this.syntheticTraceForBuiltinCase(entry.caseId);
      if (trace) traces.set(entry.caseId, trace);
    }
    return traces;
  }

  async createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail> {
    const createdAt = new Date().toISOString();
    this.gateChecks.unshift({
      id: `gate_${randomUUID()}`,
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      evalRunId: input.evalRunId,
      label: input.label ?? null,
      metadata: input.metadata ?? {},
      maxDisagreements: input.maxDisagreements,
      createdAt,
      items: input.items.map((item) => ({ id: `gati_${randomUUID()}`, ...item, createdAt }))
    });
    const detail = await this.getGateCheckDetail(input.projectId, this.gateChecks[0]!.id);
    if (!detail) throw new Error(`Gate check vanished after create: ${this.gateChecks[0]!.id}`);
    return detail;
  }

  async getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null> {
    const stored = this.gateChecks.find((candidate) => candidate.id === gateCheckId && candidate.projectId === projectId);
    if (!stored) return null;
    const run = await this.getEvalRunDetail(projectId, stored.evalRunId);
    if (!run) return null;
    const items: GateCheckItem[] = stored.items.map((item) => {
      const evalItem = run.items.find((candidate) => candidate.caseId === item.candidateCaseId);
      return {
        id: item.id,
        gateCheckId: stored.id,
        goldenEntryId: item.goldenEntryId,
        goldenCaseId: item.goldenCaseId,
        caseKey: item.caseKey,
        candidateCaseId: item.candidateCaseId,
        expectedLabel: item.expectedLabel,
        status: evalItem?.status === "completed" ? "completed" : evalItem?.status === "failed" ? "failed" : "pending",
        judgedLabel: evalItem?.resultLabel ?? null,
        agreement: evalItem?.agreement ?? null,
        cached: evalItem?.cached ?? false,
        error: evalItem?.error ?? null,
        createdAt: item.createdAt
      };
    });
    return { ...this.projectGateCheck(stored, run), items };
  }

  async listGateChecks(projectId: string, opts?: { limit?: number | undefined }): Promise<GateCheck[]> {
    const checks: GateCheck[] = [];
    for (const stored of this.gateChecks) {
      if (stored.projectId !== projectId) continue;
      const run = await this.getEvalRun(projectId, stored.evalRunId);
      if (!run) continue;
      checks.push(this.projectGateCheck(stored, run));
    }
    return checks
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, opts?.limit ?? 50);
  }

  private projectGateCheck(
    stored: (typeof this.gateChecks)[number],
    run: EvalRun
  ): GateCheck {
    const decision = deriveGateCheckDecision({
      runStatus: run.status,
      totalItems: run.totalItems,
      completedItems: run.completedItems,
      failedItems: run.failedItems,
      agreedItems: run.agreedItems,
      maxDisagreements: stored.maxDisagreements
    });
    return {
      id: stored.id,
      projectId: stored.projectId,
      skillVersionId: stored.skillVersionId,
      evalRunId: stored.evalRunId,
      label: stored.label,
      metadata: stored.metadata,
      maxDisagreements: stored.maxDisagreements,
      status: decision.status,
      totalCandidates: run.totalItems,
      judgedCandidates: run.completedItems,
      erroredCandidates: run.failedItems,
      disagreements: decision.disagreements,
      createdAt: stored.createdAt,
      finishedAt: run.finishedAt
    };
  }

  private isRunFinished(run: EvalRun): boolean {
    return run.status === "completed" || run.status === "failed" || run.status === "canceled";
  }

  // A partially judged run is terminal "completed" while failedItems and the
  // surfaced error keep its evidence explicitly incomplete. If nothing was
  // judged, the run itself is failed.
  private maybeFinishRun(run: EvalRun): boolean {
    if (run.completedItems + run.failedItems >= run.totalItems) {
      run.status = run.completedItems === 0 && run.failedItems > 0 ? "failed" : "completed";
      run.finishedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  private traceIdForCase(caseId: string): string {
    const imported = this.traces.get(caseId);
    if (imported) return imported.id;
    const exception = demoExceptions.find((candidate) => candidate.id === caseId);
    if (exception) return exception.traceId;
    const golden = demoGoldenSet.find((entry) => entry.caseId === caseId);
    if (golden) return golden.traceId;
    // caseExistsForProject guards every caller, so this is unreachable.
    throw new CaseNotFoundError(caseId);
  }

  async listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]> {
    return this.verdicts
      .filter((verdict) => verdict.projectId === input.projectId)
      .filter((verdict) => !input.caseId || verdict.caseId === input.caseId)
      .filter((verdict) => !input.source || verdict.source === input.source)
      .filter((verdict) => !input.skillVersionId || verdict.skillVersionId === input.skillVersionId)
      .filter((verdict) => {
        if (!input.criterionId) return true;
        if (!verdict.skillVersionId) return false;
        const criterionVersionId = this.skillVersionCriteria.get(verdict.skillVersionId);
        return this.criterionVersions.some((version) =>
          version.id === criterionVersionId &&
          version.projectId === input.projectId &&
          version.criterionId === input.criterionId
        );
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit)
      .map((verdict) => {
        const actorName = verdict.actorName ?? (
          verdict.actorUserId ? DEMO_ACTOR_NAMES.get(verdict.actorUserId) : undefined
        );
        return actorName ? { ...verdict, actorName } : verdict;
      });
  }

  async getProjectKappaSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<KappaSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    return computeKappaSummary(verdicts);
  }

  async getProjectJudgeHumanCalibration(
    projectId: string,
    criterionVersionId?: string | undefined,
    skillVersionId?: string | undefined
  ): Promise<KappaSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    return computeJudgeHumanCalibration(verdicts.filter((verdict) =>
      !skillVersionId || verdict.source !== "llm_judge" || verdict.skillVersionId === skillVersionId
    ));
  }

  async getDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<DisagreementSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    const summary = computeDisagreementSummary(verdicts);
    attachDemoActorNames(summary.cases.map((entry) => entry.labels));
    return summary;
  }

  async getJudgeHumanDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<JudgeHumanDisagreementSummary> {
    const verdicts = await this.verdictsForCriterion(projectId, criterionVersionId);
    const summary = computeJudgeHumanDisagreement(verdicts);
    attachDemoActorNames(summary.cases.map((entry) => entry.humanLabels));
    return summary;
  }

  async getConvergenceAudit(
    projectId: string,
    skillId: string,
    versionId: string,
    input: ConvergenceAuditPageInput = {}
  ): Promise<ConvergenceAuditPage> {
    // The predecessor = the version created immediately before this one. The
    // list is newest-first, so it's the next entry after this version's index.
    const criterionVersionId = this.skillVersionCriteria.get(versionId);
    const versions = (await this.listSkillVersions(projectId, skillId, 1000)).filter((version) =>
      criterionVersionId !== undefined && this.skillVersionCriteria.get(version.id) === criterionVersionId
    );
    const idx = versions.findIndex((v) => v.id === versionId);
    const beforeVersionId = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1]!.id : null;
    const scopedVerdicts = criterionVersionId
      ? this.verdicts.filter((verdict) =>
          verdict.projectId === projectId && (
            (verdict.source === "llm_judge" && (
              verdict.skillVersionId === versionId || verdict.skillVersionId === beforeVersionId
            )) || (
              verdict.source === "adjudicated" &&
              verdict.skillVersionId !== null &&
              this.skillVersionCriteria.get(verdict.skillVersionId) === criterionVersionId
            )
          )
        )
      : [];
    const cursor = decodeConvergenceCursor(input.cursor ?? null);
    if (cursor && (
      cursor.versionId !== versionId ||
      cursor.criterionVersionId !== criterionVersionId ||
      cursor.beforeVersionId !== beforeVersionId
    )) {
      throw new InvalidConvergenceCursorError();
    }
    const latestAtSnapshot = cursor
      ? { createdAt: cursor.snapshotCreatedAt, id: cursor.snapshotId }
      : [...scopedVerdicts].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
        )[0] ?? null;
    const verdicts = cursor
      ? scopedVerdicts.filter((verdict) =>
          verdict.createdAt < cursor.snapshotCreatedAt || (
            verdict.createdAt === cursor.snapshotCreatedAt && verdict.id <= cursor.snapshotId
          )
        )
      : scopedVerdicts;
    const completeAudit = computeConvergenceAudit(verdicts, { beforeVersionId, afterVersionId: versionId });
    const limit = convergencePageLimit(input.limit);
    const rank = convergenceChangeRank;
    const afterCursor = cursor
      ? completeAudit.cases.filter((entry) => {
          const entryRank = rank(entry.change);
          return entryRank > cursor.rank || (entryRank === cursor.rank && entry.caseId > cursor.caseId);
        })
      : completeAudit.cases;
    const pageCases = afterCursor.slice(0, limit);
    const hasMore = afterCursor.length > limit;
    const last = pageCases.at(-1) ?? null;
    const covered = new Set(completeAudit.cases.map((entry) => entry.caseId));
    const nextUncoveredCaseId = verdicts
      .filter((verdict) =>
        verdict.source === "adjudicated" &&
        verdict.payload.kind !== "scalar" &&
        !covered.has(verdict.caseId)
      )
      .map((verdict) => verdict.caseId)
      .sort()[0] ?? null;
    return {
      audit: { ...completeAudit, cases: pageCases },
      nextCursor: hasMore && last && latestAtSnapshot
        ? encodeConvergenceCursor({
            versionId,
            criterionVersionId: criterionVersionId!,
            beforeVersionId,
            snapshotCreatedAt: latestAtSnapshot.createdAt,
            snapshotId: latestAtSnapshot.id,
            rank: rank(last.change),
            caseId: last.caseId
          })
        : null,
      nextUncoveredCaseId
    };
  }

  private async verdictsForCriterion(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<VerdictRecord[]> {
    const resolved = await this.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    return this.verdicts.filter((verdict) =>
      verdict.projectId === projectId &&
      verdict.skillVersionId !== null &&
      this.skillVersionCriteria.get(verdict.skillVersionId) === resolved
    );
  }

  async getSelfConsistencyReport(projectId: string, versionId: string): Promise<SelfConsistencyReport> {
    const verdicts = this.verdicts.filter((verdict) => verdict.projectId === projectId);
    return computeSelfConsistency(verdicts, versionId);
  }

  async listAuditEntries(): Promise<JudgeCardAuditEntry[]> {
    // Demo mode records no audit_logs rows; the Judge Card's basis note says so.
    return [];
  }

  async createReviewQueue(input: CreateReviewQueueInputDb): Promise<ReviewQueue> {
    const criterionVersionId = await this.resolveReviewCriterionVersion(
      input.projectId,
      input.criterionVersionId
    );
    // Reject case IDs that don't belong to this project. DemoRepo's tenancy
    // model: all cases live in the demo project; PG enforces via FK.
    for (const caseId of input.caseIds) {
      if (!(await this.caseExistsForProject(input.projectId, caseId))) {
        throw new Error(`Case not found in project: ${caseId}`);
      }
    }
    const id = `revq_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.reviewQueues.push({
      id,
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      status: "open",
      createdByUserId: input.createdByUserId ?? null,
      createdAt,
      closedAt: null
    });
    const seen = new Set<string>();
    let position = 0;
    for (const caseId of input.caseIds) {
      if (seen.has(caseId)) continue; // dedup within a single create call
      seen.add(caseId);
      this.reviewQueueItems.push({
        id: `revqi_${randomUUID()}`,
        queueId: id,
        caseId,
        criterionVersionId,
        status: "pending",
        position,
        assignedToUserId: null,
        createdAt,
        completedAt: null
      });
      position += 1;
    }
    return this.toReviewQueue(this.reviewQueues[this.reviewQueues.length - 1]!);
  }

  async addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]> {
    const queue = this.reviewQueues.find((q) => q.id === input.queueId && q.projectId === input.projectId);
    if (!queue) throw new Error(`Review queue not found: ${input.queueId}`);
    // Validate every case before any insert — same shape as createReviewQueue.
    for (const item of input.items) {
      if (!(await this.caseExistsForProject(input.projectId, item.caseId))) {
        throw new Error(`Case not found in project: ${item.caseId}`);
      }
    }
    const resolvedItems = await Promise.all(input.items.map(async (item) => ({
      ...item,
      criterionVersionId: await this.resolveReviewCriterionVersion(
        input.projectId,
        item.criterionVersionId
      )
    })));
    // Position continues where the existing items end so new rows append in
    // FIFO order.
    let position = this.reviewQueueItems.filter((existing) => existing.queueId === input.queueId).length;
    const createdAt = new Date().toISOString();
    const added: ReviewQueueItem[] = [];
    const seen = new Set<string>();
    for (const item of resolvedItems) {
      const dedupKey = `${item.caseId}__${item.criterionVersionId}__${item.assignedToUserId ?? ""}`;
      // Within this call: dedup on (case, criterion, assignee) — the same tuple twice is
      // pointless. Across calls: the unique index on PG enforces the same.
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      // Also dedup against existing items in the queue with the same pair.
      const alreadyExists = this.reviewQueueItems.some(
        (existing) =>
          existing.queueId === input.queueId &&
          existing.caseId === item.caseId &&
          existing.criterionVersionId === item.criterionVersionId &&
          (existing.assignedToUserId ?? "") === (item.assignedToUserId ?? "")
      );
      if (alreadyExists) continue;
      const row: ReviewQueueItem = {
        id: `revqi_${randomUUID()}`,
        queueId: input.queueId,
        caseId: item.caseId,
        criterionVersionId: item.criterionVersionId,
        status: "pending",
        position,
        assignedToUserId: item.assignedToUserId ?? null,
        createdAt,
        completedAt: null
      };
      this.reviewQueueItems.push(row);
      added.push(row);
      position += 1;
    }
    return added;
  }

  async listReviewQueues(projectId: string, opts?: { status?: ReviewQueueStatus | undefined }): Promise<ReviewQueue[]> {
    return this.reviewQueues
      .filter((q) => q.projectId === projectId)
      .filter((q) => !opts?.status || q.status === opts.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((q) => this.toReviewQueue(q));
  }

  async getReviewQueueDetail(projectId: string, queueId: string): Promise<ReviewQueueDetail | null> {
    const row = this.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!row) return null;
    return {
      queue: this.toReviewQueue(row),
      items: this.reviewQueueItems
        .filter((item) => item.queueId === queueId)
        .sort((left, right) => left.position - right.position)
    };
  }

  async getNextPendingQueueItem(projectId: string, queueId: string, opts?: {
    assignedToUserId?: string | undefined;
    criterionVersionId?: string | undefined;
  }): Promise<ReviewQueueItem | null> {
    const queue = this.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue || queue.status !== "open") return null;
    const pending = this.reviewQueueItems.filter((item) => item.queueId === queueId && item.status === "pending");
    const criterionVersions = new Set(pending.map((item) => item.criterionVersionId));
    if (!opts?.criterionVersionId && criterionVersions.size > 1) {
      throw new AmbiguousProjectSkillError(projectId, Math.max(2, criterionVersions.size));
    }
    if (opts?.criterionVersionId) {
      await this.resolveReviewCriterionVersion(projectId, opts.criterionVersionId);
    }
    return pending
      .filter((item) => !opts?.criterionVersionId || item.criterionVersionId === opts.criterionVersionId)
      .filter((item) => {
        // No assignee filter → return any pending item (unassigned or
        // assigned). With a filter → match either: (a) explicitly assigned to
        // this reviewer, or (b) unassigned (anyone can pull).
        if (!opts?.assignedToUserId) return true;
        return item.assignedToUserId === opts.assignedToUserId || item.assignedToUserId === null;
      })
      .sort((left, right) => left.position - right.position)[0] ?? null;
  }

  private async resolveReviewCriterionVersion(
    projectId: string,
    requested?: string | undefined
  ): Promise<string> {
    if (requested) {
      const criterionVersion = this.criterionVersions.find((candidate) =>
        candidate.projectId === projectId && candidate.id === requested
      );
      const hasEvaluator = [...this.skillVersionCriteria.values()].includes(requested);
      if (!criterionVersion || !hasEvaluator) {
        throw new DatasetRevisionConflictError(
          `Criterion version is not bound to an evaluator in this project: ${requested}`
        );
      }
      return requested;
    }
    const current = await this.getCurrentSkill(projectId);
    const criterionVersionId = this.skillVersionCriteria.get(current.currentVersion.id);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Current evaluator has no immutable criterion version binding");
    }
    return criterionVersionId;
  }

  private async resolveGoldenCriterionVersion(
    projectId: string,
    requested?: string | undefined
  ): Promise<string> {
    if (requested) {
      const exists = this.criterionVersions.some((candidate) =>
        candidate.projectId === projectId && candidate.id === requested
      );
      if (!exists) {
        throw new DatasetRevisionConflictError(
          `Criterion version does not belong to this project: ${requested}`
        );
      }
      return requested;
    }
    const current = await this.getCurrentSkill(projectId);
    const criterionVersionId = this.skillVersionCriteria.get(current.currentVersion.id);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Current evaluator has no immutable criterion version binding");
    }
    return criterionVersionId;
  }

  async closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const queue = this.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue) return null;
    if (queue.status !== "closed") {
      queue.status = "closed";
      queue.closedAt = new Date().toISOString();
    }
    return this.toReviewQueue(queue);
  }

  async reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const queue = this.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue) return null;
    if (queue.status !== "open") {
      queue.status = "open";
      queue.closedAt = null;
    }
    return this.toReviewQueue(queue);
  }

  private toReviewQueue(row: {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    status: ReviewQueueStatus;
    createdByUserId: string | null;
    createdAt: string;
    closedAt: string | null;
  }): ReviewQueue {
    let pendingCount = 0;
    let completedCount = 0;
    for (const item of this.reviewQueueItems) {
      if (item.queueId !== row.id) continue;
      if (item.status === "pending") pendingCount += 1;
      else completedCount += 1;
    }
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      status: row.status,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      pendingCount,
      completedCount
    };
  }

  async listCases(projectId: string, opts: ListCasesOptions = {}): Promise<CaseListEntry[]> {
    // DemoRepo tenancy: imported traces live in the demo project. Built-in
    // fixture cases (exceptions/golden) are session-demo scaffolding without
    // real timestamps and stay off the machine surface.
    if (projectId !== demoProject.id) return [];
    const limit = opts.limit ?? 500;
    const entries: CaseListEntry[] = [];
    for (const [caseId, trace] of this.traces.entries()) {
      if (this.isEvidenceScaffoldingCase(caseId)) continue;
      const source = this.traceSources.get(caseId);
      if (!source) continue;
      if (opts.since !== undefined && source.createdAt <= opts.since) continue;
      entries.push({
        caseId,
        sourceTraceId: source.sourceTraceId,
        createdAt: source.createdAt,
        trace: {
          input: trace.input,
          output: trace.output,
          metadata: trace.metadata ?? {},
          ...(trace.steps ? { steps: trace.steps } : {})
        }
      });
    }
    return entries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.caseId.localeCompare(b.caseId))
      .slice(0, limit);
  }

  async listCaseIdsForProject(projectId: string, limit = 10_000): Promise<string[]> {
    // DemoRepo tenancy: all cases (traces + exceptions + golden set) live in
    // the demo project. Return the union, deduped, capped at `limit`.
    // Gate candidates are excluded: the approval-time backfill must never
    // re-judge (and pay for) product-gate scaffolding.
    if (projectId !== demoProject.id) return [];
    const ids = new Set<string>();
    for (const caseId of this.traces.keys()) {
      if (!this.isEvidenceScaffoldingCase(caseId)) ids.add(caseId);
    }
    for (const exception of demoExceptions) ids.add(exception.id);
    for (const entry of demoGoldenSet) ids.add(entry.caseId);
    return [...ids].slice(0, limit);
  }

  async caseExistsForProject(projectId: string, caseId: string): Promise<boolean> {
    // DemoRepo's tenancy model: all built-in fixtures (cases, exceptions, golden
    // set) belong to the demo project. Imported cases (via importTrace) also use
    // the demo project. So a case exists "for this project" iff it exists in any
    // of these sources AND projectId is the demo project.
    if (projectId !== demoProject.id) return false;
    if (this.traces.has(caseId)) return true;
    if (demoExceptions.some((exception) => exception.id === caseId)) return true;
    if (demoGoldenSet.some((entry) => entry.caseId === caseId)) return true;
    return false;
  }

  async createFeedbackSyncJob(input: { projectId: string; judgeRunId: string; provider: FeedbackSyncProvider }): Promise<FeedbackSyncJobRecord | null> {
    const run = this.judgeRuns.find((candidate) => candidate.id === input.judgeRunId && candidate.projectId === input.projectId);
    if (!run) return null;
    const traceSource = this.traceSources.get(run.caseId);
    if (!traceSource || traceSource.source !== input.provider || !traceSource.sourceIntegrationId) return null;
    const integration = input.provider === "langfuse"
      ? this.langfuseIntegrations.get(traceSource.sourceIntegrationId)
      : input.provider === "ironside"
        ? this.ironsideIntegrations.get(traceSource.sourceIntegrationId)
        : this.langSmithIntegrations.get(traceSource.sourceIntegrationId);
    if (!integration) return null;
    const key = `${input.projectId}:${input.provider}:${input.judgeRunId}`;
    const existingJobId = this.feedbackJobRunIds.get(key);
    if (existingJobId) {
      const existing = this.feedbackJobs.get(existingJobId);
      return existing && existing.status !== "synced"
        ? { id: existing.id, projectId: input.projectId, judgeRunId: input.judgeRunId, provider: input.provider, status: existing.status }
        : null;
    }
    const id = `fsync_${randomUUID()}`;
    this.feedbackJobs.set(id, {
      id,
      projectId: input.projectId,
      provider: input.provider,
      judgeRun: { ...run, modelBinding: demoSkill.currentVersion.modelBinding },
      sourceTraceId: traceSource.sourceTraceId,
      integration,
      status: "pending"
    });
    this.feedbackJobRunIds.set(key, id);
    return { id, projectId: input.projectId, judgeRunId: input.judgeRunId, provider: input.provider, status: "pending" };
  }

  async loadFeedbackSyncContext(job: FeedbackSyncJob): Promise<FeedbackSyncContext> {
    const context = this.feedbackJobs.get(job.feedbackSyncJobId);
    if (!context || context.projectId !== job.projectId) throw new FeedbackSyncJobNotFoundError(job.feedbackSyncJobId);
    return context;
  }

  async listFeedbackSyncJobs(input: ListFeedbackSyncJobsInput): Promise<FeedbackSyncJobListItem[]> {
    return [...this.feedbackJobs.values()]
      .filter((job) => job.projectId === input.projectId && (!input.status || job.status === input.status))
      .slice(0, input.limit)
      .map((job) => ({
        id: job.id,
        projectId: job.projectId,
        judgeRunId: job.judgeRun.id,
        provider: job.provider,
        status: job.status,
        attempts: this.feedbackJobAttempts.get(job.id) ?? 0,
        lastError: this.feedbackJobLastError.get(job.id) ?? null,
        createdAt: new Date().toISOString()
      }));
  }

  async markFeedbackSyncSucceeded(job: FeedbackSyncJob): Promise<void> {
    const context = await this.loadFeedbackSyncContext(job);
    this.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "synced" });
  }

  async markFeedbackSyncFailed(job: FeedbackSyncJob, error: unknown): Promise<void> {
    const context = await this.loadFeedbackSyncContext(job);
    this.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "failed" });
    // PG parity (C7): failures increment attempts and record the error.
    this.feedbackJobAttempts.set(job.feedbackSyncJobId, (this.feedbackJobAttempts.get(job.feedbackSyncJobId) ?? 0) + 1);
    this.feedbackJobLastError.set(job.feedbackSyncJobId, error instanceof Error ? error.message : String(error));
  }

  async createSkillVersion(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    const version = await this.createSkillVersionPending(skillId, input, context);
    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(`Skill version ${version.id} has no immutable regression dataset binding.`);
    }
    return this.runRegressionGateForVersion({
      projectId: demoProject.id,
      skillVersionId: version.id,
      datasetRevisionId,
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
      ...(context.actorUserId ? { actorUserId: context.actorUserId } : {}),
      timeScope: input.timeScope
    });
  }

  async createSkillVersionPending(skillId: string, input: CreateSkillVersionInput, _context: CreateSkillVersionContext): Promise<SkillVersion> {
    const evaluatorBinding = [...this.criterionSkills.entries()].find(([, skill]) =>
      skill.projectId === demoProject.id && skill.id === skillId
    );
    if (!evaluatorBinding) throw new NoCurrentSkillError(demoProject.id);
    const [criterionId, evaluator] = evaluatorBinding;
    const definitionCount = this.criterionVersions.filter((candidate) =>
      candidate.projectId === demoProject.id && candidate.criterionId === criterionId
    ).length;
    if (!input.criterionVersionId && definitionCount > 1) {
      throw new DatasetRevisionConflictError(
        "Criteria with multiple immutable definitions require an explicit criterionVersionId when creating an evaluator version."
      );
    }
    const criterionVersion = input.criterionVersionId
      ? this.criterionVersions.find((candidate) =>
          candidate.projectId === demoProject.id &&
          candidate.criterionId === criterionId &&
          candidate.id === input.criterionVersionId
        )
      : this.criterionVersions
          .filter((candidate) => candidate.projectId === demoProject.id && candidate.criterionId === criterionId)
          .sort((left, right) => right.revision - left.revision)[0];
    if (!criterionVersion) {
      throw new DatasetRevisionConflictError(
        `Skill ${skillId} does not own criterion version ${input.criterionVersionId ?? "(latest)"}.`
      );
    }
    const createdAt = new Date().toISOString();
    const regressionRevision = await this.getOrCreateRegressionDatasetRevision(
      demoProject.id,
      _context.actorUserId,
      criterionVersion.id
    );
    const priorVersions = (this.skillVersions ?? [demoSkillPrevVersion, demoSkill.currentVersion])
      .filter((candidate) => candidate.skillId === skillId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const version: SkillVersion = {
      id: `skillv_${randomUUID()}`,
      skillId,
      criterionVersionId: criterionVersion.id,
      version: nextPatchVersion(priorVersions[0]?.version ?? evaluator.currentVersion.version),
      status: "calibrating",
      rubricMarkdown: input.rubricMarkdown,
      prompt: input.prompt,
      modelBinding: input.modelBinding,
      outputSchema: input.outputSchema ?? MinimumVerdictOutputSchema,
      goldenSetAgreement: null,
      tooStrictCount: 0,
      tooLenientCount: 0,
      ambiguousCount: 0,
      knownLimitations: [],
      verdictKind: input.verdictKind,
      scalarRange: input.verdictKind === "scalar" ? input.scalarRange ?? null : null,
      categoricalChoiceScores: input.verdictKind === "categorical" ? input.categoricalChoiceScores ?? null : null,
      rubricProvenance: _context.rubricProvenance ?? "human-authored",
      regressionDatasetRevisionId: regressionRevision.id,
      createdAt,
      approvedAt: null
    };
    // persist so listSkillVersions renders the audit trail; the gate
    // step mutates this same object in place (demo is reference-shared).
    if (this.skillVersions === null) this.skillVersions = [structuredClone(demoSkill.currentVersion)];
    this.skillVersions.push(version);
    this.skillVersionCriteria.set(version.id, criterionVersion.id);
    evaluator.isStarter = false;
    return version;
  }

  async runRegressionGateForVersion(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    if (this.skillVersions === null) this.skillVersions = [structuredClone(demoSkill.currentVersion)];
    const version = this.skillVersions.find((candidate) => candidate.id === job.skillVersionId);
    if (!version) throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
    const criterionVersionId = this.skillVersionCriteria.get(version.id);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Evaluator version has no immutable criterion version binding");
    }
    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(
        `Skill version ${version.id} has no immutable regression dataset binding`,
      );
    }
    if (job.datasetRevisionId !== datasetRevisionId) {
      throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
    }
    const revision = await this.getDatasetRevisionDetail(job.projectId, datasetRevisionId);
    if (!revision || revision.role !== "regression_golden") {
      throw new Error(`Pinned regression dataset revision is unavailable: ${datasetRevisionId}`);
    }

    // Prior-version comparison: the version immediately before the pending one.
    const priorVersionId = this.skillVersions
      .filter((candidate) =>
        candidate.skillId === version.skillId &&
        candidate.id !== version.id &&
        this.skillVersionCriteria.get(candidate.id) === criterionVersionId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]?.id;
    const previousVerdicts = previousVerdictsFromRun(
      priorVersionId ? this.regressionRuns.get(priorVersionId) ?? null : null
    );

    const goldenSet: GoldenSetEntry[] = revision.items.map((item) => {
      if (!item.referenceLabel || !item.sourceCaseId) {
        throw new DatasetRevisionConflictError(
          `Regression revision item ${item.id} has no case identity or reference label`
        );
      }
      return {
        id: item.sourceGoldenEntryId ?? item.id,
        caseId: item.sourceCaseId,
        traceId: item.sourceTraceId ?? item.sourceCaseId,
        agreedLabel: item.referenceLabel,
        reason: item.note ?? "Frozen regression case.",
        promotedBy: "Frozen regression revision",
        promotedAt: item.createdAt,
        sourceSkillVersionId: version.id,
        criterionVersionId
      };
    });
    const traces = new Map(revision.items.map((item) => {
      if (!item.sourceCaseId) {
        throw new DatasetRevisionConflictError(`Regression revision item ${item.id} has no case identity`);
      }
      return [item.sourceCaseId, {
        id: item.sourceTraceId ?? item.sourceCaseId,
        input: item.payloadSnapshot.input,
        output: item.payloadSnapshot.output,
        metadata: item.payloadSnapshot.metadata,
        ...(item.payloadSnapshot.steps ? { steps: item.payloadSnapshot.steps } : {})
      } satisfies Trace] as const;
    }));
    const computedRegression = await runGoldenSetRegression({
      skillVersion: version,
      goldenSet,
      traces,
      overrideReason: job.overrideReason,
      actorUserId: job.actorUserId,
      judgeProvider: this.judgeProvider,
      previousVerdicts
    });
    const regression: RegressionRunResult = { ...computedRegression, datasetRevisionId };

    version.status = regression.status === "blocked" ? "regressing" : "approved";
    version.goldenSetAgreement = regression.compared === 0 ? null : (regression.compared - regression.regressed) / regression.compared;
    const directions = regressionDirectionCounts(regression.cases);
    version.tooStrictCount = directions.tooStrict;
    version.tooLenientCount = directions.tooLenient;
    version.ambiguousCount = directions.ambiguous;
    version.knownLimitations = regression.regressed > 0 ? ["regressed on one or more golden-set cases"] : [];
    version.approvedAt = regression.status === "blocked" ? null : new Date().toISOString();
    this.regressionRuns.set(version.id, regression);
    this.datasetExposureEvents.push({
      id: `dse_${randomUUID()}`,
      projectId: job.projectId,
      revisionId: datasetRevisionId,
      revisionItemId: null,
      kind: "evaluator_execution",
      exposureClass: "development",
      activity: "regression_run",
      subjectKind: "evaluator_version",
      subjectId: version.id,
      actorUserId: job.actorUserId ?? null,
      evidenceRefKind: "regression_run",
      evidenceRefId: regression.id,
      reason: null,
      details: {},
      occurredAt: regression.createdAt
    });

    return { version, regressionRun: regression };
  }

  async failRegressionGateForVersion(job: GateRunJob, error: unknown): Promise<void> {
    if (this.skillVersions === null) this.skillVersions = [structuredClone(demoSkill.currentVersion)];
    const version = this.skillVersions.find((candidate) => candidate.id === job.skillVersionId);
    if (!version) throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
    // A replay after a successful or already-terminal gate must not overwrite
    // the recorded outcome or append another error run.
    if (version.status !== "calibrating") return;

    const message = gateFailureMessage(error);
    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(
        `Calibrating skill version ${version.id} has no immutable regression dataset binding.`,
      );
    }
    if (job.datasetRevisionId !== datasetRevisionId) {
      throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
    }
    version.status = "failed";
    version.goldenSetAgreement = null;
    version.tooStrictCount = 0;
    version.tooLenientCount = 0;
    version.ambiguousCount = 0;
    version.knownLimitations = [`regression gate failed: ${message}`];
    version.approvedAt = null;
    this.regressionRuns.set(version.id, {
      id: `reg_${randomUUID()}`,
      skillVersionId: version.id,
      datasetRevisionId,
      status: "error",
      compared: 0,
      regressed: 0,
      improved: 0,
      flipped: 0,
      error: message,
      goldenSetMissing: false,
      cases: [],
      createdAt: new Date().toISOString()
    });
  }

  async getRegressionRunForVersion(_projectId: string, skillVersionId: string): Promise<RegressionRunResult | null> {
    return this.regressionRuns.get(skillVersionId) ?? null;
  }

  async listRegressionRunsForVersions(_projectId: string, skillVersionIds: string[]): Promise<RegressionRunResult[]> {
    return skillVersionIds.flatMap((versionId) => {
      const run = this.regressionRuns.get(versionId);
      return run ? [run] : [];
    });
  }

  async listSkillVersions(_projectId: string, skillId: string, limit = 50): Promise<SkillVersion[]> {
    if (this.skillVersions === null) this.skillVersions = [structuredClone(demoSkill.currentVersion)];
    return [...this.skillVersions]
      .filter((version) => version.skillId === skillId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }
}

export interface JudgeRunContext {
  projectId: string;
  caseId: string;
  skillVersion: SkillVersion;
  trace: Trace;
}

export interface RecordJudgeRunInput {
  projectId: string;
  caseId: string;
  skillVersionId: string;
  verdict: Awaited<ReturnType<JudgeProvider["judge"]>>;
  rawRequest?: unknown;
  rawResponse?: unknown;
  // Wall-clock duration of the provider call (added early so eval runs have
  // latency history; cost capture follows with provider-usage plumbing).
  latencyMs?: number | undefined;
  // token usage from the provider envelope (absent when unreported).
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  providerMetadata?: {
    model: string | null;
    requestId: string | null;
    responseId: string | null;
    systemFingerprint: string | null;
  } | undefined;
}

function gateFailureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export interface TraceImportContext {
  ingestionPurpose: RuntimeIngestionPurpose;
  sourceIntegrationId?: string | undefined;
  importJobId?: string | undefined;
  normalizationVersion?: string | undefined;
  redactionConfig?: TraceRedactionConfig | undefined;
}

export const TRACE_INGESTION_PURPOSES_BY_SOURCE = {
  manual: [
    "analysis_eligible_manual",
    "judge_api",
    "judge_batch_general",
    "dataset_example",
    "trace_test_synthetic"
  ],
  langsmith: ["analysis_eligible_langsmith"],
  langfuse: ["analysis_eligible_langfuse"],
  ironside: ["analysis_eligible_ironside"],
  release_evidence: ["release_evidence"],
  gate_candidate: []
} as const satisfies Record<CaseSource, readonly RuntimeIngestionPurpose[]>;

export function assertTraceIngestionPurpose(
  source: CaseSource,
  purpose: RuntimeIngestionPurpose
): void {
  const allowed = TRACE_INGESTION_PURPOSES_BY_SOURCE[source] as readonly RuntimeIngestionPurpose[];
  if (!allowed.includes(purpose)) {
    throw new Error(`Ingestion purpose ${purpose} is not valid for case source ${source}`);
  }
}

export interface CreateImportJobInput {
  projectId: string;
  source: TraceSource;
  sourceIntegrationId?: string | undefined;
  skillVersionId?: string | undefined;
  actorUserId?: string | undefined;
  requestedLimit?: number | undefined;
}

export interface CompleteImportJobInput {
  importedCount: number;
  queuedJudgeCount: number;
}

export interface ListImportJobsInput {
  projectId: string;
  status?: ImportJobStatus | undefined;
  limit: number;
}

export interface PromoteExceptionToGoldenSetInput extends PromoteGoldenSetInput {
  projectId: string;
  caseId: string;
  actorUserId?: string | undefined;
  actorName?: string | undefined;
}

export interface RetireGoldenSetEntryInput {
  projectId: string;
  entryId: string;
  actorUserId?: string | undefined;
  reason?: string | undefined;
}

export interface LangSmithImportContext extends LangSmithIntegration {
  apiKey: string;
  limit: number;
  redactionConfig?: TraceRedactionConfig | undefined;
}

export interface ClaimLangSmithImportTargetsInput {
  now: Date;
  intervalMs: number;
  batchSize: number;
  defaultLimit: number;
}

export interface LangfuseImportContext extends LangfuseIntegration {
  publicKey: string;
  secretKey: string;
  limit: number;
  redactionConfig?: TraceRedactionConfig | undefined;
}

export interface ClaimLangfuseImportTargetsInput {
  now: Date;
  intervalMs: number;
  batchSize: number;
  defaultLimit: number;
}

export interface IronsideImportContext extends IronsideIntegration {
  apiKey: string;
  limit: number;
  redactionConfig?: TraceRedactionConfig | undefined;
  syncState: IronsideSyncState;
}

export interface ClaimIronsideImportTargetsInput {
  now: Date;
  intervalMs: number;
  batchSize: number;
  defaultLimit: number;
}

export interface LangSmithCredentials extends LangSmithIntegration {
  apiKey: string;
}

export interface LangfuseCredentials extends LangfuseIntegration {
  publicKey: string;
  secretKey: string;
}

export interface IronsideCredentials extends IronsideIntegration {
  apiKey: string;
}

export type FeedbackSyncProvider = "langsmith" | "langfuse" | "ironside";
export type FeedbackSyncStatus = "pending" | "sending" | "synced" | "failed";

export interface FeedbackSyncJobRecord {
  id: string;
  projectId: string;
  judgeRunId: string;
  provider: FeedbackSyncProvider;
  status: FeedbackSyncStatus;
}

export interface FeedbackSyncContext {
  id: string;
  projectId: string;
  provider: FeedbackSyncProvider;
  judgeRun: JudgeRun & { modelBinding: SkillVersion["modelBinding"] };
  sourceTraceId: string;
  integration: LangSmithCredentials | LangfuseCredentials | IronsideCredentials;
}

export interface ListFeedbackSyncJobsInput {
  projectId: string;
  status?: FeedbackSyncStatus | undefined;
  limit: number;
}

export interface FeedbackSyncJobListItem {
  id: string;
  projectId: string;
  judgeRunId: string;
  provider: FeedbackSyncProvider;
  status: FeedbackSyncStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

function toPublicLangSmithIntegration(integration: LangSmithImportContext): LangSmithIntegration {
  return {
    id: integration.id,
    projectId: integration.projectId,
    provider: "langsmith",
    skillVersionId: integration.skillVersionId,
    projectName: integration.projectName,
    endpointUrl: integration.endpointUrl,
    pollEnabled: integration.pollEnabled,
    pollIntervalSeconds: integration.pollIntervalSeconds,
    pollLimit: integration.pollLimit,
    lastTestedAt: integration.lastTestedAt,
    lastTestResult: integration.lastTestResult,
    createdAt: integration.createdAt
  };
}

function toPublicIronsideIntegration(integration: IronsideImportContext): IronsideIntegration {
  return {
    id: integration.id,
    projectId: integration.projectId,
    provider: "ironside",
    skillVersionId: integration.skillVersionId,
    url: integration.url,
    pollEnabled: integration.pollEnabled,
    pollIntervalSeconds: integration.pollIntervalSeconds,
    pollLimit: integration.pollLimit,
    quietPeriodSeconds: integration.quietPeriodSeconds,
    lastTestedAt: integration.lastTestedAt,
    lastTestResult: integration.lastTestResult,
    createdAt: integration.createdAt
  };
}

function toPublicLangfuseIntegration(integration: LangfuseImportContext): LangfuseIntegration {
  return {
    id: integration.id,
    projectId: integration.projectId,
    provider: "langfuse",
    skillVersionId: integration.skillVersionId,
    projectName: integration.projectName,
    endpointUrl: integration.endpointUrl,
    pollEnabled: integration.pollEnabled,
    pollIntervalSeconds: integration.pollIntervalSeconds,
    pollLimit: integration.pollLimit,
    lastTestedAt: integration.lastTestedAt,
    lastTestResult: integration.lastTestResult,
    createdAt: integration.createdAt
  };
}

export async function runGoldenSetRegression(input: {
  skillVersion: SkillVersion;
  goldenSet: GoldenSetEntry[];
  traces: Map<string, Trace>;
  overrideReason?: string | undefined;
  actorUserId?: string | undefined;
  // The golden-set regression gate only needs the binary `judge` path, so it
  // accepts any provider that implements it (a full JudgeProvider qualifies).
  judgeProvider?: BinaryJudgeProvider | undefined;
  // the previous version's verdict per golden case (caseId → label),
  // built from that version's recorded regression run. Lets us classify
  // `improve` honestly (new agrees where the prior version disagreed) and
  // count true flips (verdict changed vs the prior version). Absent for a
  // skill's first version, or for golden cases the prior run didn't cover —
  // those fall back to label-only classification (agree / regress).
  previousVerdicts?: Map<string, VerdictLabel> | undefined;
}): Promise<Omit<RegressionRunResult, "datasetRevisionId">> {
  const judgeProvider = input.judgeProvider ?? new MockJudgeProvider();
  const prompt: JudgePrompt = {
    id: input.skillVersion.id,
    name: input.skillVersion.version,
    kind: "unified",
    content: renderJudgePromptContent(input.skillVersion)
  };

  // Judge the comparable entries with bounded concurrency. Real providers
  // take seconds per call and this runs inside the version-create request —
  // fully sequential, a 20-case golden set blocks the request for minutes.
  // A provider failure aborts the gate as a typed error (the route answers
  // 502 with context); fail-fast wastes at most CONCURRENCY-1 extra calls.
  const comparable = input.goldenSet.filter((entry) => input.traces.has(entry.caseId));
  const verdicts = new Array<JudgeVerdict>(comparable.length);
  const GATE_CONCURRENCY = 4;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(GATE_CONCURRENCY, comparable.length) }, async () => {
      while (cursor < comparable.length) {
        const index = cursor++;
        const entry = comparable[index]!;
        try {
          verdicts[index] = await judgeProvider.judge({
            prompt,
            trace: input.traces.get(entry.caseId)!,
            outputSchema: input.skillVersion.outputSchema ?? DEFAULT_OUTPUT_SCHEMA
          });
        } catch (error) {
          throw new RegressionGateJudgeError(entry.caseId, error);
        }
      }
    })
  );

  let compared = 0;
  let regressed = 0;
  let improved = 0;
  let flipped = 0;
  const cases: RegressionCaseDiff[] = [];

  for (const [index, entry] of comparable.entries()) {
    compared += 1;
    const verdict = verdicts[index]!;
    const newAgrees = verdict.label === entry.agreedLabel;
    const prevLabel = input.previousVerdicts?.get(entry.caseId);
    const prevKnown = prevLabel !== undefined;
    const prevAgrees = prevKnown && prevLabel === entry.agreedLabel;

    // `regressed` (gate trigger) stays "new version disagrees with the golden
    // label" — the gate must keep blocking versions that disagree with the
    // team's truth. `improve` is reserved for cases the new version FIXED
    // relative to the prior version, so the Improved tile never fires on a
    // case that was already good.
    let change: RegressionCaseDiff["change"];
    if (!newAgrees) {
      change = "regress";
      regressed += 1;
    } else if (prevKnown && !prevAgrees) {
      change = "improve";
      improved += 1;
    } else {
      change = "agree";
    }
    if (prevKnown && verdict.label !== prevLabel) flipped += 1;

    cases.push({
      caseId: entry.caseId,
      traceId: entry.traceId,
      agreedLabel: entry.agreedLabel,
      newLabel: verdict.label,
      change,
      rationale: verdict.reason.slice(0, REGRESSION_RATIONALE_MAX_LENGTH)
    });
  }

  const overrideReason = input.overrideReason?.trim();
  const status: RegressionRunResult["status"] = regressed > 0 && !overrideReason ? "blocked" : regressed > 0 ? "overridden" : "passed";

  return {
    id: `regr_${randomUUID()}`,
    skillVersionId: input.skillVersion.id,
    status,
    compared,
    regressed,
    improved,
    flipped,
    overrideReason: overrideReason || undefined,
    goldenSetMissing: compared === 0,
    cases,
    createdAt: new Date().toISOString()
  };
}

// turn a recorded regression run into a caseId → verdict map for the
// next version's prior-comparison. null/undefined run yields an empty map
// (first version, or a version with no recorded run).
export function previousVerdictsFromRun(run: RegressionRunResult | null | undefined): Map<string, VerdictLabel> {
  const map = new Map<string, VerdictLabel>();
  if (!run) return map;
  for (const diff of run.cases) map.set(diff.caseId, diff.newLabel);
  return map;
}

export function buildGoldenSetHealthSummary(
  projectId: string,
  entries: GoldenSetEntry[],
  now: Date = new Date(),
  staleAfterDays = GOLDEN_SET_STALE_AFTER_DAYS
): GoldenSetHealthSummary {
  const entriesWithAge = entries.map((entry) => ({
    id: entry.id,
    traceId: entry.traceId,
    agreedLabel: entry.agreedLabel,
    promotedAt: entry.promotedAt,
    ageDays: ageInDays(entry.promotedAt, now),
    reason: entry.reason
  }));
  const staleEntries = entriesWithAge
    .filter((entry) => entry.ageDays >= staleAfterDays)
    .sort((left, right) => right.ageDays - left.ageDays)
    .slice(0, 5);
  const staleCount = entriesWithAge.filter((entry) => entry.ageDays >= staleAfterDays).length;
  const duplicateGroups = duplicateGoldenSetGroups(entriesWithAge);
  const duplicateCount = duplicateGroups.reduce((total, group) => total + group.entryCount - 1, 0);
  const passCount = entries.filter((entry) => entry.agreedLabel === "pass").length;
  const failCount = entries.filter((entry) => entry.agreedLabel === "fail").length;
  const promotedTimes = entries
    .map((entry) => Date.parse(entry.promotedAt))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => left - right);
  const oldestPromotedTime = promotedTimes[0];
  const newestPromotedTime = promotedTimes[promotedTimes.length - 1];
  const actionRecommendations = goldenSetHealthRecommendations({
    totalActive: entries.length,
    staleCount,
    staleAfterDays,
    duplicateCount,
    passCount,
    failCount
  });
  // Recommendations intentionally remain either action items or one healthy fallback.
  // Clients should use the structured status, not parse recommendation copy.
  const status: GoldenSetHealthSummary["status"] = actionRecommendations.length > 0 ? "needs_action" : "healthy";

  return {
    projectId,
    status,
    totalActive: entries.length,
    staleAfterDays,
    staleCount,
    freshCount: entriesWithAge.filter((entry) => entry.ageDays < staleAfterDays).length,
    passCount,
    failCount,
    oldestPromotedAt: oldestPromotedTime === undefined ? null : new Date(oldestPromotedTime).toISOString(),
    newestPromotedAt: newestPromotedTime === undefined ? null : new Date(newestPromotedTime).toISOString(),
    staleEntries,
    duplicateCount,
    duplicateGroups: duplicateGroups.slice(0, 5),
    recommendations: actionRecommendations.length > 0
      ? actionRecommendations
      : ["Golden set looks healthy enough for the current regression gate."]
  };
}

function duplicateGoldenSetGroups(entries: GoldenSetHealthSummary["staleEntries"]): GoldenSetHealthSummary["duplicateGroups"] {
  const byTraceId = new Map<string, GoldenSetHealthSummary["staleEntries"]>();
  for (const entry of entries) {
    const group = byTraceId.get(entry.traceId);
    if (group) {
      group.push(entry);
    } else {
      byTraceId.set(entry.traceId, [entry]);
    }
  }

  return [...byTraceId.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([traceId, group]) => ({
      traceId,
      entryCount: group.length,
      entries: [...group]
        .sort((left, right) => Date.parse(left.promotedAt) - Date.parse(right.promotedAt))
        .slice(0, 5)
    }))
    .sort((left, right) => right.entryCount - left.entryCount || left.traceId.localeCompare(right.traceId));
}

function ageInDays(value: string, now: Date): number {
  const promotedAt = new Date(value);
  if (Number.isNaN(promotedAt.getTime())) return 0;
  const ageMs = now.getTime() - promotedAt.getTime();
  return Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
}

function goldenSetHealthRecommendations(input: {
  totalActive: number;
  staleCount: number;
  staleAfterDays: number;
  duplicateCount: number;
  passCount: number;
  failCount: number;
}): string[] {
  const recommendations: string[] = [];
  if (input.totalActive === 0) {
    recommendations.push("Promote reviewed exceptions before relying on the regression gate.");
  } else if (input.totalActive < 10) {
    recommendations.push("Grow the golden set to at least 10 active cases before treating regression runs as authoritative.");
  }
  if (input.staleCount > 0) {
    recommendations.push(`Review ${input.staleCount} golden-set ${input.staleCount === 1 ? "case" : "cases"} older than ${input.staleAfterDays} days for stale labels or product drift.`);
  }
  if (input.duplicateCount > 0) {
    recommendations.push(`Review ${input.duplicateCount} duplicate golden-set ${input.duplicateCount === 1 ? "case" : "cases"} before expanding the suite.`);
  }
  if (input.totalActive > 0 && (input.passCount === 0 || input.failCount === 0)) {
    recommendations.push("Keep both pass and fail examples active so the gate catches strict and lenient drift.");
  }
  return recommendations;
}

function demoTraceForGoldenEntry(entry: GoldenSetEntry): Trace {
  return {
    id: entry.traceId,
    input: { caseId: entry.caseId },
    output: entry.agreedLabel === "pass"
      ? { message: `${entry.reason} Minor borderline tone note for strict regression testing.` }
      : { message: `${entry.reason} incorrect failure signal.` },
    metadata: { goldenSetEntryId: entry.id }
  };
}

function nextPatchVersion(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = version.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

export type ConvergenceCursor = {
  versionId: string;
  criterionVersionId: string;
  beforeVersionId: string | null;
  snapshotCreatedAt: string;
  snapshotId: string;
  rank: number;
  caseId: string;
};

export function convergencePageLimit(value: number | undefined): number {
  if (value === undefined) return CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT;
  return Math.min(CONVERGENCE_CASE_PAGE_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

export function convergenceChangeRank(change: ConvergenceCaseChange): number {
  if (change === "regressed") return 0;
  if (change === "improved") return 1;
  if (change === "still_disagree") return 2;
  return 3;
}

export function encodeConvergenceCursor(cursor: ConvergenceCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeConvergenceCursor(value: string | null): ConvergenceCursor | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      !Number.isInteger(parsed.rank) ||
      Number(parsed.rank) < 0 ||
      Number(parsed.rank) > 3 ||
      typeof parsed.versionId !== "string" ||
      parsed.versionId.length === 0 ||
      typeof parsed.criterionVersionId !== "string" ||
      parsed.criterionVersionId.length === 0 ||
      !(parsed.beforeVersionId === null || typeof parsed.beforeVersionId === "string") ||
      typeof parsed.snapshotCreatedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.snapshotCreatedAt)) ||
      typeof parsed.snapshotId !== "string" ||
      parsed.snapshotId.length === 0 ||
      typeof parsed.caseId !== "string" ||
      parsed.caseId.length === 0
    ) {
      throw new InvalidConvergenceCursorError();
    }
    return {
      versionId: parsed.versionId,
      criterionVersionId: parsed.criterionVersionId,
      beforeVersionId: parsed.beforeVersionId as string | null,
      snapshotCreatedAt: parsed.snapshotCreatedAt,
      snapshotId: parsed.snapshotId,
      rank: Number(parsed.rank),
      caseId: parsed.caseId
    };
  } catch (error) {
    if (error instanceof InvalidConvergenceCursorError) throw error;
    throw new InvalidConvergenceCursorError();
  }
}

// B12 (M0 C8): demo parity with PG's attachActorNames — the seeded demo
// reviewers resolve to display names so the trust feeds read "Maya · Pass" in
// demo exactly like prod, and the web needs no id-prettifying fallback.
const DEMO_ACTOR_NAMES = new Map<string, string>([
  ["user_maya", "Maya"],
  ["user_jules", "Jules"],
  ["user_priya", "Priya"]
]);

function attachDemoActorNames(labelLists: Array<Array<{ actorUserId: string; actorName?: string | null | undefined }>>): void {
  for (const labels of labelLists) {
    for (const label of labels) {
      label.actorName = DEMO_ACTOR_NAMES.get(label.actorUserId) ?? null;
    }
  }
}
