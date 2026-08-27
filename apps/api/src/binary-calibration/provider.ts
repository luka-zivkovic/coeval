import {
  AnthropicJudgeProvider,
  OpenAIJudgeProvider,
  type JudgeProvider,
  type JudgePrompt,
  type Trace
} from "@coeval/audit/runtime";
import {
  GovernedReviewPayloadSnapshotSchema,
  normalizeJudgeProviderId,
  renderJudgePromptContent,
  type BinaryCalibrationErrorCode,
  type BinaryCalibrationPrivateProviderObservation,
  type JudgeProviderId,
  type ModelBinding
} from "@coeval/shared";
import {
  judgeProviderEnvironmentKey,
  type JudgeProviderOptions
} from "../lib/judge-provider.js";
import type {
  BinaryCalibrationAttemptWorkItem,
  BinaryCalibrationAuthorizedRun,
  BinaryCalibrationRequestedModelBinding
} from "./repository.js";
import { binaryCalibrationBaseUrlDigest } from "./repository.js";

export type BinaryCalibrationCredentialResolver = (
  projectId: string,
  provider: JudgeProviderId
) => Promise<string | null>;

export interface BinaryCalibrationProviderFactoryInput {
  binding: ModelBinding;
  requestedBinding: BinaryCalibrationRequestedModelBinding;
  provider: Exclude<JudgeProviderId, "mock">;
  temperature: number;
  options: JudgeProviderOptions;
}

export type BinaryCalibrationProviderFactory = (
  input: BinaryCalibrationProviderFactoryInput
) => JudgeProvider;

export interface BinaryCalibrationProviderResult {
  terminalEvaluatorOutcome: "evaluator_pass" | "evaluator_fail" | "abstained";
  providerObservation: BinaryCalibrationPrivateProviderObservation;
}

export type BinaryCalibrationBeforePhysicalCall = () => Promise<void>;

export type BinaryCalibrationProviderExecutor = (input: {
  authorizedRun: BinaryCalibrationAuthorizedRun;
  attempt: BinaryCalibrationAttemptWorkItem;
  beforePhysicalCall: BinaryCalibrationBeforePhysicalCall;
}) => Promise<BinaryCalibrationProviderResult>;

/**
 * Closed, persistence-free provider path for sealed calibration. It never
 * calls judgeAndRecord and its result type cannot carry rationale, raw output,
 * request IDs, response IDs, prompts, or credentials into the private ledger.
 */
