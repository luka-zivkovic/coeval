import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import {
  AddReviewQueueItemsInputSchema,
  AgentBootstrapRequestSchema,
  type AgentBootstrapResponse,
  buildAgentConnectSnippets,
  compileJudgePrompt,
  defaultJudgePromptTemplate,
  CreateApiKeyInputSchema,
  CreateCriterionInputSchema,
  CreateCriterionVersionInputSchema,
  CreateReviewQueueInputSchema,
  CreateSkillVersionInputSchema,
  CreateEvaluatorSuiteManifestInputSchema,
  JudgeBatchRequestSchema,
  JudgeServiceRequestSchema,
  verdictLabelFromPayload,
  VERDICT_LIST_MAX_LIMIT,
  FeedbackSyncStatusSchema,
  ImportJobStatusSchema,
  PROJECT_NAME_MAX_LENGTH,
  ProjectModeSchema,
  type LangfuseConnectionTestResult,
  type LangfuseImportEnqueueResult,
  LangfuseImportRequestSchema,
  LangfuseIntegrationInputSchema,
  type IronsideConnectionTestResult,
  type IronsideEvaluatorContext,
  type IronsideImportEnqueueResult,
  IronsideImportRequestSchema,
  IronsideIntegrationInputSchema,
  UpdateIronsideIntegrationInputSchema,
  type LangSmithConnectionTestResult,
  type LangSmithImportEnqueueResult,
  LangSmithImportRequestSchema,
  LangSmithIntegrationInputSchema,
  ManualTraceImportInputSchema,
  MinimumVerdictOutputSchema,
  PromoteGoldenSetInputSchema,
  ReviewQueueStatusSchema,
  JudgeKeyProviderSchema,
  RetireGoldenSetEntryInputSchema,
  SetJudgeProviderKeyInputSchema,
  UpdateLangfuseIntegrationInputSchema,
  UpdateLangSmithIntegrationInputSchema,
  type V1CaseEntry,
  type V1CasesResponse,
  type V1FindingsResponse,
  type V1GoldenResponse,
  type V1ProjectResponse,
  FINDINGS_CASE_SCAN_LIMIT,
  FINDINGS_VERDICT_SCAN_LIMIT,
  V1_CASES_DEFAULT_LIMIT,
  V1_CASES_MAX_LIMIT,
  VerdictPayloadSchema,
  VerdictSourceSchema
} from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import { AgentSetupEligibilityError, AmbiguousProjectSkillError, AssessmentReceiptIntegrityError, AssessmentReceiptUnavailableError, CaseNotFoundError, CoevalRepository, CriterionStableKeyConflictError, DatasetNotFoundError, DatasetRevisionConflictError, DemoRepository, EvaluatorSuiteBindingError, EvaluatorSuiteIdempotencyConflictError, GoldenSetEntryAlreadyRetiredError, GoldenSetEntryNotFoundError, GoldenSetLabelConflictError, ImportSkillVersionBindingError, IronsideIntegrationAlreadyExistsError, IronsideIntegrationChangedError, IronsideIntegrationNotFoundError, LangfuseIntegrationNotFoundError, LangSmithIntegrationNotFoundError, NoCurrentSkillError, RecursiveTraceSkippedError, RegressionGateJudgeError, RegressionGateUnavailableError, type IronsideImportContext, type LangfuseImportContext, type LangSmithImportContext } from "./repository.js";
import type { CoevalAuth } from "./lib/auth.js";
import {
  bootstrapOwnerUserByEmail,
  claimAgentSetupPairing,
  completeAgentSetupPairing,
  createInvitation,
  createProjectForUser,
  ensureWorkspaceForUser,
  firstProjectForUser,
  invalidateAgentSetupPairing,
  parseTrustedOrigins,
  redeemInvitation,
  releaseAgentSetupPairing,
  resolveAgentSetupPairing,
  setupRequired,
  userProjectRole
} from "./lib/auth.js";
import { LangSmithClient, LangSmithHttpError, type LangSmithTraceFetcher } from "./lib/langsmith.js";
import { LangfuseClient, LangfuseHttpError, type LangfuseTraceFetcher } from "./lib/langfuse.js";
import { IronsideClient, IronsideHttpError, type IronsideTraceSource } from "./lib/ironside.js";
import { buildTrustDigest, SPEND_WINDOW_RUNS } from "./lib/trust-digest.js";
import { buildFindings, latestDiscreteVerdictByCase } from "./lib/findings.js";
import {
  createStrictJudgeProvider,
  isJudgeAuthError,
  judgeProviderEnvironmentKey,
  JudgeProviderUnavailableError,
  openAIJudgeProviderBaseUrl
} from "./lib/judge-provider.js";
import {
  createGovernedReviewRouter,
  PgGovernedReviewRepository,
  type GovernedReviewRepository
} from "./governed-review/index.js";
import {
  createBinaryCalibrationArtifactRouter,
  createBinaryCalibrationControlRouter
} from "./binary-calibration/routes.js";
import { PgBinaryCalibrationRepository } from "./binary-calibration/repository.pg.js";
import type { BinaryCalibrationControlRepository } from "./binary-calibration/repository.js";
import { createAnalysisPopulationRouter } from "./analysis-population/routes.js";
import { PgAnalysisPopulationRepository } from "./analysis-population/repository.pg.js";
import type { AnalysisPopulationRepository } from "./analysis-population/repository.js";
import {
  createAnalysisStudyRouter,
  createAnalysisTaxonomyRouter,
  PgAnalysisStudyRepository,
  type AnalysisStudyRepository
} from "./analysis-study/index.js";
import {
  createAnalysisPromotionRouter,
  PgAnalysisPromotionRepository,
  type AnalysisPromotionRepository
} from "./analysis-promotion/index.js";
import {
  createEvaluatorLifecycleRouter,
  PgEvaluatorLifecycleRepository,
  type EvaluatorLifecycleRepository
} from "./evaluator-lifecycle/index.js";
import {
  createAnalysisMeasurementRouter,
  PgAnalysisMeasurementRepository,
  type AnalysisMeasurementRepository
} from "./analysis-measurement/index.js";
import { fetchJudgeModelCatalog, JudgeModelCatalogError } from "./lib/judge-models.js";
import { contentDigest, sha256Digest } from "./lib/assessment-receipt.js";
import { canonicalEvaluatorSuiteManifestBytes } from "./lib/evaluator-suite.js";
import { assertImportJudgingAllowed, scheduleImportedCaseJudging } from "./workers/import-judging.js";
import { judgeAndRecord } from "./workers/judge.js";
import type { TraceTestDraftGenerator } from "./lib/trace-test-drafter.js";
import type { TraceTestValidationRunner } from "./lib/trace-test-validator.js";
import {
  createRequestServices,
  type AppVariables
} from "./request-services/index.js";
import { registerDatasetAdministrationRoutes } from "./routes/dataset-administration.js";
import { registerEvaluationAdministrationRoutes } from "./routes/evaluation-administration.js";
import {
  FIRST_PROJECT_KEY_NAME,
  registerProjectAdministrationRoutes
} from "./routes/project-administration.js";
import { registerSkillAdministrationRoutes } from "./routes/skill-administration.js";
import { registerTraceTestAdministrationRoutes } from "./routes/trace-test-administration.js";

export {
  agentSetupPairingClaimExpiresAt,
  agentSetupPairingStatus
} from "./routes/project-administration.js";

// Guardrails on the API-keyed judge surface. Env-overridable so a deployment
// can tune them without a release; the defaults assume one team's CI, not
// public traffic. A malformed value falls back to the default — NaN must not
// silently disable a limit (NaN comparisons are all false, which would turn
// the rate limit off).
function guardrailFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`Ignoring ${name}="${raw}" (not a positive number); using ${fallback}.`);
    return fallback;
  }
  return value;
}
const JUDGE_MAX_BODY_BYTES = guardrailFromEnv("JUDGE_MAX_BODY_BYTES", 256 * 1024);
const JUDGE_RATE_LIMIT_PER_MINUTE = guardrailFromEnv("JUDGE_RATE_LIMIT_PER_MINUTE", 60);
const JUDGE_TIMEOUT_MS = guardrailFromEnv("JUDGE_TIMEOUT_MS", 60_000);
const JUDGE_BATCH_MAX_ITEMS = guardrailFromEnv("JUDGE_BATCH_MAX_ITEMS", 100);
const JUDGE_BATCH_MAX_BODY_BYTES = guardrailFromEnv("JUDGE_BATCH_MAX_BODY_BYTES", 4 * 1024 * 1024);
const TRACE_TEST_DRAFT_TIMEOUT_MS = guardrailFromEnv("TRACE_TEST_DRAFT_TIMEOUT_MS", 45_000);
const TRACE_TEST_VALIDATION_TIMEOUT_MS = guardrailFromEnv("TRACE_TEST_VALIDATION_TIMEOUT_MS", 30_000);
const LEGACY_GOVERNANCE_CLASS = "ungoverned_legacy";

// Existing verdict, adjudication, and review-queue surfaces predate the
// governed-review contract. Keep their wire shapes stable while making the
// evidence boundary machine-readable on successes and validation errors.
function markUngovernedLegacy(c: Context): void {
  c.header("X-Coeval-Governance-Class", LEGACY_GOVERNANCE_CLASS);
}

const ReceiptComparisonInputSchema = z.object({
  consumerReceiptBase64: z.string().min(1).max(JUDGE_BATCH_MAX_BODY_BYTES)
}).strict();

function decodeExactBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

const AGENT_BOOTSTRAP_PROMPT = defaultJudgePromptTemplate("captured agent-skill run");

function bootstrapTokenMatches(presented: string): boolean {
  const configured = process.env.COEVAL_BOOTSTRAP_TOKEN?.trim() ?? "";
  if (configured.length < 32 || presented.length === 0) return false;
  const configuredHash = createHash("sha256").update(configured).digest();
  const presentedHash = createHash("sha256").update(presented).digest();
  return timingSafeEqual(configuredHash, presentedHash);
}

// The origin agents must call back. Behind a TLS-terminating reverse proxy the
// request URL carries the INTERNAL scheme/host (no X-Forwarded handling exists
// here), so pasted instructions would point the agent at http://internal and
// every bootstrap would fail. BETTER_AUTH_URL is the deployment's canonical
// public origin; the request origin is only the single-host dev fallback.
function publicApiBaseUrl(c: Context): string {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(c.req.url).origin;
}

export function bootstrapRateLimitIdentity(c: Context): string {
  // Forwarded addresses are authoritative only when the operator explicitly
  // declares that direct traffic cannot bypass their trusted reverse proxy.
  if (process.env.COEVAL_TRUST_PROXY === "1") {
    const forwarded = c.req.header("cf-connecting-ip")
      ?? c.req.header("x-real-ip")
      ?? c.req.header("x-forwarded-for")?.split(",")[0];
    if (forwarded?.trim()) return forwarded.trim();
  }
  try {
    const direct = getConnInfo(c).remote.address;
    if (direct?.trim()) return direct.trim();
  } catch {
    // app.request() and non-Node adapters do not expose socket metadata.
  }
  return "unknown-client";
}

export interface CreateAppOptions {
  auth?: CoevalAuth | undefined;
  pool?: Pool | undefined;
  queue?: Queue | undefined;
  langSmithClientFactory?: ((context: LangSmithImportContext) => LangSmithTraceFetcher) | undefined;
  langfuseClientFactory?: ((context: LangfuseImportContext) => LangfuseTraceFetcher) | undefined;
  ironsideClientFactory?: ((context: Pick<IronsideImportContext, "url" | "apiKey">) => IronsideTraceSource) | undefined;
  traceTestDraftGenerator?: TraceTestDraftGenerator | undefined;
  traceTestValidationRunner?: TraceTestValidationRunner | undefined;
  governedReviewRepository?: GovernedReviewRepository | null | undefined;
  binaryCalibrationRepository?: BinaryCalibrationControlRepository | null | undefined;
  analysisPopulationRepository?: AnalysisPopulationRepository | null | undefined;
  analysisStudyRepository?: AnalysisStudyRepository | null | undefined;
  analysisPromotionRepository?: AnalysisPromotionRepository | null | undefined;
  evaluatorLifecycleRepository?: EvaluatorLifecycleRepository | null | undefined;
  analysisMeasurementRepository?: AnalysisMeasurementRepository | null | undefined;
}

