import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  PRODUCTION_CALIBRATION_CONTRACT,
  PRODUCTION_DECISION_RECORD_CONTRACT,
  ProductionCalibrationArtifactSchema,
  ProductionDecisionLedgerRecordSchema,
  type ProductionDecisionLedgerRecord
} from "@rubrist/shared";
import { canonicalJson } from "../lib/assessment-receipt.js";
import { governedContentV1Digest } from "../lib/governed-content-digest.js";
import {
  PRODUCTION_RECORD_APPEND_MAX_RECORDS,
  PRODUCTION_RECORD_MAX_BYTES,
  PRODUCTION_SNAPSHOT_MAX_BYTES,
  ProductionRecordRepositoryError,
  type AppendProductionRecordsInput,
  type AppendProductionRecordsResult,
  type LoadedProductionRecords,
  type LoadProductionRecordsInput,
  type ProductionRecordActor,
  type ProductionRecordDeletionCounts,
  type ProductionRetentionRun,
  type ProductionCalibrationSnapshot,
  type ProductionCalibrationSnapshotSummary,
  type ProductionDecisionRecordRepository,
  type SaveProductionSnapshotInput
} from "./repository.js";

/** Digest kind for the set of records a report was built from. */
export const PRODUCTION_RECORD_SET_DIGEST_KIND = "rubrist/production-record-set/v1";

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
      // Appends share the project's record lock; erasure and purges take it
      // exclusively, so neither can interleave with an append in flight.
      await client.query(
        `select pg_advisory_xact_lock_shared(hashtextextended($1, 0))`,
        [recordLockKey(input.projectId)]
      );
      await rejectFutureDated(client, rows);
      await rejectErasedDecisions(client, input.projectId, rows);
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

  async loadRecords(input: LoadProductionRecordsInput): Promise<LoadedProductionRecords> {
    const from = input.window.from?.toISOString() ?? null;
    const to = input.window.to?.toISOString() ?? null;
    // One statement reads one consistent snapshot of the table. Loading one
    // row past the ceiling tells an over-full window apart from an exact fit.
    const result = await this.pool.query<{ content: unknown; content_digest: string }>(
      `with window_decisions as (
         select decision_id from production_decision_records
         where project_id = $1 and kind = 'decision'
           and ($2::timestamptz is null or record_at >= $2::timestamptz)
           and ($3::timestamptz is null or record_at < $3::timestamptz)
       ), selected as (
         select record.content, record.content_digest, record.record_at, record.received_at
         from production_decision_records record
         where record.project_id = $1 and record.decision_id in (select decision_id from window_decisions)
         union all
         select orphan.content, orphan.content_digest, orphan.record_at, orphan.received_at
         from production_decision_records orphan
         where orphan.project_id = $1 and orphan.kind <> 'decision'
           and ($2::timestamptz is null or orphan.record_at >= $2::timestamptz)
           and ($3::timestamptz is null or orphan.record_at < $3::timestamptz)
           and not exists (
             select 1 from production_decision_records decision
             where decision.project_id = $1 and decision.kind = 'decision' and decision.decision_id = orphan.decision_id
           )
       )
       select content, content_digest from selected
       order by record_at, received_at, content_digest
       limit $4`,
      [input.projectId, from, to, input.maxRecords + 1]
    );
    if (result.rows.length > input.maxRecords) {
      throw new ProductionRecordRepositoryError(
        "record_ceiling_exceeded",
        `The window holds more than ${input.maxRecords} records; choose a narrower window`,
        { maximum: input.maxRecords, from, to }
      );
    }
    return {
      records: result.rows.map((row) => ProductionDecisionLedgerRecordSchema.parse(row.content)),
      recordSetDigest: governedContentV1Digest(
        PRODUCTION_RECORD_SET_DIGEST_KIND,
        result.rows.map((row) => row.content_digest).sort()
      )
    };
  }

  async saveSnapshot(input: SaveProductionSnapshotInput): Promise<ProductionCalibrationSnapshotSummary> {
    const bytes = Buffer.from(canonicalJson(input.artifact), "utf8");
    if (bytes.byteLength > PRODUCTION_SNAPSHOT_MAX_BYTES) throw snapshotTooLarge(bytes.byteLength);
    const result = await this.pool.query(
      `insert into production_calibration_snapshots
         (id, project_id, report_contract, canonical_bytes, artifact_digest, window_from, window_to,
          parameters, record_count, record_set_digest, built_at, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
       returning ${SNAPSHOT_SUMMARY_COLUMNS}`,
      [
        `pcs_${randomUUID()}`, input.projectId, input.artifact.contract, bytes, bytesDigest(bytes),
        input.artifact.window.from, input.artifact.window.to, JSON.stringify(input.parameters),
        input.recordCount, input.recordSetDigest, input.artifact.generatedAt, input.userId
      ]
    ).catch((error: unknown) => {
      throw mapPgError(error);
    });
    return snapshotSummary(result.rows[0] as Record<string, unknown>);
  }

  async listSnapshots(projectId: string): Promise<ProductionCalibrationSnapshotSummary[]> {
    const result = await this.pool.query(
      `select ${SNAPSHOT_SUMMARY_COLUMNS} from production_calibration_snapshots
       where project_id = $1 order by created_at desc, id desc`,
      [projectId]
    );
    return result.rows.map((row) => snapshotSummary(row as Record<string, unknown>));
  }

  async getSnapshot(projectId: string, snapshotId: string): Promise<ProductionCalibrationSnapshot | null> {
    const result = await this.pool.query(
      `select ${SNAPSHOT_SUMMARY_COLUMNS}, canonical_bytes from production_calibration_snapshots
       where project_id = $1 and id = $2`,
      [projectId, snapshotId]
    );
    const row = result.rows[0] as (Record<string, unknown> & { canonical_bytes: Buffer }) | undefined;
    if (!row) return null;
    const snapshot = snapshotSummary(row);
    // Never trust a stored projection: the bytes must still hash to their digest.
    if (bytesDigest(row.canonical_bytes) !== snapshot.artifactDigest) {
      throw new Error(`Production calibration snapshot ${snapshotId} no longer matches its digest`);
    }
    return {
      snapshot,
      artifact: ProductionCalibrationArtifactSchema.parse(JSON.parse(row.canonical_bytes.toString("utf8")))
    };
  }

  async getRetentionDays(projectId: string): Promise<number> {
    const result = await this.pool.query<{ days: number }>(
      `select production_record_retention_days as days from projects where id = $1`,
      [projectId]
    );
    const days = result.rows[0]?.days;
    if (days === undefined) throw new ProductionRecordRepositoryError("project_not_found", "The project no longer exists");
    return Number(days);
  }

  async setRetentionDays(input: ProductionRecordActor & { retentionDays: number }): Promise<number> {
    return this.transaction(async (client) => {
      const result = await client.query<{ days: number }>(
        `update projects set production_record_retention_days = $2, updated_at = now()
         where id = $1 returning production_record_retention_days as days`,
        [input.projectId, input.retentionDays]
      );
      if (!result.rows[0]) throw new ProductionRecordRepositoryError("project_not_found", "The project no longer exists");
      await insertAudit(client, input.projectId, input.userId, "production.retention.update", "project", input.projectId, {
        retentionDays: input.retentionDays
      });
      return Number(result.rows[0].days);
    });
  }

  async applyRetention(now: Date): Promise<ProductionRetentionRun> {
    return this.transaction(async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        `select pg_try_advisory_xact_lock(hashtextextended('rubrist/production-retention/v1', 0)) as locked`
      );
      if (!lock.rows[0]?.locked) return { skipped: true, projects: [] };
      await client.query("set local rubrist.production_deletion = 'on'");
      // Retention runs on Rubrist's receive time, never the caller's `at`. A
      // decision received before the cutoff goes with all of its actions and
      // outcomes; an orphan goes by its own receive time.
      const deleted = await client.query<{
        project_id: string; cutoff: Date; decisions: number; actions: number; outcomes: number;
      }>(
        `with cutoffs as (
           select id as project_id,
                  $1::timestamptz - make_interval(days => production_record_retention_days) as cutoff
           from projects
         ), expired as (
           select record.project_id, record.decision_id
           from production_decision_records record
           join cutoffs on cutoffs.project_id = record.project_id
           where record.kind = 'decision' and record.received_at < cutoffs.cutoff
         ), deleted as (
           delete from production_decision_records record
           using cutoffs
           where record.project_id = cutoffs.project_id and (
             exists (
               select 1 from expired
               where expired.project_id = record.project_id and expired.decision_id = record.decision_id
             )
             or (
               record.kind <> 'decision' and record.received_at < cutoffs.cutoff
               and not exists (
                 select 1 from production_decision_records decision
                 where decision.project_id = record.project_id and decision.kind = 'decision'
                   and decision.decision_id = record.decision_id
               )
             )
           )
           returning record.project_id, record.kind
         )
         select deleted.project_id, cutoffs.cutoff,
                count(*) filter (where deleted.kind = 'decision')::integer as decisions,
                count(*) filter (where deleted.kind = 'action')::integer as actions,
                count(*) filter (where deleted.kind = 'outcome')::integer as outcomes
         from deleted join cutoffs on cutoffs.project_id = deleted.project_id
         group by deleted.project_id, cutoffs.cutoff
         order by deleted.project_id`,
        [now.toISOString()]
      );
      const projects = deleted.rows.map((row) => ({
        projectId: row.project_id,
        cutoff: row.cutoff.toISOString(),
        deleted: { decisions: row.decisions, actions: row.actions, outcomes: row.outcomes }
      }));
      for (const project of projects) {
        await insertAudit(client, project.projectId, null, "production.retention.apply", "project", project.projectId, {
          cutoff: project.cutoff,
          deleted: project.deleted
        });
      }
      return { skipped: false, projects };
    });
  }

  async eraseDecision(input: ProductionRecordActor & { decisionId: string }): Promise<ProductionRecordDeletionCounts> {
    const decisionIdDigest = textDigest(input.decisionId);
    return this.transaction(async (client) => {
      // Wait for appends in flight, and hold new ones until the tombstone commits.
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [recordLockKey(input.projectId)]);
      await client.query("set local rubrist.production_deletion = 'on'");
      const deleted = await client.query<{ kind: string; content_digest: string }>(
        `delete from production_decision_records where project_id = $1 and decision_id = $2
         returning kind, content_digest`,
        [input.projectId, input.decisionId]
      );
      await client.query(
        `insert into production_decision_tombstones (project_id, decision_id_digest, erased_by_user_id)
         values ($1, $2, $3) on conflict do nothing`,
        [input.projectId, decisionIdDigest, input.userId]
      );
      const counts = deletionCounts(deleted.rows);
      // The audit entry keeps digests only; the decision ID itself may be personal data.
      await insertAudit(client, input.projectId, input.userId, "production.decision.erase", "production_decision", decisionIdDigest, {
        decisionIdDigest,
        erasedRecordDigests: deleted.rows.map((row) => row.content_digest).sort(),
        deleted: counts
      });
      return counts;
    });
  }

  async purgeApiKeyRecords(input: ProductionRecordActor & { apiKeyId: string }): Promise<ProductionRecordDeletionCounts> {
    return this.transaction(async (client) => {
      // A request authenticated just before the revoke may still be writing.
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [recordLockKey(input.projectId)]);
      const key = await client.query<{ revoked_at: Date | null }>(
        `select revoked_at from api_keys where id = $1 and project_id = $2 for share`,
        [input.apiKeyId, input.projectId]
      );
      const row = key.rows[0];
      if (!row) throw new ProductionRecordRepositoryError("api_key_not_found", "No such API key in this project");
      if (!row.revoked_at) {
        throw new ProductionRecordRepositoryError(
          "api_key_not_revoked",
          "Revoke the API key before purging what it sent"
        );
      }
      await client.query("set local rubrist.production_deletion = 'on'");
      const deleted = await client.query<{ kind: string }>(
        `delete from production_decision_records where project_id = $1 and submitted_by_api_key_id = $2 returning kind`,
        [input.projectId, input.apiKeyId]
      );
      const counts = deletionCounts(deleted.rows);
      await insertAudit(client, input.projectId, input.userId, "production.api_key.purge", "api_key", input.apiKeyId, {
        deleted: counts
      });
      return counts;
    });
  }

  async deleteSnapshot(input: ProductionRecordActor & { snapshotId: string }): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query("set local rubrist.production_deletion = 'on'");
      const deleted = await client.query<{ artifact_digest: string }>(
        `delete from production_calibration_snapshots where project_id = $1 and id = $2 returning artifact_digest`,
        [input.projectId, input.snapshotId]
      );
      const row = deleted.rows[0];
      if (!row) return false;
      await insertAudit(client, input.projectId, input.userId, "production.snapshot.delete", "production_snapshot", input.snapshotId, {
        artifactDigest: row.artifact_digest
      });
      return true;
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

