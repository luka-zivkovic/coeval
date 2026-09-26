import { z } from "zod";
import { containsLoneUtf16Surrogate, JudgeProviderCredentialSourceSchema, UnicodeScalarValueSchema } from "./judge.js";

// Model-agnostic evaluator identity (Rubrist ADR-0014). An evaluator version is
// its definition plus its execution binding; together they are identity and
// feed skillDigest v2. What Rubrist learned about the binding from provider
// capability data and probe calls is the resolution record, which is never
// identity and never changes the binding.
//
// Every optional setting is present and `null` when it is not sent, so the
// canonical form never depends on whether a producer omitted a key.

export const EVALUATOR_IDENTITY_BASIS = "rubrist/evaluator-identity/v2" as const;

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonEmptyTextSchema = (max: number) => UnicodeScalarValueSchema.pipe(z.string().min(1).max(max));
// A record parse skips an own `__proto__` key without reporting it, so the
// parsed identity would silently differ from the document. Identity records
// refuse the key on the raw input, before the record parse runs.
const identityRecord = <T extends z.ZodType>(value: T) => z.unknown()
  .refine((raw) => typeof raw !== "object" || raw === null || !Object.hasOwn(raw, "__proto__"), { message: "__proto__ is not a valid key" })
  .pipe(z.record(UnicodeScalarValueSchema, value));

export const ExecutionProviderIdSchema = z.enum(["mock", "anthropic", "openai", "openrouter", "custom", "typesafe"]);
export type ExecutionProviderId = z.infer<typeof ExecutionProviderIdSchema>;

/** Versioned ways of obtaining a verdict. Each version pins everything injected around the judging skill. */
export const VerdictProtocolIdSchema = z.enum([
  "anthropic.structured-output/v1",
  "anthropic.forced-tool/v1",
  "openai.structured-output/v1",
  "openai.forced-function/v1",
  "prompted-json/v1",
  "typed-question/v1",
  "mock/v1"
]);
export type VerdictProtocolId = z.infer<typeof VerdictProtocolIdSchema>;

const PROTOCOLS_BY_PROVIDER: Record<ExecutionProviderId, readonly VerdictProtocolId[]> = {
  mock: ["mock/v1"],
  anthropic: ["anthropic.structured-output/v1", "anthropic.forced-tool/v1", "prompted-json/v1"],
  openai: ["openai.structured-output/v1", "openai.forced-function/v1", "prompted-json/v1"],
  openrouter: ["openai.structured-output/v1", "openai.forced-function/v1", "prompted-json/v1"],
  custom: ["openai.structured-output/v1", "openai.forced-function/v1", "prompted-json/v1"],
  typesafe: ["typed-question/v1"]
};

/** The protocols a provider family can run, in the section 3 preference order; used by bindings and the model picker. */
export function verdictProtocolsFor(provider: ExecutionProviderId): readonly VerdictProtocolId[] {
  return PROTOCOLS_BY_PROVIDER[provider];
}

export const SamplingSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable()
}).strict();
export type SamplingSettings = z.infer<typeof SamplingSettingsSchema>;

const AnthropicThinkingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("disabled") }).strict(),
  z.object({ type: z.literal("enabled"), budgetTokens: z.number().int().min(1024) }).strict(),
  z.object({ type: z.literal("adaptive") }).strict()
]);

const OpenRouterReasoningSchema = z.object({
  family: z.literal("openrouter"),
  enabled: z.boolean(),
  effort: z.enum(["low", "medium", "high"]).nullable(),
  maxTokens: z.number().int().positive().nullable()
}).strict().superRefine((reasoning, ctx) => {
  // OpenRouter takes an effort or a token budget, not both, and neither when reasoning is off.
  if (reasoning.effort !== null && reasoning.maxTokens !== null) {
    ctx.addIssue({ code: "custom", path: ["maxTokens"], message: "OpenRouter reasoning takes an effort or a token budget, not both" });
  }
  if (!reasoning.enabled && (reasoning.effort !== null || reasoning.maxTokens !== null)) {
    ctx.addIssue({ code: "custom", path: ["enabled"], message: "disabled OpenRouter reasoning states no effort or token budget" });
  }
});

