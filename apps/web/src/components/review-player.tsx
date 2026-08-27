import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronLeft, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow, MarginNote } from "@/components/coeval";
import { TraceDetail, type TraceDecisionKind } from "@/components/trace-detail";
import { fetchCaseDetail } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardSkillVersionId } from "@/lib/criterion-scope";
import { cn } from "@/lib/utils";
import type { ExceptionDetail } from "@coeval/shared";

export interface ReviewPlayerItem {
  // Stable identity for the strip dots (queue item id, or the caseId itself
  // in ad-hoc mode).
  key: string;
  caseId: string;
  completed: boolean;
}

interface ReviewPlayerProps {
  eyebrow: string;
  name: string;
  // Short id shown next to the eyebrow (queue ids); omitted in ad-hoc mode.
  idTag?: string | undefined;
  // Ordered by the host: queue position, or the exception list order.
  items: ReviewPlayerItem[];
  marginNote?: { who: string; text: string } | undefined;
  onExit: () => void;
  // A decision landed on the case. Queue hosts reload their items (the server
  // marks completion); the ad-hoc host marks it client-side and tallies.
  onItemChanged: (caseId: string, kind: TraceDecisionKind) => void;
  // Rendered when every item is completed (unless the user reopened the walk).
  renderDone: (reopen: () => void) => React.ReactNode;
}

