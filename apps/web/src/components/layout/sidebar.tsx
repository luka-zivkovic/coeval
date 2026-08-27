import { useEffect, useId, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Flag,
  FileCog,
  Star,
  Database,
  Plug,
  ListChecks,
  Inbox,
  Scale,
  Settings as SettingsIcon,
  Check,
  ChevronDown,
  Plus,
  Layers3,
  ShieldCheck,
  Microscope
} from "lucide-react";
import { useTheme } from "next-themes";
import { NewProjectModal } from "@/components/project-create";
import { fetchProjects, selectProject, selectedProjectId } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useAppMode } from "@/lib/app-mode";
import { useCriterion } from "@/lib/criterion-context";
import { useMode } from "@/hooks/use-mode";
import { DISPLAY_MODE_BY_VALUE, DISPLAY_MODE_OPTIONS, workspaceRouteVisible } from "@/lib/display-mode";
import { cn } from "@/lib/utils";
import type { JourneyActState, JourneyActStates } from "@/lib/journey";
import { GOLDEN_GATE_RECOMMENDED, type Project } from "@coeval/shared";

interface JourneyNavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  withBadge?: boolean;
}

interface JourneyNavGroup {
  label: string;
  act?: keyof JourneyActStates;
  items: JourneyNavItem[];
}

// The numbered acts describe the legacy operational loop only. Governed
// analysis/truth and ungoverned diagnostics stay outside those checkmarked
// groups so a trace count or golden-set size cannot imply stronger evidence.
const TRACING_NAV: JourneyNavGroup[] = [
  { label: "Journey", items: [{ to: "/", label: "Overview", icon: LayoutDashboard, end: true }] },
  { label: "1 · Define good", act: "defineGood", items: [
    { to: "/criteria", label: "Criteria", icon: Layers3 },
    { to: "/skill", label: "Review guide", icon: FileCog }
  ] },
  { label: "Governed lifecycle", items: [
    { to: "/analyze", label: "Analyze · find failures", icon: Microscope },
    { to: "/human-truth", label: "Human truth · governed", icon: ShieldCheck }
  ] },
  {
    label: "2 · Operational triage",
    act: "judgeRealWork",
    items: [
      { to: "/traces", label: "Live traces", icon: ListChecks },
      { to: "/exceptions", label: "Needs a human · ungoverned", icon: Flag, withBadge: true },
      { to: "/review-queues", label: "Review sessions · ungoverned", icon: Inbox },
      { to: "/datasets", label: "Saved datasets", icon: Database }
    ]
  },
  {
    label: "3 · Guard known failures",
    act: "earnTrust",
    items: [
      { to: "/golden", label: "Golden set", icon: Star }
    ]
  },
  { label: "Ungoverned diagnostics", items: [
    { to: "/reliability", label: "Reliability signals", icon: Scale }
  ] }
];

const BENCH_NAV: JourneyNavGroup[] = [
  { label: "Journey", items: [{ to: "/", label: "Overview", icon: LayoutDashboard, end: true }] },
  { label: "1 · Define good", act: "defineGood", items: [
    { to: "/criteria", label: "Criteria", icon: Layers3 },
    { to: "/skill", label: "Review guide", icon: FileCog }
  ] },
  { label: "Governed lifecycle", items: [
    { to: "/analyze", label: "Analyze · find failures", icon: Microscope },
    { to: "/human-truth", label: "Human truth · governed", icon: ShieldCheck }
  ] },
  {
    label: "2 · Operational triage",
    act: "judgeRealWork",
    items: [
      { to: "/datasets", label: "Examples & runs", icon: Database },
      { to: "/exceptions", label: "Needs a human · ungoverned", icon: Flag, withBadge: true }
    ]
  },
  {
    label: "3 · Guard known failures",
    act: "earnTrust",
    items: [
      { to: "/golden", label: "Golden set", icon: Star }
    ]
  },
  { label: "Ungoverned diagnostics", items: [
    { to: "/reliability", label: "Reliability signals", icon: Scale }
  ] }
];

const SYS_ITEMS = [
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/settings",     label: "Settings",     icon: SettingsIcon }
];

// Bench keeps Integrations visible as the graduation hook: connecting a
// tracer is how a bench project grows into a trace project — same skill,
// added coverage.
const BENCH_SYS_ITEMS = [
  { to: "/integrations", label: "Integrations · + traces", icon: Plug },
  { to: "/settings",     label: "Settings",     icon: SettingsIcon }
];

