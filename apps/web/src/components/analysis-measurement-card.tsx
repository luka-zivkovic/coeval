import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AnalysisWorkflowMeasurementReport, BinaryCalibrationWilsonRate } from "@coeval/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchAnalysisWorkflowMeasurement } from "@/lib/analysis-measurement-api";

export function AnalysisMeasurementCard({
  studyId,
  taxonomyRevisionId
}: {
  studyId: string;
  taxonomyRevisionId: string | null;
}) {
  const [report, setReport] = useState<AnalysisWorkflowMeasurementReport | null>(null);
  const [skillVersionId, setSkillVersionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    setSkillVersionId("");
    setReport(null);
  }, [studyId]);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    void fetchAnalysisWorkflowMeasurement({
      studyId,
      taxonomyRevisionId,
      skillVersionId: skillVersionId || null
    }).then(({ report: value }) => {
      if (generation.current === current) setReport(value);
    }).catch((cause) => {
      if (generation.current === current) {
        setError(cause instanceof Error ? cause.message : "Component measurement request failed");
      }
    }).finally(() => {
      if (generation.current === current) setLoading(false);
    });
  }, [studyId, taxonomyRevisionId, skillVersionId]);

  return <Card>
    <CardHeader className="justify-between">
      <CardTitle>Versioned component measurements</CardTitle>
      {report ? <span className="font-mono text-[9px] text-ink-4">{report.calculationVersion}</span> : null}
    </CardHeader>
    <CardContent>
      <p className="mb-4 text-[11px] text-ink-3">
        Components remain separate. Missing, running, and incomplete evidence is shown explicitly and is never treated as zero or success.
      </p>
      {error ? <p role="alert" className="text-[11px] text-signal">{error}</p> : null}
      {loading && !report ? <p className="text-[11px] text-ink-3">Loading exact evidence bindings…</p> : null}
      {report ? <div className="space-y-5">
        <MeasurementSection title="Coding completion">
          <MeasurementFact label="Selected" value={report.coding.selectedItemCount} />
          <MeasurementFact label="Viewed" value={report.coding.viewedItemCount} />
          <MeasurementFact label="In progress" value={report.coding.inProgressItemCount} />
          <MeasurementFact label="Completed" value={report.coding.completedItemCount} />
          <MeasurementFact label="No failure observed" value={report.coding.noFailureObservedItemCount} />
          <MeasurementFact label="Missing" value={report.coding.missingItemCount} />
        </MeasurementSection>

        {report.taxonomy.state === "available" ? <>
          <MeasurementSection title="Taxonomy coverage">
            <MeasurementFact label="Active observations" value={report.taxonomy.coverage.activeFailureObservationCount} />
            <MeasurementFact label="Categorized" value={report.taxonomy.coverage.categorized} />
            <MeasurementFact label="Assigned to retired code" value={report.taxonomy.coverage.assignedToRetiredCode} />
            <MeasurementFact label="Uncategorized" value={report.taxonomy.coverage.uncategorized} />
            <MeasurementFact label="Selected item denominator" value={report.taxonomy.coverage.selectedItemCount} />
            <MeasurementFact label="Completed item denominator" value={report.taxonomy.coverage.completedItemCount} />
          </MeasurementSection>
          <MeasurementSection title="Taxonomy churn">
            <MeasurementFact label="Additions" value={report.taxonomy.churn.additions} />
            <MeasurementFact label="Label changes" value={report.taxonomy.churn.labelChanges} />
            <MeasurementFact label="Definition changes" value={report.taxonomy.churn.definitionChanges} />
            <MeasurementFact label="Retirements" value={report.taxonomy.churn.retirements} />
            <MeasurementFact label="Observation reassignments" value={report.taxonomy.churn.observationReassignments} />
          </MeasurementSection>
        </> : <p className="text-[11px] text-ink-3">Choose a taxonomy revision to calculate exact coverage and churn.</p>}

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-ink-4">Evaluator evidence (optional)
            <select value={skillVersionId} onChange={(event) => setSkillVersionId(event.target.value)}
              className="mt-1 h-9 w-full rounded-sm border border-rule bg-card px-3 text-[12px] normal-case tracking-normal text-ink">
              <option value="">No evaluator selected</option>
              {report.evaluatorOptions.map((option) => <option key={option.skillVersionId} value={option.skillVersionId}>
                {option.skillVersionId} · criterion {option.criterionId}
              </option>)}
            </select>
          </label>
          {report.evaluatorOptions.length === 0 ? <p className="mt-2 text-[11px] text-ink-3">
            No evaluator lifecycle is bound to this study yet. Coding and taxonomy measurements remain available.
          </p> : null}
        </div>

        {report.evaluator ? <EvaluatorComponents evaluator={report.evaluator} /> : null}
        <div className="break-all border-t border-rule-soft pt-3 font-mono text-[9px] text-ink-4">
          report {report.reportDigest}
        </div>
      </div> : null}
    </CardContent>
  </Card>;
}

