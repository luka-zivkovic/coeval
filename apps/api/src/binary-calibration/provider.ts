import {
  EvaluatorCallError,
  executeTypedQuestion,
  executeVerdict,
  type ExecutionFetch,
  type ObservedProvenance
} from "@rubrist/audit/runtime";
import {
  GovernedReviewPayloadSnapshotSchema,
  type BinaryCalibrationV2ErrorCode,
  type BinaryCalibrationV2PrivateProviderObservation,
  type EvaluatorItemOutcome,
  type ExecutionBinding,
  type JudgeProviderId
} from "@rubrist/shared";
import { endpointUrlFor } from "../lib/execution-binding.js";
import { judgeProviderEnvironmentKey } from "../lib/judge-provider.js";
import type {
  BinaryCalibrationAttemptWorkItem,
  BinaryCalibrationAuthorizedRun
} from "./repository.js";

export type BinaryCalibrationCredentialResolver = (
  projectId: string,
  provider: JudgeProviderId
) => Promise<string | null>;

export interface BinaryCalibrationProviderResult {
  outcome: EvaluatorItemOutcome;
  providerObservation: BinaryCalibrationV2PrivateProviderObservation;
}

export type BinaryCalibrationBeforePhysicalCall = () => Promise<void>;

export type BinaryCalibrationProviderExecutor = (input: {
  authorizedRun: BinaryCalibrationAuthorizedRun;
  attempt: BinaryCalibrationAttemptWorkItem;
  beforePhysicalCall: BinaryCalibrationBeforePhysicalCall;
}) => Promise<BinaryCalibrationProviderResult>;

/**
 * Closed, persistence-free provider path for sealed calibration. Each attempt
 * is one call of the evaluator's executor (ADR-0014 sections 2, 5, and 6):
 * the run's pinned binding, sent exactly, in one physical call; a prompted
 * protocol through executeVerdict, typed-question/v1 through
 * executeTypedQuestion. The result can't carry a rationale, raw output,
 * request or response IDs, prompts, questions, or credentials into the
 * private ledger.
 */
export function createBinaryCalibrationProviderExecutor(input: {
  resolveProjectCredential: BinaryCalibrationCredentialResolver;
  fetch?: ExecutionFetch;
  timeoutMs?: number;
}): BinaryCalibrationProviderExecutor {
  return async ({ authorizedRun, attempt, beforePhysicalCall }) => {
    const binding = authorizedRun.executionBinding;
    if (binding.provider === "mock") {
      throw new BinaryCalibrationProviderError(
        "internal",
        "Sealed calibration runs only an evaluator on a provider it calls.",
        { physicalCall: false }
      );
    }
    // A project credential is authoritative. The platform key applies only
    // when the project has none; an auth rejection is never retried with it.
    const projectCredential = await input.resolveProjectCredential(authorizedRun.projectId, binding.provider);
    const apiKey = projectCredential ?? judgeProviderEnvironmentKey(binding.provider) ?? null;
    const trace = traceFromProtectedPayload(attempt);
    // Whether the call-start record was written (a request may have left),
    // and whether writing it failed, which is the repository's to recover.
    let dispatched = false;
    let callStartFailed = false;

    // The last step before the one physical call, after every refusal: each
    // invocation is one durable physical-call count.
    const beforeDispatch = async () => {
      try {
        await beforePhysicalCall();
      } catch (error) {
        callStartFailed = true;
        throw error;
      }
      dispatched = true;
    };
    const transport = {
      beforeDispatch,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
    };

    try {
      const evaluator = authorizedRun.evaluator;
      if (evaluator.kind === "typed-question") {
        // A typed-question verdict is pass or fail on its threshold; it never abstains.
        const result = await executeTypedQuestion({
          binding,
          apiKey,
          evaluator: { question: evaluator.question, threshold: evaluator.threshold },
          trace,
          ...transport
        });
        return { outcome: result.verdict.label, providerObservation: providerObservationFor(binding, result.observed) };
      }
      const result = await executeVerdict({
        binding,
        apiKey,
        customBaseUrl: endpointUrlFor(authorizedRun),
        rubricMarkdown: evaluator.rubricMarkdown,
        prompt: evaluator.prompt,
        trace,
        spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null },
        ...transport
      });
      if (result.verdict.kind !== "binary") {
        throw new BinaryCalibrationProviderError(
          "invalid_evaluator_output",
          "The calibration provider returned an invalid evaluator output.",
          { physicalCall: true, observed: result.observed }
        );
      }
      return {
        outcome: result.verdict.label === "ambiguous" ? "abstain" : result.verdict.label,
        providerObservation: providerObservationFor(binding, result.observed)
      };
    } catch (error) {
      // A call-start record that couldn't be written is no provider outcome;
      // the worker hands the run to recovery.
      if (callStartFailed) throw error;
      if (error instanceof BinaryCalibrationProviderError) throw error;
      if (error instanceof EvaluatorCallError) {
        throw new BinaryCalibrationProviderError(error.failureKind, "The calibration provider call failed.", {
          physicalCall: error.physicalCall,
          observed: {
            model: error.observed?.model ?? null,
            systemFingerprint: error.observed?.systemFingerprint ?? null,
            // The executor records an OpenRouter error's upstream, and only an OpenRouter binding's.
            upstreamProvider: error.observed?.upstreamProvider ?? null
          }
        });
      }
      throw new BinaryCalibrationProviderError("internal", "The calibration provider call failed.", { physicalCall: dispatched });
    }
  };
}