export interface SidebarProps {
  projectName?: string;
  projectSource?: string;
  exceptionsCount?: number;
  bench?: boolean;
  journeyActs?: JourneyActStates | undefined;
  goldenSetSize?: number;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({
  projectName = "Coeval",
  projectSource = "—",
  exceptionsCount = 0,
  bench = false,
  journeyActs,
  goldenSetSize = 0,
  mobileOpen = false,
  onMobileClose
}: SidebarProps) {
  const [mode, setMode] = useMode();
  const { href: criterionHref } = useCriterion();
  const navGroups = (bench ? BENCH_NAV : TRACING_NAV)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => workspaceRouteVisible(mode, bench, item.to))
    }))
    .filter((group) => group.items.length > 0);
  const systemItems = (bench ? BENCH_SYS_ITEMS : SYS_ITEMS)
    .filter((item) => workspaceRouteVisible(mode, bench, item.to));
  const { theme, setTheme } = useTheme();
  const session = useSession();
  const userName = session.data?.user?.name ?? "Operator";
  const initial = (userName[0] ?? "C").toUpperCase();
  const role = session.data?.user?.email ?? "Skill owner";

  return (
    <aside
      id="workspace-navigation"
      aria-label="Workspace sidebar"
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex w-[min(85vw,232px)] h-dvh flex-col overflow-y-auto border-r border-rule bg-paper-2 pt-[18px] pb-3.5 shadow-[var(--shadow-elev)] transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-auto lg:translate-x-0 lg:visible lg:shadow-none",
        mobileOpen
          ? "visible translate-x-0"
          : "invisible -translate-x-full [transition:transform_200ms,visibility_0s_200ms]"
      )}
      tabIndex={-1}
    >
      <div className="flex items-baseline gap-2.5 border-b border-rule-soft px-[22px] pt-1 pb-[18px] mb-3.5">
        <div className="font-serif text-[17px] font-semibold tracking-[-0.025em] text-ink">
          <span className="text-signal">c</span>oeval
        </div>
        <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">v0.4 · Audit</div>
      </div>

      <ProjectSwitcher projectName={projectName} projectSource={projectSource} />

      <nav aria-label="Project navigation">
        {navGroups.map((group) => (
          <NavSection
            key={group.label}
            label={group.act === "earnTrust"
              ? `${group.label} · ${Math.min(goldenSetSize, GOLDEN_GATE_RECOMMENDED)}/${GOLDEN_GATE_RECOMMENDED}`
              : group.label}
            state={group.act ? journeyActs?.[group.act] : undefined}
          >
            {group.items.map((item) => {
              const showBadge = item.withBadge && exceptionsCount > 0;
              return (
                <NavItem
                  key={item.to}
                  to={criterionHref(item.to)}
                  icon={<item.icon className="h-3.5 w-3.5" />}
                  label={item.label}
                  {...(showBadge ? { badge: exceptionsCount, badgeSignal: true } : {})}
                  {...(item.end ? { end: true } : {})}
                  onNavigate={onMobileClose}
                />
              );
            })}
          </NavSection>
        ))}

        {systemItems.length > 0 ? (
          <NavSection label="System">
            {systemItems.map((item) => (
              <NavItem key={item.to} to={criterionHref(item.to)} icon={<item.icon className="h-3.5 w-3.5" />} label={item.label} onNavigate={onMobileClose} />
            ))}
          </NavSection>
        ) : null}
      </nav>

      <div className="mt-auto border-t border-rule-soft px-3.5 pt-3">
        <div className="eyebrow mb-2">Workspace display</div>
        <div
          role="group"
          aria-label="Workspace display"
          aria-describedby="workspace-display-help"
          className="flex rounded-sm border border-rule bg-paper-3 p-0.5 font-mono text-[9px] uppercase tracking-[0.06em]"
        >
          {DISPLAY_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(
                "flex-1 cursor-pointer border-0 bg-transparent px-1.5 py-1.5 text-ink-3",
                mode === option.value && "bg-card text-ink shadow-[var(--shadow-card)]",
                mode === option.value && option.value === "dev" && "text-dev"
              )}
              aria-pressed={mode === option.value}
              onClick={() => setMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p id="workspace-display-help" className="mt-1.5 text-[10.5px] leading-[1.4] text-ink-4">
          {DISPLAY_MODE_BY_VALUE[mode].description}
        </p>

        <div className="mt-3 flex items-center gap-2.5 text-[12px] text-ink-2">
          <div className="grid h-[22px] w-[22px] place-items-center rounded-full bg-ink text-[11px] font-medium text-paper">
            {initial}
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="truncate">{userName}</div>
            <div className="font-mono text-[10px] text-ink-4 truncate">{role}</div>
          </div>
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="ml-auto cursor-pointer border border-rule-soft bg-transparent px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3 hover:bg-paper-3"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </div>
    </aside>
  );
}

