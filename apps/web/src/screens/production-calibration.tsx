import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { ProductionCalibrationArtifact } from "@rubrist/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { SectionHead } from "@/components/rubrist";
import { DatabaseModeRequired } from "@/components/database-mode-required";
import { useAppMode } from "@/lib/app-mode";
import { BooleanReading } from "../components/production-calibration/boolean-reading.js";
import { ChoiceReading } from "../components/production-calibration/choice-reading.js";
import { ScoreReading } from "../components/production-calibration/score-reading.js";
import {
  buildStoredProductionReport,
  fetchProductionCalibrationSample,
  fetchProductionSnapshot,
  importProductionRecords,
  listProductionSnapshots,
  previewProductionCalibration,
  ProductionCalibrationApiError,
  saveProductionSnapshot,
  type ProductionCalibrationPreviewSummary,
  type ProductionCalibrationReportParameters,
  type ProductionCalibrationSnapshotSummary,
  type ProductionRecordImportResult
} from "../lib/production-calibration-api.js";
import {
  PRODUCTION_CALIBRATION_GOVERNED_REVIEW_NOTE,
  PRODUCTION_CALIBRATION_PROVENANCE_LINE,
  costsFromInputs,
  formatModelIdentity,
  formatOutcomeSources,
  formatReportWindow,
  questionOptionKey,
  questionOptionLabel,
  questionOptions,
  storedWindowBounds,
  type CostInputs
} from "../lib/production-calibration-ui.js";

const DEFAULT_THRESHOLD = 0.5;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const RECOMPUTE_DELAY_MS = 250;
const DEFAULT_WINDOW_DAYS_BACK = 29;
const EMPTY_COSTS: CostInputs = { falsePositive: "", falseNegative: "", humanReview: "" };

/** Where the reading on screen came from; only live readings recompute when the threshold or costs change. */
type ReadingSource =
  | { kind: "preview"; records: string }
  | {
    kind: "stored";
    from: string | null;
    to: string | null;
    /** The parameters this reading was built with, so a snapshot saves exactly what is shown. */
    params: ProductionCalibrationReportParameters;
    recordCount: number;
    recordSetDigest: string;
  }
  | { kind: "snapshot"; snapshot: ProductionCalibrationSnapshotSummary };

interface Reading {
  source: ReadingSource;
  artifact: ProductionCalibrationArtifact;
  /** Per-question counts from the server; a snapshot has none and falls back to the artifact's. */
  summary: ProductionCalibrationPreviewSummary | null;
}

export function ProductionCalibrationScreen() {
  const { demoMode } = useAppMode();
  if (demoMode) {
    return (
      <DatabaseModeRequired
        eyebrow="Production calibration · demo mode"
        title="Production calibration previews need a signed-in project."
        description="Readings are computed for one project membership and returned to that session, and stored records belong to that project."
        demoAlternative="The demo has no project session to scope a ledger or stored records to. Configure Postgres and sign in to read production decisions."
      />
    );
  }
  return <PersistentProductionCalibrationScreen />;
}

function isoDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function PersistentProductionCalibrationScreen() {
  const [ledger, setLedger] = useState("");
  const [ledgerSource, setLedgerSource] = useState<string | null>(null);
  const [bins, setBins] = useState("10");
  const [windowDays, setWindowDays] = useState("7");
  const [fromDate, setFromDate] = useState(() => isoDate(-DEFAULT_WINDOW_DAYS_BACK));
  const [throughDate, setThroughDate] = useState(() => isoDate(0));
  const [reading, setReading] = useState<Reading | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [costs, setCosts] = useState<CostInputs>(EMPTY_COSTS);
  const [computing, setComputing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ProductionRecordImportResult | null>(null);
  const [snapshots, setSnapshots] = useState<ProductionCalibrationSnapshotSummary[] | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const options = reading ? questionOptions(reading.artifact, reading.summary?.questions ?? []) : [];
  const selected = options.find((option) => questionOptionKey(option) === selectedKey) ?? options[0] ?? null;
  const entry = reading && selected
    ? reading.artifact.questions.find((question) =>
      question.question === selected.question && question.answerType === selected.answerType) ?? null
    : null;

  const parsedBins = Number.parseInt(bins, 10);
  const parsedWindowDays = Number.parseInt(windowDays, 10);
  const baseParams = {
    ...(Number.isInteger(parsedBins) && parsedBins >= 1 && parsedBins <= 100 ? { bins: parsedBins } : {}),
    ...(Number.isInteger(parsedWindowDays) && parsedWindowDays >= 1 && parsedWindowDays <= 366 ? { windowDays: parsedWindowDays } : {})
  };
  const storedWindow = storedWindowBounds(fromDate, throughDate);

  const refreshSnapshots = useCallback(async () => {
    try {
      setSnapshots(await listProductionSnapshots());
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    void refreshSnapshots();
  }, [refreshSnapshots]);

  const run = useCallback(async (
    source: Exclude<ReadingSource, { kind: "snapshot" }>,
    params: ProductionCalibrationReportParameters,
    mode: "compute" | "recompute"
  ) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    if (mode === "compute") setComputing(true);
    else setRecomputing(true);
    setError(null);
    try {
      if (source.kind === "preview") {
        const next = await previewProductionCalibration({ records: source.records, ...params }, controller.signal);
        if (controller.signal.aborted) return;
        setReading({ source, artifact: next.artifact, summary: next.summary });
      } else {
        const next = await buildStoredProductionReport({ from: source.from, to: source.to, ...params }, controller.signal);
        if (controller.signal.aborted) return;
        setReading({
          source: { ...source, params, recordCount: next.recordCount, recordSetDigest: next.recordSetDigest },
          artifact: next.artifact,
          summary: next.summary
        });
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(describeError(cause));
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setComputing(false);
        setRecomputing(false);
      }
    }
  }, []);

  function resetSelection(): void {
    setSelectedKey(null);
    setThreshold(DEFAULT_THRESHOLD);
    setCosts(EMPTY_COSTS);
  }

  function computePreview(): void {
    if (ledger.trim() === "") {
      setError("Paste or upload a decision ledger first.");
      return;
    }
    resetSelection();
    void run({ kind: "preview", records: ledger }, baseParams, "compute");
  }

  function buildStored(): void {
    if (!storedWindow) {
      setError("Choose a from date on or before the through date.");
      return;
    }
    resetSelection();
    void run({ kind: "stored", ...storedWindow, params: baseParams, recordCount: 0, recordSetDigest: "" }, baseParams, "compute");
  }

  // Save exactly the stored reading on screen: its own window and parameters,
  // never the date inputs if they were edited after the build.
  const savable = reading?.source.kind === "stored" && !computing && !recomputing ? reading.source : null;
  async function saveSnapshot(): Promise<void> {
    if (!savable) return;
    setSaving(true);
    setError(null);
    try {
      await saveProductionSnapshot({ from: savable.from, to: savable.to, ...savable.params });
      await refreshSnapshots();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  async function openSnapshot(snapshotId: string): Promise<void> {
    // A snapshot load takes part in the same abort guard as builds, so
    // whichever the reader asked for last is what stays on screen.
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setError(null);
    try {
      const { snapshot, artifact } = await fetchProductionSnapshot(snapshotId, controller.signal);
      if (controller.signal.aborted) return;
      resetSelection();
      setReading({ source: { kind: "snapshot", snapshot }, artifact, summary: null });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(describeError(cause));
    } finally {
      if (inflight.current === controller) inflight.current = null;
    }
  }

  async function importLedger(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`The ledger file is ${file.size} bytes; an import accepts up to ${MAX_UPLOAD_BYTES} bytes.`);
      return;
    }
    setImporting(true);
    setError(null);
    setImportResult(null);
    try {
      setImportResult(await importProductionRecords(await file.text()));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setImporting(false);
    }
  }

  // Threshold and cost changes re-request the live reading scoped to the
  // selected boolean question after a short pause; a newer request aborts
  // the one in flight. A saved snapshot never recomputes.
  const recomputeTimer = useRef<number | null>(null);
  function scheduleRecompute(next: { threshold: number; costs: CostInputs }): void {
    if (!reading || reading.source.kind === "snapshot" || !entry || entry.answerType !== "boolean") return;
    if (recomputeTimer.current !== null) window.clearTimeout(recomputeTimer.current);
    const source = reading.source;
    const question = entry.question;
    recomputeTimer.current = window.setTimeout(() => {
      recomputeTimer.current = null;
      void run(source, { question, threshold: next.threshold, costs: costsFromInputs(next.costs), ...baseParams }, "recompute");
    }, RECOMPUTE_DELAY_MS);
  }
  function changeThreshold(next: number): void {
    setThreshold(next);
    scheduleRecompute({ threshold: next, costs });
  }
  function changeCosts(next: CostInputs): void {
    setCosts(next);
    scheduleRecompute({ threshold, costs: next });
  }

  useEffect(() => () => {
    inflight.current?.abort();
    if (recomputeTimer.current !== null) window.clearTimeout(recomputeTimer.current);
  }, []);

  async function loadSample(): Promise<void> {
    setLoadingSample(true);
    setError(null);
    try {
      const text = await fetchProductionCalibrationSample();
      setLedger(text);
      setLedgerSource("sample · CI flaky-test triage · 16 decisions · 32 human outcomes · digests only");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingSample(false);
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`The ledger file is ${file.size} bytes; the preview accepts up to ${MAX_UPLOAD_BYTES} bytes.`);
      return;
    }
    setError(null);
    setLedger(await file.text());
    setLedgerSource(`file · ${file.name} · ${file.size} bytes`);
  }

  function selectQuestion(key: string): void {
    setSelectedKey(key);
    setThreshold(DEFAULT_THRESHOLD);
    setCosts(EMPTY_COSTS);
  }

  const numberField = "h-7 w-20 rounded-sm border border-rule bg-paper px-2 font-sans text-[12px] normal-case tracking-normal text-ink";
  const fieldLabel = "grid gap-1 font-mono text-[9.5px] uppercase tracking-[0.09em] text-ink-4";

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Production calibration · ungoverned"
        title="Production calibration"
        sub="A production decision is a Check whose evaluator is the agent's own decision model: the question is the criterion, each decision is a result with a probability, and the outcome that arrived later is the label. Read the project's stored decision records, or paste a ledger to preview it without storing anything."
      />

      <p role="note" className="mb-5 rounded-sm border border-gold-tint bg-ambig-bg px-4 py-3 text-[12.5px] leading-5 text-ink-2">
        <b className="font-medium">{PRODUCTION_CALIBRATION_PROVENANCE_LINE}</b>{" "}
        <span className="text-ink-3">{PRODUCTION_CALIBRATION_GOVERNED_REVIEW_NOTE}</span>
      </p>

      {error ? (
        <div role="alert" className="mb-5 rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">{error}</div>
      ) : null}

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className={fieldLabel}>
          Reliability bins
          <input type="number" min={1} max={100} value={bins} onChange={(event) => setBins(event.target.value)} className={numberField} />
        </label>
        <label className={fieldLabel}>
          Drift window · days
          <input type="number" min={1} max={366} value={windowDays} onChange={(event) => setWindowDays(event.target.value)} className={numberField} />
        </label>
        <span className="font-mono text-[10px] text-ink-4">report parameters for stored reports, snapshots, and previews</span>
      </div>

      <Card className="mb-6">
        <CardHeader className="justify-between">
          <CardTitle>Stored records</CardTitle>
          <span className="font-mono text-[10px] text-ink-4">
            decisions sent with a production-ingest key or imported by an owner · UTC dates
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className={fieldLabel}>
              From
              <input type="date" aria-label="Window from date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="h-7 rounded-sm border border-rule bg-paper px-2 font-sans text-[12px] normal-case tracking-normal text-ink" />
            </label>
            <label className={fieldLabel}>
              Through
              <input type="date" aria-label="Window through date" value={throughDate} onChange={(event) => setThroughDate(event.target.value)} className="h-7 rounded-sm border border-rule bg-paper px-2 font-sans text-[12px] normal-case tracking-normal text-ink" />
            </label>
            <Button variant="primary" size="sm" onClick={buildStored} disabled={computing}>
              {computing ? "Building…" : "Build report"}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void saveSnapshot()}
              disabled={saving || !savable}
              title={savable ? "Save the stored report on screen" : "Build a stored report first"}
            >
              {saving ? "Saving…" : "Save snapshot"}
            </Button>
            <Button variant="default" size="sm" onClick={() => importInput.current?.click()} disabled={importing}>
              {importing ? "Importing…" : "Import .jsonl (owners)"}
            </Button>
            <input
              ref={importInput}
              type="file"
              accept=".jsonl,.ndjson,.json,text/plain,application/x-ndjson"
              aria-label="Import a decision ledger into the project"
              className="sr-only"
              onChange={(event) => void importLedger(event)}
            />
          </div>
          {importResult ? (
            <p className="font-mono text-[10.5px] text-ink-3" aria-live="polite">
              imported · {importResult.inserted.decisions} decisions · {importResult.inserted.actions} actions · {importResult.inserted.outcomes} outcomes · {importResult.duplicates} duplicates · {importResult.awaitingDecision} awaiting their decision
            </p>
          ) : null}
          <p className="text-[11.5px] leading-5 text-ink-3">
            A snapshot saves the stored report on screen, with its window and parameters, as exact bytes with their digest. It keeps its history after record retention removes the records.
          </p>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader className="justify-between">
          <CardTitle>Snapshots</CardTitle>
          <span className="font-mono text-[10px] text-ink-4">saved readings · newest first · parameters fixed</span>
        </CardHeader>
        <CardContent>
          {snapshots === null ? (
            <p className="text-[12px] text-ink-3">Loading snapshots…</p>
          ) : snapshots.length === 0 ? (
            <p className="text-[12px] text-ink-3">No snapshots yet.</p>
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Built</th>
                  <th scope="col">Window</th>
                  <th scope="col">Records</th>
                  <th scope="col">Digest</th>
                  <th scope="col"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="font-mono text-[11px]">{snapshot.builtAt}</td>
                    <td className="font-mono text-[11px] text-ink-3">{formatReportWindow(snapshot.window)}</td>
                    <td className="font-mono text-[11px] tabular-nums">{snapshot.recordCount}</td>
                    <td className="font-mono text-[11px] text-ink-3">{snapshot.artifactDigest.slice(0, 19)}…</td>
                    <td>
                      <Button variant="ghost" size="sm" onClick={() => void openSnapshot(snapshot.id)}>Open</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader className="justify-between">
          <CardTitle>Preview a ledger</CardTitle>
          <span className="font-mono text-[10px] text-ink-4">
            rubrist/production-decision-record/v1 · JSON Lines · decision, action, outcome records · up to {MAX_UPLOAD_BYTES / (1024 * 1024)} MiB · not stored
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="Decision ledger (JSON Lines)"
            value={ledger}
            onChange={(event) => {
              setLedger(event.target.value);
              setLedgerSource(null);
            }}
            placeholder={'{"kind":"decision","id":"…","at":"…","questionSet":{…},"model":"…","provider":"…","stateDigest":"sha256:…","stateLength":0,"answers":{…},"latencyMs":null,"usage":null}\n{"kind":"outcome","decisionId":"…","at":"…","question":"…","value":true,"source":"human"}'}
            className="min-h-[160px]"
            spellCheck={false}
          />
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="primary" size="sm" onClick={computePreview} disabled={computing || ledger.trim() === ""}>
              {computing ? "Computing…" : "Compute preview"}
            </Button>
            <Button variant="default" size="sm" onClick={() => void loadSample()} disabled={loadingSample}>
              {loadingSample ? "Loading sample…" : "Load sample ledger"}
            </Button>
            <Button variant="default" size="sm" onClick={() => fileInput.current?.click()}>
              Upload .jsonl
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".jsonl,.ndjson,.json,text/plain,application/x-ndjson"
              aria-label="Upload a decision ledger file"
              className="sr-only"
              onChange={(event) => void upload(event)}
            />
            {ledgerSource ? <span className="font-mono text-[10px] text-ink-4">{ledgerSource}</span> : null}
          </div>
        </CardContent>
      </Card>

      {reading ? (
        <>
          <Card className="mb-6">
            <CardHeader className="justify-between">
              <CardTitle>Reading</CardTitle>
              <span className="font-mono text-[10px] text-ink-4">
                generated {reading.artifact.generatedAt} · {reading.artifact.contract}
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[12px] leading-5 text-ink-2">
                <b className="font-medium">{PRODUCTION_CALIBRATION_PROVENANCE_LINE}</b>{" "}
                <span className="text-ink-3">
                  evidence · production outcomes · sealed false · independent human validation false · {formatOutcomeSources(reading.artifact.evidence)}
                </span>
              </p>
              <dl className="grid gap-x-7 gap-y-1 font-mono text-[10px] text-ink-4 sm:grid-cols-2 lg:grid-cols-3">
                <Meta label="source" value={describeSource(reading.source)} />
                <Meta label="records" value={`${reading.artifact.records.decisions.total} decisions · ${reading.artifact.records.actions.total} actions · ${reading.artifact.records.outcomes.total} outcomes`} />
                <Meta label="orphans" value={`${reading.artifact.records.actions.orphan} actions · ${reading.artifact.records.outcomes.orphan} outcomes`} />
                <Meta label="superseded outcomes" value={`${reading.artifact.records.outcomes.superseded} · ${reading.artifact.records.outcomes.conflicting} conflicting`} />
                <Meta label="synthetic decisions" value={String(reading.artifact.records.decisions.synthetic)} />
                <Meta label="window" value={formatReportWindow(reading.artifact.window)} />
                <Meta label="decision span" value={`${reading.artifact.records.decisions.firstAt ?? "n/a"} to ${reading.artifact.records.decisions.lastAt ?? "n/a"}`} />
                <Meta label="models" value={reading.artifact.records.models.map((row) => `${formatModelIdentity(row.model)} (${row.decisions})`).join(" · ")} />
                <Meta label="question sets" value={reading.artifact.records.questionSets.map((set) => `${set.name} v${set.version} (${set.decisions})`).join(" · ")} />
                <Meta label="question-set digests" value={[...new Set(reading.artifact.records.questionSets.map((set) => set.digest))].join(" · ")} />
              </dl>
              <label className="grid max-w-[720px] gap-1 font-mono text-[9.5px] uppercase tracking-[0.09em] text-ink-4">
                Question
                <select
                  aria-label="Question"
                  value={selected ? questionOptionKey(selected) : ""}
                  onChange={(event) => selectQuestion(event.target.value)}
                  className="h-8 rounded-sm border border-rule bg-card px-2 font-sans text-[12px] normal-case tracking-normal text-ink"
                >
                  {options.map((option) => (
                    <option key={questionOptionKey(option)} value={questionOptionKey(option)}>{questionOptionLabel(option)}</option>
                  ))}
                </select>
              </label>
            </CardContent>
          </Card>

          {entry?.answerType === "boolean" ? (
            <BooleanReading
              entry={entry}
              threshold={reading.source.kind === "snapshot" ? entry.calibration.confusion.threshold : threshold}
              onThresholdChange={changeThreshold}
              costs={costs}
              onCostsChange={changeCosts}
              pending={recomputing}
              readOnly={reading.source.kind === "snapshot"}
            />
          ) : entry?.answerType === "choice" ? (
            <ChoiceReading entry={entry} />
          ) : entry?.answerType === "score" ? (
            <ScoreReading entry={entry} />
          ) : (
            <p className="text-[12px] text-ink-3">The reading has no question to show.</p>
          )}
        </>
      ) : null}
    </div>
  );
}

function describeSource(source: ReadingSource): string {
  switch (source.kind) {
    case "preview":
      return "pasted ledger · not stored";
    case "stored":
      return `stored records · ${source.recordCount} loaded · record set ${source.recordSetDigest.slice(0, 19)}…`;
    case "snapshot":
      return `snapshot ${source.snapshot.id} · built ${source.snapshot.builtAt} · ${source.snapshot.artifactDigest.slice(0, 19)}…`;
  }
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="inline">{label} · </dt>
      <dd className="inline break-all text-ink-3">{value}</dd>
    </div>
  );
}

function describeError(cause: unknown): string {
  if (cause instanceof ProductionCalibrationApiError) {
    return cause.code === null ? cause.message : `${cause.message} · ${cause.code}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
