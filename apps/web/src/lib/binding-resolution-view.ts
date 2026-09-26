import {
  describeReasoningSettings,
  type BindingResolutionStatus,
  type CapabilityProbe,
  type JudgeProviderCredentialSource,
  type SettingSupport
} from "@rubrist/shared";

// How a version's resolution reads to its author (ADR-0014 section 4, Batch
// 8F): its status, what the model showed about each unset setting, every
// probe of the latest attempt, and whether the binding can pass a governed
// gate, with what to change where it can't.

export type ResolutionTone = "pass" | "ambig" | "fail";

export interface ResolutionProbeRow {
  purpose: string;
  sent: string;
  outcome: string;
  tone: ResolutionTone;
  providerMessage: string | null;
}

export interface ResolutionView {
  label: string;
  tone: ResolutionTone;
  summary: string;
  settings: Array<{ setting: string; support: string }>;
  probes: ResolutionProbeRow[];
  gate: { ready: true } | { ready: false; problems: string[]; suggestion: string | null; providerMessage: string | null };
  /** Whether the viewer may resolve now, and doing so could change the record. */
  canResolve: boolean;
}

const CREDENTIAL: Record<JudgeProviderCredentialSource, string> = {
  built_in: "the built-in mock",
  project: "this project's key",
  environment: "the platform's key"
};

const SUPPORT: Record<SettingSupport, string> = {
  accepted: "accepted",
  value_rejected: "the probed value was rejected",
  parameter_rejected: "rejected as a parameter, so it stays unset"
};

const PURPOSE: Record<CapabilityProbe["purpose"], string> = {
  protocol: "Protocol probe",
  temperature: "Temperature probe",
  reasoning: "Reasoning probe",
  confirm: "Confirming probe"
};

function sentSettings(sent: CapabilityProbe["sent"]): string {
  return [
    sent.temperature === null ? "temperature not sent" : `temperature ${sent.temperature}`,
    sent.topP === null ? null : `top_p ${sent.topP}`,
    describeReasoningSettings(sent.reasoning),
    sent.outputTokenLimit === null ? null : `${sent.outputTokenLimit} output tokens`
  ].filter((part): part is string => part !== null).join(" · ");
}

function probeOutcome(probe: CapabilityProbe): { outcome: string; tone: ResolutionTone } {
  if (probe.outcome === "accepted") return { outcome: "accepted", tone: "pass" };
  if (probe.outcome === "error") {
    return { outcome: `no answer: ${(probe.failureKind ?? "error").replaceAll("_", " ")}`, tone: "ambig" };
  }
  switch (probe.rejection) {
    case "parameter":
      return { outcome: `rejected ${probe.rejectedParameter ?? "a setting"} as a parameter`, tone: "fail" };
    case "value":
      return { outcome: `rejected this ${probe.rejectedParameter ?? "setting"} value`, tone: "fail" };
    case "mechanism":
      return { outcome: "rejected the verdict protocol", tone: "fail" };
    default:
      return { outcome: "rejected", tone: "fail" };
  }
}

const utcMinute = (timestamp: string) => `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** What the resolution panel shows for a version's resolution status. */
export function resolutionView(status: BindingResolutionStatus): ResolutionView {
  const { record } = status;
  const label = record === null ? "Not resolved yet"
    : record.status === "resolved" ? "Resolved"
      : record.status === "failed" ? "Failed" : "Unresolved";
  const tone: ResolutionTone = record?.status === "resolved" ? "pass" : record?.status === "failed" ? "fail" : "ambig";
  const summary = record === null
    ? "No resolution has run yet. It runs after save, the first time a governed gate needs it, or on demand."
    : `Last attempt${record.checkedAt === null ? "" : ` ${utcMinute(record.checkedAt)}`}, ${record.credentialSource === null ? "without a credential" : `with ${CREDENTIAL[record.credentialSource]}`}.${
      record.status === "failed" ? " A failed binding is fixed only by a new evaluator version." : ""}`;
  return {
    label,
    tone,
    summary,
    settings: record === null ? [] : [
      { setting: "Temperature", support: record.temperatureSupport === null ? "not probed" : SUPPORT[record.temperatureSupport] },
      { setting: "Reasoning", support: record.reasoningSupport === null ? "not probed" : SUPPORT[record.reasoningSupport] }
    ],
    probes: (record?.probes ?? []).map((probe) => ({
      purpose: `${PURPOSE[probe.purpose]}${probe.stage === "capability_check" ? " (check)" : ""} · ${probe.verdictProtocol}`,
      sent: sentSettings(probe.sent),
      ...probeOutcome(probe),
      providerMessage: probe.providerMessage
    })),
    gate: status.gateRefusal === null ? { ready: true } : {
      ready: false,
      problems: status.gateRefusal.problems,
      // Before any attempt, resolving is the next step, not a retry.
      suggestion: record === null ? null : status.gateRefusal.suggestion,
      providerMessage: status.gateRefusal.providerMessage
    },
    canResolve: status.projectRole === "owner" && status.resolvable
  };
}
