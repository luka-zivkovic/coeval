import * as React from "react";
import { cn } from "@/lib/utils";

// A reviewer's decision on a case, rendered as a small uppercase mono mark.
// Resolved exception rows keep their decision on the record instead of vanishing.
export type DecisionKind = "accept" | "override" | "promote" | "skip" | "adjudicated";

const DECISION_LABEL: Record<DecisionKind, string> = {
  accept:      "Accepted",
  override:    "Overridden",
  promote:     "★ Promoted",
  skip:        "Skipped",
  adjudicated: "Adjudicated"
};

const DECISION_COLOR: Record<DecisionKind, string> = {
  accept:      "text-ink-3",
  override:    "text-signal",
  promote:     "text-gold",
  skip:        "text-ink-4",
  adjudicated: "text-dev"
};

export function Decision({
  kind,
  children,
  className
}: {
  kind: DecisionKind;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em]",
        DECISION_COLOR[kind],
        className
      )}
    >
      {children ?? DECISION_LABEL[kind]}
    </span>
  );
}

export { DECISION_LABEL };
