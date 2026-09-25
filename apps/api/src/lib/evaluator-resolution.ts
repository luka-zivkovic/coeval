import { EvaluatorCallError, executeVerdict, type ExecutionFetch, type TokenUsage, type VerdictSpec } from "@rubrist/audit/runtime";
import {
  CapabilityProbeSchema,
  REASONING_DEFAULTS_VERSION,
  ResolutionRecordSchema,
  reasoningFamilyFor,
  takesSamplingSettings,
  type CapabilityProbe,
  type ExecutionBinding,
  type JudgeProviderCredentialSource,
  type ReasoningSettings,
  type ResolutionRecord,
  type SettingSupport,
  type VerdictProtocolId
} from "@rubrist/shared";
import { canonicalJson } from "./assessment-receipt.js";
import { attributeProbeOutcome, capabilityProtocolOrder, type PublishedCapabilities } from "./evaluator-capability.js";

// The capability check, resolution, and re-check of an execution binding
// (Rubrist ADR-0014 section 4). Probes send a fixed, non-sensitive input and
// never change the binding: the check informs the author before save,
// resolution confirms or fails the saved binding, and the re-check guards one
// governed run or sealed authorization.

/**
 * One probe call: resolves with the usage the provider reported when it
 * accepted the call, and throws the call's failure otherwise.
 */
export type ProbeExecutor = (binding: ExecutionBinding) => Promise<{ usage: TokenUsage | null }>;

/** The fixed probe input: no project data, no rubric of the author's. */
export const CAPABILITY_PROBE_INPUT = {
  rubricMarkdown: "Pass when the answer states the correct sum. Fail when it doesn't.",
  prompt: "Judge the trace against the review guide below.\n\n<review_guide>\n{{rubric_markdown}}\n</review_guide>",
  trace: { id: "rubrist-capability-probe", input: { question: "What is 2 + 3?" }, output: { answer: "5" } }
} as const;

/**
 * The temperature a temperature probe sends: 1, the providers' default. A
 * model that takes temperature only at its default accepts it, so its
 * evaluators must state it; only a model refusing the default too is shown
 * rejecting the parameter itself (ADR-0014 section 2).
 */
export const PROBE_TEMPERATURE = 1;

/** Probes run in sequence while an author waits, so each is short. */
export const PROBE_TIMEOUT_MS = 30_000;

/** A probe executor over executeVerdict, judging the fixed input with the evaluator's verdict kind. */
export function verdictProbeExecutor(input: {
  apiKey: string | null;
  customBaseUrl: string | null;
  spec: VerdictSpec;
  fetch?: ExecutionFetch;
  timeoutMs?: number;
}): ProbeExecutor {
  return async (binding) => {
    const result = await executeVerdict({
      binding,
      apiKey: input.apiKey,
      customBaseUrl: input.customBaseUrl,
      rubricMarkdown: CAPABILITY_PROBE_INPUT.rubricMarkdown,
      prompt: CAPABILITY_PROBE_INPUT.prompt,
      trace: CAPABILITY_PROBE_INPUT.trace,
      spec: input.spec,
      timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
      ...(input.fetch ? { fetch: input.fetch } : {})
    });
    return { usage: result.usage };
  };
}

/**
 * What a reasoning probe sends where the table has no entry: a middle value
 * of the family's shape. For Anthropic it is adaptive thinking where the model
 * may support it, else enabled thinking at the minimum budget, with effort
 * `medium` only where effort is supported.
 */
export function middleReasoning(family: ReasoningSettings["family"], published: PublishedCapabilities | null): ReasoningSettings {
  switch (family) {
    case "anthropic": {
      const adaptive = published?.thinkingTypes == null || published.thinkingTypes.includes("adaptive");
      const effort = published?.effortLevels == null || published.effortLevels.includes("medium") ? "medium" : null;
      return adaptive
        ? { family, thinking: { type: "adaptive" }, effort }
        : { family, thinking: { type: "enabled", budgetTokens: 1024 }, effort };
    }
    case "openai":
      return { family, effort: "medium" };
    case "openrouter":
      return { family, enabled: true, effort: "medium", maxTokens: null };
  }
}

/** The family's no-reasoning setting. */
export function noReasoning(family: ReasoningSettings["family"]): ReasoningSettings {
  switch (family) {
    case "anthropic":
      return { family, thinking: { type: "disabled" }, effort: null };
    case "openai":
      return { family, effort: "none" };
    case "openrouter":
      return { family, enabled: false, effort: null, maxTokens: null };
  }
}

