import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  ANALYSIS_POPULATION_API_PAGE_MAX,
  ANALYSIS_POPULATION_CURSOR_MAX_LENGTH,
  AnalysisFailureTaxonomyCreateInputSchema,
  AnalysisObservationAssignmentEventInputSchema,
  AnalysisObservationAssignmentEventResultSchema,
  AnalysisObservationAssignmentsPageSchema,
  AnalysisStudyAbandonInputSchema,
  AnalysisStudyCloseInputSchema,
  AnalysisStudyCompleteInputSchema,
  AnalysisStudyCreateInputSchema,
  AnalysisStudyCreateResultSchema,
  AnalysisStudyDetailSchema,
  AnalysisStudyEventResultSchema,
  AnalysisStudyItemEventInputSchema,
  AnalysisStudyItemEventResultSchema,
  AnalysisStudyItemEventsPageSchema,
  AnalysisStudyItemsPageSchema,
  AnalysisStudyOpenInputSchema,
  AnalysisStudySummariesPageSchema,
  AnalysisTaxonomyCoverageSchema,
  AnalysisTaxonomyDetailSchema,
  AnalysisTaxonomyRevisionCreateInputSchema,
  AnalysisTaxonomyRevisionProjectionSchema,
  AnalysisTaxonomyRevisionResultSchema,
  AnalysisTaxonomyRevisionsPageSchema,
  DatasetEvidenceDigestSchema,
  DatasetRevisionPayloadSnapshotSchema
} from "@coeval/shared";
import {
  AnalysisStudyRepositoryError,
  type AnalysisStudyAccess,
  type AnalysisStudyItemContent,
  type AnalysisStudyProjectRole,
  type AnalysisStudyRepository
} from "./repository.js";

const ANALYSIS_STUDY_BODY_BYTES = 8 * 1024 * 1024;
const ResourceIdSchema = z.string().min(1).max(240);
const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ANALYSIS_POPULATION_API_PAGE_MAX).default(50),
  cursor: z.string().min(1).max(ANALYSIS_POPULATION_CURSOR_MAX_LENGTH).nullable().default(null)
}).strict();
const StudyItemContentSchema = z.object({
  projectId: ResourceIdSchema,
  studyId: ResourceIdSchema,
  populationId: ResourceIdSchema,
  drawId: ResourceIdSchema,
  datasetRevisionId: ResourceIdSchema,
  studyItemId: ResourceIdSchema,
  drawItemId: ResourceIdSchema,
  memberId: ResourceIdSchema,
  revisionItemId: ResourceIdSchema,
  caseId: ResourceIdSchema,
  position: z.number().int().min(0).max(9_999),
  inputDigest: DatasetEvidenceDigestSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  viewEventId: ResourceIdSchema,
  datasetExposureEventId: ResourceIdSchema,
  payloadSnapshot: DatasetRevisionPayloadSnapshotSchema
}).strict();

interface AnalysisStudyRouteIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface CreateAnalysisStudyRouterOptions {
  repository: AnalysisStudyRepository | null;
  databaseMode: boolean;
  requestIdentity: (context: Context) => AnalysisStudyRouteIdentity;
  resolveProjectRole: (input: {
    projectId: string;
    userId: string;
  }) => Promise<AnalysisStudyProjectRole | null>;
}

