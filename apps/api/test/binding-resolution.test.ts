import type { ExecutionFetch } from "@rubrist/audit/runtime";
import type { ExecutionBinding } from "@rubrist/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindingResolutionServices,
  governedGateRefusal,
  recheckGovernedBinding,
  resolveGovernedBinding,
  type GovernedBinding
} from "../src/lib/binding-resolution.js";
import { SEEDED_BINDING, resolvedRecordFor, temperatureRejectingRecordFor } from "./fixtures/execution-binding.js";

// Resolution and re-check as the governed gates use them (ADR-0014 section 4).

const OPUS: ExecutionBinding = { ...SEEDED_BINDING, modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", sampling: { temperature: null, topP: null } };
const governed = (executionBinding: ExecutionBinding): GovernedBinding => ({
  projectId: "project",
  executionBinding,
  customEndpointUrl: null,
  spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
});
const VERDICT = { label: "pass", score: 0.9, rationale: "The answer states 5." };
const accepted = () => new Response(JSON.stringify({
  id: "msg", model: "claude-observed", stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(VERDICT) }], usage: { input_tokens: 10, output_tokens: 5 }
}));
const rejected = (message: string) => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400 });

function services(respond: (body: Record<string, unknown>) => Response) {
  const sent: Array<Record<string, unknown>> = [];
  const fetch: ExecutionFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push(body);
    return respond(body);
  };
  return {
    sent,
    services: bindingResolutionServices(async () => "sk-project", {
      fetch,
      capabilityFetch: async () => new Response("{}", { status: 404 }),
      now: () => new Date("2026-09-26T00:00:00.000Z")
    })
  };
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("the credential a gate probes with", () => {
  it("is the project's key, then the platform's, and the mock needs none", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-platform";
    expect(await bindingResolutionServices(async () => "sk-project").credential("p", "anthropic")).toEqual({ apiKey: "sk-project", source: "project" });
    expect(await bindingResolutionServices(async () => null).credential("p", "anthropic")).toEqual({ apiKey: "sk-platform", source: "environment" });
    expect(await bindingResolutionServices(async () => null).credential("p", "openai")).toEqual({ apiKey: null, source: null });
    expect(await bindingResolutionServices(async () => null).credential("p", "mock")).toEqual({ apiKey: null, source: "built_in" });
  });
});

describe("resolution at a gate", () => {
  it("resolves the saved request and probes an unset temperature, recording the credential source", async () => {
    const { services: s, sent } = services((body) => "temperature" in body ? rejected("`temperature` is deprecated for this model.") : accepted());
    const record = await resolveGovernedBinding(s, governed(OPUS));
    expect(record).toMatchObject({ status: "resolved", credentialSource: "project", temperatureSupport: "parameter_rejected" });
    expect(sent).toHaveLength(2);
    expect(governedGateRefusal(OPUS, record)).toBeNull();
  });

  it("fails a binding the provider rejects, and leaves it unresolved on a transient error", async () => {
    expect((await resolveGovernedBinding(services(() => rejected("model: not found")).services, governed(SEEDED_BINDING))).status).toBe("failed");
    expect((await resolveGovernedBinding(services(() => new Response("{}", { status: 503 })).services, governed(SEEDED_BINDING))).status).toBe("unresolved");
  });
});

describe("the re-check before a governed run", () => {
  it("holds while the saved request is accepted and every unset setting is still rejected as a parameter", async () => {
    expect((await recheckGovernedBinding(services(() => accepted()).services, governed(SEEDED_BINDING))).outcome).toBe("holds");
    const opus = services((body) => "temperature" in body ? rejected("`temperature` is deprecated for this model.") : accepted());
    expect((await recheckGovernedBinding(opus.services, governed(OPUS))).outcome).toBe("holds");
  });

  it("no longer holds when the provider rejects the request or starts accepting an unset setting", async () => {
    expect((await recheckGovernedBinding(services(() => rejected("model: not found")).services, governed(SEEDED_BINDING))).outcome).toBe("no_longer_holds");
    expect((await recheckGovernedBinding(services(() => accepted()).services, governed(OPUS))).outcome).toBe("no_longer_holds");
  });

  it("is unknown on a transient error or when no call can be sent", async () => {
    expect((await recheckGovernedBinding(services(() => new Response("{}", { status: 503 })).services, governed(SEEDED_BINDING))).outcome).toBe("unknown");
    const noKey = bindingResolutionServices(async () => null, { capabilityFetch: async () => new Response("{}", { status: 404 }) });
    expect(await recheckGovernedBinding(noKey, governed(SEEDED_BINDING))).toEqual({ outcome: "unknown", probes: [] });
  });
});

describe("a gate refusal", () => {
  it("says what to change: leave a rejected parameter unset, choose another value, or retry when unreachable", async () => {
    const resolved = await resolvedRecordFor(SEEDED_BINDING);
    expect(governedGateRefusal(SEEDED_BINDING, resolved)).toBeNull();
    expect(governedGateRefusal(SEEDED_BINDING, null)).toMatchObject({ suggestion: expect.stringContaining("reachable") });
    expect(governedGateRefusal(OPUS, resolved)).toMatchObject({
      problems: [expect.stringContaining("temperature must be explicit")],
      suggestion: expect.stringContaining("states its temperature")
    });

    const parameter = await resolveGovernedBinding(services(() => rejected("`temperature` is deprecated for this model.")).services, governed(SEEDED_BINDING));
    expect(governedGateRefusal(SEEDED_BINDING, parameter)).toMatchObject({
      providerMessage: expect.stringContaining("deprecated"),
      suggestion: expect.stringContaining("leaves temperature unset")
    });
    const value = await resolveGovernedBinding(services(() => rejected("temperature: must be 1 for this model")).services, governed(SEEDED_BINDING));
    const refusal = governedGateRefusal(SEEDED_BINDING, value);
    expect(refusal?.suggestion).toMatch(/another temperature value|settings the model accepts/);
    expect(governedGateRefusal(OPUS, await temperatureRejectingRecordFor(OPUS))).toBeNull();
  });
});
