import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import * as criterionSelectionModule from "../src/lib/criterion-selection.js";

vi.mock("../src/components/layout/sidebar.js", () => ({ Sidebar: () => createElement("aside") }));
vi.mock("../src/components/layout/topbar.js", () => ({
  Topbar: ({ right }: { right?: ReactNode }) => createElement("header", null, right),
  TopbarPill: ({ children }: { children?: ReactNode }) => createElement("span", null, children)
}));
vi.mock("@/lib/display-mode", () => ({
  DISPLAY_MODE_BY_VALUE: { pm: { label: "Guided" } }
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => createElement("button", null, children)
}));
vi.mock("@/components/skip-link", () => ({ SkipLink: () => null }));
vi.mock("@/components/import-trace-launcher", () => ({ ImportTraceLauncher: () => null }));
vi.mock("@/components/project-create", () => ({ NoProjectLanding: () => null }));
vi.mock("@/screens/system", () => ({ ApiUnavailableScreen: () => null }));
vi.mock("@/hooks/use-mode", () => ({ useMode: () => ["pm"] }));
vi.mock("@/lib/app-mode", () => ({ useAppMode: () => ({ demoMode: false }) }));
vi.mock("@/lib/dashboard-context", () => ({
  DashboardProvider: ({ children }: { children: ReactNode }) => children,
  useDashboard: () => ({ dashboard: null, errorKind: null, reload: vi.fn() })
}));
vi.mock("@/lib/criterion-context", () => ({
  CriterionProvider: ({ children }: { children: ReactNode }) => children,
  useCriterion: () => ({
    choices: [{ criterion: { id: "criterion_1" } }, { criterion: { id: "criterion_2" } }],
    selectedCriterionId: null,
    selectedChoice: null,
    selectCriterion: vi.fn(),
    selectionRequired: true
  })
}));
vi.mock("@/lib/criterion-selection", () => criterionSelectionModule);
vi.mock("@/screens/criteria", () => ({
  CriterionPicker: () => createElement("div", null, "criterion-picker")
}));
vi.mock("@/lib/journey", () => ({ isBench: () => false, journeyActStates: vi.fn() }));

const { RootLayout } = await import("../src/components/layout/root-layout.js");

function renderRoute(path: string): string {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(
      Routes,
      null,
      createElement(
        Route,
        { element: createElement(RootLayout) },
        createElement(Route, { path, element: createElement("div", null, `${path}-route-content`) })
      )
    )
  ));
}

describe("project-level route criterion gate", () => {
  it("renders a direct Settings route before a multi-criterion choice exists", () => {
    const html = renderRoute("/settings");
    expect(html).toContain("/settings-route-content");
    expect(html).not.toContain("criterion-picker");
  });

  it("continues to require a criterion for evaluator-scoped routes", () => {
    const html = renderRoute("/skill");
    expect(html).toContain("criterion-picker");
    expect(html).not.toContain("/skill-route-content");
  });
});
