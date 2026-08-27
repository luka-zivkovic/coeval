import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAnalysisPopulation,
  fetchAnalysisPopulationExclusions,
  fetchAnalysisPopulationMembers,
  fetchAnalysisPopulationOverlaps,
  fetchAnalysisPopulations,
  fetchAnalysisPopulationSelectedContent,
  fetchAnalysisPopulationSelections
} from "../src/lib/analysis-population-api.js";
import { AnalysisPopulationRequestCoordinator } from "../src/lib/analysis-population-request-coordinator.js";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardContent: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardHeader: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardTitle: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never)
}));
vi.mock("@/components/ui/input", () => ({ Input: (props: object) => createElement("input", props) }));
vi.mock("@/components/coeval", () => ({
  SectionHead: ({ title, sub }: { title: string; sub: string }) => createElement("header", null, title, sub)
}));
vi.mock("@/components/database-mode-required", () => ({
  DatabaseModeRequired: () => createElement("div", null)
}));
vi.mock("@/lib/app-mode", () => ({
  useAppMode: () => ({ authEnabled: true, demoMode: false })
}));
vi.mock("@/lib/analysis-population-api", () => ({
  createAnalysisPopulation: vi.fn(),
  fetchAnalysisPopulation: vi.fn(),
  fetchAnalysisPopulationExclusions: vi.fn(),
  fetchAnalysisPopulationMembers: vi.fn(),
  fetchAnalysisPopulationOverlaps: vi.fn(),
  fetchAnalysisPopulations: vi.fn(),
  fetchAnalysisPopulationSelectedContent: vi.fn(),
  fetchAnalysisPopulationSelections: vi.fn()
}));
vi.mock("@/lib/analysis-population-request-coordinator", () => ({
  AnalysisPopulationRequestCoordinator: class {}
}));
vi.mock("@/lib/analyze-journey", () => ({
  defaultAnalysisWindowEnd: () => new Date("2026-08-20T11:58:00.000Z")
}));
vi.mock("@/screens/analysis-study-workspace", () => ({
  AnalysisStudyWorkspace: () => createElement("div", null)
}));

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const timestamp = "2026-08-20T12:00:00.000Z";
const population = {
  id: "population_1",
  projectId: "project_1",
  datasetRevisionId: "revision_1",
  windowStart: "2026-08-19T00:00:00.000Z",
  windowEnd: "2026-08-20T00:00:00.000Z",
  eligibleSources: ["manual", "langsmith", "langfuse", "ironside"],
  eligibleIngestionPurposes: [
    "analysis_eligible_manual",
    "analysis_eligible_langsmith",
    "analysis_eligible_langfuse",
    "analysis_eligible_ironside"
  ],
  canonicalizationVersion: "governed-content-json/v1",
  orderingVersion: "cases-created-at-id/v1",
  populationSize: 1,
  exclusionCount: "1",
  frameDigest: sha("1"),
  contentDigest: sha("2"),
  snapshotXid8: "1:2:",
  snapshotTakenAt: timestamp,
  createdByUserId: "user_1",
  createdBySubjectId: "subject_1",
  createdAt: timestamp
} as const;
const draw = {
  id: "draw_1",
  projectId: "project_1",
  populationId: "population_1",
  datasetRevisionId: "revision_1",
  method: "simple_random",
  stoppingRule: "fixed",
  drawExecutor: "coeval_server",
  seed: "0".repeat(64),
  rngVersion: "sha256-rank/v1",
  algorithmVersion: "coeval-analysis-draw/v1",
  fixedBudget: 1,
  populationSize: 1,
  inclusionProbability: { numerator: 1, denominator: 1 },
  drawDigest: sha("3"),
  contentDigest: sha("4"),
  executedBySubjectId: "subject_1",
  executedAt: timestamp
} as const;
const claim = {
  drawnFromPopulationId: "population_1",
  representativeOfPopulationId: null,
  representativeReason: "coding_not_complete"
} as const;
const summary = { population, draw, claim };
const selection = {
  id: "selection_1",
  projectId: "project_1",
  drawId: "draw_1",
  populationId: "population_1",
  memberId: "member_1",
  revisionItemId: "revision_item_1",
  caseId: "case_1",
  position: 0,
  frameMemberDigest: sha("5"),
  rankDigest: sha("6"),
  contentDigest: sha("7"),
  createdAt: timestamp
} as const;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}