export function createAnalysisStudyRouter(options: CreateAnalysisStudyRouterOptions): Hono {
  const router = baseRouter();

  router.post("/", async (c) => {
    const actor = await resolveAccess(c, options, true);
    if (actor instanceof Response) return actor;
    const input = await parseBody(c, AnalysisStudyCreateInputSchema, "analysis_study_invalid_input");
    if (input instanceof Response) return input;
    const result = await callRepository(c, () => options.repository!.createStudy(actor, input));
    if (result instanceof Response) return result;
    const parsed = AnalysisStudyCreateResultSchema.safeParse(result);
    if (!parsed.success || parsed.data.study.study.populationId !== input.populationId ||
      parsed.data.study.study.projectId !== actor.projectId) {
      throw new Error("Analysis repository returned an invalid study create binding");
    }
    return c.json({ result: parsed.data }, parsed.data.reused ? 200 : 201);
  });

  router.get("/", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const result = await callRepository(c, () => options.repository!.listStudies(access, page));
    if (result instanceof Response) return result;
    const parsed = AnalysisStudySummariesPageSchema.safeParse(result);
    if (!parsed.success || parsed.data.items.some((item) => item.study.study.projectId !== access.projectId)) {
      throw new Error("Analysis repository returned an invalid study list");
    }
    return c.json({ page: parsed.data, projectRole: access.projectRole });
  });

  for (const [path, schema, method] of [
    ["/:studyId/open", AnalysisStudyOpenInputSchema, "openStudy"],
    ["/:studyId/close", AnalysisStudyCloseInputSchema, "closeStudy"],
    ["/:studyId/complete", AnalysisStudyCompleteInputSchema, "completeStudy"],
    ["/:studyId/abandon", AnalysisStudyAbandonInputSchema, "abandonStudy"]
  ] as const) {
    router.post(path, async (c) => {
      const actor = await resolveAccess(c, options, true);
      if (actor instanceof Response) return actor;
      const studyId = parseResourceId(c, "studyId");
      if (studyId instanceof Response) return studyId;
      const input = await parseBody(c, schema as z.ZodType<unknown>, "analysis_study_invalid_input");
      if (input instanceof Response) return input;
      const result = await callRepository(c, () => {
        const repository = options.repository!;
        if (method === "openStudy") return repository.openStudy(actor, studyId, input as never);
        if (method === "closeStudy") return repository.closeStudy(actor, studyId, input as never);
        if (method === "completeStudy") return repository.completeStudy(actor, studyId, input as never);
        return repository.abandonStudy(actor, studyId, input as never);
      });
      if (result instanceof Response) return result;
      const parsed = AnalysisStudyEventResultSchema.safeParse(result);
      if (!parsed.success || !studyEventResultMatchesPath(parsed.data, studyId, actor.projectId) ||
        !studyEventResultMatchesCommand(parsed.data, method, input)) {
        throw new Error("Analysis repository returned an invalid study transition binding");
      }
      return c.json({ result: parsed.data });
    });
  }

  router.get("/:studyId/items", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const studyId = parseResourceId(c, "studyId");
    if (studyId instanceof Response) return studyId;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const result = await callRepository(c, () => options.repository!.listStudyItems(access, studyId, page));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const parsed = AnalysisStudyItemsPageSchema.safeParse(result);
    if (!parsed.success || parsed.data.items.some((item) =>
      item.item.studyId !== studyId || item.item.projectId !== access.projectId
    )) {
      throw new Error("Analysis study repository returned invalid item bindings");
    }
    return c.json({ page: parsed.data });
  });

  router.get("/:studyId/items/:studyItemId/events", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const ids = parseStudyItemIds(c);
    if (ids instanceof Response) return ids;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const result = await callRepository(c, () =>
      options.repository!.listStudyItemEvents(access, ids.studyId, ids.studyItemId, page)
    );
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const parsed = AnalysisStudyItemEventsPageSchema.safeParse(result);
    if (!parsed.success || parsed.data.items.some((event) =>
      event.studyId !== ids.studyId || event.studyItemId !== ids.studyItemId ||
      event.projectId !== access.projectId
    )) throw new Error("Analysis study repository returned invalid event bindings");
    return c.json({ page: parsed.data });
  });

  router.post("/:studyId/items/:studyItemId/events", async (c) => {
    const actor = await resolveAccess(c, options, false);
    if (actor instanceof Response) return actor;
    const ids = parseStudyItemIds(c);
    if (ids instanceof Response) return ids;
    const input = await parseBody(c, AnalysisStudyItemEventInputSchema, "analysis_study_invalid_item_event");
    if (input instanceof Response) return input;
    const result = await callRepository(c, () =>
      options.repository!.appendStudyItemEvent(actor, ids.studyId, ids.studyItemId, input)
    );
    if (result instanceof Response) return result;
    const parsed = AnalysisStudyItemEventResultSchema.safeParse(result);
    if (!parsed.success || parsed.data.item.item.studyId !== ids.studyId ||
      parsed.data.item.item.id !== ids.studyItemId ||
      parsed.data.item.item.projectId !== actor.projectId ||
      parsed.data.event.studyId !== ids.studyId ||
      parsed.data.event.studyItemId !== ids.studyItemId ||
      parsed.data.event.projectId !== actor.projectId ||
      (!parsed.data.replayed && (
        parsed.data.item.currentEventId !== parsed.data.event.id ||
        parsed.data.item.currentEventDigest !== parsed.data.event.eventDigest ||
        parsed.data.item.currentVersion !== parsed.data.event.version
      )) ||
      (parsed.data.replayed && BigInt(parsed.data.event.version) > BigInt(parsed.data.item.currentVersion)) ||
      !itemEventResultMatchesCommand(parsed.data, input)) {
      throw new Error("Analysis study repository returned an invalid item-event result");
    }
    return c.json({ result: parsed.data });
  });

  router.get("/:studyId/items/:studyItemId/content", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const ids = parseStudyItemIds(c);
    if (ids instanceof Response) return ids;
    const context = await callRepository(c, () =>
      options.repository!.getStudyItem(access, ids.studyId, ids.studyItemId)
    );
    if (context instanceof Response) return context;
    if (!context) return notFound(c);
    const result = await callRepository(c, () =>
      options.repository!.getStudyItemContent(access, ids.studyId, ids.studyItemId)
    );
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const parsed = StudyItemContentSchema.safeParse(result satisfies AnalysisStudyItemContent);
    if (!parsed.success || parsed.data.projectId !== access.projectId ||
      parsed.data.studyId !== ids.studyId || parsed.data.studyItemId !== ids.studyItemId ||
      context.study.study.id !== ids.studyId || context.study.study.projectId !== access.projectId ||
      context.item.item.id !== ids.studyItemId || context.item.item.projectId !== access.projectId ||
      context.item.item.studyId !== ids.studyId ||
      parsed.data.populationId !== context.study.study.populationId ||
      parsed.data.drawId !== context.study.study.drawId ||
      parsed.data.datasetRevisionId !== context.study.study.datasetRevisionId ||
      parsed.data.drawItemId !== context.item.item.drawItemId ||
      parsed.data.memberId !== context.item.item.memberId ||
      parsed.data.revisionItemId !== context.item.item.revisionItemId ||
      parsed.data.caseId !== context.item.item.caseId ||
      parsed.data.position !== context.item.item.position) {
      throw new Error("Analysis study repository returned invalid content bindings");
    }
    return c.json({ content: parsed.data });
  });

  router.get("/:studyId/coverage", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const studyId = parseResourceId(c, "studyId");
    if (studyId instanceof Response) return studyId;
    const revision = ResourceIdSchema.safeParse(c.req.query("taxonomyRevisionId"));
    if (!revision.success) return invalidResource(c);
    const result = await callRepository(c, () =>
      options.repository!.getTaxonomyCoverage(access, studyId, revision.data)
    );
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const parsed = AnalysisTaxonomyCoverageSchema.safeParse(result);
    if (!parsed.success || parsed.data.studyId !== studyId || parsed.data.taxonomyRevisionId !== revision.data ||
      (parsed.data as { projectId?: string }).projectId !== access.projectId) {
      throw new Error("Analysis study repository returned invalid coverage bindings");
    }
    return c.json({ coverage: parsed.data });
  });

  router.get("/:studyId", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const studyId = parseResourceId(c, "studyId");
    if (studyId instanceof Response) return studyId;
    const result = await callRepository(c, () => options.repository!.getStudy(access, studyId));
    if (result instanceof Response) return result;
    if (!result) return notFound(c);
    const parsed = AnalysisStudyDetailSchema.safeParse(result);
    if (!parsed.success || parsed.data.summary.study.study.id !== studyId ||
      parsed.data.summary.study.study.projectId !== access.projectId) {
      throw new Error("Analysis study repository returned an invalid detail binding");
    }
    return c.json({ detail: parsed.data });
  });

  return router;
}

