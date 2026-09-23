import type { ProductionCalibrationQuestion } from "@rubrist/shared";
import { ReliabilityDiagram } from "./reliability-diagram.js";
import { RateStat, Stat } from "./boolean-reading.js";
import {
  formatModelIdentity,
  formatPercent,
  formatProbability,
  formatRateCompact,
  topConfusionPairs
} from "../../lib/production-calibration-ui.js";

export type ChoiceQuestion = Extract<ProductionCalibrationQuestion, { answerType: "choice" }>;
export type ScoreQuestion = Extract<ProductionCalibrationQuestion, { answerType: "score" }>;

export function ChoiceReading({ entry }: { entry: ChoiceQuestion }) {
  const { calibration } = entry;
  const pairs = topConfusionPairs(calibration.confusion);
  const correct = calibration.confusion.filter((cell) => cell.truth === cell.chosen).reduce((sum, cell) => sum + cell.count, 0);
  return (
    <div className="space-y-6">
      <section aria-label="Choice summary">
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Decisions" value={String(calibration.n)} foot={`${calibration.nWithOutcome} with an outcome`} />
          <RateStat label="Top-1 accuracy" rate={calibration.accuracy} />
          <Stat label="Expected calibration error" value={formatProbability(calibration.ece)} foot="confidence against top-1 correctness" />
          <Stat label="Brier score" value={formatProbability(calibration.brier)} foot="confidence against top-1 correctness" />
        </dl>
      </section>

      <section aria-label="Confidence reliability" className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <ReliabilityDiagram
          bins={calibration.reliability}
          predictedLabel="Mean stated confidence"
          observedLabel="Top-1 correct rate"
          title="Confidence reliability diagram"
        />
        <div className="min-w-0 overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Confidence bin</th>
                <th scope="col">Count</th>
                <th scope="col">Mean confidence</th>
                <th scope="col">Top-1 correct · 95% interval · k/n</th>
              </tr>
            </thead>
            <tbody>
              {calibration.reliability.map((bin) => (
                <tr key={bin.index}>
                  <td className="font-mono text-[11px] text-ink-3">{bin.lower.toFixed(2)} to {bin.upper.toFixed(2)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{bin.count}</td>
                  <td className="font-mono text-[11px] tabular-nums">{bin.meanPredicted === null ? "no decisions" : formatPercent(bin.meanPredicted)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatRateCompact(bin.observedRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Confusion pairs" className="grid gap-4 xl:grid-cols-2">
        <div className="overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-serif text-[14px] font-medium">Top confusion pairs</div>
            <span className="font-mono text-[10px] text-ink-4">{correct} correct · {calibration.nWithOutcome - correct} confused</span>
          </div>
          {pairs.length === 0 ? (
            <p className="text-[11.5px] text-ink-3">
              {calibration.nWithOutcome === 0 ? "No outcomes have been posted for this question." : "Every chosen option matched its outcome."}
            </p>
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Truth</th>
                  <th scope="col">Chosen</th>
                  <th scope="col">Count</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((cell) => (
                  <tr key={`${cell.truth}->${cell.chosen}`}>
                    <td className="font-mono text-[11px]">{cell.truth}</td>
                    <td className="font-mono text-[11px]">{cell.chosen}</td>
                    <td className="font-mono text-[11px] tabular-nums">{cell.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="overflow-x-auto">
          <div className="mb-2 font-serif text-[14px] font-medium">By model identity</div>
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Decisions</th>
                <th scope="col">Top-1 accuracy · 95% interval · k/n</th>
                <th scope="col">ECE</th>
              </tr>
            </thead>
            <tbody>
              {calibration.byModel.map((group) => (
                <tr key={formatModelIdentity(group.model)}>
                  <td className="font-mono text-[11px]">{formatModelIdentity(group.model)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{group.n} · {group.nWithOutcome} with outcome</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatRateCompact(group.accuracy)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatProbability(group.ece)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function ScoreNotice({ entry }: { entry: ScoreQuestion }) {
  return (
    <section aria-label="Score question" className="rounded-sm border border-dashed border-rule bg-paper-2 p-4">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-4">not implemented · {entry.calibration.reason.replaceAll("_", " ")}</div>
      <p className="mt-2 max-w-[70ch] text-[12px] leading-5 text-ink-2">
        Score (ordinal) calibration is reported as not implemented by the shared module. This question has{" "}
        {entry.calibration.n} decision{entry.calibration.n === 1 ? "" : "s"} and {entry.calibration.nWithOutcome} outcome{entry.calibration.nWithOutcome === 1 ? "" : "s"};
        nothing else is claimed about it.
      </p>
    </section>
  );
}
