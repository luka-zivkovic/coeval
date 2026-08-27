import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const actionClass =
  "-my-1 inline-flex min-h-6 items-center rounded-sm py-1 text-left text-inherit underline-offset-2 hover:underline focus-visible:underline";

export function RowLink({
  children,
  className,
  onClick,
  ...props
}: ComponentProps<typeof Link> & { children: ReactNode }) {
  return (
    <Link
      {...props}
      className={cn(actionClass, className)}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    >
      {children}
    </Link>
  );
}

export function RowButton({
  children,
  className,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "type" | "onClick"> & {
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      {...props}
      type="button"
      className={cn(actionClass, className)}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
    >
      {children}
    </button>
  );
}
