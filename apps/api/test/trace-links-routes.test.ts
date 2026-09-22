import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { demoProject } from "@coeval/db";
import {
  ironsideTraceViewerUrl,
  parseTraceDeepLink,
  traceDeepLinkPath,
  type IronsideIntegration,
  type Project,
  type TraceLinkResolution
} from "@coeval/shared";
import { createApp } from "../src/app.js";
import type { IronsideTraceSource } from "../src/lib/ironside.js";
import { DemoRepository, type CoevalRepository, type ImportedIronsideTraceMatch } from "../src/repository.js";
import type { AppVariables } from "../src/request-services/index.js";
import { registerTraceLinkRoutes } from "../src/routes/trace-links.js";

function ironsideClient(remoteProjectId = "remote_agents"): IronsideTraceSource {
  return {
    async getContext() {
      return {
        protocolVersion: "ironside/evaluator/v1",
        project: { id: remoteProjectId, name: "Production agents" },
        capabilities: ["traces:read", "scores:write"],
        settlement: { kind: "quiet_period", quietPeriodSeconds: 120 }
      };
    },
    async listTraces() {
      return { protocolVersion: "ironside/evaluator/v1", traces: [], nextCursor: "cursor_empty", hasMore: false };
    },
    async getTrace() {
      throw new Error("not used");
    }
  };
}

async function importIronside(
  repository: DemoRepository,
  input: { traceId: string; version: string; remoteProjectId?: string; integrationId?: string }
): Promise<string> {
  const result = await repository.importTrace(demoProject.id, "ironside", {
    sourceTraceId: input.traceId,
    input: { question: "Refund?" },
    output: { answer: "Thirty days." },
    metadata: {}
  }, {
    ingestionPurpose: "analysis_eligible_ironside",
    sourceIntegrationId: input.integrationId,
    sourceTraceVersion: input.version,
    sourceRemoteProjectId: input.remoteProjectId ?? "remote_agents"
  });
  return result.caseId;
}

async function connectedDemoApp(options: { webUrl?: string } = {}) {
  const repository = new DemoRepository();
  const app = createApp(repository, { ironsideClientFactory: () => ironsideClient() });
  const response = await app.request("/api/integrations/ironside", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://ironside-api.example.com/",
      apiKey: "ironside_sc_secret",
      pollEnabled: false,
      ...(options.webUrl ? { webUrl: options.webUrl } : {})
    })
  });
  expect(response.status).toBe(201);
  const { integration } = await response.json() as { integration: IronsideIntegration };
  return { repository, app, integration };
}

describe("trace deep-link contract", () => {
  it("parses exactly the shared Ironside link shape", () => {
    const params = new URLSearchParams("source=ironside&project=remote_agents&trace=tr_1&version=2026-09-01T10:00:00.000Z&utm=x");
    expect(parseTraceDeepLink(params)).toEqual({
      ok: true,
      query: { source: "ironside", project: "remote_agents", trace: "tr_1", version: "2026-09-01T10:00:00.000Z" }
    });
    expect(parseTraceDeepLink(new URLSearchParams("source=ironside&project=p&trace=t&version="))).toEqual({
      ok: true,
      query: { source: "ironside", project: "p", trace: "t" }
    });
    expect(traceDeepLinkPath({ source: "ironside", project: "p 1", trace: "t/1", version: "2026-09-01T10:00:00Z" }))
      .toBe("/links/trace?source=ironside&project=p+1&trace=t%2F1&version=2026-09-01T10%3A00%3A00Z");
  });

  it("rejects unknown sources, missing or malformed fields, and repeated parameters", () => {
    expect(parseTraceDeepLink(new URLSearchParams("source=langfuse&project=p&trace=t"))).toMatchObject({ ok: false, code: "unsupported_source" });
    expect(parseTraceDeepLink(new URLSearchParams("project=p&trace=t"))).toMatchObject({ ok: false, code: "invalid_link" });
    expect(parseTraceDeepLink(new URLSearchParams("source=ironside&project=p"))).toMatchObject({ ok: false, code: "invalid_link" });
    expect(parseTraceDeepLink(new URLSearchParams("source=ironside&project=p&trace=t&version=yesterday"))).toMatchObject({ ok: false, code: "invalid_link" });
    expect(parseTraceDeepLink(new URLSearchParams("source=ironside&project=%20p&trace=t"))).toMatchObject({ ok: false, code: "invalid_link" });
    expect(parseTraceDeepLink(new URLSearchParams("source=ironside&project=p&trace=t%00x"))).toMatchObject({ ok: false, code: "invalid_link" });
    expect(parseTraceDeepLink(new URLSearchParams(`source=ironside&project=p&trace=${"x".repeat(501)}`))).toMatchObject({ ok: false, code: "invalid_link" });
    expect(parseTraceDeepLink(new URLSearchParams("source=ironside&project=p&trace=a&trace=b"))).toMatchObject({ ok: false, code: "invalid_link" });
  });

  it("builds Ironside viewer URLs from one pattern and refuses non-http bases", () => {
    expect(ironsideTraceViewerUrl("https://ironside.example.com/", "proj 1", "trace/1"))
      .toBe("https://ironside.example.com/projects/proj%201/traces/trace%2F1");
    expect(ironsideTraceViewerUrl("https://example.com/ironside/", "p", "t"))
      .toBe("https://example.com/ironside/projects/p/traces/t");
    expect(ironsideTraceViewerUrl("javascript:alert(1)", "p", "t")).toBeNull();
    expect(ironsideTraceViewerUrl("not a url", "p", "t")).toBeNull();
  });
});

