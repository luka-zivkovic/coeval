import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BindingResolutionStatus, CapabilityProbe, ResolutionRecord } from "@rubrist/shared";
import { resolutionView } from "../src/lib/binding-resolution-view.js";
import { fetchBindingResolution, resolveBindingNow } from "../src/lib/evaluator-lifecycle-api.js";

vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never) }));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children?: unknown }) => createElement("section", null, children as never),
  CardContent: ({ children }: { children?: unknown }) => createElement("div", null, children as never)
}));
vi.mock("@/components/rubrist", () => ({
  Chip: ({ children, variant }: { children?: unknown; variant?: string }) => createElement("span", { "data-variant": variant }, children as never),
  Eyebrow: ({ children }: { children?: unknown }) => createElement("span", null, children as never)
}));
vi.mock("@/lib/evaluator-lifecycle-api", () => ({ fetchBindingResolution: vi.fn(), resolveBindingNow: vi.fn() }));

const { ResolutionPanel } = await import("../src/components/binding-resolution-status.js");

// A version's resolution, shown to its author (ADR-0014 section 4, Batch 8F).

function probe(overrides: Partial<CapabilityProbe>): CapabilityProbe {
  return {
    stage: "resolution", purpose: "confirm", verdictProtocol: "anthropic.structured-output/v1",
    sent: { temperature: 0, topP: null, reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "high" }, outputTokenLimit: 1_200 },
    outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null,
    usage: null, costMicroUsd: null,
    ...overrides
  };
}

function record(overrides: Partial<ResolutionRecord> = {}): ResolutionRecord {
  return {
    status: "resolved", capabilitySnapshotDigest: null, reasoningDefaultsVersion: null, credentialSource: "project",
    temperatureSupport: null, reasoningSupport: null, probes: [probe({})], checkedAt: "2026-09-26T08:30:12.000Z",
    ...overrides
  };
}

function status(overrides: Partial<BindingResolutionStatus> = {}): BindingResolutionStatus {
  return { skillVersionId: "version", projectRole: "owner", record: record(), gateRefusal: null, resolvable: false, ...overrides };
}

const REFUSAL = {
  message: "The execution binding can't pass a governed gate: the execution binding is failed, not resolved",
  problems: ["the execution binding is failed, not resolved"],
  providerMessage: "`temperature` is deprecated for this model.",
  suggestion: "Save a new evaluator version that leaves temperature unset."
};

describe("the resolution view", () => {
  it("reads a resolved binding ready for governed gates, with each probe's settings and outcome", () => {
    expect(resolutionView(status())).toEqual({
      label: "Resolved",
      tone: "pass",
      summary: "Last attempt 2026-09-26 08:30 UTC, with this project's key.",
      settings: [
        { setting: "Temperature", support: "not probed" },
        { setting: "Reasoning", support: "not probed" }
      ],
      probes: [{
        purpose: "Confirming probe · anthropic.structured-output/v1",
        sent: "temperature 0 · thinking adaptive at effort high · 1200 output tokens",
        outcome: "accepted",
        tone: "pass",
        providerMessage: null
      }],
      gate: { ready: true },
      canResolve: false
    });
  });

  it("says a failed binding needs a new version, with the provider's message and what to change", () => {
    const view = resolutionView(status({
      record: record({
        status: "failed",
        probes: [probe({ outcome: "rejected", rejection: "parameter", rejectedParameter: "temperature", failureKind: "provider_rejected_request", providerMessage: REFUSAL.providerMessage })]
      }),
      gateRefusal: REFUSAL
    }));
    expect(view).toMatchObject({
      label: "Failed",
      tone: "fail",
      summary: "Last attempt 2026-09-26 08:30 UTC, with this project's key. A failed binding is fixed only by a new evaluator version.",
      gate: { ready: false, problems: REFUSAL.problems, suggestion: REFUSAL.suggestion, providerMessage: REFUSAL.providerMessage },
      canResolve: false
    });
    expect(view.probes[0]).toMatchObject({ outcome: "rejected temperature as a parameter", tone: "fail", providerMessage: REFUSAL.providerMessage });
  });

  it("offers to resolve only an owner who could change the record", () => {
    const unresolved = status({
      record: record({ status: "unresolved", credentialSource: "environment", probes: [probe({ outcome: "error", failureKind: "provider_rate_limit" })] }),
      gateRefusal: { ...REFUSAL, providerMessage: null, suggestion: "Try again once the provider is reachable with a working credential." },
      resolvable: true
    });
    expect(resolutionView(unresolved)).toMatchObject({
      label: "Unresolved", tone: "ambig", summary: "Last attempt 2026-09-26 08:30 UTC, with the platform's key.", canResolve: true
    });
    expect(resolutionView(unresolved).probes[0]).toMatchObject({ outcome: "no answer: provider rate limit", tone: "ambig" });
    expect(resolutionView({ ...unresolved, projectRole: "member" }).canResolve).toBe(false);
    expect(resolutionView({ ...unresolved, resolvable: false }).canResolve).toBe(false);
  });

  it("reads a version no resolution has run for, without a retry suggestion", () => {
    expect(resolutionView(status({ record: null, gateRefusal: REFUSAL, resolvable: true }))).toMatchObject({
      label: "Not resolved yet",
      tone: "ambig",
      summary: "No resolution has run yet. It runs after save, the first time a governed gate needs it, or on demand.",
      settings: [],
      probes: [],
      gate: { ready: false, suggestion: null },
      canResolve: true
    });
  });

  it("states what the model showed about unset settings", () => {
    expect(resolutionView(status({ record: record({ temperatureSupport: "parameter_rejected", reasoningSupport: "accepted" }) })).settings).toEqual([
      { setting: "Temperature", support: "rejected as a parameter, so it stays unset" },
      { setting: "Reasoning", support: "accepted" }
    ]);
  });
});

