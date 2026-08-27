import { Link, Outlet, useLocation } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { SkipLink } from "../components/skip-link";

/**
 * Security-sensitive reviewer shell. It intentionally sits outside
 * RootLayout, CriterionProvider, and DashboardProvider, and therefore cannot
 * enrich the frozen task view from trace, case, evaluator, or queue surfaces.
 */
export function BlindReviewLayout() {
  const location = useLocation();
  const inTask = location.pathname !== "/governed-review/tasks";

  return (
    <div className="min-h-screen bg-paper text-ink">
      <SkipLink />
      <header className="border-b border-rule bg-paper-2">
        <div className="mx-auto flex min-h-14 max-w-[1080px] items-center gap-4 px-5">
          <Link
            to="/governed-review/tasks"
            className="font-serif text-[17px] font-semibold tracking-[-0.025em] text-ink"
            aria-label="Governed review task inbox"
          >
            <span className="text-signal">c</span>oeval
          </Link>
          <span className="h-5 w-px bg-rule" aria-hidden="true" />
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
            <ShieldCheck className="size-3.5 text-signal" aria-hidden="true" />
            Blind review workspace
          </div>
          {inTask ? (
            <Link
              to="/governed-review/tasks"
              className="ml-auto rounded-sm border border-rule bg-card px-3 py-1.5 text-[12px] text-ink-2 hover:bg-card-2"
            >
              Task inbox
            </Link>
          ) : null}
        </div>
      </header>
      <div className="border-b border-gold-tint bg-ambig-bg px-5 py-2 text-center font-mono text-[10px] tracking-[0.04em] text-gold">
        Frozen reviewer view · no evaluator, peer, expected-label, trace, or adjudication context before labeling closes
      </div>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1080px] px-5 py-8 outline-none">
        <Outlet />
      </main>
    </div>
  );
}
