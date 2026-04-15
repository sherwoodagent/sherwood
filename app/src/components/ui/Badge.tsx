import { type ReactNode } from "react";

type BadgeVariant = "neutral" | "success" | "warn" | "danger" | "info";

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = "neutral", children, className = "" }: BadgeProps) {
  return <span className={`sh-badge sh-badge--${variant} ${className}`}>{children}</span>;
}
