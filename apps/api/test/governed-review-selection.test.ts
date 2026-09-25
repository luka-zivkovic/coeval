import { describe, expect, it } from "vitest";
import { sha256Digest } from "../src/lib/canonical-json.js";
import { governedReviewServePositions } from "../src/lib/governed-review-artifacts.js";
import { executeGovernedReviewSelection, type GovernedSelectionRequest } from "../src/governed-review/selection.js";

const frame = Array.from({ length: 30 }, (_, index) => ({
  id: `review_item_${String(index).padStart(2, "0")}`,
  digest: sha256Digest(`frame-item-${index}`)
}));
const SERVE_SEED = "a1".repeat(32);
const OTHER_SERVE_SEED = "b2".repeat(32);
const DRAW_SEED = "c3".repeat(32);
const identity = (length: number) => Array.from({ length }, (_, index) => index);

describe("governed review serve order", () => {
  it("serves a caller-directed list in an order that does not follow the submission", () => {
    // A caller ranking items by a model score submits them in that order.
    const submitted = frame.slice(0, 16).map((item) => item.id).reverse();
    const selection = executeGovernedReviewSelection({
      frame,
      selection: { method: "uncertainty", selectedSourceItemIds: submitted },
      serveOrderSeed: SERVE_SEED
    });

    expect(selection.selected.map((item) => item.id)).toEqual(submitted);
    expect(selection.serveOrder).toMatchObject({ seed: SERVE_SEED, version: "sha256-serve-rank/v1" });
    const positions = selection.serveOrder.positions;
    expect([...positions].sort((left, right) => left - right)).toEqual(identity(submitted.length));
    expect(positions).not.toEqual(identity(submitted.length));
    // Reproducible from the frozen seed and the draw alone.
    expect(governedReviewServePositions(SERVE_SEED, selection.selected.map((item) => item.digest))).toEqual(positions);
    // Reordering the same submission does not change where each item is served.
    const resubmitted = executeGovernedReviewSelection({
      frame,
      selection: { method: "uncertainty", selectedSourceItemIds: [...submitted].reverse() },
      serveOrderSeed: SERVE_SEED
    });
    const servedAt = (result: typeof selection) =>
      new Map(result.selected.map((item, index) => [item.id, result.serveOrder.positions[index]]));
    expect(servedAt(resubmitted)).toEqual(servedAt(selection));
  });

  it.each<[string, GovernedSelectionRequest]>([
    ["simple_random", { method: "simple_random", fixedBudget: 10 }],
    ["systematic", { method: "systematic", fixedBudget: 10 }],
    ["stratified_random", {
      method: "stratified_random",
      strata: [
        { key: "a", definition: "first half", sourceItemIds: frame.slice(0, 15).map((item) => item.id), fixedBudget: 4 },
        { key: "b", definition: "second half", sourceItemIds: frame.slice(15).map((item) => item.id), fixedBudget: 6 }
      ]
    }],
    ["manual", { method: "manual", selectedSourceItemIds: frame.slice(3, 13).map((item) => item.id) }]
  ])("leaves the %s draw and its digest unchanged by the serve seed", (_method, request) => {
    const first = executeGovernedReviewSelection({ frame, selection: request, seed: DRAW_SEED, serveOrderSeed: SERVE_SEED });
    const second = executeGovernedReviewSelection({ frame, selection: request, seed: DRAW_SEED, serveOrderSeed: OTHER_SERVE_SEED });

    const { serveOrder: firstServe, ...firstDraw } = first;
    const { serveOrder: secondServe, ...secondDraw } = second;
    expect(secondDraw).toEqual(firstDraw);
    expect(secondServe.positions).not.toEqual(firstServe.positions);
  });

  it("does not serve a stratified draw grouped by stratum", () => {
    const selection = executeGovernedReviewSelection({
      frame,
      selection: {
        method: "stratified_random",
        strata: [
          { key: "judge_fail", definition: "evaluator said fail", sourceItemIds: frame.slice(0, 15).map((item) => item.id), fixedBudget: 8 },
          { key: "judge_pass", definition: "evaluator said pass", sourceItemIds: frame.slice(15).map((item) => item.id), fixedBudget: 8 }
        ]
      },
      seed: DRAW_SEED,
      serveOrderSeed: SERVE_SEED
    });
    const strata = selection.strata.flatMap((stratum) => stratum.selectedItemIds.map(() => stratum.key));
    const served = strata
      .map((key, index) => ({ key, position: selection.serveOrder.positions[index]! }))
      .sort((left, right) => left.position - right.position)
      .map((entry) => entry.key);
    expect(served).not.toEqual(strata);
    expect(served.slice(0, 8)).not.toEqual(Array(8).fill("judge_fail"));
  });

  it("generates a fresh serve seed when none is given", () => {
    const request: GovernedSelectionRequest = { method: "manual", selectedSourceItemIds: frame.slice(0, 5).map((item) => item.id) };
    const first = executeGovernedReviewSelection({ frame, selection: request });
    const second = executeGovernedReviewSelection({ frame, selection: request });
    expect(first.serveOrder.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(second.serveOrder.seed).not.toBe(first.serveOrder.seed);
    expect(second.drawDigest).toBe(first.drawDigest);
  });
});
