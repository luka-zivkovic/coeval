import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  ANALYSIS_POPULATION_API_PAGE_MAX,
  ANALYSIS_POPULATION_CURSOR_MAX_LENGTH,
  AnalysisCriterionPromotionCandidatesPageSchema,
  AnalysisCriterionPromotionCreateInputSchema,
  AnalysisCriterionPromotionCreateResultSchema,
  AnalysisCriterionPromotionDetailSchema,
  AnalysisCriterionPromotionSummariesPageSchema,
  AnalysisCriterionPromotionSupportsPageSchema,
  type AnalysisCriterionPromotionCreateInput,
  type AnalysisCriterionPromotionCreateResult
} from "@coeval/shared";
import {
  AnalysisPromotionRepositoryError,
  type AnalysisPromotionAccess,
  type AnalysisPromotionProjectRole,
  type AnalysisPromotionRepository
} from "./repository.js";
import { analysisCriterionPromotionRequestDigest } from "../lib/analysis-promotion.js";

const ANALYSIS_PROMOTION_BODY_BYTES = 2 * 1024 * 1024;
const ResourceIdSchema = z.string().trim().min(1).max(240);
const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ANALYSIS_POPULATION_API_PAGE_MAX).default(50),
  cursor: z.string().min(1).max(ANALYSIS_POPULATION_CURSOR_MAX_LENGTH).nullable().default(null)
}).strict();
const PromotionListQuerySchema = PageQuerySchema.extend({
  studyId: ResourceIdSchema
}).strict();
const PromotionCandidatesQuerySchema = PromotionListQuerySchema.extend({
  taxonomyRevisionId: ResourceIdSchema,
  codeId: ResourceIdSchema
}).strict();

interface AnalysisPromotionRouteIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface CreateAnalysisPromotionRouterOptions {
  repository: AnalysisPromotionRepository | null;
  databaseMode: boolean;
  requestIdentity: (context: Context) => AnalysisPromotionRouteIdentity;
  resolveProjectRole: (input: {
    projectId: string;
    userId: string;
  }) => Promise<AnalysisPromotionProjectRole | null>;
}

export function createAnalysisPromotionRouter(options: CreateAnalysisPromotionRouterOptions): Hono {
  const router = new Hono();
  router.use("*", bodyLimit({
    maxSize: ANALYSIS_PROMOTION_BODY_BYTES,
    onError: (c) => c.json({
      error: `Request body exceeds ${ANALYSIS_PROMOTION_BODY_BYTES} bytes`,
      code: "analysis_promotion_body_too_large"
    }, 413)
  }));
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });

  router.post("/", async (c) => {
    const actor = await resolveOwner(c, options);
    if (actor instanceof Response) return actor;
    const body = await c.req.json().catch(() => null);
    const parsed = AnalysisCriterionPromotionCreateInputSchema.safeParse(body);
    if (!parsed.success) return invalidInput(c, parsed.error);
    const result = await callRepository(c, () => options.repository!.createPromotion(actor, parsed.data));
    if (result instanceof Response) return result;
    const verified = AnalysisCriterionPromotionCreateResultSchema.safeParse(result);
    if (!verified.success || !createResultMatches(actor, parsed.data, verified.data)) {
      throw new Error("Analysis promotion repository returned an invalid create result");
    }
    return c.json({ result: verified.data }, verified.data.replayed ? 200 : 201);
  });

  router.get("/candidates", async (c) => {
    const access = await resolveOwner(c, options);
    if (access instanceof Response) return access;
    const query = parseQuery(c, PromotionCandidatesQuerySchema);
    if (query instanceof Response) return query;
    const result = await callRepository(c, () => options.repository!.listCandidates(access, query));
    if (result instanceof Response) return result;
    const verified = AnalysisCriterionPromotionCandidatesPageSchema.safeParse(result);
    if (!verified.success || verified.data.items.some((candidate) =>
      candidate.projectId !== access.projectId ||
      candidate.studyId !== query.studyId ||
      candidate.taxonomyRevisionId !== query.taxonomyRevisionId ||
      candidate.codeId !== query.codeId
    )) throw new Error("Analysis promotion repository returned invalid candidates");
    return c.json({ page: verified.data });
  });

  router.get("/", async (c) => {
    const access = await resolveOwner(c, options);
    if (access instanceof Response) return access;
    const query = parseQuery(c, PromotionListQuerySchema);
    if (query instanceof Response) return query;
    const result = await callRepository(c, () => options.repository!.listPromotions(access, query.studyId, query));
    if (result instanceof Response) return result;
    const verified = AnalysisCriterionPromotionSummariesPageSchema.safeParse(result);
    if (!verified.success || verified.data.items.some((summary) =>
      summary.promotion.projectId !== access.projectId || summary.promotion.studyId !== query.studyId
    )) throw new Error("Analysis promotion repository returned invalid summaries");
    return c.json({ page: verified.data });
  });

  router.get("/:promotionId/supports", async (c) => {
    const access = await resolveOwner(c, options);
    if (access instanceof Response) return access;
    const promotionId = parseResourceId(c, "promotionId");
    if (promotionId instanceof Response) return promotionId;
    const page = parseQuery(c, PageQuerySchema);
    if (page instanceof Response) return page;
    const result = await callRepository(c, () => options.repository!.listSupports(access, promotionId, page));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = AnalysisCriterionPromotionSupportsPageSchema.safeParse(result);
    if (!verified.success || verified.data.items.some((support) =>
      support.projectId !== access.projectId || support.promotionId !== promotionId
    )) throw new Error("Analysis promotion repository returned invalid supports");
    return c.json({ page: verified.data });
  });

  router.get("/:promotionId", async (c) => {
    const access = await resolveOwner(c, options);
    if (access instanceof Response) return access;
    const promotionId = parseResourceId(c, "promotionId");
    if (promotionId instanceof Response) return promotionId;
    const result = await callRepository(c, () => options.repository!.getPromotion(access, promotionId));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const verified = AnalysisCriterionPromotionDetailSchema.safeParse(result);
    if (!verified.success || verified.data.promotion.id !== promotionId ||
      verified.data.promotion.projectId !== access.projectId) {
      throw new Error("Analysis promotion repository returned an invalid detail");
    }
    return c.json({ detail: verified.data });
  });

  return router;
}

