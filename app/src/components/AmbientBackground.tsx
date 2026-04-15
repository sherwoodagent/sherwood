/**
 * AmbientBackground — static gradient atmosphere. Replaces the heavier
 * Three.js scenes (TorusKnot, Forest) with a CSS-only equivalent that
 * costs zero JS bundle and renders identically across devices.
 *
 * Variants:
 *  - "default": cool emerald wash (used on most pages)
 *  - "warm":    parchment-tinted variant (use on settled-state pages)
 */

interface AmbientBackgroundProps {
  variant?: "default" | "warm";
  scanlines?: boolean;
}

export default function AmbientBackground({ variant = "default", scanlines = true }: AmbientBackgroundProps) {
  return (
    <>
      <div
        className={variant === "warm" ? "sh-bg-gradient sh-bg-gradient--warm" : "sh-bg-gradient"}
        aria-hidden="true"
      />
      {scanlines && <div className="scanlines" aria-hidden="true" style={{ opacity: 0.18 }} />}
    </>
  );
}
