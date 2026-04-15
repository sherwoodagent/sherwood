import { type ActivityEvent, type ActivityEventType } from "@/lib/syndicate-data";
import { truncateAddress, formatAsset } from "@/lib/contracts";

interface StrategyActivityProps {
  activity: ActivityEvent[];
  assetDecimals: number;
  assetSymbol: string;
  addressNames?: Record<string, string>;
}

const EVENT_CONFIG: Record<
  ActivityEventType,
  { label: string; bg: string; color: string }
> = {
  deposit: {
    label: "DEPOSIT",
    bg: "rgba(46, 230, 166, 0.2)",
    color: "var(--color-accent)",
  },
  withdrawal: {
    label: "WITHDRAW",
    bg: "rgba(255, 77, 77, 0.2)",
    color: "#ff4d4d",
  },
  executed: {
    label: "EXECUTED",
    bg: "rgba(100, 149, 237, 0.2)",
    color: "#6495ed",
  },
  settled: {
    label: "SETTLED",
    bg: "rgba(255, 255, 255, 0.1)",
    color: "rgba(255,255,255,0.5)",
  },
  cancelled: {
    label: "CANCELLED",
    bg: "rgba(255, 255, 255, 0.1)",
    color: "rgba(255,255,255,0.55)",
  },
};

function EventBadge({ type }: { type: ActivityEventType }) {
  const cfg = EVENT_CONFIG[type];
  return (
    <span
      style={{
        fontFamily: "var(--font-plus-jakarta), sans-serif",
        fontSize: "9px",
        padding: "2px 6px",
        borderRadius: "2px",
        background: cfg.bg,
        color: cfg.color,
        textTransform: "uppercase",
      }}
    >
      {cfg.label}
    </span>
  );
}

function formatRelativeTime(timestamp: bigint): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - Number(timestamp);

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(Number(timestamp) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatPnL(
  pnl: bigint,
  decimals: number,
  symbol: string,
): { text: string; color: string } {
  const isUSD = symbol === "USDC" || symbol === "USDT";
  const abs = pnl < 0n ? -pnl : pnl;
  const formatted = formatAsset(abs, decimals, isUSD ? "USD" : undefined);
  const display = isUSD ? formatted : `${formatted} ${symbol}`;
  if (pnl > 0n) return { text: `+${display}`, color: "var(--color-accent)" };
  if (pnl < 0n) return { text: `-${display}`, color: "#ff4d4d" };
  return { text: display, color: "rgba(255,255,255,0.5)" };
}

export default function StrategyActivity({
  activity,
  assetDecimals,
  assetSymbol,
  addressNames,
}: StrategyActivityProps) {
  const isUSD = assetSymbol === "USDC" || assetSymbol === "USDT";

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Strategy Activity</span>
        <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
          {activity.length} EVENTS
        </span>
      </div>

      {activity.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "2rem 0",
            color: "rgba(255,255,255,0.55)",
            fontFamily: "var(--font-plus-jakarta), sans-serif",
            fontSize: "12px",
          }}
        >
          No activity yet
        </div>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Actor</th>
              <th scope="col">Amount</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((evt, i) => {
              const amountFormatted =
                evt.amount > 0n
                  ? isUSD
                    ? formatAsset(evt.amount, assetDecimals, "USD")
                    : `${formatAsset(evt.amount, assetDecimals)} ${assetSymbol}`
                  : "—";

              let details = "—";
              if (evt.proposalId !== undefined) {
                details = `Proposal #${evt.proposalId}`;
              }
              if (evt.type === "settled" && evt.pnl !== undefined) {
                const pnl = formatPnL(evt.pnl, assetDecimals, assetSymbol);
                details = `P&L: ${pnl.text}`;
              }

              return (
                <tr key={`${evt.txHash}-${evt.type}-${i}`}>
                  <td>{formatRelativeTime(evt.timestamp)}</td>
                  <td>
                    <EventBadge type={evt.type} />
                  </td>
                  <td>{addressNames?.[evt.actor.toLowerCase()] || truncateAddress(evt.actor)}</td>
                  <td>{amountFormatted}</td>
                  <td
                    style={
                      evt.type === "settled" && evt.pnl !== undefined
                        ? {
                            color: formatPnL(evt.pnl, assetDecimals, assetSymbol)
                              .color,
                            fontWeight: 600,
                          }
                        : undefined
                    }
                  >
                    {details}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
