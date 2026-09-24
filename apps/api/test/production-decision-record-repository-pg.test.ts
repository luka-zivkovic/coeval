import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import type {
  ProductionActionRecord,
  ProductionDecisionLedgerRecord,
  ProductionDecisionRecord,
  ProductionOutcomeRecord
} from "@rubrist/shared";
import {
  PRODUCTION_RECORD_APPEND_MAX_RECORDS,
  PRODUCTION_RECORD_MAX_BYTES,
  ProductionRecordRepositoryError,
  type ProductionRecordSubmitter
} from "../src/production-calibration/repository.js";
import { PgProductionDecisionRecordRepository } from "../src/production-calibration/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; production record persistence tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

const PROJECT_ID = "proj_production_records";
const OTHER_PROJECT_ID = "proj_production_records_other";
const KEY: ProductionRecordSubmitter = { kind: "api_key", apiKeyId: "key_ingest" };
const OWNER: ProductionRecordSubmitter = { kind: "user", userId: "user_owner" };
const CONTRACT = "rubrist/production-decision-record/v1";
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function decision(id: string, probability = 0.8, at = "2026-09-20T10:00:00.000Z"): ProductionDecisionRecord {
  return {
    kind: "decision",
    id,
    at,
    questionSet: { name: "triage", version: 1, digest: digest("a") },
    model: "jev-1.13.0",
    provider: "typesafe",
    stateDigest: digest("b"),
    stateLength: 42,
    answers: { is_flaky: { type: "boolean", probability } },
    latencyMs: 12.5,
    usage: { input_tokens: 700, output_tokens: 260 }
  };
}

function action(decisionId: string): ProductionActionRecord {
  return { kind: "action", decisionId, at: "2026-09-20T10:00:01.000Z", question: "is_flaky", threshold: 0.5, action: "auto_retry" };
}

function outcome(decisionId: string, value = true, at = "2026-09-20T11:00:00.000Z"): ProductionOutcomeRecord {
  return { kind: "outcome", decisionId, at, question: "is_flaky", value, source: "human" };
}

async function rejection(promise: Promise<unknown>): Promise<ProductionRecordRepositoryError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  if (!(error instanceof ProductionRecordRepositoryError)) throw new Error(`expected a repository error, got ${String(error)}`);
  return error;
}

