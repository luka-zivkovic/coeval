import type { EvalRunDetail } from "@coeval/shared";
import type { PoolClient } from "pg";
import {
  buildAssessmentReceipt,
  canonicalReceiptBytes,
  receiptArtifactDigest,
  receiptSourceSnapshotDigest
} from "../lib/assessment-receipt.js";
import type {
  AssessmentReceiptArtifact,
  AssessmentReceiptArtifactSource
} from "../repository/contracts.js";
import { AssessmentReceiptUnavailableError } from "../repository/errors.js";
import { computeEvalRunSpend } from "../repository/helpers.js";
import {
  rowToAssessmentReceiptArtifact,
  rowToEvalRun,
  rowToEvalRunItem,
  rowToSkillVersion
} from "./mappers.js";

export async function mintAssessmentReceiptWithClient(
  client: PoolClient,
  projectId: string,
  evalRunId: string,
  sourceKind: Exclude<AssessmentReceiptArtifactSource, "correction">
): Promise<AssessmentReceiptArtifact | null> {
  const runResult = await client.query(
    `select * from eval_runs where id = $1 and project_id = $2 for update`,
    [evalRunId, projectId]
  );
  const runRow = runResult.rows[0];
  if (!runRow) return null;
  const run = rowToEvalRun(runRow);
  const existingResult = await client.query(
    `select * from assessment_receipt_artifacts
       where eval_run_id = $1 and contract_version = 1 and artifact_revision = 1`,
    [evalRunId]
  );
  if (existingResult.rows[0]) return rowToAssessmentReceiptArtifact(existingResult.rows[0]);
  if (run.trigger !== "release_evidence") {
    throw new AssessmentReceiptUnavailableError(
      "not_release_evidence",
      "Assessment receipts are available only for release_evidence runs"
    );
  }
  if (run.status === "pending" || run.status === "running") {
    throw new AssessmentReceiptUnavailableError(
      "not_terminal",
      "Assessment receipt is not available until the eval run is terminal"
    );
  }
  const [itemsResult, versionResult] = await Promise.all([
    client.query(
      `select * from eval_run_items where eval_run_id = $1 order by created_at asc, id asc`,
      [evalRunId]
    ),
    client.query(
      `select * from skill_versions where id = $1 and project_id = $2`,
      [run.skillVersionId, projectId]
    )
  ]);
  const versionRow = versionResult.rows[0];
  if (!versionRow) {
    throw new AssessmentReceiptUnavailableError("missing_source", "Eval run skill version not found");
  }
  const items = itemsResult.rows.map(rowToEvalRunItem);
  const detail: EvalRunDetail = { ...run, items, spend: computeEvalRunSpend(items) };
  const skillVersion = rowToSkillVersion(versionRow);
  const receipt = buildAssessmentReceipt({ run: detail, skillVersion });
  const canonicalBytes = canonicalReceiptBytes(receipt);
  const artifactDigest = receiptArtifactDigest(canonicalBytes);
  const artifactId = `rart_${evalRunId}_v1_r1`;
  await client.query(
    `insert into assessment_receipt_artifacts
       (id, project_id, eval_run_id, receipt_id, contract_version, artifact_revision,
        canonical_bytes, artifact_digest, evidence_digest, source_snapshot_digest,
        source_kind, predecessor_artifact_id, correction_reason, created_by_user_id)
       values ($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,null,null,null)
       on conflict (eval_run_id, contract_version, artifact_revision) do nothing`,
    [
      artifactId,
      projectId,
      evalRunId,
      receipt.receiptId,
      canonicalBytes,
      artifactDigest,
      receipt.evidenceDigest,
      receiptSourceSnapshotDigest({ run: detail, skillVersion }),
      sourceKind
    ]
  );
  const stored = await client.query(
    `select * from assessment_receipt_artifacts
       where eval_run_id = $1 and contract_version = 1 and artifact_revision = 1`,
    [evalRunId]
  );
  if (!stored.rows[0]) throw new Error(`Assessment receipt artifact vanished after mint: ${evalRunId}`);
  return rowToAssessmentReceiptArtifact(stored.rows[0]);
}

// A run with some judged items finishes "completed" even with per-item
// failures; failed_items and the first surfaced error preserve that signal.
// A run where nothing was judged finishes "failed".
export async function bumpEvalRunCounters(
  client: PoolClient,
  projectId: string,
  evalRunId: string,
  bump: { completed: number; failed: number; agreed: number; error: string | null }
): Promise<boolean> {
  const result = await client.query(
    `update eval_runs
       set completed_items = completed_items + $3,
           failed_items = failed_items + $4,
           agreed_items = agreed_items + $5,
           error = coalesce(error, $6),
           status = case when completed_items + failed_items + $3 + $4 >= total_items
                         then case when completed_items + $3 = 0 and failed_items + $4 > 0 then 'failed' else 'completed' end
                         else status end,
           finished_at = case when completed_items + failed_items + $3 + $4 >= total_items then now() else finished_at end
       where id = $1 and project_id = $2 and status in ('pending', 'running')
       returning status`,
    [evalRunId, projectId, bump.completed, bump.failed, bump.agreed, bump.error]
  );
  const status = String(result.rows[0]?.status);
  return status === "completed" || status === "failed";
}
