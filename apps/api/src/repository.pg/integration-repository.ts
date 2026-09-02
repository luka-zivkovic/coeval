import { randomUUID } from "node:crypto";
import {
  IronsideConnectionTestResultSchema,
  IronsideSyncStateSchema,
  LangfuseConnectionTestResultSchema,
  LangSmithConnectionTestResultSchema,
  type IronsideConnectionTestResult,
  type IronsideEvaluatorContext,
  type IronsideImportJob,
  type IronsideImportTarget,
  type IronsideIntegration,
  type IronsideIntegrationInput,
  type IronsideSyncState,
  type LangfuseConnectionTestResult,
  type LangfuseImportJob,
  type LangfuseImportTarget,
  type LangfuseIntegration,
  type LangfuseIntegrationInput,
  type LangSmithConnectionTestResult,
  type LangSmithImportJob,
  type LangSmithImportTarget,
  type LangSmithIntegration,
  type LangSmithIntegrationInput,
  type UpdateIronsideIntegrationInput,
  type UpdateLangfuseIntegrationInput,
  type UpdateLangSmithIntegrationInput
} from "@coeval/shared";
import type { Pool } from "pg";
import type {
  ClaimIronsideImportTargetsInput,
  ClaimLangfuseImportTargetsInput,
  ClaimLangSmithImportTargetsInput,
  IronsideImportContext,
  LangfuseImportContext,
  LangSmithImportContext
} from "../repository.js";
import {
  AmbiguousProjectSkillError,
  DatasetRevisionConflictError,
  IronsideCredentialsMissingError,
  IronsideIntegrationAlreadyExistsError,
  IronsideIntegrationChangedError,
  IronsideIntegrationNotFoundError,
  LangfuseCredentialsMissingError,
  LangfuseIntegrationNotFoundError,
  LangSmithCredentialsMissingError,
  LangSmithIntegrationNotFoundError,
  NoCurrentSkillError
} from "../repository/errors.js";
import type {
  IntegrationRepositoryPort,
  SkillLifecycleRepositoryPort
} from "../repository/ports.js";
import { decryptJson, encryptJson } from "../lib/encryption.js";
import {
  parseJson,
  rowToIronsideIntegration,
  rowToLangfuseIntegration,
  rowToLangSmithIntegration,
  toIso
} from "./mappers.js";

