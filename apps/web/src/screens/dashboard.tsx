import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, RefreshCcw, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Table } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { Eyebrow, SectionHead, KPI, KPIRow, DistBar, Legend, VerdictChip, Chip, JourneyPipeline, Receipt, Ref } from "@/components/coeval";
import { DashboardWelcome } from "@/screens/dashboard-welcome";
import { DashboardBenchWelcome } from "@/screens/dashboard-bench-welcome";
import { DashboardProvisional } from "@/screens/dashboard-provisional";
import { FirstRunSetupLedger } from "@/components/first-run-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import { FirstVerdictCard } from "@/components/first-verdict";
import { RowLink } from "@/components/row-action";
import { countLegacyHumanCheckedCases } from "@/lib/legacy-human-checks";
import { useDashboard } from "@/lib/dashboard-context";
import { useMode } from "@/hooks/use-mode";
import { isBench, journeyStage, takeSetupReceipt, clearSetupReceipt } from "@/lib/journey";
import type { CapabilityGap } from "@coeval/shared";

const QUEUE_VOLUME: Record<CapabilityGap["severity"], string> = {
  high:   "High unresolved volume",
  medium: "Moderate unresolved volume",
  low:    "Low unresolved volume"
};

export function DashboardScreen() {
  const navigate = useNavigate();
  const { dashboard, loading, error, reload } = useDashboard();
  const [mode] = useMode();
  const [receipt, setReceipt] = useState<string | null>(() => takeSetupReceipt());
  const criterionId = dashboard?.skill.criterionId ?? null;

  // "Says who, about which cases?" — the legacy human-check number is counted
  // from the verdict log itself (distinct cases with a human or adjudicated
  // verdict). Governed truth lives on a separate evidence path.
  const [legacyHumanChecked, setLegacyHumanChecked] = useState<number | null>(null);
  useEffect(() => {
    if (!criterionId) {
      setLegacyHumanChecked(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const checkedCases = await countLegacyHumanCheckedCases(criterionId);
        if (!cancelled) {
          setLegacyHumanChecked(checkedCases);
        }
      } catch {
        if (!cancelled) setLegacyHumanChecked(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [criterionId]);

  const totals = useMemo(() => {
    if (!dashboard) return null;
    const { pass, fail, ambiguous } = dashboard.verdictDistribution;
    const total = pass + fail + ambiguous;
    return {
      total,
      pass,
      fail,
      ambiguous,
      passPct: total ? Math.round((pass / total) * 100) : 0,
      failPct: total ? Math.round((fail / total) * 100) : 0,
      ambigPct: total ? Math.round((ambiguous / total) * 100) : 0
    };
  }, [dashboard]);

  if (loading && !dashboard) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Loading" title="Monday morning" />
        <div className="rounded-sm border border-rule-soft bg-card p-12 text-center text-ink-3">
          Fetching project dashboard…
        </div>
      </div>
    );
  }

  if (error || !dashboard || !totals) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Coeval" title="API unavailable" />
        <Card>
          <CardContent>
            <p className="text-[13px] text-ink-2">{error ?? "Start the API with `pnpm dev:api` and refresh."}</p>
            <Button variant="primary" className="mt-3" onClick={() => void reload()}>
              <RefreshCcw /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Journey stages (P0-1), derived from real state:
  //   day0        → setup ledger (nothing imported, nothing to show)
  //   provisional → traces in, starter rubric never approved — verdicts wear
  //                 the dashed badge until review or explicit sign-off
  //   production  → the dashboard below
  const stage = journeyStage(dashboard);
  if (stage === "day0") {
    // Owners only: creating a pairing is owner-gated server-side, so showing
    // the card to members would offer a guaranteed-403 action.
    const canPairAgent = dashboard.viewerRole === "owner" && dashboard.skill.isStarter;
    return isBench(dashboard.project)
      ? <DashboardBenchWelcome dashboard={dashboard} canPairAgent={canPairAgent} />
      : <DashboardWelcome dashboard={dashboard} canPairAgent={canPairAgent} />;
  }
  if (stage === "provisional") {
    return <DashboardProvisional dashboard={dashboard} onSignedOff={() => void reload()} />;
  }

  const { project, skill, exceptions, topCapabilityGaps, goldenSetSize } = dashboard;
  // Bench copy rule: supplied examples, never traces; no sync-back or
  // trace-screen targets (both are outside the bench IA); "established",
  // never production language.
  const bench = isBench(project);
  const importedTotal = project.importedTraceCount;
  const autoJudged = project.autoJudgedTraceCount;
  const exceptionsTotal = exceptions.length;
  const syncBackPct = Math.round(project.syncBackCoverage * 100);
  const agreement = skill.currentVersion.goldenSetAgreement;
  const agreementPct = agreement == null ? null : Math.round(agreement * 100);

  return (
    <div className="fadeUp max-w-[1760px]">
      <FirstProjectKeyCard project={project} className="mb-5" />
      {receipt ? (
        <Receipt
          className="mb-5"
          meta="just now"
          actions={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearSetupReceipt();
                setReceipt(null);
              }}
            >
              <X /> Dismiss
            </Button>
          }
        >
          <b>Setup complete.</b> {receipt}
        </Receipt>
      ) : null}
      <SectionHead
        eyebrow="Overview"
        title="Project overview"
        sub={bench
          ? "See what is ready, what still needs an example or Run, and the next action for this Check."
          : "See what is set up, what needs a human, and the next action for this criterion before opening detailed evidence."}
        when={`Data as of ${new Date(project.updatedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })}`}
      />

      {bench ? (
        <FirstRunSetupLedger dashboard={dashboard} className="mb-7" />
      ) : (
        <JourneyPipeline dashboard={dashboard} onNavigate={navigate} />
      )}

      {project.autoJudgedTraceCount === 1 ? (
        <FirstVerdictCard
          dashboard={dashboard}
          onOpenCase={(caseId) => navigate(`/cases/${caseId}`, { state: { backTo: "/", backLabel: "Back to overview" } })}
          className="mb-7"
        />
      ) : null}

      <div className="mb-7 max-w-[760px] font-serif text-[22px] font-medium leading-[1.28] tracking-[-0.022em]">
        The Check evaluated {autoJudged.toLocaleString()} of {importedTotal.toLocaleString()}{" "}
        {bench ? "supplied examples" : "traces"}.{" "}
        <Link className="border-b border-ink-3 text-inherit no-underline hover:border-ink" to="/exceptions">
          {exceptionsTotal} {exceptionsTotal === 1 ? "is" : "are"} waiting on a person
        </Link>
        {legacyHumanChecked !== null ? (
          <>
            ; legacy human checks cover{" "}
            <Link
              className="border-b border-ink-3 text-inherit no-underline hover:border-ink"
              to={bench ? "/exceptions" : "/traces"}
            >
              {legacyHumanChecked.toLocaleString()} {legacyHumanChecked === 1 ? "case" : "cases"}
            </Link>
          </>
        ) : null}
        . The remaining Results rely only on the Check.
        {agreementPct != null ? (
          <>
            {" "}Its recorded agreement with the Golden set is{" "}
            <Link
              className="border-b border-ink-3 text-inherit no-underline hover:border-ink"
              to="/skill/versions"
            >
              {agreementPct}%
            </Link>
            .
          </>
        ) : null}
      </div>

      <KPIRow className="mb-7">
        <KPI
          label={bench ? "Examples" : "Traces imported"}
          num={importedTotal.toLocaleString()}
          delta={bench ? "supplied · no production traces" : project.traceProvider === "manual" ? "manual import" : `${project.traceProvider} · live`}
          deltaKind="up"
          foot={`as of ${new Date(project.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
          to={bench ? "/datasets" : "/traces"}
          src={bench ? "open examples →" : "open traces →"}
        />
        <KPI
          label="Legacy human checks"
          num={legacyHumanChecked === null ? "—" : legacyHumanChecked.toLocaleString()}
          delta={bench ? "ungoverned case reviews" : "ungoverned queues + adjudications"}
          foot="not governed human truth"
          to={bench ? "/exceptions" : "/review-queues"}
          src={bench ? "open exceptions →" : "open queues →"}
        />
        <KPI
          label="Exceptions"
          num={exceptionsTotal}
          delta={exceptionsTotal === 0 ? "queue clear" : "Waiting on a reviewer"}
          deltaKind={exceptionsTotal === 0 ? "default" : "signal"}
          foot="Humans next"
          to="/exceptions"
          src="open queue →"
        />
        {bench ? (
          <KPI
            label="Protected examples"
            num={goldenSetSize}
            delta={goldenSetSize === 0 ? "gate advisory only" : "gate armed"}
            deltaKind={goldenSetSize === 0 ? "signal" : "default"}
            foot="known cases used to catch evaluator regressions"
            to="/golden"
            src="open golden set →"
          />
        ) : project.traceProvider === "manual" ? (
          <KPI
            label="Sync-back"
            num="—"
            delta="no tracer connected"
            foot="connect one to write verdicts back"
            to="/integrations"
            src="open integrations →"
          />
        ) : (
          <KPI
            label="Sync-back"
            num={syncBackPct}
            unit="%"
            delta={syncBackPct === 100 ? "clean" : "partial"}
            deltaKind={syncBackPct === 100 ? "up" : "signal"}
            foot="Verdicts written back to trace platform"
            to="/integrations"
            src="open integrations →"
          />
        )}
      </KPIRow>

      <Card className="mb-7">
        <CardHeader>
          <div>
          <CardTitle>Result distribution</CardTitle>
            <CardDescription>
              The latest Check result for each recorded case. Earlier results and repeated
              runs are excluded.
            </CardDescription>
          </div>
          <div className="flex-1" />
          <Legend
            items={[
              { color: "var(--ink)", label: `Pass · ${totals.pass}` },
              { color: "var(--signal)", label: `Fail · ${totals.fail}` },
              { color: "var(--ambig-pattern)", label: `Ambiguous · ${totals.ambiguous}` }
            ]}
          />
        </CardHeader>
        <CardContent>
          <DistBar pass={totals.pass} fail={totals.fail} ambig={totals.ambiguous} />
          <div className="mt-3 font-mono text-[11px] text-ink-3">
            {totals.passPct}% pass · {totals.failPct}% fail · {totals.ambigPct}% ambiguous
          </div>
        </CardContent>
      </Card>

      <div className="mb-7 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Check categories</CardTitle>
              <CardDescription>
                Exact failure categories supplied by the Check. They filter cases; they do not imply similarity.
              </CardDescription>
            </div>
            <div className="flex-1" />
            <div className="font-mono text-[11px] text-ink-3">current run</div>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: 80 }}>Cases</th>
                <th>Queue volume</th>
              </tr>
            </thead>
            <tbody>
              {topCapabilityGaps.length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-center text-ink-3">
                    No judge categories yet. Categories appear when evaluator outputs include a
                    failure category; Coeval does not group cases by semantic similarity.
                  </td>
                </tr>
              ) : null}
              {topCapabilityGaps.map((gap) => (
                <tr
                  key={gap.id}
                  className="row-link"
                  onClick={() => navigate(`/exceptions?cluster=${encodeURIComponent(gap.name)}`)}
                >
                  <td>
                    <RowLink to={`/exceptions?cluster=${encodeURIComponent(gap.name)}`}>
                      {gap.name}
                    </RowLink>
                  </td>
                  <td className="font-mono">{gap.count}</td>
                  <td className="text-ink-3">{QUEUE_VOLUME[gap.severity]}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>{bench ? "Skill on the bench" : "Skill in production"}</CardTitle>
              <CardDescription>
                {bench ? "The artifact judging your examples." : "The artifact judging your traces."}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Eyebrow>name</Eyebrow>
                <div className="mt-0.5 font-serif text-[17px] font-medium tracking-[-0.015em]">{skill.name}</div>
              </div>
              {/* The VERSION's status, not the parent skill's — skills.status
                  stays "draft" forever while versions move through the gate,
                  which read as "production skill: draft" next to an approved
                  version. */}
              <Chip>v{skill.currentVersion.version} · {skill.currentVersion.status}</Chip>
            </div>
            <Separator />
            <div className="flex items-end justify-between">
              <div>
                <Eyebrow>Golden-set agreement</Eyebrow>
                <div className="mt-1 flex items-baseline gap-2">
                  <div className="font-serif text-[24px] font-medium tracking-[-0.025em]">
                    {agreementPct == null ? "—" : `${agreementPct}%`}
                  </div>
                  <div className="font-mono text-[12px] text-ink-3">{goldenSetSize} golden cases</div>
                </div>
              </div>
              <div className="dev-only">
                <Eyebrow tone="dev">Too strict / lenient</Eyebrow>
                <div className="mt-1 font-mono text-[12px] text-dev">
                  {skill.currentVersion.tooStrictCount} / {skill.currentVersion.tooLenientCount}
                </div>
              </div>
            </div>
            <Separator />
            <div className="flex flex-col gap-1.5 font-mono text-[11px] text-ink-3">
              <div>
                Model · <span className="text-ink">{skill.currentVersion.modelBinding.provider}/{skill.currentVersion.modelBinding.modelId}</span>
              </div>
              <div>
                Requested · <span className="text-ink">{skill.currentVersion.modelBinding.modelId}</span> · catalog identity {skill.currentVersion.modelBinding.modelVersion} · temp {skill.currentVersion.modelBinding.temperature}
              </div>
              <div>
                Owner · <span className="text-ink">{skill.ownerName}</span>
              </div>
            </div>
            {mode === "exec" ? (
              <Button variant="default" className="mt-2 self-start" onClick={() => navigate("/skill/versions")}>
                View versions <ArrowRight />
              </Button>
            ) : (
              <Button variant="default" className="mt-2 self-start" onClick={() => navigate("/skill")}>
                Open Check <ArrowRight />
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-7">
        <CardHeader>
          <div>
            <CardTitle>Exceptions waiting</CardTitle>
            <CardDescription>Cases the evaluator marked failed or ambiguous, or sent for human review.</CardDescription>
          </div>
          <div className="flex-1" />
          {exceptions.length > 0 ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate("/review", { state: { caseIds: exceptions.map((ex) => ex.id) } })}
            >
              Review all {exceptions.length} <ArrowRight />
            </Button>
          ) : null}
          <Button variant="default" size="sm" onClick={() => navigate("/exceptions")}>
            Open queue <ArrowRight />
          </Button>
        </CardHeader>
        <Table>
          <thead>
            <tr>
              <th style={{ width: 130 }}>When</th>
              <th>Case</th>
              <th style={{ width: 150 }}>Skill said</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {exceptions.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center text-ink-3">No exceptions right now. Failed or ambiguous judge runs will appear here.</td>
              </tr>
            ) : null}
            {exceptions.slice(0, 5).map((ex) => (
              <tr
                key={ex.id}
                className="row-link row-signal"
                onClick={() => navigate(`/cases/${ex.id}`, { state: { backTo: "/", backLabel: "Back to overview" } })}
              >
                <td className="font-mono text-ink-3">
                  {new Date(ex.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td>
                  <RowLink
                    to={`/cases/${ex.id}`}
                    state={{ backTo: "/", backLabel: "Back to overview" }}
                  >
                    {ex.title}
                  </RowLink>
                  <div className="mt-1 flex items-center gap-2">
                    {ex.capabilityGap ? (
                      <Ref
                        kind="category"
                        label={ex.capabilityGap}
                        onClick={() => navigate(`/exceptions?cluster=${encodeURIComponent(ex.capabilityGap as string)}`)}
                      />
                    ) : null}
                    <span className="dev-only font-mono text-[11px] tracking-[0.04em] text-ink-3">
                      {ex.traceId}
                    </span>
                  </div>
                </td>
                <td>
                  <VerdictChip verdict={ex.verdict} />
                </td>
                <td className="text-ink-3">{ex.reason}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="mt-2">
        <Button variant="default" size="sm" onClick={() => navigate("/integrations")}>
          <ChevronRight /> Manage integrations
        </Button>
      </div>
    </div>
  );
}
