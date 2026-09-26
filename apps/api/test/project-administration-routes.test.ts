import { Hono } from "hono";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionFetch } from "@rubrist/audit/runtime";
import { createApp, agentSetupPairingClaimExpiresAt, agentSetupPairingStatus } from "../src/app.js";
import type { AgentSetupPairingRecord } from "../src/lib/auth.js";
import { bindingResolutionServices } from "../src/lib/binding-resolution.js";
import { DemoRepository } from "../src/repository.js";
import { CAPABILITY_CHECKS_PER_MINUTE, createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { CAPABILITY_CHECKS_IN_FLIGHT, registerProjectAdministrationRoutes } from "../src/routes/project-administration.js";

const OPUS_CHECK = { provider: "anthropic", endpoint: { kind: "managed" }, modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", outputTokenLimit: 1_200, routing: null };

/** The route family alone, in a project, with provider calls answered by `fetch`. */
function checkApp(fetch: ExecutionFetch, options: { pool?: Pool } = {}) {
  const repository = new DemoRepository();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(async (c, next) => {
    c.set("projectId", "project");
    await next();
  });
  registerProjectAdministrationRoutes(app, {
    repository,
    ...options,
    requestServices: createRequestServices({ repository, ownerAuthorizationEnabled: false, rateLimitPerMinute: 60, batchMaxItems: 100 }),
    publicApiBaseUrl: () => "https://rubrist.example",
    bindingResolution: bindingResolutionServices(async () => "sk-project", {
      fetch,
      capabilityFetch: async () => new Response("{}", { status: 404 })
    })
  });
  return (body: unknown) => app.request("/api/judge/capability-check", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
}

const acceptedVerdict = () => new Response(JSON.stringify({
  id: "msg", model: "claude-opus-5-5", stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ label: "pass", score: 0.9, rationale: "ok" }) }], usage: { input_tokens: 1, output_tokens: 1 }
}));

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
      publicApiBaseUrl: () => "https://rubrist.example",
      bindingResolution: bindingResolutionServices(async () => null)
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/projects",
      "POST /api/projects",
      "POST /api/agent-setup/pairings",
      "GET /api/agent-setup/pairings/:pairingId",
      "DELETE /api/agent-setup/pairings/:pairingId",
      "GET /api/judge/providers",
      "GET /api/judge/providers/:provider/models",
      "POST /api/judge/capability-check",
      "GET /api/project/settings",
      "PATCH /api/project/settings",
      "POST /api/project/retention/prune",
      "DELETE /api/project",
      "GET /api/dashboard",
      "GET /api/onboarding/evidence-inventory"
    ]);
  });

  it("checks a model's capabilities before save, refusing without a key", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const app = createApp(new DemoRepository(), { bindingResolution: bindingResolutionServices(async () => null) });
      const check = (body: unknown) => app.request("/api/judge/capability-check", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
      const mock = await check({ provider: "mock", endpoint: { kind: "managed" }, modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1", outputTokenLimit: null, routing: null });
      expect(mock.status).toBe(200);
      await expect(mock.json()).resolves.toMatchObject({ report: { credentialSource: "built_in", protocol: "mock/v1", probes: [{ purpose: "protocol", outcome: "accepted" }] } });
      const keyless = await check({ provider: "anthropic", endpoint: { kind: "managed" }, modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", outputTokenLimit: 1_200, routing: null });
      expect(keyless.status).toBe(409);
      await expect(keyless.json()).resolves.toEqual({ error: "Configure a key for anthropic before checking its models." });
      expect((await check({ provider: "anthropic", modelId: "claude-opus-5-5" })).status).toBe(400);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("refuses a check no saved binding could make, before any call", async () => {
    const urls: string[] = [];
    const check = checkApp(async (url) => {
      urls.push(url);
      return acceptedVerdict();
    }, { pool: {} as Pool });
    const elsewhere = await check({ ...OPUS_CHECK, provider: "openai", endpoint: { kind: "custom", baseUrl: "https://attacker.example/v1" }, outputTokenLimit: null });
    expect(elsewhere.status).toBe(400);
    expect((await check({ ...OPUS_CHECK, outputTokenLimit: null })).status).toBe(400);
    const mock = await check({ provider: "mock", endpoint: { kind: "managed" }, modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1", outputTokenLimit: null, routing: null });
    expect(mock.status).toBe(400);
    await expect(mock.json()).resolves.toEqual({ error: "The mock provider has no capabilities to check." });
    expect(urls).toEqual([]);
  });

  it("limits how many checks an owner starts, and how many a project runs at once", async () => {
    const limited = checkApp(async () => acceptedVerdict());
    for (let started = 0; started < CAPABILITY_CHECKS_PER_MINUTE; started += 1) {
      expect((await limited(OPUS_CHECK)).status).toBe(200);
    }
    const over = await limited(OPUS_CHECK);
    expect(over.status).toBe(429);
    await expect(over.json()).resolves.toEqual({ error: `Rate limit exceeded: ${CAPABILITY_CHECKS_PER_MINUTE} capability checks/minute.` });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = checkApp(async () => {
      await held;
      return acceptedVerdict();
    });
    const running = Array.from({ length: CAPABILITY_CHECKS_IN_FLIGHT }, () => slow(OPUS_CHECK));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const busy = await slow(OPUS_CHECK);
    expect(busy.status).toBe(429);
    await expect(busy.json()).resolves.toEqual({ error: "A capability check for this project is already running. Retry when it finishes." });
    release();
    expect((await Promise.all(running)).map((response) => response.status)).toEqual([200, 200]);
    expect((await slow(OPUS_CHECK)).status).toBe(200);
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
      "openrouter",
      "typesafe"
    ]);

    // TypeSafe has no model catalog: a typed-question model is named exactly.
    const typesafeModels = await app.request("/api/judge/providers/typesafe/models");
    expect(typesafeModels.status).toBe(400);
    await expect(typesafeModels.json()).resolves.toEqual({ error: "TypeSafe models are entered by name" });

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