export function createAnalysisTaxonomyRouter(options: CreateAnalysisStudyRouterOptions): Hono {
  const router = baseRouter();

  router.post("/", async (c) => {
    const actor = await resolveAccess(c, options, true);
    if (actor instanceof Response) return actor;
    const input = await parseBody(c, AnalysisFailureTaxonomyCreateInputSchema, "analysis_taxonomy_invalid_input");
    if (input instanceof Response) return input;
    const result = await callRepository(c, () => options.repository!.createTaxonomy(actor, input));
    if (result instanceof Response) return result;
    const parsed = AnalysisTaxonomyRevisionResultSchema.safeParse(result);
    if (!parsed.success || parsed.data.revision.revision.taxonomyId !== parsed.data.taxonomy.id ||
      parsed.data.revision.revision.projectId !== actor.projectId || parsed.data.taxonomy.projectId !== actor.projectId ||
      parsed.data.taxonomy.name !== input.name || parsed.data.taxonomy.description !== input.description ||
      parsed.data.taxonomy.idempotencyKey !== input.idempotencyKey ||
      parsed.data.revision.revision.sequence !== 1 || parsed.data.revision.revision.reason !== input.reason ||
      parsed.data.revision.revision.idempotencyKey !== input.idempotencyKey ||
      !taxonomyCodesMatchInput(parsed.data.revision.codes, input.codes)) {
      throw new Error("Analysis repository returned an invalid taxonomy create binding");
    }
    return c.json({ result: parsed.data }, parsed.data.replayed ? 200 : 201);
  });

  router.get("/", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const result = await callRepository(c, () => options.repository!.getTaxonomy(access));
    if (result instanceof Response) return result;
    if (!result) return notFound(c, "analysis_taxonomy_not_found");
    const parsed = AnalysisTaxonomyDetailSchema.safeParse(result);
    if (!parsed.success || parsed.data.taxonomy.projectId !== access.projectId ||
      parsed.data.revision.revision.projectId !== access.projectId) {
      throw new Error("Analysis repository returned an invalid taxonomy detail");
    }
    return c.json({ detail: parsed.data });
  });

  router.get("/:taxonomyId/revisions", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const taxonomyId = parseResourceId(c, "taxonomyId");
    if (taxonomyId instanceof Response) return taxonomyId;
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const result = await callRepository(c, () =>
      options.repository!.listTaxonomyRevisions(access, taxonomyId, page)
    );
    if (result instanceof Response) return result;
    if (!result) return notFound(c, "analysis_taxonomy_not_found");
    const parsed = AnalysisTaxonomyRevisionsPageSchema.safeParse(result);
    if (!parsed.success || parsed.data.items.some((revision) =>
      revision.taxonomyId !== taxonomyId || revision.projectId !== access.projectId
    )) {
      throw new Error("Analysis taxonomy repository returned invalid revision bindings");
    }
    return c.json({ page: parsed.data });
  });

  router.get("/:taxonomyId/revisions/:revisionId", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const taxonomyId = parseResourceId(c, "taxonomyId");
    const revisionId = parseResourceId(c, "revisionId");
    if (taxonomyId instanceof Response || revisionId instanceof Response) return invalidResource(c);
    const result = await callRepository(c, () =>
      options.repository!.getTaxonomyRevision(access, taxonomyId, revisionId)
    );
    if (result instanceof Response) return result;
    if (!result) return notFound(c, "analysis_taxonomy_not_found");
    const parsed = AnalysisTaxonomyRevisionProjectionSchema.safeParse(result);
    if (!parsed.success || parsed.data.revision.taxonomyId !== taxonomyId ||
      parsed.data.revision.id !== revisionId || parsed.data.revision.projectId !== access.projectId ||
      parsed.data.codes.some((code) => code.projectId !== access.projectId)) {
      throw new Error("Analysis taxonomy repository returned invalid revision detail bindings");
    }
    return c.json({ revision: parsed.data });
  });

  router.post("/:taxonomyId/revisions", async (c) => {
    const actor = await resolveAccess(c, options, true);
    if (actor instanceof Response) return actor;
    const taxonomyId = parseResourceId(c, "taxonomyId");
    if (taxonomyId instanceof Response) return taxonomyId;
    const input = await parseBody(c, AnalysisTaxonomyRevisionCreateInputSchema, "analysis_taxonomy_invalid_revision");
    if (input instanceof Response) return input;
    const result = await callRepository(c, () =>
      options.repository!.createTaxonomyRevision(actor, taxonomyId, input)
    );
    if (result instanceof Response) return result;
    const parsed = AnalysisTaxonomyRevisionResultSchema.safeParse(result);
    if (!parsed.success || parsed.data.taxonomy.id !== taxonomyId ||
      parsed.data.revision.revision.taxonomyId !== taxonomyId ||
      parsed.data.taxonomy.projectId !== actor.projectId ||
      parsed.data.revision.revision.projectId !== actor.projectId ||
      parsed.data.revision.codes.some((code) => code.projectId !== actor.projectId) ||
      parsed.data.revision.revision.predecessorRevisionId !== input.expectedPredecessorRevisionId ||
      parsed.data.revision.revision.predecessorRevisionDigest !== input.expectedPredecessorRevisionDigest ||
      parsed.data.revision.revision.sequence !== input.expectedPredecessorSequence + 1 ||
      parsed.data.revision.revision.reason !== input.reason ||
      parsed.data.revision.revision.idempotencyKey !== input.idempotencyKey ||
      !taxonomyCodesMatchInput(parsed.data.revision.codes, input.codes)) {
      throw new Error("Analysis taxonomy repository returned an invalid revision result");
    }
    return c.json({ result: parsed.data }, parsed.data.replayed ? 200 : 201);
  });

  router.get("/:taxonomyId/assignments/:observationEventId", async (c) => {
    const access = await resolveAccess(c, options, false);
    if (access instanceof Response) return access;
    const taxonomyId = parseResourceId(c, "taxonomyId");
    const observationEventId = parseResourceId(c, "observationEventId");
    if (taxonomyId instanceof Response || observationEventId instanceof Response) return invalidResource(c);
    const page = parsePage(c);
    if (page instanceof Response) return page;
    const result = await callRepository(c, () =>
      options.repository!.listObservationAssignments(access, taxonomyId, observationEventId, page)
    );
    if (result instanceof Response) return result;
    if (!result) return notFound(c, "analysis_taxonomy_not_found");
    const parsed = AnalysisObservationAssignmentsPageSchema.safeParse(result);
    if (!parsed.success || parsed.data.items.some((event) =>
      event.taxonomyId !== taxonomyId || event.observationEventId !== observationEventId ||
      event.projectId !== access.projectId
    )) throw new Error("Analysis taxonomy repository returned invalid assignment bindings");
    return c.json({ page: parsed.data });
  });

  router.post("/:taxonomyId/assignments", async (c) => {
    const actor = await resolveAccess(c, options, false);
    if (actor instanceof Response) return actor;
    const taxonomyId = parseResourceId(c, "taxonomyId");
    if (taxonomyId instanceof Response) return taxonomyId;
    const input = await parseBody(c, AnalysisObservationAssignmentEventInputSchema, "analysis_assignment_invalid_input");
    if (input instanceof Response) return input;
    const result = await callRepository(c, () =>
      options.repository!.appendObservationAssignment(actor, taxonomyId, input)
    );
    if (result instanceof Response) return result;
    const parsed = AnalysisObservationAssignmentEventResultSchema.safeParse(result);
    if (!parsed.success || parsed.data.event.taxonomyId !== taxonomyId ||
      parsed.data.event.observationEventId !== input.observationEventId ||
      parsed.data.event.projectId !== actor.projectId ||
      !assignmentResultMatchesCommand(parsed.data, input)) {
      throw new Error("Analysis taxonomy repository returned an invalid assignment result");
    }
    return c.json({ result: parsed.data });
  });

  return router;
}

