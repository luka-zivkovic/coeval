import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AssessmentReceipt,
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
  EvalRunItemStatus,
  EvalRunStatus,
  EvalRunTrigger,
  GoldenSetEntry,
  ConvergenceAuditPage,
  ConvergenceCaseChange,
  SelfConsistencyReport,
  DisagreementSummary,
  ImportJobRecord,
  ImportJobStatus,
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
  GoldenSetRetirementContext,
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
  GateCheckItem,
  JudgeCardAuditEntry,
  TraceTestDetail,
  TraceTestRevision,
  TraceTestSummary,
  TraceTestRunSource,
  TraceTestValidation
} from "@coeval/shared";
import { capabilityGapsFromExceptions } from "./lib/capability-gaps.js";
import {
  deriveGateCheckDecision,
  GoldenSetRetirementContextSchema,
  IronsideConnectionTestResultSchema,
  IronsideSyncStateSchema,
  LangfuseConnectionTestResultSchema,
  LangSmithConnectionTestResultSchema,
  MinimumVerdictOutputSchema,
  RegressionRunResultSchema,
  SkillSchema,
  SkillVersionSchema,
  StoredModelBindingSchema,
  VerdictLabelSchema,
  VerdictPayloadSchema,
  VerdictRecordSchema,
  isInternalTraceMetadata,
  effectiveHumanLabel,
  regressionDirectionCounts,
  verdictLabelFromPayload
} from "@coeval/shared";
import type { Trace } from "@coeval/audit/runtime";
import { createJudgeProvider, type JudgeProviderFactory } from "./lib/judge-provider.js";
import { PgEvaluatorLifecycleRepository } from "./evaluator-lifecycle/repository.pg.js";
import { decryptJson, encryptJson } from "./lib/encryption.js";
import { generateApiKey, hashApiKey } from "./lib/api-keys.js";
import { normalizeTracePayload, redactNormalizedTracePayload, type NormalizedTracePayload, type NormalizedTraceStep } from "./lib/redaction.js";
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
  evaluatorSuiteArtifactDigest,
  evaluatorSuiteCreateRequestDigest,
  evaluatorSuiteCriterionDigest,
  parseCanonicalEvaluatorSuiteManifestBytes
} from "./lib/evaluator-suite.js";
import {
  assertTraceIngestionPurpose,
  computeEvalRunSpend,
  convergencePageLimit,
  decodeConvergenceCursor,
  encodeConvergenceCursor,
  judgeKeyDisplay,
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
  AssessmentReceiptIntegrityError,
  AssessmentReceiptUnavailableError,
  CaseNotFoundError,
  CriterionStableKeyConflictError,
  DatasetNameTakenError,
  DatasetRevisionConflictError,
  DatasetRevisionNotFoundError,
  GoldenSetLabelConflictError,
  EvaluatorSuiteBindingError,
  EvaluatorSuiteIdempotencyConflictError,
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
  IronsideIntegrationNotFoundError,
  LangfuseCredentialsMissingError,
  LangfuseIntegrationNotFoundError,
  LangSmithCredentialsMissingError,
  LangSmithIntegrationNotFoundError,
  NoCurrentSkillError,
  OnboardingCheckConflictError,
  RecursiveTraceSkippedError,
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
  type AssessmentReceiptArtifactSource,
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
  type FeedbackSyncStatus,
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
  datasetInputIdentity,
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest,
  decidePublicDatasetRevisionCreation
} from "./lib/dataset-revision.js";

export class PgRepository implements CoevalRepository {
  constructor(
    private readonly pool: Pool,
    private readonly judgeProviderFactory: JudgeProviderFactory = createJudgeProvider
  ) {}

  async listProjects(userId?: string | undefined): Promise<Project[]> {
    const result = userId
      ? await this.pool.query(
          `select p.*
           from projects p
           join project_members pm on pm.project_id = p.id
           where pm.user_id = $1
           order by p.created_at asc`,
          [userId]
        )
      : await this.pool.query(`select * from projects order by created_at asc`);
    return result.rows.map(rowToProject);
  }

