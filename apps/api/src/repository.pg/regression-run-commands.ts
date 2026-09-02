import type { RegressionRunResult } from "@coeval/shared";
import type { PoolClient } from "pg";
import type { CreateSkillVersionContext } from "../repository/contracts.js";

export async function insertRegressionRun(
  client: PoolClient,
  regressionRun: RegressionRunResult,
  context: CreateSkillVersionContext
): Promise<void> {
  await client.query(
    `insert into regression_runs
       (id, project_id, skill_version_id, dataset_revision_id, status, compared, regressed, improved, flipped,
        override_reason, override_actor_user_id, golden_set_missing, cases, error_message, created_at,
        criterion_version_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               (select criterion_version_id from skill_versions where id=$3 and project_id=$2))`,
    [
      regressionRun.id,
      context.projectId,
      regressionRun.skillVersionId,
      regressionRun.datasetRevisionId,
      regressionRun.status,
      regressionRun.compared,
      regressionRun.regressed,
      regressionRun.improved,
      regressionRun.flipped,
      regressionRun.overrideReason ?? null,
      context.actorUserId ?? null,
      regressionRun.goldenSetMissing,
      JSON.stringify(regressionRun.cases),
      regressionRun.error ?? null,
      regressionRun.createdAt
    ]
  );
}
