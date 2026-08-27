import type { Context } from "hono";
import { Hono } from "hono";
import { z, type ZodType } from "zod";
import {
  AppendGovernedReviewAdjudicationInputSchema,
  AppendGovernedReviewAlignmentEventInputSchema,
  CreateImportedTruthInputSchema,
  CreateGovernedReviewBatchInputSchema,
  CreateGovernedReviewInstructionInputSchema,
  CreateSealedReviewIntakeInputSchema,
  DeferGovernedReviewTaskInputSchema,
  GOVERNED_REVIEW_GENERAL_BODY_BYTES,
  GOVERNED_REVIEW_INTAKE_BODY_BYTES,
  ImportedTruthListQuerySchema,
  GovernedReviewListQuerySchema,
  GovernedReviewStreamCommandSchema,
  ResumeGovernedReviewTaskInputSchema,
  SubmitGovernedReviewLabelInputSchema,
  WithdrawGovernedReviewLabelInputSchema
} from "./contracts.js";
import {
  GovernedReviewBodyTooLargeError,
  GovernedReviewDomainError
} from "./errors.js";
import { verifyExactBlindTaskViewArtifact } from "./projection.js";
import type {
  GovernedReviewActor,
  GovernedReviewProjectRole,
  GovernedReviewRepository
} from "./repository.js";

export interface GovernedReviewRequestIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface GovernedReviewRouteDependencies {
  repository: GovernedReviewRepository | null;
  authMode: boolean;
  requestIdentity(c: Context): GovernedReviewRequestIdentity;
  resolveProjectRole(input: { projectId: string; userId: string }): Promise<GovernedReviewProjectRole | null>;
}

type RouteVariables = { governedReviewActor: GovernedReviewActor };

