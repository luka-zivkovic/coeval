import { EvaluatorCallError, type ExecutionFetch } from "@rubrist/audit/runtime";
import { ResolutionRecordSchema, documentedReasoningDefault, type ExecutionBinding, type ReasoningSettings } from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import { anthropicPublishedCapabilities } from "../src/lib/evaluator-capability.js";
import {
  CAPABILITY_PROBE_INPUT,
  governedGateProblems,
  middleReasoning,
  noReasoning,
  recheckExecutionBinding,
  resolveExecutionBinding,
  runCapabilityCheck,
  verdictProbeExecutor,
  type ProbeExecutor
} from "../src/lib/evaluator-resolution.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ADAPTIVE: ReasoningSettings = { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" };
const DISABLED: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: null };

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

function rejection(message: string, kind: EvaluatorCallError["failureKind"] = "provider_rejected_request") {
  return new EvaluatorCallError(kind, message, {
    physicalCall: true,
    status: kind === "provider_rejected_request" ? 400 : 503,
    providerError: { type: "invalid_request_error", code: null, param: null, message, raw: null, upstreamProvider: null }
  });
}

interface SimulatedModel {
  /** Protocols the model can't do, rejected by naming the mechanism. */
  rejectsProtocols?: string[];
  temperature?: "accepted" | "parameter" | "value";
  /** Whether a reasoning setting is accepted, rejected by value, or rejected as a parameter. */
  reasoning?: (reasoning: ReasoningSettings) => "accepted" | "parameter" | "value";
  /** Fail every call this many times first with a transient error. */
  transient?: boolean;
}

// A scripted provider: throws the same classified errors executeVerdict would.
function simulate(model: SimulatedModel): { execute: ProbeExecutor; sent: ExecutionBinding[] } {
  const sent: ExecutionBinding[] = [];
  return {
    sent,
    execute: async (binding) => {
      sent.push(binding);
      if (model.transient) throw rejection("overloaded", "provider_unavailable");
      if (model.rejectsProtocols?.includes(binding.verdictProtocol)) {
        throw rejection(binding.verdictProtocol.includes("structured")
          ? "output_config.format: structured outputs are not supported for this model"
          : "tool_choice forcing a specific tool is not supported for this model");
      }
      if (binding.sampling.temperature !== null && model.temperature === "parameter") throw rejection("temperature is deprecated for this model.");
      if (binding.sampling.temperature !== null && model.temperature === "value") throw rejection("temperature: must be 1 for this model");
      if (binding.reasoning !== null && model.reasoning) {
        const outcome = model.reasoning(binding.reasoning);
        const mode = binding.reasoning.family === "anthropic" ? binding.reasoning.thinking.type : "effort";
        if (outcome === "parameter") throw rejection("thinking is not supported for this model");
        if (outcome === "value") throw rejection(`thinking.type: '${mode}' is not supported for this model`);
      }
    }
  };
}

// Opus 5.5 as ADR-0014 describes it: rejects temperature and a forced tool, thinks adaptively only.
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

