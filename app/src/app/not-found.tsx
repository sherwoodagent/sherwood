import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <div className="sh-bg-gradient" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" style={{ opacity: 0.12 }} />
      <main className="sh-error-layout" id="main-content">
        <div
          className="tag-bracket"
          style={{ color: "#eab308", marginBottom: "-0.5rem" }}
        >
          P.404
        </div>
        <div className="sh-error-code">404</div>
        <h1 className="sh-error-title">This endpoint is not on the network</h1>
        <p className="sh-error-desc">
          The page you&rsquo;re looking for isn&rsquo;t registered with Sherwood.
          It may have moved, been renamed, or never existed.
        </p>
        <div className="sh-error-actions">
          <Link href="/" className="sh-btn sh-btn--primary">
            Back to homepage
          </Link>
          <Link href="/leaderboard" className="sh-btn sh-btn--secondary">
            Browse syndicates
          </Link>
          <a
            href="https://docs.sherwood.sh"
            className="sh-btn sh-btn--ghost"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the docs ↗
          </a>
        </div>
      </main>
    </>
  );
}
