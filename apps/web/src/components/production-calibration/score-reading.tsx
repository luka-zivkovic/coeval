import type { ProductionCalibrationQuestion } from "@rubrist/shared";
import { ReliabilityDiagram } from "./reliability-diagram.js";
import { RateStat, Stat } from "./boolean-reading.js";
import {
  formatLevels,
  formatModelIdentity,
  formatPercent,
  formatProbability,
  formatRateCompact,
  scoreBias,
  scoreExclusionText,
  scoreUndefinedText,
  topScoreConfusionPairs
} from "../../lib/production-calibration-ui.js";

export type ScoreQuestion = Extract<ProductionCalibrationQuestion, { answerType: "score" }>;

export function ScoreReading({ entry }: { entry: ScoreQuestion }) {
  const { calibration } = entry;
  const exclusions = scoreExclusionText(calibration.excluded);
  if (calibration.state === "undefined") {
    return (
      <section aria-label="Score question" className="rounded-sm border border-dashed border-rule bg-paper-2 p-4">
        <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-4">
          undefined · {calibration.undefinedReason.replaceAll("_", " ")}
        </div>
        <p className="mt-2 max-w-[70ch] text-[12px] leading-5 text-ink-2">{scoreUndefinedText(calibration)}</p>
        {exclusions ? <p className="mt-2 max-w-[70ch] text-[11.5px] leading-5 text-ink-3">{exclusions}</p> : null}
      </section>
    );
  }

  const bias = scoreBias(calibration.meanSignedError);
  const pairs = topScoreConfusionPairs(calibration.confusion);
  const exact = calibration.confusion.filter((cell) => cell.truth === cell.predicted).reduce((sum, cell) => sum + cell.count, 0);
  return (
    <div className="space-y-6">
      <section aria-label="Score summary" className="space-y-2">
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <Stat
            label="Decisions"
            value={String(calibration.n)}
            foot={`${calibration.nWithOutcome} with an outcome · ${calibration.levels} levels, 0 to ${calibration.levels - 1}`}
          />
          <RateStat label="Exact level" rate={calibration.exactAccuracy} />
          <RateStat label="Within one level" rate={calibration.withinOneAccuracy} />
          <Stat label="Mean absolute error" value={formatLevels(calibration.meanAbsoluteError)} foot="stated mean against the outcome level" />
          <Stat label="Bias" value={bias.value} foot={bias.direction} />
          <Stat
            label="Ranked probability score"
            value={formatProbability(calibration.rankedProbabilityScore)}
            foot="Brier over every level cut; 0 is perfect"
          />
        </dl>
        {exclusions ? <p className="text-[11.5px] leading-5 text-ink-3">{exclusions}</p> : null}
      </section>

      <section aria-label="Confidence reliability" className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <ReliabilityDiagram
          bins={calibration.reliability}
          predictedLabel="Probability of the most likely level"
          observedLabel="Exact level rate"
          title="Confidence reliability diagram"
        />
        <div className="min-w-0 overflow-x-auto">
          <div className="mb-2 font-mono text-[10px] text-ink-4">
            ECE {formatProbability(calibration.ece)} · Brier {formatProbability(calibration.brier)} · most likely level against exact correctness
          </div>
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Confidence bin</th>
                <th scope="col">Count</th>
                <th scope="col">Mean confidence</th>
                <th scope="col">Exact level · 95% interval · k/n</th>
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

      <section aria-label="Cumulative level cuts" className="overflow-x-auto">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-serif text-[14px] font-medium">Cumulative level cuts</div>
          <span className="font-mono text-[10px] text-ink-4">P(level ≥ k) against whether the outcome reached level k</span>
        </div>
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Outcome level</th>
              <th scope="col">Mean predicted</th>
              <th scope="col">Observed · 95% interval · k/n</th>
              <th scope="col">Brier</th>
              <th scope="col">ECE</th>
            </tr>
          </thead>
          <tbody>
            {calibration.cumulative.map((cut) => (
              <tr key={cut.atLeast}>
                <td className="font-mono text-[11px]">≥ {cut.atLeast}</td>
                <td className="font-mono text-[11px] tabular-nums">{cut.meanPredicted === null ? "no outcomes" : formatPercent(cut.meanPredicted)}</td>
                <td className="font-mono text-[11px] tabular-nums">{formatRateCompact(cut.observedRate)}</td>
                <td className="font-mono text-[11px] tabular-nums">{formatProbability(cut.brier)}</td>
                <td className="font-mono text-[11px] tabular-nums">{formatProbability(cut.ece)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Level confusion" className="grid gap-4 xl:grid-cols-2">
        <div className="overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-serif text-[14px] font-medium">Top level confusions</div>
            <span className="font-mono text-[10px] text-ink-4">{exact} exact · {calibration.nWithOutcome - exact} off</span>
          </div>
          {pairs.length === 0 ? (
            <p className="text-[11.5px] text-ink-3">
              {calibration.nWithOutcome === 0 ? "No outcomes have been posted for this question." : "Every most likely level matched its outcome."}
            </p>
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Outcome level</th>
                  <th scope="col">Most likely level</th>
                  <th scope="col">Count</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((cell) => (
                  <tr key={`${cell.truth}->${cell.predicted}`}>
                    <td className="font-mono text-[11px] tabular-nums">{cell.truth}</td>
                    <td className="font-mono text-[11px] tabular-nums">{cell.predicted}</td>
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
                <th scope="col">Exact level · 95% interval · k/n</th>
                <th scope="col">Mean absolute error</th>
                <th scope="col">RPS</th>
              </tr>
            </thead>
            <tbody>
              {calibration.byModel.map((group) => (
                <tr key={formatModelIdentity(group.model)}>
                  <td className="font-mono text-[11px]">{formatModelIdentity(group.model)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{group.n} · {group.nWithOutcome} with outcome</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatRateCompact(group.exactAccuracy)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatLevels(group.meanAbsoluteError)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatProbability(group.rankedProbabilityScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
