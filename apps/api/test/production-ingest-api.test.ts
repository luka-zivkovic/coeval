import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiKeySchema, type ProductionDecisionLedgerRecord } from "@rubrist/shared";
import { createApp } from "../src/app.js";
import {
  PRODUCTION_INGEST_MAX_BODY_BYTES,
  PRODUCTION_INGEST_PATH,
  createProductionIngestRouter
} from "../src/production-calibration/ingest-routes.js";
import {
  ProductionRecordRepositoryError,
  type AppendProductionRecordsInput,
  type AppendProductionRecordsResult,
  type ProductionDecisionRecordRepository,
  type ProductionRecordRepositoryErrorCode
} from "../src/production-calibration/repository.js";
import { createProductionCalibrationRouter } from "../src/production-calibration/routes.js";
import { DemoRepository } from "../src/repository.js";
import { createRequestServices } from "../src/request-services/index.js";

const ledger = readFileSync(new URL("./fixtures/production-decision-ledger.jsonl", import.meta.url), "utf8");
const RESULT: AppendProductionRecordsResult = {
  inserted: { decisions: 2, actions: 0, outcomes: 4 },
  duplicates: 0,
  awaitingDecision: 0
};

class FakeRecordRepository implements ProductionDecisionRecordRepository {
  readonly calls: AppendProductionRecordsInput[] = [];
  failure: ProductionRecordRepositoryErrorCode | null = null;

  async appendRecords(input: AppendProductionRecordsInput): Promise<AppendProductionRecordsResult> {
    this.calls.push(input);
    if (this.failure) throw new ProductionRecordRepositoryError(this.failure, `fake ${this.failure}`, { line: 2 });
    return RESULT;
  }

  loadRecords(): never { throw new Error("not used by ingest"); }
  saveSnapshot(): never { throw new Error("not used by ingest"); }
  listSnapshots(): never { throw new Error("not used by ingest"); }
  getSnapshot(): never { throw new Error("not used by ingest"); }
  getRetentionDays(): never { throw new Error("not used by ingest"); }
  setRetentionDays(): never { throw new Error("not used by ingest"); }
  applyRetention(): never { throw new Error("not used by ingest"); }
  eraseDecision(): never { throw new Error("not used by ingest"); }
  purgeApiKeyRecords(): never { throw new Error("not used by ingest"); }
  deleteSnapshot(): never { throw new Error("not used by ingest"); }
}

async function setup(records: FakeRecordRepository | null = new FakeRecordRepository()) {
  const repository = new DemoRepository();
  const app = createApp(repository, { productionDecisionRecordRepository: records });
  const project = (await repository.listProjects())[0];
  if (!project) throw new Error("the demo repository has no project");
  const ingestKey = await repository.createApiKey({ projectId: project.id, name: "ingest", capability: "production_ingest" });
  const judgeKey = await repository.createApiKey({ projectId: project.id, name: "judge" });
  return { app, records, projectId: project.id, ingestKey, judgeKey };
}

function ingest(app: ReturnType<typeof createApp>, key: string, body: string, contentType = "application/x-ndjson") {
  return app.request(PRODUCTION_INGEST_PATH, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": contentType },
    body
  });
}