/** One closed reasoning shape per provider family; `null` on the binding means not sent. */
export const ReasoningSettingsSchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("anthropic"),
    thinking: AnthropicThinkingSchema,
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable()
  }).strict(),
  z.object({
    family: z.literal("openai"),
    effort: z.enum(["none", "minimal", "low", "medium", "high"])
  }).strict(),
  OpenRouterReasoningSchema
]);
export type ReasoningSettings = z.infer<typeof ReasoningSettingsSchema>;

const REASONING_FAMILY_BY_PROVIDER: Partial<Record<ExecutionProviderId, ReasoningSettings["family"]>> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  custom: "openai"
};

/** The provider family's reasoning shape, or `null` for families with none (typesafe, mock). */
export function reasoningFamilyFor(provider: ExecutionProviderId): ReasoningSettings["family"] | null {
  return REASONING_FAMILY_BY_PROVIDER[provider] ?? null;
}

/** Whether the provider family takes sampling settings and an output token limit; typesafe and mock take none. */
export function takesSamplingSettings(provider: ExecutionProviderId): boolean {
  return provider !== "typesafe" && provider !== "mock";
}

export const ExecutionEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("managed") }).strict(),
  // The binding names a custom endpoint by digest only; the URL itself stays private.
  z.object({ kind: z.literal("custom"), baseUrlDigest: Sha256DigestSchema }).strict()
]);
export type ExecutionEndpoint = z.infer<typeof ExecutionEndpointSchema>;

/** OpenRouter must route only to an upstream that honours every stated parameter. */
export const OpenRouterRoutingSchema = z.object({
  requireParameters: z.literal(true),
  allowFallbacks: z.literal(false)
}).strict();
export type OpenRouterRouting = z.infer<typeof OpenRouterRoutingSchema>;

export const ExecutionBindingSchema = z.object({
  provider: ExecutionProviderIdSchema,
  endpoint: ExecutionEndpointSchema,
  modelId: NonEmptyTextSchema(240),
  modelVersion: NonEmptyTextSchema(240),
  sampling: SamplingSettingsSchema,
  reasoning: ReasoningSettingsSchema.nullable(),
  outputTokenLimit: z.number().int().positive().max(1_000_000).nullable(),
  verdictProtocol: VerdictProtocolIdSchema,
  routing: OpenRouterRoutingSchema.nullable()
}).strict().superRefine((binding, ctx) => {
  if (!PROTOCOLS_BY_PROVIDER[binding.provider].includes(binding.verdictProtocol)) {
    ctx.addIssue({ code: "custom", path: ["verdictProtocol"], message: `${binding.verdictProtocol} is not a ${binding.provider} protocol` });
  }
  // A custom provider always names its endpoint; OpenAI names one only when a
  // platform base-URL override applies (ADR-0014 section 2). Others are managed.
  const endpointFits = binding.provider === "custom"
    ? binding.endpoint.kind === "custom"
    : binding.provider === "openai" || binding.endpoint.kind === "managed";
  if (!endpointFits) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: `${binding.provider} bindings can't name a ${binding.endpoint.kind} endpoint` });
  }
  if ((binding.provider === "openrouter") !== (binding.routing !== null)) {
    ctx.addIssue({ code: "custom", path: ["routing"], message: "OpenRouter bindings state their routing requirements; others have none" });
  }
  const family = reasoningFamilyFor(binding.provider);
  if (binding.reasoning !== null && binding.reasoning.family !== family) {
    ctx.addIssue({ code: "custom", path: ["reasoning"], message: `${binding.provider} has no ${binding.reasoning.family} reasoning shape` });
  }
  if (binding.provider === "anthropic" && binding.outputTokenLimit === null) {
    ctx.addIssue({ code: "custom", path: ["outputTokenLimit"], message: "Anthropic requires an output token limit" });
  }
  if (!takesSamplingSettings(binding.provider)) {
    if (binding.sampling.temperature !== null || binding.sampling.topP !== null) {
      ctx.addIssue({ code: "custom", path: ["sampling"], message: `${binding.provider} takes no sampling settings` });
    }
    if (binding.outputTokenLimit !== null) {
      ctx.addIssue({ code: "custom", path: ["outputTokenLimit"], message: `${binding.provider} takes no output token limit` });
    }
  }
});
export type ExecutionBinding = z.infer<typeof ExecutionBindingSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** A reasoning setting in words, or "reasoning not sent". */
export function describeReasoningSettings(reasoning: ReasoningSettings | null): string {
  if (reasoning === null) return "reasoning not sent";
  switch (reasoning.family) {
    case "anthropic": {
      const thinking = reasoning.thinking.type === "enabled" ? `thinking enabled (${reasoning.thinking.budgetTokens} tokens)` : `thinking ${reasoning.thinking.type}`;
      return reasoning.effort === null ? thinking : `${thinking} at effort ${reasoning.effort}`;
    }
    case "openai":
      return `reasoning effort ${reasoning.effort}`;
    case "openrouter":
      if (!reasoning.enabled) return "reasoning off";
      return ["reasoning on", reasoning.effort === null ? null : `at effort ${reasoning.effort}`, reasoning.maxTokens === null ? null : `(${reasoning.maxTokens} tokens)`]
        .filter((part): part is string => part !== null).join(" ");
  }
}

