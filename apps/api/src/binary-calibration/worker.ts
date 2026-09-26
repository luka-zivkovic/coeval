import type { Queue } from "@rubrist/queue";
import type { GovernedBinding, RecheckOutcome } from "../lib/binding-resolution.js";
import type { BinaryCalibrationMintResult } from "./repository.js";
import type {
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationExecutionRepository
} from "./repository.js";
import {
  BinaryCalibrationProviderError,
  providerObservationFor,
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
  /** The re-check before a run's first authorization (ADR-0014 section 4). */
  recheck?: BinaryCalibrationRecheck;
  recheckBackoffMs?: number;
}

/** Re-checks a binding with the probe input, never sealed data. */
export type BinaryCalibrationRecheck = (binding: GovernedBinding) => Promise<RecheckOutcome>;

export interface BinaryCalibrationOrchestrator {
  stop(): void;
  discover(): Promise<number>;
}

const DEFAULT_CLAIM_TTL_MS = 15 * 60_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 15_000;
const DEFAULT_DISCOVERY_LIMIT = 100;
// A re-check that couldn't reach the provider waits this long before the next
// one, so an outage doesn't probe on every discovery pass.
const DEFAULT_RECHECK_BACKOFF_MS = 5 * 60_000;

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
        claimTtlMs,
        ...(options.recheck ? { recheck: options.recheck } : {}),
        ...(options.recheckBackoffMs !== undefined ? { recheckBackoffMs: options.recheckBackoffMs } : {})
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
  recheck?: BinaryCalibrationRecheck;
  recheckBackoffMs?: number;
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
    if (input.recheck) {
      // Before the first authorization, and so before any sealed exposure:
      // the resolution must still hold. The probes use a fixed input, never a
      // sealed item, and never change the resolution record.
      const target = await input.repository.getRecheckTarget(claim);
      if (!target.authorized) {
        const backoffMs = input.recheckBackoffMs ?? DEFAULT_RECHECK_BACKOFF_MS;
        if (target.msSinceUnknownRecheck !== null && target.msSinceUnknownRecheck < backoffMs) {
          await input.repository.markRecoveryRequired(claim);
          return null;
        }
        // A re-check that throws is as unknown as a transient error.
        const result = await input.recheck(target.binding).catch(() => ({ outcome: "unknown" as const, probes: [] }));
        await input.repository.recordRecheck(claim, result);
        if (result.outcome === "unknown") {
          // A transient error delays the run; it never fails the binding.
          await input.repository.markRecoveryRequired(claim);
          return null;
        }
        if (result.outcome === "no_longer_holds") {
          await input.repository.rejectBeforeAuthorization(claim, "resolution_no_longer_holds");
          return null;
        }
      }
    }

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
          result: { state: "failure", failureKind: "internal" },
          attemptState: "terminal",
          providerObservation: requestedOnlyProviderObservation(authorizedRun.executionBinding)
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
          (result.outcome !== "pass" && result.outcome !== "fail" && result.outcome !== "abstain") ||
          result.providerObservation.provider !== authorizedRun.executionBinding.provider
        ) {
          throw new BinaryCalibrationProviderError(
            "provider_protocol",
            "The calibration provider returned invalid terminal metadata.",
            { physicalCall: true }
          );
        }
        // A typed-question evaluator never abstains (ADR-0014 decision 8); an
        // abstention from one is invalid output, which the artifact can hold.
        if (result.outcome === "abstain" && authorizedRun.evaluator.kind === "typed-question") {
          throw new BinaryCalibrationProviderError(
            "invalid_evaluator_output",
            "A typed-question evaluator returned an abstention.",
            { physicalCall: true }
          );
        }
        await input.repository.completeAttempt(activeClaim, attempt.attemptId, {
          result: { state: "outcome", outcome: result.outcome },
          attemptState: "terminal",
          providerObservation: {
            provider: result.providerObservation.provider,
            observedModel: result.providerObservation.observedModel,
            observedVersion: result.providerObservation.observedVersion,
            systemFingerprint: result.providerObservation.systemFingerprint,
            upstreamProvider: result.providerObservation.upstreamProvider
          }
        });
      } catch (error) {
        if (!(error instanceof BinaryCalibrationProviderError)) throw error;
        // A failure keeps what the provider returned before it, but only
        // when a request left; a refusal before the call observed nothing.
        await input.repository.completeAttempt(activeClaim, attempt.attemptId, {
          result: { state: "failure", failureKind: error.code },
          attemptState: "terminal",
          providerObservation: error.physicalCall
            ? providerObservationFor(authorizedRun.executionBinding, error.observed)
            : requestedOnlyProviderObservation(authorizedRun.executionBinding)
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
