import { randomUUID } from "node:crypto";
import type { EvalRun, EvalRunDetail, EvalRunItem } from "@coeval/shared";
import type { Pool } from "pg";
import { computeEvalRunSpend } from "../repository.js";
import type {
  CompleteEvalRunItemInputDb,
  CreateConvergenceEvalRunInputDb,
  CreateEvalRunInputDb,
  CreateImportedCaseEvalRunInputDb,
  EvalRunDispatchClaim,
  EvalRunDispatchInputDb,
  EvalRunItemExecutionClaim,
  EvalRunItemExecutionInputDb,
  EvalRunItemReleaseDisposition,
  EvalRunItemReleaseOptions,
  FailEvalRunItemInputDb,
  StaleEvalRunItemExecution
} from "../repository.js";
import { DatasetRevisionConflictError } from "../repository/errors.js";
import type { EvalRunRepositoryPort } from "../repository/ports.js";
import {
  bumpEvalRunCounters,
  mintAssessmentReceiptWithClient
} from "./assessment-receipt-commands.js";
import { rowToEvalRun, rowToEvalRunItem, toIso } from "./mappers.js";

// PostgreSQL evaluation-run creation, durable dispatch, item execution, and
// terminalization. Queue retries and receipt minting retain their existing
// transaction boundaries; run evidence does not make release decisions.
export class PgEvalRunRepository implements EvalRunRepositoryPort {
  constructor(private readonly pool: Pool) {}

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
        await mintAssessmentReceiptWithClient(client, input.projectId, runId, "terminal_mint");
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
      const runFinished = await bumpEvalRunCounters(client, input.projectId, input.evalRunId, {
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
          await mintAssessmentReceiptWithClient(client, input.projectId, input.evalRunId, "terminal_mint");
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
      const runFinished = await bumpEvalRunCounters(client, input.projectId, input.evalRunId, {
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
          await mintAssessmentReceiptWithClient(client, input.projectId, input.evalRunId, "terminal_mint");
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
}
