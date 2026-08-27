import * as React from "react";
import { Menu } from "lucide-react";

export interface TopbarProps {
  crumbs: React.ReactNode[];
  right?: React.ReactNode;
  navigationOpen?: boolean;
  onOpenNavigation?: () => void;
  navigationTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function Topbar({ crumbs, right, navigationOpen = false, onOpenNavigation, navigationTriggerRef }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex min-w-0 flex-wrap items-center gap-3 border-b border-rule bg-paper px-4 py-3 sm:px-7">
      {onOpenNavigation ? (
        <button
          ref={navigationTriggerRef}
          type="button"
          aria-label="Open workspace navigation"
          aria-controls="workspace-navigation"
          aria-expanded={navigationOpen}
          className="grid size-8 shrink-0 place-items-center rounded-sm border border-rule bg-card lg:hidden"
          onClick={onOpenNavigation}
        >
          <Menu className="size-4" />
        </button>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-[11px] text-ink-3">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <span className="text-ink-3">/</span> : null}
            <span className={i === crumbs.length - 1 ? "truncate text-ink" : "truncate"}>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="flex-1" />
      {right ? <div className="w-full min-w-0 lg:w-auto">{right}</div> : null}
    </header>
  );
}

export function TopbarPill({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-rule bg-card px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2">
      {children}
    </div>
  );
}
