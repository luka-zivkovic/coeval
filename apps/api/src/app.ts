import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import {
  CreateApiKeyInputSchema,
  JudgeKeyProviderSchema,
  JudgeBatchRequestSchema,
  JudgeServiceRequestSchema,
  ManualTraceImportInputSchema,
  PROJECT_NAME_MAX_LENGTH,
  ProjectModeSchema,
  SetJudgeProviderKeyInputSchema,
  verdictLabelFromPayload
} from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import {
  AssessmentReceiptIntegrityError,
  AssessmentReceiptUnavailableError,
  CaseNotFoundError,
  CoevalRepository,
  DatasetNotFoundError,
  DemoRepository,
  ImportSkillVersionBindingError,
  RecursiveTraceSkippedError,
  type IronsideImportContext,
  type LangfuseImportContext,
  type LangSmithImportContext
} from "./repository.js";
import type { CoevalAuth } from "./lib/auth.js";
import {
  createInvitation,
  ensureWorkspaceForUser,
  firstProjectForUser,
  parseTrustedOrigins,
  redeemInvitation,
  resolveAgentSetupPairing,
  setupRequired,
  userProjectRole
} from "./lib/auth.js";
import type { LangSmithTraceFetcher } from "./lib/langsmith.js";
import type { LangfuseTraceFetcher } from "./lib/langfuse.js";
import type { IronsideTraceSource } from "./lib/ironside.js";
import {
  createStrictJudgeProvider,
  isJudgeAuthError,
  JudgeProviderUnavailableError
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
import { contentDigest, sha256Digest } from "./lib/assessment-receipt.js";
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
import { registerIntegrationAdministrationRoutes } from "./routes/integration-administration.js";
import { registerLegacyEvidenceAdministrationRoutes } from "./routes/legacy-evidence-administration.js";
import {
  FIRST_PROJECT_KEY_NAME,
  registerProjectAdministrationRoutes
} from "./routes/project-administration.js";
import { registerSkillAdministrationRoutes } from "./routes/skill-administration.js";
import { registerTraceTestAdministrationRoutes } from "./routes/trace-test-administration.js";
import { registerV1AgentAdministrationRoutes } from "./routes/v1-agent-administration.js";

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

const ReceiptComparisonInputSchema = z.object({
  consumerReceiptBase64: z.string().min(1).max(JUDGE_BATCH_MAX_BODY_BYTES)
}).strict();

function decodeExactBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

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

  registerV1AgentAdministrationRoutes(app, {
    repository,
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.pool ? { pool: options.pool } : {}),
    publicApiBaseUrl
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

  registerIntegrationAdministrationRoutes(app, {
    repository,
    requestServices,
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.pool ? { pool: options.pool } : {}),
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.langSmithClientFactory ? { langSmithClientFactory: options.langSmithClientFactory } : {}),
    ...(options.langfuseClientFactory ? { langfuseClientFactory: options.langfuseClientFactory } : {}),
    ...(options.ironsideClientFactory ? { ironsideClientFactory: options.ironsideClientFactory } : {})
  });

  registerLegacyEvidenceAdministrationRoutes(app, {
    repository,
    ...(options.pool ? { pool: options.pool } : {})
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

export type CoevalApi = ReturnType<typeof createApp>;
