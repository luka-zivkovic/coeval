import type { Pool } from "pg";
import type {
  Criterion,
  CriterionDetail,
  CriterionVersion,
  CreateCriterionInput,
  CreateCriterionVersionInput,
  CreatedCriterion,
  CreateEvaluatorSuiteManifestInput,
  EvaluatorSuite,
  EvaluatorSuiteManifest,
  EvaluatorExecutionContext,
  ApiKey,
  CreatedApiKey,
  Dataset,
  DatasetDetail,
  DatasetItem,
  DatasetRevision,
  DatasetRevisionDetail,
  EvalRun,
  EvalRunDetail,
  EvalRunItem,
  GoldenSetEntry,
  ConvergenceAuditPage,
  SelfConsistencyReport,
  DisagreementSummary,
  ImportJobRecord,
  JudgeHumanDisagreementSummary,
  JudgeRun,
  KappaSummary,
  ReviewQueue,
  ReviewQueueDetail,
  ReviewQueueItem,
  ReviewQueueStatus,
  JudgeRunJob,
  IronsideImportJob,
  IronsideImportTarget,
  IronsideIntegration,
  IronsideIntegrationInput,
  IronsideEvaluatorContext,
  IronsideSyncState,
  UpdateIronsideIntegrationInput,
  IronsideConnectionTestResult,
  LangfuseImportJob,
  LangfuseImportTarget,
  LangfuseIntegration,
  LangfuseIntegrationInput,
  LangSmithImportJob,
  LangSmithImportTarget,
  LangSmithIntegration,
  LangSmithIntegrationInput,
  ManualTraceImportInput,
  OnboardingEvidenceInventory,
  Project,
  ProjectSettings,
  RunComparison,
  JudgeKeyProvider,
  JudgeProviderKey,
  SkillFormatExample,
  Skill,
  SkillVersion,
  CaseSource,
  DashboardSummary,
  CreateSkillVersionInput,
  ExceptionCase,
  ExceptionDetail,
  FeedbackSyncJob,
  GoldenSetHealthSummary,
  RegressionRunResult,
  RetentionPruneResult,
  LangfuseConnectionTestResult,
  LangSmithConnectionTestResult,
  UpdateLangfuseIntegrationInput,
  UpdateLangSmithIntegrationInput,
  UpdateProjectSettingsInput,
  VerdictRecord,
  GateRunJob,
  GateCheck,
  GateCheckDetail,
  JudgeCardAuditEntry,
  TraceTestDetail,
  TraceTestSummary,
  TraceTestValidation
} from "@coeval/shared";
import type { Trace } from "@coeval/audit/runtime";
import { createJudgeProvider, type JudgeProviderFactory } from "./lib/judge-provider.js";
import type {
  ConvergenceAuditPageInput,
  RecordTraceTestFunnelEventInputDb
} from "./repository.js";
import {
  AmbiguousProjectSkillError,
  DatasetRevisionConflictError,
  type AddDatasetItemsInputDb,
  type AssessmentReceiptArtifact,
  type AssessmentReceiptComparison,
  type AddQueueItemsInputDb,
  type ClaimIronsideImportTargetsInput,
  type ClaimLangfuseImportTargetsInput,
  type ClaimLangSmithImportTargetsInput,
  type CompleteEvalRunItemInputDb,
  type CompleteImportJobInput,
  type CoevalRepository,
  type CompareAssessmentReceiptCopyInput,
  type CreateApiKeyInputDb,
  type CreateAssessmentReceiptCorrectionInput,
  type CreateDatasetInputDb,
  type CreateDatasetRevisionDbInput,
  type CreateConvergenceEvalRunInputDb,
  type CreateImportedCaseEvalRunInputDb,
  type CreateEvalRunInputDb,
  type CreateGateCheckInputDb,
  type CreateImportJobInput,
  type CreateRunComparisonInputDb,
  type CreateReviewQueueInputDb,
  type CreateSkillVersionContext,
  type CreateTraceTestInputDb,
  type EnableTraceTestInputDb,
  type EvalRunDispatchClaim,
  type EvalRunDispatchInputDb,
  type EvalRunItemExecutionClaim,
  type EvalRunItemExecutionInputDb,
  type EvalRunItemReleaseOptions,
  type EvalRunItemReleaseDisposition,
  type FailEvalRunItemInputDb,
  type FeedbackSyncContext,
  type FeedbackSyncJobRecord,
  type FeedbackSyncJobListItem,
  type FeedbackSyncProvider,
  type JudgeRunContext,
  type IronsideImportContext,
  type LangfuseImportContext,
  type LangSmithImportContext,
  type CaseListEntry,
  type ListCasesOptions,
  type ListImportJobsInput,
  type ListFeedbackSyncJobsInput,
  type ListVerdictsInput,
  type PromoteExceptionToGoldenSetInput,
  type RecordJudgeRunInput,
  type RecordVerdictInput,
  type RecordTraceTestValidationInputDb,
  type ReviseTraceTestInputDb,
  type RetireGoldenSetEntryInput,
  type StaleEvalRunItemExecution,
  type ImportDatasetExamplesDbInput,
  type ImportDatasetExamplesDbResult,
  type TraceImportContext,
  type TraceImportResult
} from "./repository.js";
import { PgApiKeyRepository } from "./repository.pg/api-key-repository.js";
import { PgAssessmentReceiptRepository } from "./repository.pg/assessment-receipt-repository.js";
import { PgCaseEvidenceRepository } from "./repository.pg/case-evidence-repository.js";
import { PgCriterionSuiteRepository } from "./repository.pg/criterion-suite-repository.js";
import { PgDatasetRepository } from "./repository.pg/dataset-repository.js";
import { PgEvalRunRepository } from "./repository.pg/eval-run-repository.js";
import { PgGoldenEvidenceRepository } from "./repository.pg/golden-evidence-repository.js";
import { PgHistoricalGateEvidenceRepository } from "./repository.pg/historical-gate-evidence-repository.js";
import { PgIntegrationRepository } from "./repository.pg/integration-repository.js";
import { PgJudgeCredentialRepository } from "./repository.pg/judge-credential-repository.js";
import { PgJudgeFeedbackRepository } from "./repository.pg/judge-feedback-repository.js";
import { PgProjectRepository } from "./repository.pg/project-repository.js";
import { PgReviewQueueRepository } from "./repository.pg/review-queue-repository.js";
import { PgRunComparisonRepository } from "./repository.pg/run-comparison-repository.js";
import { PgSkillLifecycleRepository } from "./repository.pg/skill-lifecycle-repository.js";
import { PgTraceImportRepository } from "./repository.pg/trace-import-repository.js";
import { PgTraceTestRepository } from "./repository.pg/trace-test-repository.js";

