import { describe, expect, it } from "vitest";
import { createProductionCalibrationRouter } from "../src/production-calibration/routes.js";

// Stored reports and snapshots are covered against PostgreSQL in
// production-stored-reports-pg.test.ts; this file pins the routes' behavior
// when no record store exists and when the session is missing.
function router(options: { repository?: null; userId?: string | null } = {}) {
  return createProductionCalibrationRouter({
    databaseMode: true,
    requestIdentity: () => ({ userId: options.userId === undefined ? "user_1" : options.userId, projectId: "project" }),
    resolveProjectRole: async () => "member",
    repository: options.repository ?? null
  });
}

describe("stored production report routes", () => {
  it("answer 501 without a record store", async () => {
    const app = router();
    const post = (path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    for (const response of [await post("/report"), await post("/snapshots"), await app.request("/snapshots"), await app.request("/snapshots/pcs_1")]) {
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "production_calibration_records_unavailable" });
    }
  });

  it("require a project-member session", async () => {
    const app = router({ userId: null });
    expect((await app.request("/report", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await app.request("/snapshots")).status).toBe(401);
  });
});
