import Link from "next/link";
import LogoWordmark from "./LogoWordmark";
import LogoMark from "./LogoMark";

export default function SiteHeader() {
  return (
    <header className="site-header font-[family-name:var(--font-plus-jakarta)]">
      <Link
        href="/"
        className="no-underline flex items-center"
      >
        <LogoWordmark height={28} className="hidden md:block" />
        <LogoMark height={32} className="block md:hidden" />
      </Link>
      <nav className="flex items-center">
        <Link href="/#how-it-works">How It Works</Link>
        {/* <Link href="/#syndicates">Live Syndicates</Link> */}
      </nav>
    </header>
  );
}
