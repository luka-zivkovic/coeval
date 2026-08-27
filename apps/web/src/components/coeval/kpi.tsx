import * as React from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export interface KPIProps {
  label: string;
  num: React.ReactNode;
  unit?: string;
  delta?: React.ReactNode;
  deltaKind?: "up" | "signal" | "default";
  foot?: React.ReactNode;
  /** Every linked dashboard number opens its source. */
  to?: string;
  /** Source hint shown under the number, e.g. "open traces →". */
  src?: React.ReactNode;
}

export function KPI({ label, num, unit, delta, deltaKind = "default", foot, to, src }: KPIProps) {
  const content = (
    <>
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">{label}</div>
      <div className="mt-2 font-serif text-[28px] font-medium leading-none tracking-[-0.025em] tabular-nums">
        {num}
        {unit ? (
          <span className="ml-1 font-mono text-[14px] text-ink-3 tracking-normal">{unit}</span>
        ) : null}
      </div>
      {delta ? (
        <div
          className={cn(
            "mt-2 font-mono text-[11px]",
            deltaKind === "up" && "text-ink",
            deltaKind === "signal" && "text-signal",
            deltaKind === "default" && "text-ink-3"
          )}
        >
          {delta}
        </div>
      ) : null}
      {foot ? (
        <div className="mt-1 font-mono text-[11px] tracking-[0.04em] text-ink-3">{foot}</div>
      ) : null}
      {src ? (
        <div className="mt-2 font-mono text-[10px] tracking-[0.04em] text-ink-4 group-hover:text-ink-2">
          {src}
        </div>
      ) : null}
    </>
  );
  const className = cn(
    "group block border-r border-rule-soft px-[18px] pt-4 pb-[18px] text-inherit no-underline last:border-r-0",
    to && "cursor-pointer transition-colors duration-100 hover:bg-card-2"
  );

  return to ? (
    <Link to={to} className={className}>
      {content}
    </Link>
  ) : (
    <div className={className}>
      {content}
    </div>
  );
}

export function KPIRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 border border-rule-soft bg-card sm:grid-cols-2 xl:grid-cols-4", className)}>
      {children}
    </div>
  );
}
