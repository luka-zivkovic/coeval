import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockScreenState = {
  demoMode: true,
  useCriterion: vi.fn(() => ({
    choices: [],
    selectedCriterionId: null,
    selectedChoice: null,
    selectCriterion: vi.fn(),
    loading: false,
    error: null,
    reload: vi.fn(),
    href: (path: string) => path
  })),
  useDashboard: vi.fn(() => ({ dashboard: null })),
  fetchAnalysisPopulations: vi.fn(),
  fetchGovernedBatches: vi.fn(),
  fetchGovernedInstructions: vi.fn()
};

const Element = ({ children, ...props }: { children?: unknown }) =>
  createElement("div", props, children as never);

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children?: unknown; to: string }) =>
    createElement("a", { href: to }, children as never),
  useNavigate: () => vi.fn()
}));
vi.mock("@/components/ui/button", () => ({ Button: Element }));
vi.mock("@/components/ui/card", () => ({
  Card: Element,
  CardContent: Element,
  CardHeader: Element,
  CardTitle: Element
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: object) => createElement("input", props)
}));
vi.mock("@/components/coeval", () => ({
  Eyebrow: Element,
  SectionHead: ({ title, sub }: { title: string; sub?: string }) =>
    createElement("header", null, title, sub)
}));
vi.mock("@/components/criterion-picker-list", () => ({ CriterionPickerList: Element }));
vi.mock("@/components/binary-calibration-panel", () => ({ BinaryCalibrationPanel: Element }));
vi.mock("@/components/evaluator-lifecycle-panel", () => ({ EvaluatorLifecyclePanel: Element }));
vi.mock("@/components/database-mode-required", () => ({
  DatabaseModeRequired: ({ title, demoAlternative }: { title: string; demoAlternative: string }) =>
    createElement("section", null, title, demoAlternative)
}));
vi.mock("@/lib/app-mode", () => ({
  useAppMode: () => ({ authEnabled: !mockScreenState.demoMode, demoMode: mockScreenState.demoMode })
}));
vi.mock("@/lib/criterion-context", () => ({
  useCriterion: () => mockScreenState.useCriterion()
}));
vi.mock("@/lib/dashboard-context", () => ({
  useDashboard: () => mockScreenState.useDashboard()
}));
vi.mock("@/lib/analysis-population-api", () => ({
  createAnalysisPopulation: vi.fn(),
  fetchAnalysisPopulation: vi.fn(),
  fetchAnalysisPopulationExclusions: vi.fn(),
  fetchAnalysisPopulationMembers: vi.fn(),
  fetchAnalysisPopulationOverlaps: vi.fn(),
  fetchAnalysisPopulations: (...args: unknown[]) => mockScreenState.fetchAnalysisPopulations(...args),
  fetchAnalysisPopulationSelectedContent: vi.fn(),
  fetchAnalysisPopulationSelections: vi.fn()
}));
vi.mock("@/lib/analysis-population-request-coordinator", () => ({
  AnalysisPopulationRequestCoordinator: class {}
}));
vi.mock("@/lib/analyze-journey", () => ({
  defaultAnalysisWindowEnd: () => new Date("2026-08-20T11:58:00.000Z")
}));
vi.mock("@/screens/analysis-study-workspace", () => ({ AnalysisStudyWorkspace: Element }));
vi.mock("@/lib/governed-review-api", () => ({
  fetchGovernedBatches: (...args: unknown[]) => mockScreenState.fetchGovernedBatches(...args),
  fetchGovernedInstructions: (...args: unknown[]) => mockScreenState.fetchGovernedInstructions(...args),
  transitionGovernedBatch: vi.fn()
}));

describe("persistent-workspace demo boundaries", () => {
  beforeEach(() => {
    mockScreenState.demoMode = true;
    vi.clearAllMocks();
  });

  it("renders the Criteria demo boundary before criterion state is read", async () => {
    const { CriteriaScreen } = await import("../src/screens/criteria.js");
    const html = renderToStaticMarkup(createElement(CriteriaScreen));

    expect(html).toContain("Criterion management needs a persistent workspace.");
    expect(mockScreenState.useCriterion).not.toHaveBeenCalled();

    mockScreenState.demoMode = false;
    expect(renderToStaticMarkup(createElement(CriteriaScreen))).toContain("No criteria yet");
    expect(mockScreenState.useCriterion).toHaveBeenCalledOnce();
  });

  it("renders the Analyze demo boundary without mounting its data workspace", async () => {
    const { AnalyzeScreen } = await import("../src/screens/analyze.js");
    const html = renderToStaticMarkup(createElement(AnalyzeScreen));

    expect(html).toContain("Governed analysis needs a persistent workspace.");
    expect(mockScreenState.fetchAnalysisPopulations).not.toHaveBeenCalled();

    mockScreenState.demoMode = false;
    expect(renderToStaticMarkup(createElement(AnalyzeScreen))).toContain("Analyze");
  });

  it("renders the Human truth demo boundary before criterion, dashboard, or governed clients mount", async () => {
    const { HumanTruthScreen } = await import("../src/screens/human-truth.js");
    const html = renderToStaticMarkup(createElement(HumanTruthScreen));

    expect(html).toContain("Governed human truth needs authenticated reviewers.");
    expect(mockScreenState.useCriterion).not.toHaveBeenCalled();
    expect(mockScreenState.useDashboard).not.toHaveBeenCalled();
    expect(mockScreenState.fetchGovernedBatches).not.toHaveBeenCalled();
    expect(mockScreenState.fetchGovernedInstructions).not.toHaveBeenCalled();

    mockScreenState.demoMode = false;
    expect(renderToStaticMarkup(createElement(HumanTruthScreen))).toContain("Human truth");
    expect(mockScreenState.useCriterion).toHaveBeenCalledOnce();
    expect(mockScreenState.useDashboard).toHaveBeenCalledOnce();
  });
});
