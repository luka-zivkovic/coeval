import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DemoRepository } from "../src/repository.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { registerV1EvaluationAdministrationRoutes } from "../src/routes/v1-evaluation-administration.js";

describe("v1 evaluation administration routes", () => {
  it("owns the exact contiguous judge, receipt, and deprecated gate route family", () => {
    const repository = new DemoRepository();
    const app = new Hono<{ Variables: AppVariables }>();
    registerV1EvaluationAdministrationRoutes(app, {
      repository,
      requestServices: createRequestServices({
        repository,
        ownerAuthorizationEnabled: false,
        rateLimitPerMinute: 60,
        batchMaxItems: 100
      }),
      judgeTimeoutMs: 60_000,
      judgeBatchMaxItems: 100,
      judgeBatchMaxBodyBytes: 4 * 1024 * 1024,
      judgeRateLimitPerMinute: 60
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/v1/judge",
      "POST /api/v1/judge/batch",
      "GET /api/v1/eval-runs/:evalRunId/assessment-receipt",
      "GET /api/v1/assessment-receipts/:receiptId",
      "POST /api/v1/eval-runs/:evalRunId/assessment-receipt/comparisons",
      "GET /api/v1/eval-runs/:evalRunId",
      "POST /api/v1/gate-checks",
      "GET /api/v1/gate-checks/:gateCheckId"
    ]);
  });
});