describe("production ingest API", () => {
  it("appends a JSON Lines batch for an ingest key and names the key as submitter", async () => {
    const { app, records, projectId, ingestKey } = await setup();
    const response = await ingest(app, ingestKey.key, ledger);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
    expect(records?.calls).toHaveLength(1);
    const call = records!.calls[0]!;
    expect(call.projectId).toBe(projectId);
    expect(call.submitter).toEqual({ kind: "api_key", apiKeyId: ingestKey.id });
    expect(call.records.map((record: ProductionDecisionLedgerRecord) => record.kind)).toEqual([
      "decision", "decision", "outcome", "outcome", "outcome", "outcome"
    ]);
  });

  it("accepts the JSON records shape and rejects bad JSON, unknown fields, and bad lines by number", async () => {
    const { app, ingestKey } = await setup();
    const lines = ledger.split("\n").filter((line) => line.trim() !== "");
    const asJson = await ingest(app, ingestKey.key, JSON.stringify({ records: lines.map((line) => JSON.parse(line) as unknown) }), "application/json");
    expect(asJson.status).toBe(200);

    const unknownField = await ingest(app, ingestKey.key, JSON.stringify({ records: ledger, extra: true }), "application/json");
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toMatchObject({ code: "production_ingest_invalid_request" });

    const notJson = await ingest(app, ingestKey.key, "{", "application/json");
    expect(await notJson.json()).toMatchObject({ code: "production_ingest_invalid_request" });

    const badLine = await ingest(app, ingestKey.key, `${lines[0]}\n{"kind":"outcome"}\n`);
    expect(badLine.status).toBe(400);
    expect(await badLine.json()).toMatchObject({
      code: "production_ingest_invalid_record",
      details: { line: 2, reason: "invalid_record" }
    });
  });

  it("keeps each key to its capability", async () => {
    const { app, records, ingestKey, judgeKey } = await setup();
    const judgeOnIngest = await ingest(app, judgeKey.key, ledger);
    expect(judgeOnIngest.status).toBe(403);
    expect(await judgeOnIngest.json()).toMatchObject({ code: "api_key_capability_mismatch" });

    const ingestOnJudge = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { authorization: `Bearer ${ingestKey.key}`, "content-type": "application/json" },
      body: "{}"
    });
    expect(ingestOnJudge.status).toBe(403);
    expect(await ingestOnJudge.json()).toMatchObject({ code: "api_key_capability_mismatch" });
    expect(records?.calls).toHaveLength(0);

    const missing = await app.request(PRODUCTION_INGEST_PATH, { method: "POST", body: ledger });
    expect(missing.status).toBe(401);
  });

  it("holds the capability gate on path variants of the ingest route", async () => {
    const { app, records, ingestKey, judgeKey } = await setup();
    const post = (key: string, path: string) => app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-ndjson" },
      body: ledger
    });
    for (const path of [PRODUCTION_INGEST_PATH, `${PRODUCTION_INGEST_PATH}/`, `${PRODUCTION_INGEST_PATH}?x=1`]) {
      expect((await post(judgeKey.key, path)).status).toBe(403);
    }
    for (const path of [
      `${PRODUCTION_INGEST_PATH}/x`, "/api/v1/PRODUCTION-DECISIONS", "/api/v1/production-decisions%2F",
      "/api/v1//production-decisions", "/api/v1/judge"
    ]) {
      const response = await post(ingestKey.key, path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "api_key_capability_mismatch" });
    }
    expect(records?.calls).toHaveLength(0);
  });

  it.each([
    ["conflicting_decision", 409],
    ["future_dated_record", 400],
    ["record_too_large", 413],
    ["batch_too_large", 413],
    ["empty_batch", 400],
    ["project_not_found", 404],
    ["write_contention", 503]
  ] as const)("maps a %s rejection to %i with its code and details", async (failure, status) => {
    const fake = new FakeRecordRepository();
    fake.failure = failure;
    const { app, ingestKey } = await setup(fake);
    const response = await ingest(app, ingestKey.key, ledger);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code: `production_ingest_${failure}`, details: { line: 2 } });
    if (failure === "write_contention") expect(response.headers.get("retry-after")).toBe("1");
  });

  it("answers 501 without a record store and 413 over the body ceiling", async () => {
    const withoutStore = await setup(null);
    expect((await ingest(withoutStore.app, withoutStore.ingestKey.key, ledger)).status).toBe(501);

    const { app, records, ingestKey } = await setup();
    const oversized = await ingest(app, ingestKey.key, "x".repeat(PRODUCTION_INGEST_MAX_BODY_BYTES + 1));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "production_ingest_body_too_large" });
    expect(records?.calls).toHaveLength(0);
  });

  it("charges the ingest record budget per record and refuses a batch it cannot cover", async () => {
    const charges: Array<[string, number]> = [];
    let allow = true;
    const fake = new FakeRecordRepository();
    const router = createProductionIngestRouter({
      repository: fake,
      requestIdentity: () => ({ projectId: "project", apiKeyId: "key_ingest" }),
      takeIngestRecords: (apiKeyId, count) => {
        charges.push([apiKeyId, count]);
        return allow;
      }
    });
    const post = (body = ledger) => router.request("/", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body });
    expect((await post()).status).toBe(200);
    // One unit before parsing, then the rest of the six records.
    expect(charges).toEqual([["key_ingest", 1], ["key_ingest", 5]]);
    charges.length = 0;
    expect((await post("not json")).status).toBe(400);
    expect(charges).toEqual([["key_ingest", 1]]);
    allow = false;
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toMatchObject({ code: "production_ingest_rate_limited" });
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps the ingest budget apart from the judge bucket and allows one full batch as a burst", () => {
    const services = createRequestServices({
      repository: new DemoRepository(),
      ownerAuthorizationEnabled: false,
      rateLimitPerMinute: 60,
      batchMaxItems: 100,
      ingestRecordsPerMinute: 100
    });
    expect(services.takeIngestRecords("key", 10_000)).toBe(true);
    expect(services.takeIngestRecords("key", 1)).toBe(false);
    expect(services.takeRateTokens("key", 1)).toBe(true);
  });
});

