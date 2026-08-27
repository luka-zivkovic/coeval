import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  ANALYSIS_POPULATION_API_PAGE_MAX,
  ANALYSIS_POPULATION_CURSOR_MAX_LENGTH,
  AnalysisPopulationCreateInputSchema,
  AnalysisPopulationCreateResultSchema,
  AnalysisPopulationDetailSchema,
  AnalysisPopulationExclusionsPageSchema,
  AnalysisPopulationMembersPageSchema,
  AnalysisPopulationOverlapsPageSchema,
  AnalysisPopulationSelectedItemsPageSchema,
  AnalysisPopulationSummariesPageSchema,
  DatasetEvidenceDigestSchema,
  DatasetRevisionPayloadSnapshotSchema
} from "@coeval/shared";
import {
  AnalysisPopulationRepositoryError,
  type AnalysisPopulationAccess,
  type AnalysisPopulationProjectRole,
  type AnalysisPopulationRepository,
  type AnalysisPopulationSelectedContent
} from "./repository.js";

const ANALYSIS_POPULATION_BODY_BYTES = 16 * 1024;
const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ANALYSIS_POPULATION_API_PAGE_MAX).default(50),
  cursor: z.string().min(1).max(ANALYSIS_POPULATION_CURSOR_MAX_LENGTH).nullable().default(null)
}).strict();

const SelectedContentSchema = z.object({
  populationId: z.string().min(1).max(240),
  datasetRevisionId: z.string().min(1).max(240),
  memberId: z.string().min(1).max(240),
  revisionItemId: z.string().min(1).max(240),
  caseId: z.string().min(1).max(240),
  drawPosition: z.number().int().min(0).max(9_999),
  inputDigest: DatasetEvidenceDigestSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  payloadSnapshot: DatasetRevisionPayloadSnapshotSchema
}).strict();

interface AnalysisPopulationRouteIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface CreateAnalysisPopulationRouterOptions {
  repository: AnalysisPopulationRepository | null;
  databaseMode: boolean;
  requestIdentity: (context: Context) => AnalysisPopulationRouteIdentity;
  resolveProjectRole: (input: {
    projectId: string;
    userId: string;
  }) => Promise<AnalysisPopulationProjectRole | null>;
}

export function createAnalysisPopulationRouter(
  options: CreateAnalysisPopulationRouterOptions
): Hono {
  const router = new Hono();
  router.use("*", bodyLimit({
    maxSize: ANALYSIS_POPULATION_BODY_BYTES,
    onError: (c) => c.json({
      error: `Request body exceeds ${ANALYSIS_POPULATION_BODY_BYTES} bytes`,
      code: "analysis_population_body_too_large"
    }, 413)
  }));
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });

  router.post("/", async (c) => {
    const access = await resolveAccess(c, options, true);
    if (access instanceof Response) return access;
    const body = await c.req.json().catch(() => null);
    const parsed = AnalysisPopulationCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: "Invalid analysis population input",
        code: "analysis_population_invalid_input",
        details: z.treeifyError(parsed.error)
      }, 400);
    }
    try {
      const result = await options.repository!.createPopulation(access, parsed.data);
      const verified = AnalysisPopulationCreateResultSchema.safeParse(result);
      if (!verified.success) throw new Error("Analysis population repository returned an invalid create result");
      return c.json({ result: verified.data }, verified.data.reusedPopulation ? 200 : 201);
    } catch (error) {
      return mapRepositoryError(c, error);
    }
  });

  router.get("/", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const result = await callRepository(c, () => options.repository!.listPopulations(access, page));
    if (result instanceof Response) return result;
    const verified = AnalysisPopulationSummariesPageSchema.safeParse(result);
    if (!verified.success) {
      throw new Error("Analysis population repository returned an invalid list result");
    }
    return c.json({ page: verified.data });
  });

  router.get("/:populationId/members", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const populationId = c.req.param("populationId");
    const result = await callRepository(c, () => options.repository!.listMembers(access, populationId, page));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = AnalysisPopulationMembersPageSchema.safeParse(result);
    if (!verified.success || verified.data.items.some((item) => item.populationId !== populationId)) {
      throw new Error("Analysis population repository returned invalid members");
    }
    return c.json({ page: verified.data });
  });

  router.get("/:populationId/selections", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const populationId = c.req.param("populationId");
    const result = await callRepository(c, () => options.repository!.listSelections(access, populationId, page));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = AnalysisPopulationSelectedItemsPageSchema.safeParse(result);
    if (!verified.success || verified.data.items.some((item) => item.populationId !== populationId)) {
      throw new Error("Analysis population repository returned invalid selections");
    }
    return c.json({ page: verified.data });
  });

  router.get("/:populationId/exclusions", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const populationId = c.req.param("populationId");
    const result = await callRepository(c, () => options.repository!.listExclusions(access, populationId, page));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = AnalysisPopulationExclusionsPageSchema.safeParse(result);
    if (!verified.success || verified.data.items.some((item) => item.populationId !== populationId)) {
      throw new Error("Analysis population repository returned invalid exclusions");
    }
    return c.json({ page: verified.data });
  });

  router.get("/:populationId/overlaps", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const populationId = c.req.param("populationId");
    const result = await callRepository(c, () => options.repository!.listOverlaps(access, populationId, page));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = AnalysisPopulationOverlapsPageSchema.safeParse(result);
    if (!verified.success) throw new Error("Analysis population repository returned invalid overlaps");
    return c.json({ page: verified.data });
  });

  router.get("/:populationId/selections/:drawPosition/content", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const rawPosition = c.req.param("drawPosition");
    const position = Number(rawPosition);
    if (!/^(0|[1-9][0-9]{0,3})$/.test(rawPosition) || !Number.isSafeInteger(position)) {
      return c.json({
        error: "Invalid analysis population selection position",
        code: "analysis_population_invalid_selection_position"
      }, 400);
    }
    const result = await callRepository(c, () => options.repository!.getSelectedContent(
      access, c.req.param("populationId"), position
    ));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = SelectedContentSchema.safeParse(result satisfies AnalysisPopulationSelectedContent);
    if (
      !verified.success ||
      verified.data.populationId !== c.req.param("populationId") ||
      verified.data.drawPosition !== position
    ) throw new Error("Analysis population repository returned invalid selected content");
    return c.json({ content: verified.data });
  });

  router.get("/:populationId", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const result = await callRepository(c, () =>
      options.repository!.getPopulation(access, c.req.param("populationId"))
    );
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = AnalysisPopulationDetailSchema.safeParse(result);
    if (!verified.success || verified.data.population.id !== c.req.param("populationId")) {
      throw new Error("Analysis population repository returned an invalid detail result");
    }
    return c.json({ detail: verified.data });
  });

  return router;
}