export function createGovernedReviewRouter(dependencies: GovernedReviewRouteDependencies) {
  const router = new Hono<{ Variables: RouteVariables }>();

  router.use("*", async (c, next) => {
    setGovernedReviewHeaders(c);
    if (!dependencies.authMode || !dependencies.repository) {
      return c.json({
        error: "Governed review requires database-backed session authentication.",
        code: "governed_review_requires_auth"
      }, 501);
    }
    const identity = dependencies.requestIdentity(c);
    if (!identity.userId) {
      return c.json({
        error: "A signed-in session is required for governed review; API keys cannot access this surface.",
        code: "governed_review_session_required"
      }, 401);
    }
    if (!identity.projectId) {
      return c.json({ error: "No project membership", code: "governed_review_project_required" }, 403);
    }
    const projectRole = await dependencies.resolveProjectRole({
      projectId: identity.projectId,
      userId: identity.userId
    });
    if (!projectRole) {
      return c.json({ error: "Not a member of this project", code: "governed_review_project_forbidden" }, 403);
    }
    c.set("governedReviewActor", {
      projectId: identity.projectId,
      userId: identity.userId,
      projectRole
    });
    await next();
  });

  router.onError((error, c) => governedReviewErrorResponse(c, error));

  router.get("/instructions", async (c) => {
    const query = parseQuery(c, z.object({ criterionVersionId: z.string().trim().min(1).max(240).optional() }).strict());
    const instructions = await repository(dependencies).listInstructions(
      actor(c),
      query.criterionVersionId
    );
    return c.json({ instructions });
  });

  router.post("/instructions", async (c) => {
    requireOwner(actor(c), "create governed review instructions");
    const input = await parseBody(c, CreateGovernedReviewInstructionInputSchema);
    const instruction = await repository(dependencies).createInstruction(actor(c), input);
    return c.json({ instruction }, 201);
  });

  router.get("/subjects", async (c) => {
    requireOwner(actor(c), "list governed review subjects");
    return c.json({ subjects: await repository(dependencies).listAssignableSubjects(actor(c)) });
  });

  router.post("/sealed-intakes", async (c) => {
    const input = await parseBody(c, CreateSealedReviewIntakeInputSchema, GOVERNED_REVIEW_INTAKE_BODY_BYTES);
    const intake = await repository(dependencies).createSealedIntake(actor(c), input);
    return c.json({ intake }, 201);
  });

  router.get("/imported-truth", async (c) => {
    requireOwner(actor(c), "list imported human truth");
    const query = parseQuery(c, ImportedTruthListQuerySchema);
    return c.json({ importedTruth: await repository(dependencies).listImportedTruth(actor(c), query) });
  });

  router.post("/imported-truth", async (c) => {
    requireOwner(actor(c), "import human truth");
    const input = await parseBody(c, CreateImportedTruthInputSchema, GOVERNED_REVIEW_INTAKE_BODY_BYTES);
    const importedTruth = await repository(dependencies).createImportedTruth(actor(c), input);
    return c.json({ importedTruth }, 201);
  });

  router.get("/batches", async (c) => {
    const query = parseQuery(c, GovernedReviewListQuerySchema);
    return c.json({ batches: await repository(dependencies).listBatches(actor(c), query) });
  });

  router.post("/batches", async (c) => {
    requireOwner(actor(c), "create governed review batches");
    const input = await parseBody(c, CreateGovernedReviewBatchInputSchema);
    const batch = await repository(dependencies).createBatchDraft(actor(c), input);
    return c.json({ batch }, 201);
  });

  router.get("/batches/:batchId", async (c) => {
    const batch = await repository(dependencies).getBatchSummary(actor(c), routeId(c, "batchId"));
    return c.json({ batch });
  });

  router.post("/batches/:batchId/open", batchTransition(dependencies, "open"));
  router.post("/batches/:batchId/close-labeling", batchTransition(dependencies, "close_labeling"));
  router.post("/batches/:batchId/alignment/open", batchTransition(dependencies, "open_alignment"));
  router.post("/batches/:batchId/adjudication/start", batchTransition(dependencies, "start_adjudication"));
  router.post("/batches/:batchId/finalize", batchTransition(dependencies, "finalize"));
  router.post("/batches/:batchId/freeze", batchTransition(dependencies, "freeze"));

  router.get("/tasks", async (c) => {
    return c.json({ tasks: await repository(dependencies).listReviewerTasks(actor(c)) });
  });

  router.get("/tasks/:taskId/view", async (c) => {
    const stored = await repository(dependencies).getOrCreateBlindTaskView(actor(c), routeId(c, "taskId"));
    const artifact = verifyExactBlindTaskViewArtifact(stored);
    c.header("content-type", "application/json; charset=utf-8");
    c.header("x-coeval-view-digest", artifact.viewDigest);
    c.header("x-coeval-canonicalization", "coeval-canonical-json/v1");
    c.header("access-control-expose-headers", "X-Coeval-View-Digest, X-Coeval-Canonicalization");
    return c.body(Uint8Array.from(artifact.canonicalBytes).buffer);
  });

  router.post("/tasks/:taskId/defer", async (c) => {
    const input = await parseBody(c, DeferGovernedReviewTaskInputSchema);
    const task = await repository(dependencies).appendTaskAction(actor(c), routeId(c, "taskId"), {
      kind: "defer",
      input
    });
    return c.json({ task });
  });

  router.post("/tasks/:taskId/resume", async (c) => {
    const input = await parseBody(c, ResumeGovernedReviewTaskInputSchema);
    const task = await repository(dependencies).appendTaskAction(actor(c), routeId(c, "taskId"), {
      kind: "resume",
      input
    });
    return c.json({ task });
  });

  router.post("/tasks/:taskId/labels", async (c) => {
    const input = await parseBody(c, SubmitGovernedReviewLabelInputSchema);
    const task = await repository(dependencies).appendTaskAction(actor(c), routeId(c, "taskId"), {
      kind: "submit_label",
      input
    });
    return c.json({ task }, 201);
  });

  router.post("/tasks/:taskId/withdraw", async (c) => {
    const input = await parseBody(c, WithdrawGovernedReviewLabelInputSchema);
    const task = await repository(dependencies).appendTaskAction(actor(c), routeId(c, "taskId"), {
      kind: "withdraw_label",
      input
    });
    return c.json({ task });
  });

  router.get("/batches/:batchId/items/:itemId/alignment", async (c) => {
    const item = await repository(dependencies).getPostBarrierItemView(
      actor(c), routeId(c, "batchId"), routeId(c, "itemId"), "alignment"
    );
    return c.json({ item });
  });

  router.post("/batches/:batchId/alignment/events", async (c) => {
    requireOwner(actor(c), "append governed review alignment events");
    const input = await parseBody(c, AppendGovernedReviewAlignmentEventInputSchema);
    const event = await repository(dependencies).appendAlignmentEvent(actor(c), routeId(c, "batchId"), input);
    return c.json({ event }, 201);
  });

  router.get("/batches/:batchId/items/:itemId/adjudication", async (c) => {
    const item = await repository(dependencies).getPostBarrierItemView(
      actor(c), routeId(c, "batchId"), routeId(c, "itemId"), "adjudication"
    );
    return c.json({ item });
  });

  router.post("/batches/:batchId/items/:itemId/adjudications", async (c) => {
    requireOwner(actor(c), "append governed review adjudications");
    const input = await parseBody(c, AppendGovernedReviewAdjudicationInputSchema);
    const adjudication = await repository(dependencies).appendAdjudication(
      actor(c), routeId(c, "batchId"), routeId(c, "itemId"), input
    );
    return c.json({ adjudication }, 201);
  });

  return router;
}