  async getProjectSettings(projectId: string): Promise<ProjectSettings> {
    const result = await this.pool.query(
      `select id, name, mode, trace_retention_days from projects where id = $1`,
      [projectId]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return rowToProjectSettings(row);
  }

  async updateProjectSettings(projectId: string, input: UpdateProjectSettingsInput, context: { actorUserId?: string | undefined }): Promise<ProjectSettings> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update projects
         set trace_retention_days = $2,
             mode = coalesce($3, mode),
             updated_at = now()
         where id = $1
         returning id, name, mode, trace_retention_days`,
        [projectId, input.traceRetentionDays, input.mode ?? null]
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Project not found: ${projectId}`);
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          projectId,
          context.actorUserId ?? null,
          "project.retention.update",
          "project",
          projectId,
          JSON.stringify({ traceRetentionDays: input.traceRetentionDays, ...(input.mode ? { mode: input.mode } : {}) })
        ]
      );
      await client.query("commit");
      return rowToProjectSettings(row);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async pruneExpiredTraces(projectId: string, context: { actorUserId?: string | undefined; now?: Date | undefined }): Promise<RetentionPruneResult> {
    const now = context.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const settingsResult = await client.query(
        `select id, trace_retention_days, last_retention_pruned_at
         from projects
         where id = $1
         for update`,
        [projectId]
      );
      const settings = settingsResult.rows[0];
      if (!settings) throw new Error(`Project not found: ${projectId}`);
      const traceRetentionDays = settings.trace_retention_days === null || settings.trace_retention_days === undefined ? null : Number(settings.trace_retention_days);
      if (!traceRetentionDays) {
        await client.query("commit");
        return {
          projectId,
          traceRetentionDays: null,
          cutoff: null,
          deletedCases: 0,
          deletedRawTraces: 0,
          skippedActiveGoldenCases: 0,
          skippedImmutableRevisionCases: 0
        };
      }

      const cutoff = new Date(now.getTime() - traceRetentionDays * 24 * 60 * 60 * 1000);
      const lastPrunedAt = settings.last_retention_pruned_at instanceof Date
        ? settings.last_retention_pruned_at
        : settings.last_retention_pruned_at
          ? new Date(String(settings.last_retention_pruned_at))
          : null;
      if (lastPrunedAt && now.getTime() - lastPrunedAt.getTime() < 60_000) {
        await client.query("commit");
        return {
          projectId,
          traceRetentionDays,
          cutoff: cutoff.toISOString(),
          deletedCases: 0,
          deletedRawTraces: 0,
          skippedActiveGoldenCases: 0,
          skippedImmutableRevisionCases: 0
        };
      }

      const skippedResult = await client.query(
        `select count(*)::int as count
         from cases c
         join raw_traces rt on rt.id = c.raw_trace_id
         where c.project_id = $1
           and rt.created_at < $2
           and exists (
             select 1
             from golden_set_entries gse
             where gse.project_id = $1
               and gse.case_id = c.id
               and gse.retired_at is null
           )`,
        [projectId, cutoff.toISOString()]
      );
      const skippedRevisionResult = await client.query(
        `select count(*)::int as count
         from cases c
         join raw_traces rt on rt.id = c.raw_trace_id
         where c.project_id = $1
           and rt.created_at < $2
           and exists (
             select 1
             from dataset_revision_items revision_item
             where revision_item.project_id = $1
               and revision_item.source_case_id = c.id
           )
           and not exists (
             select 1
             from golden_set_entries gse
             where gse.project_id = $1
               and gse.case_id = c.id
               and gse.retired_at is null
           )`,
        [projectId, cutoff.toISOString()]
      );
      const deletedCases = await client.query(
        `delete from cases c
         using raw_traces rt
         where c.raw_trace_id = rt.id
           and c.project_id = $1
           and rt.project_id = $1
           and rt.created_at < $2
           -- A receipt is stable evidence, so its source case must outlive
           -- customer-traffic retention pruning.
           and c.case_type <> 'release_evidence'
           -- Immutable revisions remain executable evidence. The revision
           -- carries a redacted payload snapshot, while the retained case id
           -- keeps the existing append-only verdict/judge ledgers usable.
           and not exists (
             select 1
             from dataset_revision_items revision_item
             where revision_item.project_id = $1
               and revision_item.source_case_id = c.id
           )
           and not exists (
             select 1
             from golden_set_entries gse
             where gse.project_id = $1
               and gse.case_id = c.id
               and gse.retired_at is null
           )`,
        [projectId, cutoff.toISOString()]
      );
      const deletedRawTraces = await client.query(
        `delete from raw_traces rt
         where rt.project_id = $1
           and rt.created_at < $2
           and not exists (
             select 1
             from cases c
             where c.raw_trace_id = rt.id
           )`,
        [projectId, cutoff.toISOString()]
      );
      await this.refreshProjectCounters(client, projectId);
      await client.query(`update projects set last_retention_pruned_at = $2 where id = $1`, [projectId, now.toISOString()]);
      const result: RetentionPruneResult = {
        projectId,
        traceRetentionDays,
        cutoff: cutoff.toISOString(),
        deletedCases: deletedCases.rowCount ?? 0,
        deletedRawTraces: deletedRawTraces.rowCount ?? 0,
        skippedActiveGoldenCases: Number(skippedResult.rows[0]?.count ?? 0),
        skippedImmutableRevisionCases: Number(skippedRevisionResult.rows[0]?.count ?? 0)
      };
      if (
        result.deletedCases > 0 ||
        result.deletedRawTraces > 0 ||
        result.skippedActiveGoldenCases > 0 ||
        result.skippedImmutableRevisionCases > 0
      ) {
        await client.query(
          `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            `audit_${randomUUID()}`,
            projectId,
            context.actorUserId ?? null,
            "project.retention.prune",
            "project",
            projectId,
            JSON.stringify(result)
          ]
        );
      }
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteProject(projectId: string, input: { confirmProjectName: string; actorUserId?: string | undefined }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const projectResult = await client.query(`select id, name from projects where id = $1 for update`, [projectId]);
      const project = projectResult.rows[0];
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const projectName = String(project.name);
      if (input.confirmProjectName !== projectName) throw new Error("Project confirmation did not match");

      await client.query(
        `update audit_logs
         set metadata = metadata || jsonb_build_object('deletedProjectId', $1),
             project_id = null
         where project_id = $1`,
        [projectId]
      );
      await client.query(`update raw_traces set source_integration_id = null where project_id = $1`, [projectId]);
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,null,$2,$3,$4,$5,$6)`,
        [
          `audit_${randomUUID()}`,
          input.actorUserId ?? null,
          "project.delete",
          "project",
          projectId,
          JSON.stringify({ deletedProjectId: projectId, projectName })
        ]
      );
      await client.query(`delete from projects where id = $1`, [projectId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getDashboardSummary(projectId: string, criterionId?: string | undefined): Promise<DashboardSummary> {
    const project = (await this.pool.query(`select * from projects where id = $1`, [projectId])).rows[0];
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const skill = criterionId
      ? await this.getCurrentSkillForCriterion(projectId, criterionId)
      : await this.getCurrentSkill(projectId);
    const criterionVersionId = skill.currentVersion.criterionVersionId;
    const goldenSet = await this.listGoldenSet(projectId, criterionVersionId);
    const exceptions = await this.listExceptionCases(projectId, criterionVersionId);
    // P1-4 dashboard honesty: one vote per case — the skill's LATEST verdict
    // on each judged case. Counting every judge_runs row inflated the chart
    // with superseded versions and repeat probes (observed: 102 verdicts over
    // 40 traces).
    const distributionRows = await this.pool.query(
      `select verdict, count(*)::int as count from (
         select distinct on (jr.case_id) jr.verdict
         from judge_runs jr
         join cases c on c.id = jr.case_id
         join skill_versions sv on sv.id = jr.skill_version_id and sv.project_id = jr.project_id
         where jr.project_id = $1
           and sv.criterion_version_id = $2
           -- Governed evaluation scaffolding is not judged customer traffic.
           and c.case_type not in ('gate_candidate', 'release_evidence')
         order by jr.case_id, jr.created_at desc, jr.id desc
       ) latest group by verdict`,
      [projectId, criterionVersionId]
    );
    const verdictDistribution = { pass: 0, fail: 0, ambiguous: 0 };
    for (const row of distributionRows.rows) {
      if (row.verdict === "pass" || row.verdict === "fail" || row.verdict === "ambiguous") {
        const verdict = row.verdict as keyof typeof verdictDistribution;
        verdictDistribution[verdict] = Number(row.count);
      }
    }
    const currentVersionResultCount = Number((await this.pool.query(
      `select count(distinct jr.case_id)::int as count
       from judge_runs jr
       join cases c on c.id = jr.case_id and c.project_id = jr.project_id
       where jr.project_id = $1
         and jr.skill_version_id = $2
         and c.case_type not in ('gate_candidate', 'release_evidence')`,
      [projectId, skill.currentVersion.id]
    )).rows[0]?.count ?? 0);

    return {
      project: rowToProject(project),
      skill,
      currentVersionResultCount,
      verdictDistribution,
      exceptions,
      topCapabilityGaps: capabilityGapsFromExceptions(exceptions),
      goldenSetSize: goldenSet.length,
      // Repository default; the /api/dashboard route overwrites this with the
      // requesting user's actual project role.
      viewerRole: "owner"
    };
  }

  async listCriteria(projectId: string): Promise<Criterion[]> {
    const result = await this.pool.query(
      `select * from criteria where project_id = $1 order by created_at asc, id asc`,
      [projectId]
    );
    return result.rows.map(rowToCriterion);
  }

  async getCriterion(projectId: string, criterionId: string): Promise<CriterionDetail | null> {
    const criterion = (await this.pool.query(
      `select * from criteria where project_id = $1 and id = $2`,
      [projectId, criterionId]
    )).rows[0];
    if (!criterion) return null;
    const versions = await this.pool.query(
      `select * from criterion_versions
       where project_id = $1 and criterion_id = $2
       order by revision desc, id desc`,
      [projectId, criterionId]
    );
    return {
      criterion: rowToCriterion(criterion),
      versions: versions.rows.map(rowToCriterionVersion)
    };
  }

  async createCriterion(
    projectId: string,
    input: CreateCriterionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CreatedCriterion> {
    const client = await this.pool.connect();
    const criterionId = `criterion_${randomUUID()}`;
    const criterionVersionId = `criterionv_${randomUUID()}`;
    const skillId = `skill_${randomUUID()}`;
    const skillVersionId = `skillv_${randomUUID()}`;
    const criterionDigest = evaluatorSuiteCriterionDigest({
      criterionId,
      criterionVersionId,
      criterionName: input.name,
      criterionDefinition: input.definition
    });
    try {
      await client.query("begin");
      const criterion = (await client.query(
        `insert into criteria
          (id, project_id, stable_key, source_kind, created_by_user_id)
         values ($1, $2, $3, 'native', $4)
         returning *`,
        [criterionId, projectId, input.stableKey, context.actorUserId ?? null]
      )).rows[0];
      const version = (await client.query(
        `insert into criterion_versions
          (id, project_id, criterion_id, revision, name, definition,
           criterion_digest, source_kind, created_by_user_id)
         values ($1, $2, $3, 1, $4, $5, $6, 'native', $7)
         returning *`,
        [
          criterionVersionId,
          projectId,
          criterionId,
          input.name,
          input.definition,
          criterionDigest,
          context.actorUserId ?? null
        ]
      )).rows[0];
      await client.query(
        `insert into skills
          (id, project_id, name, description, owner_user_id, status, is_starter, criterion_id)
         values ($1, $2, $3, $4, $5, 'draft', false, $6)`,
        [skillId, projectId, input.name, input.definition, context.actorUserId ?? null, criterionId]
      );
      const skillVersion: SkillVersion = {
        id: skillVersionId,
        skillId,
        criterionVersionId,
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
        createdAt: new Date().toISOString(),
        approvedAt: null
      };
      await this.insertSkillVersion(
        client,
        skillVersion,
        projectId,
        criterionVersionId,
        context.actorUserId ?? null
      );
      await client.query("commit");
      return {
        criterion: rowToCriterion(criterion),
        versions: [rowToCriterionVersion(version)],
        evaluator: {
          id: skillId,
          projectId,
          criterionId,
          name: input.name,
          description: input.definition,
          ownerName: context.actorUserId ?? "API key",
          status: "draft",
          isStarter: false,
          currentVersion: skillVersion
        }
      };
    } catch (error) {
      await client.query("rollback");
      if (isUniqueViolation(error)) throw new CriterionStableKeyConflictError(input.stableKey);
      throw error;
    } finally {
      client.release();
    }
  }

  async createCriterionVersion(
    projectId: string,
    criterionId: string,
    input: CreateCriterionVersionInput,
    context: { actorUserId?: string | undefined }
  ): Promise<CriterionVersion | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const criterion = await client.query(
        `select id from criteria where project_id = $1 and id = $2 for update`,
        [projectId, criterionId]
      );
      if (!criterion.rowCount) {
        await client.query("rollback");
        return null;
      }
      const revisionRow = (await client.query(
        `select coalesce(max(revision), 0)::int + 1 as revision
         from criterion_versions where project_id = $1 and criterion_id = $2`,
        [projectId, criterionId]
      )).rows[0];
      const revision = Number(revisionRow?.revision ?? 1);
      const id = `criterionv_${randomUUID()}`;
      const criterionDigest = evaluatorSuiteCriterionDigest({
        criterionId,
        criterionVersionId: id,
        criterionName: input.name,
        criterionDefinition: input.definition
      });
      const inserted = (await client.query(
        `insert into criterion_versions
          (id, project_id, criterion_id, revision, name, definition,
           criterion_digest, source_kind, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'native', $8)
         returning *`,
        [id, projectId, criterionId, revision, input.name, input.definition, criterionDigest, context.actorUserId ?? null]
      )).rows[0];
      await client.query("commit");
      return rowToCriterionVersion(inserted);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvaluatorSuites(projectId: string): Promise<EvaluatorSuite[]> {
    const result = await this.pool.query(
      `select * from evaluator_suites where project_id = $1 order by created_at desc, id desc`,
      [projectId]
    );
    return result.rows.map(rowToEvaluatorSuite);
  }

  async getEvaluatorSuite(projectId: string, suiteId: string): Promise<EvaluatorSuite | null> {
    const row = (await this.pool.query(
      `select * from evaluator_suites where project_id = $1 and id = $2`,
      [projectId, suiteId]
    )).rows[0];
    return row ? rowToEvaluatorSuite(row) : null;
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
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const project = await client.query(`select id from projects where id = $1 for update`, [projectId]);
      if (!project.rowCount) throw new Error(`Project not found: ${projectId}`);
      const priorAttempt = (await client.query(
        `select canonical_bytes, request_digest from evaluator_suite_manifests
         where project_id = $1 and idempotency_key = $2`,
        [projectId, input.idempotencyKey]
      )).rows[0];
      if (priorAttempt) {
        const existing = parseCanonicalEvaluatorSuiteManifestBytes(
          Buffer.from(priorAttempt.canonical_bytes as Uint8Array)
        );
        if (String(priorAttempt.request_digest) !== evaluatorSuiteCreateRequestDigest(input)) {
          throw new EvaluatorSuiteIdempotencyConflictError(input.idempotencyKey);
        }
        await client.query("commit");
        return existing;
      }
      let suiteId = input.suiteId;
      if (suiteId) {
        const suite = await client.query(
          `select id from evaluator_suites where project_id = $1 and id = $2 for update`,
          [projectId, suiteId]
        );
        if (!suite.rowCount) {
          throw new EvaluatorSuiteBindingError(`Evaluator suite not found in this project: ${suiteId}`);
        }
      } else {
        suiteId = `suite_${randomUUID()}`;
        await client.query(
          `insert into evaluator_suites (id, project_id, created_by_user_id) values ($1, $2, $3)`,
          [suiteId, projectId, context.actorUserId ?? null]
        );
      }

      const memberInputs = [];
      for (const [position, binding] of input.members.entries()) {
        const row = (await client.query(
          `select criterion_version.criterion_id,
                  criterion_version.id as bound_criterion_version_id,
                  criterion_version.name as criterion_name,
                  criterion_version.definition as criterion_definition,
                  skill_version.*
           from criterion_versions criterion_version
           join skills skill
             on skill.project_id = criterion_version.project_id
            and skill.criterion_id = criterion_version.criterion_id
           join skill_versions skill_version
             on skill_version.project_id = skill.project_id
            and skill_version.skill_id = skill.id
            and skill_version.criterion_version_id = criterion_version.id
           where criterion_version.project_id = $1
             and criterion_version.id = $2
             and skill_version.id = $3
             and evaluator_skill_version_context_allowed_v1($1,skill_version.id,'suite_publication')`,
          [projectId, binding.criterionVersionId, binding.skillVersionId]
        )).rows[0];
        if (!row) {
          throw new EvaluatorSuiteBindingError(
            `Suite member ${position} must bind a criterion version to its exact evaluator version in this project.`
          );
        }
        memberInputs.push({
          criterionId: String(row.criterion_id),
          criterionVersionId: String(row.bound_criterion_version_id),
          criterionName: String(row.criterion_name),
          criterionDefinition: String(row.criterion_definition),
          skillVersion: rowToSkillVersion(row)
        });
      }
      if (new Set(memberInputs.map((member) => member.criterionId)).size !== memberInputs.length) {
        throw new EvaluatorSuiteBindingError(
          "Evaluator suite members must bind distinct stable criteria, not multiple versions of one criterion."
        );
      }

      const revision = Number((await client.query(
        `select coalesce(max(revision), 0)::int + 1 as revision
         from evaluator_suite_manifests where project_id = $1 and suite_id = $2`,
        [projectId, suiteId]
      )).rows[0]?.revision ?? 1);
      const manifest = buildEvaluatorSuiteManifest({
        manifestId: `manifest_${randomUUID()}`,
        suiteId,
        projectId,
        revision,
        members: memberInputs,
        trialPlan: input.trialPlan
      });
      const canonicalBytes = canonicalEvaluatorSuiteManifestBytes(manifest);
      const artifactDigest = evaluatorSuiteArtifactDigest(canonicalBytes);
      await client.query(
        `insert into evaluator_suite_manifests
          (id, suite_id, project_id, revision, contract, schema_version, member_count,
           trial_plan, canonical_bytes, artifact_digest, manifest_digest, created_by_user_id,
           idempotency_key, request_digest)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          manifest.manifestId,
          manifest.suiteId,
          manifest.projectId,
          manifest.revision,
          manifest.contract,
          manifest.schemaVersion,
          manifest.members.length,
          JSON.stringify(manifest.trialPlan),
          canonicalBytes,
          artifactDigest,
          manifest.manifestDigest,
          context.actorUserId ?? null,
          input.idempotencyKey,
          evaluatorSuiteCreateRequestDigest(input)
        ]
      );
      for (const member of manifest.members) {
        await client.query(
          `insert into evaluator_suite_manifest_members
            (manifest_id, suite_id, project_id, position, criterion_id, criterion_version_id,
             criterion_name, criterion_definition, criterion_digest, skill_id, skill_version_id,
             skill_digest, output_contract_digest, applicability)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            manifest.manifestId,
            manifest.suiteId,
            manifest.projectId,
            member.position,
            member.criterionId,
            member.criterionVersionId,
            member.criterionName,
            member.criterionDefinition,
            member.criterionDigest,
            member.skillId,
            member.skillVersionId,
            member.skillDigest,
            member.outputContractDigest,
            JSON.stringify(member.applicability)
          ]
        );
      }
      await client.query("commit");
      return manifest;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvaluatorSuiteManifests(
    projectId: string,
    suiteId?: string | undefined
  ): Promise<EvaluatorSuiteManifest[]> {
    const result = await this.pool.query(
      `select canonical_bytes from evaluator_suite_manifests
       where project_id = $1 ${suiteId ? "and suite_id = $2" : ""}
       order by suite_id asc, revision desc, id desc`,
      suiteId ? [projectId, suiteId] : [projectId]
    );
    return result.rows.map((row) =>
      parseCanonicalEvaluatorSuiteManifestBytes(Buffer.from(row.canonical_bytes as Uint8Array))
    );
  }

  async getEvaluatorSuiteManifest(
    projectId: string,
    manifestId: string
  ): Promise<EvaluatorSuiteManifest | null> {
    const row = (await this.pool.query(
      `select canonical_bytes from evaluator_suite_manifests where project_id = $1 and id = $2`,
      [projectId, manifestId]
    )).rows[0];
    return row
      ? parseCanonicalEvaluatorSuiteManifestBytes(Buffer.from(row.canonical_bytes as Uint8Array))
      : null;
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
      await this.getOrCreateRegressionDatasetRevisionWithClient(
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
      await this.getOrCreateRegressionDatasetRevisionWithClient(
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
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await this.importTraceOnClient(client, projectId, source, input, context);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  // The import body, callable inside a caller-owned transaction — the examples
  // bulk path runs many of these plus the dataset-membership writes in ONE
  // transaction so a mid-flow failure can't strand membership-less cases.
  private async lockTraceImportIdentity(
    client: PoolClient,
    projectId: string,
    source: CaseSource,
    sourceTraceId: string
  ): Promise<void> {
    await client.query(
      `select pg_advisory_xact_lock(
         hashtextextended(jsonb_build_array($1::text, $2::text, $3::text)::text, 0)
       )`,
      [projectId, source, sourceTraceId]
    );
  }

  private async importTraceOnClient(
    client: PoolClient,
    projectId: string,
    source: CaseSource,
    input: ManualTraceImportInput,
    context: TraceImportContext
  ): Promise<TraceImportResult> {
    assertTraceIngestionPurpose(source, context.ingestionPurpose);
    if (isInternalTraceMetadata(input.metadata)) {
      throw new RecursiveTraceSkippedError(input.sourceTraceId);
    }
    const rawTraceId = `raw_${randomUUID()}`;
    const caseId = `case_${randomUUID()}`;
    const sourceTraceId = input.sourceTraceId?.trim() || `${source}_${randomUUID()}`;
    const normalizationVersion = context.normalizationVersion ?? `${source}-v1`;
    const rawPayload = normalizeTracePayload(input);
    const normalizedPayload = redactNormalizedTracePayload(rawPayload, context.redactionConfig);

    // Purpose records the immutable first origin; it does not create a second
    // identity for the same upstream trace. Serialize this identity before
    // checking so concurrent product paths cannot both mint an origin.
    // Legacy duplicate rows, if any, resolve to the earliest retained origin.
    await this.lockTraceImportIdentity(client, projectId, source, sourceTraceId);
    const existing = await client.query(
      `select rt.id as raw_trace_id, c.id as case_id, rt.source_trace_id
       from raw_traces rt
       join cases c on c.raw_trace_id = rt.id
       where rt.project_id = $1
         and c.project_id = $1
         and rt.source_trace_id = $2
         and c.case_type = $3
       order by c.created_at asc, c.id asc, rt.created_at asc, rt.id asc
       limit 1`,
      [projectId, sourceTraceId, source]
    );
    if (existing.rows[0]) {
      return {
        rawTraceId: String(existing.rows[0].raw_trace_id),
        caseId: String(existing.rows[0].case_id),
        sourceTraceId: String(existing.rows[0].source_trace_id),
        created: false
      };
    }

    await client.query(
      `insert into raw_traces
       (id, project_id, source_integration_id, source_trace_id, import_job_id, raw_payload, normalization_version)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [rawTraceId, projectId, context.sourceIntegrationId ?? null, sourceTraceId, context.importJobId ?? null, JSON.stringify(rawPayload), normalizationVersion]
    );
    await client.query(
      `insert into cases
       (id, project_id, raw_trace_id, case_type, normalized_payload, ingestion_purpose)
       values ($1,$2,$3,$4,$5,$6)`,
      [caseId, projectId, rawTraceId, source, JSON.stringify(normalizedPayload), context.ingestionPurpose]
    );
    const inputIdentity = datasetInputIdentity({ input: input.input });
    await client.query(
      `insert into case_input_identity_records
       (id, project_id, source_case_id, record_kind, identity_basis, input_digest)
       values ($1,$2,$3,'authoring_import',$4,$5)
       on conflict (project_id, source_case_id, record_kind) do nothing`,
      [`ciir_${randomUUID()}`, projectId, caseId, inputIdentity.basis, inputIdentity.digest]
    );
    // Gate candidates are product-gate scaffolding, not imported customer
    // traffic — they must not move the imported-trace counter (mirrors the
    // refreshProjectCounters recount, which also skips them).
    if (source !== "gate_candidate" && source !== "release_evidence") {
      await client.query(
        `update projects
         set imported_trace_count = imported_trace_count + 1,
             updated_at = now()
         where id = $1`,
        [projectId]
      );
    }
    return { rawTraceId, caseId, sourceTraceId, created: true };
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
        await this.lockTraceImportIdentity(client, input.projectId, "manual", sourceTraceId);
      }

      const results: ImportDatasetExamplesDbResult["items"] = [];
      for (const item of input.items) {
        const imported = await this.importTraceOnClient(client, input.projectId, "manual", {
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

  // BYO judge keys — integrations masking split: the encrypted column
  // never appears in a client-facing SELECT; decryption happens only in the
  // worker-facing getJudgeProviderCredential.
  async setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string, actorUserId?: string): Promise<JudgeProviderKey> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const key = await this.setJudgeProviderKeyOnClient(client, projectId, provider, apiKey, actorUserId);
      await client.query("commit");
      return key;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async setJudgeProviderKeyOnClient(
    client: PoolClient,
    projectId: string,
    provider: JudgeKeyProvider,
    apiKey: string,
    actorUserId?: string
  ): Promise<JudgeProviderKey> {
    const result = await client.query(
      `insert into judge_provider_keys (id, project_id, provider, encrypted_credentials, key_display)
       values ($1, $2, $3, $4, $5)
       on conflict (project_id, provider) do update set
         encrypted_credentials = excluded.encrypted_credentials,
         key_display = excluded.key_display,
         created_at = now()
       returning provider, key_display, created_at`,
      [`jpk_${randomUUID()}`, projectId, provider, encryptJson({ apiKey }), judgeKeyDisplay(apiKey)]
    );
    await client.query(
      `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [`audit_${randomUUID()}`, projectId, actorUserId ?? null, "project.judge_key.set", "judge_provider_key", provider, JSON.stringify({ provider })]
    );
    const row = result.rows[0];
    return {
      provider: String(row.provider) as JudgeKeyProvider,
      keyDisplay: String(row.key_display),
      createdAt: toIso(row.created_at)
    };
  }

  async listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]> {
    const result = await this.pool.query(
      `select provider, key_display, created_at from judge_provider_keys
       where project_id = $1 order by provider asc`,
      [projectId]
    );
    return result.rows.map((row) => ({
      provider: String(row.provider) as JudgeKeyProvider,
      keyDisplay: String(row.key_display),
      createdAt: toIso(row.created_at)
    }));
  }

  async deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, actorUserId?: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from judge_provider_keys where project_id = $1 and provider = $2`,
      [projectId, provider]
    );
    const removed = (result.rowCount ?? 0) > 0;
    if (removed) {
      await this.pool.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [`audit_${randomUUID()}`, projectId, actorUserId ?? null, "project.judge_key.removed", "judge_provider_key", provider, JSON.stringify({ provider })]
      );
    }
    return removed;
  }

  async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
    const result = await this.pool.query(
      `select encrypted_credentials from judge_provider_keys
       where project_id = $1 and provider = $2`,
      [projectId, provider]
    );
    const row = result.rows[0];
    if (!row) return null;
    return decryptJson<{ apiKey?: string }>(String(row.encrypted_credentials)).apiKey ?? null;
  }

  async createImportJob(input: CreateImportJobInput): Promise<ImportJobRecord> {
    const importJobId = `import_${randomUUID()}`;
    const skillVersionId = await this.resolveImportSkillVersionId(input.projectId, input.skillVersionId);
    await this.authorizeSkillVersionExecution({
      projectId: input.projectId,
      skillVersionId,
      context: input.sourceIntegrationId ? "scheduled_import" : "manual_import",
      resourceKind: "import_job",
      resourceId: importJobId,
      idempotencyKey: `import-job:${importJobId}:${skillVersionId}`
    });
    await this.pool.query(
      `insert into import_jobs
       (id, project_id, status, source, source_integration_id, actor_user_id, requested_limit, skill_version_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id`,
      [
        importJobId,
        input.projectId,
        "queued",
        input.source,
        input.sourceIntegrationId ?? null,
        input.actorUserId ?? null,
        input.requestedLimit ?? null,
        skillVersionId
      ]
    );
    return this.loadImportJobRecord(input.projectId, importJobId);
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

  private async resolveIntegrationSkillVersionId(
    projectId: string,
    requested?: string | undefined
  ): Promise<string | null> {
    if (requested) return this.resolveImportSkillVersionId(projectId, requested, "scheduled_import");
    try {
      return await this.resolveImportSkillVersionId(projectId,undefined,"scheduled_import");
    } catch (error) {
      // Connections may be configured before the project's first evaluator
      // exists. Such a connection is durably unselected and scheduled polling
      // skips it until an exact version can be snapshotted at enqueue time.
      if (error instanceof NoCurrentSkillError) return null;
      throw error;
    }
  }

  async markImportJobQueued(projectId: string, importJobId: string, queueJobId: string): Promise<ImportJobRecord> {
    const result = await this.pool.query(
      `update import_jobs
       set queue_job_id = $3,
           status = 'queued',
           error = null
       where id = $1 and project_id = $2
       returning *`,
      [importJobId, projectId, queueJobId]
    );
    if (!result.rowCount) throw new Error(`Import job not found: ${importJobId}`);
    return this.loadImportJobRecord(projectId, importJobId);
  }

  async markImportJobRunning(projectId: string, importJobId: string): Promise<void> {
    const result = await this.pool.query(
      `update import_jobs
       set status = 'running',
           started_at = now(),
           error = null
       where id = $1 and project_id = $2`,
      [importJobId, projectId]
    );
    if (!result.rowCount) throw new Error(`Import job not found: ${importJobId}`);
  }

  async markImportJobCompleted(projectId: string, importJobId: string, result: CompleteImportJobInput): Promise<void> {
    const updated = await this.pool.query(
      `update import_jobs
       set status = 'completed',
           completed_at = now(),
           imported_count = (
             select count(*)::integer
             from raw_traces
             where project_id = $2
               and import_job_id = $1
           ),
           queued_judge_count = $3,
           error = null
       where id = $1 and project_id = $2`,
      [importJobId, projectId, result.queuedJudgeCount]
    );
    if (!updated.rowCount) throw new Error(`Import job not found: ${importJobId}`);
  }

  async markImportJobFailed(projectId: string, importJobId: string, error: unknown): Promise<ImportJobRecord> {
    const result = await this.pool.query(
      `update import_jobs
       set status = 'failed',
           completed_at = now(),
           error = $3
       where id = $1 and project_id = $2
       returning *`,
      [importJobId, projectId, error instanceof Error ? error.message : String(error)]
    );
    if (!result.rowCount) throw new Error(`Import job not found: ${importJobId}`);
    return this.loadImportJobRecord(projectId, importJobId);
  }

  async listImportJobs(input: ListImportJobsInput): Promise<ImportJobRecord[]> {
    const result = await this.pool.query(
      `select ij.*, u.email as actor_email, u.name as actor_name
       from import_jobs ij
       left join "user" u on u.id = ij.actor_user_id
       where ij.project_id = $1
         and ($2::text is null or ij.status = $2)
       order by ij.created_at desc
       limit $3`,
      [input.projectId, input.status ?? null, input.limit]
    );
    return result.rows.map(rowToImportJobRecord);
  }

  private async loadImportJobRecord(projectId: string, importJobId: string): Promise<ImportJobRecord> {
    const result = await this.pool.query(
      `select ij.*, u.email as actor_email, u.name as actor_name
       from import_jobs ij
       left join "user" u on u.id = ij.actor_user_id
       where ij.id = $1 and ij.project_id = $2`,
      [importJobId, projectId]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Import job not found: ${importJobId}`);
    return rowToImportJobRecord(row);
  }

  private async recordImportSelectionFailure(input: {
    projectId: string;
    source: "langsmith" | "langfuse" | "ironside";
    integrationId: string;
    requestedLimit: number;
    now: Date;
    code: "skill_version_required" | "invalid_skill_version";
  }): Promise<void> {
    await this.pool.query(
      `insert into import_jobs
         (id, project_id, status, source, source_integration_id, requested_limit,
          skill_version_id, created_at, completed_at, error)
       values ($1,$2,'failed',$3,$4,$5,null,$6,$6,$7)`,
      [
        `import_${randomUUID()}`,
        input.projectId,
        input.source,
        input.integrationId,
        input.requestedLimit,
        input.now.toISOString(),
        `${input.code}: configure an exact evaluator version before scheduled import`
      ]
    );
  }

  async createLangSmithIntegration(projectId: string, input: LangSmithIntegrationInput): Promise<LangSmithIntegration> {
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const result = await this.pool.query(
      `insert into integrations (id, project_id, provider, encrypted_credentials, config, poll_enabled, poll_interval_seconds, poll_limit)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (project_id, provider)
       do update set encrypted_credentials = excluded.encrypted_credentials,
                     config = excluded.config,
                     poll_enabled = $6,
                     poll_interval_seconds = $7,
                     poll_limit = $8,
                     last_tested_at = null,
                     last_test_result = null
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        `int_${randomUUID()}`,
        projectId,
        "langsmith",
        encryptJson({ apiKey: input.apiKey }),
        JSON.stringify({
          projectName: input.projectName ?? null,
          endpointUrl: input.endpointUrl ?? null,
          redaction: input.redaction ?? {},
          skillVersionId
        }),
        pollEnabled,
        pollIntervalSeconds,
        pollLimit
      ]
    );
    // Connecting a tracer graduates a bench project: evidence now includes a
    // trace stream, so the trace-centric IA takes over. Additive — datasets,
    // skill versions, and the golden set are untouched.
    await this.pool.query(`update projects set mode = 'tracing', updated_at = now() where id = $1 and mode <> 'tracing'`, [projectId]);
    return rowToLangSmithIntegration(result.rows[0]);
  }

  async listLangSmithIntegrations(projectId: string): Promise<LangSmithIntegration[]> {
    const result = await this.pool.query(
      `select id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at
       from integrations
       where project_id = $1 and provider = 'langsmith'
       order by created_at desc`,
      [projectId]
    );
    return result.rows.map(rowToLangSmithIntegration);
  }

  async updateLangSmithIntegration(projectId: string, integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration> {
    const skillVersionId = input.skillVersionId === undefined
      ? null
      : await this.resolveImportSkillVersionId(projectId, input.skillVersionId, "scheduled_import");
    const result = await this.pool.query(
      `update integrations
       set poll_enabled = coalesce($3::boolean, poll_enabled),
           poll_interval_seconds = coalesce($4::integer, poll_interval_seconds),
           poll_limit = coalesce($5::integer, poll_limit),
           config = case when $6::text is null then config
             else jsonb_set(config, '{skillVersionId}', to_jsonb($6::text), true) end
       where id = $1 and project_id = $2 and provider = 'langsmith'
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        integrationId,
        projectId,
        input.pollEnabled ?? null,
        input.pollIntervalSeconds ?? null,
        input.pollLimit ?? null,
        skillVersionId
      ]
    );
    const row = result.rows[0];
    if (!row) throw new LangSmithIntegrationNotFoundError(integrationId);
    return rowToLangSmithIntegration(row);
  }

  async recordLangSmithConnectionTest(projectId: string, integrationId: string, result: LangSmithConnectionTestResult): Promise<void> {
    const updated = await this.pool.query(
      `update integrations
       set last_tested_at = $3::timestamptz,
           last_test_result = $4::jsonb
       where id = $1 and project_id = $2 and provider = 'langsmith'`,
      [
        integrationId,
        projectId,
        result.checkedAt,
        JSON.stringify(result)
      ]
    );
    if (!updated.rowCount) throw new LangSmithIntegrationNotFoundError(integrationId);
  }

  async deleteLangSmithIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `select id, config
         from integrations
         where id = $1 and project_id = $2 and provider = 'langsmith'
         for update`,
        [integrationId, projectId]
      );
      const row = result.rows[0];
      if (!row) throw new LangSmithIntegrationNotFoundError(integrationId);
      await client.query(
        `update raw_traces
         set source_integration_id = null
         where project_id = $1 and source_integration_id = $2`,
        [projectId, integrationId]
      );
      await client.query(
        `delete from integrations
         where id = $1 and project_id = $2 and provider = 'langsmith'`,
        [integrationId, projectId]
      );
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          projectId,
          context.actorUserId ?? null,
          "integration.delete",
          "integration",
          integrationId,
          JSON.stringify({ provider: "langsmith", config: parseJson(row.config) })
        ]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDueLangSmithImportTargets(input: ClaimLangSmithImportTargetsInput): Promise<LangSmithImportTarget[]> {
    const result = await this.pool.query(
      `with due as (
         select i.id
         from integrations i
         where i.provider = 'langsmith'
           and i.poll_enabled = true
           and exists (
             select 1
             from skill_versions sv
             where sv.project_id = i.project_id
             limit 1
           )
           and (
             i.last_polled_at is null
             or i.last_polled_at <= $1::timestamptz - (greatest(i.poll_interval_seconds, 1) || ' seconds')::interval
           )
         order by i.last_polled_at asc nulls first, i.created_at asc
         limit $2
       )
       update integrations i
       set last_polled_at = $1::timestamptz
       from due
       where i.id = due.id
         and i.provider = 'langsmith'
         and i.poll_enabled = true
         and (
           i.last_polled_at is null
           or i.last_polled_at <= $1::timestamptz - (greatest(i.poll_interval_seconds, 1) || ' seconds')::interval
         )
       returning i.id, i.project_id, i.poll_limit, i.config`,
      [input.now.toISOString(), input.batchSize]
    );
    const targets: LangSmithImportTarget[] = [];
    for (const row of result.rows) {
      const projectId = String(row.project_id);
      const config = parseJson(row.config) as { skillVersionId?: string | null };
      try {
        targets.push({
          projectId,
          integrationId: String(row.id),
          skillVersionId: await this.resolveImportSkillVersionId(projectId, config.skillVersionId ?? undefined, "scheduled_import"),
          limit: Math.max(1, Math.min(Number(row.poll_limit ?? input.defaultLimit), 100))
        });
      } catch (error) {
        const expected =
          !(error instanceof AmbiguousProjectSkillError) &&
          !(error instanceof DatasetRevisionConflictError) &&
          !(error instanceof NoCurrentSkillError);
        if (expected) throw error;
        await this.recordImportSelectionFailure({
          projectId,
          source: "langsmith",
          integrationId: String(row.id),
          requestedLimit: Math.max(1, Math.min(Number(row.poll_limit ?? input.defaultLimit), 100)),
          now: input.now,
          code: error instanceof DatasetRevisionConflictError ? "invalid_skill_version" : "skill_version_required"
        });
      }
    }
    return targets;
  }

  async loadLangSmithImportContext(job: LangSmithImportJob): Promise<LangSmithImportContext> {
    const result = await this.pool.query(
      `select * from integrations where id = $1 and project_id = $2 and provider = 'langsmith'`,
      [job.integrationId, job.projectId]
    );
    const row = result.rows[0];
    if (!row) throw new LangSmithIntegrationNotFoundError(job.integrationId);
    const credentials = decryptJson<{ apiKey?: string }>(String(row.encrypted_credentials));
    const config = parseJson(row.config) as { projectName?: string | null; endpointUrl?: string | null; skillVersionId?: string | null; redaction?: LangSmithImportContext["redactionConfig"] };
    if (!credentials.apiKey) throw new LangSmithCredentialsMissingError(job.integrationId);
    if (job.skillVersionId) {
      await this.authorizeSkillVersionExecution({
        projectId: job.projectId,
        skillVersionId: job.skillVersionId,
        context: "scheduled_import",
        resourceKind: "langsmith_import",
        resourceId: job.importJobId ?? job.integrationId,
        idempotencyKey: `provider-start:langsmith:${job.importJobId ?? job.integrationId}:${job.skillVersionId}`
      });
    }
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      provider: "langsmith",
      skillVersionId: job.skillVersionId ?? config.skillVersionId ?? null,
      projectName: config.projectName ?? null,
      endpointUrl: config.endpointUrl ?? null,
      pollEnabled: row.poll_enabled !== false,
      pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
      pollLimit: Number(row.poll_limit ?? 25),
      lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
      lastTestResult: row.last_test_result == null
        ? null
        : LangSmithConnectionTestResultSchema.parse(parseJson(row.last_test_result)),
      createdAt: toIso(row.created_at),
      apiKey: credentials.apiKey,
      limit: job.limit,
      redactionConfig: config.redaction ?? {}
    };
  }

  async createLangfuseIntegration(projectId: string, input: LangfuseIntegrationInput): Promise<LangfuseIntegration> {
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const result = await this.pool.query(
      `insert into integrations (id, project_id, provider, encrypted_credentials, config, poll_enabled, poll_interval_seconds, poll_limit)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (project_id, provider)
       do update set encrypted_credentials = excluded.encrypted_credentials,
                     config = excluded.config,
                     poll_enabled = $6,
                     poll_interval_seconds = $7,
                     poll_limit = $8,
                     last_tested_at = null,
                     last_test_result = null
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        `int_${randomUUID()}`,
        projectId,
        "langfuse",
        encryptJson({ publicKey: input.publicKey, secretKey: input.secretKey }),
        JSON.stringify({
          projectName: null,
          endpointUrl: input.endpointUrl ?? null,
          redaction: input.redaction ?? {},
          skillVersionId
        }),
        pollEnabled,
        pollIntervalSeconds,
        pollLimit
      ]
    );
    // Same graduation rule as LangSmith: a connected tracer flips bench → tracing.
    await this.pool.query(`update projects set mode = 'tracing', updated_at = now() where id = $1 and mode <> 'tracing'`, [projectId]);
    return rowToLangfuseIntegration(result.rows[0]);
  }

  async listLangfuseIntegrations(projectId: string): Promise<LangfuseIntegration[]> {
    const result = await this.pool.query(
      `select id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at
       from integrations
       where project_id = $1 and provider = 'langfuse'
       order by created_at desc`,
      [projectId]
    );
    return result.rows.map(rowToLangfuseIntegration);
  }

  async updateLangfuseIntegration(projectId: string, integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration> {
    const skillVersionId = input.skillVersionId === undefined
      ? null
      : await this.resolveImportSkillVersionId(projectId, input.skillVersionId, "scheduled_import");
    const result = await this.pool.query(
      `update integrations
       set poll_enabled = coalesce($3::boolean, poll_enabled),
           poll_interval_seconds = coalesce($4::integer, poll_interval_seconds),
           poll_limit = coalesce($5::integer, poll_limit),
           config = case when $6::text is null then config
             else jsonb_set(config, '{skillVersionId}', to_jsonb($6::text), true) end
       where id = $1 and project_id = $2 and provider = 'langfuse'
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        integrationId,
        projectId,
        input.pollEnabled ?? null,
        input.pollIntervalSeconds ?? null,
        input.pollLimit ?? null,
        skillVersionId
      ]
    );
    const row = result.rows[0];
    if (!row) throw new LangfuseIntegrationNotFoundError(integrationId);
    return rowToLangfuseIntegration(row);
  }

  async recordLangfuseConnectionTest(projectId: string, integrationId: string, result: LangfuseConnectionTestResult): Promise<void> {
    const updated = await this.pool.query(
      `update integrations
       set last_tested_at = $3::timestamptz,
           last_test_result = $4::jsonb
       where id = $1 and project_id = $2 and provider = 'langfuse'`,
      [
        integrationId,
        projectId,
        result.checkedAt,
        JSON.stringify(result)
      ]
    );
    if (!updated.rowCount) throw new LangfuseIntegrationNotFoundError(integrationId);
  }

  async deleteLangfuseIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `select id, config
         from integrations
         where id = $1 and project_id = $2 and provider = 'langfuse'
         for update`,
        [integrationId, projectId]
      );
      const row = result.rows[0];
      if (!row) throw new LangfuseIntegrationNotFoundError(integrationId);
      await client.query(
        `update raw_traces
         set source_integration_id = null
         where project_id = $1 and source_integration_id = $2`,
        [projectId, integrationId]
      );
      await client.query(
        `delete from integrations
         where id = $1 and project_id = $2 and provider = 'langfuse'`,
        [integrationId, projectId]
      );
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          projectId,
          context.actorUserId ?? null,
          "integration.delete",
          "integration",
          integrationId,
          JSON.stringify({ provider: "langfuse", config: parseJson(row.config) })
        ]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDueLangfuseImportTargets(input: ClaimLangfuseImportTargetsInput): Promise<LangfuseImportTarget[]> {
    const result = await this.pool.query(
      `with due as (
         select i.id
         from integrations i
         where i.provider = 'langfuse'
           and i.poll_enabled = true
           and exists (
             select 1
             from skill_versions sv
             where sv.project_id = i.project_id
             limit 1
           )
           and (
             i.last_polled_at is null
             or i.last_polled_at <= $1::timestamptz - (greatest(i.poll_interval_seconds, 1) || ' seconds')::interval
           )
         order by i.last_polled_at asc nulls first, i.created_at asc
         limit $2
       )
       update integrations i
       set last_polled_at = $1::timestamptz
       from due
       where i.id = due.id
         and i.provider = 'langfuse'
         and i.poll_enabled = true
         and (
           i.last_polled_at is null
           or i.last_polled_at <= $1::timestamptz - (greatest(i.poll_interval_seconds, 1) || ' seconds')::interval
         )
       returning i.id, i.project_id, i.poll_limit, i.config`,
      [input.now.toISOString(), input.batchSize]
    );
    const targets: LangfuseImportTarget[] = [];
    for (const row of result.rows) {
      const projectId = String(row.project_id);
      const config = parseJson(row.config) as { skillVersionId?: string | null };
      try {
        targets.push({
          projectId,
          integrationId: String(row.id),
          skillVersionId: await this.resolveImportSkillVersionId(projectId, config.skillVersionId ?? undefined, "scheduled_import"),
          limit: Math.max(1, Math.min(Number(row.poll_limit ?? input.defaultLimit), 100))
        });
      } catch (error) {
        const expected =
          !(error instanceof AmbiguousProjectSkillError) &&
          !(error instanceof DatasetRevisionConflictError) &&
          !(error instanceof NoCurrentSkillError);
        if (expected) throw error;
        await this.recordImportSelectionFailure({
          projectId,
          source: "langfuse",
          integrationId: String(row.id),
          requestedLimit: Math.max(1, Math.min(Number(row.poll_limit ?? input.defaultLimit), 100)),
          now: input.now,
          code: error instanceof DatasetRevisionConflictError ? "invalid_skill_version" : "skill_version_required"
        });
      }
    }
    return targets;
  }

  async loadLangfuseImportContext(job: LangfuseImportJob): Promise<LangfuseImportContext> {
    const result = await this.pool.query(
      `select * from integrations where id = $1 and project_id = $2 and provider = 'langfuse'`,
      [job.integrationId, job.projectId]
    );
    const row = result.rows[0];
    if (!row) throw new LangfuseIntegrationNotFoundError(job.integrationId);
    const credentials = decryptJson<{ publicKey?: string; secretKey?: string }>(String(row.encrypted_credentials));
    const config = parseJson(row.config) as { projectName?: string | null; endpointUrl?: string | null; skillVersionId?: string | null; redaction?: LangfuseImportContext["redactionConfig"] };
    if (!credentials.publicKey || !credentials.secretKey) throw new LangfuseCredentialsMissingError(job.integrationId);
    if (job.skillVersionId) {
      await this.authorizeSkillVersionExecution({
        projectId: job.projectId,
        skillVersionId: job.skillVersionId,
        context: "scheduled_import",
        resourceKind: "langfuse_import",
        resourceId: job.importJobId ?? job.integrationId,
        idempotencyKey: `provider-start:langfuse:${job.importJobId ?? job.integrationId}:${job.skillVersionId}`
      });
    }
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      provider: "langfuse",
      skillVersionId: job.skillVersionId ?? config.skillVersionId ?? null,
      projectName: config.projectName ?? null,
      endpointUrl: config.endpointUrl ?? null,
      pollEnabled: row.poll_enabled !== false,
      pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
      pollLimit: Number(row.poll_limit ?? 25),
      lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
      lastTestResult: row.last_test_result == null
        ? null
        : LangfuseConnectionTestResultSchema.parse(parseJson(row.last_test_result)),
      createdAt: toIso(row.created_at),
      publicKey: credentials.publicKey,
      secretKey: credentials.secretKey,
      limit: job.limit,
      redactionConfig: config.redaction ?? {}
    };
  }

  async createIronsideIntegration(projectId: string, input: IronsideIntegrationInput): Promise<IronsideIntegration> {
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const result = await this.pool.query(
      `insert into integrations (id, project_id, provider, encrypted_credentials, config, poll_enabled, poll_interval_seconds, poll_limit)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (project_id, provider)
       do update set encrypted_credentials = excluded.encrypted_credentials,
                     config = excluded.config,
                     poll_enabled = $6,
                     poll_interval_seconds = $7,
                     poll_limit = $8,
                     last_tested_at = null,
                     last_test_result = null
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        `int_${randomUUID()}`,
        projectId,
        "ironside",
        encryptJson({ apiKey: input.apiKey }),
        JSON.stringify({
          url: input.url,
          redaction: input.redaction ?? {},
          quietPeriodSeconds: input.quietPeriodSeconds ?? 300,
          skillVersionId,
          // Reconciliation state starts empty: no watermark (first sweep
          // backfills history), no mid-window cursor. Reconnecting resets it
          // deliberately — the sweep is idempotent, so a re-import is safe.
          sync: { watermark: null, cursor: null, windowTo: null }
        }),
        pollEnabled,
        pollIntervalSeconds,
        pollLimit
      ]
    );
    // Same graduation rule as LangSmith/Langfuse: a connected tracer flips bench → tracing.
    await this.pool.query(`update projects set mode = 'tracing', updated_at = now() where id = $1 and mode <> 'tracing'`, [projectId]);
    return rowToIronsideIntegration(result.rows[0]);
  }

  async listIronsideIntegrations(projectId: string): Promise<IronsideIntegration[]> {
    const result = await this.pool.query(
      `select id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at
       from integrations
       where project_id = $1 and provider = 'ironside'
       order by created_at desc`,
      [projectId]
    );
    return result.rows.map(rowToIronsideIntegration);
  }

  async updateIronsideIntegration(projectId: string, integrationId: string, input: UpdateIronsideIntegrationInput): Promise<IronsideIntegration> {
    const skillVersionId = input.skillVersionId === undefined
      ? null
      : await this.resolveImportSkillVersionId(projectId, input.skillVersionId, "scheduled_import");
    const result = await this.pool.query(
      `update integrations
       set poll_enabled = coalesce($3::boolean, poll_enabled),
           poll_interval_seconds = coalesce($4::integer, poll_interval_seconds),
           poll_limit = coalesce($5::integer, poll_limit),
           config = case when $6::text is null then config
             else jsonb_set(config, '{skillVersionId}', to_jsonb($6::text), true) end
       where id = $1 and project_id = $2 and provider = 'ironside'
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        integrationId,
        projectId,
        input.pollEnabled ?? null,
        input.pollIntervalSeconds ?? null,
        input.pollLimit ?? null,
        skillVersionId
      ]
    );
    const row = result.rows[0];
    if (!row) throw new IronsideIntegrationNotFoundError(integrationId);
    return rowToIronsideIntegration(row);
  }

  async recordIronsideConnectionTest(projectId: string, integrationId: string, result: IronsideConnectionTestResult): Promise<void> {
    const updated = await this.pool.query(
      `update integrations
       set last_tested_at = $3::timestamptz,
           last_test_result = $4::jsonb
       where id = $1 and project_id = $2 and provider = 'ironside'`,
      [
        integrationId,
        projectId,
        result.checkedAt,
        JSON.stringify(result)
      ]
    );
    if (!updated.rowCount) throw new IronsideIntegrationNotFoundError(integrationId);
  }

  async deleteIronsideIntegration(projectId: string, integrationId: string, context: { actorUserId?: string | undefined }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `select id, config
         from integrations
         where id = $1 and project_id = $2 and provider = 'ironside'
         for update`,
        [integrationId, projectId]
      );
      const row = result.rows[0];
      if (!row) throw new IronsideIntegrationNotFoundError(integrationId);
      await client.query(
        `update raw_traces
         set source_integration_id = null
         where project_id = $1 and source_integration_id = $2`,
        [projectId, integrationId]
      );
      await client.query(
        `delete from integrations
         where id = $1 and project_id = $2 and provider = 'ironside'`,
        [integrationId, projectId]
      );
      await client.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          projectId,
          context.actorUserId ?? null,
          "integration.delete",
          "integration",
          integrationId,
          JSON.stringify({ provider: "ironside", config: parseJson(row.config) })
        ]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDueIronsideImportTargets(input: ClaimIronsideImportTargetsInput): Promise<IronsideImportTarget[]> {
    const result = await this.pool.query(
      `with due as (
         select i.id
         from integrations i
         where i.provider = 'ironside'
           and i.poll_enabled = true
           and exists (
             select 1
             from skill_versions sv
             where sv.project_id = i.project_id
             limit 1
           )
           and (
             i.last_polled_at is null
             or i.last_polled_at <= $1::timestamptz - (greatest(i.poll_interval_seconds, 1) || ' seconds')::interval
           )
         order by i.last_polled_at asc nulls first, i.created_at asc
         limit $2
       )
       update integrations i
       set last_polled_at = $1::timestamptz
       from due
       where i.id = due.id
         and i.provider = 'ironside'
         and i.poll_enabled = true
         and (
           i.last_polled_at is null
           or i.last_polled_at <= $1::timestamptz - (greatest(i.poll_interval_seconds, 1) || ' seconds')::interval
         )
       returning i.id, i.project_id, i.poll_limit, i.config`,
      [input.now.toISOString(), input.batchSize]
    );
    const targets: IronsideImportTarget[] = [];
    for (const row of result.rows) {
      const projectId = String(row.project_id);
      const config = parseJson(row.config) as { skillVersionId?: string | null };
      try {
        targets.push({
          projectId,
          integrationId: String(row.id),
          skillVersionId: await this.resolveImportSkillVersionId(projectId, config.skillVersionId ?? undefined, "scheduled_import"),
          limit: Math.max(1, Math.min(Number(row.poll_limit ?? input.defaultLimit), 100))
        });
      } catch (error) {
        const expected =
          !(error instanceof AmbiguousProjectSkillError) &&
          !(error instanceof DatasetRevisionConflictError) &&
          !(error instanceof NoCurrentSkillError);
        if (expected) throw error;
        await this.recordImportSelectionFailure({
          projectId,
          source: "ironside",
          integrationId: String(row.id),
          requestedLimit: Math.max(1, Math.min(Number(row.poll_limit ?? input.defaultLimit), 100)),
          now: input.now,
          code: error instanceof DatasetRevisionConflictError ? "invalid_skill_version" : "skill_version_required"
        });
      }
    }
    return targets;
  }

  async loadIronsideImportContext(job: IronsideImportJob): Promise<IronsideImportContext> {
    const result = await this.pool.query(
      `select * from integrations where id = $1 and project_id = $2 and provider = 'ironside'`,
      [job.integrationId, job.projectId]
    );
    const row = result.rows[0];
    if (!row) throw new IronsideIntegrationNotFoundError(job.integrationId);
    const credentials = decryptJson<{ apiKey?: string }>(String(row.encrypted_credentials));
    const config = parseJson(row.config) as {
      url?: string;
      redaction?: IronsideImportContext["redactionConfig"];
      skillVersionId?: string | null;
      quietPeriodSeconds?: number;
      sync?: unknown;
    };
    if (!credentials.apiKey || !config.url) throw new IronsideCredentialsMissingError(job.integrationId);
    if (job.skillVersionId) {
      await this.authorizeSkillVersionExecution({
        projectId: job.projectId,
        skillVersionId: job.skillVersionId,
        context: "scheduled_import",
        resourceKind: "ironside_import",
        resourceId: job.importJobId ?? job.integrationId,
        idempotencyKey: `provider-start:ironside:${job.importJobId ?? job.integrationId}:${job.skillVersionId}`
      });
    }
    const syncState = IronsideSyncStateSchema.catch({ watermark: null, cursor: null, windowTo: null })
      .parse(config.sync ?? { watermark: null, cursor: null, windowTo: null });
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      provider: "ironside",
      skillVersionId: job.skillVersionId ?? config.skillVersionId ?? null,
      url: config.url,
      pollEnabled: row.poll_enabled !== false,
      pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
      pollLimit: Number(row.poll_limit ?? 25),
      quietPeriodSeconds: Number(config.quietPeriodSeconds ?? 300),
      lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
      lastTestResult: row.last_test_result == null
        ? null
        : IronsideConnectionTestResultSchema.parse(parseJson(row.last_test_result)),
      createdAt: toIso(row.created_at),
      apiKey: credentials.apiKey,
      limit: job.limit,
      redactionConfig: config.redaction ?? {},
      syncState
    };
  }

  async saveIronsideSyncState(projectId: string, integrationId: string, state: IronsideSyncState): Promise<void> {
    const result = await this.pool.query(
      `update integrations
       set config = jsonb_set(config, '{sync}', $3::jsonb, true)
       where id = $1 and project_id = $2 and provider = 'ironside'`,
      [integrationId, projectId, JSON.stringify(state)]
    );
    if (!result.rowCount) throw new IronsideIntegrationNotFoundError(integrationId);
  }

  async loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext> {
    const caseResult = await this.pool.query(
      `select id, project_id, normalized_payload,ingestion_purpose,case_type
       from cases
       where id = $1 and project_id = $2`,
      [job.caseId, job.projectId]
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) throw new Error(`Case not found for judge job: ${job.caseId}`);

    const resolvedSkillVersionId = job.skillVersionId ?? (await this.getCurrentSkill(job.projectId)).currentVersion.id;
    const versionResult = await this.pool.query(
      `select sv.*
       from skill_versions sv
       where sv.project_id = $1
         and sv.id = $2
       limit 1`,
      [job.projectId, resolvedSkillVersionId]
    );
    const versionRow = versionResult.rows[0];
    if (!versionRow) throw new Error(`Skill version not found for judge job: ${job.skillVersionId ?? "latest"}`);

    let executionContext: EvaluatorExecutionContext;
    let resourceKind: string;
    let resourceId: string;
    if (job.evalRunId) {
      const evalRun = (await this.pool.query(
        `select trigger,dataset_revision_id,source_trace_test_id from eval_runs
         where id=$1 and project_id=$2 and skill_version_id=$3`,
        [job.evalRunId,job.projectId,resolvedSkillVersionId]
      )).rows[0];
      if (!evalRun) throw new Error(`Eval run not found for judge job: ${job.evalRunId}`);
      if (evalRun.trigger === "product_gate" || evalRun.trigger === "release_evidence") {
        executionContext = "release_gate";
      } else if (evalRun.source_trace_test_id) {
        executionContext = "trace_test";
      } else if (evalRun.trigger === "backfill") {
        executionContext = "implicit_production";
      } else if (evalRun.trigger === "manual") {
        executionContext = "explicit_nonproduction_dataset";
      } else {
        executionContext = "manual_import";
      }
      resourceKind = "eval_run_item";
      resourceId = job.evalRunItemId ?? job.evalRunId;
    } else {
      const purpose = String(caseRow.ingestion_purpose);
      executionContext = purpose === "release_evidence"
        ? "release_gate"
        : purpose === "trace_test_synthetic"
          ? "trace_test"
          : purpose.startsWith("analysis_eligible_provider_")
            ? "scheduled_import"
            : purpose === "judge_api"
              ? "implicit_production"
              : "manual_import";
      resourceKind = "case";
      resourceId = String(caseRow.id);
    }
    await this.authorizeSkillVersionExecution({
      projectId: job.projectId,
      skillVersionId: resolvedSkillVersionId,
      context: executionContext,
      resourceKind,
      resourceId,
      idempotencyKey: `provider-start:${executionContext}:${resourceKind}:${resourceId}:${resolvedSkillVersionId}`
    });

    const payload = redactNormalizedTracePayload(parseJson(caseRow.normalized_payload) as { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; steps?: NormalizedTraceStep[] });
    return {
      projectId: String(caseRow.project_id),
      caseId: String(caseRow.id),
      skillVersion: rowToSkillVersion(versionRow),
      trace: {
        id: String(caseRow.id),
        input: payload.input ?? payload,
        output: payload.output ?? payload,
        metadata: payload.metadata ?? {},
        // Steps reach the judge through this trace — the providers serialize
        // the whole object (M2 T1).
        ...(payload.steps ? { steps: payload.steps } : {})
      }
    };
  }

  async recordJudgeRun(input: RecordJudgeRunInput): Promise<JudgeRun> {
    const existing = await this.pool.query(
      `select * from judge_runs
       where project_id = $1 and case_id = $2 and skill_version_id = $3
       order by created_at desc
       limit 1`,
      [input.projectId, input.caseId, input.skillVersionId]
    );
    if (existing.rows[0]) return rowToJudgeRun(existing.rows[0]);

    const result = await this.pool.query(
      `insert into judge_runs
       (id, project_id, case_id, skill_version_id, verdict, score, reasoning, raw_request, raw_response, latency_ms, input_tokens, output_tokens, provider_metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning *`,
      [
        `judge_${randomUUID()}`,
        input.projectId,
        input.caseId,
        input.skillVersionId,
        input.verdict.label,
        input.verdict.score,
        input.verdict.reason,
        JSON.stringify(input.rawRequest ?? {}),
        JSON.stringify(input.rawResponse ?? input.verdict),
        input.latencyMs ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        JSON.stringify(input.providerMetadata ?? {
          model: null,
          requestId: null,
          responseId: null,
          systemFingerprint: null
        })
      ]
    );
    await this.pool.query(
      `update projects
       -- +1 only when this is the case's FIRST judge run: a re-judge (new
       -- version, consistency probe) is not new coverage. The exists-probe is
       -- an index hit on judge_runs_case_skill_idx (case_id leading) — a full
       -- count(distinct) here would rescan the project's fastest-growing
       -- table on every judge run and serialize eval workers on this row.
       -- Concurrent first-runs of one case can in theory double-count; the
       -- periodic full recount in refreshProjectCounters self-heals that.
       set auto_judged_trace_count = auto_judged_trace_count +
             (case when exists (
                select 1 from cases c
                where c.id = $2 and c.project_id = $1
                  and c.case_type in ('gate_candidate', 'release_evidence')
              ) then 0 when exists (
                select 1 from judge_runs jr
                where jr.case_id = $2 and jr.project_id = $1 and jr.id <> $3
              ) then 0 else 1 end),
           updated_at = now()
       where id = $1`,
      [input.projectId, input.caseId, result.rows[0].id]
    );
    return rowToJudgeRun(result.rows[0]);
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
    const generated = generateApiKey();
    const result = await this.pool.query(
      `insert into api_keys (id, project_id, name, key_hash, key_prefix, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6)
       returning *`,
      [`apikey_${randomUUID()}`, input.projectId, input.name, generated.keyHash, generated.keyPrefix, input.createdByUserId ?? null]
    );
    return { ...rowToApiKey(result.rows[0]), key: generated.key };
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    const result = await this.pool.query(
      `select * from api_keys where project_id = $1 order by created_at desc`,
      [projectId]
    );
    return result.rows.map(rowToApiKey);
  }

  async revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update api_keys set revoked_at = now()
       where id = $1 and project_id = $2 and revoked_at is null`,
      [apiKeyId, projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null> {
    const keyHash = hashApiKey(rawKey);
    const result = await this.pool.query(
      `update api_keys set last_used_at = now()
       where key_hash = $1 and revoked_at is null
       returning id, project_id`,
      [keyHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { projectId: String(row.project_id), apiKeyId: String(row.id) };
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

      const verdicts = await this.loadHumanVerdictsForCases(client, input.projectId, rows.rows.map((row) => String(row.case_id)));
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
        const identity = await this.resolveCaseInputIdentity(client, input.projectId, caseId, row.raw_payload);
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

      revisionId = await this.insertDatasetRevisionWithClient(client, {
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
        ?? await this.resolveSingletonCriterionVersionForRegression(client, projectId);
      revisionId = await this.getOrCreateRegressionDatasetRevisionWithClient(
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

  private async getOrCreateRegressionDatasetRevisionWithClient(
    client: PoolClient,
    projectId: string,
    criterionVersionId: string,
    actorUserId?: string
  ): Promise<string> {
    const project = await client.query(`select id from projects where id = $1 for update`, [projectId]);
    if (!project.rows[0]) throw new Error(`Project not found: ${projectId}`);
    const rows = await client.query(
      `select gse.*, c.normalized_payload, rt.raw_payload
       from golden_set_entries gse
       join cases c on c.id = gse.case_id and c.project_id = gse.project_id
       left join raw_traces rt on rt.id = c.raw_trace_id
       where gse.project_id = $1
         and gse.criterion_version_id = $2
         and gse.retired_at is null
       order by gse.promoted_at asc, gse.id asc`,
      [projectId, criterionVersionId]
    );
    const verdicts = await this.loadHumanVerdictsForCases(
      client,
      projectId,
      rows.rows.map((row) => String(row.case_id)),
      criterionVersionId
    );
    const prepared = [] as Array<{
      sourceCaseId: string;
      sourceTraceId: string;
      sourceDatasetItemId: null;
      sourceGoldenEntryId: string;
      payloadSnapshot: DatasetRevisionPayloadSnapshot;
      inputDigest: string;
      itemDigest: string;
      referenceLabel: "pass" | "fail";
      referenceFailStep: null;
      referenceProvenance: DatasetReferenceProvenance;
      note: string;
    }>;
    for (const row of rows.rows) {
      const caseId = String(row.case_id);
      const payloadSnapshot = normalizedPayloadSnapshot(row.normalized_payload);
      const identity = await this.resolveCaseInputIdentity(client, projectId, caseId, row.raw_payload);
      const referenceLabel = row.agreed_label === "fail" ? "fail" : "pass";
      const matching = (verdicts.get(caseId) ?? []).filter((verdict) =>
        verdictLabelFromPayload(verdict.payload) === referenceLabel &&
        (verdict.source === "human" || verdict.source === "adjudicated")
      );
      const referenceProvenance: DatasetReferenceProvenance = {
        kind: "golden_promotion",
        sourceId: String(row.id),
        verdictIds: matching.map((verdict) => verdict.id),
        actorUserIds: matching.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
        basis: "Visible golden promotion; known-failure governance, not sealed validation."
      };
      const itemDigest = datasetRevisionItemDigest({
        inputIdentity: identity,
        redactedPayload: payloadSnapshot,
        referenceLabel,
        expectedFailStep: null,
        reviewProvenance: referenceProvenance,
        note: String(row.reason)
      });
      prepared.push({
        sourceCaseId: caseId,
        sourceTraceId: String(row.trace_id),
        sourceDatasetItemId: null,
        sourceGoldenEntryId: String(row.id),
        payloadSnapshot,
        inputDigest: identity.digest,
        itemDigest,
        referenceLabel,
        referenceFailStep: null,
        referenceProvenance,
        note: String(row.reason)
      });
    }

    const revisionDigest = datasetRevisionDigest({
      role: "regression_golden",
      itemDigests: prepared.map((item) => item.itemDigest)
    });
    const pointer = await client.query(
      `select pointer.revision_id, revision.revision_digest
       from criterion_regression_revisions pointer
       join dataset_revisions revision on revision.id = pointer.revision_id
       where pointer.project_id = $1 and pointer.criterion_version_id = $2`,
      [projectId, criterionVersionId]
    );
    if (pointer.rows[0]?.revision_digest === revisionDigest) return String(pointer.rows[0].revision_id);

    const revisionId = await this.insertDatasetRevisionWithClient(client, {
      projectId,
      seriesId: `golden:${projectId}:${criterionVersionId}`,
      sourceDatasetId: null,
      criterionVersionId,
      role: "regression_golden",
      sourceKind: "golden_snapshot",
      provenanceLevel: prepared.length > 0 && prepared.every((item) => item.referenceProvenance.verdictIds.length > 0)
        ? "reviewed_unblinded"
        : "legacy",
      createdByUserId: actorUserId,
      items: prepared
    });
    await client.query(
      `insert into dataset_exposure_events
       (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
        subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
       values ($1,$2,$3,'legacy_pretracking','development','legacy_import','system',
               'golden-registry',$4,'golden_registry',null,null,'{}'::jsonb,$5)`,
      [`dse_${randomUUID()}`, projectId, revisionId, actorUserId ?? null, `regression-visible:${revisionId}`]
    );
    await client.query(
      `insert into criterion_regression_revisions (project_id, criterion_version_id, revision_id)
       values ($1,$2,$3)
       on conflict (project_id, criterion_version_id) do update
       set revision_id = excluded.revision_id, updated_at = now()`,
      [projectId, criterionVersionId, revisionId]
    );
    return revisionId;
  }

  private async resolveSingletonCriterionVersionForRegression(
    client: PoolClient,
    projectId: string
  ): Promise<string> {
    const result = await client.query(
      `select latest.id
       from criteria criterion
       join lateral (
         select version.id
         from criterion_versions version
         where version.project_id = criterion.project_id
           and version.criterion_id = criterion.id
         order by version.revision desc, version.id desc
         limit 1
       ) latest on true
       where criterion.project_id = $1
       order by criterion.id`,
      [projectId]
    );
    if (result.rows.length !== 1) {
      throw new DatasetRevisionConflictError(
        `Project ${projectId} requires an explicit criterionVersionId for regression evidence.`
      );
    }
    return String(result.rows[0].id);
  }

  private async insertDatasetRevisionWithClient(
    client: PoolClient,
    input: {
      projectId: string;
      seriesId: string;
      sourceDatasetId: string | null;
      criterionVersionId?: string | undefined;
      role: DatasetRevision["role"];
      sourceKind: DatasetRevision["sourceKind"];
      provenanceLevel: DatasetRevision["provenanceLevel"];
      expectedParentRevisionId?: string | undefined;
      idempotencyKey?: string | undefined;
      reuseLatestContent?: boolean | undefined;
      createdByUserId?: string | undefined;
      items: Array<{
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
      }>;
    }
  ): Promise<string> {
    const parentResult = await client.query(
      `select id, revision_number, role, content_digest from dataset_revisions
       where project_id = $1 and series_id = $2
       order by revision_number desc
       limit 1
       for update`,
      [input.projectId, input.seriesId]
    );
    const parentId = parentResult.rows[0] ? String(parentResult.rows[0].id) : null;
    if (input.expectedParentRevisionId !== undefined && input.expectedParentRevisionId !== parentId) {
      throw new DatasetRevisionConflictError(
        `Dataset revision changed from ${input.expectedParentRevisionId} to ${parentId ?? "none"}`
      );
    }
    const revisionId = `dsr_${randomUUID()}`;
    const itemDigests = input.items.map((item) => item.itemDigest);
    const contentDigest = datasetRevisionContentDigest(itemDigests);
    const revisionDigest = datasetRevisionDigest({ role: input.role, itemDigests });
    if (
      input.reuseLatestContent &&
      parentResult.rows[0]?.role === input.role &&
      parentResult.rows[0]?.content_digest === contentDigest
    ) {
      return String(parentResult.rows[0].id);
    }
    await client.query(
      `insert into dataset_revisions
       (id, project_id, series_id, revision_number, source_dataset_id, parent_revision_id,
        role, source_kind, identity_basis, content_digest, revision_digest, item_count,
        provenance_level, created_by_user_id, idempotency_key, criterion_version_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'input-identity/v1',$9,$10,$11,$12,$13,$14,$15)`,
      [
        revisionId,
        input.projectId,
        input.seriesId,
        Number(parentResult.rows[0]?.revision_number ?? 0) + 1,
        input.sourceDatasetId,
        parentId,
        input.role,
        input.sourceKind,
        contentDigest,
        revisionDigest,
        input.items.length,
        input.provenanceLevel,
        input.createdByUserId ?? null,
        input.idempotencyKey ?? null,
        input.criterionVersionId ?? null
      ]
    );
    for (const [position, item] of input.items.entries()) {
      await client.query(
        `insert into dataset_revision_items
         (id, revision_id, project_id, position, source_case_id, source_trace_id,
          source_dataset_item_id, source_golden_entry_id, input_digest, item_digest,
          payload_snapshot, reference_label, reference_fail_step, reference_provenance, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          `dsri_${randomUUID()}`,
          revisionId,
          input.projectId,
          position,
          item.sourceCaseId,
          item.sourceTraceId,
          item.sourceDatasetItemId,
          item.sourceGoldenEntryId,
          item.inputDigest,
          item.itemDigest,
          JSON.stringify(item.payloadSnapshot),
          item.referenceLabel,
          item.referenceFailStep,
          JSON.stringify(item.referenceProvenance),
          item.note
        ]
      );
    }
    await client.query(
      `insert into dataset_exposure_events
       (id, project_id, revision_id, kind, exposure_class, activity, subject_kind,
        subject_id, actor_user_id, evidence_ref_kind, evidence_ref_id, reason, details, idempotency_key)
       values ($1,$2,$3,'created','lineage','revision_create',$4,$5,$6,
               'dataset_revision',$3,null,'{}'::jsonb,$7)`,
      [
        `dse_${randomUUID()}`,
        input.projectId,
        revisionId,
        input.createdByUserId ? "person" : "system",
        input.createdByUserId ?? null,
        input.createdByUserId ?? null,
        `revision-created:${revisionId}`
      ]
    );
    return revisionId;
  }

  private async resolveCaseInputIdentity(
    client: PoolClient,
    projectId: string,
    caseId: string,
    rawPayloadValue: unknown
  ): Promise<ReturnType<typeof datasetInputIdentity>> {
    const existing = await client.query(
      `select identity_basis, input_digest
       from case_input_identity_records
       where project_id = $1 and source_case_id = $2 and input_digest is not null
       order by case when record_kind = 'authoring_import' then 0 else 1 end, created_at asc
       limit 1`,
      [projectId, caseId]
    );
    if (existing.rows[0]) {
      return { basis: "input-identity/v1", digest: String(existing.rows[0].input_digest) };
    }
    const rawPayload = parseJson(rawPayloadValue) as { input?: unknown } | null;
    if (!rawPayload || !("input" in rawPayload)) {
      throw new DatasetRevisionConflictError(
        `Case ${caseId} has no retained pre-redaction input identity; it remains legacy-exposed and cannot be frozen as exact evidence.`
      );
    }
    const identity = datasetInputIdentity({ input: rawPayload.input });
    await client.query(
      `insert into case_input_identity_records
       (id, project_id, source_case_id, record_kind, identity_basis, input_digest)
       values ($1,$2,$3,'identity_resolved',$4,$5)
       on conflict (project_id, source_case_id, record_kind) do nothing`,
      [`ciir_${randomUUID()}`, projectId, caseId, identity.basis, identity.digest]
    );
    return identity;
  }

  private async loadHumanVerdictsForCases(
    client: PoolClient,
    projectId: string,
    caseIds: string[],
    criterionVersionId?: string | undefined
  ): Promise<Map<string, VerdictRecord[]>> {
    const byCase = new Map<string, VerdictRecord[]>();
    if (caseIds.length === 0) return byCase;
    const result = await client.query(
      `select verdict.* from verdicts verdict
       where verdict.project_id = $1 and verdict.case_id = any($2::text[])
         and verdict.source in ('human','adjudicated')
         and ($3::text is null or exists (
           select 1
           from skill_versions evaluator
           where evaluator.project_id = verdict.project_id
             and evaluator.id = verdict.skill_version_id
             and evaluator.criterion_version_id = $3
         ))
       order by verdict.created_at asc, verdict.id asc`,
      [projectId, caseIds, criterionVersionId ?? null]
    );
    for (const row of result.rows) {
      const verdict = rowToVerdictRecord(row);
      const bucket = byCase.get(verdict.caseId);
      if (bucket) bucket.push(verdict);
      else byCase.set(verdict.caseId, [verdict]);
    }
    return byCase;
  }

  private async mintAssessmentReceiptWithClient(
    client: PoolClient,
    projectId: string,
    evalRunId: string,
    sourceKind: Exclude<AssessmentReceiptArtifactSource, "correction">
  ): Promise<AssessmentReceiptArtifact | null> {
    const runResult = await client.query(
      `select * from eval_runs where id = $1 and project_id = $2 for update`,
      [evalRunId, projectId]
    );
    const runRow = runResult.rows[0];
    if (!runRow) return null;
    const run = rowToEvalRun(runRow);
    const existingResult = await client.query(
      `select * from assessment_receipt_artifacts
       where eval_run_id = $1 and contract_version = 1 and artifact_revision = 1`,
      [evalRunId]
    );
    if (existingResult.rows[0]) return rowToAssessmentReceiptArtifact(existingResult.rows[0]);
    if (run.trigger !== "release_evidence") {
      throw new AssessmentReceiptUnavailableError(
        "not_release_evidence",
        "Assessment receipts are available only for release_evidence runs"
      );
    }
    if (run.status === "pending" || run.status === "running") {
      throw new AssessmentReceiptUnavailableError(
        "not_terminal",
        "Assessment receipt is not available until the eval run is terminal"
      );
    }
    const [itemsResult, versionResult] = await Promise.all([
      client.query(
        `select * from eval_run_items where eval_run_id = $1 order by created_at asc, id asc`,
        [evalRunId]
      ),
      client.query(
        `select * from skill_versions where id = $1 and project_id = $2`,
        [run.skillVersionId, projectId]
      )
    ]);
    const versionRow = versionResult.rows[0];
    if (!versionRow) {
      throw new AssessmentReceiptUnavailableError("missing_source", "Eval run skill version not found");
    }
    const items = itemsResult.rows.map(rowToEvalRunItem);
    const detail: EvalRunDetail = { ...run, items, spend: computeEvalRunSpend(items) };
    const skillVersion = rowToSkillVersion(versionRow);
    const receipt = buildAssessmentReceipt({ run: detail, skillVersion });
    const canonicalBytes = canonicalReceiptBytes(receipt);
    const artifactDigest = receiptArtifactDigest(canonicalBytes);
    const artifactId = `rart_${evalRunId}_v1_r1`;
    await client.query(
      `insert into assessment_receipt_artifacts
       (id, project_id, eval_run_id, receipt_id, contract_version, artifact_revision,
        canonical_bytes, artifact_digest, evidence_digest, source_snapshot_digest,
        source_kind, predecessor_artifact_id, correction_reason, created_by_user_id)
       values ($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,null,null,null)
       on conflict (eval_run_id, contract_version, artifact_revision) do nothing`,
      [
        artifactId,
        projectId,
        evalRunId,
        receipt.receiptId,
        canonicalBytes,
        artifactDigest,
        receipt.evidenceDigest,
        receiptSourceSnapshotDigest({ run: detail, skillVersion }),
        sourceKind
      ]
    );
    const stored = await client.query(
      `select * from assessment_receipt_artifacts
       where eval_run_id = $1 and contract_version = 1 and artifact_revision = 1`,
      [evalRunId]
    );
    if (!stored.rows[0]) throw new Error(`Assessment receipt artifact vanished after mint: ${evalRunId}`);
    return rowToAssessmentReceiptArtifact(stored.rows[0]);
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
        await this.mintAssessmentReceiptWithClient(client, input.projectId, runId, "terminal_mint");
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
      const runFinished = await this.bumpEvalRunCounters(client, input.projectId, input.evalRunId, {
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
          await this.mintAssessmentReceiptWithClient(client, input.projectId, input.evalRunId, "terminal_mint");
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
      const runFinished = await this.bumpEvalRunCounters(client, input.projectId, input.evalRunId, {
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
          await this.mintAssessmentReceiptWithClient(client, input.projectId, input.evalRunId, "terminal_mint");
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

  // A run with some judged items finishes "completed" even with per-item
  // failures; failed_items and the first surfaced error preserve that signal.
  // A run where nothing was judged finishes "failed".
  private async bumpEvalRunCounters(
    client: PoolClient,
    projectId: string,
    evalRunId: string,
    bump: { completed: number; failed: number; agreed: number; error: string | null }
  ): Promise<boolean> {
    const result = await client.query(
      `update eval_runs
       set completed_items = completed_items + $3,
           failed_items = failed_items + $4,
           agreed_items = agreed_items + $5,
           error = coalesce(error, $6),
           status = case when completed_items + failed_items + $3 + $4 >= total_items
                         then case when completed_items + $3 = 0 and failed_items + $4 > 0 then 'failed' else 'completed' end
                         else status end,
           finished_at = case when completed_items + failed_items + $3 + $4 >= total_items then now() else finished_at end
       where id = $1 and project_id = $2 and status in ('pending', 'running')
       returning status`,
      [evalRunId, projectId, bump.completed, bump.failed, bump.agreed, bump.error]
    );
    const status = String(result.rows[0]?.status);
    return status === "completed" || status === "failed";
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
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const artifact = await this.mintAssessmentReceiptWithClient(
        client,
        projectId,
        evalRunId,
        "historical_freeze"
      );
      await client.query("commit");
      return artifact;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAssessmentReceiptArtifactByReceiptId(
    projectId: string,
    receiptId: string
  ): Promise<AssessmentReceiptArtifact | null> {
    const result = await this.pool.query(
      `select * from assessment_receipt_artifacts where project_id = $1 and receipt_id = $2`,
      [projectId, receiptId]
    );
    return result.rows[0] ? rowToAssessmentReceiptArtifact(result.rows[0]) : null;
  }

  async listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]> {
    const result = await this.pool.query(
      `select * from assessment_receipt_artifacts
       where project_id = $1 and eval_run_id = $2
       order by artifact_revision asc`,
      [projectId, evalRunId]
    );
    return result.rows.map(rowToAssessmentReceiptArtifact);
  }

  async compareAssessmentReceiptCopy(input: CompareAssessmentReceiptCopyInput): Promise<AssessmentReceiptComparison> {
    let consumerReceipt: AssessmentReceipt;
    try {
      consumerReceipt = parseCanonicalReceiptBytes(input.consumerCanonicalBytes);
    } catch (error) {
      throw new AssessmentReceiptIntegrityError(error instanceof Error ? error.message : String(error));
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const root = await this.mintAssessmentReceiptWithClient(
        client,
        input.projectId,
        input.evalRunId,
        "historical_freeze"
      );
      if (!root) throw new AssessmentReceiptUnavailableError("missing_source", "Eval run not found");
      const rootReceipt = parseCanonicalReceiptBytes(root.canonicalBytes);
      if (
        consumerReceipt.projectId !== input.projectId ||
        consumerReceipt.evalRunId !== input.evalRunId ||
        consumerReceipt.receiptId !== rootReceipt.receiptId
      ) {
        throw new AssessmentReceiptIntegrityError("Consumer receipt identity does not match the persisted root assessment");
      }
      const consumerArtifactDigest = receiptArtifactDigest(input.consumerCanonicalBytes);
      const comparisonStatus = input.consumerCanonicalBytes.equals(root.canonicalBytes) ? "match" : "diverged";
      await client.query(
        `insert into assessment_receipt_comparisons
         (id, project_id, eval_run_id, artifact_id, consumer_receipt_id,
          consumer_canonical_bytes, consumer_artifact_digest, comparison_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (artifact_id, consumer_artifact_digest) do nothing`,
        [
          `rcomp_${randomUUID()}`,
          input.projectId,
          input.evalRunId,
          root.id,
          consumerReceipt.receiptId,
          input.consumerCanonicalBytes,
          consumerArtifactDigest,
          comparisonStatus
        ]
      );
      const stored = await client.query(
        `select * from assessment_receipt_comparisons
         where artifact_id = $1 and consumer_artifact_digest = $2`,
        [root.id, consumerArtifactDigest]
      );
      if (!stored.rows[0]) throw new Error("Assessment receipt comparison vanished after insert");
      const comparison = rowToAssessmentReceiptComparison(stored.rows[0]);
      if (
        comparison.artifactId !== root.id ||
        !comparison.consumerCanonicalBytes.equals(input.consumerCanonicalBytes) ||
        comparison.comparisonStatus !== comparisonStatus
      ) {
        throw new AssessmentReceiptIntegrityError(
          "Persisted consumer receipt comparison does not match its artifact and exact bytes"
        );
      }
      await client.query("commit");
      return comparison;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAssessmentReceiptCorrection(
    input: CreateAssessmentReceiptCorrectionInput
  ): Promise<AssessmentReceiptArtifact> {
    const reason = input.reason.trim();
    if (!reason) throw new AssessmentReceiptIntegrityError("Assessment receipt correction reason is required");
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

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const root = await this.mintAssessmentReceiptWithClient(
        client,
        input.projectId,
        input.evalRunId,
        "historical_freeze"
      );
      if (!root) throw new AssessmentReceiptUnavailableError("missing_source", "Eval run not found");
      const existing = await client.query(
        `select * from assessment_receipt_artifacts where project_id = $1 and receipt_id = $2`,
        [input.projectId, receipt.receiptId]
      );
      if (existing.rows[0]) {
        const artifact = rowToAssessmentReceiptArtifact(existing.rows[0]);
        if (
          artifact.sourceKind === "correction" &&
          artifact.evalRunId === input.evalRunId &&
          artifact.canonicalBytes.equals(canonicalBytes)
        ) {
          await client.query("commit");
          return artifact;
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
      const latest = await client.query(
        `select * from assessment_receipt_artifacts
         where project_id = $1 and eval_run_id = $2 and contract_version = 1
         order by artifact_revision desc limit 1`,
        [input.projectId, input.evalRunId]
      );
      const predecessor = rowToAssessmentReceiptArtifact(latest.rows[0]);
      const artifactRevision = predecessor.artifactRevision + 1;
      const artifactDigest = receiptArtifactDigest(canonicalBytes);
      const artifactId = `rart_${input.evalRunId}_v1_r${artifactRevision}`;
      const inserted = await client.query(
        `insert into assessment_receipt_artifacts
         (id, project_id, eval_run_id, receipt_id, contract_version, artifact_revision,
          canonical_bytes, artifact_digest, evidence_digest, source_snapshot_digest,
          source_kind, predecessor_artifact_id, correction_reason, created_by_user_id)
         values ($1,$2,$3,$4,1,$5,$6,$7,$8,$7,'correction',$9,$10,$11)
         returning *`,
        [
          artifactId,
          input.projectId,
          input.evalRunId,
          receipt.receiptId,
          artifactRevision,
          canonicalBytes,
          artifactDigest,
          receipt.evidenceDigest,
          predecessor.id,
          reason,
          input.createdByUserId ?? null
        ]
      );
      await client.query("commit");
      return rowToAssessmentReceiptArtifact(inserted.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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
    const result = await this.pool.query(
      `insert into run_comparisons
       (id, project_id, dataset_id, dataset_revision_id, version_a_id, version_b_id, run_a_id, run_b_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [
        `rcmp_${randomUUID()}`,
        input.projectId,
        input.datasetId,
        input.datasetRevisionId ?? null,
        input.versionAId,
        input.versionBId,
        input.runAId,
        input.runBId
      ]
    );
    return rowToRunComparison(result.rows[0]);
  }

  async getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null> {
    const result = await this.pool.query(
      `select * from run_comparisons where id = $1 and project_id = $2`,
      [runComparisonId, projectId]
    );
    const row = result.rows[0];
    return row ? rowToRunComparison(row) : null;
  }

  async listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]> {
    const result = await this.pool.query(
      `select * from run_comparisons where project_id = $1 order by created_at desc, id desc limit $2`,
      [projectId, opts?.limit ?? 50]
    );
    return result.rows.map(rowToRunComparison);
  }

  // --- Product deploy gate ---------------------------------------------------

  async getGoldenSetTraces(
    projectId: string,
    criterionVersionId?: string | undefined
  ): Promise<Map<string, Trace>> {
    return this.loadGoldenSetTraces(await this.listGoldenSet(projectId, criterionVersionId));
  }

  async createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail> {
    const gateCheckId = `gate_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into gate_checks
         (id, project_id, skill_version_id, eval_run_id, label, metadata, max_disagreements, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          gateCheckId,
          input.projectId,
          input.skillVersionId,
          input.evalRunId,
          input.label ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.maxDisagreements,
          input.createdByUserId ?? null
        ]
      );
      for (const item of input.items) {
        await client.query(
          `insert into gate_check_items
           (id, gate_check_id, project_id, golden_entry_id, golden_case_id, candidate_case_id, case_key, expected_label)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            `gati_${randomUUID()}`,
            gateCheckId,
            input.projectId,
            item.goldenEntryId,
            item.goldenCaseId,
            item.candidateCaseId,
            item.caseKey,
            item.expectedLabel
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
    const detail = await this.getGateCheckDetail(input.projectId, gateCheckId);
    if (!detail) throw new Error(`Gate check vanished after create: ${gateCheckId}`);
    return detail;
  }

  async getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null> {
    const result = await this.pool.query(
      `select gc.*, ${GATE_CHECK_RUN_COLUMNS}
       from gate_checks gc
       join eval_runs er on er.id = gc.eval_run_id
       where gc.id = $1 and gc.project_id = $2`,
      [gateCheckId, projectId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const check = rowToGateCheck(row);
    // The join key is the derived candidate case: eval_run_items is unique on
    // (eval_run_id, case_id), so each gate item matches at most one run item.
    const items = await this.pool.query(
      `select gi.*, eri.status as eval_status, eri.result_label, eri.agreement, eri.cached, eri.error as eval_error
       from gate_check_items gi
       left join eval_run_items eri
         on eri.eval_run_id = $2 and eri.case_id = gi.candidate_case_id
       where gi.gate_check_id = $1
       order by gi.created_at asc, gi.id asc`,
      [gateCheckId, check.evalRunId]
    );
    return { ...check, items: items.rows.map(rowToGateCheckItem) };
  }

  async listGateChecks(projectId: string, opts?: { limit?: number | undefined }): Promise<GateCheck[]> {
    const result = await this.pool.query(
      `select gc.*, ${GATE_CHECK_RUN_COLUMNS}
       from gate_checks gc
       join eval_runs er on er.id = gc.eval_run_id
       where gc.project_id = $1
       order by gc.created_at desc
       limit $2`,
      [projectId, opts?.limit ?? 50]
    );
    return result.rows.map(rowToGateCheck);
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
    const criterionVersionId = await this.resolveReviewCriterionVersion(
      input.projectId,
      input.criterionVersionId
    );
    // Validate every case belongs to this project before we open a transaction;
    // a missing case should fail fast with a typed error, not a generic FK
    // violation downstream.
    const distinctCaseIds = [...new Set(input.caseIds)];
    const validation = await this.pool.query(
      `select id from cases where project_id = $1 and id = any($2::text[])`,
      [input.projectId, distinctCaseIds]
    );
    const foundIds = new Set(validation.rows.map((row) => String(row.id)));
    const missing = distinctCaseIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Cases not found in project: ${missing.join(", ")}`);
    }

    const queueId = `revq_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into review_queues (id, project_id, name, description, created_by_user_id)
         values ($1,$2,$3,$4,$5)`,
        [queueId, input.projectId, input.name, input.description ?? null, input.createdByUserId ?? null]
      );
      let position = 0;
      for (const caseId of distinctCaseIds) {
        await client.query(
          `insert into review_queue_items (id, queue_id, case_id, criterion_version_id, position)
           values ($1,$2,$3,$4,$5)`,
          [`revqi_${randomUUID()}`, queueId, caseId, criterionVersionId, position]
        );
        position += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const detail = await this.getReviewQueueDetail(input.projectId, queueId);
    if (!detail) throw new Error(`Review queue not found after creation: ${queueId}`);
    return detail.queue;
  }

  async listReviewQueues(projectId: string, opts?: { status?: ReviewQueueStatus | undefined }): Promise<ReviewQueue[]> {
    const result = await this.pool.query(
      `select rq.*,
              coalesce(sum(case when rqi.status = 'pending' then 1 else 0 end), 0)::int as pending_count,
              coalesce(sum(case when rqi.status = 'completed' then 1 else 0 end), 0)::int as completed_count
       from review_queues rq
       left join review_queue_items rqi on rqi.queue_id = rq.id
       where rq.project_id = $1
         and ($2::text is null or rq.status = $2)
       group by rq.id
       order by rq.created_at desc`,
      [projectId, opts?.status ?? null]
    );
    return result.rows.map(rowToReviewQueue);
  }

  async getReviewQueueDetail(projectId: string, queueId: string): Promise<ReviewQueueDetail | null> {
    const queueRows = await this.pool.query(
      `select rq.*,
              coalesce(sum(case when rqi.status = 'pending' then 1 else 0 end), 0)::int as pending_count,
              coalesce(sum(case when rqi.status = 'completed' then 1 else 0 end), 0)::int as completed_count
       from review_queues rq
       left join review_queue_items rqi on rqi.queue_id = rq.id
       where rq.id = $1 and rq.project_id = $2
       group by rq.id`,
      [queueId, projectId]
    );
    if (!queueRows.rows[0]) return null;
    const itemRows = await this.pool.query(
      `select * from review_queue_items where queue_id = $1 order by position asc`,
      [queueId]
    );
    return {
      queue: rowToReviewQueue(queueRows.rows[0]),
      items: itemRows.rows.map(rowToReviewQueueItem)
    };
  }

  async getNextPendingQueueItem(projectId: string, queueId: string, opts?: {
    assignedToUserId?: string | undefined;
    criterionVersionId?: string | undefined;
  }): Promise<ReviewQueueItem | null> {
    // Closed queues return null. With assignee filter: match items assigned to
    // that reviewer OR unassigned (the unassigned pool is shared). Without
    // filter: return any pending item.
    if (!opts?.criterionVersionId) {
      const scope = await this.pool.query(
        `select count(distinct criterion_version_id)::int as criterion_count
         from review_queue_items
         where queue_id = $1 and status = 'pending'`,
        [queueId]
      );
      const criterionCount = Number(scope.rows[0]?.criterion_count ?? 0);
      if (criterionCount > 1) {
        throw new AmbiguousProjectSkillError(projectId, Math.max(2, criterionCount));
      }
    } else {
      await this.resolveReviewCriterionVersion(projectId, opts.criterionVersionId);
    }
    const result = await this.pool.query(
      `select rqi.*
       from review_queue_items rqi
       join review_queues rq on rq.id = rqi.queue_id
       where rq.id = $1 and rq.project_id = $2 and rq.status = 'open' and rqi.status = 'pending'
         and ($3::text is null or rqi.assigned_to_user_id is null or rqi.assigned_to_user_id = $3)
         and ($4::text is null or rqi.criterion_version_id = $4)
       order by rqi.position asc
       limit 1`,
      [queueId, projectId, opts?.assignedToUserId ?? null, opts?.criterionVersionId ?? null]
    );
    return result.rows[0] ? rowToReviewQueueItem(result.rows[0]) : null;
  }

  async addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]> {
    // Queue must exist in this project.
    const queueRow = await this.pool.query(
      `select id from review_queues where id = $1 and project_id = $2`,
      [input.queueId, input.projectId]
    );
    if (!queueRow.rowCount) throw new Error(`Review queue not found: ${input.queueId}`);

    // Validate every case belongs to this project before touching the queue.
    const caseIds = [...new Set(input.items.map((item) => item.caseId))];
    const validation = await this.pool.query(
      `select id from cases where project_id = $1 and id = any($2::text[])`,
      [input.projectId, caseIds]
    );
    const found = new Set(validation.rows.map((row) => String(row.id)));
    const missing = caseIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`Cases not found in project: ${missing.join(", ")}`);
    }
    const resolvedItems = await Promise.all(input.items.map(async (item) => ({
      ...item,
      criterionVersionId: await this.resolveReviewCriterionVersion(
        input.projectId,
        item.criterionVersionId
      )
    })));

    // Compute the starting position from the existing item count.
    const countRow = await this.pool.query(
      `select count(*)::int as count from review_queue_items where queue_id = $1`,
      [input.queueId]
    );
    let position = Number(countRow.rows[0]?.count ?? 0);

    const added: ReviewQueueItem[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const item of resolvedItems) {
        // ON CONFLICT DO NOTHING deduplicates the exact
        // (queue, case, criterion version, assignee) tuple.
        const result = await client.query(
          `insert into review_queue_items
             (id, queue_id, case_id, criterion_version_id, position, assigned_to_user_id)
           values ($1, $2, $3, $4, $5, $6)
           on conflict do nothing
           returning *`,
          [
            `revqi_${randomUUID()}`,
            input.queueId,
            item.caseId,
            item.criterionVersionId,
            position,
            item.assignedToUserId ?? null
          ]
        );
        if (result.rows[0]) {
          added.push(rowToReviewQueueItem(result.rows[0]));
          position += 1;
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return added;
  }

  async closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const updated = await this.pool.query(
      `update review_queues
       set status = 'closed', closed_at = now()
       where id = $1 and project_id = $2 and status <> 'closed'
       returning id`,
      [queueId, projectId]
    );
    if (!updated.rowCount) {
      // Either not found or already closed — fall through to detail lookup so
      // already-closed queues still return their current row (idempotent).
      const detail = await this.getReviewQueueDetail(projectId, queueId);
      return detail ? detail.queue : null;
    }
    const detail = await this.getReviewQueueDetail(projectId, queueId);
    return detail ? detail.queue : null;
  }

  async reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const updated = await this.pool.query(
      `update review_queues
       set status = 'open', closed_at = null
       where id = $1 and project_id = $2 and status <> 'open'
       returning id`,
      [queueId, projectId]
    );
    if (!updated.rowCount) {
      const detail = await this.getReviewQueueDetail(projectId, queueId);
      return detail ? detail.queue : null;
    }
    const detail = await this.getReviewQueueDetail(projectId, queueId);
    return detail ? detail.queue : null;
  }

  private async resolveReviewCriterionVersion(
    projectId: string,
    requested?: string | undefined
  ): Promise<string> {
    if (requested) {
      const result = await this.pool.query(
        `select version.id
         from criterion_versions version
         where version.project_id = $1
           and version.id = $2
           and exists (
             select 1
             from skill_versions evaluator
             where evaluator.project_id = version.project_id
               and evaluator.criterion_version_id = version.id
           )`,
        [projectId, requested]
      );
      if (!result.rowCount) {
        throw new DatasetRevisionConflictError(
          `Criterion version is not bound to an evaluator in this project: ${requested}`
        );
      }
      return requested;
    }
    const current = await this.getCurrentSkill(projectId);
    const row = (await this.pool.query(
      `select criterion_version_id
       from skill_versions
       where project_id = $1 and id = $2`,
      [projectId, current.currentVersion.id]
    )).rows[0];
    const criterionVersionId = String(row?.criterion_version_id ?? "");
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
    const result = await this.pool.query(
      `insert into feedback_sync_jobs (id, project_id, judge_run_id, provider, status)
       select $1, jr.project_id, jr.id, $4, 'pending'
       from judge_runs jr
       join cases c on c.id = jr.case_id
       join raw_traces rt on rt.id = c.raw_trace_id
       join integrations i on i.id = rt.source_integration_id and i.provider = $4
       where jr.project_id = $2 and jr.id = $3
       on conflict (judge_run_id, provider) do nothing
       returning *`,
      [`fsync_${randomUUID()}`, input.projectId, input.judgeRunId, input.provider]
    );
    const row = result.rows[0] ?? (await this.pool.query(
      `select * from feedback_sync_jobs
       where project_id = $1 and judge_run_id = $2 and provider = $3 and status <> 'synced'`,
      [input.projectId, input.judgeRunId, input.provider]
    )).rows[0];
    return row ? rowToFeedbackSyncJobRecord(row) : null;
  }

  async loadFeedbackSyncContext(job: FeedbackSyncJob): Promise<FeedbackSyncContext> {
    const result = await this.pool.query(
      `select fsj.id as feedback_sync_job_id,
              fsj.project_id,
              fsj.provider,
              jr.id as judge_run_id,
              jr.case_id,
              jr.skill_version_id,
              sv.model_binding,
              jr.verdict,
              jr.score,
              jr.reasoning,
              jr.created_at as judge_run_created_at,
              rt.source_trace_id,
              i.id as integration_id,
              i.config as integration_config,
              i.encrypted_credentials,
              i.created_at as integration_created_at
       from feedback_sync_jobs fsj
       join judge_runs jr on jr.id = fsj.judge_run_id
       join skill_versions sv on sv.id = jr.skill_version_id
       join cases c on c.id = jr.case_id
       join raw_traces rt on rt.id = c.raw_trace_id
       join integrations i on i.id = rt.source_integration_id and i.provider = fsj.provider
       where fsj.id = $1 and fsj.project_id = $2`,
      [job.feedbackSyncJobId, job.projectId]
    );
    const row = result.rows[0];
    if (!row) throw new FeedbackSyncJobNotFoundError(job.feedbackSyncJobId);
    const provider = toFeedbackSyncProvider(row.provider);
    const config = parseJson(row.integration_config) as {
      projectName?: string | null;
      endpointUrl?: string | null;
      url?: string;
      quietPeriodSeconds?: number;
      skillVersionId?: string | null;
    };
    const credentials = decryptJson<{ apiKey?: string; publicKey?: string; secretKey?: string }>(String(row.encrypted_credentials));
    if (provider === "langsmith" && !credentials.apiKey) throw new FeedbackSyncCredentialsMissingError(job.feedbackSyncJobId);
    if (provider === "langfuse" && (!credentials.publicKey || !credentials.secretKey)) throw new FeedbackSyncCredentialsMissingError(job.feedbackSyncJobId);
    if (provider === "ironside" && (!credentials.apiKey || !config.url)) throw new FeedbackSyncCredentialsMissingError(job.feedbackSyncJobId);
    return {
      id: String(row.feedback_sync_job_id),
      projectId: String(row.project_id),
      provider,
      sourceTraceId: String(row.source_trace_id),
      judgeRun: {
        id: String(row.judge_run_id),
        projectId: String(row.project_id),
        caseId: String(row.case_id),
        skillVersionId: String(row.skill_version_id),
        modelBinding: StoredModelBindingSchema.parse(parseJson(row.model_binding)),
        verdict: row.verdict === "fail" ? "fail" : row.verdict === "ambiguous" ? "ambiguous" : "pass",
        score: Number(row.score),
        reasoning: String(row.reasoning),
        createdAt: toIso(row.judge_run_created_at)
      },
      integration: provider === "langfuse"
        ? {
            id: String(row.integration_id),
            projectId: String(row.project_id),
            provider: "langfuse",
            skillVersionId: config.skillVersionId ?? null,
            projectName: config.projectName ?? null,
            endpointUrl: config.endpointUrl ?? null,
            pollEnabled: true,
            pollIntervalSeconds: 300,
            pollLimit: 25,
            lastTestedAt: null,
            lastTestResult: null,
            createdAt: toIso(row.integration_created_at),
            publicKey: credentials.publicKey!,
            secretKey: credentials.secretKey!
          }
        : provider === "ironside"
        ? {
            id: String(row.integration_id),
            projectId: String(row.project_id),
            provider: "ironside",
            skillVersionId: config.skillVersionId ?? null,
            url: String(config.url),
            pollEnabled: true,
            pollIntervalSeconds: 300,
            pollLimit: 25,
            quietPeriodSeconds: Number(config.quietPeriodSeconds ?? 300),
            lastTestedAt: null,
            lastTestResult: null,
            createdAt: toIso(row.integration_created_at),
            apiKey: credentials.apiKey!
          }
        : {
            id: String(row.integration_id),
            projectId: String(row.project_id),
            provider: "langsmith",
            skillVersionId: config.skillVersionId ?? null,
            projectName: config.projectName ?? null,
            endpointUrl: config.endpointUrl ?? null,
            pollEnabled: true,
            pollIntervalSeconds: 300,
            pollLimit: 25,
            lastTestedAt: null,
            lastTestResult: null,
            createdAt: toIso(row.integration_created_at),
            apiKey: credentials.apiKey!
          }
    };
  }

  async listFeedbackSyncJobs(input: ListFeedbackSyncJobsInput): Promise<FeedbackSyncJobListItem[]> {
    const result = await this.pool.query(
      `select id, project_id, judge_run_id, provider, status, attempts, last_error, created_at
       from feedback_sync_jobs
       where project_id = $1 and ($2::text is null or status = $2)
       order by created_at desc
       limit $3`,
      [input.projectId, input.status ?? null, input.limit]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      judgeRunId: String(row.judge_run_id),
      provider: toFeedbackSyncProvider(row.provider),
      status: toFeedbackSyncStatus(row.status),
      attempts: Number(row.attempts ?? 0),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      createdAt: toIso(row.created_at)
    }));
  }

  async markFeedbackSyncSucceeded(job: FeedbackSyncJob): Promise<void> {
    await this.pool.query(
      `update feedback_sync_jobs set status = 'synced', last_error = null where id = $1 and project_id = $2`,
      [job.feedbackSyncJobId, job.projectId]
    );
    await this.refreshSyncBackCoverage(job.projectId);
  }

  async markFeedbackSyncFailed(job: FeedbackSyncJob, error: unknown): Promise<void> {
    await this.pool.query(
      `update feedback_sync_jobs set status = 'failed', attempts = attempts + 1, last_error = $3 where id = $1 and project_id = $2`,
      [job.feedbackSyncJobId, job.projectId, error instanceof Error ? error.message : String(error)]
    );
    await this.refreshSyncBackCoverage(job.projectId);
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
      const regressionDatasetRevisionId = await this.getOrCreateRegressionDatasetRevisionWithClient(
        client,
        context.projectId,
        criterionVersionId,
        context.actorUserId
      );

      const version: SkillVersion = {
        id: `skillv_${randomUUID()}`,
        skillId,
        criterionVersionId,
        version: await this.nextVersion(client, skillId),
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
        regressionDatasetRevisionId,
        createdAt: new Date().toISOString(),
        approvedAt: null
      };

      if (context.agentSetup?.providerCredential) {
        const credential = context.agentSetup.providerCredential;
        await this.setJudgeProviderKeyOnClient(
          client,
          context.projectId,
          credential.provider,
          credential.apiKey,
          context.actorUserId
        );
      }
      await this.insertSkillVersion(
        client,
        version,
        context.projectId,
        criterionVersionId,
        context.actorUserId ?? null
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
      await this.insertRegressionRun(client, regressionRun, { projectId: job.projectId, actorUserId: job.actorUserId });
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
      await this.insertRegressionRun(client, {
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

  private async refreshSyncBackCoverage(projectId: string): Promise<void> {
    // This is enqueued sync coverage: synced upstream feedback jobs divided by
    // upstream feedback jobs attempted. Manual traces and verdicts that never
    // produced feedback_sync_jobs are intentionally excluded from the denominator.
    await this.pool.query(
      `update projects
       set sync_back_coverage = coalesce((
             select count(*) filter (where fsj.status = 'synced')::numeric / nullif(count(*)::numeric, 0)
             from feedback_sync_jobs fsj
             where fsj.project_id = $1 and fsj.provider in ('langsmith', 'langfuse', 'ironside')
           ), 0),
           updated_at = now()
       where id = $1`,
      [projectId]
    );
  }

  private async refreshProjectCounters(client: PoolClient, projectId: string): Promise<void> {
    await client.query(
      `update projects
       set imported_trace_count = (
             -- Gate candidates (case_type 'gate_candidate') are product-gate
             -- scaffolding, not imported traffic — excluded here and in the
             -- importTrace increment.
             select count(*)::int
             from raw_traces rt
             where rt.project_id = $1
               and not exists (
                 select 1 from cases c
                 where c.raw_trace_id = rt.id
                   and c.case_type in ('gate_candidate', 'release_evidence')
               )
           ),
           auto_judged_trace_count = (
             -- Distinct cases, not judge_runs rows: re-judges (new versions,
             -- self-consistency probes) must not push coverage past 100%.
             -- Gate candidates are excluded to match the imported count.
             select count(distinct jr.case_id)::int
             from judge_runs jr
             join cases c on c.id = jr.case_id
             where jr.project_id = $1
               and c.case_type not in ('gate_candidate', 'release_evidence')
           ),
           sync_back_coverage = coalesce((
             select count(*) filter (where fsj.status = 'synced')::numeric / nullif(count(*)::numeric, 0)
             from feedback_sync_jobs fsj
             where fsj.project_id = $1 and fsj.provider in ('langsmith', 'langfuse', 'ironside')
           ), 0),
           updated_at = now()
       where id = $1`,
      [projectId]
    );
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

  private async insertSkillVersion(
    client: PoolClient,
    version: SkillVersion,
    projectId: string,
    criterionVersionId: string,
    actorUserId: string | null
  ): Promise<void> {
    const developerSubjectId = actorUserId
      ? await this.getOrCreateGovernedReviewerSubject(client, projectId, actorUserId)
      : null;
    const recordedActorUserId = developerSubjectId ? actorUserId : null;
    await client.query(
      `insert into skill_versions
       (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
        golden_set_agreement, too_strict_count, too_lenient_count, ambiguous_count, known_limitations,
        verdict_kind, scalar_range, categorical_choice_scores, rubric_provenance,
        regression_dataset_revision_id, created_at, approved_at, criterion_version_id,
        created_by_user_id, created_by_subject_id, developer_identity_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        version.id,
        version.skillId,
        projectId,
        version.version,
        version.status,
        version.rubricMarkdown,
        version.prompt,
        JSON.stringify(version.outputSchema),
        JSON.stringify(version.modelBinding),
        version.goldenSetAgreement,
        version.tooStrictCount,
        version.tooLenientCount,
        version.ambiguousCount,
        version.knownLimitations,
        version.verdictKind,
        version.scalarRange === null ? null : JSON.stringify(version.scalarRange),
        version.categoricalChoiceScores === null ? null : JSON.stringify(version.categoricalChoiceScores),
        version.rubricProvenance,
        version.regressionDatasetRevisionId ?? null,
        version.createdAt,
        version.approvedAt,
        criterionVersionId,
        recordedActorUserId,
        developerSubjectId,
        developerSubjectId ? "recorded" : "unknown_legacy"
      ]
    );
  }

  /**
   * Account links are removable PII; governed evidence uses the durable,
   * project-scoped subject instead. The unique account binding is also the
   * serialization point when two evaluator versions are authored at once.
   */
  private async getOrCreateGovernedReviewerSubject(
    client: PoolClient,
    projectId: string,
    accountUserId: string
  ): Promise<string | null> {
    // API-key and internal callers may supply an actor string that is not a
    // verified account membership. It cannot become governed identity
    // evidence: keep the version unknown_legacy and let sealed eligibility
    // fail closed.
    const verifiedAccount = await client.query(
      `select 1
       from "user" account
       join project_members membership
         on membership.user_id = account.id and membership.project_id = $1
       where account.id = $2`,
      [projectId, accountUserId]
    );
    if (!verifiedAccount.rowCount) return null;
    const candidateId = `grs_${createHash("sha256")
      .update([projectId, accountUserId].join("\u0000"), "utf8")
      .digest("hex")
      .slice(0, 48)}`;
    await client.query(
      `insert into governed_reviewer_subjects
         (id, project_id, account_user_id, subject_digest)
       values ($1, $2, $3,
         governed_content_v1_digest(
           'governed-reviewer-subject/v1',
           jsonb_build_object('projectId', $2::text, 'subjectId', $1::text)
         )
       )
       on conflict do nothing`,
      [candidateId, projectId, accountUserId]
    );
    const subject = await client.query(
      `select id
       from governed_reviewer_subjects
       where project_id = $1 and account_user_id = $2`,
      [projectId, accountUserId]
    );
    if (!subject.rows[0]?.id) {
      throw new Error("Unable to establish governed evaluator-author subject");
    }
    return String(subject.rows[0].id);
  }

  private async insertRegressionRun(client: PoolClient, regressionRun: RegressionRunResult, context: CreateSkillVersionContext): Promise<void> {
    await client.query(
      `insert into regression_runs
       (id, project_id, skill_version_id, dataset_revision_id, status, compared, regressed, improved, flipped,
        override_reason, override_actor_user_id, golden_set_missing, cases, error_message, created_at,
        criterion_version_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               (select criterion_version_id from skill_versions where id=$3 and project_id=$2))`,
      [
        regressionRun.id,
        context.projectId,
        regressionRun.skillVersionId,
        regressionRun.datasetRevisionId,
        regressionRun.status,
        regressionRun.compared,
        regressionRun.regressed,
        regressionRun.improved,
        regressionRun.flipped,
        regressionRun.overrideReason ?? null,
        context.actorUserId ?? null,
        regressionRun.goldenSetMissing,
        JSON.stringify(regressionRun.cases),
        regressionRun.error ?? null,
        regressionRun.createdAt
      ]
    );
  }

  private async nextVersion(client: PoolClient, skillId: string): Promise<string> {
    const result = await client.query(
      `select version from skill_versions where skill_id = $1 order by created_at desc limit 1`,
      [skillId]
    );
    const current = String(result.rows[0]?.version ?? "0.0.0");
    const [major = "0", minor = "0", patch = "0"] = current.split(".");
    return `${major}.${minor}.${Number(patch) + 1}`;
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

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    mode: row.mode === "bench" ? "bench" : "tracing",
    traceProvider: row.trace_provider === "langsmith" || row.trace_provider === "langfuse" || row.trace_provider === "ironside" || row.trace_provider === "manual" ? row.trace_provider : "unknown",
    importedTraceCount: Number(row.imported_trace_count ?? 0),
    autoJudgedTraceCount: Number(row.auto_judged_trace_count ?? 0),
    syncBackCoverage: Number(row.sync_back_coverage ?? 0),
    traceRetentionDays: row.trace_retention_days === null || row.trace_retention_days === undefined ? null : Number(row.trace_retention_days),
    updatedAt: toIso(row.updated_at)
  };
}

function rowToProjectSettings(row: Record<string, unknown>): ProjectSettings {
  return {
    projectId: String(row.id),
    name: String(row.name),
    mode: row.mode === "bench" ? "bench" : "tracing",
    traceRetentionDays: row.trace_retention_days === null || row.trace_retention_days === undefined ? null : Number(row.trace_retention_days)
  };
}

function rowToCriterion(row: Record<string, unknown>): Criterion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    stableKey: String(row.stable_key),
    sourceKind: criterionSourceKind(row.source_kind),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

function rowToCriterionVersion(row: Record<string, unknown>): CriterionVersion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    revision: Number(row.revision),
    name: String(row.name),
    definition: String(row.definition),
    criterionDigest: String(row.criterion_digest),
    sourceKind: criterionSourceKind(row.source_kind),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

function criterionSourceKind(value: unknown): "native" | "analysis_promotion" {
  if (value === "native" || value === "analysis_promotion") return value;
  throw new Error(`Unsupported criterion source kind: ${String(value)}`);
}

function rowToEvaluatorSuite(row: Record<string, unknown>): EvaluatorSuite {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

function rowToSkill(row: Record<string, unknown>): Skill {
  return SkillSchema.parse({
    id: String(row.id),
    projectId: String(row.project_id),
    criterionId: String(row.criterion_id),
    name: String(row.name),
    description: String(row.description),
    ownerName: String(row.owner_name ?? row.owner_email ?? row.owner_user_id ?? "Owner"),
    status: toSkillStatus(row.status),
    isStarter: row.is_starter === true,
    currentVersion: {
      id: String(row.version_id),
      skillId: String(row.id),
      criterionVersionId: String(row.version_criterion_version_id),
      version: String(row.version),
      status: toSkillStatus(row.version_status),
      rubricMarkdown: String(row.rubric_markdown),
      prompt: String(row.prompt),
      modelBinding: parseJson(row.model_binding),
      outputSchema: parseJson(row.output_schema),
      goldenSetAgreement: row.golden_set_agreement === null || row.golden_set_agreement === undefined ? null : Number(row.golden_set_agreement),
      tooStrictCount: Number(row.too_strict_count ?? 0),
      tooLenientCount: Number(row.too_lenient_count ?? 0),
      ambiguousCount: Number(row.ambiguous_count ?? 0),
      knownLimitations: Array.isArray(row.known_limitations) ? row.known_limitations.map(String) : [],
      verdictKind: String(row.verdict_kind),
      scalarRange: row.scalar_range == null ? null : parseJson(row.scalar_range),
      categoricalChoiceScores: row.categorical_choice_scores == null ? null : parseJson(row.categorical_choice_scores),
      rubricProvenance: String(row.rubric_provenance),
      regressionDatasetRevisionId: row.regression_dataset_revision_id === null || row.regression_dataset_revision_id === undefined
        ? null
        : String(row.regression_dataset_revision_id),
      createdAt: toIso(row.version_created_at),
      approvedAt: row.approved_at ? toIso(row.approved_at) : null
    }
  });
}

function rowToGoldenSetEntry(row: Record<string, unknown>): GoldenSetEntry {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    traceId: String(row.trace_id),
    agreedLabel: row.agreed_label === "fail" ? "fail" : "pass",
    reason: String(row.reason ?? ""),
    promotedBy: String(row.promoted_by ?? row.promoted_by_user_id ?? "Unknown"),
    promotedAt: toIso(row.promoted_at),
    sourceSkillVersionId: String(row.source_skill_version_id),
    criterionVersionId: String(row.criterion_version_id)
  };
}

async function loadGoldenSetRetirementContext(client: PoolClient, projectId: string, entryId: string): Promise<GoldenSetRetirementContext | null> {
  const result = await client.query(
    `select gse.retired_at,
            audit.actor_user_id,
            audit.metadata,
            u.name as actor_name,
            u.email as actor_email
     from golden_set_entries gse
     left join lateral (
       select actor_user_id, metadata
       from audit_logs
       where project_id = $2
         and action = 'golden_set.retire'
         and target_type = 'golden_set_entry'
         and target_id = $1
       order by created_at desc
       limit 1
     ) audit on true
     left join "user" u on u.id = audit.actor_user_id
     where gse.id = $1 and gse.project_id = $2`,
    [entryId, projectId]
  );
  const row = result.rows[0];
  if (!row?.retired_at) return null;
  const metadata = parseJson(row.metadata) as { reason?: unknown } | null;
  const actorName = row.actor_name === null || row.actor_name === undefined ? null : String(row.actor_name);
  const actorEmail = row.actor_email === null || row.actor_email === undefined ? null : String(row.actor_email);
  const actorUserId = row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id);
  return GoldenSetRetirementContextSchema.parse({
    retiredAt: toIso(row.retired_at),
    retiredByUserId: actorUserId,
    retiredBy: actorName && actorEmail ? `${actorName} <${actorEmail}>` : actorEmail ?? actorName ?? actorUserId,
    reason: typeof metadata?.reason === "string" ? metadata.reason : null
  });
}

function rowToSkillVersion(row: Record<string, unknown>): SkillVersion {
  const scalarRangeRaw = row.scalar_range == null ? null : parseJson(row.scalar_range);
  const categoricalChoiceScoresRaw = row.categorical_choice_scores == null ? null : parseJson(row.categorical_choice_scores);
  return SkillVersionSchema.parse({
    id: String(row.id),
    skillId: String(row.skill_id),
    criterionVersionId: String(row.criterion_version_id),
    version: String(row.version),
    status: toSkillStatus(row.status),
    rubricMarkdown: String(row.rubric_markdown),
    prompt: String(row.prompt),
    modelBinding: parseJson(row.model_binding),
    outputSchema: parseJson(row.output_schema),
    goldenSetAgreement: row.golden_set_agreement === null || row.golden_set_agreement === undefined ? null : Number(row.golden_set_agreement),
    tooStrictCount: Number(row.too_strict_count ?? 0),
    tooLenientCount: Number(row.too_lenient_count ?? 0),
    ambiguousCount: Number(row.ambiguous_count ?? 0),
    knownLimitations: Array.isArray(row.known_limitations) ? row.known_limitations.map(String) : [],
    verdictKind: String(row.verdict_kind),
    scalarRange: scalarRangeRaw,
    categoricalChoiceScores: categoricalChoiceScoresRaw,
    rubricProvenance: String(row.rubric_provenance),
    regressionDatasetRevisionId: row.regression_dataset_revision_id === null || row.regression_dataset_revision_id === undefined
      ? null
      : String(row.regression_dataset_revision_id),
    createdAt: toIso(row.created_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null
  });
}

function rowToJudgeRun(row: Record<string, unknown>): JudgeRun {
  const metadata = row.provider_metadata && typeof parseJson(row.provider_metadata) === "object"
    ? parseJson(row.provider_metadata) as Record<string, unknown>
    : {};
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    caseId: String(row.case_id),
    skillVersionId: String(row.skill_version_id),
    verdict: row.verdict === "fail" ? "fail" : row.verdict === "ambiguous" ? "ambiguous" : "pass",
    score: Number(row.score),
    reasoning: String(row.reasoning),
    ...(row.latency_ms === null || row.latency_ms === undefined ? {} : { latencyMs: Number(row.latency_ms) }),
    providerMetadata: {
      model: typeof metadata.model === "string" ? metadata.model : null,
      requestId: typeof metadata.requestId === "string" ? metadata.requestId : null,
      responseId: typeof metadata.responseId === "string" ? metadata.responseId : null,
      systemFingerprint: typeof metadata.systemFingerprint === "string" ? metadata.systemFingerprint : null
    },
    createdAt: toIso(row.created_at)
  };
}

// Postgres unique_violation. Used to translate constraint backstops (e.g. the
// active-dataset-name partial index) into domain errors instead of 500s.
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

function isCheckViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23514";
}

function postgresErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "Dataset revision violates an immutable evidence constraint";
}

function rowToTraceTestSummary(row: Record<string, unknown>): TraceTestSummary {
  const currentRevision = Number(row.current_revision);
  const enabledRevision = row.enabled_revision === null || row.enabled_revision === undefined
    ? null
    : Number(row.enabled_revision);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sourceCaseId: row.source_case_id ? String(row.source_case_id) : null,
    sourceCaseRef: String(row.source_case_ref),
    sourceTraceRef: String(row.source_trace_ref),
    lifecycle: enabledRevision === null ? "draft" : "enabled",
    currentRevision,
    enabledRevision,
    hasUnpublishedChanges: enabledRevision !== null && currentRevision !== enabledRevision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function rowToTraceTestRevision(row: Record<string, unknown>): TraceTestRevision {
  return {
    id: String(row.id),
    traceTestId: String(row.trace_test_id),
    revision: Number(row.revision),
    lifecycle: row.lifecycle === "enabled" ? "enabled" : "draft",
    desiredBehavior: String(row.desired_behavior),
    scenario: String(row.scenario),
    expectedBehavior: String(row.expected_behavior),
    mustDo: parseJson(row.must_do) as string[],
    mustAvoid: parseJson(row.must_avoid) as string[],
    goodExample: parseJson(row.good_example) as TraceTestRevision["goodExample"],
    badExample: parseJson(row.bad_example) as TraceTestRevision["badExample"],
    checker: parseJson(row.checker) as TraceTestRevision["checker"],
    draftProvenance: parseJson(row.draft_provenance) as TraceTestRevision["draftProvenance"],
    validationId: row.validation_id ? String(row.validation_id) : null,
    validatedRevision: row.validated_revision === null || row.validated_revision === undefined
      ? null
      : Number(row.validated_revision),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    reviewedByUserId: row.reviewed_by_user_id ? String(row.reviewed_by_user_id) : null,
    createdAt: toIso(row.created_at),
    reviewedAt: row.reviewed_at ? toIso(row.reviewed_at) : null
  };
}

function rowToTraceTestValidation(row: Record<string, unknown>): TraceTestValidation {
  return {
    id: String(row.id),
    traceTestId: String(row.trace_test_id),
    revision: Number(row.revision),
    status: String(row.status) as TraceTestValidation["status"],
    badEvidence: parseJson(row.bad_evidence) as TraceTestValidation["badEvidence"],
    goodEvidence: parseJson(row.good_evidence) as TraceTestValidation["goodEvidence"],
    method: String(row.method) as TraceTestValidation["method"],
    diagnostic: row.diagnostic === null || row.diagnostic === undefined ? null : String(row.diagnostic) as TraceTestValidation["diagnostic"],
    evaluator: row.evaluator === null || row.evaluator === undefined ? null : parseJson(row.evaluator) as TraceTestValidation["evaluator"],
    overrideReason: row.override_reason === null || row.override_reason === undefined ? null : String(row.override_reason),
    recordedByUserId: row.recorded_by_user_id ? String(row.recorded_by_user_id) : null,
    createdAt: toIso(row.created_at)
  };
}

function rowToDataset(row: Record<string, unknown>, itemCount: number): Dataset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    kind: String(row.kind) as DatasetKind,
    itemCount,
    createdAt: toIso(row.created_at),
    archivedAt: row.archived_at ? toIso(row.archived_at) : null
  };
}

function rowToDatasetItem(row: Record<string, unknown>): DatasetItem {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    caseId: String(row.case_id),
    traceId: String(row.trace_id),
    expectedLabel: row.expected_label ? (String(row.expected_label) as "pass" | "fail") : null,
    expectedFailStep: row.expected_fail_step === null || row.expected_fail_step === undefined ? null : Number(row.expected_fail_step),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    addedAt: toIso(row.added_at)
  };
}

function normalizedPayloadSnapshot(value: unknown): DatasetRevisionPayloadSnapshot {
  const payload = parseJson(value) as {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    steps?: DatasetRevisionPayloadSnapshot["steps"];
  } | null;
  if (!payload || !("input" in payload) || !("output" in payload)) {
    throw new DatasetRevisionConflictError("Case has no complete retained normalized payload to freeze");
  }
  return {
    input: payload.input,
    output: payload.output,
    metadata: payload.metadata ?? {},
    ...(payload.steps ? { steps: payload.steps } : {})
  };
}

function rowToDatasetRevision(row: Record<string, unknown>): DatasetRevision {
  const role = String(row.role) as DatasetRevision["role"];
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    seriesId: String(row.series_id),
    revisionNumber: Number(row.revision_number),
    sourceDatasetId: row.source_dataset_id === null || row.source_dataset_id === undefined ? null : String(row.source_dataset_id),
    parentRevisionId: row.parent_revision_id === null || row.parent_revision_id === undefined ? null : String(row.parent_revision_id),
    role,
    sourceKind: String(row.source_kind) as DatasetRevision["sourceKind"],
    identityBasis: "input-identity/v1",
    contentDigest: String(row.content_digest),
    revisionDigest: String(row.revision_digest),
    itemCount: Number(row.item_count),
    provenanceLevel: String(row.provenance_level) as DatasetRevision["provenanceLevel"],
    exposureState: role !== "sealed_validation"
      ? "visible_by_design"
      : Boolean(row.has_development_exposure) ? "exposed" : "protected",
    semanticLeakageDetection: "unsupported",
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined ? null : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

function rowToDatasetRevisionItem(row: Record<string, unknown>): DatasetRevisionItem {
  return {
    id: String(row.id),
    revisionId: String(row.revision_id),
    position: Number(row.position),
    sourceCaseId: row.source_case_id === null || row.source_case_id === undefined ? null : String(row.source_case_id),
    sourceTraceId: row.source_trace_id === null || row.source_trace_id === undefined ? null : String(row.source_trace_id),
    sourceDatasetItemId: row.source_dataset_item_id === null || row.source_dataset_item_id === undefined ? null : String(row.source_dataset_item_id),
    sourceGoldenEntryId: row.source_golden_entry_id === null || row.source_golden_entry_id === undefined ? null : String(row.source_golden_entry_id),
    inputDigest: String(row.input_digest),
    itemDigest: String(row.item_digest),
    payloadSnapshot: normalizedPayloadSnapshot(row.payload_snapshot),
    referenceLabel: row.reference_label === "pass" || row.reference_label === "fail" ? row.reference_label : null,
    referenceFailStep: row.reference_fail_step === null || row.reference_fail_step === undefined ? null : Number(row.reference_fail_step),
    referenceProvenance: parseJson(row.reference_provenance) as DatasetReferenceProvenance,
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: toIso(row.created_at)
  };
}

function rowToDatasetExposureEvent(row: Record<string, unknown>): DatasetExposureEvent {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    revisionId: String(row.revision_id),
    revisionItemId: row.revision_item_id === null || row.revision_item_id === undefined ? null : String(row.revision_item_id),
    kind: String(row.kind) as DatasetExposureEvent["kind"],
    exposureClass: String(row.exposure_class) as DatasetExposureEvent["exposureClass"],
    activity: String(row.activity) as DatasetExposureEvent["activity"],
    subjectKind: String(row.subject_kind) as DatasetExposureEvent["subjectKind"],
    subjectId: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
    evidenceRefKind: row.evidence_ref_kind === null || row.evidence_ref_kind === undefined ? null : String(row.evidence_ref_kind),
    evidenceRefId: row.evidence_ref_id === null || row.evidence_ref_id === undefined ? null : String(row.evidence_ref_id),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    details: (parseJson(row.details) ?? {}) as Record<string, unknown>,
    occurredAt: toIso(row.occurred_at)
  };
}

function rowToEvalRun(row: Record<string, unknown>): EvalRun {
  const sourceTraceTest: TraceTestRunSource | null = row.source_trace_test_id
    ? {
        traceTestId: String(row.source_trace_test_id),
        revision: Number(row.source_trace_test_revision),
        validationRevision: Number(row.source_trace_test_validation_revision),
        validationId: String(row.source_trace_test_validation_id),
        sourceCaseRef: String(row.source_trace_test_case_ref),
        caseId: String(row.source_trace_test_case_id),
        datasetItemId: String(row.source_trace_test_dataset_item_id)
      }
    : null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    datasetId: row.dataset_id ? String(row.dataset_id) : null,
    datasetRevisionId: row.dataset_revision_id ? String(row.dataset_revision_id) : null,
    skillVersionId: String(row.skill_version_id),
    trigger: String(row.trigger) as EvalRunTrigger,
    status: String(row.status) as EvalRunStatus,
    blocking: Boolean(row.blocking),
    totalItems: Number(row.total_items),
    completedItems: Number(row.completed_items),
    failedItems: Number(row.failed_items),
    agreedItems: Number(row.agreed_items),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    sourceTraceTest,
    createdAt: toIso(row.created_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    finishedAt: row.finished_at ? toIso(row.finished_at) : null
  };
}

function rowToAssessmentReceiptArtifact(row: Record<string, unknown>): AssessmentReceiptArtifact {
  const canonicalBytes = Buffer.from(row.canonical_bytes as Uint8Array);
  let receipt: AssessmentReceipt;
  try {
    receipt = parseCanonicalReceiptBytes(canonicalBytes);
  } catch (error) {
    throw new AssessmentReceiptIntegrityError(
      `Persisted assessment receipt bytes failed validation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const artifactDigest = String(row.artifact_digest);
  if (artifactDigest !== receiptArtifactDigest(canonicalBytes)) {
    throw new AssessmentReceiptIntegrityError("Persisted assessment receipt artifactDigest mismatch");
  }
  const projectId = String(row.project_id);
  const evalRunId = String(row.eval_run_id);
  const receiptId = String(row.receipt_id);
  const contractVersion = Number(row.contract_version);
  const evidenceDigest = String(row.evidence_digest);
  if (
    receipt.projectId !== projectId ||
    receipt.evalRunId !== evalRunId ||
    receipt.receiptId !== receiptId ||
    receipt.schemaVersion !== contractVersion ||
    receipt.evidenceDigest !== evidenceDigest
  ) {
    throw new AssessmentReceiptIntegrityError("Persisted assessment receipt columns do not match its canonical bytes");
  }
  return {
    id: String(row.id),
    projectId,
    evalRunId,
    receiptId,
    contractVersion,
    artifactRevision: Number(row.artifact_revision),
    canonicalBytes,
    artifactDigest,
    evidenceDigest,
    sourceSnapshotDigest: String(row.source_snapshot_digest),
    sourceKind: String(row.source_kind) as AssessmentReceiptArtifactSource,
    predecessorArtifactId: row.predecessor_artifact_id === null || row.predecessor_artifact_id === undefined
      ? null
      : String(row.predecessor_artifact_id),
    correctionReason: row.correction_reason === null || row.correction_reason === undefined
      ? null
      : String(row.correction_reason),
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined
      ? null
      : String(row.created_by_user_id),
    createdAt: toIso(row.created_at)
  };
}

function rowToAssessmentReceiptComparison(row: Record<string, unknown>): AssessmentReceiptComparison {
  const consumerCanonicalBytes = Buffer.from(row.consumer_canonical_bytes as Uint8Array);
  let receipt: AssessmentReceipt;
  try {
    receipt = parseCanonicalReceiptBytes(consumerCanonicalBytes);
  } catch (error) {
    throw new AssessmentReceiptIntegrityError(
      `Persisted consumer receipt bytes failed validation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const projectId = String(row.project_id);
  const evalRunId = String(row.eval_run_id);
  const consumerReceiptId = String(row.consumer_receipt_id);
  const consumerArtifactDigest = String(row.consumer_artifact_digest);
  const comparisonStatus = String(row.comparison_status);
  if (consumerArtifactDigest !== receiptArtifactDigest(consumerCanonicalBytes)) {
    throw new AssessmentReceiptIntegrityError("Persisted consumer receipt artifactDigest mismatch");
  }
  if (
    receipt.projectId !== projectId ||
    receipt.evalRunId !== evalRunId ||
    receipt.receiptId !== consumerReceiptId
  ) {
    throw new AssessmentReceiptIntegrityError("Persisted consumer receipt columns do not match its canonical bytes");
  }
  if (comparisonStatus !== "match" && comparisonStatus !== "diverged") {
    throw new AssessmentReceiptIntegrityError("Persisted consumer receipt comparison status is invalid");
  }
  return {
    id: String(row.id),
    projectId,
    evalRunId,
    artifactId: String(row.artifact_id),
    consumerReceiptId,
    consumerCanonicalBytes,
    consumerArtifactDigest,
    comparisonStatus,
    createdAt: toIso(row.created_at)
  };
}

function rowToRunComparison(row: Record<string, unknown>): RunComparison {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    datasetId: String(row.dataset_id),
    datasetRevisionId: row.dataset_revision_id ? String(row.dataset_revision_id) : null,
    versionAId: String(row.version_a_id),
    versionBId: String(row.version_b_id),
    runAId: String(row.run_a_id),
    runBId: String(row.run_b_id),
    createdAt: toIso(row.created_at)
  };
}

function rowToEvalRunItem(row: Record<string, unknown>): EvalRunItem {
  return {
    id: String(row.id),
    evalRunId: String(row.eval_run_id),
    caseId: String(row.case_id),
    datasetItemId: row.dataset_item_id ? String(row.dataset_item_id) : null,
    datasetRevisionItemId: row.dataset_revision_item_id ? String(row.dataset_revision_item_id) : null,
    clientItemId: row.client_item_id === null || row.client_item_id === undefined ? null : String(row.client_item_id),
    contentDigest: row.content_digest === null || row.content_digest === undefined ? null : String(row.content_digest),
    status: String(row.status) as EvalRunItemStatus,
    verdictId: row.verdict_id ? String(row.verdict_id) : null,
    expectedLabel: row.expected_label ? (String(row.expected_label) as "pass" | "fail") : null,
    expectedFailStep: row.expected_fail_step === null || row.expected_fail_step === undefined ? null : Number(row.expected_fail_step),
    failingStep: row.failing_step === null || row.failing_step === undefined ? null : Number(row.failing_step),
    resultLabel: row.result_label === null || row.result_label === undefined ? null : String(row.result_label),
    agreement: row.agreement === null || row.agreement === undefined ? null : Boolean(row.agreement),
    // Tri-state, never blended into overall agreement: true/false only when
    // BOTH the expectation and the judge's named step exist.
    stepAgreement:
      row.expected_fail_step === null || row.expected_fail_step === undefined ||
      row.failing_step === null || row.failing_step === undefined
        ? null
        : Number(row.expected_fail_step) === Number(row.failing_step),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
    providerMetadata: row.provider_metadata === null || row.provider_metadata === undefined
      ? null
      : parseJson(row.provider_metadata) as EvalRunItem["providerMetadata"],
    cached: Boolean(row.cached),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: toIso(row.created_at),
    finishedAt: row.finished_at ? toIso(row.finished_at) : null
  };
}

// Eval-run counter columns a gate-check projection needs, aliased so they
// can't collide with gate_checks' own columns (both tables have created_at).
const GATE_CHECK_RUN_COLUMNS =
  `er.status as run_status, er.total_items as run_total_items,
   er.completed_items as run_completed_items, er.failed_items as run_failed_items,
   er.agreed_items as run_agreed_items, er.finished_at as run_finished_at`;

function rowToGateCheck(row: Record<string, unknown>): GateCheck {
  const maxDisagreements = Number(row.max_disagreements);
  const decision = deriveGateCheckDecision({
    runStatus: String(row.run_status) as EvalRunStatus,
    totalItems: Number(row.run_total_items),
    completedItems: Number(row.run_completed_items),
    failedItems: Number(row.run_failed_items),
    agreedItems: Number(row.run_agreed_items),
    maxDisagreements
  });
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    skillVersionId: String(row.skill_version_id),
    evalRunId: String(row.eval_run_id),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    metadata: (parseJson(row.metadata) ?? {}) as Record<string, unknown>,
    maxDisagreements,
    status: decision.status,
    totalCandidates: Number(row.run_total_items),
    judgedCandidates: Number(row.run_completed_items),
    erroredCandidates: Number(row.run_failed_items),
    disagreements: decision.disagreements,
    createdAt: toIso(row.created_at),
    finishedAt: row.run_finished_at ? toIso(row.run_finished_at) : null
  };
}

function rowToGateCheckItem(row: Record<string, unknown>): GateCheckItem {
  const evalStatus = row.eval_status === null || row.eval_status === undefined ? null : String(row.eval_status);
  return {
    id: String(row.id),
    gateCheckId: String(row.gate_check_id),
    goldenEntryId: String(row.golden_entry_id),
    goldenCaseId: String(row.golden_case_id),
    caseKey: String(row.case_key),
    candidateCaseId: String(row.candidate_case_id),
    expectedLabel: String(row.expected_label) as "pass" | "fail",
    status: evalStatus === "completed" ? "completed" : evalStatus === "failed" ? "failed" : "pending",
    judgedLabel: row.result_label === null || row.result_label === undefined ? null : String(row.result_label),
    agreement: row.agreement === null || row.agreement === undefined ? null : Boolean(row.agreement),
    cached: Boolean(row.cached),
    error: row.eval_error === null || row.eval_error === undefined ? null : String(row.eval_error),
    createdAt: toIso(row.created_at)
  };
}

function rowToApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    keyPrefix: String(row.key_prefix),
    createdAt: toIso(row.created_at),
    lastUsedAt: row.last_used_at ? toIso(row.last_used_at) : null,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : null
  };
}

function rowToExceptionCase(row: Record<string, unknown>): ExceptionCase {
  const payload = parseJson(row.normalized_payload) as { metadata?: Record<string, unknown>; input?: unknown };
  const rawResponse = row.raw_response ? parseJson(row.raw_response) as { failureCategory?: unknown } : {};
  const sourceTraceId = String(row.source_trace_id ?? row.case_id);
  const verdict = VerdictLabelSchema.safeParse(row.verdict).data ?? "fail";
  const latestVerdict = VerdictLabelSchema.safeParse(row.latest_verdict).data ?? null;
  const latestJudgeRunId = row.latest_judge_run_id === null || row.latest_judge_run_id === undefined
    ? null
    : String(row.latest_judge_run_id);
  const judgeRunId = String(row.judge_run_id ?? row.id ?? "");
  const latestReason = row.latest_reasoning === null || row.latest_reasoning === undefined
    ? null
    : String(row.latest_reasoning);
  const reason = String(row.reasoning ?? "");
  const rejudgedSince = latestJudgeRunId && latestJudgeRunId !== judgeRunId && latestVerdict && (
    latestVerdict !== verdict || latestReason !== reason
  )
    ? {
        judgeRunId: latestJudgeRunId,
        verdict: latestVerdict,
        reason: latestReason ?? "",
        createdAt: row.latest_created_at ? toIso(row.latest_created_at) : toIso(row.created_at)
      }
    : null;
  const title = typeof payload.metadata?.name === "string" && payload.metadata.name
    ? payload.metadata.name
    : `Trace ${sourceTraceId}`;
  return {
    id: String(row.case_id),
    traceId: sourceTraceId,
    title,
    ...(judgeRunId ? { judgeRunId } : {}),
    ...(row.skill_version_id ? { skillVersionId: String(row.skill_version_id) } : {}),
    ...(row.criterion_version_id ? { criterionVersionId: String(row.criterion_version_id) } : {}),
    // The recorded label verbatim. This mapper also backs getCaseDetail (any
    // judged case, not just exceptions), so coercing an unrecognized label to
    // "fail" would misrepresent the recorded evidence in the UI.
    verdict,
    reason,
    ...(rejudgedSince ? { rejudgedSince } : {}),
    capabilityGap: typeof rawResponse.failureCategory === "string" ? rawResponse.failureCategory : undefined,
    reviewerState: "needs_review",
    createdAt: toIso(row.created_at)
  };
}

function rowToLangSmithIntegration(row: Record<string, unknown>): LangSmithIntegration {
  const config = parseJson(row.config) as { projectName?: string | null; endpointUrl?: string | null; skillVersionId?: string | null };
  const lastTestResult = row.last_test_result == null
    ? null
    : LangSmithConnectionTestResultSchema.parse(parseJson(row.last_test_result));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    provider: "langsmith",
    skillVersionId: config.skillVersionId ?? null,
    projectName: config.projectName ?? null,
    endpointUrl: config.endpointUrl ?? null,
    pollEnabled: row.poll_enabled !== false,
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
    pollLimit: Number(row.poll_limit ?? 25),
    lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
    lastTestResult,
    createdAt: toIso(row.created_at)
  };
}

function rowToLangfuseIntegration(row: Record<string, unknown>): LangfuseIntegration {
  const config = parseJson(row.config) as { projectName?: string | null; endpointUrl?: string | null; skillVersionId?: string | null };
  const lastTestResult = row.last_test_result == null
    ? null
    : LangfuseConnectionTestResultSchema.parse(parseJson(row.last_test_result));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    provider: "langfuse",
    skillVersionId: config.skillVersionId ?? null,
    projectName: config.projectName ?? null,
    endpointUrl: config.endpointUrl ?? null,
    pollEnabled: row.poll_enabled !== false,
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
    pollLimit: Number(row.poll_limit ?? 25),
    lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
    lastTestResult,
    createdAt: toIso(row.created_at)
  };
}

function rowToIronsideIntegration(row: Record<string, unknown>): IronsideIntegration {
  const config = parseJson(row.config) as { url?: string; quietPeriodSeconds?: number; skillVersionId?: string | null };
  const lastTestResult = row.last_test_result == null
    ? null
    : IronsideConnectionTestResultSchema.parse(parseJson(row.last_test_result));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    provider: "ironside",
    skillVersionId: config.skillVersionId ?? null,
    url: String(config.url ?? ""),
    pollEnabled: row.poll_enabled !== false,
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
    pollLimit: Number(row.poll_limit ?? 25),
    quietPeriodSeconds: Number(config.quietPeriodSeconds ?? 300),
    lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
    lastTestResult,
    createdAt: toIso(row.created_at)
  };
}

function toFeedbackSyncProvider(value: unknown): FeedbackSyncProvider {
  return value === "langfuse" ? "langfuse" : value === "ironside" ? "ironside" : "langsmith";
}

function rowToFeedbackSyncJobRecord(row: Record<string, unknown>): FeedbackSyncJobRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    judgeRunId: String(row.judge_run_id),
    provider: toFeedbackSyncProvider(row.provider),
    status: toFeedbackSyncStatus(row.status)
  };
}

function rowToImportJobRecord(row: Record<string, unknown>): ImportJobRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    source: row.source === "langfuse" ? "langfuse" : row.source === "langsmith" ? "langsmith" : row.source === "ironside" ? "ironside" : "manual",
    sourceIntegrationId: row.source_integration_id === null || row.source_integration_id === undefined ? null : String(row.source_integration_id),
    skillVersionId: row.skill_version_id === null || row.skill_version_id === undefined
      ? null
      : String(row.skill_version_id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
    actorEmail: row.actor_email === null || row.actor_email === undefined ? null : String(row.actor_email),
    actorName: row.actor_name === null || row.actor_name === undefined ? null : String(row.actor_name),
    queueJobId: row.queue_job_id === null || row.queue_job_id === undefined ? null : String(row.queue_job_id),
    status: toImportJobStatus(row.status),
    requestedLimit: row.requested_limit === null || row.requested_limit === undefined ? null : Number(row.requested_limit),
    importedCount: Number(row.imported_count ?? 0),
    queuedJudgeCount: Number(row.queued_judge_count ?? 0),
    createdAt: toIso(row.created_at ?? row.started_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    error: row.error === null || row.error === undefined ? null : String(row.error)
  };
}

function toImportJobStatus(value: unknown): ImportJobStatus {
  return value === "running" || value === "completed" || value === "failed" ? value : "queued";
}

function rowToVerdictRecord(row: Record<string, unknown>): VerdictRecord {
  return VerdictRecordSchema.parse({
    id: String(row.id),
    projectId: String(row.project_id),
    caseId: String(row.case_id),
    skillVersionId: row.skill_version_id === null || row.skill_version_id === undefined ? null : String(row.skill_version_id),
    source: String(row.source),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id),
    actorName: row.actor_name === null || row.actor_name === undefined ? null : String(row.actor_name),
    payload: VerdictPayloadSchema.parse(parseJson(row.payload)),
    externalRunId: row.external_run_id === null || row.external_run_id === undefined ? null : String(row.external_run_id),
    createdAt: toIso(row.created_at)
  });
}

function rowToReviewQueue(row: Record<string, unknown>): ReviewQueue {
  const rawStatus = String(row.status);
  const status: ReviewQueueStatus = rawStatus === "closed" ? "closed" : "open";
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    status,
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined ? null : String(row.created_by_user_id),
    createdAt: toIso(row.created_at),
    closedAt: row.closed_at ? toIso(row.closed_at) : null,
    pendingCount: Number(row.pending_count ?? 0),
    completedCount: Number(row.completed_count ?? 0)
  };
}

function rowToReviewQueueItem(row: Record<string, unknown>): ReviewQueueItem {
  const rawStatus = String(row.status);
  const status = rawStatus === "completed" ? "completed" : "pending";
  return {
    id: String(row.id),
    queueId: String(row.queue_id),
    caseId: String(row.case_id),
    criterionVersionId: String(row.criterion_version_id),
    status,
    position: Number(row.position ?? 0),
    assignedToUserId: row.assigned_to_user_id === null || row.assigned_to_user_id === undefined ? null : String(row.assigned_to_user_id),
    createdAt: toIso(row.created_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null
  };
}

function rowToRegressionRun(row: Record<string, unknown>): RegressionRunResult {
  return RegressionRunResultSchema.parse({
    id: row.id,
    skillVersionId: row.skill_version_id,
    datasetRevisionId: row.dataset_revision_id,
    status: row.status,
    compared: row.compared,
    regressed: row.regressed,
    improved: row.improved,
    flipped: row.flipped,
    overrideReason: row.override_reason ?? undefined,
    goldenSetMissing: row.golden_set_missing,
    cases: parseJson(row.cases),
    error: row.error_message ?? null,
    createdAt: toIso(row.created_at)
  });
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toSkillStatus(value: unknown): Skill["status"] {
  const status = String(value);
  return ["draft", "calibrating", "validated", "approved", "production", "regressing", "failed", "needs_review", "deprecated"].includes(status)
    ? status as Skill["status"]
    : "draft";
}

function gateFailureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function toFeedbackSyncStatus(value: unknown): FeedbackSyncStatus {
  const status = String(value);
  return ["pending", "sending", "synced", "failed"].includes(status)
    ? status as FeedbackSyncStatus
    : "pending";
}
