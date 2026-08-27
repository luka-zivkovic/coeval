import type { Queue } from "@coeval/queue";
import type { BinaryCalibrationMintResult } from "./repository.js";
import type {
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationExecutionRepository
} from "./repository.js";
import {
  BinaryCalibrationProviderError,
  requestedOnlyProviderObservation,
  type BinaryCalibrationProviderExecutor
} from "./provider.js";

export interface BinaryCalibrationRunJob {
  runId: string;
}

export interface BinaryCalibrationWorkerOptions {
  claimTtlMs?: number;
  discoveryIntervalMs?: number;
  discoveryLimit?: number;
}

export interface BinaryCalibrationOrchestrator {
  stop(): void;
  discover(): Promise<number>;
}

const DEFAULT_CLAIM_TTL_MS = 15 * 60_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 15_000;
const DEFAULT_DISCOVERY_LIMIT = 100;

/**
 * Register the sealed worker and a bounded discovery loop. Discovery is what
 * makes an expired claim recoverable even if the original queue delivery was
 * acknowledged or the process died before scheduling its own retry.
 */
export async function registerBinaryCalibrationWorker(
  queue: Queue,
  repository: BinaryCalibrationExecutionRepository,
  executeProvider: BinaryCalibrationProviderExecutor,
  options: BinaryCalibrationWorkerOptions = {}
): Promise<BinaryCalibrationOrchestrator> {
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const discoveryIntervalMs =
    options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
  const discoveryLimit = options.discoveryLimit ?? DEFAULT_DISCOVERY_LIMIT;

  validatePositiveInteger(claimTtlMs, "claimTtlMs");
  validatePositiveInteger(discoveryIntervalMs, "discoveryIntervalMs");
  validatePositiveInteger(discoveryLimit, "discoveryLimit");

  await queue.work<BinaryCalibrationRunJob>(
    "binary-calibration.run",
    async ({ id, data }) => {
      if (!isRunJob(data)) {
        // Invalid, untrusted queue bytes can never identify a protected run.
        console.error(`binary-calibration.run job ${id} has invalid data; dropping`);
        return;
      }
      await processBinaryCalibrationRun({
        repository,
        executeProvider,
        runId: data.runId,
        workerId: `binary-calibration:${id}`,
        claimTtlMs
      });
    }
  );

  let stopped = false;
  let discoveryInFlight: Promise<number> | null = null;
  const discover = (): Promise<number> => {
    if (stopped) return Promise.resolve(0);
    if (discoveryInFlight) return discoveryInFlight;
    discoveryInFlight = enqueueRunnableBinaryCalibrationRuns(
      queue,
      repository,
      discoveryLimit
    ).finally(() => {
      discoveryInFlight = null;
    });
    return discoveryInFlight;
  };

  await discover();
  const timer = setInterval(() => {
    void discover().catch(() => {
      // Do not serialize repository/provider detail into process logs. The
      // next bounded interval retries discovery independently.
      console.error("binary calibration discovery failed");
    });
  }, discoveryIntervalMs);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    discover
  };
}

export async function enqueueRunnableBinaryCalibrationRuns(
  queue: Queue,
  repository: BinaryCalibrationExecutionRepository,
  limit = DEFAULT_DISCOVERY_LIMIT
): Promise<number> {
  validatePositiveInteger(limit, "limit");
  const runIds = await repository.listRunnableRunIds(limit);
  for (const runId of runIds) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new BinaryCalibrationWorkerError(
        "repository_failure",
        "Calibration discovery returned an invalid run identity."
      );
    }
    await queue.send(
      "binary-calibration.run",
      { runId } satisfies BinaryCalibrationRunJob,
      { retryLimit: 20, retryBackoff: true }
    );
  }
  return runIds.length;
}

