/**
 * GuardianLifecycleFlow — horizontal 5-step proposal lifecycle visual.
 *
 * Lifted directly from the pitch deck (slide 4): 5 cards connected by accent
 * arrows with the Guardian Review step highlighted. Communicates that the
 * Guardian Network is a load-bearing step in every proposal's path to
 * execution — not an optional layer.
 */
const STEPS = [
  {
    num: "01",
    title: "Proposal",
    desc: "An agent submits a strategy proposal with calldata.",
    highlight: false,
  },
  {
    num: "02",
    title: "Vote",
    desc: "Depositors vote. Optimistic governance — silent = pass.",
    highlight: false,
  },
  {
    num: "03",
    title: "Guardian Review",
    desc: "Staked guardians simulate calldata. Block quorum slashes.",
    highlight: true,
    badge: "$WOOD",
  },
  {
    num: "04",
    title: "Execute",
    desc: "Capital deploys onchain to the strategy contract.",
    highlight: false,
  },
  {
    num: "05",
    title: "Settle",
    desc: "P&L returns. Guardians earn. Reputation accrues.",
    highlight: false,
  },
];

export default function GuardianLifecycleFlow({ className }: { className?: string }) {
  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(5, 1fr)",
        gap: "0.6rem",
        position: "relative",
      }}
    >
      {STEPS.map((s, i) => {
        const isLast = i === STEPS.length - 1;
        return (
          <div
            key={s.num}
            className="font-[family-name:var(--font-plus-jakarta)] guardian-flow-step"
            data-highlight={s.highlight ? "true" : "false"}
            style={{
              position: "relative",
              padding: "1.25rem 1rem 1.1rem",
              border: s.highlight
                ? "1px solid rgba(46, 230, 166, 0.55)"
                : "1px solid var(--color-border)",
              background: s.highlight
                ? "linear-gradient(180deg, rgba(46, 230, 166, 0.1) 0%, rgba(46, 230, 166, 0.02) 100%)"
                : "rgba(0, 0, 0, 0.4)",
              boxShadow: s.highlight
                ? "0 0 0 1px rgba(46, 230, 166, 0.06), 0 20px 60px -25px rgba(46, 230, 166, 0.45)"
                : "none",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              minHeight: 150,
            }}
          >
            {s.highlight && s.badge && (
              <span
                style={{
                  position: "absolute",
                  top: -10,
                  right: 12,
                  background: "var(--color-accent)",
                  color: "#000",
                  fontFamily: "var(--font-jetbrains-mono)",
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: "0.18em",
                  padding: "3px 7px",
                }}
              >
                {s.badge}
              </span>
            )}
            <div
              style={{
                fontFamily: "var(--font-jetbrains-mono)",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.22em",
                color: s.highlight
                  ? "var(--color-accent)"
                  : "rgba(255, 255, 255, 0.45)",
              }}
            >
              {s.num}
            </div>
            <div
              className="font-[family-name:var(--font-inter)]"
              style={{
                fontSize: "0.95rem",
                fontWeight: 600,
                color: "white",
                letterSpacing: "-0.01em",
              }}
            >
              {s.title}
            </div>
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.5,
                color: "rgba(255, 255, 255, 0.55)",
              }}
            >
              {s.desc}
            </div>

            {/* Connector arrow — pitch-deck style */}
            {!isLast && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  right: -12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--color-accent)",
                  fontSize: 18,
                  fontWeight: 700,
                  zIndex: 2,
                  textShadow: "0 0 8px rgba(0,0,0,0.8)",
                }}
              >
                →
              </span>
            )}
          </div>
        );
      })}
      <style>{`
        @media (max-width: 900px) {
          .guardian-flow-step:nth-child(n) {
            min-height: auto !important;
          }
        }
      `}</style>
    </div>
  );
}
