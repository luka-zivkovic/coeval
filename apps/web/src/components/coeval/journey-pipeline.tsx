import { Check } from "lucide-react";
import { GOLDEN_GATE_RECOMMENDED, type DashboardSummary } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { firstRunEditorPath, journeyActStates, isBench, type JourneyActState } from "@/lib/journey";
import { cn } from "@/lib/utils";

export function JourneyPipeline({
  dashboard,
  onNavigate,
  className
}: {
  dashboard: DashboardSummary;
  onNavigate: (path: string) => void;
  className?: string;
}) {
  const states = journeyActStates(dashboard);
  const bench = isBench(dashboard.project);
  const judged = dashboard.currentVersionResultCount;
  const golden = dashboard.goldenSetSize;
  const steps: Array<{
    state: JourneyActState;
    act: string;
    title: string;
    detail: string;
    action: string;
    path: string;
  }> = [
    {
      state: states.defineGood,
      act: "Act 1",
      title: "Choose what to Check",
      detail: dashboard.skill.isStarter
        ? "Review the starter Check against a recorded Run."
        : `v${dashboard.skill.currentVersion.version} · ${dashboard.skill.currentVersion.status}`,
      action: "Review Check",
      // A still-starter skill routes through the first-run editor (onboarding
      // framing + worked starter); anything else opens the plain editor.
      path: dashboard.skill.isStarter ? firstRunEditorPath() : "/skill/edit"
    },
    {
      state: states.judgeRealWork,
      act: "Act 2",
      title: "See Results on real Runs",
      detail: judged > 0
        ? `${judged.toLocaleString()} recorded ${bench ? "example" : "Run"}${judged === 1 ? "" : "s"} checked · ungoverned triage`
        : `Add the first ${bench ? "example and run it" : "recorded Run or live source"}.`,
      action: bench ? "Open examples" : "Open traces",
      path: bench ? "/datasets" : "/traces"
    },
    {
      state: states.earnTrust,
      act: "Act 3",
      title: "Protect reviewed examples",
      detail: golden >= GOLDEN_GATE_RECOMMENDED
        ? `${golden} protected examples · recommended starting set reached`
        : `${golden}/${GOLDEN_GATE_RECOMMENDED} protected examples · regression check ${golden > 0 ? "active" : "empty"}`,
      action: dashboard.exceptions.length > 0 ? "Review Results" : "Open protected examples",
      path: dashboard.exceptions.length > 0 ? "/exceptions" : "/golden"
    }
  ];

  return (
    <div className={cn("mb-7", className)}>
      <div className="grid grid-cols-3 overflow-hidden rounded-sm border border-rule bg-card">
        {steps.map((step, index) => (
          <div
            key={step.act}
            className={cn(
              "relative flex min-h-[118px] flex-col border-r border-rule-soft px-4 py-3 last:border-r-0",
              step.state === "now" && "bg-signal-wash",
              step.state === "next" && "opacity-90"
            )}
          >
            {index < steps.length - 1 ? (
              <span className="absolute -right-[5px] top-[26px] z-10 size-2 rotate-45 border-r border-t border-rule bg-card" />
            ) : null}
            <div className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-4">
              {step.state === "done" ? <Check className="size-3" /> : <span>{index + 1}</span>}
              <span>{step.act}</span>
              {step.state === "now" ? <span className="ml-auto text-signal">next action</span> : null}
            </div>
            <div className="mt-1 text-[13.5px] font-medium text-ink">{step.title}</div>
            <div className="mt-1 text-[11px] leading-[1.45] text-ink-3">{step.detail}</div>
            {step.state === "now" ? (
              <Button className="mt-auto self-start" size="sm" variant="outline" onClick={() => onNavigate(step.path)}>
                {step.action}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-2 max-w-[80ch] text-[11px] leading-[1.5] text-ink-3">
        Operational setup only. Governed analysis and human truth are tracked separately in their
        own evidence workflows.
      </p>
    </div>
  );
}