/**
 * One line stating everything a binding sends, and naming each unset setting
 * as not sent. It reads a saved binding or a submitted one alike.
 */
export function describeExecutionBinding(binding: Omit<ExecutionBinding, "endpoint"> & { endpoint: { kind: "managed" | "custom" } }): string {
  return [
    `${binding.provider}/${binding.modelId}`,
    binding.modelVersion === binding.modelId ? null : `version ${binding.modelVersion}`,
    binding.endpoint.kind === "custom" ? "custom endpoint" : null,
    binding.sampling.temperature === null ? "temperature not sent" : `temperature ${binding.sampling.temperature}`,
    binding.sampling.topP === null ? null : `top_p ${binding.sampling.topP}`,
    describeReasoningSettings(binding.reasoning),
    binding.outputTokenLimit === null ? "no output token limit" : `${binding.outputTokenLimit} output tokens`,
    binding.verdictProtocol
  ].filter((part): part is string => part !== null).join(" · ");
}

/**
 * A custom endpoint's base URL as an author gives it. Paths are appended to
 * it, so it is plain http(s) with no credentials, query, or fragment.
 */
export const EndpointBaseUrlSchema = z.string().trim().min(1).max(2_000).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "the endpoint base URL must be a URL" });
    return;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    ctx.addIssue({ code: "custom", message: "the endpoint base URL must be http(s), with no credentials, query, or fragment" });
  }
});

/**
 * An execution binding as submitted. It differs from the stored binding only
 * in naming a custom endpoint by its URL; the server names it by digest and
 * validates the result with ExecutionBindingSchema.
 */
export const ExecutionBindingInputSchema = z.object({
  provider: ExecutionProviderIdSchema,
  endpoint: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("managed") }).strict(),
    z.object({ kind: z.literal("custom"), baseUrl: EndpointBaseUrlSchema }).strict()
  ]),
  modelId: NonEmptyTextSchema(240),
  modelVersion: NonEmptyTextSchema(240),
  sampling: SamplingSettingsSchema,
  reasoning: ReasoningSettingsSchema.nullable(),
  outputTokenLimit: z.number().int().positive().max(1_000_000).nullable(),
  verdictProtocol: VerdictProtocolIdSchema,
  routing: OpenRouterRoutingSchema.nullable()
}).strict();
export type ExecutionBindingInput = z.infer<typeof ExecutionBindingInputSchema>;

/**
 * The provider family's protocol where no capability data or probe can
 * choose one (ADR-0014 section 3): structured output for Anthropic, OpenAI,
 * and OpenRouter, a forced function for custom endpoints.
 */
export function defaultVerdictProtocol(provider: ExecutionProviderId): VerdictProtocolId {
  switch (provider) {
    case "anthropic":
      return "anthropic.structured-output/v1";
    case "openai":
    case "openrouter":
      return "openai.structured-output/v1";
    case "custom":
      return "openai.forced-function/v1";
    case "mock":
      return "mock/v1";
    case "typesafe":
      return "typed-question/v1";
  }
}

