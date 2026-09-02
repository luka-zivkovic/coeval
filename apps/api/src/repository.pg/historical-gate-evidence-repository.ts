import { randomUUID } from "node:crypto";
import type {
  GateCheck,
  GateCheckDetail
} from "@coeval/shared";
import type { Pool } from "pg";
import type { CreateGateCheckInputDb } from "../repository.js";
import type { HistoricalGateEvidenceRepositoryPort } from "../repository/ports.js";
import {
  GATE_CHECK_RUN_COLUMNS,
  rowToGateCheck,
  rowToGateCheckItem
} from "./mappers.js";

// Internal PostgreSQL compatibility ledger for deprecated historical gate
// evidence. It persists and projects artifacts but owns no release decision.
export class PgHistoricalGateEvidenceRepository implements HistoricalGateEvidenceRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async createGateCheck(input: CreateGateCheckInputDb): Promise<GateCheckDetail> {
    const gateCheckId = `gate_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into gate_checks
         (id, project_id, skill_version_id, eval_run_id, label, metadata, max_disagreements, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          gateCheckId,
          input.projectId,
          input.skillVersionId,
          input.evalRunId,
          input.label ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.maxDisagreements,
          input.createdByUserId ?? null
        ]
      );
      for (const item of input.items) {
        await client.query(
          `insert into gate_check_items
           (id, gate_check_id, project_id, golden_entry_id, golden_case_id, candidate_case_id, case_key, expected_label)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            `gati_${randomUUID()}`,
            gateCheckId,
            input.projectId,
            item.goldenEntryId,
            item.goldenCaseId,
            item.candidateCaseId,
            item.caseKey,
            item.expectedLabel
          ]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const detail = await this.getGateCheckDetail(input.projectId, gateCheckId);
    if (!detail) throw new Error(`Gate check vanished after create: ${gateCheckId}`);
    return detail;
  }

  async getGateCheckDetail(projectId: string, gateCheckId: string): Promise<GateCheckDetail | null> {
    const result = await this.pool.query(
      `select gc.*, ${GATE_CHECK_RUN_COLUMNS}
       from gate_checks gc
       join eval_runs er on er.id = gc.eval_run_id
       where gc.id = $1 and gc.project_id = $2`,
      [gateCheckId, projectId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const check = rowToGateCheck(row);
    // The join key is the derived candidate case: eval_run_items is unique on
    // (eval_run_id, case_id), so each gate item matches at most one run item.
    const items = await this.pool.query(
      `select gi.*, eri.status as eval_status, eri.result_label, eri.agreement, eri.cached, eri.error as eval_error
       from gate_check_items gi
       left join eval_run_items eri
         on eri.eval_run_id = $2 and eri.case_id = gi.candidate_case_id
       where gi.gate_check_id = $1
       order by gi.created_at asc, gi.id asc`,
      [gateCheckId, check.evalRunId]
    );
    return { ...check, items: items.rows.map(rowToGateCheckItem) };
  }

  async listGateChecks(projectId: string, opts?: { limit?: number | undefined }): Promise<GateCheck[]> {
    const result = await this.pool.query(
      `select gc.*, ${GATE_CHECK_RUN_COLUMNS}
       from gate_checks gc
       join eval_runs er on er.id = gc.eval_run_id
       where gc.project_id = $1
       order by gc.created_at desc
       limit $2`,
      [projectId, opts?.limit ?? 50]
    );
    return result.rows.map(rowToGateCheck);
  }
}
