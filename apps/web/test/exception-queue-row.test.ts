import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { caseReviewUrl, rationalePreview, selectReviewCaseIds } from "../src/lib/exception-queue.js";

describe("exception queue rows", () => {
  it("uses a deterministic exact first sentence instead of a generated gist", () => {
    expect(rationalePreview("Exact first sentence! Another sentence.")).toBe("Exact first sentence!");
    expect(rationalePreview("  Exact text without punctuation  ")).toBe("Exact text without punctuation");
    expect(rationalePreview("First line.\nSecond line stays in the full note.")).toBe("First line.");
  });

  it("keeps exact-note expansion and full-context review wired into every row", async () => {
    const source = await readFile(new URL("../src/screens/exceptions.tsx", import.meta.url), "utf8");

    expect(source).toContain("aria-expanded={expanded}");
    expect(source).toContain("expanded ? exception.reason : rationalePreview(exception.reason)");
    expect(source).toContain('<Table className="table-fixed">');
    expect(source).toContain('"truncate whitespace-nowrap"');
    expect(source).toContain("open Review to read the full trace and guide before recording a ruling");
    expect(source).toContain('exceptions.length === 0 ? "Queue cleared" : "No matches"');
    expect(source).toContain("navigate(caseReviewUrl(ex.id, ex.capabilityGap)");
  });

  it("keeps a row-level review scoped to its case across refreshes", () => {
    expect(caseReviewUrl("case one", "policy_grounding")).toBe(
      "/review?caseId=case+one&cluster=policy_grounding"
    );
    expect(
      selectReviewCaseIds({
        explicitCaseId: "case_one",
        stateCaseIds: undefined,
        exceptions: [
          { id: "case_one", capabilityGap: "policy_grounding" },
          { id: "case_two", capabilityGap: "policy_grounding" }
        ],
        categoryFilter: "policy_grounding"
      })
    ).toEqual(["case_one"]);
  });

  it("uses truthful judge-category language instead of promising semantic clusters", async () => {
    const [exceptionsSource, dashboardSource] = await Promise.all([
      readFile(new URL("../src/screens/exceptions.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/screens/dashboard.tsx", import.meta.url), "utf8")
    ]);

    expect(exceptionsSource).toContain("Judge category");
    expect(exceptionsSource).toContain("Save this category as a queue");
    expect(exceptionsSource).not.toContain("Queue this cluster");
    expect(dashboardSource).toContain("Exact failure categories supplied by the evaluator");
    expect(dashboardSource).not.toContain("Clusters of disagreement");
    expect(dashboardSource).toContain("High unresolved volume");
    expect(dashboardSource).not.toContain("Skill too strict or lenient");
  });
});
