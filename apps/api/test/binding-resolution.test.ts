import type { ExecutionFetch } from "@rubrist/audit/runtime";
import type { ExecutionBinding } from "@rubrist/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindingResolutionServices,
  governedGateRefusal,
  recheckGovernedBinding,
  resolutionNeeded,
  resolveGovernedBinding,
  type GovernedBinding
} from "../src/lib/binding-resolution.js";
import { CAPABILITY_PROBE_INPUT, TYPED_QUESTION_PROBE, governedGateProblems } from "../src/lib/evaluator-resolution.js";
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
  delete process.env.TYPESAFE_API_KEY;
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
    // The model accepts temperature, so it must be stated.
    const accepting = await resolveGovernedBinding(services(() => accepted()).services, governed(OPUS));
    expect(accepting.temperatureSupport).toBe("accepted");
    expect(governedGateRefusal(OPUS, accepting)).toMatchObject({
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

describe("a transient error on a setting probe never fails a binding", () => {
  it("leaves a setting unanswered, so the gate resolves again and suggests retrying", async () => {
    const { services: s } = services((body) => "temperature" in body ? new Response("{}", { status: 529 }) : accepted());
    const record = await resolveGovernedBinding(s, governed(OPUS));
    expect(record).toMatchObject({ status: "resolved", temperatureSupport: null });
    expect(resolutionNeeded(OPUS, record)).toBe(true);
    expect(governedGateRefusal(OPUS, record)?.suggestion).toContain("Try again");

    expect(resolutionNeeded(OPUS, await temperatureRejectingRecordFor(OPUS))).toBe(false);
    expect(resolutionNeeded(SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING))).toBe(false);
    expect(resolutionNeeded(SEEDED_BINDING, { ...(await resolvedRecordFor(SEEDED_BINDING)), status: "failed" })).toBe(false);
    expect(resolutionNeeded(SEEDED_BINDING, null)).toBe(true);
  });

  it("keeps a re-check unknown when a rejection is unattributed only because capabilities couldn't be read", async () => {
    const OPENROUTER: ExecutionBinding = {
      ...SEEDED_BINDING, provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6", modelVersion: "anthropic/claude-sonnet-4.6",
      sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
      verdictProtocol: "openai.forced-function/v1", routing: { requireParameters: true, allowFallbacks: false }
    };
    const chat = () => new Response(JSON.stringify({
      id: "c", model: "anthropic/claude-sonnet-4.6",
      choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_verdict", arguments: JSON.stringify(VERDICT) } }] }, finish_reason: "tool_calls" }]
    }));
    const opaque = () => new Response(JSON.stringify({ error: { code: 400, message: "Provider returned error" } }), { status: 400 });
    const { services: s } = services((body) => "temperature" in body || "reasoning" in body ? opaque() : chat());
    expect((await recheckGovernedBinding(s, governed(OPENROUTER))).outcome).toBe("unknown");
  });

  it("no longer holds once a setting has a definite answer, even when another probe errored", async () => {
    const { services: s } = services((body) => "thinking" in body && (body.thinking as { type: string }).type !== "disabled"
      ? new Response("{}", { status: 503 })
      : accepted());
    const unsetBoth: ExecutionBinding = { ...OPUS, reasoning: null };
    expect((await recheckGovernedBinding(s, governed(unsetBoth))).outcome).toBe("no_longer_holds");
  });
});

describe("a typed-question binding (ADR-0014 section 5)", () => {
  const JEV: ExecutionBinding = {
    provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
    sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
    verdictProtocol: "typed-question/v1", routing: null
  };
  const answer = (noul: number) => new Response(JSON.stringify({
    model: "jev-1.13.0", answers: { verdict: { type: "noul", noul } }, usage: { input_tokens: 40, output_tokens: 2 }
  }), { status: 200 });

  it("is probed with the project's TypeSafe key, else TYPESAFE_API_KEY", async () => {
    process.env.TYPESAFE_API_KEY = "typesafe-platform";
    expect(await bindingResolutionServices(async () => "typesafe-project").credential("p", "typesafe")).toEqual({ apiKey: "typesafe-project", source: "project" });
    expect(await bindingResolutionServices(async () => null).credential("p", "typesafe")).toEqual({ apiKey: "typesafe-platform", source: "environment" });
  });

  it("resolves on one confirming probe that asks the fixed question about the fixed trace, and takes no setting probes", async () => {
    const { sent, services: gate } = services(() => answer(0.97));
    const record = await resolveGovernedBinding(gate, governed(JEV));
    expect(record).toMatchObject({ status: "resolved", credentialSource: "project", temperatureSupport: null, reasoningSupport: null });
    expect(record.probes.map((probe) => [probe.stage, probe.purpose, probe.outcome])).toEqual([["resolution", "confirm", "accepted"]]);
    expect(sent).toEqual([{
      state: { input: CAPABILITY_PROBE_INPUT.trace.input, output: CAPABILITY_PROBE_INPUT.trace.output },
      questions: { verdict: TYPED_QUESTION_PROBE.question },
      model: "jev-1.13.0"
    }]);
    // With no sampling or reasoning to state, a resolved binding passes the governed gates.
    expect(governedGateProblems(JEV, record)).toEqual([]);
  });

  it("is re-checked with the confirming probe alone, and never probed without a credential", async () => {
    const { sent, services: gate } = services(() => answer(0.97));
    expect(await recheckGovernedBinding(gate, governed(JEV))).toMatchObject({ outcome: "holds", probes: [{ purpose: "confirm", outcome: "accepted" }] });
    expect(sent).toHaveLength(1);
    const keyless = bindingResolutionServices(async () => null, { fetch: async () => { throw new Error("must not send"); } });
    const record = await resolveGovernedBinding(keyless, governed(JEV));
    expect(record).toMatchObject({ status: "unresolved", credentialSource: null, probes: [] });
  });

  it("suggests another model, not another protocol, when TypeSafe's response breaks its only protocol", async () => {
    const broken = () => new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    const record = await resolveGovernedBinding(services(broken).services, governed(JEV));
    expect(record.status).toBe("failed");
    expect(governedGateRefusal(JEV, record)?.suggestion).toMatch(/only verdict protocol; try again later, or choose another model/);
  });

  it("fails when TypeSafe rejects the request, and stays unresolved on a transient error", async () => {
    const rejectedBody = () => new Response(JSON.stringify({ detail: "Unknown model: jev-0" }), { status: 400 });
    expect((await resolveGovernedBinding(services(rejectedBody).services, governed(JEV))).status).toBe("failed");
    const unavailable = () => new Response(JSON.stringify({ detail: "upstream failure" }), { status: 503 });
    expect((await resolveGovernedBinding(services(unavailable).services, governed(JEV))).status).toBe("unresolved");
  });
});