/**
 * A provider call that ended without an outcome. `physicalCall` says whether
 * a request left Rubrist; the observation keeps only what the provider
 * returned before the failure.
 */
/** What the ledger keeps of a call's observed provenance. */
export type CalibrationObservation = Pick<ObservedProvenance, "model" | "systemFingerprint" | "upstreamProvider">;

export class BinaryCalibrationProviderError extends Error {
  readonly physicalCall: boolean;
  readonly observed: CalibrationObservation | null;

  constructor(
    public readonly code: BinaryCalibrationV2ErrorCode,
    message: string,
    options: { physicalCall: boolean; observed?: CalibrationObservation | null }
  ) {
    super(message);
    this.name = "BinaryCalibrationProviderError";
    this.physicalCall = options.physicalCall;
    this.observed = options.observed ?? null;
  }
}

/** The ledger observation of a call: the requested provider and what the provider returned. */
export function providerObservationFor(
  binding: ExecutionBinding,
  observed: CalibrationObservation | null
): BinaryCalibrationV2PrivateProviderObservation {
  const observedModel = boundedOrNull(observed?.model);
  return {
    provider: binding.provider,
    observedModel,
    observedVersion: null,
    // A fingerprint or upstream only counts beside an observed model.
    systemFingerprint: observedModel === null ? null : boundedOrNull(observed?.systemFingerprint),
    upstreamProvider: binding.provider === "openrouter" ? boundedOrNull(observed?.upstreamProvider) : null
  };
}

export function requestedOnlyProviderObservation(
  binding: ExecutionBinding
): BinaryCalibrationV2PrivateProviderObservation {
  return providerObservationFor(binding, null);
}

function traceFromProtectedPayload(attempt: BinaryCalibrationAttemptWorkItem) {
  const parsed = GovernedReviewPayloadSnapshotSchema.safeParse(attempt.payloadSnapshot);
  if (!parsed.success) {
    throw new BinaryCalibrationProviderError("internal", "The protected calibration payload is invalid.", { physicalCall: false });
  }
  const payload = parsed.data;
  return {
    // Do not transmit the protected revision item digest as a trace identity.
    // The fixed transport-local ID has no persistence or cross-item meaning.
    id: "sealed-observation",
    input: payload.input,
    output: payload.output,
    ...(payload.steps !== undefined ? { steps: payload.steps } : {})
  };
}

function boundedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (Array.from(value).length > 4_096 || hasLoneUtf16Surrogate(value)) return null;
  return value;
}

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