export class PgRepository implements CoevalRepository {
  private readonly apiKeyRepository: PgApiKeyRepository;
  private readonly assessmentReceiptRepository: PgAssessmentReceiptRepository;
  private readonly caseEvidenceRepository: PgCaseEvidenceRepository;
  private readonly criterionSuiteRepository: PgCriterionSuiteRepository;
  private readonly datasetRepository: PgDatasetRepository;
  private readonly evalRunRepository: PgEvalRunRepository;
  private readonly goldenEvidenceRepository: PgGoldenEvidenceRepository;
  private readonly historicalGateEvidenceRepository: PgHistoricalGateEvidenceRepository;
  private readonly integrationRepository: PgIntegrationRepository;
  private readonly judgeCredentialRepository: PgJudgeCredentialRepository;
  private readonly judgeFeedbackRepository: PgJudgeFeedbackRepository;
  private readonly projectRepository: PgProjectRepository;
  private readonly reviewQueueRepository: PgReviewQueueRepository;
  private readonly runComparisonRepository: PgRunComparisonRepository;
  private readonly skillLifecycleRepository: PgSkillLifecycleRepository;
  private readonly traceImportRepository: PgTraceImportRepository;
  private readonly traceTestRepository: PgTraceTestRepository;

  constructor(
    private readonly pool: Pool,
    judgeProviderFactory: JudgeProviderFactory = createJudgeProvider
  ) {
    this.apiKeyRepository = new PgApiKeyRepository(pool);
    this.assessmentReceiptRepository = new PgAssessmentReceiptRepository(pool);
    this.caseEvidenceRepository = new PgCaseEvidenceRepository(pool, {
      assertSingletonCriterion: (projectId) => this.assertSingletonCriterion(projectId),
      getCurrentSkill: (projectId) => this.getCurrentSkill(projectId),
      resolveGoldenCriterionVersion: (projectId, requested) =>
        this.resolveGoldenCriterionVersion(projectId, requested)
    });
    this.criterionSuiteRepository = new PgCriterionSuiteRepository(pool);
    this.datasetRepository = new PgDatasetRepository(pool);
    this.evalRunRepository = new PgEvalRunRepository(pool);
    this.goldenEvidenceRepository = new PgGoldenEvidenceRepository(pool, {
      assertSingletonCriterion: (projectId) => this.assertSingletonCriterion(projectId),
      resolveGoldenCriterionVersion: (projectId, requested) =>
        this.resolveGoldenCriterionVersion(projectId, requested)
    });
    this.historicalGateEvidenceRepository = new PgHistoricalGateEvidenceRepository(pool);
    this.integrationRepository = new PgIntegrationRepository(
      pool,
      (projectId, requested, requiredContext) =>
        this.resolveImportSkillVersionId(projectId, requested, requiredContext),
      (input) => this.authorizeSkillVersionExecution(input)
    );
    this.judgeCredentialRepository = new PgJudgeCredentialRepository(pool);
    this.judgeFeedbackRepository = new PgJudgeFeedbackRepository(
      pool,
      async (projectId) => (await this.getCurrentSkill(projectId)).currentVersion.id,
      (input) => this.authorizeSkillVersionExecution(input)
    );
    this.projectRepository = new PgProjectRepository(pool, {
      getCurrentSkill: (projectId) => this.getCurrentSkill(projectId),
      getCurrentSkillForCriterion: (projectId, criterionId) =>
        this.getCurrentSkillForCriterion(projectId, criterionId),
      listGoldenSet: (projectId, criterionVersionId) =>
        this.listGoldenSet(projectId, criterionVersionId),
      listExceptionCases: (projectId, criterionVersionId) =>
        this.listExceptionCases(projectId, criterionVersionId)
    });
    this.reviewQueueRepository = new PgReviewQueueRepository(
      pool,
      (projectId) => this.getCurrentSkill(projectId)
    );
    this.runComparisonRepository = new PgRunComparisonRepository(pool);
    this.skillLifecycleRepository = new PgSkillLifecycleRepository(
      pool,
      judgeProviderFactory,
      {
        assertSingletonCriterion: (projectId) => this.assertSingletonCriterion(projectId),
        getDatasetRevisionDetail: (projectId, revisionId) =>
          this.getDatasetRevisionDetail(projectId, revisionId),
        getJudgeProviderCredential: (projectId, provider) =>
          this.getJudgeProviderCredential(projectId, provider)
      }
    );
    this.traceImportRepository = new PgTraceImportRepository(
      pool,
      (projectId, requested) => this.resolveImportSkillVersionId(projectId, requested),
      (input) => this.authorizeSkillVersionExecution(input)
    );
    this.traceTestRepository = new PgTraceTestRepository(pool);
  }

