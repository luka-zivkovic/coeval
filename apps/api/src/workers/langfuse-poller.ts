import type { Queue } from "@coeval/queue";
import type { CoevalRepository } from "../repository.js";

export interface LangfusePollerOptions {
  intervalMs?: number | undefined;
  batchSize?: number | undefined;
  importLimit?: number | undefined;
  runOnStart?: boolean | undefined;
}

export interface LangfusePollingResult {
  claimed: number;
  queued: number;
}

export interface LangfusePollerHandle {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_IMPORT_LIMIT = 25;

export function registerLangfusePoller(
  queue: Queue,
  repository: CoevalRepository,
  options: LangfusePollerOptions = {}
): LangfusePollerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (intervalMs <= 0) return { stop() {} };

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await enqueueDueLangfuseImports(repository, queue, { ...options, intervalMs });
      if (result.queued > 0) {
        console.log(`langfuse.poller queued ${result.queued}/${result.claimed} import jobs`);
      }
    } catch (error) {
      console.error("langfuse.poller failed:", error);
    } finally {
      running = false;
    }
  };

  if (options.runOnStart ?? true) void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export async function enqueueDueLangfuseImports(
  repository: CoevalRepository,
  queue: Queue,
  options: LangfusePollerOptions & { now?: Date | undefined } = {}
): Promise<LangfusePollingResult> {
  const targets = await repository.claimDueLangfuseImportTargets({
    now: options.now ?? new Date(),
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    defaultLimit: options.importLimit ?? DEFAULT_IMPORT_LIMIT
  });

  let queued = 0;
  for (const target of targets) {
    const importJob = await repository.createImportJob({
      projectId: target.projectId,
      source: "langfuse",
      sourceIntegrationId: target.integrationId,
      skillVersionId: target.skillVersionId,
      requestedLimit: target.limit
    });
    let jobId: string | null = null;
    try {
      jobId = await queue.send("langfuse.import", {
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
      await repository.markImportJobFailed(target.projectId, importJob.id, new Error("Queue unavailable; scheduled Langfuse import was not enqueued"));
    }
  }

  return { claimed: targets.length, queued };
}

export function parseLangfusePollIntervalMs(value: string | undefined): number {
  if (!value) return DEFAULT_INTERVAL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS;
}

export function parseLangfusePollImportLimit(value: string | undefined): number {
  if (!value) return DEFAULT_IMPORT_LIMIT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : DEFAULT_IMPORT_LIMIT;
}
