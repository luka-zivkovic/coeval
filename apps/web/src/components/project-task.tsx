import { Activity, FlaskConical } from "lucide-react";
import { Eyebrow } from "@/components/coeval";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PROJECT_NAME_MAX_LENGTH, type ProjectMode } from "@coeval/shared";

// SINGLE source for first-run vocabulary. Three surfaces render this form
// (new-project modal, no-project landing, owner setup) — labels, placeholders,
// CTAs, and errors live here so a copy change cannot ship to two surfaces and
// miss the third.
export const PROJECT_TASK_COPY: Record<ProjectMode, { nameLabel: string; namePlaceholder: string; cta: string; busyCta: string }> = {
  bench: {
    nameLabel: "Project name",
    namePlaceholder: "e.g. Checkout support",
    cta: "Create project",
    busyCta: "Creating…"
  },
  tracing: {
    nameLabel: "Agent or workflow name",
    namePlaceholder: "e.g. Checkout Agent",
    cta: "Create project",
    busyCta: "Creating…"
  }
};

export const CHOOSE_TASK_ERROR = "Choose where your first recorded runs will come from.";
export const NAME_REQUIRED_ERROR = "Name the agent, workflow, dataset, or skill you are evaluating.";

export function ProjectTaskFork({
  mode,
  setMode
}: {
  mode: ProjectMode | null;
  setMode: (mode: ProjectMode) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>Where will your first runs come from?</Eyebrow>
      <div className="grid grid-cols-2 gap-2">
        <TaskCard
          active={mode === "tracing"}
          icon={<Activity className="size-3.5" />}
          title="Recorded production runs"
          detail="Connect LangSmith or Langfuse, or paste runs from an agent or workflow."
          onPick={() => setMode("tracing")}
        />
        <TaskCard
          active={mode === "bench"}
          icon={<FlaskConical className="size-3.5" />}
          title="Examples or an Agent Skill"
          detail="Supply input-and-output examples, or let your coding agent set up a Check for one Agent Skill."
          onPick={() => setMode("bench")}
        />
      </div>
      <div className="text-[11px] leading-[1.5] text-ink-3">
        Coeval reads recorded Runs; it does not execute your AI. You can connect another source later
        without losing Checks or Results.
      </div>
    </div>
  );
}

function TaskCard({
  active,
  icon,
  title,
  detail,
  onPick
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-sm border px-3 py-2.5 text-left",
        active ? "border-ink bg-card" : "border-rule-soft bg-paper-2 hover:bg-paper-3"
      )}
    >
      <span className={cn("inline-flex items-center gap-1.5 text-[12.5px] font-medium", active ? "text-ink" : "text-ink-2")}>
        {icon} {title}
      </span>
      <span className="text-[11px] leading-[1.5] text-ink-3">{detail}</span>
    </button>
  );
}

export function ProjectTaskNextSteps({ mode }: { mode: ProjectMode }) {
  return (
    <div className="rounded-sm border border-rule-soft bg-paper-2 px-3 py-2.5 text-[11.5px] leading-[1.55] text-ink-2">
      {mode === "bench" ? (
        <>
          <b>What happens next:</b> Add one example Run, choose one thing to Check, and see the first
          Result. Expected labels are optional during setup.
        </>
      ) : (
        <>
          <b>What happens next:</b> Connect or paste one recorded Run, choose one thing to Check, and
          see what the starter Check concludes. Its Results remain unvalidated after setup.
        </>
      )}
    </div>
  );
}

// The full mode-gated block every creation surface renders: task fork, then —
// once a task is chosen — the name field and next-steps. Enter-to-submit is
// opt-in (the owner-setup form already submits on Enter natively).
export function ProjectTaskFields({
  mode,
  setMode,
  name,
  setName,
  onEnter
}: {
  mode: ProjectMode | null;
  setMode: (mode: ProjectMode) => void;
  name: string;
  setName: (name: string) => void;
  onEnter?: () => void;
}) {
  return (
    <>
      <ProjectTaskFork mode={mode} setMode={setMode} />
      {mode ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Eyebrow>{PROJECT_TASK_COPY[mode].nameLabel}</Eyebrow>
            <Input
              autoFocus
              data-dialog-initial-focus
              maxLength={PROJECT_NAME_MAX_LENGTH}
              placeholder={PROJECT_TASK_COPY[mode].namePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onEnter ? (e) => {
                if (e.key === "Enter") onEnter();
              } : undefined}
            />
          </div>
          <ProjectTaskNextSteps mode={mode} />
        </>
      ) : null}
    </>
  );
}
