"use client";

import { type ReactNode } from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** "bottom" (default) renders below the trigger — safer when the trigger
   *  lives near the top of its container (e.g. stats-bar labels).
   *  "top" renders above for cases where there's no room below. */
  placement?: "top" | "bottom";
  /** Horizontal anchor. Defaults to "left" so tooltips flow rightward
   *  into available space — correct for most left-aligned labels.
   *  Use "right" near the viewport's right edge. */
  align?: "left" | "right";
}

/** Hover/focus tooltip. CSS-only positioning — no JS. */
export function Tooltip({
  content,
  children,
  placement = "bottom",
  align = "left",
}: TooltipProps) {
  const alignClass = align === "right" ? " sh-tooltip-content--align-right" : "";
  return (
    <span className="sh-tooltip-root">
      {children}
      <span
        className={`sh-tooltip-content sh-tooltip-content--${placement}${alignClass}`}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
}
