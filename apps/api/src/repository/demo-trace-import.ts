import { randomUUID } from "node:crypto";
import {
  type CaseSource,
  type ImportJobRecord,
  type ManualTraceImportInput,
  isInternalTraceMetadata
} from "@coeval/shared";
import { datasetInputIdentity } from "../lib/dataset-revision.js";
import { normalizeTracePayload, redactNormalizedTracePayload } from "../lib/redaction.js";
import type {
  CompleteImportJobInput,
  CreateImportJobInput,
  ListImportJobsInput,
  TraceImportContext,
  TraceImportResult
} from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import { RecursiveTraceSkippedError } from "./errors.js";
import { assertTraceIngestionPurpose } from "./helpers.js";
import type { TraceImportRepositoryPort } from "./ports.js";

interface DemoTraceImportRepositoryDependencies {
  resolveImportSkillVersionId(
    projectId: string,
    requested?: string | undefined
  ): Promise<string>;
}

// Internal DemoRepository slice. It owns no state: the facade constructs it
// once with the exact shared store and one narrow evaluator-version callback.
// Dataset-example rollback remains a facade consistency boundary and calls the
// stable public importTrace method rather than reaching through this slice.
export class DemoTraceImportRepository implements TraceImportRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoTraceImportRepositoryDependencies
  ) {}

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

  async createImportJob(input: CreateImportJobInput): Promise<ImportJobRecord> {
    const now = new Date().toISOString();
    const skillVersionId = await this.dependencies.resolveImportSkillVersionId(input.projectId, input.skillVersionId);
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

  private getImportJob(projectId: string, importJobId: string): ImportJobRecord {
    const job = this.store.importJobs.find((candidate) => candidate.id === importJobId && candidate.projectId === projectId);
    if (!job) throw new Error(`Import job not found: ${importJobId}`);
    return job;
  }
}
