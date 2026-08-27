import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileCheck2, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionHead } from "@/components/coeval";
import { TraceDetail } from "@/components/trace-detail";
import { fetchCaseDetail, fetchTraceTests } from "@/lib/api";
import { intentForVerdict, type TraceTestIntent } from "@/lib/trace-test-flow";
import { dismissTraceTestPrompt, traceTestPromptDismissed } from "@/lib/trace-test-pilot";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardSkillVersionId } from "@/lib/criterion-scope";
import { type ExceptionDetail, type TraceTestSummary } from "@coeval/shared";

interface TraceScreenProps {
  fetcher: (caseId: string) => Promise<ExceptionDetail>;
  backTo: string;
  backLabel: string;
}

function TraceScreenBase({ fetcher, backTo, backLabel }: TraceScreenProps) {
  const { id: caseId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { refresh } = useDashboard();
  const [detail, setDetail] = useState<ExceptionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Reload-after-verdict callback. Race guard: tag each call so a stale
  // refetch from a previous case can't write its error/detail into the new
  // case's UI. (The initial-load effect below has its own cleanup-based guard.)
  const loadSeqRef = useRef(0);

  const load = useCallback(
    (id: string) => {
      const seq = ++loadSeqRef.current;
      fetcher(id)
        .then((d) => {
          if (loadSeqRef.current !== seq) return;
          setDetail(d);
          setError(null);
        })
        .catch((err) => {
          if (loadSeqRef.current !== seq) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (loadSeqRef.current === seq) setLoading(false);
        });
    },
    [fetcher]
  );

  useEffect(() => {
    if (!caseId) return;
    setDetail(null);
    setError(null);
    setLoading(true);
    // Bumping the sequence ref before kicking the fetch ensures any in-flight
    // refetch from a previously-rendered caseId is ignored when it resolves.
    const seq = ++loadSeqRef.current;
    let cancelled = false;
    fetcher(caseId)
      .then((d) => {
        if (cancelled || loadSeqRef.current !== seq) return;
        setDetail(d);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || loadSeqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled || loadSeqRef.current !== seq) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, fetcher]);

  if (!caseId) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Trace" title="Missing case id" />
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Trace drill-down" title="Loading trace" />
        <Card>
          <CardContent className="text-ink-3">Fetching case…</CardContent>
        </Card>
      </div>
    );
  }

  // Only swap to the full error card on initial-load failure (no detail to
  // fall back on). For refresh failures we keep the working view and show a
  // dismissable banner — the user just recorded a verdict; losing the page
  // because the follow-up fetch hiccupped would discard their success.
  if (!detail) {
    return (
      <div className="fadeUp">
        <div className="mb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}>
            <ArrowLeft /> {backLabel}
          </Button>
        </div>
        <SectionHead eyebrow="Trace drill-down" title="Could not load trace" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            {error ?? "Trace was not found."}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fadeUp">
      <div className="mb-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate(backTo)}>
          <ArrowLeft /> {backLabel}
        </Button>
        <div className="font-mono text-[11px] text-ink-3">
          {detail.exception.id} · {detail.trace.id}
        </div>
      </div>

      {error ? (
        <div className="mb-3 flex items-center gap-3 rounded-sm border border-signal-tint bg-signal-wash px-3 py-2 text-[12px] text-signal">
          <span className="flex-1">Could not refresh trace: {error}</span>
          <Button variant="ghost" size="xs" onClick={() => load(caseId)}>
            Retry
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      <TraceTestEntry detail={detail} />

      <TraceDetail
        detail={detail}
        onChanged={() => {
          load(caseId);
          void refresh();
        }}
      />
    </div>
  );
}

const ENTRY_COPY: Record<TraceTestIntent, { title: string; body: string }> = {
  prevent: {
    title: "Prevent this next time",
    body: "Choose what should happen next time, then save it as a plain-language test."
  },
  protect: {
    title: "Protect this behavior",
    body: "Keep the useful behavior in this response as a test you can check again later."
  },
  make: {
    title: "Make this a test",
    body: "Choose what matters in this conversation, then save the behavior you want as a rerunnable test."
  }
};

function TraceTestEntry({ detail }: { detail: ExceptionDetail }) {
  const navigate = useNavigate();
  const [tests, setTests] = useState<TraceTestSummary[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const [draftsError, setDraftsError] = useState(false);
  const [draftsReload, setDraftsReload] = useState(0);
  const [promptDismissed, setPromptDismissed] = useState(() => traceTestPromptDismissed(detail.exception.id));
  const effectiveVerdict = detail.latestHumanLabel ?? detail.exception.verdict;
  const intent = intentForVerdict(effectiveVerdict);
  const copy = ENTRY_COPY[intent];

  useEffect(() => {
    let cancelled = false;
    setDraftsLoaded(false);
    setDraftsError(false);
    fetchTraceTests(detail.exception.id)
      .then((rows) => {
        if (cancelled) return;
        setTests(rows);
      })
      .catch(() => {
        if (!cancelled) {
          setTests([]);
          setDraftsError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setDraftsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [detail.exception.id, draftsReload]);

  useEffect(() => {
    setPromptDismissed(traceTestPromptDismissed(detail.exception.id));
  }, [detail.exception.id]);

  const openBuilder = (suffix: string) => navigate(
    `/cases/${detail.exception.id}/make-test${suffix}`,
    { state: { backTo: `/cases/${detail.exception.id}`, backLabel: "Back to conversation" } }
  );
  const drafts = tests.filter((test) => test.lifecycle === "draft" || test.hasUnpublishedChanges);
  const enabled = tests.filter((test) => test.enabledRevision !== null);
  const latestDraft = drafts[0];

  if (!draftsLoaded) {
    return (
      <div className="mb-5 flex justify-end">
        <Button variant="ghost" size="sm" disabled><ShieldCheck /> Checking saved tests…</Button>
      </div>
    );
  }

  if (!draftsError && !latestDraft && enabled.length > 0) {
    return (
      <div className="mb-5 flex flex-wrap items-center gap-4 rounded-sm border border-rule-soft bg-paper-2 px-4 py-3.5">
        <div className="grid size-8 shrink-0 place-items-center rounded-sm border border-rule-soft bg-card text-ink-2"><ShieldCheck className="size-4" /></div>
        <div className="min-w-[220px] flex-1">
          <div className="font-serif text-[15px] font-medium text-ink">This conversation is protected</div>
          <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">{enabled.length} enabled test{enabled.length === 1 ? "" : "s"} keep the saved behavior available for future runs.</div>
        </div>
        <Button variant="outline" onClick={() => navigate("/datasets")}>View test runs</Button>
        <Button variant="ghost" onClick={() => openBuilder(`?intent=${intent}`)}>Make another test</Button>
      </div>
    );
  }

  if (!draftsError && promptDismissed && !latestDraft) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-end gap-2 text-[11.5px] text-ink-3">
        <span>Start a draft rerunnable test from this conversation.</span>
        <Button variant="ghost" size="sm" onClick={() => openBuilder(`?intent=${intent}`)}>
          <ShieldCheck /> {copy.title}
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-4 rounded-sm border border-rule-soft bg-paper-2 px-4 py-3.5">
      <div className="grid size-8 shrink-0 place-items-center rounded-sm border border-rule-soft bg-card text-ink-2">
        {latestDraft ? <FileCheck2 className="size-4" /> : <ShieldCheck className="size-4" />}
      </div>
      <div className="min-w-[220px] flex-1">
        <div className="font-serif text-[15px] font-medium text-ink">{latestDraft ? "Resume test draft" : copy.title}</div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">
          {latestDraft
            ? `${drafts.length} saved draft${drafts.length === 1 ? "" : "s"} from this conversation. Resume the most recently updated one.`
            : draftsError ? "Coeval could not check this conversation for saved drafts. Retry before starting another." : copy.body}
        </div>
      </div>
      <Button
        variant="primary"
        disabled={!draftsLoaded}
        onClick={() => draftsError ? setDraftsReload((value) => value + 1) : openBuilder(latestDraft ? `?draft=${encodeURIComponent(latestDraft.id)}` : `?intent=${intent}`)}
      >
        {draftsError ? "Retry" : latestDraft ? "Resume draft" : copy.title}
      </Button>
      {!latestDraft && !draftsError ? (
        <Button
          variant="ghost"
          onClick={() => {
            dismissTraceTestPrompt(detail.exception.id);
            setPromptDismissed(true);
          }}
        >Not now</Button>
      ) : null}
      {drafts.length > 1 ? (
        <details className="w-full border-t border-rule-soft pt-2">
          <summary className="inline-flex min-h-6 cursor-pointer items-center text-[11.5px] text-ink-3">Choose another saved draft</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {drafts.slice(1).map((draft) => (
              <Button key={draft.id} variant="ghost" size="xs" onClick={() => openBuilder(`?draft=${encodeURIComponent(draft.id)}`)}>
                {new Date(draft.updatedAt).toLocaleString()}
              </Button>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

// The canonical case-detail screen. Callers that aren't the Traces audit
// (e.g. the exceptions queue) pass their back target through router state:
// `navigate(`/cases/${id}`, { state: { backTo: "/exceptions", backLabel: "Back to queue" } })`.
export function CaseScreen() {
  const location = useLocation();
  const { dashboard } = useDashboard();
  const skillVersionId = dashboardSkillVersionId(dashboard);
  const fetcher = useCallback(
    (caseId: string) => fetchCaseDetail(caseId, skillVersionId ?? undefined),
    [skillVersionId],
  );
  const state = (location.state ?? {}) as { backTo?: string; backLabel?: string };
  return (
    <TraceScreenBase
      fetcher={fetcher}
      backTo={state.backTo ?? "/traces"}
      backLabel={state.backLabel ?? "Back to Traces"}
    />
  );
}