function baseRouter(): Hono {
  const router = new Hono();
  router.use("*", bodyLimit({
    maxSize: ANALYSIS_STUDY_BODY_BYTES,
    onError: (c) => c.json({
      error: `Request body exceeds ${ANALYSIS_STUDY_BODY_BYTES} bytes`,
      code: "analysis_study_body_too_large"
    }, 413)
  }));
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  return router;
}

async function resolveAccess(
  c: Context,
  options: CreateAnalysisStudyRouterOptions,
  ownerRequired: boolean
): Promise<AnalysisStudyAccess | Response> {
  if (!options.databaseMode || !options.repository) {
    return c.json({
      error: "Analysis studies require database-backed session mode",
      code: "analysis_study_database_required"
    }, 501);
  }
  const identity = options.requestIdentity(c);
  if (identity.apiKeyId || !identity.userId) {
    return c.json({
      error: "A project session is required for governed analysis",
      code: "analysis_study_session_required"
    }, 401);
  }
  const role = await options.resolveProjectRole({ projectId: identity.projectId, userId: identity.userId });
  if (!role) {
    return c.json({ error: "Analysis project membership was not found", code: "analysis_study_forbidden" }, 403);
  }
  if (ownerRequired && role !== "owner") {
    return c.json({ error: "Only project owners may administer analysis", code: "analysis_study_owner_required" }, 403);
  }
  return { projectId: identity.projectId, userId: identity.userId, projectRole: role };
}

