import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  useNavigate,
  useSearchParams
} from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  GitCompareArrows,
  Plus,
  RefreshCcw
} from "lucide-react";
import {
  Card,
  CardContent
} from "@/components/ui/card";
import {
  Button
} from "@/components/ui/button";
import {
  Table
} from "@/components/ui/table";
import {
  RowButton
} from "@/components/row-action";
import {
  Eyebrow,
  SectionHead
} from "@/components/coeval";
import {
  createDatasetRevision,
  createDatasetRevisionEvalRun,
  createEvalRun,
  fetchDatasetDetail,
  fetchDatasetRevisions,
  fetchDatasets,
  fetchEvalRunDetail,
  fetchEvalRuns,
  fetchSkillVersions
} from "@/lib/api";
import {
  useDashboard
} from "@/lib/dashboard-context";
import {
  filterToSkillVersionScope
} from "@/lib/criterion-scope";
import {
  isBench
} from "@/lib/journey";
import {
  computeRunDelta,
  orderRuns,
  type RunDelta
} from "@/lib/run-delta";
import {
  cn,
  formatTimestamp
} from "@/lib/utils";
import {
  type Dataset,
  type DatasetDetail,
  type DatasetRevision,
  type EvalRun,
  type EvalRunDetail
} from "@coeval/shared";
import { AddExamplesModal } from "./datasets/examples.js";
import { DatasetCard, DatasetDetailCard, EvalRunDetailCard, RunDeltaCard } from "./datasets/cards.js";
export { parseExamplesText } from "./datasets/examples.js";

const ACTIVE_RUN_POLL_MS = 4000;

function runProgress(run: EvalRun): string {
  return `${run.completedItems + run.failedItems}/${run.totalItems}`;
}

const RUN_STATUS_TONE: Record<EvalRun["status"], string> = {
  pending: "text-ink-3",
  running: "text-ink",
  completed: "text-ink",
  failed: "text-signal",
  canceled: "text-ink-3"
};

