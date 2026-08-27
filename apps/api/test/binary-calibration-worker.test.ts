import { describe, expect, it } from "vitest";
import type {
  BinaryCalibrationErrorCode,
  BinaryCalibrationPrivateProviderObservation
} from "@coeval/shared";
import {
  BinaryCalibrationProviderError,
  type BinaryCalibrationProviderExecutor
} from "../src/binary-calibration/provider.js";
import type {
  BinaryCalibrationAttemptWorkItem,
  BinaryCalibrationAuthorizedRun,
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationExecutionRepository,
  BinaryCalibrationMintResult,
  CompleteBinaryCalibrationAttemptInput
} from "../src/binary-calibration/repository.js";
import {
  BinaryCalibrationWorkerError,
  processBinaryCalibrationRun
} from "../src/binary-calibration/worker.js";

const DIGEST = `sha256:${"b".repeat(64)}`;

function authorized(claim: BinaryCalibrationExecutionClaim): BinaryCalibrationAuthorizedRun {
  return {
    claim,
    projectId: "project_1",
    datasetRevisionId: "revision_1",
    revisionDigest: DIGEST,
    itemCount: 1,
    skillVersionId: "skill_version_1",
    requestedModelBinding: {
      provider: "openai",
      modelId: "gpt-pinned",
      modelVersion: "gpt-pinned",
      temperatureDecimal: "0",
      topPDecimal: null,
      endpointKind: "managed",
      baseUrlDigest: null,
      requestedBindingDigest: DIGEST
    },
    executionModelBinding: {
      provider: "openai",
      modelId: "gpt-pinned",
      modelVersion: "gpt-pinned",
      temperature: 0
    },
    providerDataHandling: {
      executionEnvironment: "external_provider",
      policyId: "policy_1",
      policyDigest: DIGEST,
      payloadTransmission: "sealed_payload_to_pinned_provider"
    },
    evaluator: {
      rubricMarkdown: "PROMPT_CANARY",
      prompt: "Judge {{rubric_markdown}}",
      outputSchema: { type: "object" }
    },
    authorization: {
      snapshotDigest: DIGEST,
      eventId: "event_1",
      recordedAt: "2026-08-23T12:00:00.000Z"
    }
  };
}

const MINT = { marker: "deterministic-repository-mint" } as unknown as BinaryCalibrationMintResult;

class FakeExecutionRepository implements BinaryCalibrationExecutionRepository {
  now = 0;
  claimAvailableAt = 0;
  attemptState: "not_started" | "started" | "terminal" = "not_started";
  physicalProviderCalls = 0;
  recoveredError: BinaryCalibrationErrorCode | null = null;
  completeInputs: CompleteBinaryCalibrationAttemptInput[] = [];
  finalizeCalls = 0;
  recoveryMarks = 0;
  failCallStart = false;
  failCompleteCount = 0;

  async listRunnableRunIds(): Promise<string[]> {
    return ["cal_run_1"];
  }

  async claimRun(
    runId: string,
    workerId: string,
    claimTtlMs: number
  ): Promise<BinaryCalibrationExecutionClaim | null> {
    if (this.now < this.claimAvailableAt) return null;
    return {
      runId,
      workerId,
      claimToken: `claim_${workerId}_${this.now}`,
      claimExpiresAt: new Date(this.now + claimTtlMs).toISOString()
    };
  }

  async heartbeatClaim(
    claim: BinaryCalibrationExecutionClaim,
    claimTtlMs: number
  ): Promise<BinaryCalibrationExecutionClaim> {
    return {
      ...claim,
      claimExpiresAt: new Date(this.now + claimTtlMs).toISOString()
    };
  }

  async authorizeRun(
    claim: BinaryCalibrationExecutionClaim
  ): Promise<BinaryCalibrationAuthorizedRun> {
    return authorized(claim);
  }

  async recoverStartedAttempts(): Promise<number> {
    if (this.attemptState !== "started") return 0;
    this.attemptState = "terminal";
    this.recoveredError = "outcome_unknown";
    return 1;
  }