export function createApp(repository: CoevalRepository = new DemoRepository(), options: CreateAppOptions = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const trustedOrigins = parseTrustedOrigins(process.env.TRUSTED_ORIGINS);
  const governedReviewRepository = options.governedReviewRepository === undefined
    ? options.pool ? new PgGovernedReviewRepository(options.pool) : null
    : options.governedReviewRepository;
  const binaryCalibrationRepository = options.binaryCalibrationRepository === undefined
    ? options.pool ? new PgBinaryCalibrationRepository(options.pool) : null
    : options.binaryCalibrationRepository;
  const analysisPopulationRepository = options.analysisPopulationRepository === undefined
    ? options.pool ? new PgAnalysisPopulationRepository(options.pool) : null
    : options.analysisPopulationRepository;
  const analysisStudyRepository = options.analysisStudyRepository === undefined
    ? options.pool ? new PgAnalysisStudyRepository(options.pool) : null
    : options.analysisStudyRepository;
  const analysisPromotionRepository = options.analysisPromotionRepository === undefined
    ? options.pool ? new PgAnalysisPromotionRepository(options.pool) : null
    : options.analysisPromotionRepository;
  const evaluatorLifecycleRepository = options.evaluatorLifecycleRepository === undefined
    ? options.pool ? new PgEvaluatorLifecycleRepository(options.pool) : null
    : options.evaluatorLifecycleRepository;
  const analysisMeasurementRepository = options.analysisMeasurementRepository === undefined
    ? options.pool ? new PgAnalysisMeasurementRepository(options.pool) : null
    : options.analysisMeasurementRepository;
  const requestServices = createRequestServices({
    repository,
    ...(options.pool ? { pool: options.pool } : {}),
    ...(options.queue ? { queue: options.queue } : {}),
    ownerAuthorizationEnabled: Boolean(options.auth && options.pool),
    rateLimitPerMinute: JUDGE_RATE_LIMIT_PER_MINUTE,
    batchMaxItems: JUDGE_BATCH_MAX_ITEMS
  });
  const {
    dispatch: dispatchEvalRun,
    listJudgeProviders,
    requireOwner,
    resolveSkillVersionId,
    takeRateTokens
  } = requestServices;

  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) => (trustedOrigins.includes(origin) ? origin : trustedOrigins[0] ?? "http://localhost:5173"),
      allowHeaders: ["Content-Type", "Authorization", "X-Coeval-Project"],
      exposeHeaders: [
        "X-Coeval-View-Digest",
        "X-Coeval-Canonicalization",
        "X-Coeval-Governance-Class",
        "X-Coeval-Artifact-Digest",
        "X-Coeval-Evidence-Digest",
        "Retry-After",
        "ETag",
        "Digest"
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      maxAge: 600
    })
  );

  app.use("*", async (c, next) => {
    if (!options.auth) {
      c.set("user", null);
      c.set("session", null);
      c.set("projectId", "proj_langsmith_support");
      await next();
      return;
    }

    const session = await options.auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", session?.user ? { id: session.user.id, email: session.user.email, name: session.user.name } : null);
    c.set("session", session?.session ?? null);
    await next();
  });

  app.get("/health", (c) => {
    return c.json({ ok: true, service: "coeval-api" });
  });

  app.get("/api/auth/setup-required", async (c) => {
    if (!options.pool || !options.auth) return c.json({ setupRequired: false, authEnabled: false });
    return c.json({ setupRequired: await setupRequired(options.pool), authEnabled: true });
  });

  app.post("/api/auth/setup", async (c) => {
    c.header("cache-control", "no-store");
    if (!options.pool || !options.auth) return c.json({ error: "Auth is not enabled" }, 400);
    if (!(await setupRequired(options.pool))) return c.json({ error: "Setup already completed" }, 409);
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({
      email: z.string().email(),
      password: z.string().min(8),
      name: z.string().min(1).optional(),
      projectName: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH).optional(),
      mode: ProjectModeSchema.optional()
    }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid setup input", details: z.treeifyError(parsed.error) }, 400);

    // returnHeaders: signUpEmail auto-signs-in (autoSignIn: true) and emits
    // the session cookie — forward it so the new owner lands in the app
    // instead of being bounced to the login form to re-type credentials.
    const { headers, response: result } = await options.auth.api.signUpEmail({
      returnHeaders: true,
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name ?? parsed.data.email
      }
    }) as { headers: Headers; response: { user?: { id: string; email: string } } };
    if (!result.user?.id) return c.json({ error: "User creation failed" }, 500);
    const workspace = await ensureWorkspaceForUser(options.pool, {
      userId: result.user.id,
      email: parsed.data.email,
      owner: true,
      apiKeyName: FIRST_PROJECT_KEY_NAME,
      ...(parsed.data.projectName ? { projectName: parsed.data.projectName } : {}),
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {})
    });
    for (const cookie of headers.getSetCookie?.() ?? []) {
      c.header("set-cookie", cookie, { append: true });
    }
    return c.json({ ok: true, projectId: workspace.projectId, apiKey: workspace.apiKey });
  });

  app.post("/api/auth/redeem-invite", async (c) => {
    if (!options.pool || !options.auth) return c.json({ error: "Auth is not enabled" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ token: z.string().min(8), email: z.string().email(), password: z.string().min(8), name: z.string().min(1).optional() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid invite redemption input", details: z.treeifyError(parsed.error) }, 400);

    // Same auto-signin cookie forwarding as /api/auth/setup: the invited
    // member should land in the app, not on the login form re-typing the
    // credentials they just chose.
    const { headers, response: result } = await options.auth.api.signUpEmail({
      returnHeaders: true,
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name ?? parsed.data.email
      }
    }) as { headers: Headers; response: { user?: { id: string; email: string } } };
    if (!result.user?.id) return c.json({ error: "User creation failed" }, 500);
    await redeemInvitation(options.pool, { token: parsed.data.token, userId: result.user.id });
    for (const cookie of headers.getSetCookie?.() ?? []) {
      c.header("set-cookie", cookie, { append: true });
    }
    return c.json({ ok: true });
  });

  app.use("/api/auth/sign-up/email", async (c) => c.json({ error: "Public sign-up is disabled. Use setup or an invite token." }, 403));
  if (options.auth) {
    app.on(["POST", "GET"], "/api/auth/*", (c) => options.auth!.handler(c.req.raw));
  }

  // Eval-as-a-service: /api/v1/* is authenticated by an API key (Bearer), not a
  // session. Resolve key → project here; runs before the session guard below,
  // which skips /api/v1/ paths.
  //
  // Guardrails, since these calls spend provider tokens: payload size is
  // capped, and each key gets a naive in-memory rate limit (per process —
  // good enough until real customers justify a Postgres-backed quota).
  // Batch carries up to JUDGE_BATCH_MAX_ITEMS traces in one body, so it gets
  // its own (larger) cap; everything else on /api/v1 keeps the single-trace cap.
  const singleBodyLimit = bodyLimit({
    maxSize: JUDGE_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: `Request body exceeds ${JUDGE_MAX_BODY_BYTES} bytes` }, 413)
  });
  const batchBodyLimit = bodyLimit({
    maxSize: JUDGE_BATCH_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: `Request body exceeds ${JUDGE_BATCH_MAX_BODY_BYTES} bytes` }, 413)
  });
  app.use("/api/v1/*", (c, next) =>
    c.req.path === "/api/v1/judge/batch" ||
    c.req.path.endsWith("/assessment-receipt/comparisons")
      ? batchBodyLimit(c, next)
      : singleBodyLimit(c, next)
  );
  // The session-authed examples paste carries the same up-to-500-item bulk
  // shape as the batch endpoint — same cap, or it becomes the one unbounded
  // body the v1 surface is protected against.
  app.use("/api/datasets/:datasetId/examples", batchBodyLimit);
  // Session-authed single-trace import: same single-trace ceiling as /api/v1.
  // Found at the M2 T1 security pass — this was the one uncapped ingestion
  // route, and steps ride the same body.
  app.use("/api/traces/manual", singleBodyLimit);
  // Test drafts carry two example outputs plus checker metadata. Keep the
  // beginner surface inside the same bound as one imported trace.
  app.use("/api/trace-tests", singleBodyLimit);
  app.use("/api/trace-tests/*", singleBodyLimit);

  const isOwnerSessionContractWrite = (method: string, path: string): boolean =>
    method === "POST" && (
      path === "/api/v1/criteria" ||
      /^\/api\/v1\/criteria\/[^/]+\/versions$/.test(path) ||
      path === "/api/v1/evaluator-suite-manifests"
    );
  const isSessionContractRoute = (path: string): boolean =>
    path === "/api/v1/criteria" ||
    path.startsWith("/api/v1/criteria/") ||
    path === "/api/v1/evaluator-suites" ||
    path.startsWith("/api/v1/evaluator-suites/") ||
    path === "/api/v1/evaluator-suite-manifests" ||
    path.startsWith("/api/v1/evaluator-suite-manifests/") ||
    path.startsWith("/api/v1/binary-calibration-artifacts/");
  const isOwnerSessionArtifactRoute = (path: string): boolean =>
    path.startsWith("/api/v1/binary-calibration-artifacts/");
  app.use("/api/v1/*", async (c, next) => {
    const ownerWrite = isOwnerSessionContractWrite(c.req.method, c.req.path);
    const ownerArtifactRead = isOwnerSessionArtifactRoute(c.req.path);
    if (options.auth && options.pool && isSessionContractRoute(c.req.path) &&
      (c.get("user") || ownerWrite || ownerArtifactRead)) {
      const user = c.get("user");
      if (!user) {
        if (ownerArtifactRead) {
          return c.json({
            error: "A project-owner session is required for binary calibration artifacts.",
            code: "binary_calibration_owner_session_required"
          }, 403);
        }
        return c.json({
          error: "An owner session is required for criterion and evaluator-suite writes; API keys are read/judge-only.",
          code: "owner_session_required"
        }, 403);
      }
      const requestedProject = c.req.header("x-coeval-project");
      const projectId = requestedProject ?? await firstProjectForUser(options.pool, user.id);
      if (!projectId) return c.json({ error: "No project membership" }, 403);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId });
      if (!role) return c.json({ error: "Not a member of this project" }, 403);
      if (ownerArtifactRead && role !== "owner") {
        return c.json({
          error: "A project-owner session is required for binary calibration artifacts.",
          code: "binary_calibration_owner_session_required"
        }, 403);
      }
      if (ownerWrite && role !== "owner") {
        return c.json({ error: "Only project owners can change criteria or evaluator suites" }, 403);
      }
      c.set("projectId", projectId);
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
    if (c.req.path === "/api/v1/bootstrap") {
      // Pool-less mode can never bootstrap: say so BEFORE token dispatch, or a
      // pairing token gets a misleading 401 that tells the user to regenerate
      // connections that can never work.
      if (!options.pool || !options.auth) {
        return c.json({
          error: "Agent bootstrap requires database-backed auth mode.",
          code: "bootstrap_requires_auth"
        }, 501);
      }
      // Pre-auth attempts are isolated by network client. A single invalid
      // caller can no longer drain one global bucket and starve every valid
      // onboarding connection. Proxy-derived client IPs require the explicit
      // COEVAL_TRUST_PROXY opt-in above.
      const bootstrapRateKey = `agent-bootstrap:${bootstrapRateLimitIdentity(c)}`;
      if (!takeRateTokens(bootstrapRateKey, 1)) {
        return c.json({
          error: `Rate limit exceeded: ${JUDGE_RATE_LIMIT_PER_MINUTE} bootstrap attempts/minute per client.`,
          code: "bootstrap_rate_limited"
        }, 429);
      }
      if (token.startsWith("coeval_pair_")) {
        const pairing = await resolveAgentSetupPairing(options.pool, token);
        if (!pairing) {
          return c.json({
            error: "This agent setup connection is invalid, expired, already used, or revoked.",
            code: "invalid_or_expired_pairing_token"
          }, 401);
        }
        c.set("user", null);
        c.set("projectId", pairing.projectId);
        c.set("agentBootstrapAuth", { kind: "pairing", pairing });
        await next();
        return;
      }
      const configured = process.env.COEVAL_BOOTSTRAP_TOKEN?.trim() ?? "";
      if (configured.length < 32) {
        return c.json({
          error: "No valid agent setup connection was provided and headless bootstrap is not enabled.",
          code: "bootstrap_unavailable",
          hint: "Create a one-time agent connection from Coeval onboarding, or set COEVAL_BOOTSTRAP_TOKEN for headless administration."
        }, 503);
      }
      if (!bootstrapTokenMatches(token)) {
        return c.json({ error: "Invalid bootstrap token.", code: "invalid_bootstrap_token" }, 401);
      }
      c.set("user", null);
      c.set("projectId", "");
      c.set("agentBootstrapAuth", { kind: "deployment-token" });
      await next();
      return;
    }
    if (!token) {
      return c.json({ error: "Missing API key. Send 'Authorization: Bearer <key>'." }, 401);
    }
    const resolved = await repository.resolveApiKey(token);
    if (!resolved) return c.json({ error: "Invalid or revoked API key." }, 401);

    if (!takeRateTokens(resolved.apiKeyId, 1)) {
      return c.json({ error: `Rate limit exceeded: ${JUDGE_RATE_LIMIT_PER_MINUTE} requests/minute per API key.` }, 429);
    }

    c.set("user", null);
    c.set("projectId", resolved.projectId);
    c.set("apiKeyId", resolved.apiKeyId);
    await next();
  });

  app.use("/api/*", async (c, next) => {
    // /api/v1/* authenticates via API key in the middleware above.
    if (c.req.path.startsWith("/api/v1/")) {
      await next();
      return;
    }
    if (!options.auth || !options.pool) {
      c.set("projectId", "proj_langsmith_support");
      await next();
      return;
    }
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    // P0-2: /api/projects needs no project resolution — listing and creating
    // projects must work for a user with zero memberships, or deleting the
    // last project strands the account permanently.
    if (c.req.path === "/api/projects") {
      c.set("projectId", "");
      await next();
      return;
    }

    // Project switching: the client pins a project with x-coeval-project;
    // membership is checked, not trusted. No header = oldest membership.
    const requestedProject = c.req.header("x-coeval-project");
    if (requestedProject) {
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: requestedProject });
      if (!role) return c.json({ error: "Not a member of this project" }, 403);
      c.set("projectId", requestedProject);
      await next();
      return;
    }
    const projectId = await firstProjectForUser(options.pool, user.id);
    if (!projectId) return c.json({ error: "No project membership" }, 403);
    c.set("projectId", projectId);
    await next();
  });

  // Governed human truth is a session-only, database-backed module. It is
  // intentionally mounted after the shared project-membership resolver and
  // never falls through to DemoRepository or the API-keyed /api/v1 surface.
  app.route("/api/governed-review", createGovernedReviewRouter({
    repository: governedReviewRepository,
    authMode: Boolean(options.auth && options.pool),
    requestIdentity: (c) => ({
      userId: c.get("user")?.id ?? null,
      projectId: c.get("projectId") ?? "",
      ...(c.get("apiKeyId") ? { apiKeyId: c.get("apiKeyId") } : {})
    }),
    resolveProjectRole: async ({ projectId, userId }) => {
      if (!options.pool) return null;
      const role = await userProjectRole(options.pool, { projectId, userId });
      return role === "owner" || role === "member" ? role : null;
    }
  }));

  const binaryCalibrationIdentity = (c: Context<{ Variables: AppVariables }>) => ({
    userId: c.get("user")?.id ?? null,
    projectId: c.get("projectId") ?? "",
    ...(c.get("apiKeyId") ? { apiKeyId: c.get("apiKeyId") } : {})
  });
  const resolveBinaryCalibrationRole = async ({
    projectId,
    userId
  }: {
    projectId: string;
    userId: string;
  }) => {
    if (!options.pool) return null;
    const role = await userProjectRole(options.pool, { projectId, userId });
    return role === "owner" || role === "member" ? role : null;
  };

  // Launch/list/detail remain session-only. The immutable aggregate artifact
  // and its current versioned status require an owner session as well; API
  // keys cannot remotely fetch either surface. No route is mounted for sealed
  // items or the private calibration ledger.
  app.route("/api/binary-calibration-runs", createBinaryCalibrationControlRouter({
    repository: binaryCalibrationRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole
  }));
  app.route("/api/v1/binary-calibration-artifacts", createBinaryCalibrationArtifactRouter({
    repository: binaryCalibrationRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole
  }));

  // Finite-frame analysis populations are session-only, database-backed, and
  // isolated from generic dataset revision and /api/v1 surfaces. The draw is
  // not representative evidence until later governed coding completes.
  app.route("/api/analysis-populations", createAnalysisPopulationRouter({
    repository: analysisPopulationRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole
  }));
  app.route("/api/analysis-studies", createAnalysisStudyRouter({
    repository: analysisStudyRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole
  }));
  app.route("/api/analysis-taxonomies", createAnalysisTaxonomyRouter({
    repository: analysisStudyRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole
  }));
  app.route("/api/analysis-promotions", createAnalysisPromotionRouter({
    repository: analysisPromotionRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole
  }));
  app.route("/api/evaluator-lifecycles", createEvaluatorLifecycleRouter({
    repository: evaluatorLifecycleRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole,
    enqueueRegression: options.queue ? async (input) => {
      await options.queue!.send("gate.run", {
        projectId: input.projectId,
        skillVersionId: input.skillVersionId,
        datasetRevisionId: input.datasetRevisionId,
        actorUserId: input.actorUserId,
        timeScope: "new"
      }, { retryLimit: 5, retryBackoff: true });
    } : undefined
  }));
  app.route("/api/analysis-measurements", createAnalysisMeasurementRouter({
    repository: analysisMeasurementRepository,
    databaseMode: Boolean(options.auth && options.pool),
    requestIdentity: binaryCalibrationIdentity,
    resolveProjectRole: resolveBinaryCalibrationRole
  }));

  registerProjectAdministrationRoutes(app, {
    repository,
    ...(options.pool ? { pool: options.pool } : {}),
    requestServices,
    publicApiBaseUrl
  });

  registerSkillAdministrationRoutes(app, {
    repository,
    ...(options.pool ? { pool: options.pool } : {}),
    ...(options.queue ? { queue: options.queue } : {}),
    requestServices
  });

  app.post("/api/users/invite", async (c) => {
    if (!options.pool) return c.json({ error: "Auth is not enabled" }, 400);
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const projectId = c.get("projectId");
    const role = await userProjectRole(options.pool, { userId: user.id, projectId });
    if (role !== "owner") return c.json({ error: "Only owners can invite users" }, 403);
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ email: z.string().email(), role: z.enum(["member", "owner"]).default("member") }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid invite input", details: z.treeifyError(parsed.error) }, 400);
    const invite = await createInvitation(options.pool, { email: parsed.data.email, role: parsed.data.role, invitedByUserId: user.id, projectId });
    return c.json(invite, 201);
  });

  app.post("/api/traces/manual", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ManualTraceImportInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid manual trace input", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const resolvedVersion = await resolveSkillVersionId(projectId, parsed.data.skillVersionId, {
      context: "manual_import", resourceKind: "route", resourceId: "manual-trace-import"
    });
    if ("invalid" in resolvedVersion) {
      return c.json({ error: resolvedVersion.invalid, code: "skill_version_required" },
        parsed.data.skillVersionId === undefined && resolvedVersion.invalid.includes("multiple criteria") ? 409 : 400);
    }
    try {
      await assertImportJudgingAllowed(repository, projectId, resolvedVersion.id);
    } catch (error) {
      if (error instanceof ImportSkillVersionBindingError) {
        return c.json({ error: error.message, code: "skill_version_not_runnable" }, 409);
      }
      throw error;
    }

    let imported;
    try {
      const { skillVersionId: _skillVersionId, ...trace } = parsed.data;
      imported = await repository.importTrace(projectId, "manual", trace, {
        ingestionPurpose: "analysis_eligible_manual"
      });
    } catch (error) {
      if (error instanceof RecursiveTraceSkippedError) {
        // Anti-recursion guard (PR #46): trace is tagged coeval-internal,
        // probably a Coeval-judge LLM call re-ingested by the upstream tracer.
        // Return 200 + skipped marker so the caller can distinguish from
        // success without surfacing a scary 5xx.
        return c.json({ skipped: true, reason: "coeval_internal" }, 200);
      }
      throw error;
    }
    let judging;
    try {
      judging = await scheduleImportedCaseJudging(repository, options.queue, {
        projectId,
        skillVersionId: resolvedVersion.id,
        caseIds: [imported.caseId]
      });
    } catch (error) {
      if (error instanceof ImportSkillVersionBindingError) {
        return c.json({
          ...imported,
          queued: false,
          queueJobId: null,
          error: "The Run was saved, but the selected Check changed before evaluation could start.",
          code: "skill_version_not_runnable"
        }, 409);
      }
      throw error;
    }

    if (judging.dispatchPending) {
      c.header("Retry-After", "300");
      return c.json({
        ...imported,
        queued: false,
        queueJobId: null,
        error: "The Run was saved, but its evaluation is not durably queued yet. Retry this import."
      }, 503);
    }

    return c.json({
      ...imported,
      queued: judging.scheduledCaseCount > 0,
      queueJobId: null
    }, 201);
  });

  // External-agent setup. The normal path is a project-scoped, 15-minute
  // pairing token created by a signed-in owner during onboarding. A separate
  // deployment token remains available for fully headless first-owner setup.
  // Both end by minting the project key used for every later /api/v1 call.
  app.post("/api/v1/bootstrap", async (c) => {
    c.header("cache-control", "no-store");
    if (!options.pool || !options.auth) {
      return c.json({
        error: "Agent bootstrap requires database-backed auth mode.",
        code: "bootstrap_requires_auth"
      }, 501);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = AgentBootstrapRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: "Invalid agent bootstrap input.",
        code: "invalid_bootstrap_input",
        details: z.treeifyError(parsed.error)
      }, 400);
    }

    const input = parsed.data;
    const bootstrapAuth = c.get("agentBootstrapAuth");
    if (!bootstrapAuth) {
      return c.json({ error: "Agent setup authorization was not resolved.", code: "bootstrap_unauthorized" }, 401);
    }
    const pairing = bootstrapAuth.kind === "pairing" ? bootstrapAuth.pairing : null;
    const prompt = input.skill.prompt ?? AGENT_BOOTSTRAP_PROMPT;
    const promptDiagnostics = compileJudgePrompt({
      rubricMarkdown: input.skill.rubricMarkdown,
      prompt
    }).diagnostics;
    if (promptDiagnostics.some((diagnostic) => diagnostic.code === "implicit-rubric")) {
      return c.json({
        error: "The judge prompt must reference {{rubric_markdown}}.",
        code: "rubric_not_referenced",
        field: "skill.prompt"
      }, 422);
    }
    const unknownVariables = promptDiagnostics.flatMap((diagnostic) =>
      diagnostic.code === "unknown-variable" ? [diagnostic.variable] : []
    );
    if (unknownVariables.length > 0) {
      return c.json({
        error: "The judge prompt contains unsupported template variables.",
        code: "unsupported_prompt_variables",
        field: "skill.prompt",
        variables: unknownVariables,
        supportedVariables: ["{{rubric_markdown}}"]
      }, 422);
    }

    const needsInitialOwner = pairing ? false : await setupRequired(options.pool);
    if (needsInitialOwner && !input.owner.password) {
      return c.json({
        error: "owner.password is required while creating the instance's first owner.",
        code: "owner_password_required",
        field: "owner.password"
      }, 422);
    }

    let owner: { id: string; email: string; name: string } | null = pairing
      ? { id: pairing.createdByUserId, email: pairing.ownerEmail, name: pairing.ownerName }
      : null;
    if (!pairing && !needsInitialOwner) {
      owner = await bootstrapOwnerUserByEmail(options.pool, input.owner.email);
      if (!owner) {
        return c.json({
          error: "No organization owner matches owner.email.",
          code: "owner_not_found",
          field: "owner.email"
        }, 404);
      }
    }

    const provider = input.skill.model.provider;
    // The explicit mock pin is credential-less by design — it exists so a
    // keyless instance can wiring-test the whole loop (the very hint the
    // missing-credential error gives). Everything below the credential gate
    // (catalog fetch, key storage) is skipped for it.
    const existingProjectProviderKey = pairing && provider !== "mock"
      ? await repository.getJudgeProviderCredential(pairing.projectId, provider)
      : null;
    const providerApiKey = provider === "mock"
      ? null
      : input.providerApiKey ?? existingProjectProviderKey ?? judgeProviderEnvironmentKey(provider);
    if (!providerApiKey && provider !== "mock") {
      return c.json({
        error: `No ${provider} credential is available for this bootstrap.`,
        code: "provider_key_required",
        field: "providerApiKey",
        provider
      }, 422);
    }

    let modelBinding: AgentBootstrapResponse["modelBinding"];
    if (provider === "mock") {
      // 'mock' matches the id the mock catalog exposes; the runtime dispatches
      // on provider, not modelId.
      modelBinding = {
        provider,
        modelId: input.skill.model.modelId ?? "mock",
        modelVersion: input.skill.model.modelId ?? "mock",
        temperature: input.skill.model.temperature
      };
    } else if (provider === "custom") {
      modelBinding = {
        provider,
        modelId: input.skill.model.modelId!,
        // No snapshot id exists for a custom gateway; modelVersion honestly
        // repeats the requested id (see ModelBindingSchema).
        modelVersion: input.skill.model.modelId!,
        temperature: input.skill.model.temperature,
        baseUrl: input.skill.model.baseUrl!
      };
    } else {
      let catalog;
      try {
        const catalogBaseUrl = provider === "openai" ? openAIJudgeProviderBaseUrl() : undefined;
        catalog = await fetchJudgeModelCatalog({
          provider,
          apiKey: providerApiKey!,
          ...(catalogBaseUrl ? { baseUrl: catalogBaseUrl } : {})
        });
      } catch (error) {
        if (error instanceof JudgeModelCatalogError) {
          const rejected = error.upstreamStatus === 401 || error.upstreamStatus === 403;
          return c.json({
            error: error.message,
            code: rejected ? "provider_key_rejected" : "provider_catalog_unavailable",
            provider,
            upstreamStatus: error.upstreamStatus
          }, rejected ? 422 : 502);
        }
        throw error;
      }
      const selected = input.skill.model.modelId
        ? catalog.models.find((model) => model.id === input.skill.model.modelId)
        : catalog.models[0];
      if (!selected) {
        return c.json({
          error: input.skill.model.modelId
            ? `Model ${input.skill.model.modelId} is not available from ${provider}.`
            : `${provider} returned no judge-compatible models.`,
          code: input.skill.model.modelId ? "model_not_available" : "model_catalog_empty",
          field: "skill.model.modelId",
          provider,
          availableModels: catalog.models.slice(0, 50).map((model) => ({
            id: model.id,
            version: model.version,
            label: model.label
          }))
        }, 422);
      }
      modelBinding = {
        provider,
        modelId: selected.id,
        // Catalog `version` equals the model id (providers expose no separate
        // snapshot id) — the pin records the requested model, not a dated
        // snapshot. See ModelBindingSchema / spec/skill-format-v1.md.
        modelVersion: selected.version,
        temperature: input.skill.model.temperature
      };
    }

    if (!pairing && needsInitialOwner) {
      const result = await options.auth.api.signUpEmail({
        body: {
          email: input.owner.email,
          password: input.owner.password!,
          name: input.owner.name ?? input.owner.email
        }
      }) as { user?: { id: string; email: string; name?: string } };
      if (!result.user?.id) {
        return c.json({ error: "First owner creation failed.", code: "owner_creation_failed" }, 500);
      }
      owner = {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name ?? input.owner.name ?? input.owner.email
      };
    }

    // Re-validate the empty/starter gates AT USE TIME. The pairing was minted
    // up to 15 minutes ago and the owner may have configured the project by
    // hand since; the checks at pairing creation are stale by the time the
    // agent runs, and proceeding would silently overwrite human-authored
    // judging configuration with an auto-approved agent-drafted version.
    if (pairing) {
      const pairedProject = (await repository.listProjects(pairing.createdByUserId))
        .find((candidate) => candidate.id === pairing.projectId);
      if (!pairedProject) {
        return c.json({ error: "The paired project no longer exists.", code: "project_not_found" }, 404);
      }
      if (pairedProject.importedTraceCount > 0) {
        await invalidateAgentSetupPairing(options.pool, pairing.id);
        return c.json({
          error: "The paired project already has imported cases. Finish setup in the app instead.",
          code: "project_not_empty"
        }, 409);
      }
      const pairedSkill = await repository.getLatestSkill(pairing.projectId);
      if (!pairedSkill.isStarter) {
        await invalidateAgentSetupPairing(options.pool, pairing.id);
        return c.json({
          error: "This project's judging skill was configured while the connection was outstanding. Agent setup will not overwrite it.",
          code: "project_already_configured"
        }, 409);
      }
    }

    let pairingClaimed = false;
    if (pairing) {
      pairingClaimed = await claimAgentSetupPairing(options.pool, pairing.id);
      if (!pairingClaimed) {
        return c.json({
          error: "This setup connection is already being used by another agent.",
          code: "pairing_already_claimed"
        }, 409);
      }
    }

    let projectId: string | null = pairing?.projectId ?? null;
    let createdProject = false;
    // Version/key creation is the point of no return: retrying after those
    // rows committed would stack a second active version and mint a second
    // live key that nobody ever received. Failures BEFORE it release the
    // pairing claim (the same token retries after the agent corrects its
    // input); failures AFTER consume the pairing and report partial
    // completion instead of inviting a replay.
    let irreversible = false;
    const projectName = pairing?.projectName ?? input.project.name;
    try {
      if (!pairing) {
        const created = await createProjectForUser(options.pool, {
          userId: owner!.id,
          email: owner!.email,
          name: projectName,
          mode: "bench"
        });
        projectId = created.projectId;
        createdProject = true;
      }
      if (!projectId) throw new Error("Agent setup did not resolve a project.");

      // Read-only lookups happen BEFORE any mutation so a failure here is
      // trivially retryable and the post-mutation failure window stays small.
      const project = await repository.getProjectSettings(projectId);
      const skill = await repository.getLatestSkill(projectId);
      const bootstrapRequestDigest = sha256Digest({
        check: input.check,
        skill: input.skill
      });
      const versionInput = CreateSkillVersionInputSchema.parse({
        rubricMarkdown: input.skill.rubricMarkdown,
        prompt,
        modelBinding,
        outputSchema: MinimumVerdictOutputSchema,
        verdictKind: "binary",
        timeScope: "new"
      });

      // Insert the version, optional provider credential, skill identity, and
      // pairing consumption in one transaction. For pairing setup this also
      // locks/re-checks durable starter state and the project emptiness counter.
      const pendingVersion = await repository.createSkillVersionPending(skill.id, versionInput, {
        projectId,
        actorUserId: owner!.id,
        rubricProvenance: "agent-drafted",
        onboardingCriterion: {
          name: input.check.name,
          definition: input.check.question,
          idempotencyKey: `agent-bootstrap:${pairing?.id ?? bootstrapRequestDigest}`,
          requestDigest: bootstrapRequestDigest
        },
        agentSetup: {
          ...(pairing ? { pairingId: pairing.id } : {}),
          skillName: input.skill.name ?? `${projectName} Judge`,
          skillDescription: `Agent-drafted judging skill for ${projectName}.`,
          ...(input.providerApiKey && provider !== "mock"
            ? { providerCredential: { provider, apiKey: input.providerApiKey } }
            : {})
        }
      });
      irreversible = true;
      if (!pendingVersion.regressionDatasetRevisionId) {
        throw new DatasetRevisionConflictError(
          `Skill version ${pendingVersion.id} has no immutable regression dataset binding.`,
        );
      }
      const { version } = await repository.runRegressionGateForVersion({
        projectId,
        skillVersionId: pendingVersion.id,
        datasetRevisionId: pendingVersion.regressionDatasetRevisionId,
        actorUserId: owner!.id,
        timeScope: "new"
      });
      const criterionVersion = await repository.getCriterionVersionForSkillVersion(projectId, version.id);
      if (!criterionVersion) {
        throw new DatasetRevisionConflictError("The agent-created Check has no immutable criterion binding.");
      }
      const apiKey = await repository.createApiKey({
        projectId,
        name: input.project.apiKeyName,
        createdByUserId: owner!.id
      });

      const response: AgentBootstrapResponse = {
        projectId,
        skillId: skill.id,
        skillVersionId: version.id,
        check: {
          criterionId: criterionVersion.criterionId,
          criterionVersionId: criterionVersion.id,
          name: criterionVersion.name,
          question: criterionVersion.definition,
          digest: criterionVersion.criterionDigest
        },
        mode: project.mode,
        rubricProvenance: "agent-drafted",
        modelBinding,
        apiKey,
        // The one-time key already travels in apiKey.key, so pre-filling the
        // wiring snippets adds no exposure and lets headless setups end wired.
        connect: buildAgentConnectSnippets({ apiBaseUrl: publicApiBaseUrl(c), apiKey: apiKey.key }),
        next: {
          judgeBatchPath: "/api/v1/judge/batch",
          humanReviewPath: "/exceptions",
          gateBoundary: "human-only"
        }
      };
      return c.json(response, 201);
    } catch (error) {
      // Headless bootstrap owns the newly-created project and can roll it
      // back. Pairing targets the human's existing onboarding project, which
      // must never be deleted on an agent failure; release its token so the
      // same connection can retry after a validation/provider correction.
      let projectRollback: "not-needed" | "succeeded" | "failed" = "not-needed";
      if (createdProject && projectId) {
        try {
          await repository.deleteProject(projectId, {
            confirmProjectName: projectName,
            actorUserId: owner?.id
          });
          projectRollback = "succeeded";
        } catch (cleanupError) {
          projectRollback = "failed";
          console.error(`Failed to roll back agent bootstrap project ${projectId}`, cleanupError);
        }
      }

      if (error instanceof AgentSetupEligibilityError && pairing) {
        try {
          await invalidateAgentSetupPairing(options.pool, pairing.id);
        } catch (invalidateError) {
          console.error(`Failed to invalidate changed-project pairing ${pairing.id}`, invalidateError);
        }
        return c.json({ error: error.message, code: error.code }, 409);
      }

      if (pairing && pairingClaimed) {
        if (irreversible) {
          // The version (and possibly a key) committed: consume the pairing so
          // the same token can NEVER replay setup and stack a second version
          // plus an orphan key on the human's project.
          try {
            await completeAgentSetupPairing(options.pool, pairing.id);
          } catch (consumeError) {
            console.error(`Failed to consume agent setup pairing ${pairing.id} after partial bootstrap`, consumeError);
          }
        } else {
          try {
            await releaseAgentSetupPairing(options.pool, pairing.id);
          } catch (releaseError) {
            console.error(`Failed to release agent setup pairing ${pairing.id}`, releaseError);
          }
        }
      }

      // A deployment-token bootstrap owns its new project. Once deletion
      // succeeds there is no partial state and the same token is safe to retry.
      if (projectRollback === "succeeded") irreversible = false;
      if (projectRollback === "failed") {
        console.error("Agent bootstrap rollback failed", error);
        return c.json({
          error: "Agent setup failed and its newly-created project could not be rolled back. Review the instance before retrying.",
          code: "bootstrap_partially_completed"
        }, 500);
      }
      if (irreversible) {
        console.error("Agent bootstrap failed after its point of no return", error);
        return c.json({
          error: "Agent setup partially completed: a judging version was created before the failure. Review the project in the app — this connection is now closed and cannot be retried.",
          code: "bootstrap_partially_completed"
        }, 500);
      }
      if (error instanceof RegressionGateUnavailableError) {
        return c.json({
          error: error.message,
          code: "provider_unavailable",
          provider: error.provider
        }, 422);
      }
      if (error instanceof RegressionGateJudgeError) {
        return c.json({ error: error.message, code: "provider_judge_failed" }, 502);
      }
      if (projectRollback === "succeeded") {
        console.error("Agent bootstrap failed and was fully rolled back", error);
        return c.json({
          error: "Agent setup failed, but its new project was fully rolled back. Correct the problem and retry with the same deployment token.",
          code: "bootstrap_rolled_back"
        }, 500);
      }
      throw error;
    }
  });

  // Connection check for API-key callers: which project does this key belong
  // to, and is a judging skill version active? No provider spend — costs only
  // the 1 rate-limit token every /api/v1 request pays.
  app.get("/api/v1/project", async (c) => {
    const projectId = c.get("projectId");
    const settings = await repository.getProjectSettings(projectId);
    let currentSkillVersionId: string | null;
    try {
      currentSkillVersionId = (await repository.getCurrentSkill(projectId)).currentVersion.id;
    } catch (error) {
      if (!(error instanceof NoCurrentSkillError) && !(error instanceof AmbiguousProjectSkillError)) throw error;
      currentSkillVersionId = null;
    }
    const response: V1ProjectResponse = {
      projectId: settings.projectId,
      name: settings.name,
      mode: settings.mode,
      currentSkillVersionId
    };
    return c.json(response);
  });

  // ---- Findings export + machine case/golden reads (issue #10) ----------
  // Read-only judgment intelligence for skill maintenance. Deliberately no
  // adjudicate/promote counterpart on this key-authed surface: human truth is
  // created in the dashboard by humans, or the loop becomes self-grading.
  // Cursors may carry a UTC offset, but every stored timestamp is a `…Z`
  // ISO string compared lexicographically downstream — normalize once at the
  // boundary so an offset-bearing cursor cannot silently mis-filter.
  const sinceQuerySchema = z.iso
    .datetime({ offset: true })
    .optional()
    .transform((value) => (value === undefined ? undefined : new Date(value).toISOString()));

  app.get("/api/v1/findings", async (c) => {
    const parsed = z.object({ since: sinceQuerySchema })
      .safeParse({ since: c.req.query("since") ?? undefined });
    if (!parsed.success) {
      return c.json({ error: "Invalid findings query", details: z.treeifyError(parsed.error) }, 400);
    }
    const projectId = c.get("projectId");
    try {
      const [human, adjudicated, judge, disagreements, golden, cases] = await Promise.all([
        repository.listVerdicts({ projectId, source: "human", limit: FINDINGS_VERDICT_SCAN_LIMIT }),
        repository.listVerdicts({ projectId, source: "adjudicated", limit: FINDINGS_VERDICT_SCAN_LIMIT }),
        repository.listVerdicts({ projectId, source: "llm_judge", limit: FINDINGS_VERDICT_SCAN_LIMIT }),
        repository.getJudgeHumanDisagreementSummary(projectId),
        repository.listGoldenSet(projectId),
        repository.listCases(projectId, { limit: FINDINGS_CASE_SCAN_LIMIT })
      ]);
      const response: V1FindingsResponse = buildFindings({
        generatedAt: new Date().toISOString(),
        since: parsed.data.since ?? null,
        verdicts: [...human, ...adjudicated, ...judge],
        disagreements,
        golden,
        cases
      });
      return c.json(response);
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/v1/cases", async (c) => {
    const parsed = z.object({
      verdict: z.string().min(1).optional(),
      stratum: z.string().min(1).optional(),
      since: sinceQuerySchema,
      limit: z.coerce.number().int().positive().max(V1_CASES_MAX_LIMIT).default(V1_CASES_DEFAULT_LIMIT)
    }).safeParse({
      verdict: c.req.query("verdict") ?? undefined,
      stratum: c.req.query("stratum") ?? undefined,
      since: c.req.query("since") ?? undefined,
      limit: c.req.query("limit") ?? undefined
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid cases query", details: z.treeifyError(parsed.error) }, 400);
    }
    const projectId = c.get("projectId");
    const [cases, human, adjudicated, judge] = await Promise.all([
      repository.listCases(projectId, {
        ...(parsed.data.since ? { since: parsed.data.since } : {}),
        limit: FINDINGS_CASE_SCAN_LIMIT
      }),
      repository.listVerdicts({ projectId, source: "human", limit: FINDINGS_VERDICT_SCAN_LIMIT }),
      repository.listVerdicts({ projectId, source: "adjudicated", limit: FINDINGS_VERDICT_SCAN_LIMIT }),
      repository.listVerdicts({ projectId, source: "llm_judge", limit: FINDINGS_VERDICT_SCAN_LIMIT })
    ]);
    const judgeByCase = latestDiscreteVerdictByCase(judge, ["llm_judge"]);
    const humanByCase = latestDiscreteVerdictByCase(human, ["human"]);
    const adjudicatedByCase = latestDiscreteVerdictByCase(adjudicated, ["adjudicated"]);
    const entries: V1CaseEntry[] = [];
    for (const entry of cases) {
      if (entries.length >= parsed.data.limit) break;
      const judgeVerdict = judgeByCase.get(entry.caseId) ?? null;
      // Adjudicated outranks reviewer rows — a recorded override outranks the
      // verdict it overrode (same precedence as effectiveHumanLabel).
      const humanVerdict = adjudicatedByCase.get(entry.caseId) ?? humanByCase.get(entry.caseId) ?? null;
      const effectiveLabel = humanVerdict?.label ?? judgeVerdict?.label ?? null;
      const rawStratum = entry.trace.metadata["stratum"];
      const stratum = typeof rawStratum === "string" && rawStratum !== "" ? rawStratum : null;
      if (parsed.data.verdict && effectiveLabel !== parsed.data.verdict) continue;
      if (parsed.data.stratum && stratum !== parsed.data.stratum) continue;
      entries.push({
        caseId: entry.caseId,
        sourceTraceId: entry.sourceTraceId,
        createdAt: entry.createdAt,
        stratum,
        input: entry.trace.input,
        output: entry.trace.output,
        metadata: entry.trace.metadata,
        ...(entry.trace.steps ? { steps: entry.trace.steps } : {}),
        judge: judgeVerdict,
        human: humanVerdict,
        effectiveLabel
      });
    }
    const response: V1CasesResponse = { cases: entries };
    return c.json(response);
  });

  app.get("/api/v1/golden-set", async (c) => {
    const parsed = z.object({
      since: sinceQuerySchema,
      criterionVersionId: z.string().min(1).optional()
    }).safeParse({
      since: c.req.query("since") ?? undefined,
      criterionVersionId: c.req.query("criterionVersionId") ?? undefined
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid golden-set query", details: z.treeifyError(parsed.error) }, 400);
    }
    const projectId = c.get("projectId");
    try {
      const [entries, traces] = await Promise.all([
        repository.listGoldenSet(projectId, parsed.data.criterionVersionId),
        repository.getGoldenSetTraces(projectId, parsed.data.criterionVersionId)
      ]);
      const since = parsed.data.since;
      const filtered = since ? entries.filter((entry) => entry.promotedAt > since) : entries;
      const response: V1GoldenResponse = {
        totalEntries: entries.length,
        entries: filtered.map((entry) => {
          const trace = traces.get(entry.caseId);
          return {
            ...entry,
            trace: trace
              ? { input: trace.input, output: trace.output, metadata: trace.metadata ?? {} }
              : null
          };
        })
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/v1/criteria", async (c) => {
    return c.json({ criteria: await repository.listCriteria(c.get("projectId")) });
  });

  app.post("/api/v1/criteria", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateCriterionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid criterion input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const detail = await repository.createCriterion(c.get("projectId"), parsed.data, {
        actorUserId: c.get("user")?.id
      });
      return c.json(detail, 201);
    } catch (error) {
      if (error instanceof CriterionStableKeyConflictError) {
        return c.json({ error: error.message, code: "criterion_stable_key_conflict" }, 409);
      }
      throw error;
    }
  });

  app.get("/api/v1/criteria/:criterionId", async (c) => {
    const detail = await repository.getCriterion(c.get("projectId"), c.req.param("criterionId"));
    return detail ? c.json(detail) : c.json({ error: "Criterion not found" }, 404);
  });

  app.post("/api/v1/criteria/:criterionId/versions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateCriterionVersionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid criterion version input", details: z.treeifyError(parsed.error) }, 400);
    }
    const version = await repository.createCriterionVersion(
      c.get("projectId"),
      c.req.param("criterionId"),
      parsed.data,
      { actorUserId: c.get("user")?.id }
    );
    return version ? c.json({ version }, 201) : c.json({ error: "Criterion not found" }, 404);
  });

  app.get("/api/v1/criteria/:criterionId/current-skill", async (c) => {
    try {
      const skill = c.req.query("scope") === "latest"
        ? await repository.getLatestSkillForCriterion(c.get("projectId"), c.req.param("criterionId"))
        : await repository.getCurrentSkillForCriterion(c.get("projectId"), c.req.param("criterionId"));
      return c.json({ skill });
    } catch (error) {
      if (error instanceof NoCurrentSkillError) {
        return c.json({ error: "No evaluator exists for this criterion" }, 404);
      }
      throw error;
    }
  });

  app.get("/api/v1/evaluator-suites", async (c) => {
    return c.json({ suites: await repository.listEvaluatorSuites(c.get("projectId")) });
  });

  app.get("/api/v1/evaluator-suites/:suiteId", async (c) => {
    const projectId = c.get("projectId");
    const suiteId = c.req.param("suiteId");
    const suite = await repository.getEvaluatorSuite(projectId, suiteId);
    if (!suite) return c.json({ error: "Evaluator suite not found" }, 404);
    return c.json({
      suite,
      manifests: await repository.listEvaluatorSuiteManifests(projectId, suiteId)
    });
  });

  app.get("/api/v1/evaluator-suite-manifests", async (c) => {
    const suiteId = c.req.query("suiteId");
    if (suiteId !== undefined && suiteId.length === 0) {
      return c.json({ error: "suiteId must not be empty" }, 400);
    }
    return c.json({
      manifests: await repository.listEvaluatorSuiteManifests(c.get("projectId"), suiteId)
    });
  });

  app.post("/api/v1/evaluator-suite-manifests", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateEvaluatorSuiteManifestInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid evaluator suite manifest input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const manifest = await repository.createEvaluatorSuiteManifest(c.get("projectId"), parsed.data, {
        actorUserId: c.get("user")?.id
      });
      return c.body(canonicalEvaluatorSuiteManifestBytes(manifest).toString("utf8"), 201, {
        "content-type": "application/json; charset=UTF-8"
      });
    } catch (error) {
      if (error instanceof EvaluatorSuiteIdempotencyConflictError) {
        return c.json({ error: error.message, code: "evaluator_suite_idempotency_conflict" }, 409);
      }
      if (error instanceof EvaluatorSuiteBindingError) {
        return c.json({ error: error.message, code: "invalid_evaluator_suite_binding" }, 409);
      }
      throw error;
    }
  });

  app.get("/api/v1/evaluator-suite-manifests/:manifestId", async (c) => {
    const manifest = await repository.getEvaluatorSuiteManifest(
      c.get("projectId"),
      c.req.param("manifestId")
    );
    return manifest
      ? c.body(canonicalEvaluatorSuiteManifestBytes(manifest).toString("utf8"), 200, {
          "content-type": "application/json; charset=UTF-8"
        })
      : c.json({ error: "Evaluator suite manifest not found" }, 404);
  });

  // Eval-as-a-service: judge a trace synchronously and return the verdict. The
  // call is governed exactly like the async pipeline — it normalizes the trace
  // into a case, runs the project's pinned skill version, and records a
  // source=llm_judge verdict (so κ / convergence / self-consistency see it too).
  app.post("/api/v1/judge", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = JudgeServiceRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid judge request", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const resolvedVersion = await resolveSkillVersionId(projectId, parsed.data.skillVersionId, {
      context: "implicit_production", resourceKind: "route", resourceId: "judge-service"
    });
    if ("invalid" in resolvedVersion) return c.json({ error: resolvedVersion.invalid }, 400);
    const skillVersionId = resolvedVersion.id;

    let imported;
    try {
      imported = await repository.importTrace(projectId, "manual", parsed.data.trace, {
        ingestionPurpose: "judge_api"
      });
    } catch (error) {
      if (error instanceof RecursiveTraceSkippedError) {
        return c.json({ skipped: true, reason: "coeval_internal" }, 200);
      }
      throw error;
    }

    // Idempotent by default: a re-POSTed trace (same sourceTraceId — client
    // retry, CI re-run) returns the verdict already on record instead of
    // burning provider tokens and appending a duplicate llm_judge verdict.
    // `force: true` bypasses — intentional repeats (self-consistency probes)
    // still work.
    if (!imported.created && !parsed.data.force) {
      const existing = await repository.listVerdicts({
        projectId,
        caseId: imported.caseId,
        source: "llm_judge",
        skillVersionId,
        limit: 1
      });
      if (existing[0]) {
        return c.json({
          caseId: imported.caseId,
          skillVersionId,
          verdict: existing[0].payload,
          cached: true
        }, 200);
      }
    }

    // Bound the provider call so a hung upstream can't pin the connection.
    // The timer is cleared on settle; losing the race returns 504 and leaves
    // the (eventual) provider result to land in the ledger when it finishes.
    // PG mode judges strictly: a non-mock binding with no credentials refuses
    // (503) instead of silently recording mock verdicts. Demo mode keeps the
    // permissive fallback — it exists to work without secrets.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("judge-timeout");
    let result;
    try {
      result = await Promise.race([
        judgeAndRecord(
          repository,
          { projectId, caseId: imported.caseId, skillVersionId },
          ...(options.pool ? [createStrictJudgeProvider] as const : [])
        ),
        new Promise<typeof timedOut>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timedOut), JUDGE_TIMEOUT_MS);
        })
      ]).finally(() => clearTimeout(timeoutHandle));
    } catch (error) {
      if (error instanceof JudgeProviderUnavailableError) {
        return c.json({
          error: error.message,
          unavailableProvider: error.provider,
          availableProviders: (await listJudgeProviders(c.get("projectId"))).filter((p) => p.available).map((p) => p.provider)
        }, 503);
      }
      // the provider rejected the credential — with a BYO project key
      // this is the LOUD failure the contract requires (never a silent env
      // fallback, never an anonymous 500).
      if (isJudgeAuthError(error)) {
        return c.json({
          error: `Judge provider rejected the project's API key: ${error instanceof Error ? error.message.slice(0, 300) : "authentication error"}`
        }, 502);
      }
      throw error;
    }
    if (result === timedOut) {
      return c.json({ error: `Judge did not complete within ${JUDGE_TIMEOUT_MS}ms.` }, 504);
    }

    return c.json({
      caseId: imported.caseId,
      skillVersionId,
      verdict: result.payload
    }, 201);
  });

  // Batch judging: fire-and-poll. Imports every trace, reuses recorded
  // verdicts where possible (same idempotency as the single endpoint), creates
  // an eval run, and fans the pending remainder out through the queue. Nothing
  // here waits on a provider, so there is no timeout problem — poll the run.
  app.post("/api/v1/judge/batch", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = JudgeBatchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid batch judge request", details: z.treeifyError(parsed.error) }, 400);
    }
    if (parsed.data.items.length > JUDGE_BATCH_MAX_ITEMS) {
      return c.json({ error: `Batch exceeds ${JUDGE_BATCH_MAX_ITEMS} items.` }, 400);
    }
    if (parsed.data.purpose === "release_evidence" && parsed.data.datasetId) {
      return c.json({ error: "release_evidence batches cannot be added to a dataset." }, 400);
    }

    const projectId = c.get("projectId");
    const resolvedVersion = await resolveSkillVersionId(projectId, parsed.data.skillVersionId, {
      context: parsed.data.purpose === "release_evidence" ? "release_gate" : "manual_import",
      resourceKind: "route",
      resourceId: `judge-batch:${parsed.data.purpose}`
    });
    if ("invalid" in resolvedVersion) return c.json({ error: resolvedVersion.invalid }, 400);
    const skillVersionId = resolvedVersion.id;

    if (parsed.data.datasetId) {
      const dataset = await repository.getDatasetDetail(projectId, parsed.data.datasetId);
      if (!dataset || dataset.archivedAt) return c.json({ error: "Dataset not found" }, 404);
    }

    // Import every trace; classify each as cached (verdict already recorded
    // for this skill version), pending (needs a provider call), or skipped
    // (anti-recursion guard). Within-batch repeats of the same trace collapse
    // onto one case.
    let skippedItems = 0;
    type BatchEntry = {
      caseId: string;
      clientItemId?: string;
      contentDigest?: string;
      verdictId?: string;
      resultLabel?: string;
      failingStep?: number;
      expectedLabel?: "pass" | "fail";
      expectedFailStep?: number;
    };
    const byCase = new Map<string, BatchEntry>();
    const releaseEntries: BatchEntry[] = [];
    for (const item of parsed.data.items) {
      const { expectedLabel, expectedFailStep, clientItemId, ...trace } = item;
      // Digest the caller's exact parsed input/output before import-time
      // normalization or redaction. A release layer can therefore verify the
      // receipt against what it actually submitted.
      const submittedDigest = parsed.data.purpose === "release_evidence"
        ? contentDigest(trace.input, trace.output)
        : undefined;
      let imported;
      try {
        imported = parsed.data.purpose === "release_evidence"
          ? await repository.importTrace(projectId, "release_evidence", {
              ...trace,
              // Client identity participates so two submitted items with the
              // same content stay independently addressable in one receipt.
              sourceTraceId: `release_${sha256Digest({ clientItemId, contentDigest: submittedDigest }).slice(7, 39)}`
            }, { ingestionPurpose: "release_evidence" })
          : await repository.importTrace(projectId, "manual", trace, {
              ingestionPurpose: "judge_batch_general"
            });
      } catch (error) {
        if (error instanceof RecursiveTraceSkippedError) {
          if (parsed.data.purpose === "release_evidence") {
            return c.json({ error: "release_evidence items cannot contain Coeval internal trace metadata." }, 400);
          }
          skippedItems += 1;
          continue;
        }
        throw error;
      }
      // Within-batch repeats collapse onto one case; the last LABELED
      // occurrence wins (a label-less duplicate never erases a label —
      // mirrors the examples route + the storage upsert). M1 E1.
      const prior = parsed.data.purpose === "general" ? byCase.get(imported.caseId) : undefined;
      if (prior) {
        if (expectedLabel) {
          prior.expectedLabel = expectedLabel;
          // Locked M2 invariant, mirrored in the storage upsert: a re-label
          // to pass clears the step expectation (zod already forbids a step
          // alongside pass in the SAME item).
          if (expectedLabel === "pass") delete prior.expectedFailStep;
        }
        if (expectedFailStep !== undefined) prior.expectedFailStep = expectedFailStep;
        continue;
      }
      const entry: BatchEntry = {
        caseId: imported.caseId,
        ...(parsed.data.purpose === "release_evidence" && clientItemId ? { clientItemId } : {}),
        ...(submittedDigest ? { contentDigest: submittedDigest } : {}),
        ...(expectedLabel ? { expectedLabel } : {}),
        ...(expectedFailStep !== undefined ? { expectedFailStep } : {})
      };
      if (!imported.created) {
        const existing = await repository.listVerdicts({
          projectId,
          caseId: imported.caseId,
          source: "llm_judge",
          skillVersionId,
          limit: 1
        });
        if (existing[0]) {
          entry.verdictId = existing[0].id;
          entry.resultLabel = verdictLabelFromPayload(existing[0].payload);
          // a cached item reports the recorded verdict's failingStep,
          // same as a fresh one would.
          if ("failingStep" in existing[0].payload && existing[0].payload.failingStep !== undefined) {
            entry.failingStep = existing[0].payload.failingStep;
          }
        }
      }
      if (parsed.data.purpose === "release_evidence") releaseEntries.push(entry);
      else byCase.set(imported.caseId, entry);
    }

    const entries = parsed.data.purpose === "release_evidence" ? releaseEntries : [...byCase.values()];
    const pendingCount = entries.filter((entry) => !entry.verdictId).length;
    // The middleware already charged 1 token for the request; each judged item
    // beyond the first costs one more. Cached items are free — no provider spend.
    const extraTokens = Math.max(0, pendingCount - 1);
    if (extraTokens > 0 && !takeRateTokens(c.get("apiKeyId")!, extraTokens)) {
      return c.json({
        error: `Rate limit exceeded: this batch needs ${pendingCount} judge calls; ${JUDGE_RATE_LIMIT_PER_MINUTE} tokens/minute per API key.`
      }, 429);
    }

    if (parsed.data.datasetId && entries.length > 0) {
      try {
        await repository.addDatasetItems({
          projectId,
          datasetId: parsed.data.datasetId,
          items: entries.map((entry) => ({
            caseId: entry.caseId,
            ...(entry.expectedLabel ? { expectedLabel: entry.expectedLabel } : {}),
            ...(entry.expectedFailStep !== undefined ? { expectedFailStep: entry.expectedFailStep } : {})
          }))
        });
      } catch (error) {
        // The dataset was checked above but can be archived (or a case pruned)
        // while the import loop ran — answer like the sibling dataset route
        // instead of surfacing a 500.
        if (error instanceof DatasetNotFoundError) return c.json({ error: error.message }, 404);
        if (error instanceof CaseNotFoundError) return c.json({ error: error.message }, 400);
        throw error;
      }
    }

    const run = await repository.createEvalRun({
      projectId,
      skillVersionId,
      trigger: parsed.data.purpose === "release_evidence" ? "release_evidence" : "api_batch",
      ...(parsed.data.datasetId ? { datasetId: parsed.data.datasetId } : {}),
      items: entries.map((entry) => entry.verdictId
        ? {
            caseId: entry.caseId,
            status: "completed" as const,
            verdictId: entry.verdictId,
            resultLabel: entry.resultLabel,
            cached: true,
            ...(entry.clientItemId ? { clientItemId: entry.clientItemId } : {}),
            ...(entry.contentDigest ? { contentDigest: entry.contentDigest } : {}),
            ...(entry.failingStep !== undefined ? { failingStep: entry.failingStep } : {}),
            ...(entry.expectedLabel ? { expectedLabel: entry.expectedLabel } : {}),
            ...(entry.expectedFailStep !== undefined ? { expectedFailStep: entry.expectedFailStep } : {})
          }
        : {
            caseId: entry.caseId,
            ...(entry.clientItemId ? { clientItemId: entry.clientItemId } : {}),
            ...(entry.contentDigest ? { contentDigest: entry.contentDigest } : {}),
            ...(entry.expectedLabel ? { expectedLabel: entry.expectedLabel } : {}),
            ...(entry.expectedFailStep !== undefined ? { expectedFailStep: entry.expectedFailStep } : {})
          })
    });

    // A fully cached batch is already terminal and must not fan out. Every
    // nonterminal run goes through the same recovery-before-send boundary as
    // session evals, comparisons, trace tests, and future extracted routers.
    const current = run.status === "completed"
      ? (await repository.getEvalRun(projectId, run.id)) ?? run
      : await dispatchEvalRun(projectId, run);

    return c.json({
      evalRunId: run.id,
      status: current.status,
      totalItems: current.totalItems,
      cachedItems: run.items.filter((item) => item.cached).length,
      skippedItems,
      pollUrl: `/api/v1/eval-runs/${run.id}`
    }, 202);
  });

  app.get("/api/v1/eval-runs/:evalRunId/assessment-receipt", async (c) => {
    const projectId = c.get("projectId");
    const evalRunId = c.req.param("evalRunId");
    try {
      const artifact = await repository.getOrFreezeAssessmentReceipt(projectId, evalRunId);
      if (!artifact) return c.json({ error: "Eval run not found" }, 404);
      const lineage = await repository.listAssessmentReceiptArtifacts(projectId, evalRunId);
      const successor = lineage.at(-1);
      if (successor && successor.artifactRevision > 1) {
        c.header(
          "Link",
          `</api/v1/assessment-receipts/${encodeURIComponent(successor.receiptId)}>; rel="successor-version"`
        );
      }
      c.header("content-type", "application/json; charset=utf-8");
      c.header("x-coeval-receipt-artifact-digest", artifact.artifactDigest);
      return c.body(artifact.canonicalBytes.toString("utf8"));
    } catch (error) {
      if (error instanceof AssessmentReceiptUnavailableError) {
        return c.json({ error: error.message, reason: error.reason }, 409);
      }
      throw error;
    }
  });

  app.get("/api/v1/assessment-receipts/:receiptId", async (c) => {
    const artifact = await repository.getAssessmentReceiptArtifactByReceiptId(
      c.get("projectId"),
      c.req.param("receiptId")
    );
    if (!artifact) return c.json({ error: "Assessment receipt not found" }, 404);
    c.header("content-type", "application/json; charset=utf-8");
    c.header("x-coeval-receipt-artifact-digest", artifact.artifactDigest);
    return c.body(artifact.canonicalBytes.toString("utf8"));
  });

  app.post("/api/v1/eval-runs/:evalRunId/assessment-receipt/comparisons", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ReceiptComparisonInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid assessment receipt comparison" }, 400);
    const consumerCanonicalBytes = decodeExactBase64(parsed.data.consumerReceiptBase64);
    if (!consumerCanonicalBytes) return c.json({ error: "consumerReceiptBase64 is not canonical base64" }, 400);
    try {
      const comparison = await repository.compareAssessmentReceiptCopy({
        projectId: c.get("projectId"),
        evalRunId: c.req.param("evalRunId"),
        consumerCanonicalBytes
      });
      return c.json({
        comparisonId: comparison.id,
        artifactId: comparison.artifactId,
        consumerReceiptId: comparison.consumerReceiptId,
        consumerArtifactDigest: comparison.consumerArtifactDigest,
        comparisonStatus: comparison.comparisonStatus
      }, 201);
    } catch (error) {
      if (error instanceof AssessmentReceiptIntegrityError) return c.json({ error: error.message }, 400);
      if (error instanceof AssessmentReceiptUnavailableError) {
        return c.json({ error: error.message, reason: error.reason }, 409);
      }
      throw error;
    }
  });

  app.get("/api/v1/eval-runs/:evalRunId", async (c) => {
    const detail = await repository.getEvalRunDetail(c.get("projectId"), c.req.param("evalRunId"));
    if (!detail) return c.json({ error: "Eval run not found" }, 404);
    return c.json(detail);
  });

  // Product-release writes are gone: Coeval emits policy-free release
  // evidence, while the release layer owns ship/hold thresholds. Historical
  // gate rows remain readable below for audit and migration purposes.
  app.post("/api/v1/gate-checks", async (c) => {
    c.header("Deprecation", "true");
    c.header("Warning", '299 - "Removed: submit purpose=release_evidence and consume an assessment receipt in the release layer."');
    return c.json({
      error: "Product gate creation has moved to the release layer.",
      code: "product_gate_writes_removed",
      migration: "Submit /api/v1/judge/batch with purpose=release_evidence, then apply release policy outside Coeval."
    }, 410);
  });

  app.get("/api/v1/gate-checks/:gateCheckId", async (c) => {
    c.header("Deprecation", "true");
    c.header("Warning", '299 - "Deprecated: submit purpose=release_evidence and consume an assessment receipt in the release layer."');
    const detail = await repository.getGateCheckDetail(c.get("projectId"), c.req.param("gateCheckId"));
    if (!detail) return c.json({ error: "Gate check not found" }, 404);
    return c.json(detail);
  });

  // BYO judge provider keys. The raw key is accepted once and never
  // returned; list responses carry only the masked display form.
  app.get("/api/judge-keys", async (c) => {
    return c.json({ keys: await repository.listJudgeProviderKeys(c.get("projectId")) });
  });

  app.put("/api/judge-keys/:provider", async (c) => {
    const denied = await requireOwner(c, "manage judge provider keys");
    if (denied) return denied;
    const provider = JudgeKeyProviderSchema.safeParse(c.req.param("provider"));
    if (!provider.success) return c.json({ error: "Provider must be anthropic, openai, openrouter, or custom" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = SetJudgeProviderKeyInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid judge key input", details: z.treeifyError(parsed.error) }, 400);
    }
    const key = await repository.setJudgeProviderKey(
      c.get("projectId"),
      provider.data,
      parsed.data.apiKey,
      c.get("user")?.id
    );
    return c.json({ key }, 201);
  });

  app.delete("/api/judge-keys/:provider", async (c) => {
    const denied = await requireOwner(c, "manage judge provider keys");
    if (denied) return denied;
    const provider = JudgeKeyProviderSchema.safeParse(c.req.param("provider"));
    if (!provider.success) return c.json({ error: "Provider must be anthropic, openai, openrouter, or custom" }, 400);
    const removed = await repository.deleteJudgeProviderKey(c.get("projectId"), provider.data, c.get("user")?.id);
    if (!removed) return c.json({ error: "No stored key for that provider" }, 404);
    return c.json({ removed: true });
  });

  app.get("/api/api-keys", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can view API keys" }, 403);
    }
    return c.json({ apiKeys: await repository.listApiKeys(c.get("projectId")) });
  });

  app.post("/api/api-keys", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can mint API keys" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = CreateApiKeyInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid API key input", details: z.treeifyError(parsed.error) }, 400);
    }
    const created = await repository.createApiKey({
      projectId: c.get("projectId"),
      name: parsed.data.name,
      createdByUserId: c.get("user")?.id
    });
    // The plaintext `key` is returned exactly once here; it is never retrievable again.
    return c.json(created, 201);
  });

  app.delete("/api/api-keys/:apiKeyId", async (c) => {
    if (options.auth && options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can revoke API keys" }, 403);
    }
    const revoked = await repository.revokeApiKey(c.get("projectId"), c.req.param("apiKeyId"));
    if (!revoked) return c.json({ error: "API key not found" }, 404);
    return c.json({ ok: true });
  });

  registerTraceTestAdministrationRoutes(app, {
    repository,
    requestServices,
    ...(options.pool ? { pool: options.pool } : {}),
    ...(options.traceTestDraftGenerator ? { traceTestDraftGenerator: options.traceTestDraftGenerator } : {}),
    ...(options.traceTestValidationRunner ? { traceTestValidationRunner: options.traceTestValidationRunner } : {}),
    judgeRateLimitPerMinute: JUDGE_RATE_LIMIT_PER_MINUTE,
    draftTimeoutMs: TRACE_TEST_DRAFT_TIMEOUT_MS,
    validationTimeoutMs: TRACE_TEST_VALIDATION_TIMEOUT_MS
  });

  registerDatasetAdministrationRoutes(app, { repository, requestServices });

  registerEvaluationAdministrationRoutes(app, {
    repository,
    requestServices,
    ...(options.queue ? { queue: options.queue } : {})
  });

  // Session-authed read side of the product deploy gate (submission is the
  // API-keyed /api/v1/gate-checks — CI owns writes; the app reads history).
  app.get("/api/gate-checks", async (c) => {
    const parsed = z.object({ limit: z.coerce.number().int().positive().max(100).default(50) })
      .safeParse({ limit: c.req.query("limit") ?? undefined });
    if (!parsed.success) {
      return c.json({ error: "Invalid gate check query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({ gateChecks: await repository.listGateChecks(c.get("projectId"), { limit: parsed.data.limit }) });
  });

  app.get("/api/gate-checks/:gateCheckId", async (c) => {
    const detail = await repository.getGateCheckDetail(c.get("projectId"), c.req.param("gateCheckId"));
    if (!detail) return c.json({ error: "Gate check not found" }, 404);
    return c.json(detail);
  });

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

  // The canonical case-detail endpoint: resolves any judged case to its trace
  // + latest verdict. Exceptions are just non-pass cases viewed here too — the
  // legacy exceptions-only GET collapsed into this one.
  app.get("/api/cases/:caseId", async (c) => {
    markUngovernedLegacy(c);
    const projectId = c.get("projectId");
    const caseId = c.req.param("caseId");
    const query = z.object({ skillVersionId: z.string().min(1).optional() }).strict().safeParse({
      skillVersionId: c.req.query("skillVersionId") ?? undefined
    });
    if (!query.success) {
      return c.json({ error: "Invalid case-detail query", details: z.treeifyError(query.error) }, 400);
    }
    let detail;
    try {
      detail = await repository.getCaseDetail(projectId, caseId, query.data.skillVersionId);
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      throw error;
    }
    if (!detail) return c.json({ error: "Case not found" }, 404);
    if (options.pool) {
      await options.pool.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          `audit_${randomUUID()}`,
          projectId,
          c.get("user")?.id ?? null,
          "case.view",
          "case",
          caseId,
          JSON.stringify({ traceId: detail.trace.id })
        ]
      );
    }
    return c.json(detail);
  });

  app.post("/api/cases/:caseId/promote", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can promote golden-set cases" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = PromoteGoldenSetInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid golden-set promotion input", details: z.treeifyError(parsed.error) }, 400);
    }
    const user = c.get("user");
    try {
      const entry = await repository.promoteExceptionToGoldenSet({
        projectId: c.get("projectId"),
        caseId: c.req.param("caseId"),
        actorUserId: user?.id,
        actorName: user?.name ?? user?.email ?? undefined,
        ...parsed.data
      });
      return c.json({ entry }, 201);
    } catch (error) {
      if (error instanceof CaseNotFoundError) return c.json({ error: error.message }, 404);
      if (error instanceof GoldenSetLabelConflictError) return c.json({ error: error.message }, 409);
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      throw error;
    }
  });

  app.post("/api/cases/:caseId/verdicts", async (c) => {
    markUngovernedLegacy(c);
    // Any authenticated user with project access can record a human verdict.
    // Verdict rows are append-only (PR #39); a reviewer who wants to "correct"
    // their verdict records a new row — historical disagreements are preserved
    // and contribute to κ history (PR #42).
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (!role) return c.json({ error: "No project access" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = z.object({
      payload: VerdictPayloadSchema,
      skillVersionId: z.string().min(1).optional()
    }).strict().safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid verdict input", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const caseId = c.req.param("caseId");
    if (!(await repository.caseExistsForProject(projectId, caseId))) {
      return c.json({ error: "Case not found in this project" }, 404);
    }

    try {
      const user = c.get("user");
      const verdict = await repository.recordVerdict({
        projectId,
        caseId,
        source: "human",
        payload: parsed.data.payload,
        skillVersionId: parsed.data.skillVersionId,
        actorUserId: user?.id
      });
      return c.json({
        verdict: {
          ...verdict,
          actorName: verdict.actorName ?? user?.name ?? user?.email ?? null
        }
      }, 201);
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        return c.json({ error: "Case not found in this project" }, 404);
      }
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      throw error;
    }
  });

  app.post("/api/cases/:caseId/adjudicate", async (c) => {
    markUngovernedLegacy(c);
    // Record the owner's ruling for a disagreed legacy case. This remains
    // ungoverned legacy evidence, but it is owner-only (matching golden-set promotion),
    // unlike a plain human verdict which any reviewer may record. Append-only:
    // re-adjudicating records a new row and latest-wins (see kappa.ts).
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can adjudicate cases" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = z.object({
      payload: VerdictPayloadSchema,
      skillVersionId: z.string().min(1).optional()
    }).strict().safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid adjudication input", details: z.treeifyError(parsed.error) }, 400);
    }
    // An adjudication resolves a DISCRETE disagreement (pass/fail/categorical).
    // A scalar payload can't — it would persist yet leave the case unresolved in
    // the feeds (adjudicatedLabel stays null). Reject it loudly instead of
    // returning a silent-success no-op.
    if (parsed.data.payload.kind === "scalar") {
      return c.json({ error: "Adjudication must be a discrete label (binary or categorical), not scalar" }, 400);
    }

    const projectId = c.get("projectId");
    const caseId = c.req.param("caseId");
    if (!(await repository.caseExistsForProject(projectId, caseId))) {
      return c.json({ error: "Case not found in this project" }, 404);
    }

    try {
      const user = c.get("user");
      const verdict = await repository.recordVerdict({
        projectId,
        caseId,
        source: "adjudicated",
        payload: parsed.data.payload,
        skillVersionId: parsed.data.skillVersionId,
        actorUserId: user?.id
      });
      return c.json({
        verdict: {
          ...verdict,
          actorName: verdict.actorName ?? user?.name ?? user?.email ?? null
        }
      }, 201);
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        return c.json({ error: "Case not found in this project" }, 404);
      }
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      throw error;
    }
  });

  app.get("/api/cases/:caseId/verdicts", async (c) => {
    markUngovernedLegacy(c);
    const projectId = c.get("projectId");
    const caseId = c.req.param("caseId");
    if (!(await repository.caseExistsForProject(projectId, caseId))) {
      return c.json({ error: "Case not found in this project" }, 404);
    }
    const parsed = z
      .object({
        source: VerdictSourceSchema.optional(),
        skillVersionId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).default(50)
      })
      .safeParse({
        source: c.req.query("source") ?? undefined,
        skillVersionId: c.req.query("skillVersionId") ?? undefined,
        limit: c.req.query("limit") ?? undefined
      });
    if (!parsed.success) {
      return c.json({ error: "Invalid verdict query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({
      verdicts: await repository.listVerdicts({
        projectId,
        caseId,
        source: parsed.data.source,
        skillVersionId: parsed.data.skillVersionId,
        limit: parsed.data.limit
      })
    });
  });

  app.get("/api/golden-set", async (c) => {
    const criterionVersionId = c.req.query("criterionVersionId") || undefined;
    try {
      return c.json({
        entries: await repository.listGoldenSet(c.get("projectId"), criterionVersionId)
      });
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  // the trust digest — four recorded-evidence signals + drift nudges
  // for the CURRENT skill version. A surface, not a sender (locked shape).
  app.get("/api/trust-digest", async (c) => {
    const projectId = c.get("projectId");
    const requestedSkillVersionId = c.req.query("skillVersionId") || undefined;
    let version;
    try {
      if (requestedSkillVersionId) {
        version = await repository.getSkillVersion(projectId, requestedSkillVersionId);
        if (!version) return c.json({ error: "Skill version not found" }, 404);
      } else {
        version = (await repository.getCurrentSkill(projectId)).currentVersion;
      }
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof NoCurrentSkillError) return c.json({ error: "No skill found for project" }, 404);
      throw error;
    }
    const criterionVersion = await repository.getCriterionVersionForSkillVersion(projectId, version.id);
    if (!criterionVersion) return c.json({ error: "Evaluator criterion binding not found" }, 409);

    const [goldenSetHealth, calibration, selfConsistency, runs] = await Promise.all([
      repository.getGoldenSetHealth(projectId, criterionVersion.id),
      repository.getProjectJudgeHumanCalibration(projectId, criterionVersion.id, version.id),
      repository.getSelfConsistencyReport(projectId, version.id),
      repository.listEvalRuns(projectId, {
        limit: SPEND_WINDOW_RUNS,
        skillVersionId: version.id
      })
    ]);

    // Spend over the last N runs: sum the per-run summaries; token sums stay
    // null until at least one run reported usage (never zero-as-unknown).
    let freshItems = 0;
    let cachedItems = 0;
    let usageMissingCount = 0;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    for (const run of runs) {
      const detail = await repository.getEvalRunDetail(projectId, run.id);
      if (!detail) continue;
      freshItems += detail.spend.freshItems;
      cachedItems += detail.spend.cachedItems;
      usageMissingCount += detail.spend.usageMissingCount;
      if (detail.spend.inputTokens !== null) inputTokens = (inputTokens ?? 0) + detail.spend.inputTokens;
      if (detail.spend.outputTokens !== null) outputTokens = (outputTokens ?? 0) + detail.spend.outputTokens;
    }

    return c.json(buildTrustDigest({
      generatedAt: new Date().toISOString(),
      version,
      goldenSetHealth,
      calibration,
      selfConsistency,
      spend: {
        windowRuns: SPEND_WINDOW_RUNS,
        runsCounted: runs.length,
        freshItems,
        cachedItems,
        inputTokens,
        outputTokens,
        usageMissingCount
      }
    }));
  });

  app.get("/api/golden-set/health", async (c) => {
    const criterionVersionId = c.req.query("criterionVersionId") || undefined;
    try {
      return c.json(await repository.getGoldenSetHealth(c.get("projectId"), criterionVersionId));
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/projects/kappa", async (c) => {
    markUngovernedLegacy(c);
    // Inter-rater agreement (Cohen's κ) over this project's human verdicts.
    // Math lives in apps/api/src/lib/kappa.ts.
    try {
      return c.json(await repository.getProjectKappaSummary(
        c.get("projectId"),
        c.req.query("criterionVersionId") || undefined
      ));
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/projects/judge-human-calibration", async (c) => {
    markUngovernedLegacy(c);
    // LLM judge ↔ human reviewer calibration, same κ shape as the
    // inter-rater endpoint. The judge appears as a synthetic reviewer keyed
    // by `judge:<skillVersionId>` so per-version calibration history is
    // preserved.
    try {
      return c.json(await repository.getProjectJudgeHumanCalibration(
        c.get("projectId"),
        c.req.query("criterionVersionId") || undefined
      ));
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/projects/disagreements", async (c) => {
    markUngovernedLegacy(c);
    // human-human disagreement — the per-case breakdown behind the κ
    // number, ranked by split severity. High-confidence SECONDARY feed of the
    // convergence loop (needs reviewer overlap).
    try {
      return c.json(await repository.getDisagreementSummary(
        c.get("projectId"),
        c.req.query("criterionVersionId") || undefined
      ));
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/projects/judge-human-disagreements", async (c) => {
    markUngovernedLegacy(c);
    // A2.2 PRIMARY feed: cases where the LLM judge and human reviewers disagree.
    // Non-empty under single-reviewer exception triage, so it's the cold-start-
    // proof entry point to the convergence loop.
    try {
      return c.json(await repository.getJudgeHumanDisagreementSummary(
        c.get("projectId"),
        c.req.query("criterionVersionId") || undefined
      ));
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/projects/verdicts", async (c) => {
    markUngovernedLegacy(c);
    // project-scope verdict listing. Same filters as the per-case
    // endpoint (PR #43) but unscoped to one case so the dashboard can render
    // recent verdict activity across the whole project.
    const parsed = z
      .object({
        source: VerdictSourceSchema.optional(),
        caseId: z.string().min(1).optional(),
        skillVersionId: z.string().min(1).optional(),
        criterionId: z.string().min(1).optional(),
        evidenceScope: z.enum(["all", "customer"]).default("all"),
        limit: z.coerce.number().int().positive().max(VERDICT_LIST_MAX_LIMIT).default(20)
      })
      .safeParse({
        source: c.req.query("source") ?? undefined,
        caseId: c.req.query("caseId") ?? undefined,
        skillVersionId: c.req.query("skillVersionId") ?? undefined,
        criterionId: c.req.query("criterionId") ?? undefined,
        evidenceScope: c.req.query("evidenceScope") ?? undefined,
        limit: c.req.query("limit") ?? undefined
      });
    if (!parsed.success) {
      return c.json({ error: "Invalid verdicts query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({
      verdicts: await repository.listVerdicts({
        projectId: c.get("projectId"),
        ...(parsed.data.caseId ? { caseId: parsed.data.caseId } : {}),
        ...(parsed.data.source ? { source: parsed.data.source } : {}),
        ...(parsed.data.skillVersionId ? { skillVersionId: parsed.data.skillVersionId } : {}),
        ...(parsed.data.criterionId ? { criterionId: parsed.data.criterionId } : {}),
        evidenceScope: parsed.data.evidenceScope,
        limit: parsed.data.limit
      })
    });
  });

  app.get("/api/projects/verdicts/export", async (c) => {
    markUngovernedLegacy(c);
    // project-scope verdict export. Operators get a downloadable copy
    // for offline analysis (κ replays, training data extraction, audits).
    // Supported formats: jsonl (default, faithful to VerdictRecord shape) and
    // csv (flattened — payload becomes verdict_kind + verdict_value columns).
    // Capped at 100k rows; that's an explicit ceiling on memory/response
    // size, not paginated yet. Larger projects can filter by case/source/
    // skill version to slice.
    const parsed = z
      .object({
        format: z.enum(["jsonl", "csv"]).default("jsonl"),
        source: VerdictSourceSchema.optional(),
        caseId: z.string().min(1).optional(),
        skillVersionId: z.string().min(1).optional(),
        criterionId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(100_000).default(10_000)
      })
      .safeParse({
        format: c.req.query("format") ?? undefined,
        source: c.req.query("source") ?? undefined,
        caseId: c.req.query("caseId") ?? undefined,
        skillVersionId: c.req.query("skillVersionId") ?? undefined,
        criterionId: c.req.query("criterionId") ?? undefined,
        limit: c.req.query("limit") ?? undefined
      });
    if (!parsed.success) {
      return c.json({ error: "Invalid export query", details: z.treeifyError(parsed.error) }, 400);
    }
    const verdicts = await repository.listVerdicts({
      projectId: c.get("projectId"),
      ...(parsed.data.caseId ? { caseId: parsed.data.caseId } : {}),
      ...(parsed.data.source ? { source: parsed.data.source } : {}),
      ...(parsed.data.skillVersionId ? { skillVersionId: parsed.data.skillVersionId } : {}),
      ...(parsed.data.criterionId ? { criterionId: parsed.data.criterionId } : {}),
      limit: parsed.data.limit
    });
    const filenameStem = `coeval-verdicts-${new Date().toISOString().slice(0, 10)}`;
    if (parsed.data.format === "csv") {
      const body = verdictsToCsv(verdicts);
      c.header("content-type", "text/csv; charset=utf-8");
      c.header("content-disposition", `attachment; filename="${filenameStem}.csv"`);
      return c.body(body);
    }
    // JSONL: one JSON object per line. Empty exports → an empty string body
    // with the right content-type so downstream tools don't mis-detect.
    const body = verdicts.map((verdict) => JSON.stringify(verdict)).join("\n");
    c.header("content-type", "application/x-ndjson; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filenameStem}.jsonl"`);
    return c.body(body);
  });

  app.post("/api/review-queues", async (c) => {
    markUngovernedLegacy(c);
    // Owner-only: creating a queue is a curation act — owners pick which cases
    // get explicit reviewer attention. Project members consume queues via
    // GET endpoints + the existing /verdicts endpoint (PR #43).
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can create review queues" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = CreateReviewQueueInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid review-queue input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const queue = await repository.createReviewQueue({
        projectId: c.get("projectId"),
        name: parsed.data.name,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.criterionVersionId !== undefined
          ? { criterionVersionId: parsed.data.criterionVersionId }
          : {}),
        caseIds: parsed.data.caseIds,
        ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
      });
      return c.json({ queue }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Cases? not found/i.test(message)) {
        return c.json({ error: "One or more cases were not found in this project", detail: message }, 400);
      }
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.get("/api/review-queues", async (c) => {
    markUngovernedLegacy(c);
    const parsed = z
      .object({ status: ReviewQueueStatusSchema.optional() })
      .safeParse({ status: c.req.query("status") ?? undefined });
    if (!parsed.success) {
      return c.json({ error: "Invalid review-queue query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({
      queues: await repository.listReviewQueues(c.get("projectId"), {
        ...(parsed.data.status ? { status: parsed.data.status } : {})
      })
    });
  });

  app.get("/api/review-queues/:queueId", async (c) => {
    markUngovernedLegacy(c);
    const detail = await repository.getReviewQueueDetail(c.get("projectId"), c.req.param("queueId"));
    if (!detail) return c.json({ error: "Review queue not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/review-queues/:queueId/next", async (c) => {
    markUngovernedLegacy(c);
    // Reviewer pulls the next pending item. Closed queues return 200 + { item:
    // null } so the UI can render an explicit "queue is closed" state without
    // confusing it with "queue done." Detail lookup confirms the queue exists.
    //
    // `?assignedTo=me` filters to items assigned to the current session
    // user (plus unassigned items, which any reviewer can pull). Any other
    // string is taken literally as a user id (useful for admin tooling).
    const projectId = c.get("projectId");
    const queueId = c.req.param("queueId");
    const detail = await repository.getReviewQueueDetail(projectId, queueId);
    if (!detail) return c.json({ error: "Review queue not found" }, 404);

    const query = z.object({
      assignedTo: z.string().min(1).optional(),
      criterionVersionId: z.string().min(1).optional()
    }).strict().safeParse({
      assignedTo: c.req.query("assignedTo") ?? undefined,
      criterionVersionId: c.req.query("criterionVersionId") ?? undefined
    });
    if (!query.success) {
      return c.json({ error: "Invalid next-item query", details: z.treeifyError(query.error) }, 400);
    }
    const assignedTo = query.data.assignedTo;
    const resolvedAssignee = assignedTo === "me"
      ? c.get("user")?.id ?? undefined
      : assignedTo ?? undefined;
    let next;
    try {
      next = await repository.getNextPendingQueueItem(projectId, queueId, {
        ...(resolvedAssignee ? { assignedToUserId: resolvedAssignee } : {}),
        ...(query.data.criterionVersionId ? { criterionVersionId: query.data.criterionVersionId } : {})
      });
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
    return c.json({ item: next, queueStatus: detail.queue.status });
  });

  app.post("/api/review-queues/:queueId/items", async (c) => {
    markUngovernedLegacy(c);
    // Owner-only: adding items (especially with explicit reviewer assignment)
    // is curation. Reviewers consume items via GET .../next and verdict via
    // the existing /verdicts endpoint.
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can add items to review queues" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = AddReviewQueueItemsInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid add-items input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const items = await repository.addReviewQueueItems({
        projectId: c.get("projectId"),
        queueId: c.req.param("queueId"),
        items: parsed.data.items
      });
      return c.json({ items, addedCount: items.length }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Review queue not found/i.test(message)) {
        return c.json({ error: "Review queue not found" }, 404);
      }
      if (/Cases? not found/i.test(message)) {
        return c.json({ error: "One or more cases were not found in this project", detail: message }, 400);
      }
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_criterion_version" }, 400);
      }
      throw error;
    }
  });

  app.post("/api/review-queues/:queueId/close", async (c) => {
    markUngovernedLegacy(c);
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can close review queues" }, 403);
    }
    const queue = await repository.closeReviewQueue(c.get("projectId"), c.req.param("queueId"));
    if (!queue) return c.json({ error: "Review queue not found" }, 404);
    return c.json({ queue });
  });

  app.post("/api/review-queues/:queueId/reopen", async (c) => {
    markUngovernedLegacy(c);
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can reopen review queues" }, 403);
    }
    const queue = await repository.reopenReviewQueue(c.get("projectId"), c.req.param("queueId"));
    if (!queue) return c.json({ error: "Review queue not found" }, 404);
    return c.json({ queue });
  });

  app.post("/api/golden-set/:entryId/retire", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can retire golden-set cases" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = RetireGoldenSetEntryInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid golden-set retirement input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      await repository.retireGoldenSetEntry({
        projectId: c.get("projectId"),
        entryId: c.req.param("entryId"),
        actorUserId: c.get("user")?.id,
        ...parsed.data
      });
      return c.json({ retired: true });
    } catch (error) {
      if (error instanceof GoldenSetEntryAlreadyRetiredError) {
        return c.json({
          error: "Golden-set entry already retired",
          ...(error.retirement ? { retirement: error.retirement } : {})
        }, 409);
      }
      if (error instanceof GoldenSetEntryNotFoundError) {
        return c.json({ error: "Golden-set entry not found" }, 404);
      }
      throw error;
    }
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

export type CoevalApi = ReturnType<typeof createApp>;

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

// project-verdict export helpers. CSV is flattened so spreadsheet
// tools / pandas can ingest it without nested-JSON handling. The payload's
// tagged-union variants collapse to verdict_kind + verdict_value:
//   - binary    → "true" | "false" | "ambiguous"
//   - scalar    → number formatted as string + `range_min` / `range_max`
//   - categorical → choice key + the JSON-encoded choiceScores map
function verdictsToCsv(verdicts: import("@coeval/shared").VerdictRecord[]): string {
  const header = [
    "id",
    "project_id",
    "case_id",
    "skill_version_id",
    "source",
    "actor_user_id",
    "external_run_id",
    "verdict_kind",
    "verdict_value",
    "rationale",
    "scalar_range_min",
    "scalar_range_max",
    "categorical_choice_scores_json",
    "created_at"
  ];
  const rows = verdicts.map((verdict) => {
    const payload = verdict.payload;
    const verdictKind = payload.kind;
    let verdictValue = "";
    let scalarMin = "";
    let scalarMax = "";
    let categoricalChoices = "";
    if (payload.kind === "binary") {
      verdictValue = "pass" in payload ? (payload.pass ? "true" : "false") : payload.label;
    } else if (payload.kind === "scalar") {
      verdictValue = String(payload.score);
      scalarMin = String(payload.range[0]);
      scalarMax = String(payload.range[1]);
    } else {
      verdictValue = payload.choice;
      categoricalChoices = JSON.stringify(payload.choiceScores);
    }
    return [
      verdict.id,
      verdict.projectId,
      verdict.caseId,
      verdict.skillVersionId ?? "",
      verdict.source,
      verdict.actorUserId ?? "",
      verdict.externalRunId ?? "",
      verdictKind,
      verdictValue,
      payload.rationale,
      scalarMin,
      scalarMax,
      categoricalChoices,
      verdict.createdAt
    ];
  });
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

function csvField(value: string): string {
  // RFC 4180 quoting: wrap in double quotes if the value contains a comma,
  // quote, or newline; double up any embedded quotes.
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
