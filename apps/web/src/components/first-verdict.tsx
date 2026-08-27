import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { DashboardSummary, ExceptionDetail } from "@coeval/shared";
import { fetchCaseDetail, fetchProjectVerdicts } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow, VerdictChip } from "@/components/coeval";
import { cn } from "@/lib/utils";

export function FirstVerdictCard({
  dashboard,
  onOpenCase,
  className
}: {
  dashboard: DashboardSummary;
  onOpenCase: (caseId: string) => void;
  className?: string;
}) {
  const [detail, setDetail] = useState<ExceptionDetail | null>(null);

  useEffect(() => {
    if (dashboard.project.autoJudgedTraceCount === 0) return;
    let cancelled = false;
    void fetchProjectVerdicts({
      source: "llm_judge",
      skillVersionId: dashboard.skill.currentVersion.id,
      limit: 1
    })
      .then((verdicts) => verdicts[0]
        ? fetchCaseDetail(verdicts[0].caseId, dashboard.skill.currentVersion.id)
        : null)
      .then((result) => {
        // Setting null matters as much as setting a result: when the skill
        // version changes and the new version has no verdicts yet, keeping
        // the previous detail would render an OLD version's verdict labeled
        // as "the review guide that produced it" beside the NEW rubric.
        if (!cancelled) setDetail(result ?? null);
      })
      .catch(() => {
        // Supplemental onboarding receipt. The dashboard still carries the
        // authoritative aggregate if this detail request races ingestion —
        // but never leave a stale cross-version verdict on screen.
        if (!cancelled) setDetail(null);
      });
    return () => { cancelled = true; };
  }, [dashboard.project.autoJudgedTraceCount, dashboard.skill.currentVersion.id]);

  if (!detail) return null;
  const rubric = dashboard.skill.currentVersion.rubricMarkdown.trim();
  const excerpt = rubric.length > 720 ? `${rubric.slice(0, 720).trimEnd()}…` : rubric;
  const isFirst = dashboard.project.autoJudgedTraceCount === 1;

  return (
    <Card className={cn("border-gold-tint", className)}>
      <CardHeader>
        <div>
          <Eyebrow>Recorded evaluator result</Eyebrow>
          <CardTitle className="mt-1">{isFirst ? "Your first verdict" : "Latest verdict"}</CardTitle>
          <CardDescription>Compare the evaluator result and rationale with the review guide used for this case.</CardDescription>
        </div>
        <div className="flex-1" />
        <VerdictChip verdict={detail.judgeRun.verdict} />
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-5">
        <div>
          <Eyebrow>Judge reason</Eyebrow>
          <div className="mt-2 text-[13px] leading-[1.6] text-ink-2">{detail.judgeRun.reasoning}</div>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => onOpenCase(detail.judgeRun.caseId)}>
            Open the case <ArrowRight />
          </Button>
        </div>
        <div className="border-l border-rule-soft pl-5">
          <Eyebrow>Review guide · v{dashboard.skill.currentVersion.version}</Eyebrow>
          <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.55] text-ink-3">
            {excerpt || "No review guide recorded."}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
