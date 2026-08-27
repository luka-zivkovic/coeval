import { useNavigate } from "react-router-dom";
import { SetupLedger } from "@/components/coeval";
import { benchSetupStepStates } from "@/lib/journey";
import { GOLDEN_GATE_RECOMMENDED, type DashboardSummary } from "@coeval/shared";

export function BenchSetupLedger({
  dashboard,
  className
}: {
  dashboard: DashboardSummary;
  className?: string;
}) {
  const navigate = useNavigate();
  const { project, skill, goldenSetSize } = dashboard;
  const judged = project.autoJudgedTraceCount;
  const states = benchSetupStepStates(dashboard);

  return (
    <SetupLedger
      {...(className ? { className } : {})}
      description={`${Object.values(states).filter((state) => state === "done").length} of 4 complete · based on saved project state`}
      steps={[
        {
          state: states.defineSkill,
          title: "Define your skill",
          ...(states.defineSkill === "done"
            ? { foot: `v${skill.currentVersion.version} ready` }
            : {
                detail: "Add your review guide and prompt, or start from a template. The evaluator must return a structured verdict.",
                cta: "Open the editor",
                onCta: () => navigate("/skill/edit")
              })
        },
        {
          state: states.addExamples,
          title: "Add example cases",
          ...(states.addExamples === "done"
            ? { foot: `${project.importedTraceCount} added` }
            : {
                detail: "Add a few input and output pairs with the result you expect. Uploading saves them; evaluation starts only when you run the set.",
                ...(states.addExamples === "now"
                  ? { cta: "Add examples", onCta: () => navigate("/datasets") }
                  : {})
              })
        },
        {
          state: states.runSkill,
          title: "Run the skill over them",
          ...(states.runSkill === "done"
            ? { foot: `${judged} judged` }
            : {
                detail: "One explicit run; every verdict carries the skill's own reasoning. Agreement is counted only against your labels.",
                ...(states.runSkill === "now"
                  ? { cta: "Run examples", onCta: () => navigate("/datasets") }
                  : {})
              })
        },
        {
          state: states.enableRegression,
          title: "Promote a golden case from the disagreements",
          ...(states.enableRegression === "done"
            ? {
                foot: `${goldenSetSize} active · ${Math.min(goldenSetSize, GOLDEN_GATE_RECOMMENDED)}/${GOLDEN_GATE_RECOMMENDED} recommended`
              }
            : {
                detail: `The first reviewed case enables regression checks; ${GOLDEN_GATE_RECOMMENDED} is the recommended starting set.`,
                ...(states.enableRegression === "now"
                  ? {
                      cta: dashboard.exceptions.length > 0 ? "Review disagreements" : "Open golden set",
                      onCta: () => navigate(dashboard.exceptions.length > 0 ? "/exceptions" : "/golden")
                    }
                  : {})
              })
        }
      ]}
    />
  );
}
