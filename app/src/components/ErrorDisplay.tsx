"use client";

import Link from "next/link";

interface ErrorDisplayProps {
  title?: string;
  description?: string;
  error?: Error;
  minHeight?: string;
  reset?: () => void;
}

export default function ErrorDisplay({
  title = "Something broke on this page",
  description = "An unexpected error occurred. Try the action below, or head back home and try again from there.",
  error,
  minHeight,
  reset,
}: ErrorDisplayProps) {
  return (
    <>
      <div className="sh-bg-gradient" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" style={{ opacity: 0.12 }} />
      <main
        className="sh-error-layout"
        style={minHeight ? { minHeight } : undefined}
        id="main-content"
        role="alert"
      >
        <div className="tag-bracket" style={{ color: "#ff4d4d", marginBottom: "-0.5rem" }}>
          P.ERR
        </div>
        <div className="sh-error-code" style={{ color: "#ff4d4d" }}>
          ×
        </div>
        <h1 className="sh-error-title">{title}</h1>
        <p className="sh-error-desc">{description}</p>

        {error && (
          <details
            style={{
              maxWidth: 520,
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              color: "rgba(255,255,255,0.4)",
              padding: "0.5rem",
              border: "1px solid var(--color-border-soft)",
              background: "rgba(255, 77, 77, 0.04)",
              wordBreak: "break-all",
            }}
          >
            <summary style={{ cursor: "pointer", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Technical details
            </summary>
            <div style={{ marginTop: "0.5rem", whiteSpace: "pre-wrap" }}>{error.message}</div>
          </details>
        )}

        <div className="sh-error-actions">
          {reset && (
            <button type="button" onClick={reset} className="sh-btn sh-btn--primary">
              Retry
            </button>
          )}
          <Link href="/" className="sh-btn sh-btn--secondary">
            Back to homepage
          </Link>
        </div>
      </main>
    </>
  );
}
