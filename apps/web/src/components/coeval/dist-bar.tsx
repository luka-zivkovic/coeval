import * as React from "react";

export interface DistBarProps {
  pass: number;
  fail: number;
  ambig: number;
}

export function DistBar({ pass, fail, ambig }: DistBarProps) {
  const total = pass + fail + ambig;
  if (total === 0) {
    return <div className="h-1.5 w-full rounded-[1px] border border-rule-soft bg-paper-3" />;
  }
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-[1px] border border-rule-soft bg-paper-3">
      <div className="h-full bg-ink" style={{ width: pct(pass) }} />
      <div className="h-full bg-signal" style={{ width: pct(fail) }} />
      <div className="fill-ambiguous h-full" style={{ width: pct(ambig) }} />
    </div>
  );
}

export interface LegendItem {
  color: string;
  label: React.ReactNode;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10.5px] text-ink-3">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="h-[9px] w-[9px] rounded-[1px]" style={{ background: item.color }} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}
