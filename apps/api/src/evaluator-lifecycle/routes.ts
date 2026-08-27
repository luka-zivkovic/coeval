import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  EvaluatorCandidateCreateInputSchema,
  EvaluatorCandidateCreateResultSchema,
  EvaluatorLifecycleActivateInputSchema,
  EvaluatorLifecycleListPageSchema,
  EvaluatorLifecycleProjectionSchema,
  EvaluatorLifecycleRetireInputSchema,
  EvaluatorLifecycleTransitionResultSchema,
  type EvaluatorCandidateCreateResult
} from "@coeval/shared";
import {
  EvaluatorLifecycleRepositoryError,
  type EvaluatorLifecycleAccess,
  type EvaluatorLifecycleProjectRole,
  type EvaluatorLifecycleRepository
} from "./repository.js";
import {
  evaluatorCandidateRequestDigest,
  evaluatorLifecycleDigest
} from "../lib/evaluator-lifecycle.js";

const BODY_LIMIT = 512 * 1024;
const ResourceIdSchema = z.string().trim().min(1).max(240);
const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).nullable().default(null)
}).strict();

interface RouteIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface CreateEvaluatorLifecycleRouterOptions {
  repository: EvaluatorLifecycleRepository | null;
  databaseMode: boolean;
  requestIdentity: (context: Context) => RouteIdentity;
  resolveProjectRole: (input: { projectId: string; userId: string }) => Promise<EvaluatorLifecycleProjectRole | null>;
  enqueueRegression?: ((input: {
    projectId: string;
    skillVersionId: string;
    datasetRevisionId: string;
    actorUserId: string;
  }) => Promise<void>) | undefined;
}

export function createEvaluatorLifecycleRouter(options: CreateEvaluatorLifecycleRouterOptions): Hono {
  const router = new Hono();
  router.use("*", bodyLimit({
    maxSize: BODY_LIMIT,
    onError: (c) => c.json({ error: "Evaluator lifecycle request is too large", code: "evaluator_lifecycle_body_too_large" }, 413)
  }));
  router.use("*", async (c,next) => { c.header("cache-control","no-store"); await next(); });

  router.post("/candidates", async (c) => {
    const actor = await resolveAccess(c,options,true);
    if (actor instanceof Response) return actor;
    const body = await c.req.json().catch(() => null);
    const parsed = EvaluatorCandidateCreateInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c,"candidate",parsed.error);
    const result = await callRepository(c,() => options.repository!.createCandidate(actor,parsed.data));
    if (result instanceof Response) return result;
    const verified = EvaluatorCandidateCreateResultSchema.safeParse(result);
    if (!verified.success || !candidateResultMatches(actor,parsed.data,verified.data)) {
      throw new Error("Evaluator lifecycle repository returned an invalid candidate result");
    }
    // Dispatch is deliberately retried for an exact candidate replay. The
    // candidate transaction may have committed even when the first queue
    // send failed or its acknowledgement was lost. The gate worker serializes
    // and replays terminal evidence, so repeated deliveries are safe.
    if (options.enqueueRegression) {
      await options.enqueueRegression({
        projectId: actor.projectId,
        skillVersionId: verified.data.projection.lifecycle.skillVersionId,
        datasetRevisionId: verified.data.projection.lifecycle.regressionDatasetRevisionId,
        actorUserId: actor.userId
      });
    }
    return c.json({ result: verified.data }, verified.data.replayed ? 200 : 201);
  });

  router.get("/", async (c) => {
    const access = await resolveAccess(c,options,false);
    if (access instanceof Response) return access;
    const query = ListQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalid(c,"query",query.error);
    const result = await callRepository(c,() => options.repository!.listLifecycles(access,query.data));
    if (result instanceof Response) return result;
    const verified = EvaluatorLifecycleListPageSchema.safeParse(result);
    if (!verified.success || verified.data.items.some((item) => item.lifecycle.projectId !== access.projectId)) {
      throw new Error("Evaluator lifecycle repository returned an invalid list");
    }
    return c.json({ page: verified.data, projectRole: access.projectRole });
  });

  router.get("/:skillVersionId", async (c) => {
    const access = await resolveAccess(c,options,false);
    if (access instanceof Response) return access;
    const skillVersionId = resource(c,"skillVersionId");
    if (skillVersionId instanceof Response) return skillVersionId;
    const result = await callRepository(c,() => options.repository!.getLifecycle(access,skillVersionId));
    if (result instanceof Response) return result;
    if (!result) return c.json({ error: "Evaluator lifecycle not found", code: "evaluator_lifecycle_not_found" },404);
    const verified = EvaluatorLifecycleProjectionSchema.safeParse(result);
    if (!verified.success || verified.data.lifecycle.projectId !== access.projectId ||
        verified.data.lifecycle.skillVersionId !== skillVersionId) {
      throw new Error("Evaluator lifecycle repository returned an invalid projection");
    }
    return c.json({ projection: verified.data });
  });

  router.post("/:skillVersionId/activate", async (c) => {
    const actor = await resolveAccess(c,options,true);
    if (actor instanceof Response) return actor;
    const skillVersionId = resource(c,"skillVersionId");
    if (skillVersionId instanceof Response) return skillVersionId;
    const parsed = EvaluatorLifecycleActivateInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c,"activation",parsed.error);
    const result = await callRepository(c,() => options.repository!.activate(actor,skillVersionId,parsed.data));
    if (result instanceof Response) return result;
    const verified = EvaluatorLifecycleTransitionResultSchema.safeParse(result);
    if (!verified.success || !activationResultMatches(actor.projectId,skillVersionId,parsed.data,verified.data)) {
      throw new Error("Evaluator lifecycle repository returned an invalid activation result");
    }
    return c.json({ result: verified.data },verified.data.replayed ? 200 : 201);
  });

  router.post("/:skillVersionId/retire", async (c) => {
    const actor = await resolveAccess(c,options,true);
    if (actor instanceof Response) return actor;
    const skillVersionId = resource(c,"skillVersionId");
    if (skillVersionId instanceof Response) return skillVersionId;
    const parsed = EvaluatorLifecycleRetireInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c,"retirement",parsed.error);
    const result = await callRepository(c,() => options.repository!.retire(actor,skillVersionId,parsed.data));
    if (result instanceof Response) return result;
    const verified = EvaluatorLifecycleTransitionResultSchema.safeParse(result);
    if (!verified.success || !retirementResultMatches(actor.projectId,skillVersionId,parsed.data,verified.data)) {
      throw new Error("Evaluator lifecycle repository returned an invalid retirement result");
    }
    return c.json({ result: verified.data },verified.data.replayed ? 200 : 201);
  });
  return router;
}

