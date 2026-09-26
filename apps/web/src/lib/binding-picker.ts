import {
  reasoningFamilyFor,
  takesSamplingSettings,
  verdictProtocolsFor,
  type CapabilityCheckReport,
  type CapabilityProbe,
  type JudgeProviderId,
  type ReasoningSettings,
  type VerdictProtocolId
} from "@rubrist/shared";

// The model picker's guidance (ADR-0014 section 4, founder decision 1): what a
// capability check showed about each setting the author can choose. A field
// the model rejects outright is hidden; a value it rejects isn't offered; a
// setting no probe tried is marked "confirmed at resolution", since resolution
// after save sends the exact saved request.

/** What the check showed about one setting as the author has it. */
export type SettingGuidance =
  | "accepted"
  | "rejected"
  | "confirmed at resolution";

export interface ProtocolGuidance {
  protocol: VerdictProtocolId;
  guidance: SettingGuidance | null;
}

export interface BindingPickerGuidance {
  /** The provider's protocols in ADR-0014 section 3 order, with what the check showed. */
  protocols: ProtocolGuidance[];
  /** The protocol to pre-select: the first one a probe accepted. */
  suggestedProtocol: VerdictProtocolId | null;
  temperature: { shown: boolean; guidance: SettingGuidance | null };
  reasoning: { shown: boolean; guidance: SettingGuidance | null };
  /** Reasoning settings a probe saw the model reject, so the picker doesn't offer them. */
  rejectedReasoning: ReasoningSettings[];
  /** What the provider publishes about Anthropic thinking and effort; `null` when unknown. */
  thinkingTypes: ReadonlyArray<"enabled" | "adaptive"> | null;
  effortLevels: ReadonlyArray<"low" | "medium" | "high" | "xhigh" | "max"> | null;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
  entry !== null && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, (entry as Record<string, unknown>)[key]]))
    : entry);

/** Whether two reasoning settings are the same setting. */
export function sameReasoning(left: ReasoningSettings | null, right: ReasoningSettings | null): boolean {
  return stable(left) === stable(right);
}

function outcomeGuidance(probe: CapabilityProbe | undefined): SettingGuidance {
  if (probe === undefined || probe.outcome === "error") return "confirmed at resolution";
  return probe.outcome === "accepted" ? "accepted" : "rejected";
}

/**
 * What the picker shows for a provider, from a capability check of the chosen
 * model (or `null` before one has run) and the reasoning the author has.
 */
export function bindingPickerGuidance(
  provider: JudgeProviderId,
  report: CapabilityCheckReport | null,
  reasoning: ReasoningSettings | null
): BindingPickerGuidance {
  const probes = report?.probes ?? [];
  const protocolProbe = (protocol: VerdictProtocolId) => probes.find((probe) => probe.purpose === "protocol" && probe.verdictProtocol === protocol);
  const protocols = verdictProtocolsFor(provider).map((protocol) => ({
    protocol,
    guidance: report === null ? null : outcomeGuidance(protocolProbe(protocol))
  }));

  const samples = takesSamplingSettings(provider);
  // A temperature probe answers for the reasoning it was sent with, so the
  // answer holds only while the author keeps that reasoning.
  const temperatureAnswered = report !== null && report.temperatureSupport !== null && sameReasoning(report.probedReasoning, reasoning);
  const temperatureRejectedOutright = temperatureAnswered && report.temperatureSupport === "parameter_rejected";
  const temperature = {
    shown: samples && !temperatureRejectedOutright,
    guidance: !samples || report === null ? null
      : temperatureRejectedOutright ? "rejected" as const
        : temperatureAnswered && report.temperatureSupport === "accepted" ? "accepted" as const
          : "confirmed at resolution" as const
  };

  const family = reasoningFamilyFor(provider);
  const reasoningRejectedOutright = report?.reasoningSupport === "parameter_rejected";
  const reasoningProbes = probes.filter((probe) => probe.purpose === "reasoning");
  const rejectedReasoning = reasoningProbes
    .filter((probe) => probe.outcome === "rejected" && probe.sent.reasoning !== null)
    .map((probe) => probe.sent.reasoning!);
  const matching = reasoning === null ? undefined : reasoningProbes.find((probe) => sameReasoning(probe.sent.reasoning, reasoning));
  return {
    protocols,
    suggestedProtocol: report?.protocol ?? null,
    temperature,
    reasoning: {
      shown: family !== null && !reasoningRejectedOutright,
      guidance: family === null || report === null || reasoning === null ? null
        : reasoningRejectedOutright ? "rejected" : outcomeGuidance(matching)
    },
    rejectedReasoning,
    thinkingTypes: report?.published?.thinkingTypes ?? null,
    effortLevels: report?.published?.effortLevels ?? null
  };
}

/** Whether the picker offers a reasoning setting: every one but those a probe saw rejected. */
export function reasoningOffered(guidance: BindingPickerGuidance, reasoning: ReasoningSettings): boolean {
  return !guidance.rejectedReasoning.some((rejected) => sameReasoning(rejected, reasoning));
}
