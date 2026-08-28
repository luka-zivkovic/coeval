import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle, RefreshCcw } from "lucide-react";
import { verdictLabelFromPayload, type CriterionVersion, type EvalRunDetail, type VerdictRecord } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow, SectionHead, VerdictChip } from "@/components/coeval";
import {
  ensureSkillVersionBackfill,
  fetchCaseVerdicts,
  fetchEvalRunDetail,
  fetchEvalRuns,
  fetchProjectVerdicts,
  fetchSkillVersionCriterion
} from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { backfillRunForVersion, verdictForTrackedItem } from "@/lib/first-result";
import { firstResultPath, markSetupReceipt } from "@/lib/journey";

const POLL_MS = 2000;

export function FirstResultScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const versionId = searchParams.get("version");
  const skillId = searchParams.get("skill");
  const criterionId = searchParams.get("criterionId");
  const { dashboard, refresh } = useDashboard();
  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [result, setResult] = useState<{ caseId: string; verdict: VerdictRecord } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dispatchPending, setDispatchPending] = useState(false);
  const [criterionVersion, setCriterionVersion] = useState<CriterionVersion | null>(null);
  const [criterionError, setCriterionError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const receiptKey = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const nextEnsureAt = useRef(0);

  useEffect(() => {
    if (!skillId || !versionId || !criterionId) return;
    let cancelled = false;
    setCriterionVersion(null);
    setCriterionError(null);
    void fetchSkillVersionCriterion(skillId, versionId)
      .then((criterion) => {
        if (cancelled) return;
        if (criterion.criterionId !== criterionId) {
          setCriterionError("This first-Result link does not match the Check's quality question.");
          return;
        }
        setCriterionVersion(criterion);
      })
      .catch((cause) => {
        if (!cancelled) setCriterionError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [criterionId, skillId, versionId]);

  const load = useCallback(async (generation: number) => {
    const current = () => generation === loadGeneration.current;
    if (!versionId || !skillId || !criterionId) {
      if (current()) {
        setError("This first-Result link is missing its Check identity.");
        setLoading(false);
      }
      return false;
    }
    try {
      const [runs, recordedVerdicts] = await Promise.all([
        fetchEvalRuns(100),
        fetchProjectVerdicts({
          source: "llm_judge",
          skillVersionId: versionId,
          evidenceScope: "customer",
          limit: 1
        })
      ]);
      if (!current()) return false;
      const summary = backfillRunForVersion(runs, versionId);
      let detail: EvalRunDetail | null;
      let observedDispatchPending: boolean | undefined;
      let nextEnsureDelayMs: number | null = null;
      if (summary) {
        const canEnsure = dashboard?.viewerRole === "owner"
          && (summary.status === "pending" || summary.status === "running")
          && Date.now() >= nextEnsureAt.current;
        if (canEnsure) {
          const ensured = await ensureSkillVersionBackfill(skillId, versionId);
          nextEnsureDelayMs = ensured.retryAfterMs;
          observedDispatchPending = ensured.dispatchPending;
          detail = ensured.run;
        } else {
          detail = await fetchEvalRunDetail(summary.id);
          if (detail && detail.status !== "pending") observedDispatchPending = false;
        }
      } else if (recordedVerdicts[0]) {
        const verdict = recordedVerdicts[0];
        setRun(null);
        setResult({ caseId: verdict.caseId, verdict });
        setDispatchPending(false);
        setError(null);
        setLoading(false);
        if (receiptKey.current !== verdict.id) {
          receiptKey.current = verdict.id;
          const receiptVersion = dashboard?.skill.currentVersion.id === versionId
            ? dashboard.skill.currentVersion.version
            : versionId;
          markSetupReceipt(`Check v${receiptVersion} returned a Result on recorded evidence.`);
          void refresh();
        }
        return false;
      } else if (!dashboard) {
        return true;
      } else if (dashboard.project.importedTraceCount === 0) {
        setError("Add a recorded Run before asking for the first Result.");
        setLoading(false);
        return false;
      } else if (dashboard.viewerRole !== "owner") {
        setError("An owner needs to start this first Result. You can still inspect the recorded Runs.");
        setLoading(false);
        return false;
      } else {
        const ensured = await ensureSkillVersionBackfill(skillId, versionId);
        nextEnsureDelayMs = ensured.retryAfterMs;
        observedDispatchPending = ensured.dispatchPending;
        detail = ensured.run;
      }
      if (!current()) return false;
      if (nextEnsureDelayMs !== null) nextEnsureAt.current = Date.now() + nextEnsureDelayMs;
      if (observedDispatchPending !== undefined) setDispatchPending(observedDispatchPending);
      if (!detail) {
        const [recorded] = await fetchProjectVerdicts({
          source: "llm_judge",
          skillVersionId: versionId,
          evidenceScope: "customer",
          limit: 1
        });
        if (!current()) return false;
        if (recorded) {
          setRun(null);
          setResult({ caseId: recorded.caseId, verdict: recorded });
          setDispatchPending(false);
          setError(null);
          setLoading(false);
          if (receiptKey.current !== recorded.id) {
            receiptKey.current = recorded.id;
            const receiptVersion = dashboard?.skill.currentVersion.id === versionId
              ? dashboard.skill.currentVersion.version
              : versionId;
            markSetupReceipt(`Check v${receiptVersion} returned a Result on recorded evidence.`);
            void refresh();
          }
          return false;
        }
        return true;
      }
      setRun(detail);
      setError(null);
      setLoading(false);

      const completedItem = detail.items.find((item) => item.status === "completed" && item.verdictId);
      if (completedItem) {
        const verdicts = await fetchCaseVerdicts(completedItem.caseId, {
          source: "llm_judge",
          skillVersionId: versionId,
          limit: 100
        });
        if (!current()) return false;
        const verdict = verdictForTrackedItem(verdicts, completedItem.verdictId!);
        if (!verdict) {
          setError("The tracked run finished, but its exact Result record could not be loaded.");
          return false;
        }
        setResult({ caseId: completedItem.caseId, verdict });
        if (receiptKey.current !== detail.id) {
          receiptKey.current = detail.id;
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
      if (current()) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
      return false;
    }
  }, [criterionId, dashboard, refresh, skillId, versionId]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    setRun(null);
    setResult(null);
    setError(null);
    setDispatchPending(false);
    setLoading(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const keepPolling = await load(generation);
      if (!cancelled && keepPolling) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (loadGeneration.current === generation) loadGeneration.current += 1;
      if (timer) clearTimeout(timer);
    };
  }, [load, retryNonce]);

  const versionLabel = dashboard?.skill.currentVersion.id === versionId
    ? `v${dashboard.skill.currentVersion.version}`
    : "the saved Check";
  const completed = run?.completedItems ?? (result
    ? Math.max(1, dashboard?.skill.currentVersion.id === versionId ? dashboard.currentVersionResultCount : 0)
    : 0);
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
        title={result
          ? "Your first Result is ready"
          : dispatchPending
            ? "Waiting to start the saved Check run"
            : `Applying ${versionLabel} to a recorded Run`}
        sub={result
          ? "This is the Check's opinion about evidence your AI already produced. It is not a human decision, proof of accuracy, or permission to ship."
          : dispatchPending
            ? "The Run is saved, but Coeval has not confirmed that evaluation started. No Result exists yet."
            : "Coeval is evaluating saved evidence. You can leave this page and return—the progress below is stored."}
      />

      {criterionError ? (
        <StatusCard
          urgent
          icon={<CircleAlert className="size-4" />}
          title="Could not verify which quality question produced this Result"
          body={criterionError}
        />
      ) : versionId && skillId && criterionId && !criterionVersion ? (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title="Loading the saved quality question"
          body="Coeval is verifying the exact Check definition bound to this Result before showing its verdict."
        />
      ) : criterionVersion ? (
        <Card className="mb-4 border-gold-tint">
          <CardHeader>
            <div>
              <Eyebrow>This Result answers</Eyebrow>
              <CardTitle className="mt-1">{criterionVersion.name}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="font-serif text-[20px] leading-7 text-ink">{criterionVersion.definition}</p>
            <p className="mt-3 text-[12px] leading-5 text-ink-2">
              Starter · unvalidated. The verdict below is this Check's model opinion, not proof that the Check is accurate.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {criterionError || (versionId && skillId && criterionId && !criterionVersion) ? null : loading && !run ? (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title="Preparing the Check run"
          body="The Check has been saved. Coeval is creating a tracked run over the recorded evidence."
        />
      ) : error ? (
        <StatusCard
          urgent
          icon={<CircleAlert className="size-4" />}
          title="Could not read the evaluation status"
          body={error}
          actions={
            <Button size="sm" variant="outline" onClick={() => {
              setLoading(true);
              setError(null);
              nextEnsureAt.current = 0;
              setRetryNonce((value) => value + 1);
            }}>
              <RefreshCcw /> Try again
            </Button>
          }
        />
      ) : dispatchPending && run && run.status === "pending" ? (
        <StatusCard
          urgent
          icon={<CircleAlert className="size-4" />}
          title="Run saved, waiting to enter the evaluation queue"
          body="Coeval has not confirmed a live queue job yet. It will keep checking this saved run; no Result has been produced or queued successfully yet."
          actions={
            <Button size="sm" variant="outline" onClick={() => {
              setLoading(true);
              nextEnsureAt.current = 0;
              setRetryNonce((value) => value + 1);
            }}>
              <RefreshCcw /> Try queueing again
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
          urgent
          icon={<CircleAlert className="size-4" />}
          title="The first Result could not be produced"
          body={`${run.error ?? `${failed.toLocaleString()} of ${total.toLocaleString()} Check attempts failed before a Result was recorded.`} Fix the provider setup if needed, then save a new Check version to try again.`}
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => navigate("/skill/edit")}>
                Review the Check
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate("/settings")}>
                Check provider settings
              </Button>
            </>
          }
        />
      ) : result ? (
        <Card className="border-gold-tint" role="status" aria-live="polite" aria-atomic="true">
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
            <VerdictChip verdict={verdictLabelFromPayload(result.verdict.payload)} />
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <Eyebrow>Why the Check said this</Eyebrow>
              <div className="mt-2 text-[13px] leading-[1.65] text-ink-2">
                {result.verdict.payload.rationale}
              </div>
              <Button
                className="mt-4"
                size="sm"
                variant="primary"
                onClick={() => navigate(`/cases/${result.caseId}`, {
                  state: { backTo: firstResultPath(versionId!, skillId!, criterionId!), backLabel: "Back to first Result" }
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
  actions,
  urgent = false
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  actions?: React.ReactNode;
  urgent?: boolean;
}) {
  return (
    <Card role={urgent ? "alert" : "status"} aria-live={urgent ? "assertive" : "polite"} aria-atomic="true">
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
