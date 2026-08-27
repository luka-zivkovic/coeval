import { describe, expect, it } from "vitest";
import { PlanQueueAssignmentsInputSchema, planQueueAssignments } from "@coeval/shared";

describe("planQueueAssignments", () => {
  it("with overlapRate=0 assigns each case to exactly one reviewer (round-robin)", () => {
    const plan = planQueueAssignments({
      caseIds: ["c1", "c2", "c3", "c4", "c5", "c6"],
      reviewers: ["a", "b", "c"],
      overlapRate: 0,
      seed: "test-1"
    });
    expect(plan).toHaveLength(6);
    // Every case appears exactly once.
    expect(new Set(plan.map((p) => p.caseId)).size).toBe(6);
    // Each reviewer is used (round-robin over 6 cases / 3 reviewers).
    const counts = countByReviewer(plan);
    expect(counts.a).toBe(2);
    expect(counts.b).toBe(2);
    expect(counts.c).toBe(2);
  });

  it("with overlapRate=1 assigns every case to every reviewer (the κ-saturated extreme)", () => {
    const plan = planQueueAssignments({
      caseIds: ["c1", "c2", "c3"],
      reviewers: ["a", "b"],
      overlapRate: 1,
      seed: "test-1"
    });
    expect(plan).toHaveLength(6);
    // Each case appears twice (once per reviewer).
    const caseCounts = countByCase(plan);
    expect(caseCounts.c1).toBe(2);
    expect(caseCounts.c2).toBe(2);
    expect(caseCounts.c3).toBe(2);
  });

  it("with overlapRate=0.5 splits cases between overlap-set and solo-set deterministically", () => {
    const plan = planQueueAssignments({
      caseIds: ["c1", "c2", "c3", "c4"],
      reviewers: ["a", "b"],
      overlapRate: 0.5,
      seed: "test-1"
    });
    // floor(4 * 0.5) = 2 cases overlap (× 2 reviewers = 4 assignments),
    // 2 solo cases (× 1 reviewer each = 2 assignments) → 6 total.
    expect(plan).toHaveLength(6);
    const caseCounts = countByCase(plan);
    const overlapped = Object.entries(caseCounts).filter(([, count]) => count === 2);
    const solo = Object.entries(caseCounts).filter(([, count]) => count === 1);
    expect(overlapped).toHaveLength(2);
    expect(solo).toHaveLength(2);
  });

  it("is deterministic — same seed produces the same plan; different seeds shuffle the assignments", () => {
    const input = {
      caseIds: ["c1", "c2", "c3", "c4", "c5"],
      reviewers: ["a", "b", "c"],
      overlapRate: 0.4
    };
    const plan1 = planQueueAssignments({ ...input, seed: "alpha" });
    const plan2 = planQueueAssignments({ ...input, seed: "alpha" });
    const plan3 = planQueueAssignments({ ...input, seed: "beta" });
    expect(plan1).toEqual(plan2);
    expect(plan1).not.toEqual(plan3);
  });

  it("uses 'default' as the implicit seed and still produces a reproducible plan", () => {
    const input = {
      caseIds: ["c1", "c2", "c3"],
      reviewers: ["a", "b"],
      overlapRate: 1 / 3
    };
    const plan1 = planQueueAssignments(input);
    const plan2 = planQueueAssignments(input);
    expect(plan1).toEqual(plan2);
  });

  it("schema rejects duplicate caseIds or reviewers, and out-of-range overlap", () => {
    expect(() => PlanQueueAssignmentsInputSchema.parse({
      caseIds: ["c1", "c1"],
      reviewers: ["a"],
      overlapRate: 0
    })).toThrow();
    expect(() => PlanQueueAssignmentsInputSchema.parse({
      caseIds: ["c1"],
      reviewers: ["a", "a"],
      overlapRate: 0
    })).toThrow();
    expect(() => PlanQueueAssignmentsInputSchema.parse({
      caseIds: ["c1"],
      reviewers: ["a"],
      overlapRate: -0.1
    })).toThrow();
    expect(() => PlanQueueAssignmentsInputSchema.parse({
      caseIds: ["c1"],
      reviewers: ["a"],
      overlapRate: 1.1
    })).toThrow();
  });

  it("plan output is ready to feed addReviewQueueItems verbatim", () => {
    const plan = planQueueAssignments({
      caseIds: ["c1", "c2"],
      reviewers: ["a", "b"],
      overlapRate: 1,
      criterionVersionId: "criterionv_groundedness_1",
      seed: "ready-feed"
    });
    // Shape check — every entry has exactly { caseId, assignedToUserId } as
    // strings; no nulls (the planner always assigns).
    expect(plan.every((p) => typeof p.caseId === "string" && p.caseId.length > 0)).toBe(true);
    expect(plan.every((p) => typeof p.assignedToUserId === "string" && p.assignedToUserId.length > 0)).toBe(true);
    expect(plan.every((p) => p.criterionVersionId === "criterionv_groundedness_1")).toBe(true);
  });

  it("scales: 100 cases × 3 reviewers × 20% overlap produces 20 × 3 + 80 × 1 = 140 assignments", () => {
    const caseIds = Array.from({ length: 100 }, (_, i) => `case_${i.toString().padStart(3, "0")}`);
    const plan = planQueueAssignments({
      caseIds,
      reviewers: ["a", "b", "c"],
      overlapRate: 0.2,
      seed: "scale-test"
    });
    expect(plan).toHaveLength(20 * 3 + 80);
    // No reviewer is starved.
    const counts = countByReviewer(plan);
    expect(counts.a).toBeGreaterThan(0);
    expect(counts.b).toBeGreaterThan(0);
    expect(counts.c).toBeGreaterThan(0);
  });
});

function countByReviewer(plan: Array<{ assignedToUserId: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of plan) out[p.assignedToUserId] = (out[p.assignedToUserId] ?? 0) + 1;
  return out;
}

function countByCase(plan: Array<{ caseId: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of plan) out[p.caseId] = (out[p.caseId] ?? 0) + 1;
  return out;
}