  async listProjects(userId?: string | undefined): Promise<Project[]> {
    return this.projectRepository.listProjects(userId);
  }

  async getProjectSettings(projectId: string): Promise<ProjectSettings> {
    return this.projectRepository.getProjectSettings(projectId);
  }

  async updateProjectSettings(
    projectId: string,
    input: UpdateProjectSettingsInput,
    context: { actorUserId?: string | undefined }
  ): Promise<ProjectSettings> {
    return this.projectRepository.updateProjectSettings(projectId, input, context);
  }

  async pruneExpiredTraces(
    projectId: string,
    context: { actorUserId?: string | undefined; now?: Date | undefined }
  ): Promise<RetentionPruneResult> {
    return this.projectRepository.pruneExpiredTraces(projectId, context);
  }

  async deleteProject(
    projectId: string,
    input: { confirmProjectName: string; actorUserId?: string | undefined }
  ): Promise<void> {
    return this.projectRepository.deleteProject(projectId, input);
  }

  async getDashboardSummary(
    projectId: string,
    criterionId?: string | undefined
  ): Promise<DashboardSummary> {
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

  async getCurrentSkill(projectId: string): Promise<Skill> {
    return this.skillLifecycleRepository.getCurrentSkill(projectId);
  }

  async getLatestSkill(projectId: string): Promise<Skill> {
    return this.skillLifecycleRepository.getLatestSkill(projectId);
  }

  async getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.skillLifecycleRepository.getCurrentSkillForCriterion(projectId, criterionId);
  }

  async getLatestSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.skillLifecycleRepository.getLatestSkillForCriterion(projectId, criterionId);
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

