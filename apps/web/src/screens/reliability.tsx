import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronRight, Scale, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/table";
import { RowLink } from "@/components/row-action";
import { Chip, Eyebrow, LabelChip, MarginNote, SectionHead } from "@/components/coeval";

import { adjudicateCase, fetchDisagreements, fetchJudgeHumanDisagreements, fetchKappaSummary,
  fetchEvalRunDetail, fetchSkillVersionConvergence, fetchTrustDigest, runNextUncoveredConvergenceCase
} from "@/lib/api";
import { useAppMode } from "@/lib/app-mode";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardCriterionVersionId, dashboardSkillVersionId } from "@/lib/criterion-scope";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import {
  convergenceCaseComparisonLabel,
  reliabilityHeroAction,
  reliabilityHeroProjection
} from "@/lib/reliability-ui";
import { interpretKappa, KAPPA_MIN_SHARED_CASES } from "@coeval/shared";
import type {
  ConvergenceAudit,
  ConvergenceAuditPage,
  DisagreementSummary,
  JudgeHumanDisagreementSummary,
  KappaInterpretation,
  KappaSummary,
  ReviewerLabel,
  TrustDigest
} from "@coeval/shared";

const KAPPA_BAND_LABEL: Record<KappaInterpretation, string> = {
  poor: "poor",
  slight: "slight",
  fair: "fair",
  moderate: "moderate",
  substantial: "substantial",
  almost_perfect: "almost perfect"
};

// The API-resolved display name; raw ids pass through untouched (demo seeds
// now carry actorName, so the old `user_` prefix-stripping fallback is gone —
// demo predicts prod, M0 C8/B12).
function reviewerName(reviewer: { actorUserId: string; actorName?: string | null | undefined }): string {
  return reviewer.actorName ?? reviewer.actorUserId;
}

// The reviewers' majority discrete label, shown as CONTEXT in the modal (not
// pre-selected — the adjudicator must decide deliberately, not ratify the
// crowd). Pass/fail only; null if no clear bloc.
function reviewerLean(labels: ReviewerLabel[]): "pass" | "fail" | null {
  const counts = { pass: 0, fail: 0 };
  for (const { label } of labels) {
    if (label === "pass") counts.pass += 1;
    else if (label === "fail") counts.fail += 1;
  }
  if (counts.pass === counts.fail) return null;
  return counts.fail > counts.pass ? "fail" : "pass";
}

// This legacy UI records a binary (pass/fail) adjudication, so it only offers
// adjudication when every label on the case is pass/fail. A case carrying an
// `ambiguous` or other categorical label can't be resolved to a faithful binary
// ruling here. Coercing it to fail would record a label no one chose and distort
// the ungoverned convergence diagnostic. Those are gated out.
function isBinaryResolvable(labels: string[]): boolean {
  return labels.length > 0 && labels.every((l) => l === "pass" || l === "fail");
}

function SeverityBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-sm bg-paper-3">
        <div className="h-full bg-signal" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[11px] tabular-nums text-ink-3">{pct}%</span>
    </div>
  );
}

// What's being adjudicated: the case + the reviewers' lean (shown as context,
// not pre-selected). null means no modal open.
interface Adjudicating {
  caseId: string;
  lean: "pass" | "fail" | null;
}

