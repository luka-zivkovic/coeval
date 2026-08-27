import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Criterion, CriterionDetail } from "@coeval/shared";
import { ApiError, fetchCriteria, fetchCriterionDetail, selectedProjectId, selectProject } from "@/lib/api";
import {
  CRITERION_QUERY_PARAM,
  criterionSelectionStorageKey,
  resolveCriterionSelection,
  withCriterionSearch,
} from "@/lib/criterion-selection";

export interface CriterionChoice {
  criterion: Criterion;
  detail: CriterionDetail | null;
  name: string;
  definition: string | null;
  revision: number | null;
}

interface CriterionContextValue {
  criteria: Criterion[];
  choices: CriterionChoice[];
  selectedCriterionId: string | null;
  selectedChoice: CriterionChoice | null;
  loading: boolean;
  error: string | null;
  selectionRequired: boolean;
  selectCriterion: (criterionId: string) => void;
  href: (pathname: string) => string;
  reload: () => Promise<void>;
}

const CriterionContext = createContext<CriterionContextValue | null>(null);

function readPersisted(projectId: string | null): string | null {
  try {
    return localStorage.getItem(criterionSelectionStorageKey(projectId));
  } catch {
    return null;
  }
}

function persist(projectId: string | null, criterionId: string): void {
  try {
    localStorage.setItem(criterionSelectionStorageKey(projectId), criterionId);
  } catch {
    // URL state remains authoritative when storage is unavailable.
  }
}

export function CriterionProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const pinnedProjectId = selectedProjectId();
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [details, setDetails] = useState<Record<string, CriterionDetail>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const projectId = pinnedProjectId ?? criteria[0]?.projectId ?? null;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let rows: Criterion[];
      try {
        rows = await fetchCriteria();
      } catch (cause) {
        // Match dashboard recovery: a deleted/revoked project pin should not
        // strand criterion discovery on a 403. Retry against the server's
        // current default project after dropping only the stale local pin.
        if (!(cause instanceof ApiError) || cause.status !== 403 || !selectedProjectId()) throw cause;
        selectProject(null);
        rows = await fetchCriteria();
      }
      setCriteria(rows);
      const settled = await Promise.allSettled(rows.map((criterion) => fetchCriterionDetail(criterion.id)));
      const next: Record<string, CriterionDetail> = {};
      for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") next[rows[index]!.id] = result.value;
      }
      setDetails(next);
    } catch (cause) {
      setCriteria([]);
      setDetails({});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const queryCriterionId = useMemo(
    () => new URLSearchParams(location.search).get(CRITERION_QUERY_PARAM),
    [location.search],
  );
  const selectedCriterionId = resolveCriterionSelection(
    criteria.map((criterion) => criterion.id),
    queryCriterionId,
    readPersisted(projectId),
  );

  useEffect(() => {
    if (!selectedCriterionId) return;
    persist(projectId, selectedCriterionId);
    if (queryCriterionId === selectedCriterionId) return;
    navigate(
      { pathname: location.pathname, search: withCriterionSearch(location.search, selectedCriterionId) },
      { replace: true },
    );
  }, [location.pathname, location.search, navigate, projectId, queryCriterionId, selectedCriterionId]);

  const choices = useMemo<CriterionChoice[]>(() => criteria.map((criterion) => {
    const detail = details[criterion.id] ?? null;
    const latest = detail ? [...detail.versions].sort((left, right) => right.revision - left.revision)[0] ?? null : null;
    return {
      criterion,
      detail,
      name: latest?.name ?? criterion.stableKey,
      definition: latest?.definition ?? null,
      revision: latest?.revision ?? null,
    };
  }), [criteria, details]);

  const selectCriterion = useCallback((criterionId: string) => {
    if (!criteria.some((criterion) => criterion.id === criterionId)) return;
    persist(projectId, criterionId);
    navigate(
      { pathname: location.pathname, search: withCriterionSearch(location.search, criterionId) },
      { replace: true },
    );
  }, [criteria, location.pathname, location.search, navigate, projectId]);

  const href = useCallback((pathname: string) => {
    return `${pathname}${withCriterionSearch("", selectedCriterionId)}`;
  }, [selectedCriterionId]);

  const selectedChoice = choices.find((choice) => choice.criterion.id === selectedCriterionId) ?? null;
  const value: CriterionContextValue = {
    criteria,
    choices,
    selectedCriterionId,
    selectedChoice,
    loading,
    error,
    selectionRequired: !loading && criteria.length > 1 && selectedCriterionId === null,
    selectCriterion,
    href,
    reload,
  };

  return <CriterionContext.Provider value={value}>{children}</CriterionContext.Provider>;
}

export function useCriterion(): CriterionContextValue {
  const value = useContext(CriterionContext);
  if (!value) throw new Error("useCriterion must be used inside CriterionProvider");
  return value;
}
