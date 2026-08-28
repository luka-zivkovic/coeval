import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { DisplayMode } from "../src/lib/display-mode.js";
import * as displayModeModule from "../src/lib/display-mode.js";

let displayMode: DisplayMode = "pm";

vi.mock("@/hooks/use-mode", () => ({
  useMode: () => [displayMode, vi.fn()]
}));
vi.mock("@/lib/display-mode", () => displayModeModule);
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() })
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { name: "Owner", email: "owner@example.com" } } })
}));
vi.mock("@/lib/app-mode", () => ({
  useAppMode: () => ({ demoMode: false })
}));
vi.mock("@/lib/criterion-context", () => ({
  useCriterion: () => ({ href: (path: string) => path })
}));
vi.mock("@/lib/api", () => ({
  fetchProjects: vi.fn(),
  selectProject: vi.fn(),
  selectedProjectId: () => null
}));
vi.mock("@/components/project-create", () => ({
  NewProjectModal: () => null
}));
vi.mock("@/components/coeval-brand", () => ({
  CoevalBrand: () => createElement("span", null, "coeval")
}));

const { Sidebar } = await import("../src/components/layout/sidebar.js");

function renderSidebar(mode: DisplayMode, bench: boolean): string {
  displayMode = mode;
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/"] },
    createElement(Sidebar, { bench })
  ));
}

describe("Settings navigation", () => {
  it("renders a Settings link in every display mode for tracing and bench projects", () => {
    for (const mode of ["pm", "dev", "exec"] as const) {
      for (const bench of [false, true]) {
        const html = renderSidebar(mode, bench);
        expect(html).toContain('href="/settings"');
        expect(html).toContain(">Settings</span>");
      }
    }
  });
});
