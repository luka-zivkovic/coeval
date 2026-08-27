import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, Database, GitCompareArrows, Play, Plus, RefreshCcw, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table } from "@/components/ui/table";
import { RowButton, RowLink } from "@/components/row-action";
import { Chip, Eyebrow, LabelChip, SectionHead, VerdictChip } from "@/components/coeval";
import {
  createDataset,
  createDatasetRevision,
  createDatasetRevisionEvalRun,
  createEvalRun,
  fetchDatasetDetail,
  fetchDatasetRevisions,
  fetchDatasets,
  fetchEvalRunDetail,
  fetchEvalRuns,
  fetchSkillVersions,
  importDatasetExamples
} from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { filterToSkillVersionScope } from "@/lib/criterion-scope";
import { isBench } from "@/lib/journey";
import { computeRunDelta, orderRuns, type RunDelta } from "@/lib/run-delta";
import { cn, formatTimestamp } from "@/lib/utils";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import { traceTestRunOutcome, type Dataset, type DatasetDetail, type DatasetExampleInput, type DatasetRevision, type EvalRun, type EvalRunDetail, type TraceTestRunOutcome } from "@coeval/shared";

const ACTIVE_RUN_POLL_MS = 4000;

function runProgress(run: EvalRun): string {
  return `${run.completedItems + run.failedItems}/${run.totalItems}`;
}

// Agreement is only meaningful over items that carried an expectedLabel AND
// were actually judged — a failed item was never judged, and counting it in
// the denominator would render an infrastructure error as a judge
// disagreement.
function detailAgreement(detail: EvalRunDetail): string {
  if (detail.status !== "completed") return "—";
  const judged = detail.items.filter((item) => item.expectedLabel !== null && item.status === "completed").length;
  if (judged === 0) return "no expected labels";
  const failed = detail.items.filter((item) => item.status === "failed").length;
  return `${detail.agreedItems}/${judged} agree${failed > 0 ? ` · ${failed} failed` : ""}`;
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

// --- Add examples: forgiving JSONL/JSON parse + import -----------------------

interface ParsedExamples {
  items: DatasetExampleInput[];
  errors: Array<{ line: number; message: string }>;
  unlabeled: number;
}

// Accepts JSONL (one object per line) or a single JSON array. Malformed rows
// surface with line numbers instead of failing the whole paste — a 200-row
// file with two bad lines should still load 198. `expected` is accepted as an
// alias for `expectedLabel`; null/missing means "no expected label" (a named
// state downstream, never silently defaulted).
export function parseExamplesText(text: string): ParsedExamples {
  const items: DatasetExampleInput[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  let unlabeled = 0;

  const pushRow = (row: unknown, line: number) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      errors.push({ line, message: "not a JSON object" });
      return;
    }
    const record = row as Record<string, unknown>;
    // Empty/whitespace strings mean "absent" — an empty expectedLabel must
    // fall through to the `expected` alias instead of shadowing it.
    const normalize = (value: unknown) =>
      typeof value === "string" && value.trim() === "" ? undefined : value;
    const rawLabel = normalize(record.expectedLabel) ?? normalize(record.expected);
    let expectedLabel: "pass" | "fail" | undefined;
    if (rawLabel === "pass" || rawLabel === "fail") expectedLabel = rawLabel;
    else if (rawLabel !== undefined && rawLabel !== null) {
      errors.push({ line, message: `expected label must be "pass" or "fail" (got ${JSON.stringify(rawLabel)})` });
      return;
    }
    if (!("input" in record) && !("output" in record)) {
      errors.push({ line, message: "needs at least an input or an output field" });
      return;
    }
    if (!expectedLabel) unlabeled += 1;
    items.push({
      input: record.input ?? null,
      output: record.output ?? null,
      ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(expectedLabel ? { expectedLabel } : {}),
      ...(typeof record.note === "string" && record.note ? { note: record.note } : {})
    });
  };

  const trimmed = text.trim();
  if (!trimmed) return { items, errors, unlabeled };
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      parsed.forEach((row, index) => pushRow(row, index + 1));
    } catch (err) {
      errors.push({ line: 1, message: err instanceof Error ? err.message.slice(0, 80) : String(err) });
    }
    return { items, errors, unlabeled };
  }
  trimmed.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      pushRow(JSON.parse(line), index + 1);
    } catch (err) {
      errors.push({ line: index + 1, message: err instanceof Error ? err.message.slice(0, 80) : String(err) });
    }
  });
  return { items, errors, unlabeled };
}

