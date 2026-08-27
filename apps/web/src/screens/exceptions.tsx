import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronDown, ChevronRight, Clock, Inbox } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/table";
import {
  Decision,
  EmptyShell,
  Eyebrow,
  ProvBanner,
  ProvChip,
  Receipt,
  Ref,
  SectionHead,
  VerdictChip
} from "@/components/coeval";
import { SaveQueueModal } from "@/components/save-queue-modal";
import { RowLink } from "@/components/row-action";
import { fetchDisagreements, fetchGoldenSet, fetchProjectVerdicts } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardCriterionVersionId, dashboardSkillVersionId } from "@/lib/criterion-scope";
import { isBench, journeyStage } from "@/lib/journey";
import { resolvedDecisions, type ResolvedDecision } from "@/lib/resolved";
import { caseReviewUrl, rationalePreview } from "@/lib/exception-queue";
import { cn, formatTimestamp } from "@/lib/utils";
import { isVerdictLabel, type DisagreementCase, type ExceptionCase, type VerdictLabel } from "@coeval/shared";

const ALL_CATEGORIES = "All categories";
const ALL_VERDICTS = "All verdicts";

const VERDICT_OPTIONS: ReadonlyArray<VerdictLabel | typeof ALL_VERDICTS> = [
  ALL_VERDICTS,
  "pass",
  "fail",
  "ambiguous"
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Passed via router state by the review session's done view.
export interface SessionReceiptState {
  decided: number;
  accept: number;
  override: number;
  promote: number;
}

function ExceptionQueueRow({
  exception,
  provisional,
  onOpen,
  onReview,
  onCategory
}: {
  exception: ExceptionCase;
  provisional: boolean;
  onOpen: () => void;
  onReview: () => void;
  onCategory: (category: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const noteId = `exception-note-${exception.id}`;

  return (
    <tr className="row-link row-signal" onClick={onOpen}>
      <td>
        <div className="flex min-w-[180px] items-center">
          <RowLink
            to={`/cases/${exception.id}`}
            state={{ backTo: "/exceptions", backLabel: "Back to queue" }}
            title={exception.title}
            className="block min-w-0 max-w-[280px] flex-1 truncate font-medium"
          >
            {exception.title}
          </RowLink>
        </div>
        <span className="dev-only mt-1 font-mono text-[10.5px] tracking-[0.04em] text-ink-4">
          {formatTimestamp(exception.createdAt)} · {exception.traceId}
        </span>
      </td>
      <td>
        {exception.capabilityGap ? (
          <Ref
            kind="category"
            label={exception.capabilityGap}
            onClick={() => onCategory(exception.capabilityGap as string)}
          />
        ) : (
          <span className="text-[11.5px] text-ink-4">Uncategorized</span>
        )}
      </td>
      <td>
        <div className="flex items-center gap-1.5">
          <VerdictChip verdict={exception.verdict} />
          {provisional ? <ProvChip /> : null}
        </div>
        {exception.rejudgedSince ? (
          <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-4">
            <span>latest</span>
            <VerdictChip verdict={exception.rejudgedSince.verdict} />
          </div>
        ) : null}
      </td>
      <td>
        <div
          id={noteId}
          className={cn(
            "block max-w-[72ch] text-[12.5px] leading-[1.45] text-ink-3",
            expanded ? "whitespace-pre-wrap text-ink-2" : "truncate whitespace-nowrap"
          )}
        >
          {expanded ? exception.reason : rationalePreview(exception.reason)}
        </div>
        {expanded && exception.rejudgedSince ? (
          <div className="mt-2 border-t border-rule-soft pt-2 text-[11.5px] leading-[1.45] text-ink-4">
            <span className="font-medium text-ink-3">Latest evaluator note:</span>{" "}
            {exception.rejudgedSince.reason}
          </div>
        ) : null}
      </td>
      <td>
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            aria-controls={noteId}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((open) => !open);
            }}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            {expanded ? "Hide note" : "Full note"}
          </Button>
          <Button
            type="button"
            variant="default"
            size="xs"
            aria-label={`Review ${exception.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onReview();
            }}
          >
            Review <ArrowRight />
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function ExceptionsScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { dashboard, loading, error } = useDashboard();
  const criterionVersionId = dashboardCriterionVersionId(dashboard);
  const skillVersionId = dashboardSkillVersionId(dashboard);

  const sessionReceipt = (location.state as { sessionReceipt?: SessionReceiptState } | null)
    ?.sessionReceipt;

  // Keep the legacy `cluster` query key so existing saved links remain valid;
  // the values are exact evaluator-supplied failure categories, not semantic
  // similarity clusters.
  const categoryFromQuery = searchParams.get("cluster");

  const [category, setCategory] = useState<string>(categoryFromQuery ?? ALL_CATEGORIES);
  const [verdict, setVerdict] = useState<string>(ALL_VERDICTS);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [resolved, setResolved] = useState<ResolvedDecision[] | null>(null);
  const [queueModalOpen, setQueueModalOpen] = useState(false);

  // P2 · adjudication state: reviewer-vs-reviewer splits surface where the
  // daily review work happens, not only on Reliability. Rulings happen there
  // (the owner-gated modal lives on that screen); this card is the pointer.
  const [splits, setSplits] = useState<DisagreementCase[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!criterionVersionId) return;
    fetchDisagreements(criterionVersionId)
      .then((summary) => {
        if (!cancelled) setSplits(summary.cases.filter((c) => c.adjudicatedLabel === null));
      })
      .catch(() => {
        /* supplemental card — the queue works without it */
      });
    return () => {
      cancelled = true;
    };
  }, [criterionVersionId]);

  const stage = dashboard ? journeyStage(dashboard) : "production";
  const exceptions: ExceptionCase[] = dashboard?.exceptions ?? [];

  // The resolved record is reconstructed from the append-only verdict log +
  // golden promotions — there is no separate "resolution" table to drift.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!criterionVersionId || !skillVersionId) return;
        const [verdicts, golden] = await Promise.all([
          fetchProjectVerdicts({ skillVersionId }),
          fetchGoldenSet(criterionVersionId),
        ]);
        if (!cancelled) setResolved(resolvedDecisions(verdicts, golden, Date.now() - WEEK_MS));
      } catch {
        if (!cancelled) setResolved([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [criterionVersionId, dashboard?.exceptions.length, skillVersionId]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const ex of exceptions) {
      if (ex.capabilityGap) set.add(ex.capabilityGap);
    }
    // If the URL pinned a category that no longer matches any current exception,
    // still surface it as a chip so the user can see why their queue is empty
    // and choose another filter — otherwise the chip vanishes silently.
    if (category !== ALL_CATEGORIES) set.add(category);
    return [ALL_CATEGORIES, ...Array.from(set).sort()];
  }, [exceptions, category]);

  const updateCategory = (next: string) => {
    setCategory(next);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === ALL_CATEGORIES) params.delete("cluster");
        else params.set("cluster", next);
        return params;
      },
      { replace: true }
    );
  };

  const list = useMemo(() => {
    return exceptions.filter((ex) => {
      if (category !== ALL_CATEGORIES && ex.capabilityGap !== category) return false;
      if (verdict !== ALL_VERDICTS && ex.verdict !== verdict) return false;
      return true;
    });
  }, [exceptions, category, verdict]);

  const resolvedCounts = useMemo(() => {
    const counts = { accept: 0, override: 0, promote: 0, adjudicated: 0 };
    for (const r of resolved ?? []) counts[r.kind] += 1;
    return counts;
  }, [resolved]);

  if (loading && !dashboard) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Exception queue" title="Loading exceptions" />
        <div className="rounded-sm border border-rule-soft bg-card p-12 text-center text-ink-3">
          Fetching the queue…
        </div>
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Exception queue" title="API unavailable" />
        <Card>
          <div className="p-6 text-[13px] text-ink-2">
            {error ?? "Start the API with `pnpm dev:api` and refresh."}
          </div>
        </Card>
      </div>
    );
  }

  // Day 0 — the judge needs cases before there is anything to disagree about:
  // traces from a connected source, or (bench) an eval run over examples.
  if (stage === "day0") {
    const bench = isBench(dashboard.project);
    return (
      <EmptyShell
        className="min-h-[60vh] justify-center"
        eyebrow="Exception queue · empty"
        title="No cases are ready for review yet"
        body={
          bench
            ? "This queue receives cases when the evaluator is unsure, disagrees with an expected label, or a reviewer flags a result. Add examples and run the evaluator first."
            : "This queue receives cases when the evaluator is unsure, disagrees with a human ruling, or a reviewer flags a result. Connect a trace source to begin."
        }
        primary={
          <Button variant="primary" onClick={() => navigate(bench ? "/datasets" : "/")}>
            {bench ? "Open Examples" : "Back to setup"}
          </Button>
        }
      />
    );
  }

  const resolvedTotal = resolved?.length ?? 0;

  return (
    <div className="fadeUp max-w-[1760px]">
      {sessionReceipt && sessionReceipt.decided > 0 ? (
        <Receipt className="mb-5" meta="just now">
          <b>Session just now</b> · {sessionReceipt.decided}{" "}
          {sessionReceipt.decided === 1 ? "case" : "cases"} reviewed — {sessionReceipt.accept} accepted ·{" "}
          {sessionReceipt.override} overridden · {sessionReceipt.promote} promoted. Every decision is on
          the record below.
        </Receipt>
      ) : null}

      {stage === "provisional" ? (
        <ProvBanner
          className="mb-4"
          text={
            <span>
              These verdicts came from the unreviewed starter rubric. Treat them as a first draft of your
              review policy. Open cases to decide what the guide should change before sign-off.
            </span>
          }
          cta={
            <Button size="sm" onClick={() => navigate("/skill/edit")}>
              Open rubric alongside
            </Button>
          }
        />
      ) : null}

      <SectionHead
        eyebrow={`Exception queue · ${exceptions.length} waiting${
          resolved !== null ? ` · ${resolvedTotal} resolved this week` : ""
        }`}
        title="Cases that need human review"
        sub="Review cases the evaluator flagged, marked ambiguous, or judged differently from an existing human label. Reviewers can see evaluator evidence here, so these rulings remain ungoverned legacy evidence. Resolved cases leave the active queue and remain in the history below."
        right={
          list.length > 0 ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                // The filtered list rides along as state; the legacy
                // ?cluster= category key survives refresh/deep links.
                const q = category !== ALL_CATEGORIES ? `?cluster=${encodeURIComponent(category)}` : "";
                navigate(`/review${q}`, { state: { caseIds: list.map((ex) => ex.id) } });
              }}
            >
              Review all {list.length} <ArrowRight />
            </Button>
          ) : null
        }
      />

      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-3 px-[18px] py-3">
          <Eyebrow>Judge category</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <FilterChip key={c} active={c === category} onClick={() => updateCategory(c)}>
                {c}
              </FilterChip>
            ))}
          </div>
          <div className="flex-1" />
          {category !== ALL_CATEGORIES && list.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setQueueModalOpen(true)}>
              <Inbox /> Save this category as a queue · {list.length}
            </Button>
          ) : null}
          <div className="flex gap-1.5">
            {VERDICT_OPTIONS.map((v) => (
              <FilterChip key={v} active={v === verdict} onClick={() => setVerdict(v)}>
                {v}
              </FilterChip>
            ))}
          </div>
        </div>
      </Card>

      {queueModalOpen ? (
        <SaveQueueModal
          caseIds={list.map((ex) => ex.id)}
          defaultName={category !== ALL_CATEGORIES ? category : "Exceptions"}
          context={`Saved from Exceptions · judge category ${category}`}
          onClose={() => setQueueModalOpen(false)}
        />
      ) : null}

      {splits.length > 0 ? (
        <Card className="mb-4">
          <CardHeader>
            <div>
              <CardTitle>Reviewer disagreements · {splits.length}</CardTitle>
              <CardDescription>
                These cases have different recorded verdicts from two or more reviewers. Compare the
                verdicts in Reliability and record the ruling that closes each disagreement.
              </CardDescription>
            </div>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => navigate("/reliability")}>
              Compare and resolve <ArrowRight />
            </Button>
          </CardHeader>
          <Table>
            <tbody>
              {splits.slice(0, 5).map((c) => (
                <tr
                  key={c.caseId}
                  className="row-link"
                  onClick={() =>
                    navigate(`/cases/${c.caseId}`, {
                      state: { backTo: "/exceptions", backLabel: "Back to queue" }
                    })
                  }
                >
                  <td>
                    <RowLink
                      to={`/cases/${c.caseId}`}
                      state={{ backTo: "/exceptions", backLabel: "Back to queue" }}
                      className="font-mono text-[12px]"
                    >
                      {c.caseId}
                    </RowLink>
                  </td>
                  <td style={{ width: 380 }}>
                    <div className="flex flex-wrap items-center gap-3">
                      {c.labels.slice(0, 3).map((r) => (
                        <span key={r.actorUserId} className="inline-flex items-center gap-1.5">
                          <span className="text-[11px] text-ink-3">
                            {r.actorName ?? r.actorUserId.slice(0, 8)}
                          </span>
                          {isVerdictLabel(r.label) ? (
                            <VerdictChip verdict={r.label} />
                          ) : (
                            <span className="font-mono text-[11px] text-ink-2">{r.label}</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ width: 160 }} className="font-mono text-[11px] text-ink-3">
                    split {Math.round(c.severity * 100)}% · {c.reviewerCount} reviewers
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <div>
            <CardTitle>Waiting on a human</CardTitle>
            <CardDescription>
              {list.length > 0
                ? `${list.length} ${list.length === 1 ? "case matches" : "cases match"} the current filters. Expand the evaluator note here, or open Review to read the full trace and guide before recording a ruling.`
                : exceptions.length === 0
                  ? "No cases are waiting for a ruling. Resolved cases remain available in the history below."
                  : "No cases match the current filters. Change a filter to see the rest of the queue."}
            </CardDescription>
          </div>
        </CardHeader>
        {list.length === 0 ? (
          <div className="px-6 py-9 text-center">
            <Eyebrow>{exceptions.length === 0 ? "Queue cleared" : "No matches"}</Eyebrow>
            <div className="mt-2 font-serif text-[16px] font-medium tracking-[-0.012em]">
              {exceptions.length === 0
                ? "No cases are waiting in this queue."
                : "No exceptions match the current filters."}
            </div>
          </div>
        ) : (
          <Table className="table-fixed">
            <thead>
              <tr>
                <th style={{ width: 240 }}>Case</th>
                <th style={{ width: 150 }}>Judge category</th>
                <th style={{ width: 110 }}>Evaluator</th>
                <th>Judge note</th>
                <th style={{ width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((ex) => (
                <ExceptionQueueRow
                  key={ex.id}
                  exception={ex}
                  provisional={stage === "provisional"}
                  onOpen={() =>
                    navigate(`/cases/${ex.id}`, {
                      state: { backTo: "/exceptions", backLabel: "Back to queue" }
                    })
                  }
                  onCategory={updateCategory}
                  onReview={() =>
                    navigate(caseReviewUrl(ex.id, ex.capabilityGap), {
                      state: { caseIds: [ex.id] }
                    })
                  }
                />
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-4">
        <button
          type="button"
          aria-expanded={resolvedOpen}
          aria-controls="resolved-decisions-panel"
          className="flex w-full cursor-pointer items-center gap-3 px-[18px] py-3 text-left"
          onClick={() => setResolvedOpen((x) => !x)}
        >
          {resolvedOpen ? (
            <ChevronDown className="size-3 text-ink-3" />
          ) : (
            <ChevronRight className="size-3 text-ink-3" />
          )}
          <span className="text-[13px] font-medium">
            Resolved this week · {resolved === null ? "…" : resolvedTotal}
          </span>
          {resolved !== null && resolvedTotal > 0 ? (
            <span className="font-mono text-[11px] text-ink-4">
              {resolvedCounts.accept} accepted · {resolvedCounts.override} overridden ·{" "}
              {resolvedCounts.promote} promoted ★
              {resolvedCounts.adjudicated ? ` · ${resolvedCounts.adjudicated} adjudicated` : ""}
            </span>
          ) : null}
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-ink-4">append-only record</span>
        </button>
        {resolvedOpen ? (
          <div id="resolved-decisions-panel">
            {resolved === null || resolvedTotal === 0 ? (
              <div className="border-t border-rule-soft px-[18px] py-6 text-center text-[12.5px] text-ink-3">
                {resolved === null
                  ? "Loading the decision record…"
                  : "No human decisions in the last 7 days. Reviewing an exception puts it here."}
              </div>
            ) : (
              <div className="border-t border-rule-soft">
                <Table>
                  <tbody>
                    {resolved.map((row) => (
                      <tr
                        key={`${row.caseId}-${row.at}`}
                        className="row-link"
                        onClick={() =>
                          navigate(`/cases/${row.caseId}`, {
                            state: { backTo: "/exceptions", backLabel: "Back to queue" }
                          })
                        }
                      >
                        <td className="font-mono text-ink-4" style={{ width: 130 }}>
                          {formatTimestamp(row.at)}
                        </td>
                        <td>
                          <RowLink
                            to={`/cases/${row.caseId}`}
                            state={{ backTo: "/exceptions", backLabel: "Back to queue" }}
                            className="font-mono text-[12px] text-ink-3"
                          >
                            {row.caseId}
                          </RowLink>
                        </td>
                        <td style={{ width: 140 }}>
                          <Decision kind={row.kind} />
                        </td>
                        <td className="text-[12px] text-ink-4">{row.note}</td>
                        <td className="dev-only font-mono text-[11px] text-ink-4" style={{ width: 120 }}>
                          {row.actorUserId ? `by ${row.actorUserId.slice(0, 12)}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="px-[18px] py-2.5 font-mono text-[11px] tracking-[0.04em] text-ink-4">
                  all decisions stay searchable in Traces
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Card>

      <div className="mt-4 flex items-center gap-1.5 text-[12px] text-ink-3">
        <Clock className="size-3" />
        <span>
          Cases outside this queue remain searchable in Traces, even when no person has reviewed them.
        </span>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-6 items-center rounded-sm border px-2 text-[11.5px] transition-colors cursor-pointer",
        active
          ? "border-ink bg-ink text-paper"
          : "border-rule-soft bg-transparent text-ink-2 hover:bg-paper-3"
      )}
    >
      {children}
    </button>
  );
}
