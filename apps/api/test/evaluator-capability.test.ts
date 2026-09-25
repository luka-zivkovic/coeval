import { EvaluatorCallError } from "@rubrist/audit/runtime";
import {
  CapabilityProbeSchema,
  REASONING_DEFAULTS_VERSION,
  ReasoningSettingsSchema,
  documentedReasoningDefault,
  reasoningDefaultsTable,
  type CapabilityProbe
} from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import {
  anthropicPublishedCapabilities,
  attributeProbeOutcome,
  capabilityProtocolOrder,
  fetchPublishedCapabilities,
  openRouterPublishedCapabilities,
  type CapabilityFetch
} from "../src/lib/evaluator-capability.js";

// Anthropic's published capabilities for an adaptive-only model, as the Models API shapes them.
const OPUS_CAPABILITIES = {
  batch: { supported: true },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
  structured_outputs: { supported: true },
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }
};

const NO_SETTINGS: CapabilityProbe["sent"] = { temperature: null, topP: null, reasoning: null, outputTokenLimit: 1200 };

function rejection(message: string, extra: { param?: string; kind?: EvaluatorCallError["failureKind"] } = {}) {
  return new EvaluatorCallError(extra.kind ?? "provider_rejected_request", message, {
    physicalCall: true,
    status: 400,
    providerError: { type: "invalid_request_error", code: null, param: extra.param ?? null, message, raw: null, upstreamProvider: null }
  });
}

function probe(purpose: CapabilityProbe["purpose"], sent: Partial<CapabilityProbe["sent"]>, error?: unknown): CapabilityProbe {
  const attribution = attributeProbeOutcome({ purpose, sent: { ...NO_SETTINGS, ...sent } }, error === undefined ? {} : { error });
  // Every attribution must make a probe the shared record accepts.
  return CapabilityProbeSchema.parse({
    stage: "capability_check",
    purpose,
    verdictProtocol: "anthropic.structured-output/v1",
    sent: { ...NO_SETTINGS, ...sent },
    ...attribution,
    costMicroUsd: null
  });
}

