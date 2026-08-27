import { describe, expect, it } from "vitest";
import type { JudgeProvider } from "@coeval/audit/runtime";
import {
  BinaryCalibrationProviderError,
  createBinaryCalibrationProviderExecutor,
  type BinaryCalibrationProviderFactoryInput
} from "../src/binary-calibration/provider.js";
import type {
  BinaryCalibrationAttemptWorkItem,
  BinaryCalibrationAuthorizedRun
} from "../src/binary-calibration/repository.js";
import { binaryCalibrationBaseUrlDigest } from "../src/binary-calibration/repository.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function authorizedRun(
  overrides: Partial<BinaryCalibrationAuthorizedRun> = {}
): BinaryCalibrationAuthorizedRun {
  return {
    claim: {
      runId: "cal_run_1",
      workerId: "worker_1",
      claimToken: "claim_1",
      claimExpiresAt: "2026-08-23T12:15:00.000Z"
    },
    projectId: "project_1",
    datasetRevisionId: "revision_1",
    revisionDigest: DIGEST,
    itemCount: 1,
    skillVersionId: "skill_version_1",
    requestedModelBinding: {
      provider: "anthropic",
      modelId: "claude-pinned",
      modelVersion: "claude-pinned",
      temperatureDecimal: "0.25",
      topPDecimal: null,
      endpointKind: "managed",
      baseUrlDigest: null,
      requestedBindingDigest: DIGEST
    },
    executionModelBinding: {
      provider: "anthropic",
      modelId: "claude-pinned",
      modelVersion: "claude-pinned",
      temperature: 0.25
    },
    providerDataHandling: {
      executionEnvironment: "external_provider",
      policyId: "policy_1",
      policyDigest: DIGEST,
      payloadTransmission: "sealed_payload_to_pinned_provider"
    },
    evaluator: {
      rubricMarkdown: "Never persist PROMPT_CANARY.",
      prompt: "Judge against {{rubric_markdown}}.",
      outputSchema: { type: "object" }
    },
    authorization: {
      snapshotDigest: DIGEST,
      eventId: "event_1",
      recordedAt: "2026-08-23T12:00:00.000Z"
    },
    ...overrides
  };
}

const ATTEMPT: BinaryCalibrationAttemptWorkItem = {
  attemptId: "attempt_1",
  runId: "cal_run_1",
  datasetRevisionItemDigest: DIGEST,
  trialIndex: 0,
  payloadSnapshot: {
    input: { question: "INPUT_CANARY" },
    output: { answer: "OUTPUT_CANARY" }
  },
  physicalProviderCalls: 0
};

function provider(
  input: BinaryCalibrationProviderFactoryInput,
  onCall: () => void = () => undefined,
  label: "pass" | "fail" | "ambiguous" = "pass"
): JudgeProvider {
  return {
    name: input.provider,
    modelName: input.binding.modelId,
    judge: async () => ({
      label: "pass",
      score: 1,
      reason: "unused",
      confidence: 1
    }),
    judgeStructured: async ({ prompt, trace }) => {
      onCall();
      expect(prompt.content).toContain("PROMPT_CANARY");
      expect(trace.input).toEqual({ question: "INPUT_CANARY" });
      return {
        verdict: {
          kind: "binary",
          label,
          score: 0.99,
          rationale: "RATIONALE_CANARY"
        },
        providerMetadata: {
          model: "claude-observed",
          requestId: "REQUEST_ID_CANARY",
          responseId: "RESPONSE_ID_CANARY",
          systemFingerprint: "fp_observed"
        }
      };
    }
  };
}

