import type { Pool } from "pg";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  AssistTraceTestDraftInputSchema,
  CreateTraceTestInputSchema,
  EnableTraceTestInputSchema,
  RecordManualTraceTestValidationInputSchema,
  ReviseTraceTestInputSchema,
  RunTraceTestValidationInputSchema,
  TraceTestFunnelEventInputSchema
} from "@coeval/shared";
import {
  openAIJudgeProviderBaseUrl,
  resolveJudgeProviderApiKey
} from "../lib/judge-provider.js";
import {
  buildTraceTestDraftPrompt,
  generateTraceTestDraft,
  parseAssistedTraceTestContent,
  scopedTraceTestEvidence,
  TRACE_TEST_DRAFT_SYSTEM_PROMPT,
  TraceTestDraftProviderError,
  type TraceTestDraftGenerator
} from "../lib/trace-test-drafter.js";
import {
  hasUsableTraceTestExample,
  traceTestValidationExamples,
  validateTraceTestPair,
  type TraceTestValidationRunner
} from "../lib/trace-test-validator.js";
import {
  AmbiguousProjectSkillError,
  NoCurrentSkillError,
  TraceTestNotFoundError,
  TraceTestRevisionConflictError,
  TraceTestSourceNotFoundError,
  TraceTestValidationNotReadyError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables, RequestServices } from "../request-services/index.js";

type TraceTestAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface TraceTestAdministrationRouteOptions {
  repository: CoevalRepository;
  pool?: Pool | undefined;
  requestServices: RequestServices;
  traceTestDraftGenerator?: TraceTestDraftGenerator | undefined;
  traceTestValidationRunner?: TraceTestValidationRunner | undefined;
  judgeRateLimitPerMinute: number;
  draftTimeoutMs: number;
  validationTimeoutMs: number;
}

const TRACE_TEST_VALIDATION_MAX_ATTEMPTS = 2;
const TRACE_TEST_VALIDATION_RATE_TOKENS = 2 * TRACE_TEST_VALIDATION_MAX_ATTEMPTS;

// Register on the parent app so body-size, session, and project-membership
// middleware retain their established order. Run dispatch stays with the later
// eval-run orchestration routes in app.ts.
export function registerTraceTestAdministrationRoutes(
  app: TraceTestAdministrationApp,
  options: TraceTestAdministrationRouteOptions
): void {
  const { repository, requestServices } = options;
  const { requireOwner, takeRateTokens } = requestServices;
  const JUDGE_RATE_LIMIT_PER_MINUTE = options.judgeRateLimitPerMinute;
  const TRACE_TEST_DRAFT_TIMEOUT_MS = options.draftTimeoutMs;
  const TRACE_TEST_VALIDATION_TIMEOUT_MS = options.validationTimeoutMs;

  const traceTestError = (c: Context<{ Variables: AppVariables }>, error: unknown): Response | null => {
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
}
