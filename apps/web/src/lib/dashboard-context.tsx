import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { DashboardSummary } from "@coeval/shared";
import { ApiError, fetchDashboard, selectedProjectId, selectProject } from "@/lib/api";
import { useCriterion } from "@/lib/criterion-context";

// P0-2: "API unavailable", "no project", "not signed in", and "empty project"
// are four different states — the shell must not blur them into one. Empty
// project is not an error at all (the day-0 journey handles it); the other
// three are classified here so layouts can render distinct shells.
export type DashboardErrorKind = "unavailable" | "no-project" | "unauthorized";

interface DashboardContextValue {
  dashboard: DashboardSummary | null;
  loading: boolean;
  error: string | null;
  errorKind: DashboardErrorKind | null;
  reload: () => Promise<void>;
  // Silent revalidation for mutating flows (example/trace imports, eval-run
  // completion): updates counts/journey without flipping `loading` (no shell
  // flash) and keeps the last-good dashboard on transient failure — the next
  // explicit reload surfaces real errors. Without this, topbar counts and
  // journey-stage branches stay stale until a hard reload (M0 C4).
  refresh: () => Promise<void>;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

function classify(err: unknown): { message: string; kind: DashboardErrorKind } {
  if (err instanceof ApiError) {
    if (err.status === 401) return { message: err.message, kind: "unauthorized" };
    if (err.status === 403) return { message: err.message, kind: "no-project" };
    return { message: err.message, kind: "unavailable" };
  }
  return { message: err instanceof Error ? err.message : String(err), kind: "unavailable" };
}

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const { selectedCriterionId, loading: criteriaLoading, selectionRequired } = useCriterion();
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<DashboardErrorKind | null>(null);

  const reload = useCallback(async () => {
    if (criteriaLoading || selectionRequired) {
      setDashboard(null);
      setLoading(criteriaLoading);
      setError(null);
      setErrorKind(null);
      return;
    }
    setLoading(true);
    setError(null);
    setErrorKind(null);
    try {
      setDashboard(await fetchDashboard(selectedCriterionId ?? undefined));
    } catch (err) {
      // A stale project pin (deleted project, revoked membership) must not
      // strand the app — drop the pin and retry on the server default once.
      if (err instanceof ApiError && err.status === 403 && selectedProjectId()) {
        selectProject(null);
        try {
          setDashboard(await fetchDashboard(selectedCriterionId ?? undefined));
          setLoading(false);
          return;
        } catch (retryErr) {
          err = retryErr;
        }
      }
      const { message, kind } = classify(err);
      setDashboard(null);
      setError(message);
      setErrorKind(kind);
    } finally {
      setLoading(false);
    }
  }, [criteriaLoading, selectedCriterionId, selectionRequired]);

  const refresh = useCallback(async () => {
    if (criteriaLoading || selectionRequired) return;
    try {
      setDashboard(await fetchDashboard(selectedCriterionId ?? undefined));
    } catch {
      // Keep the last-good dashboard; background refreshes never degrade the
      // shell. Real failures surface on the next explicit reload/navigation.
    }
  }, [criteriaLoading, selectedCriterionId, selectionRequired]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A criterion switch changes the identity of every dashboard surface. Do
  // not expose the previous criterion's last-good dashboard during the new
  // request; consumers must remain empty until the matching evaluator lands.
  const scopedDashboard = selectedCriterionId && dashboard?.skill.criterionId !== selectedCriterionId
    ? null
    : dashboard;

  return (
    <DashboardContext.Provider value={{ dashboard: scopedDashboard, loading, error, errorKind, reload, refresh }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    throw new Error("useDashboard must be used inside DashboardProvider");
  }
  return ctx;
}