function EvaluatorComponents({ evaluator }: {
  evaluator: NonNullable<AnalysisWorkflowMeasurementReport["evaluator"]>;
}) {
  const calibration = evaluator.calibration;
  return <div className="space-y-5">
    <MeasurementSection title="Governed reviewer disagreement">
      <MeasurementFact label="Unanimous" value={evaluator.governedDisagreement.unanimous} />
      <MeasurementFact label="Mixed pass / fail" value={evaluator.governedDisagreement.mixedPassFail} />
      <MeasurementFact label="Cannot determine" value={evaluator.governedDisagreement.cannotDetermine} />
      <MeasurementFact label="Coverage gap" value={evaluator.governedDisagreement.coverageGap} />
      <MeasurementFact label="Unresolvable" value={evaluator.governedDisagreement.unresolvable} />
      <MeasurementFact label="Single rater" value={evaluator.governedDisagreement.singleRater} />
      <MeasurementFact label="Adjudicated (cross-cutting)" value={evaluator.governedDisagreement.adjudicated} />
    </MeasurementSection>

    <div>
      <h4 className="mb-2 font-serif text-[13px]">Calibration components</h4>
      <p className="text-[11px] text-ink-3">State: <span className="font-mono">{calibration.state}</span></p>
      {calibration.state === "complete" || calibration.state === "incomplete" ? <div className="mt-3 space-y-3">
        <MeasurementSection title={`Aggregate artifact · ${calibration.currentAdmissibility}`}>
          <MeasurementFact label="Truth support" value={calibration.truthSupport.total} />
          <MeasurementFact label="Truth pass" value={calibration.truthSupport.pass} />
          <MeasurementFact label="Truth fail" value={calibration.truthSupport.fail} />
        </MeasurementSection>
        {calibration.trials.map((trial) => <MeasurementSection key={trial.trialIndex} title={`Trial ${trial.trialIndex + 1} · ${trial.status}`}>
          <MeasurementFact label="Classified" value={trial.classified} />
          <MeasurementFact label="Abstained" value={trial.abstained} />
          <MeasurementFact label="Errored" value={trial.errored} />
          <MeasurementFact label="Unevaluated" value={trial.unevaluated} />
          <MeasurementFact label="False pass" value={trial.falsePass} />
          <MeasurementFact label="False fail" value={trial.falseFail} />
          <MeasurementFact label="Classified coverage" value={rate(trial.classifiedCoverage.overall)} />
          <MeasurementFact label="Truth-pass coverage" value={rate(trial.classifiedCoverage.truthPass)} />
          <MeasurementFact label="Truth-fail coverage" value={rate(trial.classifiedCoverage.truthFail)} />
        </MeasurementSection>)}
      </div> : calibration.state === "missing" ? <p className="mt-2 text-[11px] text-ink-3">No calibration artifact exists for this evaluator.</p> :
        <p className="mt-2 text-[11px] text-ink-3">{calibration.accountedObservations}/{calibration.plannedObservations} observations accounted.</p>}
    </div>

    <MeasurementSection title="Calibration artifact durations">
      <MeasurementFact label="First completed artifact" value={duration(evaluator.timeToFirstCompletedCalibrationArtifact)} />
      <MeasurementFact label="First currently admissible artifact" value={duration(evaluator.timeToFirstCurrentlyAdmissibleCalibrationArtifact)} />
    </MeasurementSection>
  </div>;
}

function MeasurementSection({ title, children }: { title: string; children: ReactNode }) {
  return <section>
    <h4 className="mb-2 font-serif text-[13px]">{title}</h4>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
  </section>;
}

function MeasurementFact({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-sm border border-rule-soft p-2">
    <div className="font-mono text-[9px] uppercase tracking-wide text-ink-4">{label}</div>
    <div className="mt-1 text-[12px]">{value}</div>
  </div>;
}

function duration(value: NonNullable<AnalysisWorkflowMeasurementReport["evaluator"]>["timeToFirstCompletedCalibrationArtifact"]): string {
  return value.state === "missing" ? "missing" : `${value.durationMilliseconds} ms`;
}

function rate(value: BinaryCalibrationWilsonRate): string {
  return value.state === "undefined"
    ? "undefined (zero denominator)"
    : `${value.numerator}/${value.denominator} · Wilson95 ${value.interval.lowerBinary64}–${value.interval.upperBinary64}`;
}
