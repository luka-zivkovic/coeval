import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { createApp } from "../src/app.js";
import { PRODUCTION_INGEST_PATH } from "../src/production-calibration/ingest-routes.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; production ingest tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;
const PROJECT_ID = "proj_production_ingest";
const ledger = readFileSync(new URL("./fixtures/production-decision-ledger.jsonl", import.meta.url), "utf8");

run("production ingest through the app and PostgreSQL", () => {
  let pool: Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repository: PgRepository;
  let app: ReturnType<typeof createApp>;

  const ingest = (key: string, body = ledger) => app.request(PRODUCTION_INGEST_PATH, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-ndjson" },
    body
  });

  beforeAll(async () => {
    ({ pool, cleanup } = await openPostgresTestDatabase("production_ingest"));
    await runMigrations(pool);
    repository = new PgRepository(pool);
    app = createApp(repository, { pool });
    await pool.query(`insert into organizations (id,name) values ('org_production_ingest','Ingest Org')`);
    await pool.query(
      `insert into projects (id,organization_id,name,trace_provider) values ($1,'org_production_ingest','Ingest','manual')`,
      [PROJECT_ID]
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("stores a batch sent with an ingest key, names the key, and treats a retry as duplicates", async () => {
    const key = await repository.createApiKey({ projectId: PROJECT_ID, name: "ingest", capability: "production_ingest" });
    expect(key.capability).toBe("production_ingest");
    const first = await ingest(key.key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      inserted: { decisions: 2, actions: 0, outcomes: 4 },
      duplicates: 0,
      awaitingDecision: 0
    });
    const retry = await ingest(key.key);
    expect(await retry.json()).toMatchObject({ inserted: { decisions: 0, actions: 0, outcomes: 0 }, duplicates: 6 });
    const submitters = await pool.query<{ submitted_by_api_key_id: string; n: string }>(
      `select submitted_by_api_key_id, count(*) as n from production_decision_records
       where project_id=$1 group by submitted_by_api_key_id`,
      [PROJECT_ID]
    );
    expect(submitters.rows).toEqual([{ submitted_by_api_key_id: key.id, n: "6" }]);
  });

  it("refuses judge keys and revoked ingest keys, and keeps capabilities to the known set", async () => {
    const judge = await repository.createApiKey({ projectId: PROJECT_ID, name: "judge" });
    expect(judge.capability).toBe("judge");
    const refused = await ingest(judge.key);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "api_key_capability_mismatch" });

    const revoked = await repository.createApiKey({ projectId: PROJECT_ID, name: "revoked", capability: "production_ingest" });
    await repository.revokeApiKey(PROJECT_ID, revoked.id);
    expect((await ingest(revoked.key)).status).toBe(401);

    await expect(pool.query(
      `insert into api_keys (id, project_id, name, key_hash, key_prefix, capability)
       values ('apikey_bad', $1, 'bad', 'hash_bad', 'rubrist_sk_bad…', 'admin')`,
      [PROJECT_ID]
    )).rejects.toMatchObject({ code: "23514" });
  });
});
