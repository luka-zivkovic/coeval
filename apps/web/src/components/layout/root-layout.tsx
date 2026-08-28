import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Sidebar } from "./sidebar";
import { Topbar, TopbarPill } from "./topbar";
import { DISPLAY_MODE_BY_VALUE } from "@/lib/display-mode";
import { Button } from "@/components/ui/button";
import { SkipLink } from "@/components/skip-link";
import { ImportTraceLauncher } from "@/components/import-trace-launcher";
import { NoProjectLanding } from "@/components/project-create";
import { ApiUnavailableScreen } from "@/screens/system";
import { useMode } from "@/hooks/use-mode";
import { useAppMode } from "@/lib/app-mode";
import { DashboardProvider, useDashboard } from "@/lib/dashboard-context";
import { CriterionProvider, useCriterion } from "@/lib/criterion-context";
import { routeRequiresCriterionSelection } from "@/lib/criterion-selection";
import { CriterionPicker } from "@/screens/criteria";
import { isBench, journeyActStates } from "@/lib/journey";

const CRUMBS: Record<string, string[]> = {
  "/":               ["Overview"],
  "/traces":         ["Traces"],
  "/exceptions":     ["Exceptions"],
  "/reliability":    ["Reliability"],
  "/review-queues":  ["Review queues"],
  "/criteria":       ["Criteria"],
  "/skill":          ["Skill"],
  "/skill/versions": ["Skill versions"],
  "/first-result":   ["First Result"],
  "/golden":         ["Golden set"],
  "/datasets":       ["Datasets"],
  "/integrations":   ["Integrations"],
  "/settings":       ["Settings"]
};

function crumbsFor(pathname: string, projectName: string, bench: boolean): string[] {
  for (const [prefix, value] of Object.entries(CRUMBS)) {
    if (pathname === prefix || (prefix !== "/" && pathname.startsWith(prefix))) {
      if (prefix === "/exceptions" && pathname !== "/exceptions") {
        return [projectName, "Exceptions", "Trace"];
      }
      if (bench && prefix === "/datasets") return [projectName, "Examples"];
      return [projectName, ...value];
    }
  }
  return [projectName];
}

export function RootLayout() {
  return (
    <CriterionProvider>
      <DashboardProvider>
        <RootLayoutInner />
      </DashboardProvider>
    </CriterionProvider>
  );
}

