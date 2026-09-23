import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  PRODUCTION_DECISION_RECORD_CONTRACT,
  type ProductionDecisionLedgerRecord
} from "@rubrist/shared";
import { governedContentV1Digest } from "../lib/governed-content-digest.js";
import {
  PRODUCTION_RECORD_APPEND_MAX_RECORDS,
  PRODUCTION_RECORD_MAX_BYTES,
  ProductionRecordRepositoryError,
  type AppendProductionRecordsInput,
  type AppendProductionRecordsResult,
  type ProductionDecisionRecordRepository
} from "./repository.js";

// The content digest is governed_content_v1_digest over the record, the same
// function the insert guard recomputes in SQL, so a stored digest always
// describes the stored content. Its canonical JSON sorts object keys and keeps
// array order, which is the join's existing notion of an identical record.
//
// Rows are inserted in one global order (decisions by ID, then actions and
// outcomes by digest) so concurrent batches that share records wait on each
// other in the same order and cannot deadlock.

interface PreparedRecord {
  id: string;
  /** One-based position in the submitted batch. */
  line: number;
  kind: ProductionDecisionLedgerRecord["kind"];
  decision_id: string;
  record_at: string;
  content: ProductionDecisionLedgerRecord;
  content_digest: string;
}

export class PgProductionDecisionRecordRepository implements ProductionDecisionRecordRepository {
  constructor(private readonly pool: Pool) {}

