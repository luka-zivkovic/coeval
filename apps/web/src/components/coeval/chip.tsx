import * as React from "react";
import { isVerdictLabel, type VerdictLabel } from "@coeval/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";

const verdictMap: Record<VerdictLabel, { variant: BadgeProps["variant"]; label: string }> = {
  pass:      { variant: "pass",  label: "Pass" },
  fail:      { variant: "fail",  label: "Fail" },
  ambiguous: { variant: "ambig", label: "Ambiguous" }
};

export function VerdictChip({ verdict, className }: { verdict: VerdictLabel; className?: string }) {
  const entry = verdictMap[verdict];
  return <Badge variant={entry.variant} className={className}>{entry.label}</Badge>;
}

// Any label string: canonical labels render as the chip, anything else
// (custom categorical choices, null) as plain mono text. Single-sourced on
// shared's isVerdictLabel — screens kept growing private copies of the
// canonical set that drift when the label universe changes.
export function LabelChip({ label }: { label: string | null }) {
  if (label === null) return <span className="font-mono text-[11px] text-ink-4">not judged</span>;
  if (isVerdictLabel(label)) return <VerdictChip verdict={label} />;
  return <span className="font-mono text-[11px] text-ink-2">{label}</span>;
}

export { Badge as Chip };
