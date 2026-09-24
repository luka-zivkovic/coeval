import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import {
  buildProductionCalibrationArtifact,
  type ProductionDecisionLedgerRecord,
  type ProductionDecisionRecord,
  type ProductionOutcomeRecord
} from "@rubrist/shared";
import { ProductionRecordRepositoryError, type ProductionRecordSubmitter } from "../src/production-calibration/repository.js";
import { PgProductionDecisionRecordRepository } from "../src/production-calibration/repository.pg.js";
import { registerProductionRetentionSweeper } from "../src/production-calibration/retention.js";
import { createProductionCalibrationRouter } from "../src/production-calibration/routes.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; production retention tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

const PROJECT_ID = "proj_production_retention";
const LONG_PROJECT_ID = "proj_production_retention_long";
const OWNER_ID = "user_retention_owner";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

function decision(id: string, probability = 0.8): ProductionDecisionRecord {
  return {
    kind: "decision", id, at: "2026-09-20T10:00:00.000Z", questionSet: { name: "triage", version: 1, digest: digest("a") },
    model: "jev-1.13.0", provider: "typesafe", stateDigest: digest("b"), stateLength: 10,
    answers: { is_flaky: { type: "boolean", probability } }, latencyMs: null, usage: null
  };
}
function outcome(decisionId: string, value = true): ProductionOutcomeRecord {
  return { kind: "outcome", decisionId, at: "2026-09-20T11:00:00.000Z", question: "is_flaky", value, source: "human" };
}

