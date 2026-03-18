import Link from "next/link";

export default function SiteHeader() {
  return (
    <header className="site-header font-[family-name:var(--font-jetbrains-mono)]">
      <Link
        href="/"
        className="text-2xl font-extrabold tracking-tighter text-white no-underline"
      >
        sherwood<span className="text-[var(--color-accent)]">.sh</span>
      </Link>
      <nav className="flex items-center">
        <Link href="/#how-it-works">How It Works</Link>
        <Link href="/#syndicates">Live Syndicates</Link>
      </nav>
    </header>
  );
}
