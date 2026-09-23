import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  PRODUCTION_CALIBRATION_MAX_BINS,
  ProductionCalibrationArtifactSchema,
  buildProductionCalibrationArtifact,
  joinProductionDecisionRecords,
  type ProductionCalibrationArtifact,
  type ProductionDecisionAnswerType,
  type ProductionDecisionLedgerRecord
} from "@rubrist/shared";
import { productionRecordErrorStatus } from "./ingest-routes.js";
import { LedgerParseError, parseLedgerRecords as parseLedger } from "./ledger.js";
import {
  PRODUCTION_REPORT_DEFAULT_MAX_RECORDS,
  ProductionRecordRepositoryError,
  type ProductionDecisionRecordRepository
} from "./repository.js";

// Session routes for production calibration. The preview is compute-only: the
// caller posts the decision ledger with the request and nothing is persisted,
// queued, or read from the database. The owner import appends a ledger to the
// project's durable records through the same write path as API-key ingest
// (ADR-0013 §4). Both share the session and membership checks of the
// neighbouring analysis surfaces.

/** Same ceiling as the batch judge body: a ledger preview is a bulk upload, not a single trace. */
export const PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES = 4 * 1024 * 1024;

const ProbabilitySchema = z.number().finite().min(0).max(1);
const NonNegativeSchema = z.number().finite().min(0);
const QuestionSchema = z.string().min(1).max(4_096);

export const ProductionCalibrationPreviewCostsSchema = z.object({
  falsePositive: NonNegativeSchema,
  falseNegative: NonNegativeSchema,
  humanReview: NonNegativeSchema.nullable().optional()
}).strict();

const ReportParametersShape = {
  /** When given, `threshold` and `costs` apply to this question only; other questions keep the defaults. */
  question: QuestionSchema.optional(),
  threshold: ProbabilitySchema.optional(),
  bins: z.number().int().min(1).max(PRODUCTION_CALIBRATION_MAX_BINS).optional(),
  windowDays: z.number().int().min(1).max(366).optional(),
  costs: ProductionCalibrationPreviewCostsSchema.nullable().optional()
};

export const ProductionCalibrationPreviewRequestSchema = z.object({
  /** JSON Lines text, or an array of already-parsed records. */
  records: z.union([z.string(), z.array(z.unknown())]),
  ...ReportParametersShape
}).strict();
export type ProductionCalibrationPreviewRequest = z.infer<typeof ProductionCalibrationPreviewRequestSchema>;

const WindowBoundSchema = z.string().datetime({ offset: true }).nullable().optional();

/** A report over the project's stored records; `from` is inclusive and `to` exclusive, on decision time. */
export const ProductionCalibrationStoredReportRequestSchema = z.object({
  from: WindowBoundSchema,
  to: WindowBoundSchema,
  ...ReportParametersShape
}).strict();
export type ProductionCalibrationStoredReportRequest = z.infer<typeof ProductionCalibrationStoredReportRequestSchema>;

type ReportParameters = Omit<ProductionCalibrationStoredReportRequest, "from" | "to">;

export const ProductionCalibrationImportRequestSchema = z.object({
  /** JSON Lines text, or an array of records. */
  records: z.union([z.string(), z.array(z.unknown())])
}).strict();

export interface ProductionCalibrationPreviewQuestionSummary {
  question: string;
  answerTypes: ProductionDecisionAnswerType[];
  decisions: number;
  outcomes: number;
}

export interface ProductionCalibrationPreviewSummary {
  records: { total: number; decisions: number; actions: number; outcomes: number };
  questions: ProductionCalibrationPreviewQuestionSummary[];
  models: ProductionCalibrationArtifact["records"]["models"];
  questionSetDigests: string[];
  /** The question the request scoped its threshold and costs to, if any. */
  question: string | null;
}

export interface ProductionCalibrationPreviewResponse {
  artifact: ProductionCalibrationArtifact;
  summary: ProductionCalibrationPreviewSummary;
  projectRole: ProductionCalibrationProjectRole;
}

export interface ProductionCalibrationStoredReportResponse extends ProductionCalibrationPreviewResponse {
  recordCount: number;
  recordSetDigest: string;
}

export type ProductionCalibrationProjectRole = "owner" | "member";

interface RouteIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

interface RouteAccess {
  projectId: string;
  userId: string;
  projectRole: ProductionCalibrationProjectRole;
}

