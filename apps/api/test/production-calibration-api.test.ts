import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_CALIBRATION_CONTRACT,
  ProductionCalibrationArtifactSchema,
  type ProductionCalibrationArtifact
} from "@rubrist/shared";
import { createApp } from "../src/app.js";
import type { RubristAuth } from "../src/lib/auth.js";
import {
  PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES,
  createProductionCalibrationRouter,
  type ProductionCalibrationPreviewResponse
} from "../src/production-calibration/routes.js";

const flakyTriage = readFileSync(new URL("./fixtures/production-decision-ledger.flaky-triage.jsonl", import.meta.url), "utf8");
const trialRunner = readFileSync(new URL("./fixtures/production-decision-ledger.trial-runner.jsonl", import.meta.url), "utf8");
const now = new Date("2026-09-21T09:00:00.000Z");

function router(input: {
  userId?: string | null;
  apiKeyId?: string;
  role?: "owner" | "member" | null;
  projectId?: string;
  databaseMode?: boolean;
} = {}) {
  return createProductionCalibrationRouter({
    databaseMode: input.databaseMode ?? true,
    requestIdentity: () => ({
      userId: input.userId === undefined ? "member" : input.userId,
      projectId: input.projectId === undefined ? "project" : input.projectId,
      apiKeyId: input.apiKeyId
    }),
    resolveProjectRole: async () => input.role === undefined ? "member" : input.role,
    now: () => now
  });
}

async function preview(app: ReturnType<typeof router>, body: unknown, init: RequestInit = {}): Promise<Response> {
  return await app.request("/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init
  });
}

async function previewJson(body: unknown): Promise<ProductionCalibrationPreviewResponse> {
  const response = await preview(router(), body);
  expect(response.status).toBe(200);
  return await response.json() as ProductionCalibrationPreviewResponse;
}

function booleanQuestion(artifact: ProductionCalibrationArtifact, question: string) {
  const entry = artifact.questions.find((candidate) => candidate.question === question && candidate.answerType === "boolean");
  if (!entry || entry.answerType !== "boolean") throw new Error(`missing boolean question ${question}`);
  return entry;
}