export function DatasetsScreen() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { dashboard, refresh } = useDashboard();
  const skillVersionId = dashboard?.skill.currentVersion.id;
  const skillId = dashboard?.skill.id ?? null;
  const bench = dashboard ? isBench(dashboard.project) : false;
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [scopeVersionIds, setScopeVersionIds] = useState<string[]>([]);
  const [versionNames, setVersionNames] = useState<Record<string, string>>({});
  const [selectedDataset, setSelectedDataset] = useState<DatasetDetail | null>(null);
  const [selectedDatasetRevisions, setSelectedDatasetRevisions] = useState<DatasetRevision[]>([]);
  const [selectedRun, setSelectedRun] = useState<EvalRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState<string | null>(null);
  const [freezing, setFreezing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opened by the topbar "Add examples" launcher (?add=1) or the button here.
  // Synced via effect, not just the initializer: the launcher navigates to
  // /datasets?add=1, which only updates searchParams when this screen is
  // already mounted — a mount-time read alone would make the topbar button a
  // no-op on the screen it points at.
  const [showAdd, setShowAdd] = useState(() => searchParams.get("add") === "1");
  useEffect(() => {
    if (searchParams.get("add") === "1") setShowAdd(true);
  }, [searchParams]);
  const closeAdd = useCallback(() => {
    setShowAdd(false);
    if (searchParams.get("add")) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const load = useCallback(async () => {
    if (!skillId) return;
    setLoading(true);
    setError(null);
    try {
      const [datasetRows, runRows, versionRows] = await Promise.all([
        fetchDatasets(),
        fetchEvalRuns(),
        fetchSkillVersions(skillId, 200),
      ]);
      const allowedVersionIds = versionRows.map((version) => version.id);
      const allowed = new Set(allowedVersionIds);
      setDatasets(datasetRows);
      setScopeVersionIds(allowedVersionIds);
      setVersionNames(Object.fromEntries(versionRows.map((version) => [version.id, version.version])));
      setRuns(filterToSkillVersionScope(runRows, allowed));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  useEffect(() => {
    void load();
  }, [load]);

  const requestedRunId = searchParams.get("run");
  const scopeVersionSet = useMemo(() => new Set(scopeVersionIds), [scopeVersionIds]);
  useEffect(() => {
    if (!requestedRunId || !selectedRun) return;
    const previousHtml = document.documentElement.style.overflow;
    const previousBody = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previousHtml;
      document.body.style.overflow = previousBody;
    };
  }, [requestedRunId, selectedRun?.id]);
  useEffect(() => {
    if (!requestedRunId || selectedRun?.id === requestedRunId || scopeVersionSet.size === 0) return;
    let cancelled = false;
    void fetchEvalRunDetail(requestedRunId)
      .then((detail) => {
        if (!cancelled) {
          if (detail && scopeVersionSet.has(detail.skillVersionId)) setSelectedRun(detail);
          else setError("Eval run not found for the selected criterion");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [requestedRunId, scopeVersionSet, selectedRun?.id]);

  // Poll while any run is still moving so progress counters tick without a
  // manual refresh. The interval is keyed on hasActiveRun ONLY: depending on
  // the selectedRun object would tear the timer down on every tick (each poll
  // replaces the object). The open card is read through a ref, and a tick's
  // result is applied only if the user still has that same run open when the
  // response lands — a stale in-flight fetch must not re-open a closed card,
  // and a transient 404/null must not blank it.
  const hasActiveRun = useMemo(
    () => runs.some((run) => run.status === "pending" || run.status === "running")
      || selectedRun?.status === "pending"
      || selectedRun?.status === "running",
    [runs, selectedRun?.status]
  );
  const selectedRunRef = useRef<EvalRunDetail | null>(null);
  selectedRunRef.current = selectedRun;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!hasActiveRun) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const open = selectedRunRef.current;
          // Poll the explicitly opened run independently of the 50-row list:
          // an older deep link must keep moving, and a list outage must not
          // freeze the focused report.
          if (open && (open.status === "pending" || open.status === "running")) {
            const detail = await fetchEvalRunDetail(open.id);
            if (cancelled) return;
            if (detail && scopeVersionSet.has(detail.skillVersionId) && selectedRunRef.current?.id === detail.id) {
              setSelectedRun(detail);
            }
          }
          const runRows = await fetchEvalRuns();
          if (cancelled) return;
          const scopedRunRows = filterToSkillVersionScope(runRows, scopeVersionSet);
          // The tick that sees the last active run finish also revalidates the
          // dashboard context: fresh verdicts change judged counts, exceptions,
          // and journey stage (M0 C4). Fire-and-forget — refreshRef avoids
          // retriggering this effect via a changing dependency.
          const anyActiveLeft = scopedRunRows.some((run) => run.status === "pending" || run.status === "running");
          if (!anyActiveLeft) void refreshRef.current();
          setRuns(scopedRunRows);
        } catch {
          // Transient poll failures keep the last good state; the next tick retries.
        }
      })();
    }, ACTIVE_RUN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasActiveRun, scopeVersionSet]);

  // cross-version delta over one dataset. Pick two COMPLETED runs of
  // the SAME dataset; the delta is computed client-side from the two run
  // details the API already serves. A = older run, B = newer.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{ a: EvalRunDetail; b: EvalRunDetail; delta: RunDelta } | null>(null);
  // skillVersionId → semver label, so the headline reads "0.1.1 10/16", not
  // an opaque id. Best-effort: an id that fails to resolve stays an id.

  const toggleCompare = (runId: string) => {
    setError(null);
    setCompareIds((current) => {
      if (current.includes(runId)) {
        setComparison(null);
        return current.filter((id) => id !== runId);
      }
      if (current.length >= 2) return current;
      return [...current, runId];
    });
  };

  useEffect(() => {
    if (compareIds.length !== 2) return;
    let cancelled = false;
    void (async () => {
      try {
        const [x, y] = await Promise.all(compareIds.map((id) => fetchEvalRunDetail(id)));
        if (cancelled || !x || !y) return;
        const [a, b] = orderRuns(x, y);
        setComparison({ a, b, delta: computeRunDelta(a, b) });
        if (skillId) {
          const versions = await fetchSkillVersions(skillId).catch(() => []);
          if (cancelled) return;
          setVersionNames(Object.fromEntries(versions.map((v) => [v.id, v.version])));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compareIds, skillId]);

  const openDataset = async (datasetId: string) => {
    setError(null);
    try {
      const [detail, revisions] = await Promise.all([
        fetchDatasetDetail(datasetId),
        fetchDatasetRevisions(datasetId)
      ]);
      setSelectedDataset(detail);
      setSelectedDatasetRevisions(revisions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openRun = async (evalRunId: string) => {
    setError(null);
    try {
      setSelectedRun(await fetchEvalRunDetail(evalRunId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startRun = async (datasetId: string) => {
    setStarting(datasetId);
    setError(null);
    try {
      const run = await createEvalRun(datasetId, skillVersionId);
      setRuns((current) => [run, ...current.filter((r) => r.id !== run.id)]);
      await openRun(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(null);
    }
  };

  const freezeDataset = async (datasetId: string, role: "analysis_authoring" | "iterative_development") => {
    setFreezing(role);
    setError(null);
    try {
      await createDatasetRevision(datasetId, role);
      setSelectedDatasetRevisions(await fetchDatasetRevisions(datasetId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFreezing(null);
    }
  };

  const startRevisionRun = async (revisionId: string) => {
    setStarting(revisionId);
    setError(null);
    try {
      const run = await createDatasetRevisionEvalRun(revisionId, skillVersionId);
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
      await openRun(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(null);
    }
  };

  const closeRun = () => {
    setSelectedRun(null);
    const next = new URLSearchParams(searchParams);
    next.delete("run");
    setSearchParams(next, { replace: true });
  };
  const openTraceTest = (source: NonNullable<EvalRunDetail["sourceTraceTest"]>) => {
    const query = new URLSearchParams({
      revision: String(source.revision),
      validationRevision: String(source.validationRevision),
      validation: source.validationId
    });
    if (selectedRun) query.set("run", selectedRun.id);
    navigate(`/tests/${encodeURIComponent(source.traceTestId)}/evidence?${query}`);
  };

  if (requestedRunId && selectedRun) {
    return (
      <div className="fadeUp max-[760px]:fixed max-[760px]:inset-0 max-[760px]:z-50 max-[760px]:overflow-y-auto max-[760px]:overflow-x-hidden max-[760px]:bg-paper max-[760px]:px-4 max-[760px]:py-4">
        <SectionHead
          eyebrow="Regression test"
          title="Run report"
          sub="The current evaluator's result, linked to the exact saved test and validation evidence."
          right={<Button variant="ghost" size="sm" onClick={closeRun}><ArrowLeft /> Back to datasets</Button>}
        />
        <EvalRunDetailCard
          detail={selectedRun}
          onClose={closeRun}
          onOpenCase={(caseId) => navigate(`/cases/${caseId}`)}
          onOpenTraceTest={openTraceTest}
        />
      </div>
    );
  }

  return (
    <div className="fadeUp">
      <SectionHead
        eyebrow={`${datasets.length} working collection${datasets.length === 1 ? "" : "s"} · mutable`}
        title={bench ? "Examples" : "Datasets"}
        sub={
          bench
            ? "Each example contains an input and output, with an optional expected label. Uploading only saves the examples. Start a run to evaluate them and calculate agreement."
            : "Datasets are named collections of cases with optional expected labels. Run an evaluator version over a dataset to record results and calculate agreement."
        }
        right={
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/compare-runs")}>
              <GitCompareArrows /> Bisect versions
            </Button>
            <Button variant="default" size="sm" onClick={() => setShowAdd(true)}>
              <Plus /> Add examples
            </Button>
          </div>
        }
      />

      {error ? (
        <Card className="mb-5 border-signal-tint bg-signal-wash">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3 text-[12px] text-signal">
            <span>{error}</span>
            {requestedRunId ? <Button variant="ghost" size="sm" onClick={closeRun}>Clear requested run</Button> : null}
          </CardContent>
        </Card>
      ) : null}

      {loading && datasets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-ink-3">Fetching datasets…</CardContent>
        </Card>
      ) : datasets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-2 py-8">
            <Eyebrow>{bench ? "No examples yet" : "No datasets yet"}</Eyebrow>
            <div className="max-w-[64ch] text-[13px] leading-[1.55] text-ink-2">
              {bench
                ? "Start with a few examples to check the workflow. This is a smoke test, not a coverage claim. Add the result you expect, run the evaluator, and review disagreements."
                : "Paste examples here with Add examples, or create datasets from the batch API "}
              {bench ? null : (
                <>
                  (<code>POST /api/v1/judge/batch</code> with a <code>datasetId</code>). Once one
                  exists, this screen runs the current skill over it and reports agreement against
                  the expected labels.
                </>
              )}
            </div>
            <Button variant="primary" size="sm" className="mt-1" onClick={() => setShowAdd(true)}>
              <Plus /> Add examples
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          {datasets.map((dataset) => (
            <DatasetCard
              key={dataset.id}
              dataset={dataset}
              starting={starting === dataset.id}
              onOpen={() => void openDataset(dataset.id)}
              onRun={() => void startRun(dataset.id)}
            />
          ))}
        </div>
      )}

      {selectedDataset ? (
        <DatasetDetailCard
          detail={selectedDataset}
          revisions={selectedDatasetRevisions}
          freezing={freezing}
          startingRevisionId={starting}
          onFreeze={(role) => void freezeDataset(selectedDataset.id, role)}
          onRunRevision={(revisionId) => void startRevisionRun(revisionId)}
          onClose={() => {
            setSelectedDataset(null);
            setSelectedDatasetRevisions([]);
          }}
          onOpenCase={(caseId) => navigate(`/cases/${caseId}`)}
        />
      ) : null}

      <SectionHead
        className="mb-3 mt-8"
        eyebrow="History"
        title="Eval runs"
        sub="This history includes manual runs, API batches, and regression checks. Agreement uses only cases with an expected label. Select two completed runs of the same dataset to compare their case-level results."
      />
      {runs.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-ink-3">
            No eval runs yet. Start one from a dataset above.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>Compare</th>
                <th>Started</th>
                <th>Dataset</th>
                <th>Skill version</th>
                <th>Trigger</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Agreement</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="row-link" onClick={() => void openRun(run.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    {run.status === "completed" && run.datasetId ? (
                      <input
                        type="checkbox"
                        className="size-6 cursor-pointer"
                        aria-label={`Compare run ${run.id}`}
                        checked={compareIds.includes(run.id)}
                        // A diff only means something within one dataset: once
                        // a run is ticked, runs of other datasets are locked
                        // out rather than silently producing an empty join.
                        disabled={
                          !compareIds.includes(run.id) &&
                          (compareIds.length >= 2 ||
                            (compareIds.length === 1 &&
                              runs.find((r) => r.id === compareIds[0])?.datasetId !== run.datasetId))
                        }
                        onChange={() => toggleCompare(run.id)}
                      />
                    ) : null}
                  </td>
                  <td>
                    <RowButton
                      onClick={() => void openRun(run.id)}
                      aria-label={`Open run · ${formatTimestamp(run.createdAt)}`}
                      className="font-mono text-[11px] text-ink-3"
                    >
                      {formatTimestamp(run.createdAt)}
                    </RowButton>
                  </td>
                  <td className="font-mono text-[11px]">
                    {run.datasetId
                      ? datasets.find((d) => d.id === run.datasetId)?.name ?? run.datasetId
                      : run.datasetRevisionId ? "immutable revision" : "ad-hoc batch"}
                  </td>
                  <td className="font-mono text-[11px] text-ink-3">{run.skillVersionId}</td>
                  <td className="font-mono text-[11px]">{run.trigger}</td>
                  <td className={cn("font-mono text-[11px]", RUN_STATUS_TONE[run.status])}>
                    {run.status}
                    {run.error ? ` · ${run.error}` : ""}
                  </td>
                  <td className="font-mono text-[11px]">{runProgress(run)}</td>
                  <td className="font-mono text-[11px]">
                    {run.status === "completed" ? `${run.agreedItems} agreed` : "—"}
                  </td>
                  <td>
                    <ChevronRight className="size-3.5 text-ink-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {compareIds.length === 1 ? (
        <div className="mt-2 text-[11px] text-ink-3">
          One run ticked — tick a second completed run of the same dataset to see the delta.
        </div>
      ) : null}

      {comparison ? (
        <RunDeltaCard
          comparison={comparison}
          datasets={datasets}
          versionNames={versionNames}
          onClose={() => {
            setComparison(null);
            setCompareIds([]);
          }}
          onOpenCase={(caseId) => navigate(`/cases/${caseId}`)}
        />
      ) : null}

      {selectedRun ? (
        <EvalRunDetailCard
          detail={selectedRun}
          onClose={closeRun}
          onOpenCase={(caseId) => navigate(`/cases/${caseId}`)}
          onOpenTraceTest={openTraceTest}
        />
      ) : null}

      {/* Gate on !loading: the ?add=1 deep link opens this before the dataset
          list has loaded, and the modal snapshots its dataset choice on mount —
          mounting it against an empty list would lock it onto "new dataset"
          even when datasets exist. */}
      {showAdd && !loading ? (
        <AddExamplesModal
          datasets={datasets.filter((d) => !d.archivedAt)}
          onClose={closeAdd}
          onImported={async (datasetId) => {
            closeAdd();
            // Example imports bump project counts + journey stage — revalidate
            // the dashboard context so topbar/sidebar update without a hard
            // reload (M0 C4).
            void refresh();
            await load();
            await openDataset(datasetId);
          }}
        />
      ) : null}
    </div>
  );
}