/** An erased decision stays erased: reject any record for its ID, naming the first one. */
async function rejectErasedDecisions(client: PoolClient, projectId: string, rows: readonly PreparedRecord[]): Promise<void> {
  const result = await client.query<{ line: number; decision_id: string }>(
    `select batch.line, batch.decision_id
     from jsonb_to_recordset($2::jsonb) as batch(line integer, decision_id text)
     join production_decision_tombstones tombstone
       on tombstone.project_id = $1
      and tombstone.decision_id_digest = 'sha256:' || encode(sha256(convert_to(batch.decision_id, 'UTF8')), 'hex')
     order by batch.line
     limit 1`,
    [projectId, JSON.stringify(rows.map((row) => ({ line: row.line, decision_id: row.decision_id })))]
  );
  const erased = result.rows[0];
  if (erased) {
    throw new ProductionRecordRepositoryError(
      "erased_decision",
      `Record ${erased.line} belongs to decision ${erased.decision_id}, which was erased`,
      { line: erased.line, decisionId: erased.decision_id }
    );
  }
}

/** Advisory lock key for one project's production records. */
function recordLockKey(projectId: string): string {
  return `rubrist/production-records/v1:${projectId}`;
}

function textDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function deletionCounts(rows: ReadonlyArray<{ kind: string }>): ProductionRecordDeletionCounts {
  const counts = { decisions: 0, actions: 0, outcomes: 0 };
  for (const row of rows) {
    if (row.kind === "decision") counts.decisions += 1;
    else if (row.kind === "action") counts.actions += 1;
    else counts.outcomes += 1;
  }
  return counts;
}