describe("the resolution panel", () => {
  const render = (view: ReturnType<typeof resolutionView> | null, error: string | null = null) =>
    renderToStaticMarkup(createElement(ResolutionPanel, { view, error, resolving: false, onResolve: vi.fn() }));

  it("shows the status, probes, and the gate's refusal with what to change", () => {
    const html = render(resolutionView(status({
      record: record({ status: "failed", probes: [probe({ outcome: "rejected", rejection: "value", rejectedParameter: "reasoning", failureKind: "provider_rejected_request", providerMessage: "effort high isn't supported" })] }),
      gateRefusal: REFUSAL
    })));
    expect(html).toContain('<span data-variant="fail">Failed</span>');
    expect(html).toContain("rejected this reasoning value");
    expect(html).toContain("Provider: effort high isn&#x27;t supported");
    expect(html).toContain("Can&#x27;t pass a governed gate yet: the execution binding is failed, not resolved.");
    expect(html).toContain(REFUSAL.suggestion);
    expect(html).not.toContain("Resolve now");
  });

  it("offers Resolve now where it could help, and says when a binding is ready", () => {
    expect(render(resolutionView(status({ record: null, gateRefusal: REFUSAL, resolvable: true })))).toContain("Resolve now");
    expect(render(resolutionView(status()))).toContain("Ready for governed gates");
    expect(render(null)).toContain("Loading the binding");
    expect(render(null, "Reading failed")).toContain('role="alert"');
  });
});

describe("the resolution web API", () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } });

  it("reads a version's resolution, and nothing where the deployment keeps no records", async () => {
    const fetchMock = vi.fn(async () => json(status()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchBindingResolution("version/1")).resolves.toEqual(status());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/evaluator-lifecycles/version%2F1/resolution");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Evaluator lifecycle requires database-backed session mode", code: "evaluator_lifecycle_database_required" }, 501)));
    await expect(fetchBindingResolution("version")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Evaluator version not found", code: "evaluator_lifecycle_not_found" }, 404)));
    await expect(fetchBindingResolution("version")).rejects.toThrow("Evaluator version not found");
  });

  it("resolves on demand with a POST, and refuses a malformed status", async () => {
    const fetchMock = vi.fn(async () => json(status({ record: record({ status: "unresolved", probes: [probe({ outcome: "error", failureKind: "provider_timeout" })] }) })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveBindingNow("version")).resolves.toMatchObject({ record: { status: "unresolved" } });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("POST");
    vi.stubGlobal("fetch", vi.fn(async () => json({ skillVersionId: "version", record: null })));
    await expect(resolveBindingNow("version")).rejects.toThrow();
  });
});