// The one sequential review surface. Both entry points — a persisted review
// queue and the ad-hoc "Review all N" flow from Exceptions/Overview — drive
// this player; verdicts always land through TraceDetail, exactly like the
// standalone case view, so there is no second review code path.
export function ReviewPlayer({
  eyebrow,
  name,
  idTag,
  items,
  marginNote,
  onExit,
  onItemChanged,
  renderDone
}: ReviewPlayerProps) {
  const { dashboard, refresh } = useDashboard();
  const skillVersionId = dashboardSkillVersionId(dashboard);
  const completedCount = items.filter((i) => i.completed).length;
  const total = items.length;
  const allComplete = total > 0 && completedCount === total;

  // Land on the first pending item; if everything is done, on the last.
  const firstPendingIndex = items.findIndex((i) => !i.completed);
  const initialCursor = firstPendingIndex >= 0 ? firstPendingIndex : Math.max(0, total - 1);

  const [cursor, setCursor] = useState(initialCursor);
  // `walkAgain` lets the user re-enter from the done view and stay in work
  // mode even when every item is already completed. Otherwise the allComplete
  // branch would short-circuit back on the next render.
  const [walkAgain, setWalkAgain] = useState(false);

  // Clamp / re-anchor when the items list changes underneath us.
  useEffect(() => {
    if (total === 0) {
      setCursor(0);
      return;
    }
    setCursor((c) => Math.min(c, total - 1));
  }, [total]);

  // Advance to the next pending case (or just the next case if none are
  // pending) after the user records a decision on the current one.
  const advanceCursor = useCallback(() => {
    setCursor((c) => {
      const nextPending = items.findIndex((item, idx) => idx > c && !item.completed);
      if (nextPending !== -1) return nextPending;
      return Math.min(c + 1, total - 1);
    });
  }, [items, total]);

  const current = items[cursor];
  const [detail, setDetail] = useState<ExceptionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Bumping retryTick refetches the current case after a failed load.
  const [retryTick, setRetryTick] = useState(0);

  // Fetch the trace detail for the current case. Race-guard: depend on the
  // case id only, cancel stale fetches, so the items array reference churning
  // (host reloads) doesn't flash a refetch.
  useEffect(() => {
    if (!current) return;
    setDetail(null);
    setDetailError(null);
    const targetCaseId = current.caseId;
    let cancelled = false;
    fetchCaseDetail(targetCaseId, skillVersionId ?? undefined)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [current?.caseId, retryTick, skillVersionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const prev = useCallback(() => setCursor((c) => Math.max(0, c - 1)), []);
  const next = useCallback(() => setCursor((c) => Math.min(total - 1, c + 1)), [total]);

  const shortcuts = useMemo(
    () => ({ onSkip: next, onPrev: prev, onNext: next, onExit }),
    [next, prev, onExit]
  );

  if (allComplete && !walkAgain) {
    return (
      <>
        {renderDone(() => {
          setCursor(0);
          setWalkAgain(true);
        })}
      </>
    );
  }

  return (
    <div className="fadeUp">
      <Topbar
        eyebrow={eyebrow}
        name={name}
        idTag={idTag}
        cursor={cursor}
        completedCount={completedCount}
        total={total}
        onExit={onExit}
      />

      <NavStrip items={items} cursor={cursor} onPick={(i) => setCursor(i)} onPrev={prev} onNext={next} />

      {!current ? (
        <Card>
          <CardContent className="py-8 text-center text-ink-3">Nothing to review.</CardContent>
        </Card>
      ) : detailError ? (
        <Card>
          <CardContent className="py-6 text-center">
            <div className="text-[13px] text-ink-2">{detailError}</div>
            <Button variant="default" size="sm" className="mt-3" onClick={() => setRetryTick((t) => t + 1)}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : !detail ? (
        <Card>
          <CardContent className="py-8 text-center text-ink-3">Loading trace…</CardContent>
        </Card>
      ) : (
        <>
          {marginNote ? (
            <MarginNote tone="neutral" who={marginNote.who} className="mb-5">
              Case {cursor + 1} of {total}. {marginNote.text}
            </MarginNote>
          ) : null}
          <TraceDetail
            detail={detail}
            shortcuts={shortcuts}
            onChanged={(kind) => {
              const caseId = current.caseId;
              void refresh();
              advanceCursor();
              onItemChanged(caseId, kind);
            }}
          />
        </>
      )}
    </div>
  );
}

function Topbar({
  eyebrow,
  name,
  idTag,
  cursor,
  completedCount,
  total,
  onExit
}: {
  eyebrow: string;
  name: string;
  idTag?: string | undefined;
  cursor: number;
  completedCount: number;
  total: number;
  onExit: () => void;
}) {
  const pct = total === 0 ? 0 : Math.round((completedCount / total) * 100);
  return (
    <div className="sticky top-0 z-10 -mx-5 -mt-7 mb-6 border-b border-rule-soft bg-paper/85 px-5 pt-3 pb-3 backdrop-blur sm:-mx-8 sm:px-8 xl:-mx-12 xl:-mt-9 xl:px-12">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Eyebrow>{eyebrow}</Eyebrow>
            {idTag ? <span className="font-mono text-[10.5px] text-ink-3">· {idTag}</span> : null}
          </div>
          <div className="mt-0.5 truncate font-serif text-[16px] font-medium tracking-[-0.012em]">
            {name}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <div className="h-[3px] flex-1 max-w-[420px] rounded-sm bg-paper-3">
              <div className="h-full rounded-sm bg-ink" style={{ width: `${pct}%` }} />
            </div>
            <div className="font-mono text-[11px] text-ink-3 whitespace-nowrap">
              <b className="font-medium text-ink">{completedCount}</b>
              <span className="text-ink-4"> of {total} done</span>
              <span className="text-ink-4"> · case {cursor + 1}</span>
            </div>
          </div>
        </div>
        <Button variant="default" size="sm" onClick={onExit}>
          <X /> Pause and exit
        </Button>
      </div>
    </div>
  );
}

function NavStrip({
  items,
  cursor,
  onPick,
  onPrev,
  onNext
}: {
  items: ReviewPlayerItem[];
  cursor: number;
  onPick: (i: number) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-3 border-b border-rule-soft pb-3">
      <Button variant="ghost" size="sm" disabled={cursor === 0} onClick={onPrev}>
        <ChevronLeft /> Prev
      </Button>
      <Button variant="default" size="sm" disabled={cursor >= items.length - 1} onClick={onNext}>
        Next <ArrowRight />
      </Button>
      <div className="ml-2 flex flex-1 flex-wrap items-center gap-[3px]">
        {items.map((item, i) => {
          const isCurrent = i === cursor;
          const cls = isCurrent ? "bg-ink" : item.completed ? "bg-ink-2" : "bg-rule-soft group-hover:bg-gold";
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onPick(i)}
              title={`Case ${i + 1} · ${item.caseId} · ${item.completed ? "completed" : "pending"}`}
              aria-label={`Go to case ${i + 1}`}
              className="group grid size-6 cursor-pointer place-items-center rounded-sm"
            >
              <span className={cn("size-1.5 rounded-sm", cls)} />
            </button>
          );
        })}
      </div>
      <div className="font-mono text-[10.5px] text-ink-3">
        {items[cursor]?.completed ? "recorded" : "not yet verdicted"}
      </div>
    </div>
  );
}
