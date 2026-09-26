import { describe, expect, it } from "vitest";
import type {
  BinaryCalibrationV2ErrorCode,
  BinaryCalibrationV2PrivateProviderObservation
} from "@rubrist/shared";
import {
  BinaryCalibrationProviderError,
  createBinaryCalibrationProviderExecutor,
  type BinaryCalibrationProviderExecutor
} from "../src/binary-calibration/provider.js";
import type {
  BinaryCalibrationAttemptWorkItem,
  BinaryCalibrationAuthorizedRun,
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationExecutionRepository,
  BinaryCalibrationMintResult,
  BinaryCalibrationRecheckTarget,
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
    executionBinding: {
      provider: "openai",
      endpoint: { kind: "managed" },
      modelId: "gpt-pinned",
      modelVersion: "gpt-pinned",
      sampling: { temperature: 0, topP: null },
      reasoning: { family: "openai", effort: "low" },
      outputTokenLimit: null,
      verdictProtocol: "openai.structured-output/v1",
      routing: null
    },
    customEndpointUrl: null,
    providerDataHandling: {
      executionEnvironment: "external_provider",
      policyId: "policy_1",
      policyDigest: DIGEST,
      payloadTransmission: "sealed_payload_to_pinned_provider"
    },
    evaluator: {
      kind: "prompted",
      rubricMarkdown: "PROMPT_CANARY",
      prompt: "Judge {{rubric_markdown}}"
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
  recoveredError: BinaryCalibrationV2ErrorCode | null = null;
  completeInputs: CompleteBinaryCalibrationAttemptInput[] = [];
  finalizeCalls = 0;
  recoveryMarks = 0;
  failCallStart = false;
  failCompleteCount = 0;
  evaluator: BinaryCalibrationAuthorizedRun["evaluator"] | null = null;

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
    this.authorizeCalls += 1;
    return this.evaluator === null ? authorized(claim) : { ...authorized(claim), evaluator: this.evaluator };
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

  authorized = false;
  msSinceUnknownRecheck: number | null = null;
  rechecks: string[] = [];
  rejections: string[] = [];
  authorizeCalls = 0;

  async getRecheckTarget(claim: BinaryCalibrationExecutionClaim): Promise<BinaryCalibrationRecheckTarget> {
    const run = authorized(claim);
    return {
      binding: {
        projectId: run.projectId,
        executionBinding: run.executionBinding,
        customEndpointUrl: run.customEndpointUrl,
        spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
      },
      authorized: this.authorized,
      msSinceUnknownRecheck: this.msSinceUnknownRecheck
    };
  }

  async recordRecheck(_claim: BinaryCalibrationExecutionClaim, result: { outcome: string }): Promise<void> {
    this.rechecks.push(result.outcome);
  }

  async rejectBeforeAuthorization(_claim: BinaryCalibrationExecutionClaim, reason: string): Promise<void> {
    this.rejections.push(reason);
  }
}

function successfulExecutor(onPhysicalCall: () => void): BinaryCalibrationProviderExecutor {
  return async ({ beforePhysicalCall }) => {
    await beforePhysicalCall();
    onPhysicalCall();
    return {
      outcome: "pass",
      providerObservation: {
        provider: "openai",
        observedModel: "gpt-observed",
        observedVersion: null,
        systemFingerprint: "fp_observed",
        upstreamProvider: null
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
        "safe typed message",
        { physicalCall: true }
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
      result: { state: "failure", failureKind: "provider_rate_limit" },
      attemptState: "terminal",
      providerObservation: {
        provider: "openai",
        observedModel: null,
        observedVersion: null,
        systemFingerprint: null,
        upstreamProvider: null
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
      upstreamProvider: null,
      requestId: "REQUEST_ID_CANARY",
      raw: "RAW_CANARY"
    } as BinaryCalibrationV2PrivateProviderObservation;
    const executeProvider: BinaryCalibrationProviderExecutor = async ({ beforePhysicalCall }) => {
      await beforePhysicalCall();
      return {
        outcome: "fail",
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
      systemFingerprint: "fp_observed",
      upstreamProvider: null
    });
  });

  it("persists an explicit evaluator abstention as a valid terminal outcome", async () => {
    const repository = new FakeExecutionRepository();
    const executeProvider: BinaryCalibrationProviderExecutor = async ({ beforePhysicalCall }) => {
      await beforePhysicalCall();
      return {
        outcome: "abstain",
        providerObservation: {
          provider: "openai",
          observedModel: "gpt-observed",
          observedVersion: null,
          systemFingerprint: null,
          upstreamProvider: null
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
      result: { state: "outcome", outcome: "abstain" },
      attemptState: "terminal",
      providerObservation: {
        provider: "openai",
        observedModel: "gpt-observed",
        observedVersion: null,
        systemFingerprint: null,
        upstreamProvider: null
      }
    }]);
  });

  it("records an abstention from a typed-question evaluator as invalid output, since one never abstains", async () => {
    const repository = new FakeExecutionRepository();
    repository.evaluator = {
      kind: "typed-question",
      question: { type: "noul", instructions: "Is it answered?", criteria: { true: "Yes.", false: "No." } },
      threshold: 0.5
    };
    const executeProvider: BinaryCalibrationProviderExecutor = async ({ beforePhysicalCall }) => {
      await beforePhysicalCall();
      return {
        outcome: "abstain",
        providerObservation: { provider: "openai", observedModel: "gpt-observed", observedVersion: null, systemFingerprint: null, upstreamProvider: null }
      };
    };
    await expect(processBinaryCalibrationRun({ repository, executeProvider, runId: "cal_run_1", workerId: "worker_1" })).resolves.toBe(MINT);
    expect(repository.completeInputs).toEqual([expect.objectContaining({
      result: { state: "failure", failureKind: "invalid_evaluator_output" }, attemptState: "terminal"
    })]);
  });

  it("keeps what a failed call observed, and nothing for a refusal before the call", async () => {
    const observed = { model: "gpt-observed", systemFingerprint: "fp_1", requestId: "REQUEST_ID_CANARY", responseId: null, upstreamProvider: null, thinkingReturned: false, reasoningTokens: null };
    const afterCall = new FakeExecutionRepository();
    await processBinaryCalibrationRun({
      repository: afterCall,
      executeProvider: async ({ beforePhysicalCall }) => {
        await beforePhysicalCall();
        throw new BinaryCalibrationProviderError("invalid_evaluator_output", "cut off", { physicalCall: true, observed });
      },
      runId: "cal_run_1",
      workerId: "worker_1"
    });
    expect(afterCall.completeInputs[0]).toEqual({
      result: { state: "failure", failureKind: "invalid_evaluator_output" },
      attemptState: "terminal",
      providerObservation: { provider: "openai", observedModel: "gpt-observed", observedVersion: null, systemFingerprint: "fp_1", upstreamProvider: null }
    });

    const refused = new FakeExecutionRepository();
    await processBinaryCalibrationRun({
      repository: refused,
      executeProvider: async () => {
        throw new BinaryCalibrationProviderError("provider_unavailable", "no key", { physicalCall: false, observed });
      },
      runId: "cal_run_1",
      workerId: "worker_1"
    });
    expect(refused.physicalProviderCalls).toBe(0);
    expect(refused.completeInputs[0]?.providerObservation).toEqual({
      provider: "openai", observedModel: null, observedVersion: null, systemFingerprint: null, upstreamProvider: null
    });
  });

  it("runs each attempt as one executor call, counted once, with the provider's observation", async () => {
    const repository = new FakeExecutionRepository();
    const sent: string[] = [];
    const executeProvider = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => "sk-project",
      fetch: async (url, init) => {
        sent.push(url);
        expect(repository.physicalProviderCalls).toBe(sent.length);
        expect(JSON.parse(init.body)).toMatchObject({ model: "gpt-pinned", reasoning_effort: "low" });
        return new Response(JSON.stringify({
          id: "c", model: "gpt-pinned-2026", system_fingerprint: "fp_2",
          choices: [{ message: { content: JSON.stringify({ label: "fail", score: 0.1, rationale: "RATIONALE_CANARY" }) }, finish_reason: "stop" }]
        }));
      }
    });
    await expect(processBinaryCalibrationRun({ repository, executeProvider, runId: "cal_run_1", workerId: "worker_1" })).resolves.toBe(MINT);
    expect(sent).toEqual(["https://api.openai.com/v1/chat/completions"]);
    expect(repository.physicalProviderCalls).toBe(1);
    expect(repository.completeInputs).toEqual([{
      result: { state: "outcome", outcome: "fail" },
      attemptState: "terminal",
      providerObservation: { provider: "openai", observedModel: "gpt-pinned-2026", observedVersion: null, systemFingerprint: "fp_2", upstreamProvider: null }
    }]);
    expect(JSON.stringify(repository.completeInputs)).not.toContain("CANARY");
  });

  describe("the re-check before the first authorization (ADR-0014 section 4)", () => {
    const counting = () => {
      let calls = 0;
      return { executeProvider: successfulExecutor(() => { calls += 1; }), calls: () => calls };
    };

    it("authorizes and runs when the resolution still holds, recording the re-check", async () => {
      const repository = new FakeExecutionRepository();
      const provider = counting();
      const seen: string[] = [];
      await expect(processBinaryCalibrationRun({
        repository, executeProvider: provider.executeProvider, runId: "cal_run_1", workerId: "worker_1",
        recheck: async (binding) => { seen.push(binding.executionBinding.modelId); return { outcome: "holds", probes: [] }; }
      })).resolves.toBe(MINT);
      expect(seen).toEqual(["gpt-pinned"]);
      expect(repository.rechecks).toEqual(["holds"]);
      expect(repository.authorizeCalls).toBe(1);
      expect(provider.calls()).toBe(1);
    });

    it("rejects the run before any authorization or sealed call when the resolution no longer holds", async () => {
      const repository = new FakeExecutionRepository();
      const provider = counting();
      await expect(processBinaryCalibrationRun({
        repository, executeProvider: provider.executeProvider, runId: "cal_run_1", workerId: "worker_1",
        recheck: async () => ({ outcome: "no_longer_holds", probes: [] })
      })).resolves.toBeNull();
      expect(repository.rejections).toEqual(["resolution_no_longer_holds"]);
      expect(repository.authorizeCalls).toBe(0);
      expect(provider.calls()).toBe(0);
    });

    it("waits on a transient error without failing the binding, and backs off before the next re-check", async () => {
      const repository = new FakeExecutionRepository();
      const provider = counting();
      let probes = 0;
      const recheck = async () => { probes += 1; return { outcome: "unknown" as const, probes: [] }; };
      await expect(processBinaryCalibrationRun({
        repository, executeProvider: provider.executeProvider, runId: "cal_run_1", workerId: "worker_1", recheck
      })).resolves.toBeNull();
      expect(repository.rechecks).toEqual(["unknown"]);
      expect(repository.recoveryMarks).toBe(1);
      expect(repository.rejections).toEqual([]);
      expect(repository.authorizeCalls).toBe(0);

      repository.msSinceUnknownRecheck = 4 * 60_000;
      await expect(processBinaryCalibrationRun({
        repository, executeProvider: provider.executeProvider, runId: "cal_run_1", workerId: "worker_1", recheck
      })).resolves.toBeNull();
      expect(probes).toBe(1);
      expect(repository.recoveryMarks).toBe(2);

      repository.msSinceUnknownRecheck = 6 * 60_000;
      await processBinaryCalibrationRun({
        repository, executeProvider: provider.executeProvider, runId: "cal_run_1", workerId: "worker_1", recheck
      });
      expect(probes).toBe(2);
      expect(provider.calls()).toBe(0);
    });

    it("treats a re-check that throws as unknown, recording it so the back-off applies", async () => {
      const repository = new FakeExecutionRepository();
      const provider = counting();
      await expect(processBinaryCalibrationRun({
        repository, executeProvider: provider.executeProvider, runId: "cal_run_1", workerId: "worker_1",
        recheck: async () => { throw new Error("capability read crashed"); }
      })).resolves.toBeNull();
      expect(repository.rechecks).toEqual(["unknown"]);
      expect(repository.recoveryMarks).toBe(1);
      expect(repository.authorizeCalls).toBe(0);
      expect(provider.calls()).toBe(0);
    });

    it("never re-checks a run that already passed authorization", async () => {
      const repository = new FakeExecutionRepository();
      repository.authorized = true;
      let probes = 0;
      await processBinaryCalibrationRun({
        repository, executeProvider: counting().executeProvider, runId: "cal_run_1", workerId: "worker_1",
        recheck: async () => { probes += 1; return { outcome: "no_longer_holds", probes: [] }; }
      });
      expect(probes).toBe(0);
      expect(repository.rejections).toEqual([]);
    });
  });
});
