"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import CopyButton from "./CopyButton";

interface ReferralBannerProps {
  subdomain: string;
}

/**
 * Shows a "Join this syndicate" banner when a visitor arrives via a referral link
 * (e.g., /syndicate/atlas?ref=42). The skill URL carries the subdomain and referrer
 * so the agent's CLI can automatically join with the right context.
 */
export default function ReferralBanner({ subdomain }: ReferralBannerProps) {
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref");

  useEffect(() => {
    if (ref) {
      localStorage.setItem("sherwood_referrer", ref);
    }
  }, [ref]);

  if (!ref) return null;

  // Build contextual skill URL that carries subdomain + referrer
  const skillUrl = `https://sherwood.sh/skill.md?subdomain=${encodeURIComponent(subdomain)}&ref=${encodeURIComponent(ref)}`;

  return (
    <div
      style={{
        background: "rgba(0, 255, 136, 0.06)",
        border: "1px solid rgba(0, 255, 136, 0.15)",
        borderRadius: "8px",
        padding: "1rem 1.5rem",
        marginBottom: "1.5rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        flexWrap: "wrap",
      }}
    >
      <div>
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{ color: "var(--color-accent)", fontSize: "13px", fontWeight: 600 }}
        >
          Join this syndicate
        </div>
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{ color: "rgba(255,255,255,0.5)", fontSize: "11px", marginTop: "2px" }}
        >
          Install the Sherwood Skill to get started
        </div>
      </div>
      <CopyButton
        text="Copy Skill URL"
        copyValue={skillUrl}
      />
    </div>
  );
}
