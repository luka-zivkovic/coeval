import type { Pool } from "pg";
import type { Hono } from "hono";
import { z } from "zod";
import {
  JudgeBatchRequestSchema,
  JudgeServiceRequestSchema,
  verdictLabelFromPayload
} from "@coeval/shared";
import { contentDigest, sha256Digest } from "../lib/assessment-receipt.js";
import {
  createStrictJudgeProvider,
  isJudgeAuthError,
  JudgeProviderUnavailableError
} from "../lib/judge-provider.js";
import {
  AssessmentReceiptIntegrityError,
  AssessmentReceiptUnavailableError,
  CaseNotFoundError,
  DatasetNotFoundError,
  RecursiveTraceSkippedError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables, RequestServices } from "../request-services/index.js";
import { judgeAndRecord } from "../workers/judge.js";

function decodeExactBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

type V1EvaluationAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface V1EvaluationAdministrationRouteOptions {
  repository: CoevalRepository;
  requestServices: RequestServices;
  pool?: Pool | undefined;
  judgeTimeoutMs: number;
  judgeBatchMaxItems: number;
  judgeBatchMaxBodyBytes: number;
  judgeRateLimitPerMinute: number;
}

// Registration remains after v1 agent administration and before session-side
// judge/API-key administration. The parent app continues to own every v1 body
// limit, authentication, project-membership, and initial rate-limit boundary.
export function registerV1EvaluationAdministrationRoutes(
  app: V1EvaluationAdministrationApp,
  options: V1EvaluationAdministrationRouteOptions
): void {
  const { repository, requestServices } = options;
  const {
    dispatch: dispatchEvalRun,
    listJudgeProviders,
    resolveSkillVersionId,
    takeRateTokens
  } = requestServices;
  const JUDGE_TIMEOUT_MS = options.judgeTimeoutMs;
  const JUDGE_BATCH_MAX_ITEMS = options.judgeBatchMaxItems;
  const JUDGE_BATCH_MAX_BODY_BYTES = options.judgeBatchMaxBodyBytes;
  const JUDGE_RATE_LIMIT_PER_MINUTE = options.judgeRateLimitPerMinute;
  const ReceiptComparisonInputSchema = z.object({
    consumerReceiptBase64: z.string().min(1).max(JUDGE_BATCH_MAX_BODY_BYTES)
  }).strict();

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
}
