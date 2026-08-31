import type { Pool } from "pg";
import type { Hono } from "hono";
import type { Queue } from "@coeval/queue";
import {
  CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT,
  CONVERGENCE_CASE_PAGE_MAX_LIMIT,
  CreateOnboardingCheckInputSchema,
  CreateSkillVersionInputSchema,
  SKILL_FORMAT_EXAMPLES_CAP,
  type SkillFormatV1
} from "@coeval/shared";
import { z } from "zod";
import { sha256Digest } from "../lib/assessment-receipt.js";
import { userProjectRole } from "../lib/auth.js";
import { buildJudgeCard, renderJudgeCardMarkdown } from "../lib/judge-card.js";
import {
  AmbiguousProjectSkillError,
  DatasetRevisionConflictError,
  InvalidConvergenceCursorError,
  NoCurrentSkillError,
  OnboardingCheckConflictError,
  RegressionGateJudgeError,
  RegressionGateUnavailableError,
  SkillVersionNotSignableError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables, RequestServices } from "../request-services/index.js";
import { runExistingCaseBackfill } from "../workers/gate.js";

type SkillAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface SkillAdministrationRouteOptions {
  repository: CoevalRepository;
  pool?: Pool | undefined;
  queue?: Queue | undefined;
  requestServices: RequestServices;
}

// Register on the parent app so the global body limit, session resolver, and
// project-membership middleware keep the exact ordering established by createApp.
// Convergence-run and backfill execution remain in app.ts with the later run-
// orchestration routes; this module owns only the contiguous administration block.
export function registerSkillAdministrationRoutes(
  app: SkillAdministrationApp,
  options: SkillAdministrationRouteOptions
): void {
  const { repository, requestServices } = options;
  const listJudgeProviders = requestServices.listJudgeProviders;

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

  // The Judge Card — recorded evidence about one version as a
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

  // P0-1 onboarding: "Sign off as-is" — approve the starter draft without
  // re-judging. Exits the provisional journey stage. Owner-only; anything
  // that was ever approved must go through the gate (POST /versions) instead.
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
          availableProviders: (await listJudgeProviders(projectId))
            .filter((provider) => provider.available)
            .map((provider) => provider.provider)
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
            availableProviders: (await listJudgeProviders(c.get("projectId"))).filter((p) => p.available).map((p) => p.provider)
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
          availableProviders: (await listJudgeProviders(c.get("projectId"))).filter((p) => p.available).map((p) => p.provider)
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
}
