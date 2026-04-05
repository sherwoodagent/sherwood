import LogoWordmark from "./LogoWordmark";

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

const FOOTER_LINKS: Record<string, FooterLink[]> = {
  Protocol: [
    { label: "Leaderboard", href: "/leaderboard" },
    { label: "Agent Skill", href: "/skill.md" },
    { label: "Guardian Skill", href: "/skill-guardian.md" },
  ],
  Developers: [
    { label: "Documentation", href: "https://docs.sherwood.sh", external: true },
    { label: "GitHub", href: "https://github.com/imthatcarlos/sherwood", external: true },
  ],
  Community: [
    { label: "Twitter / X", href: "https://x.com/sherwoodagent", external: true },
    { label: "Contact", href: "mailto:contact@sherwood.sh", external: true },
  ],
};

function ExternalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="inline ml-1 opacity-40">
      <path d="M3.5 1H11V8.5M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

export default function SiteFooter() {
  return (
    <footer className="mt-0 font-[family-name:var(--font-plus-jakarta)]" style={{ background: "#000" }}>
      <div className="max-w-[1400px] mx-auto px-8 md:px-16 py-16">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 md:gap-8">
          {/* Logo + tagline */}
          <div className="space-y-4">
            <LogoWordmark height={24} />
            <p className="text-sm text-white/50 leading-relaxed max-w-[260px]">
              The operating system for agent-managed funds on Base & Robinhood.
            </p>
            <div className="flex gap-3 pt-2">
              <a
                href="https://x.com/sherwoodagent"
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 rounded-full border border-[rgba(255,255,255,0.1)] flex items-center justify-center text-white/40 hover:text-[#2EE6A6] hover:border-[#2EE6A6] transition-all"
              >
                <XIcon />
              </a>
              <a
                href="https://github.com/imthatcarlos/sherwood"
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 rounded-full border border-[rgba(255,255,255,0.1)] flex items-center justify-center text-white/40 hover:text-[#2EE6A6] hover:border-[#2EE6A6] transition-all"
              >
                <GitHubIcon />
              </a>
            </div>
          </div>

          {/* Link columns */}
          {Object.entries(FOOTER_LINKS).map(([heading, links]) => (
            <div key={heading}>
              <h4 className="text-xs uppercase tracking-[0.1em] text-white/40 mb-4 font-semibold">
                {heading}
              </h4>
              <ul className="space-y-3">
                {links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="text-sm text-white/70 hover:text-[#2EE6A6] transition-colors"
                    >
                      {link.label}
                      {link.external && <ExternalIcon />}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="border-t border-[rgba(255,255,255,0.06)] mt-12 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-xs text-white/25">
            &copy; {new Date().getFullYear()} Sherwood Protocol. All rights reserved.
          </p>
          <p className="text-xs text-white/20">
            Unaudited software. Not financial advice. Use at your own risk.
          </p>
        </div>
      </div>
    </footer>
  );
}
