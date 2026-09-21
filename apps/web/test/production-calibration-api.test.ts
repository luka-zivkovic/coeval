import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionDecisionLedgerRecordSchema,
  buildProductionCalibrationArtifact
} from "@coeval/shared";
import {
  PRODUCTION_CALIBRATION_SAMPLE_PATH,
  ProductionCalibrationApiError,
  fetchProductionCalibrationSample,
  previewProductionCalibration
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
    expect(new Headers(init.headers).get("x-coeval-project")).toBe("project_1");
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
