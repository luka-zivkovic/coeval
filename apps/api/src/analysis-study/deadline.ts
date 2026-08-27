export interface AnalysisStudyDeadlineRepository {
  closeDueStudies(limit: number): Promise<number>;
}

export interface AnalysisStudyDeadlineCloserOptions {
  intervalMs?: number;
  batchSize?: number;
}

export interface AnalysisStudyDeadlineCloser {
  closeDue(): Promise<number>;
  stop(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_INTERVAL_MS = 2_147_483_647;
const MAX_BATCH_SIZE = 1_000;

/**
 * Materialize server-deadline study closures even when no request reads or
 * mutates the study. The repository owns DB-clock comparison, row locking,
 * and the atomic closure snapshot; this loop only schedules bounded passes.
 */
export async function registerAnalysisStudyDeadlineCloser(
  repository: AnalysisStudyDeadlineRepository,
  options: AnalysisStudyDeadlineCloserOptions = {}
): Promise<AnalysisStudyDeadlineCloser> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  assertBoundedPositiveInteger(intervalMs, MAX_INTERVAL_MS, "intervalMs");
  assertBoundedPositiveInteger(batchSize, MAX_BATCH_SIZE, "batchSize");

  let stopped = false;
  let inFlight: Promise<number> | null = null;
  const closeDue = (): Promise<number> => {
    if (stopped) return Promise.resolve(0);
    if (inFlight) return inFlight;
    inFlight = repository.closeDueStudies(batchSize).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  await closeDue();
  const timer = setInterval(() => {
    void closeDue().catch(() => {
      // Study IDs, item evidence, and database error detail do not belong in
      // process logs. A later bounded pass retries independently.
      console.error("analysis study deadline closure failed");
    });
  }, intervalMs);
  timer.unref();

  return {
    closeDue,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    }
  };
}

function assertBoundedPositiveInteger(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
}