async function parseBody<T>(
  c: Context,
  schema: z.ZodType<T>,
  code: string
): Promise<T | Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid governed analysis input", code, details: z.treeifyError(parsed.error) }, 400);
  }
  return parsed.data;
}

function parsePage(c: Context): { limit: number; cursor: string | null } | Response {
  const parsed = PageQuerySchema.safeParse({
    limit: c.req.query("limit") ?? undefined,
    cursor: c.req.query("cursor") ?? undefined
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid governed analysis page", code: "analysis_study_invalid_page" }, 400);
  }
  return parsed.data;
}

function parseResourceId(c: Context, name: string): string | Response {
  const parsed = ResourceIdSchema.safeParse(c.req.param(name));
  return parsed.success ? parsed.data : invalidResource(c);
}

function parseStudyItemIds(c: Context): { studyId: string; studyItemId: string } | Response {
  const studyId = ResourceIdSchema.safeParse(c.req.param("studyId"));
  const studyItemId = ResourceIdSchema.safeParse(c.req.param("studyItemId"));
  if (!studyId.success || !studyItemId.success) return invalidResource(c);
  return { studyId: studyId.data, studyItemId: studyItemId.data };
}

function invalidResource(c: Context): Response {
  return c.json({ error: "Invalid governed analysis resource identity", code: "analysis_study_invalid_resource" }, 400);
}

function notFound(c: Context, code = "analysis_study_not_found"): Response {
  return c.json({ error: "Governed analysis resource not found", code }, 404);
}

async function callRepository<T>(c: Context, operation: () => Promise<T>): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    return mapRepositoryError(c, error);
  }
}

