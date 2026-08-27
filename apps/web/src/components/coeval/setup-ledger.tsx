import * as React from "react";
import { Check } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Onboarding checklist that persists on the Overview until completed.
export type LedgerStepState = "done" | "now" | "locked";

export interface LedgerStep {
  state: LedgerStepState;
  title: React.ReactNode;
  detail?: React.ReactNode;
  cta?: React.ReactNode;
  onCta?: () => void;
  foot?: React.ReactNode;
}

export function SetupLedger({
  steps,
  className,
  title = "Set up your evaluator",
  description
}: {
  steps: LedgerStep[];
  className?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
}) {
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <Card className={className}>
      <CardHeader className="flex-col items-stretch gap-0.5">
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description ?? `${done} of ${steps.length} complete`}
        </CardDescription>
      </CardHeader>
      <div>
        {steps.map((s, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-3.5 border-b border-rule-soft px-[18px] py-3.5 last:border-b-0",
              s.state === "locked" && "opacity-90"
            )}
          >
            <div
              className={cn(
                "mt-px grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-rule-strong font-mono text-[10.5px] text-ink-3",
                s.state === "done" && "border-ink bg-ink text-paper",
                s.state === "now" && "border-ink text-ink"
              )}
            >
              {s.state === "done" ? <Check className="h-[11px] w-[11px]" /> : i + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  "text-[13.5px] font-medium",
                  s.state === "done" && "text-ink-4 line-through decoration-rule-strong"
                )}
              >
                {s.title}
              </div>
              {s.detail ? <div className="mt-px text-[12px] text-ink-3">{s.detail}</div> : null}
            </div>
            {s.cta ? (
              <Button size="sm" variant={s.state === "now" ? "primary" : "default"} onClick={s.onCta}>
                {s.cta}
              </Button>
            ) : null}
            {s.foot ? <div className="self-center font-mono text-[11px] text-ink-4">{s.foot}</div> : null}
          </div>
        ))}
      </div>
    </Card>
  );
}
