import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { BenchSetupLedger } from "@/components/bench-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import { FirstVerdictCard } from "@/components/first-verdict";
import { SectionHead, KPI, KPIRow, SetupLedger, ProvBanner } from "@/components/coeval";
import { signOffSkillVersion, ApiError } from "@/lib/api";
import { isBench, markSetupReceipt } from "@/lib/journey";
import {
  GOLDEN_GATE_ARMS_AT,
  GOLDEN_GATE_RECOMMENDED,
  type DashboardSummary
} from "@coeval/shared";

interface DashboardProvisionalProps {
  dashboard: DashboardSummary;
  onSignedOff: () => void;
}

// Overview · first import — traces are in, but the current skill version is
// the never-approved starter draft. Every verdict is provisional until the
// rubric is reviewed (gate run) or signed off as-is (explicit approval).
export function DashboardProvisional({ dashboard, onSignedOff }: DashboardProvisionalProps) {
  const navigate = useNavigate();
  const [signingOff, setSigningOff] = useState(false);
  const [signOffError, setSignOffError] = useState<string | null>(null);

  const { project, skill, exceptions, goldenSetSize } = dashboard;
  const bench = isBench(project);
  const imported = project.importedTraceCount;
  const judged = project.autoJudgedTraceCount;
  const version = skill.currentVersion;

  async function signOffAsIs() {
    setSigningOff(true);
    setSignOffError(null);
    try {
      await signOffSkillVersion(skill.id, version.id);
      markSetupReceipt(
        `Rubric v${version.version} signed off — the dashed badges are gone, verdicts count now.`
      );
      onSignedOff();
    } catch (error) {
      setSignOffError(
        error instanceof ApiError && error.status === 403
          ? "Only owners can sign off the rubric."
          : error instanceof Error
            ? error.message
            : "Sign-off failed."
      );
    } finally {
      setSigningOff(false);
    }
  }

  return (
    <div className="fadeUp max-w-[1760px]">
      <FirstProjectKeyCard project={project} className="mb-5" />
      <div className="mb-4">
        <ProvBanner
          text={
            bench ? (
              <span>
                {imported.toLocaleString()} example{imported === 1 ? "" : "s"} on the bench. Nothing is
                evaluated until you start a run, and results remain <b>provisional</b> until an owner
                reviews and approves the guide.
              </span>
            ) : (
              <span>
                The starter rubric judged {judged === imported ? "all" : judged.toLocaleString()} of your{" "}
                {imported.toLocaleString()} traces. These verdicts are <b>provisional</b>. Review the guide
                before asking an owner to approve the evaluator.
              </span>
            )
          }
          cta2={
            <Button size="sm" variant="ghost" disabled={signingOff} onClick={() => void signOffAsIs()}>
              {signingOff ? "Signing off…" : "Sign off as-is"}
            </Button>
          }
          cta={
            <Button size="sm" onClick={() => navigate("/skill/edit")}>
              Review the rubric
            </Button>
          }
        />
        {signOffError ? (
          <div className="mt-2 font-mono text-[11px] text-signal">{signOffError}</div>
        ) : null}
      </div>

      <SectionHead
        eyebrow={bench ? "First examples · Skill Bench" : `First import · ${project.traceProvider}`}
        title={
          bench
            ? `${imported.toLocaleString()} example${imported === 1 ? "" : "s"} in. Run the skill over them.`
            : `${imported.toLocaleString()} traces in. Here's what the judge thinks.`
        }
        sub={
          exceptions.length > 0
            ? `${exceptions.length} cases need human review. Open a few to see where the starter guide needs to change.`
            : bench
              ? "Nothing has been evaluated yet. Start a run from Examples. Agreement is calculated only for the examples that include an expected label."
              : "The starter evaluator passed every imported trace, but the results are still provisional. Review the guide against those traces next."
        }
      />

      <FirstVerdictCard
        dashboard={dashboard}
        onOpenCase={(caseId) => navigate(`/cases/${caseId}`, { state: { backTo: "/", backLabel: "Back to overview" } })}
        className="mb-5"
      />

      <KPIRow className="mb-5">
        <KPI
          label={bench ? "Examples" : "Imported"}
          num={imported.toLocaleString()}
          foot={bench ? "supplied · no production traces" : `${project.traceProvider} · first poll`}
        />
        <KPI
          label="Judged · provisional"
          num={judged.toLocaleString()}
          foot={`starter rubric v${version.version}`}
        />
        <KPI
          label="Want a human look"
          num={exceptions.length}
          delta={exceptions.length > 0 ? "open the queue →" : "queue clear"}
          deltaKind={exceptions.length > 0 ? "signal" : "default"}
          to="/exceptions"
          src="open exceptions →"
        />
        <KPI
          label="Golden cases"
          num={goldenSetSize}
          foot={
            goldenSetSize === 0
              ? "promote a case to arm the gate"
              : goldenSetSize >= GOLDEN_GATE_RECOMMENDED
                ? "gate armed"
                : `gate armed · aim for ${GOLDEN_GATE_RECOMMENDED}+`
          }
          to="/golden"
          src="open golden set →"
        />
      </KPIRow>

      <div className="max-w-[960px]">
        {bench ? (
          <BenchSetupLedger dashboard={dashboard} />
        ) : (
          <SetupLedger
            steps={[
              {
                state: "done",
                title: "Connect a trace source",
                foot: project.traceProvider
              },
              {
                state: "done",
                title: "Import your first traces",
                foot: `${imported.toLocaleString()} traces`
              },
              {
                state: "now",
                title: "Review the starter rubric",
                detail:
                  exceptions.length > 0
                    ? `Open it next to the ${exceptions.length} flagged cases and edit what reads wrong.`
                    : "Edit it against the traces that just arrived.",
                cta: "Review rubric",
                onCta: () => navigate("/skill/edit")
              },
              {
                state: goldenSetSize >= GOLDEN_GATE_ARMS_AT ? "done" : "locked",
                title: "Enable regression checks with a golden case",
                detail: "You'll do this naturally while reviewing exceptions.",
                ...(goldenSetSize >= GOLDEN_GATE_ARMS_AT
                  ? {
                      foot: `${goldenSetSize} active · ${Math.min(goldenSetSize, GOLDEN_GATE_RECOMMENDED)}/${GOLDEN_GATE_RECOMMENDED} recommended`
                    }
                  : { cta: "Open exceptions", onCta: () => navigate("/exceptions") })
              }
            ]}
          />
        )}
      </div>
    </div>
  );
}