describe("rubrist-reasoning-defaults/v1", () => {
  it("holds the documented defaults ADR-0014 records, each a valid reasoning shape with sources", () => {
    expect(REASONING_DEFAULTS_VERSION).toBe("rubrist-reasoning-defaults/v1");
    expect(documentedReasoningDefault("anthropic", "claude-sonnet-4-6")?.reasoning)
      .toEqual({ family: "anthropic", thinking: { type: "disabled" }, effort: "high" });
    expect(documentedReasoningDefault("anthropic", "claude-opus-5-5")?.reasoning)
      .toEqual({ family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" });
    expect(documentedReasoningDefault("openai", "gpt-5")).toBeNull();
    for (const entry of reasoningDefaultsTable()) {
      expect(ReasoningSettingsSchema.parse(entry.reasoning)).toEqual(entry.reasoning);
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("published capability data", () => {
  it("reads Anthropic's capabilities without claiming what it doesn't publish", () => {
    const published = anthropicPublishedCapabilities("claude-opus-5-5", OPUS_CAPABILITIES)!;
    expect(published).toMatchObject({
      source: "anthropic-models-api",
      structuredOutput: true,
      toolUse: null,
      temperature: null,
      topP: null,
      reasoning: true,
      thinkingTypes: ["adaptive"],
      effortLevels: ["low", "medium", "high", "xhigh", "max"]
    });
    expect(published.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const noEffort = anthropicPublishedCapabilities("claude-haiku-4-5-20251001", { ...OPUS_CAPABILITIES, effort: { supported: false } })!;
    expect(noEffort.effortLevels).toEqual([]);
  });

  it("reads OpenRouter's supported parameters, digesting them in a stable order", () => {
    const published = openRouterPublishedCapabilities("openai/gpt-5", ["tools", "temperature", "tool_choice", "reasoning", "structured_outputs", "tools"])!;
    expect(published).toMatchObject({ structuredOutput: true, toolUse: true, temperature: true, topP: false, reasoning: true });
    expect(openRouterPublishedCapabilities("openai/gpt-5", ["structured_outputs", "reasoning", "tool_choice", "temperature", "tools"])!.snapshotDigest)
      .toBe(published.snapshotDigest);
  });

  it("orders protocols as section 3 does, skipping only what the data rules out", () => {
    expect(capabilityProtocolOrder("anthropic", null)).toEqual(["anthropic.structured-output/v1", "anthropic.forced-tool/v1", "prompted-json/v1"]);
    const noStructured = anthropicPublishedCapabilities("m", { ...OPUS_CAPABILITIES, structured_outputs: { supported: false } });
    expect(capabilityProtocolOrder("anthropic", noStructured)).toEqual(["anthropic.forced-tool/v1", "prompted-json/v1"]);
    const noTools = openRouterPublishedCapabilities("m", ["temperature"]);
    expect(capabilityProtocolOrder("openrouter", noTools)).toEqual(["prompted-json/v1"]);
    expect(capabilityProtocolOrder("custom", null)).toEqual(["openai.structured-output/v1", "openai.forced-function/v1", "prompted-json/v1"]);
  });

  it("fetches only where a provider publishes, and falls back to probes on any failure", async () => {
    const calls: string[] = [];
    const fetchStub: CapabilityFetch = async (url) => {
      calls.push(url);
      if (url.includes("anthropic")) return new Response(JSON.stringify({ id: "claude-opus-5-5", capabilities: OPUS_CAPABILITIES }));
      return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5", supported_parameters: ["tools", "tool_choice"] }] }));
    };
    expect((await fetchPublishedCapabilities({ provider: "anthropic", modelId: "claude-opus-5-5", apiKey: "k", fetch: fetchStub }))?.structuredOutput).toBe(true);
    expect((await fetchPublishedCapabilities({ provider: "openrouter", modelId: "openai/gpt-5", apiKey: "k", fetch: fetchStub }))?.toolUse).toBe(true);
    expect(await fetchPublishedCapabilities({ provider: "openrouter", modelId: "unknown/model", apiKey: "k", fetch: fetchStub })).toBeNull();
    expect(await fetchPublishedCapabilities({ provider: "openai", modelId: "gpt-5", apiKey: "k", fetch: fetchStub })).toBeNull();
    expect(await fetchPublishedCapabilities({ provider: "anthropic", modelId: "m", apiKey: null, fetch: fetchStub })).toBeNull();
    expect(calls).toEqual([
      "https://api.anthropic.com/v1/models/claude-opus-5-5",
      "https://openrouter.ai/api/v1/models",
      "https://openrouter.ai/api/v1/models"
    ]);
    const failing: CapabilityFetch = async () => { throw new TypeError("fetch failed"); };
    expect(await fetchPublishedCapabilities({ provider: "anthropic", modelId: "m", apiKey: "k", fetch: failing })).toBeNull();
    const denied: CapabilityFetch = async () => new Response("{}", { status: 401 });
    expect(await fetchPublishedCapabilities({ provider: "anthropic", modelId: "m", apiKey: "k", fetch: denied })).toBeNull();
  });
});

describe("probe attribution", () => {
  const anthropicDisabled = { family: "anthropic" as const, thinking: { type: "disabled" as const }, effort: "high" as const };

  it("accepts a successful probe", () => {
    expect(probe("temperature", { temperature: 0 })).toMatchObject({ outcome: "accepted", rejection: null, failureKind: null });
  });

  it("marks a parameter rejected outright only when the wording refuses the parameter itself", () => {
    expect(probe("temperature", { temperature: 0 }, rejection("temperature is deprecated for this model.")))
      .toMatchObject({ outcome: "rejected", rejection: "parameter", rejectedParameter: "temperature" });
    expect(probe("temperature", { temperature: 0 }, rejection("Unsupported parameter: 'temperature' is not supported with this model.", { param: "temperature" })))
      .toMatchObject({ rejection: "parameter", rejectedParameter: "temperature" });
    expect(probe("reasoning", { reasoning: { family: "openai", effort: "medium" } }, rejection("Unsupported parameter: 'reasoning_effort' is not supported with this model.", { param: "reasoning_effort" })))
      .toMatchObject({ rejection: "parameter", rejectedParameter: "reasoning" });
  });

  it("marks only the value when the wording or a sent value points at one", () => {
    expect(probe("temperature", { temperature: 0 }, rejection("Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.", { param: "temperature" })))
      .toMatchObject({ rejection: "value", rejectedParameter: "temperature" });
    expect(probe("reasoning", { reasoning: anthropicDisabled }, rejection("thinking.type: 'disabled' is not supported for this model")))
      .toMatchObject({ rejection: "value", rejectedParameter: "reasoning" });
    expect(probe("temperature", { temperature: 1.5 }, rejection("temperature: range: 0 <= temperature <= 1")))
      .toMatchObject({ rejection: "value", rejectedParameter: "temperature" });
  });

  it("marks a mechanism rejection when only the output mechanism is named", () => {
    expect(probe("protocol", {}, rejection("tool_choice forcing a specific tool is not supported for this model")))
      .toMatchObject({ rejection: "mechanism", rejectedParameter: null });
    expect(probe("protocol", {}, rejection("output_config.format: structured outputs are not supported for this model")))
      .toMatchObject({ rejection: "mechanism" });
    expect(probe("protocol", {}, rejection("no tool call", { kind: "provider_protocol" })))
      .toMatchObject({ outcome: "rejected", rejection: "mechanism", failureKind: "provider_protocol" });
  });

  it("leaves a rejection naming nothing, or several sent parameters, unattributed", () => {
    expect(probe("temperature", { temperature: 0 }, rejection("Invalid request.")))
      .toMatchObject({ rejection: "unattributed", rejectedParameter: null });
    expect(probe("reasoning", { reasoning: { family: "anthropic", thinking: { type: "enabled", budgetTokens: 2048 }, effort: null }, outputTokenLimit: 1200 },
      rejection("max_tokens must be greater than thinking.budget_tokens")))
      .toMatchObject({ rejection: "unattributed" });
    expect(probe("temperature", { temperature: 0 }, rejection("broken", { kind: "provider_protocol" })))
      .toMatchObject({ rejection: "unattributed", failureKind: "provider_protocol" });
  });

  it("reads OpenRouter's wrapped upstream error, and keeps it in the provider message", () => {
    const wrapped = new EvaluatorCallError("provider_rejected_request", "Provider returned error", {
      physicalCall: true,
      status: 400,
      providerError: { type: null, code: "400", param: null, message: "Provider returned error", raw: "{\"error\":\"temperature is deprecated for this model\"}", upstreamProvider: "Anthropic" }
    });
    expect(probe("temperature", { temperature: 0 }, wrapped)).toMatchObject({
      rejection: "parameter",
      rejectedParameter: "temperature",
      providerMessage: "Provider returned error — upstream Anthropic: {\"error\":\"temperature is deprecated for this model\"}"
    });
  });

  it("ignores parameters the probe didn't send", () => {
    expect(probe("protocol", {}, rejection("tools are not supported when temperature is set")))
      .toMatchObject({ rejection: "mechanism" });
  });

  it("records transient failures as errors, never as rejections", () => {
    for (const kind of ["provider_rate_limit", "provider_timeout", "provider_authentication", "invalid_evaluator_output"] as const) {
      expect(probe("confirm", {}, rejection("try later", { kind }))).toMatchObject({ outcome: "error", rejection: null, failureKind: kind });
    }
    expect(probe("confirm", {}, new Error("bug"))).toMatchObject({ outcome: "error", failureKind: "internal" });
  });
});
