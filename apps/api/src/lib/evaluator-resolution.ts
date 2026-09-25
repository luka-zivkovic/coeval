import { executeVerdict, type ExecutionFetch } from "@rubrist/audit/runtime";
import {
  CapabilityProbeSchema,
  REASONING_DEFAULTS_VERSION,
  ResolutionRecordSchema,
  type CapabilityProbe,
  type ExecutionBinding,
  type JudgeProviderCredentialSource,
  type ReasoningSettings,
  type ResolutionRecord,
  type SettingSupport,
  type VerdictProtocolId
} from "@rubrist/shared";
import { attributeProbeOutcome, capabilityProtocolOrder, type PublishedCapabilities } from "./evaluator-capability.js";

// The capability check, resolution, and re-check of an execution binding
// (Rubrist ADR-0014 section 4). Probes send a fixed, non-sensitive input and
// never change the binding: the check informs the author before save,
// resolution confirms or fails the saved binding, and the re-check guards one
// governed run or sealed authorization.

/** One probe call: resolves when the provider accepted it, throws the call's failure otherwise. */
export type ProbeExecutor = (binding: ExecutionBinding) => Promise<void>;

type VerdictSpec = { verdictKind: "binary" | "scalar" | "categorical"; scalarRange: [number, number] | null; categoricalChoiceScores: Record<string, number> | null };

/** The fixed probe input: no project data, no rubric of the author's. */
export const CAPABILITY_PROBE_INPUT = {
  rubricMarkdown: "Pass when the answer states the correct sum. Fail when it doesn't.",
  prompt: "Judge the trace against the review guide below.\n\n<review_guide>\n{{rubric_markdown}}\n</review_guide>",
  trace: { id: "rubrist-capability-probe", input: { question: "What is 2 + 3?" }, output: { answer: "5" } }
} as const;

/** The temperature a temperature probe sends: the seeded default's. */
export const PROBE_TEMPERATURE = 0;

/** A probe executor over executeVerdict, judging the fixed input with the evaluator's verdict kind. */
export function verdictProbeExecutor(input: {
  apiKey: string | null;
  customBaseUrl: string | null;
  spec: VerdictSpec;
  fetch?: ExecutionFetch;
  timeoutMs?: number;
}): ProbeExecutor {
  return async (binding) => {
    await executeVerdict({
      binding,
      apiKey: input.apiKey,
      customBaseUrl: input.customBaseUrl,
      rubricMarkdown: CAPABILITY_PROBE_INPUT.rubricMarkdown,
      prompt: CAPABILITY_PROBE_INPUT.prompt,
      trace: CAPABILITY_PROBE_INPUT.trace,
      spec: input.spec,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
    });
  };
}

const takesSampling = (provider: ExecutionBinding["provider"]) => provider !== "typesafe" && provider !== "mock";

function reasoningFamily(provider: ExecutionBinding["provider"]): ReasoningSettings["family"] | null {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "openai":
    case "custom":
      return "openai";
    case "openrouter":
      return "openrouter";
    case "mock":
    case "typesafe":
      return null;
  }
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

