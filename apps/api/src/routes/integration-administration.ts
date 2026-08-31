import type { Pool } from "pg";
import type { Hono } from "hono";
import { z } from "zod";
import {
  FeedbackSyncStatusSchema,
  ImportJobStatusSchema,
  type IronsideConnectionTestResult,
  type IronsideEvaluatorContext,
  type IronsideImportEnqueueResult,
  IronsideImportRequestSchema,
  IronsideIntegrationInputSchema,
  type LangfuseConnectionTestResult,
  type LangfuseImportEnqueueResult,
  LangfuseImportRequestSchema,
  LangfuseIntegrationInputSchema,
  type LangSmithConnectionTestResult,
  type LangSmithImportEnqueueResult,
  LangSmithImportRequestSchema,
  LangSmithIntegrationInputSchema,
  UpdateIronsideIntegrationInputSchema,
  UpdateLangfuseIntegrationInputSchema,
  UpdateLangSmithIntegrationInputSchema
} from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import type { CoevalAuth } from "../lib/auth.js";
import { userProjectRole } from "../lib/auth.js";
import { IronsideClient, IronsideHttpError, type IronsideTraceSource } from "../lib/ironside.js";
import { LangfuseClient, LangfuseHttpError, type LangfuseTraceFetcher } from "../lib/langfuse.js";
import { LangSmithClient, LangSmithHttpError, type LangSmithTraceFetcher } from "../lib/langsmith.js";
import {
  AmbiguousProjectSkillError,
  DatasetRevisionConflictError,
  IronsideIntegrationAlreadyExistsError,
  IronsideIntegrationChangedError,
  IronsideIntegrationNotFoundError,
  LangfuseIntegrationNotFoundError,
  LangSmithIntegrationNotFoundError,
  type CoevalRepository,
  type IronsideImportContext,
  type LangfuseImportContext,
  type LangSmithImportContext
} from "../repository.js";
import type { AppVariables, RequestServices } from "../request-services/index.js";

type IntegrationAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface IntegrationAdministrationRouteOptions {
  repository: CoevalRepository;
  requestServices: RequestServices;
  auth?: CoevalAuth | undefined;
  pool?: Pool | undefined;
  queue?: Queue | undefined;
  langSmithClientFactory?: ((context: LangSmithImportContext) => LangSmithTraceFetcher) | undefined;
  langfuseClientFactory?: ((context: LangfuseImportContext) => LangfuseTraceFetcher) | undefined;
  ironsideClientFactory?: ((context: Pick<IronsideImportContext, "url" | "apiKey">) => IronsideTraceSource) | undefined;
}

