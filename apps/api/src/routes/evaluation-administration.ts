import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  CreateEvalRunInputSchema,
  CreateRunComparisonInputSchema,
  StartTraceTestRunInputSchema,
  traceTestRunOutcome,
  type DatasetDetail,
  type DatasetRevisionDetail,
  type EvalRun,
  type RunComparison,
  type TraceTestRunSource
} from "@coeval/shared";
import type { Queue } from "@coeval/queue";
import { computeRunComparisonDiff, runComparisonAgreement, runComparisonStatus } from "../lib/run-comparison.js";
import {
  DatasetNameTakenError,
  DatasetRevisionConflictError,
  DatasetRevisionNotFoundError,
  ImportSkillVersionBindingError,
  SealedValidationUnavailableError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables, RequestServices } from "../request-services/index.js";
import { runExistingCaseBackfill } from "../workers/gate.js";
import { assertImportJudgingAllowed } from "../workers/import-judging.js";

const TRACE_TEST_DATASET_NAME = "Regression tests";

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

type EvaluationAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface EvaluationAdministrationRouteOptions {
  repository: CoevalRepository;
  requestServices: RequestServices;
  queue?: Queue | undefined;
}

// Registration remains after dataset administration and before the legacy
// session-side product-gate reads that intentionally stay in the composition root.
export function registerEvaluationAdministrationRoutes(
  app: EvaluationAdministrationApp,
  options: EvaluationAdministrationRouteOptions
): void {
  const { repository, requestServices } = options;
  const {
    createDatasetRevision: createDatasetRevisionEvalRun,
    dispatch: dispatchEvalRun,
    requireOwner,
    resolveSkillVersionId,
    startDataset: startDatasetEvalRun,
    startDatasetRevision: startDatasetRevisionEvalRun
  } = requestServices;

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
}
