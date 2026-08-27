import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip, Eyebrow } from "@/components/coeval";
import { knownFailureGateSummary, sameModelBinding } from "../lib/skill-edit-flow.js";
import { cn } from "@/lib/utils";
import {
  type SkillVersion,
  type SkillVersionTimeScope,
  type VerdictKind
} from "@coeval/shared";

export type SkillEditPhase = "edit" | "creating" | "running" | "result";
export type SkillEditOutcome = "passed" | "blocked" | "overridden" | "error";

type StepState = "done" | "current" | "upcoming";

function stepStates(phase: SkillEditPhase): readonly StepState[] {
  if (phase === "edit") return ["current", "upcoming", "upcoming", "upcoming"];
  if (phase === "creating") return ["done", "current", "upcoming", "upcoming"];
  if (phase === "running") return ["done", "done", "current", "upcoming"];
  return ["done", "done", "done", "current"];
}

const OUTCOME_LABEL: Record<SkillEditOutcome, string> = {
  passed: "Passed",
  blocked: "Review required",
  overridden: "Override recorded",
  error: "Check failed"
};

export function SkillEditFlow({
  phase,
  baseVersion,
  createdVersion,
  referenceCount,
  outcome,
  className
}: {
  phase: SkillEditPhase;
  baseVersion: string;
  createdVersion?: string | undefined;
  referenceCount?: number | null | undefined;
  outcome?: SkillEditOutcome | undefined;
  className?: string | undefined;
}) {
  const states = stepStates(phase);
  const currentStepRef = useRef<HTMLSpanElement | null>(null);
  const steps = [
    { label: "Review changes", detail: `From v${baseVersion}` },
    { label: "Create version", detail: createdVersion ? `v${createdVersion} recorded` : "Immutable on save" },
    {
      label: "Check references",
      detail: referenceCount == null
        ? "Pinned revision"
        : `${referenceCount} case${referenceCount === 1 ? "" : "s"}`
    },
    { label: "Outcome", detail: outcome ? OUTCOME_LABEL[outcome] : "Passed or review required" }
  ] as const;
  const currentIndex = states.findIndex((state) => state === "current");
  const announcement = `${steps[currentIndex]?.label ?? "Evaluator edit"}: ${steps[currentIndex]?.detail ?? "in progress"}`;

  useEffect(() => {
    if (phase !== "edit") currentStepRef.current?.focus();
  }, [phase]);

  return (
    <section
      aria-label="Evaluator edit progress"
      title={referenceCount == null ? undefined : knownFailureGateSummary(referenceCount)}
      className={cn("relative z-20 mb-5 rounded-sm border border-rule-soft bg-paper/95 px-3 py-3 shadow-sm backdrop-blur sm:sticky sm:top-0", className)}
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {steps.map((step, index) => {
          const state = states[index]!;
          return (
            <div
              key={step.label}
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-start gap-2 rounded-sm border px-2.5 py-2",
                state === "current" && "border-ink bg-card-2",
                state === "done" && "border-rule-soft bg-paper-3",
                state === "upcoming" && "border-transparent text-ink-3"
              )}
            >
              <span className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[10px]",
                state === "current" ? "border-ink bg-ink text-paper" : "border-rule-strong"
              )}>
                {state === "done" ? <Check className="size-3" /> : index + 1}
              </span>
              <span
                ref={state === "current" ? currentStepRef : undefined}
                tabIndex={state === "current" && phase !== "edit" ? -1 : undefined}
                className="min-w-0 outline-none"
              >
                <span className="block text-[11.5px] font-medium text-ink">{step.label}</span>
                <span className="block truncate text-[10.5px] text-ink-3">{step.detail}</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const TIME_SCOPE_COPY: Record<SkillVersionTimeScope, string> = {
  new: "Future traces only",
  existing: "Re-judge existing traces",
  both: "Future and existing traces"
};

function lineCount(value: string): number {
  return value.replace(/\r\n?/g, "\n").split("\n").length;
}

function SourceComparison({
  label,
  version,
  before,
  after
}: {
  label: string;
  version: string;
  before: string;
  after: string;
}) {
  return (
    <div className="border-t border-rule-soft pt-3">
      <Eyebrow>{label} · exact source</Eyebrow>
      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <div>
          <div className="mb-1 font-mono text-[10.5px] text-ink-3">v{version}</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-rule-soft bg-paper-3 p-3 font-mono text-[11px] leading-5 text-ink-2">{before}</pre>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10.5px] text-ink-3">New version</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-rule-soft bg-card-2 p-3 font-mono text-[11px] leading-5 text-ink-2">{after}</pre>
        </div>
      </div>
    </div>
  );
}

export function SkillChangeReview({
  base,
  rubricMarkdown,
  prompt,
  modelBinding,
  verdictKind,
  timeScope
}: {
  base: SkillVersion;
  rubricMarkdown: string;
  prompt: string;
  modelBinding: SkillVersion["modelBinding"];
  verdictKind: VerdictKind;
  timeScope: SkillVersionTimeScope;
}) {
  const rubricChanged = rubricMarkdown !== base.rubricMarkdown;
  const promptChanged = prompt !== base.prompt;
  const bindingChanged = !sameModelBinding(modelBinding, base.modelBinding);
  const verdictChanged = verdictKind !== base.verdictKind;
  const changedCount = [rubricChanged, promptChanged, bindingChanged, verdictChanged].filter(Boolean).length;

  return (
    <Card className="mb-5">
      <CardHeader>
        <div>
          <CardTitle>Review changes from v{base.version}</CardTitle>
          <CardDescription>
            Saving never overwrites v{base.version}. It creates a new immutable version, pins the
            current known-failure revision, and records the terminal check outcome in Version history.
          </CardDescription>
        </div>
        <Chip variant={changedCount > 0 ? "default" : "outline"}>
          {changedCount} evaluator field{changedCount === 1 ? "" : "s"} changed
        </Chip>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-2 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
            <div className="text-ink-3">Review guide</div>
            <div className="mt-0.5 font-medium text-ink">{rubricChanged ? "Changed" : "No change"}</div>
            <div className="text-[10.5px] text-ink-3">{lineCount(base.rubricMarkdown)} → {lineCount(rubricMarkdown)} lines</div>
          </div>
          <div className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
            <div className="text-ink-3">Judge instructions</div>
            <div className="mt-0.5 font-medium text-ink">{promptChanged ? "Changed" : "No change"}</div>
            <div className="text-[10.5px] text-ink-3">exact prompt source</div>
          </div>
          <div className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
            <div className="text-ink-3">Requested model</div>
            <div className="mt-0.5 font-medium text-ink">{bindingChanged ? "Changed" : "No change"}</div>
            <div className="truncate font-mono text-[10.5px] text-ink-3">{base.modelBinding.modelId} → {modelBinding.modelId}</div>
          </div>
          <div className="rounded-sm border border-rule-soft bg-paper-3 px-3 py-2">
            <div className="text-ink-3">Result / apply scope</div>
            <div className="mt-0.5 font-medium text-ink">{verdictChanged ? `${base.verdictKind} → ${verdictKind}` : verdictKind}</div>
            <div className="text-[10.5px] text-ink-3">{TIME_SCOPE_COPY[timeScope]}</div>
          </div>
        </div>

        {rubricChanged || promptChanged ? (
          <details className="rounded-sm border border-rule-soft bg-card-2 px-3 py-2">
            <summary className="cursor-pointer text-[12px] font-medium text-ink">View exact source comparison</summary>
            <div className="mt-3 flex flex-col gap-4">
              {rubricChanged ? (
                <SourceComparison label="Review guide" version={base.version} before={base.rubricMarkdown} after={rubricMarkdown} />
              ) : null}
              {promptChanged ? (
                <SourceComparison label="Judge instructions" version={base.version} before={base.prompt} after={prompt} />
              ) : null}
            </div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
