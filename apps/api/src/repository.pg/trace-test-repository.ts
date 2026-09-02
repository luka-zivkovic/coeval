import { randomUUID } from "node:crypto";
import type {
  TraceTestDetail,
  TraceTestSummary,
  TraceTestValidation
} from "@coeval/shared";
import type { Pool } from "pg";
import { redactNormalizedTracePayload, type NormalizedTracePayload } from "../lib/redaction.js";
import {
  traceTestValidationDiagnostic,
  traceTestValidationStatus,
  type CreateTraceTestInputDb,
  type EnableTraceTestInputDb,
  type RecordTraceTestFunnelEventInputDb,
  type RecordTraceTestValidationInputDb,
  type ReviseTraceTestInputDb
} from "../repository.js";
import {
  TraceTestNotFoundError,
  TraceTestRevisionConflictError,
  TraceTestSourceNotFoundError,
  TraceTestValidationNotReadyError
} from "../repository/errors.js";
import type { TraceTestRepositoryPort } from "../repository/ports.js";
import {
  parseJson,
  rowToTraceTestRevision,
  rowToTraceTestSummary,
  rowToTraceTestValidation
} from "./mappers.js";

// PostgreSQL trace-derived test identity, append-only revision, validation,
// enablement, and journey-funnel persistence. This evidence lifecycle owns no
// release decision or policy threshold.
export class PgTraceTestRepository implements TraceTestRepositoryPort {
  constructor(private readonly pool: Pool) {}

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
}
