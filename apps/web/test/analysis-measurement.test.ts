import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisMeasurementCard } from "../src/components/analysis-measurement-card.js";

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children?: unknown }) => createElement("section", props, children as never),
  CardContent: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardHeader: ({ children, ...props }: { children?: unknown }) => createElement("header", props, children as never),
  CardTitle: ({ children, ...props }: { children?: unknown }) => createElement("h2", props, children as never)
}));
vi.mock("@/lib/analysis-measurement-api", () => ({ fetchAnalysisWorkflowMeasurement: vi.fn() }));

const digest = `sha256:${"a".repeat(64)}`;
const report = {
  contractVersion: "coeval/analysis-workflow-measurement/v1",
  calculationVersion: "analysis-workflow-components/v1",
  projectId: "project",
  studyId: "study",
  populationId: "population",
  drawId: "draw",
  datasetRevisionId: "revision",
  studyCreatedAt: "2026-08-24T00:00:00.000Z",
  studyState: "coding_open",
  coding: {
    selectedItemCount: 1,
    viewedItemCount: 0,
    inProgressItemCount: 0,
    completedItemCount: 0,
    noFailureObservedItemCount: 0,
    missingItemCount: 1
  },
  taxonomy: { state: "not_requested" },
  evaluatorOptions: [],
  evaluator: null,
  reportDigest: digest,
  calculatedAt: "2026-08-24T01:00:00.000Z"
};

describe("analysis component measurement UI", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests exact optional bindings and retains the server project role", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/analysis-measurement-api");
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "project") });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ report, projectRole: "member" }), {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("../src/lib/analysis-measurement-api.js");
    const result = await api.fetchAnalysisWorkflowMeasurement({
      studyId: "study / 1",
      taxonomyRevisionId: "taxonomy",
      skillVersionId: "skill-version"
    });
    expect(result.projectRole).toBe("member");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/analysis-measurements/study%20%2F%201?taxonomyRevisionId=taxonomy&skillVersionId=skill-version",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("renders the no-criterion measurement boundary without composite claims", () => {
    const html = renderToStaticMarkup(createElement(AnalysisMeasurementCard, {
      studyId: "study",
      taxonomyRevisionId: null
    }));
    expect(html).toContain("Versioned component measurements");
    expect(html).toContain("Missing, running, and incomplete evidence");
    expect(html).not.toMatch(/composite score|trusted evaluator|release[- ]ready|pass threshold/i);
  });
});