// P0-2: a switcher that actually switches. Projects load when the popover
// opens; picking one pins it (x-coeval-project on every call) and reloads so
// every cached surface re-resolves. In demo mode the popover still lists the
// single seeded project — the affordance is real either way.
function ProjectSwitcher({ projectName, projectSource }: { projectName: string; projectSource: string }) {
  const { demoMode } = useAppMode();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const current = selectedProjectId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(project: Project) {
    selectProject(project.id);
    window.location.assign("/");
  }

  return (
    <div ref={wrapRef} className="relative mx-3.5 mb-[18px]">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Switch project — ${projectName}`}
        aria-expanded={open}
        aria-controls={popoverId}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-sm border border-rule bg-card px-3 py-2.5 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-ink" />
        <div className="flex min-w-0 flex-col">
          <div className="text-[12.5px] font-medium truncate">{projectName}</div>
          <div className="font-mono text-[10px] text-ink-4 truncate">{projectSource}</div>
        </div>
        <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-ink-4" />
      </button>

      {open ? (
        <div id={popoverId} className="fadeUp absolute left-0 top-full z-40 mt-1 w-[280px] rounded-sm border border-rule bg-card py-1.5 shadow-[var(--shadow-elev)]">
          {projects === null && !loadError ? (
            <div className="px-3.5 py-2.5 text-[12px] text-ink-3">Loading projects…</div>
          ) : loadError ? (
            <div role="alert" className="px-3.5 py-2.5 text-[12px] text-signal">{loadError}</div>
          ) : (
            (projects ?? []).map((p) => {
              const active = current ? p.id === current : p.name === projectName;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left hover:bg-card-2",
                    active && "bg-card-2"
                  )}
                  aria-current={active ? "true" : undefined}
                  onClick={() => pick(p)}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-ink" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                    <span className="truncate font-mono text-[10px] text-ink-4">
                      {p.mode === "bench"
                        ? `Judge a dataset · ${p.importedTraceCount.toLocaleString()} examples`
                        : `Judge live traces · ${p.importedTraceCount.toLocaleString()} traces`}
                    </span>
                  </span>
                  {active ? <Check className="h-3 w-3 shrink-0" /> : null}
                </button>
              );
            })
          )}
          <div className="my-1.5 border-t border-rule-soft" />
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left hover:bg-card-2"
            onClick={() => {
              setOpen(false);
              setShowNew(true);
            }}
          >
            <Plus className="h-3 w-3" />
            <span className="text-[12.5px]">New project</span>
            <span className="ml-auto font-mono text-[10px] text-ink-4">
              {demoMode ? "auth mode only" : ""}
            </span>
          </button>
        </div>
      ) : null}

      {showNew ? (
        <NewProjectModal
          onClose={() => {
            setShowNew(false);
            window.requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}

function NavSection({ label, state, children }: { label: string; state?: JourneyActState | undefined; children: React.ReactNode }) {
  return (
    <div className="mb-2.5 px-3.5">
      <div className="flex items-center px-2 pb-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-4">
        <span>{label}</span>
        {state === "done" ? <Check className="ml-auto size-3" /> : null}
        {state === "now" ? <span className="ml-auto text-signal">now</span> : null}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  badgeSignal?: boolean;
  end?: boolean;
  onNavigate?: (() => void) | undefined;
}

function NavItem({ to, icon, label, badge, badgeSignal, end, onNavigate }: NavItemProps) {
  return (
    <NavLink to={to} {...(end ? { end: true } : {})} className="block" onClick={onNavigate}>
      {({ isActive }) => (
        <div
          className={cn(
            "relative flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-[7px] text-[13px] text-ink-2 select-none",
            isActive ? "bg-card text-ink" : "hover:bg-paper-3"
          )}
        >
          {isActive ? (
            <span className="absolute -left-3.5 top-1.5 bottom-1.5 w-[2px] bg-ink" />
          ) : null}
          <span className={cn(isActive ? "text-ink" : "text-ink-3")}>{icon}</span>
          <span>{label}</span>
          {badge != null && badge > 0 ? (
            <span
              className={cn(
                "ml-auto font-mono text-[10px]",
                badgeSignal ? "text-signal" : isActive ? "text-ink-2" : "text-ink-4"
              )}
            >
              {badge}
            </span>
          ) : null}
        </div>
      )}
    </NavLink>
  );
}
