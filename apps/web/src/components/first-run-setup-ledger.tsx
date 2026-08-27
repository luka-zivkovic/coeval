import { useNavigate } from "react-router-dom";
import { SetupLedger } from "@/components/coeval";
import { firstResultPath, firstRunEditorPath, firstRunSetupStepStates, isBench } from "@/lib/journey";
import type { DashboardSummary } from "@coeval/shared";

export function FirstRunSetupLedger({
  dashboard,
  className
}: {
  dashboard: DashboardSummary;
  className?: string;
}) {
  const navigate = useNavigate();
  const { project, skill } = dashboard;
  const bench = isBench(project);
  const states = firstRunSetupStepStates(dashboard);
  const done = Object.values(states).filter((state) => state === "done").length;
  const imported = project.importedTraceCount;
  const judged = dashboard.currentVersionResultCount;
  const editPath = skill.isStarter ? firstRunEditorPath() : "/skill/edit";

  return (
    <SetupLedger
      {...(className ? { className } : {})}
      title="Get your first result"
      description={done === 3 ? "3 of 3 complete · first result ready" : `${done} of 3 complete · based on saved project state`}
      steps={[
        {
          state: states.bringRun,
          title: bench ? "Bring one example run" : "Bring one recorded run",
          ...(states.bringRun === "done"
            ? { foot: `${imported.toLocaleString()} ${bench ? "example" : "run"}${imported === 1 ? "" : "s"}` }
            : {
                detail: bench
                  ? "A run is one input and the output your AI produced. An expected result is optional."
                  : "Connect LangSmith or Langfuse, or paste one run. Coeval reads the record; it does not replay your AI.",
                cta: bench ? "Add an example" : "Add a recorded run",
                onCta: () => navigate(bench ? "/datasets?add=1" : "/traces"),
                secondaryCta: "Set up without a run",
                onSecondaryCta: () => navigate(editPath)
              })
        },
        {
          state: states.chooseCheck,
          title: "Choose one thing to Check",
          ...(states.chooseCheck === "done"
            ? { foot: `Check v${skill.currentVersion.version} ready` }
            : {
                detail: "Tell Coeval one quality that matters. Technical settings stay out of the first-run path.",
                ...(states.chooseCheck === "now"
                  ? { cta: "Review the Check", onCta: () => navigate(editPath) }
                  : {})
              })
        },
        {
          state: states.seeResult,
          title: "See the first Result",
          ...(states.seeResult === "done"
            ? { foot: `${judged.toLocaleString()} result${judged === 1 ? "" : "s"}` }
            : {
                detail: "Coeval applies the Check to recorded evidence. This is the Check's opinion until a person reviews it separately.",
                ...(states.seeResult === "now"
                  ? {
                      cta: "Continue to first Result",
                      onCta: () => navigate(firstResultPath(skill.currentVersion.id))
                    }
                  : {})
              })
        }
      ]}
    />
  );
}
