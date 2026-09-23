import * as React from "react";
import { cn } from "@/lib/utils";

export interface SparkProps {
  values: number[];
  signalIndex?: number;
  className?: string;
}

export function Spark({ values, signalIndex, className }: SparkProps) {
  const max = Math.max(1, ...values);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} style={{ width: 76 }}>
      <div className="flex h-9 items-end gap-[3px]">
        {values.map((v, i) => (
          <div
            key={i}
            className={cn("w-2", i === signalIndex ? "bg-signal" : "bg-ink")}
            style={{ height: `${(v / max) * 36}px` }}
          />
        ))}
      </div>
      <div className="font-mono text-[11px] text-ink-3">M T W T F S S</div>
    </div>
  );
}
