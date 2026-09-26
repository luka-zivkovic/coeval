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
  type EvaluatorCandidateCreateInput,
  type EvaluatorCandidateCreateResult,
  type ResolutionRecord,
  mutableModelAlias
} from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "../lib/canonical-json.js";
import {
  EvaluatorLifecycleRepositoryError,
  type EvaluatorLifecycleAccess,
  type EvaluatorLifecycleProjectRole,
  type EvaluatorLifecycleRepository,
  type ResolvedBinding
} from "./repository.js";
import {
  evaluatorCandidateRequestDigest,
  evaluatorLifecycleDigest
} from "../lib/evaluator-lifecycle.js";
import { ExecutionBindingInputError, executionBindingFromInput } from "../lib/execution-binding.js";
import {
  resolutionNeeded,
  resolveGovernedBinding,
  resolveSavedBinding,
  type BindingResolutionServices,
  type GovernedBinding
} from "../lib/binding-resolution.js";

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
  /** Probes a binding at a governed gate; without it, an unresolved binding stays unresolved. */
  bindingResolution?: BindingResolutionServices | undefined;
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
    // The governed gate needs the binding resolved; a replay needs nothing.
    let resolution: ResolvedBinding | null = null;
    if (!(await options.repository!.candidateExists(actor,parsed.data.idempotencyKey))) {
      const resolved = await resolveCandidateBinding(c,options,actor.projectId,parsed.data);
      if (resolved instanceof Response) return resolved;
      resolution = resolved;
    }
    const result = await callRepository(c,() => options.repository!.createCandidate(actor,parsed.data,resolution));
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
    // An unresolved binding resolves the first time a governed gate needs it.
    await resolveWhenUnresolved(options,actor.projectId,skillVersionId,"activation",parsed.data.idempotencyKey);
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
  router.get("/:skillVersionId/resolution", async (c) => {
    const access = await resolveAccess(c,options,false);
    if (access instanceof Response) return access;
    const skillVersionId = resource(c,"skillVersionId");
    if (skillVersionId instanceof Response) return skillVersionId;
    const governed = await options.repository!.getGovernedBinding(access,skillVersionId);
    if (!governed) return c.json({ error: "Evaluator version not found", code: "evaluator_lifecycle_not_found" },404);
    return c.json({ skillVersionId, record: governed.record });
  });

  // Resolution on demand (ADR-0014 section 4); a failed binding stays failed.
  router.post("/:skillVersionId/resolution", async (c) => {
    const actor = await resolveAccess(c,options,true);
    if (actor instanceof Response) return actor;
    const skillVersionId = resource(c,"skillVersionId");
    if (skillVersionId instanceof Response) return skillVersionId;
    if (!options.bindingResolution) {
      return c.json({ error: "Resolution needs provider access this deployment doesn't configure", code: "evaluator_lifecycle_unsupported" },501);
    }
    const record = await resolveWhenUnresolved(options,actor.projectId,skillVersionId,"on_demand",`on-demand:${actor.userId}:${new Date().toISOString()}`);
    if (record === undefined) return c.json({ error: "Evaluator version not found", code: "evaluator_lifecycle_not_found" },404);
    return c.json({ skillVersionId, record });
  });
  return router;
}

/** Resolves a candidate's binding before creation, recording the attempt against its request. */
async function resolveCandidateBinding(
  c: Context,
  options: CreateEvaluatorLifecycleRouterOptions,
  projectId: string,
  input: EvaluatorCandidateCreateInput
): Promise<ResolvedBinding | null | Response> {
  if (!options.bindingResolution) return null;
  let stored: ReturnType<typeof executionBindingFromInput>;
  try {
    stored = executionBindingFromInput(input.executionBinding, undefined, { typedQuestion: input.typedQuestion !== undefined });
  } catch (error) {
    if (!(error instanceof ExecutionBindingInputError)) throw error;
    return c.json({ error: error.message, code: "evaluator_lifecycle_invalid_execution_binding", details: {} },400);
  }
  // Candidates are binary evaluators.
  const governed: GovernedBinding = {
    projectId,
    executionBinding: stored.executionBinding,
    customEndpointUrl: stored.customEndpointUrl,
    spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
  };
  const record = await resolveGovernedBinding(options.bindingResolution,governed);
  await options.repository!.recordResolution({
    projectId, skillVersionId: null, executionBinding: stored.executionBinding, kind: "resolution",
    triggerKind: "candidate_creation", triggerRef: input.idempotencyKey, outcome: record.status, probes: record.probes
  },null);
  return { bindingDigest: sha256Digest(stored.executionBinding), record };
}

/**
 * Resolution after save (ADR-0014 section 4), for the gate worker: a
 * just-saved version's binding is resolved when it has no record or only an
 * unresolved one, and the attempt is recorded against the save. A resolved
 * record that lacks an answer only a gate needs is left to the gate, since
 * resolution after save never probes reasoning; a failed one is fixed only by
 * a new version. The mock makes no call, and a mutable alias is refused at
 * every governed gate, so neither is probed.
 */
export function savedVersionResolver(
  repository: EvaluatorLifecycleRepository,
  services: BindingResolutionServices
): (job: { projectId: string; skillVersionId: string }) => Promise<void> {
  return async ({ projectId, skillVersionId }) => {
    const governed = await repository.getGovernedBinding({ projectId }, skillVersionId);
    if (!governed) return;
    const binding = governed.binding.executionBinding;
    if (binding.provider === "mock" || mutableModelAlias(binding.modelId) !== null) return;
    if (governed.record !== null && governed.record.status !== "unresolved") return;
    const record = await resolveSavedBinding(services, governed.binding);
    await repository.recordResolution({
      projectId, skillVersionId, executionBinding: binding, kind: "resolution",
      triggerKind: "version_save", triggerRef: `version-save:${skillVersionId}`, outcome: record.status, probes: record.probes
    }, record);
  };
}

/**
 * Resolves a saved version's binding when a gate needs it (no record, an
 * unresolved one, or a resolved one missing an answer a gate needs) and
 * stores the result. A failed binding is fixed only by a new evaluator
 * version. Returns the latest record, or `undefined` when the version isn't
 * in the project.
 */
async function resolveWhenUnresolved(
  options: CreateEvaluatorLifecycleRouterOptions,
  projectId: string,
  skillVersionId: string,
  triggerKind: "activation" | "on_demand",
  triggerRef: string
): Promise<ResolutionRecord | null | undefined> {
  const governed = await options.repository!.getGovernedBinding({ projectId },skillVersionId);
  if (!governed) return undefined;
  if (!options.bindingResolution || !resolutionNeeded(governed.binding.executionBinding,governed.record)) return governed.record;
  const record = await resolveGovernedBinding(options.bindingResolution,governed.binding);
  return options.repository!.recordResolution({
    projectId, skillVersionId, executionBinding: governed.binding.executionBinding, kind: "resolution",
    triggerKind, triggerRef, outcome: record.status, probes: record.probes
  },record);
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
      error.code==="unsupported" ? 501 : error.code==="invalid_cursor" || error.code==="invalid_execution_binding" ? 400 :
      error.code==="mutable_model_alias" ? 422 : 409;
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
    result.skill.currentVersion.rubricMarkdown===(input.rubricMarkdown ?? null) &&
    result.skill.currentVersion.prompt===(input.prompt ?? null) &&
    canonicalJson(result.skill.currentVersion.typedQuestion)===canonicalJson(input.typedQuestion ?? null) &&
    result.skill.currentVersion.decisionThreshold===(input.decisionThreshold ?? null) &&
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
