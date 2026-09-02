import { randomUUID } from "node:crypto";
import type {
  CaseSource,
  ImportJobRecord,
  ManualTraceImportInput
} from "@coeval/shared";
import type { Pool } from "pg";
import type {
  CompleteImportJobInput,
  CreateImportJobInput,
  ListImportJobsInput,
  TraceImportContext,
  TraceImportResult
} from "../repository.js";
import type {
  SkillLifecycleRepositoryPort,
  TraceImportRepositoryPort
} from "../repository/ports.js";
import { importTraceOnClient } from "./trace-import-commands.js";
import { rowToImportJobRecord } from "./mappers.js";

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
