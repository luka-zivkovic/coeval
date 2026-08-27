import { Hono, type Context } from "hono";
import { z } from "zod";
import { AnalysisWorkflowMeasurementReportSchema } from "@coeval/shared";
import { verifyAnalysisWorkflowMeasurementReport } from "../lib/analysis-measurement.js";
import {
  AnalysisMeasurementRepositoryError,
  type AnalysisMeasurementAccess,
  type AnalysisMeasurementProjectRole,
  type AnalysisMeasurementRepository
} from "./repository.js";

const ResourceIdSchema = z.string().trim().min(1).max(240);
const QuerySchema = z.object({
  taxonomyRevisionId: ResourceIdSchema.optional(),
  skillVersionId: ResourceIdSchema.optional(),
  calibrationArtifactId: ResourceIdSchema.optional()
}).strict();

interface RouteIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface CreateAnalysisMeasurementRouterOptions {
  repository: AnalysisMeasurementRepository | null;
  databaseMode: boolean;
  requestIdentity: (context: Context) => RouteIdentity;
  resolveProjectRole: (input: { projectId: string; userId: string }) => Promise<AnalysisMeasurementProjectRole | null>;
}

export function createAnalysisMeasurementRouter(options: CreateAnalysisMeasurementRouterOptions): Hono {
  const router = new Hono();
  router.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  router.get("/:studyId", async (context) => {
    const access = await resolveAccess(context, options);
    if (access instanceof Response) return access;
    const study = ResourceIdSchema.safeParse(context.req.param("studyId"));
    if (!study.success) return context.json({ error: "Invalid measurement study identity", code: "analysis_measurement_invalid_resource" }, 400);
    const query = QuerySchema.safeParse(context.req.query());
    if (!query.success || (query.data.calibrationArtifactId && !query.data.skillVersionId)) {
      return context.json({ error: "Invalid analysis measurement query", code: "analysis_measurement_invalid_query" }, 400);
    }
    const result = await callRepository(context, () => options.repository!.getReport(access, study.data, {
      taxonomyRevisionId: query.data.taxonomyRevisionId ?? null,
      skillVersionId: query.data.skillVersionId ?? null,
      calibrationArtifactId: query.data.calibrationArtifactId ?? null
    }));
    if (result instanceof Response) return result;
    if (!result) return context.json({ error: "Analysis measurement study not found", code: "analysis_measurement_not_found" }, 404);
    const parsed = AnalysisWorkflowMeasurementReportSchema.safeParse(result);
    if (!parsed.success || parsed.data.projectId !== access.projectId || parsed.data.studyId !== study.data ||
        (query.data.taxonomyRevisionId !== undefined &&
          (parsed.data.taxonomy.state !== "available" ||
           parsed.data.taxonomy.coverage.taxonomyRevisionId !== query.data.taxonomyRevisionId)) ||
        (query.data.taxonomyRevisionId === undefined && parsed.data.taxonomy.state !== "not_requested") ||
        (query.data.skillVersionId !== undefined && parsed.data.evaluator?.skillVersionId !== query.data.skillVersionId) ||
        (query.data.skillVersionId === undefined && parsed.data.evaluator !== null) ||
        (query.data.calibrationArtifactId !== undefined &&
          ((parsed.data.evaluator?.calibration.state !== "complete" &&
            parsed.data.evaluator?.calibration.state !== "incomplete") ||
           parsed.data.evaluator.calibration.artifactId !== query.data.calibrationArtifactId))) {
      throw new Error("Analysis measurement repository returned a cross-bound report");
    }
    verifyAnalysisWorkflowMeasurementReport(parsed.data);
    return context.json({ report: parsed.data, projectRole: access.projectRole });
  });
  return router;
}

async function resolveAccess(
  context: Context,
  options: CreateAnalysisMeasurementRouterOptions
): Promise<AnalysisMeasurementAccess | Response> {
  if (!options.databaseMode || !options.repository) {
    return context.json({
      error: "Analysis measurements require database-backed session mode",
      code: "analysis_measurement_database_required"
    }, 501);
  }
  const identity = options.requestIdentity(context);
  if (identity.apiKeyId || !identity.userId) {
    return context.json({ error: "A project-member session is required", code: "analysis_measurement_session_required" }, 401);
  }
  const projectRole = await options.resolveProjectRole({ projectId: identity.projectId, userId: identity.userId });
  if (!projectRole) {
    return context.json({ error: "Analysis measurement membership was not found", code: "analysis_measurement_forbidden" }, 403);
  }
  return { projectId: identity.projectId, userId: identity.userId, projectRole };
}

async function callRepository<T>(context: Context, callback: () => Promise<T>): Promise<T | Response> {
  try {
    return await callback();
  } catch (error) {
    if (!(error instanceof AnalysisMeasurementRepositoryError)) throw error;
    const status = error.code === "not_found" ? 404 : 409;
    return context.json({
      error: error.message,
      code: `analysis_measurement_${error.code}`,
      details: error.details
    }, status);
  }
}