run("PgProductionDecisionRecordRepository", () => {
  let pool: Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repository: PgProductionDecisionRecordRepository;

  const append = (records: ProductionDecisionLedgerRecord[], submitter: ProductionRecordSubmitter = KEY, projectId = PROJECT_ID) =>
    repository.appendRecords({ projectId, submitter, records });
  const count = async (projectId = PROJECT_ID) =>
    Number((await pool.query<{ n: string }>(
      `select count(*) as n from production_decision_records where project_id=$1`, [projectId]
    )).rows[0]?.n);

  beforeAll(async () => {
    ({ pool, cleanup } = await openPostgresTestDatabase("production_records"));
    await runMigrations(pool);
    repository = new PgProductionDecisionRecordRepository(pool);
    await pool.query(`insert into organizations (id,name) values ('org_production_records','Production Org')`);
    for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
      await pool.query(
        `insert into projects (id,organization_id,name,trace_provider) values ($1,'org_production_records',$1,'manual')`,
        [projectId]
      );
    }
    await pool.query(
      `insert into api_keys (id, project_id, name, key_hash, key_prefix, capability)
       values ('key_ingest', $1, 'ingest', 'hash_ingest', 'rubrist_sk_ing…', 'production_ingest'),
              ('key_revoked', $1, 'revoked', 'hash_revoked', 'rubrist_sk_rev…', 'production_ingest')`,
      [PROJECT_ID]
    );
    await pool.query(`update api_keys set revoked_at = now() where id = 'key_revoked'`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("appends decisions, actions, and outcomes with a digest the database recomputes and the observed submitter", async () => {
    await expect(append([decision("d1"), action("d1"), outcome("d1")])).resolves.toEqual({
      inserted: { decisions: 1, actions: 1, outcomes: 1 },
      duplicates: 0,
      awaitingDecision: 0
    });
    const rows = await pool.query<{
      kind: string; decision_id: string; content: unknown; content_digest: string; sql_digest: string;
      submitted_by_api_key_id: string | null; submitted_by_user_id: string | null; record_at: Date;
    }>(
      `select kind, decision_id, content, content_digest, record_at,
              governed_content_v1_digest($2, content) as sql_digest,
              submitted_by_api_key_id, submitted_by_user_id
       from production_decision_records where project_id=$1 and decision_id='d1' order by kind`,
      [PROJECT_ID, CONTRACT]
    );
    expect(rows.rows.map((row) => row.kind)).toEqual(["action", "decision", "outcome"]);
    for (const row of rows.rows) {
      expect(row.content_digest).toBe(row.sql_digest);
      expect(row).toMatchObject({ decision_id: "d1", submitted_by_api_key_id: "key_ingest", submitted_by_user_id: null });
    }
    expect(rows.rows[1]?.content).toEqual(decision("d1"));
    expect(rows.rows[1]?.record_at.toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  it("treats identical records as no-ops across retries, within a batch, and regardless of key order", async () => {
    const before = await count();
    await expect(append([decision("d1"), action("d1"), outcome("d1")])).resolves.toEqual({
      inserted: { decisions: 0, actions: 0, outcomes: 0 },
      duplicates: 3,
      awaitingDecision: 0
    });
    const reordered = Object.fromEntries(Object.entries(decision("d1")).reverse()) as ProductionDecisionRecord;
    await expect(append([reordered, outcome("d1", false), outcome("d1", false)], OWNER)).resolves.toEqual({
      inserted: { decisions: 0, actions: 0, outcomes: 1 },
      duplicates: 2,
      awaitingDecision: 0
    });
    expect(await count()).toBe(before + 1);
  });

  it("rejects a conflicting decision atomically, inside the batch or against a stored one", async () => {
    const before = await count();
    const stored = await rejection(append([decision("d2"), outcome("d2"), decision("d1", 0.3)]));
    expect(stored).toMatchObject({ code: "conflicting_decision", details: { decisionId: "d1", line: 3 } });
    const inBatch = await rejection(append([decision("d3", 0.8), outcome("d3"), decision("d3", 0.4)]));
    expect(inBatch).toMatchObject({ code: "conflicting_decision", details: { decisionId: "d3", line: 3 } });
    expect(await count()).toBe(before);
  });

  it("stores actions and outcomes before their decision and counts them until it arrives", async () => {
    await expect(append([action("d4"), outcome("d4")])).resolves.toMatchObject({
      inserted: { decisions: 0, actions: 1, outcomes: 1 },
      awaitingDecision: 2
    });
    await expect(append([decision("d4")])).resolves.toMatchObject({ inserted: { decisions: 1 }, awaitingDecision: 0 });
    await expect(append([outcome("d4", false, "2026-09-20T12:00:00.000Z")])).resolves.toMatchObject({
      inserted: { outcomes: 1 },
      awaitingDecision: 0
    });
  });

  it("rejects records dated more than five minutes after receipt and accepts backfills", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const error = await rejection(append([decision("d5", 0.8, "2026-09-20T10:00:00.000Z"), outcome("d5", true, future)]));
    expect(error).toMatchObject({ code: "future_dated_record", details: { line: 2 } });
    const nearFuture = new Date(Date.now() + 60 * 1000).toISOString();
    await expect(append([decision("d6", 0.8, "2019-01-01T00:00:00.000Z"), outcome("d6", true, nearFuture)]))
      .resolves.toMatchObject({ inserted: { decisions: 1, outcomes: 1 } });
  });

  it("rejects content PostgreSQL JSON cannot hold before writing, and empty or oversized batches", async () => {
    const withNul = { ...decision("d7"), tags: { note: "a\u0000b" } };
    await expect(rejection(append([decision("d8"), withNul]))).resolves.toMatchObject({
      code: "invalid_record", details: { line: 2 }
    });
    await expect(rejection(append([]))).resolves.toMatchObject({ code: "empty_batch" });
    // Schema-valid but enormous: 2,000 long option names in one choice answer.
    const options = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`option_${index}_${"x".repeat(40)}`, 0]));
    const huge: ProductionDecisionRecord = {
      ...decision("d9"),
      answers: { kind: { type: "choice", choice: "option_0", probabilities: options, confidence: 0.5 } }
    };
    await expect(rejection(append([decision("d8"), huge]))).resolves.toMatchObject({
      code: "record_too_large", details: { line: 2, maximum: PRODUCTION_RECORD_MAX_BYTES }
    });
    await expect(rejection(append([decision("d8")], OWNER, "proj_missing"))).resolves.toMatchObject({ code: "project_not_found" });
    // A key revoked after the request authenticated, or a key of another project, writes nothing.
    await expect(rejection(append([decision("d8")], { kind: "api_key", apiKeyId: "key_revoked" }))).resolves.toMatchObject({ code: "api_key_revoked" });
    await expect(rejection(append([decision("d8")], KEY, OTHER_PROJECT_ID))).resolves.toMatchObject({ code: "api_key_revoked" });
    const oversized = Array.from({ length: PRODUCTION_RECORD_APPEND_MAX_RECORDS + 1 }, () => outcome("d8"));
    await expect(rejection(append(oversized))).resolves.toMatchObject({ code: "batch_too_large" });
    const stored = await pool.query(`select 1 from production_decision_records where decision_id in ('d7','d8','d9')`);
    expect(stored.rowCount).toBe(0);
  });

  it("keeps stored records append-only and their content, digest, time, and submitter consistent", async () => {
    await expect(pool.query(
      `update production_decision_records set record_at = now() where project_id=$1`, [PROJECT_ID]
    )).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(
      `delete from production_decision_records where project_id=$1`, [PROJECT_ID]
    )).rejects.toMatchObject({ code: "55000" });

    const insert = (values: {
      kind?: string; decisionId?: string; recordAt?: string; content?: unknown; digest?: string;
      apiKeyId?: string | null; userId?: string | null; receivedAt?: string;
    }) => {
      const content = values.content ?? decision("tamper");
      return pool.query(
        `insert into production_decision_records
           (id, project_id, kind, decision_id, record_at, content, content_digest,
            submitted_by_api_key_id, submitted_by_user_id, received_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,coalesce($7, governed_content_v1_digest($11, $6::jsonb)),$8,$9,$10)
         returning received_at`,
        [
          `pdr_tamper_${Math.random()}`, PROJECT_ID, values.kind ?? "decision", values.decisionId ?? "tamper",
          values.recordAt ?? "2026-09-20T10:00:00.000Z", JSON.stringify(content), values.digest ?? null,
          values.apiKeyId === undefined ? "key_direct" : values.apiKeyId, values.userId ?? null,
          values.receivedAt ?? new Date().toISOString(), CONTRACT
        ]
      );
    };
    await expect(insert({ digest: digest("c") })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ kind: "outcome" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ decisionId: "someone-else" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ recordAt: "2026-09-21T10:00:00.000Z" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ apiKeyId: null })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ userId: "user_owner" })).rejects.toMatchObject({ code: "23514" });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await expect(insert({ content: decision("tamper_future", 0.8, future), decisionId: "tamper_future", recordAt: future }))
      .rejects.toMatchObject({ code: "23514" });
    // A writer cannot set the receive time: the guard replaces it with the database clock.
    const forged = await insert({ receivedAt: "2099-01-01T00:00:00.000Z" });
    expect((forged.rows[0] as { received_at: Date }).received_at.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("keeps projects apart and lets project erasure remove their records", async () => {
    await expect(append([decision("d1", 0.1), outcome("d1", false)], OWNER, OTHER_PROJECT_ID)).resolves.toMatchObject({
      inserted: { decisions: 1, outcomes: 1 }
    });
    const before = await count();
    await pool.query(`delete from projects where id=$1`, [OTHER_PROJECT_ID]);
    expect(await count(OTHER_PROJECT_ID)).toBe(0);
    expect(await count()).toBe(before);
  });

  it("lets exactly one of two concurrent conflicting appends win and stores concurrent identical appends once", async () => {
    const racing = await Promise.allSettled([append([decision("d20", 0.9)]), append([decision("d20", 0.1)])]);
    expect(racing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = racing.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason).toMatchObject({ code: "conflicting_decision" });

    const identical = await Promise.all([append([decision("d21"), outcome("d21")]), append([decision("d21"), outcome("d21")])]);
    expect(identical.reduce((sum, result) => sum + result.inserted.decisions + result.inserted.outcomes, 0)).toBe(2);
    expect(identical.reduce((sum, result) => sum + result.duplicates, 0)).toBe(2);
    const stored = await pool.query(`select 1 from production_decision_records where decision_id='d21'`);
    expect(stored.rowCount).toBe(2);
  });

  it("does not deadlock when concurrent batches share records in opposite orders", async () => {
    for (let round = 0; round < 8; round += 1) {
      const records = [
        decision(`dl${round}a`), decision(`dl${round}b`), decision(`dl${round}c`),
        outcome(`dl${round}a`), outcome(`dl${round}b`), outcome(`dl${round}c`)
      ];
      const results = await Promise.all([append(records), append([...records].reverse())]);
      expect(results.reduce((sum, result) =>
        sum + result.inserted.decisions + result.inserted.outcomes, 0)).toBe(records.length);
    }
  });

  it("has no column that could hold state or question text", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name='production_decision_records' and table_schema=current_schema()
       order by ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id", "project_id", "kind", "decision_id", "record_at", "content", "content_digest",
      "submitted_by_api_key_id", "submitted_by_user_id", "received_at"
    ]);
  });
});
