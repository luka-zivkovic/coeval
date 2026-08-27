// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "../src/hooks/use-dialog-focus.js";

function DialogHarness({
  closeOnEscape = true,
  onClose
}: {
  closeOnEscape?: boolean;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose, closeOnEscape });
  return createElement(
    "div",
    { ref: dialogRef, role: "dialog", tabIndex: -1 },
    createElement("button", { type: "button", id: "first", autoFocus: true }, "First"),
    createElement("button", { type: "button", id: "last" }, "Last")
  );
}

describe("useDialogFocus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("moves focus inside, traps Tab at both edges, and closes on Escape", () => {
    const onClose = vi.fn();
    act(() => root.render(createElement(DialogHarness, { onClose })));

    const first = container.querySelector<HTMLButtonElement>("#first")!;
    const last = container.querySelector<HTMLButtonElement>("#last")!;
    expect(document.activeElement).toBe(first);

    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })
    );
    expect(document.activeElement).toBe(last);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("can disable Escape while a dialog action is in flight", () => {
    const onClose = vi.fn();
    act(() => root.render(createElement(DialogHarness, { onClose, closeOnEscape: false })));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("restores focus to the control that opened the dialog", () => {
    const opener = document.createElement("button");
    document.body.prepend(opener);
    opener.focus();

    act(() => root.render(createElement(DialogHarness, { onClose: vi.fn() })));
    expect(document.activeElement).not.toBe(opener);

    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    opener.remove();

    root = createRoot(container);
  });
});