const sameSettings = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/**
 * Sends one probe and records it. A call that never left Rubrist (no
 * credential, no endpoint, a binding the adapters refuse) is no probe, so it
 * returns `null` and nothing is recorded.
 */
async function sendProbe(
  execute: ProbeExecutor,
  published: PublishedCapabilities | null,
  stage: CapabilityProbe["stage"],
  purpose: CapabilityProbe["purpose"],
  binding: ExecutionBinding
): Promise<CapabilityProbe | null> {
  const sent = {
    temperature: binding.sampling.temperature,
    topP: binding.sampling.topP,
    reasoning: binding.reasoning,
    outputTokenLimit: binding.outputTokenLimit
  };
  let error: unknown;
  let usage: TokenUsage | null = null;
  try {
    usage = (await execute(binding)).usage;
  } catch (caught) {
    if (caught instanceof EvaluatorCallError && !caught.physicalCall) return null;
    error = caught ?? new Error("probe failed");
    usage = caught instanceof EvaluatorCallError ? caught.usage : null;
  }
  const attribution = attributeProbeOutcome({ purpose, sent }, error === undefined ? {} : { error }, published);
  return CapabilityProbeSchema.parse({ stage, purpose, verdictProtocol: binding.verdictProtocol, sent, ...attribution, usage, costMicroUsd: null });
}

/** A setting's support as a probe recorded it; `null` when the probe errored or says nothing about it. */
function supportFrom(probe: CapabilityProbe, setting: "temperature" | "reasoning"): SettingSupport | null {
  if (probe.outcome === "accepted") return "accepted";
  if (probe.outcome === "error") return null;
  if (probe.rejection === "parameter" && probe.rejectedParameter === setting) return "parameter_rejected";
  if (probe.rejection === "unattributed" || (probe.rejection === "value" && probe.rejectedParameter === setting)) return "value_rejected";
  return null;
}

/**
 * Summaries the governed gates read: temperature as probed with `reasoning`
 * (the saved reasoning once one exists), reasoning from any reasoning probe.
 * The conservative answer wins: an acceptance, then a rejected value (the
 * parameter exists), and only then a rejected parameter.
 */
function summarize(probes: readonly CapabilityProbe[], setting: "temperature" | "reasoning", reasoning?: ReasoningSettings | null): SettingSupport | null {
  const relevant = probes.filter((probe) => probe.purpose === setting &&
    (setting !== "temperature" || reasoning === undefined || sameSettings(probe.sent.reasoning, reasoning)));
  const outcomes = relevant.map((probe) => supportFrom(probe, setting)).filter((support): support is SettingSupport => support !== null);
  if (outcomes.includes("accepted")) return "accepted";
  if (outcomes.includes("value_rejected")) return "value_rejected";
  return outcomes.includes("parameter_rejected") ? "parameter_rejected" : null;
}

/** The parts of a binding a capability check probes; its probes describe only these. */
export type CapabilityCheckBase = Pick<ExecutionBinding, "provider" | "endpoint" | "modelId" | "modelVersion" | "outputTokenLimit" | "routing">;

export interface CapabilityCheckResult {
  base: CapabilityCheckBase;
  credentialSource: JudgeProviderCredentialSource | null;
  /** The first protocol a probe accepted, which the picker pre-selects; `null` when none did. */
  protocol: VerdictProtocolId | null;
  probes: CapabilityProbe[];
  temperatureSupport: SettingSupport | null;
  reasoningSupport: SettingSupport | null;
  /** The reasoning the temperature probe was sent with. */
  probedReasoning: ReasoningSettings | null;
}

/**
 * The capability check before save, at most 6 probes: protocols in section 3
 * order until one is accepted, sent with no optional settings; then one
 * temperature probe with the documented default reasoning; then up to two
 * reasoning probes, the documented default (or a middle value) and the
 * family's no-reasoning setting. A transient error, or a call that can't be
 * sent, ends the check with what it learned.
 */
