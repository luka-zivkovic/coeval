import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import {
  ProductionCalibrationArtifactSchema,
  buildProductionCalibrationArtifact,
  type ProductionDecisionLedgerRecord,
  type ProductionDecisionRecord,
  type ProductionOutcomeRecord
} from "@rubrist/shared";
import { canonicalJson } from "../src/lib/canonical-json.js";
import { ProductionRecordRepositoryError, type ProductionRecordSubmitter } from "../src/production-calibration/repository.js";
import { PgProductionDecisionRecordRepository } from "../src/production-calibration/repository.pg.js";
import {
  createProductionCalibrationRouter,
  type ProductionCalibrationStoredReportResponse
} from "../src/production-calibration/routes.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; stored production report tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

const PROJECT_ID = "proj_stored_reports";
const KEY: ProductionRecordSubmitter = { kind: "api_key", apiKeyId: "key_ingest" };
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n)).toISOString();
const now = new Date("2026-09-24T12:00:00.000Z");

function decision(id: string, at: string, probability: number): ProductionDecisionRecord {
  return {
    kind: "decision", id, at, questionSet: { name: "triage", version: 1, digest: digest("a") }, model: "jev-1.13.0",
    provider: "typesafe", stateDigest: digest("b"), stateLength: 10,
    answers: { is_flaky: { type: "boolean", probability } }, latencyMs: null, usage: null
  };
}
function outcome(decisionId: string, at: string, value: boolean): ProductionOutcomeRecord {
  return { kind: "outcome", decisionId, at, question: "is_flaky", value, source: "human" };
}

