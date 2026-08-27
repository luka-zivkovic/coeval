import {
  AnthropicJudgeProvider,
  MockJudgeProvider,
  OpenAIJudgeProvider,
  type JudgeProvider,
  type JudgeVerdict,
  type StructuredVerdict,
  type VerdictSpec
} from "@coeval/audit/runtime";
import {
  verdictLabelFromPayload,
  type JudgeProviderAvailabilityItem,
  type JudgeProviderId,
  type StoredModelBinding,
  type SkillVersion,
  type VerdictPayload
} from "@coeval/shared";

// Factory keyed by a skill version's immutable requested `modelBinding`. This is what makes
// the platform judge *real*: the worker (and the eval-as-a-service endpoint)
// instantiate the provider the skill version actually pins, so self-consistency
// / convergence / calibration describe the model as run — not a single injected
// stand-in.
//
// A project-scoped key is authoritative when present; otherwise first-class
// providers can use their platform environment key. Missing credentials fall
// back to the mock only in permissive demo paths. Strict production paths turn
// that fallback into JudgeProviderUnavailableError.
export interface JudgeProviderOptions {
  apiKey?: string;
}
export type JudgeProviderFactory = (binding: StoredModelBinding, opts?: JudgeProviderOptions) => JudgeProvider;

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

export function judgeProviderEnvironmentKey(provider: JudgeProviderId): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
  return undefined;
}

export function resolveJudgeProviderApiKey(provider: JudgeProviderId, projectApiKey?: string): string | undefined {
  return projectApiKey ?? judgeProviderEnvironmentKey(provider);
}

// Shared by runtime dispatch and model discovery so an OpenAI-compatible
// deployment never executes against one base URL while sending its credential
// to another provider's /models endpoint.
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

// Strict variant: same construction, but a binding that would degrade to the
// mock throws instead. Used where recording a mock verdict would be a lie
// (eval runs and the sync judge endpoint in PG mode); the permissive factory
// below stays the default so demo mode and provider-injecting tests work.
export function createStrictJudgeProvider(binding: StoredModelBinding, opts?: JudgeProviderOptions): JudgeProvider {
  const provider = createJudgeProvider(binding, opts);
  if (binding.provider !== "mock" && provider.name === "mock") {
    throw new JudgeProviderUnavailableError(binding.provider);
  }
  return provider;
}

export function createJudgeProvider(binding: StoredModelBinding, opts?: JudgeProviderOptions): JudgeProvider {
  const provider = binding.provider;

  if (provider === "mock") return new MockJudgeProvider();

  if (provider === "anthropic") {
    const apiKey = resolveJudgeProviderApiKey(provider, opts?.apiKey);
    if (!apiKey) {
      warnOnce("anthropic", "ANTHROPIC_API_KEY is not set; judge falling back to MockJudgeProvider.");
      return new MockJudgeProvider();
    }
    return new AnthropicJudgeProvider({
      apiKey,
      model: binding.modelId,
      temperature: binding.temperature,
      // Eval-item workers keep one durable physical-call ledger. SDK retries
      // and the ordinary temperature-compatibility retry would make that
      // ledger false, so runtime judging uses exactly one transport attempt.
      requestPolicy: "single_physical_call"
    });
  }

  if (provider === "openai") {
    const apiKey = resolveJudgeProviderApiKey(provider, opts?.apiKey);
    if (!apiKey) {
      warnOnce("openai", "OPENAI_API_KEY is not set; judge falling back to MockJudgeProvider.");
      return new MockJudgeProvider();
    }
    const baseUrl = openAIJudgeProviderBaseUrl();
    return new OpenAIJudgeProvider({
      apiKey,
      model: binding.modelId,
      temperature: binding.temperature,
      ...(baseUrl ? { baseUrl } : {})
    });
  }

  if (provider === "openrouter" || provider === "custom") {
    const apiKey = resolveJudgeProviderApiKey(provider, opts?.apiKey);
    if (!apiKey) {
      warnOnce(provider, `${PROVIDER_LABELS[provider]} API key is not set; judge falling back to MockJudgeProvider.`);
      return new MockJudgeProvider();
    }
    const baseUrl = provider === "openrouter" ? "https://openrouter.ai/api/v1" : binding.baseUrl;
    if (!baseUrl) {
      warnOnce("custom:base-url", "Custom judge provider has no base URL; judge falling back to MockJudgeProvider.");
      return new MockJudgeProvider();
    }
    return new OpenAIJudgeProvider({
      apiKey,
      baseUrl,
      providerName: provider,
      model: binding.modelId,
      temperature: binding.temperature
    });
  }

  warnOnce(`unknown:${binding.provider}`, `Unknown judge provider "${binding.provider}"; falling back to MockJudgeProvider.`);
  return new MockJudgeProvider();
}

// is this error the provider rejecting the CREDENTIAL (as opposed to a
// transient failure)? Auth rejections are permanent — retrying spends nothing
// but time, and with a BYO project key the honest behavior is to fail the
// judge call loudly, never to fall back to the platform env key.
export function isJudgeAuthError(error: unknown): boolean {
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
  return {
    label,
    score: verdict.score,
    reason: verdict.rationale,
    confidence: verdict.score
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