function mapRepositoryError(c: Context, error: unknown): Response {
  if (!(error instanceof AnalysisStudyRepositoryError)) throw error;
  if (error.code === "analysis_study_not_found" || error.code === "analysis_taxonomy_not_found") {
    return c.json({ error: error.message, code: error.code }, 404);
  }
  if (error.code === "analysis_study_forbidden") {
    return c.json({ error: error.message, code: error.code }, 403);
  }
  if (error.code === "analysis_study_invalid_cursor") {
    return c.json({ error: error.message, code: error.code, details: error.details }, 400);
  }
  return c.json({ error: error.message, code: error.code, details: error.details }, 409);
}

function studyEventResultMatchesPath(
  result: z.infer<typeof AnalysisStudyEventResultSchema>,
  studyId: string,
  projectId: string
): boolean {
  return result.study.study.id === studyId && result.study.study.projectId === projectId &&
    result.event.studyId === studyId &&
    result.event.projectId === projectId &&
    ((!result.replayed && result.study.currentEventId === result.event.id &&
      result.study.currentEventDigest === result.event.eventDigest &&
      result.study.currentVersion === result.event.version &&
      result.study.state === result.event.toState) ||
     (result.replayed && BigInt(result.event.version) <= BigInt(result.study.currentVersion)));
}

