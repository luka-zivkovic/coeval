import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionDecisionLedgerRecordSchema,
  buildProductionCalibrationArtifact
} from "@rubrist/shared";
import {
  PRODUCTION_CALIBRATION_SAMPLE_PATH,
  ProductionCalibrationApiError,
  buildStoredProductionReport,
  fetchProductionCalibrationSample,
  fetchProductionSnapshot,
  importProductionRecords,
  listProductionSnapshots,
  previewProductionCalibration,
  saveProductionSnapshot
} from "../src/lib/production-calibration-api.js";

const ledgerText = readFileSync(
  new URL("../../api/test/fixtures/production-decision-ledger.flaky-triage.jsonl", import.meta.url),
  "utf8"
);
const records = ledgerText.split("\n").filter((line) => line.trim() !== "")
  .map((line) => ProductionDecisionLedgerRecordSchema.parse(JSON.parse(line)));
const artifact = buildProductionCalibrationArtifact(records, { now: new Date("2026-09-21T09:00:00.000Z") });
const summary = {
  records: { total: 48, decisions: 16, actions: 0, outcomes: 32 },
  questions: [{ question: "is_flaky", answerTypes: ["boolean"], decisions: 16, outcomes: 16 }],
  models: artifact.records.models,
  questionSetDigests: [artifact.records.questionSets[0]!.digest],
  question: null
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production calibration preview client", () => {
  it("posts the ledger and parameters with the pinned project header and parses the artifact", async () => {
    const fetchMock = vi.fn(async () => json({ artifact, summary, projectRole: "member" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { getItem: () => "project_1" });
    const preview = await previewProductionCalibration({
      records: ledgerText,
      question: "is_flaky",
      threshold: 0.3,
      bins: 5,
      costs: { falsePositive: 1, falseNegative: 4, humanReview: null }
    });
    expect(preview.artifact).toEqual(artifact);
    expect(preview.summary.records.decisions).toBe(16);
    expect(preview.summary.questions[0]?.answerTypes).toEqual(["boolean"]);
    expect(preview.projectRole).toBe("member");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/production-calibration/preview");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("x-rubrist-project")).toBe("project_1");
    expect(JSON.parse(String(init.body))).toEqual({
      records: ledgerText,
      question: "is_flaky",
      threshold: 0.3,
      bins: 5,
      costs: { falsePositive: 1, falseNegative: 4, humanReview: null }
    });
  });

  it("surfaces the API's line-numbered rejection and refuses an invalid artifact", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      error: "Line 4 is not valid JSON",
      code: "production_calibration_invalid_record",
      details: { line: 4, reason: "invalid_json" }
    }, 400)));
    vi.stubGlobal("localStorage", { getItem: () => null });
    const failure = await previewProductionCalibration({ records: "{" }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProductionCalibrationApiError);
    expect(failure).toMatchObject({ status: 400, code: "production_calibration_invalid_record", line: 4, message: "Line 4 is not valid JSON" });

    vi.stubGlobal("fetch", vi.fn(async () => json({ artifact: { ...artifact, evidence: { ...artifact.evidence, sealed: true } }, summary, projectRole: "owner" })));
    await expect(previewProductionCalibration({ records: ledgerText })).rejects.toThrow();

    vi.stubGlobal("fetch", vi.fn(async () => json({ artifact, summary, projectRole: "visitor" })));
    await expect(previewProductionCalibration({ records: ledgerText })).rejects.toThrow("omitted the project role");
  });

  it("loads the bundled sample ledger from the web app's static assets", async () => {
    const fetchMock = vi.fn(async () => new Response(ledgerText, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProductionCalibrationSample()).resolves.toBe(ledgerText);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(PRODUCTION_CALIBRATION_SAMPLE_PATH);
    expect(PRODUCTION_CALIBRATION_SAMPLE_PATH).toBe("/samples/production-decision-ledger.flaky-triage.jsonl");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchProductionCalibrationSample()).rejects.toMatchObject({ status: 404 });
  });
});

describe("stored production report client", () => {
  const recordSetDigest = `sha256:${"a".repeat(64)}`;
  const snapshot = {
    id: "pcs_1",
    projectId: "project_1",
    reportContract: "rubrist/production-calibration/v2",
    artifactDigest: `sha256:${"b".repeat(64)}`,
    window: { from: "2026-09-01T00:00:00.000Z", to: null },
    parameters: { bins: 10 },
    recordCount: 48,
    recordSetDigest,
    builtAt: "2026-09-21T09:00:00.000Z",
    createdByUserId: "user_1",
    createdAt: "2026-09-21T09:00:01.000Z"
  };

  it("builds a stored report over a window and never sends records", async () => {
    const fetchMock = vi.fn(async () => json({ artifact, summary, projectRole: "owner", recordCount: 48, recordSetDigest }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { getItem: () => "project_1" });
    const report = await buildStoredProductionReport({ from: "2026-09-01T00:00:00.000Z", to: null, bins: 5 });
    expect(report).toMatchObject({ recordCount: 48, recordSetDigest, projectRole: "owner" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/production-calibration/report");
    expect(JSON.parse(String(init.body))).toEqual({ from: "2026-09-01T00:00:00.000Z", bins: 5 });
  });

  it("saves, lists, and opens snapshots and rejects a malformed digest", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("fetch", vi.fn(async () => json({ snapshot }, 201)));
    await expect(saveProductionSnapshot({ from: "2026-09-01T00:00:00.000Z" })).resolves.toMatchObject({ id: "pcs_1", recordCount: 48 });
    vi.stubGlobal("fetch", vi.fn(async () => json({ snapshots: [snapshot] })));
    await expect(listProductionSnapshots()).resolves.toHaveLength(1);
    const fetchMock = vi.fn(async () => json({ snapshot, artifact }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProductionSnapshot("pcs_1")).resolves.toMatchObject({ snapshot: { id: "pcs_1" }, artifact });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/production-calibration/snapshots/pcs_1");
    vi.stubGlobal("fetch", vi.fn(async () => json({ snapshots: [{ ...snapshot, artifactDigest: "sha256:short" }] })));
    await expect(listProductionSnapshots()).rejects.toThrow("Invalid artifactDigest");
  });

  it("imports a ledger and surfaces an owner-only refusal with its code", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("fetch", vi.fn(async () => json({ inserted: { decisions: 16, actions: 0, outcomes: 32 }, duplicates: 0, awaitingDecision: 0 })));
    await expect(importProductionRecords(ledgerText)).resolves.toEqual({
      inserted: { decisions: 16, actions: 0, outcomes: 32 }, duplicates: 0, awaitingDecision: 0
    });
    vi.stubGlobal("fetch", vi.fn(async () => json({
      error: "Only project owners can import decision records", code: "production_calibration_owner_required"
    }, 403)));
    await expect(importProductionRecords(ledgerText)).rejects.toMatchObject({ status: 403, code: "production_calibration_owner_required" });
  });
});