describe("production calibration preview API boundary", () => {
  it("requires database-backed project-member sessions and permits member previews", async () => {
    const body = { records: flakyTriage };
    expect((await preview(router({ databaseMode: false }), body)).status).toBe(501);
    expect((await preview(router({ userId: null }), body)).status).toBe(401);
    expect((await preview(router({ userId: null, apiKeyId: "key" }), body)).status).toBe(401);
    expect((await preview(router({ projectId: "" }), body)).status).toBe(403);
    expect((await preview(router({ role: null }), body)).status).toBe(403);
    const response = await preview(router(), body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json() as ProductionCalibrationPreviewResponse;
    expect(payload.projectRole).toBe("member");
  });

  it("scopes the preview to the resolved project membership through the app boundary", async () => {
    const fakeAuth = {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 })
    } as unknown as RubristAuth;
    const app = createApp(undefined, { auth: fakeAuth, pool: {} as Pool });
    const response = await app.request("/api/production-calibration/preview", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rubrist-project": "project" },
      body: JSON.stringify({ records: flakyTriage })
    });
    expect(response.status).toBe(401);
    // Demo mode never computes a preview: there is no session to scope it to.
    const demo = createApp();
    expect((await demo.request("/api/production-calibration/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records: flakyTriage })
    })).status).toBe(501);
  });

  it("rejects a bad line by number, naming the first failing record", async () => {
    const lines = flakyTriage.split("\n").filter((line) => line.trim() !== "");
    const broken = [...lines.slice(0, 3), "{not json", ...lines.slice(3)].join("\n");
    const invalidJson = await preview(router(), { records: broken });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toMatchObject({
      error: "Line 4 is not valid JSON",
      code: "production_calibration_invalid_record",
      details: { line: 4, reason: "invalid_json" }
    });

    const badRecord = JSON.parse(lines[0]!) as Record<string, unknown>;
    badRecord.stateDigest = "not-a-digest";
    const withBadRecord = [lines[0], lines[1], JSON.stringify(badRecord), ...lines.slice(2)].join("\n");
    const invalidRecord = await preview(router(), { records: withBadRecord });
    expect(invalidRecord.status).toBe(400);
    const payload = await invalidRecord.json() as { error: string; details: { line: number } };
    expect(payload.error).toMatch(/^Line 3 is not a valid production decision record at stateDigest: /);
    expect(payload.details.line).toBe(3);

    const arrayForm = await preview(router(), { records: [JSON.parse(lines[0]!), { kind: "outcome" }] });
    expect(arrayForm.status).toBe(400);
    await expect(arrayForm.json()).resolves.toMatchObject({ details: { line: 2, reason: "invalid_record" } });

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    first.stateLength = 1;
    const conflicting = await preview(router(), { records: [...lines, JSON.stringify(first)].join("\n") });
    expect(conflicting.status).toBe(400);
    await expect(conflicting.json()).resolves.toMatchObject({ code: "production_calibration_conflicting_records" });
    const duplicated = await preview(router(), { records: [...lines, lines[0]].join("\n") });
    expect(duplicated.status).toBe(200);
    await expect(duplicated.json()).resolves.toMatchObject({ summary: { records: { total: 49, decisions: 16 } } });

    const empty = await preview(router(), { records: "\n\n" });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ code: "production_calibration_empty_ledger" });
  });

  it("rejects unknown fields, unknown questions, malformed JSON, and oversized bodies", async () => {
    expect((await preview(router(), { records: flakyTriage, extra: true })).status).toBe(400);
    expect((await preview(router(), { records: flakyTriage, threshold: 1.5 })).status).toBe(400);
    expect((await preview(router(), "{oops")).status).toBe(400);
    const unknownQuestion = await preview(router(), { records: flakyTriage, question: "nope" });
    expect(unknownQuestion.status).toBe(400);
    await expect(unknownQuestion.json()).resolves.toMatchObject({ code: "production_calibration_unknown_question" });
    const oversized = await preview(router(), { records: flakyTriage }, {
      headers: { "content-type": "application/json", "content-length": String(PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES + 1) }
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: `Request body exceeds ${PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES} bytes`
    });
  });

  it("builds the artifact and summary for the flaky-triage ledger", async () => {
    const { artifact, summary } = await previewJson({ records: flakyTriage });
    expect(artifact.contract).toBe(PRODUCTION_CALIBRATION_CONTRACT);
    expect(ProductionCalibrationArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.generatedAt).toBe(now.toISOString());
    expect(artifact.evidence).toEqual({
      kind: "production_outcomes",
      sealed: false,
      independentHumanValidation: false,
      outcomeSources: { human: 32, automatic: 0, delayed: 0 }
    });
    expect(summary.records).toEqual({ total: 48, decisions: 16, actions: 0, outcomes: 32 });
    expect(summary.questions).toEqual([
      { question: "failure_kind", answerTypes: ["choice"], decisions: 16, outcomes: 16 },
      { question: "is_flaky", answerTypes: ["boolean"], decisions: 16, outcomes: 16 },
      { question: "needs_human", answerTypes: ["boolean"], decisions: 16, outcomes: 0 },
      { question: "owner_team", answerTypes: ["choice"], decisions: 16, outcomes: 0 },
      { question: "resolution", answerTypes: ["choice"], decisions: 16, outcomes: 0 },
      { question: "safe_to_retry", answerTypes: ["boolean"], decisions: 16, outcomes: 0 },
      { question: "severity", answerTypes: ["score"], decisions: 16, outcomes: 0 }
    ]);
    expect(summary.models).toEqual([{
      model: { provider: "typesafe", observedModel: "jev-1.13.0", identityStrength: "observed_version" },
      decisions: 16
    }]);
    expect(summary.questionSetDigests).toEqual(["sha256:ae55dd25e0ad8714578f6f3c04e867ea098345cd3e6cd6a94d86413a2d24a050"]);
    expect(summary.question).toBeNull();
    expect(artifact.questions.map((question) => [question.question, question.answerType])).toEqual(
      summary.questions.map((question) => [question.question, question.answerTypes[0]])
    );
    const isFlaky = booleanQuestion(artifact, "is_flaky");
    expect(isFlaky.calibration.nWithOutcome).toBe(16);
    expect(isFlaky.calibration.confusion.threshold).toBe(0.5);
    expect(isFlaky.thresholdAdvice).toBeNull();
    const severity = artifact.questions.find((question) => question.question === "severity");
    if (severity?.answerType !== "score") throw new Error("expected score calibration for severity");
    expect(severity.calibration).toMatchObject({ state: "defined", levels: 5, n: 16, nWithOutcome: 0 });
    expect(artifact.window).toEqual({ from: null, to: null });
  });

  it("builds the artifact and summary for the trial-runner ledger", async () => {
    const { artifact, summary } = await previewJson({ records: trialRunner });
    expect(summary.records).toEqual({ total: 84, decisions: 12, actions: 0, outcomes: 72 });
    expect(summary.questions.map((question) => [question.question, question.answerTypes, question.outcomes])).toEqual([
      ["claim_matches_state", ["boolean"], 12],
      ["claims_reservation_made", ["boolean"], 12],
      ["over_reserved_precomputed", ["boolean"], 12],
      ["over_reserved_raw", ["boolean"], 12],
      ["state_shows_reservation", ["boolean"], 12],
      ["verdict", ["choice"], 12]
    ]);
    expect(artifact.evidence.outcomeSources).toEqual({ human: 0, automatic: 72, delayed: 0 });
    const verdict = artifact.questions.find((question) => question.question === "verdict");
    expect(verdict?.answerType === "choice" && verdict.calibration.accuracy.state).toBe("defined");
  });

  it("applies threshold, bins, window, and costs, globally or scoped to one question", async () => {
    const global = await previewJson({
      records: flakyTriage,
      threshold: 0.85,
      bins: 5,
      windowDays: 1,
      costs: { falsePositive: 1, falseNegative: 4 }
    });
    expect(global.artifact.parameters).toMatchObject({ threshold: 0.85, bins: 5, windowDays: 1 });
    const isFlaky = booleanQuestion(global.artifact, "is_flaky");
    expect(isFlaky.calibration.confusion.threshold).toBe(0.85);
    expect(isFlaky.calibration.reliability).toHaveLength(5);
    expect(isFlaky.calibration.errorDirections.falsePositive.definition).toContain("p >= 0.85");
    expect(isFlaky.thresholdAdvice?.mode).toBe("single");
    expect(isFlaky.thresholdAdvice?.caveat).toBe("fewer_than_30_outcomes");
    expect(isFlaky.thresholdAdvice?.sweep).toHaveLength(19);
    expect(isFlaky.thresholdAdvice?.recommendation).not.toBeNull();
    expect(booleanQuestion(global.artifact, "needs_human").thresholdAdvice).toMatchObject({ caveat: "no_outcomes", recommendation: null });

    const band = await previewJson({
      records: flakyTriage,
      question: "is_flaky",
      threshold: 0.3,
      costs: { falsePositive: 1, falseNegative: 4, humanReview: 0.5 }
    });
    expect(band.summary.question).toBe("is_flaky");
    expect(band.artifact.parameters.threshold).toBe(0.5);
    expect(booleanQuestion(band.artifact, "is_flaky").calibration.confusion.threshold).toBe(0.3);
    expect(booleanQuestion(band.artifact, "is_flaky").thresholdAdvice).toMatchObject({ mode: "band" });
    expect(booleanQuestion(band.artifact, "is_flaky").thresholdAdvice?.sweep).toHaveLength(190);
    expect(booleanQuestion(band.artifact, "needs_human").calibration.confusion.threshold).toBe(0.5);
    expect(booleanQuestion(band.artifact, "needs_human").thresholdAdvice).toBeNull();

    const explicitNull = await previewJson({ records: flakyTriage, costs: null });
    expect(booleanQuestion(explicitNull.artifact, "is_flaky").thresholdAdvice).toBeNull();
  });
});
