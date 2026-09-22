import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceLinkConnection, TraceLinkMatch, TraceLinkResolution } from "@coeval/shared";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/components/coeval", () => ({
  EmptyGlyph: () => createElement("i"),
  EmptyShell: ({ eyebrow, title, body, primary }: { eyebrow?: string; title: string; body?: unknown; primary?: unknown }) =>
    createElement("section", null, eyebrow, createElement("h1", null, title), body as never, primary as never)
}));

const { caseHref, connectionSyncBlocker, traceLinkOutcome } = await import("../src/lib/trace-link.js");
const { TraceLinkView } = await import("../src/screens/trace-link.js");
const { ViewInIronsideLink } = await import("../src/components/view-in-ironside.js");
const { fetchCaseSourceLink, resolveTraceLink, syncIronsideConnection } = await import("../src/lib/trace-link-api.js");

const query = { source: "ironside" as const, project: "remote_agents", trace: "tr_1" };

function match(projectId: string, caseId: string): TraceLinkMatch {
  return {
    projectId,
    projectName: projectId === "proj_a" ? "Alpha" : "Beta",
    caseId,
    traceVersion: "2026-09-01T10:00:00.000Z",
    importedAt: "2026-09-01T10:05:00.000Z",
    importedVersionCount: 1
  };
}

const connection: TraceLinkConnection = {
  projectId: "proj_a",
  projectName: "Alpha",
  integrationId: "int_1",
  skillVersionId: "skillv_1",
  pollLimit: 25,
  revalidationRequired: false,
  pollEnabled: true
};

function resolution(overrides: Partial<TraceLinkResolution>): TraceLinkResolution {
  return {
    source: "ironside",
    remoteProjectId: "remote_agents",
    traceId: "tr_1",
    traceVersion: null,
    status: "not_imported",
    matches: [],
    otherVersions: [],
    connections: [],
    ...overrides
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trace link outcome", () => {
  it("opens a single match, asks to pick among several, and otherwise reports not imported", () => {
    const one = match("proj_a", "case_a");
    expect(traceLinkOutcome(resolution({ status: "resolved", matches: [one] }))).toEqual({ kind: "open", match: one });
    expect(traceLinkOutcome(resolution({ status: "ambiguous", matches: [one, match("proj_b", "case_b")] })).kind).toBe("pick");
    expect(traceLinkOutcome(resolution({ connections: [connection] }))).toEqual({
      kind: "not_imported",
      otherVersions: [],
      connections: [connection]
    });
    expect(caseHref({ caseId: "case/1" })).toBe("/cases/case%2F1");
  });

  it("only offers a sync when the existing connection can import on its own binding", () => {
    expect(connectionSyncBlocker(connection)).toBeNull();
    expect(connectionSyncBlocker({ ...connection, revalidationRequired: true })).toContain("tested successfully");
    expect(connectionSyncBlocker({ ...connection, skillVersionId: null })).toContain("no polling criterion");
  });
});

describe("trace link page", () => {
  it("lets the user choose between projects", () => {
    const html = renderToStaticMarkup(createElement(TraceLinkView, {
      query,
      resolution: resolution({ status: "ambiguous", matches: [match("proj_a", "case_a"), match("proj_b", "case_b")] }),
      error: null,
      onRetry: () => {}
    }));
    expect(html).toContain("This trace is imported in more than one of your projects.");
    expect(html).toContain("Open in Alpha");
    expect(html).toContain("Open in Beta");
  });

  it("explains a not-yet-imported trace and offers the existing connection's import", () => {
    const html = renderToStaticMarkup(createElement(TraceLinkView, {
      query: { ...query, version: "2026-09-02T10:00:00.000Z" },
      resolution: resolution({ connections: [connection], otherVersions: [match("proj_a", "case_old")] }),
      error: null,
      onRetry: () => {}
    }));
    expect(html).toContain("This trace version hasn&#x27;t been imported into Coeval yet.");
    expect(html).toContain("after Ironside&#x27;s quiet period ends");
    expect(html).toContain("Other imported versions of this trace");
    expect(html).toContain("Open this version");
    expect(html).toContain("Import now");
    expect(html).toContain("version 2026-09-02T10:00:00.000Z");
  });

  it("explains how import happens when no project is connected to that Ironside project", () => {
    const html = renderToStaticMarkup(createElement(TraceLinkView, {
      query,
      resolution: resolution({}),
      error: null,
      onRetry: () => {}
    }));
    expect(html).toContain("None of your Coeval projects is connected to Ironside project");
    expect(html).toContain("Integrations → Connect Ironside");
    expect(html).not.toContain("Import now");
  });

  it("is a top-level route outside the project-scoped layout", async () => {
    const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
    const linkRoute = app.indexOf('path: "links/trace"');
    expect(linkRoute).toBeGreaterThan(-1);
    expect(linkRoute).toBeLessThan(app.indexOf("element: <RootLayout />"));
  });
});

describe("View in Ironside", () => {
  it("links to the viewer URL in a new tab without an opener", () => {
    const html = renderToStaticMarkup(createElement(ViewInIronsideLink, {
      link: { ironside: { remoteProjectId: "p", traceId: "t", traceVersion: null, viewerUrl: "https://ironside.example.com/projects/p/traces/t" } }
    }));
    expect(html).toContain('href="https://ironside.example.com/projects/p/traces/t"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("View in Ironside");
  });

  it("renders nothing for other sources and a note when no connection supplies a URL", () => {
    expect(renderToStaticMarkup(createElement(ViewInIronsideLink, { link: { ironside: null } }))).toBe("");
    expect(renderToStaticMarkup(createElement(ViewInIronsideLink, {
      link: { ironside: { remoteProjectId: "p", traceId: "t", traceVersion: null, viewerUrl: null } }
    }))).toContain("no current connection");
  });
});

describe("trace link clients", () => {
  it("resolves a link through the membership-wide endpoint", async () => {
    const body = resolution({ status: "resolved", matches: [match("proj_a", "case_a")] });
    const fetchMock = vi.fn(async () => json(body));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { getItem: () => null });
    await expect(resolveTraceLink({ ...query, version: "2026-09-01T10:00:00.000Z" })).resolves.toEqual(body);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/links/trace?source=ironside&project=remote_agents&trace=tr_1&version=2026-09-01T10%3A00%3A00.000Z");
  });

  it("reads a case source link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ironside: null })));
    vi.stubGlobal("localStorage", { getItem: () => "proj_a" });
    await expect(fetchCaseSourceLink("case_a")).resolves.toEqual({ ironside: null });
  });

  it("syncs with the connection's project and polling binding without switching projects", async () => {
    const importJob = {
      id: "import_1",
      projectId: "proj_a",
      source: "ironside",
      sourceIntegrationId: "int_1",
      skillVersionId: "skillv_1",
      actorUserId: null,
      actorEmail: null,
      actorName: null,
      queueJobId: "job_1",
      status: "queued",
      requestedLimit: 25,
      importedCount: 0,
      queuedJudgeCount: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      error: null
    };
    const fetchMock = vi.fn(async () => json({ queued: true, queueJobId: "job_1", importJob }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncIronsideConnection(connection)).resolves.toMatchObject({ queued: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/integrations/ironside/int_1/import");
    expect(new Headers(init.headers).get("x-coeval-project")).toBe("proj_a");
    expect(JSON.parse(String(init.body))).toEqual({ limit: 25, skillVersionId: "skillv_1" });
    await expect(syncIronsideConnection({ ...connection, skillVersionId: null })).rejects.toThrow("no polling criterion");
  });
});