export interface CreateProductionCalibrationRouterOptions {
  databaseMode: boolean;
  requestIdentity: (context: Context) => RouteIdentity;
  resolveProjectRole: (input: { projectId: string; userId: string }) => Promise<ProductionCalibrationProjectRole | null>;
  /** Durable decision records; null outside database-backed mode. */
  repository?: ProductionDecisionRecordRepository | null | undefined;
  /** The most stored records one report may load; defaults to PRODUCTION_REPORT_DEFAULT_MAX_RECORDS. */
  maxReportRecords?: number | undefined;
  /** The artifact's generation time; injectable so tests stay deterministic. */
  now?: () => Date;
}

class PreviewHttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 501 | 503,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "PreviewHttpError";
  }
}

export function createProductionCalibrationRouter(options: CreateProductionCalibrationRouterOptions): Hono {
  const router = new Hono();
  router.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  router.onError((error, context) => {
    if (error instanceof PreviewHttpError) {
      return context.json({
        error: error.message,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details })
      }, error.status);
    }
    throw error;
  });
  router.post("/preview", async (context) => {
    const access = await resolveAccess(context, options);
    if (access instanceof Response) return access;
    const request = await parseBody(context);
    const records = parseLedgerRecords(request.records);
    if (records.length === 0) {
      throw new PreviewHttpError("The ledger contains no records", "production_calibration_empty_ledger", 400);
    }
    const artifact = buildReport(records, request, (options.now ?? (() => new Date()))(), null);
    const response: ProductionCalibrationPreviewResponse = {
      artifact,
      summary: summarize(records, artifact, request.question ?? null),
      projectRole: access.projectRole
    };
    return context.json(response);
  });
  // Reports over stored records (ADR-0013 §3). The server loads the window's
  // records itself, so a stored report or snapshot can only describe records
  // Rubrist holds, never a pasted ledger.
  const storedReport = async (context: Context): Promise<{
    access: RouteAccess;
    repository: ProductionDecisionRecordRepository;
    request: ProductionCalibrationStoredReportRequest;
    response: ProductionCalibrationStoredReportResponse;
  }> => {
    const access = await resolveAccess(context, options);
    if (access instanceof Response) throw new ResponseError(access);
    const repository = requireRepository(options);
    const parsed = ProductionCalibrationStoredReportRequestSchema.safeParse(await readJsonBody(context));
    if (!parsed.success) {
      throw new PreviewHttpError(
        "Invalid production calibration report request",
        "production_calibration_invalid_request",
        400,
        { validation: z.treeifyError(parsed.error) }
      );
    }
    const request = parsed.data;
    const window = {
      from: request.from ? new Date(request.from) : null,
      to: request.to ? new Date(request.to) : null
    };
    if (window.from && window.to && window.from.getTime() >= window.to.getTime()) {
      throw new PreviewHttpError("The window's from must be earlier than its to", "production_calibration_invalid_window", 400);
    }
    const loaded = await withRecordErrors(context, () => repository.loadRecords({
      projectId: access.projectId,
      window,
      maxRecords: options.maxReportRecords ?? PRODUCTION_REPORT_DEFAULT_MAX_RECORDS
    }));
    const artifact = buildReport(loaded.records, request, (options.now ?? (() => new Date()))(), window);
    return {
      access,
      repository,
      request,
      response: {
        artifact,
        summary: summarize(loaded.records, artifact, request.question ?? null),
        projectRole: access.projectRole,
        recordCount: loaded.records.length,
        recordSetDigest: loaded.recordSetDigest
      }
    };
  };
  router.post("/report", async (context) => {
    try {
      return context.json((await storedReport(context)).response);
    } catch (error) {
      if (error instanceof ResponseError) return error.response;
      throw error;
    }
  });
  router.post("/snapshots", async (context) => {
    let built: Awaited<ReturnType<typeof storedReport>>;
    try {
      built = await storedReport(context);
    } catch (error) {
      if (error instanceof ResponseError) return error.response;
      throw error;
    }
    const { access, repository, request, response } = built;
    const snapshot = await withRecordErrors(context, () => repository.saveSnapshot({
      projectId: access.projectId,
      userId: access.userId,
      artifact: response.artifact,
      parameters: request,
      recordCount: response.recordCount,
      recordSetDigest: response.recordSetDigest
    }));
    return context.json({ snapshot }, 201);
  });
  router.get("/snapshots", async (context) => {
    const access = await resolveAccess(context, options);
    if (access instanceof Response) return access;
    return context.json({ snapshots: await requireRepository(options).listSnapshots(access.projectId) });
  });
  router.get("/snapshots/:snapshotId", async (context) => {
    const access = await resolveAccess(context, options);
    if (access instanceof Response) return access;
    const snapshot = await requireRepository(options).getSnapshot(access.projectId, context.req.param("snapshotId"));
    if (!snapshot) {
      throw new PreviewHttpError("Snapshot not found", "production_calibration_snapshot_not_found", 404);
    }
    return context.json(snapshot);
  });
  router.post("/records", async (context) => {
    const access = await resolveAccess(context, options);
    if (access instanceof Response) return access;
    if (access.projectRole !== "owner") {
      throw new PreviewHttpError("Only project owners can import decision records", "production_calibration_owner_required", 403);
    }
    const repository = requireRepository(options);
    const parsed = ProductionCalibrationImportRequestSchema.safeParse(await readJsonBody(context));
    if (!parsed.success) {
      throw new PreviewHttpError(
        "Invalid production decision record import",
        "production_calibration_invalid_request",
        400,
        { validation: z.treeifyError(parsed.error) }
      );
    }
    const records = parseLedgerRecords(parsed.data.records);
    return context.json(await withRecordErrors(context, () => repository.appendRecords({
      projectId: access.projectId,
      submitter: { kind: "user", userId: access.userId },
      records
    })));
  });
  return router;
}

