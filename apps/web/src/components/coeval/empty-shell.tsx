import * as React from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./eyebrow";

export interface EmptyShellProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  art?: React.ReactNode;
  className?: string;
}

export function EmptyShell({
  eyebrow,
  title,
  body,
  primary,
  secondary,
  art,
  className
}: EmptyShellProps) {
  return (
    <div className={cn("fadeUp flex flex-col items-center px-4 py-16 text-center", className)}>
      {art ? <div className="mb-4 text-ink-3">{art}</div> : null}
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <div className="mt-2 max-w-[42ch] font-serif text-[28px] font-medium leading-[1.1] tracking-[-0.02em] text-ink">
        {title}
      </div>
      {body ? (
        <div className="mt-3 max-w-[58ch] text-[13.5px] leading-[1.55] text-ink-3">{body}</div>
      ) : null}
      {primary || secondary ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {secondary}
          {primary}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyGlyph({ kind }: { kind: "404" | "offline" | "locked" }) {
  const common = {
    width: 56,
    height: 56,
    viewBox: "0 0 64 64",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
  if (kind === "404") {
    return (
      <svg {...common}>
        <rect x={6} y={14} width={52} height={36} rx={1} />
        <path d="M14 28h10v10M14 38h14" />
        <circle cx={38} cy={33} r={6} />
        <path d="M48 28h6M51 28v10" />
        <path d="M6 22h52" />
      </svg>
    );
  }
  if (kind === "offline") {
    return (
      <svg {...common}>
        <path d="M6 30c14-14 38-14 52 0" />
        <path d="M14 38c10-10 26-10 36 0" />
        <path d="M22 46c6-6 14-6 20 0" />
        <circle cx={32} cy={54} r={1.5} fill="currentColor" />
        <path d="M8 8l48 48" stroke="var(--signal)" strokeWidth={1.5} />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x={16} y={28} width={32} height={24} rx={2} />
      <path d="M22 28v-6a10 10 0 0 1 20 0v6" />
      <circle cx={32} cy={40} r={2.5} />
      <path d="M32 42v4" />
    </svg>
  );
}