run("production record retention, erasure, and purges", () => {
  let pool: Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repository: PgProductionDecisionRecordRepository;

  const append = (records: ProductionDecisionLedgerRecord[], submitter: ProductionRecordSubmitter = { kind: "user", userId: OWNER_ID }, projectId = PROJECT_ID) =>
    repository.appendRecords({ projectId, submitter, records });
  const ids = async (projectId = PROJECT_ID) => (await pool.query<{ label: string }>(
    `select kind || ':' || decision_id as label from production_decision_records where project_id = $1 order by 1`,
    [projectId]
  )).rows.map((row) => row.label);
  const receivedAt = async (kind: string, decisionId: string) => (await pool.query<{ received_at: Date }>(
    `select received_at from production_decision_records where project_id = $1 and kind = $2 and decision_id = $3`,
    [PROJECT_ID, kind, decisionId]
  )).rows[0]!.received_at;
  const audits = async (action: string) => (await pool.query<{ metadata: Record<string, unknown>; target_id: string }>(
    `select metadata, target_id from audit_logs where action = $1 order by created_at`,
    [action]
  )).rows;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

  beforeAll(async () => {
    ({ pool, cleanup } = await openPostgresTestDatabase("production_retention"));
    await runMigrations(pool);
    repository = new PgProductionDecisionRecordRepository(pool);
    await pool.query(`insert into organizations (id,name) values ('org_retention','Retention Org')`);
    await pool.query(`insert into "user" (id,name,email) values ($1,$1,$2)`, [OWNER_ID, "owner@retention.test"]);
    for (const projectId of [PROJECT_ID, LONG_PROJECT_ID]) {
      await pool.query(
        `insert into projects (id,organization_id,name,trace_provider) values ($1,'org_retention',$1,'manual')`,
        [projectId]
      );
    }
    await pool.query(
      `insert into api_keys (id, project_id, name, key_hash, key_prefix, capability)
       values ('key_live', $1, 'live', 'hash_live', 'rubrist_sk_live…', 'production_ingest'),
              ('key_leaked', $1, 'leaked', 'hash_leaked', 'rubrist_sk_leak…', 'production_ingest')`,
      [PROJECT_ID]
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("keeps the retention period per project, 90 days by default, within 1 to 730 days", async () => {
    await expect(repository.getRetentionDays(PROJECT_ID)).resolves.toBe(90);
    await expect(repository.setRetentionDays({ projectId: LONG_PROJECT_ID, userId: OWNER_ID, retentionDays: 730 })).resolves.toBe(730);
    await expect(pool.query(`update projects set production_record_retention_days = 0 where id = $1`, [PROJECT_ID]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`update projects set production_record_retention_days = 731 where id = $1`, [PROJECT_ID]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await audits("production.retention.update")).map((row) => row.metadata)).toEqual([{ retentionDays: 730 }]);
  });

  it("deletes whole decisions received before the cutoff, orphans by their own receive time, and nothing newer", async () => {
    await append([decision("old"), outcome("orphan_old")]);
    await pause();
    const middle = new Date();
    await pause();
    await append([outcome("old", false), decision("new"), outcome("new"), outcome("orphan_new")]);
    await append([decision("keep")], { kind: "user", userId: OWNER_ID }, LONG_PROJECT_ID);
    expect((await receivedAt("decision", "old")).getTime()).toBeLessThan(middle.getTime());
    expect((await receivedAt("outcome", "new")).getTime()).toBeGreaterThan(middle.getTime());

    // A cutoff between the two batches: the old decision goes with its newer outcome.
    const run = await repository.applyRetention(new Date(middle.getTime() + 90 * DAY_MS));
    expect(run.skipped).toBe(false);
    expect(run.projects).toEqual([{
      projectId: PROJECT_ID,
      cutoff: middle.toISOString(),
      deleted: { decisions: 1, actions: 0, outcomes: 2 }
    }]);
    expect(await ids()).toEqual(["decision:new", "outcome:new", "outcome:orphan_new"]);
    expect(await ids(LONG_PROJECT_ID)).toEqual(["decision:keep"]);
    expect((await audits("production.retention.apply")).at(-1)?.metadata).toEqual({
      cutoff: middle.toISOString(),
      deleted: { decisions: 1, actions: 0, outcomes: 2 }
    });
    // A rerun at the same time deletes nothing and writes no audit entry.
    await expect(repository.applyRetention(new Date(middle.getTime() + 90 * DAY_MS))).resolves.toEqual({ skipped: false, projects: [] });
  });

  it("lets only one retention run delete at a time and a sweeper run on demand", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`select pg_advisory_xact_lock(hashtextextended('rubrist/production-retention/v1', 0))`);
      await expect(repository.applyRetention(new Date())).resolves.toEqual({ skipped: true, projects: [] });
      await client.query("rollback");
    } finally {
      client.release();
    }
    const sweeper = registerProductionRetentionSweeper(repository, { intervalMs: 0, now: () => new Date() });
    await expect(sweeper.sweep()).resolves.toMatchObject({ skipped: false });
    await sweeper.stop();
  });

  it("erases a decision, leaves only digests behind, and refuses the decision afterwards", async () => {
    await append([decision("secret"), outcome("secret"), { ...outcome("secret", false), note: "call Ana at 555-0100" }]);
    await expect(repository.eraseDecision({ projectId: PROJECT_ID, userId: OWNER_ID, decisionId: "secret" }))
      .resolves.toEqual({ decisions: 1, actions: 0, outcomes: 2 });
    expect((await ids()).filter((label) => label.endsWith(":secret"))).toEqual([]);
    const [entry] = await audits("production.decision.erase");
    expect(JSON.stringify(entry)).not.toContain("secret");
    expect(JSON.stringify(entry)).not.toContain("555-0100");
    expect(entry?.metadata).toMatchObject({ deleted: { decisions: 1, actions: 0, outcomes: 2 } });

    const replay = await append([decision("fresh"), decision("secret")]).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(ProductionRecordRepositoryError);
    expect(replay).toMatchObject({ code: "erased_decision", details: { line: 2 } });
    expect(await ids()).not.toContain("decision:fresh");
    await expect(pool.query(
      `insert into production_decision_records (id, project_id, kind, decision_id, record_at, content, content_digest, submitted_by_user_id)
       values ('pdr_direct', $1, 'outcome', 'secret', $2, $3::jsonb, governed_content_v1_digest('rubrist/production-decision-record/v1', $3::jsonb), $4)`,
      [PROJECT_ID, "2026-09-20T11:00:00.000Z", JSON.stringify(outcome("secret")), OWNER_ID]
    )).rejects.toMatchObject({ code: "23514", constraint: "production_decision_records_erased_check" });
    // Erasing again is harmless.
    await expect(repository.eraseDecision({ projectId: PROJECT_ID, userId: OWNER_ID, decisionId: "secret" }))
      .resolves.toEqual({ decisions: 0, actions: 0, outcomes: 0 });
  });

  it("purges exactly what a revoked key sent, and only after it is revoked", async () => {
    await append([decision("from_leak"), outcome("new", false)], { kind: "api_key", apiKeyId: "key_leaked" });
    await append([decision("from_live")], { kind: "api_key", apiKeyId: "key_live" });
    await expect(repository.purgeApiKeyRecords({ projectId: PROJECT_ID, userId: OWNER_ID, apiKeyId: "key_leaked" }))
      .rejects.toMatchObject({ code: "api_key_not_revoked" });
    await expect(repository.purgeApiKeyRecords({ projectId: PROJECT_ID, userId: OWNER_ID, apiKeyId: "key_missing" }))
      .rejects.toMatchObject({ code: "api_key_not_found" });
    await pool.query(`update api_keys set revoked_at = now() where id = 'key_leaked'`);
    await expect(repository.purgeApiKeyRecords({ projectId: PROJECT_ID, userId: OWNER_ID, apiKeyId: "key_leaked" }))
      .resolves.toEqual({ decisions: 1, actions: 0, outcomes: 1 });
    const remaining = await pool.query<{ submitted_by_api_key_id: string | null }>(
      `select distinct submitted_by_api_key_id from production_decision_records where project_id = $1`,
      [PROJECT_ID]
    );
    expect(remaining.rows.map((row) => row.submitted_by_api_key_id)).not.toContain("key_leaked");
    expect(await ids()).toContain("decision:from_live");
    expect((await audits("production.api_key.purge")).map((row) => row.target_id)).toEqual(["key_leaked"]);
  });

  it("deletes a snapshot only through the owner operation", async () => {
    const saved = await repository.saveSnapshot({
      projectId: PROJECT_ID, userId: OWNER_ID, artifact: buildProductionCalibrationArtifact([], { now: new Date() }),
      parameters: {}, recordCount: 0, recordSetDigest: digest("c")
    });
    await expect(pool.query(`delete from production_calibration_snapshots where id = $1`, [saved.id]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(repository.deleteSnapshot({ projectId: LONG_PROJECT_ID, userId: OWNER_ID, snapshotId: saved.id })).resolves.toBe(false);
    await expect(repository.deleteSnapshot({ projectId: PROJECT_ID, userId: OWNER_ID, snapshotId: saved.id })).resolves.toBe(true);
    await expect(repository.getSnapshot(PROJECT_ID, saved.id)).resolves.toBeNull();
    expect((await audits("production.snapshot.delete")).at(-1)?.metadata).toEqual({ artifactDigest: saved.artifactDigest });
  });

  it("serves the retention and deletion routes to owners only", async () => {
    const router = (role: "owner" | "member") => createProductionCalibrationRouter({
      databaseMode: true,
      requestIdentity: () => ({ userId: OWNER_ID, projectId: PROJECT_ID }),
      resolveProjectRole: async () => role,
      repository
    });
    const send = (role: "owner" | "member", method: string, path: string, body?: unknown) => router(role).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    expect(await (await send("member", "GET", "/settings")).json()).toEqual({ retentionDays: 90 });
    expect((await send("member", "PUT", "/settings", { retentionDays: 30 })).status).toBe(403);
    expect(await (await send("owner", "PUT", "/settings", { retentionDays: 30 })).json()).toEqual({ retentionDays: 30 });
    const tooLong = await send("owner", "PUT", "/settings", { retentionDays: 731 });
    expect(await tooLong.json()).toMatchObject({ code: "production_calibration_invalid_retention" });
    expect((await send("member", "POST", "/records/erase", { decisionId: "new" })).status).toBe(403);
    expect(await (await send("owner", "POST", "/records/erase", { decisionId: "new" })).json())
      .toEqual({ erased: { decisions: 1, actions: 0, outcomes: 1 } });
    const notRevoked = await send("owner", "POST", "/records/purge", { apiKeyId: "key_live" });
    expect(notRevoked.status).toBe(409);
    expect(await notRevoked.json()).toMatchObject({ code: "production_calibration_api_key_not_revoked" });
    expect((await send("owner", "DELETE", "/snapshots/pcs_missing")).status).toBe(404);
  });
});