// PostgreSQL provider-integration configuration, polling, credential loading,
// remote identity quarantine, and opaque sync-cursor persistence. The slice
// selects and authorizes exact evaluator versions but owns no release policy.
export class PgIntegrationRepository implements IntegrationRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly resolveImportSkillVersionId: (
      projectId: string,
      requested?: string | undefined,
      requiredContext?: Parameters<SkillLifecycleRepositoryPort["authorizeSkillVersionExecution"]>[0]["context"] | undefined
    ) => Promise<string>,
    private readonly authorizeSkillVersionExecution: SkillLifecycleRepositoryPort["authorizeSkillVersionExecution"]
  ) {}

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

  async createIronsideIntegration(projectId: string, input: IronsideIntegrationInput, remote: IronsideEvaluatorContext): Promise<IronsideIntegration> {
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = input.skillVersionId === undefined
      ? null
      : await this.resolveImportSkillVersionId(projectId, input.skillVersionId, "scheduled_import");
    const result = await this.pool.query(
      `insert into integrations (id, project_id, provider, encrypted_credentials, config, poll_enabled, poll_interval_seconds, poll_limit)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (project_id, provider)
       do nothing
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        `int_${randomUUID()}`,
        projectId,
        "ironside",
        encryptJson({ apiKey: input.apiKey }),
        JSON.stringify({
          url: input.url,
          redaction: input.redaction ?? {},
          remoteProjectId: remote.project.id,
          remoteProjectName: remote.project.name,
          protocolVersion: remote.protocolVersion,
          settlementQuietPeriodSeconds: remote.settlement.quietPeriodSeconds,
          revalidationRequired: false,
          connectionRevision: 1,
          skillVersionId,
          sync: { cursor: null }
        }),
        pollEnabled,
        pollIntervalSeconds,
        pollLimit
      ]
    );
    if (!result.rows[0]) throw new IronsideIntegrationAlreadyExistsError(projectId);
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

  async updateIronsideIntegration(
    projectId: string,
    integrationId: string,
    input: UpdateIronsideIntegrationInput,
    remote?: IronsideEvaluatorContext,
    expected?: { remoteProjectId: string; revalidationRequired: boolean; connectionRevision: number }
  ): Promise<IronsideIntegration> {
    const skillVersionId = input.skillVersionId === undefined
      ? null
      : await this.resolveImportSkillVersionId(projectId, input.skillVersionId, "scheduled_import");
    const result = await this.pool.query(
      `update integrations
       set poll_enabled = coalesce($3::boolean, poll_enabled),
           poll_interval_seconds = coalesce($4::integer, poll_interval_seconds),
           poll_limit = coalesce($5::integer, poll_limit),
           encrypted_credentials = coalesce($7::text, encrypted_credentials),
           config = (
             config || jsonb_strip_nulls(jsonb_build_object(
               'skillVersionId', $6::text,
               'url', $8::text,
               'remoteProjectId', $9::text,
               'remoteProjectName', $10::text,
               'protocolVersion', $11::text,
               'settlementQuietPeriodSeconds', $12::integer
             ))
           ) || case when $9::text is null then '{}'::jsonb else jsonb_build_object(
             'connectionRevision', (config ->> 'connectionRevision')::bigint + 1,
             'revalidationRequired', false,
             'revalidatedAt', clock_timestamp()
           ) end
       where id = $1 and project_id = $2 and provider = 'ironside'
         and (
           $13::text is null
           or (
             config ->> 'remoteProjectId' = $13
             and (config ->> 'revalidationRequired')::boolean = $14::boolean
             and (config ->> 'connectionRevision')::bigint = $15::bigint
           )
         )
       returning id, project_id, provider, config, poll_enabled, poll_interval_seconds, poll_limit, last_tested_at, last_test_result, created_at`,
      [
        integrationId,
        projectId,
        input.pollEnabled ?? null,
        input.pollIntervalSeconds ?? null,
        input.pollLimit ?? null,
        skillVersionId,
        input.apiKey === undefined ? null : encryptJson({ apiKey: input.apiKey }),
        input.url ?? null,
        remote?.project.id ?? null,
        remote?.project.name ?? null,
        remote?.protocolVersion ?? null,
        remote?.settlement.quietPeriodSeconds ?? null,
        expected?.remoteProjectId ?? null,
        expected?.revalidationRequired ?? false,
        expected?.connectionRevision ?? 0
      ]
    );
    const row = result.rows[0];
    if (!row) {
      const exists = await this.pool.query(
        `select 1 from integrations
          where id = $1 and project_id = $2 and provider = 'ironside'`,
        [integrationId, projectId]
      );
      if (exists.rowCount) throw new IronsideIntegrationChangedError(integrationId);
      throw new IronsideIntegrationNotFoundError(integrationId);
    }
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

  async quarantineIronsideIntegration(
    projectId: string,
    integrationId: string,
    expected: { remoteProjectId: string; connectionRevision: number },
    result: IronsideConnectionTestResult
  ): Promise<boolean> {
    const updated = await this.pool.query(
      `update integrations
       set poll_enabled = false,
           last_tested_at = $3::timestamptz,
           last_test_result = $4::jsonb,
           config = config || jsonb_build_object(
             'connectionRevision', (config ->> 'connectionRevision')::bigint + 1,
             'revalidationRequired', true,
             'quarantinedAt', $3::timestamptz,
             'quarantineReason', coalesce($4::jsonb ->> 'error', 'remote project mismatch')
           )
       where id = $1 and project_id = $2 and provider = 'ironside'
         and config ->> 'remoteProjectId' = $5
         and (config ->> 'connectionRevision')::bigint = $6::bigint`,
      [
        integrationId,
        projectId,
        result.checkedAt,
        JSON.stringify(result),
        expected.remoteProjectId,
        expected.connectionRevision
      ]
    );
    if (updated.rowCount) return true;
    const exists = await this.pool.query(
      `select 1 from integrations
        where id = $1 and project_id = $2 and provider = 'ironside'`,
      [integrationId, projectId]
    );
    if (!exists.rowCount) throw new IronsideIntegrationNotFoundError(integrationId);
    return false;
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
           and (i.config ->> 'revalidationRequired')::boolean = false
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
         and (i.config ->> 'revalidationRequired')::boolean = false
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
      remoteProjectId?: string;
      remoteProjectName?: string;
      protocolVersion?: string;
      settlementQuietPeriodSeconds?: number;
      connectionRevision?: number;
      revalidationRequired?: boolean;
      sync?: unknown;
    };
    if (
      !credentials.apiKey || !config.url || !config.remoteProjectId ||
      !config.remoteProjectName || config.protocolVersion !== "ironside/evaluator/v1" ||
      typeof config.settlementQuietPeriodSeconds !== "number" ||
      !Number.isFinite(config.settlementQuietPeriodSeconds) ||
      typeof config.connectionRevision !== "number" ||
      !Number.isSafeInteger(config.connectionRevision) ||
      typeof config.revalidationRequired !== "boolean"
    ) throw new IronsideCredentialsMissingError(job.integrationId);
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
    const syncState = IronsideSyncStateSchema.parse(config.sync);
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      provider: "ironside",
      skillVersionId: job.skillVersionId ?? config.skillVersionId ?? null,
      url: config.url,
      remoteProjectId: config.remoteProjectId,
      remoteProjectName: config.remoteProjectName,
      protocolVersion: "ironside/evaluator/v1",
      settlementQuietPeriodSeconds: config.settlementQuietPeriodSeconds,
      pollEnabled: row.poll_enabled !== false,
      pollIntervalSeconds: Number(row.poll_interval_seconds ?? 300),
      pollLimit: Number(row.poll_limit ?? 25),
      lastTestedAt: row.last_tested_at ? toIso(row.last_tested_at) : null,
      lastTestResult: row.last_test_result == null
        ? null
        : IronsideConnectionTestResultSchema.parse(parseJson(row.last_test_result)),
      createdAt: toIso(row.created_at),
      apiKey: credentials.apiKey,
      limit: job.limit,
      redactionConfig: config.redaction ?? {},
      syncState,
      revalidationRequired: config.revalidationRequired,
      connectionRevision: config.connectionRevision
    };
  }

  async saveIronsideSyncState(
    projectId: string,
    integrationId: string,
    state: IronsideSyncState,
    expectedCursor?: string | null
  ): Promise<boolean> {
    const compareCursor = expectedCursor !== undefined;
    const result = await this.pool.query(
      `update integrations
       set config = jsonb_set(config, '{sync}', $3::jsonb, true)
       where id = $1 and project_id = $2 and provider = 'ironside'
         and (
           not $4::boolean
           or config #>> '{sync,cursor}' is not distinct from $5::text
         )`,
      [integrationId, projectId, JSON.stringify(state), compareCursor, expectedCursor ?? null]
    );
    if (!result.rowCount && !compareCursor) throw new IronsideIntegrationNotFoundError(integrationId);
    return Boolean(result.rowCount);
  }
}
