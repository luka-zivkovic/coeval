import { randomUUID } from "node:crypto";
import type { Trace } from "@coeval/audit/runtime";
import { demoProject, demoSkill } from "@coeval/db";
import type { FeedbackSyncJob, JudgeRun, JudgeRunJob } from "@coeval/shared";
import type {
  FeedbackSyncContext,
  FeedbackSyncJobListItem,
  FeedbackSyncJobRecord,
  FeedbackSyncProvider,
  JudgeRunContext,
  ListFeedbackSyncJobsInput,
  RecordJudgeRunInput
} from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import { FeedbackSyncJobNotFoundError } from "./errors.js";
import type { JudgeFeedbackRepositoryPort } from "./ports.js";

interface DemoJudgeFeedbackRepositoryDependencies {
  loadFeedbackSyncContext(job: FeedbackSyncJob): Promise<FeedbackSyncContext>;
  syntheticTraceForBuiltinCase(caseId: string): Trace | null;
}

// Internal DemoRepository judge-result and feedback-writeback slice. Judge
// runs, source identities, provider credentials, and sync state remain on the
// exact shared store; only worker-only contexts expose raw integration data.
export class DemoJudgeFeedbackRepository implements JudgeFeedbackRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoJudgeFeedbackRepositoryDependencies
  ) {}

  async loadJudgeRunContext(job: JudgeRunJob): Promise<JudgeRunContext> {
    // Imported traces first; built-in fixture cases (exceptions, golden set)
    // get the same synthesized traces the case-detail and regression surfaces
    // use, so demo eval runs can judge them instead of failing the item.
    const trace = this.store.traces.get(job.caseId) ?? this.dependencies.syntheticTraceForBuiltinCase(job.caseId);
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
    const context = await this.dependencies.loadFeedbackSyncContext(job);
    this.store.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "synced" });
  }

  async markFeedbackSyncFailed(job: FeedbackSyncJob, error: unknown): Promise<void> {
    const context = await this.dependencies.loadFeedbackSyncContext(job);
    this.store.feedbackJobs.set(job.feedbackSyncJobId, { ...context, status: "failed" });
    // PG parity (C7): failures increment attempts and record the error.
    this.store.feedbackJobAttempts.set(job.feedbackSyncJobId, (this.store.feedbackJobAttempts.get(job.feedbackSyncJobId) ?? 0) + 1);
    this.store.feedbackJobLastError.set(job.feedbackSyncJobId, error instanceof Error ? error.message : String(error));
  }

  async markFeedbackSyncBlocked(job: FeedbackSyncJob, error: unknown): Promise<void> {
    const context = await this.dependencies.loadFeedbackSyncContext(job);
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
}
