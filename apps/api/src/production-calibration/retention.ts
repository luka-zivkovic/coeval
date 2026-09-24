import type { ProductionDecisionRecordRepository, ProductionRetentionRun } from "./repository.js";

// Scheduled retention for production decision records (ADR-0013 section 5).
// Retention must not depend on an owner remembering to prune: every API
// process runs this sweep, and the repository's advisory lock lets only one
// of them delete at a time.

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ProductionRetentionSweeperOptions {
  /** 0 or less disables the timer; the sweep can still be run by hand. */
  intervalMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface ProductionRetentionSweeper {
  sweep(): Promise<ProductionRetentionRun>;
  stop(): Promise<void>;
}

export function registerProductionRetentionSweeper(
  repository: Pick<ProductionDecisionRecordRepository, "applyRetention">,
  options: ProductionRetentionSweeperOptions = {}
): ProductionRetentionSweeper {
  const intervalMs = Math.min(options.intervalMs ?? DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let inFlight: Promise<ProductionRetentionRun> | null = null;
  const sweep = (): Promise<ProductionRetentionRun> => {
    if (stopped) return Promise.resolve({ skipped: true, projects: [] });
    if (inFlight) return inFlight;
    inFlight = repository.applyRetention(now()).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const tick = () => {
    void sweep().catch(() => {
      // Record contents and database detail do not belong in process logs;
      // the next pass retries independently.
      console.error("production record retention failed");
    });
  };
  if (intervalMs <= 0) {
    return { sweep, stop: async () => { stopped = true; await inFlight; } };
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    sweep,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    }
  };
}

export function parseProductionRetentionIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_INTERVAL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS;
}
