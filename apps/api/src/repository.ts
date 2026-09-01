import { MockJudgeProvider, type JudgeProvider, type Trace } from "@coeval/audit/runtime";
import { demoProject } from "@coeval/db";
import {
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
  DatasetItem,
  DatasetRevision,
  DatasetRevisionDetail,
  EvalRun,
  EvalRunDetail,
  EvalRunItem,
  type GateCheck,
  type GateCheckDetail,
  ExceptionDetail,
  FeedbackSyncJob,
  GoldenSetHealthSummary,
  GoldenSetEntry,
  ConvergenceAuditPage,
  SelfConsistencyReport,
  DisagreementSummary,
  ImportJobRecord,
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
  type IronsideEvaluatorContext,
  IronsideSyncState,
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
  OnboardingEvidenceInventory,
  Project,
  ProjectSettings,
  RegressionRunResult,
  RetentionPruneResult,
  RunComparison,
  Skill,
  JudgeKeyProvider,
  JudgeProviderKey,
  SkillFormatExample,
  SkillVersion,
  TraceTestDetail,
  TraceTestSummary,
  TraceTestValidation,
  CaseSource,
  UpdateLangfuseIntegrationInput,
  UpdateLangSmithIntegrationInput,
  UpdateProjectSettingsInput,
  VerdictRecord
} from "@coeval/shared";
import type {
  ProjectRepositoryPort, CriterionSuiteRepositoryPort,
  SkillLifecycleRepositoryPort, GoldenEvidenceRepositoryPort,
  TraceImportRepositoryPort, IntegrationRepositoryPort,
  JudgeFeedbackRepositoryPort, CaseEvidenceRepositoryPort,
  ReviewQueueRepositoryPort, ApiKeyRepositoryPort,
  TraceTestRepositoryPort, DatasetRepositoryPort,
  JudgeCredentialRepositoryPort, EvalRunRepositoryPort,
  AssessmentReceiptRepositoryPort, RunComparisonRepositoryPort,
  HistoricalGateEvidenceRepositoryPort
} from "./repository/ports.js";
import type {
  CreateSkillVersionContext,
  ConvergenceAuditPageInput,
  AssessmentReceiptArtifact,
  AssessmentReceiptComparison,
  CompareAssessmentReceiptCopyInput,
  CreateAssessmentReceiptCorrectionInput,
  CreateGateCheckInputDb,
  CreateRunComparisonInputDb,
  CreateEvalRunInputDb,
  CreateConvergenceEvalRunInputDb,
  CreateImportedCaseEvalRunInputDb,
  EvalRunDispatchInputDb,
  EvalRunDispatchClaim,
  EvalRunItemExecutionInputDb,
  EvalRunItemExecutionClaim,
  EvalRunItemReleaseDisposition,
  EvalRunItemReleaseOptions,
  StaleEvalRunItemExecution,
  CompleteEvalRunItemInputDb,
  FailEvalRunItemInputDb,
  CreateApiKeyInputDb,
  CreateTraceTestInputDb,
  ReviseTraceTestInputDb,
  RecordTraceTestValidationInputDb,
  EnableTraceTestInputDb,
  RecordTraceTestFunnelEventInputDb,
  CreateDatasetInputDb,
  AddDatasetItemsInputDb,
  ImportDatasetExamplesDbInput,
  ImportDatasetExamplesDbResult,
  CreateDatasetRevisionDbInput,
  AddQueueItemsInputDb,
  CreateReviewQueueInputDb,
  RecordVerdictInput,
  ListCasesOptions,
  CaseListEntry,
  ListVerdictsInput,
  TraceImportResult,
  JudgeRunContext,
  RecordJudgeRunInput,
  TraceImportContext,
  CreateImportJobInput,
  CompleteImportJobInput,
  ListImportJobsInput,
  PromoteExceptionToGoldenSetInput,
  RetireGoldenSetEntryInput,
  LangSmithImportContext,
  ClaimLangSmithImportTargetsInput,
  LangfuseImportContext,
  ClaimLangfuseImportTargetsInput,
  IronsideImportContext,
  ClaimIronsideImportTargetsInput,
  FeedbackSyncProvider,
  FeedbackSyncJobRecord,
  FeedbackSyncContext,
  ListFeedbackSyncJobsInput,
  FeedbackSyncJobListItem
} from "./repository/contracts.js";
import { createDemoRepositoryComposition, type DemoRepositoryComposition } from "./repository/demo-composition.js";
import { DemoRepositoryStore } from "./repository/demo-store.js";
export * from "./repository/contracts.js";
export * from "./repository/errors.js";
export { buildGoldenSetHealthSummary, previousVerdictsFromRun, runGoldenSetRegression } from "./repository/golden-helpers.js";
export * from "./repository/helpers.js";

