import { describe, expect, it } from "vitest";
import type { EvalRun, VerdictRecord } from "@coeval/shared";
import { backfillRunForVersion, verdictForTrackedItem } from "../src/lib/first-result.js";

function run(input: Partial<EvalRun> & Pick<EvalRun, "id" | "skillVersionId" | "trigger">): EvalRun {
  return {
    projectId: "project_1",
    datasetId: null,
    skillVersionId: input.skillVersionId,
    trigger: input.trigger,
    status: "pending",
    blocking: false,
    totalItems: 1,
    completedItems: 0,
    failedItems: 0,
    agreedItems: 0,
    error: null,
    sourceTraceTest: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...input
  };
}

describe("first Result tracked run", () => {
  it("selects only the durable backfill for the exact Check version", () => {
    const expected = run({ id: "evr_backfill", skillVersionId: "skillv_new", trigger: "backfill" });
    expect(backfillRunForVersion([
      run({ id: "evr_manual", skillVersionId: "skillv_new", trigger: "manual" }),
      run({ id: "evr_old", skillVersionId: "skillv_old", trigger: "backfill" }),
      expected
    ], "skillv_new")).toEqual(expected);
  });

  it("does not substitute an unrelated run while gate work is still preparing", () => {
    expect(backfillRunForVersion([
      run({ id: "evr_manual", skillVersionId: "skillv_new", trigger: "manual" })
    ], "skillv_new")).toBeNull();
  });

  it("renders the verdict linked by the completed item instead of a case/version fallback", () => {
    const verdict = (id: string, rationale: string): VerdictRecord => ({
      id,
      projectId: "project_1",
      caseId: "case_1",
      skillVersionId: "skillv_new",
      source: "llm_judge",
      actorUserId: null,
      payload: { kind: "binary", pass: id === "verdict_tracked", rationale },
      externalRunId: null,
      createdAt: "2026-08-28T00:00:00.000Z"
    });
    const older = verdict("verdict_legacy", "Reasoning from a different provider call");
    const tracked = verdict("verdict_tracked", "Reasoning that completed this item");

    expect(verdictForTrackedItem([older, tracked], tracked.id)).toEqual(tracked);
    expect(verdictForTrackedItem([older], tracked.id)).toBeNull();
  });
});