/**
 * The binding a new project's starter evaluator is seeded with (ADR-0014
 * section 2): every identity field stated, and the documented default
 * reasoning saved explicitly. Projects are seeded before any credential
 * exists, so it is saved unresolved and resolves when a governed gate or
 * run first needs it, or on demand. It is frozen: copy it before changing it.
 */
export const SEEDED_DEFAULT_EXECUTION_BINDING: ExecutionBinding = deepFreeze({
  provider: "anthropic",
  endpoint: { kind: "managed" },
  modelId: "claude-sonnet-4-6",
  modelVersion: "claude-sonnet-4-6",
  sampling: { temperature: 0, topP: null },
  reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: "high" },
  outputTokenLimit: 1_200,
  verdictProtocol: "anthropic.structured-output/v1",
  routing: null
});

/**
 * The longest rubric or prompt template a prompted definition holds. Every
 * input that saves an evaluator version uses it, so every saved version has
 * an identity.
 */
export const EVALUATOR_DEFINITION_TEXT_MAX = 100_000;

// The v1 skill-version invariants (skills.ts), which v2 identity keeps.
const PromptedDefinitionSchema = z.object({
  kind: z.literal("prompted"),
  rubricMarkdown: z.string().max(EVALUATOR_DEFINITION_TEXT_MAX),
  prompt: z.string().max(EVALUATOR_DEFINITION_TEXT_MAX),
  verdictKind: z.enum(["binary", "scalar", "categorical"]),
  outputSchema: identityRecord(z.unknown()),
  scalarRange: z.tuple([z.number(), z.number()]).nullable(),
  categoricalChoiceScores: identityRecord(z.number().min(0).max(1)).nullable()
}).strict().superRefine((definition, ctx) => {
  if (definition.verdictKind === "scalar"
    ? definition.scalarRange === null || definition.scalarRange[0] >= definition.scalarRange[1]
    : definition.scalarRange !== null) {
    ctx.addIssue({ code: "custom", path: ["scalarRange"], message: "scalar definitions need an ascending scalarRange, and only they have one" });
  }
  if (definition.verdictKind === "categorical"
    ? definition.categoricalChoiceScores === null || Object.keys(definition.categoricalChoiceScores).length === 0
    : definition.categoricalChoiceScores !== null) {
    ctx.addIssue({ code: "custom", path: ["categoricalChoiceScores"], message: "categorical definitions need choice scores, and only they have them" });
  }
});

/** The text of a binary yes-or-no question. Identity holds only its digest (ADR-0014 section 5). */
export const TypedQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: NonEmptyTextSchema(20_000),
  criteria: z.object({
    true: NonEmptyTextSchema(5_000),
    false: NonEmptyTextSchema(5_000)
  }).strict()
}).strict();
export type TypedQuestion = z.infer<typeof TypedQuestionSchema>;

/** A binary `noul` question answered with a probability (ADR-0014 section 5). */
const TypedQuestionDefinitionSchema = z.object({
  kind: z.literal("typed-question"),
  question: z.object({ type: z.literal("noul"), digest: Sha256DigestSchema }).strict(),
  polarity: z.literal("true_is_pass"),
  // Required and part of identity; chosen on nonsealed data, never a default.
  threshold: z.number().gt(0).lt(1),
  rationale: z.literal("not_provided")
}).strict();

export const EvaluatorDefinitionSchema = z.discriminatedUnion("kind", [PromptedDefinitionSchema, TypedQuestionDefinitionSchema])
  .superRefine((definition, ctx) => {
    // Canonical identities operate on Unicode scalar values, nested keys and values included.
    if (containsLoneUtf16Surrogate(definition)) {
      ctx.addIssue({ code: "custom", message: "evaluator definitions must not contain lone UTF-16 surrogates" });
    }
  });
export type EvaluatorDefinition = z.infer<typeof EvaluatorDefinitionSchema>;

