import { randomUUID } from "node:crypto";
import { MockJudgeProvider, DEFAULT_OUTPUT_SCHEMA, type JudgeProvider, type JudgePrompt, type JudgeVerdict, type Trace } from "@coeval/audit/runtime";
import { demoExceptions, demoGoldenSet, demoProject, demoSkill, demoSkillPrevVersion, demoVerdicts, getDemoDashboardSummary } from "@coeval/db";
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
  EvalRun,
  EvalRunDetail,
  EvalRunItem,
  GateCheck,
  GateCheckDetail,
  GateCheckItem,
  ExceptionCase,
  ExceptionDetail,
  FeedbackSyncJob,
  GOLDEN_SET_STALE_AFTER_DAYS,
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
  REGRESSION_RATIONALE_MAX_LENGTH,
  RegressionCaseDiff,
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
  VerdictLabel,
  VerdictRecord
} from "@coeval/shared";
import { deriveGateCheckDecision, effectiveHumanLabel, isInternalTraceMetadata, renderJudgePromptContent, verdictLabelFromPayload } from "@coeval/shared";
import { normalizeTracePayload, redactNormalizedTracePayload, redactTrace } from "./lib/redaction.js";
import { generateApiKey, hashApiKey } from "./lib/api-keys.js";
import {
  buildAssessmentReceipt,
  canonicalReceiptBytes,
  parseCanonicalReceiptBytes,
  receiptArtifactDigest,
  receiptSourceSnapshotDigest
} from "./lib/assessment-receipt.js";
import {
  evaluatorSuiteCriterionDigest
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
import type {
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
  HistoricalGateEvidenceRepositoryPort
} from "./repository/ports.js";
import type {
  CreateSkillVersionContext,
  ConvergenceAuditPageInput,
  AssessmentReceiptArtifactSource,
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
import {
  InvalidConvergenceCursorError,
  AssessmentReceiptUnavailableError,
  AssessmentReceiptIntegrityError,
  DatasetRevisionNotFoundError,
  SealedValidationUnavailableError,
  DatasetRevisionConflictError,
  RecursiveTraceSkippedError,
  GoldenSetEntryAlreadyRetiredError,
  GoldenSetEntryNotFoundError,
  CaseNotFoundError,
  RegressionGateJudgeError,
  GoldenSetLabelConflictError,
  LangSmithIntegrationNotFoundError,
  LangfuseIntegrationNotFoundError,
  NoCurrentSkillError,
  AmbiguousProjectSkillError,
  IronsideIntegrationNotFoundError,
  IronsideIntegrationChangedError,
  IronsideIntegrationAlreadyExistsError,
  FeedbackSyncJobNotFoundError,
  DatasetNotFoundError,
  DatasetNameTakenError,
  TraceTestSourceNotFoundError,
  TraceTestNotFoundError,
  TraceTestRevisionConflictError,
  TraceTestValidationNotReadyError
} from "./repository/errors.js";
import {
  traceTestValidationStatus,
  traceTestValidationDiagnostic,
  traceTestValidationIsEnableEligible,
  computeEvalRunSpend,
  judgeKeyDisplay,
  assertTraceIngestionPurpose,
  convergencePageLimit,
  convergenceChangeRank,
  encodeConvergenceCursor,
  decodeConvergenceCursor
} from "./repository/helpers.js";
import { DemoRepositoryStore } from "./repository/demo-store.js";
import { DemoCriterionSuiteRepository } from "./repository/demo-criteria.js";
import { DemoProjectRepository } from "./repository/demo-projects.js";
import { DemoSkillLifecycleRepository } from "./repository/demo-skills.js";
export * from "./repository/contracts.js";
export * from "./repository/errors.js";
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
  private readonly criterionSuiteRepository: DemoCriterionSuiteRepository;
  private readonly projectRepository: DemoProjectRepository;
  private readonly skillLifecycleRepository: DemoSkillLifecycleRepository;
  private readonly store = new DemoRepositoryStore();

  constructor(
    private readonly judgeProvider: JudgeProvider = new MockJudgeProvider(),
    options: { seedVerdicts?: boolean } = {}
  ) {
    const criterionId = demoSkill.criterionId;
    const criterionVersionId = demoSkill.currentVersion.criterionVersionId;
    this.store.criteria.push({
      id: criterionId,
      projectId: demoProject.id,
      stableKey: `skill:${demoSkill.id}`,
      sourceKind: "native",
      createdByUserId: null,
      createdAt: demoProject.updatedAt
    });
    this.store.criterionVersions.push({
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
    this.store.skillVersionCriteria.set(demoSkillPrevVersion.id, criterionVersionId);
    this.store.skillVersionCriteria.set(demoSkill.currentVersion.id, criterionVersionId);
    this.store.criterionSkills.set(criterionId, demoSkill);
    if (options.seedVerdicts) this.store.verdicts.push(...demoVerdicts);
    // Demo fixtures are authored in source rather than imported through the
    // runtime redaction path. Capture their original input identity up front
    // so the demo never hashes a redacted fallback while calling it exact.
    for (const entry of demoGoldenSet) {
      this.store.caseInputIdentities.set(
        entry.caseId,
        datasetInputIdentity({ input: demoTraceForGoldenEntry(entry).input })
      );
    }
    for (const exception of demoExceptions) {
      const trace = this.syntheticTraceForBuiltinCase(exception.id);
      if (trace) this.store.caseInputIdentities.set(exception.id, datasetInputIdentity({ input: trace.input }));
    }
    // A2.2c: when seeding, expose the predecessor version too so the convergence
    // audit has a real before→after to compare. Without seeding, the version
    // list lazy-inits to just the current version (existing behaviour).
    this.store.skillVersions = options.seedVerdicts
      ? [structuredClone(demoSkillPrevVersion), structuredClone(demoSkill.currentVersion)]
      : null;
    this.projectRepository = new DemoProjectRepository(this.store, {
      getCurrentSkill: (projectId) => this.getCurrentSkill(projectId),
      getCurrentSkillForCriterion: (projectId, criterionId) =>
        this.getCurrentSkillForCriterion(projectId, criterionId),
      isEvidenceScaffoldingCase: (caseId) => this.isEvidenceScaffoldingCase(caseId),
      listGoldenSet: (projectId, criterionVersionId) => this.listGoldenSet(projectId, criterionVersionId),
      syntheticTraceForBuiltinCase: (caseId) => this.syntheticTraceForBuiltinCase(caseId)
    });
    this.criterionSuiteRepository = new DemoCriterionSuiteRepository(this.store);
    this.skillLifecycleRepository = new DemoSkillLifecycleRepository(this.store, this.judgeProvider, {
      createSkillVersionPending: (skillId, input, context) =>
        this.createSkillVersionPending(skillId, input, context),
      getDatasetRevisionDetail: (projectId, revisionId) =>
        this.getDatasetRevisionDetail(projectId, revisionId),
      getOrCreateRegressionDatasetRevision: (projectId, actorUserId, resolvedCriterionVersionId) =>
        this.getOrCreateRegressionDatasetRevision(projectId, actorUserId, resolvedCriterionVersionId),
      previousVerdictsFromRun,
      runRegressionGateForVersion: (job) => this.runRegressionGateForVersion(job),
      runGoldenSetRegression
    });
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

  // Derived product-gate cases (case source 'gate_candidate') are judging
  // scaffolding: excluded from dashboards, exceptions, and backfills.
  private isEvidenceScaffoldingCase(caseId: string): boolean {
    const source = this.store.traceSources.get(caseId)?.source;
    return source === "gate_candidate" || source === "release_evidence";
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
    const resolvedCriterionVersionId = await this.resolveGoldenCriterionVersion(
      projectId,
      criterionVersionId
    );
    return [...this.store.promotedGoldenSet, ...demoGoldenSet].filter((entry) =>
      entry.criterionVersionId === resolvedCriterionVersionId &&
      !this.store.retiredGoldenSetEntries.has(entry.id)
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
    const criterionCount = this.store.criteria.filter((criterion) => criterion.projectId === projectId).length;
    if (!skillVersionId && criterionCount > 1) {
      throw new AmbiguousProjectSkillError(projectId, criterionCount);
    }
    const judged = [...this.store.judgeRuns]
      .filter((run) => run.caseId === caseId && (!skillVersionId || run.skillVersionId === skillVersionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (judged) {
      const trace = this.store.traces.get(caseId);
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
      ? this.store.skillVersionCriteria.get(skillVersionId)
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
    const criterionVersionId = this.store.skillVersionCriteria.get(skillVersionId);
    let verdictHistory: VerdictRecord[] = this.store.verdicts
      .filter((record) => record.projectId === demoProject.id && record.caseId === caseId)
      .filter((record) => record.source === "llm_judge" || record.source === "human" || record.source === "adjudicated")
      .filter((record) => !criterionVersionId || (
        record.skillVersionId !== null && this.store.skillVersionCriteria.get(record.skillVersionId) === criterionVersionId
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
    const goldenSetEntry = [...this.store.promotedGoldenSet, ...demoGoldenSet].find((entry) =>
      entry.caseId === caseId &&
      (!criterionVersionId || entry.criterionVersionId === criterionVersionId) &&
      !this.store.retiredGoldenSetEntries.has(entry.id)
    ) ?? null;
    // Imported cases serve their REAL stored payload (already redacted at
    // ingestion — PG parity, and the only way steps reach case detail);
    // the synthetic placeholder remains for built-in fixture cases only.
    const stored = this.store.traces.get(caseId);
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
        criterionVersionId: this.store.skillVersionCriteria.get(
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
      datasetExpectations: this.store.datasetItems
        .filter((item) => item.caseId === caseId)
        .map((item) => ({
          datasetName: this.store.datasets.find((d) => d.id === item.datasetId && !d.archivedAt)?.name ?? null,
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
    if (this.store.traceSources.get(input.caseId)?.source === "release_evidence") {
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
    this.store.verdicts.push({
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
    const criterionVersionId = this.store.skillVersionCriteria.get(detail.judgeRun.skillVersionId);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Judge evaluator has no immutable criterion version binding");
    }
    const existing = this.store.promotedGoldenSet.find((entry) =>
      entry.caseId === input.caseId &&
      this.store.skillVersionCriteria.get(entry.sourceSkillVersionId) === criterionVersionId &&
      !this.store.retiredGoldenSetEntries.has(entry.id)
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
    this.store.promotedGoldenSet.unshift(entry);
    await this.getOrCreateRegressionDatasetRevision(input.projectId, input.actorUserId, criterionVersionId);
    return entry;
  }

  async retireGoldenSetEntry(input: RetireGoldenSetEntryInput): Promise<void> {
    const entry = [...this.store.promotedGoldenSet, ...demoGoldenSet].find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new GoldenSetEntryNotFoundError(input.entryId);
    const retirement = this.store.retiredGoldenSetEntries.get(entry.id);
    if (retirement) throw new GoldenSetEntryAlreadyRetiredError(input.entryId, retirement);
    this.store.retiredGoldenSetEntries.set(entry.id, {
      retiredAt: new Date().toISOString(),
      retiredByUserId: input.actorUserId ?? null,
      retiredBy: input.actorUserId ?? "Unknown",
      reason: input.reason ?? null
    });
    const criterionVersionId = this.store.skillVersionCriteria.get(entry.sourceSkillVersionId);
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
    for (const [existingCaseId, traceSource] of this.store.traceSources.entries()) {
      if (
        traceSource.source === source
        && traceSource.sourceTraceId === sourceTraceId
        && (traceSource.sourceTraceVersion ?? null) === (context.sourceTraceVersion ?? null)
        && (traceSource.sourceRemoteProjectId ?? null) === (context.sourceRemoteProjectId ?? null)
      ) {
        return {
          rawTraceId: traceSource.rawTraceId,
          caseId: existingCaseId,
          sourceTraceId,
          created: false
        };
      }
    }
    const normalizedPayload = redactNormalizedTracePayload(normalizeTracePayload(input), context.redactionConfig);
    this.store.traces.set(caseId, {
      id: sourceTraceId,
      input: normalizedPayload.input,
      output: normalizedPayload.output,
      metadata: normalizedPayload.metadata,
      ...(normalizedPayload.steps ? { steps: normalizedPayload.steps } : {})
    });
    this.store.traceSources.set(caseId, {
      source,
      sourceTraceId,
      sourceTraceVersion: context.sourceTraceVersion,
      sourceRemoteProjectId: context.sourceRemoteProjectId,
      rawTraceId,
      ingestionPurpose: context.ingestionPurpose,
      createdAt: new Date().toISOString(),
      sourceIntegrationId: context.sourceIntegrationId,
      importJobId: context.importJobId
    });
    this.store.caseInputIdentities.set(caseId, datasetInputIdentity({ input: input.input }));
    return { rawTraceId, caseId, sourceTraceId, created: true };
  }

  async setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string): Promise<JudgeProviderKey> {
    const createdAt = new Date().toISOString();
    const keyDisplay = judgeKeyDisplay(apiKey);
    this.store.judgeProviderKeys.set(`${projectId}:${provider}`, { apiKey, keyDisplay, createdAt });
    return { provider, keyDisplay, createdAt };
  }

  async listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]> {
    return [...this.store.judgeProviderKeys.entries()]
      .filter(([mapKey]) => mapKey.startsWith(`${projectId}:`))
      .map(([mapKey, value]) => ({
        provider: mapKey.split(":")[1] as JudgeKeyProvider,
        keyDisplay: value.keyDisplay,
        createdAt: value.createdAt
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider): Promise<boolean> {
    return this.store.judgeProviderKeys.delete(`${projectId}:${provider}`);
  }

  async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
    return this.store.judgeProviderKeys.get(`${projectId}:${provider}`)?.apiKey ?? null;
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
    this.store.importJobs.unshift(job);
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
    const totalImportedForJob = [...this.store.traceSources.values()].filter((traceSource) => traceSource.importJobId === importJobId).length;
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
    return this.store.importJobs
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
    this.store.importJobs.unshift({
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
    this.store.langSmithIntegrations.set(id, {
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
    return [...this.store.langSmithIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicLangSmithIntegration);
  }

  async updateLangSmithIntegration(projectId: string, integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration> {
    const integration = this.store.langSmithIntegrations.get(integrationId);
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
    const integration = this.store.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async deleteLangSmithIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.store.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    this.store.langSmithIntegrations.delete(integrationId);
    this.store.langSmithLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.store.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.store.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueLangSmithImportTargets(input: ClaimLangSmithImportTargetsInput): Promise<LangSmithImportTarget[]> {
    const targets: LangSmithImportTarget[] = [];
    for (const integration of this.store.langSmithIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.store.langSmithLastPolledAt.get(integration.id);
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
        this.store.langSmithLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.store.langSmithLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadLangSmithImportContext(job: LangSmithImportJob): Promise<LangSmithImportContext> {
    const integration = this.store.langSmithIntegrations.get(job.integrationId);
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
    this.store.langfuseIntegrations.set(id, {
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
    return [...this.store.langfuseIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicLangfuseIntegration);
  }

  async updateLangfuseIntegration(projectId: string, integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration> {
    const integration = this.store.langfuseIntegrations.get(integrationId);
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
    const integration = this.store.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async deleteLangfuseIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.store.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    this.store.langfuseIntegrations.delete(integrationId);
    this.store.langfuseLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.store.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.store.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueLangfuseImportTargets(input: ClaimLangfuseImportTargetsInput): Promise<LangfuseImportTarget[]> {
    const targets: LangfuseImportTarget[] = [];
    for (const integration of this.store.langfuseIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.store.langfuseLastPolledAt.get(integration.id);
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
        this.store.langfuseLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.store.langfuseLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadLangfuseImportContext(job: LangfuseImportJob): Promise<LangfuseImportContext> {
    const integration = this.store.langfuseIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new LangfuseIntegrationNotFoundError(job.integrationId);
    return { ...integration, limit: job.limit };
  }

  async createIronsideIntegration(projectId: string, input: IronsideIntegrationInput, remote: IronsideEvaluatorContext): Promise<IronsideIntegration> {
    const existing = [...this.store.ironsideIntegrations.values()]
      .find((integration) => integration.projectId === projectId);
    if (existing) throw new IronsideIntegrationAlreadyExistsError(projectId);
    const id = `int_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = input.skillVersionId === undefined
      ? null
      : await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    const integration: IronsideIntegration = {
      id,
      projectId,
      provider: "ironside",
      skillVersionId,
      url: input.url,
      remoteProjectId: remote.project.id,
      remoteProjectName: remote.project.name,
      protocolVersion: remote.protocolVersion,
      settlementQuietPeriodSeconds: remote.settlement.quietPeriodSeconds,
      revalidationRequired: false,
      pollEnabled,
      pollIntervalSeconds,
      pollLimit,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt
    };
    this.store.ironsideIntegrations.set(id, {
      ...integration,
      apiKey: input.apiKey,
      limit: pollLimit,
      pollEnabled,
      pollIntervalMs: pollIntervalSeconds * 1000,
      redactionConfig: input.redaction ?? {},
      syncState: { cursor: null },
      revalidationRequired: false,
      connectionRevision: 1
    });
    return integration;
  }

  async listIronsideIntegrations(projectId: string): Promise<IronsideIntegration[]> {
    return [...this.store.ironsideIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicIronsideIntegration);
  }

  async updateIronsideIntegration(
    projectId: string,
    integrationId: string,
    input: UpdateIronsideIntegrationInput,
    remote?: IronsideEvaluatorContext,
    expected?: { remoteProjectId: string; revalidationRequired: boolean; connectionRevision: number }
  ): Promise<IronsideIntegration> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    if (
      expected &&
      (
        integration.remoteProjectId !== expected.remoteProjectId ||
        integration.revalidationRequired !== expected.revalidationRequired ||
        integration.connectionRevision !== expected.connectionRevision
      )
    ) {
      throw new IronsideIntegrationChangedError(integrationId);
    }
    if (input.url !== undefined) integration.url = input.url;
    if (input.apiKey !== undefined) integration.apiKey = input.apiKey;
    if (remote) {
      integration.remoteProjectId = remote.project.id;
      integration.remoteProjectName = remote.project.name;
      integration.protocolVersion = remote.protocolVersion;
      integration.settlementQuietPeriodSeconds = remote.settlement.quietPeriodSeconds;
      integration.revalidationRequired = false;
      integration.connectionRevision += 1;
    }
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
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async quarantineIronsideIntegration(
    projectId: string,
    integrationId: string,
    expected: { remoteProjectId: string; connectionRevision: number },
    result: IronsideConnectionTestResult
  ): Promise<boolean> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) {
      throw new IronsideIntegrationNotFoundError(integrationId);
    }
    if (
      integration.remoteProjectId !== expected.remoteProjectId ||
      integration.connectionRevision !== expected.connectionRevision
    ) return false;
    integration.pollEnabled = false;
    integration.revalidationRequired = true;
    integration.connectionRevision += 1;
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
    return true;
  }

  async deleteIronsideIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    this.store.ironsideIntegrations.delete(integrationId);
    this.store.ironsideLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.store.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.store.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueIronsideImportTargets(input: ClaimIronsideImportTargetsInput): Promise<IronsideImportTarget[]> {
    const targets: IronsideImportTarget[] = [];
    for (const integration of this.store.ironsideIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.store.ironsideLastPolledAt.get(integration.id);
      if (!integration.pollEnabled || integration.revalidationRequired) continue;
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
        this.store.ironsideLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.store.ironsideLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadIronsideImportContext(job: IronsideImportJob): Promise<IronsideImportContext> {
    const integration = this.store.ironsideIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new IronsideIntegrationNotFoundError(job.integrationId);
    return { ...integration, syncState: { ...integration.syncState }, limit: job.limit };
  }

  async saveIronsideSyncState(
    projectId: string,
    integrationId: string,
    state: IronsideSyncState,
    expectedCursor?: string | null
  ): Promise<boolean> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    if (expectedCursor !== undefined && integration.syncState.cursor !== expectedCursor) return false;
    integration.syncState = { ...state };
    return true;
  }

  private getImportJob(projectId: string, importJobId: string): ImportJobRecord {
    const job = this.store.importJobs.find((candidate) => candidate.id === importJobId && candidate.projectId === projectId);
    if (!job) throw new Error(`Import job not found: ${importJobId}`);
    return job;
  }

  async loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext> {
    // Imported traces first; built-in fixture cases (exceptions, golden set)
    // get the same synthesized traces the case-detail and regression surfaces
    // use, so demo eval runs can judge them instead of failing the item.
    const trace = this.store.traces.get(job.caseId) ?? this.syntheticTraceForBuiltinCase(job.caseId);
    if (!trace) throw new Error(`Case not found for judge job: ${job.caseId}`);
    // Honor the pinned version like PgRepository does — an eval run pinned to
    // an older version must record verdicts under THAT version id, or the run
    // claims one judge while the ledger says another (the A2.2c trap).
    const skillVersion = job.skillVersionId
      ? (this.store.skillVersions ?? [demoSkill.currentVersion]).find((version) => version.id === job.skillVersionId)
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
    const existing = this.store.judgeRuns.find((candidate) =>
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
    this.store.judgeRuns.push(run);
    return run;
  }

  async recordVerdict(input: RecordVerdictInput): Promise<VerdictRecord> {
    if (input.externalRunId) {
      const existing = this.store.verdicts.find(
        (candidate) =>
          candidate.projectId === input.projectId &&
          candidate.source === "imported_external" &&
          candidate.externalRunId === input.externalRunId
      );
      if (existing) return existing;
    }
    let skillVersionId = input.skillVersionId;
    if (input.source === "human" || input.source === "adjudicated") {
      const criterionCount = this.store.criteria.filter((criterion) => criterion.projectId === input.projectId).length;
      const definitionCount = this.store.criterionVersions.filter((version) => version.projectId === input.projectId).length;
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
    this.store.verdicts.push(record);
    // a human verdict completes pending queue items pointing at
    // this case, scoped to:
    //   - items unassigned (any reviewer covered them); AND
    //   - items assigned specifically to this verdict's actor.
    // Items assigned to OTHER reviewers stay pending — they're the κ-overlap
    // partner row and must wait for that reviewer's own verdict.
    if (input.source === "human") {
      const criterionVersionId = skillVersionId
        ? this.store.skillVersionCriteria.get(skillVersionId)
        : undefined;
      for (const item of this.store.reviewQueueItems) {
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
    this.store.apiKeys.push({ record, keyHash: generated.keyHash });
    return { ...record, key: generated.key };
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    return this.store.apiKeys
      .filter((entry) => entry.record.projectId === projectId)
      .map((entry) => entry.record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean> {
    const entry = this.store.apiKeys.find((candidate) => candidate.record.id === apiKeyId && candidate.record.projectId === projectId);
    if (!entry || entry.record.revokedAt) return false;
    entry.record.revokedAt = new Date().toISOString();
    return true;
  }

  async resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null> {
    const keyHash = hashApiKey(rawKey);
    const entry = this.store.apiKeys.find((candidate) => candidate.keyHash === keyHash && !candidate.record.revokedAt);
    if (!entry) return null;
    entry.record.lastUsedAt = new Date().toISOString();
    return { projectId: entry.record.projectId, apiKeyId: entry.record.id };
  }

  async createTraceTest(input: CreateTraceTestInputDb): Promise<TraceTestDetail> {
    if (input.projectId !== demoProject.id) throw new TraceTestSourceNotFoundError(input.sourceCaseId);
    const stored = this.store.traces.get(input.sourceCaseId);
    const detail = stored ? null : await this.getCaseDetail(input.projectId, input.sourceCaseId);
    if (!stored && !detail) throw new TraceTestSourceNotFoundError(input.sourceCaseId);
    const source = stored ?? detail!.trace;
    const sourceSnapshot = {
      input: source.input,
      output: source.output,
      metadata: source.metadata ?? {},
      ...(source.steps ? { steps: source.steps } : {})
    };
    const traceSource = this.store.traceSources.get(input.sourceCaseId);
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
    this.store.traceTests.push(record);
    this.store.traceTestRevisions.push({
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
    return this.store.traceTests
      .filter((test) => test.projectId === projectId && (!sourceCaseRef || test.sourceCaseRef === sourceCaseRef))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .map((test) => this.toTraceTestSummary(test));
  }

  async getTraceTest(projectId: string, traceTestId: string): Promise<TraceTestDetail | null> {
    const test = this.store.traceTests.find((candidate) => candidate.id === traceTestId && candidate.projectId === projectId);
    return test ? this.toTraceTestDetail(test) : null;
  }

  async reviseTraceTest(input: ReviseTraceTestInputDb): Promise<TraceTestDetail> {
    const test = this.store.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.expectedRevision) {
      throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    }
    const createdAt = new Date().toISOString();
    const revision = test.currentRevision + 1;
    this.store.traceTestRevisions.push({
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
    const test = this.store.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
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
    this.store.traceTestValidations.push(validation);
    return structuredClone(validation);
  }

  async enableTraceTest(input: EnableTraceTestInputDb): Promise<TraceTestDetail> {
    const test = this.store.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.expectedRevision) {
      throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    }
    const validation = this.store.traceTestValidations.find(
      (candidate) => candidate.id === input.validationId && candidate.traceTestId === test.id && candidate.revision === input.expectedRevision
    );
    if (!validation || !traceTestValidationIsEnableEligible(validation)) {
      throw new TraceTestValidationNotReadyError("A successful validation for the current draft is required before enabling this test");
    }
    const current = this.store.traceTestRevisions.find(
      (candidate) => candidate.traceTestId === test.id && candidate.revision === input.expectedRevision
    );
    if (!current) throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    if (current.lifecycle !== "draft") {
      throw new TraceTestValidationNotReadyError("Create a new draft revision before enabling this test again");
    }
    const reviewedAt = new Date().toISOString();
    const revision = test.currentRevision + 1;
    this.store.traceTestRevisions.push({
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
    this.store.traceTestFunnelEvents.add(`${input.projectId}:${input.journeyId}:${input.event}`);
  }

  private toTraceTestSummary(test: (typeof this.store.traceTests)[number]): TraceTestSummary {
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

  private toTraceTestDetail(test: (typeof this.store.traceTests)[number]): TraceTestDetail {
    return {
      ...this.toTraceTestSummary(test),
      sourceSnapshot: structuredClone(test.sourceSnapshot),
      sourceScope: structuredClone(test.sourceScope),
      createdByUserId: test.createdByUserId,
      revisions: this.store.traceTestRevisions
        .filter((revision) => revision.traceTestId === test.id)
        .sort((left, right) => left.revision - right.revision)
        .map((revision) => structuredClone(revision)),
      validations: this.store.traceTestValidations
        .filter((validation) => validation.traceTestId === test.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((validation) => structuredClone(validation))
    };
  }

  async createDataset(input: CreateDatasetInputDb): Promise<Dataset> {
    const name = input.name.trim();
    const duplicate = this.store.datasets.find(
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
    this.store.datasets.push(record);
    return this.toDataset(record);
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    return this.store.datasets
      .filter((dataset) => dataset.projectId === projectId && !dataset.archivedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((dataset) => this.toDataset(dataset));
  }

  async getDatasetDetail(projectId: string, datasetId: string): Promise<DatasetDetail | null> {
    const dataset = this.store.datasets.find((candidate) => candidate.id === datasetId && candidate.projectId === projectId);
    if (!dataset) return null;
    return {
      ...this.toDataset(dataset),
      items: this.store.datasetItems
        .filter((item) => item.datasetId === datasetId)
        .sort((left, right) => left.addedAt.localeCompare(right.addedAt))
    };
  }

  async archiveDataset(projectId: string, datasetId: string): Promise<boolean> {
    const dataset = this.store.datasets.find(
      (candidate) => candidate.id === datasetId && candidate.projectId === projectId && !candidate.archivedAt
    );
    if (!dataset) return false;
    dataset.archivedAt = new Date().toISOString();
    return true;
  }

  async addDatasetItems(input: AddDatasetItemsInputDb): Promise<DatasetItem[]> {
    const dataset = this.store.datasets.find(
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
      const existing = this.store.datasetItems.find(
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
      this.store.datasetItems.push({
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
    return this.store.datasetItems
      .filter((item) => item.datasetId === input.datasetId)
      .sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  async importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult> {
    const dataset = this.store.datasets.find(
      (candidate) => candidate.id === input.datasetId && candidate.projectId === input.projectId && !candidate.archivedAt
    );
    if (!dataset) throw new DatasetNotFoundError(input.datasetId);

    // In-memory "transaction": snapshot the collections this flow mutates and
    // restore them on any failure, so a mid-flow throw can't strand cases
    // without dataset membership (PG gets the same guarantee from a real
    // transaction).
    const tracesSnapshot = new Map(this.store.traces);
    const traceSourcesSnapshot = new Map(this.store.traceSources);
    const inputIdentitiesSnapshot = new Map(this.store.caseInputIdentities);
    const datasetItemsSnapshot = [...this.store.datasetItems];
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
      this.store.traces.clear();
      for (const [key, value] of tracesSnapshot) this.store.traces.set(key, value);
      this.store.traceSources.clear();
      for (const [key, value] of traceSourcesSnapshot) this.store.traceSources.set(key, value);
      this.store.caseInputIdentities.clear();
      for (const [key, value] of inputIdentitiesSnapshot) this.store.caseInputIdentities.set(key, value);
      this.store.datasetItems.length = 0;
      this.store.datasetItems.push(...datasetItemsSnapshot);
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
      const priorId = this.store.datasetRevisionIdempotency.get(idempotencyLookup);
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
    const series = this.store.datasetRevisions
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
      const trace = this.store.traces.get(item.caseId);
      if (!trace) throw new DatasetRevisionConflictError(`Case ${item.caseId} has no retained payload to freeze`);
      const payloadSnapshot: DatasetRevisionPayloadSnapshot = {
        input: structuredClone(trace.input),
        output: structuredClone(trace.output),
        metadata: structuredClone(trace.metadata ?? {}),
        ...(trace.steps ? { steps: structuredClone(trace.steps) } : {})
      };
      const inputIdentity = this.store.caseInputIdentities.get(item.caseId);
      if (!inputIdentity) {
        throw new DatasetRevisionConflictError(
          `Case ${item.caseId} has no retained pre-redaction input identity and cannot be frozen as exact evidence`
        );
      }
      const matching = item.expectedLabel
        ? this.store.verdicts.filter((verdict) =>
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
      this.store.datasetRevisionItems
        .filter((item) => this.store.datasetRevisions.some((revision) =>
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
    this.store.datasetRevisions.push(revision);
    this.store.datasetRevisionItems.push(...items);
    this.store.datasetExposureEvents.push(exposure);
    if (idempotencyLookup) this.store.datasetRevisionIdempotency.set(idempotencyLookup, revision.id);
    return { ...structuredClone(revision), items: structuredClone(items), exposures: [structuredClone(exposure)] };
  }

  async listDatasetRevisions(projectId: string, sourceDatasetId?: string): Promise<DatasetRevision[]> {
    return this.store.datasetRevisions
      .filter((revision) => revision.projectId === projectId && (!sourceDatasetId || revision.sourceDatasetId === sourceDatasetId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((revision) => structuredClone(revision));
  }

  async getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null> {
    const revision = this.store.datasetRevisions.find((candidate) => candidate.projectId === projectId && candidate.id === revisionId);
    if (!revision) return null;
    return {
      ...structuredClone(revision),
      items: this.store.datasetRevisionItems
        .filter((item) => item.revisionId === revision.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => structuredClone(item)),
      exposures: this.store.datasetExposureEvents
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
    const revision = this.store.datasetRevisions.find((candidate) =>
      candidate.projectId === input.projectId && candidate.id === input.revisionId
    );
    if (!revision) throw new DatasetRevisionNotFoundError(input.revisionId);
    this.store.datasetExposureEvents.push({
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
    const projectCriteria = this.store.criteria.filter((criterion) => criterion.projectId === projectId);
    const resolvedCriterionVersionId = criterionVersionId ?? (() => {
      if (projectCriteria.length !== 1) {
        throw new DatasetRevisionConflictError(
          `Project ${projectId} requires an explicit criterionVersionId for regression evidence.`
        );
      }
      const latest = this.store.criterionVersions
        .filter((version) => version.criterionId === projectCriteria[0]!.id)
        .sort((left, right) => right.revision - left.revision)[0];
      if (!latest) throw new DatasetRevisionConflictError("Criterion has no immutable definition.");
      return latest.id;
    })();
    const golden = await this.listGoldenSet(projectId, resolvedCriterionVersionId);
    const now = new Date().toISOString();
    const revisionId = `dsr_${randomUUID()}`;
    const items = golden.map((entry, position) => {
      const trace = this.store.traces.get(entry.caseId) ?? demoTraceForGoldenEntry(entry);
      const payloadSnapshot: DatasetRevisionPayloadSnapshot = {
        input: structuredClone(trace.input),
        output: structuredClone(trace.output),
        metadata: structuredClone(trace.metadata ?? {}),
        ...(trace.steps ? { steps: structuredClone(trace.steps) } : {})
      };
      const inputIdentity = this.store.caseInputIdentities.get(entry.caseId);
      if (!inputIdentity) {
        throw new DatasetRevisionConflictError(
          `Case ${entry.caseId} has no retained pre-redaction input identity and cannot be frozen as exact evidence`
        );
      }
      const matchingHuman = this.store.verdicts.filter((verdict) =>
        verdict.caseId === entry.caseId &&
        (verdict.source === "human" || verdict.source === "adjudicated") &&
        verdict.skillVersionId !== null &&
        this.store.skillVersionCriteria.get(verdict.skillVersionId) === resolvedCriterionVersionId &&
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
    const currentRevisionId = this.store.regressionDatasetRevisionIdsByCriterion.get(resolvedCriterionVersionId)
      ?? (projectCriteria.length === 1 ? this.store.regressionDatasetRevisionId : null);
    const current = currentRevisionId
      ? this.store.datasetRevisions.find((revision) => revision.id === currentRevisionId)
      : undefined;
    if (current?.revisionDigest === revisionDigest) {
      const detail = await this.getDatasetRevisionDetail(projectId, current.id);
      if (!detail) throw new DatasetRevisionConflictError("Current regression revision vanished");
      return detail;
    }
    const series = this.store.datasetRevisions.filter((revision) =>
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
    this.store.datasetRevisions.push(revision);
    this.store.datasetRevisionItems.push(...items);
    this.store.datasetExposureEvents.push(created, visible);
    this.store.regressionDatasetRevisionIdsByCriterion.set(resolvedCriterionVersionId, revision.id);
    if (projectCriteria.length === 1) this.store.regressionDatasetRevisionId = revision.id;
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
    const dataset = this.store.datasets.find((candidate) => candidate.id === datasetId && candidate.projectId === projectId);
    if (!dataset) return false;
    const index = this.store.datasetItems.findIndex((item) => item.datasetId === datasetId && item.id === itemId);
    if (index < 0) return false;
    this.store.datasetItems.splice(index, 1);
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
      itemCount: this.store.datasetItems.filter((item) => item.datasetId === record.id).length
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
    const existing = this.store.assessmentReceiptArtifacts.find(
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
    const raced = this.store.assessmentReceiptArtifacts.find(
      (artifact) => artifact.evalRunId === run.id && artifact.contractVersion === 1 && artifact.artifactRevision === 1
    );
    if (raced) return this.cloneAssessmentReceiptArtifact(raced);
    this.store.assessmentReceiptArtifacts.push(prepared);
    return this.cloneAssessmentReceiptArtifact(prepared);
  }

  async createEvalRun(input: CreateEvalRunInputDb): Promise<EvalRunDetail> {
    if (input.trigger === "backfill") {
      const existing = this.store.evalRuns.find((candidate) =>
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
      ? this.store.datasetRevisions.find((candidate) => candidate.id === input.datasetRevisionId && candidate.projectId === input.projectId)
      : null;
    if (input.datasetRevisionId && !revision) throw new DatasetRevisionNotFoundError(input.datasetRevisionId);
    const revisionItems = revision
      ? new Map(
          this.store.datasetRevisionItems
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
    this.store.evalRuns.push(run);
    this.store.evalRunItems.push(...items);
    if (revision && this.isTerminalEvalRun(run)) {
      this.store.datasetExposureEvents.push({
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
    if (terminalArtifact) this.store.assessmentReceiptArtifacts.push(terminalArtifact);
    return { ...run, items, spend: computeEvalRunSpend(items) };
  }

  async createConvergenceEvalRun(input: CreateConvergenceEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    const key = `${input.projectId}:${input.skillVersionId}:${input.caseId}`;
    const existing = this.store.convergenceEvalRuns.get(key);
    if (existing) {
      const original = await existing;
      const current = await this.getEvalRunDetail(input.projectId, original.id);
      if (current && current.status !== "failed" && current.status !== "canceled") {
        return { run: current, created: false };
      }
      if (this.store.convergenceEvalRuns.get(key) === existing) this.store.convergenceEvalRuns.delete(key);
      return this.createConvergenceEvalRun(input);
    }
    const creation = this.createEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "manual",
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      items: [{ caseId: input.caseId }]
    });
    this.store.convergenceEvalRuns.set(key, creation);
    try {
      return { run: await creation, created: true };
    } catch (error) {
      if (this.store.convergenceEvalRuns.get(key) === creation) this.store.convergenceEvalRuns.delete(key);
      throw error;
    }
  }

  async createImportedCaseEvalRun(input: CreateImportedCaseEvalRunInputDb): Promise<{
    run: EvalRunDetail;
    created: boolean;
  }> {
    const key = `${input.projectId}:${input.skillVersionId}:${input.caseId}`;
    const existing = this.store.importedCaseEvalRuns.get(key);
    if (existing) {
      const original = await existing;
      return {
        run: (await this.getEvalRunDetail(input.projectId, original.id)) ?? original,
        created: false
      };
    }
    const creation = this.createEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "api_batch",
      items: [{ caseId: input.caseId }]
    });
    this.store.importedCaseEvalRuns.set(key, creation);
    try {
      return { run: await creation, created: true };
    } catch (error) {
      if (this.store.importedCaseEvalRuns.get(key) === creation) this.store.importedCaseEvalRuns.delete(key);
      throw error;
    }
  }

  async claimEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<EvalRunDispatchClaim> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run) return { state: "busy", jobId: null };
    const current = this.store.evalRunDispatches.get(run.id) ?? {
      jobId: randomUUID(),
      dispatchToken: null,
      claimedAt: null,
      dispatched: false
    };
    this.store.evalRunDispatches.set(run.id, current);
    if (current.dispatched) return { state: "dispatched", jobId: current.jobId };
    const leaseExpired = current.claimedAt !== null && current.claimedAt <= Date.now() - 5 * 60_000;
    if (current.dispatchToken !== null && !leaseExpired) return { state: "busy", jobId: current.jobId };
    current.dispatchToken = input.dispatchToken;
    current.claimedAt = Date.now();
    return { state: "claimed", jobId: current.jobId };
  }

  async rotateEvalRunDispatchJob(input: EvalRunDispatchInputDb): Promise<string | null> {
    const current = this.store.evalRunDispatches.get(input.evalRunId);
    if (!current || current.dispatched || current.dispatchToken !== input.dispatchToken) return null;
    current.jobId = randomUUID();
    return current.jobId;
  }

  async markEvalRunDispatched(input: EvalRunDispatchInputDb): Promise<void> {
    const current = this.store.evalRunDispatches.get(input.evalRunId);
    if (!current || current.dispatchToken !== input.dispatchToken) return;
    current.dispatched = true;
    current.dispatchToken = null;
    current.claimedAt = null;
    await this.armEvalRunItemDeliveryDeadline(input.projectId, input.evalRunId);
  }

  async releaseEvalRunDispatch(input: EvalRunDispatchInputDb): Promise<void> {
    const current = this.store.evalRunDispatches.get(input.evalRunId);
    if (!current || current.dispatched || current.dispatchToken !== input.dispatchToken) return;
    current.dispatchToken = null;
    current.claimedAt = null;
  }

  async armEvalRunItemDeliveryDeadline(projectId: string, evalRunId: string): Promise<void> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return;
    const deadline = Date.now() + 15 * 60_000;
    for (const item of this.store.evalRunItems) {
      if (item.evalRunId === evalRunId && item.status === "pending") {
        this.store.evalRunItemDeliveryDeadlines.set(item.id, deadline);
      }
    }
  }

  async markEvalRunRunning(projectId: string, evalRunId: string): Promise<void> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return;
    const starting = run.status === "pending";
    if (starting) {
      run.status = "running";
      run.startedAt = new Date().toISOString();
    }
    if (starting && run.datasetRevisionId && run.startedAt) {
      this.store.datasetExposureEvents.push({
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
    const run = this.store.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return [];
    return this.store.evalRunItems.filter((item) => item.evalRunId === evalRunId && item.status === "pending");
  }

  async listPendingEvalRunItemDispatches(projectId: string, evalRunId: string): Promise<Array<{
    item: EvalRunItem;
    jobId: string;
  }>> {
    const pending = await this.listPendingEvalRunItems(projectId, evalRunId);
    return pending.map((item) => {
      const jobId = this.store.evalRunItemQueueJobs.get(item.id) ?? randomUUID();
      this.store.evalRunItemQueueJobs.set(item.id, jobId);
      return { item, jobId };
    });
  }

  async claimEvalRunItemExecution(input: EvalRunItemExecutionInputDb): Promise<EvalRunItemExecutionClaim> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return { state: "terminal" };
    const item = this.store.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    if (!item || item.status !== "pending") return { state: "terminal" };
    const current = this.store.evalRunItemExecutions.get(item.id);
    if (current) {
      if (current.providerCallReturned) {
        return { state: "outcome_unknown", executionToken: current.executionToken, providerCallReturned: true };
      }
      if (current.claimedAt > Date.now() - 15 * 60_000) return { state: "busy" };
      if (current.providerCallStarted) {
        return { state: "outcome_unknown", executionToken: current.executionToken, providerCallReturned: false };
      }
    }
    this.store.evalRunItemExecutions.set(item.id, {
      executionToken: input.executionToken,
      claimedAt: Date.now(),
      providerCallStarted: false,
      providerCallReturned: false
    });
    return { state: "claimed" };
  }

  async claimEvalRunItemRecovery(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    const item = this.store.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    const deadline = this.store.evalRunItemDeliveryDeadlines.get(input.evalRunItemId);
    if (
      !run || (run.status !== "pending" && run.status !== "running") ||
      !item || item.status !== "pending" || this.store.evalRunItemExecutions.has(item.id) ||
      deadline === undefined || deadline > Date.now()
    ) return false;
    this.store.evalRunItemExecutions.set(item.id, {
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
    const run = this.store.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    const item = this.store.evalRunItems.find(
      (candidate) => candidate.id === evalRunItemId && candidate.evalRunId === evalRunId
    );
    const deadline = this.store.evalRunItemDeliveryDeadlines.get(evalRunItemId);
    if (
      !run || (run.status !== "pending" && run.status !== "running") ||
      !item || item.status !== "pending" || this.store.evalRunItemExecutions.has(item.id) ||
      deadline === undefined || deadline > Date.now()
    ) return false;
    this.store.evalRunItemDeliveryDeadlines.set(evalRunItemId, Date.now() + 15 * 60_000);
    return true;
  }

  async beginEvalRunItemProviderCall(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const current = this.store.evalRunItemExecutions.get(input.evalRunItemId);
    if (!current || current.executionToken !== input.executionToken || current.providerCallStarted) return false;
    current.providerCallStarted = true;
    return true;
  }

  async markEvalRunItemProviderCallReturned(input: EvalRunItemExecutionInputDb): Promise<boolean> {
    const current = this.store.evalRunItemExecutions.get(input.evalRunItemId);
    if (!current || current.executionToken !== input.executionToken || !current.providerCallStarted) return false;
    current.providerCallReturned = true;
    return true;
  }

  async releaseEvalRunItemExecution(
    input: EvalRunItemExecutionInputDb,
    options: EvalRunItemReleaseOptions = {}
  ): Promise<EvalRunItemReleaseDisposition> {
    const current = this.store.evalRunItemExecutions.get(input.evalRunItemId);
    if (!current || current.executionToken !== input.executionToken) return { state: "lost" };
    if (current.providerCallStarted) {
      return { state: "provider_started", providerCallReturned: current.providerCallReturned };
    }
    if (options.preservePreCallClaim) return { state: "pre_call_held" };
    this.store.evalRunItemExecutions.delete(input.evalRunItemId);
    this.store.evalRunItemDeliveryDeadlines.set(input.evalRunItemId, Date.now() + 15 * 60_000);
    return { state: "released" };
  }

  async listStaleEvalRunItemExecutions(): Promise<StaleEvalRunItemExecution[]> {
    const stale: StaleEvalRunItemExecution[] = [];
    for (const item of this.store.evalRunItems) {
      if (item.status !== "pending") continue;
      const evalRunItemId = item.id;
      const run = this.store.evalRuns.find((candidate) => candidate.id === item.evalRunId);
      if (!run || (run.status !== "pending" && run.status !== "running")) continue;
      const execution = this.store.evalRunItemExecutions.get(evalRunItemId);
      if (execution) {
        if (execution.claimedAt > Date.now() - 15 * 60_000) continue;
      } else if ((this.store.evalRunItemDeliveryDeadlines.get(evalRunItemId) ?? Number.POSITIVE_INFINITY) > Date.now()) {
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
    const run = this.store.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run) return null;
    const item = this.store.evalRunItems.find(
      (candidate) => candidate.id === evalRunItemId && candidate.evalRunId === evalRunId
    );
    return item ? { ...item } : null;
  }

  async completeEvalRunItem(input: CompleteEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run) return { runFinished: false };
    if (run.status !== "pending" && run.status !== "running") return { runFinished: this.isRunFinished(run) };
    const item = this.store.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    // Retry replay of an already-terminal item: count nothing.
    if (
      !item ||
      item.status !== "pending" ||
      (input.executionToken !== undefined && this.store.evalRunItemExecutions.get(item.id)?.executionToken !== input.executionToken)
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
      this.store.evalRunItemExecutions.delete(item.id);
      run.completedItems += 1;
      if (item.agreement === true) run.agreedItems += 1;
      const runFinished = this.maybeFinishRun(run);
      if (runFinished && run.trigger === "release_evidence") {
        await this.mintDemoRootArtifact(run, "terminal_mint");
      }
      this.store.evalRunItemDeliveryDeadlines.delete(item.id);
      return { runFinished };
    } catch (error) {
      Object.assign(run, runBefore);
      Object.assign(item, itemBefore);
      throw error;
    }
  }

  async failEvalRunItem(input: FailEvalRunItemInputDb): Promise<{ runFinished: boolean }> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === input.evalRunId && candidate.projectId === input.projectId);
    if (!run) return { runFinished: false };
    if (run.status !== "pending" && run.status !== "running") return { runFinished: this.isRunFinished(run) };
    const item = this.store.evalRunItems.find(
      (candidate) => candidate.id === input.evalRunItemId && candidate.evalRunId === input.evalRunId
    );
    if (
      !item ||
      item.status !== "pending" ||
      (input.executionToken !== undefined && this.store.evalRunItemExecutions.get(item.id)?.executionToken !== input.executionToken)
    ) return { runFinished: this.isRunFinished(run) };
    const runBefore = structuredClone(run);
    const itemBefore = structuredClone(item);
    try {
      item.status = "failed";
      item.error = input.error;
      item.finishedAt = new Date().toISOString();
      this.store.evalRunItemExecutions.delete(item.id);
      run.failedItems += 1;
      // Surface the FIRST item error at run level — the poll signal clients
      // read (issue #152).
      if (run.error === null) run.error = input.error;
      const runFinished = this.maybeFinishRun(run);
      if (runFinished && run.trigger === "release_evidence") {
        await this.mintDemoRootArtifact(run, "terminal_mint");
      }
      this.store.evalRunItemDeliveryDeadlines.delete(item.id);
      return { runFinished };
    } catch (error) {
      Object.assign(run, runBefore);
      Object.assign(item, itemBefore);
      throw error;
    }
  }

  async getEvalRun(projectId: string, evalRunId: string): Promise<EvalRun | null> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    return run ? { ...run } : null;
  }

  async getEvalRunDetail(projectId: string, evalRunId: string): Promise<EvalRunDetail | null> {
    const run = await this.getEvalRun(projectId, evalRunId);
    if (!run) return null;
    const items = this.store.evalRunItems
      .filter((item) => item.evalRunId === evalRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { ...run, items, spend: computeEvalRunSpend(items) };
  }

  async listEvalRuns(
    projectId: string,
    opts?: { limit?: number | undefined; skillVersionId?: string | undefined }
  ): Promise<EvalRun[]> {
    return this.store.evalRuns
      .filter((run) => run.projectId === projectId)
      .filter((run) => !opts?.skillVersionId || run.skillVersionId === opts.skillVersionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, opts?.limit ?? 50)
      .map((run) => ({ ...run }));
  }

  async getOrFreezeAssessmentReceipt(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact | null> {
    const run = this.store.evalRuns.find((candidate) => candidate.id === evalRunId && candidate.projectId === projectId);
    if (!run) return null;
    return this.mintDemoRootArtifact(run, "historical_freeze");
  }

  async getAssessmentReceiptArtifactByReceiptId(
    projectId: string,
    receiptId: string
  ): Promise<AssessmentReceiptArtifact | null> {
    const artifact = this.store.assessmentReceiptArtifacts.find(
      (candidate) => candidate.projectId === projectId && candidate.receiptId === receiptId
    );
    return artifact ? this.cloneAssessmentReceiptArtifact(artifact) : null;
  }

  async listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]> {
    return this.store.assessmentReceiptArtifacts
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
    const existing = this.store.assessmentReceiptComparisons.find(
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
    this.store.assessmentReceiptComparisons.push(comparison);
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
    const existingReceipt = this.store.assessmentReceiptArtifacts.find(
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
    const lineage = this.store.assessmentReceiptArtifacts
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
    this.store.assessmentReceiptArtifacts.push(correction);
    return this.cloneAssessmentReceiptArtifact(correction);
  }

  async deleteUndispatchedEvalRun(projectId: string, evalRunId: string): Promise<void> {
    const index = this.store.evalRuns.findIndex((run) => run.id === evalRunId && run.projectId === projectId);
    if (index === -1) return;
    const run = this.store.evalRuns[index]!;
    // Guarded: once anything judged or failed, the run stays (append-only).
    if (run.status !== "pending" || run.completedItems > 0 || run.failedItems > 0) return;
    this.store.evalRuns.splice(index, 1);
    for (let i = this.store.evalRunItems.length - 1; i >= 0; i--) {
      if (this.store.evalRunItems[i]!.evalRunId === evalRunId) this.store.evalRunItems.splice(i, 1);
    }
  }

  async createRunComparison(input: CreateRunComparisonInputDb): Promise<RunComparison> {
    if (input.datasetRevisionId) {
      const revision = this.store.datasetRevisions.find((candidate) =>
        candidate.id === input.datasetRevisionId &&
        candidate.projectId === input.projectId &&
        candidate.sourceDatasetId === input.datasetId
      );
      const runA = this.store.evalRuns.find((candidate) => candidate.id === input.runAId && candidate.projectId === input.projectId);
      const runB = this.store.evalRuns.find((candidate) => candidate.id === input.runBId && candidate.projectId === input.projectId);
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
    this.store.runComparisons.push(comparison);
    return { ...comparison };
  }

  async getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null> {
    const comparison = this.store.runComparisons.find(
      (candidate) => candidate.id === runComparisonId && candidate.projectId === projectId
    );
    return comparison ? { ...comparison } : null;
  }

  async listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]> {
    return this.store.runComparisons
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

  // --- Historical gate evidence compatibility ------------------------------

  async getGoldenSetTraces(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<Map<string, Trace>> {
    const traces = new Map<string, Trace>();
    for (const entry of await this.listGoldenSet(projectId, criterionVersionId)) {
      // Imported (promoted) cases first; built-in fixture golden cases get the
      // same synthesized traces the judge context uses.
      const trace = this.store.traces.get(entry.caseId) ?? this.syntheticTraceForBuiltinCase(entry.caseId);
      if (trace) traces.set(entry.caseId, trace);
    }
    return traces;
  }

  async createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail> {
    const createdAt = new Date().toISOString();
    this.store.gateChecks.unshift({
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
    const detail = await this.getGateCheckDetail(input.projectId, this.store.gateChecks[0]!.id);
    if (!detail) throw new Error(`Gate check vanished after create: ${this.store.gateChecks[0]!.id}`);
    return detail;
  }

  async getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null> {
    const stored = this.store.gateChecks.find((candidate) => candidate.id === gateCheckId && candidate.projectId === projectId);
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
    for (const stored of this.store.gateChecks) {
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
    stored: (typeof this.store.gateChecks)[number],
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
    const imported = this.store.traces.get(caseId);
    if (imported) return imported.id;
    const exception = demoExceptions.find((candidate) => candidate.id === caseId);
    if (exception) return exception.traceId;
    const golden = demoGoldenSet.find((entry) => entry.caseId === caseId);
    if (golden) return golden.traceId;
    // caseExistsForProject guards every caller, so this is unreachable.
    throw new CaseNotFoundError(caseId);
  }

  async listVerdicts(input: ListVerdictsInput): Promise<VerdictRecord[]> {
    return this.store.verdicts
      .filter((verdict) => verdict.projectId === input.projectId)
      .filter((verdict) => input.evidenceScope !== "customer" || !this.isEvidenceScaffoldingCase(verdict.caseId))
      .filter((verdict) => !input.caseId || verdict.caseId === input.caseId)
      .filter((verdict) => !input.source || verdict.source === input.source)
      .filter((verdict) => !input.skillVersionId || verdict.skillVersionId === input.skillVersionId)
      .filter((verdict) => {
        if (!input.criterionId) return true;
        if (!verdict.skillVersionId) return false;
        const criterionVersionId = this.store.skillVersionCriteria.get(verdict.skillVersionId);
        return this.store.criterionVersions.some((version) =>
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
    const criterionVersionId = this.store.skillVersionCriteria.get(versionId);
    const versions = (await this.listSkillVersions(projectId, skillId, 1000)).filter((version) =>
      criterionVersionId !== undefined && this.store.skillVersionCriteria.get(version.id) === criterionVersionId
    );
    const idx = versions.findIndex((v) => v.id === versionId);
    const beforeVersionId = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1]!.id : null;
    const scopedVerdicts = criterionVersionId
      ? this.store.verdicts.filter((verdict) =>
          verdict.projectId === projectId && (
            (verdict.source === "llm_judge" && (
              verdict.skillVersionId === versionId || verdict.skillVersionId === beforeVersionId
            )) || (
              verdict.source === "adjudicated" &&
              verdict.skillVersionId !== null &&
              this.store.skillVersionCriteria.get(verdict.skillVersionId) === criterionVersionId
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
    return this.store.verdicts.filter((verdict) =>
      verdict.projectId === projectId &&
      verdict.skillVersionId !== null &&
      this.store.skillVersionCriteria.get(verdict.skillVersionId) === resolved
    );
  }

  async getSelfConsistencyReport(projectId: string, versionId: string): Promise<SelfConsistencyReport> {
    const verdicts = this.store.verdicts.filter((verdict) => verdict.projectId === projectId);
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
    this.store.reviewQueues.push({
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
      this.store.reviewQueueItems.push({
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
    return this.toReviewQueue(this.store.reviewQueues[this.store.reviewQueues.length - 1]!);
  }

  async addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]> {
    const queue = this.store.reviewQueues.find((q) => q.id === input.queueId && q.projectId === input.projectId);
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
    let position = this.store.reviewQueueItems.filter((existing) => existing.queueId === input.queueId).length;
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
      const alreadyExists = this.store.reviewQueueItems.some(
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
      this.store.reviewQueueItems.push(row);
      added.push(row);
      position += 1;
    }
    return added;
  }

  async listReviewQueues(projectId: string, opts?: { status?: ReviewQueueStatus | undefined }): Promise<ReviewQueue[]> {
    return this.store.reviewQueues
      .filter((q) => q.projectId === projectId)
      .filter((q) => !opts?.status || q.status === opts.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((q) => this.toReviewQueue(q));
  }

  async getReviewQueueDetail(projectId: string, queueId: string): Promise<ReviewQueueDetail | null> {
    const row = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!row) return null;
    return {
      queue: this.toReviewQueue(row),
      items: this.store.reviewQueueItems
        .filter((item) => item.queueId === queueId)
        .sort((left, right) => left.position - right.position)
    };
  }

  async getNextPendingQueueItem(projectId: string, queueId: string, opts?: {
    assignedToUserId?: string | undefined;
    criterionVersionId?: string | undefined;
  }): Promise<ReviewQueueItem | null> {
    const queue = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue || queue.status !== "open") return null;
    const pending = this.store.reviewQueueItems.filter((item) => item.queueId === queueId && item.status === "pending");
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
      const criterionVersion = this.store.criterionVersions.find((candidate) =>
        candidate.projectId === projectId && candidate.id === requested
      );
      const hasEvaluator = [...this.store.skillVersionCriteria.values()].includes(requested);
      if (!criterionVersion || !hasEvaluator) {
        throw new DatasetRevisionConflictError(
          `Criterion version is not bound to an evaluator in this project: ${requested}`
        );
      }
      return requested;
    }
    const current = await this.getCurrentSkill(projectId);
    const criterionVersionId = this.store.skillVersionCriteria.get(current.currentVersion.id);
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
      const exists = this.store.criterionVersions.some((candidate) =>
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
    const criterionVersionId = this.store.skillVersionCriteria.get(current.currentVersion.id);
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Current evaluator has no immutable criterion version binding");
    }
    return criterionVersionId;
  }

  async closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const queue = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
    if (!queue) return null;
    if (queue.status !== "closed") {
      queue.status = "closed";
      queue.closedAt = new Date().toISOString();
    }
    return this.toReviewQueue(queue);
  }

  async reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const queue = this.store.reviewQueues.find((q) => q.id === queueId && q.projectId === projectId);
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
    for (const item of this.store.reviewQueueItems) {
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
    for (const [caseId, trace] of this.store.traces.entries()) {
      if (this.isEvidenceScaffoldingCase(caseId)) continue;
      const source = this.store.traceSources.get(caseId);
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

  async getOnboardingEvidenceInventory(projectId: string): Promise<OnboardingEvidenceInventory> {
    return this.projectRepository.getOnboardingEvidenceInventory(projectId);
  }

  async listCaseIdsForProject(projectId: string, limit = 10_000): Promise<string[]> {
    // DemoRepo tenancy: all cases (traces + exceptions + golden set) live in
    // the demo project. Return the union, deduped, capped at `limit`.
    // Gate candidates are excluded: the approval-time backfill must never
    // re-judge (and pay for) product-gate scaffolding.
    if (projectId !== demoProject.id) return [];
    const ids = new Set<string>();
    for (const caseId of this.store.traces.keys()) {
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
    if (this.store.traces.has(caseId)) return true;
    if (demoExceptions.some((exception) => exception.id === caseId)) return true;
    if (demoGoldenSet.some((entry) => entry.caseId === caseId)) return true;
    return false;
  }

  async createFeedbackSyncJob(input: { projectId: string; judgeRunId: string; provider: FeedbackSyncProvider }): Promise<FeedbackSyncJobRecord | null> {
    const run = this.store.judgeRuns.find((candidate) => candidate.id === input.judgeRunId && candidate.projectId === input.projectId);
    if (!run) return null;
    const traceSource = this.store.traceSources.get(run.caseId);
    if (!traceSource || traceSource.source !== input.provider || !traceSource.sourceIntegrationId) return null;
    const integration = input.provider === "langfuse"
      ? this.store.langfuseIntegrations.get(traceSource.sourceIntegrationId)
      : input.provider === "ironside"
        ? this.store.ironsideIntegrations.get(traceSource.sourceIntegrationId)
        : this.store.langSmithIntegrations.get(traceSource.sourceIntegrationId);
    if (!integration) return null;
    const key = `${input.projectId}:${input.provider}:${input.judgeRunId}`;
    const existingJobId = this.store.feedbackJobRunIds.get(key);
    if (existingJobId) {
      const existing = this.store.feedbackJobs.get(existingJobId);
      return existing && existing.status !== "synced"
        ? { id: existing.id, projectId: input.projectId, judgeRunId: input.judgeRunId, provider: input.provider, status: existing.status }
        : null;
    }
    const id = `fsync_${randomUUID()}`;
    this.store.feedbackJobs.set(id, {
      id,
      projectId: input.projectId,
      provider: input.provider,
      judgeRun: { ...run, modelBinding: demoSkill.currentVersion.modelBinding },
      sourceTraceId: traceSource.sourceTraceId,
      sourceTraceVersion: traceSource.sourceTraceVersion ?? null,
      criterionStableKey: "response-quality",
      integration,
      status: "pending"
    });
    this.store.feedbackJobRunIds.set(key, id);
    return { id, projectId: input.projectId, judgeRunId: input.judgeRunId, provider: input.provider, status: "pending" };
  }

  async loadFeedbackSyncContext(job: FeedbackSyncJob): Promise<FeedbackSyncContext> {
    const context = this.store.feedbackJobs.get(job.feedbackSyncJobId);
    if (!context || context.projectId !== job.projectId) throw new FeedbackSyncJobNotFoundError(job.feedbackSyncJobId);
    return context;
  }

  async listFeedbackSyncJobs(input: ListFeedbackSyncJobsInput): Promise<FeedbackSyncJobListItem[]> {
    return [...this.store.feedbackJobs.values()]
      .filter((job) => job.projectId === input.projectId && (!input.status || job.status === input.status))
      .slice(0, input.limit)
      .map((job) => ({
        id: job.id,
        projectId: job.projectId,
        judgeRunId: job.judgeRun.id,
        provider: job.provider,
        status: job.status,
        attempts: this.store.feedbackJobAttempts.get(job.id) ?? 0,
        lastError: this.store.feedbackJobLastError.get(job.id) ?? null,
        createdAt: new Date().toISOString()
      }));
  }

  async markFeedbackSyncSucceeded(job: FeedbackSyncJob): Promise<void> {
    const context = await this.loadFeedbackSyncContext(job);
    this.store.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "synced" });
  }

  async markFeedbackSyncFailed(job: FeedbackSyncJob, error: unknown): Promise<void> {
    const context = await this.loadFeedbackSyncContext(job);
    this.store.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "failed" });
    // PG parity (C7): failures increment attempts and record the error.
    this.store.feedbackJobAttempts.set(job.feedbackSyncJobId, (this.store.feedbackJobAttempts.get(job.feedbackSyncJobId) ?? 0) + 1);
    this.store.feedbackJobLastError.set(job.feedbackSyncJobId, error instanceof Error ? error.message : String(error));
  }

  async markFeedbackSyncBlocked(job: FeedbackSyncJob, error: unknown): Promise<void> {
    const context = await this.loadFeedbackSyncContext(job);
    this.store.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "blocked" });
    this.store.feedbackJobLastError.set(job.feedbackSyncJobId, error instanceof Error ? error.message : String(error));
  }

  async markFeedbackSyncPending(job: FeedbackSyncJob): Promise<void> {
    const context = this.store.feedbackJobs.get(job.feedbackSyncJobId);
    if (!context || context.projectId !== job.projectId) {
      throw new FeedbackSyncJobNotFoundError(job.feedbackSyncJobId);
    }
    if (context.status !== "blocked") return;
    this.store.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "pending" });
    this.store.feedbackJobLastError.delete(job.feedbackSyncJobId);
  }

  async listBlockedIronsideFeedbackSyncJobs(projectId: string, integrationId: string): Promise<FeedbackSyncJob[]> {
    return [...this.store.feedbackJobs.values()]
      .filter((job) =>
        job.projectId === projectId &&
        job.provider === "ironside" &&
        job.integration.id === integrationId &&
        job.status === "blocked"
      )
      .map((job) => ({ projectId: job.projectId, feedbackSyncJobId: job.id }));
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
    remoteProjectId: integration.remoteProjectId,
    remoteProjectName: integration.remoteProjectName,
    protocolVersion: integration.protocolVersion,
    settlementQuietPeriodSeconds: integration.settlementQuietPeriodSeconds,
    revalidationRequired: integration.revalidationRequired,
    pollEnabled: integration.pollEnabled,
    pollIntervalSeconds: integration.pollIntervalSeconds,
    pollLimit: integration.pollLimit,
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
