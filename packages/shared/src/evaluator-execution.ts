import { z } from "zod";
import { UnicodeScalarValueSchema } from "./judge.js";

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
const NonEmptyTextSchema = UnicodeScalarValueSchema.pipe(z.string().min(1));

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

/** The protocols a provider family can run; used by bindings and by the model picker. */
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
  z.object({
    family: z.literal("openrouter"),
    enabled: z.boolean(),
    effort: z.enum(["low", "medium", "high"]).nullable(),
    maxTokens: z.number().int().positive().nullable()
  }).strict()
]);
export type ReasoningSettings = z.infer<typeof ReasoningSettingsSchema>;

const REASONING_FAMILY_BY_PROVIDER: Partial<Record<ExecutionProviderId, ReasoningSettings["family"]>> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  custom: "openai"
};

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

export const ExecutionBindingSchema = z.object({
  provider: ExecutionProviderIdSchema,
  endpoint: ExecutionEndpointSchema,
  modelId: NonEmptyTextSchema.pipe(z.string().max(240)),
  modelVersion: NonEmptyTextSchema.pipe(z.string().max(240)),
  sampling: SamplingSettingsSchema,
  reasoning: ReasoningSettingsSchema.nullable(),
  outputTokenLimit: z.number().int().positive().max(1_000_000).nullable(),
  verdictProtocol: VerdictProtocolIdSchema,
  routing: OpenRouterRoutingSchema.nullable()
}).strict().superRefine((binding, ctx) => {
  if (!PROTOCOLS_BY_PROVIDER[binding.provider].includes(binding.verdictProtocol)) {
    ctx.addIssue({ code: "custom", path: ["verdictProtocol"], message: `${binding.verdictProtocol} is not a ${binding.provider} protocol` });
  }
  if ((binding.provider === "custom") !== (binding.endpoint.kind === "custom")) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "only custom providers name a custom endpoint, and they must" });
  }
  if ((binding.provider === "openrouter") !== (binding.routing !== null)) {
    ctx.addIssue({ code: "custom", path: ["routing"], message: "OpenRouter bindings state their routing requirements; others have none" });
  }
  const family = REASONING_FAMILY_BY_PROVIDER[binding.provider];
  if (binding.reasoning !== null && binding.reasoning.family !== family) {
    ctx.addIssue({ code: "custom", path: ["reasoning"], message: `${binding.provider} has no ${binding.reasoning.family} reasoning shape` });
  }
  if (binding.provider === "anthropic" && binding.outputTokenLimit === null) {
    ctx.addIssue({ code: "custom", path: ["outputTokenLimit"], message: "Anthropic requires an output token limit" });
  }
  if ((binding.provider === "typesafe" || binding.provider === "mock") &&
      (binding.sampling.temperature !== null || binding.sampling.topP !== null || binding.outputTokenLimit !== null)) {
    ctx.addIssue({ code: "custom", path: ["sampling"], message: `${binding.provider} takes no sampling settings or token limit` });
  }
});
export type ExecutionBinding = z.infer<typeof ExecutionBindingSchema>;

const PromptedDefinitionSchema = z.object({
  kind: z.literal("prompted"),
  rubricMarkdown: z.string().max(100_000),
  prompt: z.string().max(100_000),
  verdictKind: z.enum(["binary", "scalar", "categorical"]),
  outputSchema: z.record(z.string(), z.unknown()),
  scalarRange: z.tuple([z.number(), z.number()]).nullable(),
  categoricalChoiceScores: z.record(z.string(), z.number()).nullable()
}).strict();

/** A binary yes-or-no question answered with a probability (ADR-0014 §5; noul only). */
const TypedQuestionDefinitionSchema = z.object({
  kind: z.literal("typed-question"),
  question: z.object({
    type: z.literal("noul"),
    instructions: NonEmptyTextSchema.pipe(z.string().max(20_000)),
    criteria: z.object({
      true: NonEmptyTextSchema.pipe(z.string().max(5_000)),
      false: NonEmptyTextSchema.pipe(z.string().max(5_000))
    }).strict()
  }).strict(),
  polarity: z.literal("true_is_pass"),
  // Required and part of identity; chosen on nonsealed data, never a default.
  threshold: z.number().gt(0).lt(1),
  rationale: z.literal("not_provided")
}).strict();