describe("trace link routes", () => {
  it("owns exactly the deep-link resolver and case source-link reads", () => {
    const app = new Hono<{ Variables: AppVariables }>();
    registerTraceLinkRoutes(app, { repository: new DemoRepository(), authMode: false });
    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/links/trace",
      "GET /api/cases/:caseId/source-link"
    ]);
  });

  it("answers invalid links with a 400 and a stable code", async () => {
    const app = createApp(new DemoRepository());
    const unknown = await app.request("/api/links/trace?source=datadog&project=p&trace=t");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "unsupported_source" });
    const invalid = await app.request("/api/links/trace?source=ironside&project=p");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_link" });
  });

  it("reports a not-yet-imported trace with the existing connection's import action", async () => {
    const { app, integration } = await connectedDemoApp();
    const response = await app.request("/api/links/trace?source=ironside&project=remote_agents&trace=tr_missing");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as TraceLinkResolution;
    expect(body).toMatchObject({
      status: "not_imported",
      remoteProjectId: "remote_agents",
      traceId: "tr_missing",
      traceVersion: null,
      matches: [],
      otherVersions: []
    });
    expect(body.connections).toEqual([{
      projectId: demoProject.id,
      projectName: demoProject.name,
      integrationId: integration.id,
      skillVersionId: integration.skillVersionId,
      pollLimit: integration.pollLimit,
      revalidationRequired: false,
      pollEnabled: false
    }]);

    const unconnected = await app.request("/api/links/trace?source=ironside&project=remote_other&trace=tr_missing");
    expect((await unconnected.json() as TraceLinkResolution).connections).toEqual([]);
  });

  it("resolves the exact version, the newest version when none is named, and never aliases remote projects", async () => {
    const { app, repository, integration } = await connectedDemoApp();
    const older = await importIronside(repository, { traceId: "tr_1", version: "2026-09-01T10:00:00.000Z", integrationId: integration.id });
    const newer = await importIronside(repository, { traceId: "tr_1", version: "2026-09-02T10:00:00.000Z", integrationId: integration.id });
    await importIronside(repository, { traceId: "tr_1", version: "2026-09-03T10:00:00.000Z", remoteProjectId: "remote_other" });

    const latest = await (await app.request("/api/links/trace?source=ironside&project=remote_agents&trace=tr_1")).json() as TraceLinkResolution;
    expect(latest.status).toBe("resolved");
    expect(latest.matches).toEqual([expect.objectContaining({
      projectId: demoProject.id,
      caseId: newer,
      traceVersion: "2026-09-02T10:00:00.000Z",
      importedVersionCount: 2
    })]);

    const exact = await (await app.request(
      `/api/links/trace?${new URLSearchParams({ source: "ironside", project: "remote_agents", trace: "tr_1", version: "2026-09-01T10:00:00.000Z" })}`
    )).json() as TraceLinkResolution;
    expect(exact.status).toBe("resolved");
    expect(exact.matches.map((match) => match.caseId)).toEqual([older]);

    const missingVersion = await (await app.request(
      `/api/links/trace?${new URLSearchParams({ source: "ironside", project: "remote_agents", trace: "tr_1", version: "2026-09-05T10:00:00.000Z" })}`
    )).json() as TraceLinkResolution;
    expect(missingVersion.status).toBe("not_imported");
    expect(missingVersion.otherVersions.map((match) => match.caseId)).toEqual([newer, older]);
  });

  it("links an imported case back to Ironside, preferring the web URL over the API URL", async () => {
    const { app, repository, integration } = await connectedDemoApp();
    const caseId = await importIronside(repository, { traceId: "tr/1", version: "2026-09-01T10:00:00.000Z", integrationId: integration.id });

    const fallback = await (await app.request(`/api/cases/${caseId}/source-link`)).json();
    expect(fallback).toEqual({
      ironside: {
        remoteProjectId: "remote_agents",
        traceId: "tr/1",
        traceVersion: "2026-09-01T10:00:00.000Z",
        viewerUrl: "https://ironside-api.example.com/projects/remote_agents/traces/tr%2F1"
      }
    });

    const rejected = await app.request(`/api/integrations/ironside/${integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webUrl: "javascript:alert(1)" })
    });
    expect(rejected.status).toBe(400);

    const patched = await app.request(`/api/integrations/ironside/${integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webUrl: "https://ironside.example.com" })
    });
    expect(patched.status).toBe(200);
    expect((await patched.json() as { integration: IronsideIntegration }).integration.webUrl).toBe("https://ironside.example.com");
    const preferred = await (await app.request(`/api/cases/${caseId}/source-link`)).json() as { ironside: { viewerUrl: string } };
    expect(preferred.ironside.viewerUrl).toBe("https://ironside.example.com/projects/remote_agents/traces/tr%2F1");

    const cleared = await app.request(`/api/integrations/ironside/${integration.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webUrl: null })
    });
    expect((await cleared.json() as { integration: IronsideIntegration }).integration.webUrl).toBeNull();

    await app.request(`/api/integrations/ironside/${integration.id}`, { method: "DELETE" });
    const disconnected = await (await app.request(`/api/cases/${caseId}/source-link`)).json() as { ironside: { viewerUrl: string | null } };
    expect(disconnected.ironside.viewerUrl).toBeNull();
  });

  it("stores a web URL given at connection time", async () => {
    const { integration } = await connectedDemoApp({ webUrl: "https://ironside.example.com" });
    expect(integration.webUrl).toBe("https://ironside.example.com");
  });

  it("returns no Ironside link for other sources and 404 for unknown cases", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const manual = await repository.importTrace(demoProject.id, "manual", {
      input: { question: "Hi" },
      output: { answer: "Hello" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    expect(await (await app.request(`/api/cases/${manual.caseId}/source-link`)).json()).toEqual({ ironside: null });
    expect((await app.request("/api/cases/case_missing/source-link")).status).toBe(404);
  });
});

describe("trace link membership resolution", () => {
  const projects: Project[] = ["proj_a", "proj_b"].map((id) => ({
    id,
    name: id === "proj_a" ? "Alpha" : "Beta",
    mode: "tracing",
    traceProvider: "ironside",
    importedTraceCount: 1,
    autoJudgedTraceCount: 0,
    syncBackCoverage: 0,
    traceRetentionDays: null,
    updatedAt: "2026-09-01T00:00:00.000Z"
  }));

  function sessionApp(options: { user: boolean; found: ImportedIronsideTraceMatch[]; seen?: string[][] }) {
    const repository = {
      async listProjects(userId?: string) {
        expect(userId).toBe("user_1");
        return projects;
      },
      async findImportedIronsideTraces(input: { projectIds: readonly string[] }) {
        options.seen?.push([...input.projectIds]);
        return options.found;
      },
      async listIronsideIntegrations() {
        return [];
      }
    } as unknown as CoevalRepository;
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("user", options.user ? { id: "user_1", email: "u@example.com", name: "U" } : null);
      c.set("projectId", "");
      await next();
    });
    registerTraceLinkRoutes(app, { repository, authMode: true });
    return app;
  }

  const match = (projectId: string, caseId: string): ImportedIronsideTraceMatch => ({
    projectId,
    caseId,
    traceVersion: "2026-09-01T10:00:00.000Z",
    importedAt: "2026-09-01T10:05:00.000Z"
  });

  it("requires a session in database-backed auth mode", async () => {
    const app = sessionApp({ user: false, found: [] });
    expect((await app.request("/api/links/trace?source=ironside&project=p&trace=t")).status).toBe(401);
  });

  it("asks the user to pick when several member projects hold the trace", async () => {
    const seen: string[][] = [];
    const app = sessionApp({ user: true, found: [match("proj_b", "case_b"), match("proj_a", "case_a")], seen });
    const body = await (await app.request("/api/links/trace?source=ironside&project=p&trace=t")).json() as TraceLinkResolution;
    expect(seen).toEqual([["proj_a", "proj_b"]]);
    expect(body.status).toBe("ambiguous");
    expect(body.matches.map((entry) => [entry.projectName, entry.caseId])).toEqual([["Alpha", "case_a"], ["Beta", "case_b"]]);
  });

  it("ignores any match outside the caller's memberships", async () => {
    const app = sessionApp({ user: true, found: [match("proj_a", "case_a"), match("proj_foreign", "case_x")] });
    const body = await (await app.request("/api/links/trace?source=ironside&project=p&trace=t")).json() as TraceLinkResolution;
    expect(body.status).toBe("resolved");
    expect(body.matches.map((entry) => entry.caseId)).toEqual(["case_a"]);
  });
});
