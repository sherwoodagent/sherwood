"use client";

/**
 * ShareButton — opens a pre-filled tweet for sharing a Sherwood URL.
 *
 * No tracking pixels, no Twitter SDK; just a tweet-intent link in a new
 * tab. Includes a copy-to-clipboard fallback for users without Twitter.
 */

import { useState } from "react";
import { useToast } from "@/components/ui/Toast";

interface Props {
  /** Path beginning with `/` (e.g. `/syndicate/atlas/agents/42`). The
   *  component prepends https://sherwood.sh. */
  path: string;
  /** Pre-filled tweet body. Will be appended with the URL. */
  text: string;
  className?: string;
}

// Hardcoded production URL on purpose: shared links should always point
// at canonical prod even when copied from a Vercel preview deploy. If we
// ever support multiple production domains, plumb this through env.
const SITE = "https://sherwood.sh";

export default function ShareButton({ path, text, className }: Props) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const url = `${SITE}${path}`;
  const tweetIntent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    text,
  )}&url=${encodeURIComponent(url)}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied", url);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed", "Use the share link instead.");
    }
  }

  return (
    <div
      style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}
      className={className}
    >
      <a
        href={tweetIntent}
        target="_blank"
        rel="noopener noreferrer"
        className="sh-btn sh-btn--secondary sh-btn--sm"
        style={{ textDecoration: "none" }}
      >
        Share on X ↗
      </a>
      <button
        type="button"
        onClick={handleCopy}
        className="sh-btn sh-btn--ghost sh-btn--sm"
        aria-label={copied ? "Link copied" : "Copy link"}
      >
        {copied ? "Copied ✓" : "Copy link"}
      </button>
    </div>
  );
}