/** Carries an access-check response out of a helper. */
class ResponseError extends Error {
  constructor(readonly response: Response) {
    super("access refused");
    this.name = "ResponseError";
  }
}

function requireRepository(options: CreateProductionCalibrationRouterOptions): ProductionDecisionRecordRepository {
  if (!options.repository) {
    throw new PreviewHttpError("Decision records need database-backed mode", "production_calibration_records_unavailable", 501);
  }
  return options.repository;
}

/** Answer a record store rejection with its own status and a `production_calibration_` code. */
async function withRecordErrors<T>(context: Context, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProductionRecordRepositoryError) {
      if (error.code === "write_contention") context.header("retry-after", "1");
      throw new PreviewHttpError(
        error.message,
        `production_calibration_${error.code}`,
        productionRecordErrorStatus(error.code),
        error.details
      );
    }
    throw error;
  }
}

/** Build one report from records and request parameters; shared by the preview and stored reports. */
function buildReport(
  records: readonly ProductionDecisionLedgerRecord[],
  request: ReportParameters,
  now: Date,
  window: { from: Date | null; to: Date | null } | null
): ProductionCalibrationArtifact {
  const costs = request.costs === undefined || request.costs === null
    ? request.costs
    : {
      falsePositive: request.costs.falsePositive,
      falseNegative: request.costs.falseNegative,
      humanReview: request.costs.humanReview ?? null
    };
  const scoped = request.question !== undefined;
  if (scoped && !records.some((record) => record.kind === "decision" && request.question! in record.answers)) {
    throw new PreviewHttpError(
      `No decision answers the question "${request.question}"`,
      "production_calibration_unknown_question",
      400
    );
  }
  return ProductionCalibrationArtifactSchema.parse(buildArtifact(records, {
    now,
    ...(window === null ? {} : { window }),
    ...(request.bins === undefined ? {} : { bins: request.bins }),
    ...(request.windowDays === undefined ? {} : { windowDays: request.windowDays }),
    ...(scoped
      ? {
        questions: {
          [request.question!]: {
            ...(request.threshold === undefined ? {} : { threshold: request.threshold }),
            ...(costs === undefined ? {} : { costs })
          }
        }
      }
      : {
        ...(request.threshold === undefined ? {} : { threshold: request.threshold }),
        ...(costs === undefined ? {} : { costs })
      })
  }));
}

// The shared join rejects two decision records that share an id but differ in
// content, because neither the prediction nor its provenance may be replaced
// silently. That is a fault in the ledger, not in the service, so it is a 400.
function buildArtifact(
  records: readonly ProductionDecisionLedgerRecord[],
  options: Parameters<typeof buildProductionCalibrationArtifact>[1]
): ProductionCalibrationArtifact {
  try {
    return buildProductionCalibrationArtifact(records, options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Conflicting decision records")) {
      throw new PreviewHttpError(error.message, "production_calibration_conflicting_records", 400);
    }
    throw error;
  }
}