const NEW_DATASET = "__new__";
const SAMPLE_EXAMPLES = `{"input": "Where is my refund??", "output": "Order is past the window; I can't help.", "expected": "fail"}
{"input": "Thanks, that fixed it!", "output": "Glad to hear it — anything else?", "expected": "pass"}
{"input": "ok", "output": "Let me know if you need anything.", "expected": null}`;

function AddExamplesModal({
  datasets,
  onClose,
  onImported
}: {
  datasets: Dataset[];
  onClose: () => void;
  onImported: (datasetId: string) => Promise<void>;
}) {
  const [datasetChoice, setDatasetChoice] = useState<string>(datasets[0]?.id ?? NEW_DATASET);
  const [newName, setNewName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose, closeOnEscape: !busy });

  const parsed = useMemo(() => parseExamplesText(text), [text]);
  const needsName = datasetChoice === NEW_DATASET;
  const canSubmit = parsed.items.length > 0 && !busy && (!needsName || newName.trim().length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setServerError(null);
    try {
      const datasetId = needsName
        ? (await createDataset({ name: newName.trim() })).id
        : datasetChoice;
      await importDatasetExamples(datasetId, parsed.items);
      await onImported(datasetId);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-examples-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto shadow-elev sm:w-[720px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="min-w-0 flex-1">
            <CardTitle id="add-examples-title">Add examples</CardTitle>
            <CardDescription>
              Paste JSONL — one <code>{'{"input", "output", "expected"}'}</code> object per line — or a
              JSON array. Nothing is judged on upload; run an eval when you're ready. Re-pasting an
              unchanged example reuses its case; an edited one becomes a fresh case.
            </CardDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close add examples dialog"
            className="-mr-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-ink-3 hover:bg-paper-3"
          >
            <X className="size-3.5" />
          </button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="add-examples-dataset" className="eyebrow">Dataset</label>
              <select
                id="add-examples-dataset"
                data-dialog-initial-focus
                value={datasetChoice}
                onChange={(e) => setDatasetChoice(e.target.value)}
                className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 text-[12.5px] text-ink focus-visible:border-ink"
              >
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} · {dataset.itemCount} case{dataset.itemCount === 1 ? "" : "s"}
                  </option>
                ))}
                <option value={NEW_DATASET}>+ New dataset…</option>
              </select>
            </div>
            {needsName ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="add-examples-dataset-name" className="eyebrow">New dataset name</label>
                <Input
                  id="add-examples-dataset-name"
                  placeholder="e.g. Support replies · v1"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="add-examples-input" className="eyebrow">Examples · JSONL or JSON array</label>
              <span className="font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
                {parsed.items.length} parsed
                {parsed.unlabeled > 0 ? ` · ${parsed.unlabeled} without expected label` : ""}
                {parsed.errors.length > 0 ? ` · ${parsed.errors.length} malformed` : ""}
              </span>
            </div>
            <textarea
              id="add-examples-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE_EXAMPLES}
              spellCheck={false}
              className="min-h-[180px] resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.5] text-ink focus-visible:border-ink"
            />
            {parsed.errors.length > 0 ? (
              <div role="alert" className="max-h-[72px] overflow-y-auto font-mono text-[10.5px] leading-[1.6] text-signal">
                {parsed.errors.slice(0, 8).map((error) => (
                  <div key={`${error.line}-${error.message}`}>
                    line {error.line}: {error.message}
                  </div>
                ))}
                {parsed.errors.length > 8 ? <div>… {parsed.errors.length - 8} more</div> : null}
              </div>
            ) : null}
            <div className="text-[11px] leading-[1.5] text-ink-3">
              <code>expected</code> is optional — <code>"pass"</code> or <code>"fail"</code>. Rows
              without it are stored and judged, but never counted in agreement. Malformed rows are
              skipped, good rows still load.
            </div>
          </div>

          {serverError ? <div role="alert" className="text-[12px] text-signal">{serverError}</div> : null}

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
              {busy
                ? "Adding…"
                : `Add ${parsed.items.length || ""} example${parsed.items.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DatasetCard({
  dataset,
  starting,
  onOpen,
  onRun
}: {
  dataset: Dataset;
  starting: boolean;
  onOpen: () => void;
  onRun: () => void;
}) {
  return (
    <Card className={cn("flex h-full flex-col", dataset.archivedAt && "opacity-60")}>
      <CardContent className="flex h-full flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
            <Database className="size-3.5 text-ink-3" /> {dataset.name}
          </div>
          <Chip>working · mutable</Chip>
        </div>
        {dataset.description ? (
          <div className="text-[12.5px] leading-[1.5] text-ink-2">{dataset.description}</div>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-ink-3">
            {dataset.itemCount} case{dataset.itemCount === 1 ? "" : "s"} · {formatTimestamp(dataset.createdAt)}
            {dataset.archivedAt ? " · archived" : ""}
          </span>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={onOpen}>
              Cases
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={onRun}
              disabled={starting || dataset.itemCount === 0 || dataset.archivedAt !== null}
              title={dataset.itemCount === 0 ? "Dataset has no cases to judge." : undefined}
            >
              <Play /> {starting ? "Starting…" : "Run eval"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DatasetDetailCard({
  detail,
  revisions,
  freezing,
  startingRevisionId,
  onFreeze,
  onRunRevision,
  onClose,
  onOpenCase
}: {
  detail: DatasetDetail;
  revisions: DatasetRevision[];
  freezing: string | null;
  startingRevisionId: string | null;
  onFreeze: (role: "analysis_authoring" | "iterative_development") => void;
  onRunRevision: (revisionId: string) => void;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <Eyebrow>
              {detail.name} · working collection · mutable · {detail.items.length} case{detail.items.length === 1 ? "" : "s"}
            </Eyebrow>
            <div className="mt-1 text-[11px] text-ink-3">
              Freeze a revision when you need a stable, digest-addressed evaluation corpus. The collection stays editable.
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={detail.items.length === 0 || freezing !== null}
              onClick={() => onFreeze("analysis_authoring")}
            >
              {freezing === "analysis_authoring" ? "Freezing…" : "Freeze for analysis"}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={detail.items.length === 0 || freezing !== null}
              onClick={() => onFreeze("iterative_development")}
            >
              {freezing === "iterative_development" ? "Freezing…" : "Freeze for development"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
        <Table>
          <thead>
            <tr>
              <th>Trace</th>
              <th>Expected</th>
              <th>Note</th>
              <th style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((item) => (
              <tr key={item.id} className="row-link" onClick={() => onOpenCase(item.caseId)}>
                <td>
                  <RowLink to={`/cases/${item.caseId}`} className="font-mono text-[11px]">
                    {item.traceId}
                  </RowLink>
                </td>
                <td>{item.expectedLabel ? <VerdictChip verdict={item.expectedLabel} /> : <span className="text-ink-4">—</span>}</td>
                <td className="text-[12px] text-ink-2">{item.note ?? "—"}</td>
                <td>
                  <ChevronRight className="size-3.5 text-ink-4" />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="mt-5 border-t border-rule-soft pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <Eyebrow>Immutable revisions · {revisions.length}</Eyebrow>
            <span className="text-[10.5px] text-ink-3">Sealed validation intake is not available in this batch.</span>
          </div>
          {revisions.length === 0 ? (
            <div className="rounded-sm bg-paper-2 px-3 py-3 text-[12px] text-ink-3">
              No frozen evidence revisions yet.
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Role</th>
                  <th>Cases</th>
                  <th>Exposure</th>
                  <th>Digest</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision) => (
                  <tr key={revision.id}>
                    <td className="font-mono text-[11px]">r{revision.revisionNumber}</td>
                    <td><Chip>{revision.role.replaceAll("_", " ")}</Chip></td>
                    <td className="font-mono text-[11px]">{revision.itemCount}</td>
                    <td className="font-mono text-[11px]">{revision.exposureState.replaceAll("_", " ")}</td>
                    <td className="font-mono text-[10px] text-ink-3" title={revision.revisionDigest}>
                      {revision.revisionDigest.slice(0, 18)}…
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={startingRevisionId === revision.id || revision.itemCount === 0}
                        onClick={() => onRunRevision(revision.id)}
                      >
                        <Play /> {startingRevisionId === revision.id ? "Starting…" : "Run"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// the delta card. Counts only, flips first, and every excluded case
// (only-in-one-run, failed) is named instead of vanishing from a denominator.
function RunDeltaCard({
  comparison,
  datasets,
  versionNames,
  onClose,
  onOpenCase
}: {
  comparison: { a: EvalRunDetail; b: EvalRunDetail; delta: RunDelta };
  datasets: Dataset[];
  versionNames: Record<string, string>;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  const { a, b, delta } = comparison;
  const versionLabel = (versionId: string) => versionNames[versionId] ?? versionId;
  const datasetName = a.datasetId
    ? datasets.find((d) => d.id === a.datasetId)?.name ?? a.datasetId
    : "ad-hoc batch";
  const sameVersion = a.skillVersionId === b.skillVersionId;
  const said = (label: string | null, status: string) =>
    label ? <LabelChip label={label} /> : <span className="text-signal">{status}</span>;

  const notes: string[] = [];
  if (delta.aOnly > 0 || delta.bOnly > 0) {
    notes.push(
      `${delta.aOnly + delta.bOnly} case(s) appear in only one run (${delta.aOnly} A-only, ${delta.bOnly} B-only) — the dataset changed between runs; they can't flip and are not shown.`
    );
  }
  if (delta.aFailed > 0 || delta.bFailed > 0) {
    notes.push(
      `${delta.aFailed + delta.bFailed} item(s) failed (${delta.aFailed} in A, ${delta.bFailed} in B) — a failed item was never judged and is never counted as a flip.`
    );
  }
  if (sameVersion) {
    notes.push("Both runs used the same skill version — any flip here is judge inconsistency, not a prompt change.");
  }

  return (
    <Card className="mt-4">
      <CardContent className="py-4">
        <div className="mb-1 flex items-center justify-between">
          <Eyebrow>Delta · {datasetName}</Eyebrow>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="mb-3 text-[13px] text-ink">
          <span className="font-medium">A · {versionLabel(a.skillVersionId)}</span>{" "}
          <span className="font-mono text-[12px]">
            {delta.aAgreement.labeled > 0 ? `${delta.aAgreement.agreed}/${delta.aAgreement.labeled} agreed` : "no expected labels"}
          </span>
          {" · "}
          <span className="font-medium">B · {versionLabel(b.skillVersionId)}</span>{" "}
          <span className="font-mono text-[12px]">
            {delta.bAgreement.labeled > 0 ? `${delta.bAgreement.agreed}/${delta.bAgreement.labeled} agreed` : "no expected labels"}
          </span>
          {" · "}
          <span className={cn("font-mono text-[12px]", delta.flipped > 0 ? "text-signal" : "text-ink-3")}>
            {delta.flipped} of {delta.shared} shared case(s) flipped
          </span>
        </div>
        {notes.length > 0 ? (
          <div className="mb-3 flex flex-col gap-0.5 text-[11px] leading-[1.5] text-ink-3">
            {notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        ) : null}
        {delta.shared === 0 ? (
          <div className="py-4 text-[12.5px] text-ink-3">
            These runs share no cases — there is nothing to diff.
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Expected</th>
                <th>A said</th>
                <th>B said</th>
                <th>Flip</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {delta.rows.map((row) => (
                <tr
                  key={row.caseId}
                  className={cn("row-link", row.flipped && "row-signal")}
                  onClick={() => onOpenCase(row.caseId)}
                >
                  <td>
                    <RowLink to={`/cases/${row.caseId}`} className="font-mono text-[11px]">
                      {row.caseId}
                    </RowLink>
                  </td>
                  <td>{row.expected ? <VerdictChip verdict={row.expected} /> : <span className="text-ink-4">—</span>}</td>
                  <td>{said(row.aSaid, row.aStatus)}</td>
                  <td>{said(row.bSaid, row.bStatus)}</td>
                  <td className="font-mono text-[11px]">
                    {row.flipped ? "flipped" : row.aSaid !== null && row.bSaid !== null ? "same" : "—"}
                  </td>
                  <td>
                    <ChevronRight className="size-3.5 text-ink-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function EvalRunDetailCard({
  detail,
  onClose,
  onOpenCase,
  onOpenTraceTest
}: {
  detail: EvalRunDetail;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
  onOpenTraceTest: (source: NonNullable<EvalRunDetail["sourceTraceTest"]>) => void;
}) {
  const disagreements = detail.items.filter((item) => item.agreement === false).length;
  // tokens and counts, never dollars. Null token sums = nothing
  // reported usage (all cached, or the provider didn't report) — an explicit
  // state, never zero-as-unknown.
  const spend = detail.spend;
  const sourceOutcome = detail.sourceTraceTest ? traceTestRunOutcome(detail) : null;
  const spendLine = [
    `${spend.freshItems} fresh`,
    `${spend.cachedItems} cached (no spend)`,
    spend.inputTokens === null && spend.outputTokens === null
      ? "usage unavailable"
      : `${spend.inputTokens ?? 0} in / ${spend.outputTokens ?? 0} out tokens`,
    ...(spend.usageMissingCount > 0 ? [`usage unavailable for ${spend.usageMissingCount} call(s)`] : []),
    ...(spend.totalLatencyMs !== null ? [`${spend.totalLatencyMs} ms total`] : [])
  ].join(" · ");
  return (
    <Card className="mt-4">
      <CardContent className="py-4">
        <div className="mb-3 flex items-center justify-between">
          <Eyebrow>
            Run {detail.id} · {detail.status} · {detailAgreement(detail)}
            {disagreements > 0 ? ` · ${disagreements} disagree` : ""}
          </Eyebrow>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="mb-3 font-mono text-[11px] text-ink-3" data-spend-line>
          spend: {spendLine}
        </div>
        {detail.sourceTraceTest ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-rule-soft bg-paper-2 px-3 py-2.5">
            <div>
              <div className="text-[12px] font-medium text-ink">Run from a saved conversation test</div>
              <div className="mt-0.5 text-[11px] text-ink-3">Revision {detail.sourceTraceTest.revision} · validation {detail.sourceTraceTest.validationId}</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenTraceTest(detail.sourceTraceTest!)}>View source test</Button>
          </div>
        ) : null}
        {sourceOutcome ? <TraceTestOutcomeBanner outcome={sourceOutcome} /> : null}
        <div className="overflow-x-auto">
          <Table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Expected</th>
              <th>Judge said</th>
              <th>Agreement</th>
              <th>Latency</th>
              <th>Cached</th>
              <th style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((item) => (
              <tr
                key={item.id}
                className={cn("row-link", item.agreement === false && "row-signal")}
                onClick={() => onOpenCase(item.caseId)}
              >
                <td>
                  <RowLink to={`/cases/${item.caseId}`} className="font-mono text-[11px]">
                    {item.caseId}
                  </RowLink>
                </td>
                <td>{item.expectedLabel ? <VerdictChip verdict={item.expectedLabel} /> : <span className="text-ink-4">—</span>}</td>
                <td>
                  {item.resultLabel ? (
                    <LabelChip label={item.resultLabel} />
                  ) : (
                    <span className="text-ink-4">{item.status}</span>
                  )}
                </td>
                <td className="font-mono text-[11px]">
                  {item.agreement === null ? "—" : item.agreement ? "agree" : "disagree"}
                </td>
                <td className="font-mono text-[11px] text-ink-3">
                  {item.latencyMs === null ? "—" : `${item.latencyMs} ms`}
                </td>
                <td className="font-mono text-[11px] text-ink-3">{item.cached ? "cached" : "fresh"}</td>
                <td>
                  <ChevronRight className="size-3.5 text-ink-4" />
                </td>
              </tr>
            ))}
          </tbody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function TraceTestOutcomeBanner({ outcome }: { outcome: TraceTestRunOutcome }) {
  const copy = outcome === "passed"
    ? { title: "Passed", body: "The evaluator behaved as this saved test expected." }
    : outcome === "regressed"
      ? { title: "Regressed", body: "The evaluator disagreed with the behavior this test protects." }
      : outcome === "needs_review"
        ? { title: "Needs review", body: "The evaluator could not make a clear behavior decision from this case." }
        : outcome === "could_not_run"
          ? { title: "Could not run", body: "A runtime or provider problem stopped this check. This is not a behavior regression." }
          : { title: "Running", body: "Coeval is checking this test now. This report will update automatically." };
  return (
    <div className="mb-3 rounded-sm border border-rule-soft bg-paper-2 px-3 py-2.5" role="status">
      <div className="text-[12px] font-medium text-ink">{copy.title}</div>
      <div className="mt-0.5 text-[11.5px] leading-[1.5] text-ink-2">{copy.body}</div>
    </div>
  );
}
