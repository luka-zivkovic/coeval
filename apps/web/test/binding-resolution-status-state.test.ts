// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BindingResolutionStatus as Status } from "@rubrist/shared";

// The resolution card's state (Batch 8F): an answer for a version the card no
// longer shows is dropped, and a refresh reads the status again.

const reads: Array<{ id: string; resolve: (status: Status | null) => void }> = [];
const resolves: Array<{ id: string; resolve: (status: Status) => void }> = [];
vi.mock("../src/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("../src/components/ui/card.js", () => ({
  Card: ({ children }: { children?: unknown }) => createElement("section", null, children as never),
  CardContent: ({ children }: { children?: unknown }) => createElement("div", null, children as never)
}));
vi.mock("../src/components/rubrist/index.js", () => ({
  Chip: ({ children }: { children?: unknown }) => createElement("span", null, children as never),
  Eyebrow: ({ children }: { children?: unknown }) => createElement("span", null, children as never)
}));
vi.mock("../src/lib/evaluator-lifecycle-api.js", () => ({
  fetchBindingResolution: vi.fn((id: string) => new Promise((resolve) => { reads.push({ id, resolve }); })),
  resolveBindingNow: vi.fn((id: string) => new Promise((resolve) => { resolves.push({ id, resolve }); }))
}));

const { BindingResolutionStatus } = await import("../src/components/binding-resolution-status.js");

const status = (id: string, checkedAt: string | null): Status => ({
  skillVersionId: id, projectRole: "owner",
  record: checkedAt === null ? null : {
    status: "unresolved", capabilitySnapshotDigest: null, reasoningDefaultsVersion: null, credentialSource: "project",
    temperatureSupport: null, reasoningSupport: null, probes: [], checkedAt
  },
  settings: { temperature: "stated", reasoning: "stated" },
  gateRefusal: { message: "m", problems: ["the execution binding is unresolved, not resolved"], providerMessage: null, suggestion: "Try again." },
  resolvable: true
});

describe("the resolution card's state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reads.length = 0;
    resolves.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = (skillVersionId: string, refreshKey = 0) =>
    act(async () => { root.render(createElement(BindingResolutionStatus, { skillVersionId, refreshKey })); });

  it("drops a Resolve now answer for a version it no longer shows", async () => {
    await render("a");
    await act(async () => reads[0]!.resolve(status("a", null)));
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent === "Resolve now")!;
    await act(async () => button.click());
    expect(resolves.map((call) => call.id)).toEqual(["a"]);

    await render("b");
    await act(async () => reads[1]!.resolve(status("b", null)));
    await act(async () => resolves[0]!.resolve(status("a", "2026-09-27T01:02:00.000Z")));
    expect(container.textContent).toContain("No resolution has run yet.");
    expect(container.textContent).not.toContain("01:02 UTC");
    expect(container.textContent).toContain("Resolve now");
  });

  it("reads the status again when the surrounding view refreshes", async () => {
    await render("a");
    await act(async () => reads[0]!.resolve(status("a", null)));
    await render("a", 1);
    expect(reads.map((call) => call.id)).toEqual(["a", "a"]);
    await act(async () => reads[1]!.resolve(status("a", "2026-09-27T03:04:00.000Z")));
    expect(container.textContent).toContain("Last attempt 2026-09-27 03:04 UTC");
  });
});
