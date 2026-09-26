import {
  EvaluatorCallError,
  MockJudgeProvider,
  assertCredential,
  assertPromptedBinding,
  executeVerdict,
  resolveEndpointBaseUrl,
  type JudgePrompt,
  type JudgeProvider,
  type JudgeVerdict,
  type StructuredJudgeResult,
  type StructuredVerdict,
  type Trace,
  type VerdictSpec
} from "@rubrist/audit/runtime";
import {
  verdictLabelFromPayload,
  type ExecutionProviderId,
  type JudgeProviderAvailabilityItem,
  type JudgeProviderId,
  type SkillVersion,
  type VerdictPayload
} from "@rubrist/shared";
import { endpointUrlFor } from "./execution-binding.js";

// Factory keyed by an evaluator version's immutable execution binding
// (ADR-0014 section 2). The worker and the eval-as-a-service endpoint build
// the provider the version pins, so every call sends exactly what the binding
// states, through the pinned verdict protocol, in one physical call.
//
// A project-scoped key is authoritative when present; otherwise first-class
// providers can use their platform environment key. Missing credentials fall
// back to the mock only in permissive demo paths. Strict production paths turn
// that fallback into JudgeProviderUnavailableError.
export interface JudgeProviderOptions {
  apiKey?: string;
}

/** What the runtime needs from an evaluator version: its binding, its endpoint URL, and what the protocol renders. */
export type EvaluatorRuntimeVersion = Pick<SkillVersion, "executionBinding" | "customEndpointUrl" | "rubricMarkdown" | "prompt">;
export type JudgeProviderFactory = (version: EvaluatorRuntimeVersion, opts?: JudgeProviderOptions) => JudgeProvider;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

// A non-mock binding would silently degrade to the mock (missing credentials).
// Thrown by the strict factory so honest surfaces (eval runs, the v1 judge
// endpoints in PG mode) refuse instead of recording mock verdicts under a
// real-provider skill version. Treated as a permanent error by the workers —
// the eval item fails with this message rather than retrying forever.
export class JudgeProviderUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(
      `Judge provider "${provider}" is unavailable: the server has no credentials for it, and running the judge would silently record mock verdicts. Set the provider API key, or choose provider "mock" explicitly.`
    );
    this.name = "JudgeProviderUnavailableError";
  }
}

const PROVIDER_LABELS: Record<JudgeProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  custom: "Custom OpenAI-compatible",
  mock: "Mock (local testing)"
};

export function judgeProviderEnvironmentKey(provider: ExecutionProviderId): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
  return undefined;
}

export function resolveJudgeProviderApiKey(provider: ExecutionProviderId, projectApiKey?: string): string | undefined {
  return projectApiKey ?? judgeProviderEnvironmentKey(provider);
}

// Model discovery and auxiliary drafting only. Evidence-producing calls never
// read it: an OpenAI binding records the override as its endpoint instead.
export function openAIJudgeProviderBaseUrl(): string | undefined {
  return process.env.OPENAI_BASE_URL?.trim() || undefined;
}

// Credential availability only — never returns the credential itself. Real
// providers come first so the editor prefers one over the built-in mock.
export function judgeProviderAvailability(
  projectKeyProviders?: ReadonlySet<string>,
  allowMock = true
): JudgeProviderAvailabilityItem[] {
  const providers: JudgeProviderId[] = ["anthropic", "openai", "openrouter", "custom", "mock"];
  return providers.map((provider) => {
    if (provider === "mock") {
      return {
        provider,
        label: PROVIDER_LABELS[provider],
        available: allowMock,
        credentialSource: "built_in" as const,
        modelSelection: "catalog" as const
      };
    }
    const hasProjectKey = Boolean(projectKeyProviders?.has(provider));
    const hasEnvironmentKey = Boolean(judgeProviderEnvironmentKey(provider));
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      available: hasProjectKey || hasEnvironmentKey,
      credentialSource: hasProjectKey ? "project" as const : hasEnvironmentKey ? "environment" as const : null,
      modelSelection: provider === "custom" ? "custom" as const : "catalog" as const
    };
  });
}

/**
 * A provider backed by the v2 executor. It judges with the version's own
 * rubric and prompt, which the pinned protocol renders; the JudgePrompt the
 * worker builds is that same rendering (an API test holds them equal), kept
 * for the recorded request.
 */
class ExecutionBindingJudgeProvider implements JudgeProvider {
  readonly name: string;
  readonly modelName: string;

  constructor(private readonly version: EvaluatorRuntimeVersion, private readonly apiKey: string | null) {
    this.name = version.executionBinding.provider;
    this.modelName = version.executionBinding.modelId;
    // Whatever executeVerdict would refuse before sending is refused here, at
    // construction, before any call-start marker, so the item is recorded as
    // never attempted rather than as a call with an unknown outcome.
    const binding = version.executionBinding;
    assertPromptedBinding(binding);
    if (binding.provider !== "mock") {
      resolveEndpointBaseUrl(binding, endpointUrlFor(version));
      assertCredential(binding.provider, apiKey);
    }
  }

  // The regression gate's pass/fail/ambiguous judgment: a binary structured
  // verdict through the same protocol, in the legacy shape the gate reads.
  async judge(input: { prompt: JudgePrompt; trace: Trace; outputSchema: object }): Promise<JudgeVerdict> {
    const result = await this.judgeStructured({
      prompt: input.prompt,
      trace: input.trace,
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    });
    return structuredVerdictToLegacy(result.verdict);
  }

