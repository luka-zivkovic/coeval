import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// A session / setup receipt strip — what just happened, on the record.
export interface ReceiptProps {
  children: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

export function Receipt({ children, meta, actions, icon, className }: ReceiptProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3.5 border border-rule border-l-2 border-l-ink bg-card px-4 py-[11px] text-[12.5px]",
        className
      )}
    >
      {icon ?? <Check className="h-[13px] w-[13px] shrink-0" />}
      <span className="flex-1">{children}</span>
      {meta ? <span className="font-mono text-[10.5px] text-ink-3">{meta}</span> : null}
      {actions}
    </div>
  );
}
