import type { Pool } from "pg";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  DeleteProjectInputSchema,
  JudgeProviderIdSchema,
  OnboardingEvidenceInventorySchema,
  PROJECT_NAME_MAX_LENGTH,
  ProjectModeSchema,
  UpdateProjectSettingsInputSchema
} from "@coeval/shared";
import {
  AgentSetupPairingInProgressError,
  AGENT_SETUP_PAIRING_CLAIM_GRACE_MS,
  createAgentSetupPairing,
  createProjectForUser,
  getAgentSetupPairing,
  revokeAgentSetupPairing,
  userProjectRole,
  type AgentSetupPairingRecord
} from "../lib/auth.js";
import {
  openAIJudgeProviderBaseUrl,
  resolveJudgeProviderApiKey
} from "../lib/judge-provider.js";
import { fetchJudgeModelCatalog, JudgeModelCatalogError } from "../lib/judge-models.js";
import {
  AmbiguousProjectSkillError,
  NoCurrentSkillError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables, RequestServices } from "../request-services/index.js";

// Owner setup and POST /api/projects import the same first-key identity so
// onboarding copy and the Settings list cannot drift apart.
export const FIRST_PROJECT_KEY_NAME = "First verdict";

export function agentSetupPairingClaimExpiresAt(pairing: AgentSetupPairingRecord): string | null {
  if (!pairing.claimedAt) return null;
  return new Date(Date.parse(pairing.claimedAt) + AGENT_SETUP_PAIRING_CLAIM_GRACE_MS).toISOString();
}

export function agentSetupPairingStatus(
  pairing: AgentSetupPairingRecord
): "pending" | "claimed" | "completed" | "expired" | "revoked" {
  if (pairing.revokedAt) return "revoked";
  if (pairing.consumedAt) return "completed";
  const claimExpiresAt = agentSetupPairingClaimExpiresAt(pairing);
  if (claimExpiresAt && Date.parse(claimExpiresAt) > Date.now()) return "claimed";
  // An abandoned claim is terminal even when the original token TTL has a few
  // minutes left; the owner can now generate a replacement safely.
  if (pairing.claimedAt) return "expired";
  if (Date.parse(pairing.expiresAt) <= Date.now()) return "expired";
  return "pending";
}

type ProjectAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface ProjectAdministrationRouteOptions {
  repository: CoevalRepository;
  pool?: Pool | undefined;
  requestServices: RequestServices;
  publicApiBaseUrl(c: Context<{ Variables: AppVariables }>): string;
}

