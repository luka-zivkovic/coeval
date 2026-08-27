import { describe, expect, it } from "vitest";
import { computeRunDelta, orderRuns } from "../src/lib/run-delta.js";
import type { EvalRunDetail, EvalRunItem } from "@coeval/shared";

function item(overrides: Partial<EvalRunItem> & { caseId: string }): EvalRunItem {
  return {
    id: `eri_${overrides.caseId}`,
    evalRunId: "run_x",
    datasetItemId: null,
    status: "completed",
    verdictId: "v_1",
    expectedLabel: null,
    expectedFailStep: null,
    failingStep: null,
    resultLabel: "pass",
    agreement: null,
    stepAgreement: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    cached: false,
    error: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    finishedAt: "2026-07-05T00:00:01.000Z",
    ...overrides
  };
}

function run(overrides: Partial<EvalRunDetail> & { id: string; items: EvalRunItem[] }): EvalRunDetail {
  return {
    projectId: "proj_1",
    datasetId: "ds_1",
    skillVersionId: "sv_a",
    trigger: "manual",
    status: "completed",
    blocking: false,
    totalItems: overrides.items.length,
    completedItems: overrides.items.filter((i) => i.status === "completed").length,
    failedItems: overrides.items.filter((i) => i.status === "failed").length,
    agreedItems: 0,
    spend: { freshItems: 0, cachedItems: 0, inputTokens: null, outputTokens: null, usageMissingCount: 0, totalLatencyMs: null },
    error: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides
  };
}

describe("orderRuns", () => {
  it("puts the older run first regardless of argument order", () => {
    const older = run({ id: "run_a", items: [], createdAt: "2026-07-05T00:00:00.000Z" });
    const newer = run({ id: "run_b", items: [], createdAt: "2026-07-05T01:00:00.000Z" });
    expect(orderRuns(newer, older).map((r) => r.id)).toEqual(["run_a", "run_b"]);
    expect(orderRuns(older, newer).map((r) => r.id)).toEqual(["run_a", "run_b"]);
  });
});

describe("computeRunDelta", () => {
  it("marks a flip only when both items completed with different labels, and sorts flips first", () => {
    const a = run({
      id: "run_a",
      agreedItems: 2,
      items: [
        item({ caseId: "case_1", expectedLabel: "pass", resultLabel: "pass" }),
        item({ caseId: "case_2", expectedLabel: "fail", resultLabel: "pass" }),
        item({ caseId: "case_3", resultLabel: "pass" })
      ]
    });
    const b = run({
      id: "run_b",
      skillVersionId: "sv_b",
      agreedItems: 2,
      items: [
        item({ caseId: "case_1", expectedLabel: "pass", resultLabel: "pass" }),
        item({ caseId: "case_2", expectedLabel: "fail", resultLabel: "fail" }),
        item({ caseId: "case_3", resultLabel: "pass" })
      ]
    });

    const delta = computeRunDelta(a, b);
    expect(delta.shared).toBe(3);
    expect(delta.flipped).toBe(1);
    expect(delta.rows[0]).toMatchObject({ caseId: "case_2", aSaid: "pass", bSaid: "fail", flipped: true });
    expect(delta.rows.slice(1).every((row) => !row.flipped)).toBe(true);
  });

  it("never counts a failed item as a flip and reports failure counts explicitly", () => {
    const a = run({
      id: "run_a",
      items: [item({ caseId: "case_1", status: "failed", resultLabel: null, verdictId: null })]
    });
    const b = run({
      id: "run_b",
      items: [item({ caseId: "case_1", resultLabel: "fail" })]
    });

    const delta = computeRunDelta(a, b);
    expect(delta.flipped).toBe(0);
    expect(delta.aFailed).toBe(1);
    expect(delta.bFailed).toBe(0);
    expect(delta.rows[0]).toMatchObject({ aSaid: null, aStatus: "failed", bSaid: "fail", flipped: false });
  });

  it("counts cases present in only one run instead of silently dropping them", () => {
    const a = run({ id: "run_a", items: [item({ caseId: "case_1" }), item({ caseId: "case_old" })] });
    const b = run({ id: "run_b", items: [item({ caseId: "case_1" }), item({ caseId: "case_new" })] });

    const delta = computeRunDelta(a, b);
    expect(delta.shared).toBe(1);
    expect(delta.aOnly).toBe(1);
    expect(delta.bOnly).toBe(1);
  });

  it("computes per-run agreement over labeled completed items only", () => {
    const a = run({
      id: "run_a",
      agreedItems: 1,
      items: [
        item({ caseId: "case_1", expectedLabel: "pass" }),
        item({ caseId: "case_2", expectedLabel: "fail", status: "failed", resultLabel: null }),
        item({ caseId: "case_3" })
      ]
    });
    const b = run({ id: "run_b", agreedItems: 0, items: [item({ caseId: "case_1" })] });

    const delta = computeRunDelta(a, b);
    expect(delta.aAgreement).toEqual({ agreed: 1, labeled: 1 });
    expect(delta.bAgreement).toEqual({ agreed: 0, labeled: 0 });
  });

  it("reports zero flips honestly when both runs said the same thing", () => {
    const items = [item({ caseId: "case_1" }), item({ caseId: "case_2" })];
    const delta = computeRunDelta(run({ id: "run_a", items }), run({ id: "run_b", items }));
    expect(delta.flipped).toBe(0);
    expect(delta.shared).toBe(2);
    expect(delta.rows).toHaveLength(2);
  });
});