  private async assertSingletonCriterion(projectId: string): Promise<void> {
    const result = await this.pool.query(
      `select count(*)::int as criterion_count from criteria where project_id = $1`,
      [projectId]
    );
    const criterionCount = Number(result.rows[0]?.criterion_count ?? 0);
    if (criterionCount > 1) throw new AmbiguousProjectSkillError(projectId, criterionCount);
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

  async listGoldenSet(
    projectId: string,
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
    projectId: string,
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

  // generic case detail. Resolves ANY judged case to its trace +
  // latest judge run regardless of verdict, so surfaces like the regression
  // diff can link a still-passing golden case to its trace without 404ing on
  // the exceptions-only filter. Returns null when the case has no judge run.
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

  async importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult> {
    return this.datasetRepository.importDatasetExamples(input);
  }

  async setJudgeProviderKey(
    projectId: string,
    provider: JudgeKeyProvider,
    apiKey: string,
    actorUserId?: string
  ): Promise<JudgeProviderKey> {
    return this.judgeCredentialRepository.setJudgeProviderKey(
      projectId,
      provider,
      apiKey,
      actorUserId
    );
  }

  async listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]> {
    return this.judgeCredentialRepository.listJudgeProviderKeys(projectId);
  }

  async deleteJudgeProviderKey(
    projectId: string,
    provider: JudgeKeyProvider,
    actorUserId?: string
  ): Promise<boolean> {
    return this.judgeCredentialRepository.deleteJudgeProviderKey(
      projectId,
      provider,
      actorUserId
    );
  }

  async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
    return this.judgeCredentialRepository.getJudgeProviderCredential(projectId, provider);
  }

  async createImportJob(input: CreateImportJobInput): Promise<ImportJobRecord> {
    return this.traceImportRepository.createImportJob(input);
  }

