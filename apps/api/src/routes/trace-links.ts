import type { Hono } from "hono";
import {
  ironsideTraceViewerUrl,
  parseTraceDeepLink,
  type CaseSourceLink,
  type TraceLinkConnection,
  type TraceLinkMatch,
  type TraceLinkResolution
} from "@rubrist/shared";
import type { RubristRepository, ImportedIronsideTraceMatch } from "../repository.js";
import type { AppVariables } from "../request-services/index.js";

type TraceLinkApp = Hono<{ Variables: AppVariables }>;

export interface TraceLinkRouteOptions {
  repository: RubristRepository;
  // Database-backed auth mode: membership comes from the session user.
  authMode: boolean;
}

// Session-only, read-only navigation between Rubrist and Ironside. These
// routes resolve identities that already exist; they never import, write
// back, or create evidence. The deep-link resolver deliberately spans the
// caller's project memberships, so it is exempt from the single-project pin
// in the /api/* middleware and filters by membership itself.
export function registerTraceLinkRoutes(app: TraceLinkApp, options: TraceLinkRouteOptions): void {
  const { repository } = options;

  app.get("/api/links/trace", async (c) => {
    c.header("cache-control", "no-store");
    const parsed = parseTraceDeepLink(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: parsed.error, code: parsed.code }, 400);
    const { project: remoteProjectId, trace: traceId, version } = parsed.query;

    const user = c.get("user");
    if (options.authMode && !user) return c.json({ error: "Unauthorized" }, 401);
    // Demo mode has no session: scope to the single project the middleware
    // selected rather than to every stored project.
    const projects = options.authMode
      ? await repository.listProjects(user!.id)
      : (await repository.listProjects()).filter((project) => project.id === c.get("projectId"));
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));

    const found = await repository.findImportedIronsideTraces({
      projectIds: projects.map((project) => project.id),
      remoteProjectId,
      traceId
    });
    const inMembership = found.filter((match) => projectNames.has(match.projectId));
    const toMatch = (match: ImportedIronsideTraceMatch, versionCount: number): TraceLinkMatch => ({
      projectId: match.projectId,
      projectName: projectNames.get(match.projectId) ?? match.projectId,
      caseId: match.caseId,
      traceVersion: match.traceVersion,
      importedAt: match.importedAt,
      importedVersionCount: versionCount
    });

    const byProject = new Map<string, ImportedIronsideTraceMatch[]>();
    for (const match of inMembership) {
      const list = byProject.get(match.projectId) ?? [];
      list.push(match);
      byProject.set(match.projectId, list);
    }

    const matches: TraceLinkMatch[] = [];
    const otherVersions: TraceLinkMatch[] = [];
    for (const [, list] of byProject) {
      const newestFirst = [...list].sort(newestVersionFirst);
      if (version === undefined) {
        matches.push(toMatch(newestFirst[0]!, newestFirst.length));
        continue;
      }
      const exact = newestFirst.find((match) => match.traceVersion === version);
      if (exact) matches.push(toMatch(exact, 1));
      else otherVersions.push(...newestFirst.map((match) => toMatch(match, newestFirst.length)));
    }
    matches.sort(byProjectOrder(projects.map((project) => project.id)));

    const connections: TraceLinkConnection[] = [];
    for (const project of projects) {
      for (const integration of await repository.listIronsideIntegrations(project.id)) {
        if (integration.remoteProjectId !== remoteProjectId) continue;
        connections.push({
          projectId: project.id,
          projectName: project.name,
          integrationId: integration.id,
          skillVersionId: integration.skillVersionId,
          pollLimit: integration.pollLimit,
          revalidationRequired: integration.revalidationRequired,
          pollEnabled: integration.pollEnabled
        });
      }
    }

    const result: TraceLinkResolution = {
      source: "ironside",
      remoteProjectId,
      traceId,
      traceVersion: version ?? null,
      status: matches.length === 0 ? "not_imported" : matches.length === 1 ? "resolved" : "ambiguous",
      matches,
      otherVersions: matches.length === 0 ? otherVersions : [],
      connections
    };
    return c.json(result);
  });

  // Where an imported native Ironside case came from, plus its viewer URL
  // built from the project's current connection to that remote project.
  app.get("/api/cases/:caseId/source-link", async (c) => {
    const projectId = c.get("projectId");
    const identity = await repository.getCaseSourceIdentity(projectId, c.req.param("caseId"));
    if (!identity) return c.json({ error: "Case not found" }, 404);
    if (identity.source !== "ironside" || !identity.sourceRemoteProjectId) {
      const none: CaseSourceLink = { ironside: null };
      return c.json(none);
    }
    const remoteProjectId = identity.sourceRemoteProjectId;
    const integration = (await repository.listIronsideIntegrations(projectId))
      .find((candidate) => candidate.remoteProjectId === remoteProjectId);
    const base = integration ? integration.webUrl ?? integration.url : null;
    const result: CaseSourceLink = {
      ironside: {
        remoteProjectId,
        traceId: identity.sourceTraceId,
        traceVersion: identity.sourceTraceVersion,
        viewerUrl: base ? ironsideTraceViewerUrl(base, remoteProjectId, identity.sourceTraceId) : null
      }
    };
    return c.json(result);
  });
}

// Ironside trace versions are ISO instants; compare them as instants, then
// fall back to import time for anything unparseable.
function newestVersionFirst(left: ImportedIronsideTraceMatch, right: ImportedIronsideTraceMatch): number {
  const leftVersion = left.traceVersion ? Date.parse(left.traceVersion) : Number.NaN;
  const rightVersion = right.traceVersion ? Date.parse(right.traceVersion) : Number.NaN;
  if (Number.isFinite(leftVersion) && Number.isFinite(rightVersion) && leftVersion !== rightVersion) {
    return rightVersion - leftVersion;
  }
  if (Number.isFinite(leftVersion) !== Number.isFinite(rightVersion)) return Number.isFinite(leftVersion) ? -1 : 1;
  return Date.parse(right.importedAt) - Date.parse(left.importedAt);
}

function byProjectOrder(order: string[]): (left: TraceLinkMatch, right: TraceLinkMatch) => number {
  return (left, right) => order.indexOf(left.projectId) - order.indexOf(right.projectId);
}
