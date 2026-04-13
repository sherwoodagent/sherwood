"use client";

/**
 * Countdown — live ticker to a future Unix timestamp (seconds, bigint or number).
 * Updates every second until the target passes. When elapsed, renders `whenDone`.
 */

import { useEffect, useState } from "react";

interface CountdownProps {
  to: bigint | number;
  label?: string;
  whenDone?: React.ReactNode;
}

export function Countdown({ to, label, whenDone }: CountdownProps) {
  const target = typeof to === "bigint" ? Number(to) : to;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = target - now;
  if (remaining <= 0) {
    return <span className="sh-countdown">{whenDone ?? "—"}</span>;
  }

  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;

  let text: string;
  if (d > 0) text = `${d}d ${h.toString().padStart(2, "0")}h ${m.toString().padStart(2, "0")}m`;
  else if (h > 0) text = `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
  else text = `${m}m ${s.toString().padStart(2, "0")}s`;

  return (
    <span className="sh-countdown" aria-live="polite">
      {label && <span className="sh-countdown__label">{label}</span>}
      <span className="sh-countdown__value">{text}</span>
    </span>
  );
}
