import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedApiKey, DashboardSummary } from "@coeval/shared";
import {
  benchSetupStepStates,
  firstProjectKey,
  forgetFirstProjectKey,
  journeyActStates,
  rememberFirstProjectKey
} from "../src/lib/journey.js";

function dashboard(input: { starter: boolean; judged: number; golden: number; imported?: number }): DashboardSummary {
  return {
    skill: { isStarter: input.starter, currentVersion: { version: "0.1.0", status: "draft" } },
    project: { importedTraceCount: input.imported ?? input.judged, autoJudgedTraceCount: input.judged },
    goldenSetSize: input.golden
  } as DashboardSummary;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}

const apiKey: CreatedApiKey = {
  id: "apikey_first",
  projectId: "proj_first",
  name: "First verdict",
  keyPrefix: "coeval_sk_first…",
  createdAt: "2026-08-14T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  key: "coeval_sk_first-project-secret"
};

describe("journey state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks only the first incomplete act as the current action", () => {
    expect(journeyActStates(dashboard({ starter: true, judged: 0, golden: 0 }))).toEqual({
      defineGood: "now",
      judgeRealWork: "next",
      earnTrust: "next"
    });
    expect(journeyActStates(dashboard({ starter: false, judged: 3, golden: 2 }))).toEqual({
      defineGood: "done",
      judgeRealWork: "done",
      earnTrust: "now"
    });
    expect(journeyActStates(dashboard({ starter: false, judged: 3, golden: 5 }))).toEqual({
      defineGood: "done",
      judgeRealWork: "done",
      earnTrust: "done"
    });
  });

  it("derives every Skill Bench setup step from durable project state", () => {
    expect(benchSetupStepStates(dashboard({ starter: false, imported: 0, judged: 0, golden: 0 }))).toEqual({
      defineSkill: "done",
      addExamples: "now",
      runSkill: "locked",
      enableRegression: "locked"
    });
    expect(benchSetupStepStates(dashboard({ starter: false, imported: 8, judged: 0, golden: 0 }))).toEqual({
      defineSkill: "done",
      addExamples: "done",
      runSkill: "now",
      enableRegression: "locked"
    });
    expect(benchSetupStepStates(dashboard({ starter: false, imported: 8, judged: 8, golden: 1 }))).toEqual({
      defineSkill: "done",
      addExamples: "done",
      runSkill: "done",
      enableRegression: "done"
    });
  });

  it("keeps later completed outcomes checked when setup happened out of order", () => {
    expect(benchSetupStepStates(dashboard({ starter: true, imported: 4, judged: 4, golden: 0 }))).toEqual({
      defineSkill: "now",
      addExamples: "done",
      runSkill: "done",
      enableRegression: "now"
    });
  });

  it("keeps an imported starter dataset runnable while rubric review remains open", () => {
    expect(benchSetupStepStates(dashboard({ starter: true, imported: 4, judged: 0, golden: 0 }))).toEqual({
      defineSkill: "now",
      addExamples: "done",
      runSkill: "now",
      enableRegression: "locked"
    });
  });

  it("keeps the one-time key scoped to its project and forgets it explicitly", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    expect(rememberFirstProjectKey("proj_first", apiKey)).toBe(true);

    expect(firstProjectKey("proj_other")).toBeNull();
    expect(firstProjectKey("proj_first")).toEqual(apiKey);
    forgetFirstProjectKey();
    expect(firstProjectKey("proj_first")).toBeNull();
  });

  it("reports when the one-time key cannot be persisted", () => {
    const blockedStorage = memoryStorage();
    blockedStorage.setItem = () => { throw new Error("storage unavailable"); };
    vi.stubGlobal("sessionStorage", blockedStorage);

    expect(rememberFirstProjectKey("proj_first", apiKey)).toBe(false);
    expect(firstProjectKey("proj_first")).toBeNull();
  });
});
