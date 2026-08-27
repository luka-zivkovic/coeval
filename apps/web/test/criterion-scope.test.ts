import { describe, expect, it } from "vitest";
import {
  filterToSkillVersionScope,
  versionPairIsInScope,
} from "../src/lib/criterion-scope.js";

describe("criterion lineage isolation", () => {
  const selectedVersions = new Set(["skillv_correctness_1", "skillv_correctness_2"]);

  it("excludes eval evidence produced by another criterion", () => {
    const rows = [
      { id: "run_old", skillVersionId: "skillv_correctness_1" },
      { id: "run_current", skillVersionId: "skillv_correctness_2" },
      { id: "run_tone", skillVersionId: "skillv_tone_1" },
    ];

    expect(filterToSkillVersionScope(rows, selectedVersions).map((row) => row.id))
      .toEqual(["run_old", "run_current"]);
  });

  it("fails closed when either side of a comparison belongs to another criterion", () => {
    expect(versionPairIsInScope({
      versionAId: "skillv_correctness_1",
      versionBId: "skillv_correctness_2",
    }, selectedVersions)).toBe(true);
    expect(versionPairIsInScope({
      versionAId: "skillv_correctness_1",
      versionBId: "skillv_tone_1",
    }, selectedVersions)).toBe(false);
  });
});
