import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { SectionHead } from "@/components/coeval";
import { DatabaseModeRequired } from "@/components/database-mode-required";
import { useAppMode } from "@/lib/app-mode";
import { BooleanReading } from "../components/production-calibration/boolean-reading.js";
import { ChoiceReading, ScoreNotice } from "../components/production-calibration/choice-reading.js";
import {
  fetchProductionCalibrationSample,
  previewProductionCalibration,
  ProductionCalibrationApiError,
  type ProductionCalibrationPreview
} from "../lib/production-calibration-api.js";
import {
  PRODUCTION_CALIBRATION_GOVERNED_REVIEW_NOTE,
  PRODUCTION_CALIBRATION_PROVENANCE_LINE,
  costsFromInputs,
  formatModelIdentity,
  formatOutcomeSources,
  questionOptionKey,
  questionOptionLabel,
  questionOptions,
  type CostInputs
} from "../lib/production-calibration-ui.js";

const DEFAULT_THRESHOLD = 0.5;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const RECOMPUTE_DELAY_MS = 250;
const EMPTY_COSTS: CostInputs = { falsePositive: "", falseNegative: "", humanReview: "" };

export function ProductionCalibrationScreen() {
  const { demoMode } = useAppMode();
  if (demoMode) {
    return (
      <DatabaseModeRequired
        eyebrow="Production calibration · demo mode"
        title="Production calibration previews need a signed-in project."
        description="The preview is computed for one project membership and returned to that session. Nothing is stored, but the request is still scoped to a project."
        demoAlternative="The demo has no project session to scope a ledger preview to. Configure Postgres and sign in to paste a decision ledger."
      />
    );
  }
  return <PersistentProductionCalibrationScreen />;
}