async function resolveAccess(
  c: Context,
  options: CreateEvaluatorLifecycleRouterOptions,
  ownerOnly: boolean
): Promise<EvaluatorLifecycleAccess | Response> {
  if (!options.databaseMode || !options.repository) {
    return c.json({ error: "Evaluator lifecycle requires database-backed session mode", code: "evaluator_lifecycle_database_required" },501);
  }
  const identity = options.requestIdentity(c);
  if (identity.apiKeyId || !identity.userId) {
    return c.json({ error: "A project-member session is required for evaluator lifecycle", code: "evaluator_lifecycle_session_required" },401);
  }
  const role = await options.resolveProjectRole({projectId:identity.projectId,userId:identity.userId});
  if (!role) return c.json({ error: "Evaluator lifecycle project membership was not found", code: "evaluator_lifecycle_forbidden" },403);
  if (ownerOnly && role!=="owner") return c.json({ error: "Only project owners may change evaluator lifecycle", code: "evaluator_lifecycle_owner_required" },403);
  return {projectId:identity.projectId,userId:identity.userId,projectRole:role};
}

async function callRepository<T>(c: Context,callback:()=>Promise<T>): Promise<T|Response> {
  try { return await callback(); }
  catch (error) {
    if (!(error instanceof EvaluatorLifecycleRepositoryError)) throw error;
    const status = error.code==="not_found" ? 404 : error.code==="forbidden" ? 403 :
      error.code==="unsupported" ? 501 : error.code==="invalid_cursor" ? 400 : 409;
    return c.json({error:error.message,code:`evaluator_lifecycle_${error.code}`,details:error.details},status);
  }
}

function candidateResultMatches(
  actor:EvaluatorLifecycleAccess,
  input:z.infer<typeof EvaluatorCandidateCreateInputSchema>,
  result:EvaluatorCandidateCreateResult
):boolean {
  const lifecycle=result.projection.lifecycle;
  return lifecycle.projectId===actor.projectId && lifecycle.criterionId===input.criterionId &&
    lifecycle.criterionVersionId===input.criterionVersionId && lifecycle.governedBatchId===input.governedBatchId &&
    lifecycle.governedBatchDigest===input.expectedBatchDigest &&
    lifecycle.truthDatasetRevisionId===input.truthDatasetRevisionId &&
    lifecycle.truthRevisionDigest===input.expectedTruthRevisionDigest &&
    lifecycle.truthContentDigest===input.expectedTruthContentDigest &&
    lifecycle.createdByUserId===actor.userId && lifecycle.idempotencyKey===input.idempotencyKey &&
    lifecycle.requestDigest===evaluatorCandidateRequestDigest(actor.projectId,input) &&
    result.skill.name===input.skillName && result.skill.description===input.skillDescription &&
    result.skill.currentVersion.rubricMarkdown===input.rubricMarkdown &&
    result.skill.currentVersion.prompt===input.prompt &&
    result.projection.currentEvent.state==="candidate" &&
    result.projection.currentEvent.transition==="candidate_created" &&
    result.projection.currentEvent.actorUserId===actor.userId &&
    result.projection.currentEvent.actorRole==="owner" &&
    result.projection.currentEvent.reason==="Candidate created from exact frozen governed nonsealed truth." &&
    result.projection.currentEvent.idempotencyKey===`candidate-created:${lifecycle.id}`;
}