  async judgeStructured(input: { prompt: JudgePrompt; trace: Trace; spec: VerdictSpec }): Promise<StructuredJudgeResult> {
    const result = await executeVerdict({
      binding: this.version.executionBinding,
      apiKey: this.apiKey,
      customBaseUrl: endpointUrlFor(this.version),
      rubricMarkdown: this.version.rubricMarkdown,
      prompt: this.version.prompt,
      trace: input.trace,
      spec: input.spec
    });
    return {
      verdict: result.verdict,
      ...(result.usage ? { usage: result.usage } : {}),
      providerMetadata: {
        model: result.observed.model,
        requestId: result.observed.requestId,
        responseId: result.observed.responseId,
        systemFingerprint: result.observed.systemFingerprint
      },
      observed: result.observed
    };
  }
}

// Strict variant: same construction, but a binding that would degrade to the
// mock throws instead. Used where recording a mock verdict would be a lie
// (eval runs and the sync judge endpoint in PG mode); the permissive factory
// below stays the default so demo mode and provider-injecting tests work.
export function createStrictJudgeProvider(version: EvaluatorRuntimeVersion, opts?: JudgeProviderOptions): JudgeProvider {
  const provider = createJudgeProvider(version, opts);
  if (version.executionBinding.provider !== "mock" && provider.name === "mock") {
    throw new JudgeProviderUnavailableError(version.executionBinding.provider);
  }
  return provider;
}

export function createJudgeProvider(version: EvaluatorRuntimeVersion, opts?: JudgeProviderOptions): JudgeProvider {
  const provider = version.executionBinding.provider;
  if (provider === "mock") return new ExecutionBindingJudgeProvider(version, null);
  const apiKey = resolveJudgeProviderApiKey(provider, opts?.apiKey);
  if (!apiKey) {
    warnOnce(provider, `${provider} has no API key; judge falling back to MockJudgeProvider.`);
    return new MockJudgeProvider();
  }
  return new ExecutionBindingJudgeProvider(version, apiKey);
}

// is this error the provider rejecting the CREDENTIAL (as opposed to a
// transient failure)? Auth rejections are permanent — retrying spends nothing
// but time, and with a BYO project key the honest behavior is to fail the
// judge call loudly, never to fall back to the platform env key.
export function isJudgeAuthError(error: unknown): boolean {
  if (error instanceof EvaluatorCallError) return error.failureKind === "provider_authentication";
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 401 || status === 403) return true;
  const message = error instanceof Error ? error.message : "";
  return /\b401\b|\b403\b|authentication[_ ]error|invalid x-api-key|incorrect api key|invalid api key/i.test(message);
}

// Translate a skill version's pinned verdict shape into the audit provider's
// verdict spec.
export function specFromSkillVersion(skillVersion: SkillVersion): VerdictSpec {
  return {
    verdictKind: skillVersion.verdictKind,
    scalarRange: skillVersion.scalarRange,
    categoricalChoiceScores: skillVersion.categoricalChoiceScores
  };
}

// Map the provider's structured output onto the shared tagged-union payload —
// the v2 verdict the trust layer (κ / convergence / self-consistency) reads.
export function structuredVerdictToPayload(verdict: StructuredVerdict): VerdictPayload {
  // failingStep rides the payload (append-only compatible; absent for
  // step-less cases and whenever the judge omitted it).
  const step = verdict.failingStep !== undefined ? { failingStep: verdict.failingStep } : {};
  if (verdict.kind === "scalar") {
    return { kind: "scalar", score: verdict.score, range: verdict.range, rationale: verdict.rationale, ...step };
  }
  if (verdict.kind === "categorical") {
    return {
      kind: "categorical",
      choice: verdict.choice,
      choiceScores: verdict.choiceScores,
      rationale: verdict.rationale,
      ...step
    };
  }
  if (verdict.label === "ambiguous") {
    return { kind: "binary", label: "ambiguous", rationale: verdict.rationale };
  }
  return { kind: "binary", pass: verdict.label === "pass", rationale: verdict.rationale, ...step };
}

// Coarse pass/fail/ambiguous projection for the legacy judge_runs row (and the
// dashboard's verdict distribution + LangSmith feedback sync, both of which
// still read judge_runs). The v2 `verdicts` table remains the exact record.
// The label threshold is single-sourced in verdictLabelFromPayload so this
// projection and eval-run resultLabels can never disagree about one verdict.
export function structuredVerdictToLegacy(verdict: StructuredVerdict): JudgeVerdict {
  const label = verdictLabelFromPayload(structuredVerdictToPayload(verdict));
  if (verdict.kind === "scalar") {
    const [min, max] = verdict.range;
    const span = max - min || 1;
    const norm = clamp01((verdict.score - min) / span);
    return {
      label,
      score: norm,
      reason: verdict.rationale,
      confidence: norm
    };
  }
  if (verdict.kind === "categorical") {
    const norm = clamp01(verdict.choiceScores[verdict.choice] ?? 0);
    return {
      label,
      score: norm,
      reason: verdict.rationale,
      confidence: norm
    };
  }
  // The binary score is P(pass); confidence is in the returned label, so a
  // fail scored 0.1 is 0.9 confident. An abstention keeps the score as is.
  return {
    label,
    score: verdict.score,
    reason: verdict.rationale,
    confidence: verdict.label === "fail" ? 1 - verdict.score : verdict.score
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
