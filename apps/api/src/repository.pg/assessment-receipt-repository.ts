import { randomUUID } from "node:crypto";
import type { AssessmentReceipt } from "@coeval/shared";
import type { Pool } from "pg";
import {
  canonicalReceiptBytes,
  parseCanonicalReceiptBytes,
  receiptArtifactDigest
} from "../lib/assessment-receipt.js";
import type {
  AssessmentReceiptArtifact,
  AssessmentReceiptComparison,
  CompareAssessmentReceiptCopyInput,
  CreateAssessmentReceiptCorrectionInput
} from "../repository/contracts.js";
import {
  AssessmentReceiptIntegrityError,
  AssessmentReceiptUnavailableError
} from "../repository/errors.js";
import type { AssessmentReceiptRepositoryPort } from "../repository/ports.js";
import { mintAssessmentReceiptWithClient } from "./assessment-receipt-commands.js";
import {
  rowToAssessmentReceiptArtifact,
  rowToAssessmentReceiptComparison
} from "./mappers.js";

// Internal PostgreSQL owner for immutable assessment-receipt artifacts,
// exact-byte consumer comparisons, and append-only correction lineage.
export class PgAssessmentReceiptRepository implements AssessmentReceiptRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async getOrFreezeAssessmentReceipt(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const artifact = await mintAssessmentReceiptWithClient(
        client,
        projectId,
        evalRunId,
        "historical_freeze"
      );
      await client.query("commit");
      return artifact;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAssessmentReceiptArtifactByReceiptId(
    projectId: string,
    receiptId: string
  ): Promise<AssessmentReceiptArtifact | null> {
    const result = await this.pool.query(
      `select * from assessment_receipt_artifacts where project_id = $1 and receipt_id = $2`,
      [projectId, receiptId]
    );
    return result.rows[0] ? rowToAssessmentReceiptArtifact(result.rows[0]) : null;
  }

  async listAssessmentReceiptArtifacts(projectId: string, evalRunId: string): Promise<AssessmentReceiptArtifact[]> {
    const result = await this.pool.query(
      `select * from assessment_receipt_artifacts
       where project_id = $1 and eval_run_id = $2
       order by artifact_revision asc`,
      [projectId, evalRunId]
    );
    return result.rows.map(rowToAssessmentReceiptArtifact);
  }

  async compareAssessmentReceiptCopy(input: CompareAssessmentReceiptCopyInput): Promise<AssessmentReceiptComparison> {
    let consumerReceipt: AssessmentReceipt;
    try {
      consumerReceipt = parseCanonicalReceiptBytes(input.consumerCanonicalBytes);
    } catch (error) {
      throw new AssessmentReceiptIntegrityError(error instanceof Error ? error.message : String(error));
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const root = await mintAssessmentReceiptWithClient(
        client,
        input.projectId,
        input.evalRunId,
        "historical_freeze"
      );
      if (!root) throw new AssessmentReceiptUnavailableError("missing_source", "Eval run not found");
      const rootReceipt = parseCanonicalReceiptBytes(root.canonicalBytes);
      if (
        consumerReceipt.projectId !== input.projectId ||
        consumerReceipt.evalRunId !== input.evalRunId ||
        consumerReceipt.receiptId !== rootReceipt.receiptId
      ) {
        throw new AssessmentReceiptIntegrityError("Consumer receipt identity does not match the persisted root assessment");
      }
      const consumerArtifactDigest = receiptArtifactDigest(input.consumerCanonicalBytes);
      const comparisonStatus = input.consumerCanonicalBytes.equals(root.canonicalBytes) ? "match" : "diverged";
      await client.query(
        `insert into assessment_receipt_comparisons
         (id, project_id, eval_run_id, artifact_id, consumer_receipt_id,
          consumer_canonical_bytes, consumer_artifact_digest, comparison_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (artifact_id, consumer_artifact_digest) do nothing`,
        [
          `rcomp_${randomUUID()}`,
          input.projectId,
          input.evalRunId,
          root.id,
          consumerReceipt.receiptId,
          input.consumerCanonicalBytes,
          consumerArtifactDigest,
          comparisonStatus
        ]
      );
      const stored = await client.query(
        `select * from assessment_receipt_comparisons
         where artifact_id = $1 and consumer_artifact_digest = $2`,
        [root.id, consumerArtifactDigest]
      );
      if (!stored.rows[0]) throw new Error("Assessment receipt comparison vanished after insert");
      const comparison = rowToAssessmentReceiptComparison(stored.rows[0]);
      if (
        comparison.artifactId !== root.id ||
        !comparison.consumerCanonicalBytes.equals(input.consumerCanonicalBytes) ||
        comparison.comparisonStatus !== comparisonStatus
      ) {
        throw new AssessmentReceiptIntegrityError(
          "Persisted consumer receipt comparison does not match its artifact and exact bytes"
        );
      }
      await client.query("commit");
      return comparison;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAssessmentReceiptCorrection(
    input: CreateAssessmentReceiptCorrectionInput
  ): Promise<AssessmentReceiptArtifact> {
    const reason = input.reason.trim();
    if (!reason) throw new AssessmentReceiptIntegrityError("Assessment receipt correction reason is required");
    let receipt: AssessmentReceipt;
    let canonicalBytes: Buffer;
    try {
      canonicalBytes = canonicalReceiptBytes(input.receipt);
      receipt = parseCanonicalReceiptBytes(canonicalBytes);
    } catch (error) {
      throw new AssessmentReceiptIntegrityError(error instanceof Error ? error.message : String(error));
    }
    if (receipt.projectId !== input.projectId || receipt.evalRunId !== input.evalRunId) {
      throw new AssessmentReceiptIntegrityError("Correction receipt identity does not match its assessment");
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const root = await mintAssessmentReceiptWithClient(
        client,
        input.projectId,
        input.evalRunId,
        "historical_freeze"
      );
      if (!root) throw new AssessmentReceiptUnavailableError("missing_source", "Eval run not found");
      const existing = await client.query(
        `select * from assessment_receipt_artifacts where project_id = $1 and receipt_id = $2`,
        [input.projectId, receipt.receiptId]
      );
      if (existing.rows[0]) {
        const artifact = rowToAssessmentReceiptArtifact(existing.rows[0]);
        if (
          artifact.sourceKind === "correction" &&
          artifact.evalRunId === input.evalRunId &&
          artifact.canonicalBytes.equals(canonicalBytes)
        ) {
          await client.query("commit");
          return artifact;
        }
        throw new AssessmentReceiptIntegrityError("Correction receiptId is already in use");
      }
      const rootReceipt = parseCanonicalReceiptBytes(root.canonicalBytes);
      if (
        receipt.schemaVersion !== rootReceipt.schemaVersion ||
        receipt.skillId !== rootReceipt.skillId ||
        receipt.skillVersionId !== rootReceipt.skillVersionId
      ) {
        throw new AssessmentReceiptIntegrityError("Correction cannot change the receipt contract or evaluator identity");
      }
      const latest = await client.query(
        `select * from assessment_receipt_artifacts
         where project_id = $1 and eval_run_id = $2 and contract_version = 1
         order by artifact_revision desc limit 1`,
        [input.projectId, input.evalRunId]
      );
      const predecessor = rowToAssessmentReceiptArtifact(latest.rows[0]);
      const artifactRevision = predecessor.artifactRevision + 1;
      const artifactDigest = receiptArtifactDigest(canonicalBytes);
      const artifactId = `rart_${input.evalRunId}_v1_r${artifactRevision}`;
      const inserted = await client.query(
        `insert into assessment_receipt_artifacts
         (id, project_id, eval_run_id, receipt_id, contract_version, artifact_revision,
          canonical_bytes, artifact_digest, evidence_digest, source_snapshot_digest,
          source_kind, predecessor_artifact_id, correction_reason, created_by_user_id)
         values ($1,$2,$3,$4,1,$5,$6,$7,$8,$7,'correction',$9,$10,$11)
         returning *`,
        [
          artifactId,
          input.projectId,
          input.evalRunId,
          receipt.receiptId,
          artifactRevision,
          canonicalBytes,
          artifactDigest,
          receipt.evidenceDigest,
          predecessor.id,
          reason,
          input.createdByUserId ?? null
        ]
      );
      await client.query("commit");
      return rowToAssessmentReceiptArtifact(inserted.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