export function ReliabilityScreen() {
  const navigate = useNavigate();
  const { demoMode } = useAppMode();
  const { dashboard } = useDashboard();
  const criterionVersionId = dashboardCriterionVersionId(dashboard);
  const skillVersionId = dashboardSkillVersionId(dashboard);
  const skillId = dashboard?.skill.id ?? null;
  const scopeKey = criterionVersionId && skillVersionId && skillId
    ? `${criterionVersionId}:${skillId}:${skillVersionId}`
    : null;
  const [kappa, setKappa] = useState<KappaSummary | null>(null);
  const [judgeHuman, setJudgeHuman] = useState<JudgeHumanDisagreementSummary | null>(null);
  const [humanHuman, setHumanHuman] = useState<DisagreementSummary | null>(null);
  const [convergencePage, setConvergencePage] = useState<ConvergenceAuditPage | null>(null);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [runningCoverage, setRunningCoverage] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjudicating, setAdjudicating] = useState<Adjudicating | null>(null);
  // supplemental — the reliability page works without it.
  const [digest, setDigest] = useState<TrustDigest | null>(null);
  const loadGeneration = useRef(0);
  const scopeKeyRef = useRef<string | null>(scopeKey);
  scopeKeyRef.current = scopeKey;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setKappa(null);
    setJudgeHuman(null);
    setHumanHuman(null);
    setConvergencePage(null);
    setLoadedScopeKey(null);
    setDigest(null);
    setAdjudicating(null);
    setLoadingMore(false);
    setRunningCoverage(false);
    setActionStatus(null);
    if (!criterionVersionId || !skillVersionId || !skillId) {
      if (generation === loadGeneration.current) setLoading(false);
      return;
    }
    setError(null);
    try {
      const [k, jh, hh, currentConvergencePage] = await Promise.all([
        fetchKappaSummary(criterionVersionId),
        fetchJudgeHumanDisagreements(criterionVersionId),
        fetchDisagreements(criterionVersionId),
        fetchSkillVersionConvergence(skillId, skillVersionId)
      ]);
      if (generation !== loadGeneration.current) return;
      setKappa(k);
      setJudgeHuman(jh);
      setHumanHuman(hh);
      setConvergencePage(currentConvergencePage);
      setLoadedScopeKey(`${criterionVersionId}:${skillId}:${skillVersionId}`);
      fetchTrustDigest(skillVersionId).then((nextDigest) => {
        if (generation === loadGeneration.current) setDigest(nextDigest);
      }).catch(() => {
        /* supplemental — absent digest renders nothing */
      });
    } catch (err) {
      if (generation === loadGeneration.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [criterionVersionId, skillId, skillVersionId]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  if (scopeKey && (loading || loadedScopeKey !== scopeKey)) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="The reliability loop" title="Loading reliability" />
      </div>
    );
  }

  if (!criterionVersionId || !skillVersionId || !skillId) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Ungoverned legacy diagnostics" title="Reliability" />
        <Card><CardContent className="text-[13px] text-ink-2">
          Finish the evaluator setup before reading version-pinned reliability diagnostics.
        </CardContent></Card>
      </div>
    );
  }

  if (error || !kappa || !judgeHuman || !humanHuman || !convergencePage || loadedScopeKey !== scopeKey) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="The reliability loop" title="Could not load reliability" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            {error ?? "Start the API with `pnpm dev:api` and refresh."}
          </CardContent>
        </Card>
      </div>
    );
  }

  const convergence = convergencePage.audit;

  // Judge-vs-human is shown as a disagreement RATE, deliberately NOT a reassuring
  // judge-human κ — a high κ next to a judge that blew a case would contradict the
  // hero feed below. The team-agreement κ is the floor; the rate is the gap.
  const splitPct =
    humanHuman.comparedCases > 0
      ? Math.round((humanHuman.disagreedCases / humanHuman.comparedCases) * 100)
      : null;
  // Per-PAIR gating, matching trust-digest and skill-versions: the aggregate
  // union of overlapping cases can clear the minimum while every individual
  // pair rests on a 2-case sample — precisely the false confidence the
  // minimum exists to suppress. The rendered mean covers qualified pairs only.
  const qualifiedPairs = kappa.pairs.filter((pair) => pair.cases >= KAPPA_MIN_SHARED_CASES);
  const qualifiedMean = qualifiedPairs.length > 0
    ? qualifiedPairs.reduce((sum, pair) => sum + pair.kappa, 0) / qualifiedPairs.length
    : null;
  const largestPairSample = kappa.pairs.reduce((max, pair) => Math.max(max, pair.cases), 0);
  const largestUndefinedPairSample = kappa.undefinedPairs.reduce((max, pair) => Math.max(max, pair.cases), 0);
  // Pairs exist but none produced a κ (e.g. scalar verdicts κ math can't
  // compare): say so instead of promising a number that can never arrive.
  const kappaUncomputable = kappa.pairs.length === 0 && kappa.unsupportedPairs > 0;
  const kappaUndefined = kappa.pairs.length === 0 && kappa.undefinedPairs.length > 0;
  const kappaText = qualifiedMean != null
    ? qualifiedMean.toFixed(2)
    : kappaUncomputable || kappaUndefined
      ? "—"
      : "Gathering";
  let bandText: string;
  if (qualifiedMean != null) {
    bandText = `${KAPPA_BAND_LABEL[interpretKappa(qualifiedMean)]} over ${qualifiedPairs.length} of ${kappa.pairs.length} pair(s)`;
  } else if (kappaUncomputable) {
    bandText = "not computable for these verdict kinds";
  } else if (kappaUndefined) {
    bandText = `undefined: expected agreement is 1 (${largestUndefinedPairSample} one-label shared cases)`;
  } else {
    bandText = `${Math.min(largestPairSample, KAPPA_MIN_SHARED_CASES)}/${KAPPA_MIN_SHARED_CASES} shared cases`;
  }
  const judgeOpen = judgeHuman.disagreedCases - judgeHuman.resolvedCases;
  const heroAction = reliabilityHeroAction(convergence, convergencePage.nextUncoveredCaseId);
  const canRunCoverage = dashboard?.viewerRole === "owner";

  const loadMoreConvergenceCases = async () => {
    if (!convergencePage.nextCursor || loadingMore) return;
    const generation = loadGeneration.current;
    const requestedScopeKey = scopeKey;
    setLoadingMore(true);
    try {
      const next = await fetchSkillVersionConvergence(skillId, skillVersionId, {
        cursor: convergencePage.nextCursor
      });
      if (generation !== loadGeneration.current || scopeKeyRef.current !== requestedScopeKey) return;
      setConvergencePage((current) => {
        if (!current) return next;
        const seen = new Set(current.audit.cases.map((item) => item.caseId));
        return {
          audit: {
            ...next.audit,
            cases: [...current.audit.cases, ...next.audit.cases.filter((item) => !seen.has(item.caseId))]
          },
          nextCursor: next.nextCursor,
          nextUncoveredCaseId: next.nextUncoveredCaseId
        };
      });
    } catch (err) {
      if (generation === loadGeneration.current && scopeKeyRef.current === requestedScopeKey) {
        setActionStatus(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === loadGeneration.current && scopeKeyRef.current === requestedScopeKey) setLoadingMore(false);
    }
  };

  const runUncoveredCase = async () => {
    if (runningCoverage) return;
    const generation = loadGeneration.current;
    const requestedScopeKey = scopeKey;
    setRunningCoverage(true);
    setActionStatus(`Starting version-pinned run for ${heroAction.caseId ?? "the next uncovered case"}…`);
    try {
      const started = await runNextUncoveredConvergenceCase(skillId, skillVersionId);
      if (generation !== loadGeneration.current || scopeKeyRef.current !== requestedScopeKey) return;
      setActionStatus(`Running ${started.caseId} with this exact evaluator version…`);
      let status = started.run.status;
      for (let attempt = 0; attempt < 60 && (status === "pending" || status === "running"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (generation !== loadGeneration.current || scopeKeyRef.current !== requestedScopeKey) return;
        const detail = await fetchEvalRunDetail(started.run.id);
        if (!detail) throw new Error("The version-pinned run could not be found after it started.");
        status = detail.status;
      }
      if (generation !== loadGeneration.current || scopeKeyRef.current !== requestedScopeKey) return;
      if (status === "failed" || status === "canceled") {
        throw new Error(`The version-pinned run ${status}. Open Examples to inspect the run details.`);
      }
      if (status === "pending" || status === "running") {
        setActionStatus(`Run ${started.run.id} is still processing. Refresh after it completes to update this diagnostic.`);
        return;
      }
      setActionStatus(`${started.caseId} is now covered by this evaluator version.`);
      setRunningCoverage(false);
      await load();
    } catch (err) {
      if (generation === loadGeneration.current && scopeKeyRef.current === requestedScopeKey) {
        setActionStatus(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === loadGeneration.current && scopeKeyRef.current === requestedScopeKey) setRunningCoverage(false);
    }
  };

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Ungoverned legacy diagnostics"
        title="Reliability"
        sub="Compare the current evaluator with recorded legacy human rulings, then inspect where reviewers disagree. These cases were not collected blind or as a representative sample, so use this page for diagnosis rather than governed human truth."
      />

      <ReliabilityHero
        audit={convergence}
        version={dashboard?.skill.currentVersion.version ?? convergence.afterVersionId}
        actionLabel={runningCoverage
          ? "Running current version…"
          : heroAction.kind === "run_uncovered" && !canRunCoverage
            ? "Open next uncovered case"
            : heroAction.label}
        actionDisabled={runningCoverage}
        onNext={() => {
          if (heroAction.kind === "run_uncovered" && canRunCoverage) {
            void runUncoveredCase();
          } else {
            navigate(heroAction.caseId ? `/cases/${heroAction.caseId}` : "/exceptions");
          }
        }}
      />

      {actionStatus ? (
        <div role="status" className="mb-3 rounded-sm border border-rule-soft bg-paper-2 px-3 py-2 text-[11.5px] text-ink-2">
          {actionStatus}
        </div>
      ) : null}

      <ConvergenceEvidence
        audit={convergence}
        nextCursor={convergencePage.nextCursor}
        loadingMore={loadingMore}
        onLoadMore={() => { void loadMoreConvergenceCases(); }}
      />

      {demoMode ? (
        <div className="mb-6 font-mono text-[10.5px] tracking-[0.04em] text-ink-4">
          Example team data — in your project these populate as the judge runs and your reviewers
          double-code cases.
        </div>
      ) : (
        <div className="mb-6" />
      )}

      {/* Primary work queue: exact legacy disagreements, never governed truth. */}
      <SectionHead
        className="mb-3"
        eyebrow="Next action"
        title="Review judge–reviewer disagreements"
        sub="Open each trace and compare the evaluator result with the recorded human labels. Add a ruling only after reading the evidence; this legacy workflow does not establish governed human truth."
        right={
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
            <Scale className="size-3.5" /> {judgeOpen} need a human call
          </span>
        }
      />
      <Card className="mb-3">
        <Table>
          <thead>
            <tr>
              <th>Case</th>
              <th style={{ width: 120 }}>Judge said</th>
              <th>Your reviewers</th>
              <th style={{ width: 150 }}>Severity</th>
              <th style={{ width: 150 }}>Resolution</th>
            </tr>
          </thead>
          <tbody>
            {judgeHuman.cases.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-ink-3">
                  {judgeHuman.comparedCases === 0
                    ? "No compared cases yet. Rule exceptions, then rerun those exact cases with this evaluator version."
                    : "No judge–reviewer disagreements are open in the compared legacy cases."}
                </td>
              </tr>
            ) : null}
            {judgeHuman.cases.map((c) => (
              <tr key={c.caseId} className="row-link row-signal" onClick={() => navigate(`/cases/${c.caseId}`)}>
                <td>
                  <RowLink to={`/cases/${c.caseId}`} className="font-mono text-[11px] tracking-[0.04em] text-ink-2">
                    {c.caseId}
                  </RowLink>
                </td>
                <td>
                  <LabelChip label={c.judgeLabel} />
                </td>
                <td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {c.humanLabels.map((h) => (
                      <span key={h.actorUserId} className="inline-flex items-center gap-1">
                        <span className="font-mono text-[10.5px] text-ink-3">{reviewerName(h)}</span>
                        <LabelChip label={h.label} />
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <SeverityBar value={c.severity} />
                </td>
                <td>
                  <ResolutionCell
                    adjudicatedLabel={c.adjudicatedLabel}
                    canAdjudicate={isBinaryResolvable([c.judgeLabel, ...c.humanLabels.map((h) => h.label)])}
                    onAdjudicate={() =>
                      setAdjudicating({ caseId: c.caseId, lean: reviewerLean(c.humanLabels) })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <MarginNote tone="signal" who="The loop" className="mb-8 max-w-[80ch]">
        A legacy adjudication closes the disagreement and becomes the reference for later comparisons
        on this page. It remains ungoverned and does not become governed human truth.
      </MarginNote>

      <div className="space-y-3">
        <details className="rounded-sm border border-rule-soft bg-card">
          <summary className="cursor-pointer px-[18px] py-4 text-[12px] font-medium text-ink">
            Reviewer agreement (κ) · {kappaText}
            <span className="ml-2 font-normal text-ink-3">What this tells you: how consistently legacy reviewers label the same cases</span>
          </summary>
          <div className="border-t border-rule-soft px-[18px] py-4 text-[11.5px] leading-6 text-ink-2">
            <p>{qualifiedMean != null
              ? `${bandText} · ${kappa.raterCount} raters · ${kappa.overlappingCases} shared cases.`
              : kappaUncomputable || kappaUndefined
                ? `${bandText}.`
                : `${bandText} · κ appears after ${KAPPA_MIN_SHARED_CASES} double-coded cases per pair.`}</p>
            <p className="mt-2 text-ink-3">κ can remain undefined when reviewers only use one label. It is not a correctness score and does not upgrade this evidence to governed truth.</p>
          </div>
        </details>

        <details className="rounded-sm border border-rule-soft bg-card">
          <summary className="cursor-pointer px-[18px] py-4 text-[12px] font-medium text-ink">
            <span className="inline-flex items-center gap-2"><Users className="size-3.5" /> Reviewer splits · {humanHuman.disagreedCases}</span>
            <span className="font-normal text-ink-3">What this tells you: where two legacy reviewers used different labels</span>
          </summary>
          <div className="border-t border-rule-soft">
            <div className="px-[18px] py-3 text-[11px] text-ink-3">{splitPct == null ? "No double-coded cases yet." : `${humanHuman.disagreedCases} of ${humanHuman.comparedCases} double-coded cases split.`}</div>
            <Table>
              <thead><tr><th>Case</th><th>Reviewer verdicts</th><th style={{ width: 90 }} className="text-right">Distinct</th><th style={{ width: 130 }}>Severity</th><th style={{ width: 150 }}>Resolution</th></tr></thead>
              <tbody>
                {humanHuman.cases.length === 0 ? <tr><td colSpan={5} className="text-center text-ink-3">Double-code cases to inspect reviewer disagreement here.</td></tr> : null}
                {humanHuman.cases.map((c) => <tr key={c.caseId} className="row-link row-signal" onClick={() => navigate(`/cases/${c.caseId}`)}>
                  <td><RowLink to={`/cases/${c.caseId}`} className="font-mono text-[11px] tracking-[0.04em] text-ink-2">{c.caseId}</RowLink></td>
                  <td><div className="flex flex-wrap items-center gap-1.5">{c.labels.map((r) => <span key={r.actorUserId} className="inline-flex items-center gap-1"><span className="font-mono text-[10.5px] text-ink-3">{reviewerName(r)}</span><LabelChip label={r.label} /></span>)}</div></td>
                  <td className="text-right font-mono tabular-nums text-ink-2">{c.distinctLabels}<span className="text-ink-3"> / {c.reviewerCount}</span></td>
                  <td><SeverityBar value={c.severity} /></td>
                  <td><ResolutionCell adjudicatedLabel={c.adjudicatedLabel}
                    canAdjudicate={isBinaryResolvable(c.labels.map((r) => r.label))}
                    onAdjudicate={() => setAdjudicating({ caseId: c.caseId, lean: reviewerLean(c.labels) })} /></td>
                </tr>)}
              </tbody>
            </Table>
          </div>
        </details>

        {digest ? <details className="rounded-sm border border-rule-soft bg-card">
          <summary className="cursor-pointer px-[18px] py-4 text-[12px] font-medium text-ink">
            Other diagnostics
            <span className="ml-2 font-normal text-ink-3">known-failure references, self-consistency, model drift, and spend</span>
          </summary>
          <div className="border-t border-rule-soft p-3"><TrustDigestSection digest={digest} /></div>
        </details> : null}
      </div>

      {adjudicating ? (
        <AdjudicateModal
          caseId={adjudicating.caseId}
          skillVersionId={skillVersionId!}
          lean={adjudicating.lean}
          onCancel={() => setAdjudicating(null)}
          onResolved={() => {
            setAdjudicating(null);
            if (scopeKeyRef.current === scopeKey) void load();
          }}
        />
      ) : null}
    </div>
  );
}

function ReliabilityHero({ audit, version, actionLabel, actionDisabled, onNext }: {
  audit: ConvergenceAudit;
  version: string;
  actionLabel: string;
  actionDisabled: boolean;
  onNext: () => void;
}) {
  const hero = reliabilityHeroProjection(audit);
  return <Card className="mb-3 border-ink">
    <CardHeader className="justify-between">
      <div>
        <CardTitle>Current evaluator vs recorded rulings</CardTitle>
        <CardDescription>Version {version} · pinned legacy adjudication slice</CardDescription>
      </div>
      <Chip variant="outline" className="font-mono text-[10px]">ungoverned · self-selected</Chip>
    </CardHeader>
    <CardContent className="grid gap-5 lg:grid-cols-[180px_1fr_auto] lg:items-center">
      <div>
        <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-3">Agreement</div>
        <div className="mt-2 font-serif text-[42px] font-medium leading-none tracking-[-0.035em] tabular-nums">{hero.agreementPercent ?? "—"}</div>
      </div>
      <div>
        <p className="font-serif text-[16px] leading-6 text-ink">{hero.agreementSentence}</p>
        <p className="mt-1 text-[11.5px] text-ink-2">{hero.coverageSentence}</p>
        <p className="mt-2 text-[10.5px] leading-5 text-ink-3">{hero.sampleCaveat}</p>
      </div>
      <Button variant="primary" disabled={actionDisabled} onClick={onNext}>{actionLabel} <ChevronRight /></Button>
    </CardContent>
  </Card>;
}

function ConvergenceEvidence({ audit, nextCursor, loadingMore, onLoadMore }: {
  audit: ConvergenceAudit;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return <details className="mb-6 rounded-sm border border-rule-soft bg-card">
    <summary className="cursor-pointer px-[18px] py-3.5 text-[11.5px] font-medium text-ink">
      Exact current-version comparison · {audit.comparedCases} case{audit.comparedCases === 1 ? "" : "s"}
      <span className="ml-2 font-normal text-ink-3">showing {audit.cases.length} · inspect the exact denominator</span>
    </summary>
    <div className="border-t border-rule-soft">
      {audit.cases.length === 0 ? <div className="px-[18px] py-5 text-[11.5px] text-ink-3">No exact case comparison is available for this version yet.</div> : <Table>
        <thead><tr><th>Case</th><th>Recorded legacy adjudication</th><th>Prior evaluator</th><th>This evaluator</th><th>Change</th></tr></thead>
        <tbody>{audit.cases.map((item) => <tr key={item.caseId} className={item.afterLabel === item.adjudicatedLabel ? undefined : "row-signal"}>
          <td><RowLink to={`/cases/${item.caseId}`} className="font-mono text-[11px] text-ink-2">{item.caseId}</RowLink></td>
          <td><LabelChip label={item.adjudicatedLabel} /></td>
          <td>{item.beforeLabel ? <LabelChip label={item.beforeLabel} /> : <span className="text-[11px] text-ink-4">No prior judgment</span>}</td>
          <td><LabelChip label={item.afterLabel} /></td>
          <td className="text-[11px] text-ink-3">{convergenceCaseComparisonLabel(item)}</td>
        </tr>)}</tbody>
      </Table>}
      {nextCursor ? (
        <div className="border-t border-rule-soft px-[18px] py-3">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading exact cases…" : `Load more exact cases (${audit.cases.length} of ${audit.comparedCases})`}
          </Button>
        </div>
      ) : null}
    </div>
  </details>;
}

function ResolutionCell({
  adjudicatedLabel,
  canAdjudicate,
  onAdjudicate
}: {
  adjudicatedLabel: string | null;
  canAdjudicate: boolean;
  onAdjudicate: () => void;
}) {
  if (adjudicatedLabel) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Check className="size-3 text-ink-3" />
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Resolved</span>
        <LabelChip label={adjudicatedLabel} />
      </span>
    );
  }
  if (!canAdjudicate) {
    // Non-binary labels (e.g. ambiguous/categorical) can't be resolved to a
    // faithful binary ruling in this UI — resolve from the trace instead.
    return (
      <span className="font-mono text-[10.5px] text-ink-4" title="Resolve a categorical case from the trace">
        open trace
      </span>
    );
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={(e) => {
        e.stopPropagation();
        onAdjudicate();
      }}
    >
      Adjudicate
    </Button>
  );
}

function AdjudicateModal({
  caseId,
  skillVersionId,
  lean,
  onCancel,
  onResolved
}: {
  caseId: string;
  skillVersionId: string;
  lean: "pass" | "fail" | null;
  onCancel: () => void;
  onResolved: () => void;
}) {
  // No default — the adjudicator must make a deliberate call, not ratify the
  // reviewers' majority (which is shown only as context below).
  const [label, setLabel] = useState<"pass" | "fail" | null>(null);
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose: onCancel, closeOnEscape: !submitting });

  const submit = async () => {
    if (label === null) return;
    setError(null);
    setSubmitting(true);
    try {
      await adjudicateCase(caseId, {
        kind: "binary",
        pass: label === "pass",
        rationale: rationale.trim()
      }, skillVersionId);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="adjudicate-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onCancel();
      }}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto shadow-elev sm:w-[520px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div>
            <CardTitle id="adjudicate-title">Record a legacy adjudication</CardTitle>
            <CardDescription>
              Record the team's ungoverned ruling for <span className="font-mono text-[12px]">{caseId}</span>.
              Later evaluator versions can be compared with it, but it is not governed human truth.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div id="adjudicate-label-title" className="eyebrow">Team ruling</div>
            <div className="flex gap-1.5" role="group" aria-labelledby="adjudicate-label-title">
              {(["pass", "fail"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setLabel(opt)}
                  aria-pressed={label === opt}
                  className={cn(
                    "inline-flex h-8 items-center rounded-sm border px-3 text-[12.5px] capitalize transition-colors cursor-pointer",
                    label === opt
                      ? "border-ink bg-ink text-paper"
                      : "border-rule-soft bg-transparent text-ink-2 hover:bg-paper-3"
                  )}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="font-mono text-[10.5px] text-ink-4">
              {lean ? `Reviewers leaned ${lean} — your call records the ruling.` : "Reviewers were evenly split."}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="adjudicate-rationale" className="eyebrow">
              Rationale <span className="lowercase tracking-normal text-ink-3">(optional)</span>
            </label>
            <textarea
              id="adjudicate-rationale"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={3}
              placeholder="Why the team is recording this ruling. Saved on the adjudication."
              className="resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-sans text-[12.5px] text-ink focus-visible:border-ink"
            />
          </div>

          {error ? <div role="alert" className="text-[12px] text-signal">{error}</div> : null}

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Chip variant="outline" className="font-mono text-[10px]">
              owner only
            </Chip>
            <Button variant="primary" onClick={() => void submit()} disabled={submitting || label === null}>
              {submitting ? "Recording…" : "Record ruling"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// the trust digest. Framing obligations (A3/A2.2b): every signal is
// ONE SIGNAL AMONG SEVERAL — never composited; "consistent ≠ correct" wherever
// self-consistency shows; the κ tile carries its caveat because this page's
// hero feed is disagreements; sampled spend shown with the judged counts.
function TrustDigestSection({ digest }: { digest: TrustDigest }) {
  const spendText = digest.spend.runsCounted === 0
    ? "no eval runs yet"
    : `${digest.spend.freshItems} fresh · ${digest.spend.cachedItems} cached over the last ${digest.spend.runsCounted} run(s)` +
      (digest.spend.inputTokens === null && digest.spend.outputTokens === null
        ? " · usage unavailable"
        : ` · ${digest.spend.inputTokens ?? 0} in / ${digest.spend.outputTokens ?? 0} out tokens`) +
      (digest.spend.usageMissingCount > 0 ? ` · usage unavailable for ${digest.spend.usageMissingCount} call(s)` : "");
  const readyKappa = digest.judgeHumanKappa.filter((pair) => pair.cases >= KAPPA_MIN_SHARED_CASES);
  const largestKappaSample = digest.judgeHumanKappa.reduce((max, pair) => Math.max(max, pair.cases), 0);
  const kappaText = readyKappa.length === 0
    ? null
    : readyKappa
        .map((pair) => `κ ${pair.kappa.toFixed(2)} (${pair.interpretation.replace("_", " ")}) vs ${pair.humanRater} · ${pair.cases} case(s)`)
        .join(" · ");
  return (
    <Card className="mb-5" data-trust-digest>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-baseline justify-between">
          <Eyebrow>Trust digest · {digest.version}</Eyebrow>
          <span className="font-mono text-[10.5px] text-ink-3">
            four signals, each one among several — never a combined score
          </span>
        </div>

        {digest.nudges.length > 0 ? (
          <div className="flex flex-col gap-2">
            {digest.nudges.map((nudge, index) => (
              <div key={index} className="rounded-sm border border-signal-tint bg-signal-wash px-3 py-2" data-nudge={nudge.signal}>
                <div className="text-[12.5px] leading-[1.5] text-ink">{nudge.sentence}</div>
                <div className="mt-0.5 text-[11px] leading-[1.5] text-ink-3">{nudge.falsifier}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-ink-3">No drift nudges — every signal with data is inside its threshold.</div>
        )}

        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11.5px] leading-[1.6] text-ink-2">
          <div>
            <span className="text-ink-3">golden set · </span>
            {digest.goldenSetHealth.totalActive === 0
              ? "no signal yet"
              : `${digest.goldenSetHealth.status} · ${digest.goldenSetHealth.totalActive} active, ${digest.goldenSetHealth.staleCount} stale`}
          </div>
          <div>
            <span className="text-ink-3">judge–human κ (this version) · </span>
            {kappaText ?? (largestKappaSample > 0
              ? `gathering evidence · ${Math.min(largestKappaSample, KAPPA_MIN_SHARED_CASES)}/${KAPPA_MIN_SHARED_CASES} shared cases`
              : "no signal yet")}
            {kappaText ? <span className="text-ink-3"> — κ can look fine while individual cases are wrong; read the feed below</span> : null}
          </div>
          <div>
            <span className="text-ink-3">self-consistency · </span>
            {digest.selfConsistency.comparedCases === 0
              ? "no signal yet"
              : `${digest.selfConsistency.consistentCases}/${digest.selfConsistency.comparedCases} repeat-judged case(s) fully consistent`}
            <span className="text-ink-3"> — consistent ≠ correct</span>
          </div>
          <div>
            <span className="text-ink-3">spend (sampled) · </span>
            {spendText}
          </div>
        </div>

        {digest.noSignal.length > 0 ? (
          <div className="flex flex-col gap-0.5 font-mono text-[10.5px] leading-[1.6] text-ink-3">
            {digest.noSignal.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
