import { serve } from "@hono/node-server";
import { runMigrations } from "@coeval/db";
import { createQueue } from "@coeval/queue";
import { createApp } from "./app.js";
import { createBinaryCalibrationProviderExecutor } from "./binary-calibration/provider.js";
import { PgBinaryCalibrationRepository } from "./binary-calibration/repository.pg.js";
import { registerBinaryCalibrationWorker } from "./binary-calibration/worker.js";
import { PgAnalysisStudyRepository, registerAnalysisStudyDeadlineCloser } from "./analysis-study/index.js";
import { PgAnalysisPromotionRepository } from "./analysis-promotion/index.js";
import { PgEvaluatorLifecycleRepository } from "./evaluator-lifecycle/index.js";
import { PgAnalysisMeasurementRepository } from "./analysis-measurement/index.js";
import { createAuth } from "./lib/auth.js";
import { createPgPool } from "./lib/db.js";
import { createStrictJudgeProvider } from "./lib/judge-provider.js";
import { DemoRepository } from "./repository.js";
import { PgRepository } from "./repository.pg.js";
import { registerEvalRunWorkers } from "./workers/eval-run.js";
import { registerFeedbackSyncWorker } from "./workers/feedback-sync.js";
import { registerGateRunWorker } from "./workers/gate.js";
import { registerJudgeRunWorker } from "./workers/judge.js";
import { registerIronsideImportWorker } from "./workers/ironside-import.js";
import { parseIronsidePollImportLimit, parseIronsidePollIntervalMs, registerIronsidePoller } from "./workers/ironside-poller.js";
import { registerLangfuseImportWorker } from "./workers/langfuse-import.js";
import { parseLangfusePollImportLimit, parseLangfusePollIntervalMs, registerLangfusePoller } from "./workers/langfuse-poller.js";
import { registerLangSmithImportWorker } from "./workers/langsmith-import.js";
import { parsePollImportLimit, parsePollIntervalMs, registerLangSmithPoller } from "./workers/langsmith-poller.js";

const port = Number(process.env.PORT ?? 8787);
const pool = createPgPool();

if (pool) {
  await runMigrations(pool);
}

const auth = pool ? createAuth(pool) : undefined;
// Demo mode seeds verdicts so κ / disagreement feeds / calibration render
// without a worker or auth. Real mode (PgRepository) uses live data.
const repository = pool ? new PgRepository(pool) : new DemoRepository(undefined, { seedVerdicts: true });
const binaryCalibrationRepository = pool
  ? new PgBinaryCalibrationRepository(pool)
  : null;
const analysisStudyRepository = pool ? new PgAnalysisStudyRepository(pool) : null;
const analysisPromotionRepository = pool ? new PgAnalysisPromotionRepository(pool) : null;
const evaluatorLifecycleRepository = pool ? new PgEvaluatorLifecycleRepository(pool) : null;
const analysisMeasurementRepository = pool ? new PgAnalysisMeasurementRepository(pool) : null;
const queue = pool ? createQueue() : undefined;
const pollers: Array<{ stop(): void | Promise<void> }> = [];

if (analysisStudyRepository) {
  pollers.push(await registerAnalysisStudyDeadlineCloser(analysisStudyRepository));
}

if (queue) {
  await queue.start();
  // BOTH judge workers are strict about credentials: a non-mock binding with
  // no key FAILS the item instead of silently recording mock verdicts. With
  // openrouter/custom bindings there is no environment-key fallback at all, so
  // a deleted project key would otherwise degrade EVERY subsequent judge run
  // to the mock heuristic while still recording source=llm_judge.
  await registerJudgeRunWorker(queue, repository, createStrictJudgeProvider);
  await registerEvalRunWorkers(queue, repository, createStrictJudgeProvider);
  // The gate worker needs no strict factory: runRegressionGateForVersion has
  // its own mock-degradation refusal (the original gate guard).
  await registerGateRunWorker(queue, repository);
  await registerLangSmithImportWorker(queue, repository);
  await registerLangfuseImportWorker(queue, repository);
  await registerIronsideImportWorker(queue, repository);
  await registerFeedbackSyncWorker(queue, repository);
  if (binaryCalibrationRepository) {
    const binaryCalibrationOrchestrator = await registerBinaryCalibrationWorker(
      queue,
      binaryCalibrationRepository,
      createBinaryCalibrationProviderExecutor({
        resolveProjectCredential: (projectId, provider) =>
          repository.getJudgeProviderCredential(projectId, provider)
      })
    );
    pollers.push(binaryCalibrationOrchestrator);
  }
  pollers.push(registerLangSmithPoller(queue, repository, {
    intervalMs: parsePollIntervalMs(process.env.LANGSMITH_POLL_INTERVAL_MS),
    importLimit: parsePollImportLimit(process.env.LANGSMITH_POLL_IMPORT_LIMIT)
  }));
  pollers.push(registerLangfusePoller(queue, repository, {
    intervalMs: parseLangfusePollIntervalMs(process.env.LANGFUSE_POLL_INTERVAL_MS),
    importLimit: parseLangfusePollImportLimit(process.env.LANGFUSE_POLL_IMPORT_LIMIT)
  }));
  pollers.push(registerIronsidePoller(queue, repository, {
    intervalMs: parseIronsidePollIntervalMs(process.env.IRONSIDE_POLL_INTERVAL_MS),
    importLimit: parseIronsidePollImportLimit(process.env.IRONSIDE_POLL_IMPORT_LIMIT)
  }));
}

const server = serve({
  fetch: createApp(repository, {
    auth,
    pool: pool ?? undefined,
    queue,
    analysisStudyRepository,
    analysisPromotionRepository,
    evaluatorLifecycleRepository,
    analysisMeasurementRepository
  }).fetch,
  port
});

console.log(`Coeval API listening on http://localhost:${port}${pool ? " (Postgres + judge worker)" : " (demo)"}`);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}; shutting down Coeval API`);
  const forceExit = setTimeout(() => {
    console.error("Timed out while shutting down Coeval API; forcing exit");
    process.exit(1);
  }, 30_000);
  forceExit.unref();

  try {
    await Promise.all(pollers.map((poller) => poller.stop()));
    await closeServer();
    await queue?.stop();
    await pool?.end();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error("Failed to shut down Coeval API cleanly", error);
    process.exit(1);
  }
}

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

process.once("SIGINT", (signal) => void shutdown(signal));
process.once("SIGTERM", (signal) => void shutdown(signal));