function RootLayoutInner() {
  const [mode] = useMode();
  const location = useLocation();
  const { dashboard, errorKind, reload } = useDashboard();
  const {
    choices,
    selectedCriterionId,
    selectedChoice,
    selectCriterion,
    selectionRequired,
  } = useCriterion();
  const { demoMode } = useAppMode();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);

  const bench = dashboard ? isBench(dashboard.project) : false;
  const projectName = dashboard?.project.name ?? "Coeval";
  // The bench subtitle doubles as the persistent honesty marker: no
  // production traces back these numbers, only supplied examples.
  const projectSource = dashboard
    ? bench
      ? `Judge a dataset · ${dashboard.project.importedTraceCount.toLocaleString()} examples · no production traces`
      : `Judge live traces · ${dashboard.project.traceProvider} · ${dashboard.project.importedTraceCount.toLocaleString()} traces`
    : "—";
  const exceptionsCount = dashboard?.exceptions.length ?? 0;
  const importedTotal = dashboard?.project.importedTraceCount ?? 0;
  const criterionSelectionRequiredForRoute = routeRequiresCriterionSelection(location.pathname);
  const showCriterionPicker = selectionRequired && criterionSelectionRequiredForRoute;

  const crumbs = useMemo(() => crumbsFor(location.pathname, projectName, bench), [location.pathname, projectName, bench]);

  useEffect(() => {
    setNavigationOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!navigationOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setNavigationOpen(false);
      window.requestAnimationFrame(() => navigationTriggerRef.current?.focus());
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => document.getElementById("workspace-navigation")?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [navigationOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeDrawerAtDesktop = () => {
      if (desktop.matches) setNavigationOpen(false);
    };
    closeDrawerAtDesktop();
    desktop.addEventListener("change", closeDrawerAtDesktop);
    return () => desktop.removeEventListener("change", closeDrawerAtDesktop);
  }, []);

  // P0-2 shell taxonomy — these are different states and get different
  // screens. "Empty project" is NOT here: that's the day-0 journey, handled
  // by the screens themselves. 401 is handled by AuthGate above the router.
  // (Hooks above must run unconditionally — keep these returns below them.)
  if (!dashboard && errorKind === "no-project") {
    return <NoProjectLanding />;
  }
  if (!dashboard && errorKind === "unavailable") {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <ApiUnavailableScreen retry={() => void reload()} />
      </div>
    );
  }

  return (
    <div className={`grid min-h-screen grid-cols-1 lg:grid-cols-[232px_minmax(0,1fr)] ${mode === "dev" ? "dev" : ""}`}>
      <SkipLink />
      {navigationOpen ? (
        <button
          type="button"
          aria-label="Close workspace navigation"
          aria-hidden="true"
          tabIndex={-1}
          className="fixed inset-0 z-30 cursor-default bg-ink/35 lg:hidden"
          onClick={() => {
            setNavigationOpen(false);
            window.requestAnimationFrame(() => navigationTriggerRef.current?.focus());
          }}
        />
      ) : null}
      <Sidebar
        projectName={projectName}
        projectSource={projectSource}
        exceptionsCount={exceptionsCount}
        bench={bench}
        journeyActs={dashboard ? journeyActStates(dashboard) : undefined}
        goldenSetSize={dashboard?.goldenSetSize ?? 0}
        mobileOpen={navigationOpen}
        onMobileClose={() => setNavigationOpen(false)}
      />
      <main id="main-content" tabIndex={-1} inert={navigationOpen} className="flex min-w-0 flex-col outline-none">
        <Topbar
          crumbs={crumbs}
          navigationOpen={navigationOpen}
          navigationTriggerRef={navigationTriggerRef}
          onOpenNavigation={() => setNavigationOpen(true)}
          right={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
              {demoMode ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-sm border border-gold-tint bg-ambig-bg px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-gold"
                  title="Running on in-memory demo fixtures — no auth, data resets on API restart."
                >
                  Demo mode
                </span>
              ) : null}
              {dashboard ? (bench ? <AddExamplesLauncher /> : <ImportTraceLauncher />) : null}
              {choices.length > 1 && selectedCriterionId ? (
                <label className="flex min-w-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
                  Criterion
                  <select
                    aria-label="Selected criterion"
                    value={selectedCriterionId}
                    onChange={(event) => selectCriterion(event.target.value)}
                    className="min-w-0 max-w-48 rounded-sm border border-rule bg-card px-2 py-1 text-[11px] normal-case tracking-normal text-ink"
                  >
                    {choices.map((choice) => (
                      <option key={choice.criterion.id} value={choice.criterion.id}>{choice.name}</option>
                    ))}
                  </select>
                </label>
              ) : selectedChoice ? (
                <span className="font-mono text-[10px] text-ink-3">criterion · {selectedChoice.name}</span>
              ) : null}
              <div className="hidden font-mono text-[10.5px] text-ink-3 xl:block">
                <b className="font-medium text-ink">{importedTotal.toLocaleString()}</b> {bench ? "examples" : "traces this week"}
                <span className="text-ink-3"> · </span>
                <b className={`font-medium ${exceptionsCount > 0 ? "text-signal" : "text-ink"}`}>{exceptionsCount}</b> exceptions
              </div>
              <div className="hidden sm:block"><TopbarPill>
                {DISPLAY_MODE_BY_VALUE[mode].label} display
              </TopbarPill></div>
            </div>
          }
        />
        <div className="min-w-0 w-full max-w-none px-5 pt-7 pb-20 sm:px-8 xl:px-12 xl:pt-9">
          {showCriterionPicker ? (
            <CriterionPicker
              choices={choices}
              selectedCriterionId={selectedCriterionId}
              onSelect={selectCriterion}
            />
          ) : !dashboard && criterionSelectionRequiredForRoute ? (
            <div className="max-w-[1760px] rounded-sm border border-rule-soft bg-card p-12 text-center text-[12.5px] text-ink-3">
              Loading the selected criterion’s evaluator and evidence…
            </div>
          ) : (
            <Outlet />
          )}
        </div>
      </main>
    </div>
  );
}

// Bench replaces the paste-a-trace modal with the Examples hub: examples are
// added in bulk with expected labels there, and are never auto-judged.
function AddExamplesLauncher() {
  const navigate = useNavigate();
  return (
    <Button
      variant="default"
      size="sm"
      onClick={() => navigate("/datasets?add=1")}
      title="Paste example cases with expected labels — judged only when you run an eval"
    >
      <Plus /> Add examples
    </Button>
  );
}
