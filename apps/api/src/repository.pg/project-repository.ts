import { randomUUID } from "node:crypto";
import type {
  DashboardSummary,
  ExceptionCase,
  GoldenSetEntry,
  OnboardingEvidenceInventory,
  Project,
  ProjectSettings,
  RetentionPruneResult,
  Skill,
  UpdateProjectSettingsInput
} from "@coeval/shared";
import type { Pool } from "pg";
import { capabilityGapsFromExceptions } from "../lib/capability-gaps.js";
import type { ProjectRepositoryPort } from "../repository/ports.js";
import {
  rowToProject,
  rowToProjectSettings
} from "./mappers.js";
import { refreshProjectCounters } from "./project-counter-commands.js";

export interface PgProjectRepositoryDependencies {
  getCurrentSkill(projectId: string): Promise<Skill>;
  getCurrentSkillForCriterion(projectId: string, criterionId: string): Promise<Skill>;
  listGoldenSet(projectId: string, criterionVersionId?: string | undefined): Promise<GoldenSetEntry[]>;
  listExceptionCases(projectId: string, criterionVersionId?: string | undefined): Promise<ExceptionCase[]>;
}
// Internal PostgreSQL project lifecycle and project-scoped read-model slice.
// The facade constructs it once with the exact application pool and lazy
// cross-port callbacks so later slices keep resolving through the facade.
export class PgProjectRepository implements ProjectRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly dependencies: PgProjectRepositoryDependencies
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
      await refreshProjectCounters(client, projectId);
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
      ? await this.dependencies.getCurrentSkillForCriterion(projectId, criterionId)
      : await this.dependencies.getCurrentSkill(projectId);
    const criterionVersionId = skill.currentVersion.criterionVersionId;
    const goldenSet = await this.dependencies.listGoldenSet(projectId, criterionVersionId);
    const exceptions = await this.dependencies.listExceptionCases(projectId, criterionVersionId);
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

  async getOnboardingEvidenceInventory(projectId: string): Promise<OnboardingEvidenceInventory> {
    // Keep this aggregate semantically aligned with listCases: only customer
    // Runs count, never gate or release-evidence scaffolding. A field counts
    // when its post-redaction stored value is present and useful to a Check.
    const result = await this.pool.query(
      `select count(*)::int as run_count,
              count(*) filter (
                where c.normalized_payload ? 'input'
                  and c.normalized_payload->'input' <> 'null'::jsonb
              )::int as input_count,
              count(*) filter (
                where c.normalized_payload ? 'output'
                  and c.normalized_payload->'output' <> 'null'::jsonb
              )::int as output_count,
              count(*) filter (
                where jsonb_typeof(c.normalized_payload->'steps') = 'array'
                  and jsonb_array_length(c.normalized_payload->'steps') > 0
              )::int as steps_count,
              count(*) filter (
                where jsonb_typeof(c.normalized_payload->'metadata') = 'object'
                  and c.normalized_payload->'metadata' <> '{}'::jsonb
              )::int as metadata_count
       from cases c
       where c.project_id = $1
         and c.case_type not in ('gate_candidate', 'release_evidence')`,
      [projectId]
    );
    const row = result.rows[0] ?? {};
    return {
      runCount: Number(row.run_count ?? 0),
      inputCount: Number(row.input_count ?? 0),
      outputCount: Number(row.output_count ?? 0),
      stepsCount: Number(row.steps_count ?? 0),
      metadataCount: Number(row.metadata_count ?? 0)
    };
  }
}