  async appendRecords(input: AppendProductionRecordsInput): Promise<AppendProductionRecordsResult> {
    if (input.records.length === 0) {
      throw new ProductionRecordRepositoryError("empty_batch", "The batch contains no records");
    }
    if (input.records.length > PRODUCTION_RECORD_APPEND_MAX_RECORDS) {
      throw new ProductionRecordRepositoryError(
        "batch_too_large",
        `A batch may contain at most ${PRODUCTION_RECORD_APPEND_MAX_RECORDS} records`,
        { records: input.records.length, maximum: PRODUCTION_RECORD_APPEND_MAX_RECORDS }
      );
    }
    const rows = prepareRecords(input.records);
    const apiKeyId = input.submitter.kind === "api_key" ? input.submitter.apiKeyId : null;
    const userId = input.submitter.kind === "user" ? input.submitter.userId : null;
    return this.transaction(async (client) => {
      await rejectFutureDated(client, rows);
      const inserted = await client.query<{ kind: string }>(
        `insert into production_decision_records
           (id, project_id, kind, decision_id, record_at, content, content_digest,
            submitted_by_api_key_id, submitted_by_user_id)
         select row_value.id, $1, row_value.kind, row_value.decision_id, row_value.record_at,
                row_value.content, row_value.content_digest, $2, $3
         from jsonb_to_recordset($4::jsonb) as row_value(
           id text, kind text, decision_id text, record_at timestamptz, content jsonb, content_digest text,
           position integer
         )
         order by row_value.position
         on conflict do nothing
         returning kind`,
        [input.projectId, apiKeyId, userId, JSON.stringify(rows.map((row, position) => ({ ...row, position })))]
      );
      await rejectConflictingDecisions(client, input.projectId, rows);
      const awaiting = await client.query<{ awaiting: number }>(
        `select count(*)::integer as awaiting
         from jsonb_to_recordset($2::jsonb) as batch(decision_id text)
         where not exists (
           select 1 from production_decision_records stored
           where stored.project_id = $1 and stored.kind = 'decision' and stored.decision_id = batch.decision_id
         )`,
        [
          input.projectId,
          JSON.stringify(rows.filter((row) => row.kind !== "decision").map((row) => ({ decision_id: row.decision_id })))
        ]
      );
      const counts = { decisions: 0, actions: 0, outcomes: 0 };
      for (const row of inserted.rows) {
        if (row.kind === "decision") counts.decisions += 1;
        else if (row.kind === "action") counts.actions += 1;
        else counts.outcomes += 1;
      }
      return {
        inserted: counts,
        duplicates: input.records.length - inserted.rows.length,
        awaitingDecision: awaiting.rows[0]?.awaiting ?? 0
      };
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const value = await work(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw mapPgError(error);
    } finally {
      client.release();
    }
  }
}

/**
 * Digest every record, drop exact repeats within the batch, reject a batch that
 * gives one decision ID two different contents, and return the rows in the
 * global insert order.
 */
function prepareRecords(records: readonly ProductionDecisionLedgerRecord[]): PreparedRecord[] {
  const byDigest = new Map<string, PreparedRecord>();
  const decisionDigests = new Map<string, { digest: string; line: number }>();
  records.forEach((record, index) => {
    const line = index + 1;
    // PostgreSQL stores the JSON text, so digest exactly what a JSON round trip keeps.
    const json = JSON.stringify(record);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > PRODUCTION_RECORD_MAX_BYTES) {
      throw new ProductionRecordRepositoryError(
        "record_too_large",
        `Record ${line} is ${bytes} bytes; a record may be at most ${PRODUCTION_RECORD_MAX_BYTES} bytes`,
        { line, bytes, maximum: PRODUCTION_RECORD_MAX_BYTES }
      );
    }
    const content = JSON.parse(json) as ProductionDecisionLedgerRecord;
    let contentDigest: string;
    try {
      contentDigest = governedContentV1Digest(PRODUCTION_DECISION_RECORD_CONTRACT, content);
    } catch (error) {
      throw new ProductionRecordRepositoryError(
        "invalid_record",
        `Record ${line} cannot be stored: ${error instanceof Error ? error.message : String(error)}`,
        { line }
      );
    }
    const decisionId = content.kind === "decision" ? content.id : content.decisionId;
    if (content.kind === "decision") {
      const seen = decisionDigests.get(decisionId);
      if (seen && seen.digest !== contentDigest) {
        throw new ProductionRecordRepositoryError(
          "conflicting_decision",
          `Records ${seen.line} and ${line} give decision ${decisionId} different contents`,
          { decisionId, line }
        );
      }
      decisionDigests.set(decisionId, { digest: contentDigest, line });
    }
    if (byDigest.has(contentDigest)) return;
    byDigest.set(contentDigest, {
      id: `pdr_${randomUUID()}`,
      line,
      kind: content.kind,
      decision_id: decisionId,
      record_at: content.at,
      content,
      content_digest: contentDigest
    });
  });
  const order = (row: PreparedRecord) => row.kind === "decision" ? row.decision_id : row.content_digest;
  return [...byDigest.values()].sort((left, right) =>
    Number(right.kind === "decision") - Number(left.kind === "decision") ||
    (order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0));
}

/** Name the first record dated more than five minutes after the database's receive time. */
async function rejectFutureDated(client: PoolClient, rows: readonly PreparedRecord[]): Promise<void> {
  const result = await client.query<{ line: number }>(
    `select batch.line
     from jsonb_to_recordset($1::jsonb) as batch(line integer, record_at timestamptz)
     where batch.record_at > now() + interval '5 minutes'
     order by batch.line
     limit 1`,
    [JSON.stringify(rows.map((row) => ({ line: row.line, record_at: row.record_at })))]
  );
  const line = result.rows[0]?.line;
  if (line !== undefined) {
    throw new ProductionRecordRepositoryError(
      "future_dated_record",
      `Record ${line} is dated more than five minutes after it was received`,
      { line }
    );
  }
}

/** A stored decision whose content differs from this batch's decision under the same ID rejects the batch. */
async function rejectConflictingDecisions(
  client: PoolClient,
  projectId: string,
  rows: readonly PreparedRecord[]
): Promise<void> {
  const decisions = rows.filter((row) => row.kind === "decision");
  if (decisions.length === 0) return;
  const result = await client.query<{ decision_id: string; line: number }>(
    `select batch.decision_id, batch.line
     from jsonb_to_recordset($2::jsonb) as batch(decision_id text, content_digest text, line integer)
     join production_decision_records stored
       on stored.project_id = $1 and stored.kind = 'decision' and stored.decision_id = batch.decision_id
     where stored.content_digest <> batch.content_digest
     order by batch.line
     limit 1`,
    [
      projectId,
      JSON.stringify(decisions.map((row) => ({
        decision_id: row.decision_id,
        content_digest: row.content_digest,
        line: row.line
      })))
    ]
  );
  const conflict = result.rows[0];
  if (conflict) {
    throw new ProductionRecordRepositoryError(
      "conflicting_decision",
      `Record ${conflict.line} gives decision ${conflict.decision_id} a different content than the stored one`,
      { decisionId: conflict.decision_id, line: conflict.line }
    );
  }
}

function mapPgError(error: unknown): Error {
  if (error instanceof ProductionRecordRepositoryError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code) : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint) : "";
  if (code === "23505" && constraint === "production_decision_records_decision_unique") {
    return new ProductionRecordRepositoryError(
      "conflicting_decision",
      "A decision with this ID and a different content was stored concurrently"
    );
  }
  if (code === "23514" && constraint === "production_decision_records_content_check") {
    return new ProductionRecordRepositoryError("record_too_large", "A record exceeds the stored content limit");
  }
  if (code === "23503" && constraint === "production_decision_records_project_id_fkey") {
    return new ProductionRecordRepositoryError("project_not_found", "The project no longer exists");
  }
  if (code === "40P01" || code === "40001") {
    return new ProductionRecordRepositoryError(
      "write_contention",
      "The batch collided with a concurrent write; retrying it is safe because identical records are no-ops"
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
