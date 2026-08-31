import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp, agentSetupPairingClaimExpiresAt, agentSetupPairingStatus } from "../src/app.js";
import type { AgentSetupPairingRecord } from "../src/lib/auth.js";
import { DemoRepository } from "../src/repository.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { registerProjectAdministrationRoutes } from "../src/routes/project-administration.js";

describe("project administration routes", () => {
  it("owns the exact contiguous project-administration route family", () => {
    const repository = new DemoRepository();
    const app = new Hono<{ Variables: AppVariables }>();
    registerProjectAdministrationRoutes(app, {
      repository,
      requestServices: createRequestServices({
        repository,
        ownerAuthorizationEnabled: false,
        rateLimitPerMinute: 60,
        batchMaxItems: 100
      }),
      publicApiBaseUrl: () => "https://coeval.example"
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/projects",
      "POST /api/projects",
      "POST /api/agent-setup/pairings",
      "GET /api/agent-setup/pairings/:pairingId",
      "DELETE /api/agent-setup/pairings/:pairingId",
      "GET /api/judge/providers",
      "GET /api/judge/providers/:provider/models",
      "GET /api/project/settings",
      "PATCH /api/project/settings",
      "POST /api/project/retention/prune",
      "DELETE /api/project",
      "GET /api/dashboard",
      "GET /api/onboarding/evidence-inventory"
    ]);
  });

  it("reports the exact saved Run fields available to beginner setup", async () => {
    const repository = new DemoRepository();
    await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "onboarding-inventory-1",
      input: { request: "Help" },
      output: { answer: "Here is help" },
      metadata: { channel: "test" },
      steps: [{ name: "lookup", input: { q: "Help" }, output: { found: true } }]
    }, { ingestionPurpose: "analysis_eligible_manual" });
    await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "onboarding-inventory-2",
      input: { request: "No result yet" },
      output: null,
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const response = await createApp(repository).request("/api/onboarding/evidence-inventory");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runCount: 2,
      inputCount: 2,
      outputCount: 1,
      stepsCount: 1,
      metadataCount: 1
    });
  });

  it("keeps a running pairing claimed through its post-expiry safety window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
      const pairing: AgentSetupPairingRecord = {
        id: "pair_test",
        projectId: "proj_test",
        projectName: "Test",
        createdByUserId: "user_test",
        ownerEmail: "owner@example.com",
        ownerName: "Owner",
        // The one-time token has expired, but this request claimed it one
        // minute ago and must remain protected against a replacement agent.
        expiresAt: "2026-08-14T11:59:00.000Z",
        claimedAt: "2026-08-14T11:59:00.000Z",
        consumedAt: null,
        revokedAt: null
      };
      expect(agentSetupPairingStatus(pairing)).toBe("claimed");
      expect(agentSetupPairingClaimExpiresAt(pairing)).toBe("2026-08-14T12:09:00.000Z");

      vi.setSystemTime(new Date("2026-08-14T12:09:00.001Z"));
      expect(agentSetupPairingStatus(pairing)).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns dashboard summary", async () => {
    const response = await createApp().request("/api/dashboard");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      project: { name: string };
      currentVersionResultCount: number;
      exceptions: unknown[];
    };
    expect(body.project.name).toBe("LangSmith Support Agent");
    expect(body.currentVersionResultCount).toBeGreaterThan(0);
    expect(body.exceptions.length).toBeGreaterThan(0);
  });

  it("updates demo retention settings and prunes with no-op result", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);

    const settingsResponse = await app.request("/api/project/settings");
    expect(settingsResponse.status).toBe(200);
    await expect(settingsResponse.json()).resolves.toMatchObject({
      projectId: "proj_langsmith_support",
      traceRetentionDays: null
    });

    const updateResponse = await app.request("/api/project/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceRetentionDays: 30 })
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({ traceRetentionDays: 30 });

    const pruneResponse = await app.request("/api/project/retention/prune", { method: "POST" });
    expect(pruneResponse.status).toBe(200);
    await expect(pruneResponse.json()).resolves.toMatchObject({
      deletedCases: 0,
      deletedRawTraces: 0
    });
  });

  it("exposes project mode on settings and judge-provider availability", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);

    const settings = await app.request("/api/project/settings");
    const settingsBody = (await settings.json()) as { mode: string };
    expect(settingsBody.mode).toBe("tracing");

    const providers = await app.request("/api/judge/providers");
    expect(providers.status).toBe(200);
    const providersBody = (await providers.json()) as {
      providers: Array<{ provider: string; available: boolean; label: string }>;
    };
    expect(providersBody.providers.find((provider) => provider.provider === "mock")?.available).toBe(true);
    expect(providersBody.providers.map((provider) => provider.provider).sort()).toEqual([
      "anthropic",
      "custom",
      "mock",
      "openai",
      "openrouter"
    ]);

    const models = await app.request("/api/judge/providers/mock/models");
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toEqual({
      provider: "mock",
      models: [{ id: "mock", label: "Mock heuristic", version: "mock", createdAt: null }]
    });
  });

  it("discovers OpenAI models through the same configured base URL as runtime", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "compatible-provider-key-app-test";
    process.env.OPENAI_BASE_URL = "https://models.example.test/v1/";
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      async json() { return { data: [{ id: "gpt-compatible", created: 1 }] }; }
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const app = createApp(new DemoRepository());
      const response = await app.request("/api/judge/providers/openai/models");

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://models.example.test/v1/models");
    } finally {
      vi.unstubAllGlobals();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  });
});
