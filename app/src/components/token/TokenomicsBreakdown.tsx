interface Slice {
  label: string;
  pct: number;
  color: string;
  description: string;
}

const SLICES: Slice[] = [
  {
    label: "LP",
    pct: 63.4,
    color: "rgb(46, 230, 166)",
    description: "Locked liquidity. The bulk of supply seeds Uniswap pools at launch.",
  },
  {
    label: "Bootstrapping incentives",
    pct: 15,
    color: "rgb(95, 192, 220)",
    description: "Treasury / multisig — guardian rewards, integrations, ecosystem grants.",
  },
  {
    label: "Team vesting",
    pct: 15,
    color: "rgb(232, 168, 124)",
    description: "Core contributors. Subject to a vesting schedule.",
  },
  {
    label: "Presale",
    pct: 6.6,
    color: "rgb(212, 130, 130)",
    description: "Early supporters. Unlocks paced to align with guardian network adoption.",
  },
];

const PIE_SIZE = 320;
const RADIUS = 140;
const CX = PIE_SIZE / 2;
const CY = PIE_SIZE / 2;

function arcPath(startAngle: number, endAngle: number): string {
  const startX = CX + RADIUS * Math.cos(startAngle);
  const startY = CY + RADIUS * Math.sin(startAngle);
  const endX = CX + RADIUS * Math.cos(endAngle);
  const endY = CY + RADIUS * Math.sin(endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${CX} ${CY} L ${startX} ${startY} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${endX} ${endY} Z`;
}

export default function TokenomicsBreakdown() {
  // Cumulative-angle pie. Reduce so each slice's path is computed from a
  // running total — lint forbids reassigning `let` across .map iterations.
  const segments = SLICES.reduce<{ start: number; items: (Slice & { path: string })[] }>(
    (acc, s) => {
      const start = acc.start;
      const end = start + (s.pct / 100) * Math.PI * 2;
      return {
        start: end,
        items: [...acc.items, { ...s, path: arcPath(start, end) }],
      };
    },
    { start: -Math.PI / 2, items: [] }, // start at 12 o'clock
  ).items;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(260px, 360px) 1fr",
        gap: "3rem",
        alignItems: "center",
      }}
      className="tokenomics-grid"
    >
      <svg
        viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
        role="img"
        aria-label="WOOD tokenomics breakdown"
        style={{ width: "100%", height: "auto", maxWidth: PIE_SIZE }}
      >
        <circle cx={CX} cy={CY} r={RADIUS + 8} fill="rgba(46, 230, 166, 0.04)" />
        {segments.map((s) => (
          <path
            key={s.label}
            d={s.path}
            fill={s.color}
            stroke="#000"
            strokeWidth="1.5"
            opacity={0.92}
          />
        ))}
        <circle cx={CX} cy={CY} r={70} fill="#000" />
        <text
          x={CX}
          y={CY - 6}
          textAnchor="middle"
          fontSize="11"
          fontWeight="700"
          fill="rgba(46, 230, 166, 0.7)"
          letterSpacing="2.4"
          fontFamily="var(--font-jetbrains-mono, monospace)"
        >
          $WOOD
        </text>
        <text
          x={CX}
          y={CY + 12}
          textAnchor="middle"
          fontSize="10"
          fontWeight="500"
          fill="rgba(255, 255, 255, 0.55)"
          letterSpacing="1.4"
          fontFamily="var(--font-jetbrains-mono, monospace)"
        >
          fixed supply
        </text>
      </svg>

      <ul
        className="font-[family-name:var(--font-plus-jakarta)]"
        style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "1.25rem" }}
      >
        {SLICES.map((s) => (
          <li
            key={s.label}
            style={{
              display: "grid",
              gridTemplateColumns: "16px 1fr auto",
              gap: "0.75rem 1rem",
              alignItems: "baseline",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                background: s.color,
                display: "inline-block",
                marginTop: 4,
              }}
            />
            <div>
              <div
                style={{
                  fontFamily: "var(--font-inter)",
                  color: "white",
                  fontSize: "15px",
                  fontWeight: 500,
                  marginBottom: 2,
                }}
              >
                {s.label}
              </div>
              <div style={{ color: "rgba(255,255,255,0.55)", fontSize: "13px", lineHeight: 1.5 }}>
                {s.description}
              </div>
            </div>
            <div
              className="tabular-nums"
              style={{
                color: "var(--color-accent)",
                fontFamily: "var(--font-jetbrains-mono)",
                fontSize: "16px",
                fontWeight: 600,
              }}
            >
              {s.pct.toFixed(1)}%
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