export const EvaluatorDefinitionSchema = z.discriminatedUnion("kind", [PromptedDefinitionSchema, TypedQuestionDefinitionSchema]);
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

/** Shared item outcome and failure taxonomy for receipt v2, calibration v2, and the ledger v2. */
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

/** A score is either the model's own stated probability or an LLM's self-reported score; neither is calibrated. */
export const EvaluatorScoreSchema = z.object({
  value: z.number().min(0).max(1),
  kind: z.enum(["native_probability", "self_reported_score"])
}).strict();
export type EvaluatorScore = z.infer<typeof EvaluatorScoreSchema>;

/** How a probed setting fared: `parameter_rejected` only when the provider named the parameter itself. */
export const SettingSupportSchema = z.enum(["accepted", "value_rejected", "parameter_rejected"]);
export type SettingSupport = z.infer<typeof SettingSupportSchema>;

const REJECTION_FAILURE_KINDS: readonly EvaluatorFailureKind[] = ["provider_rejected_request", "provider_protocol"];

/**
 * One probe call (ADR-0014 section 4), with the optional settings it sent.
 * A rejection names the output mechanism, a parameter, or only a value; one
 * Rubrist can't attribute is recorded as `value`, so it never lets a setting
 * go unset.
 */
export const CapabilityProbeSchema = z.object({
  stage: z.enum(["capability_check", "resolution", "recheck"]),
  purpose: z.enum(["protocol", "temperature", "reasoning", "confirm"]),
  verdictProtocol: VerdictProtocolIdSchema,
  sent: z.object({
    temperature: z.number().min(0).max(2).nullable(),
    reasoning: ReasoningSettingsSchema.nullable()
  }).strict(),
  outcome: z.enum(["accepted", "rejected", "error"]),
  rejection: z.enum(["mechanism", "parameter", "value"]).nullable(),
  failureKind: EvaluatorFailureKindSchema.nullable(),
  providerMessage: z.string().max(2_000).nullable(),
  costMicroUsd: z.number().int().nonnegative().nullable()
}).strict().superRefine((probe, ctx) => {
  const rejected = probe.outcome === "rejected";
  if (rejected !== (probe.rejection !== null)) {
    ctx.addIssue({ code: "custom", path: ["rejection"], message: "only a rejected probe says what was rejected, and it must" });
  }
  const failureKindFits = probe.outcome === "accepted"
    ? probe.failureKind === null
    : probe.failureKind !== null && REJECTION_FAILURE_KINDS.includes(probe.failureKind) === rejected;
  if (!failureKindFits) {
    ctx.addIssue({ code: "custom", path: ["failureKind"], message: `a probe that is ${probe.outcome} can't carry failure kind ${probe.failureKind}` });
  }
  if (probe.purpose === "protocol" && (probe.sent.temperature !== null || probe.sent.reasoning !== null)) {
    ctx.addIssue({ code: "custom", path: ["sent"], message: "protocol probes send no optional settings" });
  }
});
export type CapabilityProbe = z.infer<typeof CapabilityProbeSchema>;

/**
 * What Rubrist learned about a binding: the capability check before save
 * (at most 6 probes) and the latest resolution attempt after it (at most 3).
 * Not identity; it confirms or fails the binding and never rewrites it.
 * Re-check probes are recorded with the run they guard, never here. The
 * support fields are what the governed gates read (ADR-0014 section 2):
 * temperature as probed with the saved reasoning, and `null` when not probed.
 */
export const ResolutionRecordSchema = z.object({
  status: z.enum(["resolved", "unresolved", "failed"]),
  capabilitySnapshotDigest: Sha256DigestSchema.nullable(),
  reasoningDefaultsVersion: z.string().min(1).max(100).nullable(),
  credentialSource: z.enum(["project", "platform"]).nullable(),
  temperatureSupport: SettingSupportSchema.nullable(),
  reasoningSupport: SettingSupportSchema.nullable(),
  probes: z.array(CapabilityProbeSchema).max(9),
  checkedAt: z.string().datetime({ offset: true }).nullable()
}).strict().superRefine((record, ctx) => {
  record.probes.forEach((probe, index) => {
    if (probe.stage === "recheck") {
      ctx.addIssue({ code: "custom", path: ["probes", index, "stage"], message: "re-check probes belong to the run they guard" });
    }
  });
});
export type ResolutionRecord = z.infer<typeof ResolutionRecordSchema>;
