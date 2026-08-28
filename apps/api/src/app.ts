import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import {
  AddDatasetItemsInputSchema,
  AddReviewQueueItemsInputSchema,
  AgentBootstrapRequestSchema,
  type AgentBootstrapResponse,
  buildAgentConnectSnippets,
  AssistTraceTestDraftInputSchema,
  compileJudgePrompt,
  CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT,
  CONVERGENCE_CASE_PAGE_MAX_LIMIT,
  defaultJudgePromptTemplate,
  CreateApiKeyInputSchema,
  CreateCriterionInputSchema,
  CreateCriterionVersionInputSchema,
  CreateDatasetInputSchema,
  CreateDatasetRevisionInputSchema,
  CreateTraceTestInputSchema,
  CreateEvalRunInputSchema,
  CreateReviewQueueInputSchema,
  CreateRunComparisonInputSchema,
  CreateOnboardingCheckInputSchema,
  CreateSkillVersionInputSchema,
  CreateEvaluatorSuiteManifestInputSchema,
  DeleteProjectInputSchema,
  JudgeBatchRequestSchema,
  JudgeServiceRequestSchema,
  verdictLabelFromPayload,
  VERDICT_LIST_MAX_LIMIT,
  FeedbackSyncStatusSchema,
  ImportDatasetExamplesInputSchema,
  ImportJobStatusSchema,
  EnableTraceTestInputSchema,
  PROJECT_NAME_MAX_LENGTH,
  ProjectModeSchema,
  type LangfuseConnectionTestResult,
  type LangfuseImportEnqueueResult,
  LangfuseImportRequestSchema,
  LangfuseIntegrationInputSchema,
  type IronsideConnectionTestResult,
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
  OnboardingEvidenceInventorySchema,
  PromoteGoldenSetInputSchema,
  ReviewQueueStatusSchema,
  JudgeKeyProviderSchema,
  JudgeProviderIdSchema,
  RetireGoldenSetEntryInputSchema,
  RecordManualTraceTestValidationInputSchema,
  ReviseTraceTestInputSchema,
  RunTraceTestValidationInputSchema,
  StartTraceTestRunInputSchema,
  TraceTestFunnelEventInputSchema,
  SetJudgeProviderKeyInputSchema,
  SKILL_FORMAT_EXAMPLES_CAP,
  type DatasetDetail,
  type DatasetRevisionDetail,
  type EvalRun,
  type EvaluatorExecutionContext,
  type TraceTestRunSource,
  type RunComparison,
  type SkillFormatV1,
  type TraceStep,
  UpdateLangfuseIntegrationInputSchema,
  UpdateLangSmithIntegrationInputSchema,
  UpdateProjectSettingsInputSchema,
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
import { traceTestRunOutcome } from "@coeval/shared";
import type { Queue, QueueSendOptions } from "@coeval/queue";
import { AgentSetupEligibilityError, AmbiguousProjectSkillError, AssessmentReceiptIntegrityError, AssessmentReceiptUnavailableError, CaseNotFoundError, CoevalRepository, CriterionStableKeyConflictError, DatasetNameTakenError, DatasetNotFoundError, DatasetRevisionConflictError, DatasetRevisionNotFoundError, DemoRepository, EvaluatorSuiteBindingError, EvaluatorSuiteIdempotencyConflictError, GoldenSetEntryAlreadyRetiredError, GoldenSetEntryNotFoundError, GoldenSetLabelConflictError, ImportSkillVersionBindingError, InvalidConvergenceCursorError, IronsideIntegrationNotFoundError, LangfuseIntegrationNotFoundError, LangSmithIntegrationNotFoundError, NoCurrentSkillError, OnboardingCheckConflictError, RecursiveTraceSkippedError, RegressionGateJudgeError, RegressionGateUnavailableError, SealedValidationUnavailableError, SkillVersionNotSignableError, TraceTestNotFoundError, TraceTestRevisionConflictError, TraceTestSourceNotFoundError, TraceTestValidationNotReadyError, type IronsideImportContext, type LangfuseImportContext, type LangSmithImportContext } from "./repository.js";
import type { CoevalAuth } from "./lib/auth.js";
import {
  bootstrapOwnerUserByEmail,
  AGENT_SETUP_PAIRING_CLAIM_GRACE_MS,
  claimAgentSetupPairing,
  completeAgentSetupPairing,
  createAgentSetupPairing,
  createInvitation,
  createProjectForUser,
  ensureWorkspaceForUser,
  firstProjectForUser,
  getAgentSetupPairing,
  invalidateAgentSetupPairing,
  parseTrustedOrigins,
  redeemInvitation,
  releaseAgentSetupPairing,
  resolveAgentSetupPairing,
  revokeAgentSetupPairing,
  setupRequired,
  userProjectRole,
  AgentSetupPairingInProgressError,
  type AgentSetupPairingRecord
} from "./lib/auth.js";
import { LangSmithClient, LangSmithHttpError, type LangSmithTraceFetcher } from "./lib/langsmith.js";
import { LangfuseClient, LangfuseHttpError, type LangfuseTraceFetcher } from "./lib/langfuse.js";
import { IronsideClient, IronsideHttpError, type IronsideTraceSource } from "./lib/ironside.js";
import { buildJudgeCard, renderJudgeCardMarkdown } from "./lib/judge-card.js";
import { buildTrustDigest, SPEND_WINDOW_RUNS } from "./lib/trust-digest.js";
import { buildFindings, latestDiscreteVerdictByCase } from "./lib/findings.js";
import {
  createStrictJudgeProvider,
  isJudgeAuthError,
  judgeProviderEnvironmentKey,
  judgeProviderAvailability,
  JudgeProviderUnavailableError,
  openAIJudgeProviderBaseUrl,
  resolveJudgeProviderApiKey
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
import { computeRunComparisonDiff, runComparisonAgreement, runComparisonStatus } from "./lib/run-comparison.js";
import { contentDigest, sha256Digest } from "./lib/assessment-receipt.js";
import { canonicalEvaluatorSuiteManifestBytes } from "./lib/evaluator-suite.js";
import { runEvalRunInline } from "./workers/eval-run.js";
import { runExistingCaseBackfill } from "./workers/gate.js";
import { assertImportJudgingAllowed, scheduleImportedCaseJudging } from "./workers/import-judging.js";
import { judgeAndRecord } from "./workers/judge.js";
import {
  buildTraceTestDraftPrompt,
  generateTraceTestDraft,
  parseAssistedTraceTestContent,
  scopedTraceTestEvidence,
  TRACE_TEST_DRAFT_SYSTEM_PROMPT,
  TraceTestDraftProviderError,
  type TraceTestDraftGenerator
} from "./lib/trace-test-drafter.js";
import {
  hasUsableTraceTestExample,
  traceTestValidationExamples,
  validateTraceTestPair,
  type TraceTestValidationRunner
} from "./lib/trace-test-validator.js";

type Variables = {
  user: { id: string; email?: string; name?: string } | null;
  session: unknown | null;
  projectId: string;
  // Set by the /api/v1/* key middleware; the batch endpoint uses it to debit
  // additional rate-limit tokens (one per judged item).
  apiKeyId?: string;
  agentBootstrapAuth?:
    | { kind: "deployment-token" }
    | { kind: "pairing"; pairing: AgentSetupPairingRecord };
};

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
const TRACE_TEST_VALIDATION_MAX_ATTEMPTS = 2;
const TRACE_TEST_VALIDATION_RATE_TOKENS = 2 * TRACE_TEST_VALIDATION_MAX_ATTEMPTS;
const TRACE_TEST_DATASET_NAME = "Regression tests";
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

const TraceTestSourceSnapshotSchema = z.object({
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(z.object({
    name: z.string().optional(),
    input: z.unknown(),
    output: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })).optional()
}).passthrough();

const AGENT_BOOTSTRAP_PROMPT = defaultJudgePromptTemplate("captured agent-skill run");

// Name of the API key auto-minted with every new project (owner setup and
// POST /api/projects both pass it) — one literal so the Settings list and
// onboarding copy can reference the same identity.
const FIRST_PROJECT_KEY_NAME = "First verdict";

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

export function agentSetupPairingClaimExpiresAt(pairing: AgentSetupPairingRecord): string | null {
  if (!pairing.claimedAt) return null;
  return new Date(Date.parse(pairing.claimedAt) + AGENT_SETUP_PAIRING_CLAIM_GRACE_MS).toISOString();
}

export function agentSetupPairingStatus(pairing: AgentSetupPairingRecord): "pending" | "claimed" | "completed" | "expired" | "revoked" {
  if (pairing.revokedAt) return "revoked";
  if (pairing.consumedAt) return "completed";
  const claimExpiresAt = agentSetupPairingClaimExpiresAt(pairing);
  if (claimExpiresAt && Date.parse(claimExpiresAt) > Date.now()) return "claimed";
  // An abandoned claim is terminal even when the original token TTL has a few
  // minutes left; the owner can now generate a replacement safely.
  if (pairing.claimedAt) return "expired";
  if (Date.parse(pairing.expiresAt) <= Date.now()) return "expired";
  return "pending";
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
  ironsideClientFactory?: ((context: IronsideImportContext) => IronsideTraceSource) | undefined;
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
  const app = new Hono<{ Variables: Variables }>();
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

  // Token bucket per key: sustained rate is JUDGE_RATE_LIMIT_PER_MINUTE
  // tokens/min; capacity is raised to the batch item cap so one full-size
  // batch is a legal burst (otherwise a >limit-item batch could NEVER pass —
  // the requested tokens would exceed what a full bucket holds). State lives
  // in this createApp closure, so tests and multi-tenant processes don't
  // bleed into each other across instances.
  // Every /api/v1 request costs 1 token; the batch endpoint debits one more
  // per additionally judged item, so batching can't multiply provider spend
  // past the per-minute budget.
  const RATE_BUCKET_CAPACITY = Math.max(JUDGE_RATE_LIMIT_PER_MINUTE, JUDGE_BATCH_MAX_ITEMS);
  const rateBuckets = new Map<string, { tokens: number; refilledAt: number }>();
  const takeRateTokens = (apiKeyId: string, count: number): boolean => {
    const now = Date.now();
    const bucket = rateBuckets.get(apiKeyId) ?? { tokens: RATE_BUCKET_CAPACITY, refilledAt: now };
    bucket.tokens = Math.min(
      RATE_BUCKET_CAPACITY,
      bucket.tokens + ((now - bucket.refilledAt) / 60_000) * JUDGE_RATE_LIMIT_PER_MINUTE
    );
    bucket.refilledAt = now;
    rateBuckets.set(apiKeyId, bucket);
    if (bucket.tokens < count) return false;
    bucket.tokens -= count;
    return true;
  };
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

  // Resolve the optional caller-pinned skill version: default to the
  // project's current version; reject ids that don't belong to this project
  // (a typo'd id would otherwise surface as an FK 500 after traces were
  // already imported, and another project's id would create a run whose
  // every item fails).
  const resolveSkillVersionId = async (
    projectId: string,
    requested: string | undefined,
    authorization: {
      context: EvaluatorExecutionContext;
      resourceKind: string;
      resourceId: string;
    } = { context: "implicit_production", resourceKind: "api_route", resourceId: "current" }
  ): Promise<{ id: string } | { invalid: string }> => {
    let resolvedId: string;
    if (requested) {
      const version = await repository.getSkillVersion(projectId, requested);
      if (!version) return { invalid: `Unknown skillVersionId for this project: ${requested}` };
      resolvedId = version.id;
    } else {
      let skill;
      try {
        skill = await repository.getCurrentSkill(projectId);
      } catch (error) {
        if (error instanceof AmbiguousProjectSkillError) {
          return { invalid: "This project has multiple criteria; provide skillVersionId explicitly." };
        }
        if (!(error instanceof NoCurrentSkillError)) throw error;
        return { invalid: "No active skill version. Define one before judging." };
      }
      resolvedId = skill.currentVersion.id;
    }
    try {
      await repository.authorizeSkillVersionExecution({
        projectId,
        skillVersionId: resolvedId,
        context: authorization.context,
        resourceKind: authorization.resourceKind,
        resourceId: authorization.resourceId,
        idempotencyKey: `route-auth:${authorization.context}:${authorization.resourceKind}:${authorization.resourceId}:${resolvedId}`
      });
    } catch (error) {
      return { invalid: error instanceof Error ? error.message : "Evaluator version is not authorized for this operation." };
    }
    return { id: resolvedId };
  };

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

  const binaryCalibrationIdentity = (c: Context<{ Variables: Variables }>) => ({
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

  app.get("/api/projects", async (c) => {
    return c.json({ projects: await repository.listProjects(c.get("user")?.id) });
  });

  // P0-2: create a project in the caller's organization. The creator becomes
  // the project owner. This is the only route that must work with zero
  // memberships (the post-deletion landing).
  app.post("/api/projects", async (c) => {
    c.header("cache-control", "no-store");
    if (!options.pool) {
      return c.json({ error: "Project creation requires auth mode (in-memory demo is single-project)" }, 501);
    }
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({ name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH), mode: ProjectModeSchema.optional() })
      .safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid project input", details: z.treeifyError(parsed.error) }, 400);
    }
    const created = await createProjectForUser(options.pool, {
      userId: user.id,
      email: user.email ?? "user",
      name: parsed.data.name,
      apiKeyName: FIRST_PROJECT_KEY_NAME,
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {})
    });
    return c.json({ projectId: created.projectId, apiKey: created.apiKey }, 201);
  });

  // Beginner-facing agent connection: a signed-in project owner creates a
  // 15-minute, single-use capability and pastes it into Claude, Codex, or any
  // other external harness. The database stores only its hash. It authorizes
  // setup for this project only and never reaches adjudication/golden routes.
  app.post("/api/agent-setup/pairings", async (c) => {
    c.header("cache-control", "no-store");
    if (!options.pool) {
      return c.json({ error: "Agent pairing requires database-backed auth mode." }, 501);
    }
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const projectId = c.get("projectId");
    const role = await userProjectRole(options.pool, { userId: user.id, projectId });
    if (role !== "owner") return c.json({ error: "Only project owners can connect a setup agent." }, 403);
    const project = (await repository.listProjects(user.id)).find((candidate) => candidate.id === projectId);
    if (!project) return c.json({ error: "Project not found." }, 404);
    if (project.importedTraceCount > 0) {
      return c.json({
        error: "Agent pairing is limited to new projects with no imported cases.",
        code: "project_not_empty"
      }, 409);
    }
    const skill = await repository.getLatestSkill(projectId);
    if (!skill.isStarter) {
      return c.json({
        error: "This project's starter judging skill has already been configured.",
        code: "project_already_configured"
      }, 409);
    }

    let pairing;
    try {
      pairing = await createAgentSetupPairing(options.pool, {
        projectId,
        createdByUserId: user.id
      });
    } catch (error) {
      if (error instanceof AgentSetupPairingInProgressError) {
        return c.json({ error: error.message, code: "pairing_already_claimed" }, 409);
      }
      throw error;
    }
    return c.json({
      id: pairing.id,
      projectId: pairing.projectId,
      projectName: pairing.projectName,
      ownerEmail: pairing.ownerEmail,
      apiBaseUrl: publicApiBaseUrl(c),
      expiresAt: pairing.expiresAt,
      claimExpiresAt: agentSetupPairingClaimExpiresAt(pairing),
      status: agentSetupPairingStatus(pairing),
      token: pairing.token
    }, 201);
  });

  app.get("/api/agent-setup/pairings/:pairingId", async (c) => {
    if (!options.pool) return c.json({ error: "Agent pairing requires auth mode." }, 501);
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const projectId = c.get("projectId");
    const role = await userProjectRole(options.pool, { userId: user.id, projectId });
    if (role !== "owner") return c.json({ error: "Only project owners can inspect setup connections." }, 403);
    const pairing = await getAgentSetupPairing(options.pool, { id: c.req.param("pairingId"), projectId });
    if (!pairing) return c.json({ error: "Agent setup connection not found." }, 404);
    return c.json({
      id: pairing.id,
      projectId: pairing.projectId,
      projectName: pairing.projectName,
      ownerEmail: pairing.ownerEmail,
      apiBaseUrl: publicApiBaseUrl(c),
      expiresAt: pairing.expiresAt,
      claimExpiresAt: agentSetupPairingClaimExpiresAt(pairing),
      status: agentSetupPairingStatus(pairing)
    });
  });

  app.delete("/api/agent-setup/pairings/:pairingId", async (c) => {
    if (!options.pool) return c.json({ error: "Agent pairing requires auth mode." }, 501);
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const projectId = c.get("projectId");
    const role = await userProjectRole(options.pool, { userId: user.id, projectId });
    if (role !== "owner") return c.json({ error: "Only project owners can revoke setup connections." }, 403);
    const revoked = await revokeAgentSetupPairing(options.pool, {
      id: c.req.param("pairingId"),
      projectId
    });
    if (revoked) return c.body(null, 204);
    const pairing = await getAgentSetupPairing(options.pool, { id: c.req.param("pairingId"), projectId });
    if (pairing && agentSetupPairingStatus(pairing) === "claimed") {
      return c.json({ error: "Agent setup is already running and can no longer be revoked." }, 409);
    }
    return c.json({ error: "Active agent setup connection not found." }, 404);
  });

  // Project/environment credential availability (no secrets). The skill
  // editor uses it to offer only runnable providers. The mock remains a local
  // demo option and is unavailable when a real database is wired.
  const projectKeyProviders = async (projectId: string): Promise<ReadonlySet<string>> =>
    new Set((await repository.listJudgeProviderKeys(projectId)).map((key) => key.provider));

  app.get("/api/judge/providers", async (c) => {
    return c.json({ providers: judgeProviderAvailability(await projectKeyProviders(c.get("projectId")), !options.pool) });
  });

  app.get("/api/judge/providers/:provider/models", async (c) => {
    const parsed = JudgeProviderIdSchema.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json({ error: "Unknown judge provider" }, 400);
    if (parsed.data === "custom") {
      return c.json({ error: "Custom OpenAI-compatible models are entered manually" }, 400);
    }
    const projectKey = parsed.data === "mock"
      ? null
      : await repository.getJudgeProviderCredential(c.get("projectId"), parsed.data);
    const apiKey = resolveJudgeProviderApiKey(parsed.data, projectKey ?? undefined);
    const openAIBaseUrl = parsed.data === "openai" ? openAIJudgeProviderBaseUrl() : undefined;
    try {
      return c.json(await fetchJudgeModelCatalog({
        provider: parsed.data,
        ...(apiKey ? { apiKey } : {}),
        ...(openAIBaseUrl ? { baseUrl: openAIBaseUrl } : {})
      }));
    } catch (error) {
      if (error instanceof JudgeModelCatalogError) {
        // "unconfigured" is the caller's state (no key for this provider) →
        // 409; "upstream" covers provider outages, timeouts, and bad payloads
        // → 502, so a transient outage never reads as user misconfiguration.
        return c.json({ error: error.message }, error.kind === "unconfigured" ? 409 : 502);
      }
      throw error;
    }
  });

  app.get("/api/project/settings", async (c) => {
    return c.json(await repository.getProjectSettings(c.get("projectId")));
  });

  app.patch("/api/project/settings", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can edit project settings" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdateProjectSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid project settings input", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json(await repository.updateProjectSettings(c.get("projectId"), parsed.data, {
      actorUserId: c.get("user")?.id
    }));
  });

  app.post("/api/project/retention/prune", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can prune project traces" }, 403);
    }

    return c.json(await repository.pruneExpiredTraces(c.get("projectId"), {
      actorUserId: c.get("user")?.id
    }));
  });

  app.delete("/api/project", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can delete projects" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = DeleteProjectInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid project deletion input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      await repository.deleteProject(c.get("projectId"), {
        confirmProjectName: parsed.data.confirmProjectName,
        actorUserId: c.get("user")?.id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/confirmation/i.test(message)) return c.json({ error: "Project name confirmation did not match" }, 400);
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.get("/api/dashboard", async (c) => {
    let summary;
    try {
      summary = await repository.getDashboardSummary(
        c.get("projectId"),
        c.req.query("criterionId") || undefined
      );
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "ambiguous_project_skill" }, 409);
      }
      if (error instanceof NoCurrentSkillError) {
        return c.json({ error: error.message, code: "criterion_not_found" }, 404);
      }
      throw error;
    }
    // Owner-only affordances (agent pairing) key off this instead of showing
    // members a card whose action is a guaranteed 403. Demo mode has no
    // roles — everyone is effectively the owner.
    const user = c.get("user");
    const role = user && options.pool
      ? await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") })
      : "owner";
    return c.json({ ...summary, viewerRole: role === "owner" ? "owner" : "member" });
  });

  app.get("/api/onboarding/evidence-inventory", async (c) => {
    const inventory = await repository.getOnboardingEvidenceInventory(c.get("projectId"));
    return c.json(OnboardingEvidenceInventorySchema.parse(inventory));
  });

  app.get("/api/skills/current", async (c) => {
    // ?scope=latest returns the newest version regardless of status — the
    // skill editor's seed, so a gate-blocked draft survives a reload as the
    // editing base. The default (production scope) never resolves a blocked
    // version.
    try {
      const criterionId = c.req.query("criterionId") || undefined;
      if (c.req.query("scope") === "latest") {
        return c.json(criterionId
          ? await repository.getLatestSkillForCriterion(c.get("projectId"), criterionId)
          : await repository.getLatestSkill(c.get("projectId")));
      }
      return c.json(criterionId
        ? await repository.getCurrentSkillForCriterion(c.get("projectId"), criterionId)
        : await repository.getCurrentSkill(c.get("projectId")));
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "ambiguous_project_skill" }, 409);
      }
      if (error instanceof NoCurrentSkillError) {
        return c.json({ error: error.message, code: "criterion_not_found" }, 404);
      }
      throw error;
    }
  });

  app.get("/api/skills/:skillId/versions", async (c) => {
    // version history surface. Read-only — any project member.
    const parsed = z
      .object({ limit: z.coerce.number().int().positive().max(200).default(50) })
      .safeParse({ limit: c.req.query("limit") ?? undefined });
    if (!parsed.success) {
      return c.json({ error: "Invalid version-list query", details: z.treeifyError(parsed.error) }, 400);
    }
    const versions = await repository.listSkillVersions(c.get("projectId"), c.req.param("skillId"), parsed.data.limit);
    const regressionRuns = await repository.listRegressionRunsForVersions(
      c.get("projectId"),
      versions.map((version) => version.id)
    );
    return c.json({ versions, regressionRuns });
  });

  // the version's recorded regression run (incl. per-case diff), so the
  // Judge Card can show what flipped when this version shipped. Read-only.
  app.get("/api/skills/:skillId/versions/:versionId/regression", async (c) => {
    const projectId = c.get("projectId");
    const version = await repository.getSkillVersion(projectId, c.req.param("versionId"));
    if (!version || version.skillId !== c.req.param("skillId")) {
      return c.json({ error: "Skill version not found" }, 404);
    }
    const run = await repository.getRegressionRunForVersion(projectId, version.id);
    if (!run) return c.json({ error: "No regression run recorded for this version" }, 404);
    return c.json({ regressionRun: run });
  });

  // Exact summary + independently paged per-case ledger. This diagnostic is
  // pinned to one evaluator version over recorded legacy adjudications.
  app.get("/api/skills/:skillId/versions/:versionId/convergence", async (c) => {
    const parsed = z.object({
      limit: z.coerce.number().int().positive().max(CONVERGENCE_CASE_PAGE_MAX_LIMIT)
        .default(CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT),
      cursor: z.string().min(1).max(1000).optional()
    }).safeParse({
      limit: c.req.query("limit") ?? undefined,
      cursor: c.req.query("cursor") ?? undefined
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid convergence query", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const page = await repository.getConvergenceAudit(
        c.get("projectId"),
        c.req.param("skillId"),
        c.req.param("versionId"),
        parsed.data
      );
      return c.json(page);
    } catch (error) {
      if (error instanceof InvalidConvergenceCursorError) {
        return c.json({ error: error.message, code: "invalid_convergence_cursor" }, 400);
      }
      throw error;
    }
  });

  // judge self-consistency for a version (part of the trust report) — does
  // the judge return the same verdict when re-run on identical input? Read-only;
  // empty (no compared cases) until a case has been judged 2+ times.
  app.get("/api/skills/:skillId/versions/:versionId/self-consistency", async (c) => {
    const report = await repository.getSelfConsistencyReport(c.get("projectId"), c.req.param("versionId"));
    return c.json({ selfConsistency: report });
  });

  // P0-1 onboarding: "Sign off as-is" — approve the starter draft without
  // re-judging. Exits the provisional journey stage. Owner-only; anything
  // that was ever approved must go through the gate (POST /versions) instead.
  // the Judge Card — recorded evidence about one version as a
  // shareable artifact (JSON, or ?format=md for paste-able markdown).
  app.get("/api/skills/:skillId/versions/:versionId/card", async (c) => {
    const projectId = c.get("projectId");
    const skillId = c.req.param("skillId");
    const versionId = c.req.param("versionId");

    const version = await repository.getSkillVersion(projectId, versionId);
    if (!version) return c.json({ error: "Skill version not found" }, 404);
    if (version.skillId !== skillId) return c.json({ error: "Skill not found" }, 404);
    const criterionVersion = await repository.getCriterionVersionForSkillVersion(projectId, versionId);
    if (!criterionVersion) return c.json({ error: "Evaluator criterion binding not found" }, 409);
    const skill = await repository.getCurrentSkillForCriterion(projectId, criterionVersion.criterionId);

    const [project, goldenSet, regression, calibration, selfConsistency, audit] = await Promise.all([
      repository.getProjectSettings(projectId),
      repository.listGoldenSet(projectId, criterionVersion.id),
      repository.getRegressionRunForVersion(projectId, versionId),
      repository.getProjectJudgeHumanCalibration(projectId, criterionVersion.id, versionId),
      repository.getSelfConsistencyReport(projectId, versionId),
      repository.listAuditEntries(projectId, "skill_version", versionId)
    ]);

    const card = buildJudgeCard({
      generatedAt: new Date().toISOString(),
      project,
      skill,
      version,
      goldenSetSize: goldenSet.length,
      regression,
      calibration,
      selfConsistency,
      audit
    });
    if (c.req.query("format") === "md") {
      // `?format=md&download=1` forces a browser download (attachment)
      // with a STATIC filename stem — never the skill/project name (that would
      // be a Content-Disposition header-injection surface). Without download=1
      // it stays inline text/markdown for the copy path.
      const headers: Record<string, string> = { "content-type": "text/markdown; charset=utf-8" };
      if (c.req.query("download") === "1") {
        const stamp = new Date().toISOString().slice(0, 10);
        headers["content-disposition"] = `attachment; filename="coeval-judge-card-${stamp}.md"`;
      }
      return c.text(renderJudgeCardMarkdown(card), 200, headers);
    }
    return c.json(card);
  });

  // portable SkillFormat v1 export — a skill version as the
  // implementation-independent document (spec/skill-format-v1.md). Mapping
  // only: everything from Skill + SkillVersion + the golden set (examples).
  // Session + member-authed like /card. `?download=1` streams a .json file.
  app.get("/api/skills/:skillId/versions/:versionId/skill-format", async (c) => {
    const projectId = c.get("projectId");
    const skillId = c.req.param("skillId");
    const versionId = c.req.param("versionId");

    const version = await repository.getSkillVersion(projectId, versionId);
    if (!version) return c.json({ error: "Skill version not found" }, 404);
    if (version.skillId !== skillId) return c.json({ error: "Skill not found" }, 404);
    const criterionVersion = await repository.getCriterionVersionForSkillVersion(projectId, versionId);
    if (!criterionVersion) return c.json({ error: "Evaluator criterion binding not found" }, 409);
    const skill = await repository.getCurrentSkillForCriterion(projectId, criterionVersion.criterionId);

    const examples = await repository.getSkillFormatExamples(
      projectId,
      SKILL_FORMAT_EXAMPLES_CAP,
      criterionVersion.id
    );
    const basis: string[] = [];
    if (examples.length === 0) {
      basis.push("examples: the golden set is empty — promote reviewed cases to seed few-shot examples.");
    } else if (examples.length === SKILL_FORMAT_EXAMPLES_CAP) {
      basis.push(`examples: capped at ${SKILL_FORMAT_EXAMPLES_CAP} of the golden set.`);
    }
    basis.push("This document is a mapping of recorded skill + golden-set data — no value is fabricated.");

    const doc: SkillFormatV1 = {
      formatVersion: "skill-format/v1",
      name: skill.name,
      description: skill.description,
      owner: skill.ownerName,
      version: version.version,
      status: version.status,
      modelBinding: version.modelBinding,
      rubricMarkdown: version.rubricMarkdown,
      examples,
      outputSchema: (version.outputSchema ?? {}) as SkillFormatV1["outputSchema"],
      basis
    };

    if (c.req.query("download") === "1") {
      const stamp = new Date().toISOString().slice(0, 10);
      return c.json(doc, 200, {
        "content-disposition": `attachment; filename="coeval-skill-format-${stamp}.json"`
      });
    }
    return c.json(doc);
  });

  app.post("/api/skills/:skillId/versions/:versionId/signoff", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can sign off the rubric" }, 403);
    }
    try {
      const version = await repository.signOffSkillVersion(
        c.get("projectId"),
        c.req.param("skillId"),
        c.req.param("versionId"),
        { actorUserId: c.get("user")?.id }
      );
      if (!version) return c.json({ error: "Skill version not found" }, 404);
      return c.json({ version });
    } catch (error) {
      if (error instanceof SkillVersionNotSignableError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.get("/api/skills/:skillId/versions/:versionId/criterion", async (c) => {
    const projectId = c.get("projectId");
    const version = await repository.getSkillVersion(projectId, c.req.param("versionId"));
    if (!version || version.skillId !== c.req.param("skillId")) {
      return c.json({ error: "Check version not found" }, 404);
    }
    const criterionVersion = await repository.getCriterionVersionForSkillVersion(projectId, version.id);
    if (!criterionVersion) return c.json({ error: "Quality question not found" }, 404);
    return c.json({ criterionVersion });
  });

  // Beginner first-Check creation. This is deliberately distinct from a
  // normal evaluator edit: the exact quality question visible in onboarding
  // is appended as an immutable criterion definition and bound to the new
  // evaluator version in the same repository transaction.
  app.post("/api/skills/:skillId/onboarding-check", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can create the first Check" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = CreateOnboardingCheckInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid onboarding Check input", details: z.treeifyError(parsed.error) }, 400);
    }
    if (options.pool && parsed.data.evaluator.modelBinding.provider === "mock") {
      return c.json({ error: "The mock judge is only available in local demo mode. Configure a real judge provider first." }, 400);
    }

    const projectId = c.get("projectId");
    const requestDigest = sha256Digest({
      criterion: parsed.data.criterion,
      evaluator: parsed.data.evaluator
    });
    const context = {
      projectId,
      actorUserId: c.get("user")?.id,
      onboardingCriterion: {
        ...parsed.data.criterion,
        idempotencyKey: parsed.data.idempotencyKey,
        requestDigest
      }
    };
    try {
      if (options.queue) {
        const pending = await repository.createSkillVersionPending(
          c.req.param("skillId"),
          parsed.data.evaluator,
          context
        );
        if (!pending.regressionDatasetRevisionId) {
          throw new DatasetRevisionConflictError(
            `Skill version ${pending.id} has no immutable regression dataset binding.`
          );
        }
        const criterionVersion = await repository.getCriterionVersionForSkillVersion(projectId, pending.id);
        if (!criterionVersion) {
          throw new DatasetRevisionConflictError("The onboarding Check has no immutable criterion binding.");
        }
        const gateJobId = await options.queue.send("gate.run", {
          projectId,
          skillVersionId: pending.id,
          datasetRevisionId: pending.regressionDatasetRevisionId,
          ...(c.get("user")?.id ? { actorUserId: c.get("user")!.id } : {}),
          timeScope: parsed.data.evaluator.timeScope
        }, { retryLimit: 5, retryBackoff: true });
        if (!gateJobId) throw new Error("The first Check was saved, but its setup job was not accepted by the queue. Retry the same proposal.");
        return c.json({ criterionVersion, version: pending, regressionRun: null, queued: true }, 202);
      }

      const result = await repository.createSkillVersion(
        c.req.param("skillId"),
        parsed.data.evaluator,
        context
      );
      const criterionVersion = await repository.getCriterionVersionForSkillVersion(projectId, result.version.id);
      if (!criterionVersion) {
        throw new DatasetRevisionConflictError("The onboarding Check has no immutable criterion binding.");
      }
      return c.json({
        criterionVersion,
        version: result.version,
        regressionRun: result.regressionRun,
        queued: false
      }, 201);
    } catch (error) {
      if (error instanceof OnboardingCheckConflictError) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "criterion_binding_conflict" }, 409);
      }
      if (error instanceof RegressionGateUnavailableError) {
        return c.json({
          error: error.message,
          unavailableProvider: error.provider,
          availableProviders: judgeProviderAvailability(
            await projectKeyProviders(projectId),
            !options.pool
          ).filter((provider) => provider.available).map((provider) => provider.provider)
        }, 503);
      }
      throw error;
    }
  });

  app.post("/api/skills/:skillId/versions", async (c) => {
    if (options.pool) {
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
      if (role !== "owner") return c.json({ error: "Only owners can edit skills" }, 403);
    }

    const skillId = c.req.param("skillId");
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSkillVersionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid skill version input", details: z.treeifyError(parsed.error) }, 400);
    }
    if (options.pool && parsed.data.modelBinding.provider === "mock") {
      return c.json({ error: "The mock judge is only available in local demo mode. Configure a real judge provider first." }, 400);
    }

    const projectId = c.get("projectId");

    // Async gate (M0 C5a): with a queue wired, the version lands immediately
    // in `calibrating` (202) and the gate.run worker judges the golden set +
    // flips the status. The web client polls the recorded regression run.
    // Inline path below stays for demo/no-queue.
    if (options.queue) {
      let pending;
      try {
        pending = await repository.createSkillVersionPending(skillId, parsed.data, {
          projectId,
          actorUserId: c.get("user")?.id
        });
      } catch (error) {
        if (error instanceof DatasetRevisionConflictError) {
          return c.json({ error: error.message, code: "criterion_version_required" }, 409);
        }
        if (error instanceof RegressionGateUnavailableError) {
          return c.json({
            error: error.message,
            unavailableProvider: error.provider,
            availableProviders: judgeProviderAvailability(await projectKeyProviders(c.get("projectId")), !options.pool).filter((p) => p.available).map((p) => p.provider)
          }, 503);
        }
        throw error;
      }
      if (!pending.regressionDatasetRevisionId) {
        throw new DatasetRevisionConflictError(
          `Skill version ${pending.id} has no immutable regression dataset binding.`,
        );
      }
      await options.queue.send("gate.run", {
        projectId,
        skillVersionId: pending.id,
        datasetRevisionId: pending.regressionDatasetRevisionId,
        ...(parsed.data.overrideReason ? { overrideReason: parsed.data.overrideReason } : {}),
        ...(c.get("user")?.id ? { actorUserId: c.get("user")!.id } : {}),
        timeScope: parsed.data.timeScope
      }, { retryLimit: 5, retryBackoff: true });
      return c.json({ version: pending, regressionRun: null, queued: true }, 202);
    }

    let result;
    try {
      result = await repository.createSkillVersion(skillId, parsed.data, {
        projectId,
        actorUserId: c.get("user")?.id
      });
    } catch (error) {
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "criterion_version_required" }, 409);
      }
      // The gate refused (no usable provider credentials) or a provider call
      // failed mid-run — both are operational states the caller can act on,
      // not internal errors. The 503 carries what IS runnable so the editor
      // can offer "save with an available provider" instead of a dead end.
      if (error instanceof RegressionGateUnavailableError) {
        return c.json({
          error: error.message,
          unavailableProvider: error.provider,
          availableProviders: judgeProviderAvailability(await projectKeyProviders(c.get("projectId")), !options.pool).filter((p) => p.available).map((p) => p.provider)
        }, 503);
      }
      if (error instanceof RegressionGateJudgeError) return c.json({ error: error.message }, 502);
      throw error;
    }

    // Queue-less demo mode still records a real EvalRun and executes it
    // inline. The browser then observes exactly the same durable first-Result
    // lifecycle as a PostgreSQL installation instead of waiting forever for a
    // queue that does not exist.
    const timeScope = parsed.data.timeScope;
    let backfill: { timeScope: typeof timeScope; cases: number; enqueued: number; skipped: number } | undefined;
    if (
      (timeScope === "existing" || timeScope === "both") &&
      result.regressionRun.status !== "blocked"
    ) {
      let authorized = false;
      try {
        await repository.authorizeSkillVersionExecution({
          projectId,
          skillVersionId: result.version.id,
          context: "implicit_production",
          resourceKind: "regression_backfill",
          resourceId: result.regressionRun.id,
          idempotencyKey: `regression-backfill:${result.regressionRun.id}`
        });
        authorized = true;
      } catch {
        // Governed candidates are never executed through the legacy implicit
        // path. Their accepted lifecycle decides when evaluation is allowed.
      }
      if (authorized) {
        const backfillRun = await runExistingCaseBackfill(repository, projectId, result.version.id);
        if (backfillRun) {
          backfill = {
            timeScope,
            cases: backfillRun.run.totalItems,
            enqueued: 0,
            skipped: 0
          };
        }
      }
    }

    const status = result.regressionRun.status === "blocked" ? 409 : 201;
    return c.json({ ...result, ...(backfill ? { backfill } : {}) }, status);
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
      const apiKey = await repository.createApiKey({
        projectId,
        name: input.project.apiKeyName,
        createdByUserId: owner!.id
      });

      const response: AgentBootstrapResponse = {
        projectId,
        skillId: skill.id,
        skillVersionId: version.id,
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
          availableProviders: judgeProviderAvailability(await projectKeyProviders(c.get("projectId")), !options.pool).filter((p) => p.available).map((p) => p.provider)
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

    if (run.status !== "completed") {
      if (options.queue) {
        await repository.armEvalRunItemDeliveryDeadline(projectId, run.id);
        await options.queue.send("eval.run", { projectId, evalRunId: run.id }, { retryLimit: 5, retryBackoff: true });
      } else {
        // Queue-less (demo) mode judges inline before responding — the mock
        // provider is cheap and the caps are small. PG mode keeps 202-then-poll.
        await runEvalRunInline(repository, projectId, run.id);
      }
    }
    const current = (await repository.getEvalRun(projectId, run.id)) ?? run;

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

  // Datasets: named case collections for repeatable eval runs. Mutations are
  // owner-only (curation acts, matching review queues); reads are open to
  // project members.
  const requireOwner = async (c: Context<{ Variables: Variables }>, action: string): Promise<Response | null> => {
    if (!options.auth || !options.pool) return null;
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const role = await userProjectRole(options.pool, { userId: user.id, projectId: c.get("projectId") });
    if (role !== "owner") return c.json({ error: `Only owners can ${action}` }, 403);
    return null;
  };

  const traceTestError = (c: Context<{ Variables: Variables }>, error: unknown): Response | null => {
    if (error instanceof TraceTestSourceNotFoundError || error instanceof TraceTestNotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof TraceTestRevisionConflictError) {
      return c.json({
        error: error.message,
        expectedRevision: error.expectedRevision,
        currentRevision: error.currentRevision
      }, 409);
    }
    if (error instanceof TraceTestValidationNotReadyError) {
      return c.json({ error: error.message }, 409);
    }
    return null;
  };

  app.get("/api/trace-tests", async (c) => {
    const sourceCaseRef = c.req.query("sourceCaseId")?.trim();
    if (sourceCaseRef !== undefined && sourceCaseRef.length === 0) {
      return c.json({ error: "sourceCaseId cannot be empty" }, 400);
    }
    return c.json({
      tests: await repository.listTraceTests(c.get("projectId"), sourceCaseRef)
    });
  });

  app.post("/api/trace-tests/assist", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AssistTraceTestDraftInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid drafting request", details: z.treeifyError(parsed.error) }, 400);
    }
    const projectId = c.get("projectId");
    let detail;
    try {
      detail = await repository.getCaseDetail(
        projectId,
        parsed.data.sourceCaseId,
        parsed.data.skillVersionId
      );
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      throw error;
    }
    if (!detail) return c.json({ error: "Source conversation not found" }, 404);

    let evidence: ReturnType<typeof scopedTraceTestEvidence>;
    try {
      evidence = scopedTraceTestEvidence(detail.trace, parsed.data.sourceScope);
    } catch {
      return c.json({ error: "The selected source scope is no longer available. Return to the conversation and choose the response again." }, 409);
    }

    let assistedVersion;
    try {
      assistedVersion = parsed.data.skillVersionId
        ? await repository.getSkillVersion(projectId, parsed.data.skillVersionId)
        : (await repository.getCurrentSkill(projectId)).currentVersion;
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (!(error instanceof NoCurrentSkillError)) throw error;
      assistedVersion = null;
    }
    const binding = assistedVersion?.modelBinding;
    const provider = binding?.provider ?? null;
    if (!binding || !provider || provider === "mock") {
      return c.json({
        status: "unavailable",
        reason: "unsupported_provider",
        message: "Automatic drafting is unavailable for this project. The manual draft is ready instead."
      });
    }
    try {
      await repository.authorizeSkillVersionExecution({
        projectId,
        skillVersionId: assistedVersion!.id,
        context: "trace_test",
        resourceKind: "trace_test_draft",
        resourceId: parsed.data.sourceCaseId,
        idempotencyKey: `provider-start:trace-test-draft:${parsed.data.sourceCaseId}:${assistedVersion!.id}`
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : "Evaluator is not authorized for trace-test drafting.",
        code: "evaluator_not_authorized"
      }, 409);
    }
    const projectCredential = await repository.getJudgeProviderCredential(projectId, provider);
    const apiKey = resolveJudgeProviderApiKey(provider, projectCredential ?? undefined);
    if (!apiKey) {
      return c.json({
        status: "unavailable",
        reason: "missing_credentials",
        message: "Automatic drafting needs a provider key. The manual draft is ready instead."
      });
    }
    const draftRateKey = `trace-test-draft:${projectId}:${c.get("user")?.id ?? "demo"}`;
    if (!takeRateTokens(draftRateKey, 1)) {
      return c.json({
        error: `Automatic drafting rate limit exceeded: ${JUDGE_RATE_LIMIT_PER_MINUTE} requests/minute. The manual draft remains available.`
      }, 429);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRACE_TEST_DRAFT_TIMEOUT_MS);
    try {
      const raw = await (options.traceTestDraftGenerator ?? generateTraceTestDraft)({
        binding,
        apiKey,
        systemPrompt: TRACE_TEST_DRAFT_SYSTEM_PROMPT,
        userPrompt: buildTraceTestDraftPrompt({
          desiredBehavior: parsed.data.desiredBehavior,
          job: parsed.data.job,
          evidence
        }),
        signal: controller.signal,
        ...(provider === "openai" && openAIJudgeProviderBaseUrl()
          ? { baseUrl: openAIJudgeProviderBaseUrl() }
          : provider === "custom" && binding.baseUrl
            ? { baseUrl: binding.baseUrl }
            : {})
      });
      const content = parseAssistedTraceTestContent(raw);
      return c.json({
        status: "generated",
        content,
        sourceScope: parsed.data.sourceScope,
        draftProvenance: {
          origin: "generated",
          generatedFields: ["scenario", "expectedBehavior", "mustDo", "mustAvoid", "goodExample", "badExample", "checker"],
          generator: {
            provider,
            model: binding.modelId,
            version: binding.modelVersion
          }
        }
      });
    } catch (error) {
      const failure = error instanceof TraceTestDraftProviderError
        ? `${error.name}${error.status ? ` (${error.status})` : ""}`
        : error instanceof DOMException && error.name === "AbortError"
          ? "timeout"
          : "invalid provider response";
      // Never log provider output or parse details here: either can contain
      // source-derived customer content. Project/provider plus a bounded
      // failure class is enough for operations.
      console.warn(`Trace-test drafting failed for project ${projectId} using ${provider}: ${failure}`);
      return c.json({
        status: "unavailable",
        reason: "provider_error",
        message: "Automatic drafting could not finish. Your manual draft is ready and nothing was lost."
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post("/api/trace-tests", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTraceTestInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid test draft", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const test = await repository.createTraceTest({
        projectId: c.get("projectId"),
        ...parsed.data,
        ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
      });
      return c.json({ test }, 201);
    } catch (error) {
      const response = traceTestError(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/trace-tests/funnel-events", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = TraceTestFunnelEventInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid trace-to-test funnel event", details: z.treeifyError(parsed.error) }, 400);
    }
    const projectId = c.get("projectId");
    const actor = c.get("user")?.id ?? "demo";
    if (!takeRateTokens(`trace-test-funnel:${projectId}:${actor}`, 1)) {
      return c.json({ error: "Trace-to-test metrics rate limit exceeded" }, 429);
    }
    await repository.recordTraceTestFunnelEvent({
      projectId,
      ...parsed.data,
      ...(c.get("user")?.id ? { actorUserId: c.get("user")!.id } : {})
    });
    return c.body(null, 204);
  });

  app.get("/api/trace-tests/:traceTestId", async (c) => {
    const test = await repository.getTraceTest(c.get("projectId"), c.req.param("traceTestId"));
    if (!test) return c.json({ error: "Test not found" }, 404);
    return c.json({ test });
  });

  app.post("/api/trace-tests/:traceTestId/revisions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ReviseTraceTestInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid test revision", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const test = await repository.reviseTraceTest({
        projectId: c.get("projectId"),
        traceTestId: c.req.param("traceTestId"),
        ...parsed.data,
        ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
      });
      return c.json({ test }, 201);
    } catch (error) {
      const response = traceTestError(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/trace-tests/:traceTestId/checks", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RunTraceTestValidationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid check request", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const projectId = c.get("projectId");
      const traceTestId = c.req.param("traceTestId");
      const test = await repository.getTraceTest(projectId, traceTestId);
      if (!test) return c.json({ error: "Test not found in this project" }, 404);
      if (test.currentRevision !== parsed.data.revision) {
        return c.json({
          error: `Test changed from revision ${parsed.data.revision} to ${test.currentRevision}`,
          expectedRevision: parsed.data.revision,
          currentRevision: test.currentRevision
        }, 409);
      }
      const revision = test.revisions.find((candidate) => candidate.revision === parsed.data.revision);
      if (!revision) return c.json({ error: "The current draft revision is unavailable" }, 409);
      if (revision.checker.kind !== "judge") {
        return c.json({ error: "This draft uses manual review. Confirm both examples and add your reason instead." }, 409);
      }

      const { badOutput, goodOutput } = traceTestValidationExamples(test, revision);
      const recordUnavailable = async (note: string) => repository.recordTraceTestValidation({
        projectId,
        traceTestId,
        revision: revision.revision,
        badEvidence: { output: badOutput, result: "unavailable", note },
        goodEvidence: { output: goodOutput, result: "unavailable", note },
        method: "automated",
        diagnostic: "unavailable",
        badAttempts: 0,
        goodAttempts: 0,
        ...(c.get("user")?.id ? { recordedByUserId: c.get("user")!.id } : {})
      });

      if (!hasUsableTraceTestExample(badOutput) || !hasUsableTraceTestExample(goodOutput)) {
        const validation = await recordUnavailable("Add both a should-fail response and a should-pass response before checking this test.");
        return c.json({ validation }, 201);
      }

      let validationVersion;
      try {
        validationVersion = parsed.data.skillVersionId
          ? await repository.getSkillVersion(projectId, parsed.data.skillVersionId)
          : (await repository.getCurrentSkill(projectId)).currentVersion;
      } catch (error) {
        if (error instanceof AmbiguousProjectSkillError) {
          return c.json({ error: error.message, code: "skill_version_required" }, 409);
        }
        if (!(error instanceof NoCurrentSkillError)) throw error;
        validationVersion = null;
      }
      const binding = validationVersion?.modelBinding;
      const provider = binding?.provider ?? null;
      if (!binding || !provider || provider === "mock") {
        const validation = await recordUnavailable("An AI checker is not configured for this project. Review the examples manually instead.");
        return c.json({ validation }, 201);
      }
      try {
        await repository.authorizeSkillVersionExecution({
          projectId,
          skillVersionId: validationVersion!.id,
          context: "trace_test",
          resourceKind: "trace_test_validation",
          resourceId: `${traceTestId}:${revision.revision}`,
          idempotencyKey: `provider-start:trace-test-validation:${traceTestId}:${revision.revision}:${validationVersion!.id}`
        });
      } catch (error) {
        return c.json({
          error: error instanceof Error ? error.message : "Evaluator is not authorized for trace-test validation.",
          code: "evaluator_not_authorized"
        }, 409);
      }
      const projectCredential = await repository.getJudgeProviderCredential(projectId, provider);
      const apiKey = resolveJudgeProviderApiKey(provider, projectCredential ?? undefined);
      if (!apiKey) {
        const validation = await recordUnavailable("The AI checker has no provider key. Review the examples manually instead.");
        return c.json({ validation }, 201);
      }
      const validationRateKey = `trace-test-validation:${projectId}:${c.get("user")?.id ?? "demo"}`;
      // Reserve the worst case up front: two examples, each with one retry.
      if (!takeRateTokens(validationRateKey, TRACE_TEST_VALIDATION_RATE_TOKENS)) {
        return c.json({ error: "Automatic check rate limit exceeded. Review the examples manually or retry shortly." }, 429);
      }
      const result = await validateTraceTestPair({
        revision,
        binding,
        apiKey,
        badOutput,
        goodOutput,
        timeoutMs: TRACE_TEST_VALIDATION_TIMEOUT_MS,
        maxAttempts: TRACE_TEST_VALIDATION_MAX_ATTEMPTS,
        ...(options.traceTestValidationRunner ? { runner: options.traceTestValidationRunner } : {}),
        ...(provider === "openai" && openAIJudgeProviderBaseUrl()
          ? { baseUrl: openAIJudgeProviderBaseUrl() }
          : provider === "custom" && binding.baseUrl
            ? { baseUrl: binding.baseUrl }
            : {})
      });
      const validation = await repository.recordTraceTestValidation({
        projectId,
        traceTestId,
        revision: revision.revision,
        badEvidence: result.badEvidence,
        goodEvidence: result.goodEvidence,
        method: "automated",
        diagnostic: result.diagnostic,
        evaluator: { provider, model: binding.modelId, version: binding.modelVersion },
        badAttempts: result.badAttempts,
        goodAttempts: result.goodAttempts,
        badUsage: result.badUsage,
        goodUsage: result.goodUsage,
        ...(c.get("user")?.id ? { recordedByUserId: c.get("user")!.id } : {})
      });
      return c.json({ validation }, 201);
    } catch (error) {
      const response = traceTestError(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/trace-tests/:traceTestId/validations", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RecordManualTraceTestValidationInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid manual validation evidence", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const projectId = c.get("projectId");
      const traceTestId = c.req.param("traceTestId");
      const test = await repository.getTraceTest(projectId, traceTestId);
      if (!test) return c.json({ error: "Test not found in this project" }, 404);
      if (test.currentRevision !== parsed.data.revision) {
        return c.json({
          error: `Test changed from revision ${parsed.data.revision} to ${test.currentRevision}`,
          expectedRevision: parsed.data.revision,
          currentRevision: test.currentRevision
        }, 409);
      }
      const revision = test.revisions.find((candidate) => candidate.revision === parsed.data.revision);
      if (!revision) return c.json({ error: "The current draft revision is unavailable" }, 409);
      const { badOutput, goodOutput } = traceTestValidationExamples(test, revision);
      if (!hasUsableTraceTestExample(badOutput) || !hasUsableTraceTestExample(goodOutput)) {
        return c.json({ error: "Add both a should-fail response and a should-pass response before confirming this test." }, 409);
      }
      const validation = await repository.recordTraceTestValidation({
        projectId,
        traceTestId,
        revision: revision.revision,
        badEvidence: { output: badOutput, result: parsed.data.badResult, note: parsed.data.overrideReason },
        goodEvidence: { output: goodOutput, result: parsed.data.goodResult, note: parsed.data.overrideReason },
        method: "manual_override",
        overrideReason: parsed.data.overrideReason,
        badAttempts: 0,
        goodAttempts: 0,
        ...(c.get("user")?.id ? { recordedByUserId: c.get("user")!.id } : {})
      });
      return c.json({ validation }, 201);
    } catch (error) {
      const response = traceTestError(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/api/trace-tests/:traceTestId/enable", async (c) => {
    const denied = await requireOwner(c, "enable tests");
    if (denied) return denied;
    const reviewerUserId = c.get("user")?.id;
    // Demo mode has no identities. A Postgres-backed app must never turn that
    // demo fallback into forged review provenance if auth was miswired.
    if (options.pool && !reviewerUserId) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = EnableTraceTestInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid enable request", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const test = await repository.enableTraceTest({
        projectId: c.get("projectId"),
        traceTestId: c.req.param("traceTestId"),
        ...parsed.data,
        reviewedByUserId: reviewerUserId ?? "demo-reviewer"
      });
      return c.json({ test });
    } catch (error) {
      const response = traceTestError(c, error);
      if (response) return response;
      throw error;
    }
  });

  app.get("/api/datasets", async (c) => {
    return c.json({ datasets: await repository.listDatasets(c.get("projectId")) });
  });

  app.post("/api/datasets", async (c) => {
    const denied = await requireOwner(c, "create datasets");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateDatasetInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const dataset = await repository.createDataset({
        projectId: c.get("projectId"),
        name: parsed.data.name,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
      });
      return c.json({ dataset }, 201);
    } catch (error) {
      if (error instanceof DatasetNameTakenError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.get("/api/datasets/:datasetId", async (c) => {
    const detail = await repository.getDatasetDetail(c.get("projectId"), c.req.param("datasetId"));
    if (!detail) return c.json({ error: "Dataset not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/datasets/:datasetId/revisions", async (c) => {
    const projectId = c.get("projectId");
    const datasetId = c.req.param("datasetId");
    const dataset = await repository.getDatasetDetail(projectId, datasetId);
    if (!dataset) return c.json({ error: "Dataset not found" }, 404);
    return c.json({
      collection: { ...dataset, mutability: "working_collection" as const },
      revisions: await repository.listDatasetRevisions(projectId, datasetId)
    });
  });

  app.post("/api/datasets/:datasetId/revisions", async (c) => {
    const denied = await requireOwner(c, "freeze dataset revisions");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateDatasetRevisionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset revision input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const revision = await repository.createDatasetRevision({
        projectId: c.get("projectId"),
        datasetId: c.req.param("datasetId"),
        ...parsed.data,
        ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
      });
      return c.json({ revision }, 201);
    } catch (error) {
      if (error instanceof DatasetNotFoundError) return c.json({ error: error.message }, 404);
      if (error instanceof SealedValidationUnavailableError) {
        return c.json({ error: error.message, code: "sealed_validation_unavailable" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.get("/api/dataset-revisions/:revisionId/metadata", async (c) => {
    const revision = (await repository.listDatasetRevisions(c.get("projectId")))
      .find((candidate) => candidate.id === c.req.param("revisionId"));
    if (!revision) return c.json({ error: "Dataset revision not found" }, 404);
    // Metadata-only by contract: no payload bytes and no content-view exposure
    // event. This is safe for progress denominators and sealed identities.
    return c.json({ revision });
  });

  app.get("/api/dataset-revisions/:revisionId", async (c) => {
    const projectId = c.get("projectId");
    const revisionId = c.req.param("revisionId");
    const metadata = (await repository.listDatasetRevisions(projectId)).find((revision) => revision.id === revisionId);
    if (!metadata) return c.json({ error: "Dataset revision not found" }, 404);
    if (metadata.role === "sealed_validation") {
      return c.json({ error: "Sealed validation contents are unavailable on the ordinary session API." }, 403);
    }
    if (metadata.sourceKind === "analysis_population") {
      return c.json({
        error: "Analysis population contents are available only through the governed Analyze API.",
        code: "analysis_population_content_route_required"
      }, 403);
    }
    await repository.recordDatasetRevisionContentView({
      projectId,
      revisionId,
      ...(c.get("user")?.id ? { actorUserId: c.get("user")!.id } : {})
    });
    const revision = await repository.getDatasetRevisionDetail(projectId, revisionId);
    if (!revision) return c.json({ error: "Dataset revision not found" }, 404);
    return c.json({ revision });
  });

  app.post("/api/datasets/:datasetId/items", async (c) => {
    const denied = await requireOwner(c, "edit datasets");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = AddDatasetItemsInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset items input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const items = await repository.addDatasetItems({
        projectId: c.get("projectId"),
        datasetId: c.req.param("datasetId"),
        items: parsed.data.items
      });
      return c.json({ items }, 201);
    } catch (error) {
      if (error instanceof DatasetNotFoundError) return c.json({ error: error.message }, 404);
      if (error instanceof CaseNotFoundError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // Skill Bench ingestion: paste examples as content. Each item mints a manual
  // case (or content-dedups into an existing one) and lands in the dataset
  // with its expected label. Two deliberate differences from trace import:
  //  - sourceTraceId is a hash of (input, output), so re-pasting an unchanged
  //    example dedups cleanly while an EDITED example becomes a fresh case —
  //    the id-based dedup would silently reuse the stale payload;
  //  - nothing is auto-judged here (no judge.run enqueue). Bench judging
  //    happens only through explicit eval runs, so pasting 200 examples never
  //    burns 200 provider calls against a placeholder rubric.
  app.post("/api/datasets/:datasetId/examples", async (c) => {
    const denied = await requireOwner(c, "edit datasets");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = ImportDatasetExamplesInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset examples input", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const datasetId = c.req.param("datasetId");

    // Coalesce within-batch duplicates by content hash BEFORE the repository
    // call: identical content = identical sourceTraceId = the same case, and
    // the last LABELED occurrence wins (a label-less duplicate must not erase
    // an earlier duplicate's label — mirrors the storage upsert). Collapsed
    // occurrences count as "reused" so the response semantics are unchanged.
    type CoalescedExample = {
      sourceTraceId: string;
      input: unknown;
      output: unknown;
      metadata: Record<string, unknown>;
      steps?: TraceStep[];
      expectedLabel?: "pass" | "fail";
      expectedFailStep?: number;
      note?: string;
    };
    const bySource = new Map<string, CoalescedExample>();
    const order: string[] = [];
    for (const item of parsed.data.items) {
      // Steps join the hash only when present: an edited step must mint a new
      // case, while every pre-M2 (step-less) example keeps its exact hash and
      // therefore its existing case.
      const contentHash = createHash("sha256")
        .update(JSON.stringify({
          input: item.input ?? null,
          output: item.output ?? null,
          ...(item.steps ? { steps: item.steps } : {})
        }))
        .digest("hex")
        .slice(0, 32);
      const sourceTraceId = `ex_${contentHash}`;
      const prior = bySource.get(sourceTraceId);
      if (!prior) order.push(sourceTraceId);
      const expectedLabel = item.expectedLabel ?? prior?.expectedLabel;
      // Same invariant as the storage upsert: this item's explicit pass
      // clears any prior step; a fail without a step keeps the prior one.
      const expectedFailStep = item.expectedLabel === "pass"
        ? undefined
        : item.expectedFailStep ?? prior?.expectedFailStep;
      const note = item.note ?? prior?.note;
      bySource.set(sourceTraceId, {
        sourceTraceId,
        input: item.input,
        output: item.output,
        metadata: item.name ? { name: item.name } : prior?.metadata ?? {},
        ...(item.steps ? { steps: item.steps } : {}),
        ...(expectedLabel ? { expectedLabel } : {}),
        ...(expectedFailStep !== undefined ? { expectedFailStep } : {}),
        ...(note ? { note } : {})
      });
    }
    const collapsedDuplicates = parsed.data.items.length - order.length;

    // Cases + dataset membership land atomically (M0 C2) — a mid-flow failure
    // rolls everything back instead of stranding membership-less cases.
    let imported;
    try {
      imported = await repository.importDatasetExamples({
        projectId,
        datasetId,
        ingestionPurpose: "dataset_example",
        items: order.map((sourceTraceId) => bySource.get(sourceTraceId)!)
      });
    } catch (error) {
      if (error instanceof DatasetNotFoundError) return c.json({ error: "Dataset not found" }, 404);
      if (error instanceof CaseNotFoundError) return c.json({ error: error.message }, 400);
      throw error;
    }

    return c.json({
      items: imported.items.map((item) => ({
        caseId: item.caseId,
        datasetItemId: item.datasetItemId,
        created: item.created
      })),
      reusedCount: collapsedDuplicates + imported.items.filter((item) => !item.created).length,
      // Route-built metadata is never coeval-internal, so the anti-recursion
      // skip can't fire on this path; the field stays for schema stability.
      skippedCount: 0
    }, 201);
  });

  app.delete("/api/datasets/:datasetId/items/:itemId", async (c) => {
    const denied = await requireOwner(c, "edit datasets");
    if (denied) return denied;
    const removed = await repository.removeDatasetItem(c.get("projectId"), c.req.param("datasetId"), c.req.param("itemId"));
    if (!removed) return c.json({ error: "Dataset item not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/datasets/:datasetId/archive", async (c) => {
    const denied = await requireOwner(c, "archive datasets");
    if (denied) return denied;
    const archived = await repository.archiveDataset(c.get("projectId"), c.req.param("datasetId"));
    if (!archived) return c.json({ error: "Dataset not found" }, 404);
    return c.json({ ok: true });
  });

  // The ONE dataset→eval-run path, split into create + dispatch phases:
  // creation snapshots the dataset's items into a run row (no tokens spent);
  // dispatch fans out through the queue (PG mode) or judges inline (demo) —
  // that's the provider-spending step. POST /api/eval-runs starts runs via
  // startDatasetEvalRun (create + dispatch back-to-back); POST
  // /api/run-comparisons persists both runs and the comparison row BEFORE
  // dispatching either, so a midway failure never orphans a spending run.
  // The comparison feature must never grow a second fan-out.
  const createDatasetEvalRun = async (input: {
    projectId: string;
    dataset: DatasetDetail;
    skillVersionId: string;
    createdByUserId?: string | undefined;
    sourceTraceTest?: TraceTestRunSource | undefined;
  }): Promise<EvalRun> =>
    repository.createEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "manual",
      datasetId: input.dataset.id,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.sourceTraceTest ? { sourceTraceTest: input.sourceTraceTest } : {}),
      items: input.dataset.items.map((item) => ({
        caseId: item.caseId,
        datasetItemId: item.id,
        ...(item.expectedLabel ? { expectedLabel: item.expectedLabel } : {}),
        ...(item.expectedFailStep !== null ? { expectedFailStep: item.expectedFailStep } : {})
      }))
    });

  const createDatasetRevisionEvalRun = async (input: {
    projectId: string;
    revision: DatasetRevisionDetail;
    skillVersionId: string;
    createdByUserId?: string | undefined;
  }): Promise<EvalRun> => {
    if (input.revision.role === "sealed_validation") {
      throw new SealedValidationUnavailableError();
    }
    if (input.revision.sourceKind === "analysis_population") {
      throw new DatasetRevisionConflictError(
        "Analysis population revisions cannot run through the ordinary evaluation path"
      );
    }
    const items = input.revision.items.map((item) => {
      if (!item.sourceCaseId) {
        throw new DatasetRevisionConflictError(`Dataset revision item ${item.id} has no judgeable case identity`);
      }
      return {
        caseId: item.sourceCaseId,
        datasetRevisionItemId: item.id,
        ...(item.referenceLabel ? { expectedLabel: item.referenceLabel } : {}),
        ...(item.referenceFailStep !== null ? { expectedFailStep: item.referenceFailStep } : {})
      };
    });
    return repository.createEvalRun({
      projectId: input.projectId,
      skillVersionId: input.skillVersionId,
      trigger: "manual",
      datasetRevisionId: input.revision.id,
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      items
    });
  };

  const dispatchEvalRun = async (
    projectId: string,
    run: EvalRun,
    queueOptions: QueueSendOptions = {}
  ): Promise<EvalRun> => {
    if (options.queue) {
      // Arm the domain recovery lease before the external queue write. A
      // process death after send can then be reconciled even if eval.run dies
      // before its handler starts.
      await repository.armEvalRunItemDeliveryDeadline(projectId, run.id);
      await options.queue.send("eval.run", { projectId, evalRunId: run.id }, {
        retryLimit: 5,
        retryBackoff: true,
        ...queueOptions
      });
    } else {
      await runEvalRunInline(repository, projectId, run.id);
    }
    return (await repository.getEvalRun(projectId, run.id)) ?? run;
  };

  const startDatasetEvalRun = async (input: {
    projectId: string;
    dataset: DatasetDetail;
    skillVersionId: string;
    createdByUserId?: string | undefined;
    sourceTraceTest?: TraceTestRunSource | undefined;
  }): Promise<EvalRun> => {
    const run = await createDatasetEvalRun(input);
    return dispatchEvalRun(input.projectId, run);
  };

  const startDatasetRevisionEvalRun = async (input: {
    projectId: string;
    revision: DatasetRevisionDetail;
    skillVersionId: string;
    createdByUserId?: string | undefined;
  }): Promise<EvalRun> => {
    const run = await createDatasetRevisionEvalRun(input);
    return dispatchEvalRun(input.projectId, run);
  };

  // Beginner trace-to-test path: materialize the enabled test's retained,
  // redacted source as one stable dataset case, then use the normal eval-run
  // machinery. Re-running creates history without duplicating suite items.
  app.post("/api/trace-tests/:traceTestId/runs", async (c) => {
    const denied = await requireOwner(c, "run tests");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = StartTraceTestRunInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "Invalid test-run request", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const traceTestId = c.req.param("traceTestId");
    const test = await repository.getTraceTest(projectId, traceTestId);
    if (!test) return c.json({ error: "Test not found in this project" }, 404);
    if (test.enabledRevision === null) {
      return c.json({ error: "Enable this test before running it." }, 409);
    }
    const revision = test.revisions.find((candidate) => candidate.revision === test.enabledRevision);
    if (!revision || revision.lifecycle !== "enabled" || revision.validationId === null || revision.validatedRevision === null) {
      return c.json({ error: "The enabled test revision is unavailable. Review and enable it again." }, 409);
    }
    const source = TraceTestSourceSnapshotSchema.safeParse(test.sourceSnapshot);
    if (!source.success) {
      return c.json({ error: "The retained source conversation cannot be run." }, 409);
    }

    const resolvedVersion = await resolveSkillVersionId(projectId, undefined, {
      context: "trace_test", resourceKind: "trace_test", resourceId: traceTestId
    });
    if ("invalid" in resolvedVersion) return c.json({ error: resolvedVersion.invalid }, 400);

    let dataset: DatasetDetail | null = null;
    if (parsed.data.datasetId) {
      dataset = await repository.getDatasetDetail(projectId, parsed.data.datasetId);
      if (!dataset || dataset.archivedAt) return c.json({ error: "Dataset not found" }, 404);
    } else {
      const existing = (await repository.listDatasets(projectId))
        .find((candidate) => candidate.name === TRACE_TEST_DATASET_NAME);
      let datasetId = existing?.id;
      if (!datasetId) {
        try {
          datasetId = (await repository.createDataset({
            projectId,
            name: TRACE_TEST_DATASET_NAME,
            description: "Enabled tests saved from real conversations.",
            ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
          })).id;
        } catch (error) {
          if (!(error instanceof DatasetNameTakenError)) throw error;
          datasetId = (await repository.listDatasets(projectId))
            .find((candidate) => candidate.name === TRACE_TEST_DATASET_NAME)?.id;
        }
      }
      if (!datasetId) throw new Error("Regression test dataset vanished during creation");
      dataset = await repository.getDatasetDetail(projectId, datasetId);
      if (!dataset) throw new Error("Regression test dataset vanished after creation");
    }

    const expectedLabel = revision.checker.metadata.journeyJob === "preserve" ? "pass" : "fail";
    const imported = await repository.importDatasetExamples({
      projectId,
      datasetId: dataset.id,
      ingestionPurpose: "trace_test_synthetic",
      items: [{
        sourceTraceId: `trace-test:${traceTestId}:revision:${revision.revision}`,
        input: source.data.input,
        output: source.data.output,
        metadata: {
          ...Object.fromEntries(Object.entries(source.data.metadata ?? {}).filter(([key]) => key !== "coeval")),
          traceTest: { id: traceTestId, revision: revision.revision, validationId: revision.validationId }
        },
        ...(source.data.steps ? { steps: source.data.steps } : {}),
        expectedLabel,
        note: `Trace test · ${revision.scenario}`
      }]
    });
    const materialized = imported.items[0];
    if (!materialized?.datasetItemId) throw new Error("Trace test case was not added to its dataset");
    const refreshedDataset = await repository.getDatasetDetail(projectId, dataset.id);
    if (!refreshedDataset) throw new Error("Trace test dataset vanished before run creation");

    const sourceTraceTest: TraceTestRunSource = {
      traceTestId,
      revision: revision.revision,
      validationRevision: revision.validatedRevision,
      validationId: revision.validationId,
      sourceCaseRef: test.sourceCaseRef,
      caseId: materialized.caseId,
      datasetItemId: materialized.datasetItemId
    };
    const started = await startDatasetEvalRun({
      projectId,
      dataset: refreshedDataset,
      skillVersionId: resolvedVersion.id,
      sourceTraceTest,
      createdByUserId: c.get("user")?.id
    });
    const run = await repository.getEvalRunDetail(projectId, started.id);
    if (!run) throw new Error(`Eval run vanished after dispatch: ${started.id}`);
    return c.json({ dataset: refreshedDataset, run, outcome: traceTestRunOutcome(run) }, 202);
  });

  // Run the pinned evaluator on exactly one adjudicated case it has not yet
  // covered. The server selects the case again at mutation time, so a stale UI
  // cannot spend tokens on an unrelated or already-covered latest-version
  // disagreement.
  app.post("/api/skills/:skillId/versions/:versionId/convergence/runs", async (c) => {
    const denied = await requireOwner(c, "run an uncovered adjudicated case");
    if (denied) return denied;
    const projectId = c.get("projectId");
    const skillId = c.req.param("skillId");
    const versionId = c.req.param("versionId");
    const version = await repository.getSkillVersion(projectId, versionId);
    if (!version || version.skillId !== skillId) {
      return c.json({ error: "Skill version not found" }, 404);
    }
    const resolvedVersion = await resolveSkillVersionId(projectId, versionId, {
      context: "explicit_nonproduction_dataset",
      resourceKind: "convergence_case",
      resourceId: versionId
    });
    if ("invalid" in resolvedVersion) return c.json({ error: resolvedVersion.invalid }, 400);

    const page = await repository.getConvergenceAudit(projectId, skillId, versionId, { limit: 1 });
    const caseId = page.nextUncoveredCaseId;
    if (!caseId) {
      return c.json({ error: "This evaluator version already covers every recorded legacy adjudication." }, 409);
    }
    const claimed = await repository.createConvergenceEvalRun({
      projectId,
      skillVersionId: resolvedVersion.id,
      ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {}),
      caseId
    });
    // The active eval_run is the durable outbox record. A database claim lets
    // exactly one HTTP request send its persisted deterministic pg-boss job
    // id. If the process crashes between send and acknowledgement, reclaiming
    // the lease reuses that job id and pg-boss's primary key rejects a second
    // job regardless of wall-clock slot boundaries.
    let started: EvalRun = claimed.run;
    if (options.queue) {
      const dispatchToken = randomUUID();
      const dispatch = await repository.claimEvalRunDispatch({
        projectId,
        evalRunId: claimed.run.id,
        dispatchToken
      });
      if (dispatch.state === "busy") {
        c.header("Retry-After", "300");
        return c.json({
          error: "This run has not been durably queued yet. Retry this request.",
          run: claimed.run,
          caseId
        }, 503);
      }
      if (dispatch.state === "claimed") {
        try {
          started = await dispatchEvalRun(projectId, claimed.run, { id: dispatch.jobId });
          await repository.markEvalRunDispatched({ projectId, evalRunId: claimed.run.id, dispatchToken });
        } catch (error) {
          await repository.releaseEvalRunDispatch({ projectId, evalRunId: claimed.run.id, dispatchToken });
          throw error;
        }
      }
    } else if (claimed.created) {
      started = await dispatchEvalRun(projectId, claimed.run);
    }
    return c.json({ run: started, caseId }, 202);
  });

  // Eval runs over a dataset. Owner-only: a run spends provider tokens
  // (matching the skill-edit gate, the other provider-spending session act).
  app.post("/api/eval-runs", async (c) => {
    const denied = await requireOwner(c, "start eval runs");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateEvalRunInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid eval-run input", details: z.treeifyError(parsed.error) }, 400);
    }
    const projectId = c.get("projectId");
    const resolvedVersion = await resolveSkillVersionId(projectId, parsed.data.skillVersionId, {
      context: "explicit_nonproduction_dataset",
      resourceKind: parsed.data.datasetId ? "dataset" : "dataset_revision",
      resourceId: parsed.data.datasetId ?? parsed.data.datasetRevisionId!
    });
    if ("invalid" in resolvedVersion) return c.json({ error: resolvedVersion.invalid }, 400);

    if (parsed.data.datasetId) {
      const dataset = await repository.getDatasetDetail(projectId, parsed.data.datasetId);
      if (!dataset || dataset.archivedAt) return c.json({ error: "Dataset not found" }, 404);
      if (dataset.items.length === 0) return c.json({ error: "Dataset has no items to judge." }, 400);
      const run = await startDatasetEvalRun({
        projectId,
        dataset,
        skillVersionId: resolvedVersion.id,
        createdByUserId: c.get("user")?.id
      });
      return c.json({ run }, 202);
    }

    const revisionId = parsed.data.datasetRevisionId!;
    const revisionMetadata = (await repository.listDatasetRevisions(projectId))
      .find((revision) => revision.id === revisionId);
    if (revisionMetadata?.sourceKind === "analysis_population") {
      return c.json({
        error: "Analysis population revisions cannot run through the ordinary eval endpoint.",
        code: "analysis_population_eval_unavailable"
      }, 409);
    }
    const revision = await repository.getDatasetRevisionDetail(projectId, revisionId);
    if (!revision) return c.json({ error: "Dataset revision not found" }, 404);
    if (revision.items.length === 0) return c.json({ error: "Dataset revision has no items to judge." }, 400);
    try {
      const run = await startDatasetRevisionEvalRun({
        projectId,
        revision,
        skillVersionId: resolvedVersion.id,
        createdByUserId: c.get("user")?.id
      });
      return c.json({ run }, 202);
    } catch (error) {
      if (error instanceof SealedValidationUnavailableError || error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof DatasetRevisionNotFoundError) return c.json({ error: error.message }, 404);
      throw error;
    }
  });

  // First-Result continuation: idempotently materialize a durable backfill
  // run for one saved Check. This covers the equally valid order where the
  // user created the Check before bringing a Run; imported judge jobs alone
  // do not expose enough lifecycle state for beginner onboarding.
  app.post("/api/skills/:skillId/versions/:versionId/backfill", async (c) => {
    const denied = await requireOwner(c, "start the first Result evaluation");
    if (denied) return denied;
    const projectId = c.get("projectId");
    const version = await repository.getSkillVersion(projectId, c.req.param("versionId"));
    if (!version || version.skillId !== c.req.param("skillId")) {
      return c.json({ error: "Check version not found" }, 404);
    }
    try {
      await assertImportJudgingAllowed(repository, projectId, version.id);
    } catch (error) {
      if (!(error instanceof ImportSkillVersionBindingError)) throw error;
      return c.json({ error: "Only the current runnable Check can produce the first Result." }, 409);
    }
    if ((await repository.listCaseIdsForProject(projectId, 1)).length === 0) {
      return c.json({ error: "Add a recorded Run before asking for the first Result." }, 409);
    }
    try {
      await repository.authorizeSkillVersionExecution({
        projectId,
        skillVersionId: version.id,
        context: "implicit_production",
        resourceKind: "onboarding_first_result",
        resourceId: version.id,
        idempotencyKey: `onboarding-first-result:${version.id}`
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : "This Check is not available for evaluation."
      }, 409);
    }
    const existingBackfill = (await repository.listEvalRuns(projectId, {
      limit: 100,
      skillVersionId: version.id
    })).find((run) => run.trigger === "backfill");
    if (existingBackfill) {
      const resumed = await runExistingCaseBackfill(repository, projectId, version.id, options.queue);
      const detail = resumed
        ? await repository.getEvalRunDetail(projectId, resumed.run.id)
        : null;
      if (!detail) throw new Error(`Backfill run vanished after creation: ${existingBackfill.id}`);
      if (resumed?.dispatchState === "busy") {
        c.header("Retry-After", "300");
        return c.json({
          error: "The Result run is saved but not durably queued yet. Retry this request.",
          run: detail
        }, 503);
      }
      return c.json({ run: detail }, detail.status === "pending" || detail.status === "running" ? 202 : 200);
    }
    const existingResult = await repository.listVerdicts({
      projectId,
      source: "llm_judge",
      skillVersionId: version.id,
      evidenceScope: "customer",
      limit: 1
    });
    if (existingResult[0]) return c.json({ run: null, existingResult: true }, 200);
    const backfill = await runExistingCaseBackfill(repository, projectId, version.id, options.queue);
    if (!backfill) return c.json({ error: "Add a recorded Run before asking for the first Result." }, 409);
    const detail = await repository.getEvalRunDetail(projectId, backfill.run.id);
    if (!detail) throw new Error(`Backfill run vanished after creation: ${backfill.run.id}`);
    if (backfill.dispatchState === "busy") {
      c.header("Retry-After", "300");
      return c.json({
        error: "The Result run is saved but not durably queued yet. Retry this request.",
        run: detail
      }, 503);
    }
    return c.json({ run: detail }, detail.status === "pending" || detail.status === "running" ? 202 : 200);
  });

  app.get("/api/eval-runs", async (c) => {
    const parsed = z.object({ limit: z.coerce.number().int().positive().max(100).default(50) })
      .safeParse({ limit: c.req.query("limit") ?? undefined });
    if (!parsed.success) {
      return c.json({ error: "Invalid eval-run query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({ runs: await repository.listEvalRuns(c.get("projectId"), { limit: parsed.data.limit }) });
  });

  app.get("/api/eval-runs/:evalRunId", async (c) => {
    const detail = await repository.getEvalRunDetail(c.get("projectId"), c.req.param("evalRunId"));
    if (!detail) return c.json({ error: "Eval run not found" }, 404);
    return c.json(detail);
  });

  // Run comparisons (Incident Bisect): freeze the working collection once,
  // judge that immutable revision with TWO versions, then diff case by case.
  // Owner-only like eval runs — it spends provider tokens twice. Both runs use
  // the same create + dispatch phases as a manual run, but all three rows (run
  // A, run B, the comparison) are persisted before either run fans out.
  app.post("/api/run-comparisons", async (c) => {
    const denied = await requireOwner(c, "start run comparisons");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateRunComparisonInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid run-comparison input", details: z.treeifyError(parsed.error) }, 400);
    }
    if (parsed.data.versionAId === parsed.data.versionBId) {
      return c.json({ error: "Pick two different skill versions to compare." }, 400);
    }
    const projectId = c.get("projectId");
    const dataset = await repository.getDatasetDetail(projectId, parsed.data.datasetId);
    if (!dataset || dataset.archivedAt) return c.json({ error: "Dataset not found" }, 404);
    if (dataset.items.length === 0) return c.json({ error: "Dataset has no items to judge." }, 400);
    const resolvedA = await resolveSkillVersionId(projectId, parsed.data.versionAId, {
      context: "explicit_nonproduction_dataset", resourceKind: "run_comparison", resourceId: `${parsed.data.datasetId}:a`
    });
    if ("invalid" in resolvedA) return c.json({ error: resolvedA.invalid }, 400);
    const resolvedB = await resolveSkillVersionId(projectId, parsed.data.versionBId, {
      context: "explicit_nonproduction_dataset", resourceKind: "run_comparison", resourceId: `${parsed.data.datasetId}:b`
    });
    if ("invalid" in resolvedB) return c.json({ error: resolvedB.invalid }, 400);

    const createdByUserId = c.get("user")?.id;
    let revision: DatasetRevisionDetail;
    try {
      revision = await repository.createDatasetRevision({
        projectId,
        datasetId: dataset.id,
        role: "iterative_development",
        reuseLatestContent: true,
        ...(createdByUserId ? { createdByUserId } : {})
      });
    } catch (error) {
      if (error instanceof SealedValidationUnavailableError || error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
    // Create phase: persist run A, run B, and the comparison row before any
    // fan-out — no provider tokens are spent until all three rows exist. If a
    // later creation throws, the earlier still-undispatched run(s) are
    // deleted best-effort: a run that never fanned out has no verdicts, so
    // removing it keeps append-only intact instead of stranding a
    // forever-pending run in the eval-runs history.
    const runA = await createDatasetRevisionEvalRun({ projectId, revision, skillVersionId: resolvedA.id, createdByUserId });
    let runB: EvalRun | undefined;
    let comparison: RunComparison;
    try {
      runB = await createDatasetRevisionEvalRun({ projectId, revision, skillVersionId: resolvedB.id, createdByUserId });
      comparison = await repository.createRunComparison({
        projectId,
        datasetId: dataset.id,
        datasetRevisionId: revision.id,
        versionAId: resolvedA.id,
        versionBId: resolvedB.id,
        runAId: runA.id,
        runBId: runB.id
      });
    } catch (error) {
      const createdRunIds = [runA.id, ...(runB ? [runB.id] : [])];
      await Promise.allSettled(createdRunIds.map((runId) => repository.deleteUndispatchedEvalRun(projectId, runId)));
      throw error;
    }
    // Dispatch phase: fan out both runs now that the pairing is on record.
    await dispatchEvalRun(projectId, runA);
    await dispatchEvalRun(projectId, runB);
    return c.json({ comparison }, 202);
  });

  app.get("/api/run-comparisons", async (c) => {
    const parsed = z.object({ limit: z.coerce.number().int().positive().max(100).default(50) })
      .safeParse({ limit: c.req.query("limit") ?? undefined });
    if (!parsed.success) {
      return c.json({ error: "Invalid run-comparison query", details: z.treeifyError(parsed.error) }, 400);
    }
    return c.json({ comparisons: await repository.listRunComparisons(c.get("projectId"), { limit: parsed.data.limit }) });
  });

  app.get("/api/run-comparisons/:comparisonId", async (c) => {
    const projectId = c.get("projectId");
    const comparison = await repository.getRunComparison(projectId, c.req.param("comparisonId"));
    if (!comparison) return c.json({ error: "Run comparison not found" }, 404);
    const [runA, runB] = await Promise.all([
      repository.getEvalRunDetail(projectId, comparison.runAId),
      repository.getEvalRunDetail(projectId, comparison.runBId)
    ]);
    // FK'd on delete cascade, so a comparison without both runs shouldn't
    // exist — but a missing run must 404 rather than fabricate a diff.
    if (!runA || !runB) return c.json({ error: "Run comparison runs not found" }, 404);
    const { buckets, cases } = computeRunComparisonDiff(runA.items, runB.items);
    const { items: itemsA, spend: spendA, ...runAMeta } = runA;
    const { items: itemsB, spend: spendB, ...runBMeta } = runB;
    return c.json({
      ...comparison,
      status: runComparisonStatus(runA, runB),
      runA: runAMeta,
      runB: runBMeta,
      agreementA: runComparisonAgreement(runA, itemsA),
      agreementB: runComparisonAgreement(runB, itemsB),
      buckets,
      cases
    });
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
      const integration = await repository.createIronsideIntegration(c.get("projectId"), parsed.data);
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
      const integration = await repository.updateIronsideIntegration(c.get("projectId"), c.req.param("integrationId"), parsed.data);
      return c.json({ integration });
    } catch (error) {
      if (error instanceof AmbiguousProjectSkillError) {
        return c.json({ error: error.message, code: "skill_version_required" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) {
        return c.json({ error: error.message, code: "invalid_skill_version" }, 400);
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
    let sampleRunCount: number;
    try {
      // The native list is a live view — fine for a connection test, which
      // only proves the URL + key work (import settlement is the worker's job).
      const page = await client.listTraces({ limit: 1 });
      sampleRunCount = page.traces.length;
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
      sampleRunCount
    };
    await repository.recordIronsideConnectionTest(projectId, integrationId, result);
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
      await repository.loadIronsideImportContext({ projectId, integrationId, skillVersionId: resolvedVersion.id, limit: parsed.data.limit });
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

function defaultIronsideAppClientFactory(context: IronsideImportContext): IronsideTraceSource {
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