function activationResultMatches(
  projectId:string,
  skillVersionId:string,
  input:z.infer<typeof EvaluatorLifecycleActivateInputSchema>,
  result:z.infer<typeof EvaluatorLifecycleTransitionResultSchema>
):boolean {
  const event=result.event;
  const evidence=event.activationEvidence;
  const expectedDigest=evaluatorLifecycleDigest({
    basis:"evaluator-lifecycle-activated-request/v1",
    projectId,
    skillVersionId,
    ...Object.fromEntries(Object.entries(input).filter(([key])=>key!=="idempotencyKey"))
  });
  const priorMatches=input.expectedPriorActiveSkillVersionId===null
    ? result.replacedEvent===null
    : result.replacedEvent!==null &&
      result.replacedEvent.skillVersionId===input.expectedPriorActiveSkillVersionId &&
      result.replacedEvent.projectId===projectId &&
      result.replacedEvent.criterionId===event.criterionId &&
      result.replacedEvent.predecessorEventId===input.expectedPriorActiveEventId &&
      result.replacedEvent.predecessorEventDigest===input.expectedPriorActiveEventDigest &&
      result.replacedEvent.transition==="retired" &&
      result.replacedEvent.activationBundleId===event.activationBundleId &&
      result.replacedEvent.actorUserId===event.actorUserId &&
      result.replacedEvent.actorSubjectId===event.actorSubjectId;
  return event.transition==="activated" && event.state==="active" &&
    event.activationBundleId!==null &&
    event.projectId===projectId && event.skillVersionId===skillVersionId &&
    event.predecessorEventId===input.expectedEventId &&
    event.predecessorEventDigest===input.expectedEventDigest &&
    event.sequence===(BigInt(input.expectedSequence)+1n).toString() &&
    event.idempotencyKey===input.idempotencyKey && event.reason===input.rationale &&
    event.requestDigest===expectedDigest && evidence!==null &&
    evidence.calibrationArtifactId===input.calibrationArtifactId &&
    evidence.calibrationArtifactDigest===input.expectedCalibrationArtifactDigest &&
    evidence.calibrationEvidenceDigest===input.expectedCalibrationEvidenceDigest &&
    evidence.regressionRunId===input.regressionRunId &&
    evidence.regressionDatasetRevisionId===result.projection.lifecycle.regressionDatasetRevisionId &&
    event.replacedSkillVersionId===input.expectedPriorActiveSkillVersionId && priorMatches &&
    result.projection.lifecycle.projectId===projectId &&
    result.projection.lifecycle.skillVersionId===skillVersionId;
}

function retirementResultMatches(
  projectId:string,
  skillVersionId:string,
  input:z.infer<typeof EvaluatorLifecycleRetireInputSchema>,
  result:z.infer<typeof EvaluatorLifecycleTransitionResultSchema>
):boolean {
  const event=result.event;
  const expectedDigest=evaluatorLifecycleDigest({
    basis:"evaluator-lifecycle-retired-request/v1",
    projectId,
    skillVersionId,
    ...Object.fromEntries(Object.entries(input).filter(([key])=>key!=="idempotencyKey"))
  });
  return event.transition==="retired" && event.state==="retired" && result.replacedEvent===null &&
    event.activationBundleId===null && event.replacedSkillVersionId===null &&
    event.projectId===projectId && event.skillVersionId===skillVersionId &&
    event.predecessorEventId===input.expectedEventId &&
    event.predecessorEventDigest===input.expectedEventDigest &&
    event.sequence===(BigInt(input.expectedSequence)+1n).toString() &&
    event.idempotencyKey===input.idempotencyKey && event.reason===input.rationale &&
    event.requestDigest===expectedDigest && result.projection.lifecycle.projectId===projectId &&
    result.projection.lifecycle.skillVersionId===skillVersionId;
}

function resource(c:Context,name:string):string|Response {
  const parsed=ResourceIdSchema.safeParse(c.req.param(name));
  return parsed.success ? parsed.data : c.json({error:"Invalid evaluator lifecycle resource",code:"evaluator_lifecycle_invalid_resource"},400);
}

function invalid(c:Context,kind:string,error:z.ZodError):Response {
  return c.json({error:`Invalid evaluator lifecycle ${kind}`,code:"evaluator_lifecycle_invalid_input",details:z.treeifyError(error)},400);
}