/**
 * Parse JSON Lines text or an array of records with the shared ledger parser,
 * answering a bad line as `400 production_calibration_invalid_record`.
 */
export function parseLedgerRecords(input: string | readonly unknown[]): ProductionDecisionLedgerRecord[] {
  try {
    return parseLedger(input);
  } catch (error) {
    if (error instanceof LedgerParseError) {
      throw new PreviewHttpError(error.message, "production_calibration_invalid_record", 400, error.details);
    }
    throw error;
  }
}

function summarize(
  records: readonly ProductionDecisionLedgerRecord[],
  artifact: ProductionCalibrationArtifact,
  question: string | null
): ProductionCalibrationPreviewSummary {
  const joined = joinProductionDecisionRecords(records);
  const questions = new Map<string, { types: Set<ProductionDecisionAnswerType>; decisions: number; outcomes: number }>();
  for (const { decision, outcomes } of joined) {
    for (const [name, answer] of Object.entries(decision.answers)) {
      const entry = questions.get(name) ?? { types: new Set(), decisions: 0, outcomes: 0 };
      entry.types.add(answer.type);
      entry.decisions += 1;
      if (name in outcomes) entry.outcomes += 1;
      questions.set(name, entry);
    }
  }
  let actions = 0;
  let outcomes = 0;
  for (const record of records) {
    if (record.kind === "action") actions += 1;
    else if (record.kind === "outcome") outcomes += 1;
  }
  const typeOrder: readonly ProductionDecisionAnswerType[] = ["boolean", "choice", "score"];
  return {
    records: { total: records.length, decisions: joined.length, actions, outcomes },
    questions: [...questions.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, entry]) => ({
        question: name,
        answerTypes: typeOrder.filter((type) => entry.types.has(type)),
        decisions: entry.decisions,
        outcomes: entry.outcomes
      })),
    models: artifact.records.models,
    questionSetDigests: [...new Set(artifact.records.questionSets.map((set) => set.digest))].sort(),
    question
  };
}

async function resolveAccess(
  context: Context,
  options: CreateProductionCalibrationRouterOptions
): Promise<RouteAccess | Response> {
  if (!options.databaseMode) {
    return context.json({
      error: "Production calibration previews require database-backed session mode",
      code: "production_calibration_database_required"
    }, 501);
  }
  const identity = options.requestIdentity(context);
  if (identity.apiKeyId || !identity.userId) {
    return context.json({ error: "A project-member session is required", code: "production_calibration_session_required" }, 401);
  }
  if (!identity.projectId) {
    return context.json({ error: "No project membership", code: "production_calibration_project_required" }, 403);
  }
  const projectRole = await options.resolveProjectRole({ projectId: identity.projectId, userId: identity.userId });
  if (!projectRole) {
    return context.json({ error: "Production calibration membership was not found", code: "production_calibration_forbidden" }, 403);
  }
  return { projectId: identity.projectId, userId: identity.userId, projectRole };
}

async function parseBody(context: Context): Promise<ProductionCalibrationPreviewRequest> {
  const parsed = ProductionCalibrationPreviewRequestSchema.safeParse(await readJsonBody(context));
  if (!parsed.success) {
    throw new PreviewHttpError(
      "Invalid production calibration preview request",
      "production_calibration_invalid_request",
      400,
      { validation: z.treeifyError(parsed.error) }
    );
  }
  return parsed.data;
}

/** Read a JSON body under the route's own byte ceiling, which is checked inside the router. */
async function readJsonBody(context: Context): Promise<unknown> {
  const declaredLength = Number(context.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES) {
    throw new PreviewHttpError(
      `Request body exceeds ${PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES} bytes`,
      "production_calibration_body_too_large",
      413
    );
  }
  const text = await context.req.text();
  if (new TextEncoder().encode(text).byteLength > PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES) {
    throw new PreviewHttpError(
      `Request body exceeds ${PRODUCTION_CALIBRATION_PREVIEW_BODY_BYTES} bytes`,
      "production_calibration_body_too_large",
      413
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PreviewHttpError("Invalid JSON request body", "production_calibration_invalid_request", 400);
  }
}