export interface CoevalRepository extends
  ProjectRepositoryPort,
  CriterionSuiteRepositoryPort,
  SkillLifecycleRepositoryPort,
  GoldenEvidenceRepositoryPort,
  TraceImportRepositoryPort,
  IntegrationRepositoryPort,
  JudgeFeedbackRepositoryPort,
  CaseEvidenceRepositoryPort,
  ReviewQueueRepositoryPort,
  ApiKeyRepositoryPort,
  TraceTestRepositoryPort,
  DatasetRepositoryPort,
  JudgeCredentialRepositoryPort,
  EvalRunRepositoryPort,
  AssessmentReceiptRepositoryPort,
  RunComparisonRepositoryPort,
  HistoricalGateEvidenceRepositoryPort {}

export class DemoRepository implements CoevalRepository {
  private readonly caseEvidenceRepository!: DemoRepositoryComposition["caseEvidenceRepository"];
  private readonly credentialRepository!: DemoRepositoryComposition["credentialRepository"];
  private readonly criterionSuiteRepository!: DemoRepositoryComposition["criterionSuiteRepository"];
  private readonly datasetRepository!: DemoRepositoryComposition["datasetRepository"];
  private readonly evaluationRepository!: DemoRepositoryComposition["evaluationRepository"];
  private readonly goldenEvidenceRepository!: DemoRepositoryComposition["goldenEvidenceRepository"];
  private readonly historicalGateEvidenceRepository!: DemoRepositoryComposition["historicalGateEvidenceRepository"];
  private readonly integrationRepository!: DemoRepositoryComposition["integrationRepository"];
  private readonly judgeFeedbackRepository!: DemoRepositoryComposition["judgeFeedbackRepository"];
  private readonly projectRepository!: DemoRepositoryComposition["projectRepository"];
  private readonly reviewQueueRepository!: DemoRepositoryComposition["reviewQueueRepository"];
  private readonly runComparisonRepository!: DemoRepositoryComposition["runComparisonRepository"];
  private readonly skillLifecycleRepository!: DemoRepositoryComposition["skillLifecycleRepository"];
  private readonly traceImportRepository!: DemoRepositoryComposition["traceImportRepository"];
  private readonly traceTestRepository!: DemoRepositoryComposition["traceTestRepository"];
  private readonly store = new DemoRepositoryStore();

  constructor(
    private readonly judgeProvider: JudgeProvider = new MockJudgeProvider(),
    options: { seedVerdicts?: boolean } = {}
  ) {
    Object.assign(this, createDemoRepositoryComposition(this, this.store, this.judgeProvider, options));
  }

  async listProjects(): Promise<Project[]> {
    return this.projectRepository.listProjects();
  }

  async getProjectSettings(): Promise<ProjectSettings> {
    return this.projectRepository.getProjectSettings();
  }

  async updateProjectSettings(_projectId: string, input: UpdateProjectSettingsInput): Promise<ProjectSettings> {
    return this.projectRepository.updateProjectSettings(_projectId, input);
  }

  async pruneExpiredTraces(): Promise<RetentionPruneResult> {
    return this.projectRepository.pruneExpiredTraces();
  }

  async deleteProject(_projectId: string, input: { confirmProjectName: string }): Promise<void> {
    return this.projectRepository.deleteProject(_projectId, input);
  }

  async getDashboardSummary(projectId = demoProject.id, criterionId?: string | undefined): Promise<DashboardSummary> {
    return this.projectRepository.getDashboardSummary(projectId, criterionId);
  }

  async listCriteria(projectId: string): Promise<Criterion[]> {
    return this.criterionSuiteRepository.listCriteria(projectId);
  }

  async getCriterion(projectId: string, criterionId: string): Promise<CriterionDetail | null> {
    return this.criterionSuiteRepository.getCriterion(projectId, criterionId);
  }

