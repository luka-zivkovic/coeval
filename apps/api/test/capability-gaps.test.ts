import { describe, expect, it } from "vitest";
import { capabilityGapsFromExceptions } from "../src/lib/capability-gaps.js";

describe("capabilityGapsFromExceptions", () => {
  it("counts exact categories from the current unresolved queue", () => {
    const exception = (id: string, capabilityGap?: string) => ({
      id,
      traceId: `trace_${id}`,
      title: id,
      verdict: "fail" as const,
      reason: "Recorded judge rationale.",
      reviewerState: "needs_review" as const,
      createdAt: "2026-08-27T00:00:00.000Z",
      ...(capabilityGap ? { capabilityGap } : {})
    });

    expect(capabilityGapsFromExceptions([
      exception("one", "policy_grounding"),
      exception("two", "policy_grounding"),
      exception("three", "missing_context"),
      exception("four")
    ])).toEqual([
      { id: "gap_policy_grounding", name: "policy_grounding", count: 2, severity: "medium" },
      { id: "gap_missing_context", name: "missing_context", count: 1, severity: "low" }
    ]);
  });
});
