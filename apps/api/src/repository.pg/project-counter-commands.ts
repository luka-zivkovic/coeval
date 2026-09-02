import type { PoolClient } from "pg";

export async function refreshProjectCounters(client: PoolClient, projectId: string): Promise<void> {
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
