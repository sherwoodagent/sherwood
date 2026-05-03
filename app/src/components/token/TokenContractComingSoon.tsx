/**
 * Pre-launch panel that holds the spot where the live $WOOD token contract
 * address will go. Conveys "this is not yet tradable" clearly. Copy button
 * is disabled until WOOD ships (see commented-out JSX below).
 */
export default function TokenContractComingSoon() {
  // Placeholder until WOOD ships. Once the address is set, replace this.
  const placeholder = "0x0000000000000000000000000000000000000000";

  return (
    <div
      className="font-[family-name:var(--font-plus-jakarta)]"
      style={{
        border: "1px dashed rgba(46, 230, 166, 0.45)",
        background:
          "linear-gradient(180deg, rgba(46, 230, 166, 0.04) 0%, rgba(0, 0, 0, 0.2) 100%)",
        padding: "2rem 1.75rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1.25rem",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-jetbrains-mono)",
              color: "var(--color-accent)",
              fontSize: 10,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              marginBottom: "0.4rem",
            }}
          >
            {"// Pre-Launch"}
          </div>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontFamily: "var(--font-jetbrains-mono)",
            fontSize: 10,
            color: "rgba(255, 165, 95, 0.95)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            border: "1px solid rgba(255, 165, 95, 0.45)",
            background: "rgba(255, 165, 95, 0.06)",
            padding: "3px 9px",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "rgb(255, 165, 95)",
              boxShadow: "0 0 6px rgba(255, 165, 95, 0.8)",
            }}
          />
          Not deployed
        </span>
      </div>

      <p
        style={{
          color: "rgba(255, 255, 255, 0.6)",
          fontSize: 14,
          lineHeight: 1.6,
          maxWidth: 640,
          marginBottom: "1.5rem",
        }}
      >
        WOOD ships with the Guardian Registry on Base mainnet.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
          padding: "0.85rem 1rem",
          background: "rgba(0, 0, 0, 0.6)",
          border: "1px solid var(--color-border)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-jetbrains-mono)",
            fontSize: 10,
            color: "rgba(255, 255, 255, 0.45)",
            letterSpacing: "0.22em",
            textTransform: "uppercase",
          }}
        >
          Address
        </span>
        <code
          className="tabular-nums"
          style={{
            flex: 1,
            minWidth: 240,
            fontFamily: "var(--font-jetbrains-mono)",
            fontSize: 13,
            color: "rgba(255, 255, 255, 0.4)",
            letterSpacing: "0.02em",
            wordBreak: "break-all",
          }}
        >
          {placeholder}
        </code>
        {/* <button
          type="button"
          onClick={handleCopy}
          className="sh-btn sh-btn--secondary sh-btn--sm"
          aria-label={copied ? "Address copied" : "Copy placeholder address"}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button> */}
      </div>
    </div>
  );
}
