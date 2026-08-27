import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FirstRunSetupLedger } from "@/components/first-run-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import { FirstVerdictCard } from "@/components/first-verdict";
import { SectionHead, KPI, KPIRow, ProvBanner } from "@/components/coeval";
import { signOffSkillVersion, ApiError } from "@/lib/api";
import { isBench, markSetupReceipt } from "@/lib/journey";
import type { DashboardSummary } from "@coeval/shared";

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

  const { project, skill, exceptions } = dashboard;
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
        `Check v${version.version} signed off. It is ready to use, but it has not been calibrated against governed human truth.`
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
                reviews and signs off the guide.
              </span>
            ) : (
              <span>
                The starter Check evaluated {judged === imported ? "all" : judged.toLocaleString()} of your{" "}
                {imported.toLocaleString()} runs. These Results are <b>provisional</b>. Review the guide
                before asking an owner to sign it off.
              </span>
            )
          }
          cta2={
            <Button size="sm" variant="ghost" disabled={signingOff} onClick={() => void signOffAsIs()}>
              {signingOff ? "Signing off…" : "Use this starter Check"}
            </Button>
          }
          cta={
            <Button size="sm" onClick={() => navigate("/skill/edit")}>
              Review the Check
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
            ? `${imported.toLocaleString()} example${imported === 1 ? "" : "s"} ready. Run your Check.`
            : `${imported.toLocaleString()} run${imported === 1 ? "" : "s"} imported. Here is what the starter Check found.`
        }
        sub={
          exceptions.length > 0
            ? `${exceptions.length} Result${exceptions.length === 1 ? " needs" : "s need"} a closer look. Open one to compare the recorded evidence with the starter guide.`
            : bench
              ? "Nothing has been evaluated yet. Start one run from Examples. A supplied expected label is optional and is not governed human truth."
              : "The starter Check did not flag these imported runs, but its Results are still provisional. Review the guide against the recorded evidence next."
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
          label="Results · provisional"
          num={judged.toLocaleString()}
          foot={`starter Check v${version.version}`}
        />
        <KPI
          label="Need a closer look"
          num={exceptions.length}
          delta={exceptions.length > 0 ? "open the queue →" : "queue clear"}
          deltaKind={exceptions.length > 0 ? "signal" : "default"}
          to="/exceptions"
          src="open exceptions →"
        />
      </KPIRow>

      <div className="max-w-[960px]">
        <FirstRunSetupLedger dashboard={dashboard} />
      </div>
    </div>
  );
}
