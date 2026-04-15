"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/components/ui/Toast";

/**
 * Inline click-to-copy text. Semantically a <button> so it's keyboard
 * operable and announced correctly by screen readers. Styled to blend
 * with surrounding text (no chrome).
 */
export default function CopyText({
  children,
  copyValue,
  className = "",
  label,
}: {
  children: React.ReactNode;
  copyValue: string;
  className?: string;
  /** Accessible label describing WHAT is being copied (e.g. "vault address"). */
  label?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = copyValue;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    toast.success(`Copied ${label ?? "to clipboard"}`);
    setTimeout(() => setCopied(false), 1500);
  }, [copyValue, label, toast]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label ?? copyValue}${copied ? " (copied)" : ""}`}
      className={`cursor-pointer transition-opacity hover:opacity-80 bg-transparent border-0 p-0 font-inherit text-inherit ${className}`}
      style={{
        font: "inherit",
        color: "inherit",
        letterSpacing: "inherit",
      }}
    >
      {children}
    </button>
  );
}