function batchTransition(
  dependencies: GovernedReviewRouteDependencies,
  action: "open" | "close_labeling" | "open_alignment" | "start_adjudication" | "finalize" | "freeze"
) {
  return async (c: Context<{ Variables: RouteVariables }>) => {
    requireOwner(actor(c), "control governed review batches");
    const command = await parseBody(c, GovernedReviewStreamCommandSchema);
    const batch = await repository(dependencies).transitionBatch(
      actor(c), routeId(c, "batchId"), action, command
    );
    return c.json({ batch });
  };
}

function repository(dependencies: GovernedReviewRouteDependencies): GovernedReviewRepository {
  if (!dependencies.repository) throw new Error("Governed review repository unavailable after route guard");
  return dependencies.repository;
}

function actor(c: Context<{ Variables: RouteVariables }>): GovernedReviewActor {
  return c.get("governedReviewActor");
}

function requireOwner(current: GovernedReviewActor, action: string): void {
  if (current.projectRole !== "owner") {
    throw new GovernedReviewDomainError(`Only project owners can ${action}`, "governed_review_owner_required", 403);
  }
}

function routeId(c: Context, name: string): string {
  const value = c.req.param(name)?.trim();
  if (!value || value.length > 240) {
    throw new GovernedReviewDomainError(`Invalid ${name}`, "invalid_governed_review_request", 400);
  }
  return value;
}

async function parseBody<T>(
  c: Context,
  schema: ZodType<T>,
  maxBytes = GOVERNED_REVIEW_GENERAL_BODY_BYTES
): Promise<T> {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new GovernedReviewBodyTooLargeError(maxBytes);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new GovernedReviewBodyTooLargeError(maxBytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GovernedReviewDomainError("Invalid JSON request body", "invalid_governed_review_request", 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new GovernedReviewDomainError(
      "Invalid governed review request",
      "invalid_governed_review_request",
      400,
      { validation: z.treeifyError(parsed.error) }
    );
  }
  return parsed.data;
}

function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new GovernedReviewDomainError(
      "Invalid governed review query",
      "invalid_governed_review_request",
      400,
      { validation: z.treeifyError(parsed.error) }
    );
  }
  return parsed.data;
}

function setGovernedReviewHeaders(c: Context): void {
  c.header("cache-control", "private, no-store");
  c.header("vary", "Cookie, x-coeval-project");
  c.header("x-content-type-options", "nosniff");
}

function governedReviewErrorResponse(c: Context, error: Error) {
  if (error instanceof GovernedReviewDomainError) {
    return c.json({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {})
    }, error.status);
  }
  console.error("Governed review route failed", error);
  return c.json({
    error: "Governed review request failed",
    code: "governed_review_internal_error"
  }, 500);
}
