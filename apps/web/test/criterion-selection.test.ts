import { describe, expect, it } from "vitest";
import {
  criterionSelectionStorageKey,
  resolveCriterionSelection,
  withCriterionSearch,
} from "../src/lib/criterion-selection.js";

describe("criterion selection", () => {
  it("auto-selects the sole criterion and preserves unrelated URL state", () => {
    expect(resolveCriterionSelection(["criterion_correctness"], null, null))
      .toBe("criterion_correctness");
    expect(withCriterionSearch("?cluster=refunds", "criterion_correctness"))
      .toBe("?cluster=refunds&criterionId=criterion_correctness");
  });

  it("requires an explicit choice for multiple criteria and rejects stale pins", () => {
    const ids = ["criterion_correctness", "criterion_tone"];
    expect(resolveCriterionSelection(ids, null, null)).toBeNull();
    expect(resolveCriterionSelection(ids, "criterion_deleted", "criterion_old")).toBeNull();
    expect(resolveCriterionSelection(ids, "criterion_deleted", "criterion_correctness")).toBeNull();
    expect(resolveCriterionSelection(ids, "criterion_tone", "criterion_correctness"))
      .toBe("criterion_tone");
  });

  it("falls back to a valid persisted choice and can replace or remove the URL pin", () => {
    const ids = ["criterion_correctness", "criterion_tone"];
    expect(resolveCriterionSelection(ids, null, "criterion_correctness"))
      .toBe("criterion_correctness");
    expect(withCriterionSearch("?criterionId=criterion_tone&from=a", "criterion_correctness"))
      .toBe("?criterionId=criterion_correctness&from=a");
    expect(withCriterionSearch("?criterionId=criterion_tone", null)).toBe("");
    expect(criterionSelectionStorageKey("project_1")).toBe("coeval.criterion.project_1");
  });
});
