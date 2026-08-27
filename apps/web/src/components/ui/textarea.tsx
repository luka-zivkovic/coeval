import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "min-w-0 w-full min-h-[110px] rounded-sm border border-rule bg-paper px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-foreground placeholder:text-ink-3 focus:border-ink-3 disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
