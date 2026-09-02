import { randomUUID } from "node:crypto";
import {
  StoredModelBindingSchema,
  type EvaluatorExecutionContext,
  type FeedbackSyncJob,
  type JudgeRun,
  type JudgeRunJob
} from "@coeval/shared";
import type { Pool } from "pg";
import { decryptJson } from "../lib/encryption.js";
import { redactNormalizedTracePayload, type NormalizedTraceStep } from "../lib/redaction.js";
import type {
  FeedbackSyncContext,
  FeedbackSyncJobListItem,
  FeedbackSyncJobRecord,
  FeedbackSyncProvider,
  JudgeRunContext,
  ListFeedbackSyncJobsInput,
  RecordJudgeRunInput
} from "../repository.js";
import {
  FeedbackSyncCredentialsMissingError,
  FeedbackSyncJobNotFoundError
} from "../repository/errors.js";
import type {
  JudgeFeedbackRepositoryPort,
  SkillLifecycleRepositoryPort
} from "../repository/ports.js";
import {
  parseJson,
  rowToFeedbackSyncJobRecord,
  rowToJudgeRun,
  rowToSkillVersion,
  toFeedbackSyncProvider,
  toFeedbackSyncStatus,
  toIso
} from "./mappers.js";

// PostgreSQL judge-run persistence and upstream feedback synchronization.
// Provider execution is authorized against an exact evaluator version; sync
// status measures evidence delivery and does not make release decisions.
export class PgJudgeFeedbackRepository implements JudgeFeedbackRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly getCurrentSkillVersionId: (projectId: string) => Promise<string>,
    private readonly authorizeSkillVersionExecution: SkillLifecycleRepositoryPort["authorizeSkillVersionExecution"]
  ) {}

  async loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext> {
    const caseResult = await this.pool.query(
      `select id, project_id, normalized_payload,ingestion_purpose,case_type
       from cases
       where id = $1 and project_id = $2`,
      [job.caseId, job.projectId]
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) throw new Error(`Case not found for judge job: ${job.caseId}`);

    const resolvedSkillVersionId = job.skillVersionId ?? await this.getCurrentSkillVersionId(job.projectId);
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
              criterion.stable_key as criterion_stable_key,
              jr.verdict,
              jr.score,
              jr.reasoning,
              jr.created_at as judge_run_created_at,
              rt.source_trace_id,
              rt.source_trace_version,
              i.id as integration_id,
              i.config as integration_config,
              i.encrypted_credentials,
              i.created_at as integration_created_at
       from feedback_sync_jobs fsj
       join judge_runs jr on jr.id = fsj.judge_run_id
       join skill_versions sv on sv.id = jr.skill_version_id
       join criterion_versions criterion_version on criterion_version.id = sv.criterion_version_id
       join criteria criterion on criterion.id = criterion_version.criterion_id
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
      remoteProjectId?: string;
      remoteProjectName?: string;
      protocolVersion?: string;
      settlementQuietPeriodSeconds?: number;
      connectionRevision?: number;
      revalidationRequired?: boolean;
      skillVersionId?: string | null;
    };
    const credentials = decryptJson<{ apiKey?: string; publicKey?: string; secretKey?: string }>(String(row.encrypted_credentials));
    if (provider === "langsmith" && !credentials.apiKey) throw new FeedbackSyncCredentialsMissingError(job.feedbackSyncJobId);
    if (provider === "langfuse" && (!credentials.publicKey || !credentials.secretKey)) throw new FeedbackSyncCredentialsMissingError(job.feedbackSyncJobId);
    if (provider === "ironside" && (
      !credentials.apiKey || !config.url || !config.remoteProjectId ||
      !config.remoteProjectName || config.protocolVersion !== "ironside/evaluator/v1" ||
      typeof config.settlementQuietPeriodSeconds !== "number" ||
      !Number.isFinite(config.settlementQuietPeriodSeconds) ||
      typeof config.connectionRevision !== "number" ||
      !Number.isSafeInteger(config.connectionRevision) ||
      typeof config.revalidationRequired !== "boolean"
    )) throw new FeedbackSyncCredentialsMissingError(job.feedbackSyncJobId);
    return {
      id: String(row.feedback_sync_job_id),
      projectId: String(row.project_id),
      provider,
      sourceTraceId: String(row.source_trace_id),
      sourceTraceVersion: row.source_trace_version == null ? null : String(row.source_trace_version),
      criterionStableKey: String(row.criterion_stable_key),
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
            remoteProjectId: config.remoteProjectId!,
            remoteProjectName: config.remoteProjectName!,
            protocolVersion: "ironside/evaluator/v1",
            settlementQuietPeriodSeconds: config.settlementQuietPeriodSeconds!,
            revalidationRequired: config.revalidationRequired!,
            connectionRevision: config.connectionRevision!,
            pollEnabled: true,
            pollIntervalSeconds: 300,
            pollLimit: 25,
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

  async markFeedbackSyncBlocked(job: FeedbackSyncJob, error: unknown): Promise<void> {
    await this.pool.query(
      `update feedback_sync_jobs
          set status = 'blocked', last_error = $3
        where id = $1 and project_id = $2`,
      [job.feedbackSyncJobId, job.projectId, error instanceof Error ? error.message : String(error)]
    );
    await this.refreshSyncBackCoverage(job.projectId);
  }

  async markFeedbackSyncPending(job: FeedbackSyncJob): Promise<void> {
    await this.pool.query(
      `update feedback_sync_jobs
          set status = 'pending', last_error = null
        where id = $1 and project_id = $2 and status = 'blocked'`,
      [job.feedbackSyncJobId, job.projectId]
    );
  }

  async listBlockedIronsideFeedbackSyncJobs(
    projectId: string,
    integrationId: string
  ): Promise<FeedbackSyncJob[]> {
    const result = await this.pool.query(
      `select fsj.id
         from feedback_sync_jobs fsj
         join judge_runs jr on jr.id = fsj.judge_run_id and jr.project_id = fsj.project_id
         join cases c on c.id = jr.case_id and c.project_id = fsj.project_id
         join raw_traces rt on rt.id = c.raw_trace_id and rt.project_id = fsj.project_id
        where fsj.project_id = $1
          and fsj.provider = 'ironside'
          and fsj.status = 'blocked'
          and rt.source_integration_id = $2
        order by fsj.created_at asc, fsj.id asc`,
      [projectId, integrationId]
    );
    return result.rows.map((row) => ({
      projectId,
      feedbackSyncJobId: String(row.id)
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
}
