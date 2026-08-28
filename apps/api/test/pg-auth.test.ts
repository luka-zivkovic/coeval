import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "@coeval/db";
import { CreateSkillVersionInputSchema, MinimumVerdictOutputSchema, STARTER_RUBRIC_MARKER } from "@coeval/shared";
import { createApp, type CoevalApi } from "../src/app.js";
import { claimAgentSetupPairing, createAuth } from "../src/lib/auth.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; Postgres auth tests may not be skipped.");
}
const run = databaseUrl ? describe : describe.skip;

run("Postgres auth flow", () => {
  it("atomically binds the beginner's visible quality question to the first Check", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_onboarding_check");

    try {
      await runMigrations(pool);
      const repository = new PgRepository(pool);
      const app = createApp(repository, { pool, auth: createAuth(pool) });
      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "guided-check@example.com",
          password: "guided-check-password",
          name: "Guided owner",
          projectName: "Support copilot",
          mode: "bench"
        })
      });
      expect(setup.status).toBe(200);
      const { projectId } = await setup.json() as { projectId: string };
      const starter = await repository.getLatestSkill(projectId);
      expect(starter.isStarter).toBe(true);

      const evaluator = CreateSkillVersionInputSchema.parse({
        rubricMarkdown: "# Support answer quality\n\nPass when the reply answers the question within policy.",
        prompt: "Judge the reply using {{rubric_markdown}}.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
        outputSchema: MinimumVerdictOutputSchema,
        verdictKind: "binary",
        timeScope: "both"
      });
      const visibleCriterion = {
        name: "Support answer quality",
        definition: "Did the reply answer the customer's question correctly and stay within policy?"
      };
      const pending = await repository.createSkillVersionPending(starter.id, evaluator, {
        projectId,
        onboardingCriterion: visibleCriterion
      });
      const bound = await repository.getCriterionVersionForSkillVersion(projectId, pending.id);

      expect(bound).toMatchObject({ revision: 2, ...visibleCriterion, sourceKind: "native" });
      expect(pending.criterionVersionId).toBe(bound?.id);
      const persisted = await pool.query(
        `select s.name, s.description, s.is_starter,
                (select count(*)::int from skill_versions sv where sv.skill_id = s.id) as version_count,
                (select count(*)::int from criterion_versions cv where cv.criterion_id = s.criterion_id) as criterion_version_count
         from skills s where s.id = $1`,
        [starter.id]
      );
      expect(persisted.rows[0]).toMatchObject({
        name: visibleCriterion.name,
        description: visibleCriterion.definition,
        is_starter: false,
        version_count: 2,
        criterion_version_count: 2
      });

      await expect(repository.createSkillVersionPending(starter.id, evaluator, {
        projectId,
        onboardingCriterion: {
          name: "Conflicting retry",
          definition: "This must not be appended."
        }
      })).rejects.toMatchObject({ code: "project_already_configured" });
      const counts = await pool.query(
        `select
           (select count(*)::int from skill_versions where skill_id = $1) as version_count,
           (select count(*)::int from criterion_versions where criterion_id = $2) as criterion_version_count`,
        [starter.id, starter.criterionId]
      );
      expect(counts.rows[0]).toMatchObject({ version_count: 2, criterion_version_count: 2 });
    } finally {
      await cleanup();
    }
  });

  it("covers setup, owner invite, non-owner rejection, and invite redemption", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_auth");

    try {
      await runMigrations(pool);
      const app = createApp(new PgRepository(pool), { pool, auth: createAuth(pool) });

      const setupProbe = await app.request("/api/auth/setup-required");
      expect(setupProbe.status).toBe(200);
      await expect(setupProbe.json()).resolves.toMatchObject({ setupRequired: true, authEnabled: true });

      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "owner@example.com",
          password: "owner-password",
          name: "Owner",
          projectName: "Agent skill audit",
          mode: "bench"
        })
      });
      expect(setup.status).toBe(200);
      const setupBody = (await setup.json()) as { projectId: string; apiKey: { key: string; name: string; projectId: string } };
      expect(setupBody.apiKey).toMatchObject({
        projectId: setupBody.projectId,
        name: "First verdict",
        key: expect.stringMatching(/^coeval_sk_/)
      });
      // Setup auto-signs-in the new owner: the session cookie from better-auth
      // must be forwarded so the UI lands in the app, not on the login form.
      expect(setup.headers.get("set-cookie") ?? "").toContain("better-auth");
      const firstProject = await pool.query(
        `select name, mode from projects order by created_at asc limit 1`
      );
      expect(firstProject.rows[0]).toMatchObject({ name: "Agent skill audit", mode: "bench" });
      // The starter seed follows the chosen mode — a bench project must not
      // open on a skill that talks about imported traces.
      const starterSkill = await pool.query(`select description from skills limit 1`);
      expect(starterSkill.rows[0]?.description).toBe("Starter skill for judging supplied examples.");
      const starterIdentity = await pool.query(
        `select criterion.source_kind,
                skill.criterion_id,
                version.criterion_version_id,
                criterion_version.criterion_id as version_criterion_id
         from skills skill
         join criteria criterion on criterion.id = skill.criterion_id
         join skill_versions version on version.skill_id = skill.id
         join criterion_versions criterion_version on criterion_version.id = version.criterion_version_id
         where skill.project_id = $1`,
        [setupBody.projectId]
      );
      expect(starterIdentity.rows).toEqual([
        expect.objectContaining({
          source_kind: "native",
          criterion_id: expect.any(String),
          criterion_version_id: expect.any(String)
        })
      ]);
      expect(starterIdentity.rows[0]?.version_criterion_id).toBe(starterIdentity.rows[0]?.criterion_id);
      const firstKeyRows = await pool.query(
        `select name, key_prefix from api_keys where project_id = $1`,
        [setupBody.projectId]
      );
      expect(firstKeyRows.rows).toEqual([
        expect.objectContaining({ name: "First verdict", key_prefix: expect.stringMatching(/^coeval_sk_/) })
      ]);
      const firstKeyAuth = await app.request("/api/v1/project", {
        headers: { authorization: `Bearer ${setupBody.apiKey.key}` }
      });
      expect(firstKeyAuth.status).toBe(200);
      const keyWrite = await app.request("/api/v1/criteria", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${setupBody.apiKey.key}` },
        body: JSON.stringify({})
      });
      expect(keyWrite.status).toBe(403);
      await expect(keyWrite.json()).resolves.toMatchObject({ code: "owner_session_required" });

      const setupAfterOwner = await app.request("/api/auth/setup-required");
      await expect(setupAfterOwner.json()).resolves.toMatchObject({ setupRequired: false });

      const secondSetup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "other-owner@example.com", password: "owner-password", name: "Other Owner" })
      });
      expect(secondSetup.status).toBe(409);

      const ownerCookie = await signIn(app, "owner@example.com", "owner-password");
      const ownerCriteriaRead = await app.request("/api/v1/criteria", {
        headers: { cookie: ownerCookie, "x-coeval-project": setupBody.projectId }
      });
      expect(ownerCriteriaRead.status).toBe(200);
      await expect(ownerCriteriaRead.json()).resolves.toMatchObject({ criteria: [{ sourceKind: "native" }] });
      const createdProject = await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ name: "Second evaluation", mode: "tracing" })
      });
      expect(createdProject.status).toBe(201);
      const createdProjectBody = (await createdProject.json()) as { projectId: string; apiKey: { key: string; projectId: string } };
      expect(createdProjectBody.apiKey).toMatchObject({
        projectId: createdProjectBody.projectId,
        key: expect.stringMatching(/^coeval_sk_/)
      });
      const ownerIntegration = await app.request("/api/integrations/langsmith", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ apiKey: "ls_test_key", projectName: "Support Agent" })
      });
      expect(ownerIntegration.status).toBe(201);
      const ownerIntegrationBody = (await ownerIntegration.json()) as { integration: { id: string } };

      const ownerInvite = await app.request("/api/users/invite", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ email: "member@example.com", role: "member" })
      });
      expect(ownerInvite.status).toBe(201);
      const inviteBody = (await ownerInvite.json()) as { token?: string };
      expect(inviteBody.token).toBeTruthy();

      const redeem = await app.request("/api/auth/redeem-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: inviteBody.token, email: "member@example.com", password: "member-password", name: "Member" })
      });
      expect(redeem.status).toBe(200);
      // Invite redemption auto-signs-in like setup does — the session cookie
      // must be forwarded.
      expect(redeem.headers.get("set-cookie") ?? "").toContain("better-auth");

      const memberRows = await pool.query(
        `select pm.role
         from project_members pm
         join "user" u on u.id = pm.user_id
         where u.email = $1`,
        ["member@example.com"]
      );
      expect(memberRows.rows[0]?.role).toBe("member");

      const memberCookie = await signIn(app, "member@example.com", "member-password");
      const memberPairing = await app.request("/api/agent-setup/pairings", {
        method: "POST",
        headers: { cookie: memberCookie }
      });
      expect(memberPairing.status).toBe(403);

      const memberInvite = await app.request("/api/users/invite", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ email: "blocked@example.com", role: "member" })
      });
      expect(memberInvite.status).toBe(403);

      const memberIntegrationCreate = await app.request("/api/integrations/langsmith", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ apiKey: "ls_member_key", projectName: "Blocked Project" })
      });
      expect(memberIntegrationCreate.status).toBe(403);

      const memberIntegrationUpdate = await app.request(`/api/integrations/langsmith/${ownerIntegrationBody.integration.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ pollEnabled: false })
      });
      expect(memberIntegrationUpdate.status).toBe(403);

      const memberIntegrationTest = await app.request(`/api/integrations/langsmith/${ownerIntegrationBody.integration.id}/test`, {
        method: "POST",
        headers: { cookie: memberCookie }
      });
      expect(memberIntegrationTest.status).toBe(403);

      const memberIntegrationDelete = await app.request(`/api/integrations/langsmith/${ownerIntegrationBody.integration.id}`, {
        method: "DELETE",
        headers: { cookie: memberCookie }
      });
      expect(memberIntegrationDelete.status).toBe(403);

      const ownerImport = await app.request(`/api/integrations/langsmith/${ownerIntegrationBody.integration.id}/import`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ limit: 1 })
      });
      expect(ownerImport.status).toBe(202);
      const ownerImportBody = (await ownerImport.json()) as {
        importJob: { id: string; actorUserId: string | null; actorEmail: string | null; actorName: string | null; status: string };
      };
      expect(ownerImportBody.importJob).toMatchObject({
        actorUserId: expect.any(String),
        actorEmail: "owner@example.com",
        actorName: "Owner",
        status: "failed"
      });
      const actorRows = await pool.query(
        `select u.email
         from import_jobs ij
         join "user" u on u.id = ij.actor_user_id
         where ij.id = $1`,
        [ownerImportBody.importJob.id]
      );
      expect(actorRows.rows[0]?.email).toBe("owner@example.com");
      const ownerImportJobs = await app.request("/api/import-jobs?limit=5", {
        headers: { cookie: ownerCookie }
      });
      await expect(ownerImportJobs.json()).resolves.toMatchObject({
        importJobs: [
          {
            id: ownerImportBody.importJob.id,
            actorEmail: "owner@example.com",
            actorName: "Owner"
          }
        ]
      });

      const skillRows = await pool.query(
        `select s.id
         from skills s
         join project_members pm on pm.project_id = s.project_id
         join "user" u on u.id = pm.user_id
         where u.email = $1
         limit 1`,
        ["member@example.com"]
      );
      const memberSkillEdit = await app.request(`/api/skills/${skillRows.rows[0].id}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({
          rubricMarkdown: "Member should not be able to edit this skill.",
          prompt: "Judge the trace.",
          modelBinding: { provider: "mock", modelId: "mock", modelVersion: "test", temperature: 0 }
        })
      });
      expect(memberSkillEdit.status).toBe(403);

      const memberPromotion = await app.request("/api/cases/case_missing/promote", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ agreedLabel: "fail", reason: "Member should not be able to promote." })
      });
      expect(memberPromotion.status).toBe(403);

      const memberSettingsUpdate = await app.request("/api/project/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ traceRetentionDays: 30 })
      });
      expect(memberSettingsUpdate.status).toBe(403);

      const memberPrune = await app.request("/api/project/retention/prune", {
        method: "POST",
        headers: { cookie: memberCookie }
      });
      expect(memberPrune.status).toBe(403);

      const memberDelete = await app.request("/api/project", {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ confirmProjectName: "Owner Workspace" })
      });
      expect(memberDelete.status).toBe(403);
    } finally {
      await cleanup();
    }
  });

  it("bootstraps an agent-drafted bench and returns its first project key once", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const previousBootstrapToken = process.env.COEVAL_BOOTSTRAP_TOKEN;
    process.env.COEVAL_BOOTSTRAP_TOKEN = "pg-agent-bootstrap-token-that-is-at-least-32-characters";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_auth");

    try {
      await runMigrations(pool);
      const app = createApp(new PgRepository(pool), { pool, auth: createAuth(pool) });
      const disconnected = await app.request("/api/v1/bootstrap", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.COEVAL_BOOTSTRAP_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          owner: { email: "agent-owner@example.com", password: "agent-owner-password" },
          project: { name: "Disconnected audit" },
          skill: {
            rubricMarkdown: "# Rubric that must be injected",
            prompt: "Judge the run without the rubric variable.",
            model: {
              provider: "custom",
              modelId: "test-judge-model",
              baseUrl: "https://judge.example/v1"
            }
          },
          providerApiKey: "test-custom-provider-key"
        })
      });
      expect(disconnected.status).toBe(422);
      await expect(disconnected.json()).resolves.toMatchObject({
        code: "rubric_not_referenced",
        field: "skill.prompt"
      });

      const response = await app.request("/api/v1/bootstrap", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.COEVAL_BOOTSTRAP_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          owner: {
            email: "agent-owner@example.com",
            password: "agent-owner-password",
            name: "Agent Owner"
          },
          project: { name: "External skill audit", apiKeyName: "Audit agent" },
          skill: {
            name: "External skill judge",
            rubricMarkdown: "# External skill judge\n\nPass when the run follows the skill contract.",
            prompt: "Judge the run.\n\n<review_guide>\n{{rubric_markdown}}\n</review_guide>",
            model: {
              provider: "custom",
              modelId: "test-judge-model",
              baseUrl: "https://judge.example/v1",
              temperature: 0
            }
          },
          providerApiKey: "test-custom-provider-key"
        })
      });
      expect(response.status).toBe(201);
      const body = await response.json() as {
        projectId: string;
        skillVersionId: string;
        rubricProvenance: string;
        apiKey: { key: string; keyPrefix: string };
        connect: { claudeCode: string; mcpJson: string; cli: string };
      };
      expect(body).toMatchObject({ rubricProvenance: "agent-drafted" });
      expect(body.apiKey.key).toMatch(/^coeval_sk_/);
      expect(body.apiKey.key.startsWith(body.apiKey.keyPrefix.slice(0, -1))).toBe(true);
      // Issue #15: the completion response wires the agent, not just keys it —
      // every snippet form carries the one-time key pre-filled.
      expect(body.connect.claudeCode).toContain(body.apiKey.key);
      expect(body.connect.mcpJson).toContain(body.apiKey.key);
      expect(body.connect.cli).toContain(body.apiKey.key);

      const persisted = await pool.query(
        `select p.mode, s.name, sv.status, sv.rubric_provenance
         from projects p
         join skills s on s.project_id = p.id
         join skill_versions sv on sv.skill_id = s.id
         where p.id = $1 and sv.id = $2`,
        [body.projectId, body.skillVersionId]
      );
      expect(persisted.rows[0]).toMatchObject({
        mode: "bench",
        name: "External skill judge",
        status: "approved",
        rubric_provenance: "agent-drafted"
      });

      const project = await app.request("/api/v1/project", {
        headers: { authorization: `Bearer ${body.apiKey.key}` }
      });
      expect(project.status).toBe(200);
      await expect(project.json()).resolves.toMatchObject({
        projectId: body.projectId,
        mode: "bench",
        currentSkillVersionId: body.skillVersionId
      });

      const humanOnly = await app.request("/api/golden-set/not-a-case/promote", {
        method: "POST",
        headers: {
          authorization: `Bearer ${body.apiKey.key}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ agreedLabel: "pass", reason: "Agent must not reach this route." })
      });
      expect(humanOnly.status).toBe(401);
    } finally {
      if (previousBootstrapToken === undefined) delete process.env.COEVAL_BOOTSTRAP_TOKEN;
      else process.env.COEVAL_BOOTSTRAP_TOKEN = previousBootstrapToken;
      await cleanup();
    }
  });

  // Issue #150: the missing-credential error tells agents to pin provider
  // "mock" explicitly — the bootstrap endpoint must actually accept that pin
  // on a keyless instance (no providerApiKey, no env key, no catalog fetch).
  it("bootstraps a mock-judged bench when provider 'mock' is pinned explicitly, without any credential", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const previousBootstrapToken = process.env.COEVAL_BOOTSTRAP_TOKEN;
    process.env.COEVAL_BOOTSTRAP_TOKEN = "pg-agent-bootstrap-token-that-is-at-least-32-characters";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_auth");

    try {
      await runMigrations(pool);
      const app = createApp(new PgRepository(pool), { pool, auth: createAuth(pool) });
      const response = await app.request("/api/v1/bootstrap", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.COEVAL_BOOTSTRAP_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          owner: { email: "mock-agent-owner@example.com", password: "mock-agent-password" },
          project: { name: "Keyless wiring test" },
          skill: {
            rubricMarkdown: "# Wiring rubric\n\nPass correct answers.",
            model: { provider: "mock" }
          }
        })
      });
      expect(response.status).toBe(201);
      const body = await response.json() as {
        projectId: string;
        modelBinding: { provider: string; modelId: string; modelVersion: string };
        apiKey: { key: string };
      };
      expect(body.modelBinding).toMatchObject({ provider: "mock", modelId: "mock", modelVersion: "mock" });
      expect(body.apiKey.key).toMatch(/^coeval_sk_/);

      // No provider credential row was minted for the mock pin.
      const credentials = await pool.query(
        `select provider from judge_provider_keys where project_id = $1`,
        [body.projectId]
      );
      expect(credentials.rows).toEqual([]);
    } finally {
      if (previousBootstrapToken === undefined) delete process.env.COEVAL_BOOTSTRAP_TOKEN;
      else process.env.COEVAL_BOOTSTRAP_TOKEN = previousBootstrapToken;
      await cleanup();
    }
  });

  it("pairs a signed-in owner with an external setup agent without a deployment token", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const previousBootstrapToken = process.env.COEVAL_BOOTSTRAP_TOKEN;
    delete process.env.COEVAL_BOOTSTRAP_TOKEN;
    const { pool, cleanup } = await openPostgresTestDatabase("pg_auth");

    try {
      await runMigrations(pool);
      const app = createApp(new PgRepository(pool), { pool, auth: createAuth(pool) });
      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "paired-owner@example.com",
          password: "paired-owner-password",
          name: "Paired Owner",
          projectName: "Friendly onboarding",
          mode: "bench"
        })
      });
      expect(setup.status).toBe(200);
      const ownerCookie = await signIn(app, "paired-owner@example.com", "paired-owner-password");

      const createPairing = await app.request("/api/agent-setup/pairings", {
        method: "POST",
        headers: { cookie: ownerCookie }
      });
      expect(createPairing.status).toBe(201);
      expect(createPairing.headers.get("cache-control")).toBe("no-store");
      const firstPairing = await createPairing.json() as {
        id: string;
        projectId: string;
        projectName: string;
        ownerEmail: string;
        status: string;
        token: string;
      };
      expect(firstPairing).toMatchObject({
        projectName: "Friendly onboarding",
        ownerEmail: "paired-owner@example.com",
        status: "pending"
      });
      expect(firstPairing.token).toMatch(/^coeval_pair_/);

      const replacementResponse = await app.request("/api/agent-setup/pairings", {
        method: "POST",
        headers: { cookie: ownerCookie }
      });
      expect(replacementResponse.status).toBe(201);
      const pairing = await replacementResponse.json() as typeof firstPairing;
      expect(pairing.id).not.toBe(firstPairing.id);
      const replaced = await pool.query(
        `select revoked_at from agent_setup_pairings where id = $1`,
        [firstPairing.id]
      );
      expect(replaced.rows[0]?.revoked_at).not.toBeNull();
      const oldConnection = await app.request("/api/v1/bootstrap", {
        method: "POST",
        headers: { authorization: `Bearer ${firstPairing.token}` }
      });
      expect(oldConnection.status).toBe(401);

      const storedBeforeUse = await pool.query(
        `select token_hash, consumed_at from agent_setup_pairings where id = $1`,
        [pairing.id]
      );
      expect(storedBeforeUse.rows[0]?.token_hash).not.toBe(pairing.token);
      expect(String(storedBeforeUse.rows[0]?.token_hash)).not.toContain(pairing.token);
      expect(storedBeforeUse.rows[0]?.consumed_at).toBeNull();

      const response = await app.request("/api/v1/bootstrap", {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairing.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          // Pairing scope, not caller-supplied identity/project text, decides
          // which existing onboarding project is configured.
          owner: { email: "ignored-but-valid@example.com" },
          project: { name: "Must not create a second project", apiKeyName: "Paired agent" },
          skill: {
            name: "Friendly onboarding judge",
            rubricMarkdown: "# Friendly onboarding\n\nPass when the target skill follows its contract.",
            model: {
              provider: "custom",
              modelId: "test-judge-model",
              baseUrl: "https://judge.example/v1"
            }
          },
          providerApiKey: "test-custom-provider-key"
        })
      });
      expect(response.status).toBe(201);
      const body = await response.json() as {
        projectId: string;
        skillVersionId: string;
        mode: string;
        rubricProvenance: string;
        apiKey: { key: string };
      };
      expect(body).toMatchObject({
        projectId: pairing.projectId,
        mode: "bench",
        rubricProvenance: "agent-drafted"
      });
      expect(body.apiKey.key).toMatch(/^coeval_sk_/);

      const persisted = await pool.query(
        `select
           (select count(*)::int from projects) as project_count,
           (select consumed_at from agent_setup_pairings where id = $1) as consumed_at,
           (select rubric_provenance from skill_versions where id = $2) as rubric_provenance,
           (select is_starter from skills where project_id = $3) as is_starter`,
        [pairing.id, body.skillVersionId, pairing.projectId]
      );
      expect(persisted.rows[0]?.project_count).toBe(1);
      expect(persisted.rows[0]?.consumed_at).not.toBeNull();
      expect(persisted.rows[0]?.rubric_provenance).toBe("agent-drafted");
      expect(persisted.rows[0]?.is_starter).toBe(false);

      const status = await app.request(`/api/agent-setup/pairings/${pairing.id}`, {
        headers: { cookie: ownerCookie }
      });
      expect(status.status).toBe(200);
      const statusBody = await status.json() as Record<string, unknown>;
      expect(statusBody).toMatchObject({ id: pairing.id, status: "completed" });
      expect(statusBody).not.toHaveProperty("token");

      const reuse = await app.request("/api/v1/bootstrap", {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairing.token}`,
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(reuse.status).toBe(401);
      await expect(reuse.json()).resolves.toMatchObject({ code: "invalid_or_expired_pairing_token" });

      const project = await app.request("/api/v1/project", {
        headers: { authorization: `Bearer ${body.apiKey.key}` }
      });
      expect(project.status).toBe(200);
      await expect(project.json()).resolves.toMatchObject({
        projectId: pairing.projectId,
        currentSkillVersionId: body.skillVersionId
      });
    } finally {
      if (previousBootstrapToken === undefined) delete process.env.COEVAL_BOOTSTRAP_TOKEN;
      else process.env.COEVAL_BOOTSTRAP_TOKEN = previousBootstrapToken;
      await cleanup();
    }
  });

  it("lets a concurrent human edit win atomically even when it retains the starter sentence", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_auth");

    try {
      await runMigrations(pool);
      const repository = new PgRepository(pool);
      const app = createApp(repository, { pool, auth: createAuth(pool) });
      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "race-owner@example.com",
          password: "race-owner-password",
          name: "Race Owner",
          projectName: "Race-safe onboarding",
          mode: "bench"
        })
      });
      expect(setup.status).toBe(200);
      const ownerCookie = await signIn(app, "race-owner@example.com", "race-owner-password");
      const pairingResponse = await app.request("/api/agent-setup/pairings", {
        method: "POST",
        headers: { cookie: ownerCookie }
      });
      expect(pairingResponse.status).toBe(201);
      const pairing = await pairingResponse.json() as { id: string; projectId: string };
      expect(await claimAgentSetupPairing(pool, pairing.id)).toBe(true);

      const seededSkill = await repository.getLatestSkill(pairing.projectId);
      expect(seededSkill.isStarter).toBe(true);
      const humanInput = CreateSkillVersionInputSchema.parse({
        rubricMarkdown: `# Human configuration\n\n${STARTER_RUBRIC_MARKER}.\n\nPass only after a human review.`,
        prompt: "Judge against {{rubric_markdown}}.",
        modelBinding: { provider: "mock", modelId: "mock", modelVersion: "mock", temperature: 0 },
        outputSchema: MinimumVerdictOutputSchema,
        verdictKind: "binary",
        timeScope: "new"
      });
      await repository.createSkillVersionPending(seededSkill.id, humanInput, {
        projectId: pairing.projectId,
        rubricProvenance: "human-authored"
      });

      const agentInput = CreateSkillVersionInputSchema.parse({
        ...humanInput,
        rubricMarkdown: "# Agent configuration\n\nPass when the agent says so."
      });
      await expect(repository.createSkillVersionPending(seededSkill.id, agentInput, {
        projectId: pairing.projectId,
        rubricProvenance: "agent-drafted",
        agentSetup: {
          pairingId: pairing.id,
          skillName: "Agent should not win",
          skillDescription: "This rename must roll back."
        }
      })).rejects.toMatchObject({ code: "project_already_configured" });

      const persisted = await pool.query(
        `select s.name, s.is_starter,
                (select count(*)::int from skill_versions sv where sv.skill_id = s.id) as version_count
         from skills s where s.id = $1`,
        [seededSkill.id]
      );
      expect(persisted.rows[0]).toMatchObject({
        name: "Default Review Skill",
        is_starter: false,
        version_count: 2
      });
    } finally {
      await cleanup();
    }
  });

  // Minimal-body setup is a live contract: tools/sim/prelude.mjs and
  // scripts/seed-user.ts both call setup with only {email, password, name}
  // and rely on the "Default Project" / tracing fallbacks. The test above
  // always sends projectName+mode, so without this test a change breaking
  // the defaults (or making the fields effectively required) passes CI.
  it("defaults the first workspace when setup omits projectName and mode", async () => {
    process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-for-pg-auth-flow-at-least-32-bytes";
    const { pool, cleanup } = await openPostgresTestDatabase("pg_auth");

    try {
      await runMigrations(pool);
      const app = createApp(new PgRepository(pool), { pool, auth: createAuth(pool) });

      const setup = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "minimal@example.com", password: "minimal-password", name: "Minimal" })
      });
      expect(setup.status).toBe(200);

      const firstProject = await pool.query(`select name, mode from projects order by created_at asc limit 1`);
      expect(firstProject.rows[0]).toMatchObject({ name: "Default Project", mode: "tracing" });
      const starterSkill = await pool.query(`select description from skills limit 1`);
      expect(starterSkill.rows[0]?.description).toBe("Starter skill for judging imported traces.");
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
