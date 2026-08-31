import type { Pool } from "pg";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  AgentBootstrapRequestSchema,
  type AgentBootstrapResponse,
  buildAgentConnectSnippets,
  compileJudgePrompt,
  CreateCriterionInputSchema,
  CreateCriterionVersionInputSchema,
  CreateEvaluatorSuiteManifestInputSchema,
  CreateSkillVersionInputSchema,
  defaultJudgePromptTemplate,
  FINDINGS_CASE_SCAN_LIMIT,
  FINDINGS_VERDICT_SCAN_LIMIT,
  MinimumVerdictOutputSchema,
  type V1CaseEntry,
  type V1CasesResponse,
  V1_CASES_DEFAULT_LIMIT,
  V1_CASES_MAX_LIMIT,
  type V1FindingsResponse,
  type V1GoldenResponse,
  type V1ProjectResponse
} from "@coeval/shared";
import type { CoevalAuth } from "../lib/auth.js";
import {
  bootstrapOwnerUserByEmail,
  claimAgentSetupPairing,
  completeAgentSetupPairing,
  createProjectForUser,
  invalidateAgentSetupPairing,
  releaseAgentSetupPairing,
  setupRequired
} from "../lib/auth.js";
import { sha256Digest } from "../lib/assessment-receipt.js";
import { canonicalEvaluatorSuiteManifestBytes } from "../lib/evaluator-suite.js";
import { buildFindings, latestDiscreteVerdictByCase } from "../lib/findings.js";
import {
  judgeProviderEnvironmentKey,
  openAIJudgeProviderBaseUrl
} from "../lib/judge-provider.js";
import { fetchJudgeModelCatalog, JudgeModelCatalogError } from "../lib/judge-models.js";
import {
  AgentSetupEligibilityError,
  AmbiguousProjectSkillError,
  CriterionStableKeyConflictError,
  DatasetRevisionConflictError,
  EvaluatorSuiteBindingError,
  EvaluatorSuiteIdempotencyConflictError,
  NoCurrentSkillError,
  RegressionGateJudgeError,
  RegressionGateUnavailableError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables } from "../request-services/index.js";

const AGENT_BOOTSTRAP_PROMPT = defaultJudgePromptTemplate("captured agent-skill run");

type V1AgentAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface V1AgentAdministrationRouteOptions {
  repository: CoevalRepository;
  auth?: CoevalAuth | undefined;
  pool?: Pool | undefined;
  publicApiBaseUrl(c: Context<{ Variables: AppVariables }>): string;
}

// Registration remains after manual trace import and before judge execution.
// The parent app continues to own every /api/v1 body-limit, authentication,
// project-membership, and rate-limit boundary.
export function registerV1AgentAdministrationRoutes(
  app: V1AgentAdministrationApp,
  options: V1AgentAdministrationRouteOptions
): void {
  const { repository, publicApiBaseUrl } = options;

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
}