  private async resolveImportSkillVersionId(
    projectId: string,
    requested?: string | undefined,
    requiredContext?: EvaluatorExecutionContext | undefined
  ): Promise<string> {
    let resolvedId: string;
    if (requested) {
      const version = await this.getSkillVersion(projectId, requested);
      if (!version) throw new DatasetRevisionConflictError(`Unknown import skillVersionId for this project: ${requested}`);
      resolvedId = version.id;
    } else {
      resolvedId = (await this.getCurrentSkill(projectId)).currentVersion.id;
    }
    if (requiredContext) {
      const allowed = (await this.pool.query(
        `select evaluator_skill_version_context_allowed_v1($1,$2,$3) as allowed`,
        [projectId,resolvedId,requiredContext]
      )).rows[0]?.allowed === true;
      if (!allowed) {
        throw new DatasetRevisionConflictError(
          `Evaluator version ${resolvedId} is not eligible for ${requiredContext}.`
        );
      }
    }
    return resolvedId;
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

  async deleteLangSmithIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void> {
    return this.integrationRepository.deleteLangSmithIntegration(projectId, integrationId, context);
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

  async deleteLangfuseIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void> {
    return this.integrationRepository.deleteLangfuseIntegration(projectId, integrationId, context);
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

  async deleteIronsideIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void> {
    return this.integrationRepository.deleteIronsideIntegration(projectId, integrationId, context);
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

  async listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]> {
    return this.caseEvidenceRepository.listVerdicts(input);
  }

  async caseExistsForProject(projectId: string, caseId: string): Promise<boolean> {
    return this.caseEvidenceRepository.caseExistsForProject(projectId, caseId);
  }

  async createApiKey(input: CreateApiKeyInputDb): Promise<CreatedApiKey> {
    return this.apiKeyRepository.createApiKey(input);
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.listApiKeys(projectId);
  }

  async revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean> {
    return this.apiKeyRepository.revokeApiKey(projectId, apiKeyId);
  }

  async resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null> {
    return this.apiKeyRepository.resolveApiKey(rawKey);
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

  async removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean> {
    return this.datasetRepository.removeDatasetItem(projectId, datasetId, itemId);
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
    return this.datasetRepository.getOrCreateRegressionDatasetRevision(projectId, actorUserId, criterionVersionId);
  }

  async createEvalRun(input: CreateEvalRunInputDb): Promise<EvalRunDetail> {
    return this.evalRunRepository.createEvalRun(input);
  }

  async createConvergenceEvalRun(input: CreateConvergenceEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    return this.evalRunRepository.createConvergenceEvalRun(input);
  }

  async createImportedCaseEvalRun(input: CreateImportedCaseEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    return this.evalRunRepository.createImportedCaseEvalRun(input);
  }

  async claimEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<EvalRunDispatchClaim> {
    return this.evalRunRepository.claimEvalRunDispatch(input);
  }

  async rotateEvalRunDispatchJob(input: EvalRunDispatchInputDb): Promise<string | null> {
    return this.evalRunRepository.rotateEvalRunDispatchJob(input);
  }

  async markEvalRunDispatched(input: EvalRunDispatchInputDb): Promise<void> {
    return this.evalRunRepository.markEvalRunDispatched(input);
  }

  async releaseEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<void> {
    return this.evalRunRepository.releaseEvalRunDispatch(input);
  }

  async armEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string): Promise<void> {
    return this.evalRunRepository.armEvalRunItemDeliveryDeadline(projectId, evalRunId);
  }

  async markEvalRunRunning(projectId: string, evalRunId: string): Promise<void> {
    return this.evalRunRepository.markEvalRunRunning(projectId, evalRunId);
  }

  async listPendingEvalRunItems(projectId: string, evalRunId: string): Promise<EvalRunItem[]> {
    return this.evalRunRepository.listPendingEvalRunItems(projectId, evalRunId);
  }

  async listPendingEvalRunItemDispatches(projectId: string, evalRunId: string): Promise<Array<{
    item: EvalRunItem;
    jobId: string;
  }>> {
    return this.evalRunRepository.listPendingEvalRunItemDispatches(projectId, evalRunId);
  }

  async claimEvalRunItemExecution(input: EvalRunItemExecutionInputDb): Promise<EvalRunItemExecutionClaim> {
    return this.evalRunRepository.claimEvalRunItemExecution(input);
  }

  async claimEvalRunItemRecovery(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    return this.evalRunRepository.claimEvalRunItemRecovery(input);
  }

  async rearmEvalRunItemDeliveryDeadline(
    projectId: string,
    evalRunId: string,
    evalRunItemId: string
  ): Promise<boolean> {
    return this.evalRunRepository.rearmEvalRunItemDeliveryDeadline(projectId, evalRunId, evalRunItemId);
  }

  async beginEvalRunItemProviderCall(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    return this.evalRunRepository.beginEvalRunItemProviderCall(input);
  }

  async markEvalRunItemProviderCallReturned(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    return this.evalRunRepository.markEvalRunItemProviderCallReturned(input);
  }

  async releaseEvalRunItemExecution(
    input: EvalRunItemExecutionInputDb,
    options: EvalRunItemReleaseOptions = {}
  ): Promise<EvalRunItemReleaseDisposition> {
    return this.evalRunRepository.releaseEvalRunItemExecution(input, options);
  }

  async listStaleEvalRunItemExecutions(): Promise<StaleEvalRunItemExecution[]> {
    return this.evalRunRepository.listStaleEvalRunItemExecutions();
  }

  async getEvalRunItem(projectId: string, evalRunId: string, evalRunItemId: string): Promise<EvalRunItem | null> {
    return this.evalRunRepository.getEvalRunItem(projectId, evalRunId, evalRunItemId);
  }

  async completeEvalRunItem(input: CompleteEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    return this.evalRunRepository.completeEvalRunItem(input);
  }

  async failEvalRunItem(input: FailEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    return this.evalRunRepository.failEvalRunItem(input);
  }

  async getEvalRun(projectId: string, evalRunId: string): Promise<EvalRun | null> {
    return this.evalRunRepository.getEvalRun(projectId, evalRunId);
  }

  async getEvalRunDetail(projectId: string, evalRunId: string): Promise<EvalRunDetail | null> {
    return this.evalRunRepository.getEvalRunDetail(projectId, evalRunId);
  }

  async listEvalRuns(
    projectId: string,
    opts?: { limit?: number | undefined; skillVersionId?: string | undefined }
  ): Promise<EvalRun[]> {
    return this.evalRunRepository.listEvalRuns(projectId, opts);
  }

  async getOrFreezeAssessmentReceipt(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact | null> {
    return this.assessmentReceiptRepository.getOrFreezeAssessmentReceipt(projectId, evalRunId);
  }

  async getAssessmentReceiptArtifactByReceiptId(
    projectId: string,
    receiptId: string
  ): Promise<AssessmentReceiptArtifact | null> {
    return this.assessmentReceiptRepository.getAssessmentReceiptArtifactByReceiptId(projectId, receiptId);
  }

  async listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]> {
    return this.assessmentReceiptRepository.listAssessmentReceiptArtifacts(projectId, evalRunId);
  }

  async compareAssessmentReceiptCopy(input: CompareAssessmentReceiptCopyInput): Promise<AssessmentReceiptComparison> {
    return this.assessmentReceiptRepository.compareAssessmentReceiptCopy(input);
  }

  async createAssessmentReceiptCorrection(
    input: CreateAssessmentReceiptCorrectionInput
  ): Promise<AssessmentReceiptArtifact> {
    return this.assessmentReceiptRepository.createAssessmentReceiptCorrection(input);
  }

  async deleteUndispatchedEvalRun(projectId: string, evalRunId: string): Promise<void> {
    return this.evalRunRepository.deleteUndispatchedEvalRun(projectId, evalRunId);
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

  // --- Product deploy gate ---------------------------------------------------

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

  async listCases(projectId: string, opts: ListCasesOptions = {}): Promise<CaseListEntry[]> {
    return this.caseEvidenceRepository.listCases(projectId, opts);
  }

  async getOnboardingEvidenceInventory(projectId: string): Promise<OnboardingEvidenceInventory> {
    return this.projectRepository.getOnboardingEvidenceInventory(projectId);
  }

  async listCaseIdsForProject(projectId: string, limit = 10_000): Promise<string[]> {
    return this.caseEvidenceRepository.listCaseIdsForProject(projectId, limit);
  }

  async listSkillVersions(projectId: string, skillId: string, limit = 50): Promise<SkillVersion[]> {
    return this.skillLifecycleRepository.listSkillVersions(projectId, skillId, limit);
  }

  async signOffSkillVersion(
    projectId: string,
    skillId: string,
    versionId: string,
    context: { actorUserId?: string | undefined }
  ): Promise<SkillVersion | null> {
    return this.skillLifecycleRepository.signOffSkillVersion(projectId, skillId, versionId, context);
  }

  async getRegressionRunForVersion(projectId: string, skillVersionId: string): Promise<RegressionRunResult | null> {
    return this.skillLifecycleRepository.getRegressionRunForVersion(projectId, skillVersionId);
  }

  async listRegressionRunsForVersions(projectId: string, skillVersionIds: string[]): Promise<RegressionRunResult[]> {
    return this.skillLifecycleRepository.listRegressionRunsForVersions(projectId, skillVersionIds);
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
    return this.caseEvidenceRepository.getProjectJudgeHumanCalibration(projectId, criterionVersionId, skillVersionId);
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

  async createReviewQueue(input: CreateReviewQueueInputDb): Promise<ReviewQueue> {
    return this.reviewQueueRepository.createReviewQueue(input);
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

  async addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]> {
    return this.reviewQueueRepository.addReviewQueueItems(input);
  }

  async closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    return this.reviewQueueRepository.closeReviewQueue(projectId, queueId);
  }

  async reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    return this.reviewQueueRepository.reopenReviewQueue(projectId, queueId);
  }

  private async resolveGoldenCriterionVersion(
    projectId: string,
    requested?: string | undefined
  ): Promise<string> {
    if (requested) {
      const result = await this.pool.query(
        `select id from criterion_versions where project_id = $1 and id = $2`,
        [projectId, requested]
      );
      if (!result.rowCount) {
        throw new DatasetRevisionConflictError(
          `Criterion version does not belong to this project: ${requested}`
        );
      }
      return requested;
    }
    const current = await this.getCurrentSkill(projectId);
    const criterion = await this.getCriterionVersionForSkillVersion(
      projectId,
      current.currentVersion.id
    );
    if (!criterion) {
      throw new DatasetRevisionConflictError("Current evaluator has no immutable criterion version binding");
    }
    return criterion.id;
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

  async listBlockedIronsideFeedbackSyncJobs(
    projectId: string,
    integrationId: string
  ): Promise<FeedbackSyncJob[]> {
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

  async listAuditEntries(projectId: string, targetType: string, targetId: string): Promise<JudgeCardAuditEntry[]> {
    return this.caseEvidenceRepository.listAuditEntries(projectId, targetType, targetId);
  }

  private async listExceptionCases(projectId: string, criterionVersionId?: string | undefined): Promise<ExceptionCase[]> {
    return this.caseEvidenceRepository.listExceptionCases(projectId, criterionVersionId);
  }
}
