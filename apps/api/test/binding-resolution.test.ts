import type { ExecutionFetch } from "@rubrist/audit/runtime";
import type { ExecutionBinding } from "@rubrist/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_CHECK_BUDGET_MS,
  bindingResolutionServices,
  checkBindingCapabilities,
  governedGateRefusal,
  recheckGovernedBinding,
  resolutionNeeded,
  resolveGovernedBinding,
  resolveSavedBinding,
  type GovernedBinding
} from "../src/lib/binding-resolution.js";
import { savedVersionResolver } from "../src/evaluator-lifecycle/routes.js";
import type { EvaluatorLifecycleRepository } from "../src/evaluator-lifecycle/repository.js";
import { ExecutionBindingInputError } from "../src/lib/execution-binding.js";
import { CapabilityCheckInputSchema, REASONING_DEFAULTS_VERSION, documentedReasoningDefault, type ResolutionRecord } from "@rubrist/shared";
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
  it("never falls back to a platform key for a custom endpoint", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-platform";
    try {
      await expect(bindingResolutionServices(async () => null).credential("project", "custom")).resolves.toEqual({ apiKey: null, source: null });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

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

describe("the capability check before save (ADR-0014 section 4)", () => {
  const base = { provider: "anthropic" as const, endpoint: { kind: "managed" as const }, modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", outputTokenLimit: 1_200, routing: null };

  it("finds the protocol, then probes temperature with the documented default reasoning, then both reasoning settings", async () => {
    const { sent, services: check } = services((body) => "temperature" in body ? rejected("`temperature` is deprecated for this model.") : accepted());
    const report = await checkBindingCapabilities(check, "project", base);
    expect(report).toMatchObject({
      credentialSource: "project",
      protocol: "anthropic.structured-output/v1",
      temperatureSupport: "parameter_rejected",
      reasoningSupport: "accepted",
      probedReasoning: documentedReasoningDefault("anthropic", "claude-opus-5-5")!.reasoning,
      documentedDefault: documentedReasoningDefault("anthropic", "claude-opus-5-5")!.reasoning,
      published: null,
      reasoningDefaultsVersion: REASONING_DEFAULTS_VERSION,
      interrupted: false,
      checkedAt: "2026-09-26T00:00:00.000Z"
    });
    expect(report.probes.map((probe) => [probe.stage, probe.purpose, probe.outcome])).toEqual([
      ["capability_check", "protocol", "accepted"],
      ["capability_check", "temperature", "rejected"],
      ["capability_check", "reasoning", "accepted"],
      ["capability_check", "reasoning", "accepted"]
    ]);
    expect(sent).toHaveLength(4);
  });

  it("checks OpenAI at the platform's base-URL override, as saving records it", async () => {
    const urls: string[] = [];
    const check = bindingResolutionServices(async () => "sk-openai", {
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ model: "gpt-x", choices: [{ message: { content: JSON.stringify(VERDICT) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      },
      now: () => new Date("2026-09-26T00:00:00.000Z")
    });
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
    try {
      const report = await checkBindingCapabilities(check, "project", { ...base, provider: "openai", modelId: "gpt-x", modelVersion: "gpt-x", outputTokenLimit: null });
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((url) => url.startsWith("https://gateway.example/v1/"))).toBe(true);
      expect(report.protocol).toBe("openai.structured-output/v1");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
    }
  });

  it("never sends a key to a URL only the custom provider may name", async () => {
    const urls: string[] = [];
    const check = bindingResolutionServices(async () => "sk-openai", {
      fetch: async (url) => {
        urls.push(url);
        return new Response("{}");
      }
    });
    const elsewhere = { ...base, provider: "openai" as const, endpoint: { kind: "custom" as const, baseUrl: "https://attacker.example/v1" }, modelId: "gpt-x", modelVersion: "gpt-x", outputTokenLimit: null };
    expect(CapabilityCheckInputSchema.safeParse(elsewhere).success).toBe(false);
    await expect(checkBindingCapabilities(check, "project", elsewhere)).rejects.toBeInstanceOf(ExecutionBindingInputError);
    expect(urls).toEqual([]);
  });

  it("refuses every input no saved binding could have", () => {
    const refused = [
      { ...base, provider: "custom" as const },
      { ...base, routing: { requireParameters: true, allowFallbacks: false } as const },
      { ...base, outputTokenLimit: null },
      { ...base, provider: "typesafe" as const, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0" }
    ];
    for (const input of refused) expect(CapabilityCheckInputSchema.safeParse(input).success).toBe(false);
    expect(CapabilityCheckInputSchema.safeParse(base).success).toBe(true);
  });

  it("checks a custom provider at the URL its author names", async () => {
    const urls: string[] = [];
    const check = bindingResolutionServices(async () => "sk-custom", {
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ model: "local", choices: [{ message: { content: JSON.stringify(VERDICT) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }
    });
    const report = await checkBindingCapabilities(check, "project", {
      ...base, provider: "custom", endpoint: { kind: "custom", baseUrl: "https://judge.example/v1" }, modelId: "local", modelVersion: "local", outputTokenLimit: null
    });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith("https://judge.example/v1/"))).toBe(true);
    expect(report.credentialSource).toBe("project");
  });

  it("reports what the provider publishes about the model", async () => {
    const check = bindingResolutionServices(async () => "sk-project", {
      fetch: async () => accepted(),
      capabilityFetch: async () => new Response(JSON.stringify({
        id: "claude-opus-5-5",
        capabilities: {
          effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: false } },
          structured_outputs: { supported: true },
          thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }
        }
      }))
    });
    const report = await checkBindingCapabilities(check, "project", base);
    expect(report.published).toEqual({ temperature: null, topP: null, reasoning: true, thinkingTypes: ["adaptive"], effortLevels: ["low", "medium"] });
  });

  it("never reports the key, even when the provider echoes it", async () => {
    const { services: check } = services(() => rejected("Invalid key sk-project for this model."));
    const report = await checkBindingCapabilities(check, "project", base);
    expect(JSON.stringify(report)).not.toContain("sk-project");
    expect(JSON.stringify(report)).toContain("[redacted]");
  });

  it("ends a check out of time with what it learned, and says it was interrupted", async () => {
    let tick = 0;
    const sent: unknown[] = [];
    const check = bindingResolutionServices(async () => "sk-project", {
      fetch: async (_url, init) => {
        sent.push(init.body);
        return accepted();
      },
      capabilityFetch: async () => new Response("{}", { status: 404 }),
      // Each reading of the clock is 25 seconds later, so the third probe can't start.
      now: () => new Date(Date.UTC(2026, 8, 26) + (tick++) * (CAPABILITY_CHECK_BUDGET_MS * 5 / 12))
    });
    const report = await checkBindingCapabilities(check, "project", base);
    expect(sent).toHaveLength(2);
    expect(report.interrupted).toBe(true);
    expect(report.probes.slice(0, 2).map((probe) => probe.outcome)).toEqual(["accepted", "accepted"]);
  });

  it("checks a TypeSafe model with its one protocol and no setting probes", async () => {
    const { sent, services: check } = services(() => new Response(JSON.stringify({
      model: "jev-1.13.0", answers: { verdict: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 4, output_tokens: 1 }
    })));
    const report = await checkBindingCapabilities(check, "project", { ...base, provider: "typesafe", modelId: "jev-1.13.0", modelVersion: "jev-1.13.0", outputTokenLimit: null });
    expect(report).toMatchObject({ protocol: "typed-question/v1", temperatureSupport: null, reasoningSupport: null, probedReasoning: null, documentedDefault: null });
    expect(sent).toHaveLength(1);
  });
});

describe("resolution after save (ADR-0014 section 4)", () => {
  it("confirms the saved request and probes an unset temperature, never reasoning", async () => {
    const { sent, services: save } = services(() => accepted());
    const record = await resolveSavedBinding(save, governed({ ...OPUS, reasoning: null }));
    expect(record.status).toBe("resolved");
    expect(record.probes.map((probe) => probe.purpose)).toEqual(["confirm", "temperature"]);
    expect(sent).toHaveLength(2);
  });

  it("is recorded against the save, only where a binding needs it and a call could be made", async () => {
    const recorded: unknown[] = [];
    const repository = (binding: ExecutionBinding, record: Awaited<ReturnType<typeof resolveSavedBinding>> | null = null) => ({
      getGovernedBinding: async () => ({ binding: governed(binding), record }),
      recordResolution: async (attempt: unknown, stored: unknown) => {
        recorded.push(attempt);
        return stored;
      }
    }) as unknown as EvaluatorLifecycleRepository;
    const { services: save } = services(() => accepted());
    await savedVersionResolver(repository(SEEDED_BINDING), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([expect.objectContaining({
      skillVersionId: "version", kind: "resolution", triggerKind: "version_save", triggerRef: "version-save:version", outcome: "resolved"
    })]);
    recorded.length = 0;
    await savedVersionResolver(repository({ ...SEEDED_BINDING, provider: "mock", verdictProtocol: "mock/v1", reasoning: null, outputTokenLimit: null, sampling: { temperature: null, topP: null } }), save)({ projectId: "project", skillVersionId: "version" });
    await savedVersionResolver(repository({ ...SEEDED_BINDING, modelId: "claude-latest" }), save)({ projectId: "project", skillVersionId: "version" });
    await savedVersionResolver(repository(SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING)), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([]);
  });

  it("resolves once: a stored record, even one lacking an answer only a gate needs, isn't probed again", async () => {
    let stored: ResolutionRecord | null = null;
    const repository = {
      getGovernedBinding: async () => ({ binding: governed({ ...OPUS, reasoning: null }), record: stored }),
      recordResolution: async (_attempt: unknown, record: ResolutionRecord | null) => {
        stored = record;
        return record;
      }
    } as unknown as EvaluatorLifecycleRepository;
    const { sent, services: save } = services(() => accepted());
    const resolve = savedVersionResolver(repository, save);
    await resolve({ projectId: "project", skillVersionId: "version" });
    expect(stored).toMatchObject({ status: "resolved", reasoningSupport: null });
    expect(resolutionNeeded({ ...OPUS, reasoning: null }, stored)).toBe(true);
    const calls = sent.length;
    await resolve({ projectId: "project", skillVersionId: "version" });
    expect(sent).toHaveLength(calls);
  });

  it("retries an unresolved record, and leaves a failed one for a new version", async () => {
    const recorded: unknown[] = [];
    const repository = (record: ResolutionRecord) => ({
      getGovernedBinding: async () => ({ binding: governed(SEEDED_BINDING), record }),
      recordResolution: async (attempt: unknown, stored: unknown) => {
        recorded.push(attempt);
        return stored;
      }
    }) as unknown as EvaluatorLifecycleRepository;
    const resolved = await resolvedRecordFor(SEEDED_BINDING);
    const { services: save } = services(() => accepted());
    await savedVersionResolver(repository({ ...resolved, status: "failed" }), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([]);
    await savedVersionResolver(repository({ ...resolved, status: "unresolved" }), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([expect.objectContaining({ triggerKind: "version_save", outcome: "resolved" })]);
  });
});