export async function runCapabilityCheck(input: {
  base: CapabilityCheckBase;
  credentialSource: JudgeProviderCredentialSource | null;
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  execute: ProbeExecutor;
}): Promise<CapabilityCheckResult> {
  const { base, published, execute } = input;
  const bare = (verdictProtocol: VerdictProtocolId): ExecutionBinding => ({
    ...base,
    sampling: { temperature: null, topP: null },
    reasoning: null,
    verdictProtocol
  });
  const probes: CapabilityProbe[] = [];
  const family = reasoningFamilyFor(base.provider);
  const probedReasoning = family === null ? null : input.documentedDefault;
  const result = (protocol: VerdictProtocolId | null): CapabilityCheckResult => ({
    base,
    credentialSource: input.credentialSource,
    protocol,
    probes,
    temperatureSupport: summarize(probes, "temperature"),
    reasoningSupport: summarize(probes, "reasoning"),
    probedReasoning
  });
  const send = async (purpose: CapabilityProbe["purpose"], binding: ExecutionBinding): Promise<CapabilityProbe | null> => {
    const probe = await sendProbe(execute, published, "capability_check", purpose, binding);
    if (probe !== null) probes.push(probe);
    return probe;
  };
  const ended = (probe: CapabilityProbe | null) => probe === null || probe.outcome === "error";

  let protocol: VerdictProtocolId | null = null;
  for (const candidate of capabilityProtocolOrder(base.provider, published).slice(0, 3)) {
    const probe = await send("protocol", bare(candidate));
    if (ended(probe)) return result(null);
    if (probe!.outcome === "accepted") {
      protocol = candidate;
      break;
    }
    // Only a rejection of the mechanism, or one Rubrist can't attribute, moves to the next protocol.
    if (probe!.rejection !== "mechanism" && probe!.rejection !== "unattributed") return result(null);
  }
  if (protocol === null) return result(null);
  if (takesSamplingSettings(base.provider)) {
    const temperature = await send("temperature", {
      ...bare(protocol),
      sampling: { temperature: PROBE_TEMPERATURE, topP: null },
      reasoning: probedReasoning
    });
    if (ended(temperature)) return result(protocol);
  }
  if (family !== null) {
    for (const reasoning of [input.documentedDefault ?? middleReasoning(family, published), noReasoning(family)]) {
      if (ended(await send("reasoning", { ...bare(protocol), reasoning }))) break;
    }
  }
  return result(protocol);
}

function checkDescribes(check: CapabilityCheckResult, binding: ExecutionBinding, credentialSource: JudgeProviderCredentialSource | null): boolean {
  const base: CapabilityCheckBase = {
    provider: binding.provider,
    endpoint: binding.endpoint,
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    outputTokenLimit: binding.outputTokenLimit,
    routing: binding.routing
  };
  // Capabilities can differ per key, so the check must have used the same credential source.
  return sameSettings(check.base, base) && check.credentialSource === credentialSource;
}

/**
 * Resolution of a saved binding (ADR-0014 section 4). One confirming probe
 * sends the exact saved request, and only it decides: accepted is
 * `resolved`, a rejection is `failed`, and an error leaves the binding
 * `unresolved`. The binding is never changed.
 *
 * Once the saved request is accepted, a setting the family has and the
 * binding leaves unset is probed, unless a probe of it already has a
 * recorded outcome (temperature with the saved reasoning): temperature at
 * save and at a gate, reasoning only at a gate, so at most 2 calls at save
 * and 3 at a gate. Check probes count only when the check describes this
 * binding and used the same credential source.
 */