// Registration remains after legacy gate reads and before legacy case,
// verdict, and review-queue administration in the composition root.
export function registerIntegrationAdministrationRoutes(
  app: IntegrationAdministrationApp,
  options: IntegrationAdministrationRouteOptions
): void {
  const { repository, requestServices } = options;
  const { resolveSkillVersionId } = requestServices;

  app.get("/api/import-jobs", async (c) => {
    const parsed = z.object({
      status: ImportJobStatusSchema.optional(),
      limit: z.coerce.number().int().positive().max(100).default(10)
    }).safeParse({
      status: c.req.query("status") ?? undefined,
      limit: c.req.query("limit") ?? undefined
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid import job query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({
      importJobs: await repository.listImportJobs({
        projectId: c.get("projectId"),
        status: parsed.data.status,
        limit: parsed.data.limit
      })
    });
  });

  app.get("/api/integrations/langsmith", async (c) => {
    return c.json({ integrations: await repository.listLangSmithIntegrations(c.get("projectId")) });
  });

  app.post("/api/integrations/langsmith", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can configure LangSmith integrations" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = LangSmithIntegrationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid LangSmith integration input", details: z.treeifyError(parsed.error) }, 400);
    }

    const pollFloorError = validateLangSmithPollFloor(parsed.data.pollIntervalSeconds);
    if (pollFloorError) return c.json({ error: pollFloorError }, 400);

    try {
      const integration = await repository.createLangSmithIntegration(c.get("projectId"), parsed.data);
      return c.json({ integration }, 201);
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_skill_version" }, 400);
      }
      throw error;
    }
  });

  app.patch("/api/integrations/langsmith/:integrationId", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can change LangSmith polling settings" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdateLangSmithIntegrationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid LangSmith integration settings input", details: z.treeifyError(parsed.error) }, 400);
    }

    const pollFloorError = validateLangSmithPollFloor(parsed.data.pollIntervalSeconds);
    if (pollFloorError) return c.json({ error: pollFloorError }, 400);

    try {
      const integration = await repository.updateLangSmithIntegration(c.get("projectId"), c.req.param("integrationId"), parsed.data);
      return c.json({ integration });
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_skill_version" }, 400);
      }
      if (!(error instanceof LangSmithIntegrationNotFoundError)) throw error;
      return c.json({ error: "LangSmith integration not found" }, 404);
    }
  });

  app.delete("/api/integrations/langsmith/:integrationId", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can disconnect LangSmith integrations" }, 403);
    }

    try {
      await repository.deleteLangSmithIntegration(c.get("projectId"), c.req.param("integrationId"), {
        actorUserId: c.get("user")?.id
      });
      return c.json({ ok: true });
    } catch (error) {
      if (!(error instanceof LangSmithIntegrationNotFoundError)) throw error;
      return c.json({ error: "LangSmith integration not found" }, 404);
    }
  });

  app.post("/api/integrations/langsmith/:integrationId/test", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can test LangSmith integrations" }, 403);
    }

    const projectId = c.get("projectId");
    const integrationId = c.req.param("integrationId");
    const checkedAt = new Date().toISOString();
    let context: LangSmithImportContext;
    try {
      context = await repository.loadLangSmithImportContext({
        projectId,
        integrationId,
        limit: 1
      });
    } catch (error) {
      if (error instanceof LangSmithIntegrationNotFoundError) {
        return c.json({ error: "LangSmith integration not found" }, 404);
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: LangSmithConnectionTestResult = {
        ok: false,
        checkedAt,
        error: message
      };
      await repository.recordLangSmithConnectionTest(projectId, integrationId, result).catch(() => undefined);
      return c.json(result, 502);
    }

    const client = (options.langSmithClientFactory ?? defaultLangSmithClientFactory)(context);
    let sampleRunCount: number;
    try {
      const runs = await client.listRuns({ projectName: context.projectName, limit: 1 });
      sampleRunCount = runs.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof LangSmithHttpError ? error.status : undefined;
      const result: LangSmithConnectionTestResult = {
        ok: false,
        checkedAt,
        ...(status !== undefined ? { status } : {}),
        error: message
      };
      await repository.recordLangSmithConnectionTest(projectId, integrationId, result).catch(() => undefined);
      return c.json(result, 502);
    }

    const result: LangSmithConnectionTestResult = {
      ok: true,
      checkedAt,
      sampleRunCount
    };
    await repository.recordLangSmithConnectionTest(projectId, integrationId, result);
    return c.json(result);
  });

  app.post("/api/integrations/langsmith/:integrationId/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = LangSmithImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid LangSmith import input", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const integrationId = c.req.param("integrationId");
    const resolvedVersion = await resolveSkillVersionId(projectId, parsed.data.skillVersionId, {
      context: "scheduled_import", resourceKind: "integration", resourceId: integrationId
    });
    if ("invalid" in resolvedVersion) {
      return c.json({ error: resolvedVersion.invalid, code: "skill_version_required" },
        parsed.data.skillVersionId === undefined && resolvedVersion.invalid.includes("multiple criteria") ? 409 : 400);
    }

    try {
      await repository.loadLangSmithImportContext({ projectId, integrationId, skillVersionId: resolvedVersion.id, limit: parsed.data.limit });
    } catch (error) {
      if (!(error instanceof LangSmithIntegrationNotFoundError)) throw error;
      return c.json({ error: "LangSmith integration not found" }, 404);
    }

    let importJob = await repository.createImportJob({
      projectId,
      source: "langsmith",
      sourceIntegrationId: integrationId,
      skillVersionId: resolvedVersion.id,
      actorUserId: c.get("user")?.id,
      requestedLimit: parsed.data.limit
    });
    let queueJobId: string | null = null;
    try {
      queueJobId = await options.queue?.send("langsmith.import", {
        projectId,
        integrationId,
        skillVersionId: resolvedVersion.id,
        limit: parsed.data.limit,
        importJobId: importJob.id
      }, { retryLimit: 5, retryBackoff: true }) ?? null;
    } catch (error) {
      importJob = await repository.markImportJobFailed(projectId, importJob.id, error);
      const result: LangSmithImportEnqueueResult = {
        queued: false,
        queueJobId: null,
        importJob
      };
      return c.json(result, 202);
    }

    if (queueJobId) {
      importJob = await repository.markImportJobQueued(projectId, importJob.id, queueJobId);
    } else {
      importJob = await repository.markImportJobFailed(projectId, importJob.id, new Error("Queue unavailable; LangSmith import was not enqueued"));
    }

    const result: LangSmithImportEnqueueResult = {
      queued: Boolean(queueJobId),
      queueJobId: queueJobId ?? null,
      importJob
    };
    return c.json(result, 202);
  });

  app.get("/api/integrations/langfuse", async (c) => {
    return c.json({ integrations: await repository.listLangfuseIntegrations(c.get("projectId")) });
  });

  app.post("/api/integrations/langfuse", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can configure Langfuse integrations" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = LangfuseIntegrationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Langfuse integration input", details: z.treeifyError(parsed.error) }, 400);
    }

    const pollFloorError = validateLangfusePollFloor(parsed.data.pollIntervalSeconds);
    if (pollFloorError) return c.json({ error: pollFloorError }, 400);

    try {
      const integration = await repository.createLangfuseIntegration(c.get("projectId"), parsed.data);
      return c.json({ integration }, 201);
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_skill_version" }, 400);
      }
      throw error;
    }
  });

  app.patch("/api/integrations/langfuse/:integrationId", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can change Langfuse polling settings" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdateLangfuseIntegrationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Langfuse integration settings input", details: z.treeifyError(parsed.error) }, 400);
    }

    const pollFloorError = validateLangfusePollFloor(parsed.data.pollIntervalSeconds);
    if (pollFloorError) return c.json({ error: pollFloorError }, 400);

    try {
      const integration = await repository.updateLangfuseIntegration(c.get("projectId"), c.req.param("integrationId"), parsed.data);
      return c.json({ integration });
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_skill_version" }, 400);
      }
      if (!(error instanceof LangfuseIntegrationNotFoundError)) throw error;
      return c.json({ error: "Langfuse integration not found" }, 404);
    }
  });

  app.delete("/api/integrations/langfuse/:integrationId", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can disconnect Langfuse integrations" }, 403);
    }

    try {
      await repository.deleteLangfuseIntegration(c.get("projectId"), c.req.param("integrationId"), {
        actorUserId: c.get("user")?.id
      });
      return c.json({ ok: true });
    } catch (error) {
      if (!(error instanceof LangfuseIntegrationNotFoundError)) throw error;
      return c.json({ error: "Langfuse integration not found" }, 404);
    }
  });

  app.post("/api/integrations/langfuse/:integrationId/test", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can test Langfuse integrations" }, 403);
    }

    const projectId = c.get("projectId");
    const integrationId = c.req.param("integrationId");
    const checkedAt = new Date().toISOString();
    let context: LangfuseImportContext;
    try {
      context = await repository.loadLangfuseImportContext({
        projectId,
        integrationId,
        limit: 1
      });
    } catch (error) {
      if (error instanceof LangfuseIntegrationNotFoundError) {
        return c.json({ error: "Langfuse integration not found" }, 404);
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: LangfuseConnectionTestResult = {
        ok: false,
        checkedAt,
        error: message
      };
      await repository.recordLangfuseConnectionTest(projectId, integrationId, result).catch(() => undefined);
      return c.json(result, 502);
    }

    const client = (options.langfuseClientFactory ?? defaultLangfuseClientFactory)(context);
    let sampleRunCount: number;
    try {
      const traces = await client.listTraces({ limit: 1 });
      sampleRunCount = traces.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof LangfuseHttpError ? error.status : undefined;
      const result: LangfuseConnectionTestResult = {
        ok: false,
        checkedAt,
        ...(status !== undefined ? { status } : {}),
        error: message
      };
      await repository.recordLangfuseConnectionTest(projectId, integrationId, result).catch(() => undefined);
      return c.json(result, 502);
    }

    const result: LangfuseConnectionTestResult = {
      ok: true,
      checkedAt,
      sampleRunCount
    };
    await repository.recordLangfuseConnectionTest(projectId, integrationId, result);
    return c.json(result);
  });

  app.post("/api/integrations/langfuse/:integrationId/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = LangfuseImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Langfuse import input", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const integrationId = c.req.param("integrationId");
    const resolvedVersion = await resolveSkillVersionId(projectId, parsed.data.skillVersionId, {
      context: "scheduled_import", resourceKind: "integration", resourceId: integrationId
    });
    if ("invalid" in resolvedVersion) {
      return c.json({ error: resolvedVersion.invalid, code: "skill_version_required" },
        parsed.data.skillVersionId === undefined && resolvedVersion.invalid.includes("multiple criteria") ? 409 : 400);
    }

    try {
      await repository.loadLangfuseImportContext({ projectId, integrationId, skillVersionId: resolvedVersion.id, limit: parsed.data.limit });
    } catch (error) {
      if (!(error instanceof LangfuseIntegrationNotFoundError)) throw error;
      return c.json({ error: "Langfuse integration not found" }, 404);
    }

    let importJob = await repository.createImportJob({
      projectId,
      source: "langfuse",
      sourceIntegrationId: integrationId,
      skillVersionId: resolvedVersion.id,
      actorUserId: c.get("user")?.id,
      requestedLimit: parsed.data.limit
    });
    let queueJobId: string | null = null;
    try {
      queueJobId = await options.queue?.send("langfuse.import", {
        projectId,
        integrationId,
        skillVersionId: resolvedVersion.id,
        limit: parsed.data.limit,
        importJobId: importJob.id
      }, { retryLimit: 5, retryBackoff: true }) ?? null;
    } catch (error) {
      importJob = await repository.markImportJobFailed(projectId, importJob.id, error);
      const result: LangfuseImportEnqueueResult = {
        queued: false,
        queueJobId: null,
        importJob
      };
      return c.json(result, 202);
    }

    if (queueJobId) {
      importJob = await repository.markImportJobQueued(projectId, importJob.id, queueJobId);
    } else {
      importJob = await repository.markImportJobFailed(projectId, importJob.id, new Error("Queue unavailable; Langfuse import was not enqueued"));
    }

    const result: LangfuseImportEnqueueResult = {
      queued: Boolean(queueJobId),
      queueJobId: queueJobId ?? null,
      importJob
    };
    return c.json(result, 202);
  });

  app.get("/api/integrations/ironside", async (c) => {
    return c.json({ integrations: await repository.listIronsideIntegrations(c.get("projectId")) });
  });

  app.post("/api/integrations/ironside", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can configure Ironside integrations" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = IronsideIntegrationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Ironside integration input", details: z.treeifyError(parsed.error) }, 400);
    }

    const pollFloorError = validateIronsidePollFloor(parsed.data.pollIntervalSeconds);
    if (pollFloorError) return c.json({ error: pollFloorError }, 400);

    try {
      const client = (options.ironsideClientFactory ?? defaultIronsideAppClientFactory)({
        url: parsed.data.url,
        apiKey: parsed.data.apiKey
      });
      const remote = await client.getContext();
      const integration = await repository.createIronsideIntegration(c.get("projectId"), parsed.data, remote);
      return c.json({ integration }, 201);
    } catch (error) {
      if (error instanceof IronsideHttpError || error instanceof z.ZodError || error instanceof TypeError) {
        return c.json({
          error: error instanceof Error ? error.message : "Ironside connection validation failed",
          code: "ironside_connection_failed",
          ...(error instanceof IronsideHttpError ? { status: error.status } : {})
        }, 502);
      }
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_skill_version" }, 400);
      }
      if (error instanceof IronsideIntegrationAlreadyExistsError) {
        return c.json({
          error: "An Ironside connection already exists. Update it in place, or disconnect it before connecting another project.",
          code: "ironside_integration_exists"
        }, 409);
      }
      throw error;
    }
  });

  app.patch("/api/integrations/ironside/:integrationId", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can change Ironside polling settings" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdateIronsideIntegrationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Ironside integration settings input", details: z.treeifyError(parsed.error) }, 400);
    }

    const pollFloorError = validateIronsidePollFloor(parsed.data.pollIntervalSeconds);
    if (pollFloorError) return c.json({ error: pollFloorError }, 400);

    try {
      const projectId = c.get("projectId");
      const integrationId = c.req.param("integrationId");
      const current = await repository.loadIronsideImportContext({
        projectId,
        integrationId,
        limit: 1
      });
      if (
        current.revalidationRequired &&
        (parsed.data.url !== undefined || parsed.data.apiKey !== undefined)
      ) {
        return c.json({
          error: "A quarantined Ironside connection must be tested successfully or disconnected before its credentials can change.",
          code: "ironside_revalidation_requires_disconnect"
        }, 409);
      }
      if (current.revalidationRequired && parsed.data.pollEnabled === true) {
        return c.json({
          error: "Test this Ironside connection successfully before enabling polling.",
          code: "ironside_revalidation_required"
        }, 409);
      }
      let remote: IronsideEvaluatorContext | undefined;
      if (parsed.data.url !== undefined || parsed.data.apiKey !== undefined) {
        const client = (options.ironsideClientFactory ?? defaultIronsideAppClientFactory)({
          url: parsed.data.url ?? current.url,
          apiKey: parsed.data.apiKey ?? current.apiKey
        });
        remote = await client.getContext();
        if (remote.project.id !== current.remoteProjectId) {
          return c.json({
            error: "The replacement credentials belong to a different Ironside project. Disconnect and create a new connection instead.",
            code: "ironside_project_mismatch"
          }, 409);
        }
      }
      const integration = await repository.updateIronsideIntegration(
        projectId,
        integrationId,
        parsed.data,
        remote,
        {
          remoteProjectId: current.remoteProjectId,
          revalidationRequired: current.revalidationRequired,
          connectionRevision: current.connectionRevision
        }
      );
      return c.json({ integration });
    } catch (error) {
      if (error instanceof IronsideHttpError || error instanceof z.ZodError || error instanceof TypeError) {
        return c.json({
          error: error instanceof Error ? error.message : "Ironside connection validation failed",
          code: "ironside_connection_failed",
          ...(error instanceof IronsideHttpError ? { status: error.status } : {})
        }, 502);
      }
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_skill_version" }, 400);
      }
      if (error instanceof IronsideIntegrationChangedError) {
        return c.json({
          error: "The Ironside connection changed while this request was validating it. Reload and try again.",
          code: "ironside_integration_changed"
        }, 409);
      }
      if (!(error instanceof IronsideIntegrationNotFoundError)) throw error;
      return c.json({ error: "Ironside integration not found" }, 404);
    }
  });

  app.delete("/api/integrations/ironside/:integrationId", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can disconnect Ironside integrations" }, 403);
    }

    try {
      await repository.deleteIronsideIntegration(c.get("projectId"), c.req.param("integrationId"), {
        actorUserId: c.get("user")?.id
      });
      return c.json({ ok: true });
    } catch (error) {
      if (!(error instanceof IronsideIntegrationNotFoundError)) throw error;
      return c.json({ error: "Ironside integration not found" }, 404);
    }
  });

  app.post("/api/integrations/ironside/:integrationId/test", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can test Ironside integrations" }, 403);
    }

    const projectId = c.get("projectId");
    const integrationId = c.req.param("integrationId");
    const checkedAt = new Date().toISOString();
    let context: IronsideImportContext;
    try {
      context = await repository.loadIronsideImportContext({
        projectId,
        integrationId,
        limit: 1
      });
    } catch (error) {
      if (error instanceof IronsideIntegrationNotFoundError) {
        return c.json({ error: "Ironside integration not found" }, 404);
      }
      const message = error instanceof Error ? error.message : String(error);
      const result: IronsideConnectionTestResult = {
        ok: false,
        checkedAt,
        error: message
      };
      await repository.recordIronsideConnectionTest(projectId, integrationId, result).catch(() => undefined);
      return c.json(result, 502);
    }

    const client = (options.ironsideClientFactory ?? defaultIronsideAppClientFactory)(context);
    let remote: IronsideEvaluatorContext;
    try {
      remote = await client.getContext();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof IronsideHttpError ? error.status : undefined;
      const result: IronsideConnectionTestResult = {
        ok: false,
        checkedAt,
        ...(status !== undefined ? { status } : {}),
        error: message
      };
      await repository.recordIronsideConnectionTest(projectId, integrationId, result).catch(() => undefined);
      return c.json(result, 502);
    }

    const result: IronsideConnectionTestResult = {
      ok: true,
      checkedAt,
      protocolVersion: remote.protocolVersion,
      remoteProjectId: remote.project.id,
      remoteProjectName: remote.project.name
    };
    if (context.remoteProjectId !== remote.project.id) {
      const failed: IronsideConnectionTestResult = {
        ok: false,
        checkedAt,
        error: "The configured credentials now resolve to a different Ironside project."
      };
      await repository.quarantineIronsideIntegration(
        projectId,
        integrationId,
        {
          remoteProjectId: context.remoteProjectId,
          connectionRevision: context.connectionRevision
        },
        failed
      );
      return c.json(failed, 409);
    }
    try {
      await repository.updateIronsideIntegration(
        projectId,
        integrationId,
        {},
        remote,
        {
          remoteProjectId: context.remoteProjectId,
          revalidationRequired: context.revalidationRequired,
          connectionRevision: context.connectionRevision
        }
      );
    } catch (error) {
      if (!(error instanceof IronsideIntegrationChangedError)) throw error;
      return c.json({
        ok: false,
        checkedAt,
        error: "The Ironside connection changed while this test was running. Reload and test it again."
      }, 409);
    }
    await repository.recordIronsideConnectionTest(projectId, integrationId, result);
    if (options.queue) {
      const blockedFeedback = await repository.listBlockedIronsideFeedbackSyncJobs(
        projectId,
        integrationId
      );
      for (const job of blockedFeedback) {
        try {
          await options.queue.send("feedback.sync", job, { retryLimit: 5, retryBackoff: true });
          // The worker may finish before this conditional transition. PG only
          // changes `blocked` rows, so a fast `synced` result cannot regress.
          await repository.markFeedbackSyncPending(job);
        } catch (error) {
          // Keep the durable row blocked. A later successful connection test
          // retries dispatch without losing the assessment or duplicating the
          // upstream score id.
          console.error(`Unable to requeue blocked Ironside feedback ${job.feedbackSyncJobId}:`, error);
        }
      }
    }
    return c.json(result);
  });

  app.post("/api/integrations/ironside/:integrationId/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = IronsideImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid Ironside import input", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const integrationId = c.req.param("integrationId");
    const resolvedVersion = await resolveSkillVersionId(projectId, parsed.data.skillVersionId, {
      context: "scheduled_import", resourceKind: "integration", resourceId: integrationId
    });
    if ("invalid" in resolvedVersion) {
      return c.json({ error: resolvedVersion.invalid, code: "skill_version_required" },
        parsed.data.skillVersionId === undefined && resolvedVersion.invalid.includes("multiple criteria") ? 409 : 400);
    }

    try {
      const context = await repository.loadIronsideImportContext({
        projectId,
        integrationId,
        skillVersionId: resolvedVersion.id,
        limit: parsed.data.limit
      });
      if (context.revalidationRequired) {
        return c.json({
          error: "This Ironside connection must be tested successfully before importing.",
          code: "ironside_revalidation_required"
        }, 409);
      }
    } catch (error) {
      if (!(error instanceof IronsideIntegrationNotFoundError)) throw error;
      return c.json({ error: "Ironside integration not found" }, 404);
    }

    let importJob = await repository.createImportJob({
      projectId,
      source: "ironside",
      sourceIntegrationId: integrationId,
      skillVersionId: resolvedVersion.id,
      actorUserId: c.get("user")?.id,
      requestedLimit: parsed.data.limit
    });
    let queueJobId: string | null = null;
    try {
      queueJobId = await options.queue?.send("ironside.import", {
        projectId,
        integrationId,
        skillVersionId: resolvedVersion.id,
        limit: parsed.data.limit,
        importJobId: importJob.id
      }, { retryLimit: 5, retryBackoff: true }) ?? null;
    } catch (error) {
      importJob = await repository.markImportJobFailed(projectId, importJob.id, error);
      const result: IronsideImportEnqueueResult = {
        queued: false,
        queueJobId: null,
        importJob
      };
      return c.json(result, 202);
    }

    if (queueJobId) {
      importJob = await repository.markImportJobQueued(projectId, importJob.id, queueJobId);
    } else {
      importJob = await repository.markImportJobFailed(projectId, importJob.id, new Error("Queue unavailable; Ironside import was not enqueued"));
    }

    const result: IronsideImportEnqueueResult = {
      queued: Boolean(queueJobId),
      queueJobId: queueJobId ?? null,
      importJob
    };
    return c.json(result, 202);
  });

  app.get("/api/feedback-syncs", async (c) => {
    const parsed = z.object({
      status: FeedbackSyncStatusSchema.optional(),
      limit: z.coerce.number().int().positive().max(100).default(50)
    }).safeParse({
      status: c.req.query("status"),
      limit: c.req.query("limit") ?? undefined
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid feedback sync query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({
      feedbackSyncs: await repository.listFeedbackSyncJobs({
        projectId: c.get("projectId"),
        status: parsed.data.status,
        limit: parsed.data.limit
      })
    });
  });
}

function configuredLangSmithPollFloorSeconds(): number {
  const defaultIntervalMs = 5 * 60 * 1000;
  const raw = process.env.LANGSMITH_POLL_INTERVAL_MS;
  const intervalMs = raw ? Number(raw) : defaultIntervalMs;
  if (!Number.isFinite(intervalMs)) return Math.ceil(defaultIntervalMs / 1000);
  if (intervalMs <= 0) return 0;
  return Math.ceil(intervalMs / 1000);
}

function configuredLangfusePollFloorSeconds(): number {
  const defaultIntervalMs = 5 * 60 * 1000;
  const raw = process.env.LANGFUSE_POLL_INTERVAL_MS;
  const intervalMs = raw ? Number(raw) : defaultIntervalMs;
  if (!Number.isFinite(intervalMs)) return Math.ceil(defaultIntervalMs / 1000);
  if (intervalMs <= 0) return 0;
  return Math.ceil(intervalMs / 1000);
}

function validateLangSmithPollFloor(pollIntervalSeconds: number | undefined): string | null {
  const pollFloorSeconds = configuredLangSmithPollFloorSeconds();
  if (
    pollFloorSeconds > 0
    && pollIntervalSeconds !== undefined
    && pollIntervalSeconds < pollFloorSeconds
  ) {
    return `pollIntervalSeconds must be at least ${pollFloorSeconds} seconds because LANGSMITH_POLL_INTERVAL_MS is the global check cadence`;
  }
  return null;
}

function validateLangfusePollFloor(pollIntervalSeconds: number | undefined): string | null {
  const pollFloorSeconds = configuredLangfusePollFloorSeconds();
  if (
    pollFloorSeconds > 0
    && pollIntervalSeconds !== undefined
    && pollIntervalSeconds < pollFloorSeconds
  ) {
    return `pollIntervalSeconds must be at least ${pollFloorSeconds} seconds because LANGFUSE_POLL_INTERVAL_MS is the global check cadence`;
  }
  return null;
}

function defaultLangSmithClientFactory(context: LangSmithImportContext): LangSmithTraceFetcher {
  return new LangSmithClient({ apiKey: context.apiKey, endpointUrl: context.endpointUrl });
}

function defaultLangfuseClientFactory(context: LangfuseImportContext): LangfuseTraceFetcher {
  return new LangfuseClient({ publicKey: context.publicKey, secretKey: context.secretKey, endpointUrl: context.endpointUrl });
}

function configuredIronsidePollFloorSeconds(): number {
  const defaultIntervalMs = 5 * 60 * 1000;
  const raw = process.env.IRONSIDE_POLL_INTERVAL_MS;
  const intervalMs = raw ? Number(raw) : defaultIntervalMs;
  if (!Number.isFinite(intervalMs)) return Math.ceil(defaultIntervalMs / 1000);
  if (intervalMs <= 0) return 0;
  return Math.ceil(intervalMs / 1000);
}

function validateIronsidePollFloor(pollIntervalSeconds: number | undefined): string | null {
  const pollFloorSeconds = configuredIronsidePollFloorSeconds();
  if (
    pollFloorSeconds > 0
    && pollIntervalSeconds !== undefined
    && pollIntervalSeconds < pollFloorSeconds
  ) {
    return `pollIntervalSeconds must be at least ${pollFloorSeconds} seconds because IRONSIDE_POLL_INTERVAL_MS is the global check cadence`;
  }
  return null;
}

function defaultIronsideAppClientFactory(context: Pick<IronsideImportContext, "url" | "apiKey">): IronsideTraceSource {
  return new IronsideClient({ url: context.url, apiKey: context.apiKey });
}
