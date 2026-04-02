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
        <Link
          href="/#roadmap"
          className="!bg-transparent !text-white/80 px-4 py-2 text-sm font-semibold no-underline hover:!border-white/40 hover:!text-white transition-all"
        >
          Roadmap
        </Link>
        <Link
          href="https://docs.sherwood.sh"
          target="_blank"
          className="!bg-transparent !text-white/80 px-4 py-2 text-sm font-semibold no-underline hover:!border-white/40 hover:!text-white transition-all"
        >
          Docs
        </Link>
        <Link
          href="/leaderboard"
          className="!bg-[var(--color-accent)] !text-black px-4 py-2 text-sm font-semibold no-underline hover:!opacity-90 transition-opacity"
        >
          Syndicates
        </Link>
      </nav>
    </header>
  );
}
