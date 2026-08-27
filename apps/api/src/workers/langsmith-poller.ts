import type { Queue } from "@coeval/queue";
import type { CoevalRepository } from "../repository.js";

export interface LangSmithPollerOptions {
  intervalMs?: number | undefined;
  batchSize?: number | undefined;
  importLimit?: number | undefined;
  runOnStart?: boolean | undefined;
}

export interface LangSmithPollingResult {
  claimed: number;
  queued: number;
}

export interface LangSmithPollerHandle {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_IMPORT_LIMIT = 25;

export function registerLangSmithPoller(
  queue: Queue,
  repository: CoevalRepository,
  options: LangSmithPollerOptions = {}
): LangSmithPollerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (intervalMs <= 0) return { stop() {} };

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await enqueueDueLangSmithImports(repository, queue, { ...options, intervalMs });
      if (result.queued > 0) {
        console.log(`langsmith.poller queued ${result.queued}/${result.claimed} import jobs`);
      }
    } catch (error) {
      console.error("langsmith.poller failed:", error);
    } finally {
      running = false;
    }
  };

  if (options.runOnStart ?? true) void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export async function enqueueDueLangSmithImports(
  repository: CoevalRepository,
  queue: Queue,
  options: LangSmithPollerOptions & { now?: Date | undefined } = {}
): Promise<LangSmithPollingResult> {
  const targets = await repository.claimDueLangSmithImportTargets({
    now: options.now ?? new Date(),
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    defaultLimit: options.importLimit ?? DEFAULT_IMPORT_LIMIT
  });

  let queued = 0;
  for (const target of targets) {
    const importJob = await repository.createImportJob({
      projectId: target.projectId,
      source: "langsmith",
      sourceIntegrationId: target.integrationId,
      skillVersionId: target.skillVersionId,
      requestedLimit: target.limit
    });
    let jobId: string | null = null;
    try {
      jobId = await queue.send("langsmith.import", {
        projectId: target.projectId,
        integrationId: target.integrationId,
        skillVersionId: target.skillVersionId,
        limit: target.limit,
        importJobId: importJob.id
      }, { retryLimit: 5, retryBackoff: true });
    } catch (error) {
      await repository.markImportJobFailed(target.projectId, importJob.id, error);
      continue;
    }
    if (jobId) {
      await repository.markImportJobQueued(target.projectId, importJob.id, jobId);
      queued += 1;
    } else {
      await repository.markImportJobFailed(target.projectId, importJob.id, new Error("Queue unavailable; scheduled LangSmith import was not enqueued"));
    }
  }

  return { claimed: targets.length, queued };
}

export function parsePollIntervalMs(value: string | undefined): number {
  if (!value) return DEFAULT_INTERVAL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS;
}

export function parsePollImportLimit(value: string | undefined): number {
  if (!value) return DEFAULT_IMPORT_LIMIT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : DEFAULT_IMPORT_LIMIT;
}
