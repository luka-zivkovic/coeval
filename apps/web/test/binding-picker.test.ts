import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityCheckReport, CapabilityProbe, ReasoningSettings } from "@rubrist/shared";
import {
  bindingPickerGuidance,
  pickerBlockingProblems,
  reasoningAccepted,
  reasoningOffered,
  sameReasoning
} from "../src/lib/binding-picker.js";

vi.mock("../src/components/ui/button.js", () => ({ Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never) }));
vi.mock("../src/lib/api.js", () => ({ checkModelCapabilities: vi.fn() }));
vi.mock("../src/components/rubrist/index.js", () => ({ Eyebrow: ({ children }: { children?: unknown }) => createElement("span", null, children as never) }));

const { BindingSettings } = await import("../src/screens/skill-edit/binding-settings.js");

// The model picker (ADR-0014 section 4, founder decision 1): it hides a field
// the model rejects outright, doesn't offer a value it rejects, and marks an
// untested setting "confirmed at resolution".
//
// The probes below have the shapes the server's capability check sends
// (apps/api/src/lib/evaluator-resolution.ts): the temperature probe sends 1
// with the documented default reasoning; the reasoning probes send the
// default (or a middle value) and the family's no-reasoning setting, which
// for Anthropic is thinking disabled with no effort.

const ADAPTIVE: ReasoningSettings = { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" };
const NO_REASONING: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: null };

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
      probe({ purpose: "reasoning", sent: { temperature: null, topP: null, reasoning: NO_REASONING, outputTokenLimit: 1_200 }, outcome: "rejected", rejection: "value", rejectedParameter: "reasoning", failureKind: "provider_rejected_request" })
    ],
    temperatureSupport: "parameter_rejected", reasoningSupport: "accepted", probedReasoning: ADAPTIVE,
    documentedDefault: ADAPTIVE, reasoningDefaultsVersion: "2026-09-26", interrupted: false, published: null, checkedAt: "2026-09-26T00:00:00.000Z",
    ...overrides
  };
}

/** A check where temperature 1 was accepted with the probed reasoning. */
const acceptingTemperature = (reasoning: ReasoningSettings | null) => report({
  temperatureSupport: "accepted",
  probedReasoning: reasoning,
  probes: [probe({}), probe({ purpose: "temperature", sent: { temperature: 1, topP: null, reasoning, outputTokenLimit: 1_200 } })]
});