run("stored production reports and snapshots", () => {
  let pool: Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repository: PgProductionDecisionRecordRepository;

  const load = (from: string | null, to: string | null, maxRecords = 1_000) => repository.loadRecords({
    projectId: PROJECT_ID,
    window: { from: from === null ? null : new Date(from), to: to === null ? null : new Date(to) },
    maxRecords
  });
  const router = (role: "owner" | "member" = "member", maxReportRecords?: number) => createProductionCalibrationRouter({
    databaseMode: true,
    requestIdentity: () => ({ userId: "user_member", projectId: PROJECT_ID }),
    resolveProjectRole: async () => role,
    repository,
    now: () => now,
    ...(maxReportRecords === undefined ? {} : { maxReportRecords })
  });
  const post = (app: ReturnType<typeof router>, path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    ({ pool, cleanup } = await openPostgresTestDatabase("stored_reports"));
    await runMigrations(pool);
    repository = new PgProductionDecisionRecordRepository(pool);
    await pool.query(`insert into organizations (id,name) values ('org_stored_reports','Reports Org')`);
    await pool.query(
      `insert into projects (id,organization_id,name,trace_provider) values ($1,'org_stored_reports','Reports','manual')`,
      [PROJECT_ID]
    );
    await pool.query(
      `insert into api_keys (id, project_id, name, key_hash, key_prefix, capability)
       values ('key_ingest', $1, 'ingest', 'hash_ingest', 'rubrist_sk_ing…', 'production_ingest')`,
      [PROJECT_ID]
    );
    // d1 day 1, d2 day 3 (its outcome arrives on day 9), d3 day 8; an orphan on day 2 and one on day 9.
    await repository.appendRecords({ projectId: PROJECT_ID, submitter: KEY, records: [
      decision("d1", day(1), 0.9), outcome("d1", day(1), true),
      decision("d2", day(3), 0.2), outcome("d2", day(9), false),
      decision("d3", day(8), 0.7), outcome("d3", day(8), true),
      outcome("ghost_early", day(2), true), outcome("ghost_late", day(9), true)
    ] });
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("loads the window's decisions with all of their records, plus orphans dated in the window, in a fixed order", async () => {
    const loaded = await load(day(1), day(5));
    const ids = loaded.records.map((record: ProductionDecisionLedgerRecord) =>
      `${record.kind}:${record.kind === "decision" ? record.id : record.decisionId}`);
    // d2's outcome arrives on day 9 but comes with its day-3 decision; ghost_late is outside the window.
    expect([...ids].sort()).toEqual(["decision:d1", "decision:d2", "outcome:d1", "outcome:d2", "outcome:ghost_early"]);
    // Order is `at`, then receive time, then content digest: d1's decision and outcome share both, so the digest decides.
    expect(ids.slice(2)).toEqual(["outcome:ghost_early", "decision:d2", "outcome:d2"]);
    expect(loaded.recordSetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const again = await load(day(1), day(5));
    expect(again.records).toEqual(loaded.records);
    expect(again.recordSetDigest).toBe(loaded.recordSetDigest);
    expect((await load(day(1), day(6))).recordSetDigest).toBe(loaded.recordSetDigest);
    expect((await load(null, null)).records).toHaveLength(8);
    expect((await load(null, null)).recordSetDigest).not.toBe(loaded.recordSetDigest);
  });

  it("refuses a window over the ceiling instead of sampling it", async () => {
    await expect(load(null, null, 7)).rejects.toMatchObject({
      code: "record_ceiling_exceeded", details: { maximum: 7, from: null, to: null }
    });
    await expect(load(null, null, 8)).resolves.toMatchObject({ records: expect.any(Array) });
    const error = await load(null, null, 7).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProductionRecordRepositoryError);
  });

  it("builds identical bytes from the same records and saves, lists, and reads back a snapshot", async () => {
    const loaded = await load(day(1), day(10));
    const build = () => buildProductionCalibrationArtifact(loaded.records, { now, window: { from: new Date(day(1)), to: new Date(day(10)) } });
    expect(canonicalJson(build())).toBe(canonicalJson(build()));

    const artifact = build();
    const saved = await repository.saveSnapshot({
      projectId: PROJECT_ID, userId: "user_member", artifact, parameters: { bins: 10 },
      recordCount: loaded.records.length, recordSetDigest: loaded.recordSetDigest
    });
    expect(saved).toMatchObject({
      reportContract: "rubrist/production-calibration/v2",
      window: { from: day(1), to: day(10) },
      recordCount: loaded.records.length,
      recordSetDigest: loaded.recordSetDigest,
      builtAt: now.toISOString(),
      createdByUserId: "user_member"
    });
    const read = await repository.getSnapshot(PROJECT_ID, saved.id);
    expect(read?.artifact).toEqual(ProductionCalibrationArtifactSchema.parse(artifact));
    expect(read?.snapshot).toEqual(saved);
    expect((await repository.listSnapshots(PROJECT_ID)).map((snapshot) => snapshot.id)).toContain(saved.id);
    expect(await repository.getSnapshot(PROJECT_ID, "pcs_missing")).toBeNull();
    expect(await repository.getSnapshot("proj_other", saved.id)).toBeNull();
  });

  it("keeps snapshots append-only and consistent with their bytes", async () => {
    const [snapshot] = await repository.listSnapshots(PROJECT_ID);
    if (!snapshot) throw new Error("expected a stored snapshot");
    await expect(pool.query(`update production_calibration_snapshots set record_count = 0 where id=$1`, [snapshot.id]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(`delete from production_calibration_snapshots where id=$1`, [snapshot.id]))
      .rejects.toMatchObject({ code: "55000" });

    const artifact = buildProductionCalibrationArtifact([], { now });
    const bytes = Buffer.from(canonicalJson(artifact), "utf8");
    const insert = (values: { digest?: string; contract?: string; windowFrom?: string | null; builtAt?: string }) => pool.query(
      `insert into production_calibration_snapshots
         (id, project_id, report_contract, canonical_bytes, artifact_digest, window_from, window_to,
          parameters, record_count, record_set_digest, built_at, created_by_user_id)
       values ($1,$2,$3,$4,coalesce($5, 'sha256:' || encode(sha256($4), 'hex')),$6,null,'{}'::jsonb,0,$7,$8,'user_member')`,
      [
        `pcs_tamper_${Math.random()}`, PROJECT_ID, values.contract ?? "rubrist/production-calibration/v2", bytes,
        values.digest ?? null, values.windowFrom ?? null, digest("c"), values.builtAt ?? now.toISOString()
      ]
    );
    await expect(insert({ digest: digest("d") })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ contract: "rubrist/production-calibration/v1" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ windowFrom: day(1) })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ builtAt: day(1) })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({})).resolves.toMatchObject({ rowCount: 1 });
  });

  it("serves stored reports and snapshots to members through the session routes", async () => {
    const app = router("member");
    const report = await post(app, "/report", { from: day(1), to: day(5), threshold: 0.5 });
    expect(report.status).toBe(200);
    const body = await report.json() as ProductionCalibrationStoredReportResponse;
    expect(body.recordCount).toBe(5);
    expect(body.artifact.window).toEqual({ from: day(1), to: day(5) });
    expect(body.artifact.records.outcomes).toMatchObject({ total: 3, orphan: 1, outsideWindow: 0 });
    expect(body.projectRole).toBe("member");

    const saved = await post(app, "/snapshots", { from: day(1), to: day(5), threshold: 0.5 });
    expect(saved.status).toBe(201);
    const { snapshot } = await saved.json() as { snapshot: { id: string; recordSetDigest: string } };
    expect(snapshot.recordSetDigest).toBe(body.recordSetDigest);
    const fetched = await app.request(`/snapshots/${snapshot.id}`);
    expect(fetched.status).toBe(200);
    expect((await fetched.json() as { artifact: unknown }).artifact).toEqual(body.artifact);
    expect(((await (await app.request("/snapshots")).json()) as { snapshots: Array<{ id: string }> }).snapshots[0]?.id).toBe(snapshot.id);
    expect((await app.request("/snapshots/pcs_missing")).status).toBe(404);

    const ceiling = await post(router("member", 2), "/report", {});
    expect(ceiling.status).toBe(422);
    expect(await ceiling.json()).toMatchObject({ code: "production_calibration_record_ceiling_exceeded", details: { maximum: 2 } });
    const backwards = await post(app, "/report", { from: day(5), to: day(1) });
    expect(await backwards.json()).toMatchObject({ code: "production_calibration_invalid_window" });
    const pasted = await post(app, "/snapshots", { records: "{}" });
    expect(pasted.status).toBe(400);
    const unknownField = await post(app, "/report", { from: day(1), window: "all" });
    expect(await unknownField.json()).toMatchObject({ code: "production_calibration_invalid_request" });
    // The orphan branch of loadRecords reads actions and outcomes by time through its own partial index.
    const indexes = await pool.query(`select 1 from pg_indexes where indexname = 'production_decision_records_orphan_at_idx'`);
    expect(indexes.rowCount).toBe(1);
  });
});
