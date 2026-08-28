import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SetupLedger } from "../src/components/coeval/setup-ledger.js";

vi.mock("@/components/ui/card", async () => {
  const { createElement } = await import("react");
  const Element = ({ children, ...props }: { children?: unknown }) =>
    createElement("div", props, children as never);
  return {
    Card: Element,
    CardHeader: Element,
    CardTitle: Element,
    CardDescription: Element
  };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({ children, ...props }: { children?: unknown }) =>
      createElement("div", props, children as never)
  };
});
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));

describe("setup ledger accessibility", () => {
  it("exposes ordered steps, their status, and the current step", () => {
    const html = renderToStaticMarkup(createElement(SetupLedger, {
      steps: [
        { state: "done", title: "Bring a Run" },
        { state: "now", title: "Choose a Check" },
        { state: "locked", title: "See a Result" }
      ]
    }));

    expect(html).toContain("<ol>");
    expect(html).toContain('<li aria-current="step"');
    expect(html).toContain("Complete: ");
    expect(html).toContain("Current step: ");
    expect(html).toContain("Locked: ");
  });
});
