import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle, RefreshCcw } from "lucide-react";
import type { EvalRunDetail, ExceptionDetail } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow, SectionHead, VerdictChip } from "@/components/coeval";
import { ensureSkillVersionBackfill, fetchCaseDetail, fetchEvalRunDetail, fetchEvalRuns } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { backfillRunForVersion } from "@/lib/first-result";
import { firstRunEditorPath, markSetupReceipt } from "@/lib/journey";

const POLL_MS = 2000;

export function FirstResultScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const versionId = searchParams.get("version");
  const { dashboard, refresh } = useDashboard();
  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [result, setResult] = useState<ExceptionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const receiptRun = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!versionId) {
      setError("This first-Result link is missing its Check version.");
      setLoading(false);
      return false;
    }
    try {
      const summary = backfillRunForVersion(await fetchEvalRuns(100), versionId);
      let detail: EvalRunDetail | null;
      if (summary) {
        detail = await fetchEvalRunDetail(summary.id);
      } else if (!dashboard) {
        return true;
      } else if (dashboard.project.importedTraceCount === 0) {
        setError("Add a recorded Run before asking for the first Result.");
        setLoading(false);
        return false;
      } else {
        detail = await ensureSkillVersionBackfill(dashboard.skill.id, versionId);
      }
      if (!detail) {
        setError("The saved evaluation run could not be loaded.");
        setLoading(false);
        return false;
      }
      setRun(detail);
      setError(null);
      setLoading(false);

      const completedItem = detail.items.find((item) => item.status === "completed" && item.verdictId);
      if (completedItem) {
        const caseDetail = await fetchCaseDetail(completedItem.caseId, versionId);
        setResult(caseDetail);
        if (receiptRun.current !== detail.id) {
          receiptRun.current = detail.id;
          const receiptVersion = dashboard?.skill.currentVersion.id === versionId
            ? dashboard.skill.currentVersion.version
            : versionId;
          markSetupReceipt(
            `Check v${receiptVersion} returned a Result on recorded evidence.`
          );
          void refresh();
        }
      } else {
        setResult(null);
      }
      return detail.status === "pending" || detail.status === "running";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
      return false;
    }
  }, [dashboard, refresh, versionId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const keepPolling = await load();
      if (!cancelled && keepPolling) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const versionLabel = dashboard?.skill.currentVersion.id === versionId
    ? `v${dashboard.skill.currentVersion.version}`
    : "the saved Check";
  const completed = run?.completedItems ?? 0;
  const failed = run?.failedItems ?? 0;
  const total = run?.totalItems ?? dashboard?.project.importedTraceCount ?? 0;

  return (
    <div className="fadeUp max-w-[1180px]">
      <div className="mb-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <ArrowLeft /> Back to Overview
        </Button>
      </div>
      <SectionHead
        eyebrow="First setup · Result"
        title={result ? "Your first Result is ready" : `Applying ${versionLabel} to a recorded Run`}
        sub={result
          ? "This is the Check's opinion about evidence your AI already produced. It is not a human decision, proof of accuracy, or permission to ship."
          : "Coeval is evaluating saved evidence. You can leave this page and return—the progress below is stored."}
      />

      {loading && !run ? (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title="Preparing the Check run"
          body="The Check has been saved. Coeval is creating a tracked run over the recorded evidence."
        />
      ) : error ? (
        <StatusCard
          icon={<CircleAlert className="size-4" />}
          title="Could not read the evaluation status"
          body={error}
          actions={
            <Button size="sm" variant="outline" onClick={() => {
              setLoading(true);
              setError(null);
              void load();
            }}>
              <RefreshCcw /> Try again
            </Button>
          }
        />
      ) : run && (run.status === "pending" || run.status === "running") ? (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title={run.status === "pending" ? "Check queued" : "Checking recorded evidence"}
          body={`${(completed + failed).toLocaleString()} of ${total.toLocaleString()} recorded ${total === 1 ? "Run" : "Runs"} finished${failed > 0 ? ` · ${failed} could not run` : ""}.`}
        />
      ) : run && !result ? (
        <StatusCard
          icon={<CircleAlert className="size-4" />}
          title="The first Result could not be produced"
          body={`${run.error ?? `${failed.toLocaleString()} of ${total.toLocaleString()} Check attempts failed before a Result was recorded.`} Fix the provider setup if needed, then save a new Check version to try again.`}
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => navigate(firstRunEditorPath())}>
                Review the Check
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate("/settings")}>
                Check provider settings
              </Button>
            </>
          }
        />
      ) : result ? (
        <Card className="border-gold-tint">
          <CardHeader>
            <div>
              <Eyebrow>Recorded Check Result · {versionLabel}</Eyebrow>
              <CardTitle className="mt-1">What the Check concluded</CardTitle>
              <CardDescription>
                {completed.toLocaleString()} of {total.toLocaleString()} recorded {total === 1 ? "Run has" : "Runs have"} a Result
                {failed > 0 ? ` · ${failed} could not run` : ""}.
              </CardDescription>
            </div>
            <div className="flex-1" />
            <VerdictChip verdict={result.judgeRun.verdict} />
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <Eyebrow>Why the Check said this</Eyebrow>
              <div className="mt-2 text-[13px] leading-[1.65] text-ink-2">
                {result.judgeRun.reasoning}
              </div>
              <Button
                className="mt-4"
                size="sm"
                variant="primary"
                onClick={() => navigate(`/cases/${result.judgeRun.caseId}`, {
                  state: { backTo: `/first-result?version=${encodeURIComponent(versionId!)}`, backLabel: "Back to first Result" }
                })}
              >
                Open the recorded Run <ArrowRight />
              </Button>
            </div>
            <div className="border-t border-rule-soft pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <Eyebrow>What this does—and does not—show</Eyebrow>
              <div className="mt-2 text-[13px] leading-[1.65] text-ink-2">
                The Check read the stored input, output, and any recorded steps or tool calls. It did
                not replay tools or verify outside side effects. A person can review this Result later,
                and that human ruling remains separate.
              </div>
              <Button className="mt-4" size="sm" variant="outline" onClick={() => navigate("/")}>
                Finish setup
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title="Waiting for the tracked Check run"
          body="The Check passed its saved regression step. Its evaluation run will appear here as soon as it is created."
        />
      )}
    </div>
  );
}

function StatusCard({
  icon,
  title,
  body,
  actions
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  actions?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="py-8">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          {icon}
          {title}
        </div>
        <div className="mt-2 max-w-[72ch] text-[12.5px] leading-[1.6] text-ink-3">{body}</div>
        {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}
