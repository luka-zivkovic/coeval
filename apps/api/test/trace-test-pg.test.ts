import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "@coeval/db";
import type { CreateTraceTestInput, TraceTestDetail, TraceTestValidation } from "@coeval/shared";
import { createApp, type CoevalApi } from "../src/app.js";
import { createAuth } from "../src/lib/auth.js";
import { PgRepository } from "../src/repository.pg.js";
import { TraceTestNotFoundError, TraceTestSourceNotFoundError } from "../src/repository.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

const draft = (sourceCaseId: string): CreateTraceTestInput => ({
  sourceCaseId,
  sourceScope: { responsePath: ["output", "messages", 0], turnIndexes: [0, 1], stepIndexes: [] },
  desiredBehavior: "Check eligibility before promising a refund.",
  scenario: "A customer asks for a refund after renewal.",
  expectedBehavior: "Explain the policy-qualified refund path.",
  mustDo: ["Check eligibility"],
  mustAvoid: ["Promise a refund without evidence"],
  goodExample: { messages: [{ role: "assistant", content: "I will check eligibility first." }] },
  badExample: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
  checker: { kind: "judge", label: "Refund policy behavior", metadata: { contract: 1 } },
  draftProvenance: {
    origin: "generated",
    generatedFields: ["scenario", "expectedBehavior", "mustDo", "mustAvoid", "goodExample", "checker"],
    generator: { provider: "mock", model: "mock-drafter" }
  }
});