export const EvaluatorIdentitySchema = z.object({
  basis: z.literal(EVALUATOR_IDENTITY_BASIS),
  definition: EvaluatorDefinitionSchema,
  executionBinding: ExecutionBindingSchema
}).strict().superRefine((identity, ctx) => {
  const typed = identity.definition.kind === "typed-question";
  if (typed !== (identity.executionBinding.verdictProtocol === "typed-question/v1")) {
    ctx.addIssue({ code: "custom", path: ["executionBinding", "verdictProtocol"], message: "typed-question definitions run on typed-question/v1, and only they do" });
  }
});
export type EvaluatorIdentity = z.infer<typeof EvaluatorIdentitySchema>;

/**
 * What evidence carries in place of the definition (ADR-0014 decision 5), and
 * exactly what skillDigest v2 is computed from: the identity basis, the
 * SHA-256 of the canonical definition, and the execution binding. It never
 * holds rubric, prompt, or question text.
 */
export const SkillDigestInputSchema = z.object({
  basis: z.literal(EVALUATOR_IDENTITY_BASIS),
  definitionDigest: Sha256DigestSchema,
  executionBinding: ExecutionBindingSchema
}).strict();
export type SkillDigestInput = z.infer<typeof SkillDigestInputSchema>;

/** Shared item model for receipt v2, calibration v2, and the ledger v2 (ADR-0014 section 6). */
export const EvaluatorItemOutcomeSchema = z.enum(["pass", "fail", "abstain"]);
export type EvaluatorItemOutcome = z.infer<typeof EvaluatorItemOutcomeSchema>;

export const EvaluatorFailureKindSchema = z.enum([
  "provider_rejected_request",
  "provider_unavailable",
  "provider_authentication",
  "provider_rate_limit",
  "provider_timeout",
  "provider_transport",
  "provider_protocol",
  "invalid_evaluator_output",
  "outcome_unknown",
  "internal"
]);
export type EvaluatorFailureKind = z.infer<typeof EvaluatorFailureKindSchema>;

/** Exactly one of an outcome, a failure, or `not_attempted`; an abstention is never a failure. */
export const EvaluatorItemStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("outcome"), outcome: EvaluatorItemOutcomeSchema }).strict(),
  z.object({ state: z.literal("failure"), failureKind: EvaluatorFailureKindSchema }).strict(),
  z.object({ state: z.literal("not_attempted") }).strict()
]);
export type EvaluatorItemState = z.infer<typeof EvaluatorItemStateSchema>;

/** A score is either the model's own stated probability or an LLM's self-reported score; neither is calibrated. */
/**
 * What the provider reported back for one attempted call (ADR-0014 section
 * 6). Every field is `null` when the provider didn't report it.
 */
export const ObservedCallSchema = z.object({
  model: z.string().nullable(),
  requestId: z.string().nullable(),
  responseId: z.string().nullable(),
  systemFingerprint: z.string().nullable(),
  // The OpenRouter upstream that served the call (ADR-0014 section 2).
  upstreamProvider: z.string().nullable(),
  thinkingReturned: z.boolean().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable()
}).strict();
export type ObservedCall = z.infer<typeof ObservedCallSchema>;

export const EvaluatorScoreSchema = z.object({
  value: z.number().min(0).max(1),
  kind: z.enum(["native_probability", "self_reported_score"])
}).strict();
export type EvaluatorScore = z.infer<typeof EvaluatorScoreSchema>;

/** How a probed setting fared: `parameter_rejected` only when the provider named the parameter itself. */
export const SettingSupportSchema = z.enum(["accepted", "value_rejected", "parameter_rejected"]);
export type SettingSupport = z.infer<typeof SettingSupportSchema>;

const REJECTION_FAILURE_KINDS: readonly EvaluatorFailureKind[] = ["provider_rejected_request", "provider_protocol"];
// ADR-0014 section 4: a check sends up to 3 protocol, 1 temperature, and 2
// reasoning probes; a resolution attempt one confirming probe plus at most one
// temperature and one reasoning probe.
const PROBE_LIMITS = {
  capability_check: { protocol: 3, temperature: 1, reasoning: 2, confirm: 0 },
  resolution: { protocol: 0, temperature: 1, reasoning: 1, confirm: 1 },
  recheck: { protocol: 0, temperature: 0, reasoning: 0, confirm: 0 }
} as const;
const CAPABILITY_CHECK_PROBE_LIMIT = 6;
const RESOLUTION_PROBE_LIMIT = 3;

