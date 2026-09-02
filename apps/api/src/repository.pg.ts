import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
  DatasetReferenceProvenance,
  DatasetRevision,
  DatasetRevisionDetail,
  DatasetRevisionPayloadSnapshot,
  EvalRun,
  EvalRunDetail,
  EvalRunItem,
  GoldenSetEntry,
  ConvergenceAuditPage,
  ConvergenceCaseChange,
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
  effectiveHumanLabel,
  regressionDirectionCounts,
  verdictLabelFromPayload
} from "@coeval/shared";
import type { Trace } from "@coeval/audit/runtime";
import { createJudgeProvider, type JudgeProviderFactory } from "./lib/judge-provider.js";
import { PgEvaluatorLifecycleRepository } from "./evaluator-lifecycle/repository.pg.js";
import { redactNormalizedTracePayload, type NormalizedTracePayload, type NormalizedTraceStep } from "./lib/redaction.js";
import { evaluatorSuiteCriterionDigest } from "./lib/evaluator-suite.js";
import {
  computeEvalRunSpend,
  convergencePageLimit,
  decodeConvergenceCursor,
  encodeConvergenceCursor,
  traceTestValidationDiagnostic,
  traceTestValidationStatus,
  type ConvergenceAuditPageInput,
  type RecordTraceTestFunnelEventInputDb
} from "./repository.js";
import { computeConvergenceAudit, computeDisagreementSummary, computeJudgeHumanCalibration, computeJudgeHumanDisagreement, computeKappaSummary, computeSelfConsistency } from "./lib/kappa.js";
import { EXCEPTION_LIST_LIMIT } from "./lib/exception-rows.js";
import {
  AgentSetupEligibilityError,
  AmbiguousProjectSkillError,
  CaseNotFoundError,
  DatasetNameTakenError,
  DatasetRevisionConflictError,
  DatasetRevisionNotFoundError,
  GoldenSetLabelConflictError,
  RegressionGateUnavailableError,
  DatasetNotFoundError,
  SealedValidationUnavailableError,
  FeedbackSyncCredentialsMissingError,
  FeedbackSyncJobNotFoundError,
  GateRunBindingMismatchError,
  GoldenSetEntryAlreadyRetiredError,
  GoldenSetEntryNotFoundError,
  InvalidConvergenceCursorError,
  IronsideCredentialsMissingError,
  IronsideIntegrationAlreadyExistsError,
  IronsideIntegrationChangedError,
  IronsideIntegrationNotFoundError,
  LangfuseCredentialsMissingError,
  LangfuseIntegrationNotFoundError,
  LangSmithCredentialsMissingError,
  LangSmithIntegrationNotFoundError,
  NoCurrentSkillError,
  OnboardingCheckConflictError,
  SkillVersionNotSignableError,
  TraceTestNotFoundError,
  TraceTestRevisionConflictError,
  TraceTestSourceNotFoundError,
  TraceTestValidationNotReadyError,
  buildGoldenSetHealthSummary,
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
import {
  datasetRevisionItemDigest,
  decidePublicDatasetRevisionCreation
} from "./lib/dataset-revision.js";
import { PgApiKeyRepository } from "./repository.pg/api-key-repository.js";
import {
  bumpEvalRunCounters,
  mintAssessmentReceiptWithClient
} from "./repository.pg/assessment-receipt-commands.js";
import { PgAssessmentReceiptRepository } from "./repository.pg/assessment-receipt-repository.js";
import { setJudgeProviderKeyOnClient } from "./repository.pg/credential-commands.js";
import { PgCriterionSuiteRepository } from "./repository.pg/criterion-suite-repository.js";
import {
  getOrCreateRegressionDatasetRevisionWithClient,
  insertDatasetRevisionWithClient,
  loadHumanVerdictsForCases,
  resolveCaseInputIdentity,
  resolveSingletonCriterionVersionForRegression
} from "./repository.pg/dataset-revision-commands.js";
import { loadGoldenSetRetirementContext } from "./repository.pg/golden-commands.js";
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
import { importTraceOnClient, lockTraceImportIdentity } from "./repository.pg/trace-import-commands.js";
import { PgTraceImportRepository } from "./repository.pg/trace-import-repository.js";
import {
  gateFailureMessage,
  isCheckViolation,
  isUniqueViolation,
  normalizedPayloadSnapshot,
  parseJson,
  postgresErrorMessage,
  rowToCriterionVersion,
  rowToDataset,
  rowToDatasetExposureEvent,
  rowToDatasetItem,
  rowToDatasetRevision,
  rowToDatasetRevisionItem,
  rowToEvalRun,
  rowToEvalRunItem,
  rowToExceptionCase,
  rowToGoldenSetEntry,
  rowToJudgeRun,
  rowToRegressionRun,
  rowToSkill,
  rowToSkillVersion,
  rowToTraceTestRevision,
  rowToTraceTestSummary,
  rowToTraceTestValidation,
  rowToVerdictRecord,
  toIso
} from "./repository.pg/mappers.js";

export class PgRepository implements CoevalRepository {
  private readonly apiKeyRepository: PgApiKeyRepository;
  private readonly assessmentReceiptRepository: PgAssessmentReceiptRepository;
  private readonly criterionSuiteRepository: PgCriterionSuiteRepository;
  private readonly historicalGateEvidenceRepository: PgHistoricalGateEvidenceRepository;
  private readonly integrationRepository: PgIntegrationRepository;
  private readonly judgeCredentialRepository: PgJudgeCredentialRepository;
  private readonly judgeFeedbackRepository: PgJudgeFeedbackRepository;
  private readonly projectRepository: PgProjectRepository;
  private readonly reviewQueueRepository: PgReviewQueueRepository;
  private readonly runComparisonRepository: PgRunComparisonRepository;
  private readonly traceImportRepository: PgTraceImportRepository;

  constructor(
    private readonly pool: Pool,
    private readonly judgeProviderFactory: JudgeProviderFactory = createJudgeProvider
  ) {
    this.apiKeyRepository = new PgApiKeyRepository(pool);
    this.assessmentReceiptRepository = new PgAssessmentReceiptRepository(pool);
    this.criterionSuiteRepository = new PgCriterionSuiteRepository(pool);
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
    const resolvedCriterionVersionId = await this.resolveGoldenCriterionVersion(
      projectId,
      criterionVersionId
    );
    const result = await this.pool.query(
      `select * from golden_set_entries
       where project_id = $1 and criterion_version_id = $2 and retired_at is null
       order by promoted_at desc`,
      [projectId, resolvedCriterionVersionId]
    );
    return result.rows.map(rowToGoldenSetEntry);
  }

  async getSkillFormatExamples(
    projectId: string,
    cap: number,
    criterionVersionId?: string | undefined
  ): Promise<SkillFormatExample[]> {
    const golden = (await this.listGoldenSet(projectId, criterionVersionId)).slice(0, cap);
    if (golden.length === 0) return [];
    const traces = await this.loadGoldenSetTraces(golden);
    return golden.map((entry) => {
      const trace = traces.get(entry.caseId);
      const metadata = trace?.metadata;
      return {
        id: entry.id,
        label: entry.agreedLabel,
        input: trace?.input ?? null,
        output: trace?.output ?? null,
        reason: entry.reason,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {})
      };
    });
  }

  async getGoldenSetHealth(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<GoldenSetHealthSummary> {
    return buildGoldenSetHealthSummary(
      projectId,
      await this.listGoldenSet(projectId, criterionVersionId)
    );
  }

  async getExceptionDetail(
    projectId: string,
    caseId: string,
    skillVersionId?: string | undefined
  ): Promise<ExceptionDetail> {
    // Exceptions are non-pass cases. The detail-by-id lookup keeps the pass
    // filter so the exceptions-queue drill-down only opens genuine exceptions.
    const detail = await this.loadCaseDetail(projectId, caseId, { exceptionsOnly: true, skillVersionId });
    if (!detail) throw new Error(`Exception not found: ${caseId}`);
    return detail;
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
    return this.loadCaseDetail(projectId, caseId, { exceptionsOnly: false, skillVersionId });
  }

  private async loadCaseDetail(
    projectId: string,
    caseId: string,
    opts: { exceptionsOnly: boolean; skillVersionId?: string | undefined }
  ): Promise<ExceptionDetail | null> {
    if (!opts.skillVersionId) await this.assertSingletonCriterion(projectId);
    const result = await this.pool.query(
      `select jr.*,
              version.criterion_version_id,
              c.normalized_payload,
              rt.source_trace_id,
              rt.raw_payload
       from judge_runs jr
       join skill_versions version
         on version.id = jr.skill_version_id
        and version.project_id = jr.project_id
       join cases c on c.id = jr.case_id
       left join raw_traces rt on rt.id = c.raw_trace_id
       where jr.project_id = $1 and jr.case_id = $2
         and ($3::text is null or jr.skill_version_id = $3)
         ${opts.exceptionsOnly ? "and jr.verdict <> 'pass'" : ""}
       order by jr.created_at desc
       limit 1`,
      [projectId, caseId, opts.skillVersionId ?? null]
    );
    const row = result.rows[0];
    if (!row) return null;
    const payload = redactNormalizedTracePayload(parseJson(row.normalized_payload) as { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; steps?: NormalizedTraceStep[] });
    const judgeRun = rowToJudgeRun(row);
    const exception = rowToExceptionCase({
      ...row,
      source_trace_id: row.source_trace_id ?? row.case_id,
      normalized_payload: row.normalized_payload
    });
    // Return the append-only evaluator + human decision evidence for this case
    // and criterion so every case host can render the same durable history.
    // The recent-history query is bounded, while the second query guarantees
    // that an older effective human/owner ruling is not pushed out by many
    // evaluator re-runs. An owner adjudication still outranks ordinary human
    // reviews via effectiveHumanLabel; malformed historical rows are skipped
    // rather than making the whole case unviewable.
    const verdictResult = await this.pool.query(
      `select verdict.*, coalesce(u.name, u.email) as actor_name
       from verdicts verdict
       join skill_versions version
         on version.id = verdict.skill_version_id
        and version.project_id = verdict.project_id
       left join "user" u on u.id = verdict.actor_user_id
       where verdict.project_id = $1
         and verdict.case_id = $2
         and version.criterion_version_id = $3
         and verdict.source in ('llm_judge', 'human', 'adjudicated')
       order by verdict.created_at desc, verdict.id desc
       limit 200`,
      [projectId, caseId, String(row.criterion_version_id)]
    );
    const effectiveRulingResult = await this.pool.query(
      `select verdict.*, coalesce(u.name, u.email) as actor_name
       from verdicts verdict
       join skill_versions version
         on version.id = verdict.skill_version_id
        and version.project_id = verdict.project_id
       left join "user" u on u.id = verdict.actor_user_id
       where verdict.project_id = $1
         and verdict.case_id = $2
         and version.criterion_version_id = $3
         and verdict.source in ('human', 'adjudicated')
       order by case when verdict.source = 'adjudicated' then 0 else 1 end,
                verdict.created_at desc,
                verdict.id desc
       limit 1`,
      [projectId, caseId, String(row.criterion_version_id)]
    );
    const verdictHistoryById = new Map<string, VerdictRecord>();
    for (const verdictRow of [...verdictResult.rows, ...effectiveRulingResult.rows]) {
      try {
        const verdict = rowToVerdictRecord(verdictRow);
        verdictHistoryById.set(verdict.id, verdict);
      } catch {
        // Preserve the rest of the audit trail when one legacy row is malformed.
      }
    }
    const verdictHistory = [...verdictHistoryById.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    );
    const goldenResult = await this.pool.query(
      `select * from golden_set_entries
       where project_id = $1
         and case_id = $2
         and criterion_version_id = $3
         and retired_at is null
       order by promoted_at desc, id desc
       limit 1`,
      [projectId, caseId, String(row.criterion_version_id)]
    );
    // the case's dataset expectations (all datasets, by name — a case
    // can carry different labels in different datasets; show every one).
    const expectationsResult = await this.pool.query(
      `select d.name as dataset_name, di.expected_label, di.expected_fail_step
       from dataset_items di
       join datasets d on d.id = di.dataset_id
       where di.case_id = $1 and di.project_id = $2 and d.archived_at is null
       order by di.added_at asc, di.id asc`,
      [caseId, projectId]
    );
    const datasetExpectations = expectationsResult.rows.map((expectation) => ({
      datasetName: String(expectation.dataset_name),
      expectedLabel: expectation.expected_label ? (String(expectation.expected_label) as "pass" | "fail") : null,
      expectedFailStep: expectation.expected_fail_step === null || expectation.expected_fail_step === undefined
        ? null
        : Number(expectation.expected_fail_step)
    }));
    return {
      exception,
      trace: {
        id: String(row.source_trace_id ?? row.case_id),
        input: payload.input ?? payload,
        output: payload.output ?? payload,
        metadata: payload.metadata ?? {},
        ...(payload.steps ? { steps: payload.steps } : {})
      },
      datasetExpectations,
      judgeRun,
      latestHumanLabel: effectiveHumanLabel(verdictHistory),
      verdictHistory,
      goldenSetEntry: goldenResult.rows[0] ? rowToGoldenSetEntry(goldenResult.rows[0]) : null,
      rawRequest: row.raw_request ? parseJson(row.raw_request) : undefined,
      rawResponse: row.raw_response ? parseJson(row.raw_response) : undefined
    };
  }

  async promoteExceptionToGoldenSet(input: PromoteExceptionToGoldenSetInput): Promise<GoldenSetEntry> {
    // Any judged case is promotable, not just exceptions: a golden set with
    // only fail entries can't catch a version that starts failing good
    // answers, so judge-passed cases are legitimate pass anchors.
    const caseType = await this.pool.query(
      `select case_type from cases where id = $1 and project_id = $2`,
      [input.caseId, input.projectId]
    );
    if (caseType.rows[0]?.case_type === "release_evidence") throw new CaseNotFoundError(input.caseId);
    const detail = await this.getCaseDetail(input.projectId, input.caseId, input.skillVersionId);
    if (!detail) throw new CaseNotFoundError(input.caseId);
    // The human-outranks-judge rule is enforced HERE, not just in the web
    // form: a client-supplied label that contradicts the recorded human
    // decision must not be frozen into the golden set (nor injected into the
    // verdicts ledger as a human judgment nobody made).
    if (
      detail.latestHumanLabel &&
      detail.latestHumanLabel !== "ambiguous" &&
      detail.latestHumanLabel !== input.agreedLabel
    ) {
      throw new GoldenSetLabelConflictError(input.caseId, input.agreedLabel, detail.latestHumanLabel);
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select id from projects where id = $1 for update`, [input.projectId]);
      const criterionVersionId = String((await client.query(
        `select criterion_version_id from skill_versions where id = $1 and project_id = $2`,
        [detail.judgeRun.skillVersionId, input.projectId]
      )).rows[0]?.criterion_version_id ?? "");
      if (!criterionVersionId) {
        throw new DatasetRevisionConflictError("Judge evaluator has no immutable criterion version binding");
      }
      // A promotion IS a human judgment on the case — record it in the v2
      // verdicts ledger (source=human) so κ / calibration count it, instead of
      // the old write-only `reviews` row nothing ever read. Same payload shape
      // recordVerdict writes; kept in this transaction so a failed golden-set
      // insert can't leave a stray verdict. Deliberately does NOT complete
      // pending review-queue items — only an explicit human verdict does that.
      await client.query(
        `insert into verdicts
         (id, project_id, case_id, skill_version_id, source, actor_user_id, verdict_kind, payload, external_run_id)
         values ($1,$2,$3,$4,'human',$5,'categorical',$6,null)`,
        [
          `verdict_${randomUUID()}`,
          input.projectId,
          input.caseId,
          detail.judgeRun.skillVersionId,
          input.actorUserId ?? null,
          JSON.stringify({
            kind: "categorical",
            choice: input.agreedLabel,
            choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
            rationale: input.reason
          })
        ]
      );
      const result = await client.query(
        `insert into golden_set_entries
         (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by_user_id,
          promoted_by, source_skill_version_id, criterion_version_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (project_id, criterion_version_id, case_id) where retired_at is null
         do update set agreed_label = excluded.agreed_label,
                       reason = excluded.reason,
                       promoted_by_user_id = excluded.promoted_by_user_id,
                       promoted_by = excluded.promoted_by,
                       source_skill_version_id = excluded.source_skill_version_id,
                       promoted_at = now()
         returning *`,
        [
          `gold_${randomUUID()}`,
          input.projectId,
          input.caseId,
          detail.trace.id,
          input.agreedLabel,
          input.reason,
          input.actorUserId ?? null,
          input.actorName ?? "Reviewer",
          detail.judgeRun.skillVersionId,
          criterionVersionId
        ]
      );
      await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        input.projectId,
        criterionVersionId,
        input.actorUserId
      );
      await client.query("commit");
      return rowToGoldenSetEntry(result.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async retireGoldenSetEntry(input: RetireGoldenSetEntryInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select id from projects where id = $1 for update`, [input.projectId]);
      const result = await client.query(
        `update golden_set_entries
         set retired_at = now()
         where id = $1 and project_id = $2 and retired_at is null
         returning id, case_id, criterion_version_id`,
        [input.entryId, input.projectId]
      );
      const row = result.rows[0];
      if (!row) {
        const existing = await client.query(
          `select retired_at
           from golden_set_entries
           where id = $1 and project_id = $2`,
          [input.entryId, input.projectId]
        );
        if (existing.rows[0]?.retired_at) {
          throw new GoldenSetEntryAlreadyRetiredError(
            input.entryId,
            await loadGoldenSetRetirementContext(client, input.projectId, input.entryId)
          );
        }
        throw new GoldenSetEntryNotFoundError(input.entryId);
      }
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          input.projectId,
          input.actorUserId ?? null,
          "golden_set.retire",
          "golden_set_entry",
          input.entryId,
          JSON.stringify({
            caseId: String(row.case_id),
            ...(input.reason ? { reason: input.reason } : {})
          })
        ]
      );
      await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        input.projectId,
        String(row.criterion_version_id),
        input.actorUserId
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async importTrace(projectId: string, source: CaseSource, input: ManualTraceImportInput, context: TraceImportContext): Promise<TraceImportResult> {
    return this.traceImportRepository.importTrace(projectId, source, input, context);
  }

  // Skill Bench bulk ingestion (M0 C2): mint/dedup every example case AND its
  // dataset membership in one transaction — all-or-nothing, no orphaned cases
  // on a mid-flow failure. Items must be pre-deduped by sourceTraceId (the
  // route coalesces within-batch duplicates before calling).
  async importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Re-check the dataset INSIDE the transaction — the route's pre-check
      // can race a concurrent archive.
      const dataset = await client.query(
        `select id from datasets where id = $1 and project_id = $2 and archived_at is null for update`,
        [input.datasetId, input.projectId]
      );
      if (!dataset.rows[0]) throw new DatasetNotFoundError(input.datasetId);

      // A batch holds every import-identity lock until commit. Acquire its
      // unique identities in one canonical order so concurrent batches with
      // reversed item order cannot deadlock. importTraceOnClient reacquires
      // the same transaction lock per item, which is safe and immediate.
      const sourceTraceIds = [...new Set(input.items
        .map((item) => item.sourceTraceId.trim())
        .filter((sourceTraceId) => sourceTraceId.length > 0))]
        .sort();
      for (const sourceTraceId of sourceTraceIds) {
        await lockTraceImportIdentity(client, input.projectId, "manual", sourceTraceId);
      }

      const results: ImportDatasetExamplesDbResult["items"] = [];
      for (const item of input.items) {
        const imported = await importTraceOnClient(client, input.projectId, "manual", {
          sourceTraceId: item.sourceTraceId,
          input: item.input,
          output: item.output,
          metadata: item.metadata,
          ...(item.steps ? { steps: item.steps } : {})
        }, { ingestionPurpose: input.ingestionPurpose });
        // Same coalescing upsert as addDatasetItems (kept in sync): labels
        // update on re-import, label-less appends never null a stored label.
        const datasetItem = await client.query(
          `insert into dataset_items (id, dataset_id, project_id, case_id, trace_id, expected_label, expected_fail_step, note)
           select $1, $2, $3, c.id, coalesce(rt.source_trace_id, c.id), $5, $6, $7
           from cases c
           left join raw_traces rt on rt.id = c.raw_trace_id
           where c.id = $4 and c.project_id = $3
           on conflict (dataset_id, case_id) do update set
             expected_label = coalesce(excluded.expected_label, dataset_items.expected_label),
             expected_fail_step = case
             when excluded.expected_label = 'pass' then null
             when excluded.expected_fail_step is not null then excluded.expected_fail_step
             else dataset_items.expected_fail_step
           end,
             note = coalesce(excluded.note, dataset_items.note)
           returning id`,
          [
            `dsi_${randomUUID()}`,
            input.datasetId,
            input.projectId,
            imported.caseId,
            item.expectedLabel ?? null,
            item.expectedFailStep ?? null,
            item.note ?? null
          ]
        );
        results.push({
          sourceTraceId: imported.sourceTraceId,
          caseId: imported.caseId,
          created: imported.created,
          datasetItemId: datasetItem.rows[0] ? String(datasetItem.rows[0].id) : null
        });
      }
      await client.query("commit");
      return { items: results };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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
    if (input.externalRunId) {
      const existing = await this.pool.query(
        `select * from verdicts
         where project_id = $1 and source = 'imported_external' and external_run_id = $2
         limit 1`,
        [input.projectId, input.externalRunId]
      );
      if (existing.rows[0]) return rowToVerdictRecord(existing.rows[0]);
    }
    let skillVersionId = input.skillVersionId;
    if (input.source === "human" || input.source === "adjudicated") {
      if (skillVersionId) {
        const binding = await this.pool.query(
          `select 1
           from skill_versions evaluator
           join cases review_case on review_case.project_id = evaluator.project_id
           where evaluator.project_id = $1
             and review_case.id = $2
             and evaluator.id = $3
           limit 1`,
          [input.projectId, input.caseId, skillVersionId]
        );
        if (!binding.rowCount) throw new CaseNotFoundError(input.caseId);
      } else {
        await this.assertSingletonCriterion(input.projectId);
        const definitionCount = Number((await this.pool.query(
          `select count(*)::int as count from criterion_versions where project_id = $1`,
          [input.projectId]
        )).rows[0]?.count ?? 0);
        if (definitionCount > 1) {
          throw new AmbiguousProjectSkillError(input.projectId, definitionCount);
        }
        const binding = await this.pool.query(
          `select run.skill_version_id
           from judge_runs run
           join skill_versions version
             on version.id = run.skill_version_id
            and version.project_id = run.project_id
           where run.project_id = $1 and run.case_id = $2
           order by run.created_at desc, run.id desc
           limit 1`,
          [input.projectId, input.caseId]
        );
        if (binding.rows[0]) {
          skillVersionId = String(binding.rows[0].skill_version_id);
        } else {
          // A reviewer can label an imported case before its first judge run;
          // persist the current evaluator as an explicit immutable binding.
          skillVersionId = (await this.getCurrentSkill(input.projectId)).currentVersion.id;
        }
      }
    }
    const result = await this.pool.query(
      `insert into verdicts
       (id, project_id, case_id, skill_version_id, source, actor_user_id, verdict_kind, payload, external_run_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning *`,
      [
        `verdict_${randomUUID()}`,
        input.projectId,
        input.caseId,
        skillVersionId ?? null,
        input.source,
        input.actorUserId ?? null,
        input.payload.kind,
        JSON.stringify(input.payload),
        input.externalRunId ?? null
      ]
    );
    // a human verdict completes any pending queue items pointing at
    // this case across every queue. LLM-judge + imported_external don't count.
    // Done in a separate statement (not the same transaction) — failure here
    // shouldn't roll back the verdict insert; queue progression is best-
    // effort and recoverable.
    if (input.source === "human") {
      // scope to items unassigned OR assigned to this actor.
      // Items assigned to OTHER reviewers stay pending — they're the κ-overlap
      // partner row and must wait for that reviewer's own verdict.
      await this.pool.query(
        `update review_queue_items rqi
         set status = 'completed', completed_at = now()
         from review_queues rq
         where rqi.queue_id = rq.id
           and rq.project_id = $1
           and rqi.case_id = $2
           and rqi.status = 'pending'
           and rqi.criterion_version_id = (
             select criterion_version_id
             from skill_versions
             where id = $4 and project_id = $1
           )
           and (rqi.assigned_to_user_id is null or rqi.assigned_to_user_id = $3)`,
        [input.projectId, input.caseId, input.actorUserId ?? null, skillVersionId]
      ).catch(() => undefined);
    }
    return rowToVerdictRecord(result.rows[0]);
  }

  async listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]> {
    const result = await this.pool.query(
      `select verdict.*, coalesce(u.name, u.email) as actor_name
       from verdicts verdict
       left join "user" u on u.id = verdict.actor_user_id
       where verdict.project_id = $1
         and ($2::text is null or verdict.case_id = $2)
         and ($3::text is null or verdict.source = $3)
         and ($4::text is null or verdict.skill_version_id = $4)
         and ($5::text is null or exists (
           select 1
           from skill_versions version
           join skills skill on skill.id = version.skill_id and skill.project_id = version.project_id
           where version.id = verdict.skill_version_id
             and version.project_id = verdict.project_id
             and skill.criterion_id = $5
         ))
         and ($6::text = 'all' or exists (
           select 1 from cases verdict_case
           where verdict_case.id = verdict.case_id
             and verdict_case.project_id = verdict.project_id
             and verdict_case.case_type not in ('gate_candidate', 'release_evidence')
         ))
       order by verdict.created_at desc
       limit $7`,
      [
        input.projectId,
        input.caseId ?? null,
        input.source ?? null,
        input.skillVersionId ?? null,
        input.criterionId ?? null,
        input.evidenceScope ?? "all",
        input.limit
      ]
    );
    return result.rows.map(rowToVerdictRecord);
  }

  async caseExistsForProject(projectId: string, caseId: string): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from cases where id = $1 and project_id = $2 limit 1`,
      [caseId, projectId]
    );
    return result.rowCount !== null && result.rowCount > 0;
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
    const client = await this.pool.connect();
    const traceTestId = `tt_${randomUUID()}`;
    try {
      await client.query("begin");
      const source = await client.query(
        `select c.id, c.normalized_payload, coalesce(rt.source_trace_id, c.id) as source_trace_ref
         from cases c
         left join raw_traces rt on rt.id = c.raw_trace_id
         where c.id = $1 and c.project_id = $2`,
        [input.sourceCaseId, input.projectId]
      );
      const sourceRow = source.rows[0];
      if (!sourceRow) throw new TraceTestSourceNotFoundError(input.sourceCaseId);
      await client.query(
        `insert into trace_tests
         (id, project_id, source_case_id, source_case_ref, source_trace_ref, source_snapshot,
          source_scope, current_revision, enabled_revision, created_by_user_id)
         values ($1,$2,$3,$3,$4,$5,$6,1,null,$7)`,
        [
          traceTestId,
          input.projectId,
          input.sourceCaseId,
          String(sourceRow.source_trace_ref),
          JSON.stringify(redactNormalizedTracePayload(parseJson(sourceRow.normalized_payload) as NormalizedTracePayload)),
          JSON.stringify(input.sourceScope),
          input.createdByUserId ?? null
        ]
      );
      await client.query(
        `insert into trace_test_revisions
         (id, trace_test_id, project_id, revision, lifecycle, desired_behavior, scenario,
          expected_behavior, must_do, must_avoid, good_example, bad_example, checker,
          draft_provenance, created_by_user_id)
         values ($1,$2,$3,1,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          `ttr_${randomUUID()}`,
          traceTestId,
          input.projectId,
          input.desiredBehavior,
          input.scenario,
          input.expectedBehavior,
          JSON.stringify(input.mustDo),
          JSON.stringify(input.mustAvoid),
          JSON.stringify(input.goodExample),
          JSON.stringify(input.badExample),
          JSON.stringify(input.checker),
          JSON.stringify(input.draftProvenance),
          input.createdByUserId ?? null
        ]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const created = await this.getTraceTest(input.projectId, traceTestId);
    if (!created) throw new TraceTestNotFoundError(traceTestId);
    return created;
  }

  async listTraceTests(projectId: string, sourceCaseRef?: string): Promise<TraceTestSummary[]> {
    const result = await this.pool.query(
      `select * from trace_tests
       where project_id = $1 and ($2::text is null or source_case_ref = $2)
       order by updated_at desc, id desc`,
      [projectId, sourceCaseRef ?? null]
    );
    return result.rows.map(rowToTraceTestSummary);
  }

  async getTraceTest(projectId: string, traceTestId: string): Promise<TraceTestDetail | null> {
    const testResult = await this.pool.query(
      `select * from trace_tests where id = $1 and project_id = $2`,
      [traceTestId, projectId]
    );
    const testRow = testResult.rows[0];
    if (!testRow) return null;
    const [revisionResult, validationResult] = await Promise.all([
      this.pool.query(
        `select * from trace_test_revisions
         where trace_test_id = $1 and project_id = $2
         order by revision asc`,
        [traceTestId, projectId]
      ),
      this.pool.query(
        `select * from trace_test_validations
         where trace_test_id = $1 and project_id = $2
         order by created_at asc, id asc`,
        [traceTestId, projectId]
      )
    ]);
    return {
      ...rowToTraceTestSummary(testRow),
      sourceSnapshot: parseJson(testRow.source_snapshot),
      sourceScope: parseJson(testRow.source_scope) as TraceTestDetail["sourceScope"],
      createdByUserId: testRow.created_by_user_id ? String(testRow.created_by_user_id) : null,
      revisions: revisionResult.rows.map(rowToTraceTestRevision),
      validations: validationResult.rows.map(rowToTraceTestValidation)
    };
  }

  async reviseTraceTest(input: ReviseTraceTestInputDb): Promise<TraceTestDetail> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query(
        `select current_revision from trace_tests where id = $1 and project_id = $2 for update`,
        [input.traceTestId, input.projectId]
      );
      if (!locked.rows[0]) throw new TraceTestNotFoundError(input.traceTestId);
      const currentRevision = Number(locked.rows[0].current_revision);
      if (currentRevision !== input.expectedRevision) {
        throw new TraceTestRevisionConflictError(input.expectedRevision, currentRevision);
      }
      const revision = currentRevision + 1;
      await client.query(
        `insert into trace_test_revisions
         (id, trace_test_id, project_id, revision, lifecycle, desired_behavior, scenario,
          expected_behavior, must_do, must_avoid, good_example, bad_example, checker,
          draft_provenance, created_by_user_id)
         values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          `ttr_${randomUUID()}`,
          input.traceTestId,
          input.projectId,
          revision,
          input.desiredBehavior,
          input.scenario,
          input.expectedBehavior,
          JSON.stringify(input.mustDo),
          JSON.stringify(input.mustAvoid),
          JSON.stringify(input.goodExample),
          JSON.stringify(input.badExample),
          JSON.stringify(input.checker),
          JSON.stringify(input.draftProvenance),
          input.createdByUserId ?? null
        ]
      );
      await client.query(
        `update trace_tests set current_revision = $3, updated_at = now()
         where id = $1 and project_id = $2`,
        [input.traceTestId, input.projectId, revision]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const revised = await this.getTraceTest(input.projectId, input.traceTestId);
    if (!revised) throw new TraceTestNotFoundError(input.traceTestId);
    return revised;
  }

  async recordTraceTestValidation(input: RecordTraceTestValidationInputDb): Promise<TraceTestValidation> {
    const client = await this.pool.connect();
    const validationId = `ttv_${randomUUID()}`;
    try {
      await client.query("begin");
      const locked = await client.query(
        `select tt.current_revision, ttr.lifecycle
         from trace_tests tt
         join trace_test_revisions ttr
           on ttr.trace_test_id = tt.id and ttr.revision = tt.current_revision
         where tt.id = $1 and tt.project_id = $2
         for update of tt`,
        [input.traceTestId, input.projectId]
      );
      if (!locked.rows[0]) throw new TraceTestNotFoundError(input.traceTestId);
      const currentRevision = Number(locked.rows[0].current_revision);
      if (currentRevision !== input.revision) {
        throw new TraceTestRevisionConflictError(input.revision, currentRevision);
      }
      const status = traceTestValidationStatus(input.badEvidence.result, input.goodEvidence.result);
      const diagnostic = input.diagnostic ?? traceTestValidationDiagnostic(input.badEvidence.result, input.goodEvidence.result);
      const inserted = await client.query(
        `insert into trace_test_validations
         (id, trace_test_id, project_id, revision, status, bad_evidence, good_evidence,
          method, diagnostic, evaluator, override_reason, recorded_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [
          validationId,
          input.traceTestId,
          input.projectId,
          input.revision,
          status,
          JSON.stringify({ ...input.badEvidence, expectedResult: "fail", attempts: input.badAttempts ?? 0, usage: input.badUsage ?? null }),
          JSON.stringify({ ...input.goodEvidence, expectedResult: "pass", attempts: input.goodAttempts ?? 0, usage: input.goodUsage ?? null }),
          input.method ?? "automated",
          diagnostic,
          input.evaluator ? JSON.stringify(input.evaluator) : null,
          input.overrideReason ?? null,
          input.recordedByUserId ?? null
        ]
      );
      await client.query("commit");
      return rowToTraceTestValidation(inserted.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async enableTraceTest(input: EnableTraceTestInputDb): Promise<TraceTestDetail> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query(
        `select tt.current_revision, ttr.lifecycle
         from trace_tests tt
         join trace_test_revisions ttr
           on ttr.trace_test_id = tt.id and ttr.revision = tt.current_revision
         where tt.id = $1 and tt.project_id = $2
         for update of tt`,
        [input.traceTestId, input.projectId]
      );
      if (!locked.rows[0]) throw new TraceTestNotFoundError(input.traceTestId);
      const currentRevision = Number(locked.rows[0].current_revision);
      if (currentRevision !== input.expectedRevision) {
        throw new TraceTestRevisionConflictError(input.expectedRevision, currentRevision);
      }
      if (locked.rows[0].lifecycle !== "draft") {
        throw new TraceTestValidationNotReadyError("Create a new draft revision before enabling this test again");
      }
      const validation = await client.query(
        `select id from trace_test_validations
         where id = $1 and trace_test_id = $2 and project_id = $3
           and revision = $4 and status = 'passed'
           and (
             (method = 'automated' and evaluator is not null)
             or
             (method = 'manual_override' and length(trim(override_reason)) >= 10)
           )`,
        [input.validationId, input.traceTestId, input.projectId, input.expectedRevision]
      );
      if (!validation.rows[0]) {
        throw new TraceTestValidationNotReadyError("A successful validation for the current draft is required before enabling this test");
      }
      const revision = currentRevision + 1;
      const inserted = await client.query(
        `insert into trace_test_revisions
         (id, trace_test_id, project_id, revision, lifecycle, desired_behavior, scenario,
          expected_behavior, must_do, must_avoid, good_example, bad_example, checker,
          draft_provenance, validation_id, validated_revision, created_by_user_id,
          reviewed_by_user_id, reviewed_at)
         select $1, trace_test_id, project_id, $2, 'enabled', desired_behavior, scenario,
                expected_behavior, must_do, must_avoid, good_example, bad_example, checker,
                draft_provenance, $3, $4, created_by_user_id, $5, now()
         from trace_test_revisions
         where trace_test_id = $6 and project_id = $7 and revision = $4`,
        [
          `ttr_${randomUUID()}`,
          revision,
          input.validationId,
          input.expectedRevision,
          input.reviewedByUserId,
          input.traceTestId,
          input.projectId
        ]
      );
      if ((inserted.rowCount ?? 0) !== 1) {
        throw new TraceTestRevisionConflictError(input.expectedRevision, currentRevision);
      }
      await client.query(
        `update trace_tests
         set current_revision = $3, enabled_revision = $3, updated_at = now()
         where id = $1 and project_id = $2`,
        [input.traceTestId, input.projectId, revision]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const enabled = await this.getTraceTest(input.projectId, input.traceTestId);
    if (!enabled) throw new TraceTestNotFoundError(input.traceTestId);
    return enabled;
  }

  async recordTraceTestFunnelEvent(input: RecordTraceTestFunnelEventInputDb): Promise<void> {
    await this.pool.query(
      `insert into audit_logs
       (id, project_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1,$2,$3,$4,'trace_test_funnel',$5,$6)
       on conflict (project_id, target_id, action)
         where target_type = 'trace_test_funnel'
       do nothing`,
      [
        `audit_${randomUUID()}`,
        input.projectId,
        input.actorUserId ?? null,
        `trace_test.funnel.${input.event}`,
        input.journeyId,
        JSON.stringify({
          event: input.event,
          elapsedMs: input.elapsedMs,
          intent: input.intent
        })
      ]
    );
  }

  async createDataset(input: CreateDatasetInputDb): Promise<Dataset> {
    try {
      const result = await this.pool.query(
        `insert into datasets (id, project_id, name, description, kind, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6)
         returning *`,
        [
          `ds_${randomUUID()}`,
          input.projectId,
          input.name.trim(),
          input.description ?? null,
          input.kind ?? "custom",
          input.createdByUserId ?? null
        ]
      );
      return rowToDataset(result.rows[0], 0);
    } catch (error) {
      // The partial unique index on (project_id, name) where archived_at is
      // null is the real guard — translate its violation to the domain error.
      if (isUniqueViolation(error)) throw new DatasetNameTakenError(input.name.trim());
      throw error;
    }
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    const result = await this.pool.query(
      `select d.*, count(di.id)::int as item_count
       from datasets d
       left join dataset_items di on di.dataset_id = d.id
       where d.project_id = $1 and d.archived_at is null
       group by d.id
       order by d.created_at desc`,
      [projectId]
    );
    return result.rows.map((row) => rowToDataset(row, Number(row.item_count)));
  }

  async getDatasetDetail(projectId: string, datasetId: string): Promise<DatasetDetail | null> {
    const datasetResult = await this.pool.query(
      `select * from datasets where id = $1 and project_id = $2`,
      [datasetId, projectId]
    );
    const datasetRow = datasetResult.rows[0];
    if (!datasetRow) return null;
    const itemsResult = await this.pool.query(
      `select * from dataset_items where dataset_id = $1 order by added_at asc, id asc`,
      [datasetId]
    );
    const items = itemsResult.rows.map(rowToDatasetItem);
    return { ...rowToDataset(datasetRow, items.length), items };
  }

  async archiveDataset(projectId: string, datasetId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update datasets set archived_at = now()
       where id = $1 and project_id = $2 and archived_at is null`,
      [datasetId, projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async addDatasetItems(input: AddDatasetItemsInputDb): Promise<DatasetItem[]> {
    const datasetResult = await this.pool.query(
      `select id from datasets where id = $1 and project_id = $2 and archived_at is null`,
      [input.datasetId, input.projectId]
    );
    if (!datasetResult.rows[0]) throw new DatasetNotFoundError(input.datasetId);

    // Validate every case belongs to the project before inserting any — the
    // caller gets all-or-nothing semantics on bad input.
    const caseIds = [...new Set(input.items.map((item) => item.caseId))];
    const known = await this.pool.query(
      `select id from cases where project_id = $1 and id = any($2::text[])`,
      [input.projectId, caseIds]
    );
    const knownIds = new Set(known.rows.map((row) => String(row.id)));
    const missing = caseIds.find((caseId) => !knownIds.has(caseId));
    if (missing) throw new CaseNotFoundError(missing);

    for (const item of input.items) {
      // Idempotent add with label upsert: re-adding a case can update its
      // expected label / note, but a label-less append (e.g. the batch judge
      // route) never nulls an existing label — coalesce keeps the old value.
      // Eval-run history is safe either way: expected_label is snapshotted
      // onto eval_run_items at run creation. trace_id mirrors the user-facing
      // id convention elsewhere (source_trace_id when imported, case id
      // otherwise).
      await this.pool.query(
        `insert into dataset_items (id, dataset_id, project_id, case_id, trace_id, expected_label, expected_fail_step, note)
         select $1, $2, $3, c.id, coalesce(rt.source_trace_id, c.id), $5, $6, $7
         from cases c
         left join raw_traces rt on rt.id = c.raw_trace_id
         where c.id = $4 and c.project_id = $3
         on conflict (dataset_id, case_id) do update set
           expected_label = coalesce(excluded.expected_label, dataset_items.expected_label),
           -- Locked M2 invariant: an explicit re-label to pass CLEARS the
           -- stored step; a fail (or label-less) upsert without a step keeps it.
           expected_fail_step = case
             when excluded.expected_label = 'pass' then null
             when excluded.expected_fail_step is not null then excluded.expected_fail_step
             else dataset_items.expected_fail_step
           end,
           note = coalesce(excluded.note, dataset_items.note)`,
        [
          `dsi_${randomUUID()}`,
          input.datasetId,
          input.projectId,
          item.caseId,
          item.expectedLabel ?? null,
          item.expectedFailStep ?? null,
          item.note ?? null
        ]
      );
    }
    const itemsResult = await this.pool.query(
      `select * from dataset_items where dataset_id = $1 order by added_at asc, id asc`,
      [input.datasetId]
    );
    return itemsResult.rows.map(rowToDatasetItem);
  }

  async removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from dataset_items where id = $1 and dataset_id = $2 and project_id = $3`,
      [itemId, datasetId, projectId]
    );
    return (result.rowCount ?? 0) > 0;
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
    const client = await this.pool.connect();
    let revisionId: string | null = null;
    try {
      await client.query("begin");
      const project = await client.query(`select id from projects where id = $1 for update`, [input.projectId]);
      if (!project.rows[0]) throw new Error(`Project not found: ${input.projectId}`);
      const datasetResult = await client.query(
        `select * from datasets
         where id = $1 and project_id = $2 and archived_at is null
         for update`,
        [input.datasetId, input.projectId]
      );
      if (!datasetResult.rows[0]) throw new DatasetNotFoundError(input.datasetId);

      if (input.idempotencyKey) {
        const existing = await client.query(
          `select id, source_dataset_id, role
           from dataset_revisions where project_id = $1 and idempotency_key = $2`,
          [input.projectId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          if (
            String(existing.rows[0].source_dataset_id) !== input.datasetId ||
            String(existing.rows[0].role) !== input.role
          ) {
            throw new DatasetRevisionConflictError("Idempotency key was already used for a different dataset revision request");
          }
          revisionId = String(existing.rows[0].id);
          await client.query("commit");
          const detail = await this.getDatasetRevisionDetail(input.projectId, revisionId);
          if (!detail) throw new DatasetRevisionConflictError("Idempotent dataset revision vanished");
          return detail;
        }
      }

      const rows = await client.query(
        `select di.*, c.normalized_payload, rt.raw_payload
         from dataset_items di
         join cases c on c.id = di.case_id and c.project_id = di.project_id
         left join raw_traces rt on rt.id = c.raw_trace_id
         where di.dataset_id = $1 and di.project_id = $2
         order by di.added_at asc, di.id asc`,
        [input.datasetId, input.projectId]
      );
      if (rows.rows.length === 0) throw new DatasetRevisionConflictError("Cannot freeze an empty working collection");

      const verdicts = await loadHumanVerdictsForCases(client, input.projectId, rows.rows.map((row) => String(row.case_id)));
      const prepared = [] as Array<{
        sourceCaseId: string;
        sourceTraceId: string;
        sourceDatasetItemId: string;
        sourceGoldenEntryId: null;
        payloadSnapshot: DatasetRevisionPayloadSnapshot;
        inputDigest: string;
        itemDigest: string;
        referenceLabel: "pass" | "fail" | null;
        referenceFailStep: number | null;
        referenceProvenance: DatasetReferenceProvenance;
        note: string | null;
      }>;
      for (const row of rows.rows) {
        const caseId = String(row.case_id);
        const payloadSnapshot = normalizedPayloadSnapshot(row.normalized_payload);
        const identity = await resolveCaseInputIdentity(client, input.projectId, caseId, row.raw_payload);
        const referenceLabel = row.expected_label === "pass" || row.expected_label === "fail"
          ? row.expected_label as "pass" | "fail"
          : null;
        const matching = referenceLabel
          ? (verdicts.get(caseId) ?? []).filter((verdict) => verdictLabelFromPayload(verdict.payload) === referenceLabel)
          : [];
        const adjudicated = matching.filter((verdict) => verdict.source === "adjudicated");
        const human = matching.filter((verdict) => verdict.source === "human");
        const supporting = adjudicated.length > 0 ? adjudicated : human;
        const referenceProvenance: DatasetReferenceProvenance = referenceLabel === null
          ? {
              kind: "unlabeled",
              sourceId: String(row.id),
              verdictIds: [],
              actorUserIds: [],
              basis: "No reference label was present when the collection was frozen."
            }
          : supporting.length > 0
            ? {
                kind: adjudicated.length > 0 ? "adjudication" : "human_verdict",
                sourceId: String(row.id),
                verdictIds: supporting.map((verdict) => verdict.id),
                actorUserIds: supporting.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
                basis: adjudicated.length > 0
                  ? "Dataset expectation matched retained adjudicated truth."
                  : "Dataset expectation matched retained human verdict history."
              }
            : {
                kind: "dataset_claim",
                sourceId: String(row.id),
                verdictIds: [],
                actorUserIds: [],
                basis: "Mutable collection expectation; not adjudicated human truth."
              };
        const referenceFailStep = row.expected_fail_step === null || row.expected_fail_step === undefined
          ? null
          : Number(row.expected_fail_step);
        const itemDigest = datasetRevisionItemDigest({
          inputIdentity: identity,
          redactedPayload: payloadSnapshot,
          referenceLabel,
          expectedFailStep: referenceFailStep,
          reviewProvenance: referenceProvenance,
          note: row.note === null || row.note === undefined ? null : String(row.note)
        });
        prepared.push({
          sourceCaseId: caseId,
          sourceTraceId: String(row.trace_id),
          sourceDatasetItemId: String(row.id),
          sourceGoldenEntryId: null,
          payloadSnapshot,
          inputDigest: identity.digest,
          itemDigest,
          referenceLabel,
          referenceFailStep,
          referenceProvenance,
          note: row.note === null || row.note === undefined ? null : String(row.note)
        });
      }

      const sealedOverlap = await client.query(
        `select distinct revision.id
         from dataset_revision_items item
         join dataset_revisions revision on revision.id = item.revision_id
         where revision.project_id = $1
           and revision.role = 'sealed_validation'
           and item.input_digest = any($2::text[])
         limit 1`,
        [input.projectId, prepared.map((item) => item.inputDigest)]
      );
      if (sealedOverlap.rows[0]) {
        throw new DatasetRevisionConflictError(
          "Working collection overlaps sealed validation input; explicit governed declassification is required before nonsealed use"
        );
      }

      revisionId = await insertDatasetRevisionWithClient(client, {
        projectId: input.projectId,
        seriesId: `dataset:${input.datasetId}`,
        sourceDatasetId: input.datasetId,
        role: input.role,
        sourceKind: "collection_snapshot",
        provenanceLevel: "unverified",
        expectedParentRevisionId: input.expectedParentRevisionId,
        idempotencyKey: input.idempotencyKey,
        reuseLatestContent: input.reuseLatestContent,
        createdByUserId: input.createdByUserId,
        items: prepared
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (isCheckViolation(error)) {
        throw new DatasetRevisionConflictError(postgresErrorMessage(error));
      }
      throw error;
    } finally {
      client.release();
    }
    const detail = revisionId ? await this.getDatasetRevisionDetail(input.projectId, revisionId) : null;
    if (!detail) throw new DatasetRevisionConflictError("Dataset revision vanished after creation");
    return detail;
  }

  async listDatasetRevisions(projectId: string, sourceDatasetId?: string): Promise<DatasetRevision[]> {
    const result = await this.pool.query(
      `select revision.*,
              exists (
                select 1 from dataset_exposure_events exposure
                where exposure.revision_id = revision.id and exposure.exposure_class = 'development'
              ) as has_development_exposure
       from dataset_revisions revision
       where revision.project_id = $1
         and ($2::text is null or revision.source_dataset_id = $2)
       order by revision.created_at desc, revision.id desc`,
      [projectId, sourceDatasetId ?? null]
    );
    return result.rows.map(rowToDatasetRevision);
  }

  async getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null> {
    const [revisionResult, itemResult, exposureResult] = await Promise.all([
      this.pool.query(
        `select revision.*,
                exists (
                  select 1 from dataset_exposure_events exposure
                  where exposure.revision_id = revision.id and exposure.exposure_class = 'development'
                ) as has_development_exposure
         from dataset_revisions revision
         where revision.id = $1 and revision.project_id = $2`,
        [revisionId, projectId]
      ),
      this.pool.query(
        `select * from dataset_revision_items
         where revision_id = $1 and project_id = $2
         order by position asc`,
        [revisionId, projectId]
      ),
      this.pool.query(
        `select * from dataset_exposure_events
         where revision_id = $1 and project_id = $2
         order by occurred_at asc, id asc`,
        [revisionId, projectId]
      )
    ]);
    if (!revisionResult.rows[0]) return null;
    return {
      ...rowToDatasetRevision(revisionResult.rows[0]),
      items: itemResult.rows.map(rowToDatasetRevisionItem),
      exposures: exposureResult.rows.map(rowToDatasetExposureEvent)
    };
  }

  async recordDatasetRevisionContentView(input: {
    projectId: string;
    revisionId: string;
    actorUserId?: string | undefined;
  }): Promise<void> {
    const inserted = await this.pool.query(
      `insert into dataset_exposure_events
       (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
        subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
       select $1, revision.project_id, revision.id, 'human_access', 'development', 'content_view',
              $4, $5, $5, 'dataset_revision', revision.id, null, '{}'::jsonb, $6
       from dataset_revisions revision
       where revision.id = $2 and revision.project_id = $3
       returning id`,
      [
        `dse_${randomUUID()}`,
        input.revisionId,
        input.projectId,
        input.actorUserId ? "person" : "system",
        input.actorUserId ?? null,
        `content-view:${input.revisionId}:${randomUUID()}`
      ]
    );
    if (!inserted.rows[0]) throw new DatasetRevisionNotFoundError(input.revisionId);
  }

  async getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string,
    criterionVersionId?: string
  ): Promise<DatasetRevisionDetail> {
    const client = await this.pool.connect();
    let revisionId: string;
    try {
      await client.query("begin");
      const resolvedCriterionVersionId = criterionVersionId
        ?? await resolveSingletonCriterionVersionForRegression(client, projectId);
      revisionId = await getOrCreateRegressionDatasetRevisionWithClient(
        client,
        projectId,
        resolvedCriterionVersionId,
        actorUserId
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const detail = await this.getDatasetRevisionDetail(projectId, revisionId);
    if (!detail) throw new DatasetRevisionConflictError("Regression dataset revision vanished after creation");
    return detail;
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
    return this.loadGoldenSetTraces(await this.listGoldenSet(projectId, criterionVersionId));
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
    // Machine read for /api/v1/findings + /api/v1/cases. Gate/release-evidence
    // scaffolding is excluded (same rule as listCaseIdsForProject); payloads
    // pass the same on-read redaction as every other trace reader.
    const result = await this.pool.query(
      `select c.id, c.created_at, c.normalized_payload,
              coalesce(rt.source_trace_id, c.id) as source_trace_id
       from cases c
       left join raw_traces rt on rt.id = c.raw_trace_id
       where c.project_id = $1
         and c.case_type not in ('gate_candidate', 'release_evidence')
         and ($2::timestamptz is null or c.created_at > $2)
       order by c.created_at desc, c.id
       limit $3`,
      [projectId, opts.since ?? null, opts.limit ?? 500]
    );
    return result.rows.map((row) => {
      const payload = redactNormalizedTracePayload(parseJson(row.normalized_payload) as { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; steps?: NormalizedTraceStep[] });
      return {
        caseId: String(row.id),
        sourceTraceId: String(row.source_trace_id),
        createdAt: new Date(row.created_at).toISOString(),
        trace: {
          input: payload.input ?? null,
          output: payload.output ?? null,
          metadata: payload.metadata ?? {},
          ...(payload.steps ? { steps: payload.steps } : {})
        }
      };
    });
  }

  async getOnboardingEvidenceInventory(projectId: string): Promise<OnboardingEvidenceInventory> {
    return this.projectRepository.getOnboardingEvidenceInventory(projectId);
  }

  async listCaseIdsForProject(projectId: string, limit = 10_000): Promise<string[]> {
    // Governed evaluation scaffolding is excluded: this feeds
    // the approval-time judge backfill, which must never re-judge (and pay
    // provider tokens for) accumulated product-gate scaffolding.
    const result = await this.pool.query(
      `select id from cases
       where project_id = $1 and case_type not in ('gate_candidate', 'release_evidence')
       order by created_at desc limit $2`,
      [projectId, limit]
    );
    return result.rows.map((row) => String(row.id));
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
    // Load human verdicts only — κ measures inter-human agreement (PR #42).
    // Capped at 50k to bound memory; teams with more verdicts will need a
    // partitioned aggregation pass later. Practical scale today: dozens of
    // reviewers × thousands of cases is well under the cap.
    const resolved = await this.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source = 'human'
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved]
    );
    return computeKappaSummary(result.rows.map(rowToVerdictRecord));
  }

  async getProjectJudgeHumanCalibration(
    projectId: string,
    criterionVersionId?: string | undefined,
    skillVersionId?: string | undefined
  ): Promise<KappaSummary> {
    // load BOTH human and llm_judge verdicts so the pure helper can
    // pair them. imported_external rows are excluded — they don't participate
    // in calibration. Same 50k cap as above.
    const resolved = await this.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source in ('human', 'llm_judge')
         and ($3::text is null or verdict.source <> 'llm_judge' or verdict.skill_version_id = $3)
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved, skillVersionId ?? null]
    );
    return computeJudgeHumanCalibration(result.rows.map(rowToVerdictRecord));
  }

  async getDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<DisagreementSummary> {
    // Human verdicts drive the splits; adjudicated rows annotate which splits
    // are resolved (A2.2b-2). Same cap as the κ summary.
    const resolved = await this.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source in ('human', 'adjudicated')
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved]
    );
    const summary = computeDisagreementSummary(result.rows.map(rowToVerdictRecord));
    await this.attachActorNames(summary.cases.map((entry) => entry.labels));
    return summary;
  }

  async getJudgeHumanDisagreementSummary(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<JudgeHumanDisagreementSummary> {
    // Load human + llm_judge verdicts (same as calibration) so the helper can
    // pair the judge's verdict against each human's, plus adjudicated rows to
    // annotate resolution (A2.2b-2). asc order makes "latest judge verdict wins"
    // resolve correctly. Same 50k cap.
    const resolved = await this.resolveGoldenCriterionVersion(projectId, criterionVersionId);
    const result = await this.pool.query(
      `select verdict.* from verdicts verdict
       join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1 and evaluator.criterion_version_id = $2
         and verdict.source in ('human', 'llm_judge', 'adjudicated')
       order by verdict.created_at asc
       limit 50000`,
      [projectId, resolved]
    );
    const summary = computeJudgeHumanDisagreement(result.rows.map(rowToVerdictRecord));
    await this.attachActorNames(summary.cases.map((entry) => entry.humanLabels));
    return summary;
  }

  // Reviewer ids in the trust feeds are Better Auth user ids — opaque UUIDs.
  // Resolve them to display names in one query and decorate the label lists
  // in place, so the feeds read "Maya · Pass", not "ba434f1c-… · Pass".
  private async attachActorNames(labelLists: Array<Array<{ actorUserId: string; actorName?: string | null | undefined }>>): Promise<void> {
    const distinct = [...new Set(labelLists.flat().map((label) => label.actorUserId))].filter(Boolean);
    if (distinct.length === 0) return;
    const result = await this.pool.query(
      `select id, name, email from "user" where id = any($1)`,
      [distinct]
    );
    const names = new Map<string, string>();
    for (const row of result.rows) {
      const name = (row.name as string | null) || (row.email as string | null);
      if (name) names.set(String(row.id), name);
    }
    for (const labels of labelLists) {
      for (const label of labels) label.actorName = names.get(label.actorUserId) ?? null;
    }
  }

  async getConvergenceAudit(
    projectId: string,
    skillId: string,
    versionId: string,
    input: ConvergenceAuditPageInput = {}
  ): Promise<ConvergenceAuditPage> {
    const target = await this.pool.query(
      `select criterion_version_id,
              to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_text
       from skill_versions
       where project_id = $1 and skill_id = $2 and id = $3`,
      [projectId, skillId, versionId]
    );
    if (!target.rows[0]) {
      return {
        audit: computeConvergenceAudit([], { beforeVersionId: null, afterVersionId: versionId }),
        nextCursor: null,
        nextUncoveredCaseId: null
      };
    }
    const criterionVersionId = String(target.rows[0].criterion_version_id);
    // The predecessor = the skill's version created immediately before this one.
    const pred = await this.pool.query(
      `select id from skill_versions
       where project_id = $1 and skill_id = $2
         and criterion_version_id = $3
         and (created_at, id) < ($4, $5)
       order by created_at desc, id desc
       limit 1`,
      [projectId, skillId, criterionVersionId, String(target.rows[0].created_at_text), versionId]
    );
    const beforeVersionId = pred.rows[0]?.id ? String(pred.rows[0].id) : null;

    const limit = convergencePageLimit(input.limit);
    const cursor = decodeConvergenceCursor(input.cursor ?? null);
    if (cursor && (
      cursor.versionId !== versionId ||
      cursor.criterionVersionId !== criterionVersionId ||
      cursor.beforeVersionId !== beforeVersionId
    )) {
      throw new InvalidConvergenceCursorError();
    }
    const snapshot = cursor ?? (await this.pool.query(
      `select to_char(verdict.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_text,
              verdict.id
       from verdicts verdict
       left join skill_versions evaluator
         on evaluator.id = verdict.skill_version_id
        and evaluator.project_id = verdict.project_id
       where verdict.project_id = $1
         and verdict.payload->>'kind' in ('binary', 'categorical')
         and ((verdict.source = 'adjudicated' and evaluator.criterion_version_id = $4)
              or (verdict.source = 'llm_judge' and verdict.skill_version_id in ($2, $3)))
       order by verdict.created_at desc, verdict.id desc
       limit 1`,
      [projectId, versionId, beforeVersionId, criterionVersionId]
    )).rows[0];
    // node-postgres converts timestamptz to JS Date and truncates PostgreSQL's
    // microseconds. Keep the watermark as lossless SQL text or the newest row
    // can compare greater than its own rounded snapshot on page one.
    const snapshotCreatedAt = cursor?.snapshotCreatedAt ?? (
      snapshot?.created_at_text ? String(snapshot.created_at_text) : null
    );
    const snapshotId = cursor?.snapshotId ?? (snapshot?.id ? String(snapshot.id) : null);
    const label = (alias: string) => `case when ${alias}.payload is null then null else case
      when ${alias}.payload->>'kind' = 'binary' then
        case when ${alias}.payload ? 'label' then ${alias}.payload->>'label'
             when (${alias}.payload->>'pass')::boolean then 'pass' else 'fail' end
      else ${alias}.payload->>'choice'
    end end`;

    // Resolve one exact latest row per case in SQL before aggregating. The
    // headline scans no arbitrary verdict cap; only the independently paged
    // disclosure is bounded. Corrections appended after the old 50k boundary
    // therefore participate in both numerator and denominators.
    const result = await this.pool.query(
      `with adjudicated_head as (
         select distinct on (verdict.case_id) verdict.case_id, verdict.payload
         from verdicts verdict
         join skill_versions evaluator
           on evaluator.id = verdict.skill_version_id
          and evaluator.project_id = verdict.project_id
         where verdict.project_id = $1
           and verdict.source = 'adjudicated'
           and evaluator.criterion_version_id = $4
           and verdict.payload->>'kind' in ('binary', 'categorical')
           and ($8::timestamptz is null or (verdict.created_at, verdict.id) <= ($8::timestamptz, $9::text))
         order by verdict.case_id, verdict.created_at desc, verdict.id desc
       ), after_head as (
         select distinct on (verdict.case_id) verdict.case_id, verdict.payload
         from verdicts verdict
         where verdict.project_id = $1
           and verdict.source = 'llm_judge'
           and verdict.skill_version_id = $2
           and verdict.payload->>'kind' in ('binary', 'categorical')
           and ($8::timestamptz is null or (verdict.created_at, verdict.id) <= ($8::timestamptz, $9::text))
         order by verdict.case_id, verdict.created_at desc, verdict.id desc
       ), before_head as (
         select distinct on (verdict.case_id) verdict.case_id, verdict.payload
         from verdicts verdict
         where verdict.project_id = $1
           and verdict.source = 'llm_judge'
           and $3::text is not null
           and verdict.skill_version_id = $3
           and verdict.payload->>'kind' in ('binary', 'categorical')
           and ($8::timestamptz is null or (verdict.created_at, verdict.id) <= ($8::timestamptz, $9::text))
         order by verdict.case_id, verdict.created_at desc, verdict.id desc
       ), labels as (
         select adjudicated.case_id,
                ${label("adjudicated")} as adjudicated_label,
                ${label("prior")} as before_label,
                ${label("current")} as after_label
         from adjudicated_head adjudicated
         join after_head current on current.case_id = adjudicated.case_id
         left join before_head prior on prior.case_id = adjudicated.case_id
       ), classified as (
         select labels.*,
                case
                  when after_label = adjudicated_label and before_label is not null and before_label <> adjudicated_label then 'improved'
                  when after_label <> adjudicated_label and before_label = adjudicated_label then 'regressed'
                  when after_label = adjudicated_label then 'still_agree'
                  else 'still_disagree'
                end as change,
                case
                  when after_label <> adjudicated_label and before_label = adjudicated_label then 0
                  when after_label = adjudicated_label and before_label is not null and before_label <> adjudicated_label then 1
                  when after_label <> adjudicated_label then 2
                  else 3
                end as change_rank
         from labels
       ), summary as (
         select (select count(*)::int from adjudicated_head) as adjudicated_total,
                count(*)::int as compared_cases,
                count(*) filter (where after_label = adjudicated_label)::int as after_agreed,
                count(*) filter (where before_label is not null)::int as before_known,
                count(*) filter (where before_label = adjudicated_label)::int as before_agreed,
                count(*) filter (where change = 'improved')::int as improved,
                count(*) filter (where change = 'regressed')::int as regressed
         from classified
       ), page as (
         select * from classified
         where $5::int is null
            or (change_rank, case_id) > ($5::int, $6::text)
         order by change_rank, case_id
         limit $7
       )
       select summary.*,
              page.case_id, page.adjudicated_label, page.before_label,
              page.after_label, page.change, page.change_rank,
              (select adjudicated.case_id
               from adjudicated_head adjudicated
               left join after_head current on current.case_id = adjudicated.case_id
               where current.case_id is null
               order by adjudicated.case_id
               limit 1) as next_uncovered_case_id
       from summary
       left join page on true
       order by page.change_rank, page.case_id`,
      [
        projectId,
        versionId,
        beforeVersionId,
        criterionVersionId,
        cursor?.rank ?? null,
        cursor?.caseId ?? null,
        limit + 1,
        snapshotCreatedAt,
        snapshotId
      ]
    );

    const summary = result.rows[0] ?? {};
    const caseRows = result.rows.filter((row) => row.case_id !== null && row.case_id !== undefined);
    const hasMore = caseRows.length > limit;
    const visibleRows = caseRows.slice(0, limit);
    const cases = visibleRows.map((row) => ({
      caseId: String(row.case_id),
      adjudicatedLabel: String(row.adjudicated_label),
      beforeLabel: row.before_label === null || row.before_label === undefined ? null : String(row.before_label),
      afterLabel: String(row.after_label),
      change: String(row.change) as ConvergenceCaseChange
    }));
    const last = visibleRows.at(-1) ?? null;
    return {
      audit: {
        afterVersionId: versionId,
        beforeVersionId,
        adjudicatedTotal: Number(summary.adjudicated_total ?? 0),
        comparedCases: Number(summary.compared_cases ?? 0),
        afterAgreed: Number(summary.after_agreed ?? 0),
        beforeKnown: Number(summary.before_known ?? 0),
        beforeAgreed: Number(summary.before_agreed ?? 0),
        improved: Number(summary.improved ?? 0),
        regressed: Number(summary.regressed ?? 0),
        cases
      },
      nextCursor: hasMore && last && snapshotCreatedAt && snapshotId
        ? encodeConvergenceCursor({
            versionId,
            criterionVersionId,
            beforeVersionId,
            snapshotCreatedAt,
            snapshotId,
            rank: Number(last.change_rank),
            caseId: String(last.case_id)
          })
        : null,
      nextUncoveredCaseId: summary.next_uncovered_case_id === null || summary.next_uncovered_case_id === undefined
        ? null
        : String(summary.next_uncovered_case_id)
    };
  }

  async getSelfConsistencyReport(projectId: string, versionId: string): Promise<SelfConsistencyReport> {
    // All of this version's judge verdicts; computeSelfConsistency groups the
    // repeats per case. Pinned to the version (a re-run by a different version
    // isn't a consistency sample for this one).
    const result = await this.pool.query(
      `select * from verdicts
       where project_id = $1 and source = 'llm_judge' and skill_version_id = $2
       order by created_at asc
       limit 50000`,
      [projectId, versionId]
    );
    return computeSelfConsistency(result.rows.map(rowToVerdictRecord), versionId);
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
    const result = await this.pool.query(
      `select id, action, actor_user_id, created_at, metadata
       from audit_logs
       where project_id = $1 and target_type = $2 and target_id = $3
       order by created_at asc, id asc`,
      [projectId, targetType, targetId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
      createdAt: toIso(row.created_at),
      metadata: row.metadata === null || row.metadata === undefined ? null : (parseJson(row.metadata) as Record<string, unknown>)
    }));
  }

  private async listExceptionCases(projectId: string, criterionVersionId?: string | undefined): Promise<ExceptionCase[]> {
    // Reduced entirely in SQL, mirroring pinExceptionJudgeRunRows
    // (lib/exception-rows.ts — the unit-tested spec): pinned = the FIRST open
    // non-pass run per case (open = created after the case's latest
    // human/adjudicated verdict), latest = the newest run overall (feeds the
    // re-judged-since marker), golden cases excluded, newest-pinned-first,
    // capped at EXCEPTION_LIST_LIMIT. The previous implementation loaded
    // EVERY judge_run row for the project (raw_response + normalized_payload
    // JSON included) on every dashboard load and reduced in JS — unbounded.
    // JSON columns are now fetched only for the final ≤limit rows.
    const result = await this.pool.query(
      `with resolved as (
         select verdict.case_id,
                version.criterion_version_id,
                max(verdict.created_at) as resolved_at
         from verdicts verdict
         join skill_versions version
           on version.id = verdict.skill_version_id
          and version.project_id = verdict.project_id
         where verdict.project_id = $1 and verdict.source in ('human', 'adjudicated')
         group by verdict.case_id, version.criterion_version_id
       ),
       pinned as (
         select distinct on (jr.case_id, version.criterion_version_id)
                jr.id as judge_run_id,
                jr.case_id,
                jr.skill_version_id,
                version.criterion_version_id,
                jr.verdict,
                jr.reasoning,
                jr.created_at
         from judge_runs jr
         join skill_versions version
           on version.id = jr.skill_version_id
          and version.project_id = jr.project_id
         join cases jc on jc.id = jr.case_id
         left join resolved r
           on r.case_id = jr.case_id
          and r.criterion_version_id = version.criterion_version_id
         where jr.project_id = $1
           and ($2::text is null or version.criterion_version_id = $2)
           and jr.verdict <> 'pass'
           -- Product-gate candidates are scaffolding, never exceptions: a
           -- fail-labeled golden case correctly judged 'fail' would otherwise
           -- flood the queue on every deploy gate.
           and jc.case_type not in ('gate_candidate', 'release_evidence')
           and (r.resolved_at is null or jr.created_at > r.resolved_at)
           and not exists (
             select 1
             from golden_set_entries gse
             where gse.project_id = $1
               and gse.case_id = jr.case_id
               and gse.criterion_version_id = version.criterion_version_id
               and gse.retired_at is null
           )
         order by jr.case_id, version.criterion_version_id, jr.created_at asc, jr.id asc
       ),
       capped as (
         select * from pinned order by created_at desc, judge_run_id desc limit $3
       ),
       latest as (
         select distinct on (jr.case_id, version.criterion_version_id)
                jr.case_id,
                version.criterion_version_id,
                jr.id as latest_judge_run_id,
                jr.verdict as latest_verdict,
                jr.reasoning as latest_reasoning,
                jr.created_at as latest_created_at
         from judge_runs jr
         join skill_versions version
           on version.id = jr.skill_version_id
          and version.project_id = jr.project_id
         where jr.project_id = $1
           and exists (
             select 1 from capped
             where capped.case_id = jr.case_id
               and capped.criterion_version_id = version.criterion_version_id
           )
         order by jr.case_id, version.criterion_version_id, jr.created_at desc, jr.id desc
       )
       select p.judge_run_id, p.case_id, p.skill_version_id, p.criterion_version_id,
              p.verdict, p.reasoning, pjr.raw_response, p.created_at,
              l.latest_judge_run_id, l.latest_verdict, l.latest_reasoning, l.latest_created_at,
              c.normalized_payload,
              rt.source_trace_id
       from capped p
       join judge_runs pjr on pjr.id = p.judge_run_id
       join latest l
         on l.case_id = p.case_id
        and l.criterion_version_id = p.criterion_version_id
       join cases c on c.id = p.case_id
       left join raw_traces rt on rt.id = c.raw_trace_id
       order by p.created_at desc, p.judge_run_id desc`,
      [projectId, criterionVersionId ?? null, EXCEPTION_LIST_LIMIT]
    );
    return result.rows.map(rowToExceptionCase);
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

  private async loadGoldenSetTraces(goldenSet: GoldenSetEntry[]): Promise<Map<string, Trace>> {
    const caseIds = goldenSet.map((entry) => entry.caseId);
    const output = new Map<string, Trace>();
    if (caseIds.length === 0) return output;

    const result = await this.pool.query(
      `select id, normalized_payload from cases where id = any($1::text[])`,
      [caseIds]
    );
    for (const row of result.rows) {
      const payload = redactNormalizedTracePayload(parseJson(row.normalized_payload) as { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; steps?: NormalizedTraceStep[] });
      output.set(row.id, {
        id: row.id,
        input: payload.input ?? payload,
        output: payload.output ?? payload,
        metadata: payload.metadata ?? {},
        ...(payload.steps ? { steps: payload.steps } : {})
      });
    }
    return output;
  }
}