async function insertAudit(
  client: PoolClient,
  projectId: string,
  actorUserId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await client.query(
    `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [`audit_${randomUUID()}`, projectId, actorUserId, action, targetType, targetId, JSON.stringify(metadata)]
  );
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

const SNAPSHOT_SUMMARY_COLUMNS = `id, project_id, report_contract, artifact_digest, window_from, window_to,
  parameters, record_count, record_set_digest, built_at, created_by_user_id, created_at`;

function bytesDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function snapshotSummary(row: Record<string, unknown>): ProductionCalibrationSnapshotSummary {
  if (row.report_contract !== PRODUCTION_CALIBRATION_CONTRACT) {
    throw new Error(`Unsupported production calibration snapshot contract ${String(row.report_contract)}`);
  }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    reportContract: String(row.report_contract),
    artifactDigest: String(row.artifact_digest),
    window: {
      from: row.window_from === null ? null : iso(row.window_from),
      to: row.window_to === null ? null : iso(row.window_to)
    },
    parameters: row.parameters as Record<string, unknown>,
    recordCount: Number(row.record_count),
    recordSetDigest: String(row.record_set_digest),
    builtAt: iso(row.built_at),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at)
  };
}

function snapshotTooLarge(bytes: number | null): ProductionRecordRepositoryError {
  return new ProductionRecordRepositoryError(
    "snapshot_too_large",
    `The report is larger than a snapshot may be (${PRODUCTION_SNAPSHOT_MAX_BYTES} bytes); choose a narrower window`,
    { bytes, maximum: PRODUCTION_SNAPSHOT_MAX_BYTES }
  );
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
  if (code === "23514" && constraint === "production_decision_records_erased_check") {
    return new ProductionRecordRepositoryError("erased_decision", "A record belongs to an erased decision");
  }
  if (code === "23514" && constraint === "production_calibration_snapshots_canonical_bytes_check") {
    return snapshotTooLarge(null);
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
