import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityCheckReport, CapabilityProbe, ReasoningSettings } from "@rubrist/shared";
import { bindingPickerGuidance, reasoningOffered, sameReasoning } from "../src/lib/binding-picker.js";

vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never) }));
vi.mock("../src/lib/api.js", () => ({ checkModelCapabilities: vi.fn() }));
vi.mock("@/components/rubrist", () => ({ Eyebrow: ({ children }: { children?: unknown }) => createElement("span", null, children as never) }));

const { BindingSettings } = await import("../src/screens/skill-edit/binding-settings.js");

// The model picker (ADR-0014 section 4, founder decision 1): it hides a field
// the model rejects outright, doesn't offer a value it rejects, and marks an
// untested setting "confirmed at resolution".

const ADAPTIVE: ReasoningSettings = { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" };
// The picker offers exact settings, so the rejected one keeps the effort the author has.
const DISABLED: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: "medium" };

function probe(overrides: Partial<CapabilityProbe>): CapabilityProbe {
  return {
    stage: "capability_check", purpose: "protocol", verdictProtocol: "anthropic.structured-output/v1",
    sent: { temperature: null, topP: null, reasoning: null, outputTokenLimit: 1_200 },
    outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null,
    usage: null, costMicroUsd: null,
    ...overrides
  };
}

function report(overrides: Partial<CapabilityCheckReport> = {}): CapabilityCheckReport {
  return {
    credentialSource: "project", protocol: "anthropic.structured-output/v1",
    probes: [
      probe({}),
      probe({ purpose: "temperature", sent: { temperature: 1, topP: null, reasoning: ADAPTIVE, outputTokenLimit: 1_200 }, outcome: "rejected", rejection: "parameter", rejectedParameter: "temperature", failureKind: "provider_rejected_request" }),
      probe({ purpose: "reasoning", sent: { temperature: null, topP: null, reasoning: ADAPTIVE, outputTokenLimit: 1_200 } }),
      probe({ purpose: "reasoning", sent: { temperature: null, topP: null, reasoning: DISABLED, outputTokenLimit: 1_200 }, outcome: "rejected", rejection: "value", rejectedParameter: "reasoning", failureKind: "provider_rejected_request" })
    ],
    temperatureSupport: "parameter_rejected", reasoningSupport: "accepted", probedReasoning: ADAPTIVE,
    documentedDefault: ADAPTIVE, reasoningDefaultsVersion: "2026-09-26", interrupted: false, published: null, checkedAt: "2026-09-26T00:00:00.000Z",
    ...overrides
  };
}

