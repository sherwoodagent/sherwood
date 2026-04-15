/**
 * LoadingSkeleton — branded loading state. Variants match the rough shape
 * of the page that follows so the layout doesn't shift on load.
 */

interface LoadingSkeletonProps {
  variant?: "page" | "panel" | "table" | "stat";
  rows?: number;
}

export default function LoadingSkeleton({ variant = "page", rows = 4 }: LoadingSkeletonProps) {
  if (variant === "panel") {
    return (
      <div className="sh-skel-panel" aria-busy="true" aria-label="Loading">
        <div className="sh-skel-bar sh-skel-bar--title" />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="sh-skel-bar" style={{ width: `${100 - i * 10}%` }} />
        ))}
      </div>
    );
  }

  if (variant === "table") {
    return (
      <div className="sh-skel-table" aria-busy="true" aria-label="Loading">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="sh-skel-row" />
        ))}
      </div>
    );
  }

  if (variant === "stat") {
    return (
      <div className="sh-skel-stats" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="sh-skel-stat">
            <div className="sh-skel-bar" style={{ width: "40%", height: 8 }} />
            <div className="sh-skel-bar sh-skel-bar--lg" style={{ width: "70%" }} />
          </div>
        ))}
      </div>
    );
  }

  // Default: full-page loading scaffold
  return (
    <div className="sh-skel-page" role="status" aria-busy="true" aria-label="Loading">
      <div className="sh-skel-loader">
        <span className="sh-skel-pulse" />
        <span className="sh-skel-pulse" style={{ animationDelay: "0.15s" }} />
        <span className="sh-skel-pulse" style={{ animationDelay: "0.3s" }} />
      </div>
      <div className="sh-skel-label">LOADING</div>
    </div>
  );
}
