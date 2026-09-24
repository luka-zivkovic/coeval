import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionDecisionLedgerRecordSchema, buildProductionCalibrationArtifact } from "@rubrist/shared";

// The screen imports app aliases (`@/...`) that only the node transform lets
// these mocks replace, so this test runs in node with a jsdom window installed
// as globals before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Event", "Node", "localStorage"] as const) {
  vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
}
const { createRoot } = await import("react-dom/client");

const Element = ({ children, ...props }: { children?: unknown }) =>
  createElement("div", props, children as never);

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: { children?: unknown; variant?: string; size?: string }) =>
    createElement("button", { type: "button", ...props }, children as never)
}));
vi.mock("@/components/ui/card", () => ({ Card: Element, CardContent: Element, CardHeader: Element, CardTitle: Element }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: object) => createElement("textarea", props) }));
vi.mock("@/components/rubrist", () => ({
  SectionHead: ({ title }: { title: string }) => createElement("header", null, title)
}));
vi.mock("@/components/database-mode-required", () => ({ DatabaseModeRequired: () => createElement("section") }));
vi.mock("@/lib/app-mode", () => ({ useAppMode: () => ({ authEnabled: true, demoMode: false }) }));

const { ProductionCalibrationScreen } = await import("../src/screens/production-calibration.js");

const records = readFileSync(
  new URL("../../api/test/fixtures/production-decision-ledger.flaky-triage.jsonl", import.meta.url),
  "utf8"
).split("\n").filter((line) => line.trim() !== "").map((line) => ProductionDecisionLedgerRecordSchema.parse(JSON.parse(line)));
const artifact = buildProductionCalibrationArtifact(records, { now: new Date("2026-09-21T09:00:00.000Z") });
const summary = {
  records: { total: 48, decisions: 16, actions: 0, outcomes: 32 },
  questions: [],
  models: artifact.records.models,
  questionSetDigests: [],
  question: null
};
const snapshot = {
  id: "pcs_old",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  window: { from: null, to: null },
  recordCount: 48,
  recordSetDigest: `sha256:${"a".repeat(64)}`,
  builtAt: "2026-09-01T00:00:00.000Z",
  createdByUserId: "user_1",
  createdAt: "2026-09-01T00:00:00.000Z"
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("production calibration screen interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let snapshotResponse: Promise<Response> | null;
  let role: "owner" | "member";

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    snapshotResponse = null;
    role = "owner";
    dom.window.confirm = () => true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ url, method, body });
      if (url.endsWith("/settings")) {
        return json({ retentionDays: method === "PUT" ? body?.retentionDays : 90, projectRole: role });
      }
      if (url.endsWith("/records/erase")) return json({ erased: { decisions: 1, actions: 0, outcomes: 2 } });
      if (url.endsWith("/snapshots/pcs_old") && method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/report")) {
        return json({ artifact, summary, projectRole: "owner", recordCount: 48, recordSetDigest: snapshot.recordSetDigest });
      }
      if (url.endsWith("/snapshots") && init?.method === "POST") return json({ snapshot }, 201);
      if (url.endsWith("/snapshots")) return json({ snapshots: [snapshot] });
      if (url.endsWith("/snapshots/pcs_old")) return snapshotResponse ?? json({ snapshot, artifact });
      return json({ error: "unexpected" }, 500);
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    dom.window.close();
  });

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  const settle = () => act(async () => {
    for (let round = 0; round < 5; round += 1) await Promise.resolve();
  });
  const setDate = (label: string, value: string) => act(() => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const source = () => [...container.querySelectorAll("dt")]
    .find((term) => term.textContent?.startsWith("source"))?.nextElementSibling?.textContent ?? null;

  it("saves the stored report on screen, not edited dates, and only while one is shown", async () => {
    act(() => root.render(createElement(ProductionCalibrationScreen)));
    await settle();
    setDate("Window from date", "2026-09-01");
    setDate("Window through date", "2026-09-10");
    expect(button("Save snapshot").disabled).toBe(true);

    await act(async () => button("Build report").click());
    await settle();
    expect(calls.find((call) => call.url.endsWith("/report"))?.body).toEqual({
      from: "2026-09-01T00:00:00.000Z", to: "2026-09-11T00:00:00.000Z", bins: 10, windowDays: 7
    });
    expect(button("Save snapshot").disabled).toBe(false);

    setDate("Window through date", "2026-09-20");
    await act(async () => button("Save snapshot").click());
    await settle();
    expect(calls.find((call) => call.url.endsWith("/snapshots") && call.method === "POST")?.body).toEqual({
      from: "2026-09-01T00:00:00.000Z", to: "2026-09-11T00:00:00.000Z", bins: 10, windowDays: 7
    });

    await act(async () => button("Open").click());
    await settle();
    expect(source()).toContain("snapshot pcs_old");
    expect(button("Save snapshot").disabled).toBe(true);
  });

  it("keeps the newer build when a slow snapshot load finishes after it", async () => {
    let release: (response: Response) => void = () => undefined;
    snapshotResponse = new Promise((resolve) => { release = resolve; });
    act(() => root.render(createElement(ProductionCalibrationScreen)));
    await settle();
    await act(async () => button("Open").click());
    await act(async () => button("Build report").click());
    await settle();
    expect(source()).toContain("stored records");
    await act(async () => release(json({ snapshot, artifact })));
    await settle();
    expect(source()).toContain("stored records");
  });

  it("hides owner controls from members once the role is known", async () => {
    role = "member";
    act(() => root.render(createElement(ProductionCalibrationScreen)));
    await settle();
    expect(container.textContent).toContain("Rubrist keeps production records for 90 days");
    expect(button("Import .jsonl (owners)")).toBeUndefined();
    expect(button("Delete")).toBeUndefined();
    expect(container.querySelector('input[aria-label="Retention days"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Decision ID to erase"]')).toBeNull();
  });

  it("lets an owner change retention, erase a decision after confirming, and delete a snapshot", async () => {
    act(() => root.render(createElement(ProductionCalibrationScreen)));
    await settle();
    setDate("Retention days", "30");
    await act(async () => button("Save retention").click());
    await settle();
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ retentionDays: 30 });
    expect(container.textContent).toContain("for 30 days");

    act(() => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Decision ID to erase"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "d-42");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    dom.window.confirm = () => false;
    await act(async () => button("Erase decision").click());
    expect(calls.some((call) => call.url.endsWith("/records/erase"))).toBe(false);
    dom.window.confirm = () => true;
    await act(async () => button("Erase decision").click());
    await settle();
    expect(calls.find((call) => call.url.endsWith("/records/erase"))?.body).toEqual({ decisionId: "d-42" });
    expect(container.textContent).toContain("erased d-42 · 1 decisions · 0 actions · 2 outcomes");

    await act(async () => button("Delete").click());
    await settle();
    expect(calls.some((call) => call.url.endsWith("/snapshots/pcs_old") && call.method === "DELETE")).toBe(true);
  });
});