describe("analysis population web boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps metadata reads payload-free until one explicit selected-content action", async () => {
    const calls: string[] = [];
    const responses = [
      { page: { items: [summary], totalCount: "1", nextCursor: null } },
      { detail: { ...summary, overlapCount: "0" } },
      { page: { items: [], totalCount: 1, nextCursor: null } },
      { page: { items: [selection], totalCount: 1, nextCursor: null } },
      { page: { items: [], totalCount: "1", nextCursor: null } },
      { page: { items: [], totalCount: "0", nextCursor: null } },
      { content: {
        populationId: "population_1",
        datasetRevisionId: "revision_1",
        memberId: "member_1",
        revisionItemId: "revision_item_1",
        caseId: "case_1",
        drawPosition: 0,
        inputDigest: sha("8"),
        itemDigest: sha("9"),
        payloadSnapshot: { input: { question: "Refund?" }, output: { answer: "Thirty days." }, metadata: {} }
      } }
    ];
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => "project_1") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      calls.push(input);
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch ${input}`);
      return json(response);
    }));

    await fetchAnalysisPopulations();
    await fetchAnalysisPopulation("population_1");
    await fetchAnalysisPopulationMembers("population_1");
    await fetchAnalysisPopulationSelections("population_1");
    await fetchAnalysisPopulationExclusions("population_1");
    await fetchAnalysisPopulationOverlaps("population_1");

    expect(calls).toHaveLength(6);
    expect(calls.some((path) => path.includes("/content"))).toBe(false);

    const content = await fetchAnalysisPopulationSelectedContent("population_1", 0);
    expect(content).toMatchObject({ populationId: "population_1", drawPosition: 0, caseId: "case_1" });
    expect(calls.filter((path) => path.includes("/content"))).toEqual([
      "/api/analysis-populations/population_1/selections/0/content"
    ]);
  });

  it("keeps draw evidence distinct from the later analysis closure", async () => {
    const { PopulationDetail } = await import("../src/screens/analyze.js");
    const html = renderToStaticMarkup(createElement(PopulationDetail, {
      detail: { ...summary, overlapCount: "0" },
      members: [],
      selections: [selection],
      exclusions: [],
      overlaps: [],
      memberCursor: null,
      selectionCursor: null,
      exclusionCursor: null,
      overlapCursor: null,
      content: null,
      contentLoadingPosition: null,
      onViewContent: vi.fn(),
      onMoreMembers: vi.fn(),
      onMoreSelections: vi.fn(),
      onMoreExclusions: vi.fn(),
      onMoreOverlaps: vi.fn()
    }));

    expect(html).toContain("This draw artifact alone does not establish completed review");
    expect(html).toContain("Inspect the linked analysis closure for current review coverage");
    expect(html).toContain("separately from eligible frame N");
    expect(html).not.toMatch(/representative sample|prevalence|coverage rate|population estimate/i);
  });

  it("accepts only the newest deferred population/content response and deduplicates a page cursor", async () => {
    const coordinator = new AnalysisPopulationRequestCoordinator();
    const applied: string[] = [];
    const populationA = coordinator.selectPopulation("population_A");
    const contentA = coordinator.beginContent("population_A")!;
    const pageA = coordinator.beginPage("members", "cursor_A")!;
    expect(coordinator.beginPage("members", "cursor_A")).toBeNull();

    const populationB = coordinator.selectPopulation("population_B");
    const contentBFirst = coordinator.beginContent("population_B")!;
    const contentBLast = coordinator.beginContent("population_B")!;
    const pageB = coordinator.beginPage("members", "cursor_B")!;

    await Promise.resolve();
    if (coordinator.isPopulationCurrent(populationB)) applied.push("detail_B");
    if (coordinator.isContentCurrent(contentBLast)) applied.push("content_B_last");
    if (coordinator.isPopulationCurrent(pageB)) applied.push("page_B");
    if (coordinator.isPopulationCurrent(populationA)) applied.push("detail_A");
    if (coordinator.isContentCurrent(contentA)) applied.push("content_A");
    if (coordinator.isContentCurrent(contentBFirst)) applied.push("content_B_first");
    if (coordinator.isPopulationCurrent(pageA)) applied.push("page_A");

    expect(applied).toEqual(["detail_B", "content_B_last", "page_B"]);
    coordinator.finishPage(pageA);
    coordinator.finishPage(pageB);
    expect(coordinator.beginPage("members", "cursor_B")).not.toBeNull();

    const source = await readFile(new URL("../src/screens/analyze.tsx", import.meta.url), "utf8");
    expect(source).toContain("requestCoordinatorRef.current!.isPopulationCurrent(token)");
    expect(source).toContain("requestCoordinatorRef.current!.isContentCurrent(token)");
    expect(source).toContain("viewContent(detail.population.id, position)");
  });

  it("mounts Analyze in the application and labels its sidebar purpose", async () => {
    const [app, sidebar] = await Promise.all([
      readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/layout/sidebar.tsx", import.meta.url), "utf8")
    ]);
    expect(app).toContain('{ path: "analyze", element: <AnalyzeScreen /> }');
    expect(sidebar).toContain('to: "/analyze"');
    expect(sidebar).toContain('label: "Analyze · find failures"');
  });
});