describe("owner import of decision records", () => {
  function importRouter(role: "owner" | "member", records: FakeRecordRepository | null = new FakeRecordRepository()) {
    return {
      records,
      router: createProductionCalibrationRouter({
        databaseMode: true,
        requestIdentity: () => ({ userId: "user_1", projectId: "project" }),
        resolveProjectRole: async () => role,
        repository: records
      })
    };
  }
  const post = (router: ReturnType<typeof createProductionCalibrationRouter>, body: unknown) =>
    router.request("/records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lets an owner import a ledger through the same write path, with the session user as submitter", async () => {
    const { router, records } = importRouter("owner");
    const response = await post(router, { records: ledger });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
    expect(records?.calls[0]).toMatchObject({ projectId: "project", submitter: { kind: "user", userId: "user_1" } });
  });

  it("refuses members, answers 501 without a store, and maps rejections", async () => {
    const member = importRouter("member");
    const forbidden = await post(member.router, { records: ledger });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "production_calibration_owner_required" });
    expect(member.records?.calls).toHaveLength(0);

    expect((await post(importRouter("owner", null).router, { records: ledger })).status).toBe(501);

    const conflicted = importRouter("owner");
    conflicted.records!.failure = "conflicting_decision";
    const conflict = await post(conflicted.router, { records: ledger });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "production_calibration_conflicting_decision", details: { line: 2 } });

    const invalid = await post(importRouter("owner").router, { records: ledger, question: "q" });
    expect(invalid.status).toBe(400);
  });
});

describe("API key capability minting", () => {
  it("mints judge keys by default and ingest keys on request, and rejects unknown capabilities", async () => {
    const app = createApp(new DemoRepository());
    const mint = (body: unknown) => app.request("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(await (await mint({ name: "ci" })).json()).toMatchObject({ capability: "judge" });
    expect(await (await mint({ name: "ingest", capability: "production_ingest" })).json())
      .toMatchObject({ capability: "production_ingest" });
    expect((await mint({ name: "admin", capability: "admin" })).status).toBe(400);
  });

  it("reads a key stored before capabilities existed as a judge key", () => {
    expect(ApiKeySchema.parse({
      id: "apikey_old",
      projectId: "project",
      name: "old",
      keyPrefix: "rubrist_sk_old…",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null
    }).capability).toBe("judge");
  });
});
