import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { CoevalAuth } from "../src/lib/auth.js";

const fakeAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response(null, { status: 404 })
} as unknown as CoevalAuth;

function routeManifest(options: { auth?: CoevalAuth; pool?: Pool } = {}): string[] {
  const app = createApp(undefined, options);
  return app.routes.map(({ method, path }) => `${method} ${path}`);
}

describe("app route registration contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins readable demo and auth-enabled route manifests", () => {
    const demo = routeManifest();
    const authenticated = routeManifest({ auth: fakeAuth });
    const authenticatedWithPool = routeManifest({ auth: fakeAuth, pool: {} as Pool });

    expect(demo).toHaveLength(225);
    // This snapshot intentionally follows Hono's route registry. A Hono upgrade
    // must show reviewers the complete ordered route-table diff, not a new hash.
    expect(demo).toMatchSnapshot("demo route manifest");
    expect(authenticated).toHaveLength(227);
    expect(authenticated).toMatchSnapshot("authenticated route manifest");
    // Pool-backed auth changes runtime behavior, but not route registration.
    // Real auth behavior is characterized in pg-auth.test.ts.
    expect(authenticatedWithPool).toEqual(authenticated);
  });

  it("keeps public routes, body limits, auth, and project resolution in fail-closed order", () => {
    const routes = routeManifest({ auth: fakeAuth });
    expect(routes.slice(0, 18)).toEqual([
      "ALL /*",
      "ALL /*",
      "ALL /*",
      "GET /health",
      "GET /api/auth/setup-required",
      "POST /api/auth/setup",
      "POST /api/auth/redeem-invite",
      "ALL /api/auth/sign-up/email",
      "POST /api/auth/*",
      "GET /api/auth/*",
      "ALL /api/v1/*",
      "ALL /api/datasets/:datasetId/examples",
      "ALL /api/traces/manual",
      "ALL /api/trace-tests",
      "ALL /api/trace-tests/*",
      "ALL /api/v1/*",
      "ALL /api/*",
      "ALL /api/governed-review/*"
    ]);
    expect(routes.filter((route) => route === "ALL /api/v1/*")).toHaveLength(2);
  });

  it("rejects an oversized v1 body before checking for an API key", async () => {
    vi.stubEnv("JUDGE_MAX_BODY_BYTES", "1024");
    vi.resetModules();
    const { createApp: createAppWithPinnedLimit } = await import("../src/app.js");
    const app = createAppWithPinnedLimit(undefined, { auth: fakeAuth });
    const response = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1025)
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: "Request body exceeds 1024 bytes"
    });
  });
});
