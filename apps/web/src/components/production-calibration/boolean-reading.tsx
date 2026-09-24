import type { ProductionCalibrationQuestion, ProductionCalibrationWilsonRate } from "@rubrist/shared";
import { ReliabilityDiagram } from "./reliability-diagram.js";
import {
  adviceState,
  cheapestBandRows,
  driftFlags,
  formatModelIdentity,
  formatPercent,
  formatProbability,
  formatRate,
  formatRateCompact,
  formatWindow,
  type CostInputs
} from "../../lib/production-calibration-ui.js";

export type BooleanQuestion = Extract<ProductionCalibrationQuestion, { answerType: "boolean" }>;

export interface BooleanReadingProps {
  entry: BooleanQuestion;
  /** The threshold the controls currently show; may lead the artifact while a recomputation is pending. */
  threshold: number;
  onThresholdChange: (threshold: number) => void;
  costs: CostInputs;
  onCostsChange: (costs: CostInputs) => void;
  pending: boolean;
  /** A saved snapshot: its parameters are fixed, so the threshold and cost controls are disabled. */
  readOnly?: boolean;
}

export function BooleanReading({ entry, threshold, onThresholdChange, costs, onCostsChange, pending, readOnly = false }: BooleanReadingProps) {
  const { calibration, drift } = entry;
  const advice = adviceState(entry.thresholdAdvice);
  const confusion = calibration.confusion;
  return (
    <div className="space-y-6">
      <section aria-label="Calibration summary">
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Decisions" value={String(calibration.n)} foot={`${calibration.nWithOutcome} with an outcome`} />
          <Stat label="Brier score" value={formatProbability(calibration.brier)} foot="0 is perfect · 0.25 is always saying 0.5" />
          <Stat label="Expected calibration error" value={formatProbability(calibration.ece)} foot={`${calibration.bins} equal-width bins, weighted by count`} />
          <Stat label="Positive class" value={String(calibration.positiveClass)} foot={`event of interest is the ${calibration.positiveClass} answer`} />
        </dl>
      </section>

      <section aria-label="Reliability" className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <ReliabilityDiagram bins={calibration.reliability} />
        <div className="min-w-0 overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Bin</th>
                <th scope="col">Count</th>
                <th scope="col">Mean predicted</th>
                <th scope="col">Observed rate · 95% interval · k/n</th>
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

      <section aria-label="Decision threshold" className="rounded-sm border border-rule-soft bg-paper-2 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="grid min-w-0 flex-1 gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">
            <span>Threshold · p &gt;= {threshold.toFixed(2)} counts as predicted {String(calibration.positiveClass)}</span>
            <input
              type="range"
              min={0.01}
              max={0.99}
              step={0.01}
              value={threshold}
              onChange={(event) => onThresholdChange(Number(event.target.value))}
              disabled={readOnly}
              aria-label="Decision threshold"
              className="w-full max-w-[420px] accent-[var(--ink)]"
            />
          </label>
          <span className="font-mono text-[10px] text-ink-4" aria-live="polite">
            {readOnly
              ? `saved snapshot · confusion at ${confusion.threshold.toFixed(2)}`
              : pending
                ? `recomputing at ${threshold.toFixed(2)}…`
                : `showing confusion at ${confusion.threshold.toFixed(2)}`}
          </span>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
          <table className="ledger max-w-[360px]" aria-label="Confusion matrix">
            <thead>
              <tr>
                <th scope="col">{`p >= ${confusion.threshold.toFixed(2)}`}</th>
                <th scope="col">Outcome true</th>
                <th scope="col">Outcome false</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Predicted true</th>
                <td className="font-mono text-[12px] tabular-nums">{confusion.truePositive} <span className="text-ink-4">TP</span></td>
                <td className="font-mono text-[12px] tabular-nums">{confusion.falsePositive} <span className="text-ink-4">FP</span></td>
              </tr>
              <tr>
                <th scope="row" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Predicted false</th>
                <td className="font-mono text-[12px] tabular-nums">{confusion.falseNegative} <span className="text-ink-4">FN</span></td>
                <td className="font-mono text-[12px] tabular-nums">{confusion.trueNegative} <span className="text-ink-4">TN</span></td>
              </tr>
            </tbody>
          </table>
          <dl className="grid gap-2 sm:grid-cols-2">
            <RateStat label="Accuracy" rate={confusion.accuracy} />
            <RateStat label="Precision" rate={confusion.precision} />
            <RateStat label="Recall" rate={confusion.recall} />
            <RateStat label="Specificity" rate={confusion.specificity} />
          </dl>
        </div>
        <ul className="mt-3 space-y-1 text-[11.5px] leading-5 text-ink-3">
          <li>False positive · {calibration.errorDirections.falsePositive.definition} · {calibration.errorDirections.falsePositive.count}</li>
          <li>False negative · {calibration.errorDirections.falseNegative.definition} · {calibration.errorDirections.falseNegative.count}</li>
        </ul>
      </section>

      <section aria-label="Threshold advisor" className="rounded-sm border border-rule-soft bg-card p-4">
        <div className="font-serif text-[14px] font-medium">Threshold advisor</div>
        <p className="mt-1 max-w-[70ch] text-[11.5px] leading-5 text-ink-3">
          An empirical sweep from 0.05 to 0.95 over the decisions that already have outcomes. It assumes tomorrow
          looks like this ledger. It recommends; it does not decide, and release thresholds stay outside Rubrist.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <CostField
            label="Cost of a false positive"
            value={costs.falsePositive}
            onChange={(value) => onCostsChange({ ...costs, falsePositive: value })}
            disabled={readOnly}
          />
          <CostField
            label="Cost of a false negative"
            value={costs.falseNegative}
            onChange={(value) => onCostsChange({ ...costs, falseNegative: value })}
            disabled={readOnly}
          />
          <CostField
            label="Cost of one human review (optional)"
            value={costs.humanReview}
            onChange={(value) => onCostsChange({ ...costs, humanReview: value })}
            disabled={readOnly}
          />
        </div>
        <div
          className={`mt-4 rounded-sm border px-3 py-2.5 text-[11.5px] leading-5 ${
            advice.kind === "thin" ? "border-gold-tint bg-ambig-bg text-ink-2" : "border-rule-soft bg-paper-2 text-ink-2"
          }`}
          data-advice-state={advice.kind}
        >
          <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-4">
            {advice.kind === "not_requested" ? "no costs entered" : null}
            {advice.kind === "no_outcomes" ? "no outcomes · no recommendation" : null}
            {advice.kind === "thin" ? "fewer than 30 outcomes · indicative only" : null}
            {advice.kind === "ready" ? (entry.thresholdAdvice?.mode === "band" ? "review band" : "single threshold") : null}
          </div>
          <p className="mt-1">{advice.text}</p>
          {advice.kind === "thin" || advice.kind === "ready" ? (
            <p className="mt-1 font-mono text-[11px] text-ink">{advice.recommendation}</p>
          ) : null}
        </div>
        {entry.thresholdAdvice && entry.thresholdAdvice.recommendation !== null ? (
          <AdviceSweep advice={entry.thresholdAdvice} />
        ) : null}
      </section>

      <section aria-label="Drift by window">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-serif text-[14px] font-medium">Drift by {drift.windowDays}-day window</div>
          <span className="font-mono text-[10px] text-ink-4">
            drift flag needs at least {drift.minOutcomesToFlag} outcomes and the mean prediction outside the observed interval
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Window (UTC)</th>
                <th scope="col">Decisions</th>
                <th scope="col">Mean predicted</th>
                <th scope="col">Observed rate · 95% interval · k/n</th>
                <th scope="col">Brier</th>
                <th scope="col">Models</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {drift.windows.map((window) => {
                const flags = driftFlags(window);
                return (
                  <tr key={window.index}>
                    <td className="font-mono text-[11px] text-ink-3">{formatWindow(window)}</td>
                    <td className="font-mono text-[11px] tabular-nums">{window.n} · {window.nWithOutcome} with outcome</td>
                    <td className="font-mono text-[11px] tabular-nums">{window.meanPredicted === null ? "n/a" : formatPercent(window.meanPredicted)}</td>
                    <td className="font-mono text-[11px] tabular-nums">{formatRateCompact(window.observedRate)}</td>
                    <td className="font-mono text-[11px] tabular-nums">{formatProbability(window.brier)}</td>
                    <td className="font-mono text-[11px] text-ink-3">{window.models.map(formatModelIdentity).join(" · ") || "none"}</td>
                    <td className={`font-mono text-[11px] ${flags.length ? "text-signal" : "text-ink-4"}`}>{flags.length ? flags.join(" · ") : "none"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="By model and question set" className="grid gap-4 xl:grid-cols-2">
        <div className="overflow-x-auto">
          <div className="mb-2 font-serif text-[14px] font-medium">By model identity</div>
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Decisions</th>
                <th scope="col">Brier</th>
                <th scope="col">ECE</th>
              </tr>
            </thead>
            <tbody>
              {calibration.byModel.map((group) => (
                <tr key={formatModelIdentity(group.model)}>
                  <td className="font-mono text-[11px]">{formatModelIdentity(group.model)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{group.n} · {group.nWithOutcome} with outcome</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatProbability(group.brier)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatProbability(group.ece)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <div className="mb-2 font-serif text-[14px] font-medium">By question-set digest</div>
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Digest</th>
                <th scope="col">Decisions</th>
                <th scope="col">Brier</th>
                <th scope="col">ECE</th>
              </tr>
            </thead>
            <tbody>
              {calibration.byDigest.map((group) => (
                <tr key={group.questionSetDigest}>
                  <td className="break-all font-mono text-[10px]">{group.questionSetDigest}</td>
                  <td className="font-mono text-[11px] tabular-nums">{group.n} · {group.nWithOutcome} with outcome</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatProbability(group.brier)}</td>
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

function AdviceSweep({ advice }: { advice: NonNullable<BooleanQuestion["thresholdAdvice"]> }) {
  if (advice.mode === "single") {
    return (
      <div className="mt-3 overflow-x-auto">
        <table className="ledger" aria-label="Threshold sweep">
          <thead>
            <tr>
              <th scope="col">Threshold</th>
              <th scope="col">FP</th>
              <th scope="col">FN</th>
              <th scope="col">Error rate among automated</th>
              <th scope="col">Expected cost per decision</th>
            </tr>
          </thead>
          <tbody>
            {advice.sweep.map((row) => {
              const chosen = advice.recommendation?.threshold === row.threshold;
              return (
                <tr key={row.threshold} className={chosen ? "selected" : undefined}>
                  <td className="font-mono text-[11px] tabular-nums">{row.threshold.toFixed(2)}{chosen ? " · recommended" : ""}</td>
                  <td className="font-mono text-[11px] tabular-nums">{row.falsePositives}</td>
                  <td className="font-mono text-[11px] tabular-nums">{row.falseNegatives}</td>
                  <td className="font-mono text-[11px] tabular-nums">{formatRateCompact(row.errorRateAmongAutomated)}</td>
                  <td className="font-mono text-[11px] tabular-nums">{row.expectedCostPerDecision.toFixed(3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
  const rows = cheapestBandRows(advice);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="ledger" aria-label="Cheapest review bands">
        <thead>
          <tr>
            <th scope="col">Auto-no at p &lt;=</th>
            <th scope="col">Auto-yes at p &gt;=</th>
            <th scope="col">Reviewed</th>
            <th scope="col">Automation</th>
            <th scope="col">Error rate among automated</th>
            <th scope="col">Expected cost per decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const chosen = advice.recommendation?.low === row.low && advice.recommendation.high === row.high;
            return (
              <tr key={`${row.low}-${row.high}`} className={chosen ? "selected" : undefined}>
                <td className="font-mono text-[11px] tabular-nums">{row.low.toFixed(2)}{chosen ? " · recommended" : ""}</td>
                <td className="font-mono text-[11px] tabular-nums">{row.high.toFixed(2)}</td>
                <td className="font-mono text-[11px] tabular-nums">{row.humanReviews}</td>
                <td className="font-mono text-[11px] tabular-nums">{row.automated}/{row.automated + row.humanReviews} = {formatPercent(row.automationRate)}</td>
                <td className="font-mono text-[11px] tabular-nums">{formatRateCompact(row.errorRateAmongAutomated)}</td>
                <td className="font-mono text-[11px] tabular-nums">{row.expectedCostPerDecision.toFixed(3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 font-mono text-[10px] text-ink-4">The {rows.length} cheapest of {advice.sweep.length} band pairs; ties go to more automation.</p>
    </div>
  );
}

function CostField({ label, value, onChange, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="grid gap-1 font-mono text-[9.5px] uppercase tracking-[0.09em] text-ink-4">
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder="0"
        className="h-8 w-full rounded-sm border border-rule bg-paper px-2 font-sans text-[12px] normal-case tracking-normal text-ink"
      />
    </label>
  );
}

export function Stat({ label, value, foot }: { label: string; value: string; foot?: string }) {
  return (
    <div className="rounded-sm border border-rule-soft bg-card px-3 py-2.5">
      <dt className="font-mono text-[9px] uppercase tracking-[0.09em] text-ink-4">{label}</dt>
      <dd className="mt-1 font-serif text-[20px] font-medium leading-none tabular-nums">{value}</dd>
      {foot ? <dd className="mt-1.5 font-mono text-[10px] text-ink-4">{foot}</dd> : null}
    </div>
  );
}

export function RateStat({ label, rate }: { label: string; rate: ProductionCalibrationWilsonRate }) {
  return (
    <div className="rounded-sm bg-card px-3 py-2">
      <dt className="font-mono text-[9px] uppercase tracking-[0.09em] text-ink-4">{label}</dt>
      <dd className="mt-1 font-mono text-[11px] leading-5 text-ink-2">{formatRate(rate)}</dd>
    </div>
  );
}