describe("capability check", () => {
  it("finds the protocol, then probes temperature with the default reasoning and both reasoning settings", async () => {
    const model = opusLike();
    const check = await runCapabilityCheck({ base: BASE, published: OPUS_PUBLISHED, documentedDefault: documentedReasoningDefault("anthropic", "claude-opus-5-5")!.reasoning, execute: model.execute });

    expect(check.protocol).toBe("anthropic.structured-output/v1");
    expect(check.probes.map((probe) => [probe.purpose, probe.outcome, probe.rejection])).toEqual([
      ["protocol", "accepted", null],
      ["temperature", "rejected", "parameter"],
      ["reasoning", "accepted", null],
      ["reasoning", "rejected", "value"]
    ]);
    expect(check.probes[0]!.sent).toEqual({ temperature: null, topP: null, reasoning: null, outputTokenLimit: 1200 });
    expect(check.probes[1]!.sent).toMatchObject({ temperature: 0, reasoning: ADAPTIVE });
    expect(check.probes.map((probe) => probe.sent.reasoning).slice(2)).toEqual([ADAPTIVE, DISABLED]);
    expect(check).toMatchObject({ temperatureSupport: "parameter_rejected", reasoningSupport: "accepted", probedReasoning: ADAPTIVE });
  });

  it("moves down the protocols past mechanism rejections, and skips what published data rules out", async () => {
    const model = simulate({ rejectsProtocols: ["anthropic.structured-output/v1", "anthropic.forced-tool/v1"], temperature: "accepted" });
    const check = await runCapabilityCheck({ base: BASE, published: null, documentedDefault: null, execute: model.execute });
    expect(check.probes.filter((probe) => probe.purpose === "protocol").map((probe) => probe.verdictProtocol))
      .toEqual(["anthropic.structured-output/v1", "anthropic.forced-tool/v1", "prompted-json/v1"]);
    expect(check.protocol).toBe("prompted-json/v1");
    expect(check.probes).toHaveLength(6);

    const noStructured = anthropicPublishedCapabilities("m", { structured_outputs: { supported: false } });
    const skipping = simulate({ temperature: "accepted" });
    await runCapabilityCheck({ base: BASE, published: noStructured, documentedDefault: null, execute: skipping.execute });
    expect(skipping.sent[0]!.verdictProtocol).toBe("anthropic.forced-tool/v1");
  });

  it("probes a middle reasoning value where the table has no entry, fitted to published thinking types", async () => {
    const model = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const check = await runCapabilityCheck({ base: BASE, published: OPUS_PUBLISHED, documentedDefault: null, execute: model.execute });
    expect(check.probes.filter((probe) => probe.purpose === "reasoning").map((probe) => probe.sent.reasoning)).toEqual([ADAPTIVE, DISABLED]);
    expect(check.probes.find((probe) => probe.purpose === "temperature")!.sent.reasoning).toBeNull();
    const enabledOnly = anthropicPublishedCapabilities("m", { thinking: { supported: true, types: { enabled: { supported: true } } }, effort: { supported: false } });
    expect(middleReasoning("anthropic", enabledOnly)).toEqual({ family: "anthropic", thinking: { type: "enabled", budgetTokens: 1024 }, effort: null });
    expect(noReasoning("openai")).toEqual({ family: "openai", effort: "none" });
  });

  it("stops at a transient error, leaving the protocol undecided", async () => {
    const check = await runCapabilityCheck({ base: BASE, published: null, documentedDefault: null, execute: simulate({ transient: true }).execute });
    expect(check).toMatchObject({ protocol: null, temperatureSupport: null, reasoningSupport: null });
    expect(check.probes).toHaveLength(1);
    expect(check.probes[0]).toMatchObject({ outcome: "error", failureKind: "provider_unavailable" });
  });

  it("takes no sampling or reasoning probes for the mock", async () => {
    const model = simulate({});
    const check = await runCapabilityCheck({
      base: { ...BASE, provider: "mock", modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1", outputTokenLimit: null },
      published: null,
      documentedDefault: null,
      execute: model.execute
    });
    expect(check.protocol).toBe("mock/v1");
    expect(check.probes).toHaveLength(1);
  });
});

describe("resolution", () => {
  async function checked() {
    const model = opusLike();
    const check = await runCapabilityCheck({ base: BASE, published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, execute: model.execute });
    return { check, model };
  }

  it("confirms the exact saved request and needs nothing more when the check covered the unset settings", async () => {
    const { check, model } = await checked();
    const binding = savedOpus();
    const record = await resolveExecutionBinding({
      binding, checkProbes: check.probes, published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, credentialSource: "project", execute: model.execute, now: NOW
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

  it("probes temperature again when the saved reasoning isn't what the check probed it with", async () => {
    const { check, model } = await checked();
    const binding = savedOpus({ reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "high" } });
    const record = await resolveExecutionBinding({
      binding, checkProbes: check.probes, published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, credentialSource: "project", execute: model.execute, now: NOW
    });
    const resolution = record.probes.filter((probe) => probe.stage === "resolution");
    expect(resolution.map((probe) => probe.purpose)).toEqual(["confirm", "temperature"]);
    expect(resolution[1]!.sent).toMatchObject({ temperature: 0, reasoning: binding.reasoning });
    expect(record.temperatureSupport).toBe("parameter_rejected");
  });

  it("probes both unset settings for an unresolved binding with no check, at most three calls", async () => {
    const model = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const binding = savedOpus({ modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", reasoning: null });
    const record = await resolveExecutionBinding({
      binding, checkProbes: [], published: null, documentedDefault: documentedReasoningDefault("anthropic", "claude-sonnet-4-6")!.reasoning,
      credentialSource: "environment", execute: model.execute, now: NOW
    });
    expect(record.probes.map((probe) => probe.purpose)).toEqual(["confirm", "temperature", "reasoning"]);
    expect(record).toMatchObject({ status: "resolved", temperatureSupport: "accepted", reasoningSupport: "accepted" });
    // Accepted settings must be stated: the gate refuses the unset ones.
    expect(governedGateProblems(binding, record)).toEqual([
      "temperature must be explicit: the model hasn't been shown to reject the temperature parameter",
      "reasoning must be explicit: the model hasn't been shown to reject the reasoning parameter"
    ]);
  });

  it("sends only the confirming probe when every setting is explicit", async () => {
    const model = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const binding = savedOpus({ sampling: { temperature: 0, topP: null }, reasoning: DISABLED });
    const record = await resolveExecutionBinding({
      binding, checkProbes: [], published: null, documentedDefault: null, credentialSource: null, execute: model.execute, now: NOW
    });
    expect(model.sent).toEqual([binding]);
    expect(record.status).toBe("resolved");
  });

  it("fails only on a rejected confirming probe, and stays unresolved on a transient one", async () => {
    const rejected = await resolveExecutionBinding({
      binding: savedOpus({ sampling: { temperature: 0, topP: null } }), checkProbes: [], published: null, documentedDefault: null,
      credentialSource: "project", execute: opusLike().execute, now: NOW
    });
    expect(rejected.status).toBe("failed");
    expect(rejected.probes[0]).toMatchObject({ purpose: "confirm", outcome: "rejected", rejection: "parameter", rejectedParameter: "temperature" });

    const transient = await resolveExecutionBinding({
      binding: savedOpus(), checkProbes: [], published: null, documentedDefault: null,
      credentialSource: "project", execute: simulate({ transient: true }).execute, now: NOW
    });
    expect(transient.status).toBe("unresolved");
    expect(transient.probes).toHaveLength(1);
    expect(governedGateProblems(savedOpus(), transient)[0]).toMatch(/unresolved, not resolved/);
  });
});

describe("re-check before a governed run", () => {
  it("holds while the saved request is accepted and every unset setting is still rejected", async () => {
    const result = await recheckExecutionBinding({ binding: savedOpus(), published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, execute: opusLike().execute });
    expect(result.holds).toBe(true);
    expect(result.probes.map((probe) => [probe.stage, probe.purpose])).toEqual([["recheck", "confirm"], ["recheck", "temperature"]]);
  });

  it("doesn't hold once the provider starts accepting an unset setting, or when it can't be shown", async () => {
    const acceptsTemperature = await recheckExecutionBinding({ binding: savedOpus(), published: null, documentedDefault: ADAPTIVE, execute: opusLike({ temperature: "accepted" }).execute });
    expect(acceptsTemperature.holds).toBe(false);
    const transient = await recheckExecutionBinding({ binding: savedOpus(), published: null, documentedDefault: ADAPTIVE, execute: simulate({ transient: true }).execute });
    expect(transient.holds).toBe(false);
    expect(transient.probes).toHaveLength(1);
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
      probes: [{ stage: "resolution", purpose: "confirm", verdictProtocol: "mock/v1", sent: { temperature: null, topP: null, reasoning: null, outputTokenLimit: null }, outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null, costMicroUsd: null }]
    });
    expect(governedGateProblems(mock, resolved)).toEqual([]);
    expect(governedGateProblems(mock, null)).toEqual(["the execution binding is unresolved, not resolved"]);
  });
});

describe("probe input", () => {
  it("judges a fixed, non-sensitive input with the evaluator's verdict kind", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub: ExecutionFetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "m", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "{\"choice\":\"good\",\"rationale\":\"r\"}" }] }));
    };
    const execute = verdictProbeExecutor({
      apiKey: "k", customBaseUrl: null, fetch: fetchStub,
      spec: { verdictKind: "categorical", scalarRange: null, categoricalChoiceScores: { good: 1, bad: 0 } }
    });
    await execute(savedOpus());
    const [body] = bodies;
    expect(JSON.stringify(body)).toContain("What is 2 + 3?");
    expect(JSON.stringify(body)).toContain(CAPABILITY_PROBE_INPUT.rubricMarkdown);
    expect(JSON.stringify((body!.output_config as { format: unknown }).format)).toContain("\"good\"");
  });
});
