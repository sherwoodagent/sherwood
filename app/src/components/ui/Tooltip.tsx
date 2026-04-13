"use client";

import { type ReactNode } from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

/** Hover/focus tooltip. Uses CSS-only visibility — no JS positioning. */
export function Tooltip({ content, children }: TooltipProps) {
  return (
    <span className="sh-tooltip-root">
      {children}
      <span className="sh-tooltip-content" role="tooltip">
        {content}
      </span>
    </span>
  );
}