// Registration stays on the parent app so the global body-limit, API-key,
// session, and project-membership middleware retain their exact route order.
export function registerProjectAdministrationRoutes(
  app: ProjectAdministrationApp,
  options: ProjectAdministrationRouteOptions
): void {
  const { repository, pool, requestServices } = options;

  app.get("/api/projects", async (c) => {
    return c.json({ projects: await repository.listProjects(c.get("user")?.id) });
  });

  // Create a project in the caller's organization. The creator becomes the
  // project owner. This route must work with zero memberships after deletion.
  app.post("/api/projects", async (c) => {
    c.header("cache-control", "no-store");
    if (!pool) {
      return c.json({ error: "Project creation requires auth mode (in-memory demo is single-project)" }, 501);
    }
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({ name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH), mode: ProjectModeSchema.optional() })
      .safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid project input", details: z.treeifyError(parsed.error) }, 400);
    }
    const created = await createProjectForUser(pool, {
      userId: user.id,
      email: user.email ?? "user",
      name: parsed.data.name,
      apiKeyName: FIRST_PROJECT_KEY_NAME,
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {})
    });
    return c.json({ projectId: created.projectId, apiKey: created.apiKey }, 201);
  });

  // Beginner-facing agent connection: a signed-in project owner creates a
  // 15-minute, single-use capability and pastes it into Claude, Codex, or any
  // other external harness. The database stores only its hash. It authorizes
  // setup for this project only and never reaches adjudication/golden routes.
  app.post("/api/agent-setup/pairings", async (c) => {
    c.header("cache-control", "no-store");
    if (!pool) {
      return c.json({ error: "Agent pairing requires database-backed auth mode." }, 501);
    }
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const projectId = c.get("projectId");
    const role = await userProjectRole(pool, { userId: user.id, projectId });
    if (role !== "owner") return c.json({ error: "Only project owners can connect a setup agent." }, 403);
    const project = (await repository.listProjects(user.id)).find((candidate) => candidate.id === projectId);
    if (!project) return c.json({ error: "Project not found." }, 404);
    if (project.importedTraceCount > 0) {
      return c.json({
        error: "Agent pairing is limited to new projects with no imported cases.",
        code: "project_not_empty"
      }, 409);
    }
    const skill = await repository.getLatestSkill(projectId);
    if (!skill.isStarter) {
      return c.json({
        error: "This project's starter judging skill has already been configured.",
        code: "project_already_configured"
      }, 409);
    }

    let pairing;
    try {
      pairing = await createAgentSetupPairing(pool, {
        projectId,
        createdByUserId: user.id
      });
    } catch (error) {
      if (error instanceof AgentSetupPairingInProgressError) {
        return c.json({ error: error.message, code: "pairing_already_claimed" }, 409);
      }
      throw error;
    }
    return c.json({
      id: pairing.id,
      projectId: pairing.projectId,
      projectName: pairing.projectName,
      ownerEmail: pairing.ownerEmail,
      apiBaseUrl: options.publicApiBaseUrl(c),
      expiresAt: pairing.expiresAt,
      claimExpiresAt: agentSetupPairingClaimExpiresAt(pairing),
      status: agentSetupPairingStatus(pairing),
      token: pairing.token
    }, 201);
  });

  app.get("/api/agent-setup/pairings/:pairingId", async (c) => {
    if (!pool) return c.json({ error: "Agent pairing requires auth mode." }, 501);
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const projectId = c.get("projectId");
    const role = await userProjectRole(pool, { userId: user.id, projectId });
    if (role !== "owner") return c.json({ error: "Only project owners can inspect setup connections." }, 403);
    const pairing = await getAgentSetupPairing(pool, { id: c.req.param("pairingId"), projectId });
    if (!pairing) return c.json({ error: "Agent setup connection not found." }, 404);
    return c.json({
      id: pairing.id,
      projectId: pairing.projectId,
      projectName: pairing.projectName,
      ownerEmail: pairing.ownerEmail,
      apiBaseUrl: options.publicApiBaseUrl(c),
      expiresAt: pairing.expiresAt,
      claimExpiresAt: agentSetupPairingClaimExpiresAt(pairing),
      status: agentSetupPairingStatus(pairing)
    });
  });

  app.delete("/api/agent-setup/pairings/:pairingId", async (c) => {
    if (!pool) return c.json({ error: "Agent pairing requires auth mode." }, 501);
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const projectId = c.get("projectId");
    const role = await userProjectRole(pool, { userId: user.id, projectId });
    if (role !== "owner") return c.json({ error: "Only project owners can revoke setup connections." }, 403);
    const revoked = await revokeAgentSetupPairing(pool, {
      id: c.req.param("pairingId"),
      projectId
    });
    if (revoked) return c.body(null, 204);
    const pairing = await getAgentSetupPairing(pool, { id: c.req.param("pairingId"), projectId });
    if (pairing && agentSetupPairingStatus(pairing) === "claimed") {
      return c.json({ error: "Agent setup is already running and can no longer be revoked." }, 409);
    }
    return c.json({ error: "Active agent setup connection not found." }, 404);
  });

  app.get("/api/judge/providers", async (c) => {
    return c.json({ providers: await requestServices.listJudgeProviders(c.get("projectId")) });
  });

  app.get("/api/judge/providers/:provider/models", async (c) => {
    const parsed = JudgeProviderIdSchema.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json({ error: "Unknown judge provider" }, 400);
    if (parsed.data === "custom") {
      return c.json({ error: "Custom OpenAI-compatible models are entered manually" }, 400);
    }
    const projectKey = parsed.data === "mock"
      ? null
      : await repository.getJudgeProviderCredential(c.get("projectId"), parsed.data);
    const apiKey = resolveJudgeProviderApiKey(parsed.data, projectKey ?? undefined);
    const openAIBaseUrl = parsed.data === "openai" ? openAIJudgeProviderBaseUrl() : undefined;
    try {
      return c.json(await fetchJudgeModelCatalog({
        provider: parsed.data,
        ...(apiKey ? { apiKey } : {}),
        ...(openAIBaseUrl ? { baseUrl: openAIBaseUrl } : {})
      }));
    } catch (error) {
      if (error instanceof JudgeModelCatalogError) {
        // Missing configuration is caller state (409); provider outages,
        // timeouts, and malformed upstream responses remain 502.
        return c.json({ error: error.message }, error.kind === "unconfigured" ? 409 : 502);
      }
      throw error;
    }
  });

  app.get("/api/project/settings", async (c) => {
    return c.json(await repository.getProjectSettings(c.get("projectId")));
  });

  app.patch("/api/project/settings", async (c) => {
    if (pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can edit project settings" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdateProjectSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid project settings input", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json(await repository.updateProjectSettings(c.get("projectId"), parsed.data, {
      actorUserId: c.get("user")?.id
    }));
  });

  app.post("/api/project/retention/prune", async (c) => {
    if (pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can prune project traces" }, 403);
    }

    return c.json(await repository.pruneExpiredTraces(c.get("projectId"), {
      actorUserId: c.get("user")?.id
    }));
  });

  app.delete("/api/project", async (c) => {
    if (pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can delete projects" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = DeleteProjectInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid project deletion input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      await repository.deleteProject(c.get("projectId"), {
        confirmProjectName: parsed.data.confirmProjectName,
        actorUserId: c.get("user")?.id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/confirmation/i.test(message)) return c.json({ error: "Project name confirmation did not match" }, 400);
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.get("/api/dashboard", async (c) => {
    let summary;
    try {
      summary = await repository.getDashboardSummary(
        c.get("projectId"),
        c.req.query("criterionId") || undefined
      );
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "ambiguous_project_skill" }, 409);
      }
      if (error instanceof NoCurrentSkillError) {
        return c.json({ error: error.message, code: "criterion_not_found" }, 404);
      }
      throw error;
    }
    const user = c.get("user");
    // Demo mode has no roles. In auth mode this prevents member dashboards
    // from rendering owner-only pairing affordances that can only return 403.
    const role = user && pool
      ? await userProjectRole(pool, { userId: user.id, projectId: c.get("projectId") })
      : "owner";
    return c.json({ ...summary, viewerRole: role === "owner" ? "owner" : "member" });
  });

  app.get("/api/onboarding/evidence-inventory", async (c) => {
    const inventory = await repository.getOnboardingEvidenceInventory(c.get("projectId"));
    return c.json(OnboardingEvidenceInventorySchema.parse(inventory));
  });
}
