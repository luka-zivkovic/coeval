import { randomUUID } from "node:crypto";
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
import {
  MinimumVerdictOutputSchema,
  regressionDirectionCounts
} from "@coeval/shared";
import type { Trace } from "@coeval/audit/runtime";
import { createJudgeProvider, type JudgeProviderFactory } from "./lib/judge-provider.js";
import { PgEvaluatorLifecycleRepository } from "./evaluator-lifecycle/repository.pg.js";
import { evaluatorSuiteCriterionDigest } from "./lib/evaluator-suite.js";
import {
  computeEvalRunSpend,
  type ConvergenceAuditPageInput,
  type RecordTraceTestFunnelEventInputDb
} from "./repository.js";
import {
  AgentSetupEligibilityError,
  AmbiguousProjectSkillError,
  DatasetRevisionConflictError,
  RegressionGateUnavailableError,
  GateRunBindingMismatchError,
  NoCurrentSkillError,
  OnboardingCheckConflictError,
  SkillVersionNotSignableError,
  previousVerdictsFromRun,
  runGoldenSetRegression,
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
import {
  bumpEvalRunCounters,
  mintAssessmentReceiptWithClient
} from "./repository.pg/assessment-receipt-commands.js";
import { PgAssessmentReceiptRepository } from "./repository.pg/assessment-receipt-repository.js";
import { PgCaseEvidenceRepository } from "./repository.pg/case-evidence-repository.js";
import { setJudgeProviderKeyOnClient } from "./repository.pg/credential-commands.js";
import { PgCriterionSuiteRepository } from "./repository.pg/criterion-suite-repository.js";
import { PgDatasetRepository } from "./repository.pg/dataset-repository.js";
import { getOrCreateRegressionDatasetRevisionWithClient } from "./repository.pg/dataset-revision-commands.js";
import { PgGoldenEvidenceRepository } from "./repository.pg/golden-evidence-repository.js";
import { PgHistoricalGateEvidenceRepository } from "./repository.pg/historical-gate-evidence-repository.js";
import { PgIntegrationRepository } from "./repository.pg/integration-repository.js";
import { PgJudgeCredentialRepository } from "./repository.pg/judge-credential-repository.js";
import { PgJudgeFeedbackRepository } from "./repository.pg/judge-feedback-repository.js";
import { PgProjectRepository } from "./repository.pg/project-repository.js";
import { insertRegressionRun } from "./repository.pg/regression-run-commands.js";
import { PgReviewQueueRepository } from "./repository.pg/review-queue-repository.js";
import { PgRunComparisonRepository } from "./repository.pg/run-comparison-repository.js";
import {
  insertSkillVersion,
  nextVersion
} from "./repository.pg/skill-version-commands.js";
import { PgTraceImportRepository } from "./repository.pg/trace-import-repository.js";
import { PgTraceTestRepository } from "./repository.pg/trace-test-repository.js";
import {
  gateFailureMessage,
  rowToCriterionVersion,
  rowToEvalRun,
  rowToEvalRunItem,
  rowToRegressionRun,
  rowToSkill,
  rowToSkillVersion,
  toIso
} from "./repository.pg/mappers.js";

export class PgRepository implements CoevalRepository {
  private readonly apiKeyRepository: PgApiKeyRepository;
  private readonly assessmentReceiptRepository: PgAssessmentReceiptRepository;
  private readonly caseEvidenceRepository: PgCaseEvidenceRepository;
  private readonly criterionSuiteRepository: PgCriterionSuiteRepository;
  private readonly datasetRepository: PgDatasetRepository;
  private readonly goldenEvidenceRepository: PgGoldenEvidenceRepository;
  private readonly historicalGateEvidenceRepository: PgHistoricalGateEvidenceRepository;
  private readonly integrationRepository: PgIntegrationRepository;
  private readonly judgeCredentialRepository: PgJudgeCredentialRepository;
  private readonly judgeFeedbackRepository: PgJudgeFeedbackRepository;
  private readonly projectRepository: PgProjectRepository;
  private readonly reviewQueueRepository: PgReviewQueueRepository;
  private readonly runComparisonRepository: PgRunComparisonRepository;
  private readonly traceImportRepository: PgTraceImportRepository;
  private readonly traceTestRepository: PgTraceTestRepository;

  constructor(
    private readonly pool: Pool,
    private readonly judgeProviderFactory: JudgeProviderFactory = createJudgeProvider
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

  // "Current" = the version production traffic should be judged with: the
  // latest APPROVED version. A gate-blocked (`regressing`) version must never
  // be picked implicitly — it exists only as audit history until someone
  // overrides it into a new approved version. Drafts rank above blocked
  // versions only so a fresh project (whose seed version is still `draft`)
  // can judge at all before its first approval.
  async getCurrentSkill(projectId: string): Promise<Skill> {
    await this.assertSingletonCriterion(projectId);
    return this.loadSkillByVersionOrder(
      projectId,
      `case
         when sv.status in ('approved', 'production') then 0
         when sv.status in ('regressing', 'failed', 'deprecated') then 2
         else 1
       end,
       sv.created_at desc,
       sv.id desc`,
      undefined,
      true
    );
  }

  // "Latest" = the newest version regardless of status — the editing base and
  // the gate's comparison baseline. Where getCurrentSkill answers "what judges
  // production traffic", this answers "what was the last attempt": a
  // gate-blocked draft must stay loadable here, or its author loses the edit
  // as a starting point the moment the editor reloads.
  async getLatestSkill(projectId: string): Promise<Skill> {
    await this.assertSingletonCriterion(projectId);
    return this.loadSkillByVersionOrder(projectId, `sv.created_at desc, sv.id desc`);
  }

  async getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.loadSkillByVersionOrder(
      projectId,
      `case
         when sv.status in ('approved', 'production') then 0
         when sv.status in ('regressing', 'failed', 'deprecated') then 2
         else 1
       end,
       sv.created_at desc,
       sv.id desc`,
      criterionId,
      true
    );
  }

  async getLatestSkillForCriterion(projectId: string, criterionId: string): Promise<Skill> {
    return this.loadSkillByVersionOrder(projectId, `sv.created_at desc, sv.id desc`, criterionId);
  }

  async getSkillVersion(projectId: string, skillVersionId: string): Promise<SkillVersion | null> {
    const result = await this.pool.query(
      `select version.*,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else version.status
              end as status
       from skill_versions version
       left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
       left join lateral evaluator_lifecycle_head_v1(lifecycle.id) lifecycle_head on true
       where version.id = $1 and version.project_id = $2`,
      [skillVersionId, projectId]
    );
    return result.rows[0] ? rowToSkillVersion(result.rows[0]) : null;
  }

  async getCriterionVersionForSkillVersion(
    projectId: string,
    skillVersionId: string
  ): Promise<CriterionVersion | null> {
    const row = (await this.pool.query(
      `select criterion.*
       from skill_versions evaluator
       join criterion_versions criterion
         on criterion.id = evaluator.criterion_version_id
        and criterion.project_id = evaluator.project_id
       where evaluator.project_id = $1 and evaluator.id = $2`,
      [projectId, skillVersionId]
    )).rows[0];
    return row ? rowToCriterionVersion(row) : null;
  }

  private async assertSingletonCriterion(projectId: string): Promise<void> {
    const result = await this.pool.query(
      `select count(*)::int as criterion_count from criteria where project_id = $1`,
      [projectId]
    );
    const criterionCount = Number(result.rows[0]?.criterion_count ?? 0);
    if (criterionCount > 1) throw new AmbiguousProjectSkillError(projectId, criterionCount);
  }

  private async loadSkillByVersionOrder(
    projectId: string,
    versionOrderBy: string,
    criterionId?: string | undefined,
    requireImplicitEligibility = false
  ): Promise<Skill> {
    const result = await this.pool.query(
      `select s.*,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else s.status
              end as status,
              sv.id as version_id,
              sv.version,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else sv.status
              end as version_status,
              sv.rubric_markdown,
              sv.prompt,
              sv.model_binding,
              sv.output_schema,
              sv.golden_set_agreement,
              sv.too_strict_count,
              sv.too_lenient_count,
              sv.ambiguous_count,
              sv.known_limitations,
              sv.verdict_kind,
              sv.scalar_range,
              sv.categorical_choice_scores,
              sv.rubric_provenance,
              sv.onboarding_assurance,
              sv.regression_dataset_revision_id,
              sv.criterion_version_id as version_criterion_version_id,
              sv.created_at as version_created_at,
              sv.approved_at,
              u.name as owner_name,
              u.email as owner_email
       from skills s
       join skill_versions sv on sv.skill_id = s.id
       left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=sv.id
       left join lateral evaluator_lifecycle_head_v1(lifecycle.id) lifecycle_head on true
       left join "user" u on u.id = s.owner_user_id
       where s.project_id = $1
         ${criterionId ? "and s.criterion_id = $2" : ""}
         ${requireImplicitEligibility
           ? "and evaluator_skill_version_context_allowed_v1(s.project_id,sv.id,'implicit_production')"
           : ""}
       order by ${versionOrderBy}
       limit 1`,
      criterionId ? [projectId, criterionId] : [projectId]
    );
    const row = result.rows[0];
    if (!row) throw new NoCurrentSkillError(projectId);
    return rowToSkill(row);
  }

  async authorizeSkillVersionExecution(input: {
    projectId: string;
    skillVersionId: string;
    context: EvaluatorExecutionContext;
    resourceKind: string;
    resourceId: string;
    idempotencyKey: string;
  }): Promise<void> {
    await new PgEvaluatorLifecycleRepository(this.pool).authorizeExecution(input);
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
    return (await this.createEvalRunOnce(input)).run;
  }

  async createConvergenceEvalRun(input: CreateConvergenceEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    return this.createEvalRunOnce({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "manual",
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      items: [{ caseId: input.caseId }],
      convergenceCaseId: input.caseId
    });
  }

  async createImportedCaseEvalRun(input: CreateImportedCaseEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    return this.createEvalRunOnce({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "api_batch",
      items: [{ caseId: input.caseId }],
      ingestionCaseId: input.caseId
    });
  }

  private async createEvalRunOnce(
    input: CreateEvalRunInputDb & {
      convergenceCaseId?: string | undefined;
      ingestionCaseId?: string | undefined;
    }
  ): Promise<{ run: EvalRunDetail; created: boolean }> {
    const runId = `evr_${randomUUID()}`;
    let resolvedRunId = runId;
    let created = true;
    const createdItems = input.items.map((item) => ({
      id: `evi_${randomUUID()}`,
      caseId: item.caseId,
      datasetItemId: item.datasetItemId ?? null,
      datasetRevisionItemId: item.datasetRevisionItemId ?? null,
      clientItemId: item.clientItemId ?? null,
      contentDigest: item.contentDigest ?? null,
      status: item.status ?? "pending",
      verdictId: item.verdictId ?? null,
      expectedLabel: item.expectedLabel ?? null,
      expectedFailStep: item.expectedFailStep ?? null,
      failingStep: item.failingStep ?? null,
      resultLabel: item.resultLabel ?? null,
      cached: item.cached ?? false,
      providerMetadata: item.providerMetadata ?? null
    }));
    // totalItems counts only verdict-bearing items; skips are recorded but
    // excluded so the completion check stays `completed + failed >= total`.
    const counted = createdItems.filter((item) => item.status !== "skipped");
    const completed = counted.filter((item) => item.status === "completed");
    const agreed = completed.filter((item) => item.expectedLabel !== null && item.resultLabel === item.expectedLabel);
    const finished = completed.length >= counted.length;

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (input.datasetRevisionId) {
        const revision = await client.query(
          `select source_kind from dataset_revisions where id=$1 and project_id=$2 for key share`,
          [input.datasetRevisionId, input.projectId]
        );
        if (revision.rows[0]?.source_kind === "analysis_population") {
          throw new DatasetRevisionConflictError(
            "Analysis population revisions cannot run through the ordinary evaluation path"
          );
        }
      }
      const insertedRun = await client.query(
        `insert into eval_runs
         (id, project_id, dataset_id, dataset_revision_id, skill_version_id, trigger, status, blocking,
          total_items, completed_items, failed_items, agreed_items, created_by_user_id, finished_at,
          source_trace_test_id, source_trace_test_revision, source_trace_test_validation_id,
          source_trace_test_validation_revision, source_trace_test_case_ref,
          source_trace_test_case_id, source_trace_test_dataset_item_id, convergence_case_id, ingestion_case_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12, case when $7 = 'completed' then now() else null end,
                 $13,$14,$15,$16,$17,$18,$19,$20,$21)
         on conflict do nothing
         returning id`,
        [
          runId,
          input.projectId,
          input.datasetId ?? null,
          input.datasetRevisionId ?? null,
          input.skillVersionId,
          input.trigger,
          finished ? "completed" : "pending",
          input.blocking ?? false,
          counted.length,
          completed.length,
          agreed.length,
          input.createdByUserId ?? null,
          input.sourceTraceTest?.traceTestId ?? null,
          input.sourceTraceTest?.revision ?? null,
          input.sourceTraceTest?.validationId ?? null,
          input.sourceTraceTest?.validationRevision ?? null,
          input.sourceTraceTest?.sourceCaseRef ?? null,
          input.sourceTraceTest?.caseId ?? null,
          input.sourceTraceTest?.datasetItemId ?? null,
          input.convergenceCaseId ?? null,
          input.ingestionCaseId ?? null
        ]
      );
      if (insertedRun.rowCount === 0) {
        const existing = input.trigger === "backfill"
          ? await client.query(
              `select id from eval_runs
               where project_id = $1 and skill_version_id = $2 and trigger = 'backfill'`,
              [input.projectId, input.skillVersionId]
            )
          : input.ingestionCaseId
            ? await client.query(
                `select id from eval_runs
                 where project_id = $1 and skill_version_id = $2 and ingestion_case_id = $3`,
                [input.projectId, input.skillVersionId, input.ingestionCaseId]
              )
            : await client.query(
              `select id from eval_runs
               where project_id = $1 and skill_version_id = $2 and convergence_case_id = $3
                 and status in ('pending', 'running')`,
              [input.projectId, input.skillVersionId, input.convergenceCaseId]
            );
        if (!existing.rows[0]?.id) throw new Error("Eval run conflict could not be resolved");
        resolvedRunId = String(existing.rows[0].id);
        created = false;
      }
      for (const item of created ? createdItems : []) {
        await client.query(
          `insert into eval_run_items
           (id, eval_run_id, project_id, dataset_item_id, dataset_revision_item_id, case_id, client_item_id,
            content_digest, status, verdict_id, expected_label, expected_fail_step,
            failing_step, result_label, agreement, cached, provider_metadata, finished_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                   case when $9 <> 'pending' then now() else null end)`,
          [
            item.id,
            runId,
            input.projectId,
            item.datasetItemId,
            item.datasetRevisionItemId,
            item.caseId,
            item.clientItemId,
            item.contentDigest,
            item.status,
            item.verdictId,
            item.expectedLabel,
            item.expectedFailStep ?? null,
            item.failingStep ?? null,
            item.resultLabel,
            item.status === "completed" && item.expectedLabel ? item.resultLabel === item.expectedLabel : null,
            item.cached,
            item.providerMetadata === null ? null : JSON.stringify(item.providerMetadata)
          ]
        );
      }
      if (created && input.datasetRevisionId && finished) {
        await client.query(
          `insert into dataset_exposure_events
           (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
            subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
           values ($1,$2,$3,'development_use','development','development_run','evaluator_version',
                   $4,$5,'eval_run',$6,null,$7::jsonb,$8)
           on conflict (project_id, idempotency_key) do nothing`,
          [
            `dse_${randomUUID()}`,
            input.projectId,
            input.datasetRevisionId,
            input.skillVersionId,
            input.createdByUserId ?? null,
            runId,
            JSON.stringify({ trigger: input.trigger }),
            `eval-run:${runId}`
          ]
        );
      }
      if (created && input.trigger === "release_evidence" && finished) {
        await mintAssessmentReceiptWithClient(client, input.projectId, runId, "terminal_mint");
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const detail = await this.getEvalRunDetail(input.projectId, resolvedRunId);
    if (!detail) throw new Error(`Eval run vanished after create: ${resolvedRunId}`);
    return { run: detail, created };
  }

  async claimEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<EvalRunDispatchClaim> {
    const claimed = await this.pool.query(
      `update eval_runs
       set queue_job_id = coalesce(queue_job_id, gen_random_uuid()),
           queue_dispatch_token = $3,
           queue_dispatch_claimed_at = clock_timestamp()
       where id = $1 and project_id = $2
         and queue_dispatched_at is null
         and (queue_dispatch_token is null
              or queue_dispatch_claimed_at <= clock_timestamp() - interval '5 minutes')
       returning queue_job_id`,
      [input.evalRunId, input.projectId, input.dispatchToken]
    );
    if (claimed.rows[0]?.queue_job_id) {
      return { state: "claimed", jobId: String(claimed.rows[0].queue_job_id) };
    }
    const existing = await this.pool.query(
      `select queue_job_id, queue_dispatched_at
       from eval_runs where id = $1 and project_id = $2`,
      [input.evalRunId, input.projectId]
    );
    const row = existing.rows[0];
    return {
      state: row?.queue_dispatched_at ? "dispatched" : "busy",
      jobId: row?.queue_job_id ? String(row.queue_job_id) : null
    };
  }

  async rotateEvalRunDispatchJob(input: EvalRunDispatchInputDb): Promise<string | null> {
    const rotated = await this.pool.query(
      `update eval_runs
       set queue_job_id = gen_random_uuid()
       where id = $1 and project_id = $2
         and queue_dispatched_at is null and queue_dispatch_token = $3
       returning queue_job_id`,
      [input.evalRunId, input.projectId, input.dispatchToken]
    );
    return rotated.rows[0]?.queue_job_id ? String(rotated.rows[0].queue_job_id) : null;
  }

  async markEvalRunDispatched(input: EvalRunDispatchInputDb): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const dispatched = await client.query(
        `update eval_runs
         set queue_dispatched_at = clock_timestamp(),
             queue_dispatch_token = null,
             queue_dispatch_claimed_at = null
         where id = $1 and project_id = $2 and queue_dispatch_token = $3
         returning id`,
        [input.evalRunId, input.projectId, input.dispatchToken]
      );
      if (dispatched.rowCount === 1) {
        await client.query(
          `update eval_run_items
           set delivery_deadline_at = clock_timestamp() + interval '15 minutes'
           where eval_run_id = $1 and project_id = $2 and status = 'pending'`,
          [input.evalRunId, input.projectId]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<void> {
    await this.pool.query(
      `update eval_runs
       set queue_dispatch_token = null, queue_dispatch_claimed_at = null
       where id = $1 and project_id = $2
         and queue_dispatched_at is null and queue_dispatch_token = $3`,
      [input.evalRunId, input.projectId, input.dispatchToken]
    );
  }

  async armEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string): Promise<void> {
    await this.pool.query(
      `update eval_run_items item
       set delivery_deadline_at = clock_timestamp() + interval '15 minutes'
       from eval_runs run
       where item.eval_run_id = $2 and item.project_id = $1 and item.status = 'pending'
         and run.id = item.eval_run_id and run.project_id = item.project_id
         and run.status in ('pending', 'running')`,
      [projectId, evalRunId]
    );
  }

  async markEvalRunRunning(projectId: string, evalRunId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query(
        `update eval_runs set status = 'running', started_at = now()
         where id = $1 and project_id = $2 and status = 'pending'
         returning dataset_revision_id, skill_version_id, created_by_user_id, trigger`,
        [evalRunId, projectId]
      );
      const row = updated.rows[0];
      if (row?.dataset_revision_id) {
        await client.query(
          `insert into dataset_exposure_events
           (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
            subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
           values ($1,$2,$3,'development_use','development','development_run','evaluator_version',
                   $4,$5,'eval_run',$6,null,$7::jsonb,$8)
           on conflict (project_id, idempotency_key) do nothing`,
          [
            `dse_${randomUUID()}`,
            projectId,
            String(row.dataset_revision_id),
            String(row.skill_version_id),
            row.created_by_user_id === null || row.created_by_user_id === undefined ? null : String(row.created_by_user_id),
            evalRunId,
            JSON.stringify({ trigger: String(row.trigger) }),
            `eval-run:${evalRunId}`
          ]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listPendingEvalRunItems(projectId: string, evalRunId: string): Promise<EvalRunItem[]> {
    const result = await this.pool.query(
      `select item.* from eval_run_items item
       join eval_runs run on run.id = item.eval_run_id and run.project_id = item.project_id
       where item.eval_run_id = $1 and item.project_id = $2 and item.status = 'pending'
         and run.status in ('pending', 'running')
       order by item.created_at asc, item.id asc`,
      [evalRunId, projectId]
    );
    return result.rows.map(rowToEvalRunItem);
  }

  async listPendingEvalRunItemDispatches(projectId: string, evalRunId: string): Promise<Array<{
    item: EvalRunItem;
    jobId: string;
  }>> {
    const result = await this.pool.query(
      `update eval_run_items item
       set queue_job_id = coalesce(item.queue_job_id, gen_random_uuid())
       from eval_runs run
       where item.eval_run_id = $1 and item.project_id = $2 and item.status = 'pending'
         and run.id = item.eval_run_id and run.project_id = item.project_id
         and run.status in ('pending', 'running')
       returning item.*`,
      [evalRunId, projectId]
    );
    return result.rows
      .sort((left, right) => toIso(left.created_at).localeCompare(toIso(right.created_at)) || String(left.id).localeCompare(String(right.id)))
      .map((row) => ({ item: rowToEvalRunItem(row), jobId: String(row.queue_job_id) }));
  }

  async claimEvalRunItemExecution(input: EvalRunItemExecutionInputDb): Promise<EvalRunItemExecutionClaim> {
    const claimed = await this.pool.query(
      `update eval_run_items
       set execution_token = $4,
           execution_claimed_at = clock_timestamp(),
           provider_call_started_at = null,
           provider_call_returned_at = null
       where id = $1 and eval_run_id = $2 and project_id = $3 and status = 'pending'
         and exists (
           select 1 from eval_runs run
           where run.id = eval_run_items.eval_run_id
             and run.project_id = eval_run_items.project_id
             and run.status in ('pending', 'running')
         )
         and (execution_token is null or (
           execution_claimed_at <= clock_timestamp() - interval '15 minutes'
           and provider_call_started_at is null
         ))
       returning id`,
      [input.evalRunItemId, input.evalRunId, input.projectId, input.executionToken]
    );
    if (claimed.rowCount === 1) return { state: "claimed" };
    const current = await this.pool.query(
      `select item.status, run.status as run_status, item.execution_token,
              item.provider_call_started_at, item.provider_call_returned_at,
              item.execution_claimed_at <= clock_timestamp() - interval '15 minutes' as claim_stale
       from eval_run_items item
       join eval_runs run on run.id = item.eval_run_id and run.project_id = item.project_id
       where item.id = $1 and item.eval_run_id = $2 and item.project_id = $3`,
      [input.evalRunItemId, input.evalRunId, input.projectId]
    );
    const row = current.rows[0];
    if (!row || row.status !== "pending" || !["pending", "running"].includes(String(row.run_status))) {
      return { state: "terminal" };
    }
    if (row.provider_call_returned_at && row.execution_token) {
      return { state: "outcome_unknown", executionToken: String(row.execution_token), providerCallReturned: true };
    }
    if (row.claim_stale === true && row.provider_call_started_at && row.execution_token) {
      return { state: "outcome_unknown", executionToken: String(row.execution_token), providerCallReturned: false };
    }
    return { state: "busy" };
  }

  async claimEvalRunItemRecovery(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const claimed = await this.pool.query(
      `update eval_run_items
       set execution_token = $4,
           execution_claimed_at = clock_timestamp(),
           provider_call_started_at = null,
           provider_call_returned_at = null
       where id = $1 and eval_run_id = $2 and project_id = $3
         and status = 'pending' and execution_token is null
         and delivery_deadline_at <= clock_timestamp()
         and exists (
           select 1 from eval_runs run
           where run.id = eval_run_items.eval_run_id
             and run.project_id = eval_run_items.project_id
             and run.status in ('pending', 'running')
         )
       returning id`,
      [input.evalRunItemId, input.evalRunId, input.projectId, input.executionToken]
    );
    return claimed.rowCount === 1;
  }

  async rearmEvalRunItemDeliveryDeadline(
    projectId: string,
    evalRunId: string,
    evalRunItemId: string
  ): Promise<boolean> {
    const rearmed = await this.pool.query(
      `update eval_run_items
       set delivery_deadline_at = clock_timestamp() + interval '15 minutes'
       where id = $1 and eval_run_id = $2 and project_id = $3
         and status = 'pending' and execution_token is null
         and delivery_deadline_at <= clock_timestamp()
         and exists (
           select 1 from eval_runs run
           where run.id = eval_run_items.eval_run_id
             and run.project_id = eval_run_items.project_id
             and run.status in ('pending', 'running')
         )
       returning id`,
      [evalRunItemId, evalRunId, projectId]
    );
    return rearmed.rowCount === 1;
  }

  async beginEvalRunItemProviderCall(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const started = await this.pool.query(
      `update eval_run_items set provider_call_started_at = clock_timestamp()
       where id = $1 and eval_run_id = $2 and project_id = $3
         and status = 'pending' and execution_token = $4
         and provider_call_started_at is null
         and exists (
           select 1 from eval_runs run
           where run.id = eval_run_items.eval_run_id
             and run.project_id = eval_run_items.project_id
             and run.status in ('pending', 'running')
         )
       returning id`,
      [input.evalRunItemId, input.evalRunId, input.projectId, input.executionToken]
    );
    return started.rowCount === 1;
  }

  async markEvalRunItemProviderCallReturned(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const returned = await this.pool.query(
      `update eval_run_items set provider_call_returned_at = clock_timestamp()
       where id = $1 and eval_run_id = $2 and project_id = $3
         and status = 'pending' and execution_token = $4
         and provider_call_started_at is not null and provider_call_returned_at is null
       returning id`,
      [input.evalRunItemId, input.evalRunId, input.projectId, input.executionToken]
    );
    return returned.rowCount === 1;
  }

  async releaseEvalRunItemExecution(
    input: EvalRunItemExecutionInputDb,
    options: EvalRunItemReleaseOptions = {}
  ): Promise<EvalRunItemReleaseDisposition> {
    if (!options.preservePreCallClaim) {
      const released = await this.pool.query(
        `update eval_run_items
         set execution_token = null, execution_claimed_at = null,
             provider_call_started_at = null, provider_call_returned_at = null,
             delivery_deadline_at = clock_timestamp() + interval '15 minutes'
         where id = $1 and eval_run_id = $2 and project_id = $3
           and status = 'pending' and execution_token = $4
           and provider_call_started_at is null`,
        [input.evalRunItemId, input.evalRunId, input.projectId, input.executionToken]
      );
      if (released.rowCount === 1) return { state: "released" };
    }
    const current = await this.pool.query(
      `select provider_call_started_at, provider_call_returned_at
       from eval_run_items
       where id = $1 and eval_run_id = $2 and project_id = $3
         and status = 'pending' and execution_token = $4`,
      [input.evalRunItemId, input.evalRunId, input.projectId, input.executionToken]
    );
    const row = current.rows[0];
    if (row?.provider_call_started_at) {
      return { state: "provider_started", providerCallReturned: Boolean(row.provider_call_returned_at) };
    }
    if (row) return { state: "pre_call_held" };
    return { state: "lost" };
  }

  async listStaleEvalRunItemExecutions(): Promise<StaleEvalRunItemExecution[]> {
    const result = await this.pool.query(
      `select item.project_id, item.eval_run_id, item.id, item.execution_token,
              item.provider_call_started_at is not null as provider_call_started,
              item.provider_call_returned_at is not null as provider_call_returned
       from eval_run_items item
       join eval_runs run on run.id = item.eval_run_id and run.project_id = item.project_id
       where item.status = 'pending'
         and run.status in ('pending', 'running')
         and ((item.execution_token is not null
               and item.execution_claimed_at <= clock_timestamp() - interval '15 minutes')
              or (item.execution_token is null
                  and item.delivery_deadline_at <= clock_timestamp()))
       order by coalesce(item.execution_claimed_at, item.delivery_deadline_at), item.id`,
    );
    return result.rows.map((row) => ({
      projectId: String(row.project_id),
      evalRunId: String(row.eval_run_id),
      evalRunItemId: String(row.id),
      executionToken: row.execution_token === null || row.execution_token === undefined
        ? null
        : String(row.execution_token),
      providerCallStarted: row.provider_call_started === true,
      providerCallReturned: row.provider_call_returned === true
    }));
  }

  async getEvalRunItem(projectId: string, evalRunId: string, evalRunItemId: string): Promise<EvalRunItem | null> {
    const result = await this.pool.query(
      `select * from eval_run_items where id = $1 and eval_run_id = $2 and project_id = $3`,
      [evalRunItemId, evalRunId, projectId]
    );
    const row = result.rows[0];
    return row ? rowToEvalRunItem(row) : null;
  }

  async completeEvalRunItem(input: CompleteEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Status guard makes queue-retry replays count nothing: a non-pending
      // item updates zero rows and we skip the counter bump entirely.
      const itemResult = await client.query(
        `update eval_run_items
         set status = 'completed',
             verdict_id = $4,
             result_label = $5,
             agreement = case when expected_label is not null then expected_label = $5 else null end,
             failing_step = $7,
             input_tokens = $8,
             output_tokens = $9,
             provider_metadata = $10,
             latency_ms = $6,
             execution_token = null,
             execution_claimed_at = null,
             provider_call_started_at = null,
             provider_call_returned_at = null,
             delivery_deadline_at = null,
             finished_at = now()
         where id = $1 and eval_run_id = $2 and project_id = $3 and status = 'pending'
           and ($11::text is null or execution_token = $11)
           and exists (
             select 1 from eval_runs run
             where run.id = eval_run_items.eval_run_id
               and run.project_id = eval_run_items.project_id
               and run.status in ('pending', 'running')
           )
         returning agreement`,
        [input.evalRunItemId, input.evalRunId, input.projectId, input.verdictId, input.resultLabel, input.latencyMs ?? null, input.failingStep ?? null, input.inputTokens ?? null, input.outputTokens ?? null, JSON.stringify(input.providerMetadata ?? {
          model: null,
          requestId: null,
          responseId: null,
          systemFingerprint: null
        }), input.executionToken ?? null]
      );
      const itemRow = itemResult.rows[0];
      if (!itemRow) {
        await client.query("rollback");
        const run = await this.getEvalRun(input.projectId, input.evalRunId);
        return { runFinished: run !== null && run.status !== "pending" && run.status !== "running" };
      }
      const runFinished = await bumpEvalRunCounters(client, input.projectId, input.evalRunId, {
        completed: 1,
        agreed: itemRow.agreement === true ? 1 : 0,
        failed: 0,
        error: null
      });
      if (runFinished) {
        const terminalRun = await client.query(
          `select trigger from eval_runs where id = $1 and project_id = $2`,
          [input.evalRunId, input.projectId]
        );
        if (terminalRun.rows[0]?.trigger === "release_evidence") {
          await mintAssessmentReceiptWithClient(client, input.projectId, input.evalRunId, "terminal_mint");
        }
      }
      await client.query("commit");
      return { runFinished };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async failEvalRunItem(input: FailEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const itemResult = await client.query(
        `update eval_run_items
         set status = 'failed', error = $4, execution_token = null,
             execution_claimed_at = null, provider_call_started_at = null,
             provider_call_returned_at = null, delivery_deadline_at = null,
             finished_at = now()
         where id = $1 and eval_run_id = $2 and project_id = $3 and status = 'pending'
           and ($5::text is null or execution_token = $5)
           and exists (
             select 1 from eval_runs run
             where run.id = eval_run_items.eval_run_id
               and run.project_id = eval_run_items.project_id
               and run.status in ('pending', 'running')
           )
         returning id`,
        [input.evalRunItemId, input.evalRunId, input.projectId, input.error, input.executionToken ?? null]
      );
      if (!itemResult.rows[0]) {
        await client.query("rollback");
        const run = await this.getEvalRun(input.projectId, input.evalRunId);
        return { runFinished: run !== null && run.status !== "pending" && run.status !== "running" };
      }
      const runFinished = await bumpEvalRunCounters(client, input.projectId, input.evalRunId, {
        completed: 0,
        agreed: 0,
        failed: 1,
        error: input.error
      });
      if (runFinished) {
        const terminalRun = await client.query(
          `select trigger from eval_runs where id = $1 and project_id = $2`,
          [input.evalRunId, input.projectId]
        );
        if (terminalRun.rows[0]?.trigger === "release_evidence") {
          await mintAssessmentReceiptWithClient(client, input.projectId, input.evalRunId, "terminal_mint");
        }
      }
      await client.query("commit");
      return { runFinished };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEvalRun(projectId: string, evalRunId: string): Promise<EvalRun | null> {
    const result = await this.pool.query(
      `select * from eval_runs where id = $1 and project_id = $2`,
      [evalRunId, projectId]
    );
    const row = result.rows[0];
    return row ? rowToEvalRun(row) : null;
  }

  async getEvalRunDetail(projectId: string, evalRunId: string): Promise<EvalRunDetail | null> {
    const run = await this.getEvalRun(projectId, evalRunId);
    if (!run) return null;
    const items = await this.pool.query(
      `select * from eval_run_items where eval_run_id = $1 order by created_at asc, id asc`,
      [evalRunId]
    );
    const mapped = items.rows.map(rowToEvalRunItem);
    return { ...run, items: mapped, spend: computeEvalRunSpend(mapped) };
  }

  async listEvalRuns(
    projectId: string,
    opts?: { limit?: number | undefined; skillVersionId?: string | undefined }
  ): Promise<EvalRun[]> {
    const result = await this.pool.query(
      `select * from eval_runs
       where project_id = $1
         and ($2::text is null or skill_version_id = $2)
       order by created_at desc, id desc
       limit $3`,
      [projectId, opts?.skillVersionId ?? null, opts?.limit ?? 50]
    );
    return result.rows.map(rowToEvalRun);
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
    // Guarded delete: only a never-dispatched run (still pending, nothing
    // judged or failed) is removable — items cascade, verdicts cannot exist
    // for a run that never fanned out, so append-only history is untouched.
    await this.pool.query(
      `delete from eval_runs
       where id = $1 and project_id = $2 and status = 'pending'
         and completed_items = 0 and failed_items = 0`,
      [evalRunId, projectId]
    );
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
    const result = await this.pool.query(
      `select version.*,
              case lifecycle_head.state
                when 'candidate' then 'calibrating'
                when 'active' then 'production'
                when 'needs_review' then 'needs_review'
                when 'retired' then 'deprecated'
                else version.status
              end as status
       from skill_versions version
       left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
       left join lateral evaluator_lifecycle_head_v1(lifecycle.id) lifecycle_head on true
       where version.project_id = $1 and version.skill_id = $2
       order by version.created_at desc
       limit $3`,
      [projectId, skillId, limit]
    );
    return result.rows.map(rowToSkillVersion);
  }

  async signOffSkillVersion(
    projectId: string,
    skillId: string,
    versionId: string,
    context: { actorUserId?: string | undefined }
  ): Promise<SkillVersion | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Serialize starter sign-off with agent bootstrap and normal version
      // creation. Whichever locks the project/skill first becomes the first
      // real configuration; the later operation observes is_starter=false.
      const locked = await client.query(
        `select sv.status, sv.approved_at
         from skills s
         join projects p on p.id = s.project_id
         join skill_versions sv on sv.skill_id = s.id
         where s.id = $1 and s.project_id = $2 and sv.id = $3
         for update of s, p, sv`,
        [skillId, projectId, versionId]
      );
      if (!locked.rows[0]) {
        await client.query("rollback");
        return null;
      }
      if (locked.rows[0].status !== "draft" || locked.rows[0].approved_at !== null) {
        throw new SkillVersionNotSignableError(versionId, String(locked.rows[0].status));
      }
      const updated = await client.query(
        `update skill_versions
         set status = 'approved', approved_at = now()
         where id = $1 and project_id = $2 and status = 'draft' and approved_at is null
         returning *`,
        [versionId, projectId]
      );
      if (!updated.rows[0]) {
        // Lost a race with a concurrent sign-off or edit — surface as not-signable.
        await client.query("rollback");
        throw new SkillVersionNotSignableError(versionId, "concurrently changed");
      }
      await client.query(`update skills set is_starter = false where id = $1 and project_id = $2`, [skillId, projectId]);
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          projectId,
          context.actorUserId ?? null,
          "skill_version.signoff",
          "skill_version",
          versionId,
          JSON.stringify({ signedOffAsIs: true })
        ]
      );
      await client.query("commit");
      return rowToSkillVersion(updated.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRegressionRunForVersion(projectId: string, skillVersionId: string): Promise<RegressionRunResult | null> {
    const result = await this.pool.query(
      `select * from regression_runs
       where project_id = $1 and skill_version_id = $2
       order by created_at desc
       limit 1`,
      [projectId, skillVersionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return rowToRegressionRun(row);
  }

  async listRegressionRunsForVersions(projectId: string, skillVersionIds: string[]): Promise<RegressionRunResult[]> {
    if (skillVersionIds.length === 0) return [];
    const result = await this.pool.query(
      `select distinct on (skill_version_id) *
       from regression_runs
       where project_id = $1 and skill_version_id = any($2::text[])
       order by skill_version_id, created_at desc`,
      [projectId, skillVersionIds]
    );
    return result.rows.map(rowToRegressionRun);
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

  // Sync path (demo / no-queue): pending insert + inline gate. The queue path
  // calls the two halves separately (route inserts pending + enqueues gate.run;
  // the worker runs the gate) — M0 C5a.
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
      projectId: context.projectId,
      skillVersionId: version.id,
      datasetRevisionId,
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
      ...(context.actorUserId ? { actorUserId: context.actorUserId } : {}),
      timeScope: input.timeScope
    });
  }

  // Inserts the version in `calibrating` with no regression run. The strict
  // provider refusal runs HERE so a 503 never leaves a pending row behind.
  async createSkillVersionPending(skillId: string, input: CreateSkillVersionInput, context: CreateSkillVersionContext): Promise<SkillVersion> {
    const submitProvider = input.modelBinding.provider;
    const suppliedCredential = context.agentSetup?.providerCredential;
    const submitKey = suppliedCredential && suppliedCredential.provider === submitProvider
      ? suppliedCredential.apiKey
      : submitProvider && submitProvider !== "mock"
        ? await this.getJudgeProviderCredential(context.projectId, submitProvider)
        : null;
    const judgeProvider = this.judgeProviderFactory(input.modelBinding, submitKey ? { apiKey: submitKey } : undefined);
    if (submitProvider !== "mock" && judgeProvider.name === "mock") {
      throw new RegressionGateUnavailableError(input.modelBinding.provider);
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // The project and skill rows are the shared serialization point for
      // human edits, sign-off, imports (which update the project counter), and
      // paired bootstrap. This closes the check-then-create race.
      const locked = await client.query(
        `select s.is_starter, s.criterion_id, p.imported_trace_count
         from skills s
         join projects p on p.id = s.project_id
         where s.id = $1 and s.project_id = $2
         for update of s, p`,
        [skillId, context.projectId]
      );
      if (!locked.rows[0]) throw new Error(`Skill not found for project: ${skillId}`);

      if (context.onboardingCriterion) {
        const replay = (await client.query(
          `select id, onboarding_request_digest
           from skill_versions
           where project_id = $1 and skill_id = $2 and onboarding_idempotency_key = $3`,
          [context.projectId, skillId, context.onboardingCriterion.idempotencyKey]
        )).rows[0];
        if (replay) {
          if (String(replay.onboarding_request_digest) !== context.onboardingCriterion.requestDigest) {
            throw new OnboardingCheckConflictError(
              "idempotency_conflict",
              "This first-Check request key was already used with different proposal content."
            );
          }
          await client.query("commit");
          const existing = await this.getSkillVersion(context.projectId, String(replay.id));
          if (!existing) throw new Error(`Onboarding Check version not found: ${String(replay.id)}`);
          return existing;
        }
      }

      if (context.agentSetup?.pairingId) {
        const pairing = await client.query(
          `select id
           from agent_setup_pairings
           where id = $1 and project_id = $2
             and claimed_at is not null and consumed_at is null and revoked_at is null
           for update`,
          [context.agentSetup.pairingId, context.projectId]
        );
        if (!pairing.rowCount) {
          throw new AgentSetupEligibilityError("pairing_no_longer_active", "This setup connection is no longer active.");
        }
        if (!locked.rows[0].is_starter) {
          throw new AgentSetupEligibilityError(
            "project_already_configured",
            "This project's judging skill was configured while the connection was outstanding."
          );
        }
        if (Number(locked.rows[0].imported_trace_count ?? 0) > 0) {
          throw new AgentSetupEligibilityError(
            "project_not_empty",
            "The paired project already has imported cases. Finish setup in the app instead."
          );
        }
      }

      // Bind the evaluator to an immutable regression corpus before it is
      // persisted or queued. Golden-set edits after this point may advance
      // the criterion pointer, but can never change this version's gate input.
      const lockedCriterion = await client.query(
        `select id, source_kind from criteria where project_id = $1 and id = $2 for update`,
        [context.projectId, String(locked.rows[0].criterion_id)]
      );
      if (!lockedCriterion.rows[0]) {
        throw new DatasetRevisionConflictError(`Skill ${skillId} has no criterion.`);
      }

      let criterionVersionId: string;
      if (context.onboardingCriterion) {
        if (!locked.rows[0].is_starter) {
          throw new OnboardingCheckConflictError(
            "project_already_configured",
            "This project's starter Check has already been configured."
          );
        }
        if (String(lockedCriterion.rows[0].source_kind) !== "native") {
          throw new OnboardingCheckConflictError(
            "criterion_not_native",
            "Guided onboarding can configure only the project's native starter criterion."
          );
        }
        if (input.criterionVersionId) {
          throw new DatasetRevisionConflictError(
            "Guided onboarding creates and binds its own criterion version."
          );
        }
        const criterionId = String(locked.rows[0].criterion_id);
        const revision = Number((await client.query(
          `select coalesce(max(revision), 0)::int + 1 as revision
           from criterion_versions where project_id = $1 and criterion_id = $2`,
          [context.projectId, criterionId]
        )).rows[0]?.revision ?? 1);
        criterionVersionId = `criterionv_${randomUUID()}`;
        const criterionDigest = evaluatorSuiteCriterionDigest({
          criterionId,
          criterionVersionId,
          criterionName: context.onboardingCriterion.name,
          criterionDefinition: context.onboardingCriterion.definition
        });
        await client.query(
          `insert into criterion_versions
            (id, project_id, criterion_id, revision, name, definition,
             criterion_digest, source_kind, created_by_user_id)
           values ($1, $2, $3, $4, $5, $6, $7, 'native', $8)`,
          [
            criterionVersionId,
            context.projectId,
            criterionId,
            revision,
            context.onboardingCriterion.name,
            context.onboardingCriterion.definition,
            criterionDigest,
            context.actorUserId ?? null
          ]
        );
      } else {
        if (!input.criterionVersionId) {
          const definitionCount = Number((await client.query(
            `select count(*)::int as count
             from criterion_versions
             where project_id = $1 and criterion_id = $2`,
            [context.projectId, String(locked.rows[0].criterion_id)]
          )).rows[0]?.count ?? 0);
          if (definitionCount > 1) {
            throw new DatasetRevisionConflictError(
              "Criteria with multiple immutable definitions require an explicit criterionVersionId when creating an evaluator version."
            );
          }
        }
        const criterionVersion = (await client.query(
          `select id from criterion_versions
           where project_id = $1 and criterion_id = $2
             and ($3::text is null or id = $3)
           order by revision desc, id desc
           limit 1`,
          [context.projectId, String(locked.rows[0].criterion_id), input.criterionVersionId ?? null]
        )).rows[0];
        if (!criterionVersion) {
          throw new DatasetRevisionConflictError(
            `Skill ${skillId} does not own criterion version ${input.criterionVersionId ?? "(latest)"}.`
          );
        }
        criterionVersionId = String(criterionVersion.id);
      }
      const regressionDatasetRevisionId = await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        context.projectId,
        criterionVersionId,
        context.actorUserId
      );

      const version: SkillVersion = {
        id: `skillv_${randomUUID()}`,
        skillId,
        criterionVersionId,
        version: await nextVersion(client, skillId),
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
        rubricProvenance: context.rubricProvenance ?? "human-authored",
        onboardingAssurance: context.onboardingCriterion || context.agentSetup
          ? "starter_unvalidated"
          : (await client.query(
              `select onboarding_assurance
               from skill_versions
               where project_id = $1 and skill_id = $2 and onboarding_assurance is not null
               order by created_at desc, id desc limit 1`,
              [context.projectId, skillId]
            )).rows[0]?.onboarding_assurance ?? null,
        regressionDatasetRevisionId,
        createdAt: new Date().toISOString(),
        approvedAt: null
      };

      if (context.agentSetup?.providerCredential) {
        const credential = context.agentSetup.providerCredential;
        await setJudgeProviderKeyOnClient(
          client,
          context.projectId,
          credential.provider,
          credential.apiKey,
          context.actorUserId
        );
      }
      await insertSkillVersion(
        client,
        version,
        context.projectId,
        criterionVersionId,
        context.actorUserId ?? null,
        context.onboardingCriterion
          ? {
              idempotencyKey: context.onboardingCriterion.idempotencyKey,
              requestDigest: context.onboardingCriterion.requestDigest
            }
          : undefined
      );
      await client.query(
        `update skills
         set is_starter = false,
             name = coalesce($3, name),
             description = coalesce($4, description)
         where id = $1 and project_id = $2`,
        [
          skillId,
          context.projectId,
          context.onboardingCriterion?.name ?? context.agentSetup?.skillName ?? null,
          context.onboardingCriterion?.definition ?? context.agentSetup?.skillDescription ?? null
        ]
      );
      if (context.agentSetup?.pairingId) {
        const consumed = await client.query(
          `update agent_setup_pairings
           set consumed_at = now(), claimed_at = null
           where id = $1 and project_id = $2
             and consumed_at is null and revoked_at is null and claimed_at is not null`,
          [context.agentSetup.pairingId, context.projectId]
        );
        if (!consumed.rowCount) {
          throw new AgentSetupEligibilityError("pairing_no_longer_active", "This setup connection is no longer active.");
        }
      }
      await client.query("commit");
      return version;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // Executes the golden-set regression gate for a pending version and persists
  // the outcome (status transition + regression run + override audit) in one
  // transaction. Called by the gate.run worker (async path) and by
  // createSkillVersion (sync path).
  async runRegressionGateForVersion(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    // Queue delivery is at-least-once. Keep one provider execution in flight
    // for an exact candidate/version even when two deliveries overlap, then
    // let the loser replay the immutable terminal regression row.
    const lockClient = await this.pool.connect();
    try {
      await lockClient.query(
        `select pg_advisory_lock(hashtextextended($1, 0))`,
        [`candidate-regression:${job.projectId}:${job.skillVersionId}`]
      );
      return await this.runRegressionGateForVersionLocked(job);
    } finally {
      await lockClient.query(
        `select pg_advisory_unlock(hashtextextended($1, 0))`,
        [`candidate-regression:${job.projectId}:${job.skillVersionId}`]
      ).catch(() => undefined);
      lockClient.release();
    }
  }

  private async runRegressionGateForVersionLocked(job: GateRunJob): Promise<{
    version: SkillVersion;
    regressionRun: RegressionRunResult;
  }> {
    const version = await this.getSkillVersion(job.projectId, job.skillVersionId);
    if (!version) throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
    const criterionVersionId = String((await this.pool.query(
      `select criterion_version_id from skill_versions where project_id = $1 and id = $2`,
      [job.projectId, job.skillVersionId]
    )).rows[0]?.criterion_version_id ?? "");
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError(`Skill version ${job.skillVersionId} has no criterion binding.`);
    }

    const datasetRevisionId = version.regressionDatasetRevisionId;
    if (!datasetRevisionId) {
      throw new DatasetRevisionConflictError(
        `Skill version ${version.id} has no immutable regression dataset binding.`,
      );
    }
    if (job.datasetRevisionId !== datasetRevisionId) {
      throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
    }
    const existingRun = await this.getRegressionRunForVersion(job.projectId, version.id);
    if (existingRun) {
      if (existingRun.datasetRevisionId !== datasetRevisionId) {
        throw new DatasetRevisionConflictError(
          `Existing regression evidence for ${version.id} does not match its pinned revision.`
        );
      }
      return { version, regressionRun: existingRun };
    }
    await this.authorizeSkillVersionExecution({
      projectId: job.projectId,
      skillVersionId: version.id,
      context: "candidate_regression_evidence",
      resourceKind: "regression_revision",
      resourceId: datasetRevisionId,
      idempotencyKey: `provider-start:candidate-regression:${version.id}:${datasetRevisionId}`
    });
    const revision = await this.getDatasetRevisionDetail(job.projectId, datasetRevisionId);
    if (!revision || revision.role !== "regression_golden") {
      throw new Error(`Pinned regression dataset revision is unavailable: ${datasetRevisionId}`);
    }
    const goldenSet: GoldenSetEntry[] = revision.items.map((item) => {
      if (!item.referenceLabel) {
        throw new DatasetRevisionConflictError(
          `Regression revision item ${item.id} has no reference label`
        );
      }
      const caseId = item.sourceCaseId ?? item.id;
      return {
        id: item.sourceGoldenEntryId ?? item.id,
        caseId,
        traceId: item.sourceTraceId ?? caseId,
        agreedLabel: item.referenceLabel,
        reason: item.note ?? "Frozen regression case.",
        promotedBy: "Frozen regression revision",
        promotedAt: item.createdAt,
        sourceSkillVersionId: version.id,
        criterionVersionId
      };
    });
    const traces = new Map(revision.items.map((item) => {
      const caseId = item.sourceCaseId ?? item.id;
      return [caseId, {
        id: item.sourceTraceId ?? caseId,
        input: item.payloadSnapshot.input,
        output: item.payloadSnapshot.output,
        metadata: item.payloadSnapshot.metadata,
        ...(item.payloadSnapshot.steps ? { steps: item.payloadSnapshot.steps } : {})
      } satisfies Trace] as const;
    }));
    // prior-version comparison — the most recent version EXCLUDING the
    // pending one under gate (which is already inserted by now).
    const priorVersionId = await this.latestVersionId(
      version.skillId,
      criterionVersionId,
      version.id
    );
    const priorRun = priorVersionId
      ? await this.getRegressionRunForVersion(job.projectId, priorVersionId)
      : null;
    // The gate must re-judge with the provider the version actually pins —
    // never the mock fallback (see createSkillVersionPending, which refuses at
    // submit time; this re-check covers env changes between enqueue and run).
    const gateProvider = version.modelBinding.provider;
    const gateKey = gateProvider !== "mock"
      ? await this.getJudgeProviderCredential(job.projectId, gateProvider)
      : null;
    const judgeProvider = this.judgeProviderFactory(version.modelBinding, gateKey ? { apiKey: gateKey } : undefined);
    if (gateProvider !== "mock" && judgeProvider.name === "mock") {
      throw new RegressionGateUnavailableError(version.modelBinding.provider);
    }
    const computedRegressionRun = await runGoldenSetRegression({
      skillVersion: version,
      goldenSet,
      traces,
      overrideReason: job.overrideReason,
      actorUserId: job.actorUserId,
      judgeProvider,
      previousVerdicts: previousVerdictsFromRun(priorRun)
    });
    const regressionRun: RegressionRunResult = {
      ...computedRegressionRun,
      datasetRevisionId
    };

    version.status = regressionRun.status === "blocked" ? "regressing" : "approved";
    version.goldenSetAgreement = regressionRun.compared === 0 ? null : (regressionRun.compared - regressionRun.regressed) / regressionRun.compared;
    const directions = regressionDirectionCounts(regressionRun.cases);
    version.tooStrictCount = directions.tooStrict;
    version.tooLenientCount = directions.tooLenient;
    version.ambiguousCount = directions.ambiguous;
    version.knownLimitations = regressionRun.goldenSetMissing
      ? ["no golden-set cases are available; regression gate is advisory only"]
      : regressionRun.regressed > 0
        ? ["regressed on one or more golden-set cases"]
        : [];
    version.approvedAt = regressionRun.status === "blocked" ? null : new Date().toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update skill_versions
         set status = $3, golden_set_agreement = $4, too_strict_count = $5,
             too_lenient_count = $6, ambiguous_count = $7, known_limitations = $8,
             approved_at = $9
         where id = $1 and project_id = $2`,
        [
          version.id,
          job.projectId,
          version.status,
          version.goldenSetAgreement,
          version.tooStrictCount,
          version.tooLenientCount,
          version.ambiguousCount,
          version.knownLimitations,
          version.approvedAt
        ]
      );
      await insertRegressionRun(client, regressionRun, { projectId: job.projectId, actorUserId: job.actorUserId });
      await client.query(
        `insert into dataset_exposure_events
         (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
          subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
         values ($1,$2,$3,'evaluator_execution','development','regression_run','evaluator_version',
                 $4,$5,'regression_run',$6,null,'{}'::jsonb,$7)
         on conflict (project_id, idempotency_key) do nothing`,
        [
          `dse_${randomUUID()}`,
          job.projectId,
          datasetRevisionId,
          version.id,
          job.actorUserId ?? null,
          regressionRun.id,
          `regression-run:${regressionRun.id}`
        ]
      );
      if (regressionRun.overrideReason) {
        await client.query(
          `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            `audit_${randomUUID()}`,
            job.projectId,
            job.actorUserId ?? null,
            "skill_version.override",
            "skill_version",
            version.id,
            JSON.stringify({ overrideReason: regressionRun.overrideReason })
          ]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    return { version, regressionRun };
  }

  async failRegressionGateForVersion(job: GateRunJob, error: unknown): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query(
        `select status, regression_dataset_revision_id from skill_versions
         where id = $1 and project_id = $2
         for update`,
        [job.skillVersionId, job.projectId]
      );
      if (!locked.rows[0]) {
        throw new Error(`Skill version not found for gate job: ${job.skillVersionId}`);
      }
      // Idempotency: a late/replayed finalizer cannot replace a successful,
      // blocked, overridden, or already-failed outcome.
      if (String(locked.rows[0].status) !== "calibrating") {
        await client.query("commit");
        return;
      }

      const message = gateFailureMessage(error);
      const rawDatasetRevisionId = locked.rows[0].regression_dataset_revision_id;
      if (rawDatasetRevisionId === null || rawDatasetRevisionId === undefined) {
        throw new DatasetRevisionConflictError(
          `Calibrating skill version ${job.skillVersionId} has no immutable regression dataset binding.`,
        );
      }
      const datasetRevisionId = String(rawDatasetRevisionId);
      if (job.datasetRevisionId !== datasetRevisionId) {
        throw new GateRunBindingMismatchError(job.datasetRevisionId, datasetRevisionId);
      }
      const regressionRunId = `reg_${randomUUID()}`;
      await client.query(
        `update skill_versions
         set status = 'failed', golden_set_agreement = null,
             too_strict_count = 0, too_lenient_count = 0, ambiguous_count = 0,
             known_limitations = $3, approved_at = null
         where id = $1 and project_id = $2`,
        [job.skillVersionId, job.projectId, [`regression gate failed: ${message}`]]
      );
      await insertRegressionRun(client, {
        id: regressionRunId,
        skillVersionId: job.skillVersionId,
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
      }, { projectId: job.projectId, actorUserId: job.actorUserId });
      await client.query(
          `insert into dataset_exposure_events
           (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
            subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
           values ($1,$2,$3,'evaluator_execution','development','regression_run','evaluator_version',
                   $4,$5,'regression_run',$6,$7,'{}'::jsonb,$8)
           on conflict (project_id, idempotency_key) do nothing`,
          [
            `dse_${randomUUID()}`,
            job.projectId,
            datasetRevisionId,
            job.skillVersionId,
            job.actorUserId ?? null,
            regressionRunId,
            message,
            `regression-run:${regressionRunId}`
          ]
        );
      await client.query("commit");
    } catch (failure) {
      await client.query("rollback").catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  }

  async listAuditEntries(projectId: string, targetType: string, targetId: string): Promise<JudgeCardAuditEntry[]> {
    return this.caseEvidenceRepository.listAuditEntries(projectId, targetType, targetId);
  }

  private async listExceptionCases(projectId: string, criterionVersionId?: string | undefined): Promise<ExceptionCase[]> {
    return this.caseEvidenceRepository.listExceptionCases(projectId, criterionVersionId);
  }

  // the most recent existing version's id (before the new insert), for
  // prior-version comparison. Null when this is the skill's first version.
  // Deliberately status-blind: the baseline is the previous ATTEMPT, blocked
  // or not — the same version the editor seeds from (getLatestSkill). The
  // gate's "improved/flipped" answers "did this edit fix what the last
  // attempt got wrong", not "is this better than production".
  private async latestVersionId(
    skillId: string,
    criterionVersionId: string,
    excludeVersionId?: string
  ): Promise<string | null> {
    // excludeVersionId: the pending version under gate is already inserted —
    // prior-version comparison must skip it (M0 C5a).
    const result = await this.pool.query(
      `select id from skill_versions
       where skill_id = $1 and criterion_version_id = $2
         and ($3::text is null or id <> $3)
       order by created_at desc, id desc
       limit 1`,
      [skillId, criterionVersionId, excludeVersionId ?? null]
    );
    return result.rows[0]?.id ? String(result.rows[0].id) : null;
  }
}