describe("sealed binary calibration provider execution", () => {
  it("rejects non-null topP before credentials, construction, call-start, or dispatch", async () => {
    let credentialReads = 0;
    let constructions = 0;
    let callStarts = 0;
    const base = authorizedRun();
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => {
        credentialReads += 1;
        return "secret";
      },
      providerFactory: (input) => {
        constructions += 1;
        return provider(input);
      }
    });

    await expect(execute({
      authorizedRun: {
        ...base,
        requestedModelBinding: {
          ...base.requestedModelBinding,
          topPDecimal: "0.9"
        },
        executionModelBinding: {
          ...base.executionModelBinding,
          topP: 0.9
        }
      },
      attempt: ATTEMPT,
      beforePhysicalCall: async () => {
        callStarts += 1;
      }
    })).rejects.toMatchObject({ code: "provider_protocol" });

    expect({ credentialReads, constructions, callStarts }).toEqual({
      credentialReads: 0,
      constructions: 0,
      callStarts: 0
    });
  });

  it("uses the exact authorized binding and invokes call-start immediately before one call", async () => {
    const events: string[] = [];
    const factoryInputs: BinaryCalibrationProviderFactoryInput[] = [];
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => "project-secret",
      providerFactory: (input) => {
        factoryInputs.push(input);
        return provider(input, () => events.push("provider"));
      }
    });

    const result = await execute({
      authorizedRun: authorizedRun(),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => {
        events.push("call-start");
      }
    });

    expect(events).toEqual(["call-start", "provider"]);
    expect(factoryInputs).toHaveLength(1);
    expect(factoryInputs[0]).toMatchObject({
      provider: "anthropic",
      temperature: 0.25,
      binding: {
        provider: "anthropic",
        modelId: "claude-pinned",
        modelVersion: "claude-pinned",
        temperature: 0.25
      },
      options: { apiKey: "project-secret" }
    });
    expect(result).toEqual({
      terminalEvaluatorOutcome: "evaluator_pass",
      providerObservation: {
        provider: "anthropic",
        observedModel: "claude-observed",
        observedVersion: null,
        systemFingerprint: "fp_observed"
      }
    });
    const persistedShape = JSON.stringify(result);
    for (const canary of [
      "PROMPT_CANARY",
      "INPUT_CANARY",
      "OUTPUT_CANARY",
      "RATIONALE_CANARY",
      "REQUEST_ID_CANARY",
      "RESPONSE_ID_CANARY",
      "project-secret"
    ]) {
      expect(persistedShape).not.toContain(canary);
    }
  });

  it("maps explicit binary ambiguity to the calibration abstention outcome", async () => {
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => "project-secret",
      providerFactory: (input) => provider(input, () => undefined, "ambiguous")
    });

    const result = await execute({
      authorizedRun: authorizedRun(),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => undefined
    });

    expect(result.terminalEvaluatorOutcome).toBe("abstained");
    expect(result.providerObservation).toMatchObject({
      provider: "anthropic",
      observedModel: "claude-observed"
    });
  });

  it("never enters the provider when durable call-start rejects", async () => {
    let providerCalls = 0;
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => "project-secret",
      providerFactory: (input) => provider(input, () => {
        providerCalls += 1;
      })
    });
    const persistenceError = new Error("DB_CANARY");

    await expect(execute({
      authorizedRun: authorizedRun(),
      attempt: ATTEMPT,
      beforePhysicalCall: async () => {
        throw persistenceError;
      }
    })).rejects.toBe(persistenceError);
    expect(providerCalls).toBe(0);
  });

  it("rejects a private/public binding mismatch before dispatch", async () => {
    let callStarts = 0;
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => "project-secret",
      providerFactory: (input) => provider(input)
    });
    const base = authorizedRun();

    await expect(execute({
      authorizedRun: {
        ...base,
        executionModelBinding: {
          ...base.executionModelBinding,
          modelId: "substituted-model"
        }
      },
      attempt: ATTEMPT,
      beforePhysicalCall: async () => {
        callStarts += 1;
      }
    })).rejects.toMatchObject({ code: "provider_protocol" });
    expect(callStarts).toBe(0);
  });

  it("rejects metadata outside the frozen sealed payload projection", async () => {
    let providerCalls = 0;
    let callStarts = 0;
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => "project-secret",
      providerFactory: (input) => provider(input, () => {
        providerCalls += 1;
      })
    });

    await expect(execute({
      authorizedRun: authorizedRun(),
      attempt: {
        ...ATTEMPT,
        payloadSnapshot: {
          input: { question: "safe" },
          output: { answer: "safe" },
          metadata: { forbidden: "METADATA_CANARY" }
        }
      },
      beforePhysicalCall: async () => {
        callStarts += 1;
      }
    })).rejects.toMatchObject({ code: "internal" });
    expect({ callStarts, providerCalls }).toEqual({ callStarts: 0, providerCalls: 0 });
  });

  it("rechecks the exact custom base URL against its authorized digest", async () => {
    let credentialReads = 0;
    let constructions = 0;
    let callStarts = 0;
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => {
        credentialReads += 1;
        return "project-secret";
      },
      providerFactory: (input) => {
        constructions += 1;
        return provider(input);
      }
    });
    const base = authorizedRun();
    const authorizedBaseUrl = "https://custom.example/v1/";

    await expect(execute({
      authorizedRun: {
        ...base,
        requestedModelBinding: {
          ...base.requestedModelBinding,
          provider: "custom",
          endpointKind: "custom",
          baseUrlDigest: binaryCalibrationBaseUrlDigest(authorizedBaseUrl)
        },
        executionModelBinding: {
          ...base.executionModelBinding,
          provider: "custom",
          baseUrl: "https://substituted.example/v1/"
        }
      },
      attempt: ATTEMPT,
      beforePhysicalCall: async () => {
        callStarts += 1;
      }
    })).rejects.toMatchObject({ code: "provider_protocol" });

    expect({ credentialReads, constructions, callStarts }).toEqual({
      credentialReads: 0,
      constructions: 0,
      callStarts: 0
    });
  });

  it("sanitizes provider errors into a closed code and safe message", async () => {
    const execute = createBinaryCalibrationProviderExecutor({
      resolveProjectCredential: async () => "project-secret",
      providerFactory: (input) => ({
        ...provider(input),
        judgeStructured: async () => {
          throw Object.assign(
            new Error("429 secret response body REQUEST_ID_CANARY"),
            { status: 429 }
          );
        }
      })
    });

    let caught: unknown;
    try {
      await execute({
        authorizedRun: authorizedRun(),
        attempt: ATTEMPT,
        beforePhysicalCall: async () => undefined
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BinaryCalibrationProviderError);
    expect(caught).toMatchObject({
      code: "provider_rate_limit",
      message: "The calibration provider rate-limited the request."
    });
    expect(JSON.stringify(caught)).not.toContain("REQUEST_ID_CANARY");
  });
});
