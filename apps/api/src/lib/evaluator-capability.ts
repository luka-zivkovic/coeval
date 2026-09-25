import {
  EvaluatorCallError,
  verdictProtocolMechanism,
  type PromptedVerdictProtocolId,
  type ProviderErrorDetail
} from "@rubrist/audit/runtime";
import {
  verdictProtocolsFor,
  type CapabilityProbe,
  type ExecutionProviderId,
  type ReasoningSettings,
  type VerdictProtocolId
} from "@rubrist/shared";
import { sha256Digest } from "./assessment-receipt.js";

// Published capability data and probe-outcome attribution for the capability
// check (Rubrist ADR-0014 section 4). Published data narrows which verdict
// protocols to try; probes decide what the model accepts; neither ever
// changes a saved binding.

type EffortLevel = Extract<ReasoningSettings, { family: "anthropic" }>["effort"] & string;

/**
 * What a provider publishes about one model, normalized. `null` means the
 * provider publishes nothing about that capability, never that it's absent.
 */
export interface PublishedCapabilities {
  source: "anthropic-models-api" | "openrouter-models-api";
  structuredOutput: boolean | null;
  toolUse: boolean | null;
  temperature: boolean | null;
  topP: boolean | null;
  reasoning: boolean | null;
  thinkingTypes: ReadonlyArray<"enabled" | "adaptive"> | null;
  effortLevels: readonly EffortLevel[] | null;
  /** SHA-256 of exactly the published data the fields above were read from. */
  snapshotDigest: string;
}

export type CapabilityFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const CAPABILITY_TIMEOUT_MS = 10_000;
const MAX_CAPABILITY_BYTES = 16 * 1024 * 1024;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const supported = (value: unknown): boolean | null => {
  const flag = record(value)?.supported;
  return typeof flag === "boolean" ? flag : null;
};

/** Anthropic's Models API `capabilities` object, normalized. The snapshot covers only what is read. */
export function anthropicPublishedCapabilities(modelId: string, capabilities: unknown): PublishedCapabilities | null {
  const data = record(capabilities);
  if (data === null) return null;
  const thinking = record(data.thinking);
  const thinkingTypes = record(thinking?.types);
  const effort = record(data.effort);
  return {
    source: "anthropic-models-api",
    structuredOutput: supported(data.structured_outputs),
    // Anthropic publishes no tool-use or sampling flags; probes decide.
    toolUse: null,
    temperature: null,
    topP: null,
    reasoning: supported(thinking),
    thinkingTypes: thinkingTypes === null
      ? null
      : (["enabled", "adaptive"] as const).filter((type) => supported(thinkingTypes[type]) === true),
    effortLevels: effort === null
      ? null
      : supported(effort) === false ? [] : EFFORT_LEVELS.filter((level) => supported(effort[level]) === true),
    snapshotDigest: sha256Digest({
      source: "anthropic-models-api",
      modelId,
      structuredOutputs: data.structured_outputs ?? null,
      thinking: data.thinking ?? null,
      effort: data.effort ?? null
    })
  };
}

/**
 * OpenRouter's `supported_parameters` for one model, normalized. The list is
 * the union across its upstreams, so a parameter missing from it is one no
 * upstream takes; bindings send require_parameters, so a call only reaches an
 * upstream that honours what it sends.
 */
