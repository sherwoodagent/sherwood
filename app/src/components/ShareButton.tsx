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
        className="sh-btn sh-btn--secondary sh-btn--sm"
        aria-label={copied ? "Link copied" : "Copy link"}
        title={copied ? "Copied!" : "Copy link"}
        style={{ padding: "0.45rem 0.6rem" }}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
        )}
      </button>
    </div>
  );
}
