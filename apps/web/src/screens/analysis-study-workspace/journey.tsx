import { useEffect, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import type {
  AnalysisCriterionPromotionCandidate,
  AnalysisCriterionPromotionCreateResult,
  AnalysisCriterionPromotionSummary,
  AnalysisStudyDetail,
  AnalysisTaxonomyDetail
} from "@coeval/shared";
import { ANALYSIS_MAX_PROMOTION_SUPPORTS } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  createAnalysisPromotion,
  fetchAnalysisPromotionCandidates,
  fetchAnalysisPromotions
} from "@/lib/analysis-promotion-api";
import {
  analysisPromotionContextMatches,
  analysisPromotionHandoffInstructionHref
} from "@/lib/analysis-promotion-ui";
import type { AnalyzeJourneyStatus } from "@/lib/analyze-journey";
import { useIdempotentAction } from "./support.js";

export function AnalyzeJourneyStrip({ steps }: { steps: readonly { status: AnalyzeJourneyStatus; detail: string }[] }) {
  const labels = [
    "Choose runs",
    "Review runs",
    "Organize findings",
    "Create a criterion"
  ] as const;
  return <section aria-label="Analyze progress" className="rounded-sm border border-rule-soft bg-paper-2 p-3">
    <div className="grid gap-2 sm:grid-cols-4">
      {steps.map((step, index) => <div key={labels[index]}
        aria-current={step.status === "current" ? "step" : undefined}
        className={`rounded-sm border px-3 py-2 ${journeyStepClass(step.status)}`}>
        <div className="flex items-center gap-2 text-[11.5px] font-medium">
          <span className="grid size-5 place-items-center rounded-full border border-rule-strong font-mono text-[10px]">{step.status === "complete" ? <Check className="size-3" /> : index + 1}</span>
          {labels[index]}
        </div>
        <div className="mt-1 pl-7 text-[10.5px] text-ink-3">{step.detail}</div>
      </div>)}
    </div>
  </section>;
}

function journeyStepClass(status: AnalyzeJourneyStatus): string {
  if (status === "current") return "border-ink bg-card-2";
  if (status === "complete") return "border-rule-soft bg-paper-3";
  if (status === "incomplete") return "border-gold-tint bg-ambig-bg";
  if (status === "available") return "border-rule-soft";
  return "border-transparent opacity-70";
}

