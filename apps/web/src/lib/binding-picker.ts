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
  temperature: {
    shown: boolean;
    guidance: SettingGuidance | null;
    /** The temperature the check saw accepted with the author's reasoning, or `null`. */
    acceptedValue: number | null;
  };
  reasoning: { shown: boolean; guidance: SettingGuidance | null };
  /** Reasoning settings a probe saw rejected; an option that sends all of one is rejected too. */
  rejectedReasoning: ReasoningSettings[];
  /** Reasoning settings a probe saw accepted, exactly as sent. */
  acceptedReasoning: ReasoningSettings[];
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

function leaves(value: unknown, path = ""): Array<[string, unknown]> {
  return value !== null && typeof value === "object"
    ? Object.entries(value).flatMap(([key, entry]) => leaves(entry, `${path}.${key}`))
    : [[path, value]];
}

/**
 * Whether `option` sends everything `probed` sent. A probe leaves a field it
 * didn't send `null` (the no-reasoning probe sends Anthropic thinking disabled
 * with no effort), so its rejection covers every option that adds to it.
 */
function sendsAllOf(probed: ReasoningSettings, option: ReasoningSettings): boolean {
  const sent = new Map(leaves(option));
  return leaves(probed).every(([path, value]) => value === null || sent.get(path) === value);
}

function outcomeGuidance(probe: CapabilityProbe | undefined): SettingGuidance {
  if (probe === undefined || probe.outcome === "error") return "confirmed at resolution";
  return probe.outcome === "accepted" ? "accepted" : "rejected";
}

/**
 * Whether the provider's published capabilities rule out a protocol's output
 * mechanism, as the check does when it skips one (ADR-0014 section 3).
 */
function publishedRulesOut(report: CapabilityCheckReport, protocol: VerdictProtocolId): boolean {
  if (report.published === null) return false;
  if (protocol.includes(".structured-output/")) return report.published.structuredOutput === false;
  if (protocol.includes(".forced-tool/") || protocol.includes(".forced-function/")) return report.published.toolUse === false;
  return false;
}

/**
 * What the picker shows for a provider, from a capability check of the chosen
 * model (or `null` before one has run) and the reasoning and temperature the
 * author has. A blank temperature is not sent.
 */
export function bindingPickerGuidance(
  provider: JudgeProviderId,
  report: CapabilityCheckReport | null,
  author: { reasoning: ReasoningSettings | null; temperature: string }
): BindingPickerGuidance {
  const probes = report?.probes ?? [];
  const protocolProbe = (protocol: VerdictProtocolId) => probes.find((probe) => probe.purpose === "protocol" && probe.verdictProtocol === protocol);
  const protocols = verdictProtocolsFor(provider).map((protocol) => ({
    protocol,
    guidance: report === null ? null
      : publishedRulesOut(report, protocol) ? "rejected" as const
        : outcomeGuidance(protocolProbe(protocol))
  }));

  // A temperature probe answers for the reasoning and the value it was sent
  // with. A parameter rejection holds for any value; anything else holds only
  // for the probed value, so another value is confirmed at resolution.
  const samples = takesSamplingSettings(provider);
  const temperatureProbe = probes.find((probe) => probe.purpose === "temperature");
  const answered = report !== null && report.temperatureSupport !== null && sameReasoning(report.probedReasoning, author.reasoning);
  const rejectedOutright = answered && report.temperatureSupport === "parameter_rejected";
  const value = author.temperature.trim() === "" ? null : Number(author.temperature);
  const probedValue = temperatureProbe?.sent.temperature ?? null;
  const temperature = {
    shown: samples && !rejectedOutright,
    guidance: !samples || report === null ? null
      : rejectedOutright ? "rejected" as const
        : value === null ? null
          : answered && probedValue === value ? (report.temperatureSupport === "accepted" ? "accepted" as const : "rejected" as const)
            : "confirmed at resolution" as const,
    acceptedValue: answered && report.temperatureSupport === "accepted" ? probedValue : null
  };

  const family = reasoningFamilyFor(provider);
  const reasoningRejectedOutright = report?.reasoningSupport === "parameter_rejected";
  const reasoningProbes = probes.filter((probe) => probe.purpose === "reasoning" && probe.sent.reasoning !== null);
  const rejectedReasoning = reasoningProbes.filter((probe) => probe.outcome === "rejected").map((probe) => probe.sent.reasoning!);
  const acceptedReasoning = reasoningProbes.filter((probe) => probe.outcome === "accepted").map((probe) => probe.sent.reasoning!);
  const chosen = author.reasoning;
  return {
    protocols,
    temperature,
    reasoning: {
      shown: family !== null && !reasoningRejectedOutright,
      guidance: family === null || report === null || chosen === null ? null
        : reasoningRejectedOutright || rejectedReasoning.some((rejected) => sendsAllOf(rejected, chosen)) ? "rejected"
          : acceptedReasoning.some((accepted) => sameReasoning(accepted, chosen)) ? "accepted"
            : "confirmed at resolution"
    },
    rejectedReasoning,
    acceptedReasoning,
    thinkingTypes: report?.published?.thinkingTypes ?? null,
    effortLevels: report?.published?.effortLevels ?? null
  };
}

/** Whether the picker offers a reasoning setting: every one but those that send all of a rejected probe. */
export function reasoningOffered(guidance: BindingPickerGuidance, reasoning: ReasoningSettings): boolean {
  return !guidance.rejectedReasoning.some((rejected) => sendsAllOf(rejected, reasoning));
}

/** Whether a probe saw exactly this reasoning setting accepted. */
export function reasoningAccepted(guidance: BindingPickerGuidance, reasoning: ReasoningSettings): boolean {
  return guidance.acceptedReasoning.some((accepted) => sameReasoning(accepted, reasoning));
}

/**
 * What the author must change before saving: a setting the check saw the
 * model reject would fail resolution after save, so the version would be
 * failed on arrival.
 */
export function pickerBlockingProblems(guidance: BindingPickerGuidance, chosen: { verdictProtocol: VerdictProtocolId }): string[] {
  const problems: string[] = [];
  if (guidance.protocols.find((option) => option.protocol === chosen.verdictProtocol)?.guidance === "rejected") {
    problems.push(`The model rejected ${chosen.verdictProtocol} in the check; choose another verdict protocol.`);
  }
  if (guidance.reasoning.shown && guidance.reasoning.guidance === "rejected") {
    problems.push("The model rejected this reasoning setting in the check; choose another.");
  }
  if (guidance.temperature.shown && guidance.temperature.guidance === "rejected") {
    problems.push("The model rejected this temperature in the check; choose another, or leave it blank.");
  }
  return problems;
}
