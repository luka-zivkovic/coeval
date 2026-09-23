import { expect, it } from "vitest";

import { runMigrations } from "@rubrist/db";
import type { TraceLinkResolution } from "@rubrist/shared";

import { createApp, type RubristApi } from "../src/app.js";
import { createAuth } from "../src/lib/auth.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke } from "./pg-smoke-support.js";

const remote = (remoteProjectId: string) => ({
  protocolVersion: "ironside/evaluator/v1" as const,
  project: { id: remoteProjectId, name: remoteProjectId },
  capabilities: ["traces:read", "scores:write"],
  settlement: { kind: "quiet_period" as const, quietPeriodSeconds: 0 }
});

const traceInput = {
  sourceTraceId: "tr_linked",
  input: { question: "Refund?" },
  output: { answer: "Within 30 days." },
  metadata: { source: "ironside" }
};

runPgSmoke("PgRepository trace links", () => {
  it("finds imported Ironside traces by source identity within the given projects only", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("pg_trace_links_find");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      for (const id of ["proj_a", "proj_b", "proj_c"]) {
        await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ($1, 'org_test', $1, 'ironside')`, [id]);
      }
      const context = (sourceRemoteProjectId: string, sourceTraceVersion: string) => ({
        ingestionPurpose: "analysis_eligible_ironside" as const,
        sourceRemoteProjectId,
        sourceTraceVersion
      });
      const a1 = await repo.importTrace("proj_a", "ironside", traceInput, context("remote_1", "2026-09-01T10:00:00.000Z"));
      const a2 = await repo.importTrace("proj_a", "ironside", traceInput, context("remote_1", "2026-09-02T10:00:00.000Z"));
      await repo.importTrace("proj_a", "ironside", traceInput, context("remote_1", "2026-09-02T10:00:00.000Z"));
      const b1 = await repo.importTrace("proj_b", "ironside", traceInput, context("remote_1", "2026-09-01T10:00:00.000Z"));
      await repo.importTrace("proj_b", "ironside", traceInput, context("remote_2", "2026-09-01T10:00:00.000Z"));
      await repo.importTrace("proj_c", "ironside", traceInput, context("remote_1", "2026-09-01T10:00:00.000Z"));
      await repo.importTrace("proj_a", "manual", traceInput, { ingestionPurpose: "analysis_eligible_manual" });

      const found = await repo.findImportedIronsideTraces({
        projectIds: ["proj_a", "proj_b"],
        remoteProjectId: "remote_1",
        traceId: "tr_linked"
      });
      expect(found.map(({ projectId, caseId, traceVersion }) => ({ projectId, caseId, traceVersion }))
        .sort((left, right) => `${left.projectId}${left.traceVersion}`.localeCompare(`${right.projectId}${right.traceVersion}`)))
        .toEqual([
          { projectId: "proj_a", caseId: a1.caseId, traceVersion: "2026-09-01T10:00:00.000Z" },
          { projectId: "proj_a", caseId: a2.caseId, traceVersion: "2026-09-02T10:00:00.000Z" },
          { projectId: "proj_b", caseId: b1.caseId, traceVersion: "2026-09-01T10:00:00.000Z" }
        ]);
      expect(found.every((match) => !Number.isNaN(Date.parse(match.importedAt)))).toBe(true);
      await expect(repo.findImportedIronsideTraces({ projectIds: [], remoteProjectId: "remote_1", traceId: "tr_linked" }))
        .resolves.toEqual([]);

      await expect(repo.getCaseSourceIdentity("proj_a", a2.caseId)).resolves.toEqual({
        source: "ironside",
        sourceTraceId: "tr_linked",
        sourceTraceVersion: "2026-09-02T10:00:00.000Z",
        sourceRemoteProjectId: "remote_1",
        sourceIntegrationId: null
      });
      await expect(repo.getCaseSourceIdentity("proj_b", a2.caseId)).resolves.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("stores, replaces, and clears the optional Ironside web URL without touching connection identity", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-trace-links-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_trace_links_web_url");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      const created = await repo.createIronsideIntegration("proj_test", {
        url: "https://ironside-api.example",
        webUrl: "https://ironside.example",
        apiKey: "key_a"
      }, remote("remote_a"));
      expect(created.webUrl).toBe("https://ironside.example");
      const expected = { remoteProjectId: "remote_a", revalidationRequired: false, connectionRevision: 1 };

      const replaced = await repo.updateIronsideIntegration("proj_test", created.id, { webUrl: "https://app.ironside.example" }, undefined, expected);
      expect(replaced).toMatchObject({ webUrl: "https://app.ironside.example", url: "https://ironside-api.example", remoteProjectId: "remote_a" });
      const untouched = await repo.updateIronsideIntegration("proj_test", created.id, { pollEnabled: false }, undefined, expected);
      expect(untouched.webUrl).toBe("https://app.ironside.example");
      const cleared = await repo.updateIronsideIntegration("proj_test", created.id, { webUrl: null }, undefined, expected);
      expect(cleared.webUrl).toBeNull();
      await expect(repo.loadIronsideImportContext({ projectId: "proj_test", integrationId: created.id, limit: 1 }))
        .resolves.toMatchObject({ webUrl: null, connectionRevision: 1 });
    } finally {
      await cleanup();
    }
  });

  it("resolves a deep link across the signed-in user's memberships and nobody else's", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-trace-links-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_trace_links_auth");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const app = createApp(repo, { pool, auth: createAuth(pool) });
      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "owner-password", name: "Owner", projectName: "Alpha", mode: "bench" })
      });
      expect(setup.status).toBe(200);
      const { projectId: alpha } = await setup.json() as { projectId: string };
      const cookie = await signIn(app, "owner@example.com", "owner-password");
      const second = await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Beta" })
      });
      expect(second.status).toBe(201);
      const { projectId: beta } = await second.json() as { projectId: string };
      await pool.query(`insert into organizations (id, name) values ('org_other', 'Other')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_foreign', 'org_other', 'Foreign', 'ironside')`);

      const context = {
        ingestionPurpose: "analysis_eligible_ironside" as const,
        sourceRemoteProjectId: "remote_1",
        sourceTraceVersion: "2026-09-01T10:00:00.000Z"
      };
      const inAlpha = await repo.importTrace(alpha, "ironside", traceInput, context);
      await repo.importTrace("proj_foreign", "ironside", traceInput, context);
      const link = "/api/links/trace?source=ironside&project=remote_1&trace=tr_linked";

      expect((await app.request(link)).status).toBe(401);
      const single = await (await app.request(link, { headers: { cookie } })).json() as TraceLinkResolution;
      expect(single.status).toBe("resolved");
      expect(single.matches.map((match) => [match.projectName, match.caseId])).toEqual([["Alpha", inAlpha.caseId]]);

      const inBeta = await repo.importTrace(beta, "ironside", traceInput, context);
      // A pinned project header must not narrow or widen the membership-wide lookup.
      const both = await (await app.request(link, { headers: { cookie, "x-rubrist-project": "proj_foreign" } })).json() as TraceLinkResolution;
      expect(both.status).toBe("ambiguous");
      expect(both.matches.map((match) => [match.projectName, match.caseId])).toEqual([
        ["Alpha", inAlpha.caseId],
        ["Beta", inBeta.caseId]
      ]);

      const unsupported = await app.request("/api/links/trace?source=other&project=p&trace=t", { headers: { cookie } });
      expect(unsupported.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});

async function signIn(app: RubristApi, email: string, password: string): Promise<string> {
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  expect(response.status).toBe(200);
  return String(response.headers.get("set-cookie"))
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}
