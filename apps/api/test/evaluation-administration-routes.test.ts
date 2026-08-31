import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DemoRepository } from "../src/repository.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { registerEvaluationAdministrationRoutes } from "../src/routes/evaluation-administration.js";

describe("evaluation administration routes", () => {
  it("owns the exact contiguous evaluation-administration route family", () => {
    const repository = new DemoRepository();
    const app = new Hono<{ Variables: AppVariables }>();
    registerEvaluationAdministrationRoutes(app, {
      repository,
      requestServices: createRequestServices({
        repository,
        ownerAuthorizationEnabled: false,
        rateLimitPerMinute: 60,
        batchMaxItems: 100
      })
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/trace-tests/:traceTestId/runs",
      "POST /api/skills/:skillId/versions/:versionId/convergence/runs",
      "POST /api/eval-runs",
      "POST /api/skills/:skillId/versions/:versionId/backfill",
      "GET /api/eval-runs",
      "GET /api/eval-runs/:evalRunId",
      "POST /api/run-comparisons",
      "GET /api/run-comparisons",
      "GET /api/run-comparisons/:comparisonId"
    ]);
  });
});
