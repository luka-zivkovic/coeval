import { useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow, KPI, KPIRow, MarginNote, SectionHead } from "@/components/coeval";
import { ReviewPlayer } from "@/components/review-player";
import { useDashboard } from "@/lib/dashboard-context";
import { selectReviewCaseIds } from "@/lib/exception-queue";
import type { TraceDecisionKind } from "@/components/trace-detail";
import type { SessionReceiptState } from "@/screens/exceptions";

function receiptFrom(decisions: Record<string, TraceDecisionKind>): SessionReceiptState {
  const counts = { accept: 0, override: 0, promote: 0 };
  for (const kind of Object.values(decisions)) counts[kind] += 1;
  return { decided: Object.keys(decisions).length, ...counts };
}

// Ad-hoc review: "Review all N" from Exceptions or the Overview opens the
// same sequential player a persisted review queue uses — no DB queue row is
// created. A row-level review stores its exact case id in the URL so refreshes
// preserve that scope. Older navigation can still supply router state or fall
// back to the current exception queue (optionally narrowed by the legacy
// ?cluster= query key, whose value is an exact judge category).
export function ReviewScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { dashboard, loading, error } = useDashboard();
  const categoryFilter = searchParams.get("cluster");
  const explicitCaseId = searchParams.get("caseId");

  const stateCaseIds = (location.state as { caseIds?: string[] } | null)?.caseIds;

  const caseIds: string[] = useMemo(() => {
    return selectReviewCaseIds({
      explicitCaseId,
      stateCaseIds,
      exceptions: dashboard?.exceptions ?? [],
      categoryFilter
    });
  }, [explicitCaseId, stateCaseIds, dashboard, categoryFilter]);

  // Client-side session state: which cases got a decision this walk, and what
  // kind — the done view tallies it. Nothing here persists; the verdicts
  // themselves landed on the cases through the player.
  const [decisions, setDecisions] = useState<Record<string, TraceDecisionKind>>({});

  const items = useMemo(
    () => caseIds.map((id) => ({ key: id, caseId: id, completed: Boolean(decisions[id]) })),
    [caseIds, decisions]
  );

  if (loading && !dashboard && caseIds.length === 0) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Review" title="Loading queue" />
      </div>
    );
  }

  if (caseIds.length === 0) {
    return (
      <div className="fadeUp">
        <SectionHead
          eyebrow="Review"
          title={categoryFilter ? `No exceptions in ${categoryFilter}` : "Queue is clear"}
          sub={error ?? "Nothing waiting. Auto-judged traces are already synced back."}
        />
        <div className="mt-4">
          <Button variant="default" onClick={() => navigate("/exceptions")}>
            <ArrowLeft /> Back to queue
          </Button>
        </div>
      </div>
    );
  }

  // The receipt rides back to the queue as router state — the queue shows it
  // once; the durable record is the verdicts themselves.
  const exitToQueue = () => {
    const receipt = receiptFrom(decisions);
    navigate("/exceptions", receipt.decided > 0 ? { state: { sessionReceipt: receipt } } : undefined);
  };

  return (
    <ReviewPlayer
      eyebrow="Review"
      name={categoryFilter ? `Exceptions · ${categoryFilter.toLowerCase()}` : "Exceptions waiting"}
      items={items}
      onExit={exitToQueue}
      onItemChanged={(caseId, kind) => setDecisions((prev) => ({ ...prev, [caseId]: kind }))}
      renderDone={(reopen) => (
        <DoneView
          decisions={decisions}
          total={caseIds.length}
          categoryFilter={categoryFilter}
          onBack={() => navigate("/")}
          onQueue={exitToQueue}
          onSkill={() => navigate("/skill/edit")}
          onReopen={reopen}
        />
      )}
    />
  );
}

function DoneView({
  decisions,
  total,
  categoryFilter,
  onBack,
  onQueue,
  onSkill,
  onReopen
}: {
  decisions: Record<string, TraceDecisionKind>;
  total: number;
  categoryFilter: string | null;
  onBack: () => void;
  onQueue: () => void;
  onSkill: () => void;
  onReopen: () => void;
}) {
  const counts = Object.values(decisions).reduce(
    (acc, d) => {
      acc[d] += 1;
      return acc;
    },
    { accept: 0, override: 0, promote: 0 }
  );

  return (
    <div className="fadeUp max-w-[720px]">
      <Eyebrow>Review session complete</Eyebrow>
      <div className="mt-2 font-serif text-[30px] font-medium leading-[1.08] tracking-[-0.02em]">
        {total} exception{total === 1 ? "" : "s"} handled
        {categoryFilter ? ` in ${categoryFilter.toLowerCase()}` : ""}.
      </div>
      <div className="mt-3 max-w-[60ch] text-[14px] leading-[1.55] text-ink-3">
        Human verdicts are recorded on each case.
        {counts.promote
          ? ` ${counts.promote} promoted ${counts.promote === 1 ? "case is" : "cases are"} now part of the golden set and will regression-test every future skill edit.`
          : ""}
      </div>

      <KPIRow className="mt-5 mb-5">
        <KPI label="Accepted" num={counts.accept} foot="skill verdicts confirmed" />
        <KPI
          label="Overridden"
          num={counts.override}
          delta={counts.override ? "reasons on file" : "—"}
          deltaKind={counts.override ? "signal" : "default"}
        />
        <KPI
          label="Promoted"
          num={counts.promote}
          delta={counts.promote ? "added to golden set" : "—"}
          deltaKind={counts.promote ? "up" : "default"}
        />
      </KPIRow>

      {counts.override >= 2 ? (
        <MarginNote tone="signal" who="Noticed during this session" className="mb-5 max-w-[620px]">
          You recorded {counts.override} overrides. If they point to the same evaluator gap, review
          the cases together before editing the guide.
          <div className="mt-2 flex gap-2">
            <Button variant="signal" size="sm" onClick={onSkill}>
              Draft rubric edit from these cases
            </Button>
          </div>
        </MarginNote>
      ) : null}

      <Card className="mb-5">
        <CardContent className="flex flex-wrap gap-2 py-4">
          <Button variant="primary" onClick={onBack}>
            Back to overview
          </Button>
          <Button variant="default" onClick={onQueue}>
            Open the queue
          </Button>
          <Button variant="ghost" onClick={onReopen}>
            Walk the cases again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