export function createBinaryCalibrationProviderExecutor(input: {
  resolveProjectCredential: BinaryCalibrationCredentialResolver;
  providerFactory?: BinaryCalibrationProviderFactory;
}): BinaryCalibrationProviderExecutor {
  const providerFactory = input.providerFactory ?? createExactProvider;

  return async ({ authorizedRun, attempt, beforePhysicalCall }) => {
    const binding = authorizedRun.requestedModelBinding;

    // v1 deliberately does not define top-p request transport semantics. Fail
    // before credential lookup, provider construction, or durable call-start.
    if (binding.topPDecimal !== null) {
      throw new BinaryCalibrationProviderError(
        "provider_protocol",
        "The requested calibration binding uses an unsupported parameter."
      );
    }

    const providerId = requireExactExecutionBinding(authorizedRun);
    const temperature = parseTemperature(binding.temperatureDecimal);
    const projectCredential = await input.resolveProjectCredential(
      authorizedRun.projectId,
      providerId
    );
    // A project credential is authoritative. Environment fallback happens
    // only when the project has no credential; an auth rejection after that
    // point is never retried with a different key.
    const apiKey = projectCredential ?? judgeProviderEnvironmentKey(providerId);
    if (!apiKey) {
      throw new BinaryCalibrationProviderError(
        "provider_unavailable",
        "The requested calibration provider is unavailable."
      );
    }

    let provider: JudgeProvider;
    try {
      provider = providerFactory({
        binding: authorizedRun.executionModelBinding,
        requestedBinding: binding,
        provider: providerId,
        temperature,
        options: { apiKey }
      });
    } catch {
      throw new BinaryCalibrationProviderError(
        "provider_unavailable",
        "The requested calibration provider is unavailable."
      );
    }

    if (provider.name !== binding.provider || provider.modelName !== binding.modelId) {
      throw new BinaryCalibrationProviderError(
        "provider_protocol",
        "The provider did not preserve the requested calibration binding."
      );
    }

    const prompt: JudgePrompt = {
      id: authorizedRun.skillVersionId,
      name: authorizedRun.skillVersionId,
      kind: "unified",
      content: renderJudgePromptContent(authorizedRun.evaluator)
    };
    const trace = traceFromProtectedPayload(attempt);
    assertCustomBaseUrlDigest(authorizedRun);

    // This await is the last operation before the single provider invocation.
    // If it rejects, the provider is never entered. Once it resolves, any
    // failure is accounted as the result of the already-counted physical call.
    await beforePhysicalCall();

    try {
      const result = await provider.judgeStructured({
        prompt,
        trace,
        spec: {
          verdictKind: "binary",
          scalarRange: null,
          categoricalChoiceScores: null
        }
      });
      if (result.verdict.kind !== "binary") {
        throw new BinaryCalibrationProviderError(
          "invalid_evaluator_output",
          "The calibration provider returned an invalid evaluator output."
        );
      }
      return {
        terminalEvaluatorOutcome: result.verdict.label === "ambiguous"
          ? "abstained"
          : result.verdict.label === "pass"
            ? "evaluator_pass"
            : "evaluator_fail",
        providerObservation: {
          // Provider is the exact requested value, already checked as a
          // canonical supported ID. Observed fields are response-derived only.
          provider: binding.provider,
          observedModel: nonEmptyOrNull(result.providerMetadata?.model),
          observedVersion: null,
          systemFingerprint: nonEmptyOrNull(
            result.providerMetadata?.systemFingerprint
          )
        }
      };
    } catch (error) {
      if (error instanceof BinaryCalibrationProviderError) throw error;
      throw sanitizeProviderFailure(error);
    }
  };
}

export class BinaryCalibrationProviderError extends Error {
  constructor(
    public readonly code: BinaryCalibrationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BinaryCalibrationProviderError";
  }
}

export function requestedOnlyProviderObservation(
  binding: BinaryCalibrationRequestedModelBinding
): BinaryCalibrationPrivateProviderObservation {
  return {
    provider: binding.provider,
    observedModel: null,
    observedVersion: null,
    systemFingerprint: null
  };
}

function createExactProvider(
  input: BinaryCalibrationProviderFactoryInput
): JudgeProvider {
  const apiKey = input.options.apiKey;
  if (!apiKey) {
    throw new BinaryCalibrationProviderError(
      "provider_unavailable",
      "The requested calibration provider is unavailable."
    );
  }
  if (input.provider === "anthropic") {
    return new AnthropicJudgeProvider({
      apiKey,
      model: input.binding.modelId,
      temperature: input.temperature,
      requestPolicy: "single_physical_call"
    });
  }
  const baseUrl = input.provider === "openrouter"
    ? "https://openrouter.ai/api/v1"
    : input.provider === "custom"
      ? input.binding.baseUrl
      : "https://api.openai.com/v1";
  if (!baseUrl) {
    throw new BinaryCalibrationProviderError(
      "provider_unavailable",
      "The requested calibration endpoint cannot be resolved exactly."
    );
  }
  return new OpenAIJudgeProvider({
    apiKey,
    baseUrl,
    providerName: input.provider,
    model: input.binding.modelId,
    temperature: input.temperature
  });
}