export async function processBinaryCalibrationRun(input: {
  repository: BinaryCalibrationExecutionRepository;
  executeProvider: BinaryCalibrationProviderExecutor;
  runId: string;
  workerId: string;
  claimTtlMs?: number;
}): Promise<BinaryCalibrationMintResult | null> {
  const claimTtlMs = input.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  validatePositiveInteger(claimTtlMs, "claimTtlMs");
  let claim = await input.repository.claimRun(
    input.runId,
    input.workerId,
    claimTtlMs
  );
  // Another worker owns this run, or the run is already terminal. Discovery
  // revisits nonterminal rows after claim expiry; never bypass the claim.
  if (!claim) return null;

  try {
    const authorizedRun = await input.repository.authorizeRun(claim);
    assertAuthorizedClaim(claim, authorizedRun.claim);

    // This MUST precede getNextAttempt. A persisted `started` row means a call
    // may already have happened; recovery permanently records outcome_unknown
    // so the same logical observation is never dispatched again.
    await input.repository.recoverStartedAttempts(claim);

    while (true) {
      claim = await input.repository.heartbeatClaim(claim, claimTtlMs);
      const activeClaim = claim;
      const attempt = await input.repository.getNextAttempt(activeClaim);
      if (!attempt) return await input.repository.finalizeRun(activeClaim);

      if (attempt.runId !== claim.runId || attempt.trialIndex !== 0) {
        await input.repository.completeAttempt(activeClaim, attempt.attemptId, {
          terminalEvaluatorOutcome: "errored",
          attemptState: "terminal",
          errorCode: "internal",
          providerObservation: requestedOnlyProviderObservation(
            authorizedRun.requestedModelBinding
          )
        });
        continue;
      }

      try {
        const result = await input.executeProvider({
          authorizedRun,
          attempt,
          beforePhysicalCall: async () => {
            // The provider executor awaits this as its final pre-dispatch
            // operation. Each invocation is one durable physical-call count.
            await input.repository.recordProviderCallStarted(
              activeClaim,
              attempt.attemptId
            );
          }
        });
        if (
          (result.terminalEvaluatorOutcome !== "evaluator_pass" &&
            result.terminalEvaluatorOutcome !== "evaluator_fail" &&
            result.terminalEvaluatorOutcome !== "abstained") ||
          result.providerObservation.provider !==
            authorizedRun.requestedModelBinding.provider
        ) {
          throw new BinaryCalibrationProviderError(
            "provider_protocol",
            "The calibration provider returned invalid terminal metadata."
          );
        }
        await input.repository.completeAttempt(activeClaim, attempt.attemptId, {
          terminalEvaluatorOutcome: result.terminalEvaluatorOutcome,
          attemptState: "terminal",
          errorCode: null,
          providerObservation: {
            provider: result.providerObservation.provider,
            observedModel: result.providerObservation.observedModel,
            observedVersion: result.providerObservation.observedVersion,
            systemFingerprint: result.providerObservation.systemFingerprint
          }
        });
      } catch (error) {
        if (!(error instanceof BinaryCalibrationProviderError)) throw error;
        await input.repository.completeAttempt(activeClaim, attempt.attemptId, {
          terminalEvaluatorOutcome: "errored",
          attemptState: "terminal",
          errorCode: error.code,
          providerObservation: requestedOnlyProviderObservation(
            authorizedRun.requestedModelBinding
          )
        });
      }
    }
  } catch {
    try {
      await input.repository.markRecoveryRequired(claim);
    } catch {
      // The claim may have expired, or a terminal write may have committed
      // before its acknowledgement was lost. Discovery and repository state
      // are authoritative; never attempt a compensating provider call here.
    }
    throw new BinaryCalibrationWorkerError(
      "repository_failure",
      "The sealed calibration run requires recovery."
    );
  }
}

export type BinaryCalibrationWorkerErrorCode =
  | "invalid_configuration"
  | "repository_failure";

export class BinaryCalibrationWorkerError extends Error {
  constructor(
    public readonly code: BinaryCalibrationWorkerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BinaryCalibrationWorkerError";
  }
}

function isRunJob(value: unknown): value is BinaryCalibrationRunJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.runId === "string" &&
    record.runId.length > 0
  );
}

function assertAuthorizedClaim(
  expected: BinaryCalibrationExecutionClaim,
  actual: BinaryCalibrationExecutionClaim
): void {
  if (
    actual.runId !== expected.runId ||
    actual.workerId !== expected.workerId ||
    actual.claimToken !== expected.claimToken
  ) {
    throw new BinaryCalibrationWorkerError(
      "repository_failure",
      "Calibration authorization returned a mismatched claim."
    );
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BinaryCalibrationWorkerError(
      "invalid_configuration",
      `${name} must be a positive safe integer.`
    );
  }
}
