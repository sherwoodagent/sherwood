"use client";

/**
 * HeroVideo — background MP4 for the landing hero.
 *
 * Performance notes:
 * - The <video> mounts AFTER the page becomes interactive (idle callback).
 *   The hero text + gradient render immediately so LCP isn't blocked
 *   waiting for an autoplaying decorative video.
 * - We respect `prefers-reduced-motion` and skip the video entirely for
 *   users who've opted out of motion (the gradient still renders).
 * - On slow connections (Save-Data, 2g/3g effectiveType) we also skip
 *   so we don't burn user bandwidth on decoration.
 */

import { useEffect, useRef, useState } from "react";

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

function shouldSkipVideo(): boolean {
  if (typeof window === "undefined") return true;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return true;
  }
  const conn = (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
  if (conn?.saveData) return true;
  if (conn?.effectiveType && /^(slow-2g|2g|3g)$/i.test(conn.effectiveType)) {
    return true;
  }
  return false;
}

export default function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [shouldMount, setShouldMount] = useState(false);

  useEffect(() => {
    if (shouldSkipVideo()) return;

    // Defer mounting the <video> until the browser is idle so we don't
    // contend for bandwidth / decode slots with the hero text + chart libs
    // that ship in the leaderboard route. Falls back to a 1s timeout on
    // browsers without requestIdleCallback (Safari).
    const ric = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    let cancel: () => void;
    if (typeof ric === "function") {
      const handle = ric(() => setShouldMount(true), { timeout: 1500 });
      cancel = () => {
        const cic = (
          window as Window & { cancelIdleCallback?: (h: number) => void }
        ).cancelIdleCallback;
        if (typeof cic === "function") cic(handle);
      };
    } else {
      const t = setTimeout(() => setShouldMount(true), 800);
      cancel = () => clearTimeout(t);
    }
    return () => cancel();
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100vh",
        overflow: "hidden",
        zIndex: -1,
      }}
    >
      {shouldMount && (
        <video
          ref={videoRef}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          onLoadedData={() => setLoaded(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.8s ease-in",
          }}
        >
          <source src="/hero-bg.mp4" type="video/mp4" />
        </video>
      )}
      {/* Gradient overlay always renders so the hero has its dark wash even
          before the video lands (or when it never does). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,1) 100%)",
        }}
      />
    </div>
  );
}
