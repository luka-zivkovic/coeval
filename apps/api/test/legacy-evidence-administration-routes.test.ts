import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DemoRepository } from "../src/repository.js";
import type { AppVariables } from "../src/request-services/index.js";
import { registerLegacyEvidenceAdministrationRoutes } from "../src/routes/legacy-evidence-administration.js";

describe("legacy evidence administration routes", () => {
  it("owns the exact contiguous ungoverned legacy evidence route family", () => {
    const app = new Hono<{ Variables: AppVariables }>();
    registerLegacyEvidenceAdministrationRoutes(app, {
      repository: new DemoRepository()
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/cases/:caseId",
      "POST /api/cases/:caseId/promote",
      "POST /api/cases/:caseId/verdicts",
      "POST /api/cases/:caseId/adjudicate",
      "GET /api/cases/:caseId/verdicts",
      "GET /api/golden-set",
      "GET /api/trust-digest",
      "GET /api/golden-set/health",
      "GET /api/projects/kappa",
      "GET /api/projects/judge-human-calibration",
      "GET /api/projects/disagreements",
      "GET /api/projects/judge-human-disagreements",
      "GET /api/projects/verdicts",
      "GET /api/projects/verdicts/export",
      "POST /api/review-queues",
      "GET /api/review-queues",
      "GET /api/review-queues/:queueId",
      "GET /api/review-queues/:queueId/next",
      "POST /api/review-queues/:queueId/items",
      "POST /api/review-queues/:queueId/close",
      "POST /api/review-queues/:queueId/reopen",
      "POST /api/golden-set/:entryId/retire"
    ]);
  });
});