describe("model picker guidance", () => {
  it("offers every field, with no guidance, before a check has run", () => {
    const guidance = bindingPickerGuidance("anthropic", null, { reasoning: ADAPTIVE, temperature: "0" });
    expect(guidance).toMatchObject({
      temperature: { shown: true, guidance: null, acceptedValue: null },
      reasoning: { shown: true, guidance: null },
      rejectedReasoning: []
    });
    expect(guidance.protocols.map((option) => option.guidance)).toEqual([null, null, null]);
  });

  it("hides temperature the model rejects with the reasoning it was probed with, and shows it again for other reasoning", () => {
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "0" }).temperature)
      .toEqual({ shown: false, guidance: "rejected", acceptedValue: null });
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: { ...ADAPTIVE, effort: "high" }, temperature: "0" }).temperature)
      .toEqual({ shown: true, guidance: "confirmed at resolution", acceptedValue: null });
  });

  it("calls a temperature accepted only when it is the value the check probed", () => {
    // The probe sends 1; the author's 0 was never tried, and some models accept only 1.
    expect(bindingPickerGuidance("openai", acceptingTemperature(null), { reasoning: null, temperature: "0" }).temperature)
      .toEqual({ shown: true, guidance: "confirmed at resolution", acceptedValue: 1 });
    expect(bindingPickerGuidance("openai", acceptingTemperature(null), { reasoning: null, temperature: "1" }).temperature)
      .toEqual({ shown: true, guidance: "accepted", acceptedValue: 1 });
    // A value rejection holds for the probed value only.
    const valueRejected = report({
      temperatureSupport: "value_rejected", probedReasoning: null,
      probes: [probe({}), probe({ purpose: "temperature", sent: { temperature: 1, topP: null, reasoning: null, outputTokenLimit: 1_200 }, outcome: "rejected", rejection: "value", rejectedParameter: "temperature", failureKind: "provider_rejected_request" })]
    });
    expect(bindingPickerGuidance("openai", valueRejected, { reasoning: null, temperature: "1" }).temperature.guidance).toBe("rejected");
    expect(bindingPickerGuidance("openai", valueRejected, { reasoning: null, temperature: "0" }).temperature.guidance).toBe("confirmed at resolution");
    // A blank temperature isn't sent, so there is nothing to confirm.
    expect(bindingPickerGuidance("openai", acceptingTemperature(null), { reasoning: null, temperature: "" }).temperature.guidance).toBeNull();
  });

  it("marks the protocols the check tried, and those the provider's published data rules out", () => {
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "" }).protocols).toEqual([
      { protocol: "anthropic.structured-output/v1", guidance: "accepted" },
      { protocol: "anthropic.forced-tool/v1", guidance: "confirmed at resolution" },
      { protocol: "prompted-json/v1", guidance: "confirmed at resolution" }
    ]);
    const noStructured = report({
      protocol: "anthropic.forced-tool/v1",
      probes: [probe({ verdictProtocol: "anthropic.forced-tool/v1" })],
      published: { structuredOutput: false, toolUse: null, temperature: null, topP: null, reasoning: true, thinkingTypes: null, effortLevels: null }
    });
    expect(bindingPickerGuidance("anthropic", noStructured, { reasoning: ADAPTIVE, temperature: "" }).protocols.map((option) => option.guidance))
      .toEqual(["rejected", "accepted", "confirmed at resolution"]);
  });

  it("doesn't offer a reasoning mode the model rejected, whatever effort the option carries", () => {
    const guidance = bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "" });
    expect(guidance.reasoning).toEqual({ shown: true, guidance: "accepted" });
    // The no-reasoning probe sent thinking disabled with no effort; every disabled option adds to it.
    for (const effort of [null, "low", "medium", "max"] as const) {
      expect(reasoningOffered(guidance, { family: "anthropic", thinking: { type: "disabled" }, effort }), String(effort)).toBe(false);
    }
    expect(reasoningOffered(guidance, ADAPTIVE)).toBe(true);
    expect(reasoningAccepted(guidance, ADAPTIVE)).toBe(true);
    expect(reasoningAccepted(guidance, { ...ADAPTIVE, effort: "max" })).toBe(false);
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: "medium" }, temperature: "" }).reasoning.guidance)
      .toBe("rejected");
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: { ...ADAPTIVE, effort: "max" }, temperature: "" }).reasoning.guidance).toBe("confirmed at resolution");
  });

  it("hides reasoning the model rejects as a parameter, and every setting a provider doesn't take", () => {
    expect(bindingPickerGuidance("anthropic", report({ reasoningSupport: "parameter_rejected" }), { reasoning: null, temperature: "" }).reasoning).toEqual({ shown: false, guidance: null });
    expect(bindingPickerGuidance("mock", null, { reasoning: null, temperature: "" })).toMatchObject({ temperature: { shown: false }, reasoning: { shown: false } });
    expect(bindingPickerGuidance("typesafe", null, { reasoning: null, temperature: "" })).toMatchObject({
      temperature: { shown: false }, reasoning: { shown: false }, protocols: [{ protocol: "typed-question/v1", guidance: null }]
    });
  });

  it("blocks saving a protocol, reasoning, or temperature the check saw rejected", () => {
    const disabled: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: "high" };
    expect(pickerBlockingProblems(bindingPickerGuidance("anthropic", report(), { reasoning: disabled, temperature: "" }), { verdictProtocol: "anthropic.structured-output/v1" }))
      .toEqual(["The model rejected this reasoning setting in the check; choose another."]);
    const rejectedProtocol = report({ protocol: "anthropic.forced-tool/v1", probes: [probe({ outcome: "rejected", rejection: "mechanism", failureKind: "provider_rejected_request" }), probe({ verdictProtocol: "anthropic.forced-tool/v1" })] });
    expect(pickerBlockingProblems(bindingPickerGuidance("anthropic", rejectedProtocol, { reasoning: ADAPTIVE, temperature: "" }), { verdictProtocol: "anthropic.structured-output/v1" }))
      .toEqual(["The model rejected anthropic.structured-output/v1 in the check; choose another verdict protocol."]);
    expect(pickerBlockingProblems(bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "0" }), { verdictProtocol: "anthropic.structured-output/v1" })).toEqual([]);
  });

  it("compares reasoning settings regardless of key order", () => {
    expect(sameReasoning(ADAPTIVE, { effort: "medium", thinking: { type: "adaptive" }, family: "anthropic" })).toBe(true);
    expect(sameReasoning(ADAPTIVE, null)).toBe(false);
  });
});