/** Settings compare by value, whatever order a producer wrote their keys in. */
function sameSettings(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
    : value;
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

/**
 * One probe call (ADR-0014 section 4), with every optional setting it sent.
 * A rejection names the output mechanism, a parameter, or only one of its
 * values, or can't be attributed. On a temperature or reasoning probe an
 * unattributed rejection counts as a value rejection, so it never lets a
 * setting go unset.
 */
export const CapabilityProbeSchema = z.object({
  stage: z.enum(["capability_check", "resolution", "recheck"]),
  purpose: z.enum(["protocol", "temperature", "reasoning", "confirm"]),
  verdictProtocol: VerdictProtocolIdSchema,
  sent: z.object({
    temperature: z.number().min(0).max(2).nullable(),
    topP: z.number().min(0).max(1).nullable(),
    reasoning: ReasoningSettingsSchema.nullable(),
    outputTokenLimit: z.number().int().positive().max(1_000_000).nullable()
  }).strict(),
  outcome: z.enum(["accepted", "rejected", "error"]),
  rejection: z.enum(["mechanism", "parameter", "value", "unattributed"]).nullable(),
  rejectedParameter: z.enum(["temperature", "topP", "reasoning", "outputTokenLimit"]).nullable(),
  failureKind: EvaluatorFailureKindSchema.nullable(),
  providerMessage: z.string().max(2_000).nullable(),
  // Token usage the provider reported for the call, so a probe's cost is
  // known even before prices are; `null` when it reported none.
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative()
  }).strict().nullable(),
  costMicroUsd: z.number().int().nonnegative().nullable()
}).strict().superRefine((probe, ctx) => {
  const rejected = probe.outcome === "rejected";
  if (rejected !== (probe.rejection !== null)) {
    ctx.addIssue({ code: "custom", path: ["rejection"], message: "only a rejected probe says what was rejected, and it must" });
  }
  const namesParameter = probe.rejection === "parameter" || probe.rejection === "value";
  if (namesParameter !== (probe.rejectedParameter !== null)) {
    ctx.addIssue({ code: "custom", path: ["rejectedParameter"], message: "parameter and value rejections name the parameter; others don't" });
  }
  const failureKindFits = probe.outcome === "accepted"
    ? probe.failureKind === null
    : probe.failureKind !== null && REJECTION_FAILURE_KINDS.includes(probe.failureKind) === rejected;
  if (!failureKindFits) {
    ctx.addIssue({ code: "custom", path: ["failureKind"], message: `a probe that is ${probe.outcome} can't carry failure kind ${probe.failureKind}` });
  }
  const sent = probe.sent;
  if (probe.purpose === "protocol" && (sent.temperature !== null || sent.topP !== null || sent.reasoning !== null)) {
    ctx.addIssue({ code: "custom", path: ["sent"], message: "protocol probes send no optional sampling or reasoning settings" });
  }
  if ((probe.purpose === "temperature" && sent.temperature === null) || (probe.purpose === "reasoning" && sent.reasoning === null)) {
    ctx.addIssue({ code: "custom", path: ["sent"], message: `a ${probe.purpose} probe sends an explicit ${probe.purpose}` });
  }
});
export type CapabilityProbe = z.infer<typeof CapabilityProbeSchema>;

/**
 * Whether some probe in the record supports the summary a gate reads. Once a
 * confirming probe exists, its reasoning is the saved reasoning, and a
 * temperature summary must come from a probe sent with that reasoning.
 */
