import { EvaluatorCallError, type ExecutionFetch } from "@rubrist/audit/runtime";
import { ResolutionRecordSchema, documentedReasoningDefault, type ExecutionBinding, type ReasoningSettings } from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import { anthropicPublishedCapabilities, openRouterPublishedCapabilities } from "../src/lib/evaluator-capability.js";
import {
  CAPABILITY_PROBE_INPUT,
  PROBE_TEMPERATURE,
  governedGateProblems,
  middleReasoning,
  noReasoning,
  recheckExecutionBinding,
  resolveExecutionBinding,
  runCapabilityCheck,
  verdictProbeExecutor,
  type CapabilityCheckResult,
  type ProbeExecutor
} from "../src/lib/evaluator-resolution.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ADAPTIVE: ReasoningSettings = { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" };
const DISABLED: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: null };
const USAGE = { inputTokens: 90, outputTokens: 12 };

const BASE = {
  provider: "anthropic" as const,
  endpoint: { kind: "managed" as const },
  modelId: "claude-opus-5-5",
  modelVersion: "claude-opus-5-5",
  outputTokenLimit: 1200,
  routing: null
};

const OPUS_PUBLISHED = anthropicPublishedCapabilities("claude-opus-5-5", {
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } },
  structured_outputs: { supported: true },
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }
});

function rejection(message: string, kind: EvaluatorCallError["failureKind"] = "provider_rejected_request", physicalCall = true) {
  return new EvaluatorCallError(kind, message, {
    physicalCall,
    status: kind === "provider_rejected_request" ? 400 : 503,
    providerError: { type: "invalid_request_error", code: null, param: null, message, raw: null, upstreamProvider: null },
    usage: kind === "provider_rejected_request" ? null : { inputTokens: 5, outputTokens: 0 }
  });
}

interface SimulatedModel {
  /** Protocols the model can't do, rejected by naming the mechanism. */
  rejectsProtocols?: string[];
  /** How the model treats an explicit temperature. */
  temperature?: "accepted" | "parameter" | "only-default";
  /** Whether a reasoning setting is accepted, rejected by value, or rejected as a parameter. */
  reasoning?: (reasoning: ReasoningSettings) => "accepted" | "parameter" | "value";
  /** Fail calls with a transient error, from the nth call (1-based) on. */
  transientFrom?: number;
  /** Refuse before sending, as a missing credential does. */
  notSent?: boolean;
}

// A scripted provider: throws the same classified errors executeVerdict would.
function simulate(model: SimulatedModel): { execute: ProbeExecutor; sent: ExecutionBinding[] } {
  const sent: ExecutionBinding[] = [];
  return {
    sent,
    execute: async (binding) => {
      if (model.notSent) throw rejection("no anthropic credential is available", "provider_unavailable", false);
      sent.push(binding);
      if (model.transientFrom !== undefined && sent.length >= model.transientFrom) throw rejection("overloaded", "provider_unavailable");
      if (model.rejectsProtocols?.includes(binding.verdictProtocol)) {
        throw rejection(binding.verdictProtocol.includes("structured")
          ? "output_config.format: structured outputs are not supported for this model"
          : "tool_choice forcing a specific tool is not supported for this model");
      }
      const temperature = binding.sampling.temperature;
      if (temperature !== null && model.temperature === "parameter") throw rejection("`temperature` is deprecated for this model.");
      if (temperature !== null && temperature !== 1 && model.temperature === "only-default") {
        throw rejection("`temperature` may only be set to 1 for this model");
      }
      if (binding.reasoning !== null && model.reasoning) {
        const outcome = model.reasoning(binding.reasoning);
        const mode = binding.reasoning.family === "anthropic" ? binding.reasoning.thinking.type : "effort";
        if (outcome === "parameter") throw rejection("Unsupported parameter: 'thinking' is not supported with this model.");
        if (outcome === "value") throw rejection(`thinking.type: '${mode}' is not supported for this model`);
      }
      return { usage: USAGE };
    }
  };
}

// A model that rejects temperature, even its default, and a forced tool, and thinks adaptively only.
const opusLike = (extra: Partial<SimulatedModel> = {}) => simulate({
  rejectsProtocols: ["anthropic.forced-tool/v1"],
  temperature: "parameter",
  reasoning: (reasoning) => reasoning.family === "anthropic" && reasoning.thinking.type === "adaptive" ? "accepted" : "value",
  ...extra
});

