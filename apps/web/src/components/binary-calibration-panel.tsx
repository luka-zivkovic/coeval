import { useCallback, useEffect, useMemo, useState } from "react";
import type { BinaryCalibrationArtifact, BinaryCalibrationWilsonRate } from "@coeval/shared";
import { Activity, Download, Play, RefreshCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  calibrationIdempotencyKey,
  createBinaryCalibrationRun,
  downloadBinaryCalibrationArtifact,
  fetchBinaryCalibrationArtifact,
  fetchBinaryCalibrationArtifactStatus,
  fetchBinaryCalibrationRuns,
  type BinaryCalibrationArtifactDownload,
  type BinaryCalibrationArtifactStatus,
  type BinaryCalibrationRun
} from "@/lib/binary-calibration-api";
import { fetchAllEvaluatorLifecycles } from "@/lib/evaluator-lifecycle-api";

export interface BinaryCalibrationPanelProps {
  datasetRevisionId: string;
  criterionVersionId: string;
  skillVersionId: string | null;
}

/** Aggregate-only controls for one frozen sealed truth revision. */
export function BinaryCalibrationPanel({
  datasetRevisionId,
  criterionVersionId,
  skillVersionId
}: BinaryCalibrationPanelProps) {
  const [runs, setRuns] = useState<BinaryCalibrationRun[]>([]);
  const [candidateVersionIds,setCandidateVersionIds] = useState<string[]>([]);
  const [selectedCandidateVersionId,setSelectedCandidateVersionId] = useState<string|null>(null);
  const [positiveClass, setPositiveClass] = useState<"pass" | "fail">("pass");
  const [artifact, setArtifact] = useState<BinaryCalibrationArtifactDownload | null>(null);
  const [artifactStatus, setArtifactStatus] = useState<BinaryCalibrationArtifactStatus | null>(null);
  const [artifactRefresh, setArtifactRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSkillVersionId = skillVersionId ?? selectedCandidateVersionId;
  const scopedRuns = useMemo(() => runs
    .filter((run) => run.datasetRevisionId === datasetRevisionId &&
      run.criterionVersionId === criterionVersionId &&
      (!effectiveSkillVersionId || run.skillVersionId===effectiveSkillVersionId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [
      criterionVersionId,
      datasetRevisionId,
      effectiveSkillVersionId,runs
    ]);
  const current = scopedRuns[0] ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRuns,lifecycles] = await Promise.all([
        fetchBinaryCalibrationRuns(),
        fetchAllEvaluatorLifecycles().catch(() => null)
      ]);
      setRuns(nextRuns);
      const candidates = lifecycles?.items
        .filter((item)=>item.lifecycle.criterionVersionId===criterionVersionId &&
          item.currentEvent.state!=="retired")
        .map((item)=>item.lifecycle.skillVersionId) ?? [];
      setCandidateVersionIds(candidates);
      setSelectedCandidateVersionId((current)=> current && candidates.includes(current)
        ? current : candidates[0] ?? null);
      setArtifactRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [criterionVersionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!current?.artifactId) {
      setArtifact(null);
      setArtifactStatus(null);
      return;
    }
    setArtifact(null);
    setArtifactStatus(null);
    let active = true;
    Promise.all([
      fetchBinaryCalibrationArtifact(current.artifactId),
      fetchBinaryCalibrationArtifactStatus(current.artifactId)
    ]).then(([nextArtifact, nextStatus]) => {
      if (!active) return;
      setArtifact(nextArtifact);
      setArtifactStatus(nextStatus);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [artifactRefresh, current?.artifactId]);

  useEffect(() => {
    if (!current || !["queued", "running", "recovery_required"].includes(current.state)) return;
    const timeout = window.setTimeout(() => void load(), 3_000);
    return () => window.clearTimeout(timeout);
  }, [current, load]);

  async function launch(): Promise<void> {
    if (!effectiveSkillVersionId) {
      setError("No current binary evaluator version is available for this criterion.");
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      await createBinaryCalibrationRun({
        datasetRevisionId,
        skillVersionId:effectiveSkillVersionId,
        positiveClass,
        trialPlan: { kind: "single", trialsPerItem: 1 },
        suiteBinding: null,
        idempotencyKey: calibrationIdempotencyKey()
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section className="mt-4 rounded-sm border border-gold-tint bg-ambig-bg/40 p-4" aria-label="Binary calibration evidence">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-serif text-[14px] font-medium">
            <Activity className="size-4" /> Binary calibration
          </div>
          <p className="mt-1 max-w-3xl text-[11.5px] leading-5 text-ink-3">
            Measure this exact evaluator against the frozen sealed truth revision. Results are
            policy-free, aggregate-only evidence. Artifact bytes and current status are available
            only to project-owner sessions; API keys cannot fetch them. Repeated trials and universal
            acceptance thresholds are not inferred.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCcw /> Refresh
        </Button>
      </div>

      {error ? (
        <div role="alert" className="mt-3 rounded-sm border border-signal-tint bg-signal-wash px-3 py-2 text-[11.5px] text-signal">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {!skillVersionId && candidateVersionIds.length ? <label className="grid gap-1 font-mono text-[9px] uppercase tracking-[0.09em] text-ink-4">
          Governed candidate
          <select
            className="h-8 rounded-sm border border-rule bg-card px-2 font-sans text-[12px] normal-case tracking-normal text-ink"
            value={selectedCandidateVersionId ?? ""}
            onChange={(event)=>setSelectedCandidateVersionId(event.target.value)}
          >
            {candidateVersionIds.map((id)=><option key={id} value={id}>{id}</option>)}
          </select>
        </label> : null}
        <label className="grid gap-1 font-mono text-[9px] uppercase tracking-[0.09em] text-ink-4">
          Declared positive class
          <select
            className="h-8 rounded-sm border border-rule bg-card px-2 font-sans text-[12px] normal-case tracking-normal text-ink"
            value={positiveClass}
            onChange={(event) => setPositiveClass(event.target.value as "pass" | "fail")}
          >
            <option value="pass">pass</option>
            <option value="fail">fail</option>
          </select>
        </label>
        <Button
          variant="primary"
          size="sm"
          disabled={launching || !effectiveSkillVersionId || Boolean(current && ["queued", "running", "recovery_required"].includes(current.state))}
          onClick={() => void launch()}
          title="Project-owner session required"
        >
          <Play /> {launching ? "Launching…" : "Launch owner-only measurement"}
        </Button>
        <div className="font-mono text-[9.5px] text-ink-4">
          single trial · evaluator {effectiveSkillVersionId ?? "unavailable"}
        </div>
      </div>

      {current ? (
        <RunEvidence
          run={current}
          artifact={artifact}
          status={artifactStatus}
          onDownload={() => artifact && downloadBinaryCalibrationArtifact(artifact)}
        />
      ) : (
        <div className="mt-4 rounded-sm border border-rule-soft bg-card px-3 py-3 text-[11.5px] text-ink-3">
          {loading ? "Loading aggregate calibration history…" : "No calibration run exists for this exact truth and criterion revision."}
        </div>
      )}
    </section>
  );
}

export function RunEvidence({
  run,
  artifact,
  status,
  onDownload
}: {
  run: BinaryCalibrationRun;
  artifact: BinaryCalibrationArtifactDownload | null;
  status: BinaryCalibrationArtifactStatus | null;
  onDownload: () => void;
}) {
  return (
    <div className="mt-4 border-t border-rule-soft pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-rule px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
              {run.state.replaceAll("_", " ")}
            </span>
            <span className="font-mono text-[9.5px] text-ink-4">run · {run.runId}</span>
          </div>
          <div className="mt-2 font-mono text-[10px] text-ink-3">
            accounted observations · {run.accountedObservations}/{run.plannedObservations} · positive class · {run.positiveClass}
          </div>
        </div>
        {artifact ? (
          <Button variant="default" size="sm" onClick={onDownload}>
            <Download /> Download exact artifact
          </Button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <EvidenceCell label="Frozen scope" value={`revision · ${run.datasetRevisionId} · ${run.revisionDigest}`} />
        <EvidenceCell label="Evaluator" value={`${run.criterionVersionId} · ${run.skillVersionId}`} />
        <EvidenceCell label="Artifact digest" value={run.artifactDigest ?? "Artifact not minted."} />
        <EvidenceCell
          label="Current artifact status"
          value={status
            ? `${status.artifactStatus} evidence · ${status.currentAdmissibility}${status.reasons.length ? ` · ${status.reasons.join(" · ")}` : ""} · checked ${status.evaluatedAt}`
            : run.artifactId ? "Loading current admissibility…" : "Artifact not minted."}
        />
      </div>

      {artifact ? <ArtifactEvidence artifact={artifact.artifact} /> : null}
    </div>
  );
}

export function ArtifactEvidence({ artifact }: { artifact: BinaryCalibrationArtifact }) {
  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
      <div className="space-y-3">
        <EvidenceCell
          label="Exposure snapshots"
          value={`authorization · ${artifact.exposure.authorization.state} · ${artifact.exposure.authorization.snapshotDigest} · completion · ${artifact.exposure.completion.state}/${artifact.exposure.completion.eligibility.result} · ${artifact.exposure.completion.snapshotDigest}`}
        />
        <EvidenceCell
          label="Requested execution"
          value={`${artifact.evaluator.requestedModelBinding.provider}/${artifact.evaluator.requestedModelBinding.modelId} · ${artifact.execution.providerDataHandling.executionEnvironment} · policy ${artifact.execution.providerDataHandling.policyId}`}
        />
        <EvidenceCell
          label="Evidence identity"
          value={`${artifact.artifactId} · evidence ${artifact.evidenceDigest} · private ledger commitment ${artifact.privateLedger.commitmentDigest}`}
        />
      </div>
      <div className="space-y-3">
        {artifact.trials.map((trial) => (
          <article key={trial.trialIndex} className="rounded-sm border border-rule-soft bg-card p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <div className="font-serif text-[13px] font-medium">Trial {trial.trialIndex + 1} · {trial.status}</div>
              <div className="font-mono text-[9.5px] text-ink-4">
                classified {trial.outcomes.classified}/{trial.outcomes.planned} · abstained {trial.outcomes.abstained} · errored {trial.outcomes.errored} · unevaluated {trial.outcomes.unevaluated}
              </div>
            </div>
            <MetricGrid artifact={artifact} trial={trial} />
            <div className="mt-3 border-t border-rule-soft pt-2">
              <div className="font-mono text-[9px] uppercase tracking-[0.09em] text-ink-4">Observed provider groups</div>
              <ul className="mt-1 space-y-1 font-mono text-[9.5px] text-ink-3">
                {trial.providerIdentityGroups.map((group) => (
                  <li key={JSON.stringify(group)}>
                    {group.observationCount} · {group.provider} · {group.identityStrength} · model {group.observedModel ?? "not observed"} · version {group.observedVersion ?? "not observed"} · fingerprint {group.systemFingerprint ?? "not observed"}
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function MetricGrid({
  artifact,
  trial
}: {
  artifact: BinaryCalibrationArtifact;
  trial: BinaryCalibrationArtifact["trials"][number];
}) {
  const metrics = [
    ["accuracy", rateText(trial.metrics.accuracy)],
    ["truth-pass recall", rateText(trial.metrics.truthPassRecall)],
    ["truth-fail recall", rateText(trial.metrics.truthFailRecall)],
    [`${artifact.positiveClass} precision`, rateText(trial.metrics.positiveClassPrecision)],
    [`${artifact.positiveClass} recall`, rateText(trial.metrics.positiveClassRecall)],
    [`${artifact.positiveClass} F1`, exactRateText(trial.metrics.positiveClassF1)],
    ["classified coverage", rateText(trial.metrics.classifiedCoverage.overall)],
    ["truth-pass coverage", rateText(trial.metrics.classifiedCoverage.truthPass)],
    ["truth-fail coverage", rateText(trial.metrics.classifiedCoverage.truthFail)]
  ];
  return (
    <dl className="mt-3 grid gap-2 md:grid-cols-2">
      {metrics.map(([label, value]) => (
        <div key={label} className="rounded-sm bg-paper-2 px-2.5 py-2">
          <dt className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4">{label}</dt>
          <dd className="mt-1 break-all font-mono text-[9px] leading-4 text-ink-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function rateText(rate: BinaryCalibrationWilsonRate): string {
  if (rate.state === "undefined") return `undefined · ${rate.undefinedReason}`;
  return `${rate.numerator}/${rate.denominator} · Wilson 95% bits [${rate.interval.lowerBinary64}, ${rate.interval.upperBinary64}]`;
}

function exactRateText(rate: BinaryCalibrationArtifact["trials"][number]["metrics"]["positiveClassF1"]): string {
  return rate.state === "defined"
    ? `${rate.numerator}/${rate.denominator} · exact fraction`
    : `undefined · ${rate.undefinedReason} · ${rate.numerator}/${rate.denominator}`;
}

function EvidenceCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-rule-soft bg-paper-2 p-3">
      <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.09em] text-ink-4">
        {label === "Exposure snapshots" ? <ShieldCheck className="size-3" /> : null}{label}
      </div>
      <div className="mt-1 break-all text-[10.5px] leading-5 text-ink-2">{value}</div>
    </div>
  );
}