describe("the binding settings fields", () => {
  const picker = (checkReport: CapabilityCheckReport | null, reasoning: ReasoningSettings | null, temperature = "0") => {
    const guidance = bindingPickerGuidance("anthropic", checkReport, { reasoning, temperature });
    return {
      settings: { reasoning, verdictProtocol: "anthropic.structured-output/v1" as const, outputTokenLimit: "1200" },
      setSettings: vi.fn(), load: vi.fn(), modelPicked: vi.fn(), report: checkReport, guidance,
      checking: false, checkError: null, runCheck: vi.fn(), savedFields: vi.fn(),
      blockingProblems: pickerBlockingProblems(guidance, { verdictProtocol: "anthropic.structured-output/v1" })
    };
  };
  const render = (checkReport: CapabilityCheckReport | null, reasoning: ReasoningSettings | null, temperature = "0") => renderToStaticMarkup(createElement(BindingSettings, {
    provider: "anthropic", temperature, setTemperature: vi.fn(), temperatureValid: true,
    picker: picker(checkReport, reasoning, temperature) as never, canCheck: true
  }));

  it("hides temperature the model rejects and says why, and marks rejected and accepted reasoning options", () => {
    const html = render(report(), ADAPTIVE);
    expect(html).toContain("The model rejects temperature with this reasoning, so none is sent.");
    expect(html).not.toContain('type="number" min="0" max="2"');
    expect(html).toContain("Thinking disabled (rejected by the model)");
    expect(html).toContain("Adaptive thinking (accepted)");
    expect(html).toContain("anthropic.structured-output/v1 (accepted)");
    expect(html).toContain("Checked with 4 probes: anthropic.structured-output/v1 accepted.");
    expect(html).toContain("Check again");
  });

  it("says which temperature the check accepted when the author's differs", () => {
    const html = renderToStaticMarkup(createElement(BindingSettings, {
      provider: "openai", temperature: "0", setTemperature: vi.fn(), temperatureValid: true, canCheck: true,
      picker: {
        ...picker(null, null),
        report: acceptingTemperature(null),
        guidance: bindingPickerGuidance("openai", acceptingTemperature(null), { reasoning: null, temperature: "0" }),
        settings: { reasoning: null, verdictProtocol: "openai.structured-output/v1", outputTokenLimit: "" },
        blockingProblems: []
      } as never
    }));
    expect(html).toContain("The check accepted temperature 1; 0 is confirmed at resolution after save.");
  });

  it("keeps a selected value the provider doesn't publish, marked, rather than showing another", () => {
    const published = report({ published: { structuredOutput: true, toolUse: null, temperature: null, topP: null, reasoning: true, thinkingTypes: ["adaptive"], effortLevels: ["low", "medium"] } });
    const enabledMax: ReasoningSettings = { family: "anthropic", thinking: { type: "enabled", budgetTokens: 2_048 }, effort: "max" };
    const html = render(published, enabledMax);
    expect(html).toContain('<option value="enabled" selected="">Thinking with a budget (not offered by the model)</option>');
    expect(html).toContain('<option value="max" selected="">Effort max (not offered by the model)</option>');
    expect(html).not.toContain("Effort high");
  });

  it("says the check ended early", () => {
    const html = render(report({ protocol: null, interrupted: true, probes: [probe({ outcome: "error", failureKind: "provider_timeout" })] }), ADAPTIVE);
    expect(html).toContain("Checked with 1 probe: no protocol confirmed. The check ended early; what it didn&#x27;t reach is confirmed at resolution after save.");
  });

  it("shows every field before a check, and states the limit's problem", () => {
    const html = render(null, ADAPTIVE);
    expect(html).toContain("Check model");
    expect(html).toContain("Picking a model checks it (up to 6 calls)");
    expect(html).toContain('placeholder="not sent"');
    expect(html).toContain("Anthropic requires a limit.");
    const blank = renderToStaticMarkup(createElement(BindingSettings, {
      provider: "anthropic", temperature: "0", setTemperature: vi.fn(), temperatureValid: true, canCheck: false,
      picker: { ...picker(null, ADAPTIVE), settings: { reasoning: { family: "anthropic", thinking: { type: "enabled", budgetTokens: 2_048 }, effort: null }, verdictProtocol: "anthropic.structured-output/v1", outputTokenLimit: "2000" } } as never
    }));
    expect(blank).toContain("The limit must exceed the thinking budget of 2048 tokens.");
    expect(blank).toContain("Choose a model whose provider has a key to check which settings it takes.");
  });

  it("lists what blocks saving", () => {
    const html = render(report(), { family: "anthropic", thinking: { type: "disabled" }, effort: "high" });
    expect(html).toContain("The model rejected this reasoning setting in the check; choose another.");
  });
});