function studyEventResultMatchesCommand(
  result: z.infer<typeof AnalysisStudyEventResultSchema>,
  method: "openStudy" | "closeStudy" | "completeStudy" | "abandonStudy",
  input: unknown
): boolean {
  if (!input || typeof input !== "object") return false;
  const command = input as Record<string, unknown>;
  const event = result.event;
  if (event.idempotencyKey !== command.idempotencyKey ||
    event.version !== successorVersion(command.expectedVersion)) return false;
  if (method === "openStudy") {
    return event.eventType === "coding_opened" &&
      JSON.stringify(event.stoppingRule) === JSON.stringify(command.stoppingRule);
  }
  if (method === "closeStudy") {
    return event.eventType === "coding_closed" && event.closeCause === "explicit_owner_close" &&
      event.reason === command.reason;
  }
  if (method === "completeStudy") {
    return event.eventType === "study_completed" &&
      event.expectedClosureDigest === command.expectedClosureDigest;
  }
  return event.eventType === "study_abandoned" && event.reason === command.reason;
}

function itemEventResultMatchesCommand(
  result: z.infer<typeof AnalysisStudyItemEventResultSchema>,
  input: z.infer<typeof AnalysisStudyItemEventInputSchema>
): boolean {
  const event = result.event;
  if (event.eventType !== input.eventType || event.idempotencyKey !== input.idempotencyKey ||
    event.version !== successorVersion(input.expectedVersion)) return false;
  if (input.eventType === "failure_observed") {
    return event.eventType === input.eventType && event.failureLabel === input.failureLabel &&
      event.rationale === input.rationale &&
      JSON.stringify(event.evidenceAnchor) === JSON.stringify(input.evidenceAnchor);
  }
  if (input.eventType === "failure_withdrawn" || input.eventType === "no_failure_withdrawn" ||
      input.eventType === "coding_reopened") {
    return event.eventType === input.eventType && event.targetEventId === input.targetEventId &&
      event.targetEventDigest === input.targetEventDigest && event.rationale === input.rationale;
  }
  return input.eventType === "no_failure_observed"
    ? event.eventType === input.eventType && event.rationale === input.rationale
    : event.eventType === "coding_completed";
}

function assignmentResultMatchesCommand(
  result: z.infer<typeof AnalysisObservationAssignmentEventResultSchema>,
  input: z.infer<typeof AnalysisObservationAssignmentEventInputSchema>
): boolean {
  const event = result.event;
  return event.eventType === input.eventType && event.taxonomyRevisionId === input.taxonomyRevisionId &&
    event.codeId === input.codeId && event.idempotencyKey === input.idempotencyKey &&
    event.version === successorVersion(input.expectedVersion) &&
    event.predecessorEventId === input.expectedPredecessorEventId &&
    event.predecessorEventDigest === input.expectedPredecessorEventDigest &&
    event.rationale === input.rationale;
}

function taxonomyCodesMatchInput(
  artifacts: Array<{ codeId: string; label: string; definition: string; status: "active" | "retired" }>,
  commands: Array<{ kind: "new" | "existing"; codeId?: string; label: string; definition: string; status?: "active" | "retired" }>
): boolean {
  return artifacts.length === commands.length && artifacts.every((artifact, index) => {
    const command = commands[index]!;
    return artifact.label === command.label && artifact.definition === command.definition &&
      artifact.status === (command.kind === "new" ? "active" : command.status) &&
      (command.kind === "new" || artifact.codeId === command.codeId);
  });
}

function successorVersion(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return String(BigInt(value) + 1n);
}