const sameSettings = (left: unknown, right: unknown): boolean => {
  const stable = (value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
    : value;
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
};

async function sendProbe(
  execute: ProbeExecutor,
  stage: CapabilityProbe["stage"],
  purpose: CapabilityProbe["purpose"],
  binding: ExecutionBinding
): Promise<CapabilityProbe> {
  const sent = {
    temperature: binding.sampling.temperature,
    topP: binding.sampling.topP,
    reasoning: binding.reasoning,
    outputTokenLimit: binding.outputTokenLimit
  };
  let error: unknown;
  try {
    await execute(binding);
  } catch (caught) {
    error = caught ?? new Error("probe failed");
  }
  const attribution = attributeProbeOutcome({ purpose, sent }, error === undefined ? {} : { error });
  return CapabilityProbeSchema.parse({ stage, purpose, verdictProtocol: binding.verdictProtocol, sent, ...attribution, costMicroUsd: null });
}

/** A setting's support as a probe recorded it; `null` when the probe errored. */
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
 * An acceptance anywhere wins over a rejection of some value.
 */
function summarize(probes: readonly CapabilityProbe[], setting: "temperature" | "reasoning", reasoning?: ReasoningSettings | null): SettingSupport | null {
  const relevant = probes.filter((probe) => probe.purpose === setting &&
    (setting !== "temperature" || reasoning === undefined || sameSettings(probe.sent.reasoning, reasoning)));
  const outcomes = relevant.map((probe) => supportFrom(probe, setting)).filter((support): support is SettingSupport => support !== null);
  if (outcomes.includes("accepted")) return "accepted";
  if (outcomes.includes("parameter_rejected")) return "parameter_rejected";
  return outcomes.includes("value_rejected") ? "value_rejected" : null;
}

export interface CapabilityCheckResult {
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
 * family's no-reasoning setting. A transient error ends the check early,
 * leaving what it learned.
 */
export async function runCapabilityCheck(input: {
  base: Pick<ExecutionBinding, "provider" | "endpoint" | "modelId" | "modelVersion" | "outputTokenLimit" | "routing">;
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
  let protocol: VerdictProtocolId | null = null;
  for (const candidate of capabilityProtocolOrder(base.provider, published).slice(0, 3)) {
    const probe = await sendProbe(execute, "capability_check", "protocol", bare(candidate));
    probes.push(probe);
    if (probe.outcome === "accepted") {
      protocol = candidate;
      break;
    }
    // Only a rejection of the mechanism, or one Rubrist can't attribute, moves to the next protocol.
    if (probe.outcome === "error" || (probe.rejection !== "mechanism" && probe.rejection !== "unattributed")) break;
  }
  const family = reasoningFamily(base.provider);
  const probedReasoning = family === null ? null : input.documentedDefault;
  if (protocol !== null && takesSampling(base.provider)) {
    const temperature = await sendProbe(execute, "capability_check", "temperature", {
      ...bare(protocol),
      sampling: { temperature: PROBE_TEMPERATURE, topP: null },
      reasoning: probedReasoning
    });
    probes.push(temperature);
  }
  if (protocol !== null && family !== null) {
    for (const reasoning of [input.documentedDefault ?? middleReasoning(family, published), noReasoning(family)]) {
      const probe = await sendProbe(execute, "capability_check", "reasoning", { ...bare(protocol), reasoning });
      probes.push(probe);
      if (probe.outcome === "error") break;
    }
  }
  return {
    protocol,
    probes,
    temperatureSupport: summarize(probes, "temperature"),
    reasoningSupport: summarize(probes, "reasoning"),
    probedReasoning
  };
}

/**
 * Resolution of a saved binding (ADR-0014 section 4). One confirming probe
 * sends the exact saved request. Unless it errored, then where the family
 * has the setting and the binding leaves it unset, and no probe of it
 * (temperature with the saved reasoning) has a recorded outcome, one probe
 * of it follows: at most 3 calls. Only the confirming probe decides: accepted is `resolved`, a
 * rejection is `failed`, and an error leaves the binding `unresolved`.
 * The binding is never changed.
 */
export async function resolveExecutionBinding(input: {
  binding: ExecutionBinding;
  checkProbes: readonly CapabilityProbe[];
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  credentialSource: JudgeProviderCredentialSource | null;
  execute: ProbeExecutor;
  now: Date;
}): Promise<ResolutionRecord> {
  const { binding, execute } = input;
  const checkProbes = input.checkProbes.filter((probe) => probe.stage === "capability_check");
  const confirm = await sendProbe(execute, "resolution", "confirm", binding);
  const probes: CapabilityProbe[] = [...checkProbes, confirm];
  const family = reasoningFamily(binding.provider);
  const recorded = (probe: CapabilityProbe) => probe.outcome !== "error";
  // A transient confirming error leaves the binding unresolved whatever else
  // is learned, so no further calls are spent until resolution runs again.
  const probing = confirm.outcome !== "error";

  if (probing && takesSampling(binding.provider) && binding.sampling.temperature === null &&
      !probes.some((probe) => probe.purpose === "temperature" && recorded(probe) && sameSettings(probe.sent.reasoning, binding.reasoning))) {
    probes.push(await sendProbe(execute, "resolution", "temperature", {
      ...binding,
      sampling: { ...binding.sampling, temperature: PROBE_TEMPERATURE }
    }));
  }
  if (probing && family !== null && binding.reasoning === null && !probes.some((probe) => probe.purpose === "reasoning" && recorded(probe))) {
    probes.push(await sendProbe(execute, "resolution", "reasoning", {
      ...binding,
      reasoning: input.documentedDefault ?? middleReasoning(family, input.published)
    }));
  }

  return ResolutionRecordSchema.parse({
    status: confirm.outcome === "accepted" ? "resolved" : confirm.outcome === "rejected" ? "failed" : "unresolved",
    capabilitySnapshotDigest: input.published?.snapshotDigest ?? null,
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
 * starts: the confirming probe again, plus a probe of each setting the family
 * has and the binding leaves unset, so one to three calls (only the first when
 * the saved request isn't accepted). The resolution
 * holds only if the saved request is still accepted and no unset setting has
 * started being accepted, since the provider would then apply its own
 * default unseen. A transient error means it can't be shown to hold, so the
 * run waits. The probes belong to the run they guard; the resolution record
 * never changes.
 */
export async function recheckExecutionBinding(input: {
  binding: ExecutionBinding;
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  execute: ProbeExecutor;
}): Promise<{ holds: boolean; probes: CapabilityProbe[] }> {
  const { binding, execute } = input;
  const confirm = await sendProbe(execute, "recheck", "confirm", binding);
  const probes = [confirm];
  // Only an accepted saved request can hold; otherwise nothing more is sent.
  if (confirm.outcome !== "accepted") return { holds: false, probes };
  const family = reasoningFamily(binding.provider);
  if (takesSampling(binding.provider) && binding.sampling.temperature === null) {
    probes.push(await sendProbe(execute, "recheck", "temperature", { ...binding, sampling: { ...binding.sampling, temperature: PROBE_TEMPERATURE } }));
  }
  if (family !== null && binding.reasoning === null) {
    probes.push(await sendProbe(execute, "recheck", "reasoning", { ...binding, reasoning: input.documentedDefault ?? middleReasoning(family, input.published) }));
  }
  return { holds: probes.slice(1).every((probe) => probe.outcome === "rejected"), probes };
}

/**
 * What stops a binding at a governed gate (ADR-0014 section 2): candidate
 * creation, activation, and sealed calibration need a resolved binding; an
 * explicit temperature unless the family takes no sampling or the record
 * shows the model rejecting the parameter itself with the saved reasoning;
 * and explicit reasoning unless the family has no shape or the record shows
 * the model rejecting the reasoning parameter itself.
 */
export function governedGateProblems(binding: ExecutionBinding, record: ResolutionRecord | null): string[] {
  const problems: string[] = [];
  if (record?.status !== "resolved") problems.push(`the execution binding is ${record?.status ?? "unresolved"}, not resolved`);
  if (takesSampling(binding.provider) && binding.sampling.temperature === null && record?.temperatureSupport !== "parameter_rejected") {
    problems.push("temperature must be explicit: the model hasn't been shown to reject the temperature parameter");
  }
  if (reasoningFamily(binding.provider) !== null && binding.reasoning === null && record?.reasoningSupport !== "parameter_rejected") {
    problems.push("reasoning must be explicit: the model hasn't been shown to reject the reasoning parameter");
  }
  return problems;
}