export async function resolveExecutionBinding(input: {
  binding: ExecutionBinding;
  trigger: "save" | "gate";
  check: CapabilityCheckResult | null;
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  credentialSource: JudgeProviderCredentialSource | null;
  execute: ProbeExecutor;
  now: Date;
}): Promise<ResolutionRecord> {
  const { binding, execute, published } = input;
  const checkProbes = input.check !== null && checkDescribes(input.check, binding, input.credentialSource)
    ? input.check.probes.filter((probe) => probe.stage === "capability_check")
    : [];
  const probes: CapabilityProbe[] = [...checkProbes];
  const confirm = await sendProbe(execute, published, "resolution", "confirm", binding);
  if (confirm !== null) probes.push(confirm);
  const family = reasoningFamilyFor(binding.provider);
  const recorded = (probe: CapabilityProbe) => probe.outcome !== "error";

  if (confirm?.outcome === "accepted") {
    if (takesSamplingSettings(binding.provider) && binding.sampling.temperature === null &&
        !probes.some((probe) => probe.purpose === "temperature" && recorded(probe) && sameSettings(probe.sent.reasoning, binding.reasoning))) {
      const probe = await sendProbe(execute, published, "resolution", "temperature", {
        ...binding,
        sampling: { ...binding.sampling, temperature: PROBE_TEMPERATURE }
      });
      if (probe !== null) probes.push(probe);
    }
    if (input.trigger === "gate" && family !== null && binding.reasoning === null &&
        !probes.some((probe) => probe.purpose === "reasoning" && recorded(probe))) {
      const probe = await sendProbe(execute, published, "resolution", "reasoning", {
        ...binding,
        reasoning: input.documentedDefault ?? middleReasoning(family, published)
      });
      if (probe !== null) probes.push(probe);
    }
  }

  return ResolutionRecordSchema.parse({
    status: confirm?.outcome === "accepted" ? "resolved" : confirm?.outcome === "rejected" ? "failed" : "unresolved",
    capabilitySnapshotDigest: published?.snapshotDigest ?? null,
    reasoningDefaultsVersion: REASONING_DEFAULTS_VERSION,
    credentialSource: input.credentialSource,
    temperatureSupport: summarize(probes, "temperature", binding.reasoning),
    reasoningSupport: summarize(probes, "reasoning"),
    probes,
    checkedAt: input.now.toISOString()
  });
}

/**
 * The re-check before a sealed calibration is authorized or a governed run
 * starts: the confirming probe again, then a probe of each setting the family
 * has and the binding leaves unset, so one to three calls (only the first
 * when the saved request isn't accepted). The resolution holds only if the
 * saved request is still accepted and every unset setting is still rejected
 * as a parameter: a provider that starts accepting it, or any of its values,
 * would otherwise apply its own default unseen. A transient error means it
 * can't be shown to hold, so the run waits. The probes belong to the run they
 * guard; the resolution record never changes.
 */
export async function recheckExecutionBinding(input: {
  binding: ExecutionBinding;
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  execute: ProbeExecutor;
}): Promise<{ holds: boolean; probes: CapabilityProbe[] }> {
  const { binding, execute, published } = input;
  const confirm = await sendProbe(execute, published, "recheck", "confirm", binding);
  if (confirm === null) return { holds: false, probes: [] };
  const probes = [confirm];
  if (confirm.outcome !== "accepted") return { holds: false, probes };
  const family = reasoningFamilyFor(binding.provider);
  const unset: Array<{ setting: "temperature" | "reasoning"; binding: ExecutionBinding }> = [];
  if (takesSamplingSettings(binding.provider) && binding.sampling.temperature === null) {
    unset.push({ setting: "temperature", binding: { ...binding, sampling: { ...binding.sampling, temperature: PROBE_TEMPERATURE } } });
  }
  if (family !== null && binding.reasoning === null) {
    unset.push({ setting: "reasoning", binding: { ...binding, reasoning: input.documentedDefault ?? middleReasoning(family, published) } });
  }
  let holds = true;
  for (const { setting, binding: probed } of unset) {
    const probe = await sendProbe(execute, published, "recheck", setting, probed);
    if (probe === null) return { holds: false, probes };
    probes.push(probe);
    if (supportFrom(probe, setting) !== "parameter_rejected") holds = false;
  }
  return { holds, probes };
}

/**
 * What stops a binding at a governed gate (ADR-0014 section 2): candidate
 * creation, activation, and sealed calibration need a resolved binding; an
 * explicit temperature unless the family takes no sampling or the record
 * shows the model rejecting the parameter itself with the saved reasoning;
 * and explicit reasoning unless the family has no shape or the record shows
 * the model rejecting the reasoning parameter itself. The record must be the
 * one resolved for this binding.
 */
export function governedGateProblems(binding: ExecutionBinding, record: ResolutionRecord | null): string[] {
  const problems: string[] = [];
  if (record?.status !== "resolved") problems.push(`the execution binding is ${record?.status ?? "unresolved"}, not resolved`);
  if (takesSamplingSettings(binding.provider) && binding.sampling.temperature === null && record?.temperatureSupport !== "parameter_rejected") {
    problems.push("temperature must be explicit: the model hasn't been shown to reject the temperature parameter");
  }
  if (reasoningFamilyFor(binding.provider) !== null && binding.reasoning === null && record?.reasoningSupport !== "parameter_rejected") {
    problems.push("reasoning must be explicit: the model hasn't been shown to reject the reasoning parameter");
  }
  return problems;
}