function PersistentProductionCalibrationScreen() {
  const [ledger, setLedger] = useState("");
  const [ledgerSource, setLedgerSource] = useState<string | null>(null);
  const [bins, setBins] = useState("10");
  const [windowDays, setWindowDays] = useState("7");
  const [preview, setPreview] = useState<ProductionCalibrationPreview | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [costs, setCosts] = useState<CostInputs>(EMPTY_COSTS);
  const [computing, setComputing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const options = preview ? questionOptions(preview.artifact, preview.summary.questions) : [];
  const selected = options.find((option) => questionOptionKey(option) === selectedKey) ?? options[0] ?? null;
  const entry = preview && selected
    ? preview.artifact.questions.find((question) =>
      question.question === selected.question && question.answerType === selected.answerType) ?? null
    : null;

  const parsedBins = Number.parseInt(bins, 10);
  const parsedWindowDays = Number.parseInt(windowDays, 10);
  const baseParams = {
    ...(Number.isInteger(parsedBins) && parsedBins >= 1 && parsedBins <= 100 ? { bins: parsedBins } : {}),
    ...(Number.isInteger(parsedWindowDays) && parsedWindowDays >= 1 && parsedWindowDays <= 366 ? { windowDays: parsedWindowDays } : {})
  };

  const run = useCallback(async (input: {
    records: string;
    question?: string;
    threshold?: number;
    costs?: ReturnType<typeof costsFromInputs>;
    bins?: number;
    windowDays?: number;
  }, mode: "compute" | "recompute") => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    if (mode === "compute") setComputing(true);
    else setRecomputing(true);
    setError(null);
    try {
      const next = await previewProductionCalibration({
        records: input.records,
        ...(input.question === undefined ? {} : { question: input.question }),
        ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
        ...(input.costs === undefined || input.costs === null ? {} : { costs: input.costs }),
        ...(input.bins === undefined ? {} : { bins: input.bins }),
        ...(input.windowDays === undefined ? {} : { windowDays: input.windowDays })
      }, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(next);
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

  function compute(): void {
    if (ledger.trim() === "") {
      setError("Paste or upload a decision ledger first.");
      return;
    }
    setSelectedKey(null);
    setThreshold(DEFAULT_THRESHOLD);
    setCosts(EMPTY_COSTS);
    void run({ records: ledger, ...baseParams }, "compute");
  }

  // Threshold and cost changes re-request the preview scoped to the selected
  // boolean question after a short pause; the ledger never leaves component
  // state between calls, and a newer request aborts the one in flight.
  const recomputeTimer = useRef<number | null>(null);
  function scheduleRecompute(next: { threshold: number; costs: CostInputs }): void {
    if (!entry || entry.answerType !== "boolean") return;
    if (recomputeTimer.current !== null) window.clearTimeout(recomputeTimer.current);
    const question = entry.question;
    recomputeTimer.current = window.setTimeout(() => {
      recomputeTimer.current = null;
      void run({
        records: ledger,
        question,
        threshold: next.threshold,
        costs: costsFromInputs(next.costs),
        ...baseParams
      }, "recompute");
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
      setPreview(null);
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
    setPreview(null);
  }

  function selectQuestion(key: string): void {
    setSelectedKey(key);
    setThreshold(DEFAULT_THRESHOLD);
    setCosts(EMPTY_COSTS);
  }

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Production calibration · ungoverned · compute-only"
        title="Production calibration"
        sub="A production decision is a Check whose evaluator is the agent's own decision model: the question is the criterion, each decision is a result with a probability, and the outcome that arrived later is the label. Paste a decision ledger to see whether the stated probabilities held up. Nothing is stored."
      />

      <p role="note" className="mb-5 rounded-sm border border-gold-tint bg-ambig-bg px-4 py-3 text-[12.5px] leading-5 text-ink-2">
        <b className="font-medium">{PRODUCTION_CALIBRATION_PROVENANCE_LINE}</b>{" "}
        <span className="text-ink-3">{PRODUCTION_CALIBRATION_GOVERNED_REVIEW_NOTE}</span>
      </p>

      {error ? (
        <div role="alert" className="mb-5 rounded-sm border border-signal-tint bg-signal-wash px-4 py-3 text-[12px] text-signal">{error}</div>
      ) : null}

      <Card className="mb-6">
        <CardHeader className="justify-between">
          <CardTitle>Decision ledger</CardTitle>
          <span className="font-mono text-[10px] text-ink-4">
            coeval/production-decision-record/v1 · JSON Lines · decision, action, outcome records · up to {MAX_UPLOAD_BYTES / (1024 * 1024)} MiB
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
            <Button variant="primary" size="sm" onClick={compute} disabled={computing || ledger.trim() === ""}>
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
            <label className="grid gap-1 font-mono text-[9.5px] uppercase tracking-[0.09em] text-ink-4">
              Reliability bins
              <input
                type="number"
                min={1}
                max={100}
                value={bins}
                onChange={(event) => setBins(event.target.value)}
                className="h-7 w-20 rounded-sm border border-rule bg-paper px-2 font-sans text-[12px] normal-case tracking-normal text-ink"
              />
            </label>
            <label className="grid gap-1 font-mono text-[9.5px] uppercase tracking-[0.09em] text-ink-4">
              Drift window · days
              <input
                type="number"
                min={1}
                max={366}
                value={windowDays}
                onChange={(event) => setWindowDays(event.target.value)}
                className="h-7 w-20 rounded-sm border border-rule bg-paper px-2 font-sans text-[12px] normal-case tracking-normal text-ink"
              />
            </label>
            {ledgerSource ? <span className="font-mono text-[10px] text-ink-4">{ledgerSource}</span> : null}
          </div>
        </CardContent>
      </Card>

      {preview ? (
        <>
          <Card className="mb-6">
            <CardHeader className="justify-between">
              <CardTitle>Reading</CardTitle>
              <span className="font-mono text-[10px] text-ink-4">
                generated {preview.artifact.generatedAt} · {preview.artifact.contract}
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[12px] leading-5 text-ink-2">
                <b className="font-medium">{PRODUCTION_CALIBRATION_PROVENANCE_LINE}</b>{" "}
                <span className="text-ink-3">
                  evidence · production outcomes · sealed false · independent human validation false · {formatOutcomeSources(preview.artifact.evidence)}
                </span>
              </p>
              <dl className="grid gap-x-7 gap-y-1 font-mono text-[10px] text-ink-4 sm:grid-cols-2 lg:grid-cols-3">
                <Meta label="records" value={`${preview.summary.records.total} · ${preview.summary.records.decisions} decisions · ${preview.summary.records.actions} actions · ${preview.summary.records.outcomes} outcomes`} />
                <Meta label="orphans" value={`${preview.artifact.records.actions.orphan} actions · ${preview.artifact.records.outcomes.orphan} outcomes`} />
                <Meta label="superseded outcomes" value={`${preview.artifact.records.outcomes.superseded} · ${preview.artifact.records.outcomes.conflicting} conflicting`} />
                <Meta label="synthetic decisions" value={String(preview.artifact.records.decisions.synthetic)} />
                <Meta label="decision span" value={`${preview.artifact.records.decisions.firstAt ?? "n/a"} to ${preview.artifact.records.decisions.lastAt ?? "n/a"}`} />
                <Meta label="models" value={preview.summary.models.map((row) => `${formatModelIdentity(row.model)} (${row.decisions})`).join(" · ")} />
                <Meta label="question sets" value={preview.artifact.records.questionSets.map((set) => `${set.name} v${set.version} (${set.decisions})`).join(" · ")} />
                <Meta label="question-set digests" value={preview.summary.questionSetDigests.join(" · ")} />
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
              threshold={threshold}
              onThresholdChange={changeThreshold}
              costs={costs}
              onCostsChange={changeCosts}
              pending={recomputing}
            />
          ) : entry?.answerType === "choice" ? (
            <ChoiceReading entry={entry} />
          ) : entry?.answerType === "score" ? (
            <ScoreNotice entry={entry} />
          ) : (
            <p className="text-[12px] text-ink-3">The ledger has decisions but no question to read.</p>
          )}
        </>
      ) : null}
    </div>
  );
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
