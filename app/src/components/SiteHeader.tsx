"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import LogoWordmark from "./LogoWordmark";
import LogoMark from "./LogoMark";

export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const [headerBottom, setHeaderBottom] = useState(57);

  useEffect(() => {
    const update = () => {
      if (headerRef.current) {
        const rect = headerRef.current.getBoundingClientRect();
        setHeaderBottom(rect.bottom);
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return (
    <header ref={headerRef} className="site-header font-[family-name:var(--font-plus-jakarta)]">
      <Link
        href="/"
        className="no-underline flex items-center"
      >
        <LogoWordmark height={28} className="hidden md:block" />
        <LogoMark height={32} className="block md:hidden" />
      </Link>
      <nav className="flex items-center">
        {/* Desktop nav links */}
        <Link
          href="/#roadmap"
          className="hidden md:inline-flex !bg-transparent !text-white/80 px-4 py-2 text-sm font-semibold no-underline hover:!border-white/40 hover:!text-white transition-all"
        >
          Roadmap
        </Link>
        <Link
          href="https://docs.sherwood.sh"
          target="_blank"
          className="hidden md:inline-flex !bg-transparent !text-white/80 px-4 py-2 text-sm font-semibold no-underline hover:!border-white/40 hover:!text-white transition-all"
        >
          Docs
        </Link>

        {/* Syndicates button — always visible */}
        <Link
          href="/leaderboard"
          className="!bg-[var(--color-accent)] !text-black px-4 py-2 text-sm font-semibold no-underline hover:!opacity-90 transition-opacity"
        >
          Syndicates
        </Link>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen((prev) => !prev)}
          className="md:hidden ml-3 p-2 text-white/80 hover:text-white transition-colors cursor-pointer"
          aria-label="Toggle menu"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            {menuOpen ? (
              <>
                <line x1="4" y1="4" x2="16" y2="16" />
                <line x1="16" y1="4" x2="4" y2="16" />
              </>
            ) : (
              <>
                <line x1="3" y1="6" x2="17" y2="6" />
                <line x1="3" y1="10" x2="17" y2="10" />
                <line x1="3" y1="14" x2="17" y2="14" />
              </>
            )}
          </svg>
        </button>
      </nav>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="mobile-nav-dropdown md:hidden" style={{ top: headerBottom }}>
          <Link
            href="/#roadmap"
            onClick={() => setMenuOpen(false)}
            className="block px-4 py-3 text-sm font-semibold text-white/80 no-underline hover:text-white hover:bg-white/5 transition-all"
          >
            Roadmap
          </Link>
          <Link
            href="https://docs.sherwood.sh"
            target="_blank"
            onClick={() => setMenuOpen(false)}
            className="block px-4 py-3 text-sm font-semibold text-white/80 no-underline hover:text-white hover:bg-white/5 transition-all"
          >
            Docs
          </Link>
        </div>
      )}
    </header>
  );
}
