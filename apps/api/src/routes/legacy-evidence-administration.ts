import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { type Context, type Hono } from "hono";
import { z } from "zod";
import {
  AddReviewQueueItemsInputSchema,
  CreateReviewQueueInputSchema,
  PromoteGoldenSetInputSchema,
  RetireGoldenSetEntryInputSchema,
  ReviewQueueStatusSchema,
  VERDICT_LIST_MAX_LIMIT,
  VerdictPayloadSchema,
  VerdictSourceSchema
} from "@coeval/shared";
import { userProjectRole } from "../lib/auth.js";
import { buildTrustDigest, SPEND_WINDOW_RUNS } from "../lib/trust-digest.js";
import {
  AmbiguousProjectSkillError,
  CaseNotFoundError,
  DatasetRevisionConflictError,
  GoldenSetEntryAlreadyRetiredError,
  GoldenSetEntryNotFoundError,
  GoldenSetLabelConflictError,
  NoCurrentSkillError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables } from "../request-services/index.js";

const LEGACY_GOVERNANCE_CLASS = "ungoverned_legacy";

// Existing verdict, adjudication, and review-queue surfaces predate the
// governed-review contract. Keep their wire shapes stable while making the
// evidence boundary machine-readable on successes and validation errors.
function markUngovernedLegacy(c: Context): void {
  c.header("X-Coeval-Governance-Class", LEGACY_GOVERNANCE_CLASS);
}

type LegacyEvidenceAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface LegacyEvidenceAdministrationRouteOptions {
  repository: CoevalRepository;
  pool?: Pool | undefined;
}

// These CURRENT compatibility surfaces remain explicitly ungoverned legacy.
// Registration stays after integration administration and before final handlers.
export function registerLegacyEvidenceAdministrationRoutes(
  app: LegacyEvidenceAdministrationApp,
  options: LegacyEvidenceAdministrationRouteOptions
): void {
  const { repository } = options;

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