function createResultMatches(
  actor: AnalysisPromotionAccess,
  input: AnalysisCriterionPromotionCreateInput,
  result: AnalysisCriterionPromotionCreateResult
): boolean {
  const promotion = result.promotion;
  if (
    promotion.projectId !== actor.projectId ||
    promotion.promotedByUserId !== actor.userId ||
    promotion.promoterRole !== "owner" ||
    promotion.studyId !== input.studyId ||
    promotion.studyClosureId !== input.expectedClosureId ||
    promotion.studyClosureDigest !== input.expectedClosureDigest ||
    promotion.taxonomyId !== input.taxonomyId ||
    promotion.taxonomyRevisionId !== input.taxonomyRevisionId ||
    promotion.taxonomyRevisionDigest !== input.expectedTaxonomyRevisionDigest ||
    promotion.codeId !== input.codeId ||
    promotion.codeEntryDigest !== input.expectedCodeEntryDigest ||
    promotion.criterionName !== input.criterionName ||
    promotion.criterionDefinition !== input.criterionDefinition ||
    promotion.rationale !== input.rationale ||
    promotion.idempotencyKey !== input.idempotencyKey ||
    promotion.requestDigest !== analysisCriterionPromotionRequestDigest(actor.projectId, input) ||
    result.supports.length !== input.supportingObservations.length
  ) return false;

  const expected = new Map(input.supportingObservations.map((support) => [support.observationEventId, support]));
  return result.supports.every((support) => {
    const requested = expected.get(support.observationEventId);
    return requested !== undefined &&
      support.studyItemId === requested.studyItemId &&
      support.closureItemId === requested.closureItemId &&
      support.closureItemDigest === requested.closureItemDigest &&
      support.observationEventDigest === requested.observationEventDigest &&
      support.assignmentEventId === requested.assignmentEventId &&
      support.assignmentEventDigest === requested.assignmentEventDigest;
  });
}

async function resolveOwner(
  c: Context,
  options: CreateAnalysisPromotionRouterOptions
): Promise<AnalysisPromotionAccess | Response> {
  if (!options.databaseMode || !options.repository) {
    return c.json({
      error: "Analysis promotions require database-backed session mode",
      code: "analysis_promotion_database_required"
    }, 501);
  }
  const identity = options.requestIdentity(c);
  if (identity.apiKeyId || !identity.userId) {
    return c.json({
      error: "A project owner session is required for analysis promotions",
      code: "analysis_promotion_session_required"
    }, 401);
  }
  const role = await options.resolveProjectRole({ projectId: identity.projectId, userId: identity.userId });
  if (!role) {
    return c.json({ error: "Analysis promotion project membership was not found", code: "analysis_promotion_forbidden" }, 403);
  }
  if (role !== "owner") {
    return c.json({ error: "Only project owners may promote analysis codes", code: "analysis_promotion_owner_required" }, 403);
  }
  return { projectId: identity.projectId, userId: identity.userId, projectRole: role };
}

function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> | Response {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({
      error: "Invalid analysis promotion query",
      code: "analysis_promotion_invalid_query",
      details: z.treeifyError(parsed.error)
    }, 400);
  }
  return parsed.data;
}

function parseResourceId(c: Context, name: string): string | Response {
  const parsed = ResourceIdSchema.safeParse(c.req.param(name));
  if (!parsed.success) return c.json({ error: "Invalid analysis promotion resource", code: "analysis_promotion_invalid_resource" }, 400);
  return parsed.data;
}

function invalidInput(c: Context, error: z.ZodError): Response {
  return c.json({
    error: "Invalid analysis promotion input",
    code: "analysis_promotion_invalid_input",
    details: z.treeifyError(error)
  }, 400);
}

function notFound(c: Context): Response {
  return c.json({ error: "Analysis promotion not found", code: "analysis_promotion_not_found" }, 404);
}

async function callRepository<T>(c: Context, callback: () => Promise<T>): Promise<T | Response> {
  try {
    return await callback();
  } catch (error) {
    if (!(error instanceof AnalysisPromotionRepositoryError)) throw error;
    const status = error.code === "analysis_promotion_not_found" ? 404 :
      error.code === "analysis_promotion_forbidden" ? 403 :
        error.code === "analysis_promotion_invalid_cursor" ? 400 : 409;
    return c.json({ error: error.message, code: error.code, details: error.details }, status);
  }
}