  async getNextAttempt(
    claim: BinaryCalibrationExecutionClaim
  ): Promise<BinaryCalibrationAttemptWorkItem | null> {
    if (this.attemptState !== "not_started") return null;
    return {
      attemptId: "attempt_1",
      runId: claim.runId,
      datasetRevisionItemDigest: DIGEST,
      trialIndex: 0,
      payloadSnapshot: {
        input: { prompt: "INPUT_CANARY" },
        output: { answer: "OUTPUT_CANARY" }
      },
      physicalProviderCalls: this.physicalProviderCalls
    };
  }

  async recordProviderCallStarted(): Promise<number> {
    if (this.failCallStart) throw new Error("DB_CALL_START_CANARY");
    this.attemptState = "started";
    this.physicalProviderCalls += 1;
    return this.physicalProviderCalls;
  }

  async completeAttempt(
    _claim: BinaryCalibrationExecutionClaim,
    _attemptId: string,
    input: CompleteBinaryCalibrationAttemptInput
  ): Promise<void> {
    if (this.failCompleteCount > 0) {
      this.failCompleteCount -= 1;
      throw new Error("DB_TERMINAL_CANARY");
    }
    this.completeInputs.push(input);
    this.attemptState = "terminal";
  }

  async finalizeRun(): Promise<BinaryCalibrationMintResult> {
    this.finalizeCalls += 1;
    return MINT;
  }

  async markRecoveryRequired(): Promise<void> {
    this.recoveryMarks += 1;
  }
}

function successfulExecutor(onPhysicalCall: () => void): BinaryCalibrationProviderExecutor {
  return async ({ beforePhysicalCall }) => {
    await beforePhysicalCall();
    onPhysicalCall();
    return {
      terminalEvaluatorOutcome: "evaluator_pass",
      providerObservation: {
        provider: "openai",
        observedModel: "gpt-observed",
        observedVersion: null,
        systemFingerprint: "fp_observed"
      }
    };
  };
}