  async createCriterion(
    projectId: string,
    input: CreateCriterionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CreatedCriterion> {
    return this.criterionSuiteRepository.createCriterion(projectId, input, context);
  }

  async createCriterionVersion(
    projectId: string,
    criterionId: string,
    input: CreateCriterionVersionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CriterionVersion | null> {
    return this.criterionSuiteRepository.createCriterionVersion(projectId, criterionId, input, context);
  }

  async listEvaluatorSuites(projectId: string): Promise<EvaluatorSuite[]> {
    return this.criterionSuiteRepository.listEvaluatorSuites(projectId);
  }

  async getEvaluatorSuite(projectId: string, suiteId: string): Promise<EvaluatorSuite | null> {
    return this.criterionSuiteRepository.getEvaluatorSuite(projectId, suiteId);
  }

  async createEvaluatorSuiteManifest(
    projectId: string,
    input: CreateEvaluatorSuiteManifestInput,
    context: { actorUserId?: string | undefined }
  ): Promise<EvaluatorSuiteManifest> {
    return this.criterionSuiteRepository.createEvaluatorSuiteManifest(projectId, input, context);
  }

  async listEvaluatorSuiteManifests(
    projectId: string,
    suiteId?: string | undefined
  ): Promise<EvaluatorSuiteManifest[]> {
    return this.criterionSuiteRepository.listEvaluatorSuiteManifests(projectId, suiteId);
  }

  async getEvaluatorSuiteManifest(
    projectId: string,
    manifestId: string
  ): Promise<EvaluatorSuiteManifest | null> {
    return this.criterionSuiteRepository.getEvaluatorSuiteManifest(projectId, manifestId);
  }

  async getCurrentSkill(projectId = demoProject.id): Promise<Skill> {
    return this.skillLifecycleRepository.getCurrentSkill(projectId);
  }

  async getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.skillLifecycleRepository.getCurrentSkillForCriterion(projectId, criterionId);
  }

  async authorizeSkillVersionExecution(input: {
    projectId: string;
    skillVersionId: string;
    context: EvaluatorExecutionContext;
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }): Promise<void> {
    return this.skillLifecycleRepository.authorizeSkillVersionExecution(input);
  }

  async getLatestSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.skillLifecycleRepository.getLatestSkillForCriterion(projectId, criterionId);
  }

  async getLatestSkill(projectId = demoProject.id): Promise<Skill> {
    return this.skillLifecycleRepository.getLatestSkill(projectId);
  }

  async getSkillVersion(projectId: string, skillVersionId: string): Promise<SkillVersion | null> {
    return this.skillLifecycleRepository.getSkillVersion(projectId, skillVersionId);
  }

  async getCriterionVersionForSkillVersion(
    projectId: string,
    skillVersionId: string
  ): Promise<CriterionVersion | null> {
    return this.skillLifecycleRepository.getCriterionVersionForSkillVersion(projectId, skillVersionId);
  }

  async signOffSkillVersion(
    _projectId: string,
    _skillId: string,
    versionId: string,
    _context: { actorUserId?: string | undefined }
  ): Promise<SkillVersion | null> {
    return this.skillLifecycleRepository.signOffSkillVersion(_projectId, _skillId, versionId, _context);
  }

  async listGoldenSet(
    projectId = demoProject.id,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetEntry[]> {
    return this.goldenEvidenceRepository.listGoldenSet(projectId, criterionVersionId);
  }

  async getSkillFormatExamples(
    projectId: string,
    cap: number,
    criterionVersionId?: string | undefined
  ): Promise<SkillFormatExample[]> {
    return this.goldenEvidenceRepository.getSkillFormatExamples(projectId, cap, criterionVersionId);
  }

  async getGoldenSetHealth(
    projectId = demoProject.id,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetHealthSummary> {
    return this.goldenEvidenceRepository.getGoldenSetHealth(projectId, criterionVersionId);
  }

  async getExceptionDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail> {
    return this.goldenEvidenceRepository.getExceptionDetail(projectId, caseId, skillVersionId);
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
    return this.goldenEvidenceRepository.getCaseDetail(projectId, caseId, skillVersionId);
  }

  async promoteExceptionToGoldenSet(input: PromoteExceptionToGoldenSetInput): Promise<GoldenSetEntry> {
    return this.goldenEvidenceRepository.promoteExceptionToGoldenSet(input);
  }

  async retireGoldenSetEntry(input: RetireGoldenSetEntryInput): Promise<void> {
    return this.goldenEvidenceRepository.retireGoldenSetEntry(input);
  }

  async importTrace(projectId: string, source: CaseSource, input: ManualTraceImportInput, context: TraceImportContext): Promise<TraceImportResult> {
    return this.traceImportRepository.importTrace(projectId, source, input, context);
  }

  async setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string): Promise<JudgeProviderKey> {
    return this.credentialRepository.setJudgeProviderKey(projectId, provider, apiKey);
  }

  async listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]> {
    return this.credentialRepository.listJudgeProviderKeys(projectId);
  }

