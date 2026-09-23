import { randomUUID } from "node:crypto";
import type {
  CaseSource,
  ImportJobRecord,
  ManualTraceImportInput
} from "@rubrist/shared";
import type { Pool } from "pg";
import type {
  CaseSourceIdentity,
  CompleteImportJobInput,
  CreateImportJobInput,
  FindImportedIronsideTracesInput,
  ImportedIronsideTraceMatch,
  ListImportJobsInput,
  TraceImportContext,
  TraceImportResult
} from "../repository.js";
import type {
  SkillLifecycleRepositoryPort,
  TraceImportRepositoryPort
} from "../repository/ports.js";
import { importTraceOnClient } from "./trace-import-commands.js";
import { rowToImportJobRecord, toIso } from "./mappers.js";

// PostgreSQL trace ingestion and import-job lifecycle persistence. Trace
// creation retains one caller-owned transaction; job records bind an exact
// authorized evaluator version without owning release policy.
export class PgTraceImportRepository implements TraceImportRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly resolveImportSkillVersionId: (
      projectId: string,
      requested?: string | undefined
    ) => Promise<string>,
    private readonly authorizeSkillVersionExecution: SkillLifecycleRepositoryPort["authorizeSkillVersionExecution"]
  ) {}

  async importTrace(projectId: string, source: CaseSource, input: ManualTraceImportInput, context: TraceImportContext): Promise<TraceImportResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await importTraceOnClient(client, projectId, source, input, context);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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

  // Resolves the native Ironside source identity (remote project, trace id)
  // inside the given projects. One row per (project, trace version): the
  // earliest case, matching importTraceOnClient's dedupe choice.
  async findImportedIronsideTraces(input: FindImportedIronsideTracesInput): Promise<ImportedIronsideTraceMatch[]> {
    if (input.projectIds.length === 0) return [];
    const result = await this.pool.query(
      `select distinct on (rt.project_id, rt.source_trace_version)
              rt.project_id, c.id as case_id, rt.source_trace_version, c.created_at
         from raw_traces rt
         join cases c on c.raw_trace_id = rt.id and c.project_id = rt.project_id
        where rt.project_id = any($1::text[])
          and rt.source_remote_project_id = $2
          and rt.source_trace_id = $3
          and c.case_type = 'ironside'
        order by rt.project_id, rt.source_trace_version, c.created_at asc, c.id asc
        limit 500`,
      [[...input.projectIds], input.remoteProjectId, input.traceId]
    );
    return result.rows.map((row) => ({
      projectId: String(row.project_id),
      caseId: String(row.case_id),
      traceVersion: row.source_trace_version == null ? null : String(row.source_trace_version),
      importedAt: toIso(row.created_at)
    }));
  }

  async getCaseSourceIdentity(projectId: string, caseId: string): Promise<CaseSourceIdentity | null> {
    const result = await this.pool.query(
      `select c.case_type, rt.source_trace_id, rt.source_trace_version,
              rt.source_remote_project_id, rt.source_integration_id
         from cases c
         join raw_traces rt on rt.id = c.raw_trace_id and rt.project_id = c.project_id
        where c.project_id = $1 and c.id = $2`,
      [projectId, caseId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      source: String(row.case_type) as CaseSource,
      sourceTraceId: String(row.source_trace_id),
      sourceTraceVersion: row.source_trace_version == null ? null : String(row.source_trace_version),
      sourceRemoteProjectId: row.source_remote_project_id == null ? null : String(row.source_remote_project_id),
      sourceIntegrationId: row.source_integration_id == null ? null : String(row.source_integration_id)
    };
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
}