function requireExactExecutionBinding(
  authorizedRun: BinaryCalibrationAuthorizedRun
): Exclude<JudgeProviderId, "mock"> {
  const requested = authorizedRun.requestedModelBinding;
  const execution = authorizedRun.executionModelBinding;
  const normalized = normalizeJudgeProviderId(execution.provider);
  if (normalized !== execution.provider || execution.provider !== requested.provider) {
    throw new BinaryCalibrationProviderError(
      "provider_protocol",
      "The requested calibration provider identifier is not canonical."
    );
  }
  const expectedTemperature = parseTemperature(requested.temperatureDecimal);
  if (
    execution.modelId !== requested.modelId ||
    execution.modelVersion !== requested.modelVersion ||
    !Object.is(execution.temperature, expectedTemperature) ||
    execution.topP !== undefined
  ) {
    throw new BinaryCalibrationProviderError(
      "provider_protocol",
      "The private execution binding does not match the authorized binding."
    );
  }
  const isCustom = normalized === "custom";
  if (
    normalized === null ||
    normalized === "mock" ||
    (isCustom &&
      (requested.endpointKind !== "custom" ||
        requested.baseUrlDigest === null ||
        !execution.baseUrl)) ||
    (!isCustom &&
      (requested.endpointKind !== "managed" ||
        requested.baseUrlDigest !== null ||
        execution.baseUrl !== undefined))
  ) {
    throw new BinaryCalibrationProviderError(
      "provider_unavailable",
      "The requested calibration endpoint cannot be resolved exactly."
    );
  }
  assertCustomBaseUrlDigest(authorizedRun);
  return normalized;
}

function assertCustomBaseUrlDigest(
  authorizedRun: BinaryCalibrationAuthorizedRun
): void {
  const requested = authorizedRun.requestedModelBinding;
  const baseUrl = authorizedRun.executionModelBinding.baseUrl;
  if (requested.endpointKind !== "custom") return;
  if (
    !baseUrl ||
    requested.baseUrlDigest === null ||
    binaryCalibrationBaseUrlDigest(baseUrl) !== requested.baseUrlDigest
  ) {
    throw new BinaryCalibrationProviderError(
      "provider_protocol",
      "The private calibration endpoint does not match its authorized digest."
    );
  }
}

function parseTemperature(value: string): number {
  const temperature = Number(value);
  if (
    !CANONICAL_DECIMAL_PATTERN.test(value) ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    throw new BinaryCalibrationProviderError(
      "provider_protocol",
      "The requested calibration temperature is invalid."
    );
  }
  return temperature;
}

function traceFromProtectedPayload(
  attempt: BinaryCalibrationAttemptWorkItem
): Trace {
  const parsed = GovernedReviewPayloadSnapshotSchema.safeParse(
    attempt.payloadSnapshot
  );
  if (!parsed.success) {
    throw new BinaryCalibrationProviderError(
      "internal",
      "The protected calibration payload is invalid."
    );
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

function sanitizeProviderFailure(error: unknown): BinaryCalibrationProviderError {
  const status = statusFromError(error);
  if (status === 401 || status === 403) {
    return new BinaryCalibrationProviderError(
      "provider_authentication",
      "The calibration provider rejected authentication."
    );
  }
  if (status === 429) {
    return new BinaryCalibrationProviderError(
      "provider_rate_limit",
      "The calibration provider rate-limited the request."
    );
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "AbortError" || /\btimeout|timed out\b/i.test(message)) {
    return new BinaryCalibrationProviderError(
      "provider_timeout",
      "The calibration provider request timed out."
    );
  }
  if (
    name === "ZodError" ||
    /arguments were not valid json|invalid evaluator output/i.test(message)
  ) {
    return new BinaryCalibrationProviderError(
      "invalid_evaluator_output",
      "The calibration provider returned an invalid evaluator output."
    );
  }
  if (
    status !== null ||
    /tool(?:_|-| )?(?:use|call)|invalid json|valid json|structured verdict|schema|response/i.test(
      message
    )
  ) {
    return new BinaryCalibrationProviderError(
      status !== null && status >= 500
        ? "provider_unavailable"
        : "provider_protocol",
      "The calibration provider returned an invalid response."
    );
  }
  if (
    name === "TypeError" ||
    /\bfetch\b|\bnetwork\b|\bconnection\b|\beconn|\bsocket\b|\bdns\b/i.test(message)
  ) {
    return new BinaryCalibrationProviderError(
      "provider_transport",
      "The calibration provider request failed in transport."
    );
  }
  return new BinaryCalibrationProviderError(
    "internal",
    "The calibration provider request failed."
  );
}

function statusFromError(error: unknown): number | null {
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  const message = error instanceof Error ? error.message : "";
  const match = message.match(/(?:failed:\s*|\b)([45]\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (Array.from(value).length > 4_096 || hasLoneUtf16Surrogate(value)) {
    return null;
  }
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

const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
