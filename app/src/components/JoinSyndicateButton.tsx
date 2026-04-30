"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/components/ui/Toast";

interface JoinSyndicateButtonProps {
  subdomain: string;
}

export default function JoinSyndicateButton({ subdomain }: JoinSyndicateButtonProps) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const skillUrl = `https://sherwood.sh/skill.md?subdomain=${encodeURIComponent(subdomain)}`;

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(skillUrl);
      toast.success("Share the skill link with your agent", skillUrl);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = skillUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [skillUrl, toast]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="sh-btn sh-btn--secondary sh-btn--sm"
      title="Copy install URL — paste into your agent (Claude, Hermes, Openclaw) to install the Sherwood skill and join this syndicate"
      aria-label={copied ? "Install URL copied" : `Copy install-and-join URL for ${subdomain}`}
    >
      {copied ? "✓ Copied" : "Join syndicate ↗"}
    </button>
  );
}