async function resolveAccess(
  c: Context,
  options: CreateAnalysisPopulationRouterOptions,
  ownerRequired: boolean
): Promise<AnalysisPopulationAccess | Response> {
  if (!options.databaseMode || !options.repository) {
    return c.json({
      error: "Analysis populations require database-backed session mode",
      code: "analysis_population_database_required"
    }, 501);
  }
  const identity = options.requestIdentity(c);
  if (identity.apiKeyId || !identity.userId) {
    return c.json({
      error: "A project session is required for analysis populations",
      code: "analysis_population_session_required"
    }, 401);
  }
  const role = await options.resolveProjectRole({
    projectId: identity.projectId,
    userId: identity.userId
  });
  if (!role) {
    return c.json({
      error: "Analysis population project membership was not found",
      code: "analysis_population_forbidden"
    }, 403);
  }
  if (ownerRequired && role !== "owner") {
    return c.json({
      error: "Only project owners may freeze analysis populations",
      code: "analysis_population_owner_required"
    }, 403);
  }
  return {
    projectId: identity.projectId,
    userId: identity.userId,
    projectRole: role
  };
}

function parsePage(c: Context): { limit: number; cursor: string | null } | Response {
  const parsed = PageQuerySchema.safeParse({
    limit: c.req.query("limit") ?? undefined,
    cursor: c.req.query("cursor") ?? undefined
  });
  if (!parsed.success) {
    return c.json({
      error: "Invalid analysis population page",
      code: "analysis_population_invalid_page",
      details: z.treeifyError(parsed.error)
    }, 400);
  }
  return parsed.data;
}

function notFound(c: Context): Response {
  return c.json({
    error: "Analysis population not found",
    code: "analysis_population_not_found"
  }, 404);
}

function mapRepositoryError(c: Context, error: unknown): Response {
  if (!(error instanceof AnalysisPopulationRepositoryError)) throw error;
  if (error.code === "analysis_population_not_found") return notFound(c);
  if (error.code === "analysis_population_forbidden") {
    return c.json({ error: error.message, code: error.code }, 403);
  }
  if (error.code === "analysis_population_invalid_cursor") {
    return c.json({ error: error.message, code: error.code }, 400);
  }
  if ([
    "analysis_population_window_too_recent",
    "analysis_population_frame_too_large",
    "analysis_population_frame_empty",
    "analysis_population_budget_invalid"
  ].includes(error.code)) {
    return c.json({ error: error.message, code: error.code, details: error.details }, 400);
  }
  return c.json({
    error: error.message,
    code: error.code,
    details: error.details
  }, 409);
}

async function callRepository<T>(c: Context, operation: () => Promise<T>): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    return mapRepositoryError(c, error);
  }
}
