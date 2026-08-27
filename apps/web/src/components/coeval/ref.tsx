import * as React from "react";
import { Flag, Star, GitCompareArrows, FileText, Inbox, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

// P1-1 · Ref — a human-readable reference chip. Names, not IDs.
// The raw ID demotes to Technical display (.dev-only).
export type RefKind = "category" | "cluster" | "golden" | "version" | "case" | "queue" | "source";

const REF_ICON: Record<RefKind, React.ComponentType<{ className?: string }>> = {
  category: Flag,
  // Retained for older call sites/links; new evaluator failure-category UI
  // should use `category` because semantic clustering is deliberately absent.
  cluster: Flag,
  golden:  Star,
  version: GitCompareArrows,
  case:    FileText,
  queue:   Inbox,
  source:  ExternalLink
};

export interface RefProps {
  kind: RefKind;
  label: React.ReactNode;
  id?: string;
  onClick?: () => void;
  mono?: boolean;
  className?: string;
}

export function Ref({ kind, label, id, onClick, mono, className }: RefProps) {
  const Icon = REF_ICON[kind] ?? FileText;
  const content = (
    <>
      <span className="ref-gly grid shrink-0 place-items-center text-ink-4">
        <Icon className="h-2.5 w-2.5" />
      </span>
      <span className={cn("truncate", mono && "font-mono")}>{label}</span>
      {id ? <span className="dev-only font-mono text-[9.5px] text-ink-4">{id}</span> : null}
    </>
  );
  const classes = cn(
    "inline-flex max-w-full items-center gap-[5px] rounded-sm border border-rule-soft bg-card-2 px-[7px] py-[2px] text-[11.5px] text-ink-2",
    onClick &&
      "min-h-6 cursor-pointer hover:border-rule-strong hover:bg-paper hover:text-ink [&:hover>.ref-gly]:text-ink-2",
    className
  );

  return onClick ? (
    <button
      type="button"
      className={classes}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {content}
    </button>
  ) : (
    <span
      className={classes}
    >
      {content}
    </span>
  );
}
