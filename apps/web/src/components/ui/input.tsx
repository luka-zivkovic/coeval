import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "min-w-0 w-full rounded-sm border border-rule bg-paper px-2.5 py-2 text-[13px] text-foreground transition-colors placeholder:text-ink-3 focus:border-ink-3 disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