function supportIsRecorded(
  allProbes: readonly CapabilityProbe[],
  setting: "temperature" | "reasoning",
  support: SettingSupport,
  confirm: CapabilityProbe | undefined
): boolean {
  const probes = setting === "temperature" && confirm
    ? allProbes.filter((probe) => sameSettings(probe.sent.reasoning, confirm.sent.reasoning))
    : allProbes;
  switch (support) {
    case "accepted":
      return probes.some((probe) => probe.outcome === "accepted" && probe.sent[setting] !== null);
    case "parameter_rejected":
      return probes.some((probe) => probe.purpose === setting && probe.rejection === "parameter" && probe.rejectedParameter === setting);
    case "value_rejected":
      return probes.some((probe) => probe.purpose === setting &&
        (probe.rejection === "unattributed" || (probe.rejection === "value" && probe.rejectedParameter === setting)));
  }
}

/**
 * What Rubrist learned about a binding: the capability check before save
 * (at most 6 probes) and the latest resolution attempt after it (at most 3,
 * with one confirming probe). Not identity; it confirms or fails the binding
 * and never rewrites it. Re-check probes, and earlier attempts that ended
 * unresolved, are recorded against what triggered them, never here.
 *
 * The support fields are what the governed gates read (ADR-0014 section 2):
 * temperature as probed with the saved reasoning, and `null` when not probed.
 * Only the confirming probe decides `resolved` or `failed`.
 */
export const ResolutionRecordSchema = z.object({
  status: z.enum(["resolved", "unresolved", "failed"]),
  capabilitySnapshotDigest: Sha256DigestSchema.nullable(),
  reasoningDefaultsVersion: z.string().min(1).max(100).nullable(),
  credentialSource: JudgeProviderCredentialSourceSchema.nullable(),
  temperatureSupport: SettingSupportSchema.nullable(),
  reasoningSupport: SettingSupportSchema.nullable(),
  probes: z.array(CapabilityProbeSchema).max(CAPABILITY_CHECK_PROBE_LIMIT + RESOLUTION_PROBE_LIMIT),
  checkedAt: z.string().datetime({ offset: true }).nullable()
}).strict().superRefine((record, ctx) => {
  const checkProbes = record.probes.filter((probe) => probe.stage === "capability_check");
  const resolutionProbes = record.probes.filter((probe) => probe.stage === "resolution");
  const counts = new Map<string, number>();
  record.probes.forEach((probe, index) => {
    if (probe.stage === "recheck") {
      ctx.addIssue({ code: "custom", path: ["probes", index, "stage"], message: "re-check probes belong to the run they guard" });
      return;
    }
    const key = `${probe.stage}/${probe.purpose}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key)! > PROBE_LIMITS[probe.stage][probe.purpose]) {
      ctx.addIssue({
        code: "custom", path: ["probes", index, "purpose"],
        message: `a ${probe.stage} holds at most ${PROBE_LIMITS[probe.stage][probe.purpose]} ${probe.purpose} probe(s)`
      });
    }
  });
  if (checkProbes.length > CAPABILITY_CHECK_PROBE_LIMIT || resolutionProbes.length > RESOLUTION_PROBE_LIMIT) {
    ctx.addIssue({ code: "custom", path: ["probes"], message: "a record holds at most 6 capability-check probes and 3 resolution probes" });
  }
  const confirm = resolutionProbes.find((probe) => probe.purpose === "confirm");
  if (resolutionProbes.length > 0 && confirm === undefined) {
    ctx.addIssue({ code: "custom", path: ["probes"], message: "a resolution attempt starts with its confirming probe" });
  }
  const statusFits = record.status === "resolved"
    ? confirm?.outcome === "accepted"
    : record.status === "failed"
      ? confirm?.outcome === "rejected"
      : confirm === undefined || confirm.outcome === "error";
  if (!statusFits) {
    ctx.addIssue({ code: "custom", path: ["status"], message: `status ${record.status} doesn't match the confirming probe` });
  }
  for (const [field, setting] of [["temperatureSupport", "temperature"], ["reasoningSupport", "reasoning"]] as const) {
    const support = record[field];
    if (support !== null && !supportIsRecorded(record.probes, setting, support, confirm)) {
      ctx.addIssue({ code: "custom", path: [field], message: `no probe in the record shows ${setting} ${support}${setting === "temperature" && confirm ? " with the saved reasoning" : ""}` });
    }
  }
});
export type ResolutionRecord = z.infer<typeof ResolutionRecordSchema>;