export function PromotionCard({ detail, taxonomy, onError, onPromotionStateChange }: {
  detail: AnalysisStudyDetail;
  taxonomy: AnalysisTaxonomyDetail;
  onError: (cause: unknown) => void;
  onPromotionStateChange: (created: boolean | null) => void;
}) {
  const study = detail.summary.study;
  const activeCodes = taxonomy.revision.codes.filter((code) => code.status === "active");
  const [codeId, setCodeId] = useState("");
  const [candidates, setCandidates] = useState<AnalysisCriterionPromotionCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [criterionName, setCriterionName] = useState("");
  const [criterionDefinition, setCriterionDefinition] = useState("");
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(false);
  const [promotionsByCode, setPromotionsByCode] = useState<Map<string, AnalysisCriterionPromotionCreateResult | AnalysisCriterionPromotionSummary>>(new Map());
  const currentContext = useRef({ studyId: study.study.id, taxonomyRevisionId: taxonomy.revision.revision.id, codeId });
  currentContext.current = { studyId: study.study.id, taxonomyRevisionId: taxonomy.revision.revision.id, codeId };
  const mutation = useIdempotentAction();
  const selectedCode = activeCodes.find((code) => code.codeId === codeId) ?? null;
  const receipt = codeId ? promotionsByCode.get(codeId) ?? null : null;

  useEffect(() => {
    setCandidates([]);
    setSelected(new Set());
    setCriterionDefinition("");
    setRationale("");
    if (!selectedCode) return;
    setCriterionName(selectedCode.label.length <= 200 ? selectedCode.label : "");
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const rows: AnalysisCriterionPromotionCandidate[] = [];
        const observations = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          if (cursor && cursors.has(cursor)) throw new Error("Analysis promotion candidate cursor did not advance");
          if (cursor) cursors.add(cursor);
          const page = await fetchAnalysisPromotionCandidates({
            studyId: study.study.id,
            taxonomyRevisionId: taxonomy.revision.revision.id,
            codeId: selectedCode.codeId,
            limit: 100,
            cursor
          });
          for (const candidate of page.items) {
            if (observations.has(candidate.observationEventId)) {
              throw new Error("Analysis promotion candidates repeated an observation across pages");
            }
            observations.add(candidate.observationEventId);
          }
          rows.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        if (!cancelled) setCandidates(rows);
      } catch (cause) {
        if (!cancelled) onError(cause);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCode?.codeId, study.study.id, taxonomy.revision.revision.id]);

  useEffect(() => {
    let cancelled = false;
    onPromotionStateChange(null);
    void (async () => {
      const rows = new Map<string, AnalysisCriterionPromotionSummary>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        if (cursor && cursors.has(cursor)) throw new Error("Analysis promotion list cursor did not advance");
        if (cursor) cursors.add(cursor);
        const page = await fetchAnalysisPromotions({ studyId: study.study.id, limit: 50, cursor });
        for (const promotion of page.items) rows.set(promotion.promotion.codeId, promotion);
        cursor = page.nextCursor;
      } while (cursor);
      if (!cancelled) {
        setPromotionsByCode(rows);
        onPromotionStateChange(rows.size > 0);
      }
    })()
      .catch((cause) => { if (!cancelled) onError(cause); });
    return () => { cancelled = true; };
  }, [study.study.id, onPromotionStateChange]);

  const toggle = (observationEventId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(observationEventId)) next.delete(observationEventId);
    else if (next.size < ANALYSIS_MAX_PROMOTION_SUPPORTS) next.add(observationEventId);
    return next;
  });
  const promote = async () => {
    if (!selectedCode || !study.closureId || !study.closureDigest) return;
    const supports = candidates.filter((candidate) => selected.has(candidate.observationEventId));
    const canonicalName = criterionName.trim();
    const canonicalDefinition = criterionDefinition.trim();
    const canonicalRationale = rationale.trim();
    const signature = JSON.stringify({
      studyId: study.study.id,
      closureId: study.closureId,
      taxonomyRevisionId: taxonomy.revision.revision.id,
      codeId: selectedCode.codeId,
      criterionName: canonicalName,
      criterionDefinition: canonicalDefinition,
      rationale: canonicalRationale,
      supports: supports.map((candidate) => candidate.observationEventId)
    });
    try {
      const expectedContext = {
        studyId: study.study.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        codeId: selectedCode.codeId
      };
      const result = await mutation.run(signature, (idempotencyKey) => createAnalysisPromotion({
        studyId: study.study.id,
        expectedClosureId: study.closureId!,
        expectedClosureDigest: study.closureDigest!,
        taxonomyId: taxonomy.taxonomy.id,
        taxonomyRevisionId: taxonomy.revision.revision.id,
        expectedTaxonomyRevisionDigest: taxonomy.revision.revision.revisionDigest,
        codeId: selectedCode.codeId,
        expectedCodeEntryDigest: selectedCode.entryDigest,
        criterionName: canonicalName,
        criterionDefinition: canonicalDefinition,
        rationale: canonicalRationale,
        supportingObservations: supports.map((candidate) => ({
          studyItemId: candidate.studyItemId,
          closureItemId: candidate.closureItemId,
          closureItemDigest: candidate.closureItemDigest,
          observationEventId: candidate.observationEventId,
          observationEventDigest: candidate.observationEventDigest,
          assignmentEventId: candidate.assignmentEventId,
          assignmentEventDigest: candidate.assignmentEventDigest
        })),
        idempotencyKey
      }));
      if (analysisPromotionContextMatches(currentContext.current, expectedContext)) {
        setPromotionsByCode((current) => new Map(current).set(result.promotion.codeId, result));
        onPromotionStateChange(true);
      }
    } catch (cause) {
      onError(cause);
    }
  };

  return <Card>
    <CardHeader className="justify-between">
      <div>
        <CardTitle>4. Turn one failure type into a criterion</CardTitle>
        <p className="mt-1 text-[10.5px] text-ink-3">Choose the exact observations that explain why this behavior should be judged consistently.</p>
      </div>
    </CardHeader>
    <CardContent>
      <p className="mb-4 text-[11px] text-ink-3">
        This records an immutable criterion and a governed nonsealed review handoff. It does not create human truth,
        an evaluator, calibration, approval, or a release decision.
      </p>
      {receipt ? <div className="mb-4 rounded-sm border border-rule-soft bg-card-2 p-3 text-[11px]">
        <div className="font-medium">Criterion created</div>
        <div className="mt-2 text-ink-3">Next, write the governed review instructions and create a nonsealed review batch. No evaluator has been created or activated.</div>
        <a className="mt-3 inline-flex text-[11px] font-medium text-signal hover:underline"
          href={analysisPromotionHandoffInstructionHref(receipt.criterion.id, receipt.handoff.promotionId)}>
          Create governed instruction and handoff batch
        </a>
      </div> : null}
      <label className="block text-[11px] text-ink-3">Failure type
        <select value={codeId} onChange={(event) => setCodeId(event.target.value)}
          className="mt-1 h-9 w-full rounded-sm border border-rule bg-card px-3 text-[12px]">
          <option value="">Choose a current failure type</option>
          {activeCodes.map((code) => <option key={code.codeId} value={code.codeId}>{code.label}</option>)}
        </select>
      </label>
      {selectedCode ? <div className="mt-3 space-y-3">
        <label className="block text-[11px] text-ink-3" htmlFor="analysis-criterion-name">Criterion name</label>
        <Input id="analysis-criterion-name" value={criterionName} onChange={(event) => setCriterionName(event.target.value)} maxLength={200}
          placeholder={selectedCode.label.length > 200 ? "Failure-type name is too long; enter a shorter criterion name" : "Name the criterion"} />
        <label className="block text-[11px] text-ink-3" htmlFor="analysis-criterion-definition">Criterion definition</label>
        <textarea id="analysis-criterion-definition" value={criterionDefinition} onChange={(event) => setCriterionDefinition(event.target.value)}
          maxLength={20_000} placeholder="State exactly what should be judged"
          className="min-h-24 w-full rounded-sm border border-rule bg-card px-3 py-2 text-[12px]" />
        <label className="block text-[11px] text-ink-3" htmlFor="analysis-criterion-rationale">Why create this criterion?</label>
        <textarea id="analysis-criterion-rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} maxLength={5_000}
          placeholder="Explain why this closed evidence should become a reusable criterion"
          className="min-h-20 w-full rounded-sm border border-rule bg-card px-3 py-2 text-[12px]" />
        <div className="rounded-sm border border-rule-soft">
          <div className="border-b border-rule-soft px-3 py-2 text-[10px] text-ink-4">
            {loading ? "Loading supporting observations…" :
              `${candidates.length} supporting observations · ${selected.size} selected`}
          </div>
          {candidates.map((candidate) => <label key={candidate.observationEventId}
            className="flex gap-3 border-b border-rule-soft px-3 py-3 last:border-0">
            <input type="checkbox" checked={selected.has(candidate.observationEventId)}
              onChange={() => toggle(candidate.observationEventId)} />
            <span className="text-[11px]"><span className="font-medium">{candidate.failureLabel}</span>
              <span className="mt-1 block text-ink-3">{candidate.observationRationale}</span>
              <span className="mt-1 block text-[9px] text-ink-4">Reviewed run {candidate.position + 1}</span>
            </span>
          </label>)}
        </div>
        <Button size="sm" disabled={mutation.busy || loading || selected.size === 0 ||
          !criterionName.trim() || !criterionDefinition.trim() || !rationale.trim()}
          onClick={() => void promote()}><Plus /> Create criterion</Button>
      </div> : null}
    </CardContent>
  </Card>;
}
