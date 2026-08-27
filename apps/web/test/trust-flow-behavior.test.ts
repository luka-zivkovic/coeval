import { describe, expect, it, vi } from "vitest";
import { countLegacyHumanCheckedCases } from "../src/lib/legacy-human-checks.js";
import { buildTraceExportPresentation } from "../src/lib/trace-export.js";

describe("trust-aligned flow behavior", () => {
  it("counts distinct legacy cases from exactly human and adjudicated verdicts", async () => {
    const fetchVerdicts = vi.fn(async ({ source }: { source: "human" | "adjudicated" }) =>
      source === "human"
        ? [{ caseId: "case_a" }, { caseId: "case_b" }]
        : [{ caseId: "case_b" }, { caseId: "case_c" }]
    );

    await expect(countLegacyHumanCheckedCases("criterion_1", fetchVerdicts)).resolves.toBe(3);
    expect(fetchVerdicts.mock.calls.map(([input]) => input)).toEqual([
      { source: "human", criterionId: "criterion_1" },
      { source: "adjudicated", criterionId: "criterion_1" }
    ]);
  });

  it.each([
    {
      name: "all sources and versions",
      sourceFilter: "all" as const,
      versionFilter: "all",
      expectedQuery: {
        format: "jsonl",
        criterionId: "criterion_1",
        source: null,
        skillVersionId: null
      },
      titleScope: "every source · every evaluator version"
    },
    {
      name: "one source",
      sourceFilter: "human" as const,
      versionFilter: "all",
      expectedQuery: {
        format: "jsonl",
        criterionId: "criterion_1",
        source: "human",
        skillVersionId: null
      },
      titleScope: "source Human · every evaluator version"
    },
    {
      name: "one evaluator version",
      sourceFilter: "all" as const,
      versionFilter: "skillv_2",
      expectedQuery: {
        format: "jsonl",
        criterionId: "criterion_1",
        source: null,
        skillVersionId: "skillv_2"
      },
      titleScope: "every source · version skillv_2"
    },
    {
      name: "one source and evaluator version",
      sourceFilter: "adjudicated" as const,
      versionFilter: "skillv_3",
      expectedQuery: {
        format: "jsonl",
        criterionId: "criterion_1",
        source: "adjudicated",
        skillVersionId: "skillv_3"
      },
      titleScope: "source Adjudicated · version skillv_3"
    }
  ])("binds $name to the export URL and disclosure", ({
    sourceFilter,
    versionFilter,
    expectedQuery,
    titleScope
  }) => {
    const presentation = buildTraceExportPresentation({
      criterionId: "criterion_1",
      sourceFilter,
      versionFilter
    });
    const query = new URL(presentation.url, "http://coeval.test").searchParams;

    expect({
      format: query.get("format"),
      criterionId: query.get("criterionId"),
      source: query.get("source"),
      skillVersionId: query.get("skillVersionId")
    }).toEqual(expectedQuery);
    expect(presentation.title).toContain(titleScope);
    expect(presentation.title).toContain(
      "Verdict-label, search, and random-sample filters are not applied."
    );
  });
});