export function openRouterPublishedCapabilities(modelId: string, supportedParameters: unknown): PublishedCapabilities | null {
  if (!Array.isArray(supportedParameters)) return null;
  const parameters = [...new Set(supportedParameters.filter((value): value is string => typeof value === "string"))].sort();
  const has = (name: string) => parameters.includes(name);
  return {
    source: "openrouter-models-api",
    structuredOutput: has("structured_outputs"),
    toolUse: has("tools") && has("tool_choice"),
    temperature: has("temperature"),
    topP: has("top_p"),
    reasoning: has("reasoning"),
    thinkingTypes: null,
    effortLevels: null,
    snapshotDigest: sha256Digest({ source: "openrouter-models-api", modelId, supportedParameters: parameters })
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CAPABILITY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Reads what the provider publishes about a model, where it publishes
 * anything: Anthropic's Models API and OpenRouter's model list. OpenAI and
 * custom endpoints publish no capability data. A failed read yields `null`;
 * the probes decide instead.
 */
export async function fetchPublishedCapabilities(input: {
  provider: ExecutionProviderId;
  modelId: string;
  apiKey: string | null;
  fetch?: CapabilityFetch;
}): Promise<PublishedCapabilities | null> {
  if (input.apiKey === null || (input.provider !== "anthropic" && input.provider !== "openrouter")) return null;
  const send = input.fetch ?? ((url, init) => fetch(url, init));
  try {
    if (input.provider === "anthropic") {
      const response = await send(`https://api.anthropic.com/v1/models/${encodeURIComponent(input.modelId)}`, {
        headers: { "anthropic-version": "2023-06-01", "x-api-key": input.apiKey },
        signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS)
      });
      if (!response.ok) return null;
      return anthropicPublishedCapabilities(input.modelId, record(await boundedJson(response))?.capabilities);
    }
    const response = await send("https://openrouter.ai/api/v1/models", {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const rows = record(await boundedJson(response))?.data;
    const row = Array.isArray(rows) ? rows.map(record).find((entry) => entry?.id === input.modelId) : undefined;
    return row ? openRouterPublishedCapabilities(input.modelId, row.supported_parameters) : null;
  } catch {
    return null;
  }
}

/**
 * The protocols a capability check tries, in ADR-0014 section 3 order:
 * structured output, then a forced tool or function, then prompted JSON. A
 * protocol the published data rules out is skipped; unpublished is tried.
 */
export function capabilityProtocolOrder(provider: ExecutionProviderId, published: PublishedCapabilities | null): VerdictProtocolId[] {
  return verdictProtocolsFor(provider).filter((protocol) => {
    if (published === null || protocol === "typed-question/v1") return true;
    const mechanism = verdictProtocolMechanism(protocol as PromptedVerdictProtocolId);
    if (mechanism === "structured_output") return published.structuredOutput !== false;
    if (mechanism === "forced_tool") return published.toolUse !== false;
    return true;
  });
}

type ProbeParameter = NonNullable<CapabilityProbe["rejectedParameter"]>;
type ProbeAttribution = Pick<CapabilityProbe, "outcome" | "rejection" | "rejectedParameter" | "failureKind" | "providerMessage">;

const PARAMETER_PATTERNS: Record<ProbeParameter, RegExp> = {
  temperature: /\btemperature\b/,
  topP: /\btop[_-]?p\b/,
  reasoning: /\bthinking\b|\breasoning(?:_effort)?\b|\beffort\b|\bbudget_tokens\b/,
  outputTokenLimit: /\bmax_(?:completion_)?tokens\b/
};
const MECHANISM_PATTERN = /\btool_choice\b|\btool choice\b|\btools?\b|\bfunction[_ ]call|\bresponse_format\b|\bjson_schema\b|\bstructured[_ ]outputs?\b|\boutput_config\.format\b|\boutput format\b/;
// Wording that refuses one value rather than the parameter itself. A
// parameter the model takes only at its default is a value rejection too.
const VALUE_PATTERN = new RegExp([
  "\\bunsupported[_ ]value\\b", "\\binvalid[_ ]value\\b", "\\bmust be\\b", "\\bshould be\\b", "\\bbetween\\b",
  "\\bat (?:least|most)\\b", "\\bgreater than\\b", "\\bless than\\b", "\\bonly the default\\b", "\\bdefault value\\b",
  "\\bnon-default\\b", "\\bmay only\\b", "\\bonly be set\\b", "\\bonly (?:supports?|accepts?)\\b", "\\bout of range\\b", "\\brange\\b"
].join("|"));

const PUBLISHED_FLAG: Partial<Record<ProbeParameter, keyof PublishedCapabilities>> = {
  temperature: "temperature",
  topP: "topP",
  reasoning: "reasoning"
};

function sentValueTokens(sent: CapabilityProbe["sent"]): Record<ProbeParameter, string[]> {
  const reasoning = sent.reasoning;
  return {
    temperature: [],
    topP: [],
    outputTokenLimit: [],
    reasoning: reasoning === null
      ? []
      : reasoning.family === "anthropic"
        ? [reasoning.thinking.type, ...(reasoning.effort !== null ? [reasoning.effort] : [])]
        : reasoning.effort !== null ? [reasoning.effort] : []
  };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The provider's message as the record keeps it, with a wrapped upstream error appended, bounded. */
function providerMessageOf(detail: ProviderErrorDetail | null): string | null {
  if (detail === null) return null;
  const upstream = detail.raw === null ? null : `upstream${detail.upstreamProvider ? ` ${detail.upstreamProvider}` : ""}: ${detail.raw}`;
  const message = [detail.message, upstream].filter((part): part is string => part !== null).join(" — ");
  return message.length === 0 ? null : message.slice(0, 2_000);
}

/**
 * How one probe fared (ADR-0014 section 4). Only a rejected request or a
 * broken protocol is a rejection; everything else is an error that leaves
 * the question open.
 *
 * - A rejection that names one sent parameter marks that parameter, as a
 *   whole only when neither the wording nor a sent value points at a single
 *   value.
 * - When the wording names nothing, but the probe sent exactly one optional
 *   setting and the provider publishes that it takes no such parameter, the
 *   parameter is marked (OpenRouter's "no endpoints" refusal names none).
 * - A rejection naming only the output mechanism, or a broken protocol on a
 *   protocol or confirming probe, is a mechanism rejection.
 * - Anything else is unattributed, which the record reads as a value
 *   rejection on a temperature or reasoning probe.
 */
export function attributeProbeOutcome(
  probe: Pick<CapabilityProbe, "purpose" | "sent">,
  outcome: { error: unknown } | { error?: undefined },
  published: PublishedCapabilities | null = null
): ProbeAttribution {
  if (outcome.error === undefined) {
    return { outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null };
  }
  const error = outcome.error;
  const failureKind = error instanceof EvaluatorCallError ? error.failureKind : "internal";
  const detail = error instanceof EvaluatorCallError ? error.providerError : null;
  const providerMessage = providerMessageOf(detail);
  if (failureKind !== "provider_rejected_request" && failureKind !== "provider_protocol") {
    return { outcome: "error", rejection: null, rejectedParameter: null, failureKind, providerMessage };
  }
  const rejected = (rejection: NonNullable<CapabilityProbe["rejection"]>, rejectedParameter: ProbeParameter | null): ProbeAttribution =>
    ({ outcome: "rejected", rejection, rejectedParameter, failureKind, providerMessage });

  if (failureKind === "provider_protocol") {
    return rejected(probe.purpose === "protocol" || probe.purpose === "confirm" ? "mechanism" : "unattributed", null);
  }
  // OpenRouter wraps the upstream's own error, which is what names the parameter.
  const text = [detail?.param, detail?.type, detail?.code, detail?.message, detail?.raw]
    .filter((part) => part !== null && part !== undefined).join(" ").toLowerCase();
  const sent = probe.sent;
  const wasSent: Record<ProbeParameter, boolean> = {
    temperature: sent.temperature !== null,
    topP: sent.topP !== null,
    reasoning: sent.reasoning !== null,
    outputTokenLimit: sent.outputTokenLimit !== null
  };
  const named = (Object.keys(PARAMETER_PATTERNS) as ProbeParameter[])
    .filter((parameter) => wasSent[parameter] && PARAMETER_PATTERNS[parameter].test(text));
  if (named.length === 1) {
    const parameter = named[0]!;
    const namesValue = VALUE_PATTERN.test(text) ||
      sentValueTokens(sent)[parameter].some((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`).test(text));
    return rejected(namesValue ? "value" : "parameter", parameter);
  }
  if (named.length === 0) {
    const optional = (["temperature", "topP", "reasoning"] as const).filter((parameter) => wasSent[parameter]);
    const only = optional.length === 1 ? optional[0]! : null;
    const flag = only === null ? undefined : PUBLISHED_FLAG[only];
    if (only !== null && flag !== undefined && published?.[flag] === false) return rejected("parameter", only);
    if (MECHANISM_PATTERN.test(text)) return rejected("mechanism", null);
  }
  return rejected("unattributed", null);
}
