// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCheckInput, CapabilityCheckReport, ExecutionBinding } from "@rubrist/shared";

// The model picker's state (Batch 8F): picks follow the model, a check's
// result never undoes an edit the author made while it ran, and the check
// runs by itself only after the author picks a model.

const pending: Array<{ input: CapabilityCheckInput; resolve: (report: CapabilityCheckReport) => void }> = [];
vi.mock("../src/components/ui/button.js", () => ({ Button: () => null }));
vi.mock("../src/components/rubrist/index.js", () => ({ Eyebrow: () => null }));
vi.mock("../src/lib/api.js", () => ({
  checkModelCapabilities: vi.fn((input: CapabilityCheckInput) => new Promise<CapabilityCheckReport>((resolve) => { pending.push({ input, resolve }); }))
}));

const { useBindingPicker } = await import("../src/screens/skill-edit/binding-settings.js");

type Model = { provider: "anthropic"; modelId: string; modelVersion: string; baseUrl: string };
const SONNET: Model = { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", baseUrl: "" };
const OPUS: Model = { provider: "anthropic", modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", baseUrl: "" };

function report(protocol: CapabilityCheckReport["protocol"], rejectedProtocol: CapabilityCheckReport["protocol"] = null): CapabilityCheckReport {
  const probe = (verdictProtocol: NonNullable<CapabilityCheckReport["protocol"]>, accepted: boolean) => ({
    stage: "capability_check" as const, purpose: "protocol" as const, verdictProtocol,
    sent: { temperature: null, topP: null, reasoning: null, outputTokenLimit: 1_200 },
    outcome: accepted ? "accepted" as const : "rejected" as const, rejection: accepted ? null : "mechanism" as const,
    rejectedParameter: null, failureKind: accepted ? null : "provider_rejected_request" as const, providerMessage: null, usage: null, costMicroUsd: null
  });
  return {
    credentialSource: "project", protocol,
    probes: [...(rejectedProtocol ? [probe(rejectedProtocol, false)] : []), ...(protocol ? [probe(protocol, true)] : [])],
    temperatureSupport: null, reasoningSupport: null, probedReasoning: null, documentedDefault: null,
    reasoningDefaultsVersion: "2026-09-26", interrupted: false, published: null, checkedAt: "2026-09-27T00:00:00.000Z"
  };
}

let picker: ReturnType<typeof useBindingPicker>;
let setModel: (model: Model) => void;
let container: HTMLDivElement;
let root: Root;

function Harness({ initial, base }: { initial: Model; base: ExecutionBinding | null }) {
  const [model, set] = useState(initial);
  setModel = set;
  picker = useBindingPicker(model, base, { canCheck: true, temperature: "0" });
  return null;
}

async function mount(initial: Model, base: ExecutionBinding | null = null) {
  await act(async () => { root.render(createElement(Harness, { initial, base })); });
}

describe("the model picker's state", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    pending.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("keeps an edit the author made while the check ran", async () => {
    await mount(SONNET);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    expect(picker.checking).toBe(true);
    await act(async () => picker.setSettings({ outputTokenLimit: "4000" }));
    await act(async () => { pending[0]!.resolve(report("anthropic.structured-output/v1")); await check; });
    expect(picker.settings.outputTokenLimit).toBe("4000");
    expect(picker.checking).toBe(false);
    expect(picker.report?.protocol).toBe("anthropic.structured-output/v1");
  });

  it("keeps each model's picks, and applies a check to the model it checked", async () => {
    await mount(SONNET);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => setModel(OPUS));
    expect(picker.checking).toBe(false);
    await act(async () => picker.setSettings({ outputTokenLimit: "3000" }));
    await act(async () => { pending[0]!.resolve(report("anthropic.forced-tool/v1", "anthropic.structured-output/v1")); await check; });
    expect(picker.settings.outputTokenLimit).toBe("3000");
    expect(picker.report).toBeNull();
    await act(async () => setModel(SONNET));
    // Sonnet's default protocol was rejected, so the accepted one is pre-selected.
    expect(picker.settings.verdictProtocol).toBe("anthropic.forced-tool/v1");
    expect(picker.report?.protocol).toBe("anthropic.forced-tool/v1");
    // A model version or endpoint fix keeps the model's picks.
    await act(async () => setModel({ ...SONNET, modelVersion: "claude-sonnet-4-6-20260101" }));
    expect(picker.settings.verdictProtocol).toBe("anthropic.forced-tool/v1");
  });

  it("pre-selects the accepted protocol only where the author hasn't chosen one or theirs was rejected", async () => {
    await mount(SONNET);
    await act(async () => picker.setSettings({ verdictProtocol: "prompted-json/v1" }));
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[0]!.resolve(report("anthropic.structured-output/v1")); await check; });
    expect(picker.settings.verdictProtocol).toBe("prompted-json/v1");

    // A version's saved protocol is its author's choice too.
    await act(async () => picker.load({
      executionBinding: { provider: "anthropic", endpoint: { kind: "managed" }, modelId: OPUS.modelId, modelVersion: OPUS.modelVersion, sampling: { temperature: 0, topP: null }, reasoning: null, outputTokenLimit: 1_200, verdictProtocol: "anthropic.forced-tool/v1", routing: null },
      customEndpointUrl: null
    }));
    await act(async () => setModel(OPUS));
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[1]!.resolve(report("anthropic.structured-output/v1")); await check; });
    expect(picker.settings.verdictProtocol).toBe("anthropic.forced-tool/v1");
  });

  it("doesn't replace reasoning the author chose not to send", async () => {
    await mount(OPUS);
    await act(async () => picker.setSettings({ reasoning: null }));
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[0]!.resolve({ ...report("anthropic.structured-output/v1"), documentedDefault: { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" } }); await check; });
    expect(picker.settings.reasoning).toBeNull();
  });

  it("checks a model by itself only after the author picks it", async () => {
    vi.useFakeTimers();
    await mount(SONNET);
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending).toHaveLength(0);
    await act(async () => { picker.modelPicked(); setModel(OPUS); });
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending.map((call) => call.input.modelId)).toEqual([OPUS.modelId]);
    await act(async () => { pending[0]!.resolve(report("anthropic.structured-output/v1")); });
    // Returning to a model already checked, or loading a version, doesn't check again.
    await act(async () => { picker.modelPicked(); setModel(SONNET); });
    await act(async () => { picker.modelPicked(); setModel(OPUS); });
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending).toHaveLength(1);
  });

  it("saves no setting the model rejects outright", async () => {
    await mount(OPUS);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    const adaptive = picker.settings.reasoning;
    await act(async () => {
      pending[0]!.resolve({
        ...report("anthropic.structured-output/v1"),
        temperatureSupport: "parameter_rejected",
        probedReasoning: adaptive,
        probes: [...report("anthropic.structured-output/v1").probes, {
          stage: "capability_check", purpose: "temperature", verdictProtocol: "anthropic.structured-output/v1",
          sent: { temperature: 1, topP: null, reasoning: adaptive, outputTokenLimit: 1_200 }, outcome: "rejected", rejection: "parameter",
          rejectedParameter: "temperature", failureKind: "provider_rejected_request", providerMessage: null, usage: null, costMicroUsd: null
        }]
      });
      await check;
    });
    expect(picker.savedFields("0")).toMatchObject({ temperature: "", reasoning: adaptive });
  });
});
