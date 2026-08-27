import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-sm border px-[7px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.04em]",
  {
    variants: {
      variant: {
        default: "border-rule-soft bg-paper-3 text-ink-2",
        pass:    "border-rule-soft bg-paper-3 text-ink",
        fail:    "border-signal-tint bg-signal-wash text-signal",
        ambig:   "border-gold-tint bg-ambig-bg text-gold",
        dev:     "border-dev-tint bg-dev-tint text-dev",
        outline: "border-rule-soft bg-transparent text-ink-2",
        provisional: "border-dashed border-gold bg-transparent text-gold"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
