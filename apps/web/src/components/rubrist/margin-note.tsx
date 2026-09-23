import * as React from "react";
import { cn } from "@/lib/utils";

export interface MarginNoteProps extends React.HTMLAttributes<HTMLDivElement> {
  who?: React.ReactNode;
  tone?: "signal" | "dev" | "neutral";
}

export function MarginNote({ who, tone = "signal", className, children, ...props }: MarginNoteProps) {
  return (
    <div
      className={cn(
        "border-l-2 px-3 py-1.5 text-[12px] text-ink-2",
        tone === "signal" && "border-signal bg-signal-wash",
        tone === "dev" && "border-dev bg-dev-tint",
        tone === "neutral" && "border-ink-3 bg-card-2",
        className
      )}
      {...props}
    >
      {who ? (
        <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">{who}</div>
      ) : null}
      {children}
    </div>
  );
}
