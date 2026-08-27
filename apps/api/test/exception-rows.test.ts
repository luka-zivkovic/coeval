import { describe, expect, it } from "vitest";
import { EXCEPTION_LIST_LIMIT, pinExceptionJudgeRunRows, type ExceptionJudgeRunRow } from "../src/lib/exception-rows.js";

function row(input: Partial<ExceptionJudgeRunRow> & Pick<ExceptionJudgeRunRow, "case_id" | "judge_run_id" | "verdict" | "created_at">): ExceptionJudgeRunRow {
  return {
    reasoning: `${input.verdict} reason`,
    ...input
  };
}

describe("pinExceptionJudgeRunRows", () => {
  it("keeps the verdict that opened the exception and marks a newer differing re-judge", () => {
    const pinned = pinExceptionJudgeRunRows([
      row({ case_id: "case_1", judge_run_id: "jr_1", verdict: "fail", reasoning: "first failure", created_at: "2026-06-01T00:00:00.000Z" }),
      row({ case_id: "case_1", judge_run_id: "jr_2", verdict: "pass", reasoning: "later pass", created_at: "2026-06-02T00:00:00.000Z" })
    ], new Map());

    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({
      judge_run_id: "jr_1",
      verdict: "fail",
      reasoning: "first failure",
      latest_judge_run_id: "jr_2",
      latest_verdict: "pass",
      latest_reasoning: "later pass"
    });
  });

  it("starts a new exception cycle after a human resolution", () => {
    const pinned = pinExceptionJudgeRunRows([
      row({ case_id: "case_1", judge_run_id: "jr_1", verdict: "fail", created_at: "2026-06-01T00:00:00.000Z" }),
      row({ case_id: "case_1", judge_run_id: "jr_2", verdict: "fail", reasoning: "new failure", created_at: "2026-06-03T00:00:00.000Z" })
    ], new Map([["case_1", "2026-06-02T00:00:00.000Z"]]));

    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({
      judge_run_id: "jr_2",
      verdict: "fail",
      reasoning: "new failure"
    });
  });

  it("omits cases whose only post-resolution verdict is pass", () => {
    const pinned = pinExceptionJudgeRunRows([
      row({ case_id: "case_1", judge_run_id: "jr_1", verdict: "fail", created_at: "2026-06-01T00:00:00.000Z" }),
      row({ case_id: "case_1", judge_run_id: "jr_2", verdict: "pass", created_at: "2026-06-03T00:00:00.000Z" })
    ], new Map([["case_1", "2026-06-02T00:00:00.000Z"]]));

    expect(pinned).toEqual([]);
  });

  it("keeps an explicit ambiguous evaluator abstention in the exception queue", () => {
    const pinned = pinExceptionJudgeRunRows([
      row({
        case_id: "case_ambiguous",
        judge_run_id: "jr_ambiguous",
        verdict: "ambiguous",
        reasoning: "rubric does not support either classification",
        created_at: "2026-06-01T00:00:00.000Z"
      })
    ], new Map());

    expect(pinned).toMatchObject([{
      case_id: "case_ambiguous",
      judge_run_id: "jr_ambiguous",
      verdict: "ambiguous"
    }]);
  });

  it("caps the pinned list at EXCEPTION_LIST_LIMIT, newest pinned first", () => {
    const rows = Array.from({ length: EXCEPTION_LIST_LIMIT + 7 }, (_, index) => ({
      case_id: `case_${String(index).padStart(3, "0")}`,
      judge_run_id: `run_${String(index).padStart(3, "0")}`,
      verdict: "fail",
      reasoning: "flagged",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }));
    const pinned = pinExceptionJudgeRunRows(rows, new Map());
    expect(EXCEPTION_LIST_LIMIT).toBe(50);
    expect(pinned).toHaveLength(EXCEPTION_LIST_LIMIT);
    // Newest pinned run survives the cap; the oldest rows fall off.
    expect(pinned[0]?.case_id).toBe(`case_${String(rows.length - 1).padStart(3, "0")}`);
    expect(pinned.some((row) => row.case_id === "case_000")).toBe(false);
  });
});
