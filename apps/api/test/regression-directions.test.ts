import { describe, expect, it } from "vitest";
import { regressionDirectionCounts, type RegressionCaseDiff } from "@coeval/shared";

function diff(partial: Pick<RegressionCaseDiff, "agreedLabel" | "newLabel" | "change">, index: number): RegressionCaseDiff {
  return {
    caseId: `case_${index}`,
    traceId: `trace_${index}`,
    rationale: "test",
    ...partial
  };
}

describe("regressionDirectionCounts", () => {
  it("splits regressions by direction instead of lumping them into strict", () => {
    const cases: RegressionCaseDiff[] = [
      diff({ agreedLabel: "pass", newLabel: "fail", change: "regress" }, 0),
      diff({ agreedLabel: "pass", newLabel: "fail", change: "regress" }, 1),
      diff({ agreedLabel: "fail", newLabel: "pass", change: "regress" }, 2),
      diff({ agreedLabel: "pass", newLabel: "ambiguous", change: "regress" }, 3),
      diff({ agreedLabel: "fail", newLabel: "fail", change: "agree" }, 4),
      diff({ agreedLabel: "pass", newLabel: "pass", change: "improve" }, 5)
    ];

    expect(regressionDirectionCounts(cases)).toEqual({ tooStrict: 2, tooLenient: 1, ambiguous: 1 });
  });

  it("sums to the regression count (agree/improve never contribute)", () => {
    const cases: RegressionCaseDiff[] = [
      diff({ agreedLabel: "fail", newLabel: "ambiguous", change: "regress" }, 0),
      diff({ agreedLabel: "pass", newLabel: "pass", change: "agree" }, 1)
    ];
    const counts = regressionDirectionCounts(cases);
    expect(counts.tooStrict + counts.tooLenient + counts.ambiguous).toBe(1);
  });
});