const savedOpus = (overrides: Partial<ExecutionBinding> = {}): ExecutionBinding => ({
  ...BASE,
  sampling: { temperature: null, topP: null },
  reasoning: ADAPTIVE,
  verdictProtocol: "anthropic.structured-output/v1",
  ...overrides
});

async function check(model = opusLike()): Promise<CapabilityCheckResult> {
  return runCapabilityCheck({ base: BASE, credentialSource: "project", published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, execute: model.execute });
}

describe("capability check", () => {
  it("finds the protocol, then probes temperature at its default with the default reasoning, then both reasoning settings", async () => {
    const result = await check();
    expect(result.protocol).toBe("anthropic.structured-output/v1");
    expect(result.probes.map((probe) => [probe.purpose, probe.outcome, probe.rejection])).toEqual([
      ["protocol", "accepted", null],
      ["temperature", "rejected", "parameter"],
      ["reasoning", "accepted", null],
      ["reasoning", "rejected", "value"]
    ]);
    expect(result.probes[0]!.sent).toEqual({ temperature: null, topP: null, reasoning: null, outputTokenLimit: 1200 });
    expect(result.probes[1]!.sent).toMatchObject({ temperature: PROBE_TEMPERATURE, reasoning: ADAPTIVE });
    expect(PROBE_TEMPERATURE).toBe(1);
    expect(result.probes.map((probe) => probe.sent.reasoning).slice(2)).toEqual([ADAPTIVE, DISABLED]);
    expect(result.probes[0]!.usage).toEqual(USAGE);
    expect(result).toMatchObject({ temperatureSupport: "parameter_rejected", reasoningSupport: "accepted", probedReasoning: ADAPTIVE, credentialSource: "project" });
  });

  it("reads a model that takes temperature only at its default as accepting temperature", async () => {
    const result = await check(opusLike({ temperature: "only-default" }));
    expect(result.temperatureSupport).toBe("accepted");
  });

  it("moves down the protocols past mechanism rejections, and skips what published data rules out", async () => {
    const model = simulate({ rejectsProtocols: ["anthropic.structured-output/v1", "anthropic.forced-tool/v1"], temperature: "accepted" });
    const result = await runCapabilityCheck({ base: BASE, credentialSource: "project", published: null, documentedDefault: null, execute: model.execute });
    expect(result.probes.filter((probe) => probe.purpose === "protocol").map((probe) => probe.verdictProtocol))
      .toEqual(["anthropic.structured-output/v1", "anthropic.forced-tool/v1", "prompted-json/v1"]);
    expect(result.protocol).toBe("prompted-json/v1");
    expect(result.probes).toHaveLength(6);

    const noStructured = anthropicPublishedCapabilities("m", { structured_outputs: { supported: false } });
    const skipping = simulate({ temperature: "accepted" });
    await runCapabilityCheck({ base: BASE, credentialSource: "project", published: noStructured, documentedDefault: null, execute: skipping.execute });
    expect(skipping.sent[0]!.verdictProtocol).toBe("anthropic.forced-tool/v1");
  });

  it("probes a middle reasoning value where the table has no entry, fitted to published thinking types", async () => {
    const model = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const result = await runCapabilityCheck({ base: BASE, credentialSource: "project", published: OPUS_PUBLISHED, documentedDefault: null, execute: model.execute });
    expect(result.probes.filter((probe) => probe.purpose === "reasoning").map((probe) => probe.sent.reasoning)).toEqual([ADAPTIVE, DISABLED]);
    expect(result.probes.find((probe) => probe.purpose === "temperature")!.sent.reasoning).toBeNull();
    const enabledOnly = anthropicPublishedCapabilities("m", { thinking: { supported: true, types: { enabled: { supported: true } } }, effort: { supported: false } });
    expect(middleReasoning("anthropic", enabledOnly)).toEqual({ family: "anthropic", thinking: { type: "enabled", budgetTokens: 1024 }, effort: null });
    expect(noReasoning("openai")).toEqual({ family: "openai", effort: "none" });
  });

  it("stops at a transient error, at any stage", async () => {
    const atProtocol = await check(simulate({ transientFrom: 1 }));
    expect(atProtocol).toMatchObject({ protocol: null, temperatureSupport: null, reasoningSupport: null });
    expect(atProtocol.probes).toHaveLength(1);
    expect(atProtocol.probes[0]).toMatchObject({ outcome: "error", failureKind: "provider_unavailable", usage: { inputTokens: 5, outputTokens: 0 } });

    const atTemperature = await check(opusLike({ transientFrom: 2 }));
    expect(atTemperature.protocol).toBe("anthropic.structured-output/v1");
    expect(atTemperature.probes.map((probe) => probe.purpose)).toEqual(["protocol", "temperature"]);
  });

  it("records nothing for calls that never left Rubrist", async () => {
    const result = await check(simulate({ notSent: true }));
    expect(result).toMatchObject({ protocol: null, probes: [] });
  });

  it("takes no sampling or reasoning probes for the mock", async () => {
    const model = simulate({});
    const result = await runCapabilityCheck({
      base: { ...BASE, provider: "mock", modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1", outputTokenLimit: null },
      credentialSource: "built_in",
      published: null,
      documentedDefault: null,
      execute: model.execute
    });
    expect(result.protocol).toBe("mock/v1");
    expect(result.probes).toHaveLength(1);
  });

  it("attributes an OpenRouter refusal of a parameter the model publishes no support for", async () => {
    const published = openRouterPublishedCapabilities("vendor/plain-model", ["tools", "tool_choice", "structured_outputs", "temperature"]);
    const execute: ProbeExecutor = async (binding) => {
      if (binding.reasoning !== null) throw rejection("No endpoints found that can handle the requested parameters.");
      return { usage: null };
    };
    const result = await runCapabilityCheck({
      base: { provider: "openrouter", endpoint: { kind: "managed" }, modelId: "vendor/plain-model", modelVersion: "vendor/plain-model", outputTokenLimit: 800, routing: { requireParameters: true, allowFallbacks: false } },
      credentialSource: "project",
      published,
      documentedDefault: null,
      execute
    });
    expect(result.reasoningSupport).toBe("parameter_rejected");
    expect(result.temperatureSupport).toBe("accepted");
  });
});

describe("resolution", () => {
  it("confirms the exact saved request and needs nothing more when the check covered the unset settings", async () => {
    const model = opusLike();
    const binding = savedOpus();
    const record = await resolveExecutionBinding({
      binding, trigger: "save", check: await check(model), published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE,
      credentialSource: "project", execute: model.execute, now: NOW
    });
    expect(model.sent.at(-1)).toEqual(binding);
    expect(record).toMatchObject({
      status: "resolved",
      temperatureSupport: "parameter_rejected",
      reasoningSupport: "accepted",
      credentialSource: "project",
      reasoningDefaultsVersion: "rubrist-reasoning-defaults/v1",
      capabilitySnapshotDigest: OPUS_PUBLISHED!.snapshotDigest,
      checkedAt: "2026-09-25T12:00:00.000Z"
    });
    expect(record.probes.filter((probe) => probe.stage === "resolution")).toHaveLength(1);
    expect(ResolutionRecordSchema.parse(record)).toEqual(record);
    expect(governedGateProblems(binding, record)).toEqual([]);
  });

  it("ignores a check of another model or credential source", async () => {
    const opusCheck = await check();
    const sonnet = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const binding = savedOpus({ modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6" });
    const record = await resolveExecutionBinding({
      binding, trigger: "save", check: opusCheck, published: null, documentedDefault: ADAPTIVE, credentialSource: "project", execute: sonnet.execute, now: NOW
    });
    expect(record.probes.every((probe) => probe.stage === "resolution")).toBe(true);
    expect(record.temperatureSupport).toBe("accepted");
    expect(governedGateProblems(binding, record)).toEqual(["temperature must be explicit: the model hasn't been shown to reject the temperature parameter"]);

    const otherKey = await resolveExecutionBinding({
      binding: savedOpus(), trigger: "save", check: opusCheck, published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE,
      credentialSource: "environment", execute: opusLike().execute, now: NOW
    });
    expect(otherKey.probes.some((probe) => probe.stage === "capability_check")).toBe(false);
  });

  it("probes temperature again when the saved reasoning isn't what the check probed it with", async () => {
    const model = opusLike();
    const binding = savedOpus({ reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "high" } });
    const record = await resolveExecutionBinding({
      binding, trigger: "save", check: await check(model), published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE,
      credentialSource: "project", execute: model.execute, now: NOW
    });
    const resolution = record.probes.filter((probe) => probe.stage === "resolution");
    expect(resolution.map((probe) => probe.purpose)).toEqual(["confirm", "temperature"]);
    expect(resolution[1]!.sent).toMatchObject({ temperature: 1, reasoning: binding.reasoning });
    expect(record.temperatureSupport).toBe("parameter_rejected");
  });

  it("sends at most 2 calls at save and 3 at a gate", async () => {
    const binding = savedOpus({ modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", reasoning: null });
    const input = { binding, check: null, published: null, documentedDefault: documentedReasoningDefault("anthropic", "claude-sonnet-4-6")!.reasoning, credentialSource: "environment" as const, now: NOW };
    const atSave = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const saved = await resolveExecutionBinding({ ...input, trigger: "save", execute: atSave.execute });
    expect(saved.probes.map((probe) => probe.purpose)).toEqual(["confirm", "temperature"]);

    const atGate = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const gated = await resolveExecutionBinding({ ...input, trigger: "gate", execute: atGate.execute });
    expect(gated.probes.map((probe) => probe.purpose)).toEqual(["confirm", "temperature", "reasoning"]);
    expect(gated).toMatchObject({ status: "resolved", temperatureSupport: "accepted", reasoningSupport: "accepted" });
    // Accepted settings must be stated: the gate refuses the unset ones.
    expect(governedGateProblems(binding, gated)).toEqual([
      "temperature must be explicit: the model hasn't been shown to reject the temperature parameter",
      "reasoning must be explicit: the model hasn't been shown to reject the reasoning parameter"
    ]);
  });

  it("sends only the confirming probe when every setting is explicit", async () => {
    const model = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const binding = savedOpus({ sampling: { temperature: 0, topP: null }, reasoning: DISABLED });
    const record = await resolveExecutionBinding({ binding, trigger: "gate", check: null, published: null, documentedDefault: null, credentialSource: null, execute: model.execute, now: NOW });
    expect(model.sent).toEqual([binding]);
    expect(record.status).toBe("resolved");
  });

  it("fails only on a rejected confirming probe, sending nothing more, and stays unresolved on a transient one", async () => {
    const rejected = await resolveExecutionBinding({
      binding: savedOpus({ sampling: { temperature: 0, topP: null }, reasoning: null }), trigger: "gate", check: null, published: null, documentedDefault: null,
      credentialSource: "project", execute: opusLike().execute, now: NOW
    });
    expect(rejected.status).toBe("failed");
    expect(rejected.probes).toHaveLength(1);
    expect(rejected.probes[0]).toMatchObject({ purpose: "confirm", outcome: "rejected", rejection: "parameter", rejectedParameter: "temperature" });

    const transient = await resolveExecutionBinding({
      binding: savedOpus(), trigger: "gate", check: null, published: null, documentedDefault: null,
      credentialSource: "project", execute: simulate({ transientFrom: 1 }).execute, now: NOW
    });
    expect(transient.status).toBe("unresolved");
    expect(transient.probes).toHaveLength(1);
    expect(governedGateProblems(savedOpus(), transient)[0]).toMatch(/unresolved, not resolved/);

    const unsent = await resolveExecutionBinding({
      binding: savedOpus(), trigger: "gate", check: null, published: null, documentedDefault: null,
      credentialSource: null, execute: simulate({ notSent: true }).execute, now: NOW
    });
    expect(unsent).toMatchObject({ status: "unresolved", probes: [] });
  });

  it("summarizes a rejected value over a rejected parameter", async () => {
    const execute: ProbeExecutor = async (binding) => {
      if (binding.reasoning?.family === "anthropic" && binding.reasoning.thinking.type === "adaptive") {
        throw rejection("output_config.effort: This model does not support the effort parameter.");
      }
      if (binding.reasoning !== null) throw rejection("thinking.type: 'disabled' is not supported for this model");
      return { usage: null };
    };
    const result = await runCapabilityCheck({ base: BASE, credentialSource: "project", published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, execute });
    expect(result.probes.filter((probe) => probe.purpose === "reasoning").map((probe) => probe.rejection)).toEqual(["parameter", "value"]);
    expect(result.reasoningSupport).toBe("value_rejected");
  });
});

describe("re-check before a governed run", () => {
  it("holds while the saved request is accepted and every unset setting is still rejected as a parameter", async () => {
    const result = await recheckExecutionBinding({ binding: savedOpus(), published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, execute: opusLike().execute });
    expect(result.holds).toBe(true);
    expect(result.probes.map((probe) => [probe.stage, probe.purpose])).toEqual([["recheck", "confirm"], ["recheck", "temperature"]]);
  });

  it("doesn't hold once the provider accepts an unset setting, or any value of it, or when it can't be shown", async () => {
    const accepts = await recheckExecutionBinding({ binding: savedOpus(), published: null, documentedDefault: ADAPTIVE, execute: opusLike({ temperature: "accepted" }).execute });
    expect(accepts.holds).toBe(false);

    const valueOnly: ProbeExecutor = async (binding) => {
      if (binding.sampling.temperature !== null) throw rejection("temperature: must be 0.5 for this model");
      return { usage: null };
    };
    expect((await recheckExecutionBinding({ binding: savedOpus(), published: null, documentedDefault: ADAPTIVE, execute: valueOnly })).holds).toBe(false);

    const unattributed: ProbeExecutor = async (binding) => {
      if (binding.sampling.temperature !== null) throw rejection("Invalid request.");
      return { usage: null };
    };
    expect((await recheckExecutionBinding({ binding: savedOpus(), published: null, documentedDefault: ADAPTIVE, execute: unattributed })).holds).toBe(false);

    const transient = await recheckExecutionBinding({ binding: savedOpus(), published: null, documentedDefault: ADAPTIVE, execute: simulate({ transientFrom: 1 }).execute });
    expect(transient).toMatchObject({ holds: false });
    expect(transient.probes).toHaveLength(1);
    const unsent = await recheckExecutionBinding({ binding: savedOpus(), published: null, documentedDefault: ADAPTIVE, execute: simulate({ notSent: true }).execute });
    expect(unsent).toEqual({ holds: false, probes: [] });
  });
});

describe("governed gates", () => {
  it("exempt the families with no sampling or reasoning settings", () => {
    const mock: ExecutionBinding = {
      provider: "mock", endpoint: { kind: "managed" }, modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1",
      sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "mock/v1", routing: null
    };
    const resolved = ResolutionRecordSchema.parse({
      status: "resolved", capabilitySnapshotDigest: null, reasoningDefaultsVersion: null, credentialSource: "built_in",
      temperatureSupport: null, reasoningSupport: null, checkedAt: NOW.toISOString(),
      probes: [{ stage: "resolution", purpose: "confirm", verdictProtocol: "mock/v1", sent: { temperature: null, topP: null, reasoning: null, outputTokenLimit: null }, outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null, usage: null, costMicroUsd: null }]
    });
    expect(governedGateProblems(mock, resolved)).toEqual([]);
    expect(governedGateProblems(mock, null)).toEqual(["the execution binding is unresolved, not resolved"]);
  });
});

describe("probe input", () => {
  it("judges a fixed, non-sensitive input with the evaluator's verdict kind, and returns usage", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub: ExecutionFetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({
        id: "m", model: "claude-opus-5-5", stop_reason: "end_turn",
        content: [{ type: "text", text: "{\"choice\":\"good\",\"rationale\":\"r\"}" }],
        usage: { input_tokens: 70, output_tokens: 9 }
      }));
    };
    const execute = verdictProbeExecutor({
      apiKey: "k", customBaseUrl: null, fetch: fetchStub,
      spec: { verdictKind: "categorical", scalarRange: null, categoricalChoiceScores: { good: 1, bad: 0 } }
    });
    expect(await execute(savedOpus())).toEqual({ usage: { inputTokens: 70, outputTokens: 9 } });
    const [body] = bodies;
    expect(JSON.stringify(body)).toContain("What is 2 + 3?");
    expect(JSON.stringify(body)).toContain(CAPABILITY_PROBE_INPUT.rubricMarkdown);
    expect(JSON.stringify((body!.output_config as { format: unknown }).format)).toContain("\"good\"");
  });

  it("runs the mock locally", async () => {
    const execute = verdictProbeExecutor({ apiKey: null, customBaseUrl: null, spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null } });
    await expect(execute({
      provider: "mock", endpoint: { kind: "managed" }, modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1",
      sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "mock/v1", routing: null
    })).resolves.toMatchObject({ usage: expect.any(Object) });
  });
});