  async deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider): Promise<boolean> {
    return this.credentialRepository.deleteJudgeProviderKey(projectId, provider);
  }

  async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
    return this.credentialRepository.getJudgeProviderCredential(projectId, provider);
  }

  async createImportJob(input: CreateImportJobInput): Promise<ImportJobRecord> {
    return this.traceImportRepository.createImportJob(input);
  }

  async markImportJobQueued(projectId: string, importJobId: string, queueJobId: string): Promise<ImportJobRecord> {
    return this.traceImportRepository.markImportJobQueued(projectId, importJobId, queueJobId);
  }

  async markImportJobRunning(projectId: string, importJobId: string): Promise<void> {
    return this.traceImportRepository.markImportJobRunning(projectId, importJobId);
  }

  async markImportJobCompleted(projectId: string, importJobId: string, result: CompleteImportJobInput): Promise<void> {
    return this.traceImportRepository.markImportJobCompleted(projectId, importJobId, result);
  }

  async markImportJobFailed(projectId: string, importJobId: string, error: unknown): Promise<ImportJobRecord> {
    return this.traceImportRepository.markImportJobFailed(projectId, importJobId, error);
  }

  async listImportJobs(input: ListImportJobsInput): Promise<ImportJobRecord[]> {
    return this.traceImportRepository.listImportJobs(input);
  }

  async createLangSmithIntegration(projectId: string, input: LangSmithIntegrationInput): Promise<LangSmithIntegration> {
    return this.integrationRepository.createLangSmithIntegration(projectId, input);
  }

  async listLangSmithIntegrations(projectId: string): Promise<LangSmithIntegration[]> {
    return this.integrationRepository.listLangSmithIntegrations(projectId);
  }

  async updateLangSmithIntegration(projectId: string, integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration> {
    return this.integrationRepository.updateLangSmithIntegration(projectId, integrationId, input);
  }

  async recordLangSmithConnectionTest(projectId: string, integrationId: string, result: LangSmithConnectionTestResult): Promise<void> {
    return this.integrationRepository.recordLangSmithConnectionTest(projectId, integrationId, result);
  }

  async deleteLangSmithIntegration(projectId: string, integrationId: string): Promise<void> {
    return this.integrationRepository.deleteLangSmithIntegration(projectId, integrationId);
  }

  async claimDueLangSmithImportTargets(input: ClaimLangSmithImportTargetsInput): Promise<LangSmithImportTarget[]> {
    return this.integrationRepository.claimDueLangSmithImportTargets(input);
  }

  async loadLangSmithImportContext(job: LangSmithImportJob): Promise<LangSmithImportContext> {
    return this.integrationRepository.loadLangSmithImportContext(job);
  }

  async createLangfuseIntegration(projectId: string, input: LangfuseIntegrationInput): Promise<LangfuseIntegration> {
    return this.integrationRepository.createLangfuseIntegration(projectId, input);
  }

  async listLangfuseIntegrations(projectId: string): Promise<LangfuseIntegration[]> {
    return this.integrationRepository.listLangfuseIntegrations(projectId);
  }

  async updateLangfuseIntegration(projectId: string, integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration> {
    return this.integrationRepository.updateLangfuseIntegration(projectId, integrationId, input);
  }

  async recordLangfuseConnectionTest(projectId: string, integrationId: string, result: LangfuseConnectionTestResult): Promise<void> {
    return this.integrationRepository.recordLangfuseConnectionTest(projectId, integrationId, result);
  }

  async deleteLangfuseIntegration(projectId: string, integrationId: string): Promise<void> {
    return this.integrationRepository.deleteLangfuseIntegration(projectId, integrationId);
  }

  async claimDueLangfuseImportTargets(input: ClaimLangfuseImportTargetsInput): Promise<LangfuseImportTarget[]> {
    return this.integrationRepository.claimDueLangfuseImportTargets(input);
  }

  async loadLangfuseImportContext(job: LangfuseImportJob): Promise<LangfuseImportContext> {
    return this.integrationRepository.loadLangfuseImportContext(job);
  }

  async createIronsideIntegration(projectId: string, input: IronsideIntegrationInput, remote: IronsideEvaluatorContext): Promise<IronsideIntegration> {
    return this.integrationRepository.createIronsideIntegration(projectId, input, remote);
  }

  async listIronsideIntegrations(projectId: string): Promise<IronsideIntegration[]> {
    return this.integrationRepository.listIronsideIntegrations(projectId);
  }

  async updateIronsideIntegration(
    projectId: string,
    integrationId: string,
    input: UpdateIronsideIntegrationInput,
    remote?: IronsideEvaluatorContext,
    expected?: { remoteProjectId: string; revalidationRequired: boolean; connectionRevision: number }
  ): Promise<IronsideIntegration> {
    return this.integrationRepository.updateIronsideIntegration(projectId, integrationId, input, remote, expected);
  }

  async recordIronsideConnectionTest(projectId: string, integrationId: string, result: IronsideConnectionTestResult): Promise<void> {
    return this.integrationRepository.recordIronsideConnectionTest(projectId, integrationId, result);
  }

  async quarantineIronsideIntegration(
    projectId: string,
    integrationId: string,
    expected: { remoteProjectId: string; connectionRevision: number },
    result: IronsideConnectionTestResult
  ): Promise<boolean> {
    return this.integrationRepository.quarantineIronsideIntegration(projectId, integrationId, expected, result);
  }

  async deleteIronsideIntegration(projectId: string, integrationId: string): Promise<void> {
    return this.integrationRepository.deleteIronsideIntegration(projectId, integrationId);
  }

  async claimDueIronsideImportTargets(input: ClaimIronsideImportTargetsInput): Promise<IronsideImportTarget[]> {
    return this.integrationRepository.claimDueIronsideImportTargets(input);
  }

  async loadIronsideImportContext(job: IronsideImportJob): Promise<IronsideImportContext> {
    return this.integrationRepository.loadIronsideImportContext(job);
  }

  async saveIronsideSyncState(
    projectId: string,
    integrationId: string,
    state: IronsideSyncState,
    expectedCursor?: string | null
  ): Promise<boolean> {
    return this.integrationRepository.saveIronsideSyncState(projectId, integrationId, state, expectedCursor);
  }

  async loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext> {
    return this.judgeFeedbackRepository.loadJudgeRunContext(job);
  }

  async recordJudgeRun(input: RecordJudgeRunInput): Promise<JudgeRun> {
    return this.judgeFeedbackRepository.recordJudgeRun(input);
  }

  async recordVerdict(input: RecordVerdictInput): Promise<VerdictRecord> {
    return this.caseEvidenceRepository.recordVerdict(input);
  }

  async createApiKey(input: CreateApiKeyInputDb): Promise<CreatedApiKey> {
    return this.credentialRepository.createApiKey(input);
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    return this.credentialRepository.listApiKeys(projectId);
  }

  async revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean> {
    return this.credentialRepository.revokeApiKey(projectId, apiKeyId);
  }

  async resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null> {
    return this.credentialRepository.resolveApiKey(rawKey);
  }

  async createTraceTest(input: CreateTraceTestInputDb): Promise<TraceTestDetail> {
    return this.traceTestRepository.createTraceTest(input);
  }

  async listTraceTests(projectId: string, sourceCaseRef?: string): Promise<TraceTestSummary[]> {
    return this.traceTestRepository.listTraceTests(projectId, sourceCaseRef);
  }

  async getTraceTest(projectId: string, traceTestId: string): Promise<TraceTestDetail | null> {
    return this.traceTestRepository.getTraceTest(projectId, traceTestId);
  }

  async reviseTraceTest(input: ReviseTraceTestInputDb): Promise<TraceTestDetail> {
    return this.traceTestRepository.reviseTraceTest(input);
  }

  async recordTraceTestValidation(input: RecordTraceTestValidationInputDb): Promise<TraceTestValidation> {
    return this.traceTestRepository.recordTraceTestValidation(input);
  }

  async enableTraceTest(input: EnableTraceTestInputDb): Promise<TraceTestDetail> {
    return this.traceTestRepository.enableTraceTest(input);
  }

  async recordTraceTestFunnelEvent(input: RecordTraceTestFunnelEventInputDb): Promise<void> {
    return this.traceTestRepository.recordTraceTestFunnelEvent(input);
  }

  async createDataset(input: CreateDatasetInputDb): Promise<Dataset> {
    return this.datasetRepository.createDataset(input);
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    return this.datasetRepository.listDatasets(projectId);
  }

  async getDatasetDetail(projectId: string, datasetId: string): Promise<DatasetDetail | null> {
    return this.datasetRepository.getDatasetDetail(projectId, datasetId);
  }

  async archiveDataset(projectId: string, datasetId: string): Promise<boolean> {
    return this.datasetRepository.archiveDataset(projectId, datasetId);
  }

  async addDatasetItems(input: AddDatasetItemsInputDb): Promise<DatasetItem[]> {
    return this.datasetRepository.addDatasetItems(input);
  }

  async importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult> {
    return this.datasetRepository.importDatasetExamples(input);
  }

  async createDatasetRevision(input: CreateDatasetRevisionDbInput): Promise<DatasetRevisionDetail> {
    return this.datasetRepository.createDatasetRevision(input);
  }

  async listDatasetRevisions(projectId: string, sourceDatasetId?: string): Promise<DatasetRevision[]> {
    return this.datasetRepository.listDatasetRevisions(projectId, sourceDatasetId);
  }

  async getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null> {
    return this.datasetRepository.getDatasetRevisionDetail(projectId, revisionId);
  }

  async recordDatasetRevisionContentView(input: {
    projectId: string;
    revisionId: string;
    actorUserId?: string | undefined;
  }): Promise<void> {
    return this.datasetRepository.recordDatasetRevisionContentView(input);
  }

  async getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string,
    criterionVersionId?: string
  ): Promise<DatasetRevisionDetail> {
    return this.datasetRepository.getOrCreateRegressionDatasetRevision(
      projectId,
      actorUserId,
      criterionVersionId
    );
  }

  async removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean> {
    return this.datasetRepository.removeDatasetItem(projectId, datasetId, itemId);
  }

  async createEvalRun(input: CreateEvalRunInputDb): Promise<EvalRunDetail> {
    return this.evaluationRepository.createEvalRun(input);
  }

  async createConvergenceEvalRun(input: CreateConvergenceEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    return this.evaluationRepository.createConvergenceEvalRun(input);
  }

  async createImportedCaseEvalRun(input: CreateImportedCaseEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    return this.evaluationRepository.createImportedCaseEvalRun(input);
  }

  async claimEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<EvalRunDispatchClaim> {
    return this.evaluationRepository.claimEvalRunDispatch(input);
  }

  async rotateEvalRunDispatchJob(input: EvalRunDispatchInputDb): Promise<string | null> {
    return this.evaluationRepository.rotateEvalRunDispatchJob(input);
  }

  async markEvalRunDispatched(input: EvalRunDispatchInputDb): Promise<void> {
    return this.evaluationRepository.markEvalRunDispatched(input);
  }

  async releaseEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<void> {
    return this.evaluationRepository.releaseEvalRunDispatch(input);
  }

  async armEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string): Promise<void> {
    return this.evaluationRepository.armEvalRunItemDeliveryDeadline(projectId, evalRunId);
  }

  async markEvalRunRunning(projectId: string, evalRunId: string): Promise<void> {
    return this.evaluationRepository.markEvalRunRunning(projectId, evalRunId);
  }

  async listPendingEvalRunItems(projectId: string, evalRunId: string): Promise<EvalRunItem[]> {
    return this.evaluationRepository.listPendingEvalRunItems(projectId, evalRunId);
  }

  async listPendingEvalRunItemDispatches(projectId: string, evalRunId: string): Promise<Array<{
    item: EvalRunItem;
    jobId: string;
  }>> {
    return this.evaluationRepository.listPendingEvalRunItemDispatches(projectId, evalRunId);
  }

  async claimEvalRunItemExecution(input: EvalRunItemExecutionInputDb): Promise<EvalRunItemExecutionClaim> {
    return this.evaluationRepository.claimEvalRunItemExecution(input);
  }

  async claimEvalRunItemRecovery(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    return this.evaluationRepository.claimEvalRunItemRecovery(input);
  }

  async rearmEvalRunItemDeliveryDeadline(
    projectId: string,
    evalRunId: string,
    evalRunItemId: string
  ): Promise<boolean> {
    return this.evaluationRepository.rearmEvalRunItemDeliveryDeadline(projectId, evalRunId, evalRunItemId);
  }

  async beginEvalRunItemProviderCall(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    return this.evaluationRepository.beginEvalRunItemProviderCall(input);
  }

  async markEvalRunItemProviderCallReturned(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    return this.evaluationRepository.markEvalRunItemProviderCallReturned(input);
  }

  async releaseEvalRunItemExecution(
    input: EvalRunItemExecutionInputDb,
    options: EvalRunItemReleaseOptions = {}
  ): Promise<EvalRunItemReleaseDisposition> {
    return this.evaluationRepository.releaseEvalRunItemExecution(input, options);
  }

  async listStaleEvalRunItemExecutions(): Promise<StaleEvalRunItemExecution[]> {
    return this.evaluationRepository.listStaleEvalRunItemExecutions();
  }

  async getEvalRunItem(projectId: string, evalRunId: string, evalRunItemId: string): Promise<EvalRunItem | null> {
    return this.evaluationRepository.getEvalRunItem(projectId, evalRunId, evalRunItemId);
  }

  async completeEvalRunItem(input: CompleteEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    return this.evaluationRepository.completeEvalRunItem(input);
  }

  async failEvalRunItem(input: FailEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    return this.evaluationRepository.failEvalRunItem(input);
  }

  async getEvalRun(projectId: string, evalRunId: string): Promise<EvalRun | null> {
    return this.evaluationRepository.getEvalRun(projectId, evalRunId);
  }

  async getEvalRunDetail(projectId: string, evalRunId: string): Promise<EvalRunDetail | null> {
    return this.evaluationRepository.getEvalRunDetail(projectId, evalRunId);
  }

  async listEvalRuns(
    projectId: string,
    opts?: { limit?: number | undefined; skillVersionId?: string | undefined }
  ): Promise<EvalRun[]> {
    return this.evaluationRepository.listEvalRuns(projectId, opts);
  }

  async getOrFreezeAssessmentReceipt(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact | null> {
    return this.evaluationRepository.getOrFreezeAssessmentReceipt(projectId, evalRunId);
  }

  async getAssessmentReceiptArtifactByReceiptId(
    projectId: string,
    receiptId: string
  ): Promise<AssessmentReceiptArtifact | null> {
    return this.evaluationRepository.getAssessmentReceiptArtifactByReceiptId(projectId, receiptId);
  }

  async listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]> {
    return this.evaluationRepository.listAssessmentReceiptArtifacts(projectId, evalRunId);
  }

  async compareAssessmentReceiptCopy(input: CompareAssessmentReceiptCopyInput): Promise<AssessmentReceiptComparison> {
    return this.evaluationRepository.compareAssessmentReceiptCopy(input);
  }

  async createAssessmentReceiptCorrection(
    input: CreateAssessmentReceiptCorrectionInput
  ): Promise<AssessmentReceiptArtifact> {
    return this.evaluationRepository.createAssessmentReceiptCorrection(input);
  }

  async deleteUndispatchedEvalRun(projectId: string, evalRunId: string): Promise<void> {
    return this.evaluationRepository.deleteUndispatchedEvalRun(projectId, evalRunId);
  }

  async createRunComparison(input: CreateRunComparisonInputDb): Promise<RunComparison> {
    return this.runComparisonRepository.createRunComparison(input);
  }

  async getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null> {
    return this.runComparisonRepository.getRunComparison(projectId, runComparisonId);
  }

  async listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]> {
    return this.runComparisonRepository.listRunComparisons(projectId, opts);
  }

  // --- Historical gate evidence compatibility ------------------------------

  async getGoldenSetTraces(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<Map<string, Trace>> {
    return this.goldenEvidenceRepository.getGoldenSetTraces(projectId, criterionVersionId);
  }

  async createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail> {
    return this.historicalGateEvidenceRepository.createGateCheck(input);
  }

  async getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null> {
    return this.historicalGateEvidenceRepository.getGateCheckDetail(projectId, gateCheckId);
  }

  async listGateChecks(projectId: string, opts?: { limit?: number | undefined }): Promise<GateCheck[]> {
    return this.historicalGateEvidenceRepository.listGateChecks(projectId, opts);
  }

  async listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]> {
    return this.caseEvidenceRepository.listVerdicts(input);
  }

  async getProjectKappaSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<KappaSummary> {
    return this.caseEvidenceRepository.getProjectKappaSummary(projectId, criterionVersionId);
  }

  async getProjectJudgeHumanCalibration(
    projectId: string,
    criterionVersionId?: string | undefined,
    skillVersionId?: string | undefined
  ): Promise<KappaSummary> {
    return this.caseEvidenceRepository.getProjectJudgeHumanCalibration(
      projectId,
      criterionVersionId,
      skillVersionId
    );
  }

  async getDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<DisagreementSummary> {
    return this.caseEvidenceRepository.getDisagreementSummary(projectId, criterionVersionId);
  }

  async getJudgeHumanDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<JudgeHumanDisagreementSummary> {
    return this.caseEvidenceRepository.getJudgeHumanDisagreementSummary(projectId, criterionVersionId);
  }

  async getConvergenceAudit(
    projectId: string,
    skillId: string,
    versionId: string,
    input: ConvergenceAuditPageInput = {}
  ): Promise<ConvergenceAuditPage> {
    return this.caseEvidenceRepository.getConvergenceAudit(projectId, skillId, versionId, input);
  }

  async getSelfConsistencyReport(projectId: string, versionId: string): Promise<SelfConsistencyReport> {
    return this.caseEvidenceRepository.getSelfConsistencyReport(projectId, versionId);
  }

  async listAuditEntries(): Promise<JudgeCardAuditEntry[]> {
    return this.caseEvidenceRepository.listAuditEntries();
  }

  async createReviewQueue(input: CreateReviewQueueInputDb): Promise<ReviewQueue> {
    return this.reviewQueueRepository.createReviewQueue(input);
  }

  async addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]> {
    return this.reviewQueueRepository.addReviewQueueItems(input);
  }

  async listReviewQueues(projectId: string, opts?: { status?: ReviewQueueStatus | undefined }): Promise<ReviewQueue[]> {
    return this.reviewQueueRepository.listReviewQueues(projectId, opts);
  }

  async getReviewQueueDetail(projectId: string, queueId: string): Promise<ReviewQueueDetail | null> {
    return this.reviewQueueRepository.getReviewQueueDetail(projectId, queueId);
  }

  async getNextPendingQueueItem(projectId: string, queueId: string, opts?: {
    assignedToUserId?: string | undefined;
    criterionVersionId?: string | undefined;
  }): Promise<ReviewQueueItem | null> {
    return this.reviewQueueRepository.getNextPendingQueueItem(projectId, queueId, opts);
  }

  async closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    return this.reviewQueueRepository.closeReviewQueue(projectId, queueId);
  }

  async reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    return this.reviewQueueRepository.reopenReviewQueue(projectId, queueId);
  }

  async listCases(projectId: string, opts: ListCasesOptions = {}): Promise<CaseListEntry[]> {
    return this.caseEvidenceRepository.listCases(projectId, opts);
  }

  async getOnboardingEvidenceInventory(projectId: string): Promise<OnboardingEvidenceInventory> {
    return this.projectRepository.getOnboardingEvidenceInventory(projectId);
  }

  async listCaseIdsForProject(projectId: string, limit = 10_000): Promise<string[]> {
    return this.caseEvidenceRepository.listCaseIdsForProject(projectId, limit);
  }

  async caseExistsForProject(projectId: string, caseId: string): Promise<boolean> {
    return this.caseEvidenceRepository.caseExistsForProject(projectId, caseId);
  }

  async createFeedbackSyncJob(input: { projectId: string; judgeRunId: string; provider: FeedbackSyncProvider }): Promise<FeedbackSyncJobRecord | null> {
    return this.judgeFeedbackRepository.createFeedbackSyncJob(input);
  }

  async loadFeedbackSyncContext(job: FeedbackSyncJob): Promise<FeedbackSyncContext> {
    return this.judgeFeedbackRepository.loadFeedbackSyncContext(job);
  }

  async listFeedbackSyncJobs(input: ListFeedbackSyncJobsInput): Promise<FeedbackSyncJobListItem[]> {
    return this.judgeFeedbackRepository.listFeedbackSyncJobs(input);
  }

  async markFeedbackSyncSucceeded(job: FeedbackSyncJob): Promise<void> {
    return this.judgeFeedbackRepository.markFeedbackSyncSucceeded(job);
  }

  async markFeedbackSyncFailed(job: FeedbackSyncJob, error: unknown): Promise<void> {
    return this.judgeFeedbackRepository.markFeedbackSyncFailed(job, error);
  }

  async markFeedbackSyncBlocked(job: FeedbackSyncJob, error: unknown): Promise<void> {
    return this.judgeFeedbackRepository.markFeedbackSyncBlocked(job, error);
  }

  async markFeedbackSyncPending(job: FeedbackSyncJob): Promise<void> {
    return this.judgeFeedbackRepository.markFeedbackSyncPending(job);
  }

  async listBlockedIronsideFeedbackSyncJobs(projectId: string, integrationId: string): Promise<FeedbackSyncJob[]> {
    return this.judgeFeedbackRepository.listBlockedIronsideFeedbackSyncJobs(projectId, integrationId);
  }

  async createSkillVersion(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    return this.skillLifecycleRepository.createSkillVersion(skillId, input, context);
  }

  async createSkillVersionPending(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<SkillVersion> {
    return this.skillLifecycleRepository.createSkillVersionPending(skillId, input, context);
  }

  async runRegressionGateForVersion(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    return this.skillLifecycleRepository.runRegressionGateForVersion(job);
  }

  async failRegressionGateForVersion(job: GateRunJob, error: unknown): Promise<void> {
    return this.skillLifecycleRepository.failRegressionGateForVersion(job, error);
  }

  async getRegressionRunForVersion(_projectId: string, skillVersionId: string): Promise<RegressionRunResult | null> {
    return this.skillLifecycleRepository.getRegressionRunForVersion(_projectId, skillVersionId);
  }

  async listRegressionRunsForVersions(_projectId: string, skillVersionIds: string[]): Promise<RegressionRunResult[]> {
    return this.skillLifecycleRepository.listRegressionRunsForVersions(_projectId, skillVersionIds);
  }

  async listSkillVersions(_projectId: string, skillId: string, limit = 50): Promise<SkillVersion[]> {
    return this.skillLifecycleRepository.listSkillVersions(_projectId, skillId, limit);
  }
}