describe("sealed binary calibration worker", () => {
  it("does not dispatch when durable pre-call persistence fails", async () => {
    const repository = new FakeExecutionRepository();
    repository.failCallStart = true;
    let physicalCalls = 0;

    await expect(processBinaryCalibrationRun({
      repository,
      executeProvider: successfulExecutor(() => {
        physicalCalls += 1;
      }),
      runId: "cal_run_1",
      workerId: "worker_1",
      claimTtlMs: 1_000
    })).rejects.toEqual(expect.objectContaining({
      name: "BinaryCalibrationWorkerError",
      code: "repository_failure",
      message: "The sealed calibration run requires recovery."
    }));

    expect(physicalCalls).toBe(0);
    expect(repository.attemptState).toBe("not_started");
    expect(repository.physicalProviderCalls).toBe(0);
    expect(repository.recoveryMarks).toBe(1);
  });

  it("recovers a call whose terminal write failed as permanent outcome_unknown without recall", async () => {
    const repository = new FakeExecutionRepository();
    repository.failCompleteCount = 1;
    let physicalCalls = 0;
    const executeProvider = successfulExecutor(() => {
      physicalCalls += 1;
    });

    await expect(processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_first",
      claimTtlMs: 1_000
    })).rejects.toBeInstanceOf(BinaryCalibrationWorkerError);
    expect(repository.attemptState).toBe("started");
    expect(repository.physicalProviderCalls).toBe(1);
    expect(physicalCalls).toBe(1);

    await expect(processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_recovery",
      claimTtlMs: 1_000
    })).resolves.toBe(MINT);

    expect(repository.recoveredError).toBe("outcome_unknown");
    expect(repository.attemptState).toBe("terminal");
    expect(repository.physicalProviderCalls).toBe(1);
    expect(physicalCalls).toBe(1);
    expect(repository.finalizeCalls).toBe(1);
  });

  it("waits for claim expiry, then recovers started work without a provider call", async () => {
    const repository = new FakeExecutionRepository();
    repository.attemptState = "started";
    repository.physicalProviderCalls = 1;
    repository.claimAvailableAt = 100;
    let physicalCalls = 0;
    const executeProvider = successfulExecutor(() => {
      physicalCalls += 1;
    });

    await expect(processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_contended",
      claimTtlMs: 1_000
    })).resolves.toBeNull();
    expect(repository.recoveredError).toBeNull();

    repository.now = 101;
    await expect(processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_after_expiry",
      claimTtlMs: 1_000
    })).resolves.toBe(MINT);
    expect(repository.recoveredError).toBe("outcome_unknown");
    expect(physicalCalls).toBe(0);
  });

  it("replays terminal state by returning the same repository mint without dispatch", async () => {
    const repository = new FakeExecutionRepository();
    repository.attemptState = "terminal";
    let physicalCalls = 0;
    const executeProvider = successfulExecutor(() => {
      physicalCalls += 1;
    });

    const first = await processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_1"
    });
    const replay = await processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_2"
    });

    expect(first).toBe(MINT);
    expect(replay).toBe(MINT);
    expect(repository.finalizeCalls).toBe(2);
    expect(physicalCalls).toBe(0);
  });

  it("persists only the closed typed error after one failed provider call", async () => {
    const repository = new FakeExecutionRepository();
    const executeProvider: BinaryCalibrationProviderExecutor = async ({ beforePhysicalCall }) => {
      await beforePhysicalCall();
      throw new BinaryCalibrationProviderError(
        "provider_rate_limit",
        "safe typed message"
      );
    };

    await expect(processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_1"
    })).resolves.toBe(MINT);

    expect(repository.physicalProviderCalls).toBe(1);
    expect(repository.completeInputs).toEqual([{
      terminalEvaluatorOutcome: "errored",
      attemptState: "terminal",
      errorCode: "provider_rate_limit",
      providerObservation: {
        provider: "openai",
        observedModel: null,
        observedVersion: null,
        systemFingerprint: null
      }
    }]);
    const persisted = JSON.stringify(repository.completeInputs);
    for (const canary of [
      "PROMPT_CANARY",
      "INPUT_CANARY",
      "OUTPUT_CANARY",
      "safe typed message"
    ]) {
      expect(persisted).not.toContain(canary);
    }
  });

  it("strips non-contract provider fields before terminal persistence", async () => {
    const repository = new FakeExecutionRepository();
    const observation = {
      provider: "openai",
      observedModel: "gpt-observed",
      observedVersion: null,
      systemFingerprint: "fp_observed",
      requestId: "REQUEST_ID_CANARY",
      raw: "RAW_CANARY"
    } as BinaryCalibrationPrivateProviderObservation;
    const executeProvider: BinaryCalibrationProviderExecutor = async ({ beforePhysicalCall }) => {
      await beforePhysicalCall();
      return {
        terminalEvaluatorOutcome: "evaluator_fail",
        providerObservation: observation
      };
    };

    await processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_1"
    });
    expect(JSON.stringify(repository.completeInputs)).not.toContain("CANARY");
    expect(repository.completeInputs[0]?.providerObservation).toEqual({
      provider: "openai",
      observedModel: "gpt-observed",
      observedVersion: null,
      systemFingerprint: "fp_observed"
    });
  });

  it("persists an explicit evaluator abstention as a valid terminal outcome", async () => {
    const repository = new FakeExecutionRepository();
    const executeProvider: BinaryCalibrationProviderExecutor = async ({ beforePhysicalCall }) => {
      await beforePhysicalCall();
      return {
        terminalEvaluatorOutcome: "abstained",
        providerObservation: {
          provider: "openai",
          observedModel: "gpt-observed",
          observedVersion: null,
          systemFingerprint: null
        }
      };
    };

    await expect(processBinaryCalibrationRun({
      repository,
      executeProvider,
      runId: "cal_run_1",
      workerId: "worker_1"
    })).resolves.toBe(MINT);

    expect(repository.completeInputs).toEqual([{
      terminalEvaluatorOutcome: "abstained",
      attemptState: "terminal",
      errorCode: null,
      providerObservation: {
        provider: "openai",
        observedModel: "gpt-observed",
        observedVersion: null,
        systemFingerprint: null
      }
    }]);
  });
});