run("trace-derived test Postgres persistence", () => {
  it("enforces project scope, immutable revisions, retained source, and human-reviewed enablement", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "trace-test-pg-secret-that-is-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("trace_test");

    try {
      await runMigrations(pool);
      const repository = new PgRepository(pool);
      const app = createApp(repository, { pool, auth: createAuth(pool) });

      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "trace-owner@example.com",
          password: "trace-owner-password",
          name: "Trace Owner",
          projectName: "Source project",
          mode: "tracing"
        })
      });
      expect(setup.status).toBe(200);
      const setupBody = (await setup.json()) as { projectId: string };
      const ownerCookie = await signIn(app, "trace-owner@example.com", "trace-owner-password");

      const secondProject = await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ name: "Other project", mode: "tracing" })
      });
      expect(secondProject.status).toBe(201);
      const secondProjectBody = (await secondProject.json()) as { projectId: string };

      const imported = await repository.importTrace(setupBody.projectId, "manual", {
        sourceTraceId: "source_refund_pg_1",
        input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
        output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
        metadata: { channel: "support" }
      }, { ingestionPurpose: "analysis_eligible_manual" });
      // Defense-in-depth regression: legacy or manually repaired rows may
      // predate ingestion redaction. A retained snapshot must redact again
      // before it outlives ordinary trace retention.
      await pool.query(
        `update cases set normalized_payload = $3 where id = $1 and project_id = $2`,
        [
          imported.caseId,
          setupBody.projectId,
          JSON.stringify({
            input: { messages: [{ role: "user", content: "Can I get a refund?" }], password: "legacy-secret" },
            output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
            metadata: { channel: "support" }
          })
        ]
      );

      const create = await app.request("/api/trace-tests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify(draft(imported.caseId))
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as { test: TraceTestDetail };
      expect(created.test).toMatchObject({
        projectId: setupBody.projectId,
        sourceCaseId: imported.caseId,
        sourceTraceRef: "source_refund_pg_1",
        lifecycle: "draft",
        enabledRevision: null
      });
      expect(created.test.sourceSnapshot).toMatchObject({ input: { password: "[REDACTED]" } });
      const noAuthPgApp = createApp(repository, { pool });
      const noAuthEnable = await noAuthPgApp.request(`/api/trace-tests/${created.test.id}/enable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, validationId: "missing" })
      });
      expect(noAuthEnable.status).toBe(401);

      const invite = await app.request("/api/users/invite", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ email: "trace-member@example.com", role: "member" })
      });
      expect(invite.status).toBe(201);
      const inviteBody = (await invite.json()) as { token: string };
      const redeem = await app.request("/api/auth/redeem-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: inviteBody.token,
          email: "trace-member@example.com",
          password: "trace-member-password",
          name: "Trace Member"
        })
      });
      expect(redeem.status).toBe(200);
      const memberCookie = await signIn(app, "trace-member@example.com", "trace-member-password");
      const actorRows = await pool.query(
        `select id, email from "user" where email in ($1, $2)`,
        ["trace-owner@example.com", "trace-member@example.com"]
      );
      expect(actorRows.rows).toHaveLength(2);
      const ownerUserId = String(actorRows.rows.find((row) => row.email === "trace-owner@example.com")?.id);
      const memberUserId = String(actorRows.rows.find((row) => row.email === "trace-member@example.com")?.id);
      const memberRead = await app.request(`/api/trace-tests/${created.test.id}`, {
        headers: { cookie: memberCookie, "x-coeval-project": setupBody.projectId }
      });
      expect(memberRead.status).toBe(200);
      const memberRevisionRequest = { ...draft(imported.caseId), expectedRevision: 1 } as Record<string, unknown>;
      delete memberRevisionRequest.sourceCaseId;
      delete memberRevisionRequest.sourceScope;
      memberRevisionRequest.scenario = "A member refines the refund scenario.";
      const memberRevision = await app.request(`/api/trace-tests/${created.test.id}/revisions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: memberCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify(memberRevisionRequest)
      });
      expect(memberRevision.status).toBe(201);
      await expect(memberRevision.json()).resolves.toMatchObject({
        test: {
          currentRevision: 2,
          revisions: [
            { revision: 1, createdByUserId: ownerUserId },
            { revision: 2, createdByUserId: memberUserId }
          ]
        }
      });
      const memberEnable = await app.request(`/api/trace-tests/${created.test.id}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: memberCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify({ expectedRevision: 2, validationId: "missing" })
      });
      expect(memberEnable.status).toBe(403);

      const crossProjectRead = await app.request(`/api/trace-tests/${created.test.id}`, {
        headers: { cookie: ownerCookie, "x-coeval-project": secondProjectBody.projectId }
      });
      expect(crossProjectRead.status).toBe(404);
      const crossProjectWrite = await app.request(`/api/trace-tests/${created.test.id}/revisions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": secondProjectBody.projectId
        },
        body: JSON.stringify({ ...draft(imported.caseId), expectedRevision: 1 })
      });
      expect(crossProjectWrite.status).toBe(404);
      await expect(repository.createTraceTest({
        projectId: secondProjectBody.projectId,
        ...draft(imported.caseId)
      })).rejects.toBeInstanceOf(TraceTestSourceNotFoundError);
      await expect(repository.recordTraceTestValidation({
        projectId: secondProjectBody.projectId,
        traceTestId: created.test.id,
        revision: 2,
        badEvidence: { output: {}, result: "fail", note: null },
        goodEvidence: { output: {}, result: "pass", note: null }
      })).rejects.toBeInstanceOf(TraceTestNotFoundError);

      const operationalFailure = await app.request(`/api/trace-tests/${created.test.id}/checks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify({ revision: 2 })
      });
      expect(operationalFailure.status).toBe(201);
      await expect(operationalFailure.json()).resolves.toMatchObject({ validation: { status: "unavailable" } });

      const premature = await app.request(`/api/trace-tests/${created.test.id}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify({ expectedRevision: 2, validationId: "missing" })
      });
      expect(premature.status).toBe(409);

      const passed = await app.request(`/api/trace-tests/${created.test.id}/validations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify({
          revision: 2,
          badResult: "fail",
          goodResult: "pass",
          overrideReason: "I reviewed both examples and confirmed the checker separates them correctly."
        })
      });
      const passedBody = (await passed.json()) as { validation: TraceTestValidation };
      expect(passedBody.validation.status).toBe("passed");

      const enable = await app.request(`/api/trace-tests/${created.test.id}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify({ expectedRevision: 2, validationId: passedBody.validation.id })
      });
      expect(enable.status).toBe(200);
      const enabled = (await enable.json()) as { test: TraceTestDetail };
      expect(enabled.test.revisions[2]).toMatchObject({
        lifecycle: "enabled",
        validatedRevision: 2,
        validationId: passedBody.validation.id,
        createdByUserId: memberUserId,
        reviewedByUserId: ownerUserId
      });

      const memberRun = await app.request(`/api/trace-tests/${created.test.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: memberCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: "{}"
      });
      expect(memberRun.status).toBe(403);

      const ownerRun = await app.request(`/api/trace-tests/${created.test.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: "{}"
      });
      expect(ownerRun.status).toBe(202);
      await expect(ownerRun.json()).resolves.toMatchObject({
        dataset: { name: "Regression tests", itemCount: 1 },
        run: {
          sourceTraceTest: {
            traceTestId: created.test.id,
            revision: 3,
            validationRevision: 2,
            validationId: passedBody.validation.id,
            sourceCaseRef: imported.caseId
          }
        }
      });
      const runRow = await pool.query(
        `select source_trace_test_id, source_trace_test_revision,
                source_trace_test_validation_revision, source_trace_test_validation_id
         from eval_runs where source_trace_test_id = $1`,
        [created.test.id]
      );
      expect(runRow.rows[0]).toMatchObject({
        source_trace_test_id: created.test.id,
        source_trace_test_revision: 3,
        source_trace_test_validation_revision: 2,
        source_trace_test_validation_id: passedBody.validation.id
      });

      const revisionRequest = { ...draft(imported.caseId), expectedRevision: 3 } as Record<string, unknown>;
      delete revisionRequest.sourceCaseId;
      delete revisionRequest.sourceScope;
      revisionRequest.scenario = "A customer asks to cancel and requests a refund.";
      const revise = await app.request(`/api/trace-tests/${created.test.id}/revisions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
          "x-coeval-project": setupBody.projectId
        },
        body: JSON.stringify(revisionRequest)
      });
      expect(revise.status).toBe(201);
      const revised = (await revise.json()) as { test: TraceTestDetail };
      expect(revised.test).toMatchObject({
        lifecycle: "enabled",
        currentRevision: 4,
        enabledRevision: 3,
        hasUnpublishedChanges: true
      });

      const revisionRows = await pool.query(
        `select revision, lifecycle, scenario from trace_test_revisions
         where trace_test_id = $1 order by revision`,
        [created.test.id]
      );
      expect(revisionRows.rows).toEqual([
        expect.objectContaining({ revision: 1, lifecycle: "draft", scenario: "A customer asks for a refund after renewal." }),
        expect.objectContaining({ revision: 2, lifecycle: "draft", scenario: "A member refines the refund scenario." }),
        expect.objectContaining({ revision: 3, lifecycle: "enabled", scenario: "A member refines the refund scenario." }),
        expect.objectContaining({ revision: 4, lifecycle: "draft", scenario: "A customer asks to cancel and requests a refund." })
      ]);

      await expect(pool.query(
        `update trace_test_revisions set project_id = $2
         where trace_test_id = $1 and revision = 4`,
        [created.test.id, secondProjectBody.projectId]
      )).rejects.toMatchObject({ code: "23503" });
      await expect(pool.query(
        `update trace_tests set current_revision = 999 where id = $1`,
        [created.test.id]
      )).rejects.toMatchObject({ code: "23503" });

      await pool.query(`delete from cases where id = $1 and project_id = $2`, [imported.caseId, setupBody.projectId]);
      const afterRetention = await repository.getTraceTest(setupBody.projectId, created.test.id);
      expect(afterRetention).toMatchObject({
        sourceCaseId: null,
        sourceCaseRef: imported.caseId,
        sourceTraceRef: "source_refund_pg_1",
        sourceSnapshot: {
          input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
          output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] }
        }
      });
      expect(await repository.getTraceTest(secondProjectBody.projectId, created.test.id)).toBeNull();

      const funnelEvent = {
        journeyId: "e137f8a5-98f5-40c9-a0cb-75a74be7fa37",
        event: "enabled",
        elapsedMs: 118_000,
        intent: "prevent"
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.request("/api/trace-tests/funnel-events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: ownerCookie,
            "x-coeval-project": setupBody.projectId
          },
          body: JSON.stringify(funnelEvent)
        });
        expect(response.status).toBe(204);
      }
      const funnelRows = await pool.query(
        `select actor_user_id, metadata from audit_logs
         where project_id = $1 and target_type = 'trace_test_funnel' and target_id = $2`,
        [setupBody.projectId, funnelEvent.journeyId]
      );
      expect(funnelRows.rows).toEqual([{
        actor_user_id: ownerUserId,
        metadata: {
          event: funnelEvent.event,
          elapsedMs: funnelEvent.elapsedMs,
          intent: funnelEvent.intent
        }
      }]);
      await pool.query(
        `delete from audit_logs where project_id = $1 and target_type = 'trace_test_funnel'`,
        [setupBody.projectId]
      );

      await pool.query(`delete from projects where id = $1`, [setupBody.projectId]);
      const cascaded = await pool.query(
        `select
           (select count(*)::int from trace_tests) as tests,
           (select count(*)::int from trace_test_revisions) as revisions,
           (select count(*)::int from trace_test_validations) as validations`
      );
      expect(cascaded.rows[0]).toMatchObject({ tests: 0, revisions: 0, validations: 0 });
    } finally {
      await cleanup();
    }
  });
});

async function signIn(app: CoevalApi, email: string, password: string): Promise<string> {
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return String(setCookie)
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}