describe("model picker guidance", () => {
  it("offers every field, with no guidance, before a check has run", () => {
    const guidance = bindingPickerGuidance("anthropic", null, ADAPTIVE);
    expect(guidance).toMatchObject({
      suggestedProtocol: null,
      temperature: { shown: true, guidance: null },
      reasoning: { shown: true, guidance: null },
      rejectedReasoning: []
    });
    expect(guidance.protocols.map((option) => option.guidance)).toEqual([null, null, null]);
  });

  it("hides temperature the model rejects with the reasoning it was probed with, and shows it again for other reasoning", () => {
    expect(bindingPickerGuidance("anthropic", report(), ADAPTIVE).temperature).toEqual({ shown: false, guidance: "rejected" });
    expect(bindingPickerGuidance("anthropic", report(), { ...ADAPTIVE, effort: "high" }).temperature)
      .toEqual({ shown: true, guidance: "confirmed at resolution" });
    expect(bindingPickerGuidance("anthropic", report({ temperatureSupport: "accepted" }), ADAPTIVE).temperature)
      .toEqual({ shown: true, guidance: "accepted" });
  });

  it("marks the protocols the check tried, and pre-selects the one it accepted", () => {
    const guidance = bindingPickerGuidance("anthropic", report(), ADAPTIVE);
    expect(guidance.suggestedProtocol).toBe("anthropic.structured-output/v1");
    expect(guidance.protocols).toEqual([
      { protocol: "anthropic.structured-output/v1", guidance: "accepted" },
      { protocol: "anthropic.forced-tool/v1", guidance: "confirmed at resolution" },
      { protocol: "prompted-json/v1", guidance: "confirmed at resolution" }
    ]);
  });

  it("doesn't offer a reasoning value the model rejected, and marks an untested one", () => {
    const guidance = bindingPickerGuidance("anthropic", report(), ADAPTIVE);
    expect(guidance.reasoning).toEqual({ shown: true, guidance: "accepted" });
    expect(reasoningOffered(guidance, DISABLED)).toBe(false);
    expect(reasoningOffered(guidance, ADAPTIVE)).toBe(true);
    expect(bindingPickerGuidance("anthropic", report(), { ...ADAPTIVE, effort: "max" }).reasoning.guidance).toBe("confirmed at resolution");
  });

  it("hides reasoning the model rejects as a parameter, and every setting a provider doesn't take", () => {
    expect(bindingPickerGuidance("anthropic", report({ reasoningSupport: "parameter_rejected" }), null).reasoning).toEqual({ shown: false, guidance: null });
    expect(bindingPickerGuidance("mock", null, null)).toMatchObject({ temperature: { shown: false }, reasoning: { shown: false } });
    expect(bindingPickerGuidance("typesafe", null, null)).toMatchObject({
      temperature: { shown: false }, reasoning: { shown: false }, protocols: [{ protocol: "typed-question/v1", guidance: null }]
    });
  });

  it("compares reasoning settings regardless of key order", () => {
    expect(sameReasoning(ADAPTIVE, { effort: "medium", thinking: { type: "adaptive" }, family: "anthropic" })).toBe(true);
    expect(sameReasoning(ADAPTIVE, null)).toBe(false);
  });
});

describe("the binding settings fields", () => {
  const picker = (checkReport: CapabilityCheckReport | null, reasoning: ReasoningSettings | null) => ({
    settings: { reasoning, verdictProtocol: "anthropic.structured-output/v1" as const, outputTokenLimit: "1200" },
    setSettings: vi.fn(), load: vi.fn(), report: checkReport,
    guidance: bindingPickerGuidance("anthropic", checkReport, reasoning),
    checking: false, checkError: null, runCheck: vi.fn(), savedFields: vi.fn()
  });
  const render = (checkReport: CapabilityCheckReport | null, reasoning: ReasoningSettings | null) => renderToStaticMarkup(createElement(BindingSettings, {
    provider: "anthropic", temperature: "0", setTemperature: vi.fn(), temperatureValid: true,
    picker: picker(checkReport, reasoning) as never, canCheck: true
  }));

  it("hides temperature the model rejects and says why, and marks a rejected reasoning option", () => {
    const html = render(report(), ADAPTIVE);
    expect(html).toContain("The model rejects temperature with this reasoning, so none is sent.");
    expect(html).not.toContain('type="number" min="0" max="2"');
    expect(html).toContain("Thinking disabled (rejected by the model)");
    expect(html).toContain("anthropic.structured-output/v1 (accepted)");
    expect(html).toContain("Checked with 4 probes: anthropic.structured-output/v1 accepted.");
  });

  it("says when a check ended early", () => {
    const html = render(report({ protocol: null, interrupted: true, probes: [probe({ outcome: "error", failureKind: "provider_timeout" })] }), ADAPTIVE);
    expect(html).toContain("Checked with 1 probe: no protocol confirmed. The check ended early; what it didn&#x27;t reach is confirmed at resolution after save.");
  });

  it("shows every field before a check, offering to run one", () => {
    const html = render(null, ADAPTIVE);
    expect(html).toContain("Check model");
    expect(html).toContain("Probes the model (up to 6 calls)");
    expect(html).toContain('placeholder="not sent"');
    expect(html).toContain("Anthropic requires a limit.");
  });
});
