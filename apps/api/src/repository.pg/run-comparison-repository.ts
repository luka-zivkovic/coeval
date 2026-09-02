import { randomUUID } from "node:crypto";
import type { RunComparison } from "@coeval/shared";
import type { Pool } from "pg";
import type { CreateRunComparisonInputDb } from "../repository.js";
import type { RunComparisonRepositoryPort } from "../repository/ports.js";
import { rowToRunComparison } from "./mappers.js";

// Internal PostgreSQL incident-bisect slice. Comparisons persist the exact
// dataset, revision, evaluator-version, and eval-run identities supplied by
// the facade while their per-case diff remains a read-time projection.
export class PgRunComparisonRepository implements RunComparisonRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async createRunComparison(input: CreateRunComparisonInputDb): Promise<RunComparison> {
    const result = await this.pool.query(
      `insert into run_comparisons
       (id, project_id, dataset_id, dataset_revision_id, version_a_id, version_b_id, run_a_id, run_b_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [
        `rcmp_${randomUUID()}`,
        input.projectId,
        input.datasetId,
        input.datasetRevisionId ?? null,
        input.versionAId,
        input.versionBId,
        input.runAId,
        input.runBId
      ]
    );
    return rowToRunComparison(result.rows[0]);
  }

  async getRunComparison(projectId: string, runComparisonId: string): Promise<RunComparison | null> {
    const result = await this.pool.query(
      `select * from run_comparisons where id = $1 and project_id = $2`,
      [runComparisonId, projectId]
    );
    const row = result.rows[0];
    return row ? rowToRunComparison(row) : null;
  }

  async listRunComparisons(projectId: string, opts?: { limit?: number | undefined }): Promise<RunComparison[]> {
    const result = await this.pool.query(
      `select * from run_comparisons where project_id = $1 order by created_at desc, id desc limit $2`,
      [projectId, opts?.limit ?? 50]
    );
    return result.rows.map(rowToRunComparison);
  }
}
