import * as React from "react";
import { cn } from "@/lib/utils";

export interface EyebrowProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "signal" | "dev";
}

export function Eyebrow({ className, tone = "default", ...props }: EyebrowProps) {
  return (
    <div
      className={cn(
        "eyebrow",
        tone === "signal" && "eyebrow-signal",
        tone === "dev" && "eyebrow-dev",
        className
      )}
      {...props}
    />
  );
}
